"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Invoice = { id:number; invoiceNo:string; amountTaxIncludedMinor:number; status:string };
type Exception = { id:number; invoiceId:number; exceptionType:string; affectedAmountMinor:number; replacementCoveredAmountMinor:number; refundedAmountMinor:number; replacementDeadline:string; status:string; reason:string };
type Payment = { id:number; paymentRequestId:number; amountMinor:number; paidAt:string; bankReference:string; recordType:string };
type PaymentRequest = { id:number; requestNo:string };
type Data = { invoices:Invoice[]; exceptions:Exception[]; payments:Payment[]; paymentRequests:PaymentRequest[]; replacementLinks:Array<{id:number;invoiceExceptionId:number;replacementInvoiceId:number;coveredAmountMinor:number;status:string}> };

const money = (minor:number) => `¥${(Number(minor || 0) / 100).toLocaleString("zh-CN", { minimumFractionDigits:2 })}`;
const exceptionLabel:Record<string,string> = { red_invoice:"红字发票", voided:"发票作废" };
const statusLabel:Record<string,string> = { awaiting_remediation:"等待补票或退款", risk_warning:"逾期风险预警", resolved:"已闭环" };
const recordLabel:Record<string,string> = { payment:"付款", refund:"退款", reversal:"冲正", correction:"更正" };

async function json(url:string, init?:RequestInit) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `请求失败（${response.status}）`);
  return body;
}

