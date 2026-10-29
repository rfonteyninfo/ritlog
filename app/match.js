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
