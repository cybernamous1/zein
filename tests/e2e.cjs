const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const B = "http://localhost:8799";
let pass = 0; const errs = [];
const ok = n => { pass++; console.log("  ok  " + n); };
(async () => {
  const browser = await chromium.launch();
  const mk = async (opts = {}) => { const ctx = await browser.newContext(opts); const p = await ctx.newPage();
    p.on("console", m => { if (["error", "warning"].includes(m.type())) errs.push(`[${m.type()}] ${m.text()}`); }); p.on("pageerror", e => errs.push("pageerror " + e.message)); return { ctx, p }; };
  const { p: o } = await mk({ viewport: { width: 1200, height: 900 } });
  const { p: s, ctx: sctx } = await mk({ viewport: { width: 390, height: 800 }, isMobile: true, acceptDownloads: true });
  const fs = require("fs"); fs.writeFileSync("/tmp/t.pdf", "%PDF-1.4\nhello\n%%EOF"); fs.writeFileSync("/tmp/done.txt", "finished work");

  // public pages
  await s.goto(B + "/"); await s.waitForSelector("text=Available services");
  for (const [h, t] of [["terms", "Terms of Service"], ["privacy", "Privacy Policy"], ["contact", "Contact"], ["login", "Sign in"], ["register", "Create your account"], ["recover", "Reset your password"]]) { await s.goto(`${B}/#/${h}`); await s.waitForSelector(`h1:has-text("${t}")`); }
  await s.goto(B + "/#/faq"); await s.waitForSelector("text=Frequently asked questions"); ok("public pages render (terms, privacy, contact, FAQ, auth, recover)");
  assert.equal(await s.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true); ok("no horizontal overflow on 390px phone (faq)");
  await s.goto(B + "/"); assert.equal(await s.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true); ok("no horizontal overflow on phone (home)");
  assert.equal(await s.locator("text=/graduation|\\btoga\\b|classroom/i").count(), 0); ok("no school imagery/wording");

  // owner setup in desktop browser
  await o.goto(B + "/#/owner-setup");
  await o.fill("#ou", "zein_owner"); await o.fill("#op", "owner-password-123"); await o.fill("#os", "s".repeat(40)); await o.click("text=Create owner account");
  await o.waitForSelector("#rc"); const ownerCode = await o.textContent("#rc"); assert.match(ownerCode, /^[A-Z2-9-]{24}$/);
  assert.equal(await o.isDisabled("#contRc"), true); await o.check("#savedRc"); await o.click("#contRc"); await o.waitForSelector("h1:has-text('Inbox')"); ok("owner setup + recovery code gate + dashboard");

  // student registers on mobile
  await s.goto(B + "/#/register");
  await s.fill("#u", "mika_s"); await s.fill("#p", "my-secret-pass-1"); await s.fill("#p2", "my-secret-pass-1"); await s.check("input[name=agree]"); await s.click("button:has-text('Create Account')");
  await s.waitForSelector("#rc"); const code = await s.textContent("#rc"); await s.check("#savedRc"); await s.click("#contRc"); await s.waitForSelector("text=My requests"); ok("student registration + one-time recovery code");

  // wizard
  await s.click("a:has-text('New inquiry')"); await s.click("button:has-text('PowerPoint Presentations')");
  const lvlOpts = await s.$$eval("#lv option", os => os.map(x => x.textContent)); assert.deepEqual(lvlOpts, ["Choose your level", "Elementary School", "Junior High School", "Senior High School"]); ok("UI offers only eligible levels");
  await s.selectOption("#lv", "Senior High School"); await s.fill("#ti", "Biology slides"); await s.fill("#de", "6 slides on cells"); await s.setInputFiles("#fl", "/tmp/t.pdf"); await s.click("button:has-text('Continue to review')");
  await s.waitForSelector("h1:has-text('Review your inquiry')"); await s.click("#back"); await s.waitForSelector("#ti"); assert.equal(await s.inputValue("#ti"), "Biology slides"); ok("can go back and edit; values kept");
  await s.click("button:has-text('Continue to review')"); await s.click("#next"); await s.click("#submit"); // no ack
  await s.waitForSelector("#toast.show"); assert.match(await s.textContent("#toast"), /confirmation/); await s.check("#ack"); await s.click("#submit");
  await s.waitForSelector("text=Inquiry submitted"); const ref = (await s.textContent(".kv p:nth-child(2)")).trim(); ok("4-step wizard submits with attachment");

  // direct-API college attempt from the browser session
  const r = await s.evaluate(async () => { const me = await (await fetch("/api/me")).json(); const f = new FormData(); Object.entries({ service: "PowerPoint Presentations", educationLevel: "College", title: "t", description: "d" }).forEach(([k, v]) => f.set(k, v));
    const x = await fetch("/api/inquiries", { method: "POST", body: f, headers: { "x-csrf-token": me.csrfToken } }); return x.status; }); assert.equal(r, 400); ok("direct API College request rejected");

  // owner inbox
  await o.goto(B + "/#/owner"); await o.reload(); await o.waitForSelector("text=Biology slides"); assert.match(await o.textContent(".tag"), /Submitted/); ok("inbox lists as Submitted without marking read");
  await o.click("text=Biology slides"); await o.waitForSelector("h1:has-text('Biology slides')"); assert.match(await o.textContent(".row.sb .tag"), /Read/); ok("opening a request marks it Read");
  await o.fill("#sm", "Which section is this for?"); await o.click("button[data-quick='Awaiting Response']"); await o.waitForSelector("text=Which section is this for?");
  await s.goto(`${B}/#/request/${ref}`); await s.waitForSelector("text=Which section is this for?"); await s.fill("#mg", "Section A"); await s.click("button:has-text('Send message')"); await s.waitForSelector("text=Section A"); ok("clarification round-trip");
  await o.reload(); await o.waitForSelector("h1:has-text('Biology slides')"); await o.click("button[data-quick='Accepted']"); await o.waitForFunction(() => /Accepted/.test(document.querySelector(".row.sb .tag")?.textContent || ""));
  await o.selectOption("#ss", "In Progress"); await o.click("#stForm button"); await o.waitForFunction(() => /In Progress/.test(document.querySelector(".row.sb .tag")?.textContent || ""));
  await o.setInputFiles("#df", "/tmp/done.txt"); await o.click("#delForm button"); await o.waitForSelector("text=done.txt");
  await o.selectOption("#ss", "Completed"); await o.click("#stForm button"); await o.waitForFunction(() => /Completed/.test(document.querySelector(".row.sb .tag")?.textContent || "")); ok("owner accepts, progresses, uploads deliverable, completes");

  // student download + review
  await s.goto(`${B}/#/request/${ref}`); await s.reload(); await s.waitForSelector("text=done.txt");
  const [dl] = await Promise.all([s.waitForEvent("download"), s.click("a:has-text('Download') >> nth=1")]); assert.equal(dl.suggestedFilename(), "done.txt"); ok("student downloads deliverable via authenticated Worker link (attachment)");
  await s.selectOption("#rt", "5"); await s.fill("#rcm", "Fast and clear."); await s.click("button:has-text('Submit review')"); await s.waitForSelector("text=Waiting for owner approval"); ok("review submitted (pending)");
  await o.goto(B + "/#/owner/reviews"); await o.waitForSelector("text=Fast and clear."); await o.click("button:has-text('Approve')"); await o.waitForSelector("text=Published");
  await s.goto(B + "/#/reviews"); await s.waitForSelector("text=Fast and clear."); ok("owner moderation publishes review on home");

  // payment methods
  await o.goto(B + "/#/owner/settings/payments"); await o.fill("#pmNew input[name=name]", "GCash"); await o.fill("#pmNew input[name=accountIdentifier]", "0917 000 0000"); await o.click("#pmNew button"); await o.waitForSelector("h2:has-text('GCash')");
  await o.fill("#pmNew input[name=name]", "Maya"); await o.uncheck("#pmNew input[name=enabled]"); await o.click("#pmNew button"); await o.waitForSelector("h2:has-text('Maya')");
  fs.writeFileSync("/tmp/qr.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  await o.setInputFiles("form.pm >> nth=0 >> .qrf", "/tmp/qr.png"); await o.click("form.pm >> nth=0 >> [data-qr]"); await o.waitForSelector("form.pm >> nth=0 >> img.qr");
  await s.goto(B + "/#/support"); await s.waitForSelector("h3:has-text('GCash')"); assert.equal(await s.locator("h3:has-text('Maya')").count(), 0); await s.waitForFunction(() => document.querySelector("img.qr")?.naturalWidth > 0); ok("payment methods CRUD + QR; only enabled shown to student");
  await s.fill("#rm", "Thanks Zein!"); await s.click("#rcForm button"); await s.waitForSelector("#toast.show"); await o.goto(B + "/#/owner/receipts"); await o.waitForSelector("text=Thanks Zein!"); ok("optional thank-you submitted and visible to owner");

  // discord
  await o.goto(B + "/#/owner/settings/integrations"); await o.waitForSelector("text=configured (stored as a Cloudflare Worker secret)");
  assert.equal((await o.content()).includes("discord.com/api/webhooks"), false); await o.fill("#did", "111222333444555666"); await o.check("input[name=enabled]"); await o.click("#dcForm button[type=submit]"); await o.waitForSelector("#toast.show");
  await o.waitForTimeout(300); await o.click("#dcTest"); await o.waitForTimeout(500);
  const calls = await (await fetch(B + "/__discord")).json(); assert.ok(calls.length >= 1); assert.deepEqual(calls.at(-1).allowed_mentions.users, ["111222333444555666"]); ok("discord settings + test; webhook URL never in page");

  // owner-assisted recovery via UI
  await o.goto(B + "/#/owner/students"); await o.fill("#stq", "mika"); await o.click("#stSearch button"); await o.waitForSelector("button[data-gen]"); o.once("dialog", d => d.accept()); await o.click("button[data-gen]");
  await o.waitForSelector(".passout .code"); const pass = await o.textContent(".passout .code");
  const { p: s2 } = await mk({ viewport: { width: 390, height: 800 } }); await s2.goto(B + "/#/recover"); await s2.click("button[data-mode=pass]"); await s2.fill("#ru", "mika_s"); await s2.fill("#rc", pass); await s2.click("#recForm button");
  await s2.waitForSelector("#np"); await s2.fill("#np", "new-secret-pass-2"); await s2.fill("#np2", "new-secret-pass-2"); await s2.click("#rsForm button"); await s2.waitForSelector("#rc"); const newCode = await s2.textContent("#rc"); assert.notEqual(newCode, code);
  await s.goto(B + "/#/portal"); await s.reload(); await s.waitForSelector("a:has-text('Sign In')"); ok("owner-assisted recovery in UI: reset, new code, old session revoked");
  await s2.check("#savedRc"); await s2.click("#contRc"); await s2.fill("#u", "mika_s"); await s2.fill("#p", "new-secret-pass-2"); await s2.click("form#authForm button"); await s2.waitForSelector("text=My requests"); ok("sign in with new password");

  // logout
  await s2.click("#logoutBtn"); await s2.waitForSelector("a:has-text('Sign In')"); ok("logout");
  await browser.close();
  const bad = errs.filter(e => !/Failed to load resource.*(401|404|403|400|409|410)/.test(e));
  console.log(`\n${pass} browser checks passed`); if (bad.length) { console.log("Console issues:\n" + bad.join("\n")); process.exit(1); } else console.log("No console errors / CSP violations");
})().catch(e => { console.error("E2E FAILED:", e.message.split("\n").slice(0, 6).join("\n")); process.exit(1); });
