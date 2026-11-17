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
// Each person's folder is self-sufficient: numbered subfolders "1 - Identity" ... "11 - Marriage certificate",
// "12 - Proof of funds", "13 - Children". There is no household folder outside the people's folders.
const personName = (specOrPath) => path.basename(typeof specOrPath === "string" ? specOrPath : specOrPath.name).split("_EE_")[0];
const isNumbered = (name, n) => new RegExp("^" + n + "\\s*-").test(name);

async function readLocal(cfg) {
  const read = (p) => (p ? fs.readFileSync(expand(p), "utf8") : "");
  const dirs = { [personName(cfg.principal)]: path.dirname(expand(cfg.principal)) };
  if (cfg.partner) dirs[personName(cfg.partner)] = path.dirname(expand(cfg.partner));
  const ls = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return null; } };
  const sub = (person, n) => {
    const kids = dirs[person] ? ls(dirs[person]) : null;
    if (!kids) return null;
    const f = kids.find((k) => k.isDirectory() && isNumbered(k.name, n));
    return f ? path.join(dirs[person], f.name) : "";
  };
  const lister = {
    // true/false: does the person's folder have subfolder "n - ..."? null: person's folder not readable
    async hasFolder(person, n) { const d = sub(person, n); return d === null ? null : !!d; },
    // loc: { folder: N, owner? } -> file names in the owner's (default: the person's) "N - ..." subfolder
    async list(person, loc) {
      const dir = sub(loc.owner || person, loc.folder);
      if (dir === null) return null;
      if (!dir) return [];
      const files = ls(dir);
      return files ? files.filter((k) => k.isFile()).map((k) => k.name) : null;
    },
  };
  return { principal: read(cfg.principal), partner: read(cfg.partner), plans: read(cfg.plans), lister };
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
  // Folder listing for table 3 (returns null when the service account can't see the folder)
  const cache = new Map();
  async function children(id) {
    if (!id) return null;
    if (cache.has(id)) return cache.get(id);
    let out = null;
    try {
      // A search over a folder we can't see just returns nothing, so first check we can open the folder itself
      await client.request({ url: `${api}/${id}`, params: { fields: "id", supportsAllDrives: true } });
      const res = await client.request({ url: api, params: { q: `'${id}' in parents and trashed = false`, fields: "files(id,name,mimeType)", pageSize: 1000, supportsAllDrives: true, includeItemsFromAllDrives: true } });
      out = res.data.files || [];
    } catch (e) { out = null; }
    cache.set(id, out);
    return out;
  }
  const isFolder = (f) => f.mimeType === "application/vnd.google-apps.folder";
  const personFolder = { [personName(cfg.principal)]: cfg.principal.folderId };
  if (cfg.partner) personFolder[personName(cfg.partner)] = cfg.partner.folderId;
  async function sub(person, n) {
    const kids = await children(personFolder[person]);
    if (!kids) return null;
    const f = kids.find((k) => isFolder(k) && isNumbered(k.name, n));
    return f ? f.id : "";
  }
  const lister = {
    async hasFolder(person, n) { const id = await sub(person, n); return id === null ? null : !!id; },
    async list(person, loc) {
      const id = await sub(loc.owner || person, loc.folder);
      if (id === null) return null;
      if (!id) return [];
      const files = await children(id);
      return files ? files.filter((f) => !isFolder(f)).map((f) => f.name) : null;
    },
  };
  return { principal: await get(cfg.principal), partner: await get(cfg.partner), plans: await get(cfg.plans), lister };
}

const profileMap = (text) => Object.fromEntries(rowsToObjects(text).filter((r) => r.Key).map((r) => [r.Key, r.Value]));

async function loadInputs(source) {
  const raw = source.type === "drive" ? await readDrive(source) : await readLocal(source);
  if (!raw.principal) throw new Error("The principal applicant's profile CSV is empty or missing.");
  const P = profileMap(raw.principal);
  // Children: the profile's dependent_children count if it has one, otherwise a "13 - Children" folder in the principal's folder
  let hasChildren;
  if (String(P.dependent_children || "").trim() !== "") hasChildren = Number(P.dependent_children) > 0;
  else hasChildren = (await raw.lister.hasFolder(personName(source.principal), 13)) !== false; // unknown (no access) counts as yes, so nothing is hidden
  return {
    principalCsv: keyValueCsv(raw.principal),
    partnerCsv: raw.partner ? keyValueCsv(raw.partner) : "",
    dob: P.date_of_birth || "",
    plans: parsePlans(raw.plans),
    household: { P, S: raw.partner ? profileMap(raw.partner) : null, principal: personName(source.principal), partner: source.partner ? personName(source.partner) : null, hasChildren },
    lister: raw.lister,
  };
}

module.exports = { rowsToObjects, loadInputs, parsePlans, parseOverride, combinations, ageOn, keyValueCsv, parseCsvRows };
