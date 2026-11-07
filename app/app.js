import { proposeVehicle, checkEndReading, nearestPlace, DEFAULT_CALENDAR, pickEvent, proposeRideType, looksMixed } from "./match.js";

const DEFAULT_CLASS = { Auto: "car", Motor: "motorcycle", Vespa: "scooter" };
const PLACE_CATEGORIES = ["Home", "Work", "Syntra", "Client", "Other"];
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

// Current GPS position {lat, lon, accuracy}, or null if denied/unavailable.
// Ride photos ask for a fresh fix (maxAge 0): a cached one could still be the start position.
function getPosition(timeout = 20000, maxAge = 0) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout, maximumAge: maxAge }
    );
  });
}

async function addressOf(loc) {
  if (!loc) return "";
  try {
    return (await api("/api/geocode/reverse", { lat: loc.lat, lon: loc.lon })).address;
  } catch {
    return "";
  }
}

function places() {
  return app.state?.places || [];
}

function calendarRules() {
  return { ...DEFAULT_CALENDAR, ...(app.state?.settings?.calendar || {}) };
}

function localDate(date, time) {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = String(time || "00:00").split(":").map(Number);
  return new Date(y, m - 1, d, hh, mm);
}

// Meeting around the ride, or null. Calendar problems never block the ride.
async function meetingFor(rideStart, rideEnd, rules) {
  const win = rules.windowMin * 60000;
  try {
    const res = await api("/api/calendar/events", { from: new Date(rideStart - win).toISOString(), to: new Date(rideEnd.getTime() + win).toISOString() });
    return { pick: pickEvent(res.events, rideStart, rideEnd, rules), error: res.error };
  } catch (e) {
    return { pick: null, error: e.message };
  }
}

function typeOptions(selected, allowEmpty) {
  const types = app.config?.rideTypes || ["Zakelijk", "Pendel", "Privé", "Fun", "Zelfstandig"];
  return (allowEmpty ? `<option value="" ${!selected ? "selected" : ""}>None</option>` : "") +
    types.map((t) => `<option ${t === selected ? "selected" : ""}>${esc(t)}</option>`).join("");
}

function categoryOptions(selected) {
  return PLACE_CATEGORIES.map((c) => `<option ${c === selected ? "selected" : ""}>${c}</option>`).join("");
}

function activeVehicles() {
  return (app.state?.vehicles || []).filter((v) => v.active);
}

// ---------- screens ----------

const routes = { home: renderHome, vehicles: renderVehicles, places: renderPlaces, settings: renderSettings };

function go(name) {
  document.querySelectorAll("nav.tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.nav === name));
  routes[name]();
}

document.querySelectorAll("nav.tabbar button").forEach((b) => (b.onclick = () => go(b.dataset.nav)));

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
  const position = getPosition(); // runs while the camera is open
  let image;
  try {
    image = await takePhoto();
  } catch {
    return;
  }
  const ocr = await readOdometer(image);
  const location = await position;
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
    // Higher than the last recorded reading: km were driven without photos.
    if (vehicle && value > vehicle.lastReading) return gapChoice(vehicle, value, image, ocr, location);
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
        location,
      });
      toast(`Ride ${res.ride.id} started.${location ? "" : " No GPS position."}`);
    } catch (e) {
      toast(e.message, 6000);
    }
    renderHome();
  };
}

// ----- end ride -----

