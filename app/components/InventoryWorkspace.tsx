"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import StocktakeWorkspace from "./StocktakeWorkspace";
import WarehouseWorkspace from "./WarehouseWorkspace";
import { mutateJson } from "../lib/mutation-client";

type Warehouse = { id: number; name: string; status: string };
type Batch = { id: number; batchNo: string; warehouseId: number; sku: string; expiryDate?: string; productionDateEstimated: boolean; expiryDateEstimated: boolean; availableQuantity: number; lockedQuantity: number; defectiveQuantity: number; pendingInspectionQuantity: number; quarantineQuantity: number; ownership: string; expiryStatus: string };
type Reservation = { id: number; batchId: number; entityType: string; entityId?: number; requestedQuantity: number; reservedQuantity: number; shortageQuantity: number; priority: number };
type Transfer = { id: number; transferNo: string; fromWarehouseId: number; toWarehouseId: number; sku: string; quantity: number; reason: string; status: string };
type Data = { batches: Batch[]; warehouses: Warehouse[]; reservations: Reservation[]; transfers: Transfer[] };

const transferStatus: Record<string, string> = { pending_approval: "待供应链审批", approved: "待实际发出", rejected: "审批拒绝", shipped: "运输中", received: "已收货" };
const expiryStatus: Record<string, string> = { normal: "正常", yellow: "黄色预警", red: "红色预警", expired_frozen: "已过期冻结" };

