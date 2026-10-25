// Randomized comparison of web/casebook-guard.js with clinical-casebook's own anonymization check (docs/enhancement-plan.md 8.17):
// whatever Casebook's `lintAnonymization` calls an error, the guard must stop too (the guard may stop more).  Prints the misses; exit 1 if any.
//
//   cd <clinical-casebook の作業ツリー> && node --no-warnings <このリポジトリ>/scripts/compare_casebook_guard.mjs [乱数の種 1] [回数 40000]
//
// Run it from Casebook's worktree (so that its `zod` is found); Node 22 reads the TypeScript directly.  Use it after changing the guard, and
// after Casebook changes its rules.
const { lintAnonymization } = await import(`${process.cwd()}/packages/core/src/lint/anonymize.ts`);
const G = await import(new URL("../web/casebook-guard.js", import.meta.url).href);
const ctx = { dobMaxYear: 2008 };
let seed = Number(process.argv[2] ?? 1);
const COUNT = Number(process.argv[3] ?? 40000);
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const fw = (s) => s.replace(/[0-9]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
const kn = (n) => String(n).replace(/[0-9]/g, (c) => "〇一二三四五六七八九"[Number(c)]);
const num = (n, w = 0) => { let s = String(n).padStart(w, "0"); const r = rnd(); return r < 0.2 ? fw(s) : r < 0.3 ? kn(s) : s; };
const sepd = () => pick(["-", "/", ".", "‐", "－", "ー", " - ", " / ", "　"]);
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec","January","October","Sept"];
const ERA = ["令和","平成","昭和","R","H","S","r","h","s"];
const Y = () => pick([1950, 1988, 2000, 2024, 2025, 2026, 98, 25, 7]);
const M = () => pick([1, 2, 3, 9, 10, 12, 13]);
const D = () => pick([1, 4, 9, 12, 24, 29, 30, 31, 32]);
const gens = [
  () => `${num(Y(),4)}${sepd()}${num(M())}${sepd()}${num(D())}`,
  () => `${num(Y(),4)}${sepd()}${num(M())}`,
  () => `${num(Y(),4)}年${num(M())}月${num(D())}日`,
  () => `${num(Y(),4)}年${num(M())}月`,
  () => `${num(M())}月${num(D())}日`,
  () => `${num(M())}月${num(D())}`,
  () => `${pick(ERA)}${num(rnd()<.5?7:25)}${sepd()}${num(M())}${sepd()}${num(D())}`,
  () => `${pick(["令和","平成","昭和"])}${num(pick([1,7,25,63]))}年${num(M())}月${num(D())}日`,
  () => `${pick(["令和","平成","昭和"])}${num(pick([7,25]))}年生まれ`,
  () => `${num(D())}${sepd()}${num(M())}${sepd()}${num(Y(),4)}`,
  () => `${num(M())}${sepd()}${num(D())}${sepd()}${num(Y(),4)}`,
  () => `${pick(MON)} ${num(D())}${pick(["", ", 2025", "th"])}`,
  () => `${num(D())} ${pick(MON)} ${pick(["", "2025"])}`,
  () => `${num(Y(),4)}${sepd()}${pick(MON)}${sepd()}${num(D())}`,
  () => `${pick(["十","二","三"])}月${pick(["二十四","十","五"])}日`,
  () => `${num(M())}月${pick(["二十四","十","五"])}日`,
  () => `${pick(["0","03","06","09","0120"])}${pick(["-"," ","(",".",""])}${num(Math.floor(rnd()*9000+1000))}${pick(["-"," ",")",".",""])}${num(Math.floor(rnd()*9000+1000))}`,
  () => `+81${pick(["-"," "])}${pick([3,6,90])}${pick(["-"," "])}${num(Math.floor(rnd()*9000+1000))}${pick(["-"," "])}${num(Math.floor(rnd()*9000+1000))}`,
  () => `${num(Math.floor(rnd()*900+100))}${pick(["-","‐","－"," "])}${num(Math.floor(rnd()*9000+1000))}`,
  () => `${num(Math.floor(rnd()*9000+1000))}${pick([" ","-",""])}${num(Math.floor(rnd()*9000+1000))}${pick([" ","-",""])}${num(Math.floor(rnd()*9000+1000))}`,
  () => `user${pick(["@","＠"])}example${pick([".","．"])}com`,
  () => `${pick(["ID","MRN","患者ID","カルテ番号","ＩＤ"])}${pick(["", ":", " ", "　", "：", "#"])}${num(Math.floor(rnd()*900000+1000))}`,
];
const ZW = ["​", "⁠", "­", "﻿", "‍"];
const wraps = [(s) => s, (s) => `主訴と経過: ${s}に発熱`, (s) => `入院${s}`, (s) => `${s}から咳。`, (s) => `BP 92/54, ${s}`];
let n = 0, miss = [];
for (let i = 0; i < COUNT; i++) {
  let s = pick(gens)();
  if (rnd() < 0.15) { const k = Math.floor(rnd() * (s.length + 1)); s = s.slice(0, k) + pick(ZW) + s.slice(k); }
  const t = pick(wraps)(s);
  const cb = lintAnonymization(t, ctx).some((f) => f.level === "error");
  const mine = G.blockersOf(t).length > 0;
  n++;
  if (cb && !mine) miss.push(t);
}
const uniq = [...new Set(miss)];
console.log("checked", n, "misses", uniq.length);
for (const t of uniq.slice(0, 40)) console.log(JSON.stringify(t));
if (uniq.length) process.exit(1);
