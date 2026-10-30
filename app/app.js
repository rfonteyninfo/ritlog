import { proposeVehicle, checkEndReading } from "./match.js";

const DEFAULT_CLASS = { Auto: "car", Motor: "motorcycle", Vespa: "scooter" };
const view = document.getElementById("view");
const camera = document.getElementById("camera");

let app = {
  settings: loadSettings(),
  state: readCache("state"),
  config: readCache("config"),
};

// ---------- storage ----------

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem("ritlog.settings")) || {};
  } catch {
    return {};
  }
}
function saveSettings(s) {
  app.settings = s;
  try { localStorage.setItem("ritlog.settings", JSON.stringify(s)); } catch {}
}
function readCache(key) {
  try { return JSON.parse(localStorage.getItem(`ritlog.${key}`)); } catch { return null; }
}
function writeCache(key, value) {
  try { localStorage.setItem(`ritlog.${key}`, JSON.stringify(value)); } catch {}
}

// ---------- api ----------

async function api(path, body) {
  const { workerUrl, token } = app.settings;
  if (!workerUrl || !token) throw new Error("Set the backend URL and access code in Settings first.");
  const res = await fetch(workerUrl.replace(/\/$/, "") + path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  if (data.state) setState(data.state);
  if (data.config) setConfig(data.config);
  return data;
}

function setState(state) {
  app.state = state;
  writeCache("state", state);
}
function setConfig(config) {
  app.config = config;
  writeCache("config", config);
}

// ---------- utils ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
function nowLocal() {
  const d = new Date();
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}
function fmtDate(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function toast(msg, ms = 3500) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}

function busy(msg) {
  view.innerHTML = `<div class="spinner">${esc(msg)}</div>`;
}

// Opens the camera and returns a compressed JPEG data URL (max 1600 px).
function takePhoto() {
  return new Promise((resolve, reject) => {
    camera.value = "";
    camera.onchange = async () => {
      const file = camera.files[0];
      if (!file) return reject(new Error("No photo taken"));
      try {
        resolve(await compress(file));
      } catch (e) {
        reject(e);
      }
    };
    camera.click();
  });
}

async function compress(file, maxSide = 1600, quality = 0.8) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

async function readOdometer(image) {
  busy("Reading odometer…");
  try {
    return await api("/api/odometer", { image });
  } catch (e) {
    toast(`Could not read the photo: ${e.message}`);
    return { readable: false, odometer_km: -1, dashboard_class: "unknown", confidence: "low", note: "" };
  }
}

function activeVehicles() {
  return (app.state?.vehicles || []).filter((v) => v.active);
}

// ---------- screens ----------

const routes = { home: renderHome, vehicles: renderVehicles, settings: renderSettings };

function go(name) {
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("active", b.dataset.nav === name));
  routes[name]();
}

document.querySelectorAll("nav button").forEach((b) => (b.onclick = () => go(b.dataset.nav)));

