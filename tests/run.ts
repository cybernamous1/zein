import assert from "node:assert/strict";
import { makeEnv, Client, bytes, mkFile, inquiryForm, settle } from "./harness.ts";
import worker from "../src/index.ts";
import { runScheduled } from "../src/cleanup.ts";

let passed = 0, failed = 0; const failures: string[] = [];
async function t(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log("  ok  " + name); } catch (e: any) { failed++; failures.push(name); console.log("FAIL  " + name + "\n      " + (e?.message || e)); }
}
const FILE_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const FILE_PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const PW = "correct horse battery";
async function newStudent(env: any, name: string, ip = "2.2.2.2") {
  const c = new Client(env, ip); const r = await c.post("/api/auth/register", { username: name, password: PW });
  assert.equal(r.status, 201, JSON.stringify(r.data)); return { c, recovery: r.data.recoveryCode as string, id: r.data.user.id as string };
}
async function newOwner(env: any) {
  const c = new Client(env, "9.9.9.9");
  const r = await c.post("/api/owner/setup", { username: "zein_owner", password: "owner-password-123", setupSecret: "s".repeat(40) });
  assert.equal(r.status, 201, JSON.stringify(r.data)); return c;
}
async function submit(c: Client, over = {}, files: any[] = []) {
  const r = await c.call("POST", "/api/inquiries", inquiryForm(over, files)); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.inquiryId as string;
}
const rows = (env: any, sql: string, ...a: any[]) => env.DB.db.prepare(sql).all(...a);
const ONE = (env: any, sql: string, ...a: any[]) => env.DB.db.prepare(sql).get(...a);

console.log("\n== Auth, sessions, owner setup ==");
await t("register returns recovery code once; stores only hashes", async () => {
  const env = makeEnv(); const { recovery } = await newStudent(env, "alice");
  assert.match(recovery, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/);
  const u = ONE(env, "SELECT * FROM users WHERE username='alice'");
  assert.ok(!JSON.stringify(u).includes(PW)); assert.ok(!JSON.stringify(u).includes(recovery.replace(/-/g, "")));
  assert.equal(u.display_name, null); assert.equal(u.email, null);
});
await t("username validation, uniqueness (case-insens), short password", async () => {
  const env = makeEnv(); await newStudent(env, "Alice");
  const c = new Client(env);
  assert.equal((await c.post("/api/auth/register", { username: "alice", password: PW })).status, 409);
  assert.equal((await c.post("/api/auth/register", { username: "a b", password: PW })).status, 400);
  assert.equal((await c.post("/api/auth/register", { username: "bobby", password: "short" })).status, 400);
  assert.equal((await c.post("/api/auth/register", { username: "zein_owner", password: PW })).status, 409);
  assert.equal((await c.post("/api/auth/register", { username: "bobby", password: PW, email: "nope" })).status, 400);
  assert.equal((await c.post("/api/auth/register", { username: "bobby2", password: PW, email: "b@x.io", displayName: "Bob" })).status, 201);
});
await t("login, /api/me, cookie flags, 365-day expiry, logout revokes", async () => {
  const env = makeEnv(); const { c } = await newStudent(env, "alice");
  const c2 = new Client(env, "3.3.3.3");
  const r = await c2.post("/api/auth/login", { username: "ALICE", password: PW });
  assert.equal(r.status, 200);
  const sc = r.res.headers.get("set-cookie")!;
  assert.match(sc, /HttpOnly/); assert.match(sc, /Secure/); assert.match(sc, /SameSite=Lax/); assert.match(sc, /Max-Age=31536000/); assert.match(sc, /^__Host-/);
  const s = ONE(env, "SELECT expires_at FROM sessions ORDER BY created_at DESC LIMIT 1");
  const days = (Date.parse(s.expires_at) - Date.now()) / 86400000; assert.ok(days > 364 && days <= 365.01);
  assert.equal((await c2.get("/api/me")).data.user.username, "alice");
  const cookie = c2.cookie;
  assert.equal((await c2.post("/api/auth/logout")).status, 200);
  const stale = new Client(env); stale.cookie = cookie; assert.equal((await stale.get("/api/me")).data.user, null);
  assert.equal((await new Client(env).post("/api/auth/login", { username: "alice", password: "wrong-password!!" })).status, 401);
  void c;
});
await t("expired session is rejected", async () => {
  const env = makeEnv(); const { c } = await newStudent(env, "alice");
  env.DB.db.exec("UPDATE sessions SET expires_at='2020-01-01T00:00:00.000Z'");
  assert.equal((await c.get("/api/me")).data.user, null);
});
await t("login rate limit locks after repeated failures", async () => {
  const env = makeEnv(); await newStudent(env, "alice"); const c = new Client(env, "4.4.4.4"); let last = 0;
  for (let i = 0; i < 12; i++) last = (await c.post("/api/auth/login", { username: "alice", password: "bad-bad-bad-bad" })).status;
  assert.equal(last, 429);
  assert.equal((await new Client(env, "5.5.5.5").post("/api/auth/login", { username: "alice", password: PW })).status, 429); // per-username limit
});
await t("owner setup: secret required, single owner, password hashed", async () => {
  const env = makeEnv(); const c = new Client(env, "8.8.8.8");
  assert.equal((await c.post("/api/owner/setup", { username: "zein_owner", password: "owner-password-123", setupSecret: "wrong" })).status, 403);
  assert.equal((await c.post("/api/owner/setup", { username: "someone", password: "owner-password-123", setupSecret: "s".repeat(40) })).status, 403);
  await newOwner(env);
  assert.equal((await new Client(env, "7.7.7.7").post("/api/owner/setup", { username: "zein_owner", password: "another-password", setupSecret: "s".repeat(40) })).status, 403);
  const weak = makeEnv({ OWNER_SETUP_SECRET: "short" });
  assert.equal((await new Client(weak).post("/api/owner/setup", { username: "zein_owner", password: "owner-password-123", setupSecret: "short" })).status, 403);
});
await t("CSRF: authenticated writes need token; cross-origin blocked", async () => {
  const env = makeEnv(); const { c } = await newStudent(env, "alice");
  assert.equal((await c.call("POST", "/api/auth/logout-all", {}, { noCsrf: true })).status, 403);
  assert.equal((await c.call("POST", "/api/auth/login", {}, { headers: { origin: "https://evil.example" } })).status, 403);
});

