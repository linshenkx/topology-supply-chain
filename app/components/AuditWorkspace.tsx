"use client";
import { useEffect, useState } from "react";

type LogRow = { id:number; actorName:string|null; actorEmail:string|null; action:string; module:string; entityType:string; entityId:string; businessNo:string|null; ipAddress:string|null; deviceId:string|null; sensitiveView:boolean; exported:boolean; createdAt:string; archiveAfter:string };
const modules = ["系统管理","采购计划","采购订单","供应商","库存","质检","发货","财务","审批","生产","盘点"];

export default function AuditWorkspace({ toast }: { toast:(message:string)=>void }) {
  const [filters,setFilters]=useState({actor:"",module:"",action:"",businessNo:"",dateFrom:"",dateTo:"",sensitive:"",exported:"",archiveScope:"active"});
  const [logs,setLogs]=useState<LogRow[]>([]); const [page,setPage]=useState(1); const [total,setTotal]=useState(0); const [loading,setLoading]=useState(false);
  const params=(targetPage=page)=>{const p=new URLSearchParams({page:String(targetPage),pageSize:"20"});Object.entries(filters).forEach(([k,v])=>v&&p.set(k,v));return p;};
  const load=async(targetPage=page)=>{setLoading(true);try{const response=await fetch(`/api/audit-logs?${params(targetPage)}`,{cache:"no-store"});const data=await response.json();if(!response.ok)throw new Error(data.error||"日志加载失败");setLogs(data.logs||[]);setTotal(data.total||0);setPage(targetPage);}catch(error){toast(error instanceof Error?error.message:"日志加载失败");}finally{setLoading(false);}};
  useEffect(()=>{void load(1);},[]);
  const exportFile=async()=>{try{const response=await fetch(`/api/audit-logs?${params(1)}&export=xlsx`);if(!response.ok){const data=await response.json();throw new Error(data.error||"导出失败");}const blob=await response.blob();const url=URL.createObjectURL(blob);const link=document.createElement("a");link.href=url;link.download=response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1]||"topology-audit-logs.xlsx";link.click();URL.revokeObjectURL(url);toast("操作日志已导出，文件已添加导出人和导出时间水印");}catch(error){toast(error instanceof Error?error.message:"导出失败");}};
  const update=(key:string,value:string)=>setFilters(previous=>({...previous,[key]:value})); const pages=Math.max(1,Math.ceil(total/20));
  return <article className="panel audit-center">
    <div className="audit-head"><div><h3>操作日志审计中心</h3><p>日志在线保留5年，到期后自动进入归档视图，不会自动删除；敏感查看和导出也会留痕。</p></div><button className="primary" onClick={()=>void exportFile()}>导出带水印 Excel</button></div>
    <div className="audit-filters">
      <input placeholder="操作人姓名或邮箱" value={filters.actor} onChange={e=>update("actor",e.target.value)}/>
      <select value={filters.module} onChange={e=>update("module",e.target.value)}><option value="">全部模块</option>{modules.map(x=><option key={x}>{x}</option>)}</select>
      <input placeholder="操作类型" value={filters.action} onChange={e=>update("action",e.target.value)}/><input placeholder="业务单号" value={filters.businessNo} onChange={e=>update("businessNo",e.target.value)}/>
      <input type="date" value={filters.dateFrom} onChange={e=>update("dateFrom",e.target.value)}/><input type="date" value={filters.dateTo} onChange={e=>update("dateTo",e.target.value)}/>
      <select value={filters.sensitive} onChange={e=>update("sensitive",e.target.value)}><option value="">全部敏感状态</option><option value="true">敏感查看</option><option value="false">普通操作</option></select>
      <select value={filters.exported} onChange={e=>update("exported",e.target.value)}><option value="">全部导出状态</option><option value="true">导出操作</option><option value="false">非导出</option></select>
      <select value={filters.archiveScope} onChange={e=>update("archiveScope",e.target.value)}><option value="active">在线日志（5年内）</option><option value="archived">归档日志（满5年）</option><option value="all">全部日志</option></select>
      <button onClick={()=>void load(1)}>{loading?"查询中…":"查询"}</button>
    </div>
    <div className="audit-table"><div className="audit-row audit-title"><span>时间 / 人员</span><span>模块 / 操作</span><span>业务与对象</span><span>安全标记</span><span>来源</span></div>
      {logs.map(x=><div className="audit-row" key={x.id}><span><strong>{x.createdAt}</strong><small>{x.actorName||"账号已停用"} · {x.actorEmail||"—"}</small></span><span><strong>{x.module}</strong><small>{x.action}</small></span><span><strong>{x.businessNo||"—"}</strong><small>{x.entityType} #{x.entityId}</small></span><span><b className={x.sensitiveView?"audit-risk":""}>{x.sensitiveView?"敏感查看":"普通"}</b>{x.exported&&<b className="audit-export">导出</b>}</span><span><strong>{x.ipAddress||"—"}</strong><small>{x.deviceId||"未记录设备"}</small></span></div>)}
      {!loading&&!logs.length&&<div className="audit-empty">暂无符合条件的操作日志</div>}
    </div>
    <div className="audit-pages"><span>共 {total} 条，第 {page} / {pages} 页</span><button disabled={page<=1} onClick={()=>void load(page-1)}>上一页</button><button disabled={page>=pages} onClick={()=>void load(page+1)}>下一页</button></div>
  </article>;
}