function renderHome() {
  const s = app.state;
  if (!app.settings.workerUrl || !app.settings.token) {
    view.innerHTML = `<div class="banner warn">Set up the backend first.</div><button class="big" id="toSettings">Open Settings</button>`;
    view.querySelector("#toSettings").onclick = () => go("settings");
    return;
  }
  if (!s) {
    busy("Loading…");
    refresh();
    return;
  }

  const pendingExcel = s.rides.filter((r) => r.excel === "pending");
  const vehicles = activeVehicles();
  let out = "";

  if (s.openRides.length) {
    out += `<div class="banner warn"><b>${s.openRides.length} ride(s) without an end photo.</b> Finish or cancel them below.</div>`;
  }
  if (pendingExcel.length) {
    const err = pendingExcel.find((r) => r.excelError)?.excelError;
    out += `<div class="banner error"><b>${pendingExcel.length} ride(s) not yet in Excel.</b>${err ? `<div class="muted">${esc(err)}</div>` : ""}
      <div class="actions"><button class="btn primary" id="retryExcel">Retry</button></div></div>`;
  }

  out += vehicles.length
    ? `<button class="big" id="startRide">Start ride</button>`
    : `<div class="banner warn">Register your vehicles first.</div><button class="big" id="toVehicles">Register a vehicle</button>`;

  if (s.openRides.length) {
    out += `<h2>Open rides</h2>`;
    for (const r of s.openRides) {
      out += `<div class="card"><div class="row"><b>${esc(r.id)} · ${esc(r.vehicle)}</b><span class="muted">${fmtDate(r.date)} ${esc(r.startTime)}</span></div>
        <div class="muted">Start: ${r.startReading} km</div>
        <div class="actions"><button class="btn primary" data-end="${esc(r.id)}">End ride</button><button class="btn" data-cancel="${esc(r.id)}">Cancel</button></div></div>`;
    }
  }

  const recent = s.rides.slice(-10).reverse();
  out += `<h2>Recent rides</h2>`;
  if (!recent.length) out += `<p class="muted">No rides yet.</p>`;
  for (const r of recent) {
    const status = r.excel === "written" ? `<span class="chip ok">Excel row ${r.excelRow}</span>` : `<span class="chip">Not in Excel</span>`;
    out += `<div class="card"><div class="row"><b>${esc(r.id)} · ${esc(r.vehicle)} · ${esc(r.type)}</b><b>${r.km} km</b></div>
      <div class="muted">${fmtDate(r.date)} ${esc(r.time)} · ${esc(r.from || "?")} → ${esc(r.to || "?")}${r.client ? ` · ${esc(r.client)}` : ""}</div>
      <div style="margin-top:4px">${status}</div></div>`;
  }
  view.innerHTML = out;

  view.querySelector("#startRide")?.addEventListener("click", startRide);
  view.querySelector("#toVehicles")?.addEventListener("click", () => go("vehicles"));
  view.querySelector("#retryExcel")?.addEventListener("click", async () => {
    busy("Writing to Excel…");
    try {
      const res = await api("/api/excel/retry", {});
      toast(res.excel.error ? res.excel.error : `Written: ${res.excel.written}`);
    } catch (e) {
      toast(e.message);
    }
    renderHome();
  });
  view.querySelectorAll("[data-end]").forEach((b) => (b.onclick = () => endRide(b.dataset.end)));
  view.querySelectorAll("[data-cancel]").forEach((b) => (b.onclick = () => cancelRide(b.dataset.cancel)));
}

async function refresh() {
  try {
    await api("/api/state");
  } catch (e) {
    toast(e.message);
    if (!app.state) setState({ version: 1, nextRideNo: 1, vehicles: [], openRides: [], rides: [], settings: {} });
  }
  renderHome();
}

// ----- start ride -----

