// Shared helpers: types, crypto, validation, file checks, rate limiting.

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  // Ordinary variables (wrangler.jsonc "vars")
  OWNER_USERNAME: string;
  CONTACT_EMAIL?: string;
  MAX_FILE_BYTES?: string;
  MAX_REQUEST_BYTES?: string;
  DELIVERABLE_GRACE_DAYS?: string;
  INQUIRY_FILE_RETENTION_DAYS?: string;
  RECEIPT_RETENTION_DAYS?: string;
  // Secrets (wrangler secret put)
  OWNER_SETUP_SECRET?: string;
  DISCORD_WEBHOOK_URL?: string;
}

export type Role = "student" | "owner";
export interface User { id: string; username: string; display_name: string | null; role: Role }
export interface Ctx { req: Request; env: Env; ec: ExecutionContext; url: URL; user: User | null; csrf: string | null }

export const SERVICES = [
  "School Assignments & Activities",
  "Research Proposal, Topics & Outlines",
  "PowerPoint Presentations",
  "Document Formatting",
  "Typing & Encoding",
  "Document Organization",
  "Other Simple Task",
];
export const LEVELS = ["Elementary School", "Junior High School", "Senior High School"];
export const STATUSES = ["Submitted", "Read", "Under Review", "Awaiting Response", "Accepted", "In Progress", "Completed", "Declined", "Cancelled"];
export const TERMINAL = ["Completed", "Declined", "Cancelled"];
// Statuses the owner may move to, by current status.
export const TRANSITIONS: Record<string, string[]> = {
  Submitted: ["Read", "Under Review", "Awaiting Response", "Accepted", "Declined"],
  Read: ["Under Review", "Awaiting Response", "Accepted", "Declined"],
  "Under Review": ["Awaiting Response", "Accepted", "Declined"],
  "Awaiting Response": ["Under Review", "Accepted", "Declined", "Cancelled"],
  Accepted: ["In Progress", "Completed", "Awaiting Response", "Declined", "Cancelled"],
  "In Progress": ["Awaiting Response", "Completed", "Cancelled"],
  Completed: [], Declined: [], Cancelled: [],
};
export const STUDENT_OPEN = ["Submitted", "Read", "Under Review", "Awaiting Response"];

export const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "x-frame-options": "DENY",
};
export const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS, ...extra } });
export class HttpError extends Error { status: number; constructor(status: number, msg: string) { super(msg); this.status = status; } }
export function fail(status: number, msg: string): never { throw new HttpError(status, msg); }

export const uid = () => crypto.randomUUID();
export const nowIso = () => new Date().toISOString();
export const addDays = (d: number) => new Date(Date.now() + d * 86400000).toISOString();
export const clean = (s: unknown, max = 2000) => String(s ?? "").replace(/\u0000/g, "").trim().slice(0, max);
export const intEnv = (v: string | undefined, def: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : def; };

const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b as ArrayBuffer)].map(x => x.toString(16).padStart(2, "0")).join("");
export const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
export const randomToken = (bytes = 32) => hex(crypto.getRandomValues(new Uint8Array(bytes)));
export async function safeEqual(a: string, b: string) {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let d = 0; for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}
// Workers limits PBKDF2 to 100,000 iterations.
export async function passwordHash(password: string, salt: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: new TextEncoder().encode(salt), iterations: 100000, hash: "SHA-256" }, key, 256);
  return hex(bits);
}
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 chars, no 0/O/1/I
export function randomCode(groups: number, size = 4) {
  const b = crypto.getRandomValues(new Uint8Array(groups * size));
  const chars = [...b].map(x => ALPHABET[x % 32]);
  const out: string[] = [];
  for (let g = 0; g < groups; g++) out.push(chars.slice(g * size, (g + 1) * size).join(""));
  return out.join("-");
}
export const normalizeCode = (s: unknown) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 64);
export const hashCode = (s: unknown) => sha256("zein-code:" + normalizeCode(s));

export const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
export function validatePassword(p: string) {
  if (p.length < 10 || p.length > 128) fail(400, "Password must be 10 to 128 characters.");
}
export function validDate(s: string) {
  if (!s) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s + "T00:00:00Z"))) fail(400, "Dates must look like YYYY-MM-DD.");
  return s;
}