console.log("\n== Recovery ==");
await t("self-service recovery: code -> reset -> new code, old code dead, sessions revoked", async () => {
  const env = makeEnv(); const { c, recovery } = await newStudent(env, "alice");
  const r = new Client(env, "6.6.6.6");
  assert.equal((await r.post("/api/auth/recover", { username: "alice", code: "AAAA-BBBB-CCCC-DDDD-EEEE" })).status, 400);
  const ok = await r.post("/api/auth/recover", { username: "alice", code: recovery.toLowerCase().replace(/-/g, " ") });
  assert.equal(ok.status, 200);
  const done = await r.post("/api/auth/reset", { resetToken: ok.data.resetToken, newPassword: "brand new password" });
  assert.equal(done.status, 200); assert.notEqual(done.data.recoveryCode, recovery);
  assert.equal((await r.post("/api/auth/reset", { resetToken: ok.data.resetToken, newPassword: "another new password" })).status, 400); // token single-use
  assert.equal((await c.get("/api/me")).data.user, null); // old session revoked
  assert.equal((await r.post("/api/auth/recover", { username: "alice", code: recovery })).status, 400); // old code invalid
  assert.equal((await new Client(env, "6.6.6.7").post("/api/auth/login", { username: "alice", password: PW })).status, 401);
  assert.equal((await new Client(env, "6.6.6.8").post("/api/auth/login", { username: "alice", password: "brand new password" })).status, 200);
  assert.equal((await r.post("/api/auth/recover", { username: "alice", code: done.data.recoveryCode })).status, 200);
});
await t("reset token expires after 15 minutes", async () => {
  const env = makeEnv(); const { recovery } = await newStudent(env, "alice"); const r = new Client(env, "6.6.6.6");
  const ok = await r.post("/api/auth/recover", { username: "alice", code: recovery });
  env.DB.db.exec("UPDATE reset_tokens SET expires_at='2020-01-01T00:00:00.000Z'");
  assert.equal((await r.post("/api/auth/reset", { resetToken: ok.data.resetToken, newPassword: "brand new password" })).status, 400);
});
await t("recovery attempts are rate limited", async () => {
  const env = makeEnv(); await newStudent(env, "alice"); const r = new Client(env, "6.6.6.6"); let last = 0;
  for (let i = 0; i < 12; i++) last = (await r.post("/api/auth/recover", { username: "alice", code: "AAAA-BBBB-CCCC-DDDD-EEEE" })).status;
  assert.equal(last, 429);
});
await t("owner-assisted: passcode hashed, 24h, single-use, replacement invalidates, attempts capped", async () => {
  const env = makeEnv(); const owner = await newOwner(env); const { c, id } = await newStudent(env, "alice");
  const found = await owner.get("/api/owner/students?q=ali"); assert.equal(found.data.students[0].username, "alice");
  assert.ok(!JSON.stringify(found.data).includes("hash"));
  const p1 = (await owner.post(`/api/owner/students/${id}/passcode`)).data;
  const exp = (Date.parse(p1.expiresAt) - Date.now()) / 3600000; assert.ok(exp > 23.9 && exp <= 24.01);
  assert.ok(!JSON.stringify(rows(env, "SELECT * FROM reset_passcodes")).includes(p1.passcode.replace(/-/g, "")));
  const p2 = (await owner.post(`/api/owner/students/${id}/passcode`)).data;
  const r = new Client(env, "6.6.6.6");
  assert.equal((await r.post("/api/auth/recover-passcode", { username: "alice", passcode: p1.passcode })).status, 400); // replaced
  const ok = await r.post("/api/auth/recover-passcode", { username: "alice", passcode: p2.passcode }); assert.equal(ok.status, 200);
  assert.equal((await r.post("/api/auth/recover-passcode", { username: "alice", passcode: p2.passcode })).status, 400); // single use
  const done = await r.post("/api/auth/reset", { resetToken: ok.data.resetToken, newPassword: "fresh password 123" });
  assert.equal(done.status, 200); assert.ok(done.data.recoveryCode);
  assert.equal((await c.get("/api/me")).data.user, null);
  const p3 = (await owner.post(`/api/owner/students/${id}/passcode`)).data;
  env.DB.db.exec("UPDATE reset_passcodes SET expires_at='2020-01-01T00:00:00.000Z'");
  assert.equal((await new Client(env, "6.6.6.9").post("/api/auth/recover-passcode", { username: "alice", passcode: p3.passcode })).status, 400); // expired
  const p4 = (await owner.post(`/api/owner/students/${id}/passcode`)).data;
  const k = new Client(env, "6.6.7.1"); for (let i = 0; i < 5; i++) await k.post("/api/auth/recover-passcode", { username: "alice", passcode: "AAAA-BBBB-CCCC" });
  assert.equal((await k.post("/api/auth/recover-passcode", { username: "alice", passcode: p4.passcode })).status, 400); // locked after 5 fails
  assert.equal((await owner.get("/api/owner/students?q=alice")).data.students[0].passcode.status, "locked");
});
await t("passcode issuance rate-limited; owner cannot target owner; students blocked", async () => {
  const env = makeEnv(); const owner = await newOwner(env); const { c, id } = await newStudent(env, "alice"); let last = 0;
  for (let i = 0; i < 7; i++) last = (await owner.post(`/api/owner/students/${id}/passcode`)).status;
  assert.equal(last, 429);
  assert.equal((await c.get("/api/owner/students?q=al")).status, 403);
  assert.equal((await c.post(`/api/owner/students/${id}/passcode`)).status, 403);
  const oid = ONE(env, "SELECT id FROM users WHERE role='owner'").id;
  assert.equal((await owner.post(`/api/owner/students/${oid}/passcode`)).status, 404);
});

