// Builds the two approved tables from what the site returned. Never adds up or recomputes points:
// the totals and cutoffs are copied from the calculator's result and IRCC's own draws data.
"use strict";

const LABELS = {
  q1: "Marital status", q2i: "Spouse citizen/PR", q2ii: "Spouse coming", q3: "Age",
  q4: "Education", q4b: "Canadian degree", q4c: "Canadian degree level",
  "q5i-a": "Test", "q5i-b-speaking": "Speaking", "q5i-b-listening": "Listening", "q5i-b-reading": "Reading", "q5i-b-writing": "Writing",
  q5ii: "Second language", "q5ii-sol-speaking": "Second language speaking", "q5ii-sol-listening": "Second language listening",
  "q5ii-sol-reading": "Second language reading", "q5ii-sol-writing": "Second language writing",
  q6i: "Canadian work", q6ii: "High-wage work", q6v: "Foreign work", q7: "Trade certificate", q8: "Job offer",
  q9: "Nomination", q10i: "Sibling", q10: "Spouse education", q11: "Spouse Canadian work", q12i: "Spouse language",
  "q12ii-fol-speaking": "Spouse speaking", "q12ii-fol-listening": "Spouse listening", "q12ii-fol-reading": "Spouse reading", "q12ii-fol-writing": "Spouse writing",
};
const SKIP = new Set(["q5i", "q6iii", "q6iv", "q8a"]); // folded into other rows (or left out of the approved layout)

const shortEducation = (t) => (/phd/i.test(t) ? "PhD" : t.split(/\s\(|,|\.\s/)[0].trim());
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const band = (t) => t.replace(/(\d)\s*-\s*(\d)/g, "$1–$2");

function scoreFor(id, P) {
  const k = id.split("-").pop();
  if (id.startsWith("q5i-b-")) return P.firstLanguage && P.firstLanguage[k];
  if (id.startsWith("q5ii-sol-")) return P.secondLanguage && P.secondLanguage[k];
  if (id.startsWith("q12ii-fol-")) return P.spouse && P.spouse.language && P.spouse.language[k];
  return undefined;
}

// readBack: [[id, selected option text], ...] in page order. P: profileUsed returned by the page script.
function inputRows(readBack, P) {
  const sel = Object.fromEntries(readBack);
  const rows = [];
  for (const [id, text] of readBack) {
    if (SKIP.has(id) || !LABELS[id]) continue;
    let v = text;
    if (id === "q3") v = (text.match(/^\d+/) || [text])[0] + (/or more/.test(text) ? "+" : /or less/.test(text) ? " or less" : "");
    else if (id === "q4" || id === "q10") v = shortEducation(text);
    else if (id === "q4c") v = text.split(/\s(?:OR|or)\s/)[0];
    else if (id === "q5ii" || id === "q12i") v = cap(text);
    else if (id === "q6ii") v = text === "Yes" ? (sel.q6iii === "Yes" ? "2×" : sel.q6iv === "Yes" ? "1.5×" : "1.3×") : "No";
    else if (id === "q8") v = text === "Yes" && sel.q8a ? `Yes, ${/twice/.test(sel.q8a) && !/1\.5/.test(sel.q8a) ? "2×" : /at least 1\.5/.test(sel.q8a) ? "1.5×" : "1.3×"}` : text;
    else {
      const s = scoreFor(id, P);
      if (s !== undefined && s !== null && !Number.isNaN(s)) {
        const b = band(text);
        v = b === String(s) ? b : `${b} (${s})`;
      }
    }
    rows.push([LABELS[id], v]);
  }
  return rows;
}

const stripScore = (v) => v.replace(/\s\(\d+(\.\d+)?\)$/, "");
const CHANGE_LABEL = { "High-wage work": "high-wage" };

function whatChanges(baseRows, rows) {
  const base = Object.fromEntries(baseRows);
  const parts = [];
  for (const [label, v] of rows) {
    if (base[label] === v) continue;
    if (label === "High-wage work" && v === "No" && base[label] === undefined) continue;
    const name = CHANGE_LABEL[label] || label;
    parts.push(`${parts.length ? name : cap(name)} ${stripScore(v)}`);
  }
  return parts.length ? parts.join("; ") : "—";
}

const shortDraw = (name) => name.replace(/\s+proficiency$/i, "");

function eligibleDraws(categories) {
  const yes = (categories || []).filter((c) => /^yes/i.test(c.eligible || ""));
  if (!yes.length) return "None";
  return yes
    .sort((a, b) => (Number(a.latestCutoff) || 1e9) - (Number(b.latestCutoff) || 1e9))
    .map((c) => {
      if (typeof c.latestCutoff !== "number") return `${shortDraw(c.category)} (${c.latestCutoff})`;
      const g = Number(c.yourGapToLatest);
      return `${shortDraw(c.category)} (${c.latestCutoff}, ${g >= 0 ? "+" : "−"}${Math.abs(g)})`;
    })
    .join("; ");
}

// docs: { rows: [{person, stage, document, status, link}], error } from lib/ircc-docs.js
function build(runs, date, docs, uploadLink) {
  const current = runs[0];
  const input = inputRows(current.readBack, current.result.profileUsed);
  const points = runs.map((r) => {
    const rows = inputRows(r.readBack, r.result.profileUsed);
    return [r.name, r === current ? "—" : whatChanges(input, rows), String(r.result.score), eligibleDraws(r.result.categories)];
  });
  const footer = `All totals from the official IRCC calculator on ${date}.`;
  const documents = (docs && docs.rows) || [];
  const docsError = docs && docs.error;
  return { input, points, documents, docsError, footer, uploadLink: uploadLink || UPLOAD_LINK, subject: `Express Entry CRS – ${date}: current ${current.result.score}` };
}

// Where to upload missing documents: the Claude chat that files them into Drive and updates the checklists.
// config.json can override it with "uploadLink".
const UPLOAD_LINK = "https://claude.ai/code/session_01Rma43uxtwEBcek9TmUQu2j";
const uploadNote = (link) => `To add a document, upload it in the Express Entry Claude chat: ${link} . Claude saves it to the right Drive folder, and it drops off this list in the next email.`;

// ---------- Rendering ----------
const DOC_HEAD = ["Person", "Stage", "Document (IRCC wording)", "Status", "IRCC page"];
const DOC_SOURCE = "List read live from IRCC's \"Get your documents ready\" and \"Apply for permanent residence\" pages. After an invitation, the personalized checklist in your IRCC account is the final word.";
const docText = (rep) => rep.docsError ? `Couldn't read IRCC's document pages today: ${rep.docsError}`
  : rep.documents.length ? null : "Nothing missing: every document on IRCC's list that applies to you has a file in Drive.";
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/high-wage/g, "high&#8209;wage");

