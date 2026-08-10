"use client";

import { useEffect, useMemo, useState } from "react";
import SupplierPriceWorkspace from "./SupplierPriceWorkspace";
import SupplierPerformanceWorkspace from "./SupplierPerformanceWorkspace";

type Toast = (message: string) => void;
type Factory = { id: number; code: string; name: string; status: string };
type Supplier = { id: number; code: string; name: string; tier: number; managedByFactoryId: number | null; unifiedSocialCreditCode: string; address: string; contactName: string; contactPhone: string; businessScope: string; verificationStatus: string; status: string };
type Sku = { id: number; code: string; name: string; itemType: string; stockUnit: string; purchaseUnit: string | null };
type Relation = { id: number; factoryId: number; supplierId: number; sku: string; isPrimary: boolean; priority: number; minimumOrderQuantity: number; packagingMultiple: number; purchaseUnit: string; leadTimeDays: number | null; dailyCapacity: number | null; monthlyCapacity: number | null; effectiveFrom: string; status: string };

const today = new Date().toISOString().slice(0, 10);

export default function SupplierWorkspace({ toast }: { toast: Toast }) {
  const [tab, setTab] = useState<"supplier" | "relation">("supplier");
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [factories, setFactories] = useState<Factory[]>([]);
  const [relations, setRelations] = useState<Relation[]>([]);
  const [skus, setSkus] = useState<Sku[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [supplier, setSupplier] = useState({ code: "", name: "", tier: "1", managedByFactoryId: "", unifiedSocialCreditCode: "", businessLicenseFileKey: "", address: "", contactName: "", contactPhone: "", businessScope: "" });
  const [relation, setRelation] = useState({ factoryId: "", supplierId: "", sku: "", isPrimary: false, priority: "1", minimumOrderQuantity: "1", packagingMultiple: "1", purchaseUnit: "", leadTimeDays: "", dailyCapacity: "", monthlyCapacity: "", effectiveFrom: today });

  const load = async () => {
    const [supplierResponse, relationResponse] = await Promise.all([fetch("/api/suppliers"), fetch("/api/supplier-skus")]);
    if (supplierResponse.ok) { const data = await supplierResponse.json(); setSuppliers(data.suppliers ?? []); setFactories(data.factories ?? []); }
    if (relationResponse.ok) { const data = await relationResponse.json(); setRelations(data.relations ?? []); setSkus(data.skus ?? []); if (!factories.length && data.factories) setFactories(data.factories); }
  };
  useEffect(() => { void load(); }, []);
  const factoryName = (id: number | null) => factories.find(item => item.id === id)?.name ?? (id ? `工厂 #${id}` : "—");
  const supplierName = (id: number) => suppliers.find(item => item.id === id)?.name ?? `供应商 #${id}`;
  const visibleSuppliers = useMemo(() => suppliers.filter(item => `${item.code}${item.name}${item.contactName}${item.contactPhone}`.toLowerCase().includes(search.toLowerCase())), [suppliers, search]);
  const visibleRelations = useMemo(() => relations.filter(item => `${item.sku}${supplierName(item.supplierId)}${factoryName(item.factoryId)}`.toLowerCase().includes(search.toLowerCase())), [relations, suppliers, factories, search]);
  const candidates = suppliers.filter(item => item.status === "active" && (!relation.factoryId || item.tier === 1 || item.managedByFactoryId === Number(relation.factoryId)));

  const submit = async () => {
    setBusy(true);
    try {
      const isSupplier = tab === "supplier";
      const payload = isSupplier ? { ...supplier, tier: Number(supplier.tier), managedByFactoryId: supplier.managedByFactoryId ? Number(supplier.managedByFactoryId) : undefined } : {
        ...relation, factoryId: Number(relation.factoryId), supplierId: Number(relation.supplierId), priority: Number(relation.priority), minimumOrderQuantity: Number(relation.minimumOrderQuantity), packagingMultiple: Number(relation.packagingMultiple),
        leadTimeDays: relation.leadTimeDays ? Number(relation.leadTimeDays) : null, dailyCapacity: relation.dailyCapacity ? Number(relation.dailyCapacity) : null, monthlyCapacity: relation.monthlyCapacity ? Number(relation.monthlyCapacity) : null,
      };
      const response = await fetch(isSupplier ? "/api/suppliers" : "/api/supplier-skus", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "提交失败");
      toast(result.approvalRequired ? "已提交，等待另一位供应链同事审批" : "已生效并记录操作日志");
      setOpen(false); await load();
    } catch (error) { toast(error instanceof Error ? error.message : "提交失败"); } finally { setBusy(false); }
  };

  return <section className="supplier-workspace">
    <div className="master-head"><div><h2>供应商网络</h2><p>维护三级供应商档案、所属组装工厂、供货优先级与产能</p></div><button className="primary" onClick={() => setOpen(true)}>＋ {tab === "supplier" ? "新增供应商" : "新增供货关系"}</button></div>
    <div className="supplier-summary"><article><b>{suppliers.filter(x => x.tier === 1).length}</b><span>第一层组装工厂</span></article><article><b>{suppliers.filter(x => x.tier === 2).length}</b><span>第二层核心供应商</span></article><article><b>{suppliers.filter(x => x.tier === 3).length}</b><span>第三层供应商</span></article><article><b>{relations.filter(x => x.status === "pending").length}</b><span>待审批供货关系</span></article></div>
    <div className="master-tabs supplier-tools"><div><button className={tab === "supplier" ? "active" : ""} onClick={() => setTab("supplier")}>供应商档案</button><button className={tab === "relation" ? "active" : ""} onClick={() => setTab("relation")}>供应商－SKU关系</button></div><input placeholder="搜索代码、名称、SKU或联系人" value={search} onChange={e => setSearch(e.target.value)} /></div>
    {tab === "supplier" ? <div className="supplier-table"><div className="row header"><span>供应商</span><span>层级 / 所属工厂</span><span>企业与联系人</span><span>经营范围</span><span>状态</span></div>{visibleSuppliers.map(item => <div className="row" key={item.id}><span><b>{item.name}</b><small>{item.code}</small></span><span><b>第 {item.tier} 层</b><small>{factoryName(item.managedByFactoryId)}</small></span><span><b>{item.contactName} · {item.contactPhone}</b><small>{item.unifiedSocialCreditCode || "信用代码待补充"} · {item.address}</small></span><span>{item.businessScope || "待补充"}</span><span className={`state ${item.verificationStatus}`}>{item.verificationStatus === "approved" ? "已生效" : item.verificationStatus === "rejected" ? "已拒绝" : "待审批"}</span></div>)}</div>
      : <div className="supplier-table relation"><div className="row header"><span>工厂 / 供应商</span><span>SKU</span><span>供货规则</span><span>产能</span><span>状态</span></div>{visibleRelations.map(item => <div className="row" key={item.id}><span><b>{supplierName(item.supplierId)}</b><small>{factoryName(item.factoryId)}</small></span><span><b>{item.sku}</b><small>{item.isPrimary ? "默认供应商" : `候选优先级 ${item.priority}`}</small></span><span><b>MOQ {item.minimumOrderQuantity} · 包装倍数 {item.packagingMultiple}</b><small>提前期 {item.leadTimeDays ?? "未填"} 天 · {item.purchaseUnit}</small></span><span><b>日产 {item.dailyCapacity ?? "待填"}</b><small>月产 {item.monthlyCapacity ?? "待填"}</small></span><span className={`state ${item.status === "active" ? "approved" : item.status}`}>{item.status === "active" ? "已生效" : item.status === "inactive" ? "未生效" : "待审批"}</span></div>)}</div>}
    {((tab === "supplier" && !visibleSuppliers.length) || (tab === "relation" && !visibleRelations.length)) && <div className="master-empty">暂无匹配数据，可通过右上角新增或使用 Excel 导入。</div>}
    {open && <div className="master-mask"><div className="master-dialog supplier-dialog"><div className="dialog-title"><h3>{tab === "supplier" ? "新增供应商档案" : "新增供应商－SKU关系"}</h3><button onClick={() => setOpen(false)}>×</button></div>
      {tab === "supplier" ? <div className="form-grid"><label>供应商编码<input value={supplier.code} onChange={e => setSupplier({ ...supplier, code: e.target.value })} /></label><label>供应商名称<input value={supplier.name} onChange={e => setSupplier({ ...supplier, name: e.target.value })} /></label><label>供应层级<select value={supplier.tier} onChange={e => setSupplier({ ...supplier, tier: e.target.value })}><option value="1">第一层组装工厂</option><option value="2">第二层核心供应商</option><option value="3">第三层供应商</option></select></label>{supplier.tier !== "1" && <label>所属组装工厂<select value={supplier.managedByFactoryId} onChange={e => setSupplier({ ...supplier, managedByFactoryId: e.target.value })}><option value="">请选择</option>{factories.map(x => <option key={x.id} value={x.id}>{x.code} - {x.name}</option>)}</select></label>}<label>统一社会信用代码<input value={supplier.unifiedSocialCreditCode} onChange={e => setSupplier({ ...supplier, unifiedSocialCreditCode: e.target.value })} /></label><label>营业执照文件标识<input placeholder="先在附件区上传后填写文件标识" value={supplier.businessLicenseFileKey} onChange={e => setSupplier({ ...supplier, businessLicenseFileKey: e.target.value })} /></label><label>企业地址<input value={supplier.address} onChange={e => setSupplier({ ...supplier, address: e.target.value })} /></label><label>联系人<input value={supplier.contactName} onChange={e => setSupplier({ ...supplier, contactName: e.target.value })} /></label><label>联系电话<input value={supplier.contactPhone} onChange={e => setSupplier({ ...supplier, contactPhone: e.target.value })} /></label><label>经营范围<textarea value={supplier.businessScope} onChange={e => setSupplier({ ...supplier, businessScope: e.target.value })} /></label></div>
      : <div className="form-grid"><label>第一层组装工厂<select value={relation.factoryId} onChange={e => setRelation({ ...relation, factoryId: e.target.value, supplierId: "" })}><option value="">请选择</option>{factories.map(x => <option key={x.id} value={x.id}>{x.code} - {x.name}</option>)}</select></label><label>供应商<select value={relation.supplierId} onChange={e => setRelation({ ...relation, supplierId: e.target.value })}><option value="">请选择</option>{candidates.map(x => <option key={x.id} value={x.id}>第{x.tier}层 · {x.name}</option>)}</select></label><label>SKU<select value={relation.sku} onChange={e => { const selected = skus.find(x => x.code === e.target.value); setRelation({ ...relation, sku: e.target.value, purchaseUnit: selected?.purchaseUnit || selected?.stockUnit || "" }); }}><option value="">请选择</option>{skus.map(x => <option key={x.id} value={x.code}>{x.code} - {x.name}</option>)}</select></label><label className="check"><input type="checkbox" checked={relation.isPrimary} onChange={e => setRelation({ ...relation, isPrimary: e.target.checked })} />设为默认供应商</label><label>候选优先级<input type="number" min="1" value={relation.priority} onChange={e => setRelation({ ...relation, priority: e.target.value })} /></label><label>采购单位<input value={relation.purchaseUnit} onChange={e => setRelation({ ...relation, purchaseUnit: e.target.value })} /></label><label>最小起订量 MOQ<input type="number" min="1" value={relation.minimumOrderQuantity} onChange={e => setRelation({ ...relation, minimumOrderQuantity: e.target.value })} /></label><label>包装倍数<input type="number" min="1" value={relation.packagingMultiple} onChange={e => setRelation({ ...relation, packagingMultiple: e.target.value })} /></label><label>交货提前期（天）<input type="number" min="0" value={relation.leadTimeDays} onChange={e => setRelation({ ...relation, leadTimeDays: e.target.value })} /></label><label>日产能<input type="number" min="1" value={relation.dailyCapacity} onChange={e => setRelation({ ...relation, dailyCapacity: e.target.value })} /></label><label>月产能<input type="number" min="1" value={relation.monthlyCapacity} onChange={e => setRelation({ ...relation, monthlyCapacity: e.target.value })} /></label><label>生效日期<input type="date" value={relation.effectiveFrom} onChange={e => setRelation({ ...relation, effectiveFrom: e.target.value })} /></label></div>}
      <div className="dialog-actions"><button onClick={() => setOpen(false)}>取消</button><button className="primary" disabled={busy} onClick={() => void submit()}>{busy ? "提交中…" : "提交"}</button></div>
    </div></div>}
    <SupplierPriceWorkspace toast={toast} />
    <SupplierPerformanceWorkspace toast={toast} />
  </section>;
}
