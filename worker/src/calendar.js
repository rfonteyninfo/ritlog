// Google Calendar (read-only): meetings around a ride, reduced to what the proposals need.
const API = "https://www.googleapis.com/calendar/v3";

function domainOf(email) {
  return String(email || "").split("@")[1]?.toLowerCase() || "";
}

// One calendar's events between two ISO times. drive.call adds the Google access token.
export async function listEvents(drive, calendarId, timeMin, timeMax) {
  const p = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "50",
    fields: "items(id,status,summary,location,start,end,attendees(email,self,responseStatus))",
  });
  const res = await drive.call("GET", `${API}/calendars/${encodeURIComponent(calendarId)}/events?${p}`, { raw: true });
  if (res.status === 403) return { events: [], error: "No calendar access yet. Settings > Connect Google again and allow the calendar." };
  if (!res.ok) return { events: [], error: `Calendar read failed (${res.status})` };
  const json = await res.json();
  const events = (json.items || [])
    .filter((e) => e.status !== "cancelled")
    .map((e) => {
      const me = (e.attendees || []).find((a) => a.self);
      return {
        id: e.id,
        summary: String(e.summary || "").slice(0, 200),
        location: String(e.location || "").slice(0, 200),
        start: e.start?.dateTime || e.start?.date || "",
        end: e.end?.dateTime || e.end?.date || "",
        allDay: !e.start?.dateTime,
        declined: me?.responseStatus === "declined",
        domains: [...new Set((e.attendees || []).filter((a) => !a.self).map((a) => domainOf(a.email)).filter(Boolean))],
      };
    });
  return { events };
}
