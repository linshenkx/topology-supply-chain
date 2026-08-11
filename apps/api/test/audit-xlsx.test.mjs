import assert from "node:assert/strict";
import test from "node:test";

import {
  AuditXlsxUnavailableError,
  createAuditXlsxExporter,
} from "../dist/infrastructure/audit-xlsx.js";
import {
  assertTwoSheetXlsxPackage,
  readStoredZip,
  workbookSheetNames,
  worksheetCells,
} from "./xlsx-test-helpers.mjs";

const auditRow = {
  id: 1,
  actorUserId: 7,
  actorName: "=HYPERLINK(\"https://attacker.invalid\")",
  actorEmail: "admin@example.com",
  action: "+cmd|' /C calc'!A0",
  module: "finance",
  entityType: "payment",
  entityId: "1",
  businessNo: "@SUM(1+1)",
  ipAddress: "203.0.113.8",
  deviceId: "device-1",
  sensitiveView: true,
  exported: false,
  createdAt: "2026-08-11T12:34:56.000Z",
  archiveAfter: "2031-08-11T12:34:56.000Z",
};

test("audit XLSX exporter creates bounded sheets and neutralizes formulas", () => {
  const exporter = createAuditXlsxExporter();
  const bytes = exporter.createXlsx({
    companyName: "广州拓扑睡眠科技有限公司",
    filterSummary: { actor: "=attacker" },
    rows: [auditRow],
    watermark: "导出人：admin@example.com",
  });

  const files = readStoredZip(bytes);
  assertTwoSheetXlsxPackage(files);
  assert.deepEqual(
    workbookSheetNames(files.get("xl/workbook.xml").toString("utf8")),
    ["导出说明", "操作日志"],
  );
  const explanationXml = files
    .get("xl/worksheets/sheet1.xml")
    .toString("utf8");
  const dataXml = files.get("xl/worksheets/sheet2.xml").toString("utf8");
  const explanation = worksheetCells(explanationXml);
  const data = worksheetCells(dataXml);
  assert.equal(explanation.get("B3"), '{"actor":"=attacker"}');
  assert.match(data.get("B2"), /^'=HYPERLINK/u);
  assert.match(data.get("E2"), /^'\+cmd/u);
  assert.match(data.get("F2"), /^'@SUM/u);
  assert.doesNotMatch(explanationXml + dataXml, /<f(?:\s|>)/u);
});

test("audit XLSX exporter rejects excessive rows and cell sizes", () => {
  const exporter = createAuditXlsxExporter();
  assert.throws(
    () =>
      exporter.createXlsx({
        companyName: "Topology",
        filterSummary: {},
        rows: Array.from({ length: 5_001 }, () => auditRow),
        watermark: "watermark",
      }),
    AuditXlsxUnavailableError,
  );
  assert.throws(
    () =>
      exporter.createXlsx({
        companyName: "Topology",
        filterSummary: {},
        rows: [{ ...auditRow, action: "x".repeat(32_001) }],
        watermark: "watermark",
      }),
    AuditXlsxUnavailableError,
  );
});
