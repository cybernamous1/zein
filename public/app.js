"use strict";
/* Zein E-Services front end — hash-routed, no framework. CSP forbids inline styles/scripts, so none are used. */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const app = $("#app");
const S = { user: null, csrf: "", config: null, resetToken: "", wizard: null, oneTime: null };
const fmtDate = d => d ? new Date(d).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—";
const fmtTime = d => d ? new Date(d).toLocaleString() : "—";
const slug = s => String(s).replace(/\s+/g, "-");
const bytesFmt = n => n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";

let toastTimer;
function toast(msg, bad = false) {
  const t = $("#toast"); t.textContent = msg; t.className = "toast show" + (bad ? " bad" : "");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 4200);
}
async function api(path, { method = "GET", body, form } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (S.csrf && method !== "GET") headers["x-csrf-token"] = S.csrf;
  const res = await fetch(path, { method, headers, body: form || (body !== undefined ? JSON.stringify(body) : undefined), credentials: "same-origin" });
  const data = await res.json().catch(() => ({}));
  if (data.csrfToken) S.csrf = data.csrfToken;
  if (!res.ok) { const e = new Error(data.error || "Something went wrong. Please try again."); e.status = res.status; throw e; }
  return data;
}
/** Run a button/form action with a loading state and error toast. */
async function busy(btn, fn) {
  const label = btn && btn.innerHTML; if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner" aria-hidden="true"></span> Please wait…'; }
  try { return await fn(); } catch (e) { toast(e.message, true); if (e.status === 401) { S.user = null; renderAccount(); } }
  finally { if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = label; } }
}
const go = h => { location.hash = h; };

function renderAccount() {
  const a = $("#accountArea");
  a.innerHTML = S.user
    ? `<a class="btn mint small" href="#/${S.user.role === "owner" ? "owner" : "portal"}">${S.user.role === "owner" ? "Owner Dashboard" : "My Portal"}</a>
       <a class="btn outline small" href="#/account">Account</a><button class="btn outline small" id="logoutBtn" type="button">Sign Out</button>`
    : `<a class="btn outline small" href="#/login">Sign In</a><a class="btn primary small" href="#/register">Create Account</a>`;
  $("#logoutBtn")?.addEventListener("click", async e => busy(e.target, async () => {
    await api("/api/auth/logout", { method: "POST" }); S.user = null; S.csrf = ""; renderAccount(); toast("You have signed out."); go("#/");
  }));
}

// ---------------- static content ----------------
const SERVICE_INFO = {
  "School Assignments & Activities": ["A", "Help with basic school assignments and simple school activities."],
  "Research Proposal, Topics & Outlines": ["R", "Topic ideas, titles, outlines, agendas and proposal preparation at an appropriate level."],
  "PowerPoint Presentations": ["P", "Clear, well-organized slide decks built from your instructions."],
  "Document Formatting": ["F", "Margins, fonts, headings, page numbers and citation layout."],
  "Typing & Encoding": ["T", "Typing handwritten or printed content into a clean document."],
  "Document Organization": ["O", "Sorting, merging and tidying your files and documents."],
  "Other Simple Task": ["+", "Other simple educational or digital tasks within what Zein can handle."],
};
const FAQ = [
  ["Who can send a request?", "Students at the Elementary, Junior High School and Senior High School levels. Requests for college, university, undergraduate, postgraduate, master's or doctoral work are not accepted."],
  ["Is it free?", "Sending an inquiry and getting an initial assessment is free. Contributions are completely voluntary: there is no minimum, no deadline, and no priority or special treatment for contributing. The owner may decline unpaid work when the workload or effort is too high."],
  ["Does submitting guarantee acceptance?", "No. Every request is reviewed first. You will see its status change as it is read, reviewed, accepted, declined or completed."],
  ["How early should I submit?", "Please submit 2 to 4 days before your own deadline. Rush requests may be declined."],
  ["How long does a task take?", "Usually within two business days after a request is accepted and complete instructions and materials are received. Larger tasks may take longer, and this will be explained before acceptance. This is an estimate, not a guarantee."],
  ["What will you not do?", "Video editing, photo manipulation, complex graphic design, advanced statistical analysis, programming projects and complex research projects. Zein also does not support plagiarism, fabricated research or misrepresentation."],
  ["Do I need my real name?", "No. You only need a username and password. Display name and email are optional."],
  ["I forgot my password.", "On the Sign In page choose “Forgot password”. You can use your personal recovery code, or ask the owner for a temporary passcode that is valid for 24 hours."],
  ["Are my files private?", "Yes. Files are stored privately and only you and the owner can open them. Files are removed after a retention period; see the Privacy page."],
  ["Can I guarantee my grade?", "No. Outputs follow your instructions and common Philippine school conventions where reasonably possible, but you must check them against your school's requirements. No grades or academic results are guaranteed."],
];
const TERMS = `
<h2>1. About this service</h2><p>Zein E-Services is an independent small online service provider. It is not a school, tutoring institution or educational organization. It helps students with simple school-related and digital tasks.</p>
<h2>2. Who may use it</h2><p>Requests are accepted for Elementary School, Junior High School and Senior High School levels only. College, university, undergraduate, postgraduate, master's and doctoral requests are declined.</p>
<h2>3. Requests and acceptance</h2><ul><li>Sending an inquiry and the initial assessment are free.</li><li>Submitting an inquiry does not mean it is accepted. Zein may accept or decline any request, including when it is outside Zein's capabilities, a rush request, or requires more effort than can reasonably be given.</li><li>Please submit 2–4 days before your deadline.</li><li>Expected completion is within two business days after acceptance and receipt of complete instructions and materials. Demanding tasks may take longer, and this will be communicated before acceptance.</li></ul>
<h2>4. Voluntary contributions</h2><p>Contributions are optional. There is no minimum amount, payment deadline, paid priority or donor-only benefit, and contributing does not change whether or when a request is accepted. Zein does not process payments on this website and does not verify transfers automatically.</p>
<h2>5. Your responsibilities</h2><ul><li>Provide accurate instructions and materials, and only content you are allowed to share.</li><li>Review the finished work for accuracy, completeness and compliance with your school's rules before you submit it.</li><li>Do not request plagiarism, fabricated research or anything that misrepresents who did the work.</li><li>Do not upload passwords, ID numbers or other unnecessary sensitive information.</li><li>Keep your password and recovery code private.</li></ul>
<h2>6. What Zein does and does not promise</h2><p>Zein will make a reasonable effort to follow your instructions and common Philippine educational conventions where possible. Zein does not guarantee grades, approvals, research outcomes or other academic results. Nothing in these terms limits any rights you have under applicable law.</p>
<h2>7. Reviews</h2><p>Only students with a completed request can leave one review for it. Reviews should describe service quality, communication and timeliness, not grades. Reviews are checked by the owner before they appear.</p>
<h2>8. Accounts and changes</h2><p>Zein may suspend accounts that misuse the service. These terms may be updated; the version on this page applies.</p>`;
const PRIVACY = `
<h2>What we collect</h2><ul><li>Account: username, password (stored only as a salted hash), optional display name and email, and a recovery code (stored only as a hash).</li><li>Requests: the details, dates, messages and files you submit, and status history.</li><li>Optional contribution receipts and thank-you messages you choose to send.</li><li>Security records such as sign-in failures and password-recovery events (no passwords or codes).</li></ul>
<h2>How we use it</h2><p>Only to run the service: assessing and completing your requests, keeping your account secure, and contacting you about your request inside this website. We do not sell your data, show ads or use third-party analytics.</p>
<h2>Who can see it</h2><p>You and the owner. The owner can see your requests, files and messages but cannot see your password or recovery code. The owner may receive short notifications (reference, service, username, level, status) in a private Discord server; these never include passwords, recovery codes or attachments.</p>
<h2>Files and retention</h2><ul><li>Files are stored privately and downloaded only through your signed-in account.</li><li>Deliverables are removed about 7 days after your first download, or after 30 days at the latest. Your submitted files are removed about 30 days after a request is completed, declined or cancelled. Contribution receipts are removed after about 60 days.</li><li>Basic request history (dates, status, messages) is kept after files are removed.</li></ul>
<h2>Your choices</h2><p>You can edit your display name and email, change your password, and sign out everywhere from your account page. To ask for your account or data to be deleted, contact the owner using the details on the Contact page.</p>
<h2>Cookies</h2><p>One secure, HttpOnly cookie keeps you signed in for up to 365 days unless you sign out.</p>`;

