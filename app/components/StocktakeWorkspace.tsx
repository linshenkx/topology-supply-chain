"use client";

import { useEffect, useMemo, useState } from "react";

type Quantity = { availableQuantity: string; lockedQuantity: string; defectiveQuantity: string; pendingInspectionQuantity: string };
type Count = { id: number; batchId: number | null; sku: string; countRound: number; availableQuantity: number; lockedQuantity: number; defectiveQuantity: number; pendingInspectionQuantity: number };
type Task = { id: number; stocktakeNo: string; warehouseId: number; scope: string; dueDate: string; status: string; targets: { batchId: number | null; sku: string; batchNo: string | null }[]; counts: Count[] };
type Data = { stocktakes: Task[]; warehouses: { id: number; name: string; status: string }[]; factories: { id: number; name: string }[]; canCreate: boolean };

const blank: Quantity = { availableQuantity: "", lockedQuantity: "", defectiveQuantity: "", pendingInspectionQuantity: "" };
const statusText: Record<string, string> = { first_count: "初盘中", recount: "复盘中", pending_approval: "差异待审批", completed: "已完成", frozen: "已冻结" };

export default function StocktakeWorkspace({ toast }: { toast: (message: string) => void }) {
  const [data, setData] = useState<Data>({ stocktakes: [], warehouses: [], factories: [], canCreate: false });
  const [selectedId, setSelectedId] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [values, setValues] = useState<Record<string, Quantity>>({});
  const [gain, setGain] = useState({ sku: "", ...blank });
  const [dates, setDates] = useState({ estimatedProductionDate: "", estimatedExpiryDate: "" });
  const [create, setCreate] = useState({ warehouseId: "", scope: "full_warehouse", dueDate: "", assignedFactoryId: "", targets: "" });

  async function load() {
    const response = await fetch("/api/v1/stocktakes", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "盘点数据加载失败");
    setData(body);
    setSelectedId(current => current && body.stocktakes.some((row: Task) => row.id === current) ? current : body.stocktakes[0]?.id);
  }
  useEffect(() => { void load().catch(error => toast(error.message)); }, []);
  const task = useMemo(() => data.stocktakes.find(row => row.id === selectedId), [data.stocktakes, selectedId]);
  const round = task?.status === "first_count" ? 1 : task?.status === "recount" ? 2 : 0;
  const warehouse = new Map(data.warehouses.map(row => [row.id, row.name]));

  async function createTask(event: React.FormEvent) {
    event.preventDefault(); setBusy(true);
    try {
      const targets = create.targets.split(/[,，\n]/).map(value => value.trim()).filter(Boolean);
      const payload = { warehouseId: Number(create.warehouseId), scope: create.scope, dueDate: create.dueDate, assignedFactoryId: create.assignedFactoryId ? Number(create.assignedFactoryId) : undefined, skus: create.scope === "sku_sample" ? targets : undefined, batchIds: create.scope === "batch" ? targets.map(Number) : undefined };
      const response = await fetch("/api/stocktakes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error ?? "创建盘点任务失败");
      toast("盘点任务已创建，相关库存已冻结"); await load();
    } catch (error) { toast(error instanceof Error ? error.message : "创建盘点任务失败"); } finally { setBusy(false); }
  }

  async function submitCount(target: { batchId: number | null; sku: string }) {
    if (!task) return; const key = String(target.batchId ?? `gain-${target.sku}`); const q = target.batchId ? values[key] : gain;
    if (!q || Object.values(q).some(value => value === "")) return toast("请完整填写四类库存数量");
    setBusy(true);
    try {
      const response = await fetch("/api/stocktakes", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: task.id, action: "submit_count", batchId: target.batchId, sku: target.sku, ...Object.fromEntries(Object.entries(q).filter(([key]) => key !== "sku").map(([key, value]) => [key, Number(value)])) }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error ?? "保存盘点数量失败");
      toast("盘点数量已保存"); await load();
    } catch (error) { toast(error instanceof Error ? error.message : "保存盘点数量失败"); } finally { setBusy(false); }
  }

  async function finishRound() {
    if (!task) return; setBusy(true);
    try {
      const response = await fetch("/api/stocktakes", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: task.id, action: "finish_round", ...dates }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error ?? "结束本轮盘点失败");
      toast(body.status === "recount" ? "初盘存在差异，已进入复盘" : body.status === "pending_approval" ? "复盘差异已提交供应链审批" : "盘点已完成并解除冻结"); await load();
    } catch (error) { toast(error instanceof Error ? error.message : "结束本轮盘点失败"); } finally { setBusy(false); }
  }

  return <div className="inventory-section stocktake-workspace">
    <div className="panel-head"><div><h3>库存盘点</h3><p>支持全仓、SKU 抽盘和批次盲盘；盘点期间绝对禁止出入库</p></div><button onClick={() => void load()} disabled={busy}>刷新</button></div>
    {data.canCreate && <form className="stocktake-create" onSubmit={createTask}>
      <label>仓库<select required value={create.warehouseId} onChange={event => setCreate({ ...create, warehouseId: event.target.value })}><option value="">请选择</option>{data.warehouses.filter(row => row.status === "active").map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
      <label>范围<select value={create.scope} onChange={event => setCreate({ ...create, scope: event.target.value })}><option value="full_warehouse">全仓盘点</option><option value="sku_sample">按 SKU 抽盘</option><option value="batch">按批次盘点</option></select></label>
      <label>截止日期<input required type="date" value={create.dueDate} onChange={event => setCreate({ ...create, dueDate: event.target.value })} /></label>
      <label>执行工厂<select value={create.assignedFactoryId} onChange={event => setCreate({ ...create, assignedFactoryId: event.target.value })}><option value="">暂不指定</option>{data.factories.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
      {create.scope !== "full_warehouse" && <label>{create.scope === "sku_sample" ? "SKU（逗号分隔）" : "批次 ID（逗号分隔）"}<input required value={create.targets} onChange={event => setCreate({ ...create, targets: event.target.value })} /></label>}
      <button className="primary" disabled={busy}>创建并冻结</button>
    </form>}
    <div className="stocktake-layout">
      <div className="stocktake-list">{data.stocktakes.map(row => <button className={row.id === selectedId ? "active" : ""} key={row.id} onClick={() => setSelectedId(row.id)}><b>{row.stocktakeNo}</b><span>{warehouse.get(row.warehouseId)}</span><small>{statusText[row.status] ?? row.status} · {row.dueDate}</small></button>)}</div>
      <div className="stocktake-detail">{!task ? <div className="empty">暂无盘点任务</div> : <>
        <h4>{task.stocktakeNo} · {statusText[task.status] ?? task.status}</h4>
        {!!round && <><p className="stocktake-blind">盲盘模式：系统账面数量已隐藏，请只录入现场实际数量。</p>
          {task.targets.map(target => { const key = String(target.batchId); const saved = task.counts.find(row => row.countRound === round && row.batchId === target.batchId); const q = values[key] ?? (saved ? Object.fromEntries(Object.entries(saved).filter(([name]) => name.endsWith("Quantity")).map(([name, value]) => [name, String(value)])) as Quantity : blank); return <div className="stocktake-line" key={key}><strong>{target.sku}<small>{target.batchNo ?? "未识别批次"}</small></strong>{Object.entries({ availableQuantity: "可用", lockedQuantity: "预留/锁定", defectiveQuantity: "次品", pendingInspectionQuantity: "待检" }).map(([name, label]) => <label key={name}>{label}<input min="0" type="number" value={q[name as keyof Quantity]} onChange={event => setValues({ ...values, [key]: { ...q, [name]: event.target.value } })} /></label>)}<button disabled={busy} onClick={() => void submitCount(target)}>保存</button></div>; })}
          <div className="stocktake-line gain"><strong>新增盘盈批次<input placeholder="输入 SKU" value={gain.sku} onChange={event => setGain({ ...gain, sku: event.target.value })} /></strong>{Object.entries({ availableQuantity: "可用", lockedQuantity: "预留/锁定", defectiveQuantity: "次品", pendingInspectionQuantity: "待检" }).map(([name, label]) => <label key={name}>{label}<input min="0" type="number" value={gain[name as keyof Quantity] ?? ""} onChange={event => setGain({ ...gain, [name]: event.target.value })} /></label>)}<button disabled={busy || !gain.sku} onClick={() => void submitCount({ batchId: null, sku: gain.sku })}>保存盘盈</button></div>
          <div className="stocktake-finish"><label>盘盈估算生产日期<input type="date" value={dates.estimatedProductionDate} onChange={event => setDates({ ...dates, estimatedProductionDate: event.target.value })} /></label><label>盘盈估算到期日<input type="date" value={dates.estimatedExpiryDate} onChange={event => setDates({ ...dates, estimatedExpiryDate: event.target.value })} /></label><button className="primary" disabled={busy} onClick={() => void finishRound()}>结束本轮盘点</button></div>
        </>}
      </>}</div>
    </div>
  </div>;
}
