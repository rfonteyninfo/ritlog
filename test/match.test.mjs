import assert from "node:assert/strict";
import { proposeVehicle, checkEndReading } from "../app/match.js";
import { photoName, slug, rideId } from "../worker/src/naming.js";

const now = new Date(2027, 2, 10, 9, 0);
const motor = { id: "m", name: "Motor", class: "motorcycle", active: true, lastReading: 120, lastReadingAt: "2027-03-09 18:00" };
const auto = { id: "a", name: "Auto", class: "car", active: true, lastReading: 150, lastReadingAt: "2027-03-09 18:00" };
const vespa = { id: "v", name: "Vespa", class: "scooter", active: true, lastReading: 950, lastReadingAt: "2027-03-01 18:00" };
const all = [motor, auto, vespa];

// Overlapping ranges (both new): dashboard class decides
assert.equal(proposeVehicle(all, 160, "motorcycle", { now }).name, "Motor");
assert.equal(proposeVehicle(all, 160, "car", { now }).name, "Auto");
// Scooter fits by range and class
const v = proposeVehicle(all, 1000, "scooter", { now });
assert.equal(v.name, "Vespa");
assert.equal(v.confident, true);
// Car dashboard that fits nothing -> Cambio
assert.equal(proposeVehicle(all, 48211, "car", { now }).name, "Cambio");
// Motorcycle that fits nothing -> ask
assert.equal(proposeVehicle(all, 48211, "motorcycle", { now }).name, null);
// Retired vehicles ignored
assert.equal(proposeVehicle([{ ...motor, active: false }], 125, "motorcycle", { now }).name, null);
// Unreadable
assert.equal(proposeVehicle(all, -1, "car", { now }).name, null);

assert.equal(checkEndReading(100, 90, "2027-03-10 08:00", now), "End reading is lower than the start (100).");
assert.equal(checkEndReading(100, 142, "2027-03-10 08:00", now), null);
assert.match(checkEndReading(100, 2000, "2027-03-10 08:00", now), /More than expected/);

assert.equal(slug("Huawei Mechelen"), "HuaweiMechelen");
assert.equal(slug("Privé"), "Prive");
assert.equal(rideId(142), "R0142");
assert.equal(
  photoName({ id: "R0142", date: "2027-01-14", time: "08:12", vehicle: "Motor", type: "Zakelijk", from: "Home", to: "Proximus Evere" }, "start"),
  "R0142_2027-01-14_0812_Motor_Zakelijk_Home-ProximusEvere_start.jpg"
);
console.log("match + naming tests ok");
