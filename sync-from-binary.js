#!/usr/bin/env node
// sync-from-binary.js — port a newer Claude Code native binary's model menu onto the
// frozen Termux JS build (v2.1.112), generically.
//
// Why this works: 2.1.112 is a FIXED target. Its registration sites and picker skeleton
// never change. Only the source binary varies, and we extract DATA from it (model
// registry + which model fills each menu slot), then fill fixed templates. No per-entry
// authoring.
//
// Usage:
//   node sync-from-binary.js <native-binary> [<stock-cli.js>] [-o <out.js>]
// Defaults: stock = cli.js.bak.1781844410 in the install dir; out = cli.js.work beside it.
//
// Covers: registry/routing for every new model (so --model works) + menu promotion of the
// newest Opus AND newest Sonnet (helper relabels + static org-branch entries QjY/uT6) +
// an optional Fable line in every picker branch. Does NOT reproduce 2.1.183+'s availability
// "(disabled)" gating — 2.1.112 lacks that plumbing, so ported entries always show.

const fs = require('fs');

const INSTALL = '/data/data/com.termux/files/usr/lib/node_modules/@anthropic-ai/claude-code';
const args = process.argv.slice(2);
const binPath = args[0];
if (!binPath) { console.error('usage: node sync-from-binary.js <native-binary> [stock-cli.js] [-o out.js]'); process.exit(1); }
const oIdx = args.indexOf('-o');
const outPath = oIdx >= 0 ? args[oIdx + 1] : `${INSTALL}/cli.js.work`;
const stockPath = (args[1] && args[1] !== '-o') ? args[1] : `${INSTALL}/cli.js.bak.1781844410`;

// ---- family + pricing (stable, family-based — not per-entry) ----
const PRICING = { opus: 'jB', sonnet: 'GQ', haiku: '_T1', fable: 'jB' };   // 2.1.112 pricing consts
const FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'];                      // skip mythos/internal

// ---- 1. extract model data from the binary (keyed on stable shapes) ----
function strings(file) {
  // mimic `strings -n 8`
  const buf = fs.readFileSync(file);
  const out = [];
  let cur = '';
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b >= 0x20 && b < 0x7f) { cur += String.fromCharCode(b); }
    else { if (cur.length >= 8) out.push(cur); cur = ''; }
  }
  if (cur.length >= 8) out.push(cur);
  return out.join('\n');
}

function familyOf(id) {
  const m = id.match(/^claude-(?:\d+-\d+-)?([a-z]+)/);
  return m ? m[1] : null;
}

function deriveDisplay(id) {
  // claude-opus-4-8 -> "Opus 4.8"; claude-fable-5 -> "Fable 5"; strip trailing -YYYYMMDD
  let s = id.replace(/^claude-/, '').replace(/-\d{8}$/, '');
  let m = s.match(/^(?:(\d+)-(\d+)-)?([a-z]+)-(.+)$/);
  if (!m) return s;
  const fam = m[3][0].toUpperCase() + m[3].slice(1);
  const ver = (m[1] ? `${m[1]}.${m[2]} ` : '') + m[4].replace(/-/g, '.');
  return `${fam} ${ver}`.trim();
}

