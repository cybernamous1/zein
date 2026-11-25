// Local server for browser testing: real Worker code + in-memory D1/R2, static files from /public.
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname } from "node:path";
import worker from "../src/index.ts";
import { makeEnv } from "./harness.ts";

const PORT = Number(process.env.PORT || 8799);
export const env: any = makeEnv({ DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123456789012345678/test-token" });
const pub = new URL("../public/", import.meta.url);
const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const headersFile = readFileSync(new URL("_headers", pub), "utf8").split("\n").slice(1).map(l => l.trim()).filter(Boolean).map(l => l.split(/:\s(.+)/).slice(0, 2));
env.ASSETS = { async fetch(req: Request) {
  const p = new URL(req.url).pathname; const f = p === "/" ? "index.html" : p.slice(1);
  const ok = existsSync(new URL(f, pub)) && !f.startsWith("_");
  const body = readFileSync(new URL(ok ? f : "index.html", pub));
  const h = new Headers({ "content-type": types[extname(ok ? f : "index.html")] || "application/octet-stream" });
  for (const [k, v] of headersFile) h.set(k, v);
  return new Response(body, { headers: h });
} };
// Discord stub so notifications can be observed
export const discordCalls: any[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (u: any, init: any) => { if (String(u).startsWith("https://discord.com/")) { discordCalls.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); } return realFetch(u, init); }) as any;

createServer(async (req, res) => {
  const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
  const url = `http://localhost:${PORT}${req.url}`;
  const hdrs: Record<string, string> = {}; for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") hdrs[k] = v;
  if (req.url === "/__discord") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify(discordCalls)); }
  const body = ["GET", "HEAD"].includes(req.method!) ? undefined : Buffer.concat(chunks);
  const r = await worker.fetch(new Request(url, { method: req.method, headers: hdrs, body }), env, { waitUntil() {} } as any);
  res.statusCode = r.status; r.headers.forEach((v, k) => res.setHeader(k, v));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(PORT, () => console.log("listening " + PORT));
