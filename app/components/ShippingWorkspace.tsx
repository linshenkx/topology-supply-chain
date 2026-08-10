"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type Shipment = {
  id: number; executionOrderId: number; batchNo: string; quantity: number; plannedShipAt: string;
  shippedAt?: string | null; carrier: string; logisticsNo: string; destination: string; status: string;
  item?: { sku?: string; productName?: string } | null;
  receipts?: Array<{ id: number; receivedQuantity: number; damagedQuantity: number; receivedAt: string }>;
  exceptions?: Array<{ id: number; description: string; status: string }>;
};

type ReturnRecord = {
  id: number; returnNo: string; sourceDeliveryBatchId: number; warehouseId: number; sku: string; quantity: number; status: string;
  inspections?: Array<{ id: number; passedQuantity: number; failedQuantity: number; defectReason: string }>;
  dispositions?: Array<{ id: number; type: string; quantity: number; status: string }>;
};

const statusText: Record<string, string> = {
  pending_factory_confirmation: "待工厂确认", planned: "待发货", pending_supply_chain: "待供应链审批",
  approved_to_ship: "已批准发货", shipped: "运输中", received: "已签收", received_with_exception: "物流异常",
  quarantined: "退货冻结待检", pending_supply_chain_review: "待审核", restocked: "已重新入库", rework: "返工中", scrapped: "已报废",
};

