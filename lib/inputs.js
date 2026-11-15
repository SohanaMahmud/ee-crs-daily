// Loads the profile and plan CSVs, either from local files (for example a Google Drive for Desktop folder)
// or straight from Google Drive with a service account. Parses plans into calculator scenarios.
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");

function expand(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

// RFC 4180 CSV parser (quotes, doubled quotes, CRLF, BOM)
function parseCsvRows(text) {
  text = text.replace(/^﻿/, "");
  const rows = [];
  let row = [], cell = "", q = false;
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
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

function rowsToObjects(text) {
  const rows = parseCsvRows(text);
  const head = rows.shift().map((h) => h.trim());
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] || "").trim()])));
}

// Only the Key and Value columns go to the calculator script
function keyValueCsv(text) {
  const objs = rowsToObjects(text);
  if (!objs.length || !("Key" in objs[0]) || !("Value" in objs[0])) throw new Error('Profile CSV needs "Key" and "Value" columns.');
  const esc = (s) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return "Key,Value\n" + objs.filter((o) => o.Key).map((o) => `${esc(o.Key)},${esc(o.Value)}`).join("\n") + "\n";
}

function profileValue(text, key) {
  const o = rowsToObjects(text).find((r) => r.Key === key);
  return o ? o.Value : "";
}

// "lang1_writing = 10; canadian_high_wage = 1.5x"  ->  { lang1_writing: "10", canadian_high_wage: "1.5x" }
function parseOverride(s) {
  const out = {};
  for (const part of String(s || "").split(/[;\n]/)) {
    const m = part.match(/^\s*([a-z0-9_]+)\s*[=:]\s*(.*?)\s*$/i);
    if (m && m[2] !== "") out[m[1]] = m[2];
  }
  return out;
}

function parsePlans(text) {
  if (!text || !text.trim()) return [];
  return rowsToObjects(text)
    .map((r) => ({
      number: r["#"] || "",
      plan: r["Plan"] || "",
      overrides: parseOverride(r["Calculator change (override)"]),
      targetDate: ((r["Target date"] || "").match(/\d{4}-\d{2}-\d{2}/) || [])[0] || null,
    }))
    .filter((p) => p.number && Object.keys(p.overrides).length);
}

// Every non-empty combination: each plan alone, then pairs, and so on up to all plans
function combinations(plans) {
  const out = [];
  const pick = (start, size, acc) => {
    if (acc.length === size) { out.push(acc.slice()); return; }
    for (let i = start; i < plans.length; i++) { acc.push(plans[i]); pick(i + 1, size, acc); acc.pop(); }
  };
  for (let size = 1; size <= plans.length; size++) pick(0, size, []);
  return out;
}

function ageOn(dob, onDate) {
  const [y, m, d] = dob.split("-").map(Number);
  const [Y, M, D] = onDate.split("-").map(Number);
  let a = Y - y;
  if (M < m || (M === m && D < d)) a--;
  return a;
}

// ---------- Sources ----------
// Evidence checklists sit next to each profile: X_EE_profile.csv -> X_EE_evidence_documents.csv
const evidenceName = (n) => n.replace(/_profile\.csv$/i, "_evidence_documents.csv");

async function readLocal(cfg) {
  const read = (p) => (p ? fs.readFileSync(expand(p), "utf8") : "");
  const evidence = (cfg.evidence || [cfg.principal, cfg.partner].filter(Boolean).map(evidenceName)).map((p) => {
    try { return read(p); } catch (e) { console.warn("Evidence checklist not found:", p); return ""; }
  });
  return { principal: read(cfg.principal), partner: read(cfg.partner), plans: read(cfg.plans), evidence };
}

async function readDrive(cfg) {
  const { GoogleAuth } = require("google-auth-library");
  const auth = new GoogleAuth({ keyFile: expand(cfg.serviceAccountKey), scopes: ["https://www.googleapis.com/auth/drive.readonly"] });
  const client = await auth.getClient();
  const api = "https://www.googleapis.com/drive/v3/files";
  async function get(spec) {
    if (!spec) return "";
    const q = `'${spec.folderId}' in parents and name = '${spec.name.replace(/'/g, "\\'")}' and trashed = false`;
    const list = await client.request({ url: api, params: { q, fields: "files(id,name,mimeType,modifiedTime)", orderBy: "modifiedTime desc", supportsAllDrives: true, includeItemsFromAllDrives: true } });
    const f = list.data.files && list.data.files[0];
    if (!f) throw new Error(`Drive: "${spec.name}" not found in folder ${spec.folderId} (is the folder shared with the service account?)`);
    const url = f.mimeType === "application/vnd.google-apps.spreadsheet" ? `${api}/${f.id}/export` : `${api}/${f.id}`;
    const params = f.mimeType === "application/vnd.google-apps.spreadsheet" ? { mimeType: "text/csv" } : { alt: "media", supportsAllDrives: true };
    const res = await client.request({ url, params, responseType: "text" });
    return typeof res.data === "string" ? res.data : String(res.data);
  }
  const evSpecs = cfg.evidence || [cfg.principal, cfg.partner].filter(Boolean).map((sp) => ({ folderId: sp.folderId, name: evidenceName(sp.name) }));
  const evidence = [];
  for (const sp of evSpecs) {
    try { evidence.push(await get(sp)); } catch (e) { console.warn("Evidence checklist not read:", e.message); evidence.push(""); }
  }
  return { principal: await get(cfg.principal), partner: await get(cfg.partner), plans: await get(cfg.plans), evidence };
}

async function loadInputs(source) {
  const raw = source.type === "drive" ? await readDrive(source) : await readLocal(source);
  if (!raw.principal) throw new Error("The principal applicant's profile CSV is empty or missing.");
  return {
    principalCsv: keyValueCsv(raw.principal),
    partnerCsv: raw.partner ? keyValueCsv(raw.partner) : "",
    dob: profileValue(raw.principal, "date_of_birth"),
    plans: parsePlans(raw.plans),
    evidence: (raw.evidence || []).filter(Boolean),
  };
}

module.exports = { rowsToObjects, loadInputs, parsePlans, parseOverride, combinations, ageOn, keyValueCsv, parseCsvRows };
