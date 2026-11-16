// Table 3 "Documents to collect", built on every run from IRCC's own pages (nothing hand-written):
//   1. read IRCC's official list of documents an Express Entry application must contain: the completeness-check
//      instructions IRCC officers use ("Mandatory documents for all applicants", "Mandatory documents (if
//      applicable)", "Other documents"; applications missing a mandatory one are rejected as incomplete),
//      plus "language test results" from the "Get your documents ready" page,
//   2. keep the documents that apply to this household (from the profile CSVs),
//   3. look in each person's Drive folders for a matching file,
//   4. list what's still missing or still needs a check, each with the IRCC page it came from.
// The personalized checklist in the IRCC account after an invitation is the final word.
"use strict";

const BASE = "https://www.canada.ca/en/immigration-refugees-citizenship/";
const PAGES = {
  completeness: BASE + "corporate/publications-manuals/operational-bulletins-manuals/permanent-residence/express-entry/applications-received-on-after-january-1-2016-completeness-check.html",
  profile: BASE + "services/immigrate-canada/express-entry/documents.html",
};

// Runs inside a canada.ca page. Returns IRCC's documents exactly as published.
async function readIrccLists(page) {
  await page.goto(PAGES.profile, { waitUntil: "load", timeout: 90000 });
  return page.evaluate(async ([completenessUrl, profileUrl]) => {
    const clean = (t) => t.replace(/\s+/g, " ").trim();
    const load = async (u) => new DOMParser().parseFromString(await (await fetch(u)).text(), "text/html");
    // Completeness check: H2 = group, H3 = document, H4 "Individuals who must submit this documentation" = who
    const d = await load(completenessUrl);
    const docs = [];
    let group = null, cur = null, inWho = false;
    for (const el of d.querySelectorAll("main *")) {
      if (el.tagName === "H2") { group = clean(el.textContent); cur = null; inWho = false; }
      else if (el.tagName === "H3" && group && /mandatory|other documents/i.test(group)) {
        cur = { group, title: clean(el.textContent), who: [], link: completenessUrl };
        docs.push(cur); inWho = false;
      } else if (el.tagName === "H4" && cur) inWho = /individuals who must submit/i.test(el.textContent);
      else if (el.tagName === "LI" && cur && inWho) cur.who.push(clean(el.textContent));
    }
    // "Get your documents ready": only used for the language test result, which the completeness list doesn't cover
    const p = await load(profileUrl);
    const lang = [...p.querySelectorAll("main li")].find((li) => /language test results/i.test(li.textContent));
    const langLink = lang && lang.querySelector("a") ? new URL(lang.querySelector("a").getAttribute("href"), location.origin).href : profileUrl;
    return { docs, language: lang ? { title: "Language test results", link: langLink } : null };
  }, [PAGES.completeness, PAGES.profile]);
}

