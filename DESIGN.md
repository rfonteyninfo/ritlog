# Ritlog app: design v1 (for approval)

Goal: log every ride into the Ritlog tab of `rekenmodule_auto_vs_motor_v4.xlsx` from two odometer photos, with Vehicle, Type, From, To and Client/purpose proposed by the app and confirmed by you in a few taps.

---

## 1. Architecture

| Part | Runs on | Role |
|---|---|---|
| Web app (PWA) | Android home screen, hosted on GitHub Pages | Camera, GPS, screens, offline queue |
| Backend | Cloudflare Worker (free tier) | Holds all keys, calls Claude, fetches calendar ICS feeds, geocodes, writes to OneDrive |
| Excel + photos + app data | OneDrive (personal Microsoft account) | Single source you open in Excel as today |
| Odometer reading | Claude API (vision) | Reads the odometer, returns dashboard class (car / motorcycle / scooter) |
| Calendars | Google Workspace, secret ICS links | Type, client and place proposals |
| Addresses | OpenStreetMap Nominatim | GPS to street/town, event location to coordinates |

- The phone only stores one access code for the Worker. No Microsoft, Google or Anthropic keys on the phone.
- App data (vehicles, places, calendars, rides) is saved as `/Ritlog-app/state.json` on OneDrive, so a lost phone loses nothing.
- Offline (parking garage): photos and GPS are queued on the phone and processed when the connection returns.

---

## 2. Settings (all editable in the app)

**Vehicles**
- Name: picked from the Lijsten tab (Auto, Motor, Cambio, Vespa), so Excel formulas keep working.
- Class: car / motorcycle / scooter.
- Registration: first odometer photo, date.
- Cambio is built in. It has no odometer history.

**Calendars**
- Per calendar: a display name, its secret ICS link, and the Type it maps to.
- Example: "Huawei" maps to Zakelijk, "Syntra" to Zelfstandig, "Coaching" to Zelfstandig, "Private" to Privé.

**Known places**
- Per place: name, category (Home, Work, Syntra, Client, Other, or your own), coordinates, radius (default 300 m), optional default Type, optional email domains (for example `proximus.com`).

**Rules**
- Maximum km per day used for odometer matching (default 600).
- Calendar time window around a ride (default: event overlaps the ride, or starts within 60 min after arrival).

---

## 3. Ride flow

**Start**
1. Tap "Start ride", take the odometer photo.
2. The app reads the odometer number and dashboard class, and records GPS and time.
3. The app proposes the vehicle (section 4). You confirm the number and the vehicle.

**End**
1. Tap the open ride, take the odometer photo. Vehicle is taken from the start.
2. The app computes km = end minus start and records GPS and time.
3. Proposal screen, every field can be overwritten:
   - Date (from start), Vehicle, Type, From, To, Client/purpose, Km, Note.
4. Tap "Save": the row is written to Excel and the photos are renamed and stored.

---

## 4. Vehicle matching (start photo only)

Two signals: the odometer range and the dashboard class.

| Reading fits a vehicle's range | Dashboard class | Result |
|---|---|---|
| One vehicle | Same class | That vehicle |
| Several vehicles | Matches one of them | The class decides |
| None | Car | Cambio |
| None | Motorcycle or scooter | Ask: misread number or new vehicle |

- Range = last known reading up to last known reading + (days since then × max km per day).
- Every confirmed end reading becomes the vehicle's new last known reading.
- Cambio km are logged as usual. The monthly overview (section 9) compares them with the Cambio invoice.

---

## 5. Type proposal

Checked in this order. The first match wins.

1. **Calendar event** within the ride window, near the destination: Type of that calendar.
2. **Known place** at the destination with a default Type: that Type.
3. **Home and Work** on a weekday, either direction: Pendel.
4. **Motor or Vespa**, no event, round trip or no known destination: Fun.
5. **Otherwise**: Privé.

- Calendar wins over the place default (your choice).
- If several events match, the one closest in time to arrival is used.

**Mixed rides**
- If the ride matches Zakelijk on any part, Zakelijk is proposed.
- When the trip has a clear detour or private stop (for example ride time far longer than the direct route, or the ride ends at Home after an event), Note gets "mixed: private stop" and the row is marked in the app so you can correct or split it.

---

## 6. From, To and Client/purpose

**From / To**
- GPS within the radius of a known place: the place name ("Home", "Huawei Mechelen").
- Otherwise: street and town from Nominatim.

**Client/purpose**
- From the matching calendar event: client name derived from attendee email domains, then from the event subject.
- Your own domain and the Huawei domain are ignored when picking the client.