// ---------------- views ----------------
function homeView(scrollTo) {
  const svc = S.config.services.map(n => `<article class="card"><div class="icon" aria-hidden="true">${SERVICE_INFO[n]?.[0] || "•"}</div><h3>${esc(n)}</h3><p>${esc(SERVICE_INFO[n]?.[1] || "")}</p><button class="btn small outline" data-start="${esc(n)}" type="button">Request this</button></article>`).join("");
  app.innerHTML = `
  <section class="hero"><div class="hero-in"><div>
    <span class="eyebrow">Independent online service for students</span>
    <h1>Your tasks,<br><em>made easier.</em></h1>
    <p>Help with school documents, presentations and research preparation — with a clear process from inquiry to delivery.</p>
    <div class="actions"><a class="btn amber" href="#/inquiry">Submit an Inquiry</a><a class="btn outline hero-btn" href="#/how">How It Works</a></div>
    <p class="fine">For Elementary, Junior High School and Senior High School students only. Every request is reviewed first; no grades or outcomes are guaranteed.</p></div>
    <aside class="hero-card" aria-label="Process"><ol><li><span>1</span>Pick a service</li><li><span>2</span>Share the details</li><li><span>3</span>Review &amp; submit</li><li><span>4</span>Track &amp; download</li></ol></aside></div></section>
  <section class="sec" id="services"><div class="sec-in"><span class="eyebrow">What we can help with</span><h2>Available services</h2><div class="grid">${svc}</div>
    <div class="notice">Not accepted: video editing, photo manipulation, complex graphic design, advanced statistical analysis, programming projects and complex research projects.</div></div></section>
  <section class="sec alt" id="eligibility"><div class="sec-in"><span class="eyebrow">Eligibility</span><h2>Who we can help</h2>
    <div class="grid"><div class="card"><h3>Elementary School</h3><p>Accepted.</p></div><div class="card"><h3>Junior High School</h3><p>Accepted.</p></div><div class="card"><h3>Senior High School</h3><p>Accepted.</p></div></div>
    <div class="notice bad">College, university, undergraduate, postgraduate, master's and doctoral requests are not accepted.</div></div></section>
  <section class="sec" id="how"><div class="sec-in"><span class="eyebrow">A straightforward process</span><h2>How it works</h2>
    <div class="steps"><div class="card"><h3>Select a service</h3><p>Choose what fits your task.</p></div><div class="card"><h3>Provide details</h3><p>Describe the task, deadline and attach any files.</p></div><div class="card"><h3>Review</h3><p>Check everything before sending.</p></div><div class="card"><h3>Submit &amp; track</h3><p>Follow the status and download finished files in your portal.</p></div></div>
    <div class="notice">Please submit 2–4 days before your deadline. Expected completion is within two business days after acceptance and receipt of complete instructions and materials; larger tasks may take longer and rush requests may be declined.</div></div></section>
  <section class="sec alt" id="why"><div class="sec-in"><span class="eyebrow">Why choose Zein</span><h2>Simple, clear and respectful</h2>
    <div class="grid"><div class="card"><h3>Free inquiries</h3><p>Asking and getting an assessment costs nothing.</p></div><div class="card"><h3>Private by design</h3><p>Use a nickname. Files are only visible to you and the owner.</p></div><div class="card"><h3>Clear tracking</h3><p>See each status change and message in one place.</p></div><div class="card"><h3>Voluntary support</h3><p>Contributions are optional and never change how your request is handled.</p></div></div></div></section>
  <section class="sec" id="reviews"><div class="sec-in"><span class="eyebrow">Genuine feedback</span><h2>Reviews</h2><div id="reviewList" class="grid"><p class="fine">Loading reviews…</p></div>
    <p class="fine">Only students with completed requests can review, and each review is approved by the owner before it appears.</p></div></section>
  <section class="sec alt" id="faq"><div class="sec-in mid"><span class="eyebrow">FAQ</span><h2>Frequently asked questions</h2>${faqHtml()}</div></section>
  <section class="sec"><div class="sec-in"><div class="cta"><div><h2>Ready to get started?</h2><p>Create an account to submit and track your inquiry.</p></div><a class="btn amber" href="#/inquiry">Submit an Inquiry</a></div></div></section>`;
  api("/api/reviews").then(r => {
    $("#reviewList").innerHTML = r.reviews.length ? r.reviews.map(x => `<article class="review"><div class="stars" aria-label="${x.rating} out of 5 stars">${"★".repeat(x.rating)}${"☆".repeat(5 - x.rating)}</div><b>${esc(x.service)}</b><p>${esc(x.comment || "Verified completed request.")}</p></article>`).join("") : '<p class="fine">No reviews yet — they will appear here after completed requests are reviewed.</p>';
  }).catch(() => { $("#reviewList").innerHTML = '<p class="fine">Reviews are unavailable right now.</p>'; });
  if (scrollTo) setTimeout(() => $("#" + scrollTo)?.scrollIntoView(), 30);
}
const faqHtml = () => FAQ.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join("");
const page = (title, inner, cls = "wrap mid") => { app.innerHTML = `<div class="${cls}"><h1>${esc(title)}</h1>${inner}</div>`; };

function contactView() {
  const email = S.config.contactEmail;
  page("Contact", `<div class="panel"><p>${email ? `Email: <a href="mailto:${esc(email)}">${esc(email)}</a>` : "Questions about a request? Sign in and send a message from that request's page — that is the fastest way to reach the owner."}</p>
  <p>To start a new task, use <a href="#/inquiry">Submit an Inquiry</a>. Please do not send passwords or ID numbers.</p><p class="fine">Zein E-Services is an independent provider and not a school or tutoring institution.</p></div>`);
}