async function jsonRequest(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

async function upload(file: File, category: string) {
  const form = new FormData();
  form.append("file", file);
  form.append("category", category);
  const data = await jsonRequest("/api/files", { method: "POST", body: form });
  return data.file as { objectKey: string; fileName: string };
}

export default function ShippingWorkspace({ toast }: { toast: (message: string) => void }) {
  const [tab, setTab] = useState<"shipments" | "returns">("shipments");
  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [returns, setReturns] = useState<ReturnRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<{ type: "ship" | "receive" | "inspect" | "propose"; id: number } | null>(null);

  const refresh = useCallback(async () => {
    const [shipmentData, returnData] = await Promise.all([jsonRequest("/api/shipments"), jsonRequest("/api/returns")]);
    setShipments(shipmentData.shipments ?? []);
    setReturns(returnData.returns ?? []);
  }, []);

  useEffect(() => { refresh().catch(error => toast(error.message)); }, [refresh, toast]);

  const summary = useMemo(() => ({
    waiting: shipments.filter(row => ["pending_factory_confirmation", "planned", "approved_to_ship"].includes(row.status)).length,
    transit: shipments.filter(row => row.status === "shipped").length,
    abnormal: shipments.filter(row => row.status === "received_with_exception").length,
    returns: returns.filter(row => !["restocked", "rework", "scrapped"].includes(row.status)).length,
  }), [shipments, returns]);

  async function post(path: string, payload: unknown, success: string) {
    setBusy(true);
    try {
      await jsonRequest(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      toast(success); setAction(null); await refresh();
    } catch (error) { toast(error instanceof Error ? error.message : "操作失败"); }
    finally { setBusy(false); }
  }

  async function createShipment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await post("/api/shipments", {
      action: "create", executionOrderId: Number(form.get("executionOrderId")), batchNo: form.get("batchNo"),
      quantity: Number(form.get("quantity")), plannedShipAt: form.get("plannedShipAt"), destination: form.get("destination"),
    }, "发货计划已创建，等待组装工厂确认");
    event.currentTarget.reset();
  }

  return <section className="shipping-workspace">
    <div className="panel-head"><div><h2>发货、签收与退货</h2><p>计划需工厂共同确认；偏离计划自动进入供应链审批。</p></div><button className="ghost-btn" onClick={() => refresh()}>刷新</button></div>
    <div className="production-summary">
      <article><strong>{summary.waiting}</strong><span>待确认/待发货</span></article>
      <article><strong>{summary.transit}</strong><span>运输中</span></article>
      <article><strong>{summary.abnormal}</strong><span>物流异常</span></article>
      <article><strong>{summary.returns}</strong><span>待处理退货</span></article>
    </div>
    <div className="workspace-tabs">
      <button className={tab === "shipments" ? "active" : ""} onClick={() => setTab("shipments")}>发货与签收</button>
      <button className={tab === "returns" ? "active" : ""} onClick={() => setTab("returns")}>退货处理</button>
    </div>

    {tab === "shipments" ? <>
      <form className="production-form" onSubmit={createShipment}>
        <label>执行单ID<input name="executionOrderId" type="number" min="1" required /></label>
        <label>发货批次号<input name="batchNo" required /></label>
        <label>计划数量<input name="quantity" type="number" min="1" required /></label>
        <label>计划发货时间<input name="plannedShipAt" type="datetime-local" required /></label>
        <label>收货地址<input name="destination" required /></label>
        <button disabled={busy}>创建发货计划</button>
      </form>
      <div className="shipping-list">{shipments.map(row => <article className="production-card" key={row.id}>
        <div className="production-row"><div><strong>{row.batchNo}</strong><span>{row.item?.sku || `执行单 #${row.executionOrderId}`} · {row.quantity} 件</span></div><span className={`status ${row.status.includes("exception") ? "bad" : ""}`}>{statusText[row.status] || row.status}</span></div>
        <div className="shipping-facts"><span>计划：{new Date(row.plannedShipAt).toLocaleString("zh-CN")}</span><span>目的地：{row.destination}</span>{row.logisticsNo && <span>{row.carrier} · {row.logisticsNo}</span>}</div>
        {row.exceptions?.filter(item => item.status !== "resolved").map(item => <div className="exception-line" key={item.id}><span>异常：{item.description}</span><button onClick={() => { const resolution = window.prompt("请输入处理结果"); if (resolution) post("/api/shipments", { action: "resolve_exception", exceptionId: item.id, resolution }, "物流异常已关闭"); }}>关闭异常</button></div>)}
        <div className="row-actions">
          {row.status === "pending_factory_confirmation" && <button onClick={() => post("/api/shipments", { action: "confirm", deliveryBatchId: row.id }, "发货计划已确认")}>确认计划</button>}
          {["planned", "approved_to_ship"].includes(row.status) && <button onClick={() => setAction({ type: "ship", id: row.id })}>登记实际发货</button>}
          {row.status === "shipped" && <button onClick={() => setAction({ type: "receive", id: row.id })}>确认签收</button>}
        </div>
      </article>)}</div>
    </> : <ReturnsPanel rows={returns} shipments={shipments} busy={busy} post={post} action={action} setAction={setAction} />}

    {action?.type === "ship" && <ShipForm id={action.id} busy={busy} post={post} close={() => setAction(null)} />}
    {action?.type === "receive" && <ReceiveForm id={action.id} busy={busy} post={post} close={() => setAction(null)} />}
    {action?.type === "inspect" && <InspectForm record={returns.find(row => row.id === action.id)!} busy={busy} post={post} close={() => setAction(null)} />}
    {action?.type === "propose" && <DispositionForm record={returns.find(row => row.id === action.id)!} busy={busy} post={post} close={() => setAction(null)} />}
  </section>;
}

function ActionBox({ title, children, close }: { title: string; children: React.ReactNode; close: () => void }) {
  return <div className="shipping-action"><div className="panel-head"><h3>{title}</h3><button className="ghost-btn" onClick={close}>取消</button></div>{children}</div>;
}

function ShipForm({ id, busy, post, close }: { id: number; busy: boolean; post: Function; close: () => void }) {
  return <ActionBox title="登记实际发货" close={close}><form className="production-form" onSubmit={async event => {
    event.preventDefault(); const form = new FormData(event.currentTarget); const file = form.get("evidence") as File;
    try { const saved = await upload(file, "shipment_evidence"); await post("/api/shipments", { action: "ship", deliveryBatchId: id, shippedAt: form.get("shippedAt"), carrier: form.get("carrier"), logisticsNo: form.get("logisticsNo"), deviationReason: form.get("deviationReason"), evidenceFileKey: saved.objectKey, evidenceFileName: saved.fileName }, "实际发货已登记，库存已扣减"); } catch (error) { window.alert(error instanceof Error ? error.message : "上传失败"); }
  }}><label>实际发货时间<input name="shippedAt" type="datetime-local" required /></label><label>承运商<input name="carrier" required /></label><label>物流单号<input name="logisticsNo" required /></label><label>偏离原因<input name="deviationReason" placeholder="未按计划日期时必填" /></label><label>发货凭证<input name="evidence" type="file" accept="image/*,.pdf" required /></label><button disabled={busy}>提交发货</button></form></ActionBox>;
}

function ReceiveForm({ id, busy, post, close }: { id: number; busy: boolean; post: Function; close: () => void }) {
  return <ActionBox title="确认收货" close={close}><form className="production-form" onSubmit={async event => {
    event.preventDefault(); const form = new FormData(event.currentTarget); const file = form.get("evidence") as File;
    try { const saved = await upload(file, "receipt_evidence"); await post("/api/shipments", { action: "receive", deliveryBatchId: id, receivedQuantity: Number(form.get("receivedQuantity")), damagedQuantity: Number(form.get("damagedQuantity")), receivedAt: form.get("receivedAt"), exceptionReason: form.get("exceptionReason"), receiptEvidenceFileKey: saved.objectKey }, "签收已确认"); } catch (error) { window.alert(error instanceof Error ? error.message : "上传失败"); }
  }}><label>签收数量<input name="receivedQuantity" type="number" min="0" required /></label><label>破损数量<input name="damagedQuantity" type="number" min="0" defaultValue="0" required /></label><label>签收时间<input name="receivedAt" type="datetime-local" required /></label><label>少货/破损原因<input name="exceptionReason" /></label><label>签收凭证<input name="evidence" type="file" accept="image/*,.pdf" required /></label><button disabled={busy}>确认签收</button></form></ActionBox>;
}

function ReturnsPanel({ rows, shipments, busy, post, action, setAction }: { rows: ReturnRecord[]; shipments: Shipment[]; busy: boolean; post: Function; action: unknown; setAction: Function }) {
  return <><form className="production-form" onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); post("/api/returns", { action: "receive", returnNo: form.get("returnNo"), sourceDeliveryBatchId: Number(form.get("sourceDeliveryBatchId")), warehouseId: Number(form.get("warehouseId")), quantity: Number(form.get("quantity")) }, "退货已登记并进入冻结库存"); event.currentTarget.reset(); }}>
    <label>退货单号<input name="returnNo" required /></label><label>原发货批次<select name="sourceDeliveryBatchId" required><option value="">请选择</option>{shipments.map(row => <option key={row.id} value={row.id}>{row.batchNo}</option>)}</select></label><label>退回仓库ID<input name="warehouseId" type="number" min="1" required /></label><label>退货数量<input name="quantity" type="number" min="1" required /></label><button disabled={busy}>登记退货</button>
  </form><div className="shipping-list">{rows.map(row => <article className="production-card" key={row.id}><div className="production-row"><div><strong>{row.returnNo}</strong><span>{row.sku} · {row.quantity} 件</span></div><span className="status">{statusText[row.status] || row.status}</span></div>{row.inspections?.map(item => <div className="shipping-facts" key={item.id}><span>质检：合格 {item.passedQuantity} / 不合格 {item.failedQuantity}</span><span>{item.defectReason}</span></div>)}{row.dispositions?.map(item => <div className="shipping-facts" key={item.id}><span>{({ restock: "重新入库", rework: "返工", scrap: "报废" } as Record<string,string>)[item.type]} {item.quantity} 件</span><span>{item.status}</span></div>)}<div className="row-actions">{row.status === "quarantined" && <button onClick={() => setAction({ type: "inspect", id: row.id })}>退货质检</button>}{row.status === "pending_supply_chain" && !row.dispositions?.length && <button onClick={() => setAction({ type: "propose", id: row.id })}>工厂提交方案</button>}{row.status === "pending_supply_chain" && !!row.dispositions?.length && <><button onClick={() => post("/api/returns", { action: "review", productReturnId: row.id, decision: "approved" }, "退货方案已批准")}>供应链批准</button><button className="danger-btn" onClick={() => post("/api/returns", { action: "review", productReturnId: row.id, decision: "rejected" }, "退货方案已拒绝")}>拒绝</button></>}</div></article>)}</div></>;
}

