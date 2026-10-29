// Adds one row to the Ritlog sheet by editing the sheet XML inside the .xlsx.
// Only columns A to H of the target row are touched. Everything else in the
// workbook (formulas, validations, other tabs) is copied unchanged.
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";

const COLS = ["A", "B", "C", "D", "E", "F", "G", "H"];
const FIRST_DATA_ROW = 5;

export function excelSerial(isoDate) {
  // isoDate "YYYY-MM-DD" -> Excel serial (1900 date system)
  const [y, m, d] = isoDate.split("-").map(Number);
  const utc = Date.UTC(y, m - 1, d);
  return Math.round((utc - Date.UTC(1899, 11, 30)) / 86400000);
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // strip control chars that are invalid in XML
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

function findSheetPath(files, sheetName) {
  const wb = strFromU8(files["xl/workbook.xml"]);
  const sheetRe = /<sheet\b[^>]*>/g;
  let rid = null;
  for (const tag of wb.match(sheetRe) || []) {
    const name = /\bname="([^"]*)"/.exec(tag)?.[1];
    if (name === sheetName) rid = /\br:id="([^"]*)"/.exec(tag)?.[1];
  }
  if (!rid) throw new Error(`Sheet "${sheetName}" not found in workbook`);
  const rels = strFromU8(files["xl/_rels/workbook.xml.rels"]);
  for (const tag of rels.match(/<Relationship\b[^>]*>/g) || []) {
    if (/\bId="([^"]*)"/.exec(tag)?.[1] === rid) {
      let target = /\bTarget="([^"]*)"/.exec(tag)[1];
      target = target.startsWith("/") ? target.slice(1) : "xl/" + target;
      return target;
    }
  }
  throw new Error(`Relationship ${rid} not found`);
}

// Returns {start, end, xml} of the <row r="n"> element, or null.
function locateRow(sheet, n) {
  const re = new RegExp(`<row\\b[^>]*\\br="${n}"[^>]*?(/>|>[\\s\\S]*?</row>)`);
  const m = re.exec(sheet);
  return m ? { start: m.index, end: m.index + m[0].length, xml: m[0] } : null;
}

// Cell element for ref (e.g. "A12") inside a row XML, or null.
function locateCell(rowXml, ref) {
  const re = new RegExp(`<c\\b[^>]*\\br="${ref}"[^>]*?(/>|>[\\s\\S]*?</c>)`);
  const m = re.exec(rowXml);
  return m ? { start: m.index, end: m.index + m[0].length, xml: m[0] } : null;
}

function cellHasValue(cellXml) {
  if (!cellXml || cellXml.endsWith("/>")) return false;
  return /<v>[^<]+<\/v>|<is>|<f[\s>]/.test(cellXml);
}

