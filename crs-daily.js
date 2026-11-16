#!/usr/bin/env node
/*
 * ee-crs-daily: runs IRCC's official CRS calculator for the current profile and every combination of
 * future plans, then emails the two approved tables. No Claude, no Claude app: Node + Playwright only.
 *
 *   node crs-daily.js            run and email
 *   node crs-daily.js --dry-run  run and print the tables (no email); also writes last-report.html
 *   node crs-daily.js --show     like --dry-run, with the browser window visible
 *
 * Every total comes from the site's own "Calculate your score" result. Nothing is added up here.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const nodemailer = require("nodemailer");
const { loadInputs, combinations, ageOn } = require("./lib/inputs");
const report = require("./lib/report");
const irccDocs = require("./lib/ircc-docs");

const CALCULATOR = "https://www.canada.ca/en/immigration-refugees-citizenship/services/immigrate-canada/express-entry/check-score.html";
const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry-run") || args.has("--show");
const HERE = __dirname;
const config = JSON.parse(fs.readFileSync(process.env.CRS_CONFIG || path.join(HERE, "config.json"), "utf8"));
const PAGE_SCRIPT = fs.readFileSync(path.join(HERE, "lib", "page-script.js"), "utf8");
const TZ = config.timeZone || "America/Toronto";
const today = new Date().toLocaleDateString("en-CA", { timeZone: TZ }); // YYYY-MM-DD

const log = (...a) => console.log(new Date().toISOString(), ...a);

async function runScenario(context, inputs, overrides) {
  const page = await context.newPage();
  try {
    await page.goto(CALCULATOR, { waitUntil: "load", timeout: 90000 });
    await page.waitForSelector("#q1", { timeout: 60000 });
    await page.evaluate(PAGE_SCRIPT); // injected like DevTools would, so the page's script policy can't block it
    await page.waitForFunction(() => window.crsReady === true, null, { timeout: 15000 });
    const result = await page.evaluate(
      ([a, b, o]) => window.crsRunFromCsv(a, b, o),
      [inputs.principalCsv, inputs.partnerCsv, overrides]
    );
    if (result && result.status === "missing values") throw new Error("Blank in the profile CSV: " + result.missing.join(", "));
    if (!result || !result.score) throw new Error("The calculator gave no total (" + ((result && result.detail) || "no result") + ")");
    const readBack = await page.evaluate(() => window.crsReadBack());
    return { result, readBack };
  } finally {
    await page.close();
  }
}

function transport() {
  const m = config.mail;
  return nodemailer.createTransport({ host: m.host || "smtp.gmail.com", port: m.port || 465, secure: m.secure !== false, auth: { user: m.user, pass: String(m.appPassword).replace(/\s+/g, "") } });
}

async function send(subject, text, html) {
  const m = config.mail;
  await transport().sendMail({ from: m.from || m.user, to: m.to.join(", "), subject, text, html });
}

async function main() {
  log("Loading profiles and plans");
  const inputs = await loadInputs(config.source);
  if (!inputs.dob) throw new Error("date_of_birth is blank in the principal applicant's CSV.");

  const scenarios = [{ name: "Current", overrides: { age: ageOn(inputs.dob, today) } }];
  for (const combo of combinations(inputs.plans)) {
    const dates = combo.map((p) => p.targetDate).filter(Boolean).sort();
    const on = dates.length ? dates[dates.length - 1] : today; // age on the latest target date in the combination
    scenarios.push({
      name: (combo.length > 1 ? "Plans " : "Plan ") + combo.map((p) => p.number).join("+"),
      overrides: Object.assign({}, ...combo.map((p) => p.overrides), { age: ageOn(inputs.dob, on < today ? today : on) }),
    });
  }

  const browser = await chromium.launch({
    headless: !args.has("--show") && config.browser?.headless !== false,
    channel: config.browser?.channel || undefined,          // "chrome" uses your installed Google Chrome
    executablePath: config.browser?.executablePath || undefined,
  });
  const context = await browser.newContext({ locale: "en-CA", timezoneId: TZ, bypassCSP: true });
  if (process.env.CRS_TEST_ROUTES) await require(path.resolve(process.env.CRS_TEST_ROUTES))(context); // tests only
  const runs = [];
  let docs;
  try {
    for (const s of scenarios) {
      log(`Running ${s.name} on the official calculator`, JSON.stringify(s.overrides));
      const r = await runScenario(context, inputs, s.overrides);
      log(`${s.name}: site total ${r.result.score}`);
      runs.push({ name: s.name, ...r });
    }
    // Table 3: IRCC's official document lists, read live, checked against the Drive folders.
    // A problem here doesn't stop the email: table 3 then says what went wrong.
    try {
      log("Reading IRCC's document lists");
      const page = await context.newPage();
      const lists = await irccDocs.readIrccLists(page);
      await page.close();
      if (!lists.profile.length || !lists.after.length) throw new Error("the lists weren't found on IRCC's pages (the pages may have changed)");
      log(`IRCC lists: ${lists.profile.length} profile items, ${lists.after.length} after-invitation items`);
      docs = { rows: await irccDocs.documentsToCollect(lists, inputs.household, inputs.lister) };
    } catch (e) {
      log("Documents table:", e.message);
      docs = { rows: [], error: e.message };
    }
  } finally {
    await browser.close();
  }

  const rep = report.build(runs, today, docs, config.uploadLink);
  const text = report.toText(rep), html = report.toHtml(rep);
  fs.writeFileSync(path.join(HERE, "last-report.html"), html);
  if (DRY) {
    console.log("\n" + rep.subject + "\n\n" + text);
    return;
  }
  await send(rep.subject, text, html);
  log("Email sent to " + config.mail.to.join(", "));
}

main().catch(async (e) => {
  log("FAILED:", e && e.stack ? e.stack : e);
  if (!DRY && config.mail) {
    try {
      await send(`Express Entry CRS – ${today}: check didn't run`, `The daily CRS check couldn't run today: ${e.message || e}`);
    } catch (e2) {
      log("Could not send the failure email either:", e2.message);
    }
  }
  process.exit(1);
});