async function startRide() {
  let image;
  try {
    image = await takePhoto();
  } catch {
    return;
  }
  const ocr = await readOdometer(image);
  const vehicles = activeVehicles();
  const cambio = app.config?.cambioName || "Cambio";
  const reading = ocr.readable ? ocr.odometer_km : -1;
  const proposal = proposeVehicle(vehicles, reading, ocr.dashboard_class, {
    maxKmPerDay: app.state.settings?.maxKmPerDay || 600,
    cambioName: cambio,
  });

  const options = vehicles
    .map((v) => `<option value="${esc(v.id)}" ${proposal.vehicleId === v.id ? "selected" : ""}>${esc(v.name)} (last ${v.lastReading} km)</option>`)
    .join("");
  view.innerHTML = `
    <h2>Start ride</h2>
    <img class="preview" src="${image}" alt="Odometer photo">
    <label>Odometer (km)</label>
    <input class="reading" id="reading" type="number" inputmode="numeric" value="${reading >= 0 ? reading : ""}">
    <div class="muted">${ocr.readable ? `Read with ${esc(ocr.confidence)} confidence.` : "Could not read the number. Type it."} ${esc(ocr.note || "")}</div>
    <label>Vehicle</label>
    <select id="vehicle">
      <option value="" ${!proposal.name ? "selected" : ""} disabled>Choose…</option>
      ${options}
      <option value="cambio" ${proposal.name === cambio && !proposal.vehicleId ? "selected" : ""}>${esc(cambio)}</option>
    </select>
    <div class="muted" id="reason">${esc(proposal.reason)}</div>
    <div class="actions">
      <button class="btn primary" id="go">Start ride</button>
      <button class="btn" id="retake">Retake photo</button>
      <button class="btn" id="back">Cancel</button>
    </div>`;

  view.querySelector("#back").onclick = renderHome;
  view.querySelector("#retake").onclick = startRide;
  view.querySelector("#go").onclick = async () => {
    const value = Number(view.querySelector("#reading").value);
    const sel = view.querySelector("#vehicle").value;
    if (!view.querySelector("#reading").value || !(value >= 0)) return toast("Enter the odometer reading.");
    if (!sel) return toast("Choose the vehicle.");
    const isCambio = sel === "cambio";
    const vehicle = isCambio ? null : vehicles.find((v) => v.id === sel);
    if (vehicle && value < vehicle.lastReading - 2 && !confirm(`${value} km is lower than the last known reading of ${vehicle.name} (${vehicle.lastReading} km). Start anyway?`)) return;
    const { date, time } = nowLocal();
    busy("Saving start…");
    try {
      const res = await api("/api/rides/start", {
        vehicle: isCambio ? cambio : vehicle.name,
        vehicleId: isCambio ? null : vehicle.id,
        reading: value,
        date,
        time,
        image,
      });
      toast(`Ride ${res.ride.id} started.`);
    } catch (e) {
      toast(e.message, 6000);
    }
    renderHome();
  };
}

// ----- end ride -----

async function endRide(id) {
  const ride = app.state.openRides.find((r) => r.id === id);
  if (!ride) return renderHome();
  let image;
  try {
    image = await takePhoto();
  } catch {
    return;
  }
  const ocr = await readOdometer(image);
  const reading = ocr.readable ? ocr.odometer_km : "";
  const types = app.config?.rideTypes || ["Zakelijk", "Pendel", "Privé", "Fun", "Zelfstandig"];

  view.innerHTML = `
    <h2>End ride ${esc(ride.id)} · ${esc(ride.vehicle)}</h2>
    <img class="preview" src="${image}" alt="Odometer photo">
    <label>Odometer (km) · start was ${ride.startReading}</label>
    <input class="reading" id="reading" type="number" inputmode="numeric" value="${reading}">
    <div class="muted">${ocr.readable ? `Read with ${esc(ocr.confidence)} confidence.` : "Could not read the number. Type it."} ${esc(ocr.note || "")}</div>
    <div class="km" id="km"></div>
    <div class="muted" id="kmWarn"></div>
    <label>Type</label>
    <select id="type"><option value="" selected disabled>Choose…</option>${types.map((t) => `<option>${esc(t)}</option>`).join("")}</select>
    <label>From</label><input id="from" autocomplete="off">
    <label>To</label><input id="to" autocomplete="off">
    <label>Client / purpose</label><input id="client" autocomplete="off">
    <label>Note</label><input id="note" autocomplete="off">
    <div class="actions">
      <button class="btn primary" id="save">Save ride</button>
      <button class="btn" id="retake">Retake photo</button>
      <button class="btn" id="back">Back</button>
    </div>`;

  const input = view.querySelector("#reading");
  const updateKm = () => {
    const v = Number(input.value);
    const warn = input.value ? checkEndReading(ride.startReading, v, `${ride.date} ${ride.startTime}`, new Date(), app.state.settings?.maxKmPerDay || 600) : "Enter the odometer reading.";
    view.querySelector("#km").textContent = input.value && v >= ride.startReading ? `${v - ride.startReading} km` : "";
    view.querySelector("#kmWarn").textContent = warn || "";
  };
  input.oninput = updateKm;
  updateKm();

  view.querySelector("#back").onclick = renderHome;
  view.querySelector("#retake").onclick = () => endRide(id);
  view.querySelector("#save").onclick = async () => {
    const v = Number(input.value);
    if (!input.value || v < ride.startReading) return toast("Check the odometer reading.");
    const type = view.querySelector("#type").value;
    if (!type) return toast("Choose the type.");
    const warn = checkEndReading(ride.startReading, v, `${ride.date} ${ride.startTime}`, new Date(), app.state.settings?.maxKmPerDay || 600);
    if (warn && !confirm(`${warn}\nSave anyway?`)) return;
    const val = (sel) => view.querySelector(sel).value.trim();
    const payload = { reading: v, time: nowLocal().time, image, type, from: val("#from"), to: val("#to"), client: val("#client"), note: val("#note") };
    busy("Saving ride…");
    try {
      const res = await api(`/api/rides/${encodeURIComponent(id)}/finish`, payload);
      toast(res.excel?.error ? `Saved ${id}, but not in Excel yet: ${res.excel.error}` : `Saved ${id}: ${res.ride.km} km, Excel row ${res.ride.excelRow}.`, 6000);
    } catch (e) {
      toast(e.message, 6000);
    }
    renderHome();
  };
}