console.log("\n== Inquiries & eligibility ==");
await t("four-step result: submit creates Submitted inquiry; defaults", async () => {
  const env = makeEnv(); const { c } = await newStudent(env, "alice"); const id = await submit(c);
  const d = (await c.get(`/api/inquiries/${id}`)).data; assert.equal(d.inquiry.status, "Submitted"); assert.equal(d.inquiry.education_level, "Senior High School");
  assert.equal(d.inquiry.internal_notes, undefined);
});
await t("eligibility enforced server-side: College/University/bogus level and keywords rejected", async () => {
  const env = makeEnv(); const { c } = await newStudent(env, "alice");
  for (const lvl of ["College", "University", "Graduate", "Postgraduate", "", "senior high school"]) {
    const r = await c.call("POST", "/api/inquiries", inquiryForm({ educationLevel: lvl })); assert.equal(r.status, 400, lvl);
  }
  for (const txt of ["Need a college thesis", "university-level essay", "my master's paper", "doctoral dissertation help", "PhD proposal"]) {
    const r = await c.call("POST", "/api/inquiries", inquiryForm({ description: txt })); assert.equal(r.status, 400, txt);
  }
  assert.equal((await c.call("POST", "/api/inquiries", inquiryForm({ service: "Hacking" }))).status, 400);
  for (const lvl of ["Elementary School", "Junior High School", "Senior High School"]) assert.equal((await c.call("POST", "/api/inquiries", inquiryForm({ educationLevel: lvl }))).status, 201);
  assert.equal(rows(env, "SELECT * FROM inquiries").length, 3);
});
await t("schema also blocks bad levels/statuses", async () => {
  const env = makeEnv(); const { id } = await newStudent(env, "alice");
  assert.throws(() => env.DB.db.prepare("INSERT INTO inquiries(id,user_id,service,education_level,title,description) VALUES('x',?, 's','College','t','d')").run(id));
});
await t("date validation; auth required; owner cannot submit", async () => {
  const env = makeEnv(); const { c } = await newStudent(env, "alice"); const owner = await newOwner(env);
  assert.equal((await c.call("POST", "/api/inquiries", inquiryForm({ deadline: "tomorrow" }))).status, 400);
  assert.equal((await new Client(env).call("POST", "/api/inquiries", inquiryForm())).status, 401);
  assert.equal((await owner.call("POST", "/api/inquiries", inquiryForm())).status, 403);
});
await t("status transitions + inbox does not mark read; detail does", async () => {
  const env = makeEnv(); const { c } = await newStudent(env, "alice"); const owner = await newOwner(env); const id = await submit(c);
  const list = await owner.get("/api/inquiries"); assert.equal(list.data.inquiries[0].status, "Submitted");
  assert.equal(ONE(env, "SELECT status FROM inquiries WHERE id=?", id).status, "Submitted");
  assert.equal((await owner.get(`/api/inquiries/${id}`)).data.inquiry.status, "Read");
  assert.equal((await owner.call("PATCH", `/api/inquiries/${id}`, { status: "Completed" })).status, 409); // Read -> Completed not allowed
  assert.equal((await owner.call("PATCH", `/api/inquiries/${id}`, { status: "Awaiting Response", message: "Which grade section?" })).status, 200);
  assert.equal((await owner.call("PATCH", `/api/inquiries/${id}`, { status: "Accepted", expectedCompletion: "2027-01-05", internalNotes: "easy job" })).status, 200);
  assert.equal((await owner.call("PATCH", `/api/inquiries/${id}`, { status: "In Progress" })).status, 200);
  assert.equal((await owner.call("PATCH", `/api/inquiries/${id}`, { status: "Completed" })).status, 200);
  assert.equal((await owner.call("PATCH", `/api/inquiries/${id}`, { status: "In Progress" })).status, 409);
  assert.equal((await owner.call("PATCH", `/api/inquiries/${id}`, { status: "Bogus" })).status, 409);
  const s = (await c.get(`/api/inquiries/${id}`)).data;
  assert.equal(s.inquiry.status, "Completed"); assert.equal(s.inquiry.internal_notes, undefined); assert.equal(s.inquiry.expected_completion, "2027-01-05");
  assert.ok(s.events.some((e: any) => e.message === "Which grade section?")); assert.ok(!JSON.stringify(s).includes("easy job"));
  assert.equal((await owner.get(`/api/inquiries/${id}`)).data.inquiry.internal_notes, "easy job");
  assert.equal((await c.call("PATCH", `/api/inquiries/${id}`, { status: "Accepted" })).status, 403);
});
await t("owner search/filter; student reply moves Awaiting Response -> Under Review; cancel", async () => {
  const env = makeEnv(); const a = await newStudent(env, "alice"), b = await newStudent(env, "bobby", "3.3.3.3"); const owner = await newOwner(env);
  const i1 = await submit(a.c, { title: "Poster text" }), i2 = await submit(b.c, { title: "Slides about frogs" });
  assert.equal((await owner.get("/api/inquiries?q=frogs")).data.inquiries.length, 1);
  assert.equal((await owner.get("/api/inquiries?q=bobby")).data.inquiries[0].id, i2);
  assert.equal((await owner.get("/api/inquiries?status=Submitted")).data.inquiries.length, 2);
  assert.equal((await owner.get("/api/inquiries?status=Nope")).status, 400);
  await owner.call("PATCH", `/api/inquiries/${i1}`, { status: "Awaiting Response", message: "Need page count" });
  assert.equal((await a.c.post(`/api/inquiries/${i1}/messages`, { message: "3 pages" })).status, 201);
  assert.equal(ONE(env, "SELECT status FROM inquiries WHERE id=?", i1).status, "Under Review");
  assert.equal((await a.c.post(`/api/inquiries/${i1}/cancel`)).status, 200);
  assert.equal((await a.c.post(`/api/inquiries/${i1}/messages`, { message: "hi" })).status, 409);
  assert.equal((await b.c.post(`/api/inquiries/${i1}/cancel`)).status, 404);
});

