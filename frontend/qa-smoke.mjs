import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const BASE = process.env.QA_BASE || "http://localhost:5180";
const API = process.env.QA_API || "http://localhost:8010/api";
const OUT = process.env.QA_OUT || "/tmp/naff-qa";
const TOKEN = process.env.QA_TOKEN || "";
const OP_TOKEN = process.env.QA_OP_TOKEN || "";
const USERNAME = process.env.QA_USERNAME || "qa";
const OP_USERNAME = process.env.QA_OP_USERNAME || "qaop";
const ROLE = process.env.QA_ROLE || "manager";

const PAGES = [
  { name: "01-dashboard", url: "/", waitFor: "text=Дашборд" },
  { name: "02-sales", url: "/sales", waitFor: "text=Все" },
  { name: "03-sales-today", url: "/sales-today" },
  { name: "04-leads", url: "/leads" },
  { name: "05-analytics", url: "/analytics" },
  { name: "06-reports", url: "/reports" },
  { name: "07-operators", url: "/operators" },
  { name: "08-attendance-today", url: "/attendance/today" },
  { name: "09-attendance-report", url: "/attendance/report" },
  { name: "10-ai-chat", url: "/ai-chat" },
  { name: "11-payroll", url: "/payroll" },
  { name: "12-audit", url: "/audit" },
  { name: "13-marketing", url: "/marketing" },
  { name: "14-sheet-sources", url: "/sheet-sources" },
  { name: "15-partners", url: "/partners" },
  { name: "16-screen", url: "/screen" },
  { name: "17-my-leads-operator", url: "/my", role: "operator" },
  { name: "18-notifications-operator", url: "/notifications", role: "operator" },
  { name: "19-lessons-today", url: "/lessons/today", role: "operator" },
  { name: "20-lessons-history", url: "/lessons/history", role: "operator" },
  { name: "21-profile", url: "/profile", role: "operator" },
  { name: "22-scan-public", url: "/scan", role: "public" },
];

const THEMES = ["light", "dark"];

async function login(page, role, theme) {
  await page.goto(BASE + "/login");
  const token = role === "operator" ? OP_TOKEN : TOKEN;
  const uname = role === "operator" ? OP_USERNAME : USERNAME;
  await page.evaluate(
    ([t, u, r, th]) => {
      localStorage.setItem("naffai_token", t);
      localStorage.setItem("naffai_username", u);
      localStorage.setItem("naffai_role", r);
      localStorage.setItem("naffai_theme", th);
      document.documentElement.setAttribute("data-nf", th);
    },
    [token, uname, role, theme || "light"],
  );
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    locale: "ru-RU",
  });
  const page = await context.newPage();

  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      errors.push({ url: page.url(), text: msg.text() });
    }
  });
  page.on("pageerror", (err) => {
    errors.push({ url: page.url(), text: err.message });
  });

  const results = [];

  // Screenshot login first, no auth
  await page.goto(BASE + "/login");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/00-login.png`, fullPage: true });
  results.push({ name: "00-login", url: "/login", ok: true });

  // Dismiss the operator morning-greeting popup so it doesn't cover screens.
  try {
    const dismiss = await fetch(`${API}/me/morning-greeting/dismiss/`, {
      method: "POST",
      headers: { Authorization: `Token ${OP_TOKEN}` },
    });
    console.error("dismiss greeting:", dismiss.status);
  } catch (e) {
    console.error("dismiss failed:", e.message);
  }

  for (const theme of THEMES) {
    for (const p of PAGES) {
      const targetRole = p.role || ROLE;
      if (targetRole !== "public") {
        await login(page, targetRole === "operator" ? "operator" : "manager", theme);
      } else {
        // public: still set theme
        await page.goto(BASE + "/login");
        await page.evaluate((t) => {
          localStorage.setItem("naffai_theme", t);
          document.documentElement.setAttribute("data-nf", t);
        }, theme);
      }
      try {
        await page.goto(BASE + p.url, { waitUntil: "networkidle", timeout: 15000 });
        // Re-assert theme after navigation (in case theme store re-init).
        await page.evaluate((t) => document.documentElement.setAttribute("data-nf", t), theme);
        await page.waitForTimeout(1500);
        const themeSuffix = theme === "dark" ? "-dark" : "";
        await page.screenshot({
          path: `${OUT}/${p.name}${themeSuffix}.png`,
          fullPage: true,
        });
        results.push({ name: `${p.name}${themeSuffix}`, url: p.url, ok: true });
      } catch (err) {
        results.push({
          name: `${p.name}${theme === "dark" ? "-dark" : ""}`,
          url: p.url,
          ok: false,
          error: String(err.message || err),
        });
      }
    }
  }

  await browser.close();

  console.log(JSON.stringify({ results, errors }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
