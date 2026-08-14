import type { FastifyRequest } from "fastify";

import type { AccessContext } from "../auth/index.js";
import type { DomainRegistrationContext } from "../../platform/registrations.js";
import { executeSupplyCommand } from "../../platform/supply-command.js";
import { approvalNotification, createApproval } from "../approvals/support.js";
import { requireFile } from "../files/support.js";
import {
  audit,
  bad,
  conflict,
  domainEvent,
  forbidden,
  insertId,
  jsonValue,
  isInternal,
  missing,
  objectBody,
  positiveInteger,
  text,
  type DataRow,
} from "../../platform/supply-support.js";

type ImportType = "supplier" | "purchase_plan" | "purchase_order" | "sku" | "opening_inventory";
const IMPORT_TYPES = new Set<ImportType>(["supplier", "purchase_plan", "purchase_order", "sku", "opening_inventory"]);
const MAX_ROWS = 20_000;

interface SheetInput {
  name: string;
  rows: Record<string, unknown>[];
}

function cell(row: Record<string, unknown>, names: readonly string[]): string {
  for (const name of names) {
    const value = row[name];
    if (value !== undefined && value !== null && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

function importType(value: unknown): ImportType {
  const result = text(value, 50) as ImportType;
  if (!IMPORT_TYPES.has(result)) return bad("Unsupported import type");
  return result;
}

function sheets(value: unknown): SheetInput[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) return bad("Workbook sheets required");
  let total = 0;
  return value.map((candidate) => {
    const input = objectBody(candidate);
    const name = text(input.name, 100);
    if (!Array.isArray(input.rows)) return bad("Sheet rows required");
    total += input.rows.length;
    if (total > MAX_ROWS) return bad("Import row limit exceeded");
    return { name, rows: input.rows.map(objectBody) };
  });
}

function normalizeWorkbook(type: ImportType, workbook: SheetInput[]) {
  const errors: Array<{ field: string; message: string; row: number; sheet: string }> = [];
  const warnings: Array<{ message: string; row: number; sheet: string }> = [];
  const normalized: Record<string, unknown>[] = [];
  const push = (sheet: string, sourceRow: number, value: Record<string, unknown>) => {
    normalized.push({ sheetName: sheet, sourceRow, ...value });
  };

  if (type === "purchase_order") {
    const information = workbook.find((sheet) => sheet.name === "单据信息");
    const products = workbook.find((sheet) => sheet.name === "产品信息");
    if (information === undefined) errors.push({ sheet: "单据信息", row: 0, field: "工作表", message: "缺少工作表“单据信息”" });
    if (products === undefined) errors.push({ sheet: "产品信息", row: 0, field: "工作表", message: "缺少工作表“产品信息”" });
    if (products !== undefined) products.rows.forEach((row, index) => {
      const sourceRow = index + 2;
      const sku = cell(row, ["SKU", "MSKU", "商品SKU", "本地SKU"]);
      const quantity = Number(cell(row, ["采购数量", "数量", "下单数量"]));
      if (!sku) errors.push({ sheet: products.name, row: sourceRow, field: "SKU", message: "SKU不能为空" });
      if (!Number.isFinite(quantity) || quantity <= 0) errors.push({ sheet: products.name, row: sourceRow, field: "采购数量", message: "采购数量必须大于0" });
      push(products.name, sourceRow, { sku, quantity, productName: cell(row, ["品名", "产品名称", "商品名称"]), expectedArrivalDate: cell(row, ["期望到货时间", "交货日期"]) });
    });
  } else {
    const sheet = workbook[0]!;
    sheet.rows.forEach((row, index) => {
      const sourceRow = index + 2;
      if (type === "supplier") {
        const code = cell(row, ["供应商代码"]);
        const name = cell(row, ["供应商名称"]);
        if (!code) errors.push({ sheet: sheet.name, row: sourceRow, field: "供应商代码", message: "供应商代码不能为空" });
        if (!name) errors.push({ sheet: sheet.name, row: sourceRow, field: "供应商名称", message: "供应商名称不能为空" });
        if (!cell(row, ["联系人"]) || !cell(row, ["联系方式"])) warnings.push({ sheet: sheet.name, row: sourceRow, message: "联系人或电话缺失，正式启用前必须补充" });
        push(sheet.name, sourceRow, { code, name, creditCode: cell(row, ["统一社会信用代码"]), address: cell(row, ["地址"]), tier: "", managedByFactoryId: "" });
      } else if (type === "purchase_plan") {
        const expectedArrivalDate = cell(row, ["期望到货时间"]);
        if (!expectedArrivalDate) errors.push({ sheet: sheet.name, row: sourceRow, field: "期望到货时间", message: "期望到货时间不能为空" });
        push(sheet.name, sourceRow, { expectedArrivalDate, sku: cell(row, ["SKU", "MSKU", "商品SKU"]), quantity: Number(cell(row, ["计划数量", "采购数量", "数量"])), planNo: cell(row, ["计划编号", "采购计划编号"]), isCombinationMain: cell(row, ["是否组合产品"]) === "是", rawExpandedItem: cell(row, ["是否组合产品"]) !== "是" });
      } else if (type === "sku") {
        const sku = cell(row, ["SKU", "MSKU", "本地SKU"]);
        if (!sku) errors.push({ sheet: sheet.name, row: sourceRow, field: "SKU", message: "SKU不能为空" });
        push(sheet.name, sourceRow, { sku, name: cell(row, ["品名", "产品名称", "商品名称"]), itemType: "", stockUnit: "" });
      } else {
        const sku = cell(row, ["SKU", "MSKU"]);
        const warehouse = cell(row, ["仓库", "仓库名称"]);
        if (!sku || !warehouse) errors.push({ sheet: sheet.name, row: sourceRow, field: "SKU/仓库", message: "SKU和仓库不能为空" });
        push(sheet.name, sourceRow, { sku, warehouse, available: "", locked: "", defective: "", pendingInspection: "", referenceQuantity: Number(cell(row, ["库存数量", "可用库存"])) || 0 });
      }
    });
  }
  const invalidRows = new Set(errors.map((error) => `${error.sheet}:${error.row}`)).size;
  return {
    canCommit: errors.length === 0,
    errors,
    rows: normalized.slice(0, 500),
    summary: { totalRows: normalized.length, validRows: Math.max(0, normalized.length - invalidRows), errorCount: errors.length, warningCount: warnings.length },
    warnings,
  };
}

export async function previewImport(
  context: DomainRegistrationContext,
  request: FastifyRequest,
  access: AccessContext,
  raw: unknown,
) {
  if (!isInternal(access)) return forbidden();
  const body = objectBody(raw);
  const type = importType(body.type);
  const fileName = text(body.fileName, 255);
  const fingerprint = text(body.fingerprint, 1_000);
  const workbook = sheets(body.sheets);
  const preview = normalizeWorkbook(type, workbook);
  return executeSupplyCommand({
    actorScope: `user:${access.userId}`,
    command: "imports.preview",
    context,
    payload: jsonValue(body),
    request,
    responseStatus: 200,
    run: async ({ transaction }) => {
      await audit(transaction, request, access, {
        action: "preview_import", module: "imports", entityType: "import_preview",
        entityId: fingerprint, after: { type, fileName, summary: preview.summary },
      });
      return { type, fileName, fingerprint, sheets: workbook.map((sheet) => sheet.name), ...preview, permissionScope: { userId: access.userId, roles: access.roles } };
    },
  });
}

export async function stageImport(
  context: DomainRegistrationContext,
  request: FastifyRequest,
  access: AccessContext,
  raw: unknown,
) {
  if (!isInternal(access)) return forbidden();
  const body = objectBody(raw);
  const type = importType(body.type);
  const fileObjectId = positiveInteger(body.fileObjectId, "Import file is required");
  const fileName = text(body.fileName, 255);
  const fingerprint = text(body.fingerprint, 1_000);
  if (!Array.isArray(body.rows) || body.rows.length > MAX_ROWS) return bad("Import rows required or exceed limit");
  const rows = body.rows.map(objectBody);
  if (Array.isArray(body.errors) && body.errors.length > 0) return conflict("Import contains invalid rows");
  const warningCount = Array.isArray(body.warnings) ? body.warnings.length : 0;
  return executeSupplyCommand({
    actorScope: `user:${access.userId}`,
    command: "imports.stage",
    context,
    payload: jsonValue(body),
    request,
    responseStatus: 201,
    run: async ({ idempotencyKey, transaction }) => {
      await requireFile(
        transaction,
        access,
        { id: fileObjectId },
        ["import", "import_source"],
        { entityType: "import_upload", entityIds: [access.userId] },
      );
      const duplicates = await transaction.query<DataRow & { createdAt: string; id: number; importNo: string; status: string }>(
        `SELECT id, import_no AS importNo, status, created_at AS createdAt
         FROM import_batches WHERE fingerprint = ? ORDER BY created_at DESC, id DESC LIMIT 1 FOR SHARE`,
        [fingerprint],
      );
      const duplicate = duplicates[0];
      const status = duplicate === undefined ? "awaiting_mapping" : "awaiting_duplicate_confirmation";
      const importNo = `IMP-R2-${idempotencyKey.replace(/[^A-Za-z0-9]/gu, "").slice(-24)}`;
      const batchId = await insertId(
        transaction,
        `INSERT INTO import_batches (
           import_no, type, file_object_id, file_name, fingerprint, business_key, status,
           total_rows, valid_rows, error_count, warning_count, duplicate_of_batch_id,
           created_by, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
        [importNo, type, fileObjectId, fileName, fingerprint, body.businessKey == null ? null : String(body.businessKey), status, rows.length, rows.length, warningCount, duplicate?.id ?? null, access.userId],
      );
      for (const row of rows) {
        const sourceRow = positiveInteger(row.sourceRow, "Source row number required");
        const sheetName = typeof row.sheetName === "string" && row.sheetName.trim() ? row.sheetName.trim() : "sheet1";
        const result = await transaction.execute(
          `INSERT INTO import_staging_rows (
             import_batch_id, sheet_name, source_row_no, business_key,
             normalized_json, raw_json, validation_status, validation_messages_json, mapping_confirmed
           ) VALUES (?, ?, ?, ?, ?, ?, 'valid', '[]', 0)`,
          [batchId, sheetName, sourceRow, String(row.businessKey ?? row.sku ?? row.code ?? ""), JSON.stringify(row), JSON.stringify(row)],
        );
        if (result.affectedRows !== 1) throw new Error("Import staging write failed");
      }
      await audit(transaction, request, access, { action: "stage_import", module: "imports", entityType: "import_batch", entityId: batchId, businessNo: importNo, after: { type, fileName, totalRows: rows.length, duplicateOf: duplicate?.id ?? null } });
      await domainEvent(context, transaction, { entityId: batchId, entityType: "import_batch", eventType: "ImportStaged", idempotencyKey, recipient: { kind: "role", role: "supply_chain" }, data: { type, rowCount: rows.length } });
      return { batch: { id: batchId, importNo, status }, duplicate: duplicate ?? null };
    },
  });
}

interface ImportBatchRow extends DataRow {
  duplicateOfBatchId: number | null;
  errorCount: number;
  fingerprint: string;
  id: number;
  importNo: string;
  status: string;
  type: string;
}

interface StagingRow extends DataRow {
  id: number;
  normalizedJson: string;
  sourceRowNo: number;
}

export async function commitImport(
  context: DomainRegistrationContext,
  request: FastifyRequest,
  access: AccessContext,
  raw: unknown,
) {
  if (!isInternal(access)) return forbidden();
  const body = objectBody(raw);
  const batchId = positiveInteger(body.batchId, "Import batch is required");
  const mappingsInput = Array.isArray(body.supplierMappings) ? body.supplierMappings.map(objectBody) : [];
  return executeSupplyCommand({
    actorScope: `user:${access.userId}`,
    command: "imports.commit",
    context,
    payload: jsonValue(body),
    request,
    responseStatus: (result) => result.awaitingMapping === true ? 202 : 200,
    run: async ({ idempotencyKey, transaction }) => {
      const batchRows = await transaction.query<ImportBatchRow>(
        `SELECT id, import_no AS importNo, type, fingerprint, status,
                error_count AS errorCount, duplicate_of_batch_id AS duplicateOfBatchId
         FROM import_batches WHERE id = ? LIMIT 1 FOR UPDATE`,
        [batchId],
      );
      const batch = batchRows[0];
      if (batch === undefined) return missing("Import batch not found");
      if (batch.status === "committed") return conflict("Import batch is already committed");
      if (batch.errorCount > 0) return conflict("Import batch still contains invalid rows");
      if (batch.duplicateOfBatchId !== null && body.confirmDuplicate !== true) return conflict("Duplicate import must be explicitly confirmed");
      const rows = await transaction.query<StagingRow>(
        `SELECT id, source_row_no AS sourceRowNo, normalized_json AS normalizedJson
         FROM import_staging_rows WHERE import_batch_id = ? ORDER BY id FOR UPDATE`,
        [batchId],
      );
      if (batch.type !== "supplier") {
        const updated = await transaction.execute(
          `UPDATE import_batches SET status = 'awaiting_mapping', updated_at = CURRENT_TIMESTAMP(3)
           WHERE id = ? AND status <> 'committed'`,
          [batchId],
        );
        if (updated.affectedRows !== 1) return conflict("Import batch changed concurrently");
        await audit(transaction, request, access, { action: "defer_import_commit", module: "imports", entityType: "import_batch", entityId: batchId, businessNo: batch.importNo, after: { type: batch.type, reason: "domain_mapping_required" } });
        return { success: false, awaitingMapping: true, message: "Complete the owning domain mapping before commit." };
      }

      const mappings = new Map(mappingsInput.map((mapping) => [positiveInteger(mapping.stagingRowId), mapping]));
      const supplierIds: number[] = [];
      for (const row of rows) {
        const mapping = mappings.get(row.id);
        if (mapping === undefined) return conflict(`Supplier mapping missing for source row ${row.sourceRowNo}`);
        const tier = positiveInteger(mapping.tier);
        if (![1, 2, 3].includes(tier)) return bad("Supplier tier must be 1, 2, or 3");
        const managedByFactoryId = tier === 1 ? null : positiveInteger(mapping.managedByFactoryId, "Managed factory required");
        if (managedByFactoryId !== null) {
          const factory = await transaction.query<DataRow>("SELECT id FROM factories WHERE id = ? AND status = 'active' LIMIT 1 FOR SHARE", [managedByFactoryId]);
          if (factory[0] === undefined) return missing("Managed factory not found");
        }
        const licenseKey = text(mapping.businessLicenseFileKey, 1_000);
        const license = await requireFile(transaction, access, /^\d+$/u.test(licenseKey) ? { id: Number(licenseKey) } : { objectKey: licenseKey }, ["business_license", "supplier_evidence"]);
        const normalized = JSON.parse(row.normalizedJson) as Record<string, unknown>;
        const code = text(normalized.code, 191);
        const name = text(normalized.name, 500);
        const existing = await transaction.query<DataRow>("SELECT id FROM suppliers WHERE code = ? LIMIT 1 FOR UPDATE", [code]);
        if (existing[0] !== undefined) return conflict(`Supplier code already exists: ${code}`);
        const supplierId = await insertId(
          transaction,
          `INSERT INTO suppliers (
             code, name, tier, managed_by_factory_id, legal_name, unified_social_credit_code,
             business_license_file_key, address, contact_name, contact_phone, business_scope,
             source, verification_status, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'lingxing_excel', 'pending', 'draft', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
          [code, name, tier, managedByFactoryId, text(mapping.legalName), text(mapping.unifiedSocialCreditCode), license.objectKey, text(mapping.address), text(mapping.contactName), text(mapping.contactPhone), text(mapping.businessScope)],
        );
        supplierIds.push(supplierId);
        const approvalId = await createApproval(transaction, { entityId: supplierId, entityType: "supplier", idempotencyKey, discriminator: `supplier:${supplierId}`, payload: { batchId, stagingRowId: row.id, mapping }, requestedBy: access.userId, summary: `Imported supplier: ${name}`, workflowType: "supplier_onboarding" });
        await approvalNotification(context, transaction, { approvalId, idempotencyKey: `${idempotencyKey}:${supplierId}`, targetEntityId: supplierId, targetEntityType: "supplier", workflowType: "supplier_onboarding" });
      }
      const committed = await transaction.execute(
        `UPDATE import_batches
         SET status = 'committed', committed_by = ?, committed_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ? AND status <> 'committed'`,
        [access.userId, batchId],
      );
      if (committed.affectedRows !== 1) return conflict("Import batch changed concurrently");
      await audit(transaction, request, access, { action: "commit_import", module: "imports", entityType: "import_batch", entityId: batchId, businessNo: batch.importNo, after: { rows: rows.length, type: batch.type, supplierIds } });
      await domainEvent(context, transaction, { entityId: batchId, entityType: "import_batch", eventType: "ImportCommitted", idempotencyKey, recipient: { kind: "role", role: "supply_chain" }, data: { rowCount: rows.length, type: batch.type } });
      return { success: true, importedRows: rows.length, approvalRequired: true, supplierIds };
    },
  });
}
