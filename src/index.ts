import type { Env, Ctx, User, CheckedFile } from "./lib.ts";
import {
  SERVICES, LEVELS, STATUSES, TERMINAL, TRANSITIONS, STUDENT_OPEN, json, HttpError, fail, uid, nowIso, addDays,
  clean, intEnv, sha256, randomToken, safeEqual, passwordHash, randomCode, hashCode, USERNAME_RE, validatePassword, validDate,
  screenEligibility, limitOrFail, clientIp, secEvent, REQUEST_EXTS, RECEIPT_EXTS, QR_EXTS,
  fileResponse, SECURITY_HEADERS, checkFile,
} from "./lib.ts";
import { notify, NOTIFY_EVENTS, discordStatus, validDiscordId, sendTest } from "./notify.ts";
import { runScheduled } from "./cleanup.ts";

const COOKIE = "__Host-zein_session";
const SESSION_SECONDS = 365 * 86400;

// ---------- request helpers ----------
const cookieValue = (req: Request, name: string) => {
  const part = (req.headers.get("Cookie") || "").split(";").map(v => v.trim()).find(v => v.startsWith(name + "="));
  if (!part) return "";
  try { return decodeURIComponent(part.slice(name.length + 1)); } catch { return ""; }
};
const sessionCookie = (token: string, maxAge = SESSION_SECONDS) => `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
async function readJson(req: Request): Promise<any> {
  const text = await req.text();
  if (text.length > 65536) fail(413, "Request is too large.");
  try { return JSON.parse(text || "{}"); } catch { return fail(400, "Invalid request."); }
}
function sameOrigin(req: Request) {
  const origin = req.headers.get("Origin");
  if (origin) { try { return new URL(origin).host === new URL(req.url).host; } catch { return false; } }
  return req.headers.get("Sec-Fetch-Site") !== "cross-site";
}
function match(pattern: string, path: string): Record<string, string> | null {
  const names: string[] = [];
  const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, n) => { names.push(n); return "([\\w-]+)"; }) + "$");
  const m = path.match(re);
  return m ? Object.fromEntries(names.map((n, i) => [n, m[i + 1]])) : null;
}
const str = (f: FormData, k: string, max: number) => { const v = f.get(k); return typeof v === "string" ? clean(v, max) : ""; };
const filesOf = (f: FormData) => f.getAll("files").filter((v): v is File => typeof v !== "string" && (v as File).size !== undefined);

async function loadSession(req: Request, env: Env): Promise<{ user: User; csrf: string } | null> {
  const token = cookieValue(req, COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.id,u.username,u.display_name,u.role,s.csrf_token FROM sessions s JOIN users u ON u.id=s.user_id
     WHERE s.token_hash=? AND s.expires_at>? AND u.disabled=0`).bind(await sha256(token), nowIso()).first<any>();
  return row ? { user: { id: row.id, username: row.username, display_name: row.display_name, role: row.role }, csrf: row.csrf_token } : null;
}
async function startSession(env: Env, userId: string) {
  const token = randomToken(), csrf = randomToken(16);
  await env.DB.prepare("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES(?,?,?,?)")
    .bind(await sha256(token), userId, csrf, new Date(Date.now() + SESSION_SECONDS * 1000).toISOString()).run();
  return { token, csrf };
}
const publicUser = (u: User) => ({ id: u.id, username: u.username, displayName: u.display_name || u.username, role: u.role });
const need = (c: Ctx): User => c.user || fail(401, "Please sign in to continue.");
const needOwner = (c: Ctx): User => { const u = need(c); if (u.role !== "owner") fail(403, "Owner access required."); return u; };
const needStudent = (c: Ctx): User => { const u = need(c); if (u.role !== "student") fail(403, "This action is for student accounts."); return u; };

async function logEvent(env: Env, inquiryId: string, actor: string | null, type: string, message = "", visible = true) {
  await env.DB.prepare("INSERT INTO inquiry_events(id,inquiry_id,actor_user_id,event_type,message,visible_to_student) VALUES(?,?,?,?,?,?)")
    .bind(uid(), inquiryId, actor, type, message.slice(0, 1000), visible ? 1 : 0).run();
}
async function authedResponse(env: Env, user: User, status = 200, extra: Record<string, unknown> = {}) {
  const s = await startSession(env, user.id);
  return json({ user: publicUser(user), csrfToken: s.csrf, ...extra }, status, { "set-cookie": sessionCookie(s.token) });
}
async function storeFiles(env: Env, prefix: string, files: CheckedFile[]) {
  const stored: { id: string; key: string; f: CheckedFile }[] = [];
  try {
    for (const f of files) {
      const id = uid(), key = `${prefix}/${id}-${f.name}`;
      await env.FILES.put(key, f.data, { httpMetadata: { contentType: f.mime } });
      stored.push({ id, key, f });
    }
  } catch (e) { await queueDeletes(env, stored.map(s => s.key), "failed upload"); throw e; }
  return stored;
}
async function queueDeletes(env: Env, keys: string[], reason: string) {
  for (const k of keys) await env.DB.prepare("INSERT OR IGNORE INTO r2_cleanup(object_key,reason) VALUES(?,?)").bind(k, reason).run().catch(() => {});
}
async function checkUploads(env: Env, raw: File[], exts: string[], existingCount = 0, existingBytes = 0) {
  const maxFile = intEnv(env.MAX_FILE_BYTES, 5242880), maxTotal = intEnv(env.MAX_REQUEST_BYTES, 15728640);
  if (raw.length + existingCount > 5) fail(400, "A maximum of 5 files is allowed.");
  let total = existingBytes;
  const out: CheckedFile[] = [];
  for (const f of raw) { const c = await checkFile(f, exts, maxFile); total += c.size; out.push(c); }
  if (total > maxTotal) fail(400, "The total file size limit is 15 MB.");
  return out;
}

