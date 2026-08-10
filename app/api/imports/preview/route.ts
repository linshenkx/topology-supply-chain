import * as XLSX from "xlsx";
import { accessErrorResponse, requireAccess, requireRole } from "../../../lib/authz";

type ImportType = "supplier" | "purchase_plan" | "purchase_order" | "sku" | "opening_inventory";
type Row = Record<string, unknown>;

const text = (row: Row, names: string[]) => {
  for (const name of names) {
    const value = row[name];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return "";
};

export async function POST(request: Request) {
  try {
    const access = await requireAccess(request);
    requireRole(access, ["admin", "supply_chain"]);
    const form = await request.formData();
    const file = form.get("file");
    const type = form.get("type") as ImportType | null;
    if (!(file instanceof File) || !type) return Response.json({ error: "请选择文件和导入类型。" }, { status: 400 });
    if (file.size > 20 * 1024 * 1024) return Response.json({ error: "单个文件不能超过20MB。" }, { status: 413 });
    if (!/\.(xlsx|xls)$/i.test(file.name)) return Response.json({ error: "仅支持.xlsx或.xls文件。" }, { status: 400 });

    const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
    const errors: Array<{ sheet: string; row: number; field: string; message: string }> = [];
    const warnings: Array<{ sheet: string; row: number; message: string }> = [];
    const normalized: Row[] = [];

    if (type === "purchase_order") {
      for (const required of ["单据信息", "产品信息"]) if (!workbook.SheetNames.includes(required)) errors.push({ sheet: required, row: 0, field: "工作表", message: `缺少工作表“${required}”` });
      if (!errors.length) {
        const rows = XLSX.utils.sheet_to_json<Row>(workbook.Sheets["产品信息"], { defval: "" });
        rows.forEach((row, index) => {
          const sku = text(row, ["SKU", "MSKU", "商品SKU", "本地SKU"]);
          const quantity = Number(text(row, ["采购数量", "数量", "下单数量"]));
          if (!sku) errors.push({ sheet: "产品信息", row: index + 2, field: "SKU", message: "SKU不能为空" });
          if (!Number.isFinite(quantity) || quantity <= 0) errors.push({ sheet: "产品信息", row: index + 2, field: "采购数量", message: "采购数量必须大于0" });
          normalized.push({ sourceRow: index + 2, sku, quantity, productName: text(row, ["品名", "产品名称", "商品名称"]), expectedArrivalDate: text(row, ["期望到货时间", "交货日期"]) });
        });
      }
    } else {
      const sheetName = workbook.SheetNames[0];
      const rows = XLSX.utils.sheet_to_json<Row>(workbook.Sheets[sheetName], { defval: "" });
      rows.forEach((row, index) => {
        if (type === "supplier") {
          const code = text(row, ["供应商代码"]);
          const name = text(row, ["供应商名称"]);
          if (!code) errors.push({ sheet: sheetName, row: index + 2, field: "供应商代码", message: "供应商代码不能为空" });
          if (!name) errors.push({ sheet: sheetName, row: index + 2, field: "供应商名称", message: "供应商名称不能为空" });
          if (!text(row, ["联系人"]) || !text(row, ["联系方式"])) warnings.push({ sheet: sheetName, row: index + 2, message: "联系人或电话缺失，正式启用前必须补充" });
          normalized.push({ sourceRow: index + 2, code, name, creditCode: text(row, ["统一社会信用代码"]), address: text(row, ["地址"]), tier: "", managedByFactoryId: "" });
        }
        if (type === "purchase_plan") {
          const expectedArrivalDate = text(row, ["期望到货时间"]);
          const sku = text(row, ["SKU", "MSKU", "商品SKU"]);
          if (!expectedArrivalDate) errors.push({ sheet: sheetName, row: index + 2, field: "期望到货时间", message: "期望到货时间不能为空" });
          normalized.push({ sourceRow: index + 2, planNo: text(row, ["计划编号", "采购计划编号"]), expectedArrivalDate, sku, quantity: Number(text(row, ["计划数量", "采购数量", "数量"])), isCombinationMain: text(row, ["是否组合产品"]) === "是", rawExpandedItem: text(row, ["是否组合产品"]) !== "是" });
        }
        if (type === "sku") {
          const sku = text(row, ["SKU", "MSKU", "本地SKU"]);
          if (!sku) errors.push({ sheet: sheetName, row: index + 2, field: "SKU", message: "SKU不能为空" });
          normalized.push({ sourceRow: index + 2, sku, name: text(row, ["品名", "产品名称", "商品名称"]), itemType: "", stockUnit: "" });
        }
        if (type === "opening_inventory") {
          const sku = text(row, ["SKU", "MSKU"]);
          const warehouse = text(row, ["仓库", "仓库名称"]);
          if (!sku || !warehouse) errors.push({ sheet: sheetName, row: index + 2, field: "SKU/仓库", message: "SKU和仓库不能为空" });
          normalized.push({ sourceRow: index + 2, sku, warehouse, available: "", locked: "", defective: "", pendingInspection: "", referenceQuantity: Number(text(row, ["库存数量", "可用库存"])) || 0 });
        }
      });
    }

    const fingerprint = `${file.name}:${file.size}:${file.lastModified}:${workbook.SheetNames.join("|")}`;
    return Response.json({
      type, fileName: file.name, sheets: workbook.SheetNames, fingerprint,
      summary: { totalRows: normalized.length, validRows: Math.max(0, normalized.length - new Set(errors.map(error => `${error.sheet}:${error.row}`)).size), errorCount: errors.length, warningCount: warnings.length },
      canCommit: errors.length === 0, rows: normalized.slice(0, 500), errors, warnings,
      permissionScope: { userId: access.userId, roles: access.roles },
    });
  } catch (error) {
    return accessErrorResponse(error);
  }
}
