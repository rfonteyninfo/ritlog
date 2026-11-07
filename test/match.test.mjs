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

// ---------- places ----------
const { distanceM, nearestPlace, proposeType } = await import("../app/match.js");
const home = { id: "h", name: "Home", lat: 51.0, lon: 4.4, radius: 300, defaultType: "" };
const office = { id: "o", name: "Huawei", lat: 51.01, lon: 4.4, radius: 300, defaultType: "Zakelijk" };
assert.ok(Math.abs(distanceM(home, office) - 1112) < 5);
assert.equal(nearestPlace([home, office], { lat: 51.001, lon: 4.4, accuracy: 20 }).place.name, "Home");
assert.equal(nearestPlace([home, office], { lat: 51.005, lon: 4.4, accuracy: 20 }), null);
assert.equal(nearestPlace([home], { lat: 51.0035, lon: 4.4, accuracy: 100 }).place.name, "Home"); // 389 m, within 300+100
assert.equal(nearestPlace([home], null), null);
assert.equal(proposeType(home, office), "Zakelijk");
assert.equal(proposeType(office, home), "Zakelijk");
assert.equal(proposeType(null, null), "Privé");
console.log("places tests ok");

// ---------- calendar rules ----------
const { DEFAULT_CALENDAR: R, nameFromDomain, eventType, eventClient, pickEvent, isPendel, proposeRideType, looksMixed } = await import("../app/match.js");
const ev = (o) => ({ summary: "", domains: [], allDay: false, declined: false, sourceType: "", ...o });
assert.equal(nameFromDomain("proximus.com"), "Proximus");
assert.equal(nameFromDomain("mail.syntra-ab.be"), "Syntra-ab");
assert.equal(eventType(ev({ domains: ["syntra-ab.be"] }), R), "Zelfstandig");
assert.equal(eventType(ev({ summary: "Les Syntra Mechelen" }), R), "Zelfstandig");
assert.equal(eventType(ev({ domains: ["huawei.com"] }), R), "Zakelijk");
assert.equal(eventType(ev({ domains: ["proximus.com", "huawei.com"] }), R), "Zakelijk");
assert.equal(eventType(ev({ domains: ["gmail.com"] }), R), "");
assert.equal(eventType(ev({ summary: "Tandarts" }), R), "");
assert.equal(eventType(ev({ sourceType: "Fun", domains: ["proximus.com"] }), R), "Fun");
assert.equal(eventClient(ev({ domains: ["huawei.com", "proximus.com"] }), R), "Proximus");
assert.equal(eventClient(ev({ domains: ["huawei.com"], summary: "Team meeting" }), R), "Team meeting");

const t = (h, m = 0) => new Date(2027, 0, 12, h, m); // Tuesday
const iso = (d) => d.toISOString();
const meeting = ev({ summary: "Proximus workshop", domains: ["proximus.com"], start: iso(t(10)), end: iso(t(12)) });
const dentist = ev({ summary: "Tandarts", start: iso(t(9, 40)), end: iso(t(10, 10)) });
let p = pickEvent([meeting, dentist], t(9), t(9, 45), R); // arrive 9:45, meeting at 10:00
assert.equal(p.event.summary, "Proximus workshop"); // typed meeting beats closer untyped one
assert.deepEqual([p.type, p.client, p.relation], ["Zakelijk", "Proximus", "to"]);
p = pickEvent([meeting], t(12, 20), t(13), R); // ride back after the meeting
assert.equal(p.relation, "from");
assert.equal(pickEvent([meeting], t(14), t(15), R), null); // meeting ended 2 h before departure
assert.equal(pickEvent([{ ...meeting, declined: true }], t(9), t(9, 45), R), null);
assert.equal(pickEvent([{ ...meeting, allDay: true }], t(9), t(9, 45), R), null);

const homeP = { category: "Home", defaultType: "" }, workP = { category: "Work", defaultType: "Zakelijk" };
assert.equal(isPendel(homeP, workP, t(8)), true);
assert.equal(isPendel(workP, homeP, new Date(2027, 0, 16, 8)), false); // Saturday
assert.equal(proposeRideType({ calendarType: "Zelfstandig", fromPlace: homeP, toPlace: workP, date: t(8) }).type, "Zelfstandig");
assert.equal(proposeRideType({ calendarType: "", fromPlace: homeP, toPlace: workP, date: t(8) }).type, "Pendel");
assert.equal(proposeRideType({ calendarType: "", fromPlace: null, toPlace: workP, date: new Date(2027, 0, 16) }).type, "Zakelijk");
assert.equal(proposeRideType({ calendarType: "", fromPlace: null, toPlace: null, date: t(8) }).type, "Privé");

const a = { lat: 51.0, lon: 4.4 }, b = { lat: 51.1, lon: 4.4 }; // ~11.1 km apart
assert.equal(looksMixed(25, a, b, R), false); // 25 <= 2*11.1+5
assert.equal(looksMixed(30, a, b, R), true);
assert.equal(looksMixed(30, a, null, R), false);
console.log("calendar rules tests ok");
