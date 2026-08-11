"use client";

import { useEffect, useMemo, useState } from "react";
import { writeSupplierPerformance } from "../lib/r2-mutation-client";

type Toast = (message: string) => void;
type MetricKey = "delivery" | "quality" | "exception" | "preparation" | "satisfaction" | "sampling";
type Ranking = { supplierId: number; displayName: string; tier: number; rank: number; score: number | null; metrics: Record<MetricKey, number | null>; reviewCounts: { satisfaction: number; sampling: number }; comments: { type: string; comment: string; tags: string[] }[] };
type Weight = Record<MetricKey, number> & { tier: number };
type Payload = { quarter: string; rankings: Ranking[]; weights: Weight[]; canConfigure: boolean; canReview: boolean; automaticMetricsPending: boolean };

const metricLabels: Record<MetricKey, string> = { delivery: "准时交付率", quality: "质检合格率", exception: "异常处理及时率", preparation: "备料按期完成率", satisfaction: "内部满意度", sampling: "打样配合度" };
const emptyWeights: Weight = { tier: 1, delivery: 25, quality: 20, exception: 15, preparation: 10, satisfaction: 15, sampling: 15 };
const quarterNow = () => { const d = new Date(); return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`; };

export default function SupplierPerformanceWorkspace({ toast }: { toast: Toast }) {
  const [quarter, setQuarter] = useState(quarterNow());
  const [tier, setTier] = useState(1);
  const [data, setData] = useState<Payload | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [weightsOpen, setWeightsOpen] = useState(false);
  const [review, setReview] = useState({ supplierId: "", reviewType: "sampling", score: "5", tags: "", comment: "" });
  const [weights, setWeights] = useState<Weight>(emptyWeights);
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().slice(0, 10));

  const load = async () => {
    const response = await fetch(`/api/v1/supplier-performance?quarter=${encodeURIComponent(quarter)}&tier=${tier}`);
    const result = await response.json();
    if (!response.ok) return toast(result.error || "绩效数据加载失败");
    setData(result);
  };
  useEffect(() => { void load(); }, [quarter, tier]);
  useEffect(() => {
    const current = data?.weights.find(item => item.tier === tier);
    if (current) setWeights({ ...current, delivery: current.delivery / 100, quality: current.quality / 100, exception: current.exception / 100, preparation: current.preparation / 100, satisfaction: current.satisfaction / 100, sampling: current.sampling / 100 });
  }, [data, tier]);

  const total = useMemo(() => (Object.keys(metricLabels) as MetricKey[]).reduce((sum, key) => sum + Number(weights[key] || 0), 0), [weights]);
  const saveReview = async () => {
    setBusy(true);
    try {
      await writeSupplierPerformance({ action: "review", supplierId: Number(review.supplierId), quarter, reviewType: review.reviewType, score: Number(review.score), tags: review.tags.split(/[，,]/).map(x => x.trim()).filter(Boolean), comment: review.comment });
      setReviewOpen(false); toast("评价已保存，评价人姓名不会向工厂显示"); await load();
    } catch (error) { toast(error instanceof Error ? error.message : "评价保存失败"); } finally { setBusy(false); }
  };
  const saveWeights = async () => {
    if (Math.abs(total - 100) > 0.001) return toast("指标权重合计必须为 100%");
    setBusy(true);
    try {
      await writeSupplierPerformance({ action: "weights", ...weights, tier, effectiveFrom });
      setWeightsOpen(false); toast("新权重版本已保存，将从指定日期生效"); await load();
    } catch (error) { toast(error instanceof Error ? error.message : "权重保存失败"); } finally { setBusy(false); }
  };

  return <section className="performance-workspace">
    <div className="performance-head"><div><span className="eyebrow">SUPPLIER PERFORMANCE</span><h2>供应商绩效与匿名排名</h2><p>按供应商层级独立排名；没有业务来源的数据不会生成虚假分数。</p></div><div className="performance-actions">{data?.canConfigure && <button onClick={() => setWeightsOpen(true)}>配置权重</button>}{data?.canReview && <button onClick={() => setReviewOpen(true)}>季度评价</button>}<button className="primary" onClick={() => { window.location.href = `/api/v1/supplier-performance?quarter=${encodeURIComponent(quarter)}&tier=${tier}&format=xlsx`; }}>导出带水印 Excel</button></div></div>
    <div className="performance-toolbar"><div className="tier-tabs">{[1, 2, 3].map(value => <button key={value} className={tier === value ? "active" : ""} onClick={() => setTier(value)}>第 {value} 层</button>)}</div><label>评价季度<input value={quarter} onChange={e => setQuarter(e.target.value)} placeholder="2026-Q3" /></label></div>
    <div className="performance-note">自动指标将在订单、质检和异常数据形成后参与计算；当前综合分只按已有评价维度重新归一化。</div>
    <div className="performance-table"><div className="row header"><span>排名 / 供应商</span><span>综合分</span>{(Object.keys(metricLabels) as MetricKey[]).map(key => <span key={key}>{metricLabels[key]}</span>)}</div>{data?.rankings.map(item => <div className="row" key={item.supplierId}><span><b>#{item.rank}　{item.displayName}</b><small>{item.comments.slice(0, 2).map(x => x.comment).filter(Boolean).join("；") || "暂无改进建议"}</small></span><span className="score">{item.score === null ? "待评价" : item.score.toFixed(1)}</span>{(Object.keys(metricLabels) as MetricKey[]).map(key => <span key={key}>{item.metrics[key] === null ? <em>待形成</em> : `${item.metrics[key]?.toFixed(1)}%`}</span>)}</div>)}</div>
    {!data?.rankings.length && <div className="performance-empty">该层级暂无已启用供应商。</div>}

    {reviewOpen && <div className="master-mask"><div className="master-dialog performance-dialog"><div className="dialog-title"><h3>填写 {quarter} 季度评价</h3><button onClick={() => setReviewOpen(false)}>×</button></div><div className="performance-form"><label>供应商<select value={review.supplierId} onChange={e => setReview({ ...review, supplierId: e.target.value })}><option value="">请选择</option>{data?.rankings.map(x => <option value={x.supplierId} key={x.supplierId}>{x.displayName}</option>)}</select></label><label>评价指标<select value={review.reviewType} onChange={e => setReview({ ...review, reviewType: e.target.value })}>{tier === 1 && <option value="satisfaction">内部满意度</option>}<option value="sampling">打样配合度</option></select></label><label>评分（1–5）<input type="number" min="1" max="5" value={review.score} onChange={e => setReview({ ...review, score: e.target.value })} /></label><label>评价标签（逗号分隔）<input value={review.tags} onChange={e => setReview({ ...review, tags: e.target.value })} placeholder="及时性好，响应快" /></label><label className="wide">文字说明（可选）<textarea value={review.comment} onChange={e => setReview({ ...review, comment: e.target.value })} /></label></div><div className="dialog-actions"><button onClick={() => setReviewOpen(false)}>取消</button><button className="primary" disabled={busy} onClick={() => void saveReview()}>保存评价</button></div></div></div>}
    {weightsOpen && <div className="master-mask"><div className="master-dialog performance-dialog"><div className="dialog-title"><h3>第 {tier} 层指标权重</h3><button onClick={() => setWeightsOpen(false)}>×</button></div><div className="performance-form">{(Object.keys(metricLabels) as MetricKey[]).map(key => <label key={key}>{metricLabels[key]}（%）<input type="number" min="0" max="100" disabled={tier !== 1 && key === "satisfaction"} value={weights[key]} onChange={e => setWeights({ ...weights, [key]: Number(e.target.value) })} /></label>)}<label>生效日期<input type="date" value={effectiveFrom} onChange={e => setEffectiveFrom(e.target.value)} /></label><strong className={total === 100 ? "valid" : "invalid"}>合计：{total}%</strong></div><div className="dialog-actions"><button onClick={() => setWeightsOpen(false)}>取消</button><button className="primary" disabled={busy || total !== 100} onClick={() => void saveWeights()}>保存版本</button></div></div></div>}
  </section>;
}
