// Address lookups with OpenStreetMap Nominatim (free, no account).
// Usage policy: max 1 request per second, identify the application.
// https://operations.osmfoundation.org/policies/nominatim/
const BASE = "https://nominatim.openstreetmap.org";
const HEADERS = { "User-Agent": "Ritlog personal ride log (https://github.com/rfonteyninfo/ritlog)", "Accept-Language": "nl,en" };

function town(a = {}) {
  return a.city || a.town || a.village || a.municipality || a.suburb || "";
}

// "Street, Town" as agreed; falls back to whatever part is known.
export function shortAddress(a = {}) {
  const street = a.road || a.pedestrian || a.footway || a.square || a.industrial || a.retail || "";
  return [street, town(a)].filter(Boolean).join(", ");
}

function checkCoord(lat, lon) {
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) throw new Error("Invalid coordinates");
}

export async function reverseGeocode(lat, lon) {
  checkCoord(lat, lon);
  const p = new URLSearchParams({ format: "jsonv2", lat: String(lat), lon: String(lon), zoom: "18", addressdetails: "1" });
  const res = await fetch(`${BASE}/reverse?${p}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`Address lookup failed (${res.status})`);
  const json = await res.json();
  return { address: shortAddress(json.address), display: json.display_name || "" };
}

export async function searchAddress(query) {
  const p = new URLSearchParams({ format: "jsonv2", q: String(query).slice(0, 200), limit: "5", addressdetails: "1" });
  const res = await fetch(`${BASE}/search?${p}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`Address search failed (${res.status})`);
  const list = await res.json();
  return list.map((r) => ({
    lat: Number(r.lat),
    lon: Number(r.lon),
    address: shortAddress(r.address),
    display: r.display_name,
  }));
}
