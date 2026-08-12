"use client";

import { useEffect, useMemo, useState } from "react";
import "./shipping.css";
import "./audit.css";
import "./performance.css";
import * as XLSX from "xlsx";
import PurchaseWorkspace from "./components/PurchaseWorkspace";
import ProductionWorkspace from "./components/ProductionWorkspace";
import InventoryWorkspace from "./components/InventoryWorkspace";
import MasterDataWorkspace from "./components/MasterDataWorkspace";
import SupplierWorkspace from "./components/SupplierWorkspace";
import ShippingWorkspace from "./components/ShippingWorkspace";
import FinanceWorkspace from "./components/FinanceWorkspace";
import AuditWorkspace from "./components/AuditWorkspace";
import { finalRequestDigest, mutateJson, uploadPlatformFile } from "./lib/mutation-client";
import { r2Imports } from "./lib/r2-mutation-client";

type Order = {
  id: string; factory: string; product: string; sku: string; qty: number;
  done: number; due: string; status: string; risk: "正常" | "注意" | "异常";
};

type ImportPreview = {
  canCommit: boolean;
  errors: Array<{ field: string; message: string; row: number; sheet: string }>;
  fileName: string;
  fingerprint: string;
  rows: Array<Record<string, unknown>>;
  summary: { errorCount: number; totalRows: number; validRows: number; warningCount: number };
  type: "purchase_plan" | "purchase_order";
  warnings: Array<{ message: string; row: number; sheet: string }>;
};

type ImportStage = { batch: { id: number; importNo: string; status: string } };
type ImportCommit = { awaitingMapping?: boolean; message?: string; success: boolean };
type UploadedImport = { file: { id: number }; usable: boolean };

const orders: Order[] = [
  { id: "EX-260728-01", factory: "组装工厂 A", product: "RestRidge 颈椎枕", sku: "RR-NP-01", qty: 2400, done: 1680, due: "07-31", status: "生产中", risk: "正常" },
  { id: "EX-260726-03", factory: "组装工厂 B", product: "CloudAir 乳胶枕", sku: "CA-LP-02", qty: 1200, done: 600, due: "07-30", status: "待补料", risk: "异常" },
  { id: "EX-260724-02", factory: "组装工厂 A", product: "Cooling Wave 枕套", sku: "CW-PC-04", qty: 3200, done: 3040, due: "07-29", status: "待发货", risk: "注意" },
  { id: "EX-260721-01", factory: "组装工厂 B", product: "DreamRest 护颈枕", sku: "DR-NP-03", qty: 1800, done: 1800, due: "07-28", status: "已完成", risk: "正常" },
];

type Supplier = {
  code: string;
  name: string;
  tier: "第一层" | "第二层" | "第三层" | "待分类";
  factory: string;
  skus: number;
  capacity: string;
  status: "正式" | "待核验" | "风险";
  priceAccess: string;
};

const supplierRows: Supplier[] = [
  { code: "SUP-0003", name: "广东鸿基羽绒制品有限公司", tier: "第一层", factory: "—", skus: 18, capacity: "日产 3,200 / 月产 72,000", status: "正式", priceAccess: "供应链 · 财务 · 本厂" },
  { code: "SUP-0011", name: "温州嘉博乳胶制品有限公司", tier: "第二层", factory: "广东鸿基羽绒制品", skus: 7, capacity: "日产 1,800 / 月产 42,000", status: "风险", priceAccess: "供应链 · 所属组装工厂" },
  { code: "SUP-0019", name: "汇聚包装材料厂", tier: "第三层", factory: "广东鸿基羽绒制品", skus: 12, capacity: "日产 8,000 / 月产 180,000", status: "正式", priceAccess: "供应链只读 · 所属组装工厂" },
  { code: "SUP-0024", name: "南通优库纺织有限公司", tier: "第三层", factory: "南通组装工厂", skus: 9, capacity: "待补充", status: "待核验", priceAccess: "供应链只读 · 所属组装工厂" },
  { code: "SUP-0028", name: "佛山拓新配件有限公司", tier: "待分类", factory: "待指定", skus: 0, capacity: "待补充", status: "待核验", priceAccess: "尚未启用" },
];

const nav = ["工作台", "采购管理", "供应商管理", "执行单", "物料与补料", "生产质检", "发货管理", "库存管理", "工厂协同", "财务结算", "审批中心", "系统管理", "AI助手"];

function SupplierPanel({ toast }: { toast: (message: string) => void }) {
  const [tier, setTier] = useState("全部");
  const [search, setSearch] = useState("");
  const [importSummary, setImportSummary] = useState("");
  const filtered = supplierRows.filter(item =>
    (tier === "全部" || item.tier === tier) &&
    `${item.code}${item.name}${item.factory}`.toLowerCase().includes(search.toLowerCase())
  );

  const inspectSupplierFile = async (file?: File) => {
    if (!file) return;
    try {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
      const valid = rows.filter(row => row["供应商代码"] && row["供应商名称"]);
      const missingContact = valid.filter(row => !row["联系人"] || !row["联系方式"]).length;
      setImportSummary(`预检完成：${valid.length} 家可进入待核验区，${missingContact} 家需补充联系人或电话。正式启用前须完成分层和归属设置。`);
    } catch {
      setImportSummary("预检失败：请上传领星导出的供应商 Excel 文件。");
    }
  };

  return <section className="supplier-page">
    <div className="supplier-hero">
      <div><span className="eyebrow">三级供应商网络</span><h2>先管好第一层，再穿透监督核心风险</h2><p>供应链直接管理组装工厂，监督第二层执行风险，并知悉第三层异常与价格。</p></div>
      <div className="supplier-actions">
        <label className="file-action">导入领星供应商<input type="file" accept=".xlsx,.xls" onChange={e => inspectSupplierFile(e.target.files?.[0])}/></label>
        <button onClick={() => toast("已创建供应商准入草稿，等待补充企业资料")}>＋ 新建供应商</button>
      </div>
    </div>
    {importSummary && <div className="supplier-import-result">{importSummary}</div>}
    <div className="supplier-metrics">
      <article><span>供应商总数</span><strong>29</strong><small>来自领星待核验数据</small></article>
      <article><span>第一层组装工厂</span><strong>5</strong><small>供应链直接管理</small></article>
      <article><span>核心供应风险</span><strong className="risk-number">2</strong><small>可能影响第一层交付</small></article>
      <article><span>待补充资料</span><strong>17</strong><small>联系人、地址或证照</small></article>
    </div>
    <div className="supplier-layout">
      <article className="panel supplier-list">
        <div className="supplier-toolbar">
          <div><h3>供应商档案</h3><p>分层、归属、产能与价格权限集中管理</p></div>
          <input aria-label="搜索供应商" placeholder="搜索名称、编码或所属工厂" value={search} onChange={e => setSearch(e.target.value)}/>
        </div>
        <div className="tier-tabs">{["全部","第一层","第二层","第三层","待分类"].map(item => <button key={item} className={tier === item ? "selected" : ""} onClick={() => setTier(item)}>{item}</button>)}</div>
        <div className="supplier-table">
          <div className="supplier-row supplier-head"><span>供应商</span><span>层级 / 所属工厂</span><span>供应SKU</span><span>产能</span><span>价格可见范围</span><span>状态</span></div>
          {filtered.map(item => <button className="supplier-row" key={item.code} onClick={() => toast(`已打开 ${item.name} 的供应商档案`)}>
            <span><strong>{item.name}</strong><small>{item.code}</small></span>
            <span><b>{item.tier}</b><small>{item.factory}</small></span>
            <span><strong>{item.skus || "—"}</strong><small>{item.skus ? "个已审核关系" : "待供应链填写"}</small></span>
            <span><b>{item.capacity}</b><small>日/月任一超限即预警</small></span>
            <span><b>{item.priceAccess}</b><small>查看与导出均记日志</small></span>
            <span><mark className={`supplier-status ${item.status}`}>{item.status}</mark></span>
          </button>)}
        </div>
      </article>
      <aside className="panel supplier-side">
        <div className="panel-head"><div><h3>待核验清单</h3><p>完成后才能正式启用</p></div><b>17 项</b></div>
        {[
          ["分层与归属","5 家待设置","供应链人工填写"],
          ["联系人与电话","15 家缺少","禁止默认补“无”"],
          ["统一社会信用代码","16 家缺少","用于查重"],
          ["供应商—SKU关系","待人工维护","新增或修改双人审批"],
        ].map(item => <button className="check-item" key={item[0]} onClick={() => toast(`已筛选：${item[0]}`)}><i>!</i><span><strong>{item[0]}</strong><small>{item[2]}</small></span><b>{item[1]}</b></button>)}
        <div className="governance-note"><strong>价格治理</strong><p>第一、二层价格变更需双人审批及凭证；第三层由组装工厂直接维护，供应链只读。</p></div>
      </aside>
    </div>
  </section>;
}

type PurchasePlanRow = {
  planNo: string; expectedAt: string; factory: string; warehouse: string; sku: string;
  product: string; planned: number; ordered: number; tolerance: string; status: string;
};

const planRows: PurchasePlanRow[] = [
  { planNo: "PP260729-001", expectedAt: "2026-08-28", factory: "广东鸿基羽绒制品", warehouse: "广州公司仓库", sku: "TP-PIL-001", product: "拓扑舒睡乳胶枕", planned: 2600, ordered: 2500, tolerance: "±5%", status: "已下单完成" },
  { planNo: "PP260729-002", expectedAt: "2026-08-31", factory: "南通组装工厂", warehouse: "南通优库仓库", sku: "TP-COV-018", product: "亲肤针织布套", planned: 4200, ordered: 3500, tolerance: "±8%", status: "未足计划采购" },
  { planNo: "PP260729-003", expectedAt: "2026-09-05", factory: "广东鸿基羽绒制品", warehouse: "广州公司仓库", sku: "TP-PIL-006", product: "云感护颈枕", planned: 1800, ordered: 0, tolerance: "±5%", status: "待工厂确认" },
  { planNo: "PP260728-004", expectedAt: "2026-08-20", factory: "广东鸿基羽绒制品", warehouse: "客户仓·深圳", sku: "TP-PIL-011", product: "凉感波浪枕", planned: 1200, ordered: 1320, tolerance: "±6%", status: "超计划待审批" },
];

