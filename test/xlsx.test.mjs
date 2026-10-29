import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { appendRitlogRow, excelSerial } from "../worker/src/xlsx.js";

assert.equal(excelSerial("2027-01-01"), 46388);
let bytes = new Uint8Array(readFileSync(new URL("./fixture.xlsx", import.meta.url)));
const r1 = appendRitlogRow(bytes, { date: "2027-01-14", vehicle: "Motor", type: "Zakelijk", from: "Thuis", to: "Proximus <Evere> & co", client: "Proximus", km: 42, note: "R0001" });
assert.equal(r1.row, 5);
const r2 = appendRitlogRow(r1.bytes, { date: "2027-01-15", vehicle: "Cambio", type: "Privé", from: "Thuis", to: "Gent", client: "", km: 61.5, note: "R0002 - héllo" });
assert.equal(r2.row, 6);
writeFileSync(process.argv[2], r2.bytes);
console.log("xlsx tests ok, wrote", process.argv[2]);
