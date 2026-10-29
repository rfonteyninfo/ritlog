# Ritlog: setup (phase 1)

About 45 minutes, all in the browser. You need nothing installed on your PC.

You will create five things. Keep a text file open to paste the values marked **[save]**.

| # | Where | What you get |
|---|---|---|
| 1 | OneDrive | Excel file in the right place |
| 2 | Cloudflare | KV ID, account ID, API token, your workers.dev address |
| 3 | Anthropic | API key |
| 4 | Microsoft Entra | Client ID, client secret |
| 5 | GitHub | The app and backend, deployed |

---

## 1. OneDrive

1. Sign in to onedrive.live.com with your **personal** Microsoft account.
2. Create a folder `Ritlog`.
3. Upload `rekenmodule_auto_vs_motor_v4.xlsx` into it. The name must match exactly. (To use another name or folder, change `EXCEL_PATH` in `worker/wrangler.toml`.)

The app creates `Ritlog-fotos` and `Ritlog-app` itself.

## 2. Cloudflare

1. Create a free account at dash.cloudflare.com.
2. **Workers & Pages** > open it once. Note your subdomain, shown as `<something>.workers.dev`.
   Your backend address will be `https://ritlog.<something>.workers.dev` **[save]**
3. **Storage & Databases > KV** > Create namespace, name `ritlog`. Copy its **ID** **[save: KV_NAMESPACE_ID]**
4. Account ID: on the Workers & Pages overview, right column, **Account ID** **[save: CLOUDFLARE_ACCOUNT_ID]**
5. API token: profile icon > **My Profile > API Tokens > Create Token** > template **Edit Cloudflare Workers** > Continue > Create. **[save: CLOUDFLARE_API_TOKEN]**

## 3. Anthropic (odometer reading)

1. console.anthropic.com > sign up, add a payment method and a small credit (for example $10).
2. **API Keys > Create Key**, name `ritlog`. **[save: ANTHROPIC_API_KEY]**
3. Recommended: **Limits**, set a monthly spend limit (for example $10).

## 4. Microsoft Entra (OneDrive access)

1. Go to entra.microsoft.com (or portal.azure.com) and sign in with the **same personal Microsoft account** as OneDrive.
   Check: with a personal account Microsoft may ask you to create a free directory first. Follow its steps.
2. **App registrations > New registration**
   - Name: `Ritlog`
   - Supported account types: **Personal Microsoft accounts only**
   - Redirect URI: platform **Web**, value `https://ritlog.<something>.workers.dev/auth/callback` (your address from step 2.2)
   - Register.
3. On the overview page copy **Application (client) ID** **[save: MS_CLIENT_ID]**
4. **Certificates & secrets > New client secret**, expiry 24 months. Copy the **Value** (not the ID) right away. **[save: MS_CLIENT_SECRET]**
   Put a reminder in your calendar 23 months from now: the app stops writing to OneDrive when this secret expires.
5. **API permissions**: `User.Read` is there by default. Add **Microsoft Graph > Delegated > Files.ReadWrite** and **offline_access**. No admin consent is needed for a personal account.

## 5. GitHub

1. Create a free account at github.com if you do not have one.
2. Create a new repository named `ritlog`, **Public** (GitHub Pages is free only for public repositories).
   The code holds no keys or personal data. Your Excel file is never part of the repository.
3. Put the project files in the repository. Two options:
   - Tell me the repository name and I push the code for you, or
   - **Add file > Upload files** and drag in the contents of the `ritlog-app` folder (including the `.github` folder).
4. **Settings > Secrets and variables > Actions**
   - Tab **Secrets**, add:
     - `APP_TOKEN`: invent a long access code (20+ characters). You type it once on your phone. **[save]**
     - `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `ANTHROPIC_API_KEY`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`
   - Tab **Variables**, add: `KV_NAMESPACE_ID`
5. **Settings > Pages**: Source **GitHub Actions**.
6. **Actions** tab: run **Deploy backend (Cloudflare Worker)** and **Deploy app (GitHub Pages)** (button **Run workflow**). Both should end green.
7. Check: open `https://ritlog.<something>.workers.dev` in a browser. It shows "Ritlog backend is running."

## 6. Phone

1. In Chrome on Android open `https://<your-github-name>.github.io/ritlog/`
2. Menu (three dots) > **Add to Home screen** > Install.
3. Open Ritlog > **Settings**:
   - Backend URL: `https://ritlog.<something>.workers.dev`
   - Access code: your `APP_TOKEN`
   - **Save and test** shows "Backend OK".
4. **Connect OneDrive** > sign in > accept. Back in the app, Save and test shows "OneDrive connected".
5. **Vehicles > Register vehicle**: Vespa now. Motor and Auto when you buy them.
6. Test ride: **Rides > Start ride**, photo, confirm. After the ride: **End ride**, photo, fill in, Save. Open the Excel file on OneDrive: a new row in Ritlog, ride ID in column H.

---

## Good to know

- **Excel open on your PC while you save a ride:** the app does not overwrite your edits. The ride shows "Not in Excel" and a **Retry** button. Close the file (or let AutoSave finish) and tap Retry.
- **Model and cost:** odometer photos are read by `claude-opus-5-5` (setting `CLAUDE_MODEL` in `worker/wrangler.toml`). Expected cost per photo is about $0.01 to $0.015, so roughly $0.02 to $0.03 per ride. Check: your real cost after a week in the Anthropic console (Usage). Switching to `claude-haiku-5-5` costs about 40 times less. Test it on your own dashboards before switching.
- **Updates:** every change pushed to the repository redeploys automatically.
