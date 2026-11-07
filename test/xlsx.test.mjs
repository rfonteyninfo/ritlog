import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { appendRitlogRow, excelSerial, fillOdometers } from "../worker/src/xlsx.js";

assert.equal(excelSerial("2027-01-01"), 46388);
let bytes = new Uint8Array(readFileSync(new URL("./fixture.xlsx", import.meta.url)));
const r1 = appendRitlogRow(bytes, { date: "2027-01-14", vehicle: "Motor", type: "Zakelijk", from: "Thuis", to: "Proximus <Evere> & co", client: "Proximus", km: 42, note: "R0001" }); // no odometer: L stays empty
assert.equal(r1.row, 5);
const r2 = appendRitlogRow(r1.bytes, { date: "2027-01-15", vehicle: "Cambio", type: "Privé", from: "Thuis", to: "Gent", client: "", km: 61.5, note: "R0002 - héllo", odometer: 48270 });
assert.equal(r2.row, 6);
const f1 = fillOdometers(r2.bytes, { 5: 1272, 6: 99999 }); // row 6 already filled: kept
assert.equal(f1.changed, 1);
assert.equal(fillOdometers(f1.bytes, { 5: 1 }).changed, 0);
writeFileSync(process.argv[2], f1.bytes);
console.log("xlsx tests ok, wrote", process.argv[2]);