// pre: {image, ocr, location} when the end photo was already taken (start photo forgotten).
async function endRide(id, pre = null) {
  const ride = app.state.openRides.find((r) => r.id === id);
  if (!ride) return renderHome();
  let image, ocr, endLocation;
  if (pre) {
    ({ image, ocr, location: endLocation } = pre);
  } else {
    const position = getPosition(); // runs while the camera is open
    try {
      image = await takePhoto();
    } catch {
      return;
    }
    ocr = await readOdometer(image);
    busy("Looking up location…");
    endLocation = await position;
  }
  busy("Checking places and calendar…");
  const rules = calendarRules();
  const rideStart = localDate(ride.date, ride.startTime);
  const rideEnd = new Date();
  const fromMatch = nearestPlace(places(), ride.startLocation);
  const toMatch = nearestPlace(places(), endLocation);
  const [fromAddress, toAddress, cal] = await Promise.all([
    fromMatch ? "" : addressOf(ride.startLocation),
    toMatch ? "" : addressOf(endLocation),
    meetingFor(rideStart, rideEnd, rules),
  ]);
  const meeting = cal.pick;
  // An unknown place where the meeting is gets the meeting's name (client, else subject).
  const meetingAt = (key) => meeting && meeting.relation === key && meeting.client;
  const from = fromMatch ? fromMatch.place.name : meetingAt("from") || fromAddress;
  const to = toMatch ? toMatch.place.name : meetingAt("to") || toAddress;
  const typeProposal = proposeRideType({ calendarType: meeting?.type, fromPlace: fromMatch?.place, toPlace: toMatch?.place, date: rideStart });
  const reading = pre ? pre.reading : ocr.readable ? ocr.odometer_km : "";
  const meetingDomains = meeting ? meeting.event.domains.filter((d) => !rules.personalDomains.includes(d) && !rules.employerDomains.includes(d)) : [];
  const hhmm = (iso) => new Date(iso).toTimeString().slice(0, 5);

  // Offer to save unknown start/end positions as known places; prefilled from the meeting when it was there.
  const newPlaceBlock = (key, label, loc) => {
    if (!loc) return "";
    const fromMeeting = meetingAt(key);
    const cat = fromMeeting ? (meeting.type === "Zelfstandig" ? "Syntra" : "Client") : "Other";
    return `<label class="check"><input type="checkbox" id="np-${key}"> Save ${label} as known place</label>
         <div id="np-${key}-fields" hidden>
           <label>Category</label><select id="np-${key}-cat">${categoryOptions(cat)}</select>
           <label>Default type</label><select id="np-${key}-type">${typeOptions(fromMeeting ? meeting.type : "", true)}</select>
         </div>`;
  };
  const locHint = (match, loc, key) =>
    match ? `Known place, ${match.distance} m away.` : meetingAt(key) ? "Name from the meeting." : loc ? "Address from GPS." : "No GPS position.";

  view.innerHTML = `
    <h2>End ride ${esc(ride.id)} · ${esc(ride.vehicle)}</h2>
    ${ride.noStartPhoto ? `<div class="banner"><b>No start photo.</b> Km counted from the last recorded reading, ${ride.startReading} km.</div>` : ""}
    <img class="preview" src="${image}" alt="Odometer photo">
    <label>Odometer (km) · start was ${ride.startReading}</label>
    <input class="reading" id="reading" type="number" inputmode="numeric" value="${reading}">
    <div class="muted">${ocr.readable ? `Read with ${esc(ocr.confidence)} confidence.` : "Could not read the number. Type it."} ${esc(ocr.note || "")}</div>
    <div class="km" id="km"></div>
    <div class="muted" id="kmWarn"></div>
    ${meeting ? `<div class="banner"><b>Meeting:</b> ${esc(meeting.event.summary || "(no title)")}, ${hhmm(meeting.event.start)} to ${hhmm(meeting.event.end)}${meeting.event.domains.length ? ` · ${esc(meeting.event.domains.join(", "))}` : ""}</div>` : ""}
    ${cal.error ? `<div class="muted">${esc(cal.error)}</div>` : ""}
    <label>Type</label>
    <select id="type">${typeOptions(typeProposal.type, false)}</select>
    <div class="muted">${esc(typeProposal.reason)}</div>
    <label class="check" id="mixedRow" hidden><input type="checkbox" id="mixed"> Mark as mixed: check for private stop</label>
    <label>From</label><input id="from" autocomplete="off" value="${esc(from)}">
    <div class="muted">${locHint(fromMatch, ride.startLocation, "from")}</div>
    ${fromMatch ? "" : newPlaceBlock("from", "start", ride.startLocation)}
    <label>To</label><input id="to" autocomplete="off" value="${esc(to)}">
    <div class="muted">${locHint(toMatch, endLocation, "to")}</div>
    ${toMatch ? "" : newPlaceBlock("to", "destination", endLocation)}
    <label>Client / purpose</label><input id="client" autocomplete="off" value="${esc(meeting?.client || "")}">
    <label>Note</label><input id="note" autocomplete="off">
    <div class="actions">
      <button class="btn primary" id="save">Save ride</button>
      <button class="btn" id="retake">Retake photo</button>
      <button class="btn" id="back">Back</button>
    </div>`;

  for (const key of ["from", "to"]) {
    const box = view.querySelector(`#np-${key}`);
    if (box) box.onchange = () => (view.querySelector(`#np-${key}-fields`).hidden = !box.checked);
  }

  const input = view.querySelector("#reading");
  // Business ride much longer than the straight line: offer (and pre-tick) the mixed mark.
  let mixedAuto = null;
  const updateMixed = () => {
    const km = Number(input.value) - ride.startReading;
    const show = view.querySelector("#type").value === "Zakelijk" && km > 0 && looksMixed(km, ride.startLocation, endLocation, rules);
    view.querySelector("#mixedRow").hidden = !show;
    if (show && mixedAuto === null) mixedAuto = view.querySelector("#mixed").checked = true;
    if (!show) view.querySelector("#mixed").checked = false;
  };
  view.querySelector("#type").addEventListener("change", updateMixed);
  input.addEventListener("input", updateMixed);
  const updateKm = () => {
    const v = Number(input.value);
    const warn = input.value ? checkEndReading(ride.startReading, v, `${ride.date} ${ride.startTime}`, new Date(), app.state.settings?.maxKmPerDay || 600) : "Enter the odometer reading.";
    view.querySelector("#km").textContent = input.value && v >= ride.startReading ? `${v - ride.startReading} km` : "";
    view.querySelector("#kmWarn").textContent = warn || "";
  };
  input.oninput = updateKm;
  updateKm();
  updateMixed();

  view.querySelector("#back").onclick = renderHome;
  view.querySelector("#retake").onclick = () => endRide(id);
  if (pre) view.querySelector("#retake").hidden = true;
  view.querySelector("#save").onclick = async () => {
    const v = Number(input.value);
    if (!input.value || v < ride.startReading) return toast("Check the odometer reading.");
    const type = view.querySelector("#type").value;
    if (!type) return toast("Choose the type.");
    const warn = checkEndReading(ride.startReading, v, `${ride.date} ${ride.startTime}`, new Date(), app.state.settings?.maxKmPerDay || 600);
    if (warn && !confirm(`${warn}\nSave anyway?`)) return;
    const val = (sel) => view.querySelector(sel).value.trim();
    const newPlaces = [];
    for (const [key, loc, address] of [["from", ride.startLocation, fromAddress], ["to", endLocation, toAddress]]) {
      if (!view.querySelector(`#np-${key}`)?.checked) continue;
      const name = val(`#${key}`);
      if (!name) return toast(`Enter a name in ${key === "from" ? "From" : "To"} to save it as a place.`);
      newPlaces.push({ name, category: val(`#np-${key}-cat`), defaultType: val(`#np-${key}-type`), lat: loc.lat, lon: loc.lon, radius: 300, address, domains: meetingAt(key) ? meetingDomains : [] });
    }
    let note = val("#note");
    if (view.querySelector("#mixed").checked && !/mixed/i.test(note)) note = ["mixed: check for private stop", note].filter(Boolean).join("; ");
    const payload = { reading: v, time: nowLocal().time, image, type, from: val("#from"), to: val("#to"), client: val("#client"), note, location: endLocation, newPlaces };
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

// ----- places -----

function renderPlaces() {
  const list = places().slice().sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  let out = `<button class="big" id="add">Add place</button><h2>Known places</h2>`;
  if (!list.length) out += `<p class="muted">None yet. Add Home, your office(s) and Syntra first.</p>`;
  for (const p of list) {
    out += `<div class="card"><div class="row"><b>${esc(p.name)}</b><span class="chip">${esc(p.category)}</span></div>
      <div class="muted">${esc(p.address || `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`)} · radius ${p.radius} m${p.defaultType ? ` · default ${esc(p.defaultType)}` : ""}</div>
      <div class="actions"><button class="btn" data-edit="${esc(p.id)}">Edit</button><button class="btn" data-del="${esc(p.id)}">Delete</button></div></div>`;
  }
  view.innerHTML = out;
  view.querySelector("#add").onclick = () => editPlace(null);
  view.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => editPlace(places().find((p) => p.id === b.dataset.edit))));
  view.querySelectorAll("[data-del]").forEach(
    (b) =>
      (b.onclick = async () => {
        const p = places().find((x) => x.id === b.dataset.del);
        if (!confirm(`Delete ${p.name}?`)) return;
        busy("Saving…");
        try {
          await api(`/api/places/${p.id}/delete`, {});
        } catch (e) {
          toast(e.message);
        }
        renderPlaces();
      })
  );
}