function colIndex(ref) {
  const letters = /^[A-Z]+/.exec(ref)[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function buildCell(ref, style, value) {
  const s = style ? ` s="${style}"` : "";
  if (value === null || value === undefined || value === "") return `<c r="${ref}"${s}/>`;
  if (typeof value === "number") return `<c r="${ref}"${s}><v>${value}</v></c>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
}

function setCell(rowXml, ref, value) {
  const existing = locateCell(rowXml, ref);
  if (existing) {
    const style = /\bs="(\d+)"/.exec(existing.xml)?.[1];
    return rowXml.slice(0, existing.start) + buildCell(ref, style, value) + rowXml.slice(existing.end);
  }
  // Insert in column order.
  const newCell = buildCell(ref, null, value);
  const target = colIndex(ref);
  const cellRe = /<c\b[^>]*\br="([A-Z]+)\d+"/g;
  let m;
  while ((m = cellRe.exec(rowXml))) {
    if (colIndex(m[1]) > target) {
      return rowXml.slice(0, m.index) + newCell + rowXml.slice(m.index);
    }
  }
  if (rowXml.endsWith("/>")) return rowXml.replace(/\/>$/, `>${newCell}</row>`);
  return rowXml.replace(/<\/row>$/, `${newCell}</row>`);
}

function rowNumberOf(rowTag) {
  return Number(/\br="(\d+)"/.exec(rowTag)[1]);
}

// Find first row >= FIRST_DATA_ROW whose column A is empty.
function firstEmptyRow(sheet) {
  for (let n = FIRST_DATA_ROW; n < 1048576; n++) {
    const row = locateRow(sheet, n);
    if (!row) return n;
    if (!cellHasValue(locateCell(row.xml, `A${n}`)?.xml)) return n;
  }
  throw new Error("No empty row found");
}

function insertRow(sheet, n, rowXml) {
  // Insert before the first row with a higher number, else before </sheetData>.
  const rowRe = /<row\b[^>]*\br="(\d+)"/g;
  let m;
  while ((m = rowRe.exec(sheet))) {
    if (Number(m[1]) > n) return sheet.slice(0, m.index) + rowXml + sheet.slice(m.index);
  }
  return sheet.replace("</sheetData>", rowXml + "</sheetData>").replace("<sheetData/>", `<sheetData>${rowXml}</sheetData>`);
}

function ensureFullCalc(files) {
  let wb = strFromU8(files["xl/workbook.xml"]);
  if (/<calcPr\b[^>]*fullCalcOnLoad=/.test(wb)) return;
  if (/<calcPr\b/.test(wb)) wb = wb.replace(/<calcPr\b/, '<calcPr fullCalcOnLoad="1"');
  else wb = wb.replace("</workbook>", '<calcPr fullCalcOnLoad="1"/></workbook>');
  files["xl/workbook.xml"] = strToU8(wb);
}

function sharedStrings(files) {
  const raw = files["xl/sharedStrings.xml"];
  if (!raw) return [];
  const xml = strFromU8(raw);
  return (xml.match(/<si>[\s\S]*?<\/si>/g) || []).map((si) =>
    (si.match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) || []).map((t) => t.replace(/<[^>]+>/g, "")).join("")
  );
}

function cellText(cellXml, strings) {
  if (!cellXml) return "";
  const inline = /<is>([\s\S]*?)<\/is>/.exec(cellXml);
  if (inline) return inline[1].replace(/<[^>]+>/g, "");
  const v = /<v>([^<]*)<\/v>/.exec(cellXml)?.[1] ?? "";
  return /\bt="s"/.test(cellXml) ? strings[Number(v)] ?? "" : v;
}

/**
 * Ride IDs already present in column H (Opmerking), as { "R0142": rowNumber }.
 * Used to avoid writing the same ride twice.
 */
export function findRideRows(xlsxBytes, sheetName = "Ritlog") {
  const files = unzipSync(xlsxBytes);
  const sheet = strFromU8(files[findSheetPath(files, sheetName)]);
  const strings = sharedStrings(files);
  const found = {};
  const cellRe = /<c\b[^>]*\br="H(\d+)"[^>]*?(\/>|>[\s\S]*?<\/c>)/g;
  let m;
  while ((m = cellRe.exec(sheet))) {
    const id = /^\s*(R\d{4,})\b/.exec(cellText(m[0], strings))?.[1];
    if (id && !found[id]) found[id] = Number(m[1]);
  }
  return found;
}

/**
 * values: { date: "YYYY-MM-DD", vehicle, type, from, to, client, km (number), note }
 * Returns { bytes: Uint8Array, row: number }
 */
export function appendRitlogRow(xlsxBytes, values, sheetName = "Ritlog") {
  const files = unzipSync(xlsxBytes);
  const sheetPath = findSheetPath(files, sheetName);
  let sheet = strFromU8(files[sheetPath]);

  const n = firstEmptyRow(sheet);
  const cellValues = [
    excelSerial(values.date),
    values.vehicle,
    values.type,
    values.from || "",
    values.to || "",
    values.client || "",
    Number(values.km),
    values.note || "",
  ];

  const row = locateRow(sheet, n);
  let rowXml = row ? row.xml : `<row r="${n}"/>`;
  COLS.forEach((col, i) => {
    rowXml = setCell(rowXml, `${col}${n}`, cellValues[i]);
  });
  if (row) sheet = sheet.slice(0, row.start) + rowXml + sheet.slice(row.end);
  else sheet = insertRow(sheet, n, rowXml);

  // Keep <dimension> covering the new row.
  sheet = sheet.replace(/<dimension ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"\/>/, (m, c1, r1, c2, r2) =>
    Number(r2) >= n ? m : `<dimension ref="${c1}${r1}:${c2}${n}"/>`
  );

  files[sheetPath] = strToU8(sheet);
  ensureFullCalc(files);
  return { bytes: zipSync(files, { level: 6 }), row: n };
}

export const _internal = { firstEmptyRow, locateRow, locateCell, rowNumberOf };
