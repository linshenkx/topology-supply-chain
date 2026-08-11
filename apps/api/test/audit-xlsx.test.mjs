import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";

import {
  AuditXlsxUnavailableError,
  createAuditXlsxExporter,
} from "../dist/infrastructure/audit-xlsx.js";

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

  const workbook = XLSX.read(bytes, { type: "array" });
  assert.deepEqual(workbook.SheetNames, ["导出说明", "操作日志"]);
  const explanation = workbook.Sheets["导出说明"];
  const data = workbook.Sheets["操作日志"];
  assert.ok(explanation);
  assert.ok(data);
  assert.equal(explanation.B3.v, '{"actor":"=attacker"}');
  assert.equal(explanation.B3.f, undefined);
  assert.match(data.B2.v, /^'=HYPERLINK/u);
  assert.match(data.E2.v, /^'\+cmd/u);
  assert.match(data.F2.v, /^'@SUM/u);
  assert.equal(data.B2.f, undefined);
  assert.equal(data.E2.f, undefined);
  assert.equal(data.F2.f, undefined);
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
