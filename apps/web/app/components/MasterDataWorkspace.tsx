"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { writeMasterData } from "../lib/supply-mutation-client";

type Toast = (message: string) => void;
type SkuItemType = "finished" | "auxiliary" | "component" | null;
type ApprovalSummary = { requestNo: string; status: string; requestedAt: string; reviewedAt: string | null; reviewComment: string | null };
type Sku = { id: number; code: string; name: string; itemType: SkuItemType; stockUnit: string | null; overproductionToleranceBps: number; purchaseOverToleranceBps: number; purchaseUnderToleranceBps: number; status: string; verificationStatus: string; latestApproval: ApprovalSummary | null };
type Conversion = { id: number; skuId: number; purchaseUnit: string; stockUnit: string; purchaseUnitQuantity: number; stockUnitQuantity: number; effectiveFrom: string; status: string };
type Bom = { id: number; finishedSku: string; version: string; effectiveFrom: string; effectiveTo: string | null; approvalStatus: string; overlapAllowed: boolean; overlapReason?: string | null; lifecycleStatus?: string; active?: boolean };
type Component = { id: number; bomId: number; componentSku: string; itemType?: string; quantityPerFinished: number; isCore: boolean; issueToleranceBps?: number; consumptionToleranceBps?: number; lossToleranceBps?: number };
type BomLine = { componentSku: string; quantityPerFinished: string; isCore: boolean; issueTolerance: string; consumptionTolerance: string; lossTolerance: string };
type MasterDataPayload = { skus: Sku[]; conversions: Conversion[]; boms: Bom[]; components: Component[] };

const itemTypeText: Record<string, string> = { finished: "成品", auxiliary: "辅料", component: "配件" };
const lifecycleText: Record<string, string> = { inactive: "已停用", draft: "草稿", pending: "待审批", rejected: "已拒绝", future: "待生效", expired: "已失效", effective: "生效中" };
const approvalText: Record<string, string> = { pending: "待审批", approved: "已通过", rejected: "已拒绝", cancelled: "已取消" };
const today = () => new Date().toISOString().slice(0, 10);
const blankLine = (): BomLine => ({ componentSku: "", quantityPerFinished: "1", isCore: false, issueTolerance: "0", consumptionTolerance: "0", lossTolerance: "0" });
const blankSku = () => ({ code: "", name: "", itemType: "finished", stockUnit: "", purchaseUnit: "", purchaseUnitQuantity: "1", stockUnitQuantity: "1", effectiveFrom: today(), overproductionTolerance: "0", purchaseOverTolerance: "0", purchaseUnderTolerance: "0" });
const blankBom = () => ({ finishedSku: "", version: "V1", effectiveFrom: today(), effectiveTo: "", overlapAllowed: false, overlapReason: "", components: [blankLine()] });
const bpsText = (value = 0) => `${value / 100}%`;
const bpsInput = (value = 0) => String(value / 100);

async function requestMasterData(signal?: AbortSignal): Promise<MasterDataPayload> {
  const response = await fetch("/api/v1/master-data", { signal });
  if (!response.ok) throw new Error("Master data request failed");
  return await response.json() as MasterDataPayload;
}

