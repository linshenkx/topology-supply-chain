import assert from "node:assert/strict";
import test from "node:test";

import {
  createSafeXlsx,
  SafeXlsxError,
} from "../dist/infrastructure/safe-xlsx.js";
import {
  readStoredZip,
  workbookSheetNames,
  worksheetCells,
  worksheetDimension,
} from "./xlsx-test-helpers.mjs";

function workbook(sheets, maxOutputBytes = 64 * 1_024) {
  return createSafeXlsx({ sheets, maxOutputBytes });
}

test("safe XLSX emits a valid deterministic ZIP/XML package and neutralizes formulas", () => {
  const bytes = workbook([
    {
      name: "😀 Data & <safe>",
      rowCount: 2,
      columnCount: 3,
      rows: [
        ["  =2+2", "<&\"'😀", 42.5],
        ["@SUM(A1:A2)", "+cmd", "-1+2"],
      ],
      columnWidths: [20, 12, 8],
    },
  ]);

  const files = readStoredZip(bytes);
  assert.deepEqual(
    [...files.keys()].sort(),
    [
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/workbook.xml",
      "xl/worksheets/sheet1.xml",
    ].sort(),
  );
  assert.deepEqual(
    workbookSheetNames(files.get("xl/workbook.xml").toString("utf8")),
    ["😀 Data & <safe>"],
  );
  const worksheetXml = files.get("xl/worksheets/sheet1.xml").toString("utf8");
  const cells = worksheetCells(worksheetXml);
  assert.equal(worksheetDimension(worksheetXml), "A1:C2");
  assert.equal(cells.get("A1"), "'  =2+2");
  assert.equal(cells.get("B1"), "<&\"'😀");
  assert.equal(cells.get("C1"), 42.5);
  assert.equal(cells.get("A2"), "'@SUM(A1:A2)");
  assert.equal(cells.get("B2"), "'+cmd");
  assert.equal(cells.get("C2"), "'-1+2");
  assert.doesNotMatch(worksheetXml, /<f(?:\s|>)/u);
});

test("safe XLSX rejects invalid structure, XML, Excel bounds, and output budgets", () => {
  const valid = {
    name: "Data",
    rowCount: 1,
    columnCount: 1,
    rows: [["value"]],
  };

  for (const input of [
    { sheets: [], maxOutputBytes: 1_024 },
    { sheets: [valid], maxOutputBytes: 1 },
    {
      sheets: [valid, { ...valid, name: "data" }],
      maxOutputBytes: 64 * 1_024,
    },
    {
      sheets: [{ ...valid, name: "bad/name" }],
      maxOutputBytes: 64 * 1_024,
    },
    {
      sheets: [{ ...valid, rows: [["bad\u0000xml"]] }],
      maxOutputBytes: 64 * 1_024,
    },
    {
      sheets: [{ ...valid, rows: [["\ud800"]] }],
      maxOutputBytes: 64 * 1_024,
    },
    {
      sheets: [{ ...valid, rows: [["x".repeat(32_768)]] }],
      maxOutputBytes: 128 * 1_024,
    },
    {
      sheets: [{ ...valid, rowCount: 2 }],
      maxOutputBytes: 64 * 1_024,
    },
    {
      sheets: [{ ...valid, rows: [[Number.NaN]] }],
      maxOutputBytes: 64 * 1_024,
    },
  ]) {
    assert.throws(() => createSafeXlsx(input), SafeXlsxError);
  }
});

test("safe XLSX sanitizes unexpected row iterator failures", () => {
  const rows = {
    *[Symbol.iterator]() {
      throw new Error("secret row contents must not leak");
    },
  };

  assert.throws(
    () =>
      workbook([
        { name: "Data", rowCount: 1, columnCount: 1, rows },
      ]),
    (error) =>
      error instanceof SafeXlsxError &&
      error.message === "XLSX generation failed" &&
      error.cause === undefined,
  );
});
