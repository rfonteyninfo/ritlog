// Google Drive helpers (Workspace account, OAuth with an Internal consent screen).
// Same interface as the earlier OneDrive module: files are addressed by path,
// e.g. "/Ritlog/rekenmodule_auto_vs_motor_v4.xlsx" (relative to My Drive).
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
// Full Drive scope: the app must open the Excel file you uploaded yourself.
export const SCOPES = "https://www.googleapis.com/auth/drive";
const REFRESH_KEY = "google_refresh_token";
const FOLDER = "application/vnd.google-apps.folder";

export function authorizeUrl(env, redirectUri, state) {
  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${AUTH_URL}?${p}`;
}

async function tokenRequest(env, params) {
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    ...params,
  });
  const res = await fetch(TOKEN_URL, { method: "POST", body });
  const json = await res.json();
  if (!res.ok) {
    if (json.error === "invalid_grant") {
      await env.KV.delete(REFRESH_KEY);
      throw new HttpError(409, "Google Drive access expired. Open Settings > Connect Google Drive.");
    }
    throw new Error(`Google token error: ${json.error_description || json.error || res.status}`);
  }
  if (json.refresh_token) await env.KV.put(REFRESH_KEY, json.refresh_token);
  return json.access_token;
}

export function exchangeCode(env, code, redirectUri) {
  return tokenRequest(env, { grant_type: "authorization_code", code, redirect_uri: redirectUri });
}

export async function isConnected(env) {
  return !!(await env.KV.get(REFRESH_KEY));
}

function q(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function splitPath(path) {
  const parts = path.split("/").filter(Boolean);
  return { folders: parts.slice(0, -1), name: parts[parts.length - 1] };
}

export class Drive {
  constructor(env) {
    this.env = env;
    this.token = null;
    this.folderIds = new Map(); // "/Ritlog-fotos/2027" -> id
  }

  async accessToken() {
    if (this.token) return this.token;
    const refresh = await this.env.KV.get(REFRESH_KEY);
    if (!refresh) throw new HttpError(409, "Google Drive is not connected. Open Settings > Connect Google Drive.");
    this.token = await tokenRequest(this.env, { grant_type: "refresh_token", refresh_token: refresh });
    return this.token;
  }

  async call(method, url, { body, headers = {}, raw = false } = {}) {
    const token = await this.accessToken();
    const res = await fetch(url, { method, body, headers: { Authorization: `Bearer ${token}`, ...headers } });
    if (raw) return res;
    if (!res.ok) {
      const text = await res.text();
      throw new HttpError(res.status, `Google Drive ${method} failed (${res.status}): ${text.slice(0, 300)}`);
    }
    return res.status === 204 ? null : res.json();
  }

  // Child of a folder by name, newest first if there are duplicates.
  async findChild(parentId, name, folderOnly = false) {
    const query = [`name = '${q(name)}'`, `'${parentId}' in parents`, "trashed = false"];
    if (folderOnly) query.push(`mimeType = '${FOLDER}'`);
    const p = new URLSearchParams({ q: query.join(" and "), fields: "files(id,name,version,mimeType)", orderBy: "modifiedTime desc", pageSize: "10" });
    const res = await this.call("GET", `${API}/files?${p}`);
    return res.files[0] || null;
  }

  // Folder id for a path like "/Ritlog-fotos/2027/01". Creates missing folders when create is true.
  async folderId(folders, create) {
    let id = "root";
    let path = "";
    for (const part of folders) {
      path += "/" + part;
      if (this.folderIds.has(path)) {
        id = this.folderIds.get(path);
        continue;
      }
      let folder = await this.findChild(id, part, true);
      if (!folder) {
        if (!create) return null;
        folder = await this.call("POST", `${API}/files?fields=id`, {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: part, mimeType: FOLDER, parents: [id] }),
        });
      }
      id = folder.id;
      this.folderIds.set(path, id);
    }
    return id;
  }

  async stat(path) {
    const { folders, name } = splitPath(path);
    const parent = await this.folderId(folders, false);
    if (!parent) return null;
    return this.findChild(parent, name);
  }

  // Returns {bytes, etag, id} or null when the file does not exist. etag = Drive "version".
  async download(path) {
    const file = await this.stat(path);
    if (!file) return null;
    const res = await this.call("GET", `${API}/files/${file.id}?alt=media`, { raw: true });
    if (!res.ok) throw new HttpError(res.status, `Google Drive download failed (${res.status}) for ${path}`);
    return { bytes: new Uint8Array(await res.arrayBuffer()), etag: file.version, id: file.id };
  }

  // ifMatch: the version seen at download. If the file changed since, nothing is written (412).
  // Drive has no atomic check, so the check runs just before writing.
  async upload(path, bytes, contentType = "application/octet-stream", ifMatch = null) {
    const existing = await this.stat(path);
    if (existing) {
      if (ifMatch && existing.version !== ifMatch) throw new HttpError(412, `File changed on Google Drive while saving: ${path}`);
      return this.call("PATCH", `${UPLOAD}/files/${existing.id}?uploadType=media&fields=id,version`, {
        body: bytes,
        headers: { "Content-Type": contentType },
      });
    }
    if (ifMatch) throw new HttpError(412, `File disappeared from Google Drive while saving: ${path}`);
    const { folders, name } = splitPath(path);
    const parent = await this.folderId(folders, true);
    const boundary = "ritlog" + crypto.randomUUID().replace(/-/g, "");
    const enc = new TextEncoder();
    const head = enc.encode(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
        JSON.stringify({ name, parents: [parent] }) +
        `\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`
    );
    const tail = enc.encode(`\r\n--${boundary}--`);
    const body = new Uint8Array(head.length + bytes.length + tail.length);
    body.set(head, 0);
    body.set(bytes, head.length);
    body.set(tail, head.length + bytes.length);
    return this.call("POST", `${UPLOAD}/files?uploadType=multipart&fields=id,version`, {
      body,
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    });
  }

  async move(fromPath, toFolder, newName) {
    const file = await this.stat(fromPath);
    if (!file) throw new HttpError(404, `File not found on Google Drive: ${fromPath}`);
    const meta = await this.call("GET", `${API}/files/${file.id}?fields=parents`);
    const target = await this.folderId(toFolder.split("/").filter(Boolean), true);
    const p = new URLSearchParams({ addParents: target, removeParents: (meta.parents || []).join(","), fields: "id" });
    return this.call("PATCH", `${API}/files/${file.id}?${p}`, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName }),
    });
  }

  // Moves the file to the Drive trash (recoverable for 30 days).
  async remove(path) {
    const file = await this.stat(path);
    if (!file) return;
    await this.call("PATCH", `${API}/files/${file.id}`, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: true }),
    });
  }
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