function toText(rep) {
  const table = (head, rows) => {
    const all = [head, ...rows];
    const w = head.map((_, i) => Math.max(...all.map((r) => String(r[i]).length)));
    const line = (r) => "| " + r.map((c, i) => String(c).padEnd(w[i])).join(" | ") + " |";
    return [line(head), "|" + w.map((n) => "-".repeat(n + 2)).join("|") + "|", ...rows.map(line)].join("\n");
  };
  return [
    "1. Input (current profile)", "", table(["Question", "Value sent"], rep.input), "",
    "2. Points", "", table(["Scenario", "What changes", "Site total", "Eligible draws (latest cutoff)"], rep.points), "",
    "3. Documents to collect", "",
    docText(rep) || table(DOC_HEAD, rep.documents.map((d) => [d.person, d.stage, d.document, d.status, d.link])), "",
    DOC_SOURCE, "",
    uploadNote(rep.uploadLink), "",
    rep.footer,
  ].join("\n");
}

// Dark theme: colours are inline and repeated as bgcolor attributes so Gmail and other mail apps keep them.
const THEME = { page: "#1e2228", head: "#2d333b", cell: "#22272e", border: "#444c56", text: "#e6edf3", muted: "#9da7b3" };

function toHtml(rep) {
  const T = THEME;
  const font = "font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.4";
  const th = `border:1px solid ${T.border};padding:6px 10px;background:${T.head};color:${T.text};text-align:left;${font}`;
  const td = `border:1px solid ${T.border};padding:6px 10px;vertical-align:top;background:${T.cell};color:${T.text};${font}`;
  // nowrap: columns that should never break across lines (scenario name, site total)
  const table = (head, rows, nowrap = []) =>
    `<table cellpadding="0" cellspacing="0" bgcolor="${T.cell}" style="border-collapse:collapse;margin-bottom:18px;background:${T.cell}">` +
    `<tr>${head.map((h, i) => `<th bgcolor="${T.head}" style="${th}${nowrap.includes(i) ? ";white-space:nowrap" : ""}">${esc(h)}</th>`).join("")}</tr>` +
    rows.map((r) => `<tr>${r.map((c, i) => `<td bgcolor="${T.cell}" style="${td}${nowrap.includes(i) ? ";white-space:nowrap" : ""}">${cell(c)}</td>`).join("")}</tr>`).join("") +
    `</table>`;
  const cell = (c) => (c && typeof c === "object" && c.href ? `<a href="${esc(c.href)}" style="color:#58a6ff;text-decoration:underline">${esc(c.label)}</a>` : esc(c));
  const h3 = (t) => `<h3 style="margin:0 0 8px;color:${T.text};${font};font-size:16px">${esc(t)}</h3>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${T.page}" style="background:${T.page};color:${T.text}">` +
    `<tr><td bgcolor="${T.page}" style="padding:20px;background:${T.page};color:${T.text};${font}">` +
    h3("1. Input (current profile)") + table(["Question", "Value sent"], rep.input) +
    h3("2. Points") + table(["Scenario", "What changes", "Site total", "Eligible draws (latest cutoff)"], rep.points, [0, 2]) +
    h3("3. Documents to collect") +
    (docText(rep) ? `<p style="margin:0 0 18px;color:${T.text};${font}">${esc(docText(rep))}</p>`
      : table(DOC_HEAD, rep.documents.map((d) => [d.person, d.stage, d.document, d.status, { href: d.link, label: "Open" }]), [0, 1, 4])) +
    `<p style="margin:0 0 12px;color:${T.muted};${font}">${esc(DOC_SOURCE)}</p>` +
    `<p style="margin:0 0 18px;color:${T.text};${font}">To add a document, upload it in the ` +
    `<a href="${esc(rep.uploadLink)}" style="color:#58a6ff;text-decoration:underline">Express Entry Claude chat</a>. ` +
    `Claude saves it to the right Drive folder, and it drops off this list in the next email.</p>` +
    `<p style="margin:0;color:${T.muted};${font}">${esc(rep.footer)}</p>` +
    `</td></tr></table>`;
}

module.exports = { build, toText, toHtml, inputRows, whatChanges, eligibleDraws };