// ----- auth -----
function showRecovery(code, title, next) {
  S.oneTime = null;
  app.innerHTML = `<div class="wrap narrow"><div class="panel"><h1>${esc(title)}</h1><p>This is your <b>personal recovery code</b>. It lets you reset your password if you forget it. <b>It is shown only once</b> — Zein cannot show it again.</p>
  <div class="code" id="rc">${esc(code)}</div><div class="row"><button class="btn outline small" id="copyRc" type="button">Copy code</button><button class="btn outline small" id="dlRc" type="button">Save as text file</button></div>
  <p class="fine">Store it somewhere safe, like a screenshot or notes app. Do not share it.</p>
  <div class="f"><label><input type="checkbox" id="savedRc"> I have saved my recovery code</label></div><button class="btn primary block" id="contRc" type="button" disabled>${esc(next.label)}</button></div></div>`;
  $("#savedRc").onchange = e => { $("#contRc").disabled = !e.target.checked; };
  $("#copyRc").onclick = async () => { try { await navigator.clipboard.writeText(code); toast("Copied."); } catch { toast("Select the code and copy it manually.", true); } };
  $("#dlRc").onclick = () => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([`Zein E-Services recovery code\n${code}\nKeep this private.\n`], { type: "text/plain" })); a.download = "zein-recovery-code.txt"; a.click(); URL.revokeObjectURL(a.href); };
  $("#contRc").onclick = () => go(next.hash);
}
function authView(mode) {
  const reg = mode === "register";
  page(reg ? "Create your account" : "Sign in", `<div class="panel"><form id="authForm" novalidate>
    <div class="f"><label for="u">Username *</label><input id="u" name="username" autocomplete="username" required minlength="3" maxlength="32" pattern="[A-Za-z0-9_.\\-]+" autocapitalize="none"><small class="hint">${reg ? "3–32 letters, numbers, dot, dash or underscore. A nickname is fine — no real name needed." : ""}</small></div>
    ${reg ? `<div class="f"><label for="dn">Display name (optional)</label><input id="dn" name="displayName" maxlength="60" autocomplete="nickname"></div><div class="f"><label for="em">Email (optional)</label><input id="em" name="email" type="email" maxlength="254" autocomplete="email"><small class="hint">Only for your own reference. Zein does not send emails.</small></div>` : ""}
    <div class="f"><label for="p">Password *</label><input id="p" name="password" type="password" required minlength="10" maxlength="128" autocomplete="${reg ? "new-password" : "current-password"}"><small class="hint">${reg ? "At least 10 characters." : ""}</small></div>
    ${reg ? `<div class="f"><label for="p2">Confirm password *</label><input id="p2" name="password2" type="password" required autocomplete="new-password"></div><div class="f"><label><input type="checkbox" name="agree" required> I agree to the <a href="#/terms">Terms</a> and <a href="#/privacy">Privacy</a> policy and I am an Elementary, Junior High or Senior High School student.</label></div>` : ""}
    <button class="btn primary block" type="submit">${reg ? "Create Account" : "Sign In"}</button></form>
    <p class="fine">${reg ? 'Already registered? <a href="#/login">Sign in</a>' : 'New here? <a href="#/register">Create an account</a> · <a href="#/recover">Forgot password?</a>'}</p></div>`, "wrap narrow");
  $("#authForm").onsubmit = async e => {
    e.preventDefault(); const f = e.target; if (!f.reportValidity()) return;
    const d = Object.fromEntries(new FormData(f));
    if (reg && d.password !== d.password2) return toast("Passwords do not match.", true);
    await busy(f.querySelector("button"), async () => {
      const r = await api(reg ? "/api/auth/register" : "/api/auth/login", { method: "POST", body: { username: d.username, password: d.password, displayName: d.displayName, email: d.email } });
      S.user = r.user; renderAccount();
      if (reg) showRecovery(r.recoveryCode, "Account created", { label: "Continue to my portal", hash: "#/portal" });
      else go(S.user.role === "owner" ? "#/owner" : (S.after || "#/portal")), S.after = "";
    });
  };
}
function ownerSetupView() {
  page("Owner setup", `<div class="panel"><p class="fine">One-time setup for the site owner. Requires the owner username and the OWNER_SETUP_SECRET configured in Cloudflare.</p><form id="osForm">
    <div class="f"><label for="ou">Owner username</label><input id="ou" name="username" required autocapitalize="none"></div>
    <div class="f"><label for="op">Password (10+ characters)</label><input id="op" name="password" type="password" minlength="10" required autocomplete="new-password"></div>
    <div class="f"><label for="os">Owner setup secret</label><input id="os" name="setupSecret" type="password" required autocomplete="off"></div>
    <button class="btn primary block" type="submit">Create owner account</button></form></div>`, "wrap narrow");
  $("#osForm").onsubmit = async e => { e.preventDefault(); const d = Object.fromEntries(new FormData(e.target));
    await busy(e.target.querySelector("button"), async () => { const r = await api("/api/owner/setup", { method: "POST", body: d }); S.user = r.user; renderAccount(); showRecovery(r.recoveryCode, "Owner account created", { label: "Open owner dashboard", hash: "#/owner" }); }); };
}
function recoverView() {
  page("Reset your password", `<div class="panel"><div class="tabs" role="tablist"><button type="button" class="on" data-mode="code">I have my recovery code</button><button type="button" data-mode="pass">Owner gave me a passcode</button></div>
  <form id="recForm"><div class="f"><label for="ru">Username</label><input id="ru" name="username" required autocapitalize="none" autocomplete="username"></div>
  <div class="f"><label for="rc" id="rcLabel">Recovery code</label><input id="rc" name="secret" required autocomplete="off" autocapitalize="characters" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX"><small class="hint" id="rcHint">The code you saved when you created your account.</small></div>
  <button class="btn primary block" type="submit">Continue</button></form>
  <p class="fine">Lost both? Contact the owner and ask for a temporary reset passcode (valid for 24 hours, single use).</p></div>`, "wrap narrow");
  let mode = "code";
  $$(".tabs button").forEach(b => b.onclick = () => { mode = b.dataset.mode; $$(".tabs button").forEach(x => x.classList.toggle("on", x === b));
    $("#rcLabel").textContent = mode === "code" ? "Recovery code" : "Temporary passcode"; $("#rc").placeholder = mode === "code" ? "XXXX-XXXX-XXXX-XXXX-XXXX" : "XXXX-XXXX-XXXX";
    $("#rcHint").textContent = mode === "code" ? "The code you saved when you created your account." : "The passcode the owner gave you. It expires 24 hours after it was created."; });
  $("#recForm").onsubmit = async e => { e.preventDefault(); const d = Object.fromEntries(new FormData(e.target));
    await busy(e.target.querySelector("button"), async () => {
      const r = await api(mode === "code" ? "/api/auth/recover" : "/api/auth/recover-passcode", { method: "POST", body: mode === "code" ? { username: d.username, code: d.secret } : { username: d.username, passcode: d.secret } });
      S.resetToken = r.resetToken; go("#/reset"); }); };
}
function resetView() {
  if (!S.resetToken) return go("#/recover");
  page("Choose a new password", `<div class="panel"><form id="rsForm"><div class="f"><label for="np">New password (10+ characters)</label><input id="np" name="p1" type="password" minlength="10" maxlength="128" required autocomplete="new-password"></div>
  <div class="f"><label for="np2">Confirm new password</label><input id="np2" name="p2" type="password" required autocomplete="new-password"></div>
  <p class="fine">After this, your old recovery code stops working, you get a new one, and all devices are signed out.</p><button class="btn primary block" type="submit">Set new password</button></form></div>`, "wrap narrow");
  $("#rsForm").onsubmit = async e => { e.preventDefault(); const d = Object.fromEntries(new FormData(e.target)); if (d.p1 !== d.p2) return toast("Passwords do not match.", true);
    await busy(e.target.querySelector("button"), async () => { const r = await api("/api/auth/reset", { method: "POST", body: { resetToken: S.resetToken, newPassword: d.p1 } });
      S.resetToken = ""; S.user = null; S.csrf = ""; renderAccount(); showRecovery(r.recoveryCode, "Password updated", { label: "Go to Sign In", hash: "#/login" }); }); };
}

