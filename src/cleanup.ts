// Scheduled maintenance (Cron Trigger): retention cleanup, R2 delete retries, notification retries.
import type { Env } from "./lib.ts";
import { nowIso } from "./lib.ts";
import { retryNotifications } from "./notify.ts";

export async function runScheduled(env: Env) {
  const now = nowIso();
  // 1. Expire files: mark deleted in D1 first, queue the R2 delete (retry-safe). Request/event rows are kept.
  const files = await env.DB.prepare("SELECT id,object_key FROM inquiry_files WHERE deleted_at IS NULL AND delete_after IS NOT NULL AND delete_after<=? LIMIT 200").bind(now).all<any>();
  for (const f of files.results) await env.DB.batch([
    env.DB.prepare("UPDATE inquiry_files SET deleted_at=? WHERE id=?").bind(now, f.id),
    env.DB.prepare("INSERT OR IGNORE INTO r2_cleanup(object_key,reason) VALUES(?,'retention')").bind(f.object_key),
  ]);
  const receipts = await env.DB.prepare("SELECT id,object_key FROM contribution_receipts WHERE object_key IS NOT NULL AND delete_after IS NOT NULL AND delete_after<=? LIMIT 200").bind(now).all<any>();
  for (const r of receipts.results) await env.DB.batch([
    env.DB.prepare("UPDATE contribution_receipts SET object_key=NULL,deleted_at=? WHERE id=?").bind(now, r.id),
    env.DB.prepare("INSERT OR IGNORE INTO r2_cleanup(object_key,reason) VALUES(?,'receipt retention')").bind(r.object_key),
  ]);
  // 2. Process the R2 deletion queue; failures stay queued for the next run.
  const queue = await env.DB.prepare("SELECT object_key FROM r2_cleanup LIMIT 200").all<{ object_key: string }>();
  for (const q of queue.results) {
    try { await env.FILES.delete(q.object_key); await env.DB.prepare("DELETE FROM r2_cleanup WHERE object_key=?").bind(q.object_key).run(); }
    catch { console.error("R2 delete failed; will retry"); }
  }
  // 3. Sweep stale temporary/ objects (older than 24h).
  try {
    const list = await env.FILES.list({ prefix: "temporary/", limit: 200 });
    for (const o of list.objects) if (Date.now() - o.uploaded.getTime() > 86400000) await env.FILES.delete(o.key);
  } catch { /* retry next run */ }
  // 4. Housekeeping.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at<=?").bind(now),
    env.DB.prepare("DELETE FROM reset_tokens WHERE expires_at<=?").bind(now),
    env.DB.prepare("DELETE FROM rate_limits WHERE window_start<?").bind(Math.floor(Date.now() / 1000) - 172800),
    env.DB.prepare("DELETE FROM notifications WHERE status IN ('sent','skipped') AND created_at<?").bind(new Date(Date.now() - 30 * 86400000).toISOString()),
    env.DB.prepare("DELETE FROM security_events WHERE created_at<?").bind(new Date(Date.now() - 180 * 86400000).toISOString()),
  ]);
  await retryNotifications(env);
}