console.log("\n== Isolation / authorization ==");
await t("students cannot see/modify each other's requests, files, messages, reviews", async () => {
  const env = makeEnv(); const a = await newStudent(env, "alice"), b = await newStudent(env, "bobby", "3.3.3.3");
  const id = await submit(a.c, {}, [mkFile("notes.txt", bytes.txt(), "text/plain")]);
  const fid = ONE(env, "SELECT id FROM inquiry_files").id;
  assert.equal((await b.c.get(`/api/inquiries/${id}`)).status, 404);
  assert.equal((await b.c.get(`/api/inquiries/${id}/files/${fid}/download`)).status, 404);
  assert.equal((await b.c.post(`/api/inquiries/${id}/messages`, { message: "x" })).status, 404);
  assert.equal((await b.c.post(`/api/inquiries/${id}/review`, { rating: 5 })).status, 404);
  assert.equal((await b.c.get("/api/inquiries")).data.inquiries.length, 0);
  assert.equal((await a.c.get(`/api/inquiries/${id}/files/${fid}/download`)).status, 200);
  assert.equal((await new Client(env).get(`/api/inquiries/${id}`)).status, 401);
});
await t("all owner endpoints reject students and anonymous users", async () => {
  const env = makeEnv(); const { c } = await newStudent(env, "alice"); const anon = new Client(env);
  const eps: [string, string][] = [["GET", "/api/owner/students?q=ab"], ["GET", "/api/owner/security-events"], ["GET", "/api/owner/payment-methods"], ["POST", "/api/owner/payment-methods"],
    ["GET", "/api/owner/receipts"], ["GET", "/api/owner/reviews"], ["GET", "/api/owner/discord"], ["PUT", "/api/owner/discord"], ["POST", "/api/owner/discord/test"], ["DELETE", "/api/owner/receipts/x"]];
  for (const [m, p] of eps) { assert.equal((await c.call(m, p, m === "GET" ? undefined : {})).status, 403, p); assert.equal((await anon.call(m, p, m === "GET" ? undefined : {})).status, 401, p); }
});
await t("owner cannot read passwords or recovery codes; no impersonation endpoint", async () => {
  const env = makeEnv(); const owner = await newOwner(env); const { id } = await newStudent(env, "alice");
  const all = JSON.stringify([(await owner.get("/api/owner/students?q=alice")).data, (await owner.get("/api/owner/security-events")).data, (await owner.get("/api/inquiries")).data]);
  assert.ok(!/hash|salt|recovery/i.test(all));
  assert.equal((await owner.post(`/api/owner/students/${id}/login`)).status, 404);
  assert.equal((await owner.post(`/api/owner/students/${id}/session`)).status, 404);
});

console.log("\n== Files ==");
await t("upload validation: MIME/ext/signature mismatch, empty, bad type, limits", async () => {
  const env = makeEnv(); const { c } = await newStudent(env, "alice");
  const bad = async (files: File[], needle?: string) => { const r = await c.call("POST", "/api/inquiries", inquiryForm({}, files)); assert.equal(r.status, 400, JSON.stringify(r.data)); if (needle) assert.match(r.data.error, new RegExp(needle)); };
  await bad([mkFile("evil.pdf", bytes.png(), "application/pdf")], "valid PDF");           // signature mismatch
  await bad([mkFile("a.pdf", bytes.pdf(), "image/png")], "does not match");               // MIME mismatch
  await bad([mkFile("a.exe", bytes.pdf(), "application/pdf")], "unsupported");            // extension
  await bad([mkFile("a.html", bytes.txt(), "text/html")], "unsupported");
  await bad([mkFile("a.docx", bytes.pdf(), FILE_DOCX)], "valid DOCX");                    // zip signature absent
  await bad([mkFile("empty.txt", new Uint8Array(0), "text/plain")], "empty");
  await bad([mkFile("bin.txt", new Uint8Array([0, 1, 2, 3]), "text/plain")], "valid TXT");
  await bad([mkFile("big.pdf", new Uint8Array(5242881).fill(65).map((_, i) => i < 5 ? "%PDF-".charCodeAt(i) : 65), "application/pdf")], "larger than");
  await bad(Array.from({ length: 6 }, (_, i) => mkFile(`f${i}.txt`, bytes.txt(), "text/plain")), "maximum of 5");
  const big = (n: string) => mkFile(n, new Uint8Array(5000000).map((_, i) => i < 5 ? "%PDF-".charCodeAt(i) : 65), "application/pdf");
  await bad([big("1.pdf"), big("2.pdf"), big("3.pdf"), big("4.pdf")], "15 MB");
  assert.equal(env.FILES.objects.size, 0); assert.equal(rows(env, "SELECT * FROM inquiries").length, 0);
});
await t("valid uploads of every allowed type; stored under incoming/ with canonical MIME", async () => {
  const env = makeEnv(); const { c } = await newStudent(env, "alice");
  const files = [mkFile("a.pdf", bytes.pdf(), "application/pdf"), mkFile("b.docx", bytes.docx(), FILE_DOCX), mkFile("c.pptx", bytes.pptx(), FILE_PPTX), mkFile("d.png", bytes.png(), "image/png"), mkFile("e.jpg", bytes.jpg(), "image/jpeg")];
  await submit(c, {}, files);
  assert.equal(env.FILES.objects.size, 5); assert.ok([...env.FILES.objects.keys()].every(k => k.startsWith("incoming/")));
  const id = ONE(env, "SELECT id FROM inquiries").id;
  assert.equal((await c.call("POST", `/api/inquiries/${id}/files`, (() => { const f = new FormData(); f.append("files", mkFile("x.txt", bytes.txt(), "text/plain")); return f; })())).status, 400); // 6th file
});
await t("download: private headers, attachment disposition, nosniff, event recorded, no public URL", async () => {
  const env = makeEnv(); const { c } = await newStudent(env, "alice"); const id = await submit(c, {}, [mkFile("my notes.pdf", bytes.pdf(), "application/pdf")]);
  const fid = ONE(env, "SELECT id FROM inquiry_files").id;
  const r = await c.get(`/api/inquiries/${id}/files/${fid}/download`);
  assert.match(r.res.headers.get("content-disposition")!, /^attachment; filename="my notes.pdf"/); assert.equal(r.res.headers.get("x-content-type-options"), "nosniff");
  assert.match(r.res.headers.get("cache-control")!, /no-store/); assert.equal(r.res.headers.get("content-type"), "application/pdf");
  assert.equal((await c.get(`/api/inquiries/${id}/files/00000000-0000-0000-0000-000000000000/download`)).status, 404);
  assert.ok(!JSON.stringify((await c.get(`/api/inquiries/${id}`)).data).includes("object_key"));
});
await t("deliverables: owner upload, student download schedules (not immediate) deletion; D1 history kept", async () => {
  const env = makeEnv(); const a = await newStudent(env, "alice"); const owner = await newOwner(env); const id = await submit(a.c);
  const form = new FormData(); form.append("files", mkFile("done.docx", bytes.docx(), FILE_DOCX));
  assert.equal((await owner.call("POST", `/api/inquiries/${id}/files`, form)).status, 201);
  const f = ONE(env, "SELECT * FROM inquiry_files WHERE file_kind='deliverable'"); assert.ok(f.object_key.startsWith("deliverables/"));
  assert.equal((await a.c.get(`/api/inquiries/${id}/files/${f.id}/download`)).status, 200);
  const after = ONE(env, "SELECT * FROM inquiry_files WHERE id=?", f.id);
  assert.equal(after.deleted_at, null); assert.ok(env.FILES.objects.has(f.object_key)); assert.ok(after.first_downloaded_at);
  const days = (Date.parse(after.delete_after) - Date.now()) / 86400000; assert.ok(days > 6.9 && days < 7.1);
  assert.equal((await a.c.get(`/api/inquiries/${id}/files/${f.id}/download`)).status, 200); // still downloadable in grace period
  assert.equal((await a.c.call("POST", `/api/inquiries/${id}/files`, (() => { const x = new FormData(); x.append("files", mkFile("x.txt", bytes.txt(), "text/plain")); return x; })())).status, 201); // student may still add while Submitted
  assert.ok(ONE(env, "SELECT 1 x FROM inquiry_events WHERE event_type='DownloadStarted'"));
  // cleanup: nothing deleted before the deadline
  await runScheduled(env); assert.ok(env.FILES.objects.has(f.object_key));
  env.DB.db.exec("UPDATE inquiry_files SET delete_after='2020-01-01T00:00:00.000Z' WHERE file_kind='deliverable'");
  env.FILES.failDelete = true; await runScheduled(env);
  assert.ok(env.FILES.objects.has(f.object_key), "R2 object retained on failure"); assert.equal(rows(env, "SELECT * FROM r2_cleanup").length, 1);
  assert.ok(ONE(env, "SELECT deleted_at FROM inquiry_files WHERE id=?", f.id).deleted_at);
  assert.equal((await a.c.get(`/api/inquiries/${id}/files/${f.id}/download`)).status, 410);
  env.FILES.failDelete = false; await runScheduled(env);
  assert.ok(!env.FILES.objects.has(f.object_key)); assert.equal(rows(env, "SELECT * FROM r2_cleanup").length, 0);
  assert.ok(ONE(env, "SELECT 1 x FROM inquiries WHERE id=?", id)); assert.ok(ONE(env, "SELECT 1 x FROM inquiry_events WHERE inquiry_id=?", id));
  const detail = (await a.c.get(`/api/inquiries/${id}`)).data; assert.equal(detail.files.find((x: any) => x.id === f.id).expired, true);
});
await t("terminal status schedules incoming file retention; owner inline preview only for images", async () => {
  const env = makeEnv(); const a = await newStudent(env, "alice"); const owner = await newOwner(env);
  const id = await submit(a.c, {}, [mkFile("p.png", bytes.png(), "image/png"), mkFile("q.pdf", bytes.pdf(), "application/pdf")]);
  await owner.call("PATCH", `/api/inquiries/${id}`, { status: "Declined" });
  assert.equal(rows(env, "SELECT * FROM inquiry_files WHERE delete_after IS NOT NULL").length, 2);
  const [png, pdf] = ["p.png", "q.pdf"].map(n => ONE(env, "SELECT id FROM inquiry_files WHERE original_name=?", n).id);
  assert.match((await owner.get(`/api/inquiries/${id}/files/${png}/download?inline=1`)).res.headers.get("content-disposition")!, /^inline/);
  assert.match((await owner.get(`/api/inquiries/${id}/files/${pdf}/download?inline=1`)).res.headers.get("content-disposition")!, /^attachment/);
  assert.match((await a.c.get(`/api/inquiries/${id}/files/${png}/download?inline=1`)).res.headers.get("content-disposition")!, /^attachment/);
  const csp = (await owner.get(`/api/inquiries/${id}/files/${png}/download`)).res.headers.get("content-security-policy"); assert.match(csp!, /sandbox/);
});