// ----- student: inquiry wizard -----
const newWizard = () => ({ step: 1, service: "", educationLevel: "", title: "", description: "", deadline: "", preferredDate: "", notes: "", contactDetails: "", files: [], ack: false, done: null });
function checkFilesClient(files) {
  const lim = S.config.limits, ok = /\.(pdf|doc|docx|pptx|txt|jpe?g|png)$/i;
  if (files.length > lim.files) return `You can attach at most ${lim.files} files.`;
  let total = 0; for (const f of files) { total += f.size; if (!ok.test(f.name)) return `"${f.name}" is not an allowed type (PDF, DOC, DOCX, PPTX, TXT, JPG, PNG).`; if (f.size > lim.fileBytes) return `"${f.name}" is larger than ${bytesFmt(lim.fileBytes)}.`; if (!f.size) return `"${f.name}" is empty.`; }
  return total > lim.totalBytes ? `Total size must be under ${bytesFmt(lim.totalBytes)}.` : "";
}
function wizardView() {
  const w = S.wizard || (S.wizard = newWizard());
  const names = ["Select Service", "Provide Details", "Review", "Submit"];
  const prog = `<ol class="progress" aria-label="Progress">${names.map((n, i) => `<li class="${i + 1 <= w.step ? "on" : ""}" ${i + 1 === w.step ? 'aria-current="step"' : ""}>${i + 1}. ${n}</li>`).join("")}</ol>`;
  let body = "";
  if (w.step === 1) body = `<h1>Select a service</h1><div class="grid">${S.config.services.map(n => `<button type="button" class="card pick ${w.service === n ? "sel" : ""}" data-svc="${esc(n)}"><h3>${esc(n)}</h3><p>${esc(SERVICE_INFO[n]?.[1] || "")}</p></button>`).join("")}</div>`;
  if (w.step === 2) body = `<h1>Provide details</h1><p class="fine">Service: <b>${esc(w.service)}</b></p><form id="dForm" novalidate>
    <div class="f"><label for="lv">Educational level *</label><select id="lv" name="educationLevel" required><option value="">Choose your level</option>${S.config.levels.map(l => `<option ${w.educationLevel === l ? "selected" : ""}>${esc(l)}</option>`).join("")}</select><small class="hint">Only Elementary, Junior High School and Senior High School requests are accepted.</small></div>
    <div class="f"><label for="ti">Request title *</label><input id="ti" name="title" required maxlength="160" value="${esc(w.title)}"></div>
    <div class="f"><label for="de">Description and instructions *</label><textarea id="de" name="description" required maxlength="4000">${esc(w.description)}</textarea></div>
    <div class="f"><label for="dl">Intended deadline (optional)</label><input id="dl" type="date" name="deadline" value="${esc(w.deadline)}"><small class="hint">Please submit 2–4 days before your deadline.</small></div>
    <div class="f"><label for="pd">Preferred completion date (optional)</label><input id="pd" type="date" name="preferredDate" value="${esc(w.preferredDate)}"></div>
    <div class="f"><label for="fl">Attachments (optional)</label><input id="fl" type="file" multiple accept=".pdf,.doc,.docx,.pptx,.txt,.jpg,.jpeg,.png"><small class="hint">Up to ${S.config.limits.files} files, ${bytesFmt(S.config.limits.fileBytes)} each, ${bytesFmt(S.config.limits.totalBytes)} total. PDF, DOC, DOCX, PPTX, TXT, JPG, PNG.${w.files.length ? ` Currently selected: ${esc(w.files.map(f => f.name).join(", "))}` : ""}</small></div>
    <div class="f"><label for="no">Additional notes (optional)</label><textarea id="no" name="notes" maxlength="1500">${esc(w.notes)}</textarea></div>
    <div class="f"><label for="cd">Contact details (optional)</label><input id="cd" name="contactDetails" maxlength="200" value="${esc(w.contactDetails)}"><small class="hint">Only if you want to be reached outside this website. Never enter passwords or ID numbers.</small></div>
    <div class="row sb"><button type="button" class="btn outline" id="back">← Back</button><button class="btn primary" type="submit">Continue to review →</button></div></form>`;
  if (w.step === 3) body = `<h1>Review your inquiry</h1><div class="kv"><p><b>Service</b></p><p>${esc(w.service)}</p><p><b>Educational level</b></p><p>${esc(w.educationLevel)}</p><p><b>Title</b></p><p>${esc(w.title)}</p><p><b>Description</b></p><p>${esc(w.description).replace(/\n/g, "<br>")}</p>
    <p><b>Deadline</b></p><p>${esc(w.deadline || "Not specified")}</p><p><b>Preferred completion date</b></p><p>${esc(w.preferredDate || "Not specified")}</p><p><b>Notes</b></p><p>${esc(w.notes || "None")}</p><p><b>Contact details</b></p><p>${esc(w.contactDetails || "None")}</p><p><b>Attachments</b></p><p>${w.files.length ? esc(w.files.map(f => `${f.name} (${bytesFmt(f.size)})`).join(", ")) : "None"}</p></div>
    <div class="row sb"><button type="button" class="btn outline" id="back">← Edit details</button><button type="button" class="btn primary" id="next">Continue →</button></div>`;
  if (w.step === 4 && !w.done) body = `<h1>Submit your inquiry</h1><div class="notice">Submitting is not the same as acceptance. Your request will be assessed and you will see updates in your portal. No grades or academic outcomes are guaranteed.</div>
    <div class="f"><label><input type="checkbox" id="ack" ${w.ack ? "checked" : ""}> I will check the finished work against my school's requirements, and this request is not for plagiarism, fabricated research or misrepresentation.</label></div>
    <div class="row sb"><button type="button" class="btn outline" id="back">← Back</button><button type="button" class="btn primary" id="submit">Submit inquiry</button></div>`;
  if (w.step === 4 && w.done) body = `<div class="center"><h1>Inquiry submitted ✓</h1><p>Your request has been received and is waiting to be read.</p><div class="kv"><p><b>Reference</b></p><p>${esc(w.done)}</p></div>
    <div class="actions"><a class="btn primary" href="#/request/${esc(w.done)}">View request</a><a class="btn outline" href="#/portal">My portal</a></div></div>`;
  app.innerHTML = `<div class="wrap mid"><div class="panel">${prog}${body}</div></div>`;
  $$("[data-svc]").forEach(b => b.onclick = () => { w.service = b.dataset.svc; w.step = 2; wizardView(); });
  $("#back")?.addEventListener("click", () => { w.step = Math.max(1, w.step - 1); wizardView(); });
  $("#next")?.addEventListener("click", () => { w.step = 4; wizardView(); });
  $("#fl")?.addEventListener("change", e => { const f = [...e.target.files], err = checkFilesClient(f); if (err) { e.target.value = ""; return toast(err, true); } w.files = f; });
  $("#dForm")?.addEventListener("submit", e => { e.preventDefault(); const f = e.target; if (!f.reportValidity()) return; Object.assign(w, Object.fromEntries(new FormData(f)));
    w.files = [...($("#fl").files.length ? $("#fl").files : w.files)]; const err = checkFilesClient(w.files); if (err) return toast(err, true);
    if (!S.config.levels.includes(w.educationLevel)) return toast("Choose an eligible level.", true); w.step = 3; wizardView(); });
  $("#ack")?.addEventListener("change", e => { w.ack = e.target.checked; });
  $("#submit")?.addEventListener("click", async e => { if (!w.ack) return toast("Please tick the confirmation box first.", true);
    await busy(e.target, async () => { const fd = new FormData(); for (const k of ["service", "educationLevel", "title", "description", "deadline", "preferredDate", "notes", "contactDetails"]) fd.set(k, w[k]); w.files.forEach(f => fd.append("files", f));
      const r = await api("/api/inquiries", { method: "POST", form: fd }); w.done = r.inquiryId; wizardView(); window.scrollTo(0, 0); }); });
}

