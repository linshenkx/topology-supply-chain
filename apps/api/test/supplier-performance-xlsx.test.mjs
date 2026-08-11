import assert from "node:assert/strict";
import test from "node:test";

import {
  createSupplierPerformanceXlsxExporter,
  SupplierPerformanceXlsxUnavailableError,
} from "../dist/infrastructure/supplier-performance-xlsx.js";
import {
  assertTwoSheetXlsxPackage,
  readStoredZip,
  workbookSheetNames,
  worksheetCells,
  worksheetDimension,
} from "./xlsx-test-helpers.mjs";

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

  const files = readStoredZip(bytes);
  assertTwoSheetXlsxPackage(files);
  assert.deepEqual(
    workbookSheetNames(files.get("xl/workbook.xml").toString("utf8")),
    ["导出说明", "绩效排名"],
  );
  const explanationXml = files
    .get("xl/worksheets/sheet1.xml")
    .toString("utf8");
  const dataXml = files.get("xl/worksheets/sheet2.xml").toString("utf8");
  const explanation = worksheetCells(explanationXml);
  const data = worksheetCells(dataXml);
  assert.equal(worksheetDimension(dataXml), "A1:K2");
  assert.deepEqual(
    Array.from({ length: 11 }, (_, index) =>
      data.get(`${String.fromCharCode(65 + index)}1`),
    ),
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
  assert.match(data.get("B2"), /^'=HYPERLINK/u);
  assert.match(data.get("K2"), /^'\s{2}\+cmd/u);
  assert.match(explanation.get("A2"), /^'\s{2}\+cmd/u);
  assert.equal(data.get("F2"), "待业务数据形成");
  assert.equal(data.get("I2"), "不适用/待评价");
  assert.doesNotMatch(explanationXml + dataXml, /<f(?:\s|>)|must-not-be-exported/u);
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
