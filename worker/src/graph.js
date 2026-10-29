// Microsoft Graph (OneDrive, personal account) helpers.
const AUTH_BASE = "https://login.microsoftonline.com/consumers/oauth2/v2.0";
const GRAPH = "https://graph.microsoft.com/v1.0";
export const SCOPES = "offline_access Files.ReadWrite User.Read";
const REFRESH_KEY = "ms_refresh_token";

export function authorizeUrl(env, redirectUri, state) {
  const p = new URLSearchParams({
    client_id: env.MS_CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri,
    response_mode: "query",
    scope: SCOPES,
    state,
  });
  return `${AUTH_BASE}/authorize?${p}`;
}

async function tokenRequest(env, params) {
  const body = new URLSearchParams({
    client_id: env.MS_CLIENT_ID,
    client_secret: env.MS_CLIENT_SECRET,
    scope: SCOPES,
    ...params,
  });
  const res = await fetch(`${AUTH_BASE}/token`, { method: "POST", body });
  const json = await res.json();
  if (!res.ok) throw new Error(`Microsoft token error: ${json.error_description || json.error || res.status}`);
  if (json.refresh_token) await env.KV.put(REFRESH_KEY, json.refresh_token);
  return json.access_token;
}

export function exchangeCode(env, code, redirectUri) {
  return tokenRequest(env, { grant_type: "authorization_code", code, redirect_uri: redirectUri });
}

export async function isConnected(env) {
  return !!(await env.KV.get(REFRESH_KEY));
}

export class Drive {
  constructor(env) {
    this.env = env;
    this.token = null;
  }

  async accessToken() {
    if (this.token) return this.token;
    const refresh = await this.env.KV.get(REFRESH_KEY);
    if (!refresh) throw new HttpError(409, "OneDrive is not connected. Open Settings > Connect OneDrive.");
    this.token = await tokenRequest(this.env, { grant_type: "refresh_token", refresh_token: refresh });
    return this.token;
  }

  async call(method, url, { body, headers = {}, raw = false } = {}) {
    const token = await this.accessToken();
    const res = await fetch(url.startsWith("http") ? url : GRAPH + url, {
      method,
      body,
      headers: { Authorization: `Bearer ${token}`, ...headers },
    });
    if (raw) return res;
    if (!res.ok) {
      const text = await res.text();
      throw new HttpError(res.status, `OneDrive ${method} failed (${res.status}): ${text.slice(0, 300)}`);
    }
    return res.status === 204 ? null : res.json();
  }

  static itemPath(path) {
    // "/Ritlog/file.xlsx" -> "/me/drive/root:/Ritlog/file.xlsx:"
    const enc = path.split("/").map(encodeURIComponent).join("/");
    return `/me/drive/root:${enc}:`;
  }

  // Returns {bytes, etag} or null when the file does not exist.
  async download(path) {
    const meta = await this.call("GET", Drive.itemPath(path), { raw: true });
    if (meta.status === 404) return null;
    if (!meta.ok) throw new HttpError(meta.status, `OneDrive read failed (${meta.status}) for ${path}`);
    const item = await meta.json();
    const res = await this.call("GET", `${Drive.itemPath(path)}/content`, { raw: true });
    if (!res.ok) throw new HttpError(res.status, `OneDrive download failed (${res.status}) for ${path}`);
    return { bytes: new Uint8Array(await res.arrayBuffer()), etag: item.eTag, id: item.id };
  }

  // Simple upload (files up to 250 MB). ifMatch protects against overwriting newer edits.
  async upload(path, bytes, contentType = "application/octet-stream", ifMatch = null) {
    const headers = { "Content-Type": contentType };
    if (ifMatch) headers["If-Match"] = ifMatch;
    const res = await this.call("PUT", `${Drive.itemPath(path)}/content`, { body: bytes, headers, raw: true });
    if (res.status === 412) throw new HttpError(412, `File changed on OneDrive while saving: ${path}`);
    if (res.status === 423) throw new HttpError(423, `File is locked on OneDrive: ${path}`);
    if (!res.ok) throw new HttpError(res.status, `OneDrive upload failed (${res.status}) for ${path}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }

  async move(fromPath, toFolder, newName) {
    return this.call("PATCH", Drive.itemPath(fromPath), {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName, parentReference: { path: `/drive/root:${toFolder}` } }),
    });
  }

  async remove(path) {
    const res = await this.call("DELETE", Drive.itemPath(path), { raw: true });
    if (!res.ok && res.status !== 404) throw new HttpError(res.status, `OneDrive delete failed (${res.status})`);
  }
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
