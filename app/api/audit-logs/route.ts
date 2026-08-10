import { and, desc, eq, gte, like, lt, lte, or, sql } from "drizzle-orm";
import * as XLSX from "xlsx";
import { getDb } from "../../../db";
import { auditLogs, users } from "../../../db/schema";
import { accessErrorResponse, requireAccess, requireRole } from "../../lib/authz";
import { writeAudit } from "../../lib/audit";

const selected={id:auditLogs.id,actorUserId:auditLogs.actorUserId,actorName:users.name,actorEmail:users.email,action:auditLogs.action,module:auditLogs.module,entityType:auditLogs.entityType,entityId:auditLogs.entityId,businessNo:auditLogs.businessNo,ipAddress:auditLogs.ipAddress,deviceId:auditLogs.deviceId,sensitiveView:auditLogs.sensitiveView,exported:auditLogs.exported,createdAt:auditLogs.createdAt,archiveAfter:auditLogs.archiveAfter};

export async function GET(request:Request){
  try{
    const access=await requireAccess(request);requireRole(access,["admin"]);const url=new URL(request.url);const p=url.searchParams;
    const keyword=p.get("keyword")?.trim();const actor=p.get("actor")?.trim();const archiveScope=p.get("archiveScope")||"active";const nowIso=new Date().toISOString();
    const conditions=[
      actor?or(like(users.name,`%${actor}%`),like(users.email,`%${actor}%`)):undefined,
      p.get("module")?eq(auditLogs.module,p.get("module")!):undefined,p.get("action")?like(auditLogs.action,`%${p.get("action")!}%`):undefined,p.get("businessNo")?like(auditLogs.businessNo,`%${p.get("businessNo")!}%`):undefined,
      p.get("dateFrom")?gte(auditLogs.createdAt,`${p.get("dateFrom")} 00:00:00`):undefined,p.get("dateTo")?lte(auditLogs.createdAt,`${p.get("dateTo")} 23:59:59`):undefined,
      p.get("sensitive")?eq(auditLogs.sensitiveView,p.get("sensitive")==="true"):undefined,p.get("exported")?eq(auditLogs.exported,p.get("exported")==="true"):undefined,
      archiveScope==="active"?gte(auditLogs.archiveAfter,nowIso):undefined,archiveScope==="archived"?lt(auditLogs.archiveAfter,nowIso):undefined,
      keyword?or(like(users.name,`%${keyword}%`),like(users.email,`%${keyword}%`),like(auditLogs.action,`%${keyword}%`),like(auditLogs.entityType,`%${keyword}%`),like(auditLogs.entityId,`%${keyword}%`),like(auditLogs.businessNo,`%${keyword}%`)):undefined,
    ].filter(Boolean);const where=conditions.length?and(...conditions):undefined;const db=getDb();
    if(p.get("export")==="xlsx"){
      const rows=await db.select(selected).from(auditLogs).leftJoin(users,eq(users.id,auditLogs.actorUserId)).where(where).orderBy(desc(auditLogs.createdAt)).limit(5000);
      const now=new Date();const watermark=`导出人：${access.name}（${access.email}）｜导出时间：${now.toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"})}`;const book=XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([["广州拓扑睡眠科技有限公司 SCM 操作日志"],[watermark],["筛选条件",JSON.stringify(Object.fromEntries(p.entries()))],["说明","文件包含敏感审计信息，仅限授权人员使用。"]]),"导出说明");
      XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet(rows.map(row=>({操作时间:row.createdAt,操作人:row.actorName||"账号已停用",操作人邮箱:row.actorEmail||"",模块:row.module,操作:row.action,业务单号:row.businessNo||"",对象类型:row.entityType,对象编号:row.entityId,敏感查看:row.sensitiveView?"是":"否",导出操作:row.exported?"是":"否",IP地址:row.ipAddress||"",设备编号:row.deviceId||"",归档日期:row.archiveAfter,水印:watermark}))),"操作日志");
      await writeAudit(access,{action:"export_audit_logs",module:"系统管理",entityType:"audit_log",entityId:now.getTime(),exported:true,sensitiveView:true,after:{count:rows.length},request});
      const bytes=XLSX.write(book,{type:"buffer",bookType:"xlsx"});return new Response(new Uint8Array(bytes),{headers:{"Content-Type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","Content-Disposition":`attachment; filename="topology-audit-logs-${now.toISOString().replace(/[-:TZ.]/g,"").slice(0,14)}.xlsx"`,"Cache-Control":"no-store"}});
    }
    if(access.localPreview)return Response.json({logs:[],total:0,page:1,pageSize:20});const page=Math.max(1,Number(p.get("page"))||1);const pageSize=Math.min(100,Math.max(10,Number(p.get("pageSize"))||20));
    const [rows,countRows]=await Promise.all([db.select(selected).from(auditLogs).leftJoin(users,eq(users.id,auditLogs.actorUserId)).where(where).orderBy(desc(auditLogs.createdAt)).limit(pageSize).offset((page-1)*pageSize),db.select({count:sql<number>`count(*)`}).from(auditLogs).leftJoin(users,eq(users.id,auditLogs.actorUserId)).where(where)]);
    await writeAudit(access,{action:"view_audit_logs",module:"系统管理",entityType:"audit_log",entityId:"list",sensitiveView:true,after:{page,filters:Object.fromEntries(p.entries())},request});return Response.json({logs:rows,total:Number(countRows[0]?.count??0),page,pageSize});
  }catch(error){return accessErrorResponse(error);}
}
