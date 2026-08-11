const MAX_EXCEL_ROWS = 1_048_576;
const MAX_EXCEL_COLUMNS = 16_384;
const MAX_SHEETS = 255;
const MAX_ZIP_ENTRIES = 65_535;
const MAX_ZIP_UINT32 = 0xffff_ffff;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_STORE_METHOD = 0;
const ZIP_VERSION = 20;
const DOS_TIME = 0;
const DOS_DATE = 0x0021;
const INVALID_XML_CHARACTER =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/u;
const INVALID_SHEET_NAME_CHARACTER = /[\\/*?:[\]]/u;

export type XlsxCell = number | string;

export interface XlsxSheet {
  name: string;
  rowCount: number;
  columnCount: number;
  rows: Iterable<readonly XlsxCell[]>;
  columnWidths?: readonly number[];
}

export interface XlsxWorkbookInput {
  sheets: readonly XlsxSheet[];
  maxOutputBytes: number;
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

export class SafeXlsxError extends Error {
  constructor() {
    super("XLSX generation failed");
    this.name = "SafeXlsxError";
  }
}

function unavailable(): never {
  throw new SafeXlsxError();
}

function escapeXml(value: string): string {
  if (INVALID_XML_CHARACTER.test(value)) return unavailable();
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&apos;";
    }
  });
}

function columnReference(columnIndex: number): string {
  let value = columnIndex + 1;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

class BoundedXmlBuilder {
  readonly #chunks: Buffer[] = [];
  readonly #maximumBytes: number;
  #size = 0;

  constructor(maximumBytes: number) {
    this.#maximumBytes = maximumBytes;
  }

  append(value: string): void {
    const byteLength = Buffer.byteLength(value, "utf8");
    if (byteLength > this.#maximumBytes - this.#size) return unavailable();
    this.#chunks.push(Buffer.from(value, "utf8"));
    this.#size += byteLength;
  }

  finish(): Buffer {
    return Buffer.concat(this.#chunks, this.#size);
  }
}

function validateSheet(sheet: XlsxSheet, names: Set<string>): void {
  if (
    typeof sheet.name !== "string" ||
    sheet.name.length === 0 ||
    sheet.name.length > 31 ||
    INVALID_SHEET_NAME_CHARACTER.test(sheet.name) ||
    sheet.name.startsWith("'") ||
    sheet.name.endsWith("'") ||
    names.has(sheet.name) ||
    INVALID_XML_CHARACTER.test(sheet.name) ||
    !Number.isSafeInteger(sheet.rowCount) ||
    sheet.rowCount < 1 ||
    sheet.rowCount > MAX_EXCEL_ROWS ||
    !Number.isSafeInteger(sheet.columnCount) ||
    sheet.columnCount < 1 ||
    sheet.columnCount > MAX_EXCEL_COLUMNS
  ) {
    return unavailable();
  }
  names.add(sheet.name);

  if (sheet.columnWidths === undefined) return;
  if (sheet.columnWidths.length > sheet.columnCount) return unavailable();
  for (const width of sheet.columnWidths) {
    if (!Number.isFinite(width) || width <= 0 || width > 255) {
      return unavailable();
    }
  }
}

function worksheetXml(sheet: XlsxSheet, maximumBytes: number): Buffer {
  const builder = new BoundedXmlBuilder(maximumBytes);
  const lastCell = `${columnReference(sheet.columnCount - 1)}${sheet.rowCount}`;
  builder.append(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      `<dimension ref="A1:${lastCell}"/>`,
  );

  if (sheet.columnWidths !== undefined && sheet.columnWidths.length > 0) {
    builder.append("<cols>");
    for (const [index, width] of sheet.columnWidths.entries()) {
      const column = index + 1;
      builder.append(
        `<col min="${column}" max="${column}" width="${width}" customWidth="1"/>`,
      );
    }
    builder.append("</cols>");
  }

  builder.append("<sheetData>");
  let rowIndex = 0;
  for (const row of sheet.rows) {
    rowIndex += 1;
    if (
      rowIndex > sheet.rowCount ||
      !Array.isArray(row) ||
      row.length > sheet.columnCount
    ) {
      return unavailable();
    }
    builder.append(`<row r="${rowIndex}">`);
    for (const [columnIndex, cell] of row.entries()) {
      const reference = `${columnReference(columnIndex)}${rowIndex}`;
      if (typeof cell === "number") {
        if (!Number.isFinite(cell)) return unavailable();
        builder.append(`<c r="${reference}"><v>${String(cell)}</v></c>`);
        continue;
      }
      if (typeof cell !== "string") return unavailable();
      builder.append(
        `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell)}</t></is></c>`,
      );
    }
    builder.append("</row>");
  }
  if (rowIndex !== sheet.rowCount) return unavailable();
  builder.append("</sheetData></worksheet>");
  return builder.finish();
}

function contentTypesXml(sheetCount: number): string {
  const worksheets = Array.from(
    { length: sheetCount },
    (_, index) =>
      `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  ).join("");
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    worksheets +
    "</Types>"
  );
}

function workbookXml(sheets: readonly XlsxSheet[]): string {
  const sheetNodes = sheets
    .map(
      (sheet, index) =>
        `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
    )
    .join("");
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets>${sheetNodes}</sheets></workbook>`
  );
}

function workbookRelationshipsXml(sheetCount: number): string {
  const sheetRelationships = Array.from(
    { length: sheetCount },
    (_, index) =>
      `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
  ).join("");
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheetRelationships +
    `<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    "</Relationships>"
  );
}

const ROOT_RELATIONSHIPS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  "</Relationships>";

const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  "</styleSheet>";

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let value = 0xffff_ffff;
  for (const byte of data) {
    const tableValue = CRC32_TABLE[(value ^ byte) & 0xff];
    if (tableValue === undefined) return unavailable();
    value = tableValue ^ (value >>> 8);
  }
  return (value ^ 0xffff_ffff) >>> 0;
}

function zipOverhead(fileNames: readonly string[]): number {
  return fileNames.reduce((total, fileName) => {
    const nameLength = Buffer.byteLength(fileName, "utf8");
    return total + 30 + nameLength + 46 + nameLength;
  }, 22);
}

function storedZip(entries: readonly ZipEntry[], maximumBytes: number): Uint8Array {
  if (entries.length === 0 || entries.length > MAX_ZIP_ENTRIES) {
    return unavailable();
  }

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const size = entry.data.length;
    if (
      name.length === 0 ||
      name.length > 0xffff ||
      size > MAX_ZIP_UINT32 ||
      localOffset > MAX_ZIP_UINT32
    ) {
      return unavailable();
    }
    const checksum = crc32(entry.data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x0403_4b50, 0);
    localHeader.writeUInt16LE(ZIP_VERSION, 4);
    localHeader.writeUInt16LE(ZIP_UTF8_FLAG, 6);
    localHeader.writeUInt16LE(ZIP_STORE_METHOD, 8);
    localHeader.writeUInt16LE(DOS_TIME, 10);
    localHeader.writeUInt16LE(DOS_DATE, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(size, 18);
    localHeader.writeUInt32LE(size, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, entry.data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x0201_4b50, 0);
    centralHeader.writeUInt16LE(ZIP_VERSION, 4);
    centralHeader.writeUInt16LE(ZIP_VERSION, 6);
    centralHeader.writeUInt16LE(ZIP_UTF8_FLAG, 8);
    centralHeader.writeUInt16LE(ZIP_STORE_METHOD, 10);
    centralHeader.writeUInt16LE(DOS_TIME, 12);
    centralHeader.writeUInt16LE(DOS_DATE, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(size, 20);
    centralHeader.writeUInt32LE(size, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, name);
    localOffset += localHeader.length + name.length + size;
  }

  const centralDirectory = Buffer.concat(centralParts);
  if (
    localOffset > MAX_ZIP_UINT32 ||
    centralDirectory.length > MAX_ZIP_UINT32
  ) {
    return unavailable();
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x0605_4b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);

  const output = Buffer.concat([...localParts, centralDirectory, end]);
  if (output.length === 0 || output.length > maximumBytes) return unavailable();
  return output;
}

export function createSafeXlsx(input: XlsxWorkbookInput): Uint8Array {
  try {
    if (
      !Array.isArray(input.sheets) ||
      input.sheets.length === 0 ||
      input.sheets.length > MAX_SHEETS ||
      !Number.isSafeInteger(input.maxOutputBytes) ||
      input.maxOutputBytes < 1 ||
      input.maxOutputBytes > MAX_ZIP_UINT32
    ) {
      return unavailable();
    }

    const sheetNames = new Set<string>();
    for (const sheet of input.sheets) validateSheet(sheet, sheetNames);

    const fileNames = [
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      ...input.sheets.map(
        (_, index) => `xl/worksheets/sheet${index + 1}.xml`,
      ),
    ];
    const dataBudget = input.maxOutputBytes - zipOverhead(fileNames);
    if (dataBudget < 1) return unavailable();

    const entries: ZipEntry[] = [];
    let dataBytes = 0;
    const addXml = (name: string, xml: string | Buffer): void => {
      const data = typeof xml === "string" ? Buffer.from(xml, "utf8") : xml;
      if (data.length > dataBudget - dataBytes) return unavailable();
      entries.push({ name, data });
      dataBytes += data.length;
    };

    addXml("[Content_Types].xml", contentTypesXml(input.sheets.length));
    addXml("_rels/.rels", ROOT_RELATIONSHIPS_XML);
    addXml("xl/workbook.xml", workbookXml(input.sheets));
    addXml(
      "xl/_rels/workbook.xml.rels",
      workbookRelationshipsXml(input.sheets.length),
    );
    addXml("xl/styles.xml", STYLES_XML);
    for (const [index, sheet] of input.sheets.entries()) {
      addXml(
        `xl/worksheets/sheet${index + 1}.xml`,
        worksheetXml(sheet, dataBudget - dataBytes),
      );
    }

    return storedZip(entries, input.maxOutputBytes);
  } catch (error) {
    if (error instanceof SafeXlsxError) throw error;
    throw new SafeXlsxError();
  }
}
