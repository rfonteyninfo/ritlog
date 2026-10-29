// File and ID naming shared by the worker.

export function rideId(n) {
  return "R" + String(n).padStart(4, "0");
}

// "Huawei Mechelen" -> "HuaweiMechelen", "Privé" -> "Prive"
export function slug(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("")
    .slice(0, 40);
}

// R0142_2027-01-14_0812_Motor_Zakelijk_Home-Proximus_start.jpg
export function photoName({ id, date, time, vehicle, type, from, to }, which) {
  const route = [slug(from) || "Unknown", slug(to) || "Unknown"].join("-");
  return [id, date, time.replace(":", ""), slug(vehicle), slug(type), route, which].join("_") + ".jpg";
}

// "/Ritlog-fotos/2027/01"
export function photoFolder(root, date) {
  const [y, m] = date.split("-");
  return `${root}/${y}/${m}`;
}
