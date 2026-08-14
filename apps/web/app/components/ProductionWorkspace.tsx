"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { mutateJson } from "../lib/mutation-client";

type Material = { id: number; theoreticalQuantity: number; issuedQuantity: number; consumedQuantity: number; lossQuantity: number; deviationStatus: string; component?: { componentSku: string; componentName: string } };
type Order = { id: number; executionNo: string; plannedQuantity: number; completedQuantity: number; status: string; plannedStartDate?: string; plannedFinishDate?: string; item?: { sku: string; productName: string }; purchaseOrder?: { orderNo: string }; factory?: { name: string }; bom?: { id: number; version: string }; materials: Material[]; reports: Array<{ result: string; actualFinishedQuantity: number }> };
type Data = { orders: Order[]; options: { orderItems: Array<{ id: number; sku: string; productName: string; quantity: number; purchaseOrder?: { orderNo: string } }>; factories: Array<{ id: number; name: string }>; boms: Array<{ id: number; finishedSku: string; version: string }> } };

const STATUS: Record<string, string> = { planned: "已计划", in_production: "生产中", variance_pending: "偏差待审批", completed: "已完成", completed_factory_owned: "已结案（含工厂自有库存）", variance_rejected: "偏差已拒绝" };

export default function ProductionWorkspace({ toast }: { toast: (message: string) => void }) {
  const [data, setData] = useState<Data>({ orders: [], options: { orderItems: [], factories: [], boms: [] } });
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [values, setValues] = useState<Record<number, { issuedQuantity: number; consumedQuantity: number; lossQuantity: number }>>({});
  const [form, setForm] = useState({ orderItemId: "", factoryId: "", bomId: "", plannedQuantity: "", plannedStartDate: "", plannedFinishDate: "" });

  const load = useCallback(async () => {
    setLoading(true);
    const response = await fetch("/api/v1/production-orders", { cache: "no-store" });
    const body = await response.json();
    if (response.ok) setData(body); else toast(body.error ?? "生产数据加载失败");
    setLoading(false);
  }, [toast]);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/v1/production-orders", { cache: "no-store", signal: controller.signal })
      .then(async response => ({ body: await response.json(), ok: response.ok }))
      .then(({ body, ok }) => {
        if (controller.signal.aborted) return;
        if (ok) setData(body); else toast(body.error ?? "生产数据加载失败");
      })
      .catch(error => { if (!controller.signal.aborted) toast(error instanceof Error ? error.message : "生产数据加载失败"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [load, toast]);

  const selectedItem = data.options.orderItems.find(item => item.id === Number(form.orderItemId));
  const availableBoms = useMemo(() => data.options.boms.filter(bom => bom.finishedSku === selectedItem?.sku), [data.options.boms, selectedItem]);
  function patchForm(name: string, value: string) {
    const next = { ...form, [name]: value };
    if (name === "orderItemId") {
      const item = data.options.orderItems.find(row => row.id === Number(value));
      next.plannedQuantity = item ? String(item.quantity) : "";
      next.bomId = "";
    }
    setForm(next);
  }
  async function send(method: "POST" | "PATCH", payload: Record<string, unknown>, success: string) {
    try {
      await mutateJson("/api/v1/production-orders", method, payload);
      toast(success); await load();
    } catch (error) { toast(error instanceof Error ? error.message : "操作失败"); }
  }
  async function create() {
    await send("POST", { ...form, orderItemId: Number(form.orderItemId), factoryId: Number(form.factoryId), bomId: Number(form.bomId), plannedQuantity: Number(form.plannedQuantity) }, "生产单已创建");
    setCreating(false);
  }
  function openMaterials(order: Order) {
    setExpanded(expanded === order.id ? null : order.id);
    setValues(current => ({ ...current, ...Object.fromEntries(order.materials.map(line => [line.id, current[line.id] ?? { issuedQuantity: line.issuedQuantity, consumedQuantity: line.consumedQuantity, lossQuantity: line.lossQuantity }])) }));
  }
  const linePayload = (order: Order) => order.materials.map(line => ({ id: line.id, ...(values[line.id] ?? { issuedQuantity: 0, consumedQuantity: 0, lossQuantity: 0 }) }));
  async function complete(order: Order) {
    const entered = window.prompt("请输入实际完工数量", String(order.completedQuantity || order.plannedQuantity));
    if (entered === null) return;
    await send("PATCH", { id: order.id, action: "complete", actualFinishedQuantity: Number(entered), materials: linePayload(order) }, "完工报告已提交；如有偏差将自动进入审批");
  }

  return <section className="production-workspace">
    <div className="panel-head"><div><h2>生产执行</h2><p>按生产单跟踪 BOM 用量、领料、消耗、损耗及完工偏差</p></div><button className="primary" onClick={() => setCreating(true)}>新建生产单</button></div>
    <div className="production-summary"><span><strong>{data.orders.length}</strong>生产单</span><span><strong>{data.orders.filter(row => row.status === "in_production").length}</strong>生产中</span><span><strong>{data.orders.filter(row => row.status === "variance_pending").length}</strong>偏差待审批</span></div>
    {creating && <div className="production-form">
      <label>采购明细<select value={form.orderItemId} onChange={e => patchForm("orderItemId", e.target.value)}><option value="">请选择</option>{data.options.orderItems.map(item => <option key={item.id} value={item.id}>{item.purchaseOrder?.orderNo} · {item.sku} · {item.productName}</option>)}</select></label>
      <label>组装工厂<select value={form.factoryId} onChange={e => patchForm("factoryId", e.target.value)}><option value="">请选择</option>{data.options.factories.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
      <label>BOM版本<select value={form.bomId} onChange={e => patchForm("bomId", e.target.value)}><option value="">请选择</option>{availableBoms.map(row => <option key={row.id} value={row.id}>{row.version}</option>)}</select></label>
      <label>计划数量<input type="number" value={form.plannedQuantity} onChange={e => patchForm("plannedQuantity", e.target.value)} /></label>
      <label>计划开工<input type="date" value={form.plannedStartDate} onChange={e => patchForm("plannedStartDate", e.target.value)} /></label>
      <label>计划完工<input type="date" value={form.plannedFinishDate} onChange={e => patchForm("plannedFinishDate", e.target.value)} /></label>
      <div className="form-actions"><button onClick={() => setCreating(false)}>取消</button><button className="primary" onClick={() => void create()}>创建</button></div>
    </div>}
    {loading ? <div className="empty">正在加载…</div> : data.orders.length === 0 ? <div className="empty">暂无生产单，可从已导入的成品采购明细创建。</div> : <div className="production-list">{data.orders.map(order => <article key={order.id} className="production-card">
      <div className="production-row"><div><strong>{order.executionNo}</strong><small>{order.purchaseOrder?.orderNo} · {order.item?.sku} · {order.item?.productName}</small></div><div>{order.factory?.name}<small>BOM {order.bom?.version ?? "-"}</small></div><div>计划 {order.plannedQuantity}<small>完成 {order.completedQuantity}</small></div><span className={`status ${order.status}`}>{STATUS[order.status] ?? order.status}</span><div className="row-actions">{order.status === "planned" && <button onClick={() => void send("PATCH", { id: order.id, action: "start" }, "生产已开始")}>开工</button>}<button onClick={() => openMaterials(order)}>物料</button><button onClick={() => void send("PATCH", { id: order.id, action: "release_materials" }, "剩余预留已释放")}>释放预留</button>{["planned", "in_production"].includes(order.status) && <button className="primary" onClick={() => void complete(order)}>完工</button>}</div></div>
      {expanded === order.id && <div className="material-editor"><div className="material-head"><span>物料</span><span>理论/预留</span><span>实际领料</span><span>实际消耗</span><span>损耗</span><span>偏差</span></div>{order.materials.map(line => { const value = values[line.id] ?? { issuedQuantity: 0, consumedQuantity: 0, lossQuantity: 0 }; return <div className="material-line" key={line.id}><span>{line.component?.componentSku}<small>{line.component?.componentName}</small></span><span>{line.theoreticalQuantity}</span>{(["issuedQuantity", "consumedQuantity", "lossQuantity"] as const).map(key => <input key={key} type="number" min="0" value={value[key]} onChange={e => setValues(all => ({ ...all, [line.id]: { ...value, [key]: Number(e.target.value) } }))} />)}<span>{line.deviationStatus === "pending_approval" ? "待审批" : "正常"}</span></div>})}<div className="form-actions"><button className="primary" onClick={() => void send("PATCH", { id: order.id, action: "materials", materials: linePayload(order) }, "物料实绩已保存")}>保存实绩</button></div></div>}
    </article>)}</div>}
  </section>;
}