// ----- student portal / request page / support / account -----
async function portalView() {
  const r = await api("/api/inquiries");
  app.innerHTML = `<div class="wrap"><div class="row sb"><div><span class="eyebrow">Student portal</span><h1>My requests</h1></div><div class="row"><a class="btn primary" href="#/inquiry" data-new>＋ New inquiry</a><a class="btn outline" href="#/support">Optional support</a></div></div>
  <div class="list">${r.inquiries.length ? r.inquiries.map(i => `<a class="item" href="#/request/${i.id}"><div><h3>${esc(i.title)}</h3><p>${esc(i.service)} · ${esc(i.education_level)} · ${fmtDate(i.created_at)}</p>${i.student_message ? `<p>Owner: ${esc(i.student_message.slice(0, 90))}</p>` : ""}</div><span class="tag ${slug(i.status)}">${esc(i.status)}</span></a>`).join("") : '<div class="panel">No requests yet. <a href="#/inquiry">Submit your first inquiry</a>.</div>'}</div></div>`;
  $("[data-new]")?.addEventListener("click", () => { S.wizard = newWizard(); });
}
const timeline = evs => `<div class="timeline">${evs.map(e => `<div><p><b>${esc(e.event_type.replace(/([A-Z])/g, " $1").trim())}</b>${e.message ? ` — ${esc(e.message)}` : ""}</p><small>${fmtTime(e.created_at)}</small></div>`).join("") || "<p class='fine'>No activity yet.</p>"}</div>`;
async function requestView(id) {
  const d = await api(`/api/inquiries/${encodeURIComponent(id)}`), i = d.inquiry, owner = S.user.role === "owner";
  const dl = f => `/api/inquiries/${i.id}/files/${f.id}/download`;
  const fileRow = f => f.expired ? `<p>${esc(f.name)} <span class="fine">(removed after retention period)</span></p>` :
    `<div class="row">${owner && /^image\//.test(f.type) ? `<a href="${dl(f)}?inline=1" target="_blank" rel="noopener"><img class="thumb" alt="Preview of ${esc(f.name)}" src="${dl(f)}?inline=1"></a>` : ""}<span>${esc(f.name)} <span class="fine">· ${bytesFmt(f.size)}</span></span><a class="btn small outline" href="${dl(f)}">Download</a></div>`;
  const incoming = d.files.filter(f => f.kind === "incoming"), deliv = d.files.filter(f => f.kind === "deliverable");
  const next = owner ? (S.config.transitions[i.status] || []) : [];
  const open = ["Submitted", "Read", "Under Review", "Awaiting Response"].includes(i.status);
  app.innerHTML = `<div class="wrap mid"><a href="#/${owner ? "owner" : "portal"}">← Back</a>
  <div class="row sb"><h1>${esc(i.title)}</h1><span class="tag ${slug(i.status)}">${esc(i.status)}</span></div>
  <div class="panel"><div class="kv"><p><b>Reference</b></p><p>${esc(i.id)}</p>${owner ? `<p><b>Student</b></p><p>${esc(i.student.username)}${i.student.displayName ? ` (${esc(i.student.displayName)})` : ""}</p>` : ""}<p><b>Service</b></p><p>${esc(i.service)}</p><p><b>Educational level</b></p><p>${esc(i.education_level)}</p>
  <p><b>Description</b></p><p>${esc(i.description).replace(/\n/g, "<br>")}</p><p><b>Deadline / preferred date</b></p><p>${esc(i.deadline || "—")} / ${esc(i.preferred_date || "—")}</p>
  ${i.extra_notes ? `<p><b>Notes</b></p><p>${esc(i.extra_notes)}</p>` : ""}${i.contact_details ? `<p><b>Contact details</b></p><p>${esc(i.contact_details)}</p>` : ""}<p><b>Expected completion</b></p><p>${esc(i.expected_completion || "Not set yet")}</p></div>
  <h2>Files you sent</h2>${incoming.map(fileRow).join("") || "<p class='fine'>No files attached.</p>"}
  <h2>Completed files</h2>${deliv.map(fileRow).join("") || "<p class='fine'>Nothing delivered yet.</p>"}${!owner && deliv.some(f => !f.expired) ? '<p class="fine">Please download and check your files soon — completed files are removed about 7 days after the first download.</p>' : ""}
  ${!owner && open ? `<form id="addFiles" class="f"><label for="af">Add more files</label><input id="af" type="file" multiple accept=".pdf,.doc,.docx,.pptx,.txt,.jpg,.jpeg,.png"><button class="btn small outline" type="submit">Upload</button></form>` : ""}</div>
  <div class="panel"><h2>Messages &amp; activity</h2>${timeline(d.events)}
  ${i.status !== "Completed" && !["Declined", "Cancelled"].includes(i.status) || owner ? `<form id="msgForm"><div class="f"><label for="mg">${owner ? "Message to student (visible to them)" : "Send more information or reply"}</label><textarea id="mg" name="message" maxlength="1000"></textarea></div><button class="btn small primary" type="submit">Send message</button></form>` : ""}</div>
  ${owner ? ownerControls(i, next, deliv) : studentActions(i, d)}</div>`;
  bindRequest(i, d, owner);
}
const ownerControls = (i, next, deliv) => `<div class="panel"><h2>Owner controls</h2>
  <div class="row"><button class="btn mint small" data-quick="Accepted" ${next.includes("Accepted") ? "" : "disabled"}>Accept</button><button class="btn danger small" data-quick="Declined" ${next.includes("Declined") ? "" : "disabled"}>Decline</button><button class="btn amber small" data-quick="Awaiting Response" ${next.includes("Awaiting Response") ? "" : "disabled"}>Ask for clarification</button></div>
  <form id="stForm"><div class="f"><label for="ss">Status</label><select id="ss" name="status"><option value="">Keep “${esc(i.status)}”</option>${next.map(s => `<option>${esc(s)}</option>`).join("")}</select></div>
  <div class="f"><label for="ec">Expected completion date</label><input id="ec" type="date" name="expectedCompletion" value="${esc(i.expected_completion || "")}"></div>
  <div class="f"><label for="im">Internal notes (only you can see these)</label><textarea id="im" name="internalNotes">${esc(i.internal_notes || "")}</textarea></div>
  <div class="f"><label for="sm">Message to student (optional, shown with the update)</label><textarea id="sm" name="message" maxlength="1000"></textarea></div>
  <button class="btn primary small" type="submit">Save update</button></form>
  <form id="delForm" class="f"><label for="df">Upload completed files</label><input id="df" type="file" multiple accept=".pdf,.doc,.docx,.pptx,.txt,.jpg,.jpeg,.png" required><button class="btn small outline" type="submit">Upload deliverables</button></form></div>`;
