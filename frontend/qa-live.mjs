// E2E for live-эфир on demo: operator publishes a fake camera, manager sees it,
// killswitch kicks and restores, second tab yields, reload recovers.
// Usage: QA_BASE=https://demo.naff.flek.uz QA_DESIGN=v1|v2 \
//        QA_OP_USER=... QA_OP_PASS=... QA_MGR_USER=... QA_MGR_PASS=... node qa-live.mjs
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const BASE = process.env.QA_BASE || "https://demo.naff.flek.uz";
const API = BASE + "/api";
const DESIGN = process.env.QA_DESIGN || "v1";
const OUT = process.env.QA_OUT || "/tmp/naff-qa-live";
const RELAY = process.env.QA_RELAY === "1";
// Operator status element: v1 floating pill, v2 badge in the /my header.
const STATUS_SEL = DESIGN === "v1" ? '[data-testid="live-pill"]' : '[data-testid="live-badge"]';

const results = [];
function check(name, ok, info = "") {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
}

async function apiLogin(username, password) {
  const r = await fetch(API + "/auth/login/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!r.ok) throw new Error(`login ${username}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function api(token, path, init = {}) {
  const r = await fetch(API + path, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Token ${token}`, ...(init.headers || {}) },
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function openAs(context, auth, path) {
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log(`  [console ${auth.role}] ${m.text().slice(0, 200)}`); });
  await page.goto(BASE + "/login");
  await page.evaluate(([t, u, r, d]) => {
    localStorage.setItem("naffai_token", t);
    localStorage.setItem("naffai_username", u);
    localStorage.setItem("naffai_role", r);
    localStorage.setItem("naffai_design", d);
  }, [auth.token, auth.username, auth.role, DESIGN]);
  await page.goto(BASE + path + (path.includes("?") ? "&" : "?") + "design=" + DESIGN);
  return page;
}

async function waitFor(fn, timeoutMs, stepMs = 1000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return null;
}

async function liveRow(mgrToken, opId) {
  const r = await api(mgrToken, "/live/live-now/");
  return (r.body?.live_now || []).find((x) => x.operator_id === opId) || null;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const opAuth = await apiLogin(process.env.QA_OP_USER, process.env.QA_OP_PASS);
  const mgrAuth = await apiLogin(process.env.QA_MGR_USER, process.env.QA_MGR_PASS);
  const op = { token: opAuth.token, username: process.env.QA_OP_USER, role: "operator" };
  const mgr = { token: mgrAuth.token, username: process.env.QA_MGR_USER, role: mgrAuth.role || "manager" };
  const me = await api(op.token, "/auth/me/");
  const opId = me.body?.operator_id ?? me.body?.operator?.id;
  check("operator me", !!opId, `operator_id=${opId} livestream_enabled=${me.body?.livestream_enabled}`);

  // Make sure the switch is on before we start.
  await api(mgr.token, "/live/global-status/", { method: "PATCH", body: JSON.stringify({ enabled: true }) });

  const args = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"];
  if (RELAY) args.push("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
  const browser = await chromium.launch({ args });
  const opCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ["camera"] });
  const mgrCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });

  // 1. Operator goes live.
  const opPage = await openAs(opCtx, op, "/my");
  let t0 = Date.now();
  const row = await waitFor(() => liveRow(mgr.token, opId).then((r) => r && r.has_video && r), 30000);
  check("operator live with video (server)", !!row, row ? `${Math.round((Date.now() - t0) / 1000)}s, sid=${row.participant_sid}` : "");
  const pill = await waitFor(() => opPage.locator(STATUS_SEL).getAttribute("data-status", { timeout: 2000 }).then((s) => s === "live" && s), 15000);
  check("operator status says live", pill === "live", `status=${pill}`);
  await opPage.screenshot({ path: `${OUT}/op-live-${DESIGN}.png` });

  // 2. Manager sees decoded video.
  const wall = await openAs(mgrCtx, mgr, "/live/wall");
  const tileSel = `[data-testid="live-tile-op:${opId}"] video`;
  const playing = await waitFor(() => wall.evaluate((sel) => {
    const v = document.querySelector(sel);
    return v && v.readyState >= 2 && v.videoWidth > 0 ? `${v.videoWidth}x${v.videoHeight}` : null;
  }, tileSel), 30000);
  check("manager tile plays video", !!playing, playing || "");
  await wall.screenshot({ path: `${OUT}/wall-${DESIGN}.png` });

  // 2b. v1: the status pill sits in the header, «Выйти» stays clickable.
  if (DESIGN === "v1") {
    const inHeader = await opPage.evaluate(() => !!document.querySelector('header [data-testid="live-pill"]'));
    check("v1 pill is in the header", inHeader);
    // Geometry, not elementFromPoint: the check-in gate modal may cover the page.
    const logoutFree = await opPage.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("aside button")).find((b) => /Выйти|Chiqish/.test(b.textContent || ""));
      const pill = document.querySelector('[data-testid="live-pill"]');
      if (!btn || !pill) return `missing ${btn ? "pill" : "logout button"}`;
      const a = btn.getBoundingClientRect();
      const b = pill.getBoundingClientRect();
      const overlap = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      return overlap ? `pill ${Math.round(b.left)},${Math.round(b.top)} over logout ${Math.round(a.left)},${Math.round(a.top)}` : "ok";
    });
    check("logout button is not covered", logoutFree === "ok", logoutFree);
  }

  // 2c. Snapshot: manager asks, operator's browser answers with a JPEG.
  t0 = Date.now();
  const snapReq = await api(mgr.token, "/live/snapshots/", { method: "POST", body: JSON.stringify({ operator_id: opId }) });
  check("snapshot requested", snapReq.status === 202, `HTTP ${snapReq.status} ${JSON.stringify(snapReq.body).slice(0, 120)}`);
  const snapId = snapReq.body?.id;
  const done = snapId && await waitFor(() => api(mgr.token, `/live/snapshots/${snapId}/`).then((r) => r.body?.status !== "pending" && r.body), 15000, 500);
  check("snapshot answered", done?.status === "done", `${Math.round((Date.now() - t0) / 1000)}s status=${done?.status} ${done?.width}x${done?.height} ${done?.error || ""}`);
  if (done?.status === "done") {
    const img = await fetch(`${API}/live/snapshots/${snapId}/image/`, { headers: { Authorization: `Token ${mgr.token}` } });
    const buf = Buffer.from(await img.arrayBuffer());
    const jpeg = img.headers.get("content-type") === "image/jpeg" && buf[0] === 0xff && buf[1] === 0xd8 && buf.length > 1000;
    check("snapshot is a real JPEG", jpeg, `${buf.length} bytes`);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(`${OUT}/snapshot-${DESIGN}.jpg`, buf);
  }

  // 3. Killswitch off → kicked fast; on → back.
  t0 = Date.now();
  await api(mgr.token, "/live/global-status/", { method: "PATCH", body: JSON.stringify({ enabled: false }) });
  const gone = await waitFor(() => liveRow(mgr.token, opId).then((r) => !r), 20000);
  check("killswitch kicks operator", !!gone, `${Math.round((Date.now() - t0) / 1000)}s`);
  const st = await waitFor(() => opPage.locator(STATUS_SEL).getAttribute("data-status", { timeout: 2000 }).then((s) => s === "disabled_global" && s), 40000);
  check("operator status shows stopped by manager", !!st, `status=${st}`);
  t0 = Date.now();
  await api(mgr.token, "/live/global-status/", { method: "PATCH", body: JSON.stringify({ enabled: true }) });
  const back = await waitFor(() => liveRow(mgr.token, opId).then((r) => r && r.has_video && r), 60000);
  check("operator returns after killswitch on", !!back, `${Math.round((Date.now() - t0) / 1000)}s`);

  // 4. Second tab of the same operator does not steal / fight.
  const second = await openAs(opCtx, op, "/my");
  await new Promise((r) => setTimeout(r, 8000));
  const r1 = await liveRow(mgr.token, opId);
  const sidStable = r1 && back && r1.participant_sid === back.participant_sid;
  check("second tab does not reconnect the stream", !!sidStable, `sid=${r1?.participant_sid}`);
  const s2 = await second.locator(STATUS_SEL).getAttribute("data-status", { timeout: 5000 }).catch(() => null);
  check("second tab says other tab", s2 === "other_tab", `status=${s2}`);
  // Close the publishing tab → the second takes over.
  t0 = Date.now();
  await opPage.close();
  const takeover = await waitFor(() => liveRow(mgr.token, opId).then((r) => r && r.has_video && r.participant_sid !== r1?.participant_sid && r), 45000);
  check("second tab takes over after first closes", !!takeover, `${Math.round((Date.now() - t0) / 1000)}s`);

  // 5. Reload recovers.
  t0 = Date.now();
  await second.reload();
  const again = await waitFor(() => liveRow(mgr.token, opId).then((r) => r && r.has_video && r.participant_sid !== takeover?.participant_sid && r), 45000);
  check("reload recovers stream", !!again, `${Math.round((Date.now() - t0) / 1000)}s`);

  // 6. Wall reflects it.
  const playing2 = await waitFor(() => wall.evaluate((sel) => {
    const v = document.querySelector(sel);
    return v && v.readyState >= 2 && v.videoWidth > 0;
  }, tileSel), 30000);
  check("wall shows the new connection", !!playing2);
  await wall.screenshot({ path: `${OUT}/wall-after-${DESIGN}.png` });

  // 7. Off air → the request is refused with a reason.
  await second.close();
  await waitFor(() => liveRow(mgr.token, opId).then((r) => !r), 30000);
  const off = await api(mgr.token, "/live/snapshots/", { method: "POST", body: JSON.stringify({ operator_id: opId }) });
  check("snapshot of an off-air operator is refused", off.status === 409, `HTTP ${off.status} code=${off.body?.code}`);

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
