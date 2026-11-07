// Vehicle proposal from an odometer reading and the dashboard class.
// Rules (design section 4): the reading must fit a vehicle's range, the
// dashboard class breaks ties, a car dashboard that fits nothing is Cambio.

const DAY_MS = 86400000;
const TOLERANCE_KM = 2; // small misreads below the last reading

function parseLocal(stamp) {
  // "YYYY-MM-DD HH:MM"
  const [d, t = "00:00"] = String(stamp).split(" ");
  const [y, m, day] = d.split("-").map(Number);
  const [hh, mm] = t.split(":").map(Number);
  return new Date(y, m - 1, day, hh, mm);
}

export function rangeFor(vehicle, now, maxKmPerDay) {
  const last = vehicle.lastReading ?? 0;
  const days = Math.max(1, Math.ceil((now - parseLocal(vehicle.lastReadingAt)) / DAY_MS));
  return { min: last - TOLERANCE_KM, max: last + days * maxKmPerDay };
}

/**
 * vehicles: active registered vehicles (Cambio not included)
 * returns { vehicleId | null, name | null, reason, confident: boolean }
 */
export function proposeVehicle(vehicles, reading, dashboardClass, { now = new Date(), maxKmPerDay = 600, cambioName = "Cambio" } = {}) {
  const active = vehicles.filter((v) => v.active);
  if (!(reading >= 0)) {
    return { vehicleId: null, name: null, confident: false, reason: "No odometer reading. Pick the vehicle." };
  }
  const fits = active.filter((v) => {
    const r = rangeFor(v, now, maxKmPerDay);
    return reading >= r.min && reading <= r.max;
  });
  const sameClass = fits.filter((v) => v.class === dashboardClass);
  const closest = (list) => list.slice().sort((a, b) => Math.abs(reading - a.lastReading) - Math.abs(reading - b.lastReading))[0];

  if (sameClass.length === 1) {
    return { vehicleId: sameClass[0].id, name: sameClass[0].name, confident: true, reason: `Reading fits ${sameClass[0].name} and the dashboard looks like a ${dashboardClass}.` };
  }
  if (sameClass.length > 1) {
    const v = closest(sameClass);
    return { vehicleId: v.id, name: v.name, confident: false, reason: `Reading fits several ${dashboardClass}s. Closest: ${v.name}. Please check.` };
  }
  if (fits.length >= 1) {
    const v = closest(fits);
    const cls = dashboardClass === "unknown" ? "" : ` Dashboard looked like a ${dashboardClass}, ${v.name} is a ${v.class}.`;
    return { vehicleId: v.id, name: v.name, confident: fits.length === 1 && dashboardClass === "unknown", reason: `Reading fits ${v.name}.${cls} Please check.` };
  }
  if (dashboardClass === "car") {
    return { vehicleId: null, name: cambioName, confident: true, reason: `Car dashboard that matches none of your vehicles: ${cambioName}.` };
  }
  return { vehicleId: null, name: null, confident: false, reason: "Reading fits none of your vehicles. Check the number, or register a new vehicle." };
}

// Plausibility of an end reading against the start of the same ride.
export function checkEndReading(startReading, endReading, startStamp, now = new Date(), maxKmPerDay = 600) {
  if (!(endReading >= 0)) return "Enter the odometer reading.";
  if (endReading < startReading) return `End reading is lower than the start (${startReading}).`;
  const days = Math.max(1, Math.ceil((now - parseLocal(startStamp)) / DAY_MS));
  if (endReading - startReading > days * maxKmPerDay) return `That is ${endReading - startReading} km. More than expected, please check.`;
  return null;
}

// ---------- places (phase 2) ----------