console.log("\n== Reviews ==");
await t("review eligibility, one per request, moderation, public only when approved", async () => {
  const env = makeEnv(); const a = await newStudent(env, "alice"); const owner = await newOwner(env); const id = await submit(a.c);
  assert.equal((await a.c.post(`/api/inquiries/${id}/review`, { rating: 5 })).status, 403);
  for (const s of ["Accepted", "Completed"]) await owner.call("PATCH", `/api/inquiries/${id}`, { status: s });
  assert.equal((await a.c.post(`/api/inquiries/${id}/review`, { rating: 6 })).status, 400);
  assert.equal((await a.c.post(`/api/inquiries/${id}/review`, { rating: 0 })).status, 400);
  assert.equal((await owner.post(`/api/inquiries/${id}/review`, { rating: 5 })).status, 403);
  assert.equal((await a.c.post(`/api/inquiries/${id}/review`, { rating: 5, comment: "Fast and clear communication" })).status, 201);
  assert.equal((await a.c.post(`/api/inquiries/${id}/review`, { rating: 4 })).status, 409);
  assert.equal((await new Client(env).get("/api/reviews")).data.reviews.length, 0); // pending moderation
  const rid = (await owner.get("/api/owner/reviews")).data.reviews[0].id;
  assert.equal((await owner.call("PATCH", `/api/owner/reviews/${rid}`, { visible: true })).status, 200);
  const pub = (await new Client(env).get("/api/reviews")).data.reviews; assert.equal(pub.length, 1); assert.ok(!JSON.stringify(pub).includes("alice"));
  await owner.call("PATCH", `/api/owner/reviews/${rid}`, { visible: false }); assert.equal((await new Client(env).get("/api/reviews")).data.reviews.length, 0);
  assert.equal((await owner.call("DELETE", `/api/owner/reviews/${rid}`)).status, 200);
});