async function cancelRide(id) {
  if (!confirm(`Cancel ride ${id}? The start photo is deleted.`)) return;
  busy("Cancelling…");
  try {
    await api(`/api/rides/${encodeURIComponent(id)}/cancel`, {});
  } catch (e) {
    toast(e.message);
  }
  renderHome();
}

// ----- vehicles -----

function renderVehicles() {
  const all = app.state?.vehicles || [];
  const active = all.filter((v) => v.active);
  const retired = all.filter((v) => !v.active);
  let out = `<button class="big" id="add">Register vehicle</button><h2>Your vehicles</h2>`;
  if (!active.length) out += `<p class="muted">None registered.</p>`;
  for (const v of active) {
    out += `<div class="card"><div class="row"><b>${esc(v.name)}</b><span class="chip">${esc(v.class)}</span></div>
      <div class="muted">Last reading ${v.lastReading} km (${esc(v.lastReadingAt)}) · registered ${esc(v.registeredAt)} at ${v.startReading} km</div>
      <div class="actions"><button class="btn" data-retire="${esc(v.id)}">Retire</button></div></div>`;
  }
  if (retired.length) {
    out += `<h2>Retired</h2>`;
    for (const v of retired) out += `<div class="card muted">${esc(v.name)} · ${esc(v.class)} · last ${v.lastReading} km</div>`;
  }
  out += `<p class="muted">Cambio is built in and needs no registration.</p>`;
  view.innerHTML = out;
  view.querySelector("#add").onclick = registerVehicle;
  view.querySelectorAll("[data-retire]").forEach(
    (b) =>
      (b.onclick = async () => {
        if (!confirm("Retire this vehicle? It is no longer proposed for new rides.")) return;
        busy("Saving…");
        try {
          await api(`/api/vehicles/${b.dataset.retire}/deactivate`, {});
        } catch (e) {
          toast(e.message);
        }
        renderVehicles();
      })
  );
}

