# Zein E-Services — Your Tasks, Made Easier.

Student-focused request platform on **Cloudflare Workers + D1 + one private R2 bucket**, with a plain HTML/CSS/JS front end.
Zein is an independent provider (not a school). Eligible levels: **Elementary, Junior High, Senior High** — enforced in the UI *and* the API.

## What is included
Public site (Home, Services, Eligibility, How It Works, Why Zein, Reviews, FAQ, Contact, Terms, Privacy) · username-first accounts with 365-day sessions ·
recovery code + owner-issued 24-hour passcodes · 4-step inquiry flow · owner dashboard (inbox with search/filter, request details, accept/decline/clarify,
status & notes, deliverable uploads, student lookup & recovery, security log, review moderation, receipts, payment methods, Discord webhook) ·
private Worker-mediated file downloads with retention cleanup · voluntary contribution methods (no payment processing).

## Ordinary variables vs. secrets
| Name | Type | Where | Purpose |
|---|---|---|---|
| `OWNER_USERNAME` | variable | `wrangler.jsonc` → `vars` | The one username allowed to become owner |
| `CONTACT_EMAIL` | variable (optional) | `vars` | Shown on the Contact page. Leave `""` until you have a real address |
| `MAX_FILE_BYTES`, `MAX_REQUEST_BYTES` | variables | `vars` | 5 MB per file / 15 MB total (defaults) |
| `DELIVERABLE_GRACE_DAYS` (7), `INQUIRY_FILE_RETENTION_DAYS` (30), `RECEIPT_RETENTION_DAYS` (60) | variables | `vars` | Retention rules (see below) |
| `OWNER_SETUP_SECRET` | **secret** | `wrangler secret put` | One-time owner bootstrap; ≥ 32 random characters. Not a student credential |
| `DISCORD_WEBHOOK_URL` | **secret** | `wrangler secret put` | Discord incoming-webhook URL. Never sent to the browser |

## First deployment (from a computer; Android works via Termux or a cloud shell)
1. `npm install`
2. `npx wrangler login`
3. **D1:** `npx wrangler d1 create zein-db` → copy the `database_id` into `wrangler.jsonc` (`REPLACE_WITH_D1_DATABASE_ID`).
4. **R2 (one private bucket):** `npx wrangler r2 bucket create zein-files`. Do **not** enable public access or a custom domain on it.
5. Edit `wrangler.jsonc` → `vars.OWNER_USERNAME` (your owner username, 3–32 chars: letters/numbers/`._-`).
6. **Initialize the empty database once:** `npm run db:remote` (runs `migrations/0001_initial.sql`). Do not run it again on a database that has data. For local dev: `npm run db:local`.
7. **Secrets:**
   - `npx wrangler secret put OWNER_SETUP_SECRET` (e.g. paste output of `openssl rand -hex 32`)
   - Optional now / later: `npx wrangler secret put DISCORD_WEBHOOK_URL`
8. `npm run deploy`
9. **Create the owner account:** open `https://<your-worker>.workers.dev/#/owner-setup`, enter `OWNER_USERNAME`, a strong password and `OWNER_SETUP_SECRET`. Save the recovery code shown once. Only one owner can ever be created; the page does nothing afterwards.
10. Owner dashboard → **Settings → Payment Methods** (add GCash, Maya, MariBank, GoTyme… upload QR images) and **Settings → Integrations** (Discord).
11. Set `CONTACT_EMAIL` in `vars` and redeploy when you have a real address (the site does not invent one).

### Discord webhook setup
Discord channel → Edit Channel → Integrations → Webhooks → New Webhook → Copy URL → `wrangler secret put DISCORD_WEBHOOK_URL`.
Then in the dashboard enter your Discord user ID (Developer Mode → right-click your name → Copy User ID), choose events, save, press **Send test notification**.
Only that user is mentioned (`allowed_mentions` restricted; no `@everyone`/`@here`). Messages contain only reference, service, username, level and status.
Notifications go through a D1 outbox (`notifications`): unique dedupe keys prevent duplicates, failures never block requests, and the hourly cron retries failed ones (max 5 attempts).