// Narrow screen for ineligible academic levels (the level dropdown is validated separately).
const INELIGIBLE = /\b(college|university|undergrad(?:uate)?|post-?grad(?:uate)?|graduate school|master'?s|masteral|doctoral|doctorate|ph\.?\s?d|dissertation)\b/i;
export function screenEligibility(...texts: string[]) {
  if (texts.some(t => INELIGIBLE.test(t)))
    fail(400, "Zein E-Services only accepts Elementary, Junior High School, and Senior High School requests. College, university, and graduate-level work is not accepted.");
}

export async function rateLimit(env: Env, bucket: string, max: number, windowSec: number) {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits(bucket,count,window_start) VALUES(?,1,?)
     ON CONFLICT(bucket) DO UPDATE SET
       count = CASE WHEN window_start <= ? THEN 1 ELSE count + 1 END,
       window_start = CASE WHEN window_start <= ? THEN ? ELSE window_start END
     RETURNING count`
  ).bind(bucket, now, now - windowSec, now - windowSec, now).first<{ count: number }>();
  return (row?.count ?? 1) <= max;
}
export async function limitOrFail(env: Env, bucket: string, max: number, windowSec: number, msg = "Too many attempts. Please wait a while and try again.") {
  if (!(await rateLimit(env, bucket, max, windowSec))) fail(429, msg);
}
export const clientIp = (req: Request) => req.headers.get("cf-connecting-ip") || "local";

export async function secEvent(env: Env, type: string, userId: string | null, username: string | null, detail = "") {
  try {
    await env.DB.prepare("INSERT INTO security_events(id,user_id,username,event_type,detail) VALUES(?,?,?,?,?)")
      .bind(uid(), userId, username, type, detail.slice(0, 300)).run();
  } catch (e) { console.error("secEvent failed"); }
}

// ---------- File validation ----------
export interface FileRule { mime: string[]; sig: (b: Uint8Array) => boolean }
const starts = (b: Uint8Array, ...bytes: number[]) => bytes.every((x, i) => b[i] === x);
const latin1 = (b: Uint8Array) => { let s = ""; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192)); return s; };
const isZip = (b: Uint8Array) => starts(b, 0x50, 0x4b, 0x03, 0x04);
export const FILE_RULES: Record<string, FileRule> = {
  pdf: { mime: ["application/pdf"], sig: b => starts(b, 0x25, 0x50, 0x44, 0x46, 0x2d) },
  doc: { mime: ["application/msword"], sig: b => starts(b, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1) },
  docx: { mime: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"], sig: b => isZip(b) && latin1(b).includes("word/") },
  pptx: { mime: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"], sig: b => isZip(b) && latin1(b).includes("ppt/") },
  txt: { mime: ["text/plain"], sig: b => { if (b.subarray(0, 8192).includes(0)) return false; try { new TextDecoder("utf-8", { fatal: true }).decode(b); return true; } catch { return false; } } },
  jpg: { mime: ["image/jpeg"], sig: b => starts(b, 0xff, 0xd8, 0xff) },
  jpeg: { mime: ["image/jpeg"], sig: b => starts(b, 0xff, 0xd8, 0xff) },
  png: { mime: ["image/png"], sig: b => starts(b, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) },
};
export const REQUEST_EXTS = ["pdf", "doc", "docx", "pptx", "txt", "jpg", "jpeg", "png"];
export const RECEIPT_EXTS = ["pdf", "jpg", "jpeg", "png"];
export const QR_EXTS = ["jpg", "jpeg", "png"];
export const CANONICAL_MIME: Record<string, string> = { jpeg: "image/jpeg", jpg: "image/jpeg" };

export function safeName(name: string) {
  const n = name.normalize("NFKC").replace(/[\\/]/g, "_").replace(/[^\w.\- ()]/g, "_").replace(/^\.+/, "").slice(0, 120);
  return n || "file";
}
export interface CheckedFile { name: string; ext: string; mime: string; size: number; data: Uint8Array }
export async function checkFile(file: File, allowedExts: string[], maxBytes: number): Promise<CheckedFile> {
  const name = safeName(file.name || "file");
  const ext = (name.split(".").pop() || "").toLowerCase();
  const rule = FILE_RULES[ext];
  if (!rule || !allowedExts.includes(ext)) fail(400, `"${name}" has an unsupported file type. Allowed: ${allowedExts.join(", ").toUpperCase()}.`);
  if (file.size <= 0) fail(400, `"${name}" is empty.`);
  if (file.size > maxBytes) fail(400, `"${name}" is larger than ${Math.round(maxBytes / 1048576)} MB.`);
  if (!rule.mime.includes(file.type)) fail(400, `"${name}" has a file type that does not match its extension.`);
  const data = new Uint8Array(await file.arrayBuffer());
  if (!rule.sig(data)) fail(400, `"${name}" does not look like a valid ${ext.toUpperCase()} file.`);
  return { name, ext, mime: rule.mime[0], size: data.byteLength, data };
}
export function contentDisposition(name: string, inline = false) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
export function fileResponse(body: ReadableStream | null, mime: string, name: string, inline: boolean) {
  const imgOk = inline && (mime === "image/png" || mime === "image/jpeg");
  return new Response(body, { headers: {
    "content-type": mime, "content-disposition": contentDisposition(name, imgOk),
    "cache-control": "private, no-store", "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; img-src 'self'; sandbox", ...SECURITY_HEADERS,
  } });
}
