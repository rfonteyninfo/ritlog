// Ritlog backend: odometer reading, app state, photos and Excel rows on Google Drive.
import { Drive, HttpError, authorizeUrl, exchangeCode, isConnected } from "./gdrive.js";
import { readOdometer } from "./odometer.js";
import { reverseGeocode, searchAddress } from "./geo.js";
import { appendRitlogRow, findRideRows, fillOdometers } from "./xlsx.js";
import { rideId, photoName, photoFolder, slug } from "./naming.js";

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function config(env) {
  return {
    excelPath: env.EXCEL_PATH || "/Ritlog/rekenmodule_auto_vs_motor_v4.xlsx",
    photoRoot: env.PHOTO_ROOT || "/Ritlog-fotos",
    statePath: env.STATE_PATH || "/Ritlog-app/state.json",
    vehicleNames: (env.VEHICLE_NAMES || "Auto,Motor,Vespa").split(",").map((s) => s.trim()),
    rideTypes: (env.RIDE_TYPES || "Zakelijk,Pendel,Privé,Fun,Zelfstandig").split(",").map((s) => s.trim()),
    cambioName: env.CAMBIO_NAME || "Cambio",
  };
}

function emptyState() {
  return { version: 1, nextRideNo: 1, vehicles: [], places: [], openRides: [], rides: [], settings: { maxKmPerDay: 600 } };
}

// ---------- helpers ----------

function cors(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
  };
}

function json(env, data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors(env) } });
}

