// End-to-end test: real worker code + fake Google Drive/Google login/Anthropic, app driven by Playwright.
import http from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import assert from "node:assert/strict";

const realFetch = globalThis.fetch;
const readings = []; // queued odometer answers
let calendarCalls = 0;
const EXCEL = "/Ritlog/rekenmodule_auto_vs_motor_v4.xlsx";
const FOLDER = "application/vnd.google-apps.folder";

// Minimal fake of the Google Drive v3 API: items with ids, parents and versions.
const items = new Map(); // id -> {id, name, parents, mimeType, bytes, version, trashed}
let nextId = 1;
function addItem(name, parent, mimeType, bytes) {
  const id = "id" + nextId++;
  items.set(id, { id, name, parents: [parent], mimeType, bytes, version: "1", trashed: false });
  return items.get(id);
}
function pathOf(item) {
  const parts = [item.name];
  let p = item.parents[0];
  while (p !== "root") {
    const parent = items.get(p);
    parts.unshift(parent.name);
    p = parent.parents[0];
  }
  return "/" + parts.join("/");
}
const files = {
  keys: () => [...items.values()].filter((i) => !i.trashed && i.mimeType !== FOLDER).map(pathOf),
  get: (path) => [...items.values()].find((i) => !i.trashed && pathOf(i) === path),
  set: (path, { bytes }) => {
    const f = files.get(path);
    f.bytes = bytes;
    f.version = String(Number(f.version) + 1);
  },
};
const ritlogFolder = addItem("Ritlog", "root", FOLDER);
addItem("rekenmodule_auto_vs_motor_v4.xlsx", ritlogFolder.id, "application/octet-stream", new Uint8Array(readFileSync(new URL("./fixture.xlsx", import.meta.url))));

function resp(status, body, type = "application/json") {
  return new Response(typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body), { status, headers: { "Content-Type": type } });
}
function toBytes(body) {
  return body instanceof Uint8Array ? body : new TextEncoder().encode(body);
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  const method = (init.method || "GET").toUpperCase();
  if (url.host === "oauth2.googleapis.com") {
    return resp(200, { access_token: "at", refresh_token: "rt", scope: "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/calendar.readonly" });
  }
  if (url.host === "api.anthropic.com") {
    const next = readings.shift();
    const body = JSON.parse(init.body);
    assert.equal(body.messages[0].content[0].type, "image");
    return resp(200, {
      id: "msg_1", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn", stop_sequence: null,
      content: [{ type: "text", text: JSON.stringify(next) }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  }
  if (url.host === "www.googleapis.com" && url.pathname.startsWith("/calendar/v3/calendars/primary/events")) {
    // One meeting with a client, 30 minutes from now; served for the first ride only.
    const items = calendarCalls++ === 0
      ? [
          { id: "e1", status: "confirmed", summary: "Proximus workshop", location: "Evere",
            start: { dateTime: new Date(Date.now() + 30 * 60000).toISOString() }, end: { dateTime: new Date(Date.now() + 90 * 60000).toISOString() },
            attendees: [{ email: "roel@huawei.com", self: true, responseStatus: "accepted" }, { email: "jan@proximus.com" }, { email: "piet@huawei.com" }] },
          { id: "e2", status: "confirmed", summary: "Verjaardag", start: { date: "2026-01-01" }, end: { date: "2026-01-02" } },
        ]
      : [];
    return resp(200, { items });
  }
  if (url.host === "www.googleapis.com") {
    const path = url.pathname;
    let m;
    if (path === "/drive/v3/files" && method === "GET") {
      const qs = url.searchParams.get("q");
      const name = /name = '((?:[^'\\]|\\.)*)'/.exec(qs)[1].replace(/\\(.)/g, "$1");
      const parent = /'([^']+)' in parents/.exec(qs)[1];
      const folderOnly = qs.includes("mimeType");
      const found = [...items.values()].filter((i) => !i.trashed && i.name === name && i.parents.includes(parent) && (!folderOnly || i.mimeType === FOLDER));
      return resp(200, { files: found.map(({ id, name, version, mimeType }) => ({ id, name, version, mimeType })) });
    }
    if (path === "/drive/v3/files" && method === "POST") {
      const meta = JSON.parse(init.body);
      return resp(200, { id: addItem(meta.name, meta.parents[0], meta.mimeType).id });
    }
    if ((m = /^\/drive\/v3\/files\/([^/]+)$/.exec(path))) {
      const item = items.get(m[1]);
      if (!item) return resp(404, {});
      if (method === "GET" && url.searchParams.get("alt") === "media") return resp(200, item.bytes, "application/octet-stream");
      if (method === "GET") return resp(200, { parents: item.parents });
      if (method === "PATCH") {
        const meta = JSON.parse(init.body);
        if (meta.trashed) item.trashed = true;
        if (meta.name) item.name = meta.name;
        if (url.searchParams.get("addParents")) item.parents = [url.searchParams.get("addParents")];
        return resp(200, { id: item.id });
      }
    }
    if ((m = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(path)) && method === "PATCH") {
      const item = items.get(m[1]);
      item.bytes = toBytes(init.body);
      item.version = String(Number(item.version) + 1);
      return resp(200, { id: item.id, version: item.version });
    }
    if (path === "/upload/drive/v3/files" && method === "POST") {
      const boundary = /boundary=(\S+)/.exec(new Headers(init.headers).get("Content-Type"))[1];
      const raw = Buffer.from(init.body);
      const text = raw.toString("latin1");
      const jsonStart = text.indexOf("\r\n\r\n") + 4;
      const meta = JSON.parse(text.slice(jsonStart, text.indexOf(`\r\n--${boundary}`, jsonStart)));
      const second = text.indexOf(`--${boundary}`, jsonStart);
      const dataStart = text.indexOf("\r\n\r\n", second) + 4;
      const dataEnd = text.lastIndexOf(`\r\n--${boundary}--`);
      const item = addItem(meta.name, meta.parents[0], "application/octet-stream", new Uint8Array(raw.subarray(dataStart, dataEnd)));
      return resp(200, { id: item.id, version: item.version });
    }
    return resp(400, { error: `fake drive: unhandled ${method} ${path}` });
  }
  if (url.host === "nominatim.openstreetmap.org") {
    assert.match(new Headers(init.headers).get("User-Agent"), /Ritlog/);
    if (url.pathname === "/reverse") {
      const lat = Number(url.searchParams.get("lat"));
      const road = lat > 50.9 ? "Stationsstraat" : "Kerkstraat";
      return resp(200, { display_name: `${road} 1, Mechelen, Belgium`, address: { road, house_number: "1", town: "Mechelen", country: "België" } });
    }
    if (url.pathname === "/search") {
      return resp(200, [{ lat: "50.80000", lon: "4.40000", display_name: "Dorpsstraat 5, Kortenberg, Belgium", address: { road: "Dorpsstraat", village: "Kortenberg" } }]);
    }
  }
  return realFetch(input, init);
};

