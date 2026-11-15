/*
 * Page-side part of ee-crs-daily. Playwright injects this into IRCC's official CRS calculator page:
 *   https://www.canada.ca/en/immigration-refugees-citizenship/services/immigrate-canada/express-entry/check-score.html
 * It defines window.crsRunFromCsv(principalCsv, partnerCsv, overrides) and window.crsReadBack().
 * Same logic as crs_from_csv.js in the ee-draw-eligibility-calculator skill: it fills every question,
 * clicks the site's "Calculate your score" button and reads the site's own result. It never adds up points.
 * Nothing is guessed: if a required value is blank in the CSV, it stops and lists what's missing.
 */


(async () => {
  // ---------- CSV -> PROFILE ----------
  function parseCsv(text) {
    text = text.replace(/^\uFEFF/, "");
    const rows = []; let row = [], cell = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') q = false;
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === ",") { row.push(cell); cell = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(cell); rows.push(row); row = []; cell = "";
      } else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    const head = rows.shift().map((h) => h.trim().toLowerCase());
    const k = head.indexOf("key"), v = head.indexOf("value");
    if (k < 0 || v < 0) throw new Error('CSV needs "Key" and "Value" columns.');
    const map = {};
    for (const r of rows) if (r[k] && r[k].trim()) map[r[k].trim()] = (r[v] || "").trim();
    return map;
  }

  function profileFromCsv(principalText, partnerText, overrides = {}) {
    const A = { ...parseCsv(principalText), ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== "age")) };
    const B = partnerText && partnerText.trim() ? parseCsv(partnerText) : null;
    const missing = [], assumptions = [];
    const today = new Date();
    const req = (m, k, who = "main applicant") => { const x = m[k]; if (x === undefined || x === "") missing.push(`${who}: ${k}`); return x; };
    const num = (m, k, who) => { const x = req(m, k, who); return x === undefined || x === "" ? NaN : Number(x); };
    const yes = (m, k, who = "main applicant") => {
      const x = (m[k] || "").toLowerCase();
      if (!x) { assumptions.push(`${who}: ${k} is blank, treated as No`); return false; }
      return x === "yes" || x === "true" || x === "y";
    };
    const choice = (m, k, none = "none") => {
      const x = (m[k] || "").toLowerCase();
      if (!x) { assumptions.push(`main applicant: ${k} is blank, treated as ${none}`); return null; }
      return x === "none" ? null : x;
    };
    const ageOn = (dob) => { const d = new Date(dob + "T00:00:00"); let a = today.getFullYear() - d.getFullYear(); const m = today.getMonth() - d.getMonth(); if (m < 0 || (m === 0 && today.getDate() < d.getDate())) a--; return a; };
    const under2y = (date) => { const d = new Date(date + "T00:00:00"); const lim = new Date(today); lim.setFullYear(lim.getFullYear() - 2); return d >= lim; };
    const lang = (m, p, who, required) => {
      const test = m[`${p}_test`];
      if (!test) { if (required) missing.push(`${who}: ${p}_test`); return null; }
      return { test, speaking: num(m, `${p}_speaking`, who), listening: num(m, `${p}_listening`, who), reading: num(m, `${p}_reading`, who), writing: num(m, `${p}_writing`, who), date: req(m, `${p}_date`, who) };
    };

    const maritalStatus = req(A, "marital_status");
    const hasPartner = /married|common/i.test(maritalStatus || "");
    const partnerPR = hasPartner ? yes(A, "partner_canadian_or_pr") : false;
    const partnerComing = hasPartner ? yes(A, "partner_coming") : false;
    const dob = req(A, "date_of_birth");
    const age = overrides.age ?? (dob ? ageOn(dob) : NaN);
    const first = lang(A, "lang1", "main applicant", true);
    const second = lang(A, "lang2", "main applicant", false);
    const cred = (A.canadian_credential || "").toLowerCase();
    if (!cred) assumptions.push("main applicant: canadian_credential is blank, treated as none");

    const occupations = [];
    for (const i of [1, 2, 3, 4, 5]) {
      const noc = A[`job${i}_noc`];
      if (!noc) continue;
      const m3 = Number(A[`job${i}_months_last_3_years`]), mc = Number(A[`job${i}_months_in_canada_last_3_years`]);
      if (!A[`job${i}_months_last_3_years`]) missing.push(`main applicant: job${i}_months_last_3_years`);
      if (!A[`job${i}_months_in_canada_last_3_years`]) missing.push(`main applicant: job${i}_months_in_canada_last_3_years`);
      occupations.push({ noc, title: A[`job${i}_title`] || "", monthsLast3Years: m3, monthsInCanadaLast3Years: mc });
    }
    if (!occupations.length) assumptions.push("main applicant: no jobs listed, so occupation categories will show as not eligible");
    // Categories count months in one occupation, so jobs with the same NOC are added together
    const byNoc = {};
    for (const o of occupations) {
      const k = String(o.noc).padStart(5, "0");
      byNoc[k] ||= { noc: k, title: o.title, monthsLast3Years: 0, monthsInCanadaLast3Years: 0 };
      byNoc[k].monthsLast3Years += o.monthsLast3Years || 0;
      byNoc[k].monthsInCanadaLast3Years += o.monthsInCanadaLast3Years || 0;
    }

    let spouse = { education: "none", canadianWorkYears: 0, language: null };
    if (hasPartner && partnerComing && !partnerPR) {
      if (!B) missing.push("partner CSV (needed because the partner is coming and isn't a citizen or PR)");
      else {
        const pl = lang(B, "lang1", "partner", false);
        spouse = { education: req(B, "education_level", "partner"), canadianWorkYears: num(B, "canadian_work_years", "partner"), language: pl };
        if (!pl) assumptions.push("partner: no language test, so spouse language is 'not applicable'");
      }
    }

    const P = {
      maritalStatus, spouseIsCanadianOrPR: partnerPR, spouseComingWithYou: partnerComing, age,
      education: req(A, "education_level"),
      canadianCredential: !cred || cred === "none" ? null : cred,
      languageResultsUnder2Years: first && first.date ? under2y(first.date) : false,
      firstLanguage: first, secondLanguage: second,
      canadianWorkYears: num(A, "canadian_work_years"),
      canadianHighWage: choice(A, "canadian_high_wage"),
      foreignWorkYears: num(A, "foreign_work_years"),
      certificateOfQualification: yes(A, "certificate_of_qualification"),
      jobOffer: choice(A, "job_offer"),
      provincialNomination: yes(A, "provincial_nomination"),
      siblingInCanada: yes(A, "sibling_in_canada"),
      occupations: Object.values(byNoc),
      foreignSkilledMilitaryApplicant: (A.foreign_skilled_military_applicant || "").toLowerCase() === "yes",
      spouse,
    };
    if (first && first.date && !P.languageResultsUnder2Years) assumptions.push(`main applicant: language test from ${first.date} is more than 2 years old`);
    return { P, missing, assumptions };
  }

  // ---------- Fill the calculator, read the result, compare with draws ----------
  async function runCalculator(P) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const el = (id) => document.getElementById(id);
  const visible = (id) => { const e = el(id); return e && e.offsetParent !== null; };
  const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();

  async function setVal(id, value) {
    const e = el(id);
    if (!e) throw new Error(`Field ${id} not found — the page may have changed.`);
    e.value = value;
    e.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(150);
  }
  async function pickText(id, text) {
    const opts = [...el(id).options].filter((o) => o.value !== "badvalue");
    const t = norm(text);
    const o = opts.find((o) => norm(o.text) === t) || opts.find((o) => norm(o.text).startsWith(t)) || opts.find((o) => norm(o.text).includes(t));
    if (!o) throw new Error(`No option "${text}" in ${id}. Options: ${opts.map((o) => o.text).join(" | ")}`);
    await setVal(id, o.value);
  }
  const yesNo = (id, b) => pickText(id, b ? "Yes" : "No");
  async function pickScore(id, score) {
    const opts = [...el(id).options].filter((o) => o.value !== "badvalue");
    const o = opts.find((o) => {
      const nums = (o.text.replace(/^M,/, "").replace(/\s+/g, "").match(/\d+(\.\d+)?/g) || []).map(Number);
      if (nums.length === 1) return Math.abs(nums[0] - score) < 1e-9;
      if (nums.length === 2) return score >= nums[0] - 1e-9 && score <= nums[1] + 1e-9;
      return false;
    });
    if (!o) throw new Error(`Score ${score} doesn't fit any band in ${id}: ${opts.map((o) => o.text).join(" | ")}`);
    await setVal(id, o.value);
  }
  async function fillScores(prefix, L) {
    for (const k of ["speaking", "listening", "reading", "writing"]) await pickScore(`${prefix}-${k}`, L[k]);
  }

  const EDU = { none: "A", secondary: "B", "one-year": "C", "two-year": "D", bachelor: "E", "two-or-more": "F", master: "G", phd: "H" };
  const CAN_EDU = { secondary: "A", "1-2 year": "B", "3+ year": "C" };
  const YEARS6 = ["A", "B", "C", "D", "E", "F"];   // 0..5+
  const YEARS4 = ["A", "B", "C", "D"];             // 0..3+
  const JOB = { "2x": "A", "1.5x": "B", "1.3x": "C" };

  // 1–2 Marital status
  await pickText("q1", P.maritalStatus);
  if (visible("q2i")) await yesNo("q2i", P.spouseIsCanadianOrPR);
  if (visible("q2ii")) await yesNo("q2ii", P.spouseComingWithYou);

  // 3 Age
  const ageText = P.age <= 17 ? "17 years of age or less" : P.age >= 45 ? "45 years of age or more" : `${P.age} years of age`;
  await pickText("q3", ageText);

  // 4 Education
  await setVal("q4", EDU[P.education]);
  if (visible("q4b")) await yesNo("q4b", !!P.canadianCredential);
  if (P.canadianCredential && visible("q4c")) await setVal("q4c", CAN_EDU[P.canadianCredential]);

  // 5 Languages
  await yesNo("q5i", P.languageResultsUnder2Years);
  await pickText("q5i-a", P.firstLanguage.test);
  await fillScores("q5i-b", P.firstLanguage);
  if (visible("q5ii")) {
    if (P.secondLanguage) {
      await pickText("q5ii", P.secondLanguage.test.split(" ")[0]);
      await fillScores("q5ii-sol", P.secondLanguage);
    } else {
      await pickText("q5ii", "not applicable");
    }
  }

  // 6 Work experience
  await setVal("q6i", YEARS6[Math.min(P.canadianWorkYears, 5)]);
  if (visible("q6ii")) await yesNo("q6ii", !!P.canadianHighWage);
  if (visible("q6iii")) await yesNo("q6iii", P.canadianHighWage === "2x");
  if (visible("q6iv")) await yesNo("q6iv", P.canadianHighWage === "2x" || P.canadianHighWage === "1.5x");
  if (visible("q6v")) await setVal("q6v", YEARS4[Math.min(P.foreignWorkYears, 3)]);

  // 7–10 Additional
  if (visible("q7")) await yesNo("q7", P.certificateOfQualification);
  if (visible("q8")) await yesNo("q8", !!P.jobOffer);
  if (P.jobOffer && visible("q8a")) await setVal("q8a", JOB[P.jobOffer]);
  if (visible("q9")) await yesNo("q9", P.provincialNomination);
  if (visible("q10i")) await yesNo("q10i", P.siblingInCanada);

  // 11–13 Spouse
  if (visible("q10")) await setVal("q10", EDU[P.spouse.education]);
  if (visible("q11")) await setVal("q11", YEARS6[Math.min(P.spouse.canadianWorkYears, 5)]);
  if (visible("q12i")) {
    if (P.spouse.language) {
      await pickText("q12i", P.spouse.language.test);
      await fillScores("q12ii-fol", P.spouse.language);
    } else {
      await pickText("q12i", "not applicable");
    }
  }

  // Submit and read results
  el("submit").click();
  await sleep(1000);
  const text = document.querySelector("main").innerText;
  const start = text.indexOf("Core/Human capital factors");
  const end = text.indexOf("What is a CRS score", start);
  const breakdown = start >= 0 ? text.slice(start, end > 0 ? end : undefined).trim() : "(results not found — check the page for validation messages)";
  const total = (breakdown.match(/grand total\s*=\s*(\d+)/i) || [])[1];
  console.log(breakdown);
  console.log(`%cCRS TOTAL: ${total ?? "?"}`, "font-size:18px;font-weight:bold;color:#26374a");
  if (!total) return breakdown;

  // ---- Compare with the official rounds of invitations ----
  // Same data feed that powers the "Express Entry rounds of invitations" page on canada.ca
  const score = Number(total);
  const feed = await fetch("/content/dam/ircc/documents/json/ee_rounds_123_en.json").then((r) => r.json());
  const rounds = feed.rounds.map((r) => ({
    date: r.drawDate,
    category: ((s) => s.charAt(0).toUpperCase() + s.slice(1))(
      r.drawName.replace(/,?\s*\(?\d{4}-Version \d+\)?/i, "").replace(/\s*\(Version \d+\)/i, "").replace(/-/g, " ").replace(/\s+/g, " ").trim().toLowerCase()
    ),
    size: Number(String(r.drawSize).replace(/,/g, "")),
    cutoff: Number(r.drawCRS),
    raw: r,
  }));

  // ---- Live category rules from IRCC's "Category-based selection" page ----
  const catHtml = await fetch("/en/immigration-refugees-citizenship/services/immigrate-canada/express-entry/rounds-invitations/category-based-selection.html").then((r) => r.text());
  const catDoc = new DOMParser().parseFromString(catHtml, "text/html");
  const categories = [...catDoc.querySelectorAll("main h2, main h3, main h4")]
    .filter((h) => /who.s eligible for the .* category/i.test(h.textContent))
    .map((h) => {
      const sec = h.closest("section, details, div[id]") || h.parentElement;
      const txt = sec.textContent.replace(/\s+/g, " ");
      const name = h.textContent.replace(/.*eligible for the\s+/i, "").replace(/\s+category.*/i, "").trim();
      const table = sec.querySelector("table");
      const nocs = table ? [...table.querySelectorAll("tbody tr")].map((r) => r.cells[1]?.textContent.trim()).filter(Boolean) : [];
      return {
        name,
        nocs,
        months: Number((txt.match(/at least (\d+) months/i) || [])[1] || 0),
        years: Number((txt.match(/past (\d+) years/i) || [])[1] || 0),
        canadaOnly: !/in Canada or abroad/i.test(txt) && /\bin Canada\b/i.test(txt),
      };
    });

  const frenchBonus = Number((breakdown.match(/French-language skills\s*=\s*(\d+)/i) || [])[1] || 0);
  const checkCategory = (cat) => {
    const n = cat.name.toLowerCase();
    if (n.includes("french")) return frenchBonus > 0 ? "yes" : "no (needs NCLC 7+ in all four French skills)";
    if (n.includes("military")) return P.foreignSkilledMilitaryApplicant ? "check (FSMA + arranged employment with the Canadian Armed Forces)" : "no (Foreign Skilled Military Applicants only)";
    if (!cat.nocs.length) return "check rules on IRCC page";
    if (!(P.occupations || []).length) return "no (no jobs listed in the CSV)";
    const hit = (P.occupations || []).filter((o) => cat.nocs.includes(String(o.noc).padStart(5, "0")));
    if (!hit.length) return `no (your NOC isn't on this list of ${cat.nocs.length})`;
    const ok = hit.find((o) => (cat.canadaOnly ? o.monthsInCanadaLast3Years : o.monthsLast3Years) >= cat.months);
    if (ok) return `yes (NOC ${ok.noc}, ${cat.canadaOnly ? "Canadian " : ""}experience meets ${cat.months} months)`;
    const best = Math.max(...hit.map((o) => (cat.canadaOnly ? o.monthsInCanadaLast3Years : o.monthsLast3Years)));
    return `not yet (NOC listed; ${best} of ${cat.months} months${cat.canadaOnly ? " in Canada" : ""} in the last ${cat.years} years)`;
  };
  const KEYWORDS = ["french", "healthcare", "stem", "trade", "education", "transport", "physician", "senior manager", "researcher", "military"];
  const keyOf = (s) => KEYWORDS.find((k) => s.toLowerCase().replace("science, technology, engineering and math (stem)", "stem").includes(k));
  const categoryEligibility = Object.fromEntries(categories.map((c) => [keyOf(c.name), { category: c.name, eligible: checkCategory(c) }]));

  const eligibility = (drawCat) => {
    const c = drawCat.toLowerCase();
    if (c.includes("canadian experience")) return P.canadianWorkYears >= 1 ? "yes" : "no (needs 1 yr skilled Canadian work)";
    if (c.includes("provincial nominee")) return P.provincialNomination ? "yes" : "no (needs a nomination)";
    const k = keyOf(c);
    if (k && categoryEligibility[k]) return categoryEligibility[k].eligible;
    return "check program rules";
  };

  const since = new Date(); since.setFullYear(since.getFullYear() - 1);
  const recent = rounds.filter((r) => new Date(r.date) >= since);
  const byCat = {};
  for (const r of recent) (byCat[r.category] ||= []).push(r);
  const table = Object.entries(byCat).map(([category, rs]) => {
    rs.sort((a, b) => b.date.localeCompare(a.date));
    const cut = rs.map((r) => r.cutoff);
    const latest = rs[0];
    return {
      category,
      draws: rs.length,
      latestDate: latest.date,
      latestCutoff: latest.cutoff,
      lowest12mo: Math.min(...cut),
      highest12mo: Math.max(...cut),
      yourGapToLatest: score - latest.cutoff,
      wouldHaveBeenInvited: `${cut.filter((c) => score >= c).length} of ${rs.length}`,
      eligible: eligibility(category),
    };
  }).sort((a, b) => a.latestCutoff - b.latestCutoff);

  // Where you sit in the pool (latest published score distribution)
  const d = rounds[0].raw;
  const n = (k) => Number(String(d[k] || "0").replace(/,/g, ""));
  const bands = [ // [low, high, key]
    [601, 1200, "dd1"], [501, 600, "dd2"], [491, 500, "dd4"], [481, 490, "dd5"], [471, 480, "dd6"], [461, 470, "dd7"], [451, 460, "dd8"],
    [441, 450, "dd10"], [431, 440, "dd11"], [421, 430, "dd12"], [411, 420, "dd13"], [401, 410, "dd14"], [351, 400, "dd15"], [301, 350, "dd16"], [0, 300, "dd17"],
  ];
  let above = 0;
  for (const [lo, hi, k] of bands) {
    if (score < lo) above += n(k);
    else if (score <= hi) above += Math.round(n(k) * (hi - score) / (hi - lo + 1)); // rough share of your own band
  }
  const poolTotal = n("dd18");

  // Categories with no draw in the last 12 months still get an eligibility line
  const categoryTable = Object.values(categoryEligibility).map((c) => {
    const k = keyOf(c.category);
    const drawn = table.find((t) => keyOf(t.category) === k);
    return { ...c, latestCutoff: drawn ? drawn.latestCutoff : "no draw in 12 months", yourGapToLatest: drawn ? drawn.yourGapToLatest : "" };
  });
  // Program-based draws (not categories, but the user wants them in the same table)
  for (const [label, re] of [["Canadian Experience Class", /experience class/i], ["Provincial Nominee Program", /nominee/i]]) {
    const drawn = table.find((t) => re.test(t.category));
    categoryTable.unshift({
      category: label,
      eligible: eligibility(label),
      latestCutoff: drawn ? drawn.latestCutoff : "no draw in 12 months",
      yourGapToLatest: drawn ? drawn.yourGapToLatest : "",
    });
  }

  console.log(`%cCategory eligibility (live rules from IRCC)`, "font-size:14px;font-weight:bold");
  console.table(categoryTable);
  console.log(`%cRecent rounds (last 12 months) vs your score of ${score}`, "font-size:14px;font-weight:bold");
  console.table(table);
  console.log(`Pool on ${d.drawDistributionAsOn}: ~${above.toLocaleString()} of ${poolTotal.toLocaleString()} candidates (~${Math.round(100 * above / poolTotal)}% of the pool) score higher than you.`);
  return { score, breakdown: breakdown.replace(/\n\n+/g, "\n"), categories: categoryTable, rounds: table, pool: { asOf: d.drawDistributionAsOn, candidatesAbove: above, total: poolTotal } };
  }

  async function run(principalText, partnerText, overrides) {
    const { P, missing, assumptions } = profileFromCsv(principalText, partnerText, overrides);
    if (missing.length) {
      const msg = "Can't run yet. These values are blank in the CSV:\n- " + missing.join("\n- ");
      console.warn(msg);
      return { status: "missing values", missing, assumptions };
    }
    const result = await runCalculator(P);
    if (assumptions.length) console.warn("Assumptions:\n- " + assumptions.join("\n- "));
    return typeof result === "object" ? { ...result, profileUsed: P, assumptions } : { status: "no result", detail: result, assumptions };
  }

  window.crsRunFromCsv = run;
  // Read the form back: every visible question with the option the site has selected, in page order
  window.crsReadBack = () => [...document.querySelectorAll("main select")]
    .filter((s) => s.offsetParent !== null && s.value && s.value !== "badvalue")
    .map((s) => [s.id, s.options[s.selectedIndex].text.trim()]);
  window.crsReady = true;
})();