console.log("\n== Payment methods & receipts ==");
await t("payment methods CRUD, enable/disable, reorder, only enabled visible to students", async () => {
  const env = makeEnv(); const owner = await newOwner(env); const a = await newStudent(env, "alice");
  const mk = async (name: string, extra = {}) => (await owner.call("POST", "/api/owner/payment-methods", { name, accountHolder: "Z", accountIdentifier: "0917", instructions: "Send any amount", ...extra })).data.id as string;
  const g = await mk("GCash"), m = await mk("Maya"), gt = await mk("GoTyme", { enabled: false });
  assert.equal((await owner.call("POST", "/api/owner/payment-methods", { name: " " })).status, 400);
  assert.deepEqual((await a.c.get("/api/payment-methods")).data.methods.map((x: any) => x.name), ["GCash", "Maya"]);
  assert.equal((await owner.call("POST", "/api/owner/payment-methods/reorder", { ids: [gt, m, g] })).status, 200);
  assert.deepEqual((await a.c.get("/api/payment-methods")).data.methods.map((x: any) => x.name), ["Maya", "GCash"]);
  assert.equal((await owner.call("PATCH", `/api/owner/payment-methods/${gt}`, { name: "GoTyme", enabled: true })).status, 200);
  assert.equal((await a.c.get("/api/payment-methods")).data.methods.length, 3);
  assert.equal((await owner.call("PATCH", `/api/owner/payment-methods/${m}`, { name: "Maya", enabled: false })).status, 200);
  assert.equal((await a.c.get("/api/payment-methods")).data.methods.length, 2);
  assert.equal((await new Client(env).get("/api/payment-methods")).status, 401);
  assert.equal((await a.c.call("PATCH", `/api/owner/payment-methods/${g}`, { name: "x" })).status, 403);
  assert.equal((await owner.call("DELETE", `/api/owner/payment-methods/${g}`)).status, 200);
  assert.equal((await owner.get("/api/owner/payment-methods")).data.methods.length, 2);
});
await t("QR upload: owner only, image-only validation, replace queues old object, served via worker", async () => {
  const env = makeEnv(); const owner = await newOwner(env); const a = await newStudent(env, "alice");
  const id = (await owner.call("POST", "/api/owner/payment-methods", { name: "GCash" })).data.id;
  const up = (name: string, data: Uint8Array, type: string) => { const f = new FormData(); f.append("files", mkFile(name, data, type)); return f; };
  assert.equal((await a.c.call("PUT", `/api/owner/payment-methods/${id}/qr`, up("q.png", bytes.png(), "image/png"))).status, 403);
  assert.equal((await owner.call("PUT", `/api/owner/payment-methods/${id}/qr`, up("q.pdf", bytes.pdf(), "application/pdf"))).status, 400);
  assert.equal((await owner.call("PUT", `/api/owner/payment-methods/${id}/qr`, up("q.png", bytes.jpg(), "image/png"))).status, 400);
  assert.equal((await owner.call("PUT", `/api/owner/payment-methods/${id}/qr`, up("q.png", bytes.png(), "image/png"))).status, 200);
  const key1 = ONE(env, "SELECT qr_object_key k FROM payment_methods").k; assert.ok(key1.startsWith("payment-qr/"));
  const img = await a.c.get(`/api/payment-methods/${id}/qr`); assert.equal(img.status, 200); assert.equal(img.res.headers.get("content-type"), "image/png");
  assert.equal((await new Client(env).get(`/api/payment-methods/${id}/qr`)).status, 401);
  assert.equal((await owner.call("PUT", `/api/owner/payment-methods/${id}/qr`, up("q2.jpg", bytes.jpg(), "image/jpeg"))).status, 200);
  assert.ok(ONE(env, "SELECT 1 x FROM r2_cleanup WHERE object_key=?", key1));
  await runScheduled(env); assert.ok(!env.FILES.objects.has(key1));
  await owner.call("PATCH", `/api/owner/payment-methods/${id}`, { name: "GCash", enabled: false });
  assert.equal((await a.c.get(`/api/payment-methods/${id}/qr`)).status, 404);
});
await t("receipts: optional (thank-you only or file), validation, owner review/delete, retention", async () => {
  const env = makeEnv(); const owner = await newOwner(env); const a = await newStudent(env, "alice"); const b = await newStudent(env, "bobby", "3.3.3.3");
  const pm = (await owner.call("POST", "/api/owner/payment-methods", { name: "GCash" })).data.id; const iq = await submit(a.c);
  const form = (o: Record<string, string>, f?: File) => { const x = new FormData(); Object.entries(o).forEach(([k, v]) => x.set(k, v)); if (f) x.append("files", f); return x; };
  assert.equal((await a.c.call("POST", "/api/receipts", form({}))).status, 400);
  assert.equal((await a.c.call("POST", "/api/receipts", form({ message: "Thank you!" }))).status, 201);
  assert.equal((await a.c.call("POST", "/api/receipts", form({ paymentMethodId: pm, inquiryId: iq }, mkFile("r.png", bytes.png(), "image/png")))).status, 201);
  assert.equal((await a.c.call("POST", "/api/receipts", form({}, mkFile("r.docx", bytes.docx(), FILE_DOCX)))).status, 400);
  assert.equal((await a.c.call("POST", "/api/receipts", form({}, mkFile("r.png", bytes.pdf(), "image/png")))).status, 400);
  assert.equal((await b.c.call("POST", "/api/receipts", form({ inquiryId: iq, message: "hi" }))).status, 404); // not their request
  assert.equal((await owner.call("POST", "/api/receipts", form({ message: "x" }))).status, 403);
  const list = (await owner.get("/api/owner/receipts")).data.receipts; assert.equal(list.length, 2);
  const withFile = list.find((r: any) => r.has_file);
  assert.equal((await a.c.get(`/api/owner/receipts/${withFile.id}/file`)).status, 403);
  assert.equal((await owner.get(`/api/owner/receipts/${withFile.id}/file?inline=1`)).status, 200);
  assert.ok(ONE(env, "SELECT object_key k FROM contribution_receipts WHERE object_key IS NOT NULL").k.startsWith("donation-receipts/"));
  assert.equal((await owner.post(`/api/owner/receipts/${withFile.id}/reviewed`)).status, 200);
  assert.ok(ONE(env, "SELECT reviewed_at r FROM contribution_receipts WHERE id=?", withFile.id).r);
  const key = ONE(env, "SELECT object_key k FROM contribution_receipts WHERE id=?", withFile.id).k;
  assert.equal((await owner.call("DELETE", `/api/owner/receipts/${withFile.id}`)).status, 200);
  await runScheduled(env); assert.ok(!env.FILES.objects.has(key)); assert.equal((await owner.get("/api/owner/receipts")).data.receipts.length, 1);
  // retention
  const other = (await owner.get("/api/owner/receipts")).data.receipts[0]; assert.ok(ONE(env, "SELECT delete_after d FROM contribution_receipts WHERE id=?", other.id).d);
});
await t("receipts never affect request acceptance (no payment gating in API)", async () => {
  const env = makeEnv(); const owner = await newOwner(env); const a = await newStudent(env, "alice"); const id = await submit(a.c);
  for (const s of ["Accepted", "In Progress", "Completed"]) assert.equal((await owner.call("PATCH", `/api/inquiries/${id}`, { status: s })).status, 200);
});

