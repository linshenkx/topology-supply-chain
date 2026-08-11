import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";

import {
  createSupplierPerformanceXlsxExporter,
  SupplierPerformanceXlsxUnavailableError,
} from "../dist/infrastructure/supplier-performance-xlsx.js";

function ranking(overrides = {}) {
  return {
    supplierId: null,
    supplierCode: null,
    supplierName: null,
    displayName: "=HYPERLINK(\"https://attacker.invalid\")",
    tier: 1,
    rank: 1,
    score: 88.5,
    metrics: {
      delivery: 90,
      quality: null,
      exception: 80,
      preparation: 75,
      satisfaction: null,
      sampling: 92.5,
    },
    automaticMetricEvidence: {
      delivery: { evaluatedBatches: 10, onTimeBatches: 9 },
    },
    reviewCounts: { satisfaction: 0, sampling: 1 },
    comments: [],
    reveal: false,
    ...overrides,
  };
}

test("supplier performance XLSX uses fixed columns and neutralizes formulas", async () => {
  const exporter = createSupplierPerformanceXlsxExporter();
  const bytes = await exporter({
    quarter: "2026-Q3",
    rankings: [ranking({ unexpectedSecret: "must-not-be-exported" })],
    watermark: "  +cmd|' /C calc'!A0",
  });

  const workbook = XLSX.read(bytes, { type: "array" });
  assert.deepEqual(workbook.SheetNames, ["导出说明", "绩效排名"]);
  const explanation = workbook.Sheets["导出说明"];
  const data = workbook.Sheets["绩效排名"];
  assert.ok(explanation);
  assert.ok(data);
  assert.equal(data["!ref"], "A1:K2");
  assert.deepEqual(
    XLSX.utils.sheet_to_json(data, { header: 1, raw: true })[0],
    [
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
    ],
  );
  assert.match(data.B2.v, /^'=HYPERLINK/u);
  assert.match(data.K2.v, /^'\s{2}\+cmd/u);
  assert.match(explanation.A2.v, /^'\s{2}\+cmd/u);
  assert.equal(data.B2.f, undefined);
  assert.equal(data.K2.f, undefined);
  assert.equal(explanation.A2.f, undefined);
  assert.equal(data.F2.v, "待业务数据形成");
  assert.equal(data.I2.v, "不适用/待评价");
  assert.doesNotMatch(JSON.stringify(workbook), /must-not-be-exported/u);
});

test("supplier performance XLSX enforces row, cell, and value bounds with sanitized errors", async () => {
  const exporter = createSupplierPerformanceXlsxExporter();
  const excessiveRows = Array.from({ length: 501 }, (_, index) =>
    ranking({ rank: index + 1 }),
  );

  for (const input of [
    undefined,
    { quarter: "2026-Q3", rankings: excessiveRows, watermark: "watermark" },
    {
      quarter: "2026-Q3",
      rankings: [ranking({ displayName: "x".repeat(32_001) })],
      watermark: "watermark",
    },
    {
      quarter: "2026-Q5",
      rankings: [ranking()],
      watermark: "watermark",
    },
    {
      quarter: "2026-Q3",
      rankings: [ranking({ score: Number.POSITIVE_INFINITY })],
      watermark: "watermark",
    },
  ]) {
    await assert.rejects(
      exporter(input),
      (error) =>
        error instanceof SupplierPerformanceXlsxUnavailableError &&
        error.message === "Supplier performance export unavailable" &&
        error.cause === undefined,
    );
  }
});
