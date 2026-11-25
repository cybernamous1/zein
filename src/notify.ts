// Discord webhook notifications via a durable, idempotent outbox.
// The webhook URL lives only in the DISCORD_WEBHOOK_URL Worker secret.
import type { Env } from "./lib.ts";
import { uid } from "./lib.ts";

export type NotifyEvent = "new_inquiry" | "student_info" | "decision" | "completed" | "new_review" | "receipt" | "download";
export const NOTIFY_EVENTS: NotifyEvent[] = ["new_inquiry", "student_info", "decision", "completed", "new_review", "receipt", "download"];
const WEBHOOK_RE = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;
const MAX_ATTEMPTS = 5;

export interface DiscordSettings { enabled: boolean; ownerId: string; events: Record<string, boolean> }
export async function getDiscordSettings(env: Env): Promise<DiscordSettings> {
  const rows = await env.DB.prepare("SELECT key,value FROM settings WHERE key LIKE 'discord_%'").all<{ key: string; value: string }>();
  const m = Object.fromEntries(rows.results.map(r => [r.key, r.value]));
  let events: Record<string, boolean> = {};
  try { events = JSON.parse(m.discord_events || "{}"); } catch { /* defaults below */ }
  for (const e of NOTIFY_EVENTS) events[e] = events[e] === true;
  return { enabled: m.discord_enabled === "1", ownerId: m.discord_owner_id || "", events };
}
export const validWebhook = (u: string | undefined) => !!u && WEBHOOK_RE.test(u);
export const validDiscordId = (s: string) => /^\d{17,20}$/.test(s);

const TITLES: Record<NotifyEvent, string> = {
  new_inquiry: "New inquiry", student_info: "Student sent more information", decision: "Request decision recorded",
  completed: "Request completed", new_review: "New review awaiting moderation", receipt: "Contribution receipt / thank-you submitted",
  download: "Student downloaded a deliverable",
};
export interface NotifyData { ref: string; service?: string; username?: string; level?: string; status?: string }

function buildBody(event: NotifyEvent, d: NotifyData, ownerId: string, test = false) {
  const esc = (s: string) => s.replace(/[`*_~|>@\\]/g, "");
  const lines = [
    d.ref && `Reference: ${esc(d.ref).slice(0, 36)}`, d.service && `Service: ${esc(d.service).slice(0, 80)}`,
    d.username && `Student: ${esc(d.username).slice(0, 40)}`, d.level && `Level: ${esc(d.level).slice(0, 40)}`,
    d.status && `Status: ${esc(d.status).slice(0, 30)}`,
  ].filter(Boolean) as string[];
  lines.push("Open the Zein owner dashboard to view details.");
  return {
    username: "Zein E-Services",
    content: ownerId ? `<@${ownerId}>` : "",
    allowed_mentions: { parse: [], users: ownerId ? [ownerId] : [] },
    embeds: [{ title: test ? "Test notification" : TITLES[event], description: test ? "Your Zein Discord webhook is working." : lines.join("\n"), color: 0x65b6a5 }],
  };
}
async function post(env: Env, body: unknown): Promise<{ ok: boolean; error?: string }> {
  const url = env.DISCORD_WEBHOOK_URL;
  if (!validWebhook(url)) return { ok: false, error: "Webhook secret is missing or invalid." };
  try {
    const res = await fetch(url!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (res.ok) return { ok: true };
    return { ok: false, error: res.status === 429 ? "Rate limited by Discord." : `Discord responded with ${res.status}.` };
  } catch { return { ok: false, error: "Could not reach Discord." }; }
}

/** Queue (idempotent on dedupeKey) and try to deliver. Never throws. */
export async function notify(env: Env, ec: ExecutionContext | null, event: NotifyEvent, dedupeKey: string, data: NotifyData) {
  try {
    const id = uid();
    await env.DB.prepare("INSERT OR IGNORE INTO notifications(id,dedupe_key,event_type,payload) VALUES(?,?,?,?)")
      .bind(id, `${event}:${dedupeKey}`, event, JSON.stringify(data)).run();
    const p = deliver(env, `${event}:${dedupeKey}`);
    if (ec) ec.waitUntil(p); else await p;
  } catch { console.error("notify enqueue failed"); }
}

async function deliver(env: Env, dedupeKey: string) {
  try {
    const n = await env.DB.prepare("SELECT * FROM notifications WHERE dedupe_key=? AND status IN ('pending','failed') AND attempts<?")
      .bind(dedupeKey, MAX_ATTEMPTS).first<any>();
    if (n) await attempt(env, n);
  } catch { console.error("notify deliver failed"); }
}
async function attempt(env: Env, n: any) {
  const s = await getDiscordSettings(env);
  const skip = !s.enabled || !s.events[n.event_type] || !validWebhook(env.DISCORD_WEBHOOK_URL);
  // Optimistic claim: only one concurrent sender can bump attempts from the value it read.
  const claim = await env.DB.prepare("UPDATE notifications SET attempts=attempts+1 WHERE id=? AND attempts=? AND status IN ('pending','failed')")
    .bind(n.id, n.attempts).run();
  if (!claim.meta.changes) return;
  if (skip) { await env.DB.prepare("UPDATE notifications SET status='skipped' WHERE id=?").bind(n.id).run(); return; }
  const r = await post(env, buildBody(n.event_type, JSON.parse(n.payload), s.ownerId));
  if (r.ok) await env.DB.prepare("UPDATE notifications SET status='sent',sent_at=?,last_error=NULL WHERE id=?").bind(new Date().toISOString(), n.id).run();
  else await env.DB.prepare("UPDATE notifications SET status='failed',last_error=? WHERE id=?").bind(r.error || "failed", n.id).run();
}
/** Cron: retry failed/stuck notifications older than two minutes. */
export async function retryNotifications(env: Env) {
  const cutoff = new Date(Date.now() - 120000).toISOString();
  const rows = await env.DB.prepare("SELECT * FROM notifications WHERE status IN ('pending','failed') AND attempts<? AND created_at<? LIMIT 20")
    .bind(MAX_ATTEMPTS, cutoff).all<any>();
  for (const n of rows.results) await attempt(env, n);
}
export async function sendTest(env: Env) {
  const s = await getDiscordSettings(env);
  if (!validWebhook(env.DISCORD_WEBHOOK_URL)) return { ok: false, error: "DISCORD_WEBHOOK_URL secret is not set or is not a valid Discord webhook URL." };
  if (!validDiscordId(s.ownerId)) return { ok: false, error: "Save a valid owner Discord user ID first." };
  return post(env, buildBody("new_inquiry", { ref: "" }, s.ownerId, true));
}
export async function discordStatus(env: Env) {
  const s = await getDiscordSettings(env);
  const failed = await env.DB.prepare("SELECT COUNT(*) c FROM notifications WHERE status='failed'").first<{ c: number }>();
  return { ...s, webhookConfigured: validWebhook(env.DISCORD_WEBHOOK_URL), failedNotifications: failed?.c ?? 0 };
}