function InspectForm({ record, busy, post, close }: { record: ReturnRecord; busy: boolean; post: Function; close: () => void }) {
  return <ActionBox title="退货质检" close={close}><form className="production-form" onSubmit={async event => { event.preventDefault(); const form = new FormData(event.currentTarget); const file = form.get("evidence") as File; try { const saved = await upload(file, "quality_evidence"); const passed = Number(form.get("passedQuantity")); await post("/api/returns", { action: "inspect", productReturnId: record.id, inspectedQuantity: record.quantity, passedQuantity: passed, failedQuantity: record.quantity - passed, defectReason: form.get("defectReason"), evidenceFileKey: saved.objectKey }, "退货质检已完成"); } catch (error) { window.alert(error instanceof Error ? error.message : "上传失败"); } }}><label>检验数量<input value={record.quantity} readOnly /></label><label>合格数量<input name="passedQuantity" type="number" min="0" max={record.quantity} required /></label><label>不良原因<input name="defectReason" /></label><label>现场照片/凭证<input name="evidence" type="file" accept="image/*,.pdf" required /></label><button disabled={busy}>提交质检</button></form></ActionBox>;
}

function DispositionForm({ record, busy, post, close }: { record: ReturnRecord; busy: boolean; post: Function; close: () => void }) {
  return <ActionBox title="工厂退货处理方案" close={close}><form className="production-form" onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); post("/api/returns", { action: "propose", productReturnId: record.id, dispositions: [{ type: "restock", quantity: Number(form.get("restock")) }, { type: "rework", quantity: Number(form.get("rework")) }, { type: "scrap", quantity: Number(form.get("scrap")) }] }, "处理方案已提交供应链审核"); }}><label>重新入库<input name="restock" type="number" min="0" defaultValue="0" /></label><label>返工<input name="rework" type="number" min="0" defaultValue="0" /></label><label>报废<input name="scrap" type="number" min="0" defaultValue="0" /></label><p>三项合计必须等于 {record.quantity} 件。</p><button disabled={busy}>提交方案</button></form></ActionBox>;
}