const yes = (v) => /^(yes|true|y)$/i.test(String(v || "").trim());
const has = (v) => !!String(v || "").trim() && !/^(none|no|n\/a)$/i.test(String(v).trim());
const reEsc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// How each IRCC document maps to this household: who it's for (or that it doesn't apply), and where its file lives.
// loc: { folder: N } = the person's "N - ..." subfolder; { shared: "" | "Proof of funds" | "Children" }.
// An entry in `people` is a person's name, or { person, extra, file, test, status } for one check per employer, country...
function rulesFor(ctx) {
  const { P, S, principal, partner, hasChildren } = ctx;
  const adults = [principal, partner].filter(Boolean);
  const kids = hasChildren ? ["Children"] : [];
  const marital = String(P.marital_status || "").toLowerCase();
  const cec = Number(P.canadian_work_years) >= 1;
  const byKid = (w) => (w === "Children" ? { shared: "Children" } : null);

  // Proof of work experience: a reference/experience letter for each employer (jobN_letter_from: "Randstad; Hays"),
  // plus the self-employment proof IRCC lists for any job marked jobN_self_employed = Yes.
  const work = [];
  const employers = [...new Set([1, 2, 3, 4, 5].flatMap((i) => String(P[`job${i}_letter_from`] || "").split(";").map((e) => e.trim()).filter(Boolean)))];
  for (const e of employers) work.push({ person: principal, extra: `letter from ${e}`, file: new RegExp(`(letter|reference).*${reEsc(e)}|${reEsc(e)}.*(letter|reference)`, "i") });
  if (!employers.length) work.push(principal);
  for (const i of [1, 2, 3, 4, 5]) {
    if (!yes(P[`job${i}_self_employed`])) continue;
    work.push({ person: principal, extra: `job ${i} (self-employed): articles of incorporation or proof of business ownership`, file: /incorporat|business ownership/i });
    work.push({ person: principal, extra: `job ${i} (self-employed): proof of self-employment income`, file: /self.?employ.*income|income.*self.?employ|business income|T2125|T4A|notice of assessment/i });
    work.push({ person: principal, extra: `job ${i} (self-employed): third-party documents showing the service and payment details`, file: /invoice|statement of work|\bSOW\b|payment/i });
  }
  if (partner && S && Number(S.canadian_work_years) > 0) work.push({ person: partner, extra: "letter for Canadian work", file: /letter|reference/i });

  // Police certificates: one per country lived in 6+ months in a row in the last 10 years (not Canada), issued after
  // the last such stay. police_countries in each profile: "Bangladesh:2024-11-20; Kenya:2023-05-01" (country:end of
  // the last 6-month stay; no date = still living there). Without it, the row asks for the countries.
  const police = [];
  for (const [who, M] of [[principal, P], [partner, S]]) {
    if (!who) continue;
    const spec = String((M && M.police_countries) || "").trim();
    if (!spec) { police.push({ person: who, extra: "which countries and when did you last stay there? (each country 6+ months in a row in the last 10 years, except Canada)", status: "To confirm" }); continue; }
    for (const part of spec.split(";").map((x) => x.trim()).filter(Boolean)) {
      const [country, after] = part.split(":").map((x) => x.trim());
      police.push({
        person: who, extra: `${country}, issued ${after ? `after ${after}` : "in the last 6 months"}`,
        test: (f) => {
          if (!new RegExp(reEsc(country), "i").test(f)) return false;
          const d = (f.match(/(\d{4}-\d{2}-\d{2})/) || [])[1];
          if (!d) return false;
          if (after) return d > after;
          const six = new Date(); six.setMonth(six.getMonth() - 6);
          return d >= six.toISOString().slice(0, 10);
        },
      });
    }
  }

  return [
    { re: /medical exam/i, people: [...adults, ...kids], loc: (w) => byKid(w) || { folder: 8 }, file: /medical|IME|1017/i },
    { re: /police certificate/i, people: police, loc: () => ({ folder: 7 }), file: null },
    { re: /passport|travel document/i, people: [...adults, ...kids], loc: (w) => byKid(w) || { folder: 1 }, file: /passport/i },
    { re: /work experience/i, people: work, loc: () => ({ folder: 4 }), file: null },
    { re: /birth certificate/i, people: kids, loc: () => ({ shared: "Children" }), file: /birth/i },
    { re: /proof of studies/i, people: adults, loc: () => ({ folder: 2 }), file: /degree|diploma/i },
    { re: /certificate of qualification/i, people: yes(P.certificate_of_qualification) ? [principal] : [], loc: () => ({ folder: 5 }), file: /qualification/i },
    { re: /letter of offer|offer from the employer/i, people: has(P.job_offer) ? [principal] : [], loc: () => ({ folder: 5 }), file: /offer/i },
    { re: /proof of funds/i, people: cec || has(P.job_offer) ? [] : ["Shared"], loc: () => ({ shared: "Proof of funds" }), file: null },
    { re: /representative|IMM 5476/i, people: yes(P.representative) ? ["Shared"] : [], loc: () => ({ shared: "" }), file: /5476|representative/i },
    { re: /common-law/i, people: /common/.test(marital) ? ["Shared"] : [], loc: () => ({ shared: "" }), file: /5409|common.?law/i },
    { re: /marriage certificate/i, people: /married/.test(marital) ? ["Shared"] : [], loc: () => ({ shared: "" }), file: /marriage/i },
    { re: /divorce/i, people: /divorc|separat/.test(marital) ? ["Shared"] : [], loc: () => ({ shared: "" }), file: /divorce|separation/i },
    { re: /death certificate/i, people: /widow/.test(marital) ? ["Shared"] : [], loc: () => ({ shared: "" }), file: /death/i },
    { re: /adoption/i, people: yes(P.adopted_child) ? kids : [], loc: () => ({ shared: "Children" }), file: /adopt/i },
    { re: /relative in Canada/i, people: yes(P.sibling_in_canada) || yes(P.relative_in_canada) ? [principal] : [], loc: () => ({ folder: 5 }), file: /sibling|relative|brother|sister/i },
    { re: /digital photo/i, people: [...adults, ...kids], loc: (w) => byKid(w) || { folder: 10 }, file: (w) => (w === "Children" ? /photo/i : null) },
    { re: /other name/i, people: adults.filter((w) => yes(((w === principal ? P : S) || {}).other_name)), loc: () => ({ folder: 1 }), file: /name/i },
    { re: /IMM 5475|release personal information/i, people: [], loc: () => ({}), file: null },   // only if you designate someone
    { re: /not captured in other fields/i, people: [], loc: () => ({}), file: null },        // optional, at your discretion
    { re: /language test/i, people: [principal], loc: () => ({ folder: 3 }), file: null },
  ].map((r) => ({ ...r, people: r.people.filter(Boolean) }));
}

