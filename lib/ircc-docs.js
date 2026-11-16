// Table 3 "Documents to collect", built on every run from IRCC's own pages (nothing hand-written):
//   1. read IRCC's official document lists (profile stage + after an invitation) from canada.ca,
//   2. keep the items that apply to this household (from the profile CSVs),
//   3. look in each person's Drive folders for a matching file,
//   4. list what's still missing, each with the IRCC page it came from.
// IRCC's personalized checklist (shown in the IRCC account after an invitation) is the final word.
"use strict";

const BASE = "https://www.canada.ca/en/immigration-refugees-citizenship/services/immigrate-canada/express-entry/";
const PAGES = {
  profile: BASE + "documents.html",                   // "Get your documents ready"
  after: BASE + "apply-permanent-residence.html",     // "Apply for permanent residence" > "Upload your documents"
};

// Runs inside a canada.ca page (Playwright page.evaluate). Returns IRCC's two lists exactly as published.
async function readIrccLists(page) {
  await page.goto(PAGES.profile, { waitUntil: "load", timeout: 90000 });
  return page.evaluate(async ([profileUrl, afterUrl]) => {
    const ownText = (li) => {
      const c = li.cloneNode(true);
      c.querySelectorAll("ul, ol, p, details, div, section").forEach((e) => e.remove());
      return c.textContent.replace(/\s+/g, " ").trim();
    };
    const abs = (h, page) => (h ? new URL(h, location.origin).href : page);
    const load = async (u) => new DOMParser().parseFromString(await (await fetch(u)).text(), "text/html");
    const listAfter = (doc, re) => {
      const p = [...doc.querySelectorAll("main p")].find((x) => re.test(x.textContent));
      let ul = p;
      while (ul && ul.tagName !== "UL") ul = ul.nextElementSibling;
      return ul ? [...ul.children] : [];
    };
    const d1 = await load(profileUrl);
    const profile = listAfter(d1, /information from some or all of these documents/i).map((li) => ({
      text: ownText(li), link: abs(li.querySelector("a") && li.querySelector("a").getAttribute("href"), profileUrl),
    }));
    const d2 = await load(afterUrl);
    const after = listAfter(d2, /most applicants will also need to upload/i).map((li) => ({
      text: ownText(li), link: abs(li.querySelector("a") && li.querySelector("a").getAttribute("href"), afterUrl + "#documents"),
    }));
    // The medical exam is its own step on the same page ("Get a medical exam, if you need one")
    const mh = [...d2.querySelectorAll("main h3")].find((h) => /medical exam/i.test(h.textContent));
    const ma = mh && mh.nextElementSibling && mh.nextElementSibling.querySelector("a");
    if (ma) after.push({ text: ma.textContent.replace(/\s+/g, " ").trim(), link: abs(ma.getAttribute("href"), afterUrl) });
    return { profile, after };
  }, [PAGES.profile, PAGES.after]);
}

const yes = (v) => /^(yes|true|y)$/i.test(String(v || "").trim());
const has = (v) => !!String(v || "").trim() && !/^(none|no)$/i.test(String(v).trim());