const worker = (await import("../worker/src/index.js")).default;
const kv = new Map();
const env = {
  APP_TOKEN: "secret-code",
  ANTHROPIC_API_KEY: "test",
  GOOGLE_CLIENT_ID: "cid",
  GOOGLE_CLIENT_SECRET: "cs",
  KV: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k) },
};

// Backend on :8787
const backend = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(`http://localhost:8787${req.url}`, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body });
  let response;
  try { response = await worker.fetch(request, env); } catch (e) { console.log("WORKER THREW", e); res.writeHead(500).end(); return; }
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(8787);

// Static app on :8080
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const appDir = new URL("../app/", import.meta.url).pathname;
const site = http.createServer((req, res) => {
  const p = join(appDir, req.url === "/" ? "index.html" : req.url.split("?")[0]);
  try {
    res.writeHead(200, { "Content-Type": types[extname(p)] || "application/octet-stream" });
    res.end(readFileSync(p));
  } catch {
    res.writeHead(404).end();
  }
}).listen(8080);

const { createRequire } = await import("node:module");
const require = createRequire(process.env.PLAYWRIGHT_FROM || import.meta.url);
const { chromium } = require("playwright");
const browser = await chromium.launch();
const HOME = { latitude: 50.8001, longitude: 4.4001 }; // ~15 m from the Home place found by search
const CLIENT = { latitude: 50.95, longitude: 4.47 };
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: process.env.DARK ? "dark" : "light", permissions: ["geolocation"], geolocation: HOME });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept());
page.on("response", async (r) => { if (r.status() >= 400) console.log("HTTP", r.status(), r.url(), await r.text().catch(() => "")); });
const photo = process.argv[2];
const snap = (name) => page.screenshot({ path: `${process.argv[3]}/${name}.png`, fullPage: true });
async function shoot(trigger) {
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click(trigger)]);
  await chooser.setFiles(photo);
}

// Connect Google Drive via the auth flow (callback simulated)
const start = await worker.fetch(new Request("http://localhost:8787/auth/start?key=secret-code"), env);
const state = new URL(start.headers.get("Location")).searchParams.get("state");
const cb = await worker.fetch(new Request(`http://localhost:8787/auth/callback?code=abc&state=${state}`), env);
assert.equal(cb.status, 200);

