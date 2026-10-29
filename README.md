# Ritlog

Logs rides into the Ritlog tab of the vehicle cost workbook from two odometer photos.

- `app/`: phone web app (PWA), hosted on GitHub Pages
- `worker/`: backend (Cloudflare Worker): reads odometers with Claude, keeps app data, photos and Excel rows on OneDrive
- `test/`: tests (`npm test`; the end-to-end test needs Playwright and a local copy of the workbook as `test/fixture.xlsx`)

Setup: see [SETUP.md](SETUP.md). Design: see [DESIGN.md](DESIGN.md).

## Phase status

| Phase | Content | Status |
|---|---|---|
| 1 | Vehicles, odometer photo reading, vehicle proposal, manual fields, Excel row, photo naming | Built |
| 2 | GPS, known places, From/To proposals | Next |
| 3 | Calendars, Type rules, client and new-place proposals, mixed flag | |
| 4 | Gap warnings, monthly overview, Cambio check, history | |

## How the Excel row is written

The backend downloads the .xlsx, fills columns A to H of the first row (from row 5) where column A is empty, and uploads it with a version check (If-Match). Formula columns I to K and all other tabs stay untouched. Excel recalculates on opening. A ride ID already present in column H is never written twice.
