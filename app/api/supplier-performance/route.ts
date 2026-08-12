import { and, desc, eq, lte } from "drizzle-orm";
import * as XLSX from "xlsx";
import { getDb } from "../../../db";
import { deliveryBatches, executionOrders, orderItems, supplierPerformanceReviews, supplierPerformanceWeightVersions, suppliers } from "../../../db/schema";
import { accessErrorResponse, isInternal, requireAccess } from "../../lib/authz";
import { writeAudit } from "../../lib/audit";
import { retiredPlatformRoute } from "../../lib/retired-writer";

type MetricKey = "delivery" | "quality" | "exception" | "preparation" | "satisfaction" | "sampling";
type Weights = Record<MetricKey, number>;
const defaults: Record<number, Weights> = {
  1: { delivery: 2500, quality: 2000, exception: 1500, preparation: 1000, satisfaction: 1500, sampling: 1500 },
  2: { delivery: 3000, quality: 2500, exception: 1500, preparation: 1500, satisfaction: 0, sampling: 1500 },
  3: { delivery: 3000, quality: 2500, exception: 2000, preparation: 1000, satisfaction: 0, sampling: 1500 },
};
const shanghaiDateFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
function localDate(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = Object.fromEntries(shanghaiDateFormatter.formatToParts(date).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function quarterFromDate(value: string) {
  const [year, month] = value.split("-").map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return null;
  return `${year}-Q${Math.floor((month - 1) / 3) + 1}`;
}
function currentQuarter() {
  const today = localDate(new Date()) || new Date().toISOString().slice(0, 10);
  return quarterFromDate(today) || `${new Date().getUTCFullYear()}-Q1`;
}
function average(values: number[]) { return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length * 20 * 10) / 10 : null; }
function parseTags(value: string) { try { const tags = JSON.parse(value); return Array.isArray(tags) ? tags.map(String) : []; } catch { return []; } }

export async function GET() {
  return retiredPlatformRoute("/api/v1/supplier-performance");
}

export async function POST() {
  return retiredPlatformRoute("/api/v1/supplier-performance");
}
