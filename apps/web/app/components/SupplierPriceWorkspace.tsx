"use client";

import { useEffect, useEffectEvent, useMemo, useState } from "react";
import { uploadPlatformFile } from "../lib/mutation-client";
import { writeSupplierPrice, writeSupplierPriceWithStepUp } from "../lib/supply-mutation-client";

type Toast = (message: string) => void;
type Supplier = { id: number; name: string; code: string; tier: number };
type Sku = { id: number; code: string; name: string };
type Agreement = { id: number; supplierId: number; sku: string; unitPriceTaxIncludedMinor: number; unitPriceTaxExcludedMinor: number; taxRateBps: number; effectiveFrom: string; effectiveTo?: string | null; status: string };
type Change = { id: number; supplierId: number; sku: string; proposedTaxIncludedMinor: number; proposedTaxExcludedMinor: number; proposedEffectiveFrom: string; decision: string; reason: string };
type Risk = { relationId: number; supplierId: number; sku: string; periodType: string; period: string; demand: number; capacity: number; excess: number };
type Relation = { id:number; supplierId:number; factoryId:number; sku:string };
type Payload = { agreements: Agreement[]; requests: Change[]; suppliers: Supplier[]; skus: Sku[]; relations:Relation[]; risks: Risk[] };

const money = (minor: number) => `¥${(minor / 100).toFixed(2)}`;