function extractModels(bin) {
  const s = strings(bin);
  const models = new Map();
  // id -> registry short key map, e.g. "claude-opus-4-8":"opus48", "claude-fable-5":"fable5"
  // (2.1.197 ships an explicit map; values are <family><major><minor> with no dashes)
  const keyMap = {};
  for (const km of s.matchAll(/"(claude-[a-z0-9-]+)":"([a-z]+[0-9]+)"/g)) {
    if (!(km[1] in keyMap)) keyMap[km[1]] = km[2];
  }
  // 2.1.197 model objects are declarative:
  //   {id:"claude-opus-4-8",family:"opus",display_name:..,provider_ids:{first_party:..,
  //    bedrock:..,vertex:..,foundry:..,anthropic_aws:..,mantle:..,gateway:..},..,supports_1m_beta:!0,..}
  // Split on object heads, then read each object's bounded chunk. Provider keys are snake_case
  // and add a `gateway` slot vs. stock 2.1.112 (firstParty/anthropicAws, no gateway) — remap below.
  const heads = [];
  const headRe = /\{id:"(claude-[a-z0-9-]+)",family:"([a-z]+)"/g;
  let h;
  while ((h = headRe.exec(s))) heads.push({ id: h[1], family: h[2], idx: h.index });
  for (let i = 0; i < heads.length; i++) {
    const { id, family, idx } = heads[i];
    const end = i + 1 < heads.length ? heads[i + 1].idx : idx + 2000;
    const chunk = s.slice(idx, end);
    const pm = chunk.match(/provider_ids:\{first_party:("[^"]*"),bedrock:(null|"[^"]*"),vertex:(null|"[^"]*"),foundry:(null|"[^"]*"),anthropic_aws:(null|"[^"]*"),mantle:(null|"[^"]*"),gateway:(?:null|"[^"]*")\}/);
    if (!pm) continue;
    const key = keyMap[id];
    if (!key) continue;                       // no registry key -> not routable, skip (mythos, *-fast)
    models.set(id, {
      id, family, key,
      providers: { firstParty: pm[1], bedrock: pm[2], vertex: pm[3], foundry: pm[4], anthropicAws: pm[5], mantle: pm[6] },
      ctx1m: /supports_1m_beta:!0/.test(chunk),
    });
  }
  return models;
}

// ---- 2. patch helper ----
function makePatcher(text) {
  const report = [];
  return {
    patch(label, oldStr, newStr, { all = false, optional = false } = {}) {
      const occ = text.split(oldStr).length - 1;
      if (occ === 0) { report.push(`${optional ? 'skip' : 'MISS'} ${label}`); return; }
      if (occ > 1 && !all) { report.push(`MULTI ${label} (${occ})`); return; }
      text = all ? text.split(oldStr).join(newStr) : text.replace(oldStr, newStr);
      report.push(`ok   ${label}`);
    },
    get text() { return text; },
    report,
  };
}

// ---- 3. register a set of new models (clone the opus-4-7 stock analogs) ----
function register(P, newModels) {
  const vars = newModels.map(m => `_z${m.key}`);
  // S0 var hoist
  P.patch('S0 var hoist',
    'var Rf1,Sf1,Cf1,bf1,If1,xf1,uf1,mf1,Bf1,pf1,qZ8,Ff1,qA,B2O,OMq;',
    `var Rf1,Sf1,Cf1,bf1,If1,xf1,uf1,mf1,Bf1,pf1,qZ8,Ff1,${vars.join(',')},qA,B2O,OMq;`);
  // S2 entry objects (after stock opus-4-7 object Ff1={...})
  const ff1 = 'Ff1={firstParty:"claude-opus-4-7",bedrock:"us.anthropic.claude-opus-4-7",vertex:"claude-opus-4-7",foundry:"claude-opus-4-7",anthropicAws:"claude-opus-4-7",mantle:"anthropic.claude-opus-4-7"}';
  const objs = newModels.map((m, i) => {
    const p = m.providers;
    return `,${vars[i]}={firstParty:${p.firstParty},bedrock:${p.bedrock},vertex:${p.vertex},foundry:${p.foundry},anthropicAws:${p.anthropicAws},mantle:${p.mantle}}`;
  }).join('');
  P.patch('S2 entry objects', ff1, ff1 + objs);
  // S1 qA registry
  const keys = newModels.map((m, i) => `,${m.key}:${vars[i]}`).join('');
  P.patch('S1 qA registry', ',opus47:Ff1}', `,opus47:Ff1${keys}}`);
  // S3 normalizer (prepend specific checks before opus-4-7)
  const norm = newModels.map(m => `if(q.includes("${m.id}"))return"${m.id}";`).join('');
  P.patch('S3 normalizer',
    'q.includes("claude-opus-4-7"))return"claude-opus-4-7";',
    `q.includes("claude-opus-4-7"))return"claude-opus-4-7";${norm}`);
  // S4 display name switch
  const disp = newModels.map(m => `case"${m.id}":return"${deriveDisplay(m.id)}"+K;`).join('');
  P.patch('S4 display name',
    'case"claude-opus-4-7":return"Opus 4.7"+K',
    `case"claude-opus-4-7":return"Opus 4.7"+K;${disp.replace(/;$/, '')}`);
  // S5 1M capability (opus + supports-1m only)
  const ctxIds = newModels.filter(m => m.ctx1m).map(m => `||K==="${m.id}"`).join('');
  if (ctxIds) P.patch('S5 1M context',
    'K==="claude-opus-4-5"||K==="claude-opus-4-6"||K==="claude-opus-4-7"',
    `K==="claude-opus-4-5"||K==="claude-opus-4-6"||K==="claude-opus-4-7"${ctxIds}`);
  // S6 max tokens (clone opus 64000/128000)
  const tok = newModels.map(m => {
    const sub = m.id.replace(/^claude-/, '').replace(/-\d{8}$/, '');
    return `if(z.includes("${sub}"))K=64000,_=128000;else `;
  }).join('');
  P.patch('S6 max tokens',
    'if(z.includes("opus-4-7"))K=64000,_=128000',
    `${tok}if(z.includes("opus-4-7"))K=64000,_=128000`);
  // S7 pricing
  const price = newModels.map((m, i) => `,[AX(${vars[i]}.firstParty)]:${PRICING[m.family] || 'jB'}`).join('');
  P.patch('S7 pricing', '[AX(Ff1.firstParty)]:jB}', `[AX(Ff1.firstParty)]:jB${price}}`);
  // S8 image dims
  const dims = newModels.map(m => `,"${m.id}":{maxWidth:2576,maxHeight:2576}`).join('');
  P.patch('S8 image dims',
    '{"claude-opus-4-7":{maxWidth:2576,maxHeight:2576}}',
    `{"claude-opus-4-7":{maxWidth:2576,maxHeight:2576}${dims}}`);
  // S9/S10 opus-only routing
  const opusNew = newModels.filter(m => m.family === 'opus');
  const inc = opusNew.map(m => `||K.includes("${m.id}")`).join('');
  if (inc) P.patch('S9 modern includes',
    'K.includes("claude-opus-4-6")||K.includes("claude-opus-4-7")',
    `K.includes("claude-opus-4-6")||K.includes("claude-opus-4-7")${inc}`);
  const aws = opusNew.map(m => `||/^${m.id}/.test(K)`).join('');
  if (aws) P.patch('S10 AWS regex',
    '/^claude-opus-4-7/.test(K)',
    `(/^claude-opus-4-7/.test(K)${aws})`, { all: true });
}

// ---- 4. menu: promote newest opus + newest sonnet (helpers + static org entries), add Fable ----
function syncMenu(P, models) {
  const opus = [...models.values()].filter(m => m.family === 'opus')
    .sort((a, b) => a.key.localeCompare(b.key));
  const newest = opus[opus.length - 1];                 // e.g. opus48
  // repoint default-opus alias resolver LE() -> newest
  P.patch('LE alias',
    'if(!KA())return ZO()[vQ];return ZO().opus47}',
    `if(!KA())return ZO()[vQ];return ZO().${newest.key}}`);
  // JK8() is the "assumed default model" fallback (q??JK8(), hE(JK8())) used when no model is
  // resolvable — stock hardwires it to the-then-newest Opus. It's not a picker row, but leaving it
  // stale means estimation/hint paths report the old flagship. Repoint it alongside LE().
  P.patch('JK8 assumed-default',
    'function JK8(){return ZO().opus47}',
    `function JK8(){return ZO().${newest.key}}`);
  // relabel the 5 stock Opus picker helpers to newest (full-def swaps)
  const D = deriveDisplay(newest.id);                   // "Opus 4.8"
  const swaps = [
    [`function pvK(q=!1){let K=!KA();return{value:"opus",label:"Opus",description:\`Opus 4.7 · Most capable for complex work\${k37()}\${K||!q?"":\` · \${Yf(jB)}\`}\`}}`,
     `function pvK(q=!1){let K=!KA();return{value:"opus",label:"Opus",description:\`${D} · Best for everyday, complex tasks\${k37()}\${K||!q?"":\` · \${Yf(jB)}\`}\`}}`],
    [`function RvK(){let q=!KA();return{value:q?ZO().opus47:"opus",label:"Opus",description:\`Opus 4.7 · Most capable for complex work\${q?"":\` · \${Yf(jB)}\`}\`,descriptionForModel:"Opus 4.7 - most capable for complex work"}}`,
     `function RvK(){let q=!KA();return{value:q?ZO().${newest.key}:"opus",label:"Opus",description:\`${D} · Best for everyday, complex tasks\${q?"":\` · \${Yf(jB)}\`}\`,descriptionForModel:"${D} - best for everyday, complex tasks"}}`],
    [`function V37(q=!1){let K=!KA();return{value:K?ZO().opus47+"[1m]":"opus[1m]",label:"Opus (1M context)",description:\`Opus 4.7 with 1M context · Most capable for complex work\${k37()}\${K||!q?"":\` · \${Yf(jB)}\`}\`,descriptionForModel:"Opus 4.7 with 1M context - most capable for complex work"}}`,
     `function V37(q=!1){let K=!KA();return{value:K?ZO().${newest.key}+"[1m]":"opus[1m]",label:"Opus (1M context)",description:\`${D} with 1M context · Best for everyday, complex tasks\${k37()}\${K||!q?"":\` · \${Yf(jB)}\`}\`,descriptionForModel:"${D} with 1M context - best for everyday, complex tasks"}}`],
    [`function IvK(){let q=!KA(),K=i7()?" · Billed as extra usage":"",_=K!==""&&!q;return{value:"opus[1m]",label:"Opus (1M context)",description:\`Opus 4.7 with 1M context\${k37()}\${K}\${!_?"":\` · \${Yf(jB)}\`}\`}}`,
     `function IvK(){let q=!KA(),K=i7()?" · Billed as extra usage":"",_=K!==""&&!q;return{value:"opus[1m]",label:"Opus (1M context)",description:\`${D} with 1M context\${k37()}\${K}\${!_?"":\` · \${Yf(jB)}\`}\`}}`],
    [`function CvK(){let q=!KA();return{value:q?ZO().opus47+"[1m]":"opus[1m]",label:"Opus (1M context)",description:\`Opus 4.7 for long sessions\${q?"":\` · \${Yf(jB)}\`}\`,descriptionForModel:"Opus 4.7 with 1M context window - for long sessions with large codebases"}}`,
     `function CvK(){let q=!KA();return{value:q?ZO().${newest.key}+"[1m]":"opus[1m]",label:"Opus (1M context)",description:\`${D} for long sessions\${q?"":\` · \${Yf(jB)}\`}\`,descriptionForModel:"${D} with 1M context window - for long sessions with large codebases"}}`],
  ];
  for (const [o, n] of swaps) P.patch(`relabel ${o.slice(9, 12)}`, o, n);

  // relabel the stock Sonnet picker helpers to the newest Sonnet (mirrors the Opus promotion).
  // Stock 2.1.112 hardwires "Sonnet 4.6"/sonnet46; bump to whatever the binary's latest sonnet is
  // so the picker matches the newer version (e.g. shows "Sonnet 5" not "Sonnet 4.6"). The Pro/Max
  // branches use the generic "sonnet"/"sonnet[1m]" alias as the value, which the backend resolves
  // to the latest sonnet — so this is a label fix; the non-firstParty branches repoint the key.
  const sonnet = [...models.values()].filter(m => m.family === 'sonnet')
    .sort((a, b) => a.key.localeCompare(b.key));
  const newestS = sonnet[sonnet.length - 1];
  if (newestS && newestS.key !== 'sonnet46') {
    const DS = deriveDisplay(newestS.id);               // "Sonnet 5"
    const sswaps = [
      [`function mjY(){let q=!KA();return{value:q?ZO().sonnet46:"sonnet",label:"Sonnet",description:\`Sonnet 4.6 · Best for everyday tasks\${q?"":\` · \${Yf(GQ)}\`}\`,descriptionForModel:"Sonnet 4.6 - best for everyday tasks. Generally recommended for most coding tasks"}}`,
       `function mjY(){let q=!KA();return{value:q?ZO().${newestS.key}:"sonnet",label:"Sonnet",description:\`${DS} · Best for everyday tasks\${q?"":\` · \${Yf(GQ)}\`}\`,descriptionForModel:"${DS} - best for everyday tasks. Generally recommended for most coding tasks"}}`],
      [`function SvK(){let q=!KA();return{value:q?ZO().sonnet46+"[1m]":"sonnet[1m]",label:"Sonnet (1M context)",description:\`Sonnet 4.6 for long sessions\${q?"":\` · \${Yf(GQ)}\`}\`,descriptionForModel:"Sonnet 4.6 with 1M context window - for long sessions with large codebases"}}`,
       `function SvK(){let q=!KA();return{value:q?ZO().${newestS.key}+"[1m]":"sonnet[1m]",label:"Sonnet (1M context)",description:\`${DS} for long sessions\${q?"":\` · \${Yf(GQ)}\`}\`,descriptionForModel:"${DS} with 1M context window - for long sessions with large codebases"}}`],
      [`function bvK(){let q=!KA(),K=i7()?" · Billed as extra usage":"";return{value:"sonnet[1m]",label:"Sonnet (1M context)",description:\`Sonnet 4.6 with 1M context\${K}\${!(K!==""&&!q)?"":\` · \${Yf(GQ)}\`}\`}}`,
       `function bvK(){let q=!KA(),K=i7()?" · Billed as extra usage":"";return{value:"sonnet[1m]",label:"Sonnet (1M context)",description:\`${DS} with 1M context\${K}\${!(K!==""&&!q)?"":\` · \${Yf(GQ)}\`}\`}}`],
    ];
    for (const [o, n] of sswaps) P.patch(`relabel ${o.slice(9, 12)}`, o, n);
    // repoint the default-sonnet alias resolver Af() -> newest (the sonnet twin of the LE() opus
    // repoint). Af() is what hv() returns for non-Max firstParty accounts, so the "Default
    // (recommended)" entry resolves through it. Without this the picker LABELS say the new Sonnet
    // (via uT6/QjY/mjY) but selecting Default still gives sonnet46 underneath.
    P.patch('Af alias',
      'if(!KA())return ZO()[TQ];return ZO().sonnet46}',
      `if(!KA())return ZO()[TQ];return ZO().${newestS.key}}`);
    // QjY is a *static* Sonnet entry object (not a helper fn) used by the org/Max (i7) picker
    // branch — the helper swaps above miss it, so it would keep showing the stale "Sonnet 4.6".
    P.patch('relabel QjY',
      `QjY={value:"sonnet",label:"Sonnet",description:"Sonnet 4.6 · Best for everyday tasks"}`,
      `QjY={value:"sonnet",label:"Sonnet",description:"${DS} · Best for everyday tasks"}`);
    // uT6 produces the org branch's "Default (recommended)" description — three hardcoded strings
    // (newest Opus for Max/Premium, newest Sonnet otherwise). Full-function relabel to the latest.
    P.patch('relabel uT6',
      `function uT6(q=!1){if(ch()||Yq6()){if(YX())return"Opus 4.7 with 1M context · Most capable for complex work";return"Opus 4.7 · Most capable for complex work"}return"Sonnet 4.6 · Best for everyday tasks"}`,
      `function uT6(q=!1){if(ch()||Yq6()){if(YX())return"${D} with 1M context · Best for everyday, complex tasks";return"${D} · Best for everyday, complex tasks"}return"${DS} · Best for everyday tasks"}`);
  }

  // Fable line (if registered): define _fableP() and push it before Haiku in each branch.
  // value is ALWAYS the plain string id — never q?ZO().fableKey:... . The picker keys rows by
  // String(value) (key:String(N8.value), value-keyed optionMap), so a row value must be a string;
  // a raw provider object (ZO().fableKey) would stringify to "[object Object]". That object form
  // only arose on non-KA org/Max (i7) accounts; the string id is correct on all account types and
  // routes fine (the normalizer resolves it), matching how the other org-branch rows use a string.
  const fable = [...models.values()].find(m => m.family === 'fable');
  if (fable) {
    P.patch('fable helper',
      'function RvK(){',
      `function _fableP(){let q=!KA();return{value:"${fable.id}",label:"Fable",description:\`Fable · Most capable for hardest, longest tasks\${q?"":\` · \${Yf(jB)}\`}\`,descriptionForModel:"Fable - most capable for your hardest and longest-running tasks"}}function RvK(){`);
    // consumer (KA) branch: before Haiku BvK
    P.patch('fable KA branch', 'return A.push(BvK()),A}', 'return A.push(_fableP()),A.push(BvK()),A}');
    // default branch: before Haiku fallback push
    P.patch('fable default branch', 'else K.push(UjY());return K}', 'else K.push(UjY());K.push(_fableP());return K}');
    // org/Max (i7) branches end with the static Haiku entry (xvK); the ch()||Yq6() sub-branch uses
    // accumulator O, the other i7 sub-branch uses A. Insert Fable just before Haiku in each.
    P.patch('fable i7 max branch', 'return O.push(xvK),O}', 'return O.push(_fableP()),O.push(xvK),O}');
    P.patch('fable i7 sub branch', 'return A.push(xvK),A}', 'return A.push(_fableP()),A.push(xvK),A}');
  }
}

// ---- main ----
const models = extractModels(binPath);
let stock = fs.readFileSync(stockPath, 'utf8');
// A model is already known if stock's qA registry already carries its short key. Key-based,
// not id-based: the binary uses undated ids (claude-haiku-4-5) where stock uses dated ones
// (claude-haiku-4-5-20251001), so id matching would re-register existing models and produce
// duplicate registry keys. Keys (haiku45, opus47, ...) are the stable identity across both.
const qaM = stock.match(/qA=\{[^}]*\}/);
const stockKeys = new Set();
if (qaM) for (const km of qaM[0].matchAll(/([a-z0-9]+):/g)) stockKeys.add(km[1]);
const newModels = [...models.values()]
  .filter(m => FAMILIES.includes(m.family) && !stockKeys.has(m.key));

console.log(`binary models: ${models.size} | already in stock: ${stockKeys.size} | new: ${newModels.length}`);
console.log('new:', newModels.map(m => `${m.id}(${m.key}${m.ctx1m ? ',1m' : ''})`).join(', ') || '(none)');

const P = makePatcher(stock);
if (newModels.length) register(P, newModels);
syncMenu(P, models);
fs.writeFileSync(outPath, P.text);
console.log('\n' + P.report.join('\n'));
console.log(`\nwrote ${outPath}`);