## How key rules work
- **Sessions:** random token in a `__Host-` Secure, HttpOnly, SameSite=Lax cookie; only its SHA-256 is stored; 365-day server-side expiry; logout, sign-out-everywhere, password change and password reset revoke sessions. Authenticated writes also require a per-session CSRF header.
- **Passwords:** PBKDF2-SHA256 (100,000 iterations — the Workers maximum) with per-user salt. Recovery codes (100-bit) and passcodes are stored only as hashes. The owner cannot view them and has no impersonation feature.
- **Self-service recovery:** username + recovery code → reset page → new password, old code invalidated, **new code shown once**, all sessions revoked.
- **Owner-assisted recovery:** Owner → Students → search username → *Generate temporary reset passcode* (shown once; single-use; 24 h; a new one replaces the old; 5 wrong attempts lock it; issuance and verification are rate-limited). The passcode is consumed when verified and the student must then set a new password within 15 minutes (one-time reset token).
- **Rate limits** (D1-backed): login, registration, recovery, passcode issue/verify, inquiries (10/day), messages, receipts.
- **Files:** one private bucket `zein-files`; prefixes `incoming/`, `deliverables/`, `payment-qr/`, `donation-receipts/` (`temporary/` is reserved and swept after 24 h). Extension, declared MIME **and file signature** must agree (PDF, DOC, DOCX, PPTX, TXT, JPG, PNG; receipts: PDF/JPG/PNG; QR: PNG/JPG). Max 5 files, 5 MB each, 15 MB total. All access is authenticated, ownership-checked and streamed through the Worker as `attachment` with `nosniff`; the owner can preview images inline in a sandboxed response.
- **Retention (hourly cron, `0 * * * *`):** a download click never deletes anything. A student's first download of a deliverable schedules deletion after `DELIVERABLE_GRACE_DAYS` (7); deliverables otherwise expire after 30 days; the student's own files expire 30 days after a request is Completed/Declined/Cancelled; receipts after 60 days. D1 marks the file deleted first and queues the R2 delete in `r2_cleanup`, so failed R2 deletes are retried. Requests, messages and events are kept.
- **Reviews:** only the student who owns a *Completed* request, one per request, 1–5 stars. Reviews are hidden until the owner approves them.
- **Statuses:** Submitted, Read, Under Review, Awaiting Response, Accepted, In Progress, Completed, Declined, Cancelled. Only opening an individual request (not the inbox) moves Submitted → Read. Owner transitions are validated server-side.

## Local development & tests
- `npm run dev` runs the Worker with local D1/R2 (apply `npm run db:local` first; create the owner at `/#/owner-setup` with a secret in `.dev.vars`: `OWNER_SETUP_SECRET=<32+ chars>`).
- `npm run typecheck` — TypeScript.
- `npm test` — backend suite (Node ≥ 22.18; uses an in-memory SQLite/R2 stand-in for D1/R2 running the real Worker code and the real schema).

## Known limitations
- Not yet exercised on real Cloudflare infrastructure (no network/credentials were available while building). Do the live checks below after first deploy.
- No email delivery: students recover through recovery codes or owner passcodes. A student who loses both and cannot reach the owner has no self-service path.
- Mobile layout was verified in headless Chromium at 390 px width, not on physical Android devices.
- PDFs are downloaded, not previewed inline; only images preview for the owner.
- The ineligible-level keyword screen is deliberately narrow (e.g. “college”, “university”, “master's”, “PhD”); the owner reviews every request anyway.
- Terms/Privacy are neutral plain-language templates, not legal advice — review them before launch.

## Live checks after first deploy
1. Create owner; confirm `/api/owner/*` returns 403 for a student account.
2. Register two students; confirm each sees only their own requests/files.
3. Submit an inquiry with a PDF; check it appears under `incoming/` in R2 and that no public R2 URL works.
4. Download a deliverable as the student; confirm the file still exists in R2 afterwards.
5. Enter the webhook secret and press *Send test notification* in the dashboard.
6. Open the site on an Android phone and walk through register → inquiry → track.
