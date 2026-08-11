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

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function crc32(data) {
  let value = 0xffff_ffff;
  for (const byte of data) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffff_ffff) >>> 0;
}

function findEndOfCentralDirectory(buffer) {
  const minimumOffset = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x0605_4b50) return offset;
  }
  throw new Error("ZIP end-of-central-directory record is missing");
}

export function readStoredZip(bytes) {
  const buffer = Buffer.from(bytes);
  const endOffset = findEndOfCentralDirectory(buffer);
  check(buffer.readUInt16LE(endOffset + 4) === 0, "multi-disk ZIP is unsupported");
  check(buffer.readUInt16LE(endOffset + 6) === 0, "multi-disk ZIP is unsupported");
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  check(
    buffer.readUInt16LE(endOffset + 8) === entryCount,
    "central-directory entry count differs",
  );
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  const commentLength = buffer.readUInt16LE(endOffset + 20);
  check(commentLength === 0, "ZIP comment was not deterministic");
  check(
    centralOffset + centralSize === endOffset,
    "central-directory bounds are invalid",
  );

  const files = new Map();
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    check(buffer.readUInt32LE(offset) === 0x0201_4b50, "central header is invalid");
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const checksum = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const fileCommentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    const name = buffer.toString("utf8", nameStart, nameEnd);
    check((flags & 0x0800) !== 0, `${name} is not marked UTF-8`);
    check(method === 0, `${name} is unexpectedly compressed`);
    check(compressedSize === size, `${name} stored size differs`);
    check(!files.has(name), `${name} is duplicated`);

    check(
      buffer.readUInt32LE(localOffset) === 0x0403_4b50,
      `${name} local header is invalid`,
    );
    check(buffer.readUInt16LE(localOffset + 6) === flags, `${name} flags differ`);
    check(
      buffer.readUInt16LE(localOffset + 8) === method,
      `${name} method differs`,
    );
    check(
      buffer.readUInt32LE(localOffset + 14) === checksum,
      `${name} CRC differs`,
    );
    check(
      buffer.readUInt32LE(localOffset + 18) === compressedSize &&
        buffer.readUInt32LE(localOffset + 22) === size,
      `${name} local sizes differ`,
    );
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const localNameStart = localOffset + 30;
    const localNameEnd = localNameStart + localNameLength;
    check(
      buffer.toString("utf8", localNameStart, localNameEnd) === name,
      `${name} local name differs`,
    );
    const dataStart = localNameEnd + localExtraLength;
    const dataEnd = dataStart + size;
    check(dataEnd <= centralOffset, `${name} data exceeds local file area`);
    const data = buffer.subarray(dataStart, dataEnd);
    check(crc32(data) === checksum, `${name} CRC32 is invalid`);
    files.set(name, data);

    offset = nameEnd + extraLength + fileCommentLength;
  }
  check(offset === endOffset, "central-directory size is invalid");
  return files;
}

export function assertTwoSheetXlsxPackage(files) {
  const names = [...files.keys()].sort();
  check(
    JSON.stringify(names) ===
      JSON.stringify(
        [
          "[Content_Types].xml",
          "_rels/.rels",
          "xl/_rels/workbook.xml.rels",
          "xl/styles.xml",
          "xl/workbook.xml",
          "xl/worksheets/sheet1.xml",
          "xl/worksheets/sheet2.xml",
        ].sort(),
      ),
    "XLSX package entries differ",
  );
  const contentTypes = files.get("[Content_Types].xml")?.toString("utf8") ?? "";
  const rootRelationships = files.get("_rels/.rels")?.toString("utf8") ?? "";
  const workbookRelationships =
    files.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "";
  check(
    contentTypes.includes('PartName="/xl/worksheets/sheet1.xml"') &&
      contentTypes.includes('PartName="/xl/worksheets/sheet2.xml"'),
    "worksheet content types are missing",
  );
  check(
    rootRelationships.includes('Target="xl/workbook.xml"'),
    "root workbook relationship is missing",
  );
  check(
    workbookRelationships.includes('Target="worksheets/sheet1.xml"') &&
      workbookRelationships.includes('Target="worksheets/sheet2.xml"') &&
      workbookRelationships.includes('Target="styles.xml"'),
    "workbook relationships are incomplete",
  );
}

function decodeXml(value) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

export function workbookSheetNames(xml) {
  return [...xml.matchAll(/<sheet name="([^"]+)" sheetId="[0-9]+" r:id="rId[0-9]+"\/>/gu)].map(
    (match) => decodeXml(match[1]),
  );
}

export function worksheetCells(xml) {
  const cells = new Map();
  for (const match of xml.matchAll(
    /<c r="([A-Z]+[0-9]+)"(?: t="([^"]+)")?>([\s\S]*?)<\/c>/gu,
  )) {
    const [, reference, type, body] = match;
    if (type === "inlineStr") {
      const text = body.match(
        /<t xml:space="preserve">([\s\S]*?)<\/t>/u,
      );
      check(text !== null, `${reference} inline string is invalid`);
      cells.set(reference, decodeXml(text[1]));
      continue;
    }
    const value = body.match(/<v>([\s\S]*?)<\/v>/u);
    check(value !== null, `${reference} numeric cell is invalid`);
    cells.set(reference, Number(decodeXml(value[1])));
  }
  return cells;
}

export function worksheetDimension(xml) {
  return xml.match(/<dimension ref="([A-Z]+[0-9]+:[A-Z]+[0-9]+)"\/>/u)?.[1];
}
