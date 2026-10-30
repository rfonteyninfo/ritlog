# Ritlog: setup (phase 1)

All in the browser, nothing to install except Google Drive for desktop (optional).

**Secrets go straight into GitHub, never in a chat.** Keep this page open in a second tab:
https://github.com/rfonteyninfo/ritlog/settings/secrets/actions
Each step below says which secret to add there the moment you create it.

| # | Where | Status |
|---|---|---|
| 1 | Google Drive | Excel file in place |
| 2 | Cloudflare | Done: subdomain `roel-51c`, KV namespace created |
| 3 | Anthropic | API key |
| 4 | Google Cloud | OAuth client for Drive access |
| 5 | GitHub | Remaining secrets, Pages, deploy |
| 6 | Phone | Install and connect |

Your addresses:
- Backend: `https://ritlog.roel-51c.workers.dev`
- App: `https://rfonteyninfo.github.io/ritlog/`

---

## 1. Google Drive

1. Go to drive.google.com, signed in as **roel@fonteyn.info**.
2. In **My Drive** create a folder `Ritlog`.
3. Upload `rekenmodule_auto_vs_motor_v4.xlsx` into it, exactly that name. **Do not** convert it to Google Sheets (Drive keeps it as .xlsx unless you open it with Sheets and save as Sheets).
4. Remove or rename the copy on OneDrive, so you never fill in the wrong file by hand.
5. Optional, recommended: install **Google Drive for desktop** (google.com/drive/download), sign in with the same account. The file then shows up in Explorer under `G:\My Drive\Ritlog` and opens in Excel as before.

The app creates `Ritlog-fotos` and `Ritlog-app` itself in My Drive. To use another folder or file name, change `EXCEL_PATH` in `worker/wrangler.toml`.

## 2. Cloudflare

Done, except two values for GitHub:

1. **Account ID**: dash.cloudflare.com > **Workers & Pages** overview, right column. Add it as secret `CLOUDFLARE_ACCOUNT_ID`.
2. **API token**: profile icon > **My Profile > API Tokens > Create Token** > template **Edit Cloudflare Workers** > Continue to summary > Create Token. Add it as secret `CLOUDFLARE_API_TOKEN`.
3. In the GitHub tab **Variables** (same settings page), add `KV_NAMESPACE_ID` with your KV namespace ID.

## 3. Anthropic (odometer reading)

1. console.anthropic.com > add a payment method and a small credit (for example $10).
2. **API Keys > Create Key**, name `ritlog`. A valid key starts with `sk-ant-api`. Add it as secret `ANTHROPIC_API_KEY`.
3. Recommended: **Limits**, set a monthly spend limit (for example $10).

## 4. Google Cloud (Drive access)

Free. No billing account and no card needed. If Google offers a "free trial" asking for a card, close that banner.

1. Go to console.cloud.google.com, signed in as **roel@fonteyn.info**.
2. Project selector (top left) > **New project**, name `ritlog`, organization `fonteyn.info` > Create. Make sure `ritlog` is selected.
3. **APIs & Services > Library**, search **Google Drive API** > **Enable**.
4. **Google Auth Platform** (older screens: **OAuth consent screen**) > **Get started**:
   - App name `Ritlog`, support email `roel@fonteyn.info`
   - Audience: **Internal** (only your domain can use it, no Google review, logins do not expire after 7 days)
   - Contact email `roel@fonteyn.info` > agree > **Create**
5. **Clients > Create client**:
   - Application type: **Web application**, name `Ritlog`
   - **Authorized redirect URIs** > Add URI: `https://ritlog.roel-51c.workers.dev/auth/callback`
   - **Create**
6. Copy right away:
   - **Client ID** (ends with `.apps.googleusercontent.com`) > secret `GOOGLE_CLIENT_ID`
   - **Client secret** (starts with `GOCSPX-`) > secret `GOOGLE_CLIENT_SECRET`

Check: Google sometimes renames these menus. If you cannot find a step, search the console for the bold words.

## 5. GitHub

1. Secrets page (https://github.com/rfonteyninfo/ritlog/settings/secrets/actions), tab **Secrets**. Add the last one:
   - `APP_TOKEN`: invent a long access code (20+ characters). You type it once on your phone.
2. Check that all 7 are there: `APP_TOKEN`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `ANTHROPIC_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (secrets) and `KV_NAMESPACE_ID` (variable).
3. https://github.com/rfonteyninfo/ritlog/settings/pages > Source: **GitHub Actions**.
4. **Actions** tab: run **Deploy backend (Cloudflare Worker)** and **Deploy app (GitHub Pages)** with **Run workflow**. Both should end green.
5. Open `https://ritlog.roel-51c.workers.dev`. It shows "Ritlog backend is running."

## 6. Phone

1. In Chrome on Android open `https://rfonteyninfo.github.io/ritlog/`
2. Menu (three dots) > **Add to Home screen** > Install.
3. Open Ritlog > **Settings**:
   - Backend URL: `https://ritlog.roel-51c.workers.dev`
   - Access code: your `APP_TOKEN`
   - **Save and test** shows "Backend OK".
4. **Connect Google Drive** > sign in as roel@fonteyn.info > Allow. Back in the app, Save and test shows "Google Drive connected".
5. **Vehicles > Register vehicle**: Vespa now. Motor and Auto when you buy them.
6. Test ride: **Rides > Start ride**, photo, confirm. After the ride: **End ride**, photo, fill in, Save. Open the Excel file: a new row in Ritlog, ride ID in column H.

---

## Good to know

- **Excel open on your PC while you save a ride:** the backend checks the file version just before writing. If the file changed, the ride shows "Not in Excel" with a **Retry** button. Save and close the file, wait until Drive for desktop has synced, tap Retry. The check is not atomic: a save from your PC in the same few seconds can still be overwritten.
- **Deleting rides or cancelled start photos** goes to the Google Drive trash (recoverable for 30 days).
- **Model and cost:** odometer photos are read by `claude-opus-5-5` (`CLAUDE_MODEL` in `worker/wrangler.toml`). About $0.01 to $0.015 per photo, so $0.02 to $0.03 per ride. Check: your real cost after a week (Anthropic console > Usage). `claude-haiku-5-5` costs about 40 times less. Test it on your own dashboards before switching.
- **Updates:** every change merged into `main` redeploys automatically.
