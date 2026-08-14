"use client";

import { useCallback, useEffect, useState } from "react";
import { mutateJson } from "../lib/mutation-client";

type Warehouse = { id: number; name: string };
type Batch = { id: number; batchNo: string; warehouseId: number; sku: string; pendingInspectionQuantity: number };
type Inspection = { id: number; batchId?: number | null; executionOrderId?: number | null; stage: string; finalResult: string | null; passedQuantity: number; failedQuantity: number; createdAt: string };

export default function QualityWorkspace({ toast }: { toast: (message: string) => void }) {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [inspections, setInspections] = useState<Inspection[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState<Batch | null>(null);
  const [defectReason, setDefectReason] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [inv, qi] = await Promise.all([
        fetch("/api/v1/inventory", { cache: "no-store" }),
        fetch("/api/v1/quality-inspections", { cache: "no-store" }),
      ]);
      const [invBody, qiBody] = await Promise.all([inv.json(), qi.json()]);
      if (!inv.ok) throw new Error(invBody.error ?? "库存数据加载失败");
      if (!qi.ok) throw new Error(qiBody.error ?? "质检数据加载失败");
      setBatches((invBody.batches ?? []).filter((row: Batch) => row.pendingInspectionQuantity > 0));
      setWarehouses(invBody.warehouses ?? []);
      setInspections(qiBody.inspections ?? []);
    } catch (error) {
      toast(error instanceof Error ? error.message : "质检数据加载失败");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      fetch("/api/v1/inventory", { cache: "no-store", signal: controller.signal }),
      fetch("/api/v1/quality-inspections", { cache: "no-store", signal: controller.signal }),
    ]).then(async ([inv, qi]) => {
      const [invBody, qiBody] = await Promise.all([inv.json(), qi.json()]);
      if (!inv.ok) throw new Error(invBody.error ?? "库存数据加载失败");
      if (!qi.ok) throw new Error(qiBody.error ?? "质检数据加载失败");
      return { invBody, qiBody };
    }).then(({ invBody, qiBody }) => {
      if (controller.signal.aborted) return;
      setBatches((invBody.batches ?? []).filter((row: Batch) => row.pendingInspectionQuantity > 0));
      setWarehouses(invBody.warehouses ?? []);
      setInspections(qiBody.inspections ?? []);
    }).catch(error => {
      if (!controller.signal.aborted) toast(error instanceof Error ? error.message : "质检数据加载失败");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [load, toast]);

  const warehouseName = (id: number) => warehouses.find(row => row.id === id)?.name ?? ("仓库 #" + id);

  async function decide(batch: Batch, result: "passed" | "failed", reason?: string) {
    setBusy(true);
    try {
      await mutateJson("/api/v1/quality-inspections", "POST", {
        batchId: batch.id,
        stage: "incoming",
        inspectionMethod: "full",
        batchQuantity: batch.pendingInspectionQuantity,
        inspectedQuantity: batch.pendingInspectionQuantity,
        passedQuantity: result === "passed" ? batch.pendingInspectionQuantity : 0,
        failedQuantity: result === "failed" ? batch.pendingInspectionQuantity : 0,
        inspectorType: "company_qc",
        ...(result === "failed" ? { defectReason: reason ?? "" } : {}),
      });
      toast(result === "passed" ? "整批合格，已转入可用库存" : "整批不合格，已转入隔离库存");
      setRejecting(null);
      setDefectReason("");
      await load();
    } catch (error) {
      toast(error instanceof Error ? error.message : "质检提交失败");
    } finally {
      setBusy(false);
    }
  }

  return <section className="quality-page real-quality">
    <div className="module-banner quality-banner"><div><span className="eyebrow">来料整批质检</span><h2>待检批次整批合格放行或整批隔离</h2><p>整批质检只允许全部合格或全部不合格；成功后刷新页面结果保持一致。</p></div><button onClick={() => void load()}>刷新数据</button></div>
    <div className="quality-kpis"><article><span>待检批次</span><strong>{batches.length}</strong><small>来自整批收货</small></article><article><span>最近质检</span><strong>{inspections.length}</strong><small>最近200条</small></article><article><span>合格</span><strong>{inspections.filter(row => row.finalResult === "passed").length}</strong><small>已转入可用</small></article><article className="alert-card"><span>隔离</span><strong>{inspections.filter(row => row.finalResult === "failed").length}</strong><small>已转入隔离库存</small></article></div>
    <article className="panel quality-list">
      <div className="quality-toolbar"><div><h3>待检库存批次</h3><p>{loading ? "正在读取数据库…" : "只有存在待检数量的批次可以整批判定"}</p></div></div>
      {!loading && !batches.length ? <div className="empty-state">暂无待检库存批次。请先在采购管理完成整批收货。</div> : <div className="quality-table"><div className="quality-row quality-head"><span>批次</span><span>SKU / 仓库</span><span>待检数量</span><span>操作</span></div>{batches.map(batch => <div className="quality-row" key={batch.id}><span><strong>{batch.batchNo}</strong><small>批次 #{batch.id}</small></span><span><strong>{batch.sku}</strong><small>{warehouseName(batch.warehouseId)}</small></span><span><b>{batch.pendingInspectionQuantity.toLocaleString()} 件</b><small>必须整批判定</small></span><span><button className="compact-action" disabled={busy} onClick={() => void decide(batch, "passed")}>整批合格</button><button className="danger-btn" disabled={busy} onClick={() => setRejecting(batch)}>整批不合格</button></span></div>)}</div>}
    </article>
    <article className="panel quality-list">
      <div className="quality-toolbar"><div><h3>最近质检记录</h3><p>数据来自数据库，刷新后保持一致</p></div></div>
      {inspections.length === 0 ? <div className="empty-state">暂无质检记录</div> : <div className="quality-table"><div className="quality-row quality-head"><span>质检单</span><span>对象</span><span>合格 / 不合格</span><span>结果</span></div>{inspections.slice(0, 50).map(row => <div className="quality-row" key={row.id}><span><strong>#{row.id}</strong><small>{new Date(row.createdAt).toLocaleString("zh-CN")}</small></span><span><strong>{row.batchId ? ("批次 #" + row.batchId) : ("执行单 #" + row.executionOrderId)}</strong><small>{row.stage}</small></span><span>{row.passedQuantity} / {row.failedQuantity}</span><span><mark className={"quality-status " + (row.finalResult ?? "pending")}>{row.finalResult ?? "待审批"}</mark></span></div>)}</div>}
    </article>
    {rejecting && <div className="modal-backdrop" role="dialog" aria-modal="true"><div className="modal-card"><div className="modal-head"><div><span className="eyebrow dark">整批不合格</span><h3>{rejecting.batchNo}</h3></div><button aria-label="关闭" onClick={() => setRejecting(null)}>×</button></div><div className="form-grid"><label className="full-field">不合格原因<textarea value={defectReason} onChange={event => setDefectReason(event.target.value)} placeholder="例如：外观缺陷"/></label></div><div className="modal-actions"><button className="secondary-action" onClick={() => setRejecting(null)}>取消</button><button disabled={busy} onClick={() => void decide(rejecting, "failed", defectReason)}>确认整批隔离</button></div></div></div>}
  </section>;
}

