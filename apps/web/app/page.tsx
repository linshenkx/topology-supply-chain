"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import "./shipping.css";
import "./audit.css";
import "./performance.css";
import PurchaseWorkspace from "./components/PurchaseWorkspace";
import ProductionWorkspace from "./components/ProductionWorkspace";
import QualityWorkspace from "./components/QualityWorkspace";
import InventoryWorkspace from "./components/InventoryWorkspace";
import MasterDataWorkspace from "./components/MasterDataWorkspace";
import SupplierWorkspace from "./components/SupplierWorkspace";
import ShippingWorkspace from "./components/ShippingWorkspace";
import FinanceWorkspace from "./components/FinanceWorkspace";
import AuditWorkspace from "./components/AuditWorkspace";
import { finalRequestDigest, mutateJson, uploadPlatformFile } from "./lib/mutation-client";
import { supplyImports } from "./lib/supply-mutation-client";

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

const nav = ["工作台", "采购管理", "供应商管理", "执行单", "物料与补料", "生产质检", "发货管理", "库存管理", "工厂协同", "财务结算", "审批中心", "系统管理"];

function InventoryPanel({ toast }: { toast: (message: string) => void }) {
  return <InventoryWorkspace toast={toast} />;
}

function UnconfiguredPanel({ title, description }: { title: string; description: string }) {
  return <section className="panel empty-state"><h2>{title}</h2><p>{description}</p></section>;
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
  const initialRequestFailed = useEffectEvent((error: unknown) => toast(error instanceof Error ? error.message : "用户列表加载失败"));
  useEffect(() => {
    const controller = new AbortController();
    void apiJson("/api/v1/users", { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setUsers(data.users ?? []); })
      .catch(error => { if (!controller.signal.aborted) initialRequestFailed(error); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

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
  const initialRequestFailed = useEffectEvent((error: unknown) => toast(error instanceof Error ? error.message : "审批列表加载失败"));
  useEffect(() => {
    const controller = new AbortController();
    void apiJson("/api/v1/approvals", { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setItems(data.approvals ?? []); })
      .catch(error => { if (!controller.signal.aborted) initialRequestFailed(error); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

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

function LoginScreen({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [challengeNo, setChallengeNo] = useState("");
  const [code, setCode] = useState("");
  const [maskedMobile, setMaskedMobile] = useState("");
  const [message, setMessage] = useState("");
  const deviceId = useRef("");
  useEffect(() => {
    const existing = window.localStorage.getItem("topology_device_id");
    if (existing) { deviceId.current = existing; return; }
    const created = crypto.randomUUID();
    window.localStorage.setItem("topology_device_id", created);
    deviceId.current = created;
  }, []);
  const login = async () => {
    setMessage("正在验证…");
    let payload: { authenticated:boolean; challengeNo?:string; maskedMobile?:string; previewCode?:string };
    try { payload = await mutateJson("/api/v1/auth/login", "POST", { account, password, deviceId: deviceId.current, deviceName: navigator.userAgent.slice(0, 80) }, { csrf:false }); }
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
  const [notice, setNotice] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [importKind, setImportKind] = useState<"plan" | "order">("order");
  const [importResult, setImportResult] = useState("");
  const [sessionName, setSessionName] = useState("陈文超");
  const [sessionUserId, setSessionUserId] = useState(0);
  const [sessionRole, setSessionRole] = useState("供应链管理员");
  const [sessionRoles, setSessionRoles] = useState<string[]>([]);
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
      const XLSX = await import("xlsx");
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
      const sheets = workbook.SheetNames.map(name => ({
        name,
        rows: XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[name]!, { defval: "" })
          .filter(row => Object.values(row).some(Boolean)),
      }));
      const fingerprint = `${file.name}:${file.size}:${file.lastModified}:${workbook.SheetNames.join("|")}`;
      const type = importKind === "plan" ? "purchase_plan" : "purchase_order";
      const preview = await supplyImports.preview<ImportPreview>({ type, fileName: file.name, fingerprint, sheets });
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
      const staged = await supplyImports.stage<ImportStage>({
        type: preview.type,
        fileObjectId: uploaded.file.id,
        fileName: preview.fileName,
        fingerprint: preview.fingerprint,
        rows: preview.rows,
        errors: preview.errors,
        warnings: preview.warnings,
      });
      const committed = await supplyImports.commit<ImportCommit>({ batchId: staged.batch.id });
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
        <nav>{nav.map((item, i) => <button key={item} className={active === item ? "active" : ""} onClick={() => { setActive(item); }}><span>{["⌂","▤","♙","◫","◇","◎","↗","▦","♧","¥","✓","⚙"][i]}</span>{item}</button>)}</nav>
        <div className="profile"><i>{sessionName.slice(0,1)}</i><div><strong>{sessionName}</strong><small>{sessionRole}</small></div><span>•••</span></div>
      </aside>

      <section className="content">
        <header><div><h1>{active === "工作台" ? `早上好，${sessionName}` : active}</h1></div><div className="header-actions"><button className="primary" onClick={() => { setImportKind("order"); setImportResult(""); setImportOpen(true); }}>＋ 导入领星采购单</button></div></header>

        {active === "供应商管理" ? <SupplierWorkspace toast={toast} /> : active === "采购管理" ? <PurchaseWorkspace toast={toast} openImport={kind => { setImportKind(kind); setImportResult(""); setImportOpen(true); }} /> : active === "物料与补料" ? <MasterDataWorkspace toast={toast} /> : active === "执行单" ? <ProductionWorkspace toast={toast} /> : active === "生产质检" ? <QualityWorkspace toast={toast} /> : active === "库存管理" ? <InventoryPanel toast={toast} /> : active === "发货管理" ? <ShippingWorkspace toast={toast} roles={sessionRoles} /> : active === "工厂协同" ? <UnconfiguredPanel title="工厂协同尚未配置" description="尚未接入可显示的协同任务、风险或绩效数据。" /> : active === "审批中心" ? <ApprovalCenterPanel toast={toast} /> : active === "系统管理" ? <SystemManagementPanel toast={toast} /> : active === "财务结算" ? <FinanceWorkspace toast={toast} /> : <UnconfiguredPanel title="工作台尚未配置" description="尚未接入可显示的订单、任务、风险、趋势或库存汇总数据。" />}
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
      {notice && <div className="toast">{notice}</div>}
    </main>
  );
}
