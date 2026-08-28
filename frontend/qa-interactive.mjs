import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const BASE = process.env.QA_BASE || "http://localhost:5180";
const API = process.env.QA_API || "http://localhost:8010/api";
const OUT = process.env.QA_OUT || "/tmp/naff-qa-int";
const TOKEN = process.env.QA_TOKEN;
const OP_TOKEN = process.env.QA_OP_TOKEN;

async function login(page, role) {
  await page.goto(BASE + "/login");
  const token = role === "operator" ? OP_TOKEN : TOKEN;
  const uname = role === "operator" ? "qaop" : "qa";
  await page.evaluate(
    ([t, u, r]) => {
      localStorage.setItem("naffai_token", t);
      localStorage.setItem("naffai_username", u);
      localStorage.setItem("naffai_role", r);
      localStorage.setItem("naffai_theme", "light");
      document.documentElement.setAttribute("data-nf", "light");
    },
    [token, uname, role],
  );
}

async function shot(page, name) {
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
}

async function main() {
  await mkdir(OUT, { recursive: true });
  await fetch(`${API}/me/morning-greeting/dismiss/`, {
    method: "POST",
    headers: { Authorization: `Token ${OP_TOKEN}` },
  }).catch(() => {});

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    locale: "ru-RU",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push({ where: page.url(), text: m.text() }));
  page.on("pageerror", (e) => errors.push({ where: page.url(), text: e.message }));

  console.log("=== Manager: Dashboard + Sale modal ===");
  await login(page, "manager");
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await shot(page, "01-dash");
  try {
    await page.getByRole("button", { name: /новая продажа/i }).first().click();
    await page.waitForTimeout(1200);
    await shot(page, "02-sale-modal");
    await page.keyboard.press("Escape");
  } catch (e) { console.log("sale modal:", e.message); }

  console.log("=== Sales list → detail ===");
  await page.goto(BASE + "/sales", { waitUntil: "networkidle" });
  await shot(page, "03-sales");
  try {
    await page.locator(".nf-row").first().click();
    await page.waitForLoadState("networkidle");
    await shot(page, "04-sale-detail");
  } catch (e) { console.log("sale row:", e.message); }

  console.log("=== Operator detail: account + QR ===");
  await page.goto(BASE + "/operators/29", { waitUntil: "networkidle" });
  await shot(page, "06-operator-detail");
  try {
    await page.getByRole("button", { name: /qr для входа/i }).click();
    await page.waitForTimeout(1500);
    await shot(page, "07-op-qr-modal");
    await page.keyboard.press("Escape");
  } catch (e) { console.log("qr modal:", e.message); }
  try {
    await page.getByRole("button", { name: /показать пароль/i }).click();
    await page.waitForTimeout(1200);
    await shot(page, "08-op-password-modal");
    await page.keyboard.press("Escape");
  } catch (e) { console.log("password modal:", e.message); }

  console.log("=== AI chat ===");
  await page.goto(BASE + "/ai-chat", { waitUntil: "networkidle" });
  await shot(page, "14-ai-chat");
  try {
    await page.getByRole("button", { name: /продажи за неделю/i }).click();
    await page.waitForTimeout(2500);
    await shot(page, "15-ai-chat-response");
  } catch (e) { console.log("ai chat:", e.message); }

  console.log("=== Operator + TG wizard ===");
  await login(page, "operator");
  await page.goto(BASE + "/my", { waitUntil: "networkidle" });
  await shot(page, "16-op-my");
  await page.goto(BASE + "/profile", { waitUntil: "networkidle" });
  await shot(page, "17-op-profile");
  try {
    await page.getByRole("button", { name: /подключ.*telegram/i }).click();
    await page.waitForTimeout(1200);
    await shot(page, "18-tg-wizard-step1");
    await page.fill('input[placeholder*="+998"]', "+998901234567");
    await page.locator('input[type="checkbox"]').first().check();
    await shot(page, "19-tg-wizard-step1-filled");
    await page.keyboard.press("Escape");
  } catch (e) { console.log("tg wizard:", e.message); }

  console.log("=== /scan public ===");
  await context.clearCookies();
  await page.evaluate(() => localStorage.clear());
  await page.goto(BASE + "/scan", { waitUntil: "networkidle" });
  await shot(page, "20-scan-public");

  await browser.close();
  console.log("\n=== ERRORS ===");
  const seen = {};
  for (const e of errors) {
    const k = e.text.slice(0, 100);
    seen[k] = (seen[k] || []).concat([e.where]);
  }
  Object.entries(seen)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 15)
    .forEach(([k, urls]) => console.log(`[${urls.length}]`, k, "→", urls[0]));
}

main().catch((e) => { console.error(e); process.exit(1); });
