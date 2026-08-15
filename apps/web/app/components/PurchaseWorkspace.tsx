"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { updatePurchaseOrder, updatePurchasePlan } from "../lib/supply-mutation-client";
import { mutateJson } from "../lib/mutation-client";

type PlanItem = {
  id: number; expectedArrivalDate: string; factoryId: number; factoryName: string;
  warehouseId: number; warehouseName: string; sku: string; productName: string; plannedQuantity: number;
  orderedQuantity: number; overToleranceBps: number; underToleranceBps: number; completionStatus: string;
};
type Plan = {
  id: number; planNo: string; version: number; status: string; confirmationDueAt?: string | null;
  updatedAt: string;
  items: PlanItem[]; responses?: Array<{ factoryId: number; decision: string; status: string }>;
};
type PurchaseOrder = {
  id: number; orderNo: string; orderDate?: string | null; status: string; totalTaxIncludedMinor: number;
  updatedAt: string;
  confirmationDueAt?: string | null;
  items: Array<{ id: number; sku: string; productName: string; quantity: number; receivedQuantity: number; dueDate?: string | null; planLinks?: Array<{ allocatedQuantity: number; planItem?: PlanItem }> }>;
};
type Session = { user: { roles: string[]; factoryId?: number | null } };

const PLAN_STATUS: Record<string, string> = {
  draft: "草稿", pending_approval: "版本待审批", awaiting_factory_confirmation: "待工厂确认",
  confirmed: "已确认", disputed: "有异议", ordering: "下单中", ordered_complete: "已下单完成", superseded: "旧版本",
};
const ITEM_STATUS: Record<string, string> = {
  not_ordered: "未下单", within_tolerance: "安全偏差内", over_plan_pending: "超计划待审批",
  under_plan_pending: "未足计划待审批", exception_approved: "异常审批完成",
};
const ORDER_STATUS: Record<string, string> = {
  draft: "草稿", factory_confirmation: "待工厂确认", confirmed: "已确认", disputed: "有异议",
  executing: "执行中", completed: "已完成", cancelled: "已取消",
};