function editPlace(place) {
  let loc = place ? { lat: place.lat, lon: place.lon, address: place.address } : null;
  view.innerHTML = `
    <h2>${place ? "Edit place" : "Add place"}</h2>
    <label>Name</label><input id="name" autocomplete="off" value="${esc(place?.name || "")}" placeholder="Home, Huawei Mechelen, Syntra Antwerpen…">
    <label>Category</label><select id="cat">${categoryOptions(place?.category || "Other")}</select>
    <label>Default type (proposed when you drive here)</label><select id="type">${typeOptions(place?.defaultType || "", true)}</select>
    <label>Radius (m)</label><input id="radius" type="number" inputmode="numeric" value="${place?.radius || 300}">
    <label>Location</label>
    <div class="muted" id="loc">${loc ? esc(loc.address || `${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)}`) : "Not set yet."}</div>
    <div class="actions"><button class="btn" id="here">Use my current location</button></div>
    <label>Or search an address</label>
    <div class="row"><input id="q" autocomplete="off" placeholder="Street 1, Town"><button class="btn" id="search">Search</button></div>
    <div id="results"></div>
    <div class="actions"><button class="btn primary" id="save">Save</button><button class="btn" id="back">Cancel</button></div>`;
  const showLoc = () => (view.querySelector("#loc").textContent = loc ? loc.address || `${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)}` : "Not set yet.");
  view.querySelector("#back").onclick = renderPlaces;
  view.querySelector("#here").onclick = async () => {
    view.querySelector("#loc").textContent = "Getting GPS position…";
    const p = await getPosition();
    if (!p) {
      showLoc();
      return toast("No GPS position. Allow location for this app.");
    }
    loc = { lat: p.lat, lon: p.lon, address: await addressOf(p) };
    showLoc();
  };
  view.querySelector("#search").onclick = async () => {
    const q = view.querySelector("#q").value.trim();
    if (!q) return;
    const box = view.querySelector("#results");
    box.innerHTML = `<div class="muted">Searching…</div>`;
    try {
      const { results } = await api("/api/geocode/search", { query: q });
      if (!results.length) return (box.innerHTML = `<div class="muted">Nothing found.</div>`);
      box.innerHTML = results.map((r, i) => `<button class="btn result" data-i="${i}">${esc(r.display)}</button>`).join("");
      box.querySelectorAll("[data-i]").forEach(
        (b) =>
          (b.onclick = () => {
            const r = results[Number(b.dataset.i)];
            loc = { lat: r.lat, lon: r.lon, address: r.address || r.display };
            box.innerHTML = "";
            showLoc();
          })
      );
    } catch (e) {
      box.innerHTML = `<div class="muted">${esc(e.message)}</div>`;
    }
  };
  view.querySelector("#save").onclick = async () => {
    const body = {
      name: view.querySelector("#name").value.trim(),
      category: view.querySelector("#cat").value,
      defaultType: view.querySelector("#type").value,
      radius: Number(view.querySelector("#radius").value) || 300,
    };
    if (!body.name) return toast("Enter a name.");
    if (!loc) return toast("Set the location: current location or search an address.");
    Object.assign(body, { lat: loc.lat, lon: loc.lon, address: loc.address || "" });
    busy("Saving…");
    try {
      await api(place ? `/api/places/${place.id}/update` : "/api/places", body);
      toast(`${body.name} saved.`);
    } catch (e) {
      toast(e.message, 6000);
    }
    renderPlaces();
  };
}

