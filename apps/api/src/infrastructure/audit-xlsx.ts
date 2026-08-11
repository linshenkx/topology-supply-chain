import type { AuditLog } from "@topology/contracts";

import {
  createSafeXlsx,
  type XlsxCell,
} from "./safe-xlsx.js";

const MAX_EXPORT_ROWS = 5_000;
const MAX_CELL_CHARACTERS = 32_000;
const MAX_WORKBOOK_BYTES = 25 * 1_024 * 1_024;
const FORMULA_PREFIX = /^[=+\-@]/u;

export interface AuditXlsxInput {
  companyName: string;
  filterSummary: Record<string, string>;
  rows: readonly AuditLog[];
  watermark: string;
}

export interface AuditXlsxExporter {
  createXlsx(input: AuditXlsxInput): Uint8Array;
}

export class AuditXlsxUnavailableError extends Error {
  constructor() {
    super("Audit export unavailable");
    this.name = "AuditXlsxUnavailableError";
  }
}

function unavailable(): never {
  throw new AuditXlsxUnavailableError();
}

function safeCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  if (text.length > MAX_CELL_CHARACTERS) return unavailable();
  return FORMULA_PREFIX.test(text.trimStart()) ? `'${text}` : text;
}

function rowValues(row: AuditLog, watermark: string): string[] {
  return [
    row.createdAt,
    row.actorName ?? "账号已停用",
    row.actorEmail ?? "",
    row.module,
    row.action,
    row.businessNo ?? "",
    row.entityType,
    row.entityId,
    row.sensitiveView ? "是" : "否",
    row.exported ? "是" : "否",
    row.ipAddress ?? "",
    row.deviceId ?? "",
    row.archiveAfter,
    watermark,
  ].map(safeCell);
}

function* auditRows(
  rows: readonly AuditLog[],
  watermark: string,
): Generator<readonly XlsxCell[]> {
  yield [
    "操作时间",
    "操作人",
    "操作人邮箱",
    "模块",
    "操作",
    "业务单号",
    "对象类型",
    "对象编号",
    "敏感查看",
    "导出操作",
    "IP地址",
    "设备编号",
    "归档日期",
    "水印",
  ];
  for (const row of rows) yield rowValues(row, watermark);
}

export function createAuditXlsxExporter(): AuditXlsxExporter {
  return {
    createXlsx(input) {
      if (input.rows.length > MAX_EXPORT_ROWS) return unavailable();

      try {
        const filterSummary = safeCell(JSON.stringify(input.filterSummary));
        const companyName = safeCell(input.companyName);
        const watermark = safeCell(input.watermark);
        return createSafeXlsx({
          maxOutputBytes: MAX_WORKBOOK_BYTES,
          sheets: [
            {
              name: "导出说明",
              rowCount: 4,
              columnCount: 2,
              rows: [
                [`${companyName} SCM 操作日志`],
                [watermark],
                ["筛选条件", filterSummary],
                ["说明", "文件包含敏感审计信息，仅限授权人员使用。"],
              ],
            },
            {
              name: "操作日志",
              rowCount: input.rows.length + 1,
              columnCount: 14,
              rows: auditRows(input.rows, watermark),
              columnWidths: [
                22, 20, 28, 18, 24, 22, 20, 20, 10, 10, 18, 22, 22, 48,
              ],
            },
          ],
        });
      } catch (error) {
        if (error instanceof AuditXlsxUnavailableError) throw error;
        throw new AuditXlsxUnavailableError();
      }
    },
  };
}