await page.goto("http://localhost:8080/");
await page.click("#toSettings");
await page.fill("#url", "http://localhost:8787");
await page.fill("#token", "secret-code");
await page.click("#save");
await page.waitForSelector("text=Google Drive connected");
await page.waitForSelector("text=Calendar connected.");
await page.fill("#zDomains", "syntra-ab.be, coachpraktijk.be");
await page.click("#calSave");
await page.waitForSelector("text=Calendar settings saved.");
const stCal = JSON.parse(new TextDecoder().decode(files.get("/Ritlog-app/state.json").bytes));
assert.deepEqual(stCal.settings.calendar.zelfstandigDomains, ["syntra-ab.be", "coachpraktijk.be"]);
assert.equal(stCal.settings.calendar.sources[0].calendarId, "primary");
await snap("1-settings");

// Register Motor and Auto (both new, near 0 km)
for (const [name, km, cls] of [["Motor", 30, "motorcycle"], ["Auto", 25, "car"]]) {
  await page.click('nav button[data-nav="vehicles"]');
  await page.click("#add");
  await page.selectOption("#name", name);
  readings.push({ readable: true, odometer_km: km, unit: "km", dashboard_class: cls, confidence: "high", note: "" });
  await shoot("#photo");
  await page.waitForSelector("#save");
  await page.click("#save");
  await page.waitForSelector(`text=Last reading ${km} km`);
}
await snap("2-vehicles");

// Add Home as a known place via address search
await page.click('nav button[data-nav="places"]');
await page.click("#add");
await page.fill("#name", "Home");
await page.selectOption("#cat", "Home");
await page.fill("#q", "Dorpsstraat 5 Kortenberg");
await page.click("#search");
await page.click("button.result");
assert.equal(await page.textContent("#loc"), "Dorpsstraat, Kortenberg");
await page.click("#save");
await page.waitForSelector("text=radius 300 m");
await snap("2b-places");

// Ride on the Motor: reading 30 with motorcycle dashboard -> Motor proposed (Auto range overlaps)
await page.click('nav button[data-nav="home"]');
readings.push({ readable: true, odometer_km: 30, unit: "km", dashboard_class: "motorcycle", confidence: "high", note: "" });
await shoot("#startRide");
await page.waitForSelector("#go");
assert.match(await page.locator("#vehicle option:checked").textContent(), /^Motor/);
await snap("3-start");
await page.click("#go");
await page.waitForSelector("text=without an end photo");
await snap("4-open");

await context.setGeolocation(CLIENT);
readings.push({ readable: true, odometer_km: 72, unit: "km", dashboard_class: "motorcycle", confidence: "high", note: "" });
await shoot("[data-end]");
await page.waitForSelector("#save");
assert.equal(await page.textContent("#km"), "42 km");
assert.equal(await page.inputValue("#from"), "Home"); // known place
assert.equal(await page.inputValue("#to"), "Proximus"); // unknown place, named after the meeting's client
assert.equal(await page.inputValue("#type"), "Zakelijk"); // from the calendar
assert.equal(await page.inputValue("#client"), "Proximus"); // attendee domain, huawei.com ignored
await page.waitForSelector("text=Proximus workshop");
assert.ok(await page.isVisible("text=Name from the meeting."));
await page.check("#np-to");
assert.equal(await page.inputValue("#np-to-cat"), "Client");
assert.equal(await page.inputValue("#np-to-type"), "Zakelijk");
await page.fill("#to", "Proximus Evere");
await snap("5-end");
await page.click("#save");
await page.waitForSelector("text=Excel row 5");
await snap("6-home");

// Cambio: unknown car odometer, starts at the new client place, ends at Home
const stAfter1 = JSON.parse(new TextDecoder().decode(files.get("/Ritlog-app/state.json").bytes));
assert.deepEqual(stAfter1.places.map((p) => [p.name, p.category, p.defaultType]).sort(), [["Home", "Home", ""], ["Proximus Evere", "Client", "Zakelijk"]]);
assert.deepEqual(stAfter1.places.find((p) => p.name === "Proximus Evere").domains, ["proximus.com"]);
assert.ok(stAfter1.rides[0].startLocation && stAfter1.rides[0].endLocation);
readings.push({ readable: true, odometer_km: 48211, unit: "km", dashboard_class: "car", confidence: "high", note: "" });
await shoot("#startRide");
await page.waitForSelector("#go");
assert.equal((await page.locator("#vehicle option:checked").textContent()).trim(), "Cambio");
await page.click("#go");
await page.waitForSelector("[data-end]");
await context.setGeolocation(HOME);
readings.push({ readable: true, odometer_km: 48270, unit: "km", dashboard_class: "car", confidence: "high", note: "" });
await shoot("[data-end]");
await page.waitForSelector("#save");
assert.equal(await page.inputValue("#from"), "Proximus Evere");
assert.equal(await page.inputValue("#to"), "Home");
assert.equal(await page.inputValue("#type"), "Zakelijk"); // from the client place's default type
assert.ok(await page.isVisible("#mixedRow")); // 59 km for ~17 km straight line
assert.ok(await page.isChecked("#mixed"));
assert.equal(await page.locator("#np-to").count(), 0); // known place: no save option
await page.selectOption("#type", "Privé");
assert.ok(await page.isHidden("#mixedRow")); // only for Zakelijk
await page.fill("#note", "check invoice");
await page.click("#save");
await page.waitForSelector("text=Excel row 6");