// How each IRCC item maps to this household: who it's for, when it applies, and where its file lives in Drive.
// loc: { folder: <number of the person's numbered subfolder> } or { shared: "" | "Proof of funds" | "Children" }
// file: regex the file name must match (null = any file in that folder)
function rulesFor(ctx) {
  const { P, principal, partner, hasChildren } = ctx;
  const adults = [principal, partner].filter(Boolean);
  const marital = String(P.marital_status || "").toLowerCase();
  const cec = Number(P.canadian_work_years) >= 1;
  return [
    { re: /passport|travel document/i, people: [...adults, hasChildren && "Children"], loc: (w) => (w === "Children" ? { shared: "Children" } : { folder: 1 }), file: /passport/i },
    { re: /language test/i, people: [principal], loc: () => ({ folder: 3 }), file: null },
    { re: /educational credential|canadian education/i, people: [principal], loc: () => ({ folder: 2 }), file: /ECA|WES|credential|assessment/i },
    { re: /job offer/i, people: has(P.job_offer) ? [principal] : [], loc: () => ({ folder: 5 }), file: /offer/i },
    { re: /work experience/i, people: [principal], loc: () => ({ folder: 4 }), file: null },
    { re: /certificate of qualification/i, people: yes(P.certificate_of_qualification) ? [principal] : [], loc: () => ({ folder: 5 }), file: /qualification/i },
    { re: /proof of funds/i, people: cec || has(P.job_offer) ? [] : ["Shared"], loc: () => ({ shared: "Proof of funds" }), file: null },
    { re: /police certificate/i, people: adults, loc: () => ({ folder: 7 }), file: null },
    { re: /provincial nomination/i, people: yes(P.provincial_nomination) ? [principal] : [], loc: () => ({ folder: 5 }), file: /nomination/i },
    { re: /birth certificate/i, people: hasChildren ? ["Children"] : [], loc: () => ({ shared: "Children" }), file: /birth/i },
    { re: /representative|IMM 5476/i, people: yes(P.representative) ? ["Shared"] : [], loc: () => ({ shared: "" }), file: /5476|representative/i },
    { re: /common-law|IMM 5409/i, people: /common/.test(marital) ? ["Shared"] : [], loc: () => ({ shared: "" }), file: /5409|common.?law/i },
    { re: /marriage certificate/i, people: /married/.test(marital) ? ["Shared"] : [], loc: () => ({ shared: "" }), file: /marriage/i },
    { re: /divorce/i, people: /divorc|separat/.test(marital) ? ["Shared"] : [], loc: () => ({ shared: "" }), file: /divorce|separation/i },
    { re: /death certificate/i, people: /widow/.test(marital) ? ["Shared"] : [], loc: () => ({ shared: "" }), file: /death/i },
    { re: /adoption/i, people: yes(P.adopted_child) ? ["Children"] : [], loc: () => ({ shared: "Children" }), file: /adopt/i },
    { re: /medical exam/i, people: [...adults, hasChildren && "Children"], loc: (w) => (w === "Children" ? { shared: "Children" } : { folder: 8 }), file: /medical|IME/i },
  ].map((r) => ({ ...r, people: r.people.filter(Boolean) }));
}

const tidy = (t) => {
  const s = t.replace(/\s*if:\s*$/i, "").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

// lister.list(person, loc) -> array of file names, or null if the folder can't be read
async function documentsToCollect(lists, ctx, lister) {
  const rules = rulesFor(ctx);
  const rows = [], seen = new Set();
  const items = [
    ...lists.profile.map((i) => ({ ...i, stage: "Profile" })),
    ...lists.after.map((i) => ({ ...i, stage: "After invitation" })),
  ];
  for (const item of items) {
    const rule = rules.find((r) => r.re.test(item.text));
    if (!rule) {
      // IRCC added something new: show it so it gets looked at
      rows.push({ person: "All", stage: item.stage, document: tidy(item.text), status: "New on IRCC's list – check", link: item.link });
      continue;
    }
    for (const person of rule.people) {
      const key = `${person}|${rule.re}`;
      if (seen.has(key)) continue; // e.g. police certificates and proof of funds appear in both lists
      seen.add(key);
      const files = await lister.list(person, rule.loc(person));
      let status;
      if (files === null) status = "Can't check (no access to its Drive folder)";
      else if (!files.some((f) => !rule.file || rule.file.test(f))) status = "Missing";
      else continue; // a matching file is in Drive
      rows.push({ person, stage: item.stage, document: tidy(item.text), status, link: item.link });
    }
  }
  const order = (p) => (p === ctx.principal ? 0 : p === ctx.partner ? 1 : p === "Shared" ? 2 : p === "Children" ? 3 : 4);
  rows.sort((a, b) => (a.stage === b.stage ? 0 : a.stage === "Profile" ? -1 : 1) || order(a.person) - order(b.person));
  return rows;
}

module.exports = { PAGES, readIrccLists, documentsToCollect };
