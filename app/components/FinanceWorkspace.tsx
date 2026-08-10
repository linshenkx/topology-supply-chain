"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import FinanceExceptionWorkspace from "./FinanceExceptionWorkspace";
import "../finance.css";

type PaymentRequest = { id:number; requestNo:string; factoryId:number; plannedPaymentDate:string; totalAmountMinor:number; invoiceCoveredAmountMinor:number; status:string };
type Invoice = { id:number; invoiceNo:string; purchaseOrderId:number; amountTaxIncludedMinor:number; expectedAmountMinor:number; amountMatchesExpected:boolean; status:string; issuedAt:string };
type Verification = { id:number; invoiceId:number; verifierRole:string; decision:string; rejectionReason?:string|null };
type Payment = { id:number; paymentRequestId:number; amountMinor:number; paidAt:string; bankReference:string; recordType:string };
type PurchaseOrder = { id:number; orderNo:string; totalTaxIncludedMinor:number };
type FinanceData = { paymentRequests:PaymentRequest[]; invoices:Invoice[]; verifications:Verification[]; payments:Payment[]; purchaseOrders:PurchaseOrder[]; exceptions:Array<{id:number;invoiceId:number;status:string;exceptionType:string;affectedAmountMinor:number}> };

const requestStatus:Record<string,string> = { waiting_invoice:"待发票", generated:"待提交财务", submitted_to_finance:"待付款", partially_paid:"部分付款", paid:"已付清", invoice_exception_frozen:"发票异常冻结", failed:"失败", cancelled:"已取消" };
const invoiceStatus:Record<string,string> = { received:"待核验", verified:"双重核验通过", rejected:"核验不通过", invalidated:"已作废/红冲" };
const money = (minor:number) => `¥${(Number(minor || 0) / 100).toLocaleString("zh-CN", { minimumFractionDigits:2 })}`;