async function registerVehicle() {
  const names = app.config?.vehicleNames || ["Auto", "Motor", "Vespa"];
  view.innerHTML = `
    <h2>Register vehicle</h2>
    <label>Name (as in the Lijsten tab)</label>
    <select id="name">${names.map((n) => `<option>${esc(n)}</option>`).join("")}</select>
    <label>Type of vehicle</label>
    <select id="class"><option value="car">Car</option><option value="motorcycle">Motorcycle</option><option value="scooter">Scooter</option></select>
    <p class="muted">Next: take a photo of the odometer.</p>
    <div class="actions"><button class="btn primary" id="photo">Take odometer photo</button><button class="btn" id="back">Cancel</button></div>`;
  const nameSel = view.querySelector("#name");
  const classSel = view.querySelector("#class");
  const syncClass = () => (classSel.value = DEFAULT_CLASS[nameSel.value] || classSel.value);
  nameSel.onchange = syncClass;
  syncClass();
  view.querySelector("#back").onclick = renderVehicles;
  view.querySelector("#photo").onclick = async () => {
    const name = nameSel.value;
    const cls = classSel.value;
    let image;
    try {
      image = await takePhoto();
    } catch {
      return;
    }
    const ocr = await readOdometer(image);
    const replacing = activeVehicles().find((v) => v.name === name);
    view.innerHTML = `
      <h2>Register ${esc(name)}</h2>
      <img class="preview" src="${image}" alt="Odometer photo">
      <label>Odometer (km)</label>
      <input class="reading" id="reading" type="number" inputmode="numeric" value="${ocr.readable ? ocr.odometer_km : ""}">
      <div class="muted">${ocr.readable ? `Read with ${esc(ocr.confidence)} confidence. Dashboard looks like: ${esc(ocr.dashboard_class)}.` : "Could not read the number. Type it."}</div>
      ${replacing ? `<div class="banner warn">This replaces the current ${esc(name)} (last ${replacing.lastReading} km). The old one is retired.</div>` : ""}
      <div class="actions"><button class="btn primary" id="save">Register</button><button class="btn" id="back">Cancel</button></div>`;
    view.querySelector("#back").onclick = renderVehicles;
    view.querySelector("#save").onclick = async () => {
      const val = view.querySelector("#reading").value;
      if (!val || !(Number(val) >= 0)) return toast("Enter the odometer reading.");
      busy("Registering…");
      try {
        await api("/api/vehicles", { name, class: cls, reading: Number(val), image, ...nowLocal() });
        toast(`${name} registered.`);
      } catch (e) {
        toast(e.message, 6000);
      }
      renderVehicles();
    };
  };
}

// ----- settings -----

async function renderSettings() {
  const s = app.settings;
  view.innerHTML = `
    <h2>Backend</h2>
    <label>Backend URL (Cloudflare Worker)</label>
    <input id="url" type="url" placeholder="https://ritlog.yourname.workers.dev" value="${esc(s.workerUrl || "")}">
    <label>Access code</label>
    <input id="token" type="password" value="${esc(s.token || "")}">
    <div class="actions"><button class="btn primary" id="save">Save and test</button></div>
    <div id="status" class="muted" style="margin-top:10px"></div>
    <h2>Google Drive</h2>
    <p class="muted">Connect once. The backend keeps access to your Google Drive files.</p>
    <a class="btn" id="connect" target="_blank" rel="noopener">Connect Google Drive</a>`;
  const connect = view.querySelector("#connect");
  const setLink = () => {
    const u = view.querySelector("#url").value.replace(/\/$/, "");
    connect.href = u ? `${u}/auth/start?key=${encodeURIComponent(view.querySelector("#token").value)}` : "#";
  };
  view.querySelector("#url").oninput = setLink;
  view.querySelector("#token").oninput = setLink;
  setLink();
  const status = view.querySelector("#status");
  const test = async () => {
    if (!app.settings.workerUrl) return;
    status.textContent = "Testing…";
    try {
      const res = await api("/api/status");
      status.innerHTML = res.connected
        ? `<span class="ok">Backend OK. Google Drive connected.</span><br>Excel file: ${esc(res.config.excelPath)}`
        : `Backend OK. <b>Google Drive not connected yet.</b>`;
    } catch (e) {
      status.textContent = `Problem: ${e.message}`;
    }
  };
  view.querySelector("#save").onclick = async () => {
    saveSettings({ workerUrl: view.querySelector("#url").value.trim(), token: view.querySelector("#token").value.trim() });
    await test();
    api("/api/state").catch(() => {});
  };
  test();
}

// ---------- start ----------

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
go("home");
if (app.settings.workerUrl && app.state) api("/api/state").then(() => document.querySelector("nav button.active")?.dataset.nav === "home" && renderHome()).catch(() => {});
