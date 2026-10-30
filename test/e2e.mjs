// End-to-end test: real worker code + fake Google Drive/Google login/Anthropic, app driven by Playwright.
import http from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import assert from "node:assert/strict";

const realFetch = globalThis.fetch;
const readings = []; // queued odometer answers
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
    return resp(200, { access_token: "at", refresh_token: "rt" });
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
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
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
await snap("1-settings");

// Register Motor and Auto (both new, near 0 km)
for (const [name, km, cls] of [["Motor", 12, "motorcycle"], ["Auto", 25, "car"]]) {
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

readings.push({ readable: true, odometer_km: 72, unit: "km", dashboard_class: "motorcycle", confidence: "high", note: "" });
await shoot("[data-end]");
await page.waitForSelector("#save");
assert.equal(await page.textContent("#km"), "42 km");
await page.selectOption("#type", "Zakelijk");
await page.fill("#from", "Home");
await page.fill("#to", "Proximus Evere");
await page.fill("#client", "Proximus");
await snap("5-end");
await page.click("#save");
await page.waitForSelector("text=Excel row 5");
await snap("6-home");

// Cambio: unknown car odometer
readings.push({ readable: true, odometer_km: 48211, unit: "km", dashboard_class: "car", confidence: "high", note: "" });
await shoot("#startRide");
await page.waitForSelector("#go");
assert.equal((await page.locator("#vehicle option:checked").textContent()).trim(), "Cambio");
await page.click("#go");
await page.waitForSelector("[data-end]");
readings.push({ readable: true, odometer_km: 48270, unit: "km", dashboard_class: "car", confidence: "high", note: "" });
await shoot("[data-end]");
await page.waitForSelector("#save");
await page.selectOption("#type", "Privé");
await page.fill("#note", "check invoice");
await page.click("#save");
await page.waitForSelector("text=Excel row 6");

// Checks on the fake Google Drive
const names = [...files.keys()].sort();
assert.ok(names.some((n) => /\/Ritlog-fotos\/\d{4}\/\d{2}\/R0001_\d{4}-\d{2}-\d{2}_\d{4}_Motor_Zakelijk_Home-ProximusEvere_start\.jpg$/.test(n)));
assert.ok(names.some((n) => /R0001_.*_end\.jpg$/.test(n)));
assert.ok(names.some((n) => /R0002_.*_Cambio_Prive_Unknown-Unknown_start\.jpg$/.test(n)));
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

writeFileSync(`${process.argv[3]}/result.xlsx`, files.get(EXCEL).bytes);
assert.deepEqual(errors, []);
await browser.close();
backend.close();
site.close();
console.log("e2e ok");