async function requestJson(url:string, init?:RequestInit) {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

export default function FinanceWorkspace({ toast }:{ toast:(message:string)=>void }) {
  const [data, setData] = useState<FinanceData>({ paymentRequests:[], invoices:[], verifications:[], payments:[], purchaseOrders:[], exceptions:[] });
  const [tab, setTab] = useState<"requests"|"invoices"|"payments"|"exceptions">("requests");
  const [busy, setBusy] = useState(false);
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [paying, setPaying] = useState<PaymentRequest|null>(null);
  const [challengeNo, setChallengeNo] = useState("");
  const [smsVerified, setSmsVerified] = useState(false);

  const refresh = useCallback(async () => setData(await requestJson("/api/finance")), []);
  useEffect(() => { refresh().catch(error => toast(error.message)); }, [refresh, toast]);

  const paidByRequest = useMemo(() => data.payments.filter(row => row.recordType === "payment").reduce<Record<number,number>>((map,row) => { map[row.paymentRequestId] = (map[row.paymentRequestId] || 0) + row.amountMinor; return map; }, {}), [data.payments]);
  const summary = useMemo(() => ({
    due: data.paymentRequests.filter(row => !["paid","cancelled"].includes(row.status)).reduce((sum,row) => sum + Math.max(0,row.totalAmountMinor-(paidByRequest[row.id]||0)),0),
    waitingInvoice: data.paymentRequests.filter(row => row.status === "waiting_invoice").length,
    pendingVerify: data.invoices.filter(row => row.status === "received").length,
    frozen: data.paymentRequests.filter(row => row.status === "invoice_exception_frozen").length,
  }), [data, paidByRequest]);

  async function post(body:Record<string,unknown>, success:string) {
    setBusy(true);
    try { await requestJson("/api/finance", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(body) }); toast(success); await refresh(); return true; }
    catch (error) { toast(error instanceof Error ? error.message : "操作失败"); return false; }
    finally { setBusy(false); }
  }

  async function upload(file:File) {
    const form = new FormData(); form.append("file", file); form.append("category", "invoice");
    const result = await requestJson("/api/files", { method:"POST", body:form });
    return result.file.objectKey as string;
  }

  async function createInvoice(event:FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); const file = form.get("file") as File;
    setBusy(true);
    try {
      const fileKey = await upload(file);
      const ok = await post({ action:"create_invoice", factoryId:Number(form.get("factoryId")), purchaseOrderId:Number(form.get("purchaseOrderId")), invoiceNo:form.get("invoiceNo"), invoiceType:form.get("invoiceType"), coverageMode:form.get("coverageMode"), amountTaxIncludedMinor:Math.round(Number(form.get("amount"))*100), taxAmountMinor:Math.round(Number(form.get("taxAmount"))*100), expectedAmountMinor:Math.round(Number(form.get("expectedAmount"))*100), issuedAt:form.get("issuedAt"), fileKey }, "发票已登记，等待供应链与财务双重核验");
      if (ok) { setInvoiceOpen(false); event.currentTarget.reset(); }
    } catch (error) { toast(error instanceof Error ? error.message : "发票登记失败"); setBusy(false); }
  }

  async function verify(invoiceId:number, verifierRole:string, decision:"approved"|"rejected") {
    const rejectionReason = decision === "rejected" ? window.prompt("请输入原因代码：amount_mismatch / title_error / tax_number_error / tax_rate_error / duplicate_invoice / other", "other") : "";
    if (decision === "rejected" && !rejectionReason) return;
    await post({ action:"verify_invoice", invoiceId, verifierRole, decision, rejectionReason }, decision === "approved" ? "发票核验已通过" : "发票已驳回");
  }

  async function requestSms() {
    try { const result = await requestJson("/api/auth/step-up/request", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ deviceId:"finance-payment" }) }); setChallengeNo(result.challengeNo); toast(`验证码已发送至 ${result.mobile || "绑定手机"}`); }
    catch (error) { toast(error instanceof Error ? error.message : "验证码发送失败"); }
  }
  async function verifySms(code:string) {
    try { await requestJson("/api/auth/step-up/verify", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ challengeNo, code }) }); setSmsVerified(true); toast("手机验证码验证成功"); }
    catch (error) { toast(error instanceof Error ? error.message : "验证码错误"); }
  }
  async function recordPayment(event:FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!paying || !smsVerified) { toast("请先完成手机验证码验证"); return; }
    const form = new FormData(event.currentTarget);
    const ok = await post({ action:"record_payment", paymentRequestId:paying.id, amountMinor:Math.round(Number(form.get("amount"))*100), paidAt:form.get("paidAt"), bankReference:form.get("bankReference"), smsVerified:true }, "付款记录已保存");
    if (ok) { setPaying(null); setChallengeNo(""); setSmsVerified(false); }
  }

  return <section className="finance-workspace">
    <div className="finance-summary">
      <article><span>待付余额</span><strong>{money(summary.due)}</strong></article><article><span>待发票请款</span><strong>{summary.waitingInvoice}</strong></article><article><span>待双重核验</span><strong>{summary.pendingVerify}</strong></article><article className={summary.frozen ? "danger" : ""}><span>异常冻结</span><strong>{summary.frozen}</strong></article>
    </div>
    <div className="workspace-tabs"><button className={tab==="requests"?"active":""} onClick={()=>setTab("requests")}>请款单</button><button className={tab==="invoices"?"active":""} onClick={()=>setTab("invoices")}>发票核验</button><button className={tab==="payments"?"active":""} onClick={()=>setTab("payments")}>付款流水</button><button className={tab==="exceptions"?"active":""} onClick={()=>setTab("exceptions")}>异常闭环</button></div>
    {tab === "requests" && <div className="finance-list">{data.paymentRequests.map(row => { const paid=paidByRequest[row.id]||0; return <article key={row.id}><div><strong>{row.requestNo}</strong><span className={`finance-status ${row.status}`}>{requestStatus[row.status]||row.status}</span></div><div className="finance-facts"><span>计划付款：{row.plannedPaymentDate}</span><span>请款：{money(row.totalAmountMinor)}</span><span>发票覆盖：{money(row.invoiceCoveredAmountMinor)}</span><span>已付：{money(paid)}</span><span>待付：{money(row.totalAmountMinor-paid)}</span></div>{!["paid","cancelled","invoice_exception_frozen"].includes(row.status) && <button className="primary" disabled={busy||row.invoiceCoveredAmountMinor<row.totalAmountMinor} onClick={()=>{setPaying(row);setSmsVerified(false);setChallengeNo("");}}>登记付款</button>}</article>; })}</div>}
    {tab === "invoices" && <><button className="primary finance-add" onClick={()=>setInvoiceOpen(true)}>＋ 登记发票</button><div className="finance-list">{data.invoices.map(row => { const checks=data.verifications.filter(v=>v.invoiceId===row.id); return <article key={row.id}><div><strong>{row.invoiceNo}</strong><span className={`finance-status ${row.status}`}>{invoiceStatus[row.status]||row.status}</span></div><div className="finance-facts"><span>采购单 #{row.purchaseOrderId}</span><span>发票金额：{money(row.amountTaxIncludedMinor)}</span><span>应开：{money(row.expectedAmountMinor)}</span><span>{row.amountMatchesExpected?"金额一致":"金额不一致，禁止通过"}</span></div><div className="verification-row"><span>供应链：{checks.find(v=>v.verifierRole==="supply_chain")?.decision||"待核验"}</span><span>财务：{checks.find(v=>v.verifierRole==="finance")?.decision||"待核验"}</span></div>{row.status==="received" && <div className="finance-actions"><button disabled={busy||!row.amountMatchesExpected} onClick={()=>verify(row.id,"supply_chain","approved")}>供应链通过</button><button disabled={busy||!row.amountMatchesExpected} onClick={()=>verify(row.id,"finance","approved")}>财务通过</button><button className="danger-button" disabled={busy} onClick={()=>verify(row.id,"finance","rejected")}>驳回</button></div>}</article>; })}</div></>}
    {tab === "payments" && <div className="finance-list">{data.payments.map(row=><article key={row.id}><div><strong>{row.recordType==="refund"?"退款":"付款"} #{row.id}</strong><span>{row.paidAt}</span></div><div className="finance-facts"><span>请款单 #{row.paymentRequestId}</span><span>{money(row.amountMinor)}</span><span>银行流水：{row.bankReference}</span></div></article>)}</div>}
    {tab === "exceptions" && <FinanceExceptionWorkspace toast={toast} />}
    {invoiceOpen && <div className="finance-dialog"><form onSubmit={createInvoice}><h3>登记增值税发票</h3><label>组装工厂 ID<input name="factoryId" type="number" required /></label><label>采购单<select name="purchaseOrderId" required>{data.purchaseOrders.map(row=><option value={row.id} key={row.id}>{row.orderNo} · {money(row.totalTaxIncludedMinor)}</option>)}</select></label><label>发票号码<input name="invoiceNo" required /></label><div className="finance-grid"><label>发票类型<select name="invoiceType"><option value="vat_special">增值税专用发票</option><option value="vat_general">增值税普通发票</option></select></label><label>覆盖方式<select name="coverageMode"><option value="full_order">整张采购单</option><option value="delivery_batch">分批发货</option></select></label><label>含税金额（元）<input name="amount" type="number" step="0.01" required /></label><label>税额（元）<input name="taxAmount" type="number" step="0.01" required /></label><label>分批应开金额（元）<input name="expectedAmount" type="number" step="0.01" /></label><label>开票日期<input name="issuedAt" type="date" required /></label></div><label>发票文件<input name="file" type="file" accept="image/*,.pdf" required /></label><div className="finance-actions"><button type="button" onClick={()=>setInvoiceOpen(false)}>取消</button><button className="primary" disabled={busy}>保存</button></div></form></div>}
    {paying && <div className="finance-dialog"><form onSubmit={recordPayment}><h3>登记付款 · {paying.requestNo}</h3><p>待付 {money(paying.totalAmountMinor-(paidByRequest[paying.id]||0))}，允许分多次付款。</p><label>本次付款金额（元）<input name="amount" type="number" step="0.01" required /></label><label>付款日期<input name="paidAt" type="date" required /></label><label>银行流水号<input name="bankReference" required /></label><div className="sms-step"><button type="button" onClick={requestSms}>{challengeNo?"重新发送":"发送手机验证码"}</button>{challengeNo && !smsVerified && <><input id="finance-sms-code" placeholder="6位验证码" maxLength={6}/><button type="button" onClick={()=>verifySms((document.getElementById("finance-sms-code") as HTMLInputElement)?.value||"")}>验证</button></>}{smsVerified&&<strong>✓ 已验证</strong>}</div><div className="finance-actions"><button type="button" onClick={()=>setPaying(null)}>取消</button><button className="primary" disabled={busy||!smsVerified}>确认登记付款</button></div></form></div>}
  </section>;
}