export default function PurchaseWorkspace({ toast, openImport }: {
  toast: (message: string) => void;
  openImport: (kind: "plan" | "order") => void;
}) {
  const [view, setView] = useState<"计划" | "采购单">("计划");
  const [query, setQuery] = useState("");
  const [plans, setPlans] = useState<Plan[]>([]);
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState<Plan | null>(null);
  const [confirmingOrder, setConfirmingOrder] = useState<PurchaseOrder | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [receiving, setReceiving] = useState<PurchaseOrder["items"][number] & { purchaseOrderId: number } | null>(null);
  const [expandedOrderId, setExpandedOrderId] = useState<number | null>(null);
  const [form, setForm] = useState({ decision: "confirmed", expectedStartDate: "", expectedFinishDate: "", proposedArrivalDate: "", reason: "" });
  const [orderForm, setOrderForm] = useState({ decision: "confirmed", proposedDueDate: "", reason: "" });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [planResponse, orderResponse, sessionResponse] = await Promise.all([
        fetch("/api/v1/purchase-plans", { cache: "no-store" }),
        fetch("/api/v1/purchase-orders", { cache: "no-store" }),
        fetch("/api/v1/session", { cache: "no-store" }),
      ]);
      const [planData, orderData, sessionData] = await Promise.all([planResponse.json(), orderResponse.json(), sessionResponse.json()]);
      if (!planResponse.ok) throw new Error(planData.error ?? "采购计划加载失败");
      if (!orderResponse.ok) throw new Error(orderData.error ?? "采购单加载失败");
      setPlans(planData.plans ?? []);
      setOrders(orderData.orders ?? []);
      if (sessionResponse.ok) setSession(sessionData);
    } catch (error) {
      toast(error instanceof Error ? error.message : "采购数据加载失败");
    } finally {
      setLoading(false);
    }
  }, [toast]);
  useEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;
    void Promise.all([
      fetch("/api/v1/purchase-plans", { cache: "no-store", signal }),
      fetch("/api/v1/purchase-orders", { cache: "no-store", signal }),
      fetch("/api/v1/session", { cache: "no-store", signal }),
    ]).then(async ([planResponse, orderResponse, sessionResponse]) => {
      const [planData, orderData, sessionData] = await Promise.all([planResponse.json(), orderResponse.json(), sessionResponse.json()]);
      if (!planResponse.ok) throw new Error(planData.error ?? "采购计划加载失败");
      if (!orderResponse.ok) throw new Error(orderData.error ?? "采购单加载失败");
      return { orderData, planData, sessionData, sessionOk: sessionResponse.ok };
    }).then(({ orderData, planData, sessionData, sessionOk }) => {
      if (signal.aborted) return;
      setPlans(planData.plans ?? []);
      setOrders(orderData.orders ?? []);
      if (sessionOk) setSession(sessionData);
    }).catch(error => { if (!signal.aborted) toast(error instanceof Error ? error.message : "采购数据加载失败"); })
      .finally(() => { if (!signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [load, toast]);

  const planRows = useMemo(() => plans.flatMap(plan => plan.items.map(item => ({ plan, item }))).filter(({ plan, item }) =>
    `${plan.planNo}${item.sku}${item.productName}${item.factoryName}`.toLowerCase().includes(query.toLowerCase())), [plans, query]);
  const visibleOrders = useMemo(() => orders.filter(order => `${order.orderNo}${order.items.map(item => `${item.sku}${item.productName}`).join("")}`.toLowerCase().includes(query.toLowerCase())), [orders, query]);
  const totalPlanned = planRows.reduce((sum, row) => sum + row.item.plannedQuantity, 0);
  const totalOrdered = planRows.reduce((sum, row) => sum + row.item.orderedQuantity, 0);
  const pendingPlans = plans.filter(plan => plan.status === "awaiting_factory_confirmation").length;
  const deviations = planRows.filter(row => ["over_plan_pending", "under_plan_pending"].includes(row.item.completionStatus)).length;
  const isFactory = Boolean(session?.user.roles.includes("factory") && session.user.factoryId);
  const canFinalize = Boolean(session?.user.roles.some(role => ["admin", "supply_chain"].includes(role)));
  const canReceive = Boolean(session?.user.roles.some(role => ["admin", "supply_chain", "factory"].includes(role)));
  function receiptWarehouseId(item: PurchaseOrder["items"][number]): number | undefined {
    if (!Array.isArray(item.planLinks) || item.planLinks.length !== 1) return undefined;
    const warehouseId = item.planLinks[0]?.planItem?.warehouseId;
    return typeof warehouseId === "number" && Number.isSafeInteger(warehouseId) && warehouseId > 0 ? warehouseId : undefined;
  }

  async function finalizeOrdering(plan: Plan) {
    if (submitting) return;
    setSubmitting(true);
    try {
      const data = await updatePurchasePlan<{ approvalRequired: boolean }>({ id: plan.id, action: "finalize_ordering", expectedUpdatedAt: plan.updatedAt });
      toast(data.approvalRequired ? "未足计划采购已提交双人审批。" : "采购计划已在安全偏差范围内完成下单。");
      await load();
    } finally { setSubmitting(false); }
  }

  async function submitFactoryResponse() {
    if (!confirming || submitting) return;
    setSubmitting(true);
    try {
      await updatePurchasePlan({ id: confirming.id, expectedUpdatedAt: confirming.updatedAt, ...form });
      toast(form.decision === "confirmed" ? "采购计划已确认。" : "异议已提交供应链审批。");
      setConfirming(null);
      setForm({ decision: "confirmed", expectedStartDate: "", expectedFinishDate: "", proposedArrivalDate: "", reason: "" });
      await load();
    } finally {
      setSubmitting(false);
    }
  }

  async function submitOrderResponse() {
    if (!confirmingOrder || submitting) return;
    setSubmitting(true);
    try {
      await updatePurchaseOrder({ id: confirmingOrder.id, expectedUpdatedAt: confirmingOrder.updatedAt, ...orderForm });
      toast(orderForm.decision === "confirmed" ? "采购单已确认，可以按期交货。" : "建议交货日期已提交供应链审批。");
      setConfirmingOrder(null);
      setOrderForm({ decision: "confirmed", proposedDueDate: "", reason: "" });
      await load();
    } finally {
      setSubmitting(false);
    }
  }

  async function submitReceive() {
    if (!receiving || submitting) return;
    setSubmitting(true);
    try {
      const warehouseId = receiptWarehouseId(receiving);
      if (warehouseId === undefined) throw new Error("该采购明细没有唯一有效的收货仓库，无法整批收货");
      await mutateJson("/api/v1/purchase-receipts", "POST", {
        purchaseOrderId: receiving.purchaseOrderId,
        orderItemId: receiving.id,
        warehouseId,
      });
      toast(`采购明细 ${receiving.sku} 已整批收货，进入待检批次`);
      setReceiving(null);
      await load();
    } catch (error) {
      toast(error instanceof Error ? error.message : "整批收货失败");
    } finally {
      setSubmitting(false);
    }
  }

  return <section className="purchase-page">
    <div className="purchase-heading">
      <div><span className="eyebrow dark">采购计划与采购单</span><h2>真实采购数据执行台</h2><p>按期望到货日期、组装工厂、采购仓库和 SKU 汇总，展示当前有效版本及实际消耗。</p></div>
      <div className="purchase-actions"><button className="secondary-action" onClick={() => openImport("plan")}>导入采购计划</button><button onClick={() => openImport("order")}>导入采购单</button></div>
    </div>
    <div className="purchase-switch"><button className={view === "计划" ? "active" : ""} onClick={() => setView("计划")}>采购计划 <b>{plans.length}</b></button><button className={view === "采购单" ? "active" : ""} onClick={() => setView("采购单")}>正式采购单 <b>{orders.length}</b></button></div>
    <div className="purchase-kpis">
      <article><span>计划采购量</span><strong>{totalPlanned.toLocaleString()}</strong><small>当前可见版本</small></article>
      <article><span>累计已下单</span><strong>{totalOrdered.toLocaleString()}</strong><small>{totalPlanned ? `${(totalOrdered / totalPlanned * 100).toFixed(1)}% 已消耗` : "等待计划数据"}</small></article>
      <article><span>待工厂确认</span><strong>{pendingPlans}</strong><small>计划 3 天 · 采购单 24 小时</small></article>
      <article className="alert-card"><span>偏差待审批</span><strong>{deviations}</strong><small>按 SKU 容差自动判断</small></article>
    </div>
    <article className="panel purchase-list">
      <div className="purchase-toolbar"><div><h3>{view === "计划" ? "采购计划汇总" : "正式采购单"}</h3><p>{loading ? "正在读取数据库…" : "数据来自 RDS，刷新页面不会丢失"}</p></div><div><button onClick={() => void load()}>刷新</button><input aria-label="搜索采购数据" placeholder="搜索单号、SKU、产品或工厂" value={query} onChange={event => setQuery(event.target.value)}/></div></div>
      {view === "计划" ? <div className="purchase-table">
        <div className="purchase-row purchase-head"><span>计划 / 到货日期</span><span>SKU / 产品</span><span>组装工厂 / 仓库</span><span>计划消耗</span><span>安全偏差</span><span>状态 / 操作</span></div>
        {!loading && !planRows.length ? <div className="empty-state">暂无正式采购计划，请先通过“导入采购计划”创建。</div> : planRows.map(({ plan, item }) => {
          const rate = Math.min(100, item.plannedQuantity ? item.orderedQuantity / item.plannedQuantity * 100 : 0);
          return <div className="purchase-row" key={`${plan.id}-${item.id}`}>
            <span><strong>{plan.planNo} · V{plan.version}</strong><small>期望到货 {item.expectedArrivalDate}</small></span>
            <span><strong>{item.sku}</strong><small>{item.productName}</small></span>
            <span><strong>{item.factoryName}</strong><small>{item.warehouseName}</small></span>
            <span><div className="purchase-progress"><i style={{ width: `${rate}%` }}/></div><small>{item.orderedQuantity.toLocaleString()} / {item.plannedQuantity.toLocaleString()} · 剩余 {Math.max(0, item.plannedQuantity - item.orderedQuantity).toLocaleString()}</small></span>
            <span><b>+{(item.overToleranceBps / 100).toFixed(1)}% / -{(item.underToleranceBps / 100).toFixed(1)}%</b><small>{ITEM_STATUS[item.completionStatus] ?? item.completionStatus}</small></span>
            <span><mark className="plan-status">{PLAN_STATUS[plan.status] ?? plan.status}</mark>{isFactory && plan.status === "awaiting_factory_confirmation" ? <button className="compact-action" onClick={() => setConfirming(plan)}>确认计划</button> : null}{canFinalize && ["confirmed", "ordering"].includes(plan.status) ? <button className="compact-action" disabled={submitting} onClick={() => void finalizeOrdering(plan)}>完成下单核对</button> : null}</span>
          </div>;
        })}
      </div> : <div className="po-board">
        {!loading && !visibleOrders.length ? <div className="empty-state">暂无正式采购单，请先通过“导入采购单”创建。</div> : visibleOrders.map(order => <div className="po-card-wrap" key={order.id}>
          <button className="po-card" onClick={() => isFactory && order.status === "factory_confirmation" ? setConfirmingOrder(order) : setExpandedOrderId(expandedOrderId === order.id ? null : order.id)}>
            <span><strong>{order.orderNo}</strong><small>下单日期 {order.orderDate ?? "待补充"}</small></span><span><small>含税金额</small><b>¥ {(order.totalTaxIncludedMinor / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}</b></span><span><small>SKU / 数量</small><b>{order.items.length} / {order.items.reduce((sum, item) => sum + item.quantity, 0).toLocaleString()}</b></span><span><mark>{ORDER_STATUS[order.status] ?? order.status}</mark><small>已收货 {order.items.reduce((sum, item) => sum + (item.receivedQuantity || 0), 0).toLocaleString()} 件 · {order.confirmationDueAt && order.status === "factory_confirmation" ? `确认截止 ${new Date(order.confirmationDueAt).toLocaleString("zh-CN")}` : order.items[0]?.dueDate ? `最早交货 ${order.items.map(item => item.dueDate).filter(Boolean).sort()[0]}` : "待维护交货日期"}</small></span><i>→</i>
          </button>
          {expandedOrderId === order.id && <div className="po-card-detail">{order.items.map(item => {
            const warehouseId = receiptWarehouseId(item);
            const fullyReceived = (item.receivedQuantity || 0) >= item.quantity;
            const canReceiveItem = canReceive && order.status === "confirmed" && warehouseId !== undefined;
            const receiptState = fullyReceived ? "已收货" : order.status !== "confirmed" ? "采购单未确认" : warehouseId === undefined ? (Array.isArray(item.planLinks) && item.planLinks.length > 1 ? "多仓分配待配置" : "未关联收货仓库") : null;
            return <div className="po-item-row" key={item.id}><span><strong>{item.sku}</strong><small>{item.productName}</small></span><span>{(item.receivedQuantity || 0).toLocaleString()} / {item.quantity.toLocaleString()} 件已收货</span><span>{warehouseId !== undefined ? `收货仓库 #${warehouseId}` : (Array.isArray(item.planLinks) && item.planLinks.length > 1 ? "多仓分配待配置" : "未关联收货仓库")}</span>{fullyReceived ? <mark className="plan-status">已收货</mark> : canReceiveItem ? <button className="compact-action" disabled={submitting} onClick={() => setReceiving({ ...item, purchaseOrderId: order.id })}>整批收货</button> : receiptState ? <mark className="plan-status">{receiptState}</mark> : null}</div>;
          })}</div>}
        </div>)}
      </div>}
    </article>
    {confirming ? <div className="modal-backdrop" role="dialog" aria-modal="true"><div className="modal-card"><div className="modal-head"><div><span className="eyebrow dark">工厂确认</span><h3>{confirming.planNo} · V{confirming.version}</h3></div><button aria-label="关闭" onClick={() => setConfirming(null)}>×</button></div><div className="form-grid">
      <label>确认结果<select value={form.decision} onChange={event => setForm(current => ({ ...current, decision: event.target.value }))}><option value="confirmed">可以按计划完成</option><option value="unable">无法按计划完成</option></select></label>
      <label>预计开工日期<input type="date" value={form.expectedStartDate} onChange={event => setForm(current => ({ ...current, expectedStartDate: event.target.value }))}/></label>
      <label>预计完工日期<input type="date" value={form.expectedFinishDate} onChange={event => setForm(current => ({ ...current, expectedFinishDate: event.target.value }))}/></label>
      {form.decision === "unable" ? <><label>建议到货日期<input type="date" value={form.proposedArrivalDate} onChange={event => setForm(current => ({ ...current, proposedArrivalDate: event.target.value }))}/></label><label className="full-field">无法完成原因<textarea value={form.reason} onChange={event => setForm(current => ({ ...current, reason: event.target.value }))}/></label></> : null}
    </div><div className="modal-actions"><button className="secondary-action" onClick={() => setConfirming(null)}>取消</button><button disabled={submitting} onClick={() => void submitFactoryResponse()}>{submitting ? "提交中…" : "提交确认"}</button></div></div></div> : null}
    {confirmingOrder ? <div className="modal-backdrop" role="dialog" aria-modal="true"><div className="modal-card"><div className="modal-head"><div><span className="eyebrow dark">采购单 24 小时确认</span><h3>{confirmingOrder.orderNo}</h3></div><button aria-label="关闭" onClick={() => setConfirmingOrder(null)}>×</button></div><div className="form-grid">
      <label>确认结果<select value={orderForm.decision} onChange={event => setOrderForm(current => ({ ...current, decision: event.target.value }))}><option value="confirmed">可以按期交货</option><option value="unable">无法按期交货</option></select></label>
      {orderForm.decision === "unable" ? <><label>建议交货日期<input type="date" value={orderForm.proposedDueDate} onChange={event => setOrderForm(current => ({ ...current, proposedDueDate: event.target.value }))}/></label><label className="full-field">无法按期原因<textarea value={orderForm.reason} onChange={event => setOrderForm(current => ({ ...current, reason: event.target.value }))}/></label></> : <div><small>确认后采购单将进入执行状态，系统继续跟踪生产与交付。</small></div>}
    </div><div className="modal-actions"><button className="secondary-action" onClick={() => setConfirmingOrder(null)}>取消</button><button disabled={submitting} onClick={() => void submitOrderResponse()}>{submitting ? "提交中…" : "提交确认"}</button></div></div></div> : null}
    {receiving ? <div className="modal-backdrop" role="dialog" aria-modal="true"><div className="modal-card"><div className="modal-head"><div><span className="eyebrow dark">整批收货</span><h3>{receiving.sku}</h3></div><button aria-label="关闭" onClick={() => setReceiving(null)}>×</button></div><div className="form-grid">
      <label>采购明细<input readOnly value={receiving.productName}/></label>
      <label>待收货数量<input readOnly value={receiving.quantity - (receiving.receivedQuantity || 0)}/></label>
      <label>收货仓库<input readOnly value={receiving.planLinks?.[0]?.planItem?.warehouseId ?? "未关联"}/></label>
    </div><div className="modal-actions"><button className="secondary-action" onClick={() => setReceiving(null)}>取消</button><button disabled={submitting} onClick={() => void submitReceive()}>{submitting ? "提交中…" : "确认整批收货"}</button></div></div></div> : null}
  </section>;
}