// ---------- main router ----------
async function handleApi(c: Ctx): Promise<Response> {
  const { req, env, url } = c, path = url.pathname, method = req.method;
  const ip = clientIp(req);
  if (method !== "GET" && method !== "HEAD" && !sameOrigin(req)) fail(403, "Invalid request origin.");
  const sess = await loadSession(req, env);
  c.user = sess?.user || null; c.csrf = sess?.csrf || null;
  if (c.user && method !== "GET" && method !== "HEAD") {
    if (!c.csrf || req.headers.get("x-csrf-token") !== c.csrf) fail(403, "Session check failed. Please refresh the page.");
  }
  let p: Record<string, string> | null;

  if (path === "/api/health") return json({ ok: true, service: "Zein E-Services" });
  if (path === "/api/config") return json({
    services: SERVICES, levels: LEVELS, statuses: STATUSES, transitions: TRANSITIONS, contactEmail: clean(env.CONTACT_EMAIL, 254),
    limits: { files: 5, fileBytes: intEnv(env.MAX_FILE_BYTES, 5242880), totalBytes: intEnv(env.MAX_REQUEST_BYTES, 15728640) },
  });
  if (path === "/api/me") return json({ user: c.user ? publicUser(c.user) : null, csrfToken: c.csrf });

  if (path === "/api/reviews" && method === "GET") {
    const rows = await env.DB.prepare(`SELECT r.rating,r.comment,r.created_at,i.service FROM reviews r JOIN inquiries i ON i.id=r.inquiry_id
      WHERE r.visible=1 ORDER BY r.created_at DESC LIMIT 50`).all();
    return json({ reviews: rows.results });
  }

  // ----- authentication -----
  if (path === "/api/auth/register" && method === "POST") {
    const b = await readJson(req);
    const username = clean(b.username, 40), password = String(b.password ?? "");
    if (!USERNAME_RE.test(username)) fail(400, "Username must be 3 to 32 characters: letters, numbers, dot, dash or underscore.");
    validatePassword(password);
    const email = clean(b.email, 254);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, "That email address does not look valid.");
    await limitOrFail(env, `register:ip:${ip}`, 10, 3600);
    if (username.toLowerCase() === clean(env.OWNER_USERNAME, 40).toLowerCase()) fail(409, "That username is not available.");
    if (await env.DB.prepare("SELECT 1 x FROM users WHERE username=?").bind(username).first()) fail(409, "That username is already taken.");
    const id = uid(), salt = randomToken(16), recovery = randomCode(5);
    try {
      await env.DB.prepare("INSERT INTO users(id,username,display_name,email,password_hash,password_salt,recovery_code_hash,role) VALUES(?,?,?,?,?,?,?, 'student')")
        .bind(id, username, clean(b.displayName, 60) || null, email || null, await passwordHash(password, salt), salt, await hashCode(recovery)).run();
    } catch { fail(409, "That username is already taken."); }
    return authedResponse(env, { id, username, display_name: clean(b.displayName, 60) || null, role: "student" }, 201, { recoveryCode: recovery });
  }

  if (path === "/api/owner/setup" && method === "POST") {
    const b = await readJson(req);
    await limitOrFail(env, `ownersetup:ip:${ip}`, 5, 3600);
    const username = clean(b.username, 40), password = String(b.password ?? "");
    const secret = env.OWNER_SETUP_SECRET || "";
    if (secret.length < 32 || !(await safeEqual(String(b.setupSecret ?? ""), secret)) || username.toLowerCase() !== clean(env.OWNER_USERNAME, 40).toLowerCase()) {
      await secEvent(env, "owner_setup_denied", null, username); fail(403, "Owner setup is not available with those details.");
    }
    if (await env.DB.prepare("SELECT 1 x FROM users WHERE role='owner'").first()) fail(403, "Owner setup is not available with those details.");
    if (!USERNAME_RE.test(username)) fail(400, "Invalid owner username.");
    validatePassword(password);
    if (await env.DB.prepare("SELECT 1 x FROM users WHERE username=?").bind(username).first()) fail(409, "That username is already in use.");
    const id = uid(), salt = randomToken(16), recovery = randomCode(5);
    try {
      await env.DB.prepare("INSERT INTO users(id,username,display_name,password_hash,password_salt,recovery_code_hash,role) VALUES(?,?,'Owner',?,?,?,'owner')")
        .bind(id, username, await passwordHash(password, salt), salt, await hashCode(recovery)).run();
    } catch { fail(403, "Owner setup is not available with those details."); }
    await secEvent(env, "owner_created", id, username);
    return authedResponse(env, { id, username, display_name: "Owner", role: "owner" }, 201, { recoveryCode: recovery });
  }

  if (path === "/api/auth/login" && method === "POST") {
    const b = await readJson(req);
    const username = clean(b.username, 40), password = String(b.password ?? "").slice(0, 200);
    await limitOrFail(env, `login:ip:${ip}`, 30, 900);
    await limitOrFail(env, `login:user:${username.toLowerCase()}`, 10, 900);
    const row = await env.DB.prepare("SELECT * FROM users WHERE username=? AND disabled=0").bind(username).first<any>();
    const hash = await passwordHash(password, row?.password_salt || "0".repeat(32)); // constant work for unknown users
    if (!row || !(await safeEqual(hash, row.password_hash))) {
      await secEvent(env, "login_failed", row?.id || null, username.slice(0, 40));
      fail(401, "Username or password is incorrect.");
    }
    if (row.role === "owner") await secEvent(env, "owner_login", row.id, row.username);
    return authedResponse(env, { id: row.id, username: row.username, display_name: row.display_name, role: row.role });
  }

  if (path === "/api/auth/logout" && method === "POST") {
    const token = cookieValue(req, COOKIE);
    if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha256(token)).run();
    return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
  }
  if (path === "/api/auth/logout-all" && method === "POST") {
    const u = need(c);
    await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(u.id).run();
    await secEvent(env, "sessions_revoked", u.id, u.username, "user requested sign-out everywhere");
    return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
  }

  // ----- recovery -----
  if (path === "/api/auth/recover" && method === "POST") {
    const b = await readJson(req);
    const username = clean(b.username, 40);
    await limitOrFail(env, `recover:ip:${ip}`, 20, 3600);
    await limitOrFail(env, `recover:user:${username.toLowerCase()}`, 10, 3600);
    const row = await env.DB.prepare("SELECT id,username,recovery_code_hash FROM users WHERE username=? AND disabled=0").bind(username).first<any>();
    const given = await hashCode(b.code);
    if (!row || !row.recovery_code_hash || !(await safeEqual(given, row.recovery_code_hash))) {
      await secEvent(env, "recovery_code_failed", row?.id || null, username.slice(0, 40));
      fail(400, "The username or recovery code is incorrect.");
    }
    await secEvent(env, "recovery_code_verified", row.id, row.username);
    return json({ resetToken: await issueResetToken(env, row.id) });
  }
  if (path === "/api/auth/recover-passcode" && method === "POST") {
    const b = await readJson(req);
    const username = clean(b.username, 40);
    await limitOrFail(env, `passcode:ip:${ip}`, 20, 3600);
    await limitOrFail(env, `passcode:user:${username.toLowerCase()}`, 15, 3600);
    const row = await env.DB.prepare(
      `SELECT u.id,u.username,r.passcode_hash,r.expires_at,r.failed_attempts,r.consumed_at FROM users u JOIN reset_passcodes r ON r.user_id=u.id
       WHERE u.username=? AND u.disabled=0`).bind(username).first<any>();
    const bad = () => fail(400, "That passcode is incorrect, expired, or already used. Ask the owner for a new one if needed.");
    if (!row || row.consumed_at || row.expires_at <= nowIso() || row.failed_attempts >= 5) { await secEvent(env, "passcode_rejected", row?.id || null, username.slice(0, 40)); bad(); }
    if (!(await safeEqual(await hashCode(b.passcode), row.passcode_hash))) {
      await env.DB.prepare("UPDATE reset_passcodes SET failed_attempts=failed_attempts+1 WHERE user_id=?").bind(row.id).run();
      await secEvent(env, "passcode_failed", row.id, row.username); bad();
    }
    const claim = await env.DB.prepare("UPDATE reset_passcodes SET consumed_at=? WHERE user_id=? AND consumed_at IS NULL AND expires_at>? AND failed_attempts<5")
      .bind(nowIso(), row.id, nowIso()).run();
    if (!claim.meta.changes) bad();
    await secEvent(env, "passcode_verified", row.id, row.username);
    return json({ resetToken: await issueResetToken(env, row.id) });
  }
  if (path === "/api/auth/reset" && method === "POST") {
    const b = await readJson(req);
    await limitOrFail(env, `reset:ip:${ip}`, 20, 3600);
    const password = String(b.newPassword ?? ""); validatePassword(password);
    const th = await sha256(String(b.resetToken ?? ""));
    const claim = await env.DB.prepare("UPDATE reset_tokens SET used_at=? WHERE token_hash=? AND used_at IS NULL AND expires_at>?").bind(nowIso(), th, nowIso()).run();
    if (!claim.meta.changes) fail(400, "This reset link has expired. Start recovery again.");
    const t = await env.DB.prepare("SELECT t.user_id,u.username FROM reset_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=?").bind(th).first<any>();
    const salt = randomToken(16), recovery = randomCode(5);
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET password_hash=?,password_salt=?,recovery_code_hash=? WHERE id=?").bind(await passwordHash(password, salt), salt, await hashCode(recovery), t.user_id),
      env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(t.user_id),
      env.DB.prepare("DELETE FROM reset_passcodes WHERE user_id=?").bind(t.user_id),
    ]);
    await secEvent(env, "password_reset", t.user_id, t.username, "sessions revoked, recovery code rotated");
    return json({ ok: true, recoveryCode: recovery });
  }

  // ----- everything below requires sign-in -----
  need(c);

  if (path === "/api/account/password" && method === "POST") {
    const u = need(c), b = await readJson(req);
    await limitOrFail(env, `chpw:${u.id}`, 10, 3600);
    validatePassword(String(b.newPassword ?? ""));
    const row = await env.DB.prepare("SELECT password_hash,password_salt FROM users WHERE id=?").bind(u.id).first<any>();
    if (!(await safeEqual(await passwordHash(String(b.currentPassword ?? ""), row.password_salt), row.password_hash))) fail(400, "Your current password is incorrect.");
    const salt = randomToken(16);
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET password_hash=?,password_salt=? WHERE id=?").bind(await passwordHash(String(b.newPassword), salt), salt, u.id),
      env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(u.id),
    ]);
    await secEvent(env, "password_changed", u.id, u.username);
    return authedResponse(env, u);
  }
  if (path === "/api/account" && method === "PATCH") {
    const u = need(c), b = await readJson(req), email = clean(b.email, 254);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, "That email address does not look valid.");
    await env.DB.prepare("UPDATE users SET display_name=?,email=? WHERE id=?").bind(clean(b.displayName, 60) || null, email || null, u.id).run();
    return json({ ok: true });
  }

  // ----- inquiries -----
  if (path === "/api/inquiries" && method === "GET") {
    const u = need(c);
    if (u.role === "student") {
      const rows = await env.DB.prepare("SELECT id,service,education_level,title,status,student_message,expected_completion,created_at,updated_at FROM inquiries WHERE user_id=? ORDER BY created_at DESC LIMIT 100").bind(u.id).all();
      return json({ inquiries: rows.results });
    }
    const status = clean(url.searchParams.get("status"), 30), q = clean(url.searchParams.get("q"), 80);
    const where: string[] = [], args: unknown[] = [];
    if (status) { if (!STATUSES.includes(status)) fail(400, "Unknown status filter."); where.push("i.status=?"); args.push(status); }
    if (q) { const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`; where.push("(i.title LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\' OR i.id LIKE ? ESCAPE '\\' OR i.service LIKE ? ESCAPE '\\')"); args.push(like, like, like, like); }
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
    const rows = await env.DB.prepare(
      `SELECT i.id,i.service,i.education_level,i.title,i.status,i.deadline,i.created_at,i.updated_at,u.username,u.display_name,
        (SELECT COUNT(*) FROM inquiry_files f WHERE f.inquiry_id=i.id AND f.file_kind='incoming' AND f.deleted_at IS NULL) AS file_count
       FROM inquiries i JOIN users u ON u.id=i.user_id ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY i.created_at DESC LIMIT 100 OFFSET ?`).bind(...args, offset).all();
    const counts = await env.DB.prepare("SELECT status,COUNT(*) n FROM inquiries GROUP BY status").all<{ status: string; n: number }>();
    return json({ inquiries: rows.results, counts: Object.fromEntries(counts.results.map(r => [r.status, r.n])) });
  }

  if (path === "/api/inquiries" && method === "POST") {
    const u = needStudent(c);
    const len = Number(req.headers.get("content-length") || 0);
    if (len > intEnv(env.MAX_REQUEST_BYTES, 15728640) + 1048576) fail(413, "The upload is too large.");
    const form = await req.formData().catch(() => fail(400, "Invalid form submission."));
    const service = str(form, "service", 100), level = str(form, "educationLevel", 40), title = str(form, "title", 160);
    const description = str(form, "description", 4000), notes = str(form, "notes", 1500), contact = str(form, "contactDetails", 200);
    const deadline = validDate(str(form, "deadline", 12)), preferred = validDate(str(form, "preferredDate", 12));
    if (!LEVELS.includes(level)) fail(400, "Choose an eligible educational level: Elementary, Junior High School, or Senior High School. College and university requests are not accepted.");
    if (!SERVICES.includes(service)) fail(400, "Choose one of the listed services.");
    if (!title || !description) fail(400, "Please complete the title and description.");
    screenEligibility(title, description, notes);
    await limitOrFail(env, `inquiry:${u.id}`, 10, 86400, "You have reached today's inquiry limit. Please try again tomorrow.");
    const checked = await checkUploads(env, filesOf(form), REQUEST_EXTS);
    const id = uid();
    const stored = await storeFiles(env, `incoming/${id}`, checked);
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO inquiries(id,user_id,service,education_level,title,description,deadline,preferred_date,extra_notes,contact_details) VALUES(?,?,?,?,?,?,?,?,?,?)`)
          .bind(id, u.id, service, level, title, description, deadline || null, preferred || null, notes || null, contact || null),
        ...stored.map(s => env.DB.prepare(`INSERT INTO inquiry_files(id,inquiry_id,uploader_user_id,object_key,original_name,content_type,size_bytes,file_kind) VALUES(?,?,?,?,?,?,?,'incoming')`)
          .bind(s.id, id, u.id, s.key, s.f.name, s.f.mime, s.f.size)),
        env.DB.prepare("INSERT INTO inquiry_events(id,inquiry_id,actor_user_id,event_type,message) VALUES(?,?,?,?,?)").bind(uid(), id, u.id, "Submitted", "Inquiry submitted"),
      ]);
    } catch (e) { await queueDeletes(env, stored.map(s => s.key), "failed inquiry insert"); throw e; }
    await notify(env, c.ec, "new_inquiry", id, { ref: id, service, username: u.username, level, status: "Submitted" });
    return json({ inquiryId: id, status: "Submitted" }, 201);
  }

  if ((p = match("/api/inquiries/:id", path)) && method === "GET") {
    const u = need(c), inq = await loadInquiry(c, p.id);
    if (u.role === "owner" && inq.status === "Submitted") {
      const now = nowIso();
      const r = await env.DB.prepare("UPDATE inquiries SET status='Read',read_at=?,updated_at=? WHERE id=? AND status='Submitted'").bind(now, now, inq.id).run();
      if (r.meta.changes) { await logEvent(env, inq.id, u.id, "Read", "Owner opened the request", true); inq.status = "Read"; }
    }
    const files = await env.DB.prepare("SELECT id,original_name,content_type,size_bytes,file_kind,created_at,deleted_at FROM inquiry_files WHERE inquiry_id=? ORDER BY created_at").bind(inq.id).all<any>();
    const evs = await env.DB.prepare(`SELECT e.event_type,e.message,e.created_at,e.visible_to_student,u.role AS actor_role FROM inquiry_events e LEFT JOIN users u ON u.id=e.actor_user_id
      WHERE e.inquiry_id=? ${u.role === "owner" ? "" : "AND e.visible_to_student=1"} ORDER BY e.created_at`).bind(inq.id).all();
    const review = await env.DB.prepare("SELECT rating,comment,visible,created_at FROM reviews WHERE inquiry_id=?").bind(inq.id).first();
    const out: any = {
      id: inq.id, service: inq.service, education_level: inq.education_level, title: inq.title, description: inq.description, deadline: inq.deadline,
      preferred_date: inq.preferred_date, extra_notes: inq.extra_notes, contact_details: inq.contact_details, status: inq.status,
      student_message: inq.student_message, expected_completion: inq.expected_completion, created_at: inq.created_at, updated_at: inq.updated_at,
    };
    if (u.role === "owner") {
      out.internal_notes = inq.internal_notes;
      const s = await env.DB.prepare("SELECT username,display_name FROM users WHERE id=?").bind(inq.user_id).first<any>();
      out.student = { username: s.username, displayName: s.display_name };
    }
    return json({ inquiry: out, files: files.results.map(f => ({ id: f.id, name: f.original_name, type: f.content_type, size: f.size_bytes, kind: f.file_kind, createdAt: f.created_at, expired: !!f.deleted_at })), events: evs.results, review });
  }

  if ((p = match("/api/inquiries/:id", path)) && method === "PATCH") {
    const u = needOwner(c), inq = await loadInquiry(c, p.id), b = await readJson(req);
    const sets: string[] = [], args: unknown[] = [];
    const status = clean(b.status, 30), message = clean(b.message, 1000);
    if (status && status !== inq.status) {
      if (!(TRANSITIONS[inq.status] || []).includes(status)) fail(409, `A request that is "${inq.status}" cannot be changed to "${status}".`);
      sets.push("status=?"); args.push(status);
      if (status === "Completed") { sets.push("completed_at=?"); args.push(nowIso()); }
    }
    if ("expectedCompletion" in b) { sets.push("expected_completion=?"); args.push(validDate(clean(b.expectedCompletion, 12)) || null); }
    if ("internalNotes" in b) { sets.push("internal_notes=?"); args.push(clean(b.internalNotes, 3000) || null); }
    if (message) { sets.push("student_message=?"); args.push(message); }
    if (!sets.length) fail(400, "Nothing to update.");
    sets.push("updated_at=?"); args.push(nowIso());
    await env.DB.prepare(`UPDATE inquiries SET ${sets.join(",")} WHERE id=?`).bind(...args, inq.id).run();
    if (status && status !== inq.status) {
      await logEvent(env, inq.id, u.id, "StatusChanged", `${inq.status} → ${status}`);
      if (TERMINAL.includes(status)) await env.DB.prepare("UPDATE inquiry_files SET delete_after=COALESCE(delete_after,?) WHERE inquiry_id=? AND deleted_at IS NULL")
        .bind(addDays(intEnv(env.INQUIRY_FILE_RETENTION_DAYS, 30)), inq.id).run();
      const student = await env.DB.prepare("SELECT username FROM users WHERE id=?").bind(inq.user_id).first<any>();
      const data = { ref: inq.id, service: inq.service, username: student.username, level: inq.education_level, status };
      if (status === "Accepted" || status === "Declined") await notify(env, c.ec, "decision", `${inq.id}:${status}`, data);
      if (status === "Completed") await notify(env, c.ec, "completed", inq.id, data);
    }
    if (message) await logEvent(env, inq.id, u.id, "OwnerMessage", message);
    return json({ ok: true });
  }

  if ((p = match("/api/inquiries/:id/cancel", path)) && method === "POST") {
    const u = needStudent(c), inq = await loadInquiry(c, p.id);
    if (!["Submitted", "Read", "Under Review", "Awaiting Response", "Accepted"].includes(inq.status)) fail(409, "This request can no longer be cancelled.");
    await env.DB.prepare("UPDATE inquiries SET status='Cancelled',updated_at=? WHERE id=?").bind(nowIso(), inq.id).run();
    await env.DB.prepare("UPDATE inquiry_files SET delete_after=COALESCE(delete_after,?) WHERE inquiry_id=? AND deleted_at IS NULL").bind(addDays(intEnv(env.INQUIRY_FILE_RETENTION_DAYS, 30)), inq.id).run();
    await logEvent(env, inq.id, u.id, "StatusChanged", `${inq.status} → Cancelled (by student)`);
    return json({ ok: true });
  }

  if ((p = match("/api/inquiries/:id/messages", path)) && method === "POST") {
    const u = need(c), inq = await loadInquiry(c, p.id), b = await readJson(req), message = clean(b.message, 1000);
    if (!message) fail(400, "Write a message first.");
    if (u.role === "student") {
      if (TERMINAL.includes(inq.status)) fail(409, "This request is closed. Submit a new inquiry if you need more help.");
      await limitOrFail(env, `msg:${u.id}`, 30, 3600);
      await logEvent(env, inq.id, u.id, "StudentMessage", message);
      if (inq.status === "Awaiting Response") await env.DB.prepare("UPDATE inquiries SET status='Under Review',updated_at=? WHERE id=?").bind(nowIso(), inq.id).run();
      else await env.DB.prepare("UPDATE inquiries SET updated_at=? WHERE id=?").bind(nowIso(), inq.id).run();
      await notify(env, c.ec, "student_info", `${inq.id}:${uid()}`, { ref: inq.id, service: inq.service, username: u.username, level: inq.education_level, status: inq.status === "Awaiting Response" ? "Under Review" : inq.status });
    } else {
      await logEvent(env, inq.id, u.id, "OwnerMessage", message);
      await env.DB.prepare("UPDATE inquiries SET student_message=?,updated_at=? WHERE id=?").bind(message, nowIso(), inq.id).run();
    }
    return json({ ok: true }, 201);
  }

  if ((p = match("/api/inquiries/:id/files", path)) && method === "POST") {
    const u = need(c), inq = await loadInquiry(c, p.id);
    const kind = u.role === "owner" ? "deliverable" : "incoming";
    if (kind === "incoming" && !STUDENT_OPEN.includes(inq.status)) fail(409, "Files can only be added while the request is being reviewed.");
    const len = Number(req.headers.get("content-length") || 0);
    if (len > intEnv(env.MAX_REQUEST_BYTES, 15728640) + 1048576) fail(413, "The upload is too large.");
    const form = await req.formData().catch(() => fail(400, "Invalid form submission."));
    const raw = filesOf(form);
    if (!raw.length) fail(400, "Choose at least one file.");
    const cur = await env.DB.prepare("SELECT COUNT(*) n,COALESCE(SUM(size_bytes),0) b FROM inquiry_files WHERE inquiry_id=? AND file_kind=? AND deleted_at IS NULL").bind(inq.id, kind).first<any>();
    const checked = await checkUploads(env, raw, REQUEST_EXTS, cur.n, cur.b);
    const stored = await storeFiles(env, `${kind === "incoming" ? "incoming" : "deliverables"}/${inq.id}`, checked);
    const delAfter = kind === "deliverable" ? addDays(intEnv(env.INQUIRY_FILE_RETENTION_DAYS, 30)) : null;
    try {
      await env.DB.batch(stored.map(s => env.DB.prepare(`INSERT INTO inquiry_files(id,inquiry_id,uploader_user_id,object_key,original_name,content_type,size_bytes,file_kind,delete_after) VALUES(?,?,?,?,?,?,?,?,?)`)
        .bind(s.id, inq.id, u.id, s.key, s.f.name, s.f.mime, s.f.size, kind, delAfter)));
    } catch (e) { await queueDeletes(env, stored.map(s => s.key), "failed file insert"); throw e; }
    await logEvent(env, inq.id, u.id, kind === "incoming" ? "FilesAdded" : "DeliverableUploaded", `${stored.length} file(s)`);
    if (kind === "incoming") await notify(env, c.ec, "student_info", `${inq.id}:files:${uid()}`, { ref: inq.id, service: inq.service, username: u.username, level: inq.education_level, status: inq.status });
    return json({ ok: true }, 201);
  }

  if ((p = match("/api/inquiries/:id/files/:fid/download", path)) && method === "GET") {
    const u = need(c), inq = await loadInquiry(c, p.id);
    const f = await env.DB.prepare("SELECT * FROM inquiry_files WHERE id=? AND inquiry_id=?").bind(p.fid, inq.id).first<any>();
    if (!f) fail(404, "File not found.");
    if (f.deleted_at) fail(410, "This file has passed its retention period and was removed.");
    const obj = await env.FILES.get(f.object_key);
    if (!obj) fail(410, "This file is no longer available.");
    const studentGets = u.role === "student" && f.file_kind === "deliverable";
    await logEvent(env, inq.id, u.id, u.role === "owner" ? "OwnerFileOpened" : "DownloadStarted", f.original_name, u.role === "student");
    if (studentGets) {
      const grace = addDays(intEnv(env.DELIVERABLE_GRACE_DAYS, 7));
      await env.DB.prepare("UPDATE inquiry_files SET first_downloaded_at=COALESCE(first_downloaded_at,?),delete_after=CASE WHEN delete_after IS NULL OR delete_after>? THEN ? ELSE delete_after END WHERE id=?")
        .bind(nowIso(), grace, grace, f.id).run();
      await notify(env, c.ec, "download", `${f.id}:${uid()}`, { ref: inq.id, service: inq.service, username: u.username, level: inq.education_level, status: inq.status });
    }
    return fileResponse(obj.body, f.content_type, f.original_name, u.role === "owner" && url.searchParams.get("inline") === "1");
  }

  if ((p = match("/api/inquiries/:id/review", path)) && method === "POST") {
    const u = needStudent(c), inq = await loadInquiry(c, p.id), b = await readJson(req);
    if (inq.status !== "Completed") fail(403, "You can review a request once it is completed.");
    const rating = Number(b.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) fail(400, "Choose a rating from 1 to 5.");
    try { await env.DB.prepare("INSERT INTO reviews(id,inquiry_id,user_id,rating,comment) VALUES(?,?,?,?,?)").bind(uid(), inq.id, u.id, rating, clean(b.comment, 1000) || null).run(); }
    catch { fail(409, "You have already reviewed this request."); }
    await logEvent(env, inq.id, u.id, "ReviewSubmitted", `${rating}-star review`, true);
    await notify(env, c.ec, "new_review", inq.id, { ref: inq.id, service: inq.service, username: u.username, level: inq.education_level, status: "Completed" });
    return json({ ok: true, message: "Thank you! Your review will appear after the owner approves it." }, 201);
  }

  // ----- voluntary contributions -----
  if (path === "/api/payment-methods" && method === "GET") {
    const rows = await env.DB.prepare("SELECT id,name,account_holder,account_identifier,instructions,(qr_object_key IS NOT NULL) AS has_qr FROM payment_methods WHERE enabled=1 ORDER BY sort_order,created_at").all();
    return json({ methods: rows.results });
  }
  if ((p = match("/api/payment-methods/:id/qr", path)) && method === "GET") {
    const u = need(c);
    const m = await env.DB.prepare("SELECT qr_object_key,qr_content_type,name,enabled FROM payment_methods WHERE id=?").bind(p.id).first<any>();
    if (!m || !m.qr_object_key || (!m.enabled && u.role !== "owner")) fail(404, "QR code not found.");
    const obj = await env.FILES.get(m.qr_object_key);
    if (!obj) fail(404, "QR code not found.");
    return fileResponse(obj.body, m.qr_content_type, `${m.name}-qr`, true);
  }
  if (path === "/api/receipts" && method === "POST") {
    const u = needStudent(c);
    await limitOrFail(env, `receipt:${u.id}`, 10, 86400);
    const len = Number(req.headers.get("content-length") || 0);
    if (len > intEnv(env.MAX_FILE_BYTES, 5242880) + 1048576) fail(413, "The file is too large.");
    const form = await req.formData().catch(() => fail(400, "Invalid form submission."));
    const message = str(form, "message", 500), methodId = str(form, "paymentMethodId", 60), inquiryId = str(form, "inquiryId", 60);
    const raw = filesOf(form);
    if (raw.length > 1) fail(400, "Attach one receipt image or PDF.");
    if (!message && !raw.length) fail(400, "Add a thank-you message or a receipt (both are optional, but one is needed to submit).");
    if (inquiryId && !(await env.DB.prepare("SELECT 1 x FROM inquiries WHERE id=? AND user_id=?").bind(inquiryId, u.id).first())) fail(404, "Request not found.");
    if (methodId && !(await env.DB.prepare("SELECT 1 x FROM payment_methods WHERE id=? AND enabled=1").bind(methodId).first())) fail(404, "Payment method not found.");
    const checked = await checkUploads(env, raw, RECEIPT_EXTS);
    const id = uid(); let key: string | null = null;
    if (checked.length) { key = `donation-receipts/${u.id}/${id}-${checked[0].name}`; await env.FILES.put(key, checked[0].data, { httpMetadata: { contentType: checked[0].mime } }); }
    try {
      await env.DB.prepare("INSERT INTO contribution_receipts(id,user_id,inquiry_id,payment_method_id,object_key,content_type,size_bytes,thank_you_message,delete_after) VALUES(?,?,?,?,?,?,?,?,?)")
        .bind(id, u.id, inquiryId || null, methodId || null, key, checked[0]?.mime || null, checked[0]?.size || null, message || null, addDays(intEnv(env.RECEIPT_RETENTION_DAYS, 60))).run();
    } catch (e) { if (key) await queueDeletes(env, [key], "failed receipt insert"); throw e; }
    await notify(env, c.ec, "receipt", id, { ref: inquiryId || id, username: u.username });
    return json({ ok: true }, 201);
  }

  // ----- owner-only -----
  if (path.startsWith("/api/owner/")) return handleOwner(c, path, method);
  return json({ error: "Not found." }, 404);
}