// Checks on the fake Google Drive
const names = [...files.keys()].sort();
assert.ok(names.some((n) => /\/Ritlog-fotos\/\d{4}\/\d{2}\/R0001_\d{4}-\d{2}-\d{2}_\d{4}_Motor_Zakelijk_Home-ProximusEvere_start\.jpg$/.test(n)));
assert.ok(names.some((n) => /R0001_.*_end\.jpg$/.test(n)));
assert.ok(names.some((n) => /R0002_.*_Cambio_Prive_ProximusEvere-Home_start\.jpg$/.test(n)));
assert.ok(!names.some((n) => n.includes("_pending")));
const st = JSON.parse(new TextDecoder().decode(files.get("/Ritlog-app/state.json").bytes));
assert.equal(st.vehicles.find((v) => v.name === "Motor").lastReading, 72);
assert.equal(st.rides.length, 2);

// Retry must not duplicate rows
st.rides[0].excel = "pending";
files.set("/Ritlog-app/state.json", { bytes: new TextEncoder().encode(JSON.stringify(st)) });
const retry = await worker.fetch(new Request("http://localhost:8787/api/excel/retry", { method: "POST", headers: { Authorization: "Bearer secret-code" }, body: "{}" }), env);
const retryJson = await retry.json();
assert.equal(retryJson.state.rides[0].excelRow, 5);

// Wrong token rejected
const bad = await worker.fetch(new Request("http://localhost:8787/api/state", { headers: { Authorization: "Bearer nope" } }), env);
assert.equal(bad.status, 401);

// Forgotten start photo: start photo shows 90, Motor's last recorded reading is 72
await page.reload();
await page.waitForSelector("#startRide");
readings.push({ readable: true, odometer_km: 90, unit: "km", dashboard_class: "motorcycle", confidence: "high", note: "" });
await shoot("#startRide");
await page.waitForSelector("#go");
await page.click("#go");
await page.waitForSelector("text=18 km not logged");
await snap("7-gap-choice");
await page.click("#asEnd");
await page.waitForSelector("#save");
assert.equal(await page.textContent("#km"), "18 km");
assert.equal(await page.inputValue("#from"), "Proximus Evere"); // end place of the previous Motor ride
assert.equal(await page.inputValue("#to"), "Home");
assert.ok(await page.isHidden("#retake"));
await snap("8-end-no-start");
await page.click("#save");
await page.waitForSelector("text=Excel row 7");

// Unlogged ride: start photo shows 100, last recorded 90
readings.push({ readable: true, odometer_km: 100, unit: "km", dashboard_class: "motorcycle", confidence: "high", note: "" });
await shoot("#startRide");
await page.waitForSelector("#go");
await page.click("#go");
await page.waitForSelector("text=10 km not logged");
await page.click("#asGap");
assert.equal(await page.inputValue("#gapType"), "Privé");
await page.click("#gapSave");
await page.waitForSelector("text=without an end photo");
const st2 = JSON.parse(new TextDecoder().decode(files.get("/Ritlog-app/state.json").bytes));
const noStart = st2.rides.find((r) => r.id === "R0003");
assert.equal(noStart.km, 18);
assert.equal(noStart.photos.length, 1);
const gap = st2.rides.find((r) => r.id === "R0004");
assert.deepEqual([gap.km, gap.type, gap.gap, gap.excelRow], [10, "Privé", true, 8]);
assert.equal(st2.openRides[0].startReading, 100);
assert.equal(st2.vehicles.find((v) => v.name === "Motor").lastReading, 100);

// Column L holds the odometer reading at the end of each ride
const { unzipSync, strFromU8 } = await import("../worker/node_modules/fflate/esm/index.mjs");
const sheetXml = strFromU8(unzipSync(files.get(EXCEL).bytes)["xl/worksheets/sheet7.xml"]);
const odo = (n) => /<c r="L\d+"[^>]*><v>(\d+)<\/v>/.exec(/<row r="\d+"[^>]*>[\s\S]*?<\/row>/g[Symbol.match](sheetXml).find((r) => r.startsWith(`<row r="${n}"`)))?.[1];
assert.deepEqual([5, 6, 7, 8].map(odo), ["72", "48270", "90", "100"]);
assert.match(sheetXml, /<c r="L4"[^>]*t="inlineStr"><is><t[^>]*>Km-stand</);

writeFileSync(`${process.argv[3]}/result.xlsx`, files.get(EXCEL).bytes);
assert.deepEqual(errors, []);
await browser.close();
backend.close();
site.close();
console.log("e2e ok");
