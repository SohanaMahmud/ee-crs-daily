// TEST ONLY. Serves a stand-in for the canada.ca calculator, draws feed and category page, using the real
// page's field ids and option texts (captured 2026-11-14). The mock's "grand total" is made up; it only
// exists to test the pipeline (fill -> read back -> tables -> email). Real totals come from canada.ca.
"use strict";
const opts = (list) => list.map(([v, t]) => `<option value="${v}">${t}</option>`).join("");
const sel = (id, list, hidden) => `<div id="w-${id}" ${hidden ? 'style="display:none"' : ""}><label for="${id}">${id}</label><select id="${id}"><option value="badvalue">Select...</option>${opts(list)}</select></div>`;
const YN = [["A", "No"], ["B", "Yes"]];
const EDU = [["A", "None, or less than secondary (high school)"], ["B", "Secondary diploma (high school graduation)"], ["C", "One-year program at a university, college, trade or technical school, or other institute"], ["D", "Two-year program at a university, college, trade or technical school, or other institute"], ["E", "Bachelor's degree (three or more year program at a university, college, trade or technical school, or other institute)"], ["F", "Two or more certificates, diplomas or degrees. One must be for a program of three or more years"], ["G", "Master's degree, or professional degree needed to practice in a licensed profession (see Help)"], ["H", "Doctoral level university degree (PhD)"]];
const AGE = [["A", "17 years of age or less"], ...Array.from({ length: 27 }, (_, i) => [`x${i}`, `${18 + i} years of age`]), ["AC", "45 years of age or more"]];
const Y6 = [["A", "None or less than a year"], ["B", "1 year"], ["C", "2 years"], ["D", "3 years"], ["E", "4 years"], ["F", "5 years or more"]];
const TESTS = [["A", "CELPIP-G"], ["B", "IELTS"], ["E", "PTE Core"], ["C", "TEF Canada"], ["D", "TCF Canada"]];
const SPK = ["16-20", "14-15", "12-13", "10-11", "7-9", "6", "4-5", "0-3"].map((t, i) => [`s${i}`, t]);
const LIS = ["549-699", "523-548", "503-522", "458-502", "398-457", "369-397", "331-368", "0-330"].map((t, i) => [`l${i}`, t]);
const REA = ["549-699", "524-548", "499-523", "453-498", "406-452", "375-405", "342-374", "0-341"].map((t, i) => [`r${i}`, t]);