function studentActions(i, d) {
  let h = "";
  if (i.status === "Completed") {
    h += d.review ? `<div class="panel"><h2>Your review</h2><div class="stars">${"★".repeat(d.review.rating)}${"☆".repeat(5 - d.review.rating)}</div><p>${esc(d.review.comment || "")}</p><p class="fine">${d.review.visible ? "Published." : "Waiting for owner approval."}</p></div>` :
      `<div class="panel"><h2>Leave a review</h2><p class="fine">Tell others about the service, communication and timeliness — not your grade.</p><form id="rvForm"><div class="f"><label for="rt">Rating</label><select id="rt" name="rating"><option value="5">★★★★★ 5</option><option value="4">★★★★ 4</option><option value="3">★★★ 3</option><option value="2">★★ 2</option><option value="1">★ 1</option></select></div><div class="f"><label for="rcm">Comment (optional)</label><textarea id="rcm" name="comment" maxlength="1000"></textarea></div><button class="btn primary small" type="submit">Submit review</button></form></div>`;
    h += `<p><a class="btn outline small" href="#/support">Optional: support Zein / say thanks</a></p>`;
  }
  if (["Submitted", "Read", "Under Review", "Awaiting Response", "Accepted"].includes(i.status)) h += `<p><button class="btn danger small" id="cancelReq" type="button">Cancel this request</button></p>`;
  return h;
}
function bindRequest(i, d, owner) {
  const id = i.id, reload = () => requestView(id);
  const filesForm = (sel) => { const fd = new FormData(); [...$(sel).files].forEach(f => fd.append("files", f)); return fd; };
  $("#msgForm")?.addEventListener("submit", e => { e.preventDefault(); const m = e.target.message.value.trim(); if (!m) return toast("Write a message first.", true);
    busy(e.target.querySelector("button"), async () => { await api(`/api/inquiries/${id}/messages`, { method: "POST", body: { message: m } }); toast("Message sent."); reload(); }); });
  $("#addFiles")?.addEventListener("submit", e => { e.preventDefault(); const f = [...$("#af").files]; if (!f.length) return toast("Choose a file first.", true); const err = checkFilesClient(f); if (err) return toast(err, true);
    busy(e.target.querySelector("button"), async () => { await api(`/api/inquiries/${id}/files`, { method: "POST", form: filesForm("#af") }); toast("Files uploaded."); reload(); }); });
  $("#cancelReq")?.addEventListener("click", e => { if (confirm("Cancel this request?")) busy(e.target, async () => { await api(`/api/inquiries/${id}/cancel`, { method: "POST", body: {} }); toast("Request cancelled."); reload(); }); });
  $("#rvForm")?.addEventListener("submit", e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target));
    busy(e.target.querySelector("button"), async () => { const r = await api(`/api/inquiries/${id}/review`, { method: "POST", body: f }); toast(r.message); reload(); }); });
  if (!owner) return;
  const patch = (btn, body, msg) => busy(btn, async () => { await api(`/api/inquiries/${id}`, { method: "PATCH", body }); toast(msg || "Updated."); reload(); });
  $$("[data-quick]").forEach(b => b.onclick = () => {
    const st = b.dataset.quick, msg = $("#sm").value.trim();
    if (st === "Awaiting Response" && !msg) { $("#sm").focus(); return toast("Write the clarification you need in the message box first.", true); }
    if (st === "Declined" && !confirm("Decline this request?")) return;
    patch(b, { status: st, message: msg, expectedCompletion: $("#ec").value, internalNotes: $("#im").value }, `Marked ${st}.`); });
  $("#stForm")?.addEventListener("submit", e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); patch(e.target.querySelector("button"), { status: f.status, expectedCompletion: f.expectedCompletion, internalNotes: f.internalNotes, message: f.message }); });
  $("#delForm")?.addEventListener("submit", e => { e.preventDefault(); const f = [...$("#df").files], err = checkFilesClient(f); if (!f.length) return toast("Choose a file first.", true); if (err) return toast(err, true);
    busy(e.target.querySelector("button"), async () => { await api(`/api/inquiries/${id}/files`, { method: "POST", form: filesForm("#df") }); toast("Deliverables uploaded."); reload(); }); });
}
async function supportView() {
  const r = await api("/api/payment-methods");
  app.innerHTML = `<div class="wrap mid"><h1>Optional support</h1><div class="notice ok">Contributions are <b>completely voluntary</b>. There is no minimum, no deadline and no priority for contributing, and it never affects whether your request is accepted. Zein does not process payments on this site — send any amount you wish through your own app, if you wish.</div>
  <div class="grid">${r.methods.map(m => `<article class="card"><h3>${esc(pmLabel(m))}</h3>${m.account_holder ? `<p>Account name: <b>${esc(m.account_holder)}</b></p>` : ""}${m.account_identifier ? `<p>Account: <b>${esc(m.account_identifier)}</b></p>` : ""}${m.instructions ? `<p>${esc(m.instructions)}</p>` : ""}${m.has_qr ? `<img class="qr" alt="${esc(pmLabel(m))} QR code" src="/api/payment-methods/${m.id}/qr">` : ""}</article>`).join("") || '<p class="fine">No contribution methods are available right now. You can still leave a thank-you message below.</p>'}</div>
  ${S.user.role === "student" ? `<div class="panel"><h2>Say thanks (optional)</h2><p class="fine">Upload a receipt if you donated, or just leave a message — or skip this page entirely.</p><form id="rcForm">
  ${r.methods.length ? `<div class="f"><label for="pm">Method used (optional)</label><select id="pm" name="paymentMethodId"><option value="">—</option>${r.methods.map(m => `<option value="${m.id}">${esc(pmLabel(m))}</option>`).join("")}</select></div>` : ""}
  <div class="f"><label for="rm">Thank-you message</label><textarea id="rm" name="message" maxlength="500"></textarea></div><div class="f"><label for="rf">Receipt (optional, JPG, PNG or PDF, up to ${bytesFmt(S.config.limits.fileBytes)})</label><input id="rf" type="file" accept=".jpg,.jpeg,.png,.pdf"></div>
  <button class="btn primary" type="submit">Send</button></form></div>` : ""}</div>`;
  $("#rcForm")?.addEventListener("submit", e => { e.preventDefault(); const fd = new FormData(e.target); const f = $("#rf").files[0]; if (f) fd.append("files", f); if (!fd.get("message") && !f) return toast("Add a message or a receipt, or just skip this page.", true);
    busy(e.target.querySelector("button"), async () => { await api("/api/receipts", { method: "POST", form: fd }); toast("Thank you! Your message was sent."); e.target.reset(); }); });
}
function accountView() {
  app.innerHTML = `<div class="wrap narrow"><h1>Account</h1><div class="panel"><p>Signed in as <b>${esc(S.user.username)}</b></p>
  <form id="prof"><div class="f"><label for="pdn">Display name (optional)</label><input id="pdn" name="displayName" maxlength="60" value="${esc(S.user.displayName === S.user.username ? "" : S.user.displayName)}"></div><div class="f"><label for="pem">Email (optional)</label><input id="pem" name="email" type="email" maxlength="254"></div><button class="btn small primary" type="submit">Save profile</button></form></div>
  <div class="panel"><h2>Change password</h2><form id="pw"><div class="f"><label for="cp">Current password</label><input id="cp" name="currentPassword" type="password" autocomplete="current-password" required></div><div class="f"><label for="n1">New password (10+ characters)</label><input id="n1" name="newPassword" type="password" minlength="10" autocomplete="new-password" required></div><button class="btn small primary" type="submit">Change password</button></form><p class="fine">Other devices are signed out when you change your password.</p></div>
  <div class="panel"><h2>Sign out everywhere</h2><button class="btn outline small" id="outAll" type="button">Sign out of all devices</button></div></div>`;
  $("#prof").onsubmit = e => { e.preventDefault(); busy(e.target.querySelector("button"), async () => { const d = Object.fromEntries(new FormData(e.target)); await api("/api/account", { method: "PATCH", body: d }); S.user.displayName = d.displayName || S.user.username; toast("Profile saved."); }); };
  $("#pw").onsubmit = e => { e.preventDefault(); busy(e.target.querySelector("button"), async () => { const r = await api("/api/account/password", { method: "POST", body: Object.fromEntries(new FormData(e.target)) }); S.user = r.user; e.target.reset(); toast("Password changed."); }); };
  $("#outAll").onclick = e => busy(e.target, async () => { await api("/api/auth/logout-all", { method: "POST", body: {} }); S.user = null; S.csrf = ""; renderAccount(); toast("Signed out everywhere."); go("#/login"); });
}