export default function MasterDataWorkspace({ toast }: { toast: Toast }) {
  const [data, setData] = useState<MasterDataPayload>({ skus: [], conversions: [], boms: [], components: [] });
  const [tab, setTab] = useState<"sku" | "bom">("sku");
  const [open, setOpen] = useState<"sku" | "bom" | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedSkuId, setSelectedSkuId] = useState<number | null>(null);
  const [selectedBomId, setSelectedBomId] = useState<number | null>(null);
  const [skuEditingId, setSkuEditingId] = useState<number | null>(null);
  const [bomCopySourceId, setBomCopySourceId] = useState<number | null>(null);
  const [compareIds, setCompareIds] = useState<number[]>([]);
  const [sku, setSku] = useState(blankSku);
  const [bom, setBom] = useState(blankBom);
  const toastRef = useRef(toast);

  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);

  const load = async () => {
    try {
      setData(await requestMasterData());
    } catch {
      toastRef.current("主数据加载失败，请稍后重试");
    }
  };
  useEffect(() => {
    const controller = new AbortController();
    void requestMasterData(controller.signal).then(
      payload => { if (!controller.signal.aborted) setData(payload); },
      () => { if (!controller.signal.aborted) toastRef.current("主数据加载失败，请稍后重试"); },
    );
    return () => controller.abort();
  }, []);

  const conversionsBySku = useMemo(() => {
    const values = new Map<number, Conversion[]>();
    for (const conversion of data.conversions) values.set(conversion.skuId, [...values.get(conversion.skuId) ?? [], conversion]);
    return values;
  }, [data.conversions]);
  const componentsByBom = useMemo(() => {
    const values = new Map<number, Component[]>();
    for (const component of data.components) values.set(component.bomId, [...values.get(component.bomId) ?? [], component]);
    return values;
  }, [data.components]);
  const finished = useMemo(() => data.skus.filter(x => x.itemType === "finished" && x.status === "active"), [data.skus]);
  const materials = useMemo(() => data.skus.filter(x => ["auxiliary", "component"].includes(x.itemType ?? "") && x.status === "active"), [data.skus]);
  const selectedSku = data.skus.find(item => item.id === selectedSkuId) ?? null;
  const selectedSkuConversions = selectedSku === null ? [] : conversionsBySku.get(selectedSku.id) ?? [];
  const selectedBom = data.boms.find(item => item.id === selectedBomId) ?? null;
  const selectedBomComponents = selectedBom === null ? [] : componentsByBom.get(selectedBom.id) ?? [];
  const selectedBoms = compareIds.map(id => data.boms.find(x => x.id === id)).filter(Boolean) as Bom[];

  const closeDialog = () => {
    setOpen(null);
    setSkuEditingId(null);
    setBomCopySourceId(null);
  };

  const openCreateDialog = () => {
    if (tab === "sku") {
      setSkuEditingId(null);
      setSku(blankSku());
      setOpen("sku");
      return;
    }
    setBomCopySourceId(null);
    setBom(blankBom());
    setOpen("bom");
  };

  const submit = async (payload: Record<string, unknown>) => {
    setBusy(true);
    try {
      await writeMasterData(payload);
      const action = String(payload.action ?? "");
      toast(action === "create_bom" ? "BOM 版本已提交，等待另一位供应链同事审批" : action === "resubmit_sku" ? "SKU 已重新提交，等待另一位供应链同事审批" : "SKU 已提交，等待另一位供应链同事审批");
      closeDialog();
      await load();
    } catch (error) { toast(error instanceof Error ? error.message : "提交失败"); } finally { setBusy(false); }
  };

  const submitSku = () => {
    const payload = { name: sku.name, itemType: sku.itemType, stockUnit: sku.stockUnit, purchaseUnit: sku.purchaseUnit, purchaseUnitQuantity: sku.purchaseUnitQuantity, stockUnitQuantity: sku.stockUnitQuantity, effectiveFrom: sku.effectiveFrom, overproductionTolerance: sku.overproductionTolerance, purchaseOverTolerance: sku.purchaseOverTolerance, purchaseUnderTolerance: sku.purchaseUnderTolerance };
    return skuEditingId === null
      ? { action: "create_sku", code: sku.code, ...payload }
      : { action: "resubmit_sku", id: skuEditingId, ...payload };
  };

  const submitBom = () => ({ action: "create_bom", ...bom, components: bom.components.map(line => ({ ...line, quantityPerFinished: Number(line.quantityPerFinished), issueTolerance: Number(line.issueTolerance), consumptionTolerance: Number(line.consumptionTolerance), lossTolerance: Number(line.lossTolerance) })) });

  const editRejectedSku = (item: Sku) => {
    const conversion = (conversionsBySku.get(item.id) ?? []).find(row => row.status === "active") ?? (conversionsBySku.get(item.id) ?? [])[0];
    setSelectedSkuId(item.id);
    setSkuEditingId(item.id);
    setSku({
      code: item.code,
      name: item.name,
      itemType: item.itemType ?? "finished",
      stockUnit: item.stockUnit ?? "",
      purchaseUnit: conversion?.purchaseUnit ?? "",
      purchaseUnitQuantity: String(conversion?.purchaseUnitQuantity ?? 1),
      stockUnitQuantity: String(conversion?.stockUnitQuantity ?? 1),
      effectiveFrom: conversion?.effectiveFrom ?? today(),
      overproductionTolerance: bpsInput(item.overproductionToleranceBps),
      purchaseOverTolerance: bpsInput(item.purchaseOverToleranceBps),
      purchaseUnderTolerance: bpsInput(item.purchaseUnderToleranceBps),
    });
    setOpen("sku");
  };

  const copyBom = (item: Bom) => {
    const lines = componentsByBom.get(item.id) ?? [];
    setSelectedBomId(item.id);
    setBomCopySourceId(item.id);
    setBom({
      finishedSku: item.finishedSku,
      version: "",
      effectiveFrom: item.effectiveFrom,
      effectiveTo: item.effectiveTo ?? "",
      overlapAllowed: item.overlapAllowed,
      overlapReason: item.overlapReason ?? "",
      components: lines.length === 0 ? [blankLine()] : lines.map(component => ({
        componentSku: component.componentSku,
        quantityPerFinished: String(component.quantityPerFinished),
        isCore: component.isCore,
        issueTolerance: bpsInput(component.issueToleranceBps),
        consumptionTolerance: bpsInput(component.consumptionToleranceBps),
        lossTolerance: bpsInput(component.lossToleranceBps),
      })),
    });
    setOpen("bom");
  };

  const toggleCompare = (item: Bom) => {
    if (compareIds.includes(item.id)) return setCompareIds(compareIds.filter(id => id !== item.id));
    if (compareIds.length === 2) return toast("最多同时比较两个 BOM 版本");
    if (selectedBoms[0] && selectedBoms[0].finishedSku !== item.finishedSku) return toast("只能比较同一成品 SKU 的 BOM 版本");
    setCompareIds([...compareIds, item.id]);
  };

  const updateLine = (index: number, values: Partial<BomLine>) => {
    const components = [...bom.components];
    components[index] = { ...components[index], ...values };
    setBom({ ...bom, components });
  };

  const compareSkus = useMemo(() => {
    const ids = new Set(compareIds);
    return [...new Set(data.components.filter(x => ids.has(x.bomId)).map(x => x.componentSku))];
  }, [compareIds, data.components]);

  return <section className="master-workspace">
    <div className="master-head"><div><h2>SKU 与 BOM</h2><p>维护成品、辅料、配件、单位换算及版本化物料清单</p></div><button className="primary" onClick={openCreateDialog}>新增{tab === "sku" ? " SKU" : " BOM 版本"}</button></div>
    <div className="master-tabs"><button className={tab === "sku" ? "active" : ""} onClick={() => setTab("sku")}>SKU 档案</button><button className={tab === "bom" ? "active" : ""} onClick={() => setTab("bom")}>BOM 版本</button></div>

    {tab === "sku" ? <>
      <div className="master-table sku-table"><div className="row header"><span>SKU 编码</span><span>名称</span><span>分类</span><span>库存单位</span><span>状态</span><span>操作</span></div>{data.skus.map(item => <div className="row" key={item.id}><b>{item.code}</b><span>{item.name}</span><span>{itemTypeText[item.itemType ?? ""] || item.itemType}</span><span>{item.stockUnit}</span><span className={`state ${item.verificationStatus}`}>{item.verificationStatus === "approved" ? "已生效" : item.verificationStatus === "rejected" ? "已拒绝" : "待审批"}</span><span className="table-actions"><button type="button" onClick={() => setSelectedSkuId(item.id)}>查看详情</button>{item.verificationStatus === "rejected" && item.status === "draft" ? <button type="button" onClick={() => editRejectedSku(item)}>修改并重新提交</button> : null}</span></div>)}</div>
      {selectedSku && <div className="master-detail"><div className="detail-title"><div><h3>{selectedSku.code}</h3><p>{selectedSku.name}</p></div>{selectedSku.verificationStatus === "rejected" && selectedSku.status === "draft" ? <button className="primary" onClick={() => editRejectedSku(selectedSku)}>修改并重新提交</button> : null}</div><div className="detail-grid"><span>物料类型<b>{itemTypeText[selectedSku.itemType ?? ""] || selectedSku.itemType}</b></span><span>库存单位<b>{selectedSku.stockUnit || "未填写"}</b></span><span>状态<b>{selectedSku.status === "active" ? "生效" : selectedSku.status === "inactive" ? "停用" : "草稿"}</b></span><span>审批状态<b>{approvalText[selectedSku.verificationStatus] || selectedSku.verificationStatus}</b></span><span>生产超产容差<b>{bpsText(selectedSku.overproductionToleranceBps)}</b></span><span>采购超计划容差<b>{bpsText(selectedSku.purchaseOverToleranceBps)}</b></span><span>采购未足容差<b>{bpsText(selectedSku.purchaseUnderToleranceBps)}</b></span><span>最近审批<b>{selectedSku.latestApproval ? approvalText[selectedSku.latestApproval.status] || selectedSku.latestApproval.status : "无记录"}</b></span></div><div className="detail-subgrid"><div><h4>单位换算</h4>{selectedSkuConversions.length === 0 ? <p>无单位换算</p> : selectedSkuConversions.map(conversion => <p key={conversion.id}>{conversion.purchaseUnitQuantity} {conversion.purchaseUnit} = {conversion.stockUnitQuantity} {conversion.stockUnit}，{conversion.effectiveFrom} 生效，{conversion.status === "active" ? "启用" : "停用"}</p>)}</div><div><h4>驳回原因</h4><p>{selectedSku.latestApproval?.status === "rejected" ? selectedSku.latestApproval.reviewComment || "审批人未填写原因" : "无驳回原因"}</p></div></div></div>}
    </> : <>
      <div className="master-table bom-table"><div className="row header"><span>成品 SKU</span><span>版本</span><span>有效区间</span><span>明细数</span><span>状态</span><span>操作</span></div>{data.boms.map(item => <div className={`row ${selectedBomId === item.id ? "selected" : ""}`} key={item.id}><b>{item.finishedSku}</b><span className="bom-version"><input type="checkbox" checked={compareIds.includes(item.id)} onChange={() => toggleCompare(item)} />{item.version}{item.overlapAllowed ? <em>并行</em> : null}</span><span>{item.effectiveFrom} 至 {item.effectiveTo || "长期"}</span><span>{(componentsByBom.get(item.id) ?? []).length}</span><span className={`state ${item.approvalStatus}`}>{lifecycleText[item.lifecycleStatus || ""] || (item.approvalStatus === "approved" ? "已生效" : item.approvalStatus === "rejected" ? "已拒绝" : "待审批")}</span><span className="table-actions"><button type="button" onClick={() => setSelectedBomId(item.id)}>查看详情</button></span></div>)}</div>
      {selectedBom && <div className="master-detail"><div className="detail-title"><div><h3>{selectedBom.finishedSku} / {selectedBom.version}</h3><p>{selectedBom.effectiveFrom} 至 {selectedBom.effectiveTo || "长期"}</p></div><button className="primary" onClick={() => copyBom(selectedBom)}>复制为新版本</button></div><p className="detail-rule">{selectedBom.overlapAllowed ? `允许与其他版本并行；原因：${selectedBom.overlapReason || "未填写"}` : "本版本生效后，系统按审批结果自动结束旧版本。"}</p><div className="bom-component-grid header"><span>物料</span><span>类型</span><span>单位用量</span><span>核心配件</span><span>领料/消耗/损耗偏差</span></div>{selectedBomComponents.map(component => <div className="bom-component-grid" key={component.id}><b>{component.componentSku}</b><span>{itemTypeText[component.itemType || ""] || "—"}</span><span>{component.quantityPerFinished}</span><span>{component.isCore ? "是" : "否"}</span><span>{bpsText(component.issueToleranceBps)} / {bpsText(component.consumptionToleranceBps)} / {bpsText(component.lossToleranceBps)}</span></div>)}</div>}
      {selectedBoms.length > 0 && <div className="bom-compare"><div className="compare-actions"><div><h3>BOM 版本对比</h3><p>{selectedBoms.map(x => `${x.finishedSku} ${x.version}`).join(" ↔ ")}</p></div><button onClick={() => setCompareIds([])}>清除选择</button></div>{selectedBoms.length < 2 ? <p className="compare-hint">再选择一个同 SKU 的版本即可比较。</p> : <div className="compare-table"><div className="compare-row header"><span>物料</span><span>{selectedBoms[0].version}</span><span>{selectedBoms[1].version}</span><span>用量差异</span></div>{compareSkus.map(code => { const left = data.components.find(x => x.bomId === selectedBoms[0].id && x.componentSku === code); const right = data.components.find(x => x.bomId === selectedBoms[1].id && x.componentSku === code); return <div className="compare-row" key={code}><b>{code}</b><span>{left?.quantityPerFinished ?? "未使用"}</span><span>{right?.quantityPerFinished ?? "未使用"}</span><strong>{left && right ? Number(right.quantityPerFinished) - Number(left.quantityPerFinished) : "物料变更"}</strong></div>; })}</div>}</div>}
    </>}

    {((tab === "sku" && !data.skus.length) || (tab === "bom" && !data.boms.length)) && <div className="master-empty">暂无数据。首批资料也可通过标准 Excel 模板导入。</div>}

    {open && <div className="master-mask"><div className="master-dialog"><div className="dialog-title"><h3>{open === "sku" ? skuEditingId === null ? "新增 SKU" : "修改并重新提交 SKU" : bomCopySourceId === null ? "新增 BOM 版本" : "复制 BOM 为新版本"}</h3><button onClick={closeDialog}>×</button></div>
      {open === "sku" ? <div className="form-grid">
        <label>SKU 编码<input value={sku.code} disabled={skuEditingId !== null} onChange={e => setSku({ ...sku, code: e.target.value })} /></label><label>名称<input value={sku.name} onChange={e => setSku({ ...sku, name: e.target.value })} /></label>
        <label>物料类型<select value={sku.itemType} onChange={e => setSku({ ...sku, itemType: e.target.value })}><option value="finished">成品</option><option value="auxiliary">辅料</option><option value="component">配件</option></select></label><label>库存单位<input placeholder="必须由供应链人工填写" value={sku.stockUnit} onChange={e => setSku({ ...sku, stockUnit: e.target.value })} /></label>
        <label>采购单位（可选）<input value={sku.purchaseUnit} onChange={e => setSku({ ...sku, purchaseUnit: e.target.value })} /></label><label>单位换算<div className="unit-conversion"><input value={sku.purchaseUnitQuantity} onChange={e => setSku({ ...sku, purchaseUnitQuantity: e.target.value })} /><span>采购单位 =</span><input value={sku.stockUnitQuantity} onChange={e => setSku({ ...sku, stockUnitQuantity: e.target.value })} /><span>库存单位</span></div></label>
        <label>换算生效日期<input type="date" value={sku.effectiveFrom} onChange={e => setSku({ ...sku, effectiveFrom: e.target.value })} /></label><label>生产超产容差（%）<input type="number" min="0" max="100" value={sku.overproductionTolerance} onChange={e => setSku({ ...sku, overproductionTolerance: e.target.value })} /></label>
        <label>采购超计划容差（%）<input type="number" min="0" max="100" value={sku.purchaseOverTolerance} onChange={e => setSku({ ...sku, purchaseOverTolerance: e.target.value })} /></label><label>采购未足容差（%）<input type="number" min="0" max="100" value={sku.purchaseUnderTolerance} onChange={e => setSku({ ...sku, purchaseUnderTolerance: e.target.value })} /></label>
      </div> : <div className="bom-form"><div className="bom-rule-tip">普通新版本在生效日自动结束旧版本；仅在消化旧料等明确场景下选择“允许并行”。采购单和生产单按采购单下单日期校验 BOM。</div><div className="form-grid"><label>成品 SKU<select value={bom.finishedSku} onChange={e => setBom({ ...bom, finishedSku: e.target.value })}><option value="">请选择</option>{finished.map(item => <option key={item.id} value={item.code}>{item.code} - {item.name}</option>)}</select></label><label>版本号<input value={bom.version} onChange={e => setBom({ ...bom, version: e.target.value })} /></label><label>生效日期<input type="date" value={bom.effectiveFrom} onChange={e => setBom({ ...bom, effectiveFrom: e.target.value })} /></label><label>失效日期<input type="date" value={bom.effectiveTo} onChange={e => setBom({ ...bom, effectiveTo: e.target.value })} /></label><label className="check"><input type="checkbox" checked={bom.overlapAllowed} onChange={e => setBom({ ...bom, overlapAllowed: e.target.checked })} />允许与旧 BOM 重叠</label>{bom.overlapAllowed && <label>重叠原因（必填）<input value={bom.overlapReason} onChange={e => setBom({ ...bom, overlapReason: e.target.value })} /></label>}</div>
        <h4>BOM 明细</h4>{bom.components.map((line, index) => <div className="bom-line-card" key={index}><div className="bom-line"><select value={line.componentSku} onChange={e => updateLine(index, { componentSku: e.target.value })}><option value="">选择辅料/配件</option>{materials.map(item => <option key={item.id} value={item.code}>{item.code} - {item.name}</option>)}</select><input aria-label="单位用量" type="number" min="0.000001" step="any" value={line.quantityPerFinished} onChange={e => updateLine(index, { quantityPerFinished: e.target.value })} /><label><input type="checkbox" checked={line.isCore} onChange={e => updateLine(index, { isCore: e.target.checked })} />核心配件</label><button type="button" disabled={bom.components.length === 1} onClick={() => setBom({ ...bom, components: bom.components.filter((_, n) => n !== index) })}>删除</button></div><div className="bom-tolerances"><label>领料允许偏差（%）<input type="number" min="0" max="100" value={line.issueTolerance} onChange={e => updateLine(index, { issueTolerance: e.target.value })} /></label><label>消耗允许偏差（%）<input type="number" min="0" max="100" value={line.consumptionTolerance} onChange={e => updateLine(index, { consumptionTolerance: e.target.value })} /></label><label>损耗允许偏差（%）<input type="number" min="0" max="100" value={line.lossTolerance} onChange={e => updateLine(index, { lossTolerance: e.target.value })} /></label></div></div>)}<button type="button" className="minor" onClick={() => setBom({ ...bom, components: [...bom.components, blankLine()] })}>＋添加明细</button>
      </div>}
      <div className="dialog-actions"><button onClick={closeDialog}>取消</button><button className="primary" disabled={busy} onClick={() => void submit(open === "sku" ? submitSku() : submitBom())}>{busy ? "提交中…" : "提交审批"}</button></div>
    </div></div>}
  </section>;
}