async function loadInquiry(c: Ctx, id: string) {
  const inq = await c.env.DB.prepare("SELECT * FROM inquiries WHERE id=?").bind(id).first<any>();
  if (!inq || (c.user!.role !== "owner" && inq.user_id !== c.user!.id)) fail(404, "Request not found.");
  return inq;
}
async function issueResetToken(env: Env, userId: string) {
  const token = randomToken();
  await env.DB.prepare("INSERT INTO reset_tokens(token_hash,user_id,expires_at) VALUES(?,?,?)").bind(await sha256(token), userId, new Date(Date.now() + 15 * 60000).toISOString()).run();
  return token;
}

async function handleOwner(c: Ctx, path: string, method: string): Promise<Response> {
  const { req, env, url } = c, owner = needOwner(c);
  let p: Record<string, string> | null;

  if (path === "/api/owner/students" && method === "GET") {
    const q = clean(url.searchParams.get("q"), 40);
    if (q.length < 2) return json({ students: [] });
    const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
    const rows = await env.DB.prepare(
      `SELECT u.id,u.username,u.display_name,u.created_at,u.disabled,r.created_at AS pc_created,r.expires_at AS pc_expires,r.failed_attempts AS pc_failed,r.consumed_at AS pc_consumed
       FROM users u LEFT JOIN reset_passcodes r ON r.user_id=u.id WHERE u.role='student' AND u.username LIKE ? ESCAPE '\\' ORDER BY u.username LIMIT 20`).bind(like).all<any>();
    const now = nowIso();
    return json({ students: rows.results.map(r => ({
      id: r.id, username: r.username, displayName: r.display_name, createdAt: r.created_at, disabled: !!r.disabled,
      passcode: !r.pc_created ? null : { createdAt: r.pc_created, expiresAt: r.pc_expires, status: r.pc_consumed ? "used" : r.pc_failed >= 5 ? "locked" : r.pc_expires <= now ? "expired" : "active" },
    })) });
  }
  if ((p = match("/api/owner/students/:id/passcode", path)) && method === "POST") {
    await limitOrFail(env, "passcode-issue:all", 30, 3600);
    await limitOrFail(env, `passcode-issue:${p.id}`, 5, 3600);
    const s = await env.DB.prepare("SELECT id,username FROM users WHERE id=? AND role='student' AND disabled=0").bind(p.id).first<any>();
    if (!s) fail(404, "Student account not found.");
    const passcode = randomCode(3), expires = new Date(Date.now() + 24 * 3600000).toISOString();
    await env.DB.prepare(`INSERT INTO reset_passcodes(user_id,passcode_hash,created_at,expires_at,failed_attempts,consumed_at) VALUES(?,?,?,?,0,NULL)
      ON CONFLICT(user_id) DO UPDATE SET passcode_hash=excluded.passcode_hash,created_at=excluded.created_at,expires_at=excluded.expires_at,failed_attempts=0,consumed_at=NULL`)
      .bind(s.id, await hashCode(passcode), nowIso(), expires).run();
    await secEvent(env, "passcode_issued", s.id, s.username, "by owner");
    return json({ passcode, username: s.username, expiresAt: expires });
  }
  if (path === "/api/owner/security-events" && method === "GET") {
    const rows = await env.DB.prepare("SELECT event_type,username,detail,created_at FROM security_events ORDER BY created_at DESC LIMIT 100").all();
    return json({ events: rows.results });
  }

  // payment methods
  if (path === "/api/owner/payment-methods" && method === "GET") {
    const rows = await env.DB.prepare("SELECT id,name,account_holder,account_identifier,instructions,enabled,sort_order,(qr_object_key IS NOT NULL) AS has_qr FROM payment_methods ORDER BY sort_order,created_at").all();
    return json({ methods: rows.results });
  }
  const pmFields = (b: any) => {
    const name = clean(b.name, 60); if (!name) fail(400, "Give the payment method a name.");
    return [name, clean(b.accountHolder, 80) || null, clean(b.accountIdentifier, 120) || null, clean(b.instructions, 600) || null, b.enabled === false ? 0 : 1] as const;
  };
  if (path === "/api/owner/payment-methods" && method === "POST") {
    const f = pmFields(await readJson(req)), id = uid();
    const max = await env.DB.prepare("SELECT COALESCE(MAX(sort_order),0)+1 n FROM payment_methods").first<{ n: number }>();
    await env.DB.prepare("INSERT INTO payment_methods(id,name,account_holder,account_identifier,instructions,enabled,sort_order) VALUES(?,?,?,?,?,?,?)").bind(id, ...f, max?.n ?? 1).run();
    return json({ id }, 201);
  }
  if (path === "/api/owner/payment-methods/reorder" && method === "POST") {
    const ids = (await readJson(req)).ids;
    if (!Array.isArray(ids) || ids.length > 100) fail(400, "Invalid order.");
    await env.DB.batch(ids.map((id: unknown, i: number) => env.DB.prepare("UPDATE payment_methods SET sort_order=? WHERE id=?").bind(i + 1, String(id))));
    return json({ ok: true });
  }
  if ((p = match("/api/owner/payment-methods/:id/qr", path))) {
    const m = await env.DB.prepare("SELECT id,qr_object_key FROM payment_methods WHERE id=?").bind(p.id).first<any>();
    if (!m) fail(404, "Payment method not found.");
    if (method === "PUT") {
      const form = await req.formData().catch(() => fail(400, "Invalid form submission.")), raw = filesOf(form);
      if (raw.length !== 1) fail(400, "Choose one PNG or JPG image.");
      const [chk] = await checkUploads(env, raw, QR_EXTS);
      const key = `payment-qr/${m.id}/${uid()}.${chk.ext === "png" ? "png" : "jpg"}`;
      await env.FILES.put(key, chk.data, { httpMetadata: { contentType: chk.mime } });
      await env.DB.prepare("UPDATE payment_methods SET qr_object_key=?,qr_content_type=? WHERE id=?").bind(key, chk.mime, m.id).run();
      if (m.qr_object_key) await queueDeletes(env, [m.qr_object_key], "qr replaced");
      return json({ ok: true });
    }
    if (method === "DELETE") {
      await env.DB.prepare("UPDATE payment_methods SET qr_object_key=NULL,qr_content_type=NULL WHERE id=?").bind(m.id).run();
      if (m.qr_object_key) await queueDeletes(env, [m.qr_object_key], "qr removed");
      return json({ ok: true });
    }
  }
  if ((p = match("/api/owner/payment-methods/:id", path))) {
    if (method === "PATCH") {
      const f = pmFields(await readJson(req));
      const r = await env.DB.prepare("UPDATE payment_methods SET name=?,account_holder=?,account_identifier=?,instructions=?,enabled=? WHERE id=?").bind(...f, p.id).run();
      if (!r.meta.changes) fail(404, "Payment method not found.");
      return json({ ok: true });
    }
    if (method === "DELETE") {
      const m = await env.DB.prepare("SELECT qr_object_key FROM payment_methods WHERE id=?").bind(p.id).first<any>();
      if (!m) fail(404, "Payment method not found.");
      if (m.qr_object_key) await queueDeletes(env, [m.qr_object_key], "method deleted");
      await env.DB.prepare("DELETE FROM payment_methods WHERE id=?").bind(p.id).run();
      return json({ ok: true });
    }
  }

  // receipts
  if (path === "/api/owner/receipts" && method === "GET") {
    const rows = await env.DB.prepare(`SELECT r.id,r.inquiry_id,r.thank_you_message,r.reviewed_at,r.created_at,(r.object_key IS NOT NULL) AS has_file,r.content_type,
      u.username,m.name AS method_name FROM contribution_receipts r JOIN users u ON u.id=r.user_id LEFT JOIN payment_methods m ON m.id=r.payment_method_id
      ORDER BY r.created_at DESC LIMIT 100`).all();
    return json({ receipts: rows.results });
  }
  if ((p = match("/api/owner/receipts/:id/file", path)) && method === "GET") {
    const r = await env.DB.prepare("SELECT object_key,content_type FROM contribution_receipts WHERE id=?").bind(p.id).first<any>();
    if (!r?.object_key) fail(404, "No receipt file.");
    const obj = await env.FILES.get(r.object_key);
    if (!obj) fail(404, "No receipt file.");
    return fileResponse(obj.body, r.content_type, `receipt-${p.id.slice(0, 8)}.${r.content_type === "application/pdf" ? "pdf" : r.content_type === "image/png" ? "png" : "jpg"}`, url.searchParams.get("inline") === "1");
  }
  if ((p = match("/api/owner/receipts/:id/reviewed", path)) && method === "POST") {
    await env.DB.prepare("UPDATE contribution_receipts SET reviewed_at=? WHERE id=?").bind(nowIso(), p.id).run();
    return json({ ok: true });
  }
  if ((p = match("/api/owner/receipts/:id", path)) && method === "DELETE") {
    const r = await env.DB.prepare("SELECT object_key FROM contribution_receipts WHERE id=?").bind(p.id).first<any>();
    if (!r) fail(404, "Receipt not found.");
    if (r.object_key) await queueDeletes(env, [r.object_key], "receipt deleted");
    await env.DB.prepare("DELETE FROM contribution_receipts WHERE id=?").bind(p.id).run();
    return json({ ok: true });
  }

  // review moderation
  if (path === "/api/owner/reviews" && method === "GET") {
    const rows = await env.DB.prepare(`SELECT r.id,r.rating,r.comment,r.visible,r.created_at,i.service,i.id AS inquiry_id,u.username FROM reviews r
      JOIN inquiries i ON i.id=r.inquiry_id JOIN users u ON u.id=r.user_id ORDER BY r.visible,r.created_at DESC LIMIT 100`).all();
    return json({ reviews: rows.results });
  }
  if ((p = match("/api/owner/reviews/:id", path))) {
    if (method === "PATCH") {
      const b = await readJson(req);
      const r = await env.DB.prepare("UPDATE reviews SET visible=? WHERE id=?").bind(b.visible ? 1 : 0, p.id).run();
      if (!r.meta.changes) fail(404, "Review not found.");
      return json({ ok: true });
    }
    if (method === "DELETE") {
      // Removing the review also lets a genuine student re-submit; delete only abusive/invalid ones.
      await env.DB.prepare("DELETE FROM reviews WHERE id=?").bind(p.id).run();
      return json({ ok: true });
    }
  }

  // Discord settings
  if (path === "/api/owner/discord" && method === "GET") return json(await discordStatus(env));
  if (path === "/api/owner/discord" && method === "PUT") {
    const b = await readJson(req), ownerId = clean(b.ownerId, 25);
    if (ownerId && !validDiscordId(ownerId)) fail(400, "A Discord user ID is 17 to 20 digits (enable Developer Mode, then right-click your name and choose Copy User ID).");
    if (b.enabled && !ownerId) fail(400, "Enter your Discord user ID before enabling notifications.");
    const events: Record<string, boolean> = {};
    for (const e of NOTIFY_EVENTS) events[e] = b.events?.[e] === true;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO settings(key,value) VALUES('discord_enabled',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(b.enabled ? "1" : "0"),
      env.DB.prepare("INSERT INTO settings(key,value) VALUES('discord_owner_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(ownerId),
      env.DB.prepare("INSERT INTO settings(key,value) VALUES('discord_events',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(events)),
    ]);
    return json(await discordStatus(env));
  }
  if (path === "/api/owner/discord/test" && method === "POST") {
    await limitOrFail(env, "discord-test", 10, 3600);
    const r = await sendTest(env);
    return json(r, r.ok ? 200 : 502);
  }
  void req; void owner;
  return json({ error: "Not found." }, 404);
}

export default {
  async fetch(req: Request, env: Env, ec: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      try { return await handleApi({ req, env, ec, url, user: null, csrf: null }); }
      catch (e) {
        if (e instanceof HttpError) return json({ error: e.message }, e.status);
        console.error("API error", (e as Error)?.message);
        return json({ error: "Something went wrong. Please try again." }, 500);
      }
    }
    const res = await env.ASSETS.fetch(req);
    const h = new Headers(res.headers);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) h.set(k, v);
    return new Response(res.body, { status: res.status, headers: h });
  },
  async scheduled(_e: ScheduledController, env: Env, ec: ExecutionContext) { ec.waitUntil(runScheduled(env)); },
};