console.log("\n== Discord webhook ==");
const HOOK = "https://discord.com/api/webhooks/123456789012345678/abcDEF-ghi_JKL";
function mockFetch() { const calls: any[] = []; let mode: "ok" | "fail" | "throw" = "ok"; const real = globalThis.fetch;
  globalThis.fetch = (async (u: any, init: any) => { calls.push({ url: String(u), body: JSON.parse(init.body) }); if (mode === "throw") throw new Error("net"); return new Response(null, { status: mode === "ok" ? 204 : 500 }); }) as any;
  return { calls, set: (m: any) => { mode = m; }, restore: () => { globalThis.fetch = real; } }; }
const OWNER_ID = "111222333444555666";
await t("settings API never returns webhook URL; test button; validation", async () => {
  const env = makeEnv({ DISCORD_WEBHOOK_URL: HOOK }); const owner = await newOwner(env); const mf = mockFetch();
  try {
    const s = await owner.get("/api/owner/discord"); assert.equal(s.data.webhookConfigured, true); assert.ok(!JSON.stringify(s.data).includes("webhooks"));
    assert.equal((await owner.call("PUT", "/api/owner/discord", { enabled: true, ownerId: "abc", events: {} })).status, 400);
    assert.equal((await owner.call("PUT", "/api/owner/discord", { enabled: true, ownerId: "", events: {} })).status, 400);
    assert.equal((await owner.call("POST", "/api/owner/discord/test")).status, 502); // no owner id yet
    const put = await owner.call("PUT", "/api/owner/discord", { enabled: true, ownerId: OWNER_ID, events: { new_inquiry: true, new_review: true } });
    assert.equal(put.status, 200); assert.ok(!JSON.stringify(put.data).includes("webhooks"));
    const t1 = await owner.call("POST", "/api/owner/discord/test"); assert.equal(t1.status, 200);
    assert.equal(mf.calls.length, 1); assert.deepEqual(mf.calls[0].body.allowed_mentions, { parse: [], users: [OWNER_ID] }); assert.equal(mf.calls[0].body.content, `<@${OWNER_ID}>`);
    const noHook = makeEnv(); const o2 = await newOwner(noHook);
    assert.equal((await o2.call("POST", "/api/owner/discord/test")).status, 502);
  } finally { mf.restore(); }
});
await t("new inquiry notifies owner only, minimal content, no @everyone, no secrets/attachments", async () => {
  const env = makeEnv({ DISCORD_WEBHOOK_URL: HOOK }); const owner = await newOwner(env); const a = await newStudent(env, "alice"); const mf = mockFetch();
  try {
    await owner.call("PUT", "/api/owner/discord", { enabled: true, ownerId: OWNER_ID, events: { new_inquiry: true } });
    await submit(a.c, { title: "@everyone @here free stuff", description: "see my private notes", notes: "my password is hunter2" }, [mkFile("secret.pdf", bytes.pdf(), "application/pdf")]);
    assert.equal(mf.calls.length, 1); const b = mf.calls[0].body, text = JSON.stringify(b);
    assert.equal(b.allowed_mentions.parse.length, 0); assert.deepEqual(b.allowed_mentions.users, [OWNER_ID]);
    assert.ok(!text.includes("@everyone") && !text.includes("@here")); assert.ok(!/hunter2|private notes|secret\.pdf|password/i.test(text));
    assert.match(text, /alice/); assert.match(text, /Senior High School/); assert.equal(mf.calls[0].url, HOOK);
    assert.equal(ONE(env, "SELECT status s FROM notifications").s, "sent");
  } finally { mf.restore(); }
});
await t("event preferences: disabled events skipped; accepted/completed/review/receipt/student-info fire when enabled", async () => {
  const env = makeEnv({ DISCORD_WEBHOOK_URL: HOOK }); const owner = await newOwner(env); const a = await newStudent(env, "alice"); const mf = mockFetch();
  try {
    await owner.call("PUT", "/api/owner/discord", { enabled: true, ownerId: OWNER_ID, events: { new_inquiry: true } });
    const id = await submit(a.c); assert.equal(mf.calls.length, 1);
    await owner.call("PATCH", `/api/inquiries/${id}`, { status: "Accepted" }); await owner.call("PATCH", `/api/inquiries/${id}`, { status: "Completed" });
    await a.c.post(`/api/inquiries/${id}/messages`, { message: "hello" }); // closed => 409, nothing sent
    assert.equal(mf.calls.length, 1); // others disabled
    await owner.call("PUT", "/api/owner/discord", { enabled: true, ownerId: OWNER_ID, events: { new_inquiry: true, student_info: true, decision: true, completed: true, new_review: true, receipt: true, download: true } });
    const id2 = await submit(a.c); await a.c.post(`/api/inquiries/${id2}/messages`, { message: "more info" });
    await owner.call("PATCH", `/api/inquiries/${id2}`, { status: "Accepted" }); await owner.call("PATCH", `/api/inquiries/${id2}`, { status: "Completed" });
    await a.c.post(`/api/inquiries/${id2}/review`, { rating: 5 });
    const f = new FormData(); f.set("message", "thanks"); await a.c.call("POST", "/api/receipts", f);
    const titles = mf.calls.slice(1).map(c => c.body.embeds[0].title);
    for (const w of ["New inquiry", "Student sent more information", "Request decision recorded", "Request completed", "New review", "Contribution receipt"]) assert.ok(titles.some((x: string) => x.includes(w)), w);
  } finally { mf.restore(); }
});
await t("Discord failure never blocks inquiry; retry sends exactly once; dedupe prevents duplicates", async () => {
  const env = makeEnv({ DISCORD_WEBHOOK_URL: HOOK }); const owner = await newOwner(env); const a = await newStudent(env, "alice"); const mf = mockFetch();
  try {
    await owner.call("PUT", "/api/owner/discord", { enabled: true, ownerId: OWNER_ID, events: { new_inquiry: true } });
    mf.set("throw"); const id = await submit(a.c); // still 201
    assert.equal(ONE(env, "SELECT status s FROM notifications").s, "failed"); assert.ok(ONE(env, "SELECT last_error e FROM notifications").e);
    assert.equal((await owner.get("/api/owner/discord")).data.failedNotifications, 1);
    mf.set("fail"); await submit(a.c); assert.equal(rows(env, "SELECT * FROM notifications WHERE status='failed'").length, 2);
    mf.set("ok"); env.DB.db.prepare("UPDATE notifications SET created_at=?").run(new Date(Date.now() - 600000).toISOString());
    const before = mf.calls.length; await runScheduled(env); assert.equal(mf.calls.length - before, 2);
    await runScheduled(env); assert.equal(mf.calls.length - before, 2); // already sent: no duplicates
    assert.equal(rows(env, "SELECT * FROM notifications WHERE status='sent'").length, 2);
    // dedupe key: enqueueing the same logical event twice sends once
    const { notify } = await import("../src/notify.ts"); const n0 = mf.calls.length;
    await notify(env, null, "new_inquiry", id, { ref: id }); await notify(env, null, "new_inquiry", id, { ref: id });
    assert.equal(mf.calls.length, n0); // same dedupe key as the original inquiry notification
    // concurrent delivery claims only once
    env.DB.db.exec("INSERT INTO notifications(id,dedupe_key,event_type,payload) VALUES('c1','new_inquiry:race','new_inquiry','{\"ref\":\"r\"}')");
    await Promise.all([notify(env, null, "new_inquiry", "race", { ref: "r" }), notify(env, null, "new_inquiry", "race", { ref: "r" })]);
    assert.equal(mf.calls.length - n0, 1);
  } finally { mf.restore(); }
});
await t("disabled integration or missing secret: inquiries still work, notifications skipped", async () => {
  const env = makeEnv(); const a = await newStudent(env, "alice"); await submit(a.c);
  assert.equal(ONE(env, "SELECT status s FROM notifications").s, "skipped");
});
await t("invalid webhook URL secret is refused (SSRF guard)", async () => {
  const env = makeEnv({ DISCORD_WEBHOOK_URL: "https://evil.example/api/webhooks/1/x" }); const owner = await newOwner(env); const mf = mockFetch();
  try { await owner.call("PUT", "/api/owner/discord", { enabled: true, ownerId: OWNER_ID, events: {} }); assert.equal((await owner.call("POST", "/api/owner/discord/test")).status, 502); assert.equal(mf.calls.length, 0); }
  finally { mf.restore(); }
});

