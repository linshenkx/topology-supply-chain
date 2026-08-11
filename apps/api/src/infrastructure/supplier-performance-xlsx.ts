import type { SupplierPerformanceExportPort } from "../modules/suppliers/index.js";
import {
  createSafeXlsx,
  type XlsxCell,
} from "./safe-xlsx.js";

const MAX_EXPORT_ROWS = 500;
const MAX_CELL_CHARACTERS = 32_000;
const MAX_WORKBOOK_BYTES = 25 * 1_024 * 1_024;
const QUARTER_PATTERN = /^[0-9]{4}-Q[1-4]$/u;

const HEADERS = [
  "排名",
  "供应商",
  "层级",
  "综合分",
  "准时交付率",
  "质检合格率",
  "异常处理及时率",
  "备料按期完成率",
  "内部满意度",
  "打样配合度",
  "水印",
] as const;

export class SupplierPerformanceXlsxUnavailableError extends Error {
  constructor() {
    super("Supplier performance export unavailable");
    this.name = "SupplierPerformanceXlsxUnavailableError";
  }
}

function unavailable(): never {
  throw new SupplierPerformanceXlsxUnavailableError();
}

function safeText(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  if (text.length > MAX_CELL_CHARACTERS) return unavailable();
  return text;
}

function boundedNumber(
  value: number,
  minimum: number,
  maximum: number,
  integer = false,
): number {
  if (
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum ||
    (integer && !Number.isSafeInteger(value))
  ) {
    return unavailable();
  }
  return value;
}

function metric(value: number | null, missing: string): XlsxCell {
  return value === null ? missing : boundedNumber(value, 0, 100);
}

function rankingValues(
  ranking: Parameters<SupplierPerformanceExportPort>[0]["rankings"][number],
  watermark: string,
): XlsxCell[] {
  if (typeof ranking.displayName !== "string") return unavailable();
  return [
    boundedNumber(ranking.rank, 1, MAX_EXPORT_ROWS, true),
    safeText(ranking.displayName),
    safeText(`第${boundedNumber(ranking.tier, 1, 3, true)}层`),
    metric(ranking.score, "待评价"),
    metric(ranking.metrics.delivery, "待业务数据形成"),
    metric(ranking.metrics.quality, "待业务数据形成"),
    metric(ranking.metrics.exception, "待业务数据形成"),
    metric(ranking.metrics.preparation, "待业务数据形成"),
    metric(ranking.metrics.satisfaction, "不适用/待评价"),
    metric(ranking.metrics.sampling, "待评价"),
    watermark,
  ];
}

function* rankingRows(
  rankings: Parameters<SupplierPerformanceExportPort>[0]["rankings"],
  watermark: string,
): Generator<readonly XlsxCell[]> {
  yield HEADERS;
  for (const ranking of rankings) {
    yield rankingValues(ranking, watermark);
  }
}

export function createSupplierPerformanceXlsxExporter(): SupplierPerformanceExportPort {
  return async (input) => {
    try {
      if (
        !Array.isArray(input.rankings) ||
        input.rankings.length > MAX_EXPORT_ROWS ||
        typeof input.quarter !== "string" ||
        !QUARTER_PATTERN.test(input.quarter) ||
        typeof input.watermark !== "string" ||
        input.watermark.length === 0
      ) {
        return unavailable();
      }
      const quarter = safeText(input.quarter);
      const watermark = safeText(input.watermark);
      return createSafeXlsx({
        maxOutputBytes: MAX_WORKBOOK_BYTES,
        sheets: [
          {
            name: "导出说明",
            rowCount: 4,
            columnCount: 2,
            rows: [
              ["广州拓扑睡眠科技有限公司 供应商绩效排名"],
              [watermark],
              ["季度", quarter],
              ["说明", "未形成业务数据的自动指标不参与当期加权计算。"],
            ],
          },
          {
            name: "绩效排名",
            rowCount: input.rankings.length + 1,
            columnCount: HEADERS.length,
            rows: rankingRows(input.rankings, watermark),
            columnWidths: [8, 28, 10, 12, 16, 16, 20, 20, 16, 16, 48],
          },
        ],
      });
    } catch (error) {
      if (error instanceof SupplierPerformanceXlsxUnavailableError) throw error;
      throw new SupplierPerformanceXlsxUnavailableError();
    }
  };
}