export default function SupplierPriceWorkspace({ toast }: { toast: Toast }) {
  const [data, setData] = useState<Payload>({ agreements: [], requests: [], suppliers: [], skus: [], relations:[], risks: [] });
  const [tab, setTab] = useState<"price" | "risk">("price");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ supplierId: "", sku: "", included: "", excluded: "", taxRate: "13", effectiveFrom: new Date().toISOString().slice(0, 10), reason: "", evidenceFileKey: "" });
  const supplierMap = useMemo(() => new Map(data.suppliers.map(x => [x.id, x])), [data.suppliers]);
  const load = async () => {
    const response = await fetch("/api/v1/supplier-prices", { cache: "no-store" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "价格数据加载失败");
    setData(result);
  };
  const initialRequestFailed = useEffectEvent((error: unknown) => toast(error instanceof Error ? error.message : "价格数据加载失败"));
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/v1/supplier-prices", { cache: "no-store", signal: controller.signal })
      .then(async response => {
        const next = await response.json();
        if (!response.ok) throw new Error(next.error || "价格数据加载失败");
        return next;
      })
      .then(next => { if (!controller.signal.aborted) setData(next); })
      .catch(error => { if (!controller.signal.aborted) initialRequestFailed(error); });
    return () => controller.abort();
  }, []);
  const upload = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try {
      const relation = data.relations.find(item => item.supplierId === Number(form.supplierId) && item.sku === form.sku);
      if (!relation) throw new Error("请先选择已授权的供应商与SKU关系。");
      const body = new FormData(); body.append("file", file); body.append("category", "price_evidence");
      body.append("entityType", "supplier_sku"); body.append("entityId", String(relation.id));
      const result = await uploadPlatformFile<{file:{id:number};usable:boolean}>(body);
      if (!result.usable) throw new Error("价格凭证已隔离，扫描通过后方可提交价格变更。");
      setForm(current => ({ ...current, evidenceFileKey: String(result.file.id) }));
    } catch (error) { toast(error instanceof Error ? error.message : "凭证上传失败"); } finally { setBusy(false); }
  };
  const submit = async () => {
    setBusy(true);
    try {
      const payload = { supplierId: Number(form.supplierId), sku: form.sku, taxIncludedMinor: Math.round(Number(form.included) * 100), taxExcludedMinor: Math.round(Number(form.excluded) * 100), taxRateBps: Math.round(Number(form.taxRate) * 100), effectiveFrom: form.effectiveFrom, reason: form.reason, evidenceFileKey: form.evidenceFileKey };
      const [sessionResponse, versionResponse] = await Promise.all([
        fetch("/api/v1/session", { cache: "no-store" }),
        fetch(`/api/v1/supplier-prices/version?supplierId=${payload.supplierId}&sku=${encodeURIComponent(payload.sku)}`, { cache: "no-store" }),
      ]);
      const session = sessionResponse.ok ? await sessionResponse.json() as { user?: { factoryId?: number | null; roles?: string[] } } : {};
      const supplier = data.suppliers.find(item => item.id === payload.supplierId);
      const relation = data.relations.find(item => item.supplierId === payload.supplierId && item.sku === payload.sku);
      const directFactory = supplier?.tier === 3 && session.user?.roles?.includes("factory") && session.user.factoryId === relation?.factoryId;
      let result: { approvalRequired: boolean };
      if (directFactory) {
        if (!versionResponse.ok) throw new Error("价格版本读取失败，请刷新后重试");
        const version = await versionResponse.json() as { objectVersion: number };
        result = await writeSupplierPriceWithStepUp(payload, version.objectVersion, async destination => window.prompt(`验证码已发送至 ${destination}，请输入 6 位验证码：`));
      } else {
        result = await writeSupplierPrice<{ approvalRequired: boolean }>(payload);
      }
      toast(result.approvalRequired ? "已提交双人审批" : "价格已生效"); setOpen(false); await load();
    } catch (error) { toast(error instanceof Error ? error.message : "提交失败"); } finally { setBusy(false); }
  };
  return <div className="price-workspace">
    <div className="price-head"><div><h3>供应商价格与产能风险</h3><p>人民币含税/未税价格、价格凭证、版本历史和日/月产能预警</p></div><button className="primary" onClick={() => setOpen(true)}>新增或变更价格</button></div>
    <div className="master-tabs"><button className={tab === "price" ? "active" : ""} onClick={() => setTab("price")}>有效价格与审批历史</button><button className={tab === "risk" ? "active" : ""} onClick={() => setTab("risk")}>产能风险（{data.risks.length}）</button></div>
    {tab === "price" ? <><div className="price-table"><div className="row header"><span>供应商</span><span>SKU</span><span>含税 / 未税</span><span>税率</span><span>有效期</span><span>状态</span></div>{data.agreements.map(item => <div className="row" key={item.id}><span><b>{supplierMap.get(item.supplierId)?.name || item.supplierId}</b><small>第 {supplierMap.get(item.supplierId)?.tier || "-"} 层</small></span><span>{item.sku}</span><span><b>{money(item.unitPriceTaxIncludedMinor)}</b><small>{money(item.unitPriceTaxExcludedMinor)}</small></span><span>{(item.taxRateBps / 100).toFixed(2)}%</span><span>{item.effectiveFrom}<small>{item.effectiveTo || "持续有效"}</small></span><span className={`state ${item.status === "active" ? "approved" : ""}`}>{item.status === "active" ? "生效中" : "历史版本"}</span></div>)}</div>
      {!!data.requests.length && <details className="price-history"><summary>查看价格变更审批记录（{data.requests.length}）</summary>{data.requests.map(item => <p key={item.id}><b>{supplierMap.get(item.supplierId)?.name} / {item.sku}</b>　{money(item.proposedTaxIncludedMinor)}　{item.proposedEffectiveFrom}　<span>{item.decision === "pending" ? "待审批" : item.decision === "approved" ? "已通过" : "已拒绝"}</span><small>{item.reason}</small></p>)}</details>}</>
      : <div className="risk-grid">{data.risks.map((item, index) => <article key={`${item.relationId}-${item.periodType}-${item.period}-${index}`}><strong>产能风险</strong><h4>{supplierMap.get(item.supplierId)?.name} · {item.sku}</h4><p>{item.periodType === "day" ? "日" : "月"}期：{item.period}</p><div><span>需求 {item.demand}</span><span>产能 {item.capacity}</span><b>超出 {item.excess}</b></div></article>)}{!data.risks.length && <div className="master-empty">当前没有超过日产能或月产能的采购需求。</div>}</div>}
    {open && <div className="master-mask"><div className="master-dialog price-dialog"><div className="dialog-title"><h3>新增或变更供应商价格</h3><button onClick={() => setOpen(false)}>×</button></div><div className="form-grid">
      <label>供应商<select value={form.supplierId} onChange={e => setForm({ ...form, supplierId: e.target.value })}><option value="">请选择</option>{data.suppliers.map(x => <option key={x.id} value={x.id}>第{x.tier}层 · {x.name}</option>)}</select></label>
      <label>SKU<select value={form.sku} onChange={e => setForm({ ...form, sku: e.target.value })}><option value="">请选择</option>{data.skus.map(x => <option key={x.id} value={x.code}>{x.code} - {x.name}</option>)}</select></label>
      <label>人民币含税单价<input type="number" min="0.01" step="0.01" value={form.included} onChange={e => setForm({ ...form, included: e.target.value })} /></label><label>人民币未税单价<input type="number" min="0.01" step="0.01" value={form.excluded} onChange={e => setForm({ ...form, excluded: e.target.value })} /></label>
      <label>税率（%）<input type="number" min="0" max="100" step="0.01" value={form.taxRate} onChange={e => setForm({ ...form, taxRate: e.target.value })} /></label><label>生效日期<input type="date" value={form.effectiveFrom} onChange={e => setForm({ ...form, effectiveFrom: e.target.value })} /></label>
      <label>价格凭证<input type="file" accept=".pdf,.jpg,.jpeg,.png,.xlsx,.xls" onChange={e => void upload(e.target.files?.[0])} /><small>{form.evidenceFileKey ? "已上传" : "至少上传一份凭证"}</small></label><label>新增/变更原因<textarea value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} /></label>
    </div><div className="dialog-actions"><button onClick={() => setOpen(false)}>取消</button><button className="primary" disabled={busy} onClick={() => void submit()}>{busy ? "处理中…" : "提交"}</button></div></div></div>}
  </div>;
}