export default function FinanceExceptionWorkspace({ toast }:{ toast:(message:string)=>void }) {
  const [data, setData] = useState<Data>({ invoices:[], exceptions:[], payments:[], paymentRequests:[], replacementLinks:[] });
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => setData(await json("/api/v1/finance")), []);
  useEffect(() => { refresh().catch(error => toast(error.message)); }, [refresh, toast]);

  const invoiceById = useMemo(() => Object.fromEntries(data.invoices.map(row => [row.id, row])), [data.invoices]);
  const verifiedReplacements = data.invoices.filter(row => row.status === "verified");

  async function post(body:Record<string,unknown>, message:string) {
    setBusy(true);
    try {
      await json("/api/finance", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(body) });
      toast(message); await refresh(); return true;
    } catch (error) { toast(error instanceof Error ? error.message : "操作失败"); return false; }
    finally { setBusy(false); }
  }

  async function stepUp(paymentRecordId:number) {
    const request = await json("/api/auth/step-up/request", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ scope:`finance:request_record_correction:${paymentRecordId}` }) });
    const code = window.prompt(request.previewCode ? `本地预览验证码：${request.previewCode}` : `验证码已发送至 ${request.mobile || "绑定手机"}，请输入6位验证码`);
    if (!code) return null;
    await json("/api/auth/step-up/verify", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ challengeNo:request.challengeNo, code }) });
    return request.challengeNo as string;
  }

  async function invalidate(invoice:Invoice) {
    const exceptionType = window.prompt("异常类型：输入 red_invoice（红字）或 voided（作废）", "red_invoice");
    if (!exceptionType) return;
    const replacementDeadline = window.prompt("请输入补票截止日期（YYYY-MM-DD）");
    if (!replacementDeadline) return;
    const reason = window.prompt("请输入红字/作废原因");
    if (!reason) return;
    await post({ action:"invalidate_invoice", invoiceId:invoice.id, exceptionType, replacementDeadline, reason }, "发票异常已登记，相关未付款金额已冻结");
  }

  async function linkReplacement(row:Exception) {
    const choices = verifiedReplacements.filter(invoice => invoice.id !== row.invoiceId).map(invoice => `${invoice.id}: ${invoice.invoiceNo}（${money(invoice.amountTaxIncludedMinor)}）`).join("\n");
    if (!choices) { toast("暂无已完成双重核验的新发票，请先登记并核验补开发票"); return; }
    const replacementInvoiceId = Number(window.prompt(`选择补开发票 ID：\n${choices}`));
    if (!replacementInvoiceId) return;
    const remaining = row.affectedAmountMinor-row.replacementCoveredAmountMinor-row.refundedAmountMinor;
    const amount = Number(window.prompt(`本次补票覆盖金额（元），剩余 ${money(remaining)}`, String(remaining/100)));
    if (!amount) return;
    await post({ action:"link_replacement_invoice", invoiceExceptionId:row.id, replacementInvoiceId, coveredAmountMinor:Math.round(amount*100) }, "补开发票已关联，异常金额已更新");
  }

  async function refund(row:Exception) {
    const requests = data.paymentRequests.map(item => `${item.id}: ${item.requestNo}`).join("\n");
    const paymentRequestId = Number(window.prompt(`选择原请款单 ID：\n${requests}`));
    if (!paymentRequestId) return;
    const remaining = row.affectedAmountMinor-row.replacementCoveredAmountMinor-row.refundedAmountMinor;
    const amount = Number(window.prompt(`本次退款到账金额（元），剩余 ${money(remaining)}`, String(remaining/100)));
    if (!amount) return;
    const receivedAt = window.prompt("退款到账日期（YYYY-MM-DD）", new Date().toISOString().slice(0,10));
    const bankReference = window.prompt("退款银行流水号");
    if (!receivedAt || !bankReference) return;
    await post({ action:"record_refund", invoiceExceptionId:row.id, paymentRequestId, amountMinor:Math.round(amount*100), receivedAt, bankReference }, "退款到账记录已保存");
  }

  async function correct(row:Payment) {
    const reason = window.prompt("请输入更正原因（审批通过后保留原记录并生成冲正/更正记录）");
    if (!reason) return;
    const proposedPaymentRequestId = Number(window.prompt("更正后的请款单 ID", String(row.paymentRequestId)));
    const amount = Number(window.prompt("更正后的金额（元）", String(row.amountMinor/100)));
    const proposedPaidAt = window.prompt("更正后的日期（YYYY-MM-DD）", row.paidAt.slice(0,10));
    const proposedBankReference = window.prompt("更正后的银行流水号", row.bankReference);
    if (!proposedPaymentRequestId || !amount || !proposedPaidAt || !proposedBankReference) return;
    try {
      const challengeNo = await stepUp(row.id);
      if (!challengeNo) return;
      await post({ action:"request_record_correction", paymentRecordId:row.id, reason, proposedPaymentRequestId, proposedAmountMinor:Math.round(amount*100), proposedPaidAt, proposedBankReference, challengeNo }, "更正申请已提交，等待另一位财务同事审批");
    } catch (error) { toast(error instanceof Error ? error.message : "手机验证失败"); }
  }

  return <div className="finance-exception-workspace">
    <section>
      <h3>发票异常闭环</h3>
      <p className="finance-hint">红字或作废后立即冻结尚未支付金额；支持部分补票、部分退款混合处理。</p>
      <div className="finance-list">{data.exceptions.length === 0 && <div className="finance-empty">暂无发票异常</div>}{data.exceptions.map(row => {
        const invoice=invoiceById[row.invoiceId]; const remaining=Math.max(0,row.affectedAmountMinor-row.replacementCoveredAmountMinor-row.refundedAmountMinor);
        return <article key={row.id} className={row.status==="risk_warning"?"exception-risk":""}>
          <div><strong>{invoice?.invoiceNo || `发票 #${row.invoiceId}`} · {exceptionLabel[row.exceptionType] || row.exceptionType}</strong><span className={`finance-status ${row.status}`}>{statusLabel[row.status] || row.status}</span></div>
          <div className="finance-facts"><span>异常金额：{money(row.affectedAmountMinor)}</span><span>已补票：{money(row.replacementCoveredAmountMinor)}</span><span>已退款：{money(row.refundedAmountMinor)}</span><span>待处理：{money(remaining)}</span><span>补票截止：{row.replacementDeadline}</span></div>
          <p>{row.reason}</p>{row.status !== "resolved" && <div className="finance-actions"><button disabled={busy} onClick={()=>linkReplacement(row)}>关联补开发票</button><button disabled={busy} onClick={()=>refund(row)}>登记退款到账</button></div>}
        </article>;
      })}</div>
    </section>
    <section>
      <h3>可登记红字/作废的发票</h3>
      <div className="finance-list">{data.invoices.filter(row=>row.status==="verified").map(row=><article key={row.id}><div><strong>{row.invoiceNo}</strong><span>{money(row.amountTaxIncludedMinor)}</span></div><div className="finance-actions"><button className="danger-button" disabled={busy} onClick={()=>invalidate(row)}>登记红字/作废</button></div></article>)}</div>
    </section>
    <section>
      <h3>付款、退款与冲正记录</h3>
      <p className="finance-hint">更正必须经过手机验证，并由另一位财务同事审批；原始记录永久保留。</p>
      <div className="finance-list">{data.payments.map(row=><article key={row.id}><div><strong>{recordLabel[row.recordType] || row.recordType} #{row.id}</strong><span>{row.paidAt}</span></div><div className="finance-facts"><span>请款单 #{row.paymentRequestId}</span><span>{money(row.amountMinor)}</span><span>流水号：{row.bankReference}</span></div>{["payment","refund"].includes(row.recordType)&&<div className="finance-actions"><button disabled={busy} onClick={()=>correct(row)}>申请更正</button></div>}</article>)}</div>
    </section>
  </div>;
}