function html(body, status = 200) {
  return new Response(`<!doctype html><meta name="viewport" content="width=device-width"><body style="font-family:sans-serif;padding:24px">${body}</body>`, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function b64ToBytes(b64) {
  const bin = atob(b64.replace(/^data:[^,]+,/, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function stripDataUrl(b64) {
  return b64.replace(/^data:[^,]+,/, "");
}

function required(obj, fields) {
  for (const f of fields) {
    if (obj[f] === undefined || obj[f] === null || obj[f] === "") throw new HttpError(400, `Missing field: ${f}`);
  }
}

function checkDate(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, "date must be YYYY-MM-DD");
  if (time !== undefined && !/^\d{2}:\d{2}$/.test(time)) throw new HttpError(400, "time must be HH:MM");
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// GPS position from the app: {lat, lon, accuracy} or null.
function cleanLocation(loc) {
  if (!loc || typeof loc !== "object") return null;
  const lat = Number(loc.lat), lon = Number(loc.lon);
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return null;
  const accuracy = Number(loc.accuracy);
  return { lat, lon, accuracy: accuracy >= 0 ? Math.round(accuracy) : null };
}

const PLACE_CATEGORIES = ["Home", "Work", "Syntra", "Client", "Other"];

function cleanPlace(body, cfg) {
  required(body, ["name", "category", "lat", "lon"]);
  const loc = cleanLocation(body);
  if (!loc) throw new HttpError(400, "Invalid coordinates");
  if (!PLACE_CATEGORIES.includes(body.category)) throw new HttpError(400, `category must be one of ${PLACE_CATEGORIES.join(", ")}`);
  if (body.defaultType && !cfg.rideTypes.includes(body.defaultType)) throw new HttpError(400, `Unknown type ${body.defaultType}`);
  const radius = Math.round(Number(body.radius) || 300);
  if (!(radius >= 50 && radius <= 5000)) throw new HttpError(400, "radius must be between 50 and 5000 m");
  return {
    name: String(body.name).trim().slice(0, 60),
    category: body.category,
    lat: loc.lat,
    lon: loc.lon,
    radius,
    defaultType: body.defaultType || "",
    address: String(body.address || "").slice(0, 200),
  };
}

// ---------- state on Google Drive ----------

async function loadState(drive, cfg) {
  const file = await drive.download(cfg.statePath);
  if (!file) return { state: emptyState(), etag: null };
  return { state: JSON.parse(new TextDecoder().decode(file.bytes)), etag: file.etag };
}

async function saveState(drive, cfg, state, etag) {
  const body = new TextEncoder().encode(JSON.stringify(state, null, 2));
  await drive.upload(cfg.statePath, body, "application/json", etag);
}

// Load, change, save; retried once if the state file changed in between.
async function updateState(drive, cfg, mutate) {
  for (let attempt = 0; ; attempt++) {
    const { state, etag } = await loadState(drive, cfg);
    const result = await mutate(state);
    try {
      await saveState(drive, cfg, state, etag);
      return { state, result };
    } catch (e) {
      if (e.status === 412 && attempt === 0) continue;
      throw e;
    }
  }
}

// Most recent finished ride of a vehicle.
function lastRideOf(state, vehicleId) {
  return state.rides.filter((r) => r.vehicleId === vehicleId).at(-1) || null;
}

// ---------- Excel ----------

function excelValues(ride) {
  return {
    date: ride.date,
    vehicle: ride.vehicle,
    type: ride.type,
    from: ride.from,
    to: ride.to,
    client: ride.client,
    km: ride.km,
    note: [ride.id, ride.autoNote, ride.note].filter(Boolean).join(" - "),
    odometer: ride.endReading,
  };
}

// Writes all rides marked excel:"pending" in one download/upload cycle, then
// records the result in the state. Rides whose ID is already in column H are
// not written again, so a retry after a partial failure cannot duplicate rows.
async function writePendingToExcel(drive, cfg) {
  const { state } = await loadState(drive, cfg);
  const pending = state.rides.filter((r) => r.excel === "pending");
  if (!pending.length) return { result: { written: 0 }, state };

  const rows = {};
  let error = null;
  for (let attempt = 0; ; attempt++) {
    try {
      const file = await drive.download(cfg.excelPath);
      if (!file) throw new HttpError(404, `Excel file not found on Google Drive at ${cfg.excelPath}`);
      const existing = findRideRows(file.bytes);
      let bytes = file.bytes;
      let changed = false;
      for (const ride of pending) {
        if (existing[ride.id]) {
          rows[ride.id] = existing[ride.id];
          continue;
        }
        const res = appendRitlogRow(bytes, excelValues(ride));
        bytes = res.bytes;
        rows[ride.id] = res.row;
        changed = true;
      }
      // Rows written before column L existed get their odometer reading once.
      const backfill = {};
      for (const ride of state.rides) {
        if (existing[ride.id] && ride.endReading >= 0) backfill[existing[ride.id]] = ride.endReading;
      }
      const filled = fillOdometers(bytes, backfill);
      if (filled.changed) {
        bytes = filled.bytes;
        changed = true;
      }
      if (changed) await drive.upload(cfg.excelPath, bytes, XLSX_TYPE, file.etag);
      break;
    } catch (e) {
      if (e.status === 412 && attempt === 0) continue;
      error = e.status === 412 || e.status === 423
        ? "The Excel file was being edited at the same moment. Close it on your PC and tap Retry."
        : e.message;
      for (const k of Object.keys(rows)) delete rows[k];
      break;
    }
  }

  const ids = new Set(pending.map((r) => r.id));
  const updated = await updateState(drive, cfg, (s) => {
    for (const ride of s.rides) {
      if (!ids.has(ride.id) || ride.excel !== "pending") continue;
      if (rows[ride.id]) {
        ride.excel = "written";
        ride.excelRow = rows[ride.id];
        delete ride.excelError;
      } else if (error) {
        ride.excelError = error;
      }
    }
  });
  return { result: { written: Object.keys(rows).length, error }, state: updated.state };
}

// ---------- routes ----------

async function handleApi(request, env, url) {
  const cfg = config(env);
  const drive = new Drive(env);
  const path = url.pathname;
  const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
  let m;

  if (path === "/api/status" && request.method === "GET") {
    return json(env, { connected: await isConnected(env), config: cfg });
  }

  if (path === "/api/state" && request.method === "GET") {
    const { state } = await loadState(drive, cfg);
    return json(env, { state, config: cfg });
  }

  if (path === "/api/odometer" && request.method === "POST") {
    required(body, ["image"]);
    return json(env, await readOdometer(env, stripDataUrl(body.image)));
  }

  if (path === "/api/vehicles" && request.method === "POST") {
    required(body, ["name", "class", "reading", "date", "time", "image"]);
    checkDate(body.date, body.time);
    if (!["car", "motorcycle", "scooter"].includes(body.class)) throw new HttpError(400, "class must be car, motorcycle or scooter");
    const reading = Math.round(Number(body.reading));
    if (!(reading >= 0)) throw new HttpError(400, "reading must be a number");
    const photoPath = `${cfg.photoRoot}/vehicles/${slug(body.name)}_${body.date}_${body.time.replace(":", "")}_registration.jpg`;
    await drive.upload(photoPath, b64ToBytes(body.image), "image/jpeg");
    const { state, result } = await updateState(drive, cfg, (s) => {
      // Registering a vehicle under a name already in use retires the old one.
      for (const v of s.vehicles) if (v.active && v.name === body.name) v.active = false;
      const vehicle = {
        id: crypto.randomUUID(),
        name: body.name,
        class: body.class,
        active: true,
        registeredAt: `${body.date} ${body.time}`,
        startReading: reading,
        lastReading: reading,
        lastReadingAt: `${body.date} ${body.time}`,
        photo: photoPath,
      };
      s.vehicles.push(vehicle);
      return vehicle;
    });
    return json(env, { vehicle: result, state });
  }

  if ((m = path.match(/^\/api\/vehicles\/([\w-]+)\/deactivate$/)) && request.method === "POST") {
    const { state } = await updateState(drive, cfg, (s) => {
      const v = s.vehicles.find((x) => x.id === m[1]);
      if (!v) throw new HttpError(404, "Vehicle not found");
      v.active = false;
    });
    return json(env, { state });
  }

  if (path === "/api/geocode/reverse" && request.method === "POST") {
    return json(env, await reverseGeocode(Number(body.lat), Number(body.lon)));
  }

  if (path === "/api/geocode/search" && request.method === "POST") {
    required(body, ["query"]);
    return json(env, { results: await searchAddress(body.query) });
  }

  if (path === "/api/places" && request.method === "POST") {
    const place = cleanPlace(body, cfg);
    const { state, result } = await updateState(drive, cfg, (s) => {
      s.places ??= [];
      const p = { id: crypto.randomUUID(), ...place };
      s.places.push(p);
      return p;
    });
    return json(env, { place: result, state });
  }

  if ((m = path.match(/^\/api\/places\/([\w-]+)\/update$/)) && request.method === "POST") {
    const place = cleanPlace(body, cfg);
    const { state } = await updateState(drive, cfg, (s) => {
      const p = (s.places || []).find((x) => x.id === m[1]);
      if (!p) throw new HttpError(404, "Place not found");
      Object.assign(p, place);
    });
    return json(env, { state });
  }

  if ((m = path.match(/^\/api\/places\/([\w-]+)\/delete$/)) && request.method === "POST") {
    const { state } = await updateState(drive, cfg, (s) => {
      s.places = (s.places || []).filter((x) => x.id !== m[1]);
    });
    return json(env, { state });
  }

  // The odometer is higher than the vehicle's last recorded reading and the photo is the END
  // of a ride: open a ride that starts at the last recorded reading, without a start photo.
  if (path === "/api/rides/start-from-last" && request.method === "POST") {
    required(body, ["vehicleId", "date"]);
    checkDate(body.date);
    const { result: ride } = await updateState(drive, cfg, (s) => {
      const v = s.vehicles.find((x) => x.id === body.vehicleId && x.active);
      if (!v) throw new HttpError(400, "Unknown vehicle. Register it first.");
      const last = lastRideOf(s, v.id);
      const r = {
        id: rideId(s.nextRideNo++),
        vehicle: v.name,
        vehicleId: v.id,
        startReading: v.lastReading,
        date: body.date,
        startTime: String(v.lastReadingAt || "").split(" ")[1] || "00:00",
        startLocation: last?.endLocation || null,
        startPhoto: null,
        noStartPhoto: true,
      };
      s.openRides.push(r);
      return r;
    });
    const { state } = await loadState(drive, cfg);
    return json(env, { ride, state });
  }

  // Km driven without photos: logged as their own row, from the last recorded reading
  // to the new reading. The vehicle's last reading moves to the new reading.
  if (path === "/api/rides/gap" && request.method === "POST") {
    required(body, ["vehicleId", "reading", "date", "time", "type"]);
    checkDate(body.date, body.time);
    if (!cfg.rideTypes.includes(body.type)) throw new HttpError(400, `Unknown type ${body.type}`);
    const reading = Math.round(Number(body.reading));
    await updateState(drive, cfg, (s) => {
      const v = s.vehicles.find((x) => x.id === body.vehicleId && x.active);
      if (!v) throw new HttpError(400, "Unknown vehicle. Register it first.");
      if (!(reading > v.lastReading)) throw new HttpError(400, `Reading ${reading} is not higher than the last recorded ${v.lastReading}`);
      const last = lastRideOf(s, v.id);
      s.rides.push({
        id: rideId(s.nextRideNo++),
        date: body.date,
        time: body.time,
        endTime: body.time,
        vehicle: v.name,
        vehicleId: v.id,
        type: body.type,
        from: body.from || last?.to || "",
        to: body.to || "",
        client: "",
        note: body.note || "",
        autoNote: "km not logged with photos",
        startReading: v.lastReading,
        endReading: reading,
        km: reading - v.lastReading,
        gap: true,
        photos: [],
        excel: "pending",
      });
      v.lastReading = reading;
      v.lastReadingAt = `${body.date} ${body.time}`;
    });
    const { state, result } = await writePendingToExcel(drive, cfg);
    return json(env, { ride: state.rides[state.rides.length - 1], excel: result, state });
  }

  if (path === "/api/rides/start" && request.method === "POST") {
    required(body, ["vehicle", "date", "time", "image"]);
    checkDate(body.date, body.time);
    const isCambio = body.vehicle === cfg.cambioName;
    const reading = Math.round(Number(body.reading));
    if (!(reading >= 0)) throw new HttpError(400, "reading must be a number");
    const { state: before } = await loadState(drive, cfg);
    if (!isCambio && !before.vehicles.some((v) => v.id === body.vehicleId && v.active)) {
      throw new HttpError(400, "Unknown vehicle. Register it first.");
    }
    // Reserve the ride number first, then upload the photo under that ID.
    const { result: ride } = await updateState(drive, cfg, (s) => {
      const r = {
        id: rideId(s.nextRideNo++),
        vehicle: body.vehicle,
        vehicleId: isCambio ? null : body.vehicleId,
        startReading: reading,
        date: body.date,
        startTime: body.time,
        startLocation: cleanLocation(body.location),
        startPhoto: null,
      };
      r.startPhoto = `${cfg.photoRoot}/_pending/${r.id}_start.jpg`;
      s.openRides.push(r);
      return r;
    });
    await drive.upload(ride.startPhoto, b64ToBytes(body.image), "image/jpeg");
    const { state } = await loadState(drive, cfg);
    return json(env, { ride, state });
  }

  if ((m = path.match(/^\/api\/rides\/(R\d+)\/cancel$/)) && request.method === "POST") {
    let photo = null;
    const { state } = await updateState(drive, cfg, (s) => {
      const i = s.openRides.findIndex((r) => r.id === m[1]);
      if (i < 0) throw new HttpError(404, "Open ride not found");
      photo = s.openRides[i].startPhoto;
      s.openRides.splice(i, 1);
    });
    if (photo) await drive.remove(photo);
    return json(env, { state });
  }

  if ((m = path.match(/^\/api\/rides\/(R\d+)\/finish$/)) && request.method === "POST") {
    required(body, ["reading", "time", "image", "type"]);
    checkDate("2000-01-01", body.time);
    const { state: current } = await loadState(drive, cfg);
    const open = current.openRides.find((r) => r.id === m[1]);
    if (!open) throw new HttpError(404, "Open ride not found");
    const endReading = Math.round(Number(body.reading));
    const km = endReading - open.startReading;
    if (!(km >= 0)) throw new HttpError(400, `End reading ${endReading} is lower than start reading ${open.startReading}`);
    if (!cfg.rideTypes.includes(body.type)) throw new HttpError(400, `Unknown type ${body.type}`);
    // Optional new known places, saved together with the ride.
    const newPlaces = (Array.isArray(body.newPlaces) ? body.newPlaces : []).slice(0, 2).map((p) => cleanPlace(p, cfg));

    const ride = {
      id: open.id,
      date: open.date,
      time: open.startTime,
      endTime: body.time,
      vehicle: open.vehicle,
      vehicleId: open.vehicleId,
      type: body.type,
      from: body.from || "",
      to: body.to || "",
      client: body.client || "",
      note: body.note || "",
      startReading: open.startReading,
      endReading,
      km,
      startLocation: open.startLocation || null,
      endLocation: cleanLocation(body.location),
      excel: "pending",
    };
    if (open.noStartPhoto) ride.autoNote = "no start photo, km from last recorded reading";
    const folder = photoFolder(cfg.photoRoot, ride.date);
    const endPath = `${folder}/${photoName(ride, "end")}`;
    await drive.upload(endPath, b64ToBytes(body.image), "image/jpeg"); // also creates the folder
    if (open.startPhoto) {
      const startName = photoName(ride, "start");
      await drive.move(open.startPhoto, folder, startName);
      ride.photos = [`${folder}/${startName}`, endPath];
    } else {
      ride.photos = [endPath];
    }

    await updateState(drive, cfg, (s) => {
      s.openRides = s.openRides.filter((r) => r.id !== ride.id);
      if (!s.rides.some((r) => r.id === ride.id)) {
        s.rides.push(ride);
        s.places ??= [];
        for (const p of newPlaces) s.places.push({ id: crypto.randomUUID(), ...p });
      }
      const v = s.vehicles.find((x) => x.id === ride.vehicleId);
      if (v && endReading >= (v.lastReading ?? 0)) {
        v.lastReading = endReading;
        v.lastReadingAt = `${ride.date} ${ride.endTime}`;
      }
    });
    const { state, result } = await writePendingToExcel(drive, cfg);
    return json(env, { ride: state.rides.find((r) => r.id === ride.id), excel: result, state });
  }

  if (path === "/api/excel/retry" && request.method === "POST") {
    const { state, result } = await writePendingToExcel(drive, cfg);
    return json(env, { excel: result, state });
  }

  throw new HttpError(404, "Not found");
}

async function handleAuth(request, env, url) {
  const redirectUri = `${url.origin}/auth/callback`;
  if (url.pathname === "/auth/start") {
    if (!safeEqual(url.searchParams.get("key") || "", env.APP_TOKEN)) return html("Wrong access code.", 403);
    const state = crypto.randomUUID();
    await env.KV.put(`oauth_state_${state}`, "1", { expirationTtl: 600 });
    return Response.redirect(authorizeUrl(env, redirectUri, state), 302);
  }
  if (url.pathname === "/auth/callback") {
    const state = url.searchParams.get("state");
    if (!state || !(await env.KV.get(`oauth_state_${state}`))) return html("Login expired. Start again from the app.", 400);
    await env.KV.delete(`oauth_state_${state}`);
    const error = url.searchParams.get("error_description") || url.searchParams.get("error");
    if (error) return html(`Google login failed: ${error}`, 400);
    await exchangeCode(env, url.searchParams.get("code"), redirectUri);
    return html("<h2>Google Drive connected</h2><p>You can close this tab and go back to the app.</p>");
  }
  return html("Not found", 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env) });
    try {
      if (url.pathname.startsWith("/auth/")) return await handleAuth(request, env, url);
      if (url.pathname.startsWith("/api/")) {
        const auth = request.headers.get("Authorization") || "";
        if (!safeEqual(auth.replace(/^Bearer /, ""), env.APP_TOKEN || "\u0000")) throw new HttpError(401, "Wrong access code");
        return await handleApi(request, env, url);
      }
      return html("Ritlog backend is running.");
    } catch (e) {
      const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
      return json(env, { error: e.message || String(e) }, status);
    }
  },
};