**Learning new known places**
When the destination is not a known place, the app proposes a new one:
- Name: from attendee domain (`proximus.com` becomes "Proximus"), else the event subject, else street and town.
- Coordinates: from the event location field (geocoded) if it is within 1 km of the GPS; else from GPS.
- Category: Client if it came from a Zakelijk calendar event, otherwise Other.
- Email domain saved with the place, so the next invite with that domain matches straight away.
- You confirm, edit or skip with one tap.

Check: Google's secret ICS feed includes attendee email addresses. I expect it does, but this must be verified with a real feed at setup. If Huawei meetings are copied into Google by hand, attendees will be missing, and the app falls back to the subject and location.

---

## 7. Gaps and warnings

On opening, the app shows a warning banner when there are:
- **Open rides**: start photo without end photo. Actions: add end photo, or close it with the next start reading of the same vehicle.
- **Unlogged km**: a vehicle's new start reading is higher than its last end reading. Action: log the difference as its own row (default Privé), or dismiss.
- **Rows not yet written to Excel** (offline or file locked). Action: retry.

---

## 8. Writing to Excel and storing photos

**Excel row (Ritlog, columns A to H only)**
- Written into the first row from row 5 down where column A is empty. Formula columns I to K are never touched.

| Column | Value |
|---|---|
| A Datum | Start date |
| B Voertuig | Vehicle name |
| C Type | Type |
| D Van | From |
| E Naar | To |
| F Klant / doel | Client/purpose |
| G Km | End minus start |
| H Opmerking | `R0142` + your note (+ "mixed: private stop" when set) |

**Ride ID**
- Format `R` + 4-digit sequence (R0001, R0002, ...). It never changes, even if you edit the row in Excel later.

**Photos**
- Location: OneDrive `/Ritlog-fotos/YYYY/MM/`.
- Name: `R0142_2027-01-14_0812_Motor_Zakelijk_Home-Proximus_start.jpg` and `..._end.jpg`.
- Spaces and special characters are stripped. Compressed to about 300 KB.

---

## 9. Screens

1. **Home**: warning banner, "Start ride" button, open rides, last 10 rides.
2. **Camera**: photo, read odometer, confirm number and vehicle.
3. **Proposal**: all fields with proposals, Save.
4. **History**: list of rides, filter by month, vehicle, Type. Tap to see photos.
5. **Monthly overview**: km per vehicle and Type, Cambio km to compare with the invoice.
6. **Settings**: vehicles, calendars, known places, rules.

Interface language: English.

---

## 10. Security and privacy

- The Worker only accepts requests with your access code.
- Odometer photos are sent to the Anthropic API for reading. GPS coordinates are sent to Nominatim for address lookup.
- Calendar ICS links are secret URLs: anyone with the link can read the calendar. They are only stored in the Worker.

---

## 11. Setup (you do this once, with step-by-step instructions from me)

1. Move the Excel file to OneDrive.
2. Microsoft Entra: register an app (personal account) for OneDrive access.
3. Anthropic: create an API key.
4. Cloudflare: account + deploy the Worker, enter the keys as secrets.
5. GitHub: account + repository, GitHub Pages for the web app.
6. Google Workspace: create the calendars, allow external sharing of event details (Admin console > Apps > Google Workspace > Calendar > Sharing settings), copy each secret ICS link into the app.
7. In the app: register vehicles, calendars, Home, Work and Syntra.

---

## 12. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Huawei meetings not synced into Google | Fewer Zakelijk proposals, no client names | Known client places still give Zakelijk |
| Odometer misread (glare, trip meter shown) | Wrong km | You always confirm the number. Range check flags impossible values |
| Excel open on PC while the app writes | Write fails | Queue and retry, warning banner |
| Mixed rides logged fully as Zakelijk | Overclaiming km-vergoeding | "mixed" flag in Note for review |
| ICS feed refresh delay (Google updates feeds with a delay) | New meeting not yet visible | Check: Google refresh interval. Manual Type override is always possible |

Check: monthly cost of the Claude API at your ride volume. Expected to be very low, to be confirmed after the first test week.

---

## 13. Build plan

1. **Phase 1**: Worker + PWA skeleton, vehicle registration, photo to odometer reading, manual entry of other fields, write to Excel, photo naming.
2. **Phase 2**: GPS, known places, From/To proposals.
3. **Phase 3**: calendar feeds, Type rules, client and new-place proposals, mixed flag.
4. **Phase 4**: warnings, monthly overview, Cambio check, history.

Each phase is testable on your phone before the next one starts.
