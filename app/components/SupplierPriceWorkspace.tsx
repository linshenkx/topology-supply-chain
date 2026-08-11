"use client";

import { useEffect, useMemo, useState } from "react";

type Toast = (message: string) => void;
type Supplier = { id: number; name: string; code: string; tier: number };
type Sku = { id: number; code: string; name: string };
type Agreement = { id: number; supplierId: number; sku: string; unitPriceTaxIncludedMinor: number; unitPriceTaxExcludedMinor: number; taxRateBps: number; effectiveFrom: string; effectiveTo?: string | null; status: string };
type Change = { id: number; supplierId: number; sku: string; proposedTaxIncludedMinor: number; proposedTaxExcludedMinor: number; proposedEffectiveFrom: string; decision: string; reason: string };
type Risk = { relationId: number; supplierId: number; sku: string; periodType: string; period: string; demand: number; capacity: number; excess: number };
type Payload = { agreements: Agreement[]; requests: Change[]; suppliers: Supplier[]; skus: Sku[]; risks: Risk[] };

const money = (minor: number) => `¥${(minor / 100).toFixed(2)}`;

export default function SupplierPriceWorkspace({ toast }: { toast: Toast }) {
  const [data, setData] = useState<Payload>({ agreements: [], requests: [], suppliers: [], skus: [], risks: [] });
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
  useEffect(() => { void load().catch(error => toast(error.message)); }, []);
  const upload = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try {
      const body = new FormData(); body.append("file", file); body.append("category", "price_evidence");
      const response = await fetch("/api/files", { method: "POST", body }); const result = await response.json();
      if (!response.ok) throw new Error(result.error || "凭证上传失败");
      setForm(current => ({ ...current, evidenceFileKey: result.file.objectKey })); toast("价格凭证已上传");
    } catch (error) { toast(error instanceof Error ? error.message : "凭证上传失败"); } finally { setBusy(false); }
  };
  const submit = async () => {
    setBusy(true);
    try {
      const response = await fetch("/api/supplier-prices", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ supplierId: Number(form.supplierId), sku: form.sku, taxIncludedMinor: Math.round(Number(form.included) * 100), taxExcludedMinor: Math.round(Number(form.excluded) * 100), taxRateBps: Math.round(Number(form.taxRate) * 100), effectiveFrom: form.effectiveFrom, reason: form.reason, evidenceFileKey: form.evidenceFileKey }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || "提交失败");
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
