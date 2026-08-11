"use client";

import { useCallback, useEffect, useState } from "react";

type Factory = { id: number; name: string };
type Blockers = { inventory: number; reservations: number; transfers: number; unfinishedBusiness: number };
type Warehouse = { id: number; code: string; name: string; type: "factory" | "company" | "other"; factoryId: number | null; address: string; status: string; mergedIntoWarehouseId: number | null; blockers: Blockers };
type Props = { toast: (message: string, tone?: "success" | "error") => void };

const typeText = { factory: "组装工厂仓", company: "公司仓", other: "其他仓库" };

export default function WarehouseWorkspace({ toast }: Props) {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [factories, setFactories] = useState<Factory[]>([]);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ code: "", name: "", type: "company", factoryId: "", address: "" });
  const [merge, setMerge] = useState({ sourceId: "", targetId: "", reason: "" });

  const load = useCallback(async () => {
    const response = await fetch("/api/v1/warehouses", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "仓库数据加载失败");
    setWarehouses(data.warehouses || []); setFactories(data.factories || []);
  }, []);
  useEffect(() => { void load().catch(error => toast(error.message, "error")); }, [load, toast]);

  async function submit(payload: Record<string, unknown>, success: string) {
    setBusy(true);
    try {
      const response = await fetch("/api/warehouses", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "操作失败");
      toast(success, "success"); await load();
    } catch (error) { toast(error instanceof Error ? error.message : "操作失败", "error"); }
    finally { setBusy(false); }
  }

  const active = warehouses.filter(row => row.status === "active");
  return <div className="inventory-section warehouse-workspace">
    <div className="section-heading"><div><h3>仓库主数据</h3><p>供应链维护仓库归属；仓库合并执行双人审批，历史单据保留原仓库。</p></div></div>
    <div className="warehouse-create">
      <input placeholder="仓库编码" value={form.code} onChange={event => setForm({ ...form, code: event.target.value })} />
      <input placeholder="仓库名称" value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} />
      <select value={form.type} onChange={event => setForm({ ...form, type: event.target.value })}><option value="company">公司仓</option><option value="factory">组装工厂仓</option><option value="other">其他仓库</option></select>
      {form.type === "factory" && <select value={form.factoryId} onChange={event => setForm({ ...form, factoryId: event.target.value })}><option value="">选择所属工厂</option>{factories.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select>}
      <input placeholder="地址" value={form.address} onChange={event => setForm({ ...form, address: event.target.value })} />
      <button className="primary" disabled={busy} onClick={() => void submit({ action: "create", ...form }, "仓库已创建").then(() => setForm({ code: "", name: "", type: "company", factoryId: "", address: "" }))}>新增仓库</button>
    </div>
    <div className="warehouse-table-wrap"><table className="warehouse-table"><thead><tr><th>仓库</th><th>类型与归属</th><th>地址</th><th>停用阻碍</th><th>状态/操作</th></tr></thead><tbody>{warehouses.map(row => {
      const factory = factories.find(item => item.id === row.factoryId)?.name;
      const blocked = Object.values(row.blockers).some(value => value > 0);
      const target = warehouses.find(item => item.id === row.mergedIntoWarehouseId)?.name;
      return <tr key={row.id}><td><strong>{row.name}</strong><small>{row.code}</small></td><td>{typeText[row.type]}<small>{factory || "—"}</small></td><td>{row.address || "—"}</td><td><span>库存 {row.blockers.inventory}</span><small>预留 {row.blockers.reservations} · 在途 {row.blockers.transfers} · 未结业务 {row.blockers.unfinishedBusiness}</small></td><td><span className={`status-pill ${row.status}`}>{row.status === "active" ? "启用" : row.status === "merged" ? `已合并至 ${target || "目标仓"}` : "停用"}</span>{row.status === "active" && <button disabled={busy || blocked} title={blocked ? "请先清理库存和未完成业务" : "停用仓库"} onClick={() => void submit({ action: "deactivate", id: row.id }, "仓库已停用")}>停用</button>}</td></tr>;
    })}</tbody></table></div>
    <div className="warehouse-merge"><h4>发起仓库合并审批</h4><select value={merge.sourceId} onChange={event => setMerge({ ...merge, sourceId: event.target.value })}><option value="">源仓库</option>{active.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select><select value={merge.targetId} onChange={event => setMerge({ ...merge, targetId: event.target.value })}><option value="">目标仓库</option>{active.filter(row => String(row.id) !== merge.sourceId).map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select><input placeholder="合并原因（必填）" value={merge.reason} onChange={event => setMerge({ ...merge, reason: event.target.value })} /><button disabled={busy} onClick={() => void submit({ action: "request_merge", id: Number(merge.sourceId), targetId: Number(merge.targetId), reason: merge.reason }, "合并申请已提交，等待另一位供应链同事审核").then(() => setMerge({ sourceId: "", targetId: "", reason: "" }))}>提交审批</button></div>
  </div>;
}