const GROUP = (g) => (/if applicable/i.test(g) ? "Mandatory if it applies" : /mandatory/i.test(g) ? "Mandatory" : /other/i.test(g) ? "Other (in the IRCC checklist)" : g);

// lister.list(person, loc) -> array of file names, or null if the folder can't be read
async function documentsToCollect(lists, ctx, lister) {
  const rules = rulesFor(ctx);
  const items = lists.docs.map((d) => ({ title: d.title, group: GROUP(d.group), link: d.link }));
  if (lists.language) items.push({ title: lists.language.title, group: "Mandatory", link: lists.language.link });
  const rows = [];
  for (const item of items) {
    const rule = rules.find((r) => r.re.test(item.title));
    if (!rule) {
      rows.push({ person: "All", stage: item.group, document: item.title, status: "New on IRCC's list – check", link: item.link });
      continue;
    }
    for (const who of rule.people) {
      const { person, extra, file, status: fixed, test } = typeof who === "string" ? { person: who } : who;
      const doc = item.title + (extra ? ` – ${extra}` : "");
      if (fixed) { rows.push({ person, stage: item.group, document: doc, status: fixed, link: item.link }); continue; }
      const pattern = file || (typeof rule.file === "function" ? rule.file(person) : rule.file);
      const files = await lister.list(person, rule.loc(person));
      let status;
      if (files === null) status = "Can't check (no access to its Drive folder)";
      else if (!files.some((f) => (test ? test(f) : !pattern || pattern.test(f)))) status = "Missing";
      else continue; // a matching file is in Drive
      rows.push({ person, stage: item.group, document: doc, status, link: item.link });
    }
  }
  const order = (p) => (p === ctx.principal ? 0 : p === ctx.partner ? 1 : p === "Shared" ? 2 : p === "Children" ? 3 : 4);
  const gOrder = (g) => (g === "Mandatory" ? 0 : /applies/.test(g) ? 1 : 2);
  rows.sort((a, b) => gOrder(a.stage) - gOrder(b.stage) || order(a.person) - order(b.person));
  return rows;
}

module.exports = { PAGES, readIrccLists, documentsToCollect, rulesFor };