// Distance in metres between two GPS points.
export function distanceM(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Closest known place whose radius contains the location. GPS accuracy (capped at 100 m)
// widens the radius a little, so a weak fix next to the building still matches.
export function nearestPlace(places, loc) {
  if (!loc || !places?.length) return null;
  let best = null;
  for (const p of places) {
    const d = distanceM(loc, p);
    const limit = p.radius + Math.min(loc.accuracy || 0, 100);
    if (d <= limit && (!best || d < best.distance)) best = { place: p, distance: Math.round(d) };
  }
  return best;
}

// Type proposal for phase 2: default Type of the destination, else of the start place, else Privé.
export function proposeType(fromPlace, toPlace, fallback = "Privé") {
  return toPlace?.defaultType || fromPlace?.defaultType || fallback;
}

// ---------- calendar and Type rules (phase 3) ----------

export const DEFAULT_CALENDAR = {
  sources: [{ id: "google-primary", name: "Google Calendar", kind: "google", calendarId: "primary", type: "" }],
  windowMin: 60,
  zelfstandigDomains: ["syntra-ab.be"],
  zelfstandigKeywords: ["syntra"],
  employerDomains: ["huawei.com"],
  personalDomains: ["fonteyn.info", "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "icloud.com"],
  mixedFactor: 2,
  mixedMinKm: 5,
};

// "proximus.com" -> "Proximus", "mail.syntra-ab.be" -> "Syntra-ab"
export function nameFromDomain(domain) {
  const labels = String(domain).toLowerCase().split(".").filter(Boolean);
  const main = labels.length >= 2 ? labels[labels.length - 2] : labels[0] || "";
  return main ? main[0].toUpperCase() + main.slice(1) : "";
}

// Type a meeting points to: its calendar's fixed type, else the rules, else "".
export function eventType(ev, rules) {
  if (ev.sourceType) return ev.sourceType;
  const title = String(ev.summary || "").toLowerCase();
  if (ev.domains.some((d) => rules.zelfstandigDomains.includes(d)) || rules.zelfstandigKeywords.some((k) => k && title.includes(k))) return "Zelfstandig";
  if (ev.domains.some((d) => !rules.personalDomains.includes(d))) return "Zakelijk";
  return "";
}

// Client/purpose: first external attendee domain (not personal, not the employer), else the subject.
export function eventClient(ev, rules) {
  const d = ev.domains.find((x) => !rules.personalDomains.includes(x) && !rules.employerDomains.includes(x));
  return d ? nameFromDomain(d) : String(ev.summary || "").trim();
}

/**
 * Meeting that best explains a ride from rideStart to rideEnd (Date objects).
 * Counts: overlaps the ride, starts within windowMin after arrival, or ended within windowMin
 * before departure. Closest in time wins; a meeting that gives a Type beats one that does not.
 * relation: "to" (meeting at the destination) or "from" (meeting at the start place).
 */
export function pickEvent(events, rideStart, rideEnd, rules) {
  const win = rules.windowMin * 60000;
  let best = null;
  for (const ev of events || []) {
    if (ev.allDay || ev.declined) continue;
    const s = new Date(ev.start), e = new Date(ev.end);
    if (isNaN(s) || isNaN(e)) continue;
    if (s > rideEnd.getTime() + win || e < rideStart.getTime() - win) continue;
    const gap = s > rideEnd ? s - rideEnd : e < rideStart ? rideStart - e : 0;
    const relation = e <= rideStart ? "from" : "to";
    const type = eventType(ev, rules);
    const rank = [type ? 0 : 1, gap];
    if (!best || rank[0] < best.rank[0] || (rank[0] === best.rank[0] && rank[1] < best.rank[1])) {
      best = { event: ev, type, client: eventClient(ev, rules), relation, rank };
    }
  }
  if (best) delete best.rank;
  return best;
}

// Weekday ride between a Home place and a Work place, either direction.
export function isPendel(fromPlace, toPlace, date) {
  const day = date.getDay();
  if (day === 0 || day === 6) return false;
  const pair = [fromPlace?.category, toPlace?.category].sort().join("-");
  return pair === "Home-Work";
}

// Priority: calendar > Pendel > place default (destination, then start) > Privé.
export function proposeRideType({ calendarType, fromPlace, toPlace, date }) {
  if (calendarType) return { type: calendarType, reason: "From your calendar." };
  if (isPendel(fromPlace, toPlace, date)) return { type: "Pendel", reason: "Weekday ride between Home and Work." };
  const placeType = toPlace?.defaultType || fromPlace?.defaultType;
  if (placeType) return { type: placeType, reason: "Default type of the place." };
  return { type: "Privé", reason: "Default." };
}

// A business ride much longer than the straight line between start and end: maybe a private stop.
export function looksMixed(km, startLoc, endLoc, rules) {
  if (!startLoc || !endLoc) return false;
  const straightKm = distanceM(startLoc, endLoc) / 1000;
  return km > rules.mixedFactor * straightKm + rules.mixedMinKm;
}