const PAGE = `<!doctype html><html><head><title>Mock calculator</title></head><body><main>
${sel("q1", [["A", "Annulled Marriage"], ["B", "Common-Law"], ["C", "Divorced / Separated"], ["D", "Legally Separated"], ["E", "Married"], ["F", "Never Married / Single"], ["G", "Widowed"]])}
${sel("q2i", YN, 1)}${sel("q2ii", YN, 1)}${sel("q3", AGE)}${sel("q4", EDU)}${sel("q4b", YN)}${sel("q4c", [["A", "Secondary (high school) or less"], ["B", "One- or two-year diploma or certificate"], ["C", "Degree, diploma or certificate of three years or longer OR a Master’s, professional or doctoral degree"]], 1)}
${sel("q5i", [["B", "No"], ["A", "Yes"]])}${sel("q5i-a", TESTS)}
${sel("q5i-b-speaking", SPK)}${sel("q5i-b-listening", LIS)}${sel("q5i-b-reading", REA)}${sel("q5i-b-writing", SPK)}
${sel("q5ii", [["A", "CELPIP-G"], ["B", "IELTS"], ["C", "PTE"], ["D", "not applicable"]])}
${sel("q6i", Y6)}${sel("q6ii", [["B", "Yes"], ["A", "No"]], 1)}${sel("q6iii", [["B", "Yes"], ["A", "No"]], 1)}${sel("q6iv", [["B", "Yes"], ["A", "No"]], 1)}
${sel("q6v", [["A", "None or less than a year"], ["B", "1 year"], ["C", "2 years"], ["D", "3 years or more"]])}
${sel("q7", YN)}${sel("q8", [["B", "Yes"], ["A", "No"]])}${sel("q8a", [["A", "A job offer in a high-wage occupation with at least twice the median wage"], ["B", "A job in a high-wage occupation with at least 1.5 times, but less than twice, the median wage"], ["C", "A job in a high-wage occupation with at least 1.3 times, but less than 1.5 times, the median wage"]], 1)}
${sel("q9", YN)}${sel("q10i", YN)}${sel("q10", EDU, 1)}${sel("q11", Y6, 1)}
${sel("q12i", [...TESTS, ["F", "not applicable"]], 1)}
<button id="submit" type="button">Calculate your score</button><div id="out"></div></main>
<script>
const $ = (id) => document.getElementById(id);
const show = (id, on) => { $("w-" + id).style.display = on ? "" : "none"; };
document.addEventListener("change", () => {
  const married = $("q1").value === "E" || $("q1").value === "B";
  show("q2i", married); show("q2ii", married);
  const spouse = married && $("q2i").value === "A" && $("q2ii").value === "B";
  ["q10", "q11", "q12i"].forEach((id) => show(id, spouse));
  show("q4c", $("q4b").value === "B");
  const can = $("q6i").value !== "A" && $("q6i").value !== "badvalue";
  ["q6ii", "q6iii", "q6iv"].forEach((id) => show(id, can));
  show("q8a", $("q8").value === "B");
});
$("submit").onclick = () => {
  const w = $("q5i-b-writing").selectedOptions[0].text;
  const french = ["16-20", "14-15", "12-13", "10-11"].includes(w) ? 50 : 0;
  const can = $("q6i").value === "B" ? 125 : 0;
  const total = 247 + (french ? 83 : 0) + can;
  $("out").innerText = "Core/Human capital factors\\nFrench-language skills = " + french + "\\nComprehensive Ranking System formula grand total = " + total + "\\nWhat is a CRS score";
};
</script></body></html>`;

const FEED = {
  rounds: [
    { drawNumber: "453", drawDate: "2026-10-28", drawName: "Transport Occupations, 2026-Version 2", drawSize: "150", drawCRS: "477", drawDistributionAsOn: "October 26, 2026", dd1: "500", dd2: "20,000", dd4: "8,000", dd5: "8,000", dd6: "8,000", dd7: "8,000", dd8: "8,000", dd10: "8,000", dd11: "8,000", dd12: "8,000", dd13: "8,000", dd14: "8,000", dd15: "40,000", dd16: "30,000", dd17: "10,000", dd18: "190,000" },
    { drawNumber: "452", drawDate: "2026-10-27", drawName: "French-Language proficiency 2026-Version 2", drawSize: "5,000", drawCRS: "407" },
    { drawNumber: "451", drawDate: "2026-10-26", drawName: "Provincial Nominee Program", drawSize: "792", drawCRS: "761" },
    { drawNumber: "449", drawDate: "2026-10-15", drawName: "Canadian Experience Class", drawSize: "2,500", drawCRS: "519" },
  ],
};

const CATS = `<html><body><main>
<section><h3>Who's eligible for the French-language proficiency category</h3><p>NCLC 7 in all four abilities.</p></section>
<section><h3>Who's eligible for the transport occupations category</h3><p>at least 6 months of continuous work experience in the past 3 years, in Canada or abroad</p>
<table><tbody><tr><td>Truck drivers</td><td>73300</td></tr></tbody></table></section>
</main></body></html>`;

module.exports = async (context) => {
  await context.route("https://www.canada.ca/**", (route) => {
    const u = route.request().url();
    if (u.includes("ee_rounds_123_en.json")) return route.fulfill({ contentType: "application/json", body: JSON.stringify(FEED) });
    if (u.includes("category-based-selection")) return route.fulfill({ contentType: "text/html", body: CATS });
    if (u.includes("check-score.html")) return route.fulfill({ contentType: "text/html", body: PAGE });
    return route.fulfill({ status: 404, body: "" });
  });
};