export default function InventoryWorkspace({ toast }: { toast: (message: string) => void }) {
  const [data, setData] = useState<Data>({ batches: [], warehouses: [], reservations: [], transfers: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [reserve, setReserve] = useState({ batchId: "", entityType: "production_order", entityId: "", requestedQuantity: "", priority: "0" });
  const [transfer, setTransfer] = useState({ fromWarehouseId: "", toWarehouseId: "", sku: "", quantity: "", reason: "" });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/v1/inventory", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "库存数据加载失败");
      setData(body);
    } catch (error) { toast(error instanceof Error ? error.message : "库存数据加载失败"); }
    finally { setLoading(false); }
  }, [toast]);
  useEffect(() => {
    async function loadInitialData() {
      await load();
    }

    void loadInitialData();
  }, [load]);

  const warehouseName = useMemo(() => new Map(data.warehouses.map(row => [row.id, row.name])), [data.warehouses]);
  const batchName = useMemo(() => new Map(data.batches.map(row => [row.id, `${row.sku} · ${row.batchNo}`])), [data.batches]);
  const totals = useMemo(() => data.batches.reduce((sum, row) => ({ available: sum.available + row.availableQuantity, locked: sum.locked + row.lockedQuantity, blocked: sum.blocked + row.defectiveQuantity + row.pendingInspectionQuantity + row.quarantineQuantity }), { available: 0, locked: 0, blocked: 0 }), [data.batches]);
  const shortage = data.reservations.reduce((sum, row) => sum + row.shortageQuantity, 0);

  async function submitReservation(event: React.FormEvent) {
    event.preventDefault(); setBusy(true);
    try {
      const body = await mutateJson<{reservation?:{shortageQuantity?:number}},Record<string,unknown>>(
        "/api/v1/inventory", "POST",
        { batchId: Number(reserve.batchId), entityType: reserve.entityType,
          ...(reserve.entityType === "historical" ? {} : { entityId: Number(reserve.entityId) }),
          requestedQuantity: Number(reserve.requestedQuantity), priority: Number(reserve.priority) },
      );
      const gap = body.reservation?.shortageQuantity ?? 0;
      toast(gap ? `已部分预留，仍有 ${gap} 件库存缺口` : "库存已成功预留");
      setReserve(current => ({ ...current, requestedQuantity: "", entityId: "" })); await load();
    } catch (error) { toast(error instanceof Error ? error.message : "库存预留失败"); }
    finally { setBusy(false); }
  }

  async function submitTransfer(event: React.FormEvent) {
    event.preventDefault(); setBusy(true);
    try {
      await mutateJson("/api/v1/inventory/transfers", "POST", { ...transfer, fromWarehouseId: Number(transfer.fromWarehouseId), toWarehouseId: Number(transfer.toWarehouseId), quantity: Number(transfer.quantity) });
      toast("调拨申请已提交，等待供应链审批"); setTransfer({ fromWarehouseId: "", toWarehouseId: "", sku: "", quantity: "", reason: "" }); await load();
    } catch (error) { toast(error instanceof Error ? error.message : "调拨申请失败"); }
    finally { setBusy(false); }
  }

  async function transferAction(id: number, action: "ship" | "receive") {
    setBusy(true);
    try {
      await mutateJson("/api/v1/inventory/transfers", "PATCH", { id, action });
      toast(action === "ship" ? "已登记实际发出，调出仓库存已扣减" : "已确认收货，调入仓库存已增加"); await load();
    } catch (error) { toast(error instanceof Error ? error.message : "调拨操作失败"); }
    finally { setBusy(false); }
  }

  return <section className="inventory-workspace">
    <div className="panel-head"><div><h2>库存与调拨</h2><p>批次管理、部分预留、缺口追踪和仓库调拨，全程禁止负库存</p></div><button onClick={() => void load()} disabled={loading}>刷新</button></div>
    <div className="inventory-kpis"><span><strong>{totals.available}</strong>可用库存</span><span><strong>{totals.locked}</strong>预留/锁定</span><span><strong>{totals.blocked}</strong>次品/待检/隔离</span><span className={shortage ? "risk" : ""}><strong>{shortage}</strong>待补库存缺口</span></div>
    <div className="inventory-forms">
      <form onSubmit={submitReservation}><h3>预留库存</h3><label>库存批次<select required value={reserve.batchId} onChange={e => setReserve({ ...reserve, batchId: e.target.value })}><option value="">请选择</option>{data.batches.filter(row => row.ownership === "company" && row.expiryStatus !== "expired_frozen").map(row => <option key={row.id} value={row.id}>{warehouseName.get(row.warehouseId)} · {row.sku} · {row.batchNo}（可用 {row.availableQuantity}）</option>)}</select></label><label>关联业务<select value={reserve.entityType} onChange={e => setReserve({ ...reserve, entityType: e.target.value })}><option value="production_order">生产单</option><option value="purchase_order">采购单</option><option value="shipment_plan">发货计划</option><option value="historical">历史预留</option></select></label>{reserve.entityType !== "historical" && <label>业务单据 ID<input required type="number" min="1" value={reserve.entityId} onChange={e => setReserve({ ...reserve, entityId: e.target.value })} /></label>}<label>需求数量<input required type="number" min="1" value={reserve.requestedQuantity} onChange={e => setReserve({ ...reserve, requestedQuantity: e.target.value })} /></label><label>优先级<input type="number" value={reserve.priority} onChange={e => setReserve({ ...reserve, priority: e.target.value })} /></label><button className="primary" disabled={busy}>确认预留</button></form>
      <form onSubmit={submitTransfer}><h3>发起仓库调拨</h3><label>调出仓<select required value={transfer.fromWarehouseId} onChange={e => setTransfer({ ...transfer, fromWarehouseId: e.target.value })}><option value="">请选择</option>{data.warehouses.filter(row => row.status === "active").map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label><label>调入仓<select required value={transfer.toWarehouseId} onChange={e => setTransfer({ ...transfer, toWarehouseId: e.target.value })}><option value="">请选择</option>{data.warehouses.filter(row => row.status === "active" && String(row.id) !== transfer.fromWarehouseId).map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label><label>SKU<input required value={transfer.sku} onChange={e => setTransfer({ ...transfer, sku: e.target.value })} /></label><label>调拨数量<input required type="number" min="1" value={transfer.quantity} onChange={e => setTransfer({ ...transfer, quantity: e.target.value })} /></label><label>调拨原因<textarea required value={transfer.reason} onChange={e => setTransfer({ ...transfer, reason: e.target.value })} /></label><button className="primary" disabled={busy}>提交审批</button></form>
    </div>
    <div className="inventory-section"><h3>库存批次</h3>{loading ? <div className="empty">正在加载…</div> : <div className="inventory-table"><div className="inventory-table-head"><span>仓库 / SKU</span><span>批次</span><span>可用 / 锁定</span><span>次品 / 待检</span><span>到期日</span><span>状态</span></div>{data.batches.map(row => <div className="inventory-table-row" key={row.id}><span><b>{warehouseName.get(row.warehouseId)}</b><small>{row.sku}</small></span><span>{row.batchNo}</span><span>{row.availableQuantity} / {row.lockedQuantity}</span><span>{row.defectiveQuantity} / {row.pendingInspectionQuantity}</span><span>{row.expiryDate ?? "未设置"}{(row.productionDateEstimated || row.expiryDateEstimated) && <small className="estimated">估算日期，领用/发货须注意</small>}</span><span className={`expiry ${row.expiryStatus}`}>{expiryStatus[row.expiryStatus] ?? row.expiryStatus}</span></div>)}</div>}</div>
    <div className="inventory-section"><h3>当前预留与缺口</h3><div className="inventory-cards">{data.reservations.length ? data.reservations.map(row => <article key={row.id}><strong>{batchName.get(row.batchId) ?? `批次 #${row.batchId}`}</strong><p>{row.entityType} #{row.entityId ?? "历史"} · 优先级 {row.priority}</p><span>需求 {row.requestedQuantity} / 已锁定 {row.reservedQuantity}</span>{row.shortageQuantity > 0 && <em>缺口 {row.shortageQuantity}</em>}</article>) : <div className="empty">暂无有效库存预留</div>}</div></div>
    <div className="inventory-section"><h3>仓库调拨</h3><div className="inventory-cards">{data.transfers.length ? data.transfers.map(row => <article key={row.id}><strong>{row.transferNo} · {row.sku} × {row.quantity}</strong><p>{warehouseName.get(row.fromWarehouseId)} → {warehouseName.get(row.toWarehouseId)}</p><span>{transferStatus[row.status] ?? row.status}</span><small>{row.reason}</small><div className="row-actions">{row.status === "approved" && <button disabled={busy} onClick={() => void transferAction(row.id, "ship")}>登记实际发出</button>}{row.status === "shipped" && <button className="primary" disabled={busy} onClick={() => void transferAction(row.id, "receive")}>确认收货</button>}</div></article>) : <div className="empty">暂无调拨单</div>}</div></div>
    <WarehouseWorkspace toast={toast} />
    <StocktakeWorkspace toast={toast} />
  </section>;
}