// ----- km driven without photos -----

function gapChoice(vehicle, reading, image, ocr, location) {
  const km = reading - vehicle.lastReading;
  view.innerHTML = `
    <h2>${km} km not logged</h2>
    <div class="banner">This photo shows <b>${reading} km</b>. The last recorded reading of ${esc(vehicle.name)} is <b>${vehicle.lastReading} km</b> (${esc(vehicle.lastReadingAt)}).</div>
    <p>What happened?</p>
    <button class="big" id="asEnd">This photo is the end of a ride</button>
    <p class="muted">You forgot the start photo. The ride counts ${km} km from the last recorded reading. Fill in the ride now, no second photo needed.</p>
    <button class="btn" id="asGap" style="width:100%">A ride was not logged</button>
    <p class="muted">The ${km} km are saved as a separate row. Then this ride starts at ${reading} km.</p>
    <div id="gapForm" hidden>
      <label>Type of the unlogged ${km} km</label><select id="gapType">${typeOptions("Privé", false)}</select>
      <label>Note</label><input id="gapNote" autocomplete="off">
      <div class="actions"><button class="btn primary" id="gapSave">Save ${km} km and start ride</button></div>
    </div>
    <div class="actions"><button class="btn" id="back">Back</button></div>`;
  view.querySelector("#back").onclick = renderHome;
  view.querySelector("#asEnd").onclick = async () => {
    busy("Opening ride…");
    try {
      const res = await api("/api/rides/start-from-last", { vehicleId: vehicle.id, date: nowLocal().date });
      return endRide(res.ride.id, { image, ocr, location, reading });
    } catch (e) {
      toast(e.message, 6000);
      renderHome();
    }
  };
  view.querySelector("#asGap").onclick = () => (view.querySelector("#gapForm").hidden = false);
  view.querySelector("#gapSave").onclick = async () => {
    const type = view.querySelector("#gapType").value;
    const note = view.querySelector("#gapNote").value.trim();
    const { date, time } = nowLocal();
    busy("Saving…");
    try {
      const gap = await api("/api/rides/gap", { vehicleId: vehicle.id, reading, date, time, type, note });
      const res = await api("/api/rides/start", { vehicle: vehicle.name, vehicleId: vehicle.id, reading, date, time, image, location });
      toast(`${gap.ride.id}: ${km} km saved${gap.excel?.error ? " (not in Excel yet)" : ""}. Ride ${res.ride.id} started.`, 6000);
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
    <h2>Google</h2>
    <p class="muted">Connect once. The backend keeps access to your Google Drive files and reads your calendar.</p>
    <a class="btn" id="connect" target="_blank" rel="noopener">Connect Google</a>
    ${calendarSettingsHtml()}`;
  bindCalendarSettings();
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
        ? `<span class="ok">Backend OK. Google Drive connected.</span><br>Excel file: ${esc(res.config.excelPath)}<br>` +
          (res.calendar ? `<span class="ok">Calendar connected.</span>` : `<b>Calendar not connected yet:</b> tap Connect Google and allow the calendar.`)
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

// ----- calendar settings -----

function calendarSettingsHtml() {
  const c = calendarRules();
  const list = (a) => esc((a || []).join(", "));
  const sources = c.sources
    .map(
      (src, i) => `<div class="card" data-src="${i}">
        <div class="row"><b>${esc(src.name)}</b><span class="chip">${esc(src.calendarId)}</span></div>
        <label>Type for every meeting in this calendar</label>
        <select class="src-type">${typeOptions(src.type, true).replace(">None<", ">None: use the rules below<")}</select>
        ${i > 0 ? `<div class="actions"><button class="btn src-del">Remove calendar</button></div>` : ""}
      </div>`
    )
    .join("");
  return `
    <h2>Calendar</h2>
    <p class="muted">Meetings around a ride propose its type and client. The calendar wins over Pendel and place defaults.</p>
    <div id="sources">${sources}</div>
    <details><summary class="muted">Add another Google calendar</summary>
      <label>Name</label><input id="srcName" placeholder="Syntra lessons">
      <label>Calendar ID (Google Calendar > settings of that calendar > Integrate calendar)</label><input id="srcId" placeholder="...@group.calendar.google.com">
      <label>Type</label><select id="srcType">${typeOptions("Zelfstandig", false)}</select>
      <div class="actions"><button class="btn" id="srcAdd">Add calendar</button></div>
    </details>
    <h2>Rules for meetings</h2>
    <label>Zelfstandig: attendee domains</label><input id="zDomains" value="${list(c.zelfstandigDomains)}">
    <label>Zelfstandig: words in the meeting title</label><input id="zWords" value="${list(c.zelfstandigKeywords)}">
    <label>Employer domains (Zakelijk, never shown as client)</label><input id="eDomains" value="${list(c.employerDomains)}">
    <label>Personal domains (never Zakelijk, never a client)</label><input id="pDomains" value="${list(c.personalDomains)}">
    <p class="muted">Any other attendee domain makes the meeting Zakelijk and becomes the client name.</p>
    <label>Time window around a ride (minutes)</label><input id="win" type="number" inputmode="numeric" value="${c.windowMin}">
    <h2>Mixed rides</h2>
    <p class="muted">A Zakelijk ride is marked "mixed" when its km exceed factor × straight-line distance + extra km.</p>
    <div class="row"><label style="flex:1">Factor<input id="mixF" type="number" step="0.1" value="${c.mixedFactor}"></label><label style="flex:1">Extra km<input id="mixKm" type="number" value="${c.mixedMinKm}"></label></div>
    <div class="actions"><button class="btn primary" id="calSave">Save calendar settings</button></div>`;
}

function bindCalendarSettings() {
  const c = calendarRules();
  const sources = c.sources.map((x) => ({ ...x }));
  const save = async () => {
    view.querySelectorAll("[data-src]").forEach((card) => (sources[Number(card.dataset.src)].type = card.querySelector(".src-type").value));
    const body = {
      sources,
      zelfstandigDomains: view.querySelector("#zDomains").value,
      zelfstandigKeywords: view.querySelector("#zWords").value,
      employerDomains: view.querySelector("#eDomains").value,
      personalDomains: view.querySelector("#pDomains").value,
      windowMin: Number(view.querySelector("#win").value),
      mixedFactor: Number(view.querySelector("#mixF").value),
      mixedMinKm: Number(view.querySelector("#mixKm").value),
    };
    try {
      await api("/api/settings/calendar", body);
      toast("Calendar settings saved.");
    } catch (e) {
      toast(e.message, 6000);
    }
    renderSettings();
  };
  view.querySelector("#calSave").onclick = save;
  view.querySelectorAll(".src-del").forEach(
    (b) =>
      (b.onclick = () => {
        sources.splice(Number(b.closest("[data-src]").dataset.src), 1);
        b.closest("[data-src]").remove();
        view.querySelectorAll("[data-src]").forEach((card, i) => (card.dataset.src = i));
        save();
      })
  );
  view.querySelector("#srcAdd").onclick = () => {
    const calendarId = view.querySelector("#srcId").value.trim();
    if (!calendarId) return toast("Enter the calendar ID.");
    view.querySelectorAll("[data-src]").forEach((card) => (sources[Number(card.dataset.src)].type = card.querySelector(".src-type").value));
    sources.push({ id: `google-${Date.now()}`, name: view.querySelector("#srcName").value.trim() || calendarId, kind: "google", calendarId, type: view.querySelector("#srcType").value });
    save();
  };
}

// ---------- start ----------

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
go("home");
if (app.settings.workerUrl && app.state) api("/api/state").then(() => document.querySelector("nav.tabbar button.active")?.dataset.nav === "home" && renderHome()).catch(() => {});