// ---------------- owner dashboard ----------------
const OWNER_TABS = [["inbox", "Inbox"], ["students", "Students"], ["reviews", "Reviews"], ["receipts", "Receipts"], ["settings", "Settings"]];
const SETTINGS_TABS = [["payments", "Payment Methods"], ["integrations", "Integrations"], ["security", "Security Log"]];
function ownerShell(tab, inner, sub) {
  app.innerHTML = `<div class="wrap"><span class="eyebrow">Owner dashboard</span><h1>${esc(OWNER_TABS.find(t => t[0] === tab)[1])}</h1>
  <nav class="tabs" aria-label="Owner sections">${OWNER_TABS.map(([k, n]) => `<a href="#/owner/${k}" class="${k === tab ? "on" : ""}">${n}</a>`).join("")}</nav>
  ${tab === "settings" ? `<nav class="tabs" aria-label="Settings">${SETTINGS_TABS.map(([k, n]) => `<a href="#/owner/settings/${k}" class="${k === sub ? "on" : ""}">${n}</a>`).join("")}</nav>` : ""}${inner}</div>`;
}
async function ownerView(tab = "inbox", sub = "payments") {
  if (!OWNER_TABS.some(t => t[0] === tab)) tab = "inbox";
  if (tab === "inbox") return inboxView();
  if (tab === "students") return studentsView();
  if (tab === "reviews") return reviewsAdmin();
  if (tab === "receipts") return receiptsAdmin();
  if (sub === "integrations") return discordView();
  if (sub === "security") return securityView();
  return paymentsAdmin();
}
let inboxState = { status: "", q: "" };
async function inboxView() {
  const qs = new URLSearchParams(); if (inboxState.status) qs.set("status", inboxState.status); if (inboxState.q) qs.set("q", inboxState.q);
  const r = await api("/api/inquiries?" + qs);
  ownerShell("inbox", `<form id="flt" class="row"><div class="grow"><label class="lbl" for="sq">Search</label><input id="sq" type="search" placeholder="Title, username, service or reference" value="${esc(inboxState.q)}"></div>
    <div><label class="lbl" for="sf">Status</label><select id="sf"><option value="">All (${Object.values(r.counts).reduce((a, b) => a + b, 0)})</option>${S.config.statuses.map(s => `<option ${inboxState.status === s ? "selected" : ""} value="${esc(s)}">${esc(s)} (${r.counts[s] || 0})</option>`).join("")}</select></div><button class="btn primary small" type="submit">Filter</button></form>
    <div class="list">${r.inquiries.map(i => `<a class="item" href="#/request/${i.id}"><div><h3>${esc(i.title)}</h3><p>${esc(i.username)} · ${esc(i.service)} · ${esc(i.education_level)} · ${fmtDate(i.created_at)}${i.file_count ? ` · ${i.file_count} file(s)` : ""}</p></div><span class="tag ${slug(i.status)}">${esc(i.status)}</span></a>`).join("") || '<div class="panel">No matching requests.</div>'}</div>
    <p class="fine">Opening this list does not mark requests as read — only opening an individual request does.</p>`);
  $("#flt").onsubmit = e => { e.preventDefault(); inboxState = { q: $("#sq").value.trim(), status: $("#sf").value }; inboxView(); };
}
function studentsView() {
  ownerShell("students", `<div class="panel"><p>Search for a student by username to generate a temporary reset passcode. You can never see passwords or recovery codes.</p>
  <form id="stSearch" class="row"><div class="grow"><label class="lbl" for="stq">Username</label><input id="stq" required minlength="2" autocapitalize="none"></div><button class="btn primary small" type="submit">Search</button></form><div id="stRes" class="list"></div></div>`);
  $("#stSearch").onsubmit = e => { e.preventDefault(); busy(e.target.querySelector("button"), async () => {
    const r = await api("/api/owner/students?q=" + encodeURIComponent($("#stq").value.trim()));
    $("#stRes").innerHTML = r.students.map(s => `<div class="item" data-sid="${s.id}"><div><h3>${esc(s.username)}</h3><p>${s.displayName ? esc(s.displayName) + " · " : ""}joined ${fmtDate(s.createdAt)}${s.passcode ? ` · passcode ${esc(s.passcode.status)} (created ${fmtTime(s.passcode.createdAt)}, expires ${fmtTime(s.passcode.expiresAt)})` : ""}</p></div><button class="btn amber small" data-gen="${s.id}" type="button">Generate temporary reset passcode</button><div class="grow passout" aria-live="polite"></div></div>`).join("") || '<p class="fine">No matching students.</p>';
    $$("[data-gen]").forEach(b => b.onclick = () => { if (!confirm("Generate a new passcode? Any previous passcode stops working.")) return; busy(b, async () => {
      const p = await api(`/api/owner/students/${b.dataset.gen}/passcode`, { method: "POST", body: {} });
      b.closest(".item").querySelector(".passout").innerHTML = `<div class="code">${esc(p.passcode)}</div><p class="fine">Shown once. Give it to <b>${esc(p.username)}</b> privately. Single use, expires ${fmtTime(p.expiresAt)} (24 hours). They enter it at Sign In → Forgot password.</p>`; }); }); }); };
}
async function reviewsAdmin() {
  const r = await api("/api/owner/reviews");
  ownerShell("reviews", `<div class="list">${r.reviews.map(x => `<div class="item"><div><div class="stars">${"★".repeat(x.rating)}${"☆".repeat(5 - x.rating)}</div><p><b>${esc(x.username)}</b> · ${esc(x.service)} · ${fmtDate(x.created_at)}</p><p>${esc(x.comment || "(no comment)")}</p><p><a href="#/request/${x.inquiry_id}">View request</a> · ${x.visible ? "Published" : "Pending / hidden"}</p></div>
    <div class="row"><button class="btn small ${x.visible ? "outline" : "mint"}" data-vis="${x.id}" data-to="${x.visible ? 0 : 1}" type="button">${x.visible ? "Hide" : "Approve & publish"}</button><button class="btn small danger" data-del="${x.id}" type="button">Delete</button></div></div>`).join("") || '<div class="panel">No reviews yet.</div>'}</div><p class="fine">Publish only genuine reviews about service quality, communication and timeliness.</p>`);
  $$("[data-vis]").forEach(b => b.onclick = () => busy(b, async () => { await api(`/api/owner/reviews/${b.dataset.vis}`, { method: "PATCH", body: { visible: b.dataset.to === "1" } }); reviewsAdmin(); }));
  $$("[data-del]").forEach(b => b.onclick = () => confirm("Delete this review permanently?") && busy(b, async () => { await api(`/api/owner/reviews/${b.dataset.del}`, { method: "DELETE" }); reviewsAdmin(); }));
}
async function receiptsAdmin() {
  const r = await api("/api/owner/receipts");
  ownerShell("receipts", `<div class="list">${r.receipts.map(x => `<div class="item"><div><h3>${esc(x.username)}${x.method_name !== null && x.method_name !== undefined ? ` · ${esc(x.method_name || "QR payment")}` : ""}</h3><p>${fmtTime(x.created_at)} ${x.reviewed_at ? "· reviewed" : "· new"}</p>${x.thank_you_message ? `<p>“${esc(x.thank_you_message)}”</p>` : ""}${x.has_file ? `<a href="/api/owner/receipts/${x.id}/file?inline=1" target="_blank" rel="noopener">${/^image\//.test(x.content_type) ? `<img class="thumb" alt="Receipt" src="/api/owner/receipts/${x.id}/file?inline=1">` : "Open receipt"}</a>` : ""}</div>
    <div class="row">${x.reviewed_at ? "" : `<button class="btn small mint" data-rev="${x.id}" type="button">Mark reviewed</button>`}<button class="btn small danger" data-rdel="${x.id}" type="button">Delete</button></div></div>`).join("") || '<div class="panel">No receipts or thank-you messages yet.</div>'}</div><p class="fine">Receipts are optional, never required, and are removed automatically after about 60 days.</p>`);
  $$("[data-rev]").forEach(b => b.onclick = () => busy(b, async () => { await api(`/api/owner/receipts/${b.dataset.rev}/reviewed`, { method: "POST", body: {} }); receiptsAdmin(); }));
  $$("[data-rdel]").forEach(b => b.onclick = () => confirm("Delete this receipt and its file?") && busy(b, async () => { await api(`/api/owner/receipts/${b.dataset.rdel}`, { method: "DELETE" }); receiptsAdmin(); }));
}
const pmLabel = m => (m && m.name) || "QR payment";
const checkQr = f => !/\.(png|jpe?g)$/i.test(f.name) ? "The QR code must be a PNG or JPG image." : f.size > S.config.limits.fileBytes ? `The image must be under ${bytesFmt(S.config.limits.fileBytes)}.` : !f.size ? "That image is empty." : "";
async function paymentsAdmin() {
  const r = await api("/api/owner/payment-methods"), ms = r.methods;
  const formFields = m => `<div class="f"><label>Name (optional)</label><input name="name" maxlength="60" value="${esc(m?.name || "")}" placeholder="e.g. GCash"></div>
    <div class="f"><label>QR code image ${m ? "(optional — leave empty to keep the current one)" : "*"}</label>${m?.has_qr ? `<img class="qr" alt="Current QR code for ${esc(pmLabel(m))}" src="/api/payment-methods/${m.id}/qr">` : ""}<input type="file" name="qr" class="qrf" accept=".png,.jpg,.jpeg,image/png,image/jpeg" ${m ? "" : "required"}><small class="hint">PNG or JPG, up to ${bytesFmt(S.config.limits.fileBytes)}.</small></div>
    <div class="f"><label>Account holder (optional)</label><input name="accountHolder" maxlength="80" value="${esc(m?.account_holder || "")}"></div><div class="f"><label>Account number / identifier (optional)</label><input name="accountIdentifier" maxlength="120" value="${esc(m?.account_identifier || "")}"></div><div class="f"><label>Instructions (optional)</label><textarea name="instructions" maxlength="600">${esc(m?.instructions || "")}</textarea></div><div class="f"><label><input type="checkbox" name="enabled" ${!m || m.enabled ? "checked" : ""}> Enabled (visible to signed-in students)</label></div>`;
  ownerShell("settings", `<div class="notice">Contributions are voluntary. Only enabled methods are shown to students. Each method needs a QR code image; the name and other details are optional.</div>
  <div class="list">${ms.map((m, idx) => `<form class="panel pm" data-id="${m.id}"><div class="row sb"><h2>${esc(pmLabel(m))} ${m.enabled ? "" : '<span class="tag">disabled</span>'}</h2><div class="row"><button class="btn small outline" data-mv="-1" type="button" ${idx === 0 ? "disabled" : ""} aria-label="Move up">↑</button><button class="btn small outline" data-mv="1" type="button" ${idx === ms.length - 1 ? "disabled" : ""} aria-label="Move down">↓</button></div></div>${formFields(m)}
    <div class="row"><button class="btn small primary" type="submit">Save</button><button class="btn small danger" data-pdel type="button">Delete method</button></div></form>`).join("")}</div>
  <form class="panel" id="pmNew"><h2>Add a payment method</h2>${formFields(null)}<button class="btn primary small" type="submit">Add method</button></form>`, "payments");
  const build = f => { const d = new FormData(); for (const k of ["name", "accountHolder", "accountIdentifier", "instructions"]) d.set(k, f.elements[k].value); d.set("enabled", f.elements.enabled.checked ? "1" : "0");
    const file = f.querySelector(".qrf").files[0]; if (file) d.append("files", file); return d; };
  const imageOk = (f, required) => { const file = f.querySelector(".qrf").files[0]; if (!file) { if (required) toast("Upload a QR code image.", true); return !required; } const err = checkQr(file); if (err) toast(err, true); return !err; };
  $("#pmNew").onsubmit = e => { e.preventDefault(); if (!imageOk(e.target, true)) return; busy(e.target.querySelector("button"), async () => { await api("/api/owner/payment-methods", { method: "POST", form: build(e.target) }); toast("Added."); paymentsAdmin(); }); };
  $$("form.pm").forEach(f => { const id = f.dataset.id;
    f.onsubmit = e => { e.preventDefault(); if (!imageOk(f, false)) return; busy(f.querySelector("[type=submit]"), async () => { await api(`/api/owner/payment-methods/${id}`, { method: "PATCH", form: build(f) }); toast("Saved."); paymentsAdmin(); }); };
    f.querySelector("[data-pdel]").onclick = () => confirm("Delete this payment method?") && busy(f.querySelector("[data-pdel]"), async () => { await api(`/api/owner/payment-methods/${id}`, { method: "DELETE" }); paymentsAdmin(); });
    $$("[data-mv]", f).forEach(b => b.onclick = () => busy(b, async () => { const ids = ms.map(m => m.id), i = ids.indexOf(id), j = i + Number(b.dataset.mv); [ids[i], ids[j]] = [ids[j], ids[i]]; await api("/api/owner/payment-methods/reorder", { method: "POST", body: { ids } }); paymentsAdmin(); }));
  });
}
async function discordView() {
  const s = await api("/api/owner/discord");
  const L = { new_inquiry: "New inquiries", student_info: "Additional student information", decision: "Accepted or declined requests", completed: "Completed requests", new_review: "New reviews", receipt: "Contribution receipts / thank-you messages", download: "Student downloads a deliverable" };
  ownerShell("settings", `<div class="panel"><h2>Discord webhook</h2><p>Webhook URL: <b>${s.webhookConfigured ? "configured (stored as a Cloudflare Worker secret)" : "not configured"}</b>. ${s.webhookConfigured ? "" : "Set the <code>DISCORD_WEBHOOK_URL</code> secret — see the README."} The URL is never shown here.</p>
  ${s.failedNotifications ? `<div class="notice bad">${s.failedNotifications} notification(s) failed to send; they are retried automatically.</div>` : ""}
  <form id="dcForm"><div class="f"><label><input type="checkbox" name="enabled" ${s.enabled ? "checked" : ""}> Enable Discord notifications</label></div>
  <div class="f"><label for="did">Your Discord user ID</label><input id="did" name="ownerId" inputmode="numeric" maxlength="20" value="${esc(s.ownerId)}" placeholder="17–20 digit number"><small class="hint">Discord → Settings → Advanced → Developer Mode on, then right-click your name → Copy User ID. Only this user is mentioned; never @everyone or @here.</small></div>
  <fieldset class="f"><legend class="lbl">Notify me about</legend>${Object.entries(L).map(([k, n]) => `<label><input type="checkbox" name="ev_${k}" ${s.events[k] ? "checked" : ""}> ${n}</label>`).join("")}</fieldset>
  <div class="row"><button class="btn primary small" type="submit">Save settings</button><button class="btn outline small" id="dcTest" type="button">Send test notification</button></div></form></div>`, "integrations");
  $("#dcForm").onsubmit = e => { e.preventDefault(); const d = Object.fromEntries(new FormData(e.target)); const events = {}; Object.keys(L).forEach(k => events[k] = !!d["ev_" + k]);
    busy(e.target.querySelector("[type=submit]"), async () => { await api("/api/owner/discord", { method: "PUT", body: { enabled: !!d.enabled, ownerId: d.ownerId, events } }); toast("Saved."); discordView(); }); };
  $("#dcTest").onclick = e => busy(e.target, async () => { await api("/api/owner/discord/test", { method: "POST", body: {} }); toast("Test sent — check Discord."); });
}
async function securityView() {
  const r = await api("/api/owner/security-events");
  ownerShell("settings", `<div class="panel scroll"><table><thead><tr><th>When</th><th>Event</th><th>User</th><th>Detail</th></tr></thead><tbody>${r.events.map(e => `<tr><td>${fmtTime(e.created_at)}</td><td>${esc(e.event_type)}</td><td>${esc(e.username || "")}</td><td>${esc(e.detail || "")}</td></tr>`).join("") || "<tr><td colspan=4>No events.</td></tr>"}</tbody></table></div>`, "security");
}

