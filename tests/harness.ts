// Local test harness: a D1/R2/Assets stand-in backed by node:sqlite and memory.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker from "../src/index.ts";

class Stmt {
  args: unknown[] = [];
  db: DatabaseSync; sql: string;
  constructor(db: DatabaseSync, sql: string) { this.db = db; this.sql = sql; }
  bind(...a: unknown[]) { this.args = a.map(v => v === undefined ? null : v); return this; }
  async first() { return (this.db.prepare(this.sql).get(...(this.args as any)) as any) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...(this.args as any)) as any[], success: true, meta: { changes: 0 } }; }
  async run() {
    if (/\breturning\b/i.test(this.sql)) { this.db.prepare(this.sql).all(...(this.args as any)); return { results: [], success: true, meta: { changes: 1 } }; }
    const r = this.db.prepare(this.sql).run(...(this.args as any));
    return { results: [], success: true, meta: { changes: Number(r.changes) } };
  }
  runSync() { return this.run(); }
}
export class FakeD1 {
  db = new DatabaseSync(":memory:");
  constructor() { this.db.exec("PRAGMA foreign_keys=ON"); this.db.exec(readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8")); }
  prepare(sql: string) { return new Stmt(this.db, sql); }
  async batch(stmts: Stmt[]) {
    this.db.exec("BEGIN");
    try { const out = []; for (const s of stmts) out.push(await s.run()); this.db.exec("COMMIT"); return out; }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
}
export class FakeR2 {
  objects = new Map<string, { data: Uint8Array; uploaded: Date; ct?: string }>();
  failDelete = false;
  async put(k: string, v: any, o?: any) { this.objects.set(k, { data: new Uint8Array(v), uploaded: new Date(), ct: o?.httpMetadata?.contentType }); }
  async get(k: string) { const o = this.objects.get(k); return o ? { body: new Blob([o.data]).stream(), uploaded: o.uploaded, key: k } : null; }
  async delete(k: string) { if (this.failDelete) throw new Error("r2 down"); this.objects.delete(k); }
  async list(o: any) { return { objects: [...this.objects].filter(([k]) => k.startsWith(o?.prefix || "")).map(([key, v]) => ({ key, uploaded: v.uploaded, body: null as any })) }; }
}
export function makeEnv(extra: Record<string, unknown> = {}) {
  const DB = new FakeD1(), FILES = new FakeR2();
  const env: any = {
    DB, FILES, OWNER_USERNAME: "zein_owner", OWNER_SETUP_SECRET: "s".repeat(40), CONTACT_EMAIL: "",
    ASSETS: { fetch: async () => new Response("<html></html>", { headers: { "content-type": "text/html" } }) }, ...extra,
  };
  return env;
}
export const ec = { waitUntil(p: Promise<any>) { pending.push(p.catch(() => {})); } };
export const pending: Promise<any>[] = [];
export const settle = async () => { while (pending.length) await Promise.all(pending.splice(0)); };

export class Client {
  cookie = ""; csrf = ""; user: any = null; env: any; ip: string;
  constructor(env: any, ip = "1.1.1.1") { this.env = env; this.ip = ip; }
  async call(method: string, path: string, body?: any, opts: { headers?: Record<string, string>; noCsrf?: boolean } = {}) {
    const h: Record<string, string> = { origin: "https://zein.test", "cf-connecting-ip": this.ip, ...opts.headers };
    if (this.cookie) h.cookie = this.cookie;
    if (this.csrf && !opts.noCsrf) h["x-csrf-token"] = this.csrf;
    let b: any;
    if (body instanceof FormData) b = body; else if (body !== undefined) { h["content-type"] = "application/json"; b = JSON.stringify(body); }
    const res = await worker.fetch(new Request("https://zein.test" + path, { method, headers: h, body: b }), this.env, ec as any);
    await settle();
    const sc = res.headers.get("set-cookie");
    if (sc) { const m = sc.match(/^__Host-zein_session=([^;]*)/); this.cookie = m && m[1] ? `__Host-zein_session=${m[1]}` : ""; }
    const ct = res.headers.get("content-type") || "";
    const data = ct.includes("json") ? await res.json() : null;
    if (data?.csrfToken) { this.csrf = data.csrfToken; }
    if (data?.user) this.user = data.user;
    return { status: res.status, data, res };
  }
  get(p: string) { return this.call("GET", p); }
  post(p: string, b?: any) { return this.call("POST", p, b ?? {}); }
}
export const bytes = {
  pdf: () => new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF"),
  png: () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
  jpg: () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]),
  docx: () => new Uint8Array([0x50, 0x4b, 3, 4, ...new TextEncoder().encode("word/document.xml")]),
  pptx: () => new Uint8Array([0x50, 0x4b, 3, 4, ...new TextEncoder().encode("ppt/slides/slide1.xml")]),
  txt: () => new TextEncoder().encode("hello notes"),
};
export const mkFile = (name: string, data: Uint8Array, type: string) => new File([data], name, { type });
export function inquiryForm(over: Record<string, string> = {}, files: File[] = []) {
  const f = new FormData();
  const base: Record<string, string> = { service: "PowerPoint Presentations", educationLevel: "Senior High School", title: "Science slides", description: "5 slides about photosynthesis", deadline: "", preferredDate: "", notes: "", contactDetails: "", ...over };
  for (const [k, v] of Object.entries(base)) f.set(k, v);
  files.forEach(x => f.append("files", x));
  return f;
}