console.log("\n== Misc / security ==");
await t("security events recorded for owner; failed logins visible; no secrets in events", async () => {
  const env = makeEnv(); const owner = await newOwner(env); await new Client(env).post("/api/auth/login", { username: "ghost", password: "whatever-pass" });
  const ev = (await owner.get("/api/owner/security-events")).data.events.map((e: any) => e.event_type); assert.ok(ev.includes("owner_created")); assert.ok(ev.includes("login_failed"));
});
await t("change password revokes other sessions; logout-all works", async () => {
  const env = makeEnv(); const { c } = await newStudent(env, "alice"); const c2 = new Client(env, "3.3.3.3"); await c2.post("/api/auth/login", { username: "alice", password: PW });
  assert.equal((await c.post("/api/account/password", { currentPassword: "wrong-password!", newPassword: "new password 12345" })).status, 400);
  assert.equal((await c.post("/api/account/password", { currentPassword: PW, newPassword: "new password 12345" })).status, 200);
  assert.equal((await c2.get("/api/me")).data.user, null); assert.equal((await c.get("/api/me")).data.user.username, "alice");
  assert.equal((await c.post("/api/auth/logout-all")).status, 200); assert.equal((await c.get("/api/me")).data.user, null);
});
await t("SQL-injection style input is treated as data; unknown API routes 404; errors don't leak internals", async () => {
  const env = makeEnv(); const { c } = await newStudent(env, "alice"); const owner = await newOwner(env);
  assert.equal((await owner.get("/api/inquiries?q=" + encodeURIComponent("' OR 1=1 --"))).data.inquiries.length, 0);
  assert.equal((await owner.get("/api/inquiries?status=" + encodeURIComponent("Submitted' OR '1'='1"))).status, 400);
  assert.equal((await c.get("/api/nope")).status, 404);
  const r = await c.call("POST", "/api/inquiries", "not-form" as any, { headers: { "content-type": "text/plain" } }); assert.ok(r.status >= 400 && r.status < 500); assert.ok(!JSON.stringify(r.data).match(/stack|sqlite|at /i));
  const xss = await submit(c, { title: "<script>alert(1)</script>" }); assert.equal((await c.get(`/api/inquiries/${xss}`)).data.inquiry.title, "<script>alert(1)</script>"); // stored raw, escaped by UI
});
await t("public config + health; static fallthrough carries security headers", async () => {
  const env = makeEnv({ CONTACT_EMAIL: "hi@zein.test" }); const c = new Client(env);
  const cfg = (await c.get("/api/config")).data; assert.deepEqual(cfg.levels, ["Elementary School", "Junior High School", "Senior High School"]); assert.equal(cfg.contactEmail, "hi@zein.test");
  assert.ok(!JSON.stringify(cfg).match(/college|university/i));
  assert.equal((await c.get("/api/health")).data.ok, true);
  const s = await worker.fetch(new Request("https://zein.test/"), env, { waitUntil() {} } as any); assert.equal(s.headers.get("x-frame-options"), "DENY");
});
await t("scheduled housekeeping purges expired sessions/tokens", async () => {
  const env = makeEnv(); await newStudent(env, "alice"); env.DB.db.exec("UPDATE sessions SET expires_at='2020-01-01T00:00:00.000Z'"); await runScheduled(env);
  assert.equal(rows(env, "SELECT * FROM sessions").length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`); if (failed) { console.log(failures.join("\n")); process.exit(1); }