function PurchasePanel({ toast, openImport }: { toast: (message: string) => void; openImport: (kind: "plan" | "order") => void }) {
  const [view, setView] = useState<"计划" | "采购单">("计划");
  const [query, setQuery] = useState("");
  const visiblePlans = planRows.filter(row => `${row.planNo}${row.sku}${row.product}${row.factory}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="purchase-page">
    <div className="purchase-heading">
      <div><span className="eyebrow dark">采购计划与采购单</span><h2>用正式采购单持续消耗采购计划</h2><p>按期望到货日期、组装工厂、采购仓库和SKU汇总；新版本按总量重新计算。</p></div>
      <div className="purchase-actions"><button className="secondary-action" onClick={() => openImport("plan")}>导入采购计划</button><button onClick={() => openImport("order")}>导入采购单</button></div>
    </div>
    <div className="purchase-switch"><button className={view === "计划" ? "active" : ""} onClick={() => setView("计划")}>采购计划 <b>12</b></button><button className={view === "采购单" ? "active" : ""} onClick={() => setView("采购单")}>正式采购单 <b>18</b></button></div>
    <div className="purchase-kpis">
      <article><span>计划采购量</span><strong>9,800</strong><small>当前有效版本</small></article>
      <article><span>累计已下单</span><strong>7,320</strong><small>74.7% 已消耗</small></article>
      <article><span>待工厂确认</span><strong>3</strong><small>计划3天 · 采购单24小时</small></article>
      <article className="alert-card"><span>偏差待审批</span><strong>2</strong><small>超计划1 · 未足计划1</small></article>
    </div>
    {view === "计划" ? <article className="panel purchase-list">
      <div className="purchase-toolbar"><div><h3>采购计划汇总</h3><p>组合产品只显示主SKU，展开子项以系统有效BOM为准</p></div><div><button onClick={() => toast("已打开采购计划版本记录")}>版本记录</button><input aria-label="搜索采购计划" placeholder="搜索计划号、SKU、产品或工厂" value={query} onChange={e => setQuery(e.target.value)}/></div></div>
      <div className="purchase-table">
        <div className="purchase-row purchase-head"><span>计划 / 到货日期</span><span>SKU / 产品</span><span>组装工厂 / 仓库</span><span>计划消耗</span><span>安全偏差</span><span>状态</span></div>
        {visiblePlans.map(row => {
          const rate = Math.min(100, row.ordered / row.planned * 100);
          return <button className="purchase-row" key={row.planNo} onClick={() => toast(`已打开采购计划 ${row.planNo}`)}>
            <span><strong>{row.planNo}</strong><small>期望到货 {row.expectedAt}</small></span>
            <span><strong>{row.sku}</strong><small>{row.product}</small></span>
            <span><strong>{row.factory}</strong><small>{row.warehouse}</small></span>
            <span><div className="purchase-progress"><i style={{ width: `${rate}%` }}/></div><small>{row.ordered.toLocaleString()} / {row.planned.toLocaleString()} · 剩余 {(row.planned-row.ordered).toLocaleString()}</small></span>
            <span><b>{row.tolerance}</b><small>按SKU设置</small></span>
            <span><mark className={`plan-status ${row.status}`}>{row.status}</mark></span>
          </button>;
        })}
      </div>
    </article> : <article className="panel po-board">
      <div className="purchase-toolbar"><div><h3>正式采购单</h3><p>导入后自动匹配对应日期的采购计划，并锁定价格与BOM</p></div><div><button onClick={() => openImport("order")}>导入采购单</button><input aria-label="搜索采购单" placeholder="搜索采购单号、SKU或工厂"/></div></div>
      {[
        ["PO260729-006","广东鸿基羽绒制品","¥ 186,400","08-28","待工厂确认","剩余 18小时"],
        ["PO260728-014","南通组装工厂","¥ 92,750","08-31","有异议","建议交货 09-03"],
        ["PO260727-011","广东鸿基羽绒制品","¥ 73,920","08-20","执行中","已发 2 / 3批"],
        ["PO260725-008","温州组装工厂","¥ 128,600","08-18","已确认","生产计划已维护"],
      ].map(row => <button className="po-card" key={row[0]} onClick={() => toast(`已打开采购单 ${row[0]}`)}>
        <span><strong>{row[0]}</strong><small>{row[1]}</small></span><span><small>含税金额</small><b>{row[2]}</b></span><span><small>约定交货</small><b>{row[3]}</b></span><span><mark>{row[4]}</mark><small>{row[5]}</small></span><i>→</i>
      </button>)}
    </article>}
    <section className="purchase-bottom">
      <article className="panel"><div className="panel-head"><div><h3>工厂确认时限</h3><p>按自然时间计算，发布新版本后重新计时</p></div></div><div className="deadline-row"><span><i>计</i><b>采购计划</b><small>3天内确认并填写预计开工、完工日期</small></span><strong>2天 14小时</strong></div><div className="deadline-row urgent-deadline"><span><i>单</i><b>正式采购单</b><small>24小时内确认能否按期交货</small></span><strong>18小时</strong></div></article>
      <article className="panel"><div className="panel-head"><div><h3>自动校验规则</h3><p>正式导入前阻止错误数据落库</p></div></div><div className="rule-grid"><span>期望到货时间不能为空</span><span>组合成品必须有有效BOM</span><span>重复单号展示新旧差异</span><span>超出SKU偏差触发双人审批</span></div></article>
    </section>
  </section>;
}

const skuRows = [
  { sku: "TP-PIL-001", name: "拓扑舒睡乳胶枕", type: "成品", stockUnit: "个", purchaseUnit: "箱", conversion: "1箱 = 12个", bom: "V3 · 当前生效", status: "完整" },
  { sku: "TP-COV-018", name: "亲肤针织布套", type: "配件", stockUnit: "个", purchaseUnit: "包", conversion: "1包 = 50个", bom: "—", status: "完整" },
  { sku: "TP-AUX-006", name: "PE包装袋 60×40", type: "辅料", stockUnit: "个", purchaseUnit: "捆", conversion: "1捆 = 100个", bom: "—", status: "完整" },
  { sku: "TP-PIL-006", name: "云感护颈枕", type: "成品", stockUnit: "个", purchaseUnit: "箱", conversion: "1箱 = 8个", bom: "V2 · 待审批", status: "待审核" },
  { sku: "LX-94098-31", name: "领星导入待核验产品", type: "待填写", stockUnit: "—", purchaseUnit: "—", conversion: "待填写", bom: "无有效BOM", status: "禁止使用" },
];

function MaterialPanel({ toast }: { toast: (message: string) => void }) {
  const [tab, setTab] = useState<"SKU" | "BOM">("SKU");
  const [type, setType] = useState("全部");
  const filtered = skuRows.filter(row => type === "全部" || row.type === type);
  return <section className="material-page">
    <div className="module-banner">
      <div><span className="eyebrow">SKU与BOM主数据</span><h2>让每一张计划在正确的BOM版本上执行</h2><p>SKU由供应链人工分类；单位换算、有效BOM和审批状态缺一不可。</p></div>
      <div><button onClick={() => toast("已打开SKU批量导入预检")}>导入SKU</button><button className="light" onClick={() => toast("已创建BOM变更草稿")}>＋ 新建BOM版本</button></div>
    </div>
    <div className="module-tabs"><button className={tab === "SKU" ? "active" : ""} onClick={() => setTab("SKU")}>SKU主数据</button><button className={tab === "BOM" ? "active" : ""} onClick={() => setTab("BOM")}>BOM版本</button></div>
    {tab === "SKU" ? <>
      <div className="material-kpis"><article><span>SKU总数</span><strong>486</strong><small>领星原始数据待核验</small></article><article><span>成品</span><strong>128</strong><small>按批次管理</small></article><article><span>辅料 / 配件</span><strong>342</strong><small>默认质检标准95%</small></article><article className="alert-card"><span>资料缺失</span><strong>16</strong><small>禁止进入正式业务</small></article></div>
      <article className="panel material-list">
        <div className="material-toolbar"><div><h3>SKU核验清单</h3><p>单位为空时必须人工补充，系统不默认填写“个”</p></div><div>{["全部","成品","辅料","配件","待填写"].map(item => <button key={item} className={type === item ? "selected" : ""} onClick={() => setType(item)}>{item}</button>)}</div></div>
        <div className="material-table"><div className="material-row material-head"><span>SKU / 名称</span><span>分类</span><span>库存单位</span><span>采购单位换算</span><span>BOM状态</span><span>可用状态</span></div>
          {filtered.map(row => <button className="material-row" key={row.sku} onClick={() => toast(`已打开SKU ${row.sku}`)}><span><strong>{row.sku}</strong><small>{row.name}</small></span><span><b>{row.type}</b><small>供应链人工维护</small></span><span><b>{row.stockUnit}</b><small>库存基础单位</small></span><span><b>{row.purchaseUnit}</b><small>{row.conversion}</small></span><span><b>{row.bom}</b><small>{row.type === "成品" ? "下单日期锁定版本" : "不适用"}</small></span><span><mark className={`material-status ${row.status}`}>{row.status}</mark></span></button>)}
        </div>
      </article>
    </> : <div className="bom-layout">
      <article className="panel bom-list"><div className="panel-head"><div><h3>TP-PIL-001 · BOM版本</h3><p>旧库存消化期间允许新旧版本手动重叠</p></div><button onClick={() => toast("已打开BOM历史版本对比")}>版本对比</button></div>
        {[
          ["V3","2026-08-15","长期","已审批","当前默认"],
          ["V2","2026-04-01","2026-09-30","已审批","重叠使用"],
          ["V4","2026-09-01","长期","待审批","未来版本"],
        ].map(row => <button className="bom-version" key={row[0]} onClick={() => toast(`已打开BOM ${row[0]}`)}><i>{row[0]}</i><span><strong>{row[4]}</strong><small>生效 {row[1]} · 失效 {row[2]}</small></span><mark className={row[3] === "待审批" ? "pending-bom" : ""}>{row[3]}</mark><b>→</b></button>)}
      </article>
      <article className="panel bom-detail"><div className="panel-head"><div><h3>V3 用料明细</h3><p>生产1个成品的理论用量与允许偏差</p></div><b>4行</b></div>
        <div className="bom-lines">{[
          ["TP-CORE-003","乳胶床芯","1个","±2.0%","核心配件"],
          ["TP-COV-018","亲肤针织布套","1个","±1.5%","配件"],
          ["TP-AUX-006","PE包装袋","1个","±3.0%","辅料"],
          ["TP-AUX-011","外包装纸箱","0.083箱","±2.0%","辅料"],
        ].map(row => <div key={row[0]}><span><strong>{row[1]}</strong><small>{row[0]} · {row[4]}</small></span><b>{row[2]}</b><mark>{row[3]}</mark></div>)}</div>
        <div className="bom-rule"><strong>版本锁定规则</strong><p>采购单按下单日期选择有效版本；发生重叠时由供应链明确选择。计划发布新版本前，既有计划不随BOM变化。</p></div>
      </article>
    </div>}
  </section>;
}

function ExecutionPanel({ toast }: { toast: (message: string) => void }) {
  const [filter, setFilter] = useState("全部");
  const productionRows = [
    { no: "MO260729-009", sku: "TP-PIL-001", factory: "广东鸿基羽绒制品", start: "08-02", finish: "08-12", qty: 2400, done: 1680, status: "生产中", deviation: "正常" },
    { no: "MO260728-006", sku: "TP-PIL-006", factory: "广东鸿基羽绒制品", start: "07-31", finish: "08-08", qty: 1200, done: 1268, status: "超产冻结", deviation: "超5.0%" },
    { no: "MO260727-004", sku: "TP-PIL-011", factory: "南通组装工厂", start: "07-28", finish: "08-06", qty: 1800, done: 1620, status: "少产待审批", deviation: "少10.0%" },
    { no: "MO260725-002", sku: "TP-PIL-003", factory: "温州组装工厂", start: "07-26", finish: "08-03", qty: 900, done: 900, status: "待完工上报", deviation: "领料+1.2%" },
  ].filter(row => filter === "全部" || row.status === filter);
  return <section className="execution-page">
    <div className="module-banner production-banner"><div><span className="eyebrow">生产计划与执行</span><h2>从BOM锁料到完工入库，全程守住计划边界</h2><p>超产范围按SKU设置；少产和物料偏差超过BOM行标准时进入供应链审批。</p></div><button onClick={() => toast("已创建生产计划草稿")}>＋ 新建生产计划</button></div>
    <div className="execution-kpis"><article><span>生产中</span><strong>12</strong><small>8,640件计划量</small></article><article><span>物料已锁定</span><strong>92.4%</strong><small>缺口681件</small></article><article><span>偏差待审批</span><strong>3</strong><small>超产1 · 少产1 · 损耗1</small></article><article><span>本月准时完工</span><strong>88.7%</strong><small>较上月 +3.1%</small></article></div>
    <div className="execution-layout">
      <article className="panel production-list"><div className="production-toolbar"><div><h3>生产执行单</h3><p>计划开工、完工、领料、消耗与产出统一追踪</p></div><div>{["全部","生产中","超产冻结","少产待审批"].map(item => <button key={item} className={filter === item ? "selected" : ""} onClick={() => setFilter(item)}>{item}</button>)}</div></div>
        <div className="production-table"><div className="production-row production-head"><span>生产单 / SKU</span><span>组装工厂</span><span>计划日期</span><span>完工进度</span><span>偏差</span><span>状态</span></div>
          {productionRows.map(row => <button className="production-row" key={row.no} onClick={() => toast(`已打开生产单 ${row.no}`)}><span><strong>{row.no}</strong><small>{row.sku} · BOM V3</small></span><span><b>{row.factory}</b><small>工厂执行</small></span><span><b>{row.start} → {row.finish}</b><small>计划开工 / 完工</small></span><span><div className="purchase-progress"><i style={{width:`${Math.min(100,row.done/row.qty*100)}%`}}/></div><small>{row.done.toLocaleString()} / {row.qty.toLocaleString()}</small></span><span><b className={row.deviation !== "正常" ? "danger" : ""}>{row.deviation}</b><small>按SKU及BOM行判断</small></span><span><mark className={`production-status ${row.status}`}>{row.status}</mark></span></button>)}
        </div>
      </article>
      <aside className="panel production-side"><div className="panel-head"><div><h3>异常处理</h3><p>公司资产与工厂自有库存严格分离</p></div><b>3项</b></div>
        <div className="production-alert"><i>超</i><span><strong>68件超产库存已冻结</strong><small>超过SKU允许比例，等待供应链审批</small></span><button onClick={() => toast("已打开超产接收审批")}>处理</button></div>
        <div className="production-alert"><i>少</i><span><strong>少产180件待审批</strong><small>通过后按实际数量结案并释放预留</small></span><button onClick={() => toast("已打开少产审批")}>处理</button></div>
        <div className="production-alert"><i>耗</i><span><strong>乳胶芯损耗超标</strong><small>BOM行允许±2%，实际+3.4%</small></span><button onClick={() => toast("已打开物料偏差审批")}>处理</button></div>
        <div className="factory-stock-note"><strong>被拒绝的超产</strong><p>自动转为工厂自有库存，不计入公司库存资产。后续公司接收时重新填写价格、双人审批，并生成采购补充单。</p></div>
      </aside>
    </div>
  </section>;
}

function QualityPanel({ toast }: { toast: (message: string) => void }) {
  const [stage, setStage] = useState("全部");
  const inspections = [
    { no: "QC260729-018", stage: "来料质检", sku: "TP-CORE-003", supplier: "温州嘉博乳胶制品", batch: 2400, sampled: 120, passed: 114, rate: 95, standard: 95, result: "合格" },
    { no: "QC260729-017", stage: "成品质检", sku: "TP-PIL-006", supplier: "广东鸿基羽绒制品", batch: 1200, sampled: 80, passed: 72, rate: 90, standard: 95, result: "全检中" },
    { no: "QC260728-013", stage: "来料质检", sku: "TP-COV-018", supplier: "南通优库纺织", batch: 3500, sampled: 100, passed: 96, rate: 96, standard: 95, result: "合格" },
    { no: "QC260728-009", stage: "成品质检", sku: "TP-PIL-011", supplier: "南通组装工厂", batch: 1800, sampled: 100, passed: 92, rate: 92, standard: 95, result: "待处理" },
  ].filter(row => stage === "全部" || row.stage === stage);
  return <section className="quality-page">
    <div className="module-banner quality-banner"><div><span className="eyebrow">来料与成品质检</span><h2>低于标准自动隔离，并转入全检</h2><p>抽检数量人工填写；同类不良问题可合并记录，只有检查合格数量可以发出。</p></div><button onClick={() => toast("已创建质检任务草稿")}>＋ 新建质检任务</button></div>
    <div className="quality-kpis"><article><span>今日待检</span><strong>8</strong><small>来料5 · 成品3</small></article><article><span>本月合格率</span><strong>96.4%</strong><small>较上月 +1.1%</small></article><article><span>全检进行中</span><strong>2</strong><small>1,880件待完成</small></article><article className="alert-card"><span>隔离库存</span><strong>308</strong><small>禁止领用、调拨和发货</small></article></div>
    <div className="quality-layout">
      <article className="panel quality-list"><div className="quality-toolbar"><div><h3>质检任务</h3><p>SKU专属标准优先，缺失时采用物料类型默认95%</p></div><div>{["全部","来料质检","成品质检"].map(item => <button key={item} className={stage === item ? "selected" : ""} onClick={() => setStage(item)}>{item}</button>)}</div></div>
        <div className="quality-table"><div className="quality-row quality-head"><span>质检单 / 阶段</span><span>SKU / 供应商</span><span>批次数量</span><span>抽检结果</span><span>标准</span><span>系统判定</span></div>
          {inspections.map(row => <button className="quality-row" key={row.no} onClick={() => toast(`已打开质检单 ${row.no}`)}><span><strong>{row.no}</strong><small>{row.stage}</small></span><span><strong>{row.sku}</strong><small>{row.supplier}</small></span><span><b>{row.batch.toLocaleString()}件</b><small>按批次管理</small></span><span><b className={row.rate < row.standard ? "danger" : ""}>{row.rate.toFixed(1)}%</b><small>{row.passed}合格 / {row.sampled}抽检</small></span><span><b>{row.standard.toFixed(1)}%</b><small>SKU标准</small></span><span><mark className={`quality-status ${row.result}`}>{row.result}</mark></span></button>)}
        </div>
      </article>
      <aside className="panel full-inspection"><div className="panel-head"><div><h3>全检进度</h3><p>QC260729-017 · TP-PIL-006</p></div><b>56.7%</b></div>
        <div className="full-circle"><strong>680<small>/ 1,200</small></strong><span>已完成全检</span></div>
        <div className="quality-counts"><span><i className="green"/>合格<b>642</b></span><span><i className="red"/>不合格<b>38</b></span><span><i className="amber"/>待检查<b>520</b></span></div>
        <div className="defect-summary"><strong>主要不良问题</strong><div><span>塌边</span><b>26件</b></div><div><span>污渍</span><b>12件</b></div></div>
        <button className="quality-primary" onClick={() => toast("已进入全检记录，支持复用同类不良问题")}>继续记录全检</button>
      </aside>
    </div>
    <section className="quality-bottom">
      <article className="panel"><div className="panel-head"><div><h3>不合格品处理</h3><p>处理数量合计必须等于不合格数量</p></div><button onClick={() => toast("已打开不合格品处理任务")}>查看任务</button></div><div className="disposition-flow">{[["返工","18"],["退货","8"],["报废","7"],["让步接收","5"]].map((item,i)=><div key={item[0]}><i>{i+1}</i><span>{item[0]}<b>{item[1]}件</b></span>{i===3&&<small>需供应链审批</small>}</div>)}</div></article>
      <article className="panel"><div className="panel-head"><div><h3>默认标准提醒</h3><p>采用物料类型标准时持续提醒供应链补充SKU标准</p></div><b>6项</b></div><div className="standard-reminder"><span><strong>TP-AUX-021</strong><small>辅料 · 来料质检</small></span><b>95.0%</b><button onClick={() => toast("已打开SKU质检标准设置")}>设置专属标准</button></div><div className="standard-reminder"><span><strong>TP-COMP-032</strong><small>配件 · 来料质检</small></span><b>95.0%</b><button onClick={() => toast("已打开SKU质检标准设置")}>设置专属标准</button></div></article>
    </section>
  </section>;
}

function LegacyInventoryPanel({ toast }: { toast: (message: string) => void }) {
  const [view, setView] = useState<"库存" | "盘点">("库存");
  const batches = [
    { batch: "BT260520-014", warehouse: "广州公司仓库", sku: "TP-PIL-001", available: 1680, locked: 480, defective: 0, pending: 0, produced: "2026-05-20", expires: "2028-05-19", warning: "正常" },
    { batch: "BT251102-006", warehouse: "广东鸿基羽绒制品", sku: "TP-COV-018", available: 720, locked: 500, defective: 18, pending: 0, produced: "2025-11-02", expires: "2026-11-01", warning: "黄色预警" },
    { batch: "BT250810-003", warehouse: "南通优库仓库", sku: "TP-AUX-006", available: 3200, locked: 800, defective: 0, pending: 200, produced: "2025-08-10", expires: "2026-08-09", warning: "红色预警" },
    { batch: "BT240701-001", warehouse: "温州组装工厂仓", sku: "TP-CORE-003", available: 0, locked: 0, defective: 86, pending: 0, produced: "2024-07-01", expires: "2026-06-30", warning: "已过期冻结" },
  ];
  return <section className="inventory-page">
    <div className="module-banner inventory-banner"><div><span className="eyebrow">多仓批次库存</span><h2>批次可追溯，负库存绝对禁止</h2><p>有保质期物料按先到期先出推荐；过期自动冻结，只能报废、退回或返工。</p></div><div><button onClick={() => toast("已创建跨仓调拨申请，等待供应链审批")}>＋ 调拨申请</button><button className="light" onClick={() => setView("盘点")}>创建盘点</button></div></div>
    <div className="module-tabs"><button className={view === "库存" ? "active" : ""} onClick={() => setView("库存")}>批次库存</button><button className={view === "盘点" ? "active" : ""} onClick={() => setView("盘点")}>盘点任务</button></div>
    {view === "库存" ? <>
      <div className="inventory-kpis"><article><span>可用库存</span><strong>24,680</strong><small>公司及工厂仓合计</small></article><article><span>预留 / 锁定</span><strong>7,320</strong><small>不足时允许部分预留</small></article><article><span>次品 / 待检</span><strong>304</strong><small>均不可用</small></article><article className="alert-card"><span>到期风险</span><strong>4批</strong><small>黄色2 · 红色1 · 过期1</small></article></div>
      <article className="panel batch-list"><div className="inventory-toolbar"><div><h3>库存批次</h3><p>黄色：剩余保质期≤总保质期1/2；红色：≤1/4</p></div><div><button onClick={() => toast("已按先到期先出排序")}>按FEFO推荐</button><input placeholder="搜索仓库、SKU或批次号"/></div></div>
        <div className="inventory-table"><div className="inventory-row inventory-head"><span>批次 / SKU</span><span>仓库</span><span>可用 / 锁定</span><span>次品 / 待检</span><span>生产 / 到期</span><span>保质期状态</span></div>
          {batches.map(row => <button className="inventory-row" key={row.batch} onClick={() => toast(`已打开库存批次 ${row.batch}`)}><span><strong>{row.batch}</strong><small>{row.sku}</small></span><span><b>{row.warehouse}</b><small>库存归属已确认</small></span><span><b>{row.available.toLocaleString()} / {row.locked.toLocaleString()}</b><small>可用 / 预留锁定</small></span><span><b>{row.defective} / {row.pending}</b><small>次品 / 待检</small></span><span><b>{row.produced}</b><small>到期 {row.expires}</small></span><span><mark className={`expiry-status ${row.warning}`}>{row.warning}</mark></span></button>)}
        </div>
      </article>
    </> : <div className="stocktake-layout">
      <article className="panel stocktake-list"><div className="panel-head"><div><h3>半年度盘点</h3><p>供应链创建并安排工厂执行；冻结期间禁止任何出入库</p></div><button onClick={() => toast("已创建2026年下半年盘点草稿")}>新建盘点</button></div>
        {[
          ["ST260701-001","广州公司仓库","全仓盘点","2026-07-31","执行中","已盘 72%"],
          ["ST260701-002","广东鸿基羽绒制品","按SKU抽盘","2026-07-31","待执行","18个SKU"],
          ["ST251201-006","南通优库仓库","按批次盘点","2025-12-31","差异复盘","差异3批"],
        ].map(row => <button className="stocktake-card" key={row[0]} onClick={() => toast(`已打开盘点单 ${row[0]}`)}><span><strong>{row[0]}</strong><small>{row[1]} · {row[2]}</small></span><span><small>截止日期</small><b>{row[3]}</b></span><span><mark>{row[4]}</mark><small>{row[5]}</small></span><i>→</i></button>)}
      </article>
      <aside className="panel blind-count"><div className="panel-head"><div><h3>盲盘流程</h3><p>盘点人员看不到系统账面数量</p></div></div>
        <div className="blind-steps">{[["1","首次盘点","仅填写实际数量"],["2","另一人复盘","首次有差异时触发"],["3","供应链审批","复盘仍有差异"],["4","生成调整单","盘盈批次自动编号"]].map(row=><div key={row[0]}><i>{row[0]}</i><span><strong>{row[1]}</strong><small>{row[2]}</small></span></div>)}</div>
        <div className="count-rule"><strong>强制校验</strong><p>盘点总数量必须等于可用量＋预留/锁定量＋次品量＋待检量，否则不能提交。</p></div>
      </aside>
    </div>}
  </section>;
}

function InventoryPanel({ toast }: { toast: (message: string) => void }) {
  return <InventoryWorkspace toast={toast} />;
}

function ShippingPanel({ toast }: { toast: (message: string) => void }) {
  return <section className="shipping-page">
    <div className="module-banner shipping-banner"><div><span className="eyebrow">发货、签收与退货</span><h2>按计划日期发货无需审批，偏离计划才审核</h2><p>实际发货时扣减库存；每个物流批次独立记录承运商、单号、时间和凭证。</p></div><button onClick={() => toast("已创建发货计划草稿，等待组装工厂共同确认")}>＋ 新建发货计划</button></div>
    <div className="shipping-kpis"><article><span>今日计划发货</span><strong>5批</strong><small>3,820件</small></article><article><span>运输中</span><strong>8批</strong><small>4个收货地址</small></article><article><span>待签收</span><strong>3批</strong><small>收货方后台确认</small></article><article className="alert-card"><span>物流异常</span><strong>2</strong><small>少货1 · 破损1</small></article></div>
    <div className="shipping-layout">
      <article className="panel shipment-list"><div className="panel-head"><div><h3>发货计划与物流批次</h3><p>同一计划可拆分多批，库存按实际发出数量扣减</p></div><button onClick={() => toast("已打开全部发货计划")}>查看全部</button></div>
        {[
          ["SH260729-018","TP-PIL-001 · 1,200件","广东鸿基 → 广州公司仓库","顺丰 · SF14382901","今天 16:00","待发货","按计划"],
          ["SH260729-015","TP-PIL-006 · 680件","广东鸿基 → 深圳客户仓","京东物流 · JD928114","今天 14:30","运输中","按计划"],
          ["SH260728-011","TP-PIL-011 · 900件","南通工厂 → 电商平台仓","跨越速运 · KY621008","07-28 17:20","待签收","按计划"],
          ["SH260727-008","TP-PIL-003 · 480件","温州工厂 → 广州公司仓库","德邦 · DB738291","07-27 12:05","物流异常","少货12件"],
        ].map(row => <button className="shipment-card" key={row[0]} onClick={() => toast(`已打开物流批次 ${row[0]}`)}><span><strong>{row[0]}</strong><small>{row[1]}</small></span><span><b>{row[2]}</b><small>{row[3]}</small></span><span><b>{row[4]}</b><small>实际 / 计划发货时间</small></span><span><mark className={`shipment-status ${row[5]}`}>{row[5]}</mark><small>{row[6]}</small></span><i>→</i></button>)}
      </article>
      <aside className="panel receipt-panel"><div className="panel-head"><div><h3>收货方待办</h3><p>账号权限仅限关联收货任务</p></div><b>3项</b></div>
        {[
          ["广州公司仓库","SH260729-015","680件","预计今天18:00"],
          ["深圳客户仓","SH260728-011","900件","已到达待签收"],
          ["电商平台仓","SH260727-006","1,200件","凭证待上传"],
        ].map(row=><button className="receipt-item" key={row[1]} onClick={() => toast(`已打开收货任务 ${row[1]}`)}><i>收</i><span><strong>{row[0]}</strong><small>{row[1]} · {row[2]}</small></span><b>{row[3]}</b></button>)}
        <div className="receipt-rule"><strong>异常自动生成</strong><p>签收少货或破损时必须填写原因、上传现场照片，并自动转交供应链处理。</p></div>
      </aside>
    </div>
    <section className="shipping-bottom"><article className="panel"><div className="panel-head"><div><h3>客户及平台退货</h3><p>退回成品先进入冻结库存，完成退货质检后再处理</p></div><button onClick={() => toast("已打开全部退货任务")}>全部4项</button></div><div className="return-flow">{["退货入库冻结","工厂提出方案","供应链审核","重新入库 / 返工 / 报废"].map((item,i)=><div key={item}><i>{i+1}</i><span>{item}</span>{i<3&&<b>→</b>}</div>)}</div></article><article className="panel"><div className="panel-head"><div><h3>发货凭证完整性</h3><p>缺少任一必填项不得确认实际发货</p></div><b>98.2%</b></div><div className="evidence-grid"><span>承运商 ✓</span><span>物流单号 ✓</span><span>实际发货时间 ✓</span><span>发货凭证 ✓</span></div></article></section>
  </section>;
}

function CollaborationPanel({ toast }: { toast: (message: string) => void }) {
  return <section className="collab-page">
    <div className="module-banner collab-banner"><div><span className="eyebrow">三级供应网络协同</span><h2>直接管理第一层，穿透监督第二层，知悉第三层</h2><p>下级异常不影响第一层交付时由组装工厂自行处理；可能影响公司交付时立即强预警。</p></div><button onClick={() => toast("已打开外部协同账号管理")}>管理协同账号</button></div>
    <div className="network-columns">
      <article className="network-card tier-one"><header><i>1</i><span><strong>第一层 · 组装工厂</strong><small>供应链直接管理</small></span><b>5家</b></header><div className="network-score"><strong>91.6</strong><span>综合绩效<small>含内部满意度</small></span></div><ul><li>采购计划与采购单履约</li><li>管理下属二、三层供应商</li><li>不能按期交货时进入供应链审批</li></ul><button onClick={() => toast("已进入第一层组装工厂列表")}>查看组装工厂 →</button></article>
      <article className="network-card tier-two"><header><i>2</i><span><strong>第二层 · 核心供应商</strong><small>组装工厂管理，供应链监督</small></span><b>12家</b></header><div className="network-score"><strong>88.2</strong><span>综合绩效<small>备料风险2项</small></span></div><ul><li>自行确认系统生成的采购任务</li><li>供应链查看完整执行和质检明细</li><li>供应链原则上不直接下达指令</li></ul><button onClick={() => toast("已进入核心供应商风险看板")}>查看核心风险 →</button></article>
      <article className="network-card tier-three"><header><i>3</i><span><strong>第三层 · 非核心/辅料</strong><small>组装工厂自行管理</small></span><b>12家</b></header><div className="network-score"><strong>86.9</strong><span>综合绩效<small>异常知悉3项</small></span></div><ul><li>供应链查看企业资料与采购价格</li><li>不查看日常订单执行明细</li><li>风险预警后由组装工厂决定暂停</li></ul><button onClick={() => toast("已进入第三层异常概览")}>查看异常概览 →</button></article>
    </div>
    <div className="collab-layout">
      <article className="panel risk-timeline"><div className="panel-head"><div><h3>可能影响公司交付</h3><p>系统预测和第一层主动报告均可触发强预警</p></div><b>2项</b></div>
        {[
          ["CR260729-003","乳胶芯延期可能影响MO260729-009","第一层须在24小时内提交方案","剩余18小时","强预警"],
          ["CR260728-007","包装纸箱来料质检不合格","第一层已提交替代备料方案","待供应链审核","处理中"],
        ].map(row=><button className="risk-item" key={row[0]} onClick={() => toast(`已打开风险 ${row[0]}`)}><i>!</i><span><strong>{row[1]}</strong><small>{row[0]} · {row[2]}</small></span><b>{row[3]}</b><mark>{row[4]}</mark></button>)}
      </article>
      <aside className="panel performance-panel"><div className="panel-head"><div><h3>季度评价</h3><p>排名隐藏企业名称，仅显示本企业位置</p></div><button onClick={() => toast("已打开绩效权重设置")}>配置权重</button></div><div className="performance-bars">{[["准时交付率",92],["质检合格率",96],["异常处理及时率",84],["备料按期完成率",88],["打样配合度",90],["内部满意度",93]].map(row=><div key={row[0]}><span>{row[0]}<b>{row[1]}</b></span><i><em style={{width:`${row[1]}%`}}/></i></div>)}</div></aside>
    </div>
  </section>;
}

type ManagedUser = {
  id: number; email: string; mobile: string; name: string; accountStatus: string;
  organizationName?: string | null; roles: string[];
  roleAssignments: Array<{ id: number; roleCode: string; effectiveFrom: string; effectiveTo?: string | null; status: string }>;
};

type ApprovalItem = {
  id: number; requestNo: string; workflowType: string; summary: string;
  highRisk: boolean; status: string; requestedAt: string;
  objectVersion: number;
  approvalOwner: "r1" | "r2" | "r3" | "unknown";
  stepUpObjectType: "approval" | "r2:approval_request";
};

const roleLabels: Record<string, string> = {
  admin: "系统管理员", supply_chain: "供应链", finance: "财务",
  factory: "组装工厂", supplier_qc: "供应商质检", company_qc: "公司质检", receiver: "收货方",
};

async function apiJson(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

function SystemManagementPanel({ toast }: { toast: (message: string) => void }) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedUser, setSelectedUser] = useState("");
  const [roleCode, setRoleCode] = useState("supply_chain");
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().slice(0, 10));
  const [effectiveTo, setEffectiveTo] = useState("");
  const [reason, setReason] = useState("");

  const refresh = async () => {
    setLoading(true);
    try {
      const data = await apiJson("/api/v1/users");
      setUsers(data.users ?? []);
    } catch (error) {
      toast(error instanceof Error ? error.message : "用户列表加载失败");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void refresh(); }, []);

  const grantRole = async () => {
    try {
      await mutateJson("/api/v1/users", "POST", { userId: Number(selectedUser), roleCode, effectiveFrom, effectiveTo: effectiveTo || null, reason });
      toast("角色申请已提交，等待另一位管理员审批");
      setReason("");
      await refresh();
    } catch (error) { toast(error instanceof Error ? error.message : "提交失败"); }
  };
  const unlock = async (userId: number) => {
    try {
      await mutateJson("/api/v1/users", "PATCH", { userId, action: "unlock" });
      toast("账号已解锁");
      await refresh();
    } catch (error) { toast(error instanceof Error ? error.message : "解锁失败"); }
  };
  const revoke = async (roleAssignmentId: number) => {
    const revokeReason = window.prompt("请输入撤销该角色的原因");
    if (!revokeReason) return;
    try {
      await mutateJson("/api/v1/users", "DELETE", { roleAssignmentId, reason: revokeReason });
      toast("撤销申请已提交，等待另一位管理员审批");
      await refresh();
    } catch (error) { toast(error instanceof Error ? error.message : "提交失败"); }
  };

  return <section className="backoffice-page real-admin">
    <div className="module-banner backoffice-banner"><div><span className="eyebrow">系统管理</span><h2>真实账号、角色与临时权限</h2><p>角色新增与撤销均进入双人审批；临时权限最长90天。</p></div><button onClick={() => void refresh()}>刷新数据</button></div>
    <div className="backoffice-kpis">
      <article><span>账号总数</span><strong>{users.length}</strong><small>实时数据库</small></article>
      <article><span>正常账号</span><strong>{users.filter(x => x.accountStatus === "active").length}</strong><small>可正常登录</small></article>
      <article><span>锁定账号</span><strong>{users.filter(x => x.accountStatus === "locked").length}</strong><small>需管理员解锁</small></article>
      <article><span>待审角色</span><strong>{users.flatMap(x => x.roleAssignments).filter(x => x.status === "pending").length}</strong><small>职责分离审批</small></article>
    </div>
    <article className="panel admin-form">
      <div className="panel-head"><div><h3>申请新增角色</h3><p>生效后用户可同时拥有多个岗位权限</p></div></div>
      <div className="admin-fields">
        <select value={selectedUser} onChange={e => setSelectedUser(e.target.value)}><option value="">选择用户</option>{users.map(user => <option key={user.id} value={user.id}>{user.name} · {user.email}</option>)}</select>
        <select value={roleCode} onChange={e => setRoleCode(e.target.value)}>{Object.entries(roleLabels).map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select>
        <input type="date" value={effectiveFrom} onChange={e => setEffectiveFrom(e.target.value)} />
        <input type="date" value={effectiveTo} onChange={e => setEffectiveTo(e.target.value)} title="留空表示长期权限" />
        <input value={reason} onChange={e => setReason(e.target.value)} placeholder="申请原因（必填）" />
        <button className="primary" disabled={!selectedUser || !reason} onClick={() => void grantRole()}>提交双人审批</button>
      </div>
    </article>
    <article className="panel backoffice-list">
      <div className="backoffice-toolbar"><div><h3>用户与权限</h3><p>{loading ? "正在读取真实数据…" : "账号停用后历史业务和审计链继续保留"}</p></div></div>
      <div className="admin-users">
        <div className="admin-user-row admin-user-head"><span>用户</span><span>组织</span><span>角色</span><span>账号状态</span><span>操作</span></div>
        {users.map(user => <div className="admin-user-row" key={user.id}>
          <span><strong>{user.name}</strong><small>{user.email} · {user.mobile}</small></span>
          <span>{user.organizationName || "公司内部"}</span>
          <span className="role-chips">{user.roles.map(role => <b key={role}>{roleLabels[role] || role}</b>)}{user.roleAssignments.filter(x => x.status === "active").map(item => <button key={item.id} onClick={() => void revoke(item.id)} title="申请撤销该附加角色">撤销 {roleLabels[item.roleCode] || item.roleCode}</button>)}</span>
          <span><mark>{user.accountStatus}</mark></span>
          <span>{user.accountStatus === "locked" ? <button onClick={() => void unlock(user.id)}>管理员解锁</button> : "—"}</span>
        </div>)}
      </div>
    </article>
    <AuditWorkspace toast={toast} />
  </section>;
}

function ApprovalCenterPanel({ toast }: { toast: (message: string) => void }) {
  const [items, setItems] = useState<ApprovalItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<ApprovalItem | null>(null);
  const [decision, setDecision] = useState<"approved" | "rejected">("approved");
  const [comment, setComment] = useState("");
  const [challengeNo, setChallengeNo] = useState("");
  const [code, setCode] = useState("");
  const [verified, setVerified] = useState(false);
  const [maskedMobile, setMaskedMobile] = useState("");

  const refresh = async () => {
    setLoading(true);
    try { const data = await apiJson("/api/v1/approvals"); setItems(data.approvals ?? []); }
    catch (error) { toast(error instanceof Error ? error.message : "审批列表加载失败"); }
    finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, []);

  const choose = (item: ApprovalItem, nextDecision: "approved" | "rejected") => {
    setSelected(item); setDecision(nextDecision); setComment(""); setChallengeNo(""); setCode(""); setVerified(false); setMaskedMobile("");
  };
  const sendCode = async () => {
    if (!selected) return;
    try {
      const requestDigest = await finalRequestDigest({ id: selected.id, decision, comment: comment.trim() });
      const data = await mutateJson<{ challengeNo:string; mobile?:string; previewCode?:string }, Record<string, unknown>>(
        "/api/v1/auth/step-up/request", "POST",
        { action: selected.approvalOwner === "r2" ? (decision === "approved" ? "approve" : "reject") : "review",
          objectType: selected.stepUpObjectType, objectId: String(selected.id),
          objectVersion: selected.objectVersion, requestDigest },
      );
      setChallengeNo(data.challengeNo);
      setMaskedMobile(data.mobile || "");
      toast(data.previewCode ? `本地预览验证码：${data.previewCode}` : `验证码已发送至 ${data.mobile}`);
    } catch (error) { toast(error instanceof Error ? error.message : "验证码发送失败"); }
  };
  const verifyCode = async () => {
    try {
      await mutateJson("/api/v1/auth/step-up/verify", "POST", { challengeNo, code });
      setVerified(true); toast("手机验证通过，请确认提交审批");
    } catch (error) { toast(error instanceof Error ? error.message : "验证码校验失败"); }
  };
  const submit = async () => {
    if (!selected) return;
    try {
      await mutateJson("/api/v1/approvals", "POST", {
        id: selected.id, decision, comment,
        ...(selected.highRisk ? { challengeNo } : {}),
      });
      toast(decision === "approved" ? "审批已通过并记录操作日志" : "审批已拒绝并记录操作日志");
      setSelected(null); await refresh();
    } catch (error) { toast(error instanceof Error ? error.message : "审批提交失败"); }
  };

  const pending = items.filter(item => item.status === "pending");
  return <section className="backoffice-page real-admin">
    <div className="module-banner backoffice-banner"><div><span className="eyebrow">审批中心</span><h2>职责分离与高风险复核</h2><p>发起人不能审核本人事项；验证码只在审核人明确点击后发送。</p></div><button onClick={() => void refresh()}>刷新数据</button></div>
    <div className="backoffice-kpis">
      <article><span>待处理</span><strong>{pending.length}</strong><small>真实审批单</small></article>
      <article><span>高风险</span><strong>{pending.filter(x => x.highRisk).length}</strong><small>需要手机验证</small></article>
      <article><span>已通过</span><strong>{items.filter(x => x.status === "approved").length}</strong><small>最近100条</small></article>
      <article><span>已拒绝</span><strong>{items.filter(x => x.status === "rejected").length}</strong><small>保留完整轨迹</small></article>
    </div>
    <article className="panel backoffice-list">
      <div className="backoffice-toolbar"><div><h3>待审批事项</h3><p>{loading ? "正在读取真实数据…" : "审批结果会同步业务状态并写入审计日志"}</p></div></div>
      <div className="approval-list">{pending.map(item => <div className="approval-row" key={item.id}>
        <span><strong>{item.requestNo}</strong><small>{new Date(item.requestedAt).toLocaleString("zh-CN")}</small></span>
        <span><strong>{item.summary}</strong><small>{item.workflowType}</small></span>
        <span>{item.highRisk ? <mark className="risk-mark">高风险 · 需验证码</mark> : <mark>普通审批</mark>}</span>
        <span><button onClick={() => choose(item, "rejected")}>拒绝</button><button className="primary" onClick={() => choose(item, "approved")}>通过</button></span>
      </div>)}</div>
    </article>
    {selected && <div className="approval-overlay" onClick={() => setSelected(null)}><article className="approval-dialog" onClick={e => e.stopPropagation()}>
      <header><div><span>{selected.requestNo}</span><h3>{decision === "approved" ? "确认通过审批" : "确认拒绝审批"}</h3></div><button onClick={() => setSelected(null)}>×</button></header>
      <p>{selected.summary}</p>
      <textarea value={comment} onChange={e => setComment(e.target.value)} placeholder="审核意见（建议填写）" />
      {selected.highRisk && <div className="stepup-box">
        <strong>高风险操作手机验证</strong>
        <p>不会自动发送。请在准备好后明确点击发送验证码。</p>
        {!challengeNo ? <button onClick={() => void sendCode()}>发送验证码</button> : <><small>已发送至 {maskedMobile}</small><div><input inputMode="numeric" maxLength={6} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ""))} placeholder="6位验证码" /><button disabled={code.length !== 6} onClick={() => void verifyCode()}>验证</button></div></>}
        {verified && <mark>手机验证已通过</mark>}
      </div>}
      <footer><button onClick={() => setSelected(null)}>取消</button><button className="primary" disabled={selected.highRisk && !verified} onClick={() => void submit()}>确认提交</button></footer>
    </article></div>}
  </section>;
}

function BackofficePanel({ module, toast }: { module: string; toast: (message: string) => void }) {
  const configs: Record<string, { title: string; subtitle: string; metrics: string[][] }> = {
    财务结算: { title: "发票、请款与付款", subtitle: "按实际发货批次生成请款；供应链与财务双重核验发票后才能付款。", metrics: [["待发票","6","¥238,400"],["待双重核验","4","供应链2 · 财务3"],["计划付款","¥486,750","未来30天"],["部分付款","3","剩余¥92,600"]] },
    审批中心: { title: "双人审批与职责分离", subtitle: "发起人不得审核本人事项；高风险操作继续要求手机验证码。", metrics: [["我的待审批","12","其中4项高风险"],["我发起的","5","2项待处理"],["今日完成","18","平均3.2小时"],["逾期事项","2","每日提醒"]] },
    系统管理: { title: "账号、权限与审计", subtitle: "多角色、临时权限和五年日志；敏感查看与导出同样留痕。", metrics: [["启用账号","86","内部24 · 外部62"],["临时权限","7","最长90天"],["锁定账号","2","连续失败5次"],["今日敏感访问","38","全部记录"]] },
    AI助手: { title: "供应链AI业务助手", subtitle: "只查询、解释和生成待确认草稿；不能直接修改业务数据。", metrics: [["今日问答","42","引用业务单据96条"],["操作草稿","8","待人工确认"],["咨询工单","3","统一交供应链分派"],["改进建议","5","仅内部可转开发"]] },
  };
  const cfg = configs[module];
  const rows: Record<string, string[][]> = {
    财务结算: [["PR260729-006","广东鸿基羽绒制品","PO260729-006 · 本批1,200件","¥81,600","待发票","2026-08-25"],["PR260728-011","南通组装工厂","PO260728-014 · 本批900件","¥92,750","待财务核验","2026-09-25"],["PR260727-009","温州组装工厂","PO260725-008 · 本批600件","¥68,400","部分付款","剩余¥18,400"],["PR260725-004","广东鸿基羽绒制品","PO260724-012 · 本批2,000件","¥136,000","待付款","2026-08-25"]],
    审批中心: [["AP260729-018","核心配件价格变更","乳胶芯 ¥18.60 → ¥19.20","高风险","待我审批","同事A发起"],["AP260729-015","采购单超计划","TP-PIL-011 超出安全范围4.0%","普通","待我审批","同事A发起"],["AP260729-012","BOM V4发布","TP-PIL-001 · 09-01生效","普通","待我审批","同事C发起"],["AP260728-009","付款记录冲正","流水号关联错误","高风险","待财务B审批","财务A发起"]],
    系统管理: [["陈文超","供应链经办人、质检","内部员工","正常","常用设备剩余72天","今天16:42"],["周敏","财务经办人","内部员工","正常","新设备已验证","今天15:18"],["广东鸿基-王工","工厂管理员","第一层工厂","正常","常用设备剩余48天","今天14:06"],["南通优库-李工","第三层供应商","外部供应商","已停用","历史记录保留","06-30 09:20"]],
    AI助手: [["库存问答","TP-PIL-001还有多少可发库存？","已引用3个批次和1张发货计划","已完成","AI-Q260729-042","供应链"],["付款草稿","生成PR260728-011付款登记草稿","等待财务确认及手机验证码","待确认","AI-Q260729-039","财务"],["数据冲突","采购单与发票金额不一致","已生成咨询工单","无法确认","AI-Q260729-035","供应链"],["改进建议","工厂建议增加批量上传物流凭证","已提交供应链评估","待分派","AI-Q260729-028","工厂"]],
  };
  return <section className="backoffice-page">
    <div className={`module-banner backoffice-banner ${module}`}><div><span className="eyebrow">{module}</span><h2>{cfg.title}</h2><p>{cfg.subtitle}</p></div><button onClick={() => toast(`${module}已创建一条新草稿`)}>＋ 新建</button></div>
    <div className="backoffice-kpis">{cfg.metrics.map(item=><article key={item[0]}><span>{item[0]}</span><strong>{item[1]}</strong><small>{item[2]}</small></article>)}</div>
    <article className="panel backoffice-list"><div className="backoffice-toolbar"><div><h3>{module === "系统管理" ? "用户与权限" : module === "AI助手" ? "最近对话与草稿" : "待处理事项"}</h3><p>{module === "财务结算" ? "请款单按组装工厂和计划付款日合并，保留关联采购单明细" : module === "审批中心" ? "审批通过、拒绝和更正均完整留痕" : module === "系统管理" ? "账号停用后历史业务记录继续保留" : "回答必须附业务单号和可点击数据来源"}</p></div><div><button onClick={() => toast("已导出带导出人和时间水印的文件")}>带水印导出</button><input placeholder="搜索单号、人员或内容"/></div></div>
      <div className="backoffice-table"><div className="backoffice-row backoffice-head">{["业务标识","事项 / 主体","说明","风险 / 状态","当前状态","责任人 / 日期"].map(x=><span key={x}>{x}</span>)}</div>{rows[module].map((row,i)=><button className="backoffice-row" key={row[4]} onClick={() => toast(`已打开 ${row[0]}`)}>{row.map((cell,j)=><span key={j}><b>{cell}</b>{j===0&&<small>完整操作轨迹</small>}</span>)}</button>)}</div>
    </article>
    <div className="governance-grid">
      <article className="panel"><div className="panel-head"><div><h3>关键控制</h3><p>系统自动执行，不依赖人工记忆</p></div></div><div className="control-list">{(module==="财务结算"?["发票必须供应链和财务双方核验","发票金额不符禁止核验","部分付款逐笔记录银行流水","更正保留原记录并新增冲正"]:module==="审批中心"?["发起人与审核人强制分离","高风险审批前重新验证手机","拒绝后必须重新提交","审批前后值永久关联业务单"]:module==="系统管理"?["新设备、异地及高风险操作验证手机","失败5次由管理员解锁","临时权限90天到期自动收回","日志5年后归档，由管理员决定删除"]:["数据权限继承当前用户","无法确认时生成咨询工单","附件识别结果逐项人工确认","代码发布需管理员和供应链负责人共同审批"]).map(x=><span key={x}>✓ {x}</span>)}</div></article>
      <article className="panel"><div className="panel-head"><div><h3>操作日志</h3><p>查看、修改、审批和导出均记录</p></div><b>实时</b></div><div className="audit-stream">{[["16:42","陈文超","查看核心配件价格"],["16:35","周敏","核验发票INV-260729-08"],["16:20","系统","生成请款单PR260729-006"],["16:08","AI助手","生成库存调拨草稿"]].map(x=><div key={x[0]}><b>{x[0]}</b><span><strong>{x[1]}</strong><small>{x[2]}</small></span></div>)}</div></article>
    </div>
  </section>;
}

function LoginScreen({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [challengeNo, setChallengeNo] = useState("");
  const [code, setCode] = useState("");
  const [maskedMobile, setMaskedMobile] = useState("");
  const [message, setMessage] = useState("");
  const [deviceId, setDeviceId] = useState("");
  useEffect(() => {
    const existing = window.localStorage.getItem("topology_device_id");
    if (existing) { setDeviceId(existing); return; }
    const created = crypto.randomUUID();
    window.localStorage.setItem("topology_device_id", created);
    setDeviceId(created);
  }, []);
  const login = async () => {
    setMessage("正在验证…");
    let payload: { authenticated:boolean; challengeNo?:string; maskedMobile?:string; previewCode?:string };
    try { payload = await mutateJson("/api/v1/auth/login", "POST", { account, password, deviceId, deviceName: navigator.userAgent.slice(0, 80) }, { csrf:false }); }
    catch (error) { setMessage(error instanceof Error ? error.message : "登录失败"); return; }
    if (payload.authenticated) { onAuthenticated(); return; }
    if (!payload.challengeNo) { setMessage("登录响应缺少验证码任务"); return; }
    setChallengeNo(payload.challengeNo); setMaskedMobile(payload.maskedMobile ?? ""); setMessage(payload.previewCode ? `本地预览验证码：${payload.previewCode}` : "验证码已发送");
  };
  const verify = async () => {
    try { await mutateJson("/api/v1/auth/verify", "POST", { challengeNo, code, deviceName: navigator.userAgent.slice(0, 80) }, { csrf:false }); }
    catch (error) { setMessage(error instanceof Error ? error.message : "验证失败"); return; }
    onAuthenticated();
  };
  return <main className="login-shell"><section className="login-card"><div className="login-brand"><i>拓</i><span><strong>拓扑供应链</strong><small>广州拓扑睡眠科技有限公司</small></span></div><div className="login-copy"><span>SCM · 进销存协同系统</span><h1>{challengeNo ? "验证登录设备" : "欢迎回来"}</h1><p>{challengeNo ? `验证码已发送至 ${maskedMobile}` : "使用账号密码登录；新设备、异地或高风险操作需要手机验证。"}</p></div>{challengeNo ? <div className="login-form"><label>手机验证码<input inputMode="numeric" maxLength={6} value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,""))} placeholder="请输入6位验证码"/></label><button onClick={verify}>验证并信任设备90天</button><button className="text-button" onClick={()=>{setChallengeNo("");setCode("");setMessage("");}}>返回账号登录</button></div> : <div className="login-form"><label>登录账号<input autoComplete="username" value={account} onChange={e=>setAccount(e.target.value)} placeholder="请输入公司邮箱"/></label><label>密码<input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="请输入密码"/></label><button onClick={login}>登录</button><small>连续输错5次将锁定账号，需管理员解锁</small></div>}{message&&<div className="login-message">{message}</div>}<footer>scm.topologygz.com · 安全访问</footer></section></main>;
}

export default function Home() {
  const [sessionState, setSessionState] = useState<"loading" | "ready" | "login">("loading");
  const [active, setActive] = useState("工作台");
  const [filter, setFilter] = useState("全部");
  const [notice, setNotice] = useState("");
  const [approvalCount, setApprovalCount] = useState(5);
  const [importOpen, setImportOpen] = useState(false);
  const [importKind, setImportKind] = useState<"plan" | "order">("order");
  const [importResult, setImportResult] = useState("");
  const [qualityOpen, setQualityOpen] = useState(false);
  const [sessionName, setSessionName] = useState("陈文超");
  const [sessionUserId, setSessionUserId] = useState(0);
  const [sessionRole, setSessionRole] = useState("供应链管理员");
  const [sessionRoles, setSessionRoles] = useState<string[]>([]);
  const visible = useMemo(() => filter === "全部" ? orders : orders.filter(o => o.status === filter), [filter]);
  const toast = (message: string) => { setNotice(message); window.setTimeout(() => setNotice(""), 2400); };
  useEffect(() => {
    fetch("/api/v1/session")
      .then(response => response.ok ? response.json() : Promise.reject(new Error("unauthenticated")))
      .then(payload => {
        if (!payload?.user) return;
        setSessionName(payload.user.name);
        setSessionUserId(payload.user.id);
        setSessionRole(payload.user.roles.join("、"));
        setSessionRoles(payload.user.roles);
        setSessionState("ready");
      })
      .catch(() => setSessionState("login"));
  }, []);
  const importExcel = async (file?: File) => {
    if (!file) return;
    try {
      if (sessionUserId <= 0) throw new Error("安全会话缺少用户标识，请重新登录");
      if (file.size > 20 * 1024 * 1024) throw new Error("单个文件不能超过 20MB");
      if (!/\.(xlsx|xls)$/iu.test(file.name)) throw new Error("仅支持 .xlsx 或 .xls 文件");
      setImportResult("正在预检并安全归档，请勿关闭窗口…");
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
      const sheets = workbook.SheetNames.map(name => ({
        name,
        rows: XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[name]!, { defval: "" })
          .filter(row => Object.values(row).some(Boolean)),
      }));
      const fingerprint = `${file.name}:${file.size}:${file.lastModified}:${workbook.SheetNames.join("|")}`;
      const type = importKind === "plan" ? "purchase_plan" : "purchase_order";
      const preview = await r2Imports.preview<ImportPreview>({ type, fileName: file.name, fingerprint, sheets });
      if (!preview.canCommit) {
        const first = preview.errors[0];
        setImportResult(`无法正式导入：发现 ${preview.summary.errorCount} 个错误${first ? `；${first.sheet} 第 ${first.row || "—"} 行 ${first.message}` : ""}`);
        return;
      }
      const form = new FormData();
      form.append("file", file);
      form.append("category", "import_source");
      form.append("entityType", "import_upload");
      form.append("entityId", String(sessionUserId));
      const uploaded = await uploadPlatformFile<UploadedImport>(form);
      if (!uploaded.usable) throw new Error("文件安全扫描尚未完成，请稍后重试");
      const staged = await r2Imports.stage<ImportStage>({
        type: preview.type,
        fileObjectId: uploaded.file.id,
        fileName: preview.fileName,
        fingerprint: preview.fingerprint,
        rows: preview.rows,
        errors: preview.errors,
        warnings: preview.warnings,
      });
      const committed = await r2Imports.commit<ImportCommit>({ batchId: staged.batch.id });
      const warning = preview.summary.warningCount ? `，另有 ${preview.summary.warningCount} 条提醒` : "";
      setImportResult(committed.awaitingMapping
        ? `校验通过并安全暂存：${preview.summary.validRows} 行${warning}；批次 ${staged.batch.importNo} 等待 SKU、工厂、仓库及 BOM 映射后生成正式单据。`
        : `校验通过并提交：${preview.summary.validRows} 行${warning}。`);
    } catch (error) {
      setImportResult(error instanceof Error ? error.message : "文件读取或导入失败，请确认文件格式和安全会话");
    }
  };

  if (sessionState === "loading") return <main className="login-shell"><div className="login-loading">正在验证安全会话…</div></main>;
  if (sessionState === "login") return <LoginScreen onAuthenticated={() => { setSessionState("loading"); window.location.reload(); }} />;
  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="brandmark">拓</span><div><strong>拓扑供应链</strong><small>进销存协同系统</small></div></div>
        <nav>{nav.map((item, i) => <button key={item} className={active === item ? "active" : ""} onClick={() => { setActive(item); }}><span>{["⌂","▤","♙","◫","◇","◎","↗","▦","♧","¥","✓","⚙","✦"][i]}</span>{item}{item === "物料与补料" && <b>3</b>}</button>)}</nav>
        <div className="factory-entry"><span>外部协同端 · 权限隔离</span><strong>工厂看本厂任务；供应商只看自己物料的质检与异常</strong><button onClick={() => toast("外部账号按工厂或供应商自动隔离数据")}>预览协同端 →</button></div>
        <div className="profile"><i>{sessionName.slice(0,1)}</i><div><strong>{sessionName}</strong><small>{sessionRole}</small></div><span>•••</span></div>
      </aside>

      <section className="content">
        <header><div><p>2026 年 7 月 29 日 · 周三</p><h1>{active === "工作台" ? `早上好，${sessionName}` : active}</h1></div><div className="header-actions"><button aria-label="通知" className="icon">♢<em>5</em></button><button className="primary" onClick={() => { setImportKind("order"); setImportResult(""); setImportOpen(true); }}>＋ 导入领星采购单</button></div></header>

        <section className="permission-bar">
          <span><i>✓</i> 当前身份：供应链管理员</span>
          <span>审批权限：来料/成品质检改判 · 超产 · 盘点差异 · 偏离计划发货 · 跨仓调拨</span>
          <b>{approvalCount} 项待审批</b>
        </section>

        {active === "供应商管理" ? <SupplierWorkspace toast={toast} /> : active === "采购管理" ? <PurchaseWorkspace toast={toast} openImport={kind => { setImportKind(kind); setImportResult(""); setImportOpen(true); }} /> : active === "物料与补料" ? <MasterDataWorkspace toast={toast} /> : active === "执行单" ? <ProductionWorkspace toast={toast} /> : active === "生产质检" ? <QualityPanel toast={toast} /> : active === "库存管理" ? <InventoryPanel toast={toast} /> : active === "发货管理" ? <ShippingWorkspace toast={toast} roles={sessionRoles} /> : active === "工厂协同" ? <CollaborationPanel toast={toast} /> : active === "审批中心" ? <ApprovalCenterPanel toast={toast} /> : active === "系统管理" ? <SystemManagementPanel toast={toast} /> : active === "财务结算" ? <FinanceWorkspace toast={toast} /> : active === "AI助手" ? <BackofficePanel module={active} toast={toast} /> : <>
        <section className="focus">
          <div><span className="eyebrow">三级供应网络 · 今日概况</span><h2>订单正在有序推进，<b>3 项供应风险</b>需要处理</h2><p>组装工厂负责下属供应商交付；供应链部门制定政策、查看备料并监控断供风险。</p></div>
          <div className="focus-number"><strong>87<small>%</small></strong><span>本月准时交付率</span><i>↑ 4.2%</i></div>
        </section>

        <section className="metrics">
          {[
            ["采购执行中","12","张","¥ 638,420","本月采购金额"],
            ["待生产交付","8,640","件","3 类","成品 · 辅料 · 配件"],
            ["物料待处理","3","项","2 项紧急","缺料 / 质检异常"],
            ["待发货","5","批","3,820 件","可用成品"],
          ].map((m, i) => <article key={m[0]}><div className={`metric-icon c${i}`}>{["▤","◫","◇","↗"][i]}</div><span>{m[0]}</span><h3>{m[1]} <small>{m[2]}</small></h3><footer><b>{m[3]}</b><small>{m[4]}</small></footer></article>)}
        </section>

        <section className="grid">
          <article className="panel execution">
            <div className="panel-head"><div><h3>工厂执行进度</h3><p>按交期优先，实时查看生产与发货状态</p></div><button onClick={() => toast("已进入全部执行单")}>查看全部 →</button></div>
            <div className="filters">{["全部","生产中","待补料","待发货"].map(f => <button className={filter === f ? "selected" : ""} onClick={() => setFilter(f)} key={f}>{f}</button>)}</div>
            <div className="table">
              <div className="tr th"><span>执行单 / 产品</span><span>工厂</span><span>交期</span><span>进度</span><span>状态</span></div>
              {visible.map((o, index) => <div className="tr" key={o.id}><span><strong>{o.product}</strong><small>{o.id} · {o.sku}</small></span><span>{o.factory}<small>{index < 3 ? `分批交付 ${index + 1}/${index + 2}` : "已全部交付"}</small></span><span><b className={o.risk === "异常" ? "danger" : ""}>{o.due}</b><small>{o.risk === "异常" ? "仅剩 2 天" : "计划交付"}</small></span><span><div className="progress"><i style={{width:`${o.done/o.qty*100}%`}} /></div><small>{o.done.toLocaleString()} / {o.qty.toLocaleString()}</small></span><span><mark className={o.status === "待补料" ? "status-shortage" : o.status === "待发货" ? "status-shipping" : o.status === "已完成" ? "status-complete" : ""}>{o.status}</mark></span></div>)}
            </div>
          </article>

          <aside className="panel todos">
            <div className="panel-head"><div><h3>待办与异常</h3><p>按影响程度排序</p></div><button onClick={() => toast("已打开全部待办")}>全部 8 项</button></div>
            {[
              ["urgent","供应商全检进行中","CloudAir 乳胶枕整批 1,200 件已隔离，已全检 680 件","塌边 26 件 · 污渍 12 件 · 642 件合格可发","查看全检"],
              ["warn","SKU 默认组装工厂变更","RR-NP-01：工厂 A → 工厂 B · 原因已填写","同事 A 发起 · 等待另一位同事审核","供应链审批"],
              ["info","偏离计划发货待审批","顺丰 SF1438… · 比约定时间提前 2 天 · 凭证 2 张","工厂 A 提交 · 15 分钟前","供应链审批"],
              ["neutral","核心配件延期待终审","乳胶芯 2,400 件 · 含税 ¥18.60 / 未税 ¥16.46 · 税率 13%","组装工厂已确认 08-05 · 等待供应链审核","供应链审批"],
              ["warn","核心配件调价待审批","乳胶芯含税价 ¥18.60 → ¥19.20 · 08-15 生效","同事 A 提交 · 等待同事 B 审核","供应链审批"],
              ["info","分批请款 · 待发票","工厂 A 本批发出 1,200 件 · 请款 ¥81,600","07-25 后发货 → 09-25 付款 · 等待整单或本批发票","查看请款"],
              ["warn","新 SKU 暂用类型标准","SL-CM-09 暂用“配件”默认合格率 95.0%","系统提醒 · 需要补充专属标准","设置标准"],
            ].map(t => <div className="todo" key={t[1]}><i className={t[0]}>!</i><div><strong>{t[1]}</strong><p>{t[2]}</p><small>{t[3]}</small></div><button onClick={() => { if (t[4] === "设置标准") { setQualityOpen(true); return; } if (t[4] === "查看全检") { toast("已进入全检任务，仅合格数量可转入可发库存"); return; } toast(`已打开审批单：${t[1]}`); if (t[4] === "供应链审批") setApprovalCount(v => Math.max(0, v - 1)); }}>{t[4]}</button></div>)}
          </aside>
        </section>

        <section className="lower">
          <article className="panel flow"><div className="panel-head"><div><h3>本月订单流转</h3><p>从采购导入到交付完成</p></div><b>7 月</b></div><div className="flowline">{[["采购导入","18"],["工厂确认","16"],["生产中","12"],["待发货","5"],["已完成","9"]].map((x,i)=><div key={x[0]}><span>{x[1]}</span><small>{x[0]}</small>{i < 4 && <i />}</div>)}</div></article>
          <article className="panel stock"><div className="panel-head"><div><h3>多仓库存健康度</h3><p>调出发货时扣减 · 调入确认收货时增加</p></div><button onClick={() => toast("已进入按仓库查看的库存明细")}>按仓库查看 →</button></div><div className="stockbar"><i /><i /><i /></div><div className="legend"><span><i className="green"/>可用库存 <b>18,420</b></span><span><i className="amber"/>生产锁定 <b>6,780</b></span><span><i className="red"/>在途调拨 <b>320</b></span></div></article>
        </section>
        </>}
      </section>
      {importOpen && <div className="modal-backdrop" role="presentation" onMouseDown={() => setImportOpen(false)}>
        <section className="import-modal" role="dialog" aria-modal="true" aria-labelledby="import-title" onMouseDown={e => e.stopPropagation()}>
          <button className="modal-close" aria-label="关闭" onClick={() => setImportOpen(false)}>×</button>
          <span className="modal-icon">表</span>
          <h2 id="import-title">导入领星{importKind === "plan" ? "采购计划" : "采购单"}</h2>
          <p>{importKind === "plan" ? "系统按期望到货日期、组装工厂、采购仓库和SKU汇总；组合展开子项仅留作原始档案。" : "系统将读取“单据信息”和“产品信息”，校验SKU、采购数量、交期及重复单号。"}</p>
          <label className="dropzone">
            <input type="file" accept=".xlsx,.xls" onChange={e => importExcel(e.target.files?.[0])} />
            <strong>选择或拖入领星 Excel 文件</strong>
            <small>支持 .xlsx / .xls，单个文件不超过 20MB</small>
          </label>
          <div className="import-rules">{importKind === "plan" ? <><span>✓ 期望到货时间为空时禁止导入</span><span>✓ 相同汇总键自动合并数量</span><span>✓ 组合产品锁定有效BOM版本</span><span>✓ 新版本双人审批并保留历史</span></> : <><span>✓ 自动匹配最近的未完成采购计划</span><span>✓ 同一SKU允许拆分多个供应商</span><span>✓ 采购偏差按SKU安全范围判断</span><span>✓ 重复单号先展示新旧差异</span></>}</div>
          {importResult && <div className={importResult.startsWith("校验通过") ? "import-result success" : "import-result error"}>{importResult}</div>}
        </section>
      </div>}
      {qualityOpen && <div className="modal-backdrop" role="presentation" onMouseDown={() => setQualityOpen(false)}>
        <section className="import-modal" role="dialog" aria-modal="true" aria-labelledby="quality-title" onMouseDown={e => e.stopPropagation()}>
          <button className="modal-close" aria-label="关闭" onClick={() => setQualityOpen(false)}>×</button>
          <span className="modal-icon">检</span>
          <h2 id="quality-title">设置 SKU 合格率标准</h2>
          <p>未设置专属标准时，系统暂用物料类型默认值并持续提醒供应链同事。</p>
          <div className="quality-form">
            <label>SKU<input defaultValue="SL-CM-09" /></label>
            <label>物料类型<select defaultValue="component"><option value="finished">成品</option><option value="auxiliary">辅料</option><option value="component">配件</option></select></label>
            <label>来料质检合格率<input type="number" min="0" max="100" step=".1" defaultValue="95.0" /><b>%</b></label>
            <label>成品质检合格率<input type="number" min="0" max="100" step=".1" defaultValue="95.0" /><b>%</b></label>
          </div>
          <button className="save-rule" onClick={() => { setQualityOpen(false); toast("SL-CM-09 的专属合格率标准已保存"); }}>保存标准并关闭提醒</button>
        </section>
      </div>}
      {notice && <div className="toast">{notice}</div>}
    </main>
  );
}