// ---------------- router ----------------
const PUBLIC = new Set(["", "home", "services", "how", "reviews", "faq", "contact", "terms", "privacy", "login", "register", "recover", "reset", "owner-setup"]);
async function route() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent), name = parts[0] || "home";
  $$("nav a").forEach(a => a.classList.toggle("on", a.getAttribute("href") === "#/" + (name === "home" ? "" : name)));
  try {
    if (!PUBLIC.has(name) && !S.user) { S.after = location.hash; toast("Please sign in to continue."); return go("#/login"); }
    if (S.user && (name === "login" || name === "register") && !S.oneTime) { /* allow viewing, harmless */ }
    if (name === "owner" && S.user.role !== "owner") return go("#/portal");
    if (["portal", "inquiry"].includes(name) && S.user.role === "owner") return go("#/owner");
    switch (name) {
      case "": case "home": homeView(); break;
      case "services": case "how": case "reviews": case "faq": homeView(name); break;
      case "contact": contactView(); break;
      case "terms": page("Terms of Service", `<div class="panel legal">${TERMS}</div>`); break;
      case "privacy": page("Privacy Policy", `<div class="panel legal">${PRIVACY}</div>`); break;
      case "login": authView("login"); break; case "register": authView("register"); break;
      case "owner-setup": ownerSetupView(); break;
      case "recover": recoverView(); break; case "reset": resetView(); break;
      case "inquiry": if (!S.wizard) S.wizard = newWizard(); wizardView(); break;
      case "portal": await portalView(); break;
      case "request": await requestView(parts[1]); break;
      case "support": await supportView(); break;
      case "account": accountView(); break;
      case "owner": await ownerView(parts[1], parts[2]); break;
      default: page("Page not found", '<p>That page does not exist. <a href="#/">Go home</a>.</p>');
    }
  } catch (e) { toast(e.message, true); if (e.status === 401) { S.user = null; renderAccount(); go("#/login"); } else if (e.status === 404) page("Not found", `<p>${esc(e.message)} <a href="#/">Go home</a>.</p>`); }
  if (name !== "services" && name !== "how" && name !== "reviews" && name !== "faq") window.scrollTo(0, 0);
  if (!["services", "how", "reviews", "faq"].includes(name)) app.focus({ preventScroll: true });
}
document.addEventListener("click", e => {
  const b = e.target.closest("[data-start]");
  if (b) { S.wizard = newWizard(); S.wizard.service = b.dataset.start; S.wizard.step = 2; go("#/inquiry"); }
  if (e.target.closest('a[href="#/inquiry"]') && !e.target.closest("[data-new]") && !S.wizard) S.wizard = newWizard();
});
window.addEventListener("hashchange", route);
(async function init() {
  $("#year").textContent = new Date().getFullYear();
  try { S.config = await api("/api/config"); const me = await api("/api/me"); S.user = me.user; } catch { app.innerHTML = '<div class="wrap"><p>The site could not load. Please refresh.</p></div>'; return; }
  renderAccount(); route();
})();
