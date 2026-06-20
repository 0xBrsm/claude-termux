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
// newest Opus + an optional Fable line. Does NOT reproduce 183's availability "(disabled)"
// gating — 2.1.112 lacks that plumbing, so ported entries always show.

const fs = require('fs');
const { execFileSync } = require('child_process');

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
const PROVIDER_KEYS = ['firstParty', 'bedrock', 'vertex', 'foundry', 'anthropicAws', 'mantle'];

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
  // provider entries
  const entryRe = /\{firstParty:"(claude-[a-z0-9-]+)",bedrock:("[^"]*"|null),vertex:("[^"]*"|null),foundry:("[^"]*"|null),anthropicAws:("[^"]*"|null),mantle:("[^"]*"|null)/g;
  const models = new Map();
  let m;
  while ((m = entryRe.exec(s))) {
    const id = m[1];
    const providers = {
      firstParty: JSON.stringify(id),
      bedrock: m[2], vertex: m[3], foundry: m[4], anthropicAws: m[5], mantle: m[6],
    };
    models.set(id, { id, providers, family: familyOf(id) });
  }
  // registry key map: {haiku35:..,opus48:aTr,fable5:MHe..}
  const keyMap = {};
  const mapM = s.match(/\{haiku35:[A-Za-z0-9_$]+(?:,[a-z0-9]+:[A-Za-z0-9_$]+)*/);
  if (mapM) for (const pair of mapM[0].slice(1).split(',')) {
    const [k, v] = pair.split(':'); if (k && v) keyMap[k] = true;
  }
  // map id -> registry key by matching family+version
  for (const mdl of models.values()) {
    const v = mdl.id.replace(/^claude-/, '').replace(/-\d{8}$/, '');
    let key = v.replace(/(\d+)-(\d+)/, '$1$2').replace(/-/g, '');       // opus-4-8 -> opus48
    if (/^\d/.test(v)) {                                                // 3-5-haiku -> haiku35
      const mm = v.match(/^(\d+)-(\d+)-([a-z]+)$/);
      if (mm) key = `${mm[3]}${mm[1]}${mm[2]}`;
    }
    mdl.key = key;
  }
  // 1M-context capability set
  const ctx = new Set();
  const ctxM = s.match(/(?:==="claude-opus-[0-9-]+"(?:\|\|)?)+/g);
  if (ctxM) for (const blk of ctxM) for (const mm of blk.matchAll(/"(claude-[a-z0-9-]+)"/g)) ctx.add(mm[1]);
  for (const mdl of models.values()) mdl.ctx1m = ctx.has(mdl.id);
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

// ---- 4. menu: promote newest opus, add Fable line ----
function syncMenu(P, models) {
  const opus = [...models.values()].filter(m => m.family === 'opus')
    .sort((a, b) => a.key.localeCompare(b.key));
  const newest = opus[opus.length - 1];                 // e.g. opus48
  // repoint default-opus alias resolver LE() -> newest
  P.patch('LE alias',
    'if(!KA())return ZO()[vQ];return ZO().opus47}',
    `if(!KA())return ZO()[vQ];return ZO().${newest.key}}`);
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

  // Fable line (if registered): define _fableP() and push it before Haiku in each branch.
  const fable = [...models.values()].find(m => m.family === 'fable');
  if (fable) {
    P.patch('fable helper',
      'function RvK(){',
      `function _fableP(){let q=!KA();return{value:q?ZO().${fable.key}:"${fable.id}",label:"Fable",description:\`Fable · Most capable for hardest, longest tasks\${q?"":\` · \${Yf(jB)}\`}\`,descriptionForModel:"Fable - most capable for your hardest and longest-running tasks"}}function RvK(){`);
    // consumer (KA) branch: before Haiku BvK
    P.patch('fable KA branch', 'return A.push(BvK()),A}', 'return A.push(_fableP()),A.push(BvK()),A}');
    // default branch: before Haiku fallback push
    P.patch('fable default branch', 'else K.push(UjY());return K}', 'else K.push(UjY());K.push(_fableP());return K}');
  }
}

// ---- main ----
const models = extractModels(binPath);
let stock = fs.readFileSync(stockPath, 'utf8');
const present = new Set();
for (const m of models.values()) if (stock.includes(`firstParty:"${m.id}"`)) present.add(m.id);
const newModels = [...models.values()]
  .filter(m => FAMILIES.includes(m.family) && !present.has(m.id));

console.log(`binary models: ${models.size} | already in stock: ${present.size} | new: ${newModels.length}`);
console.log('new:', newModels.map(m => `${m.id}(${m.key}${m.ctx1m ? ',1m' : ''})`).join(', ') || '(none)');

const P = makePatcher(stock);
if (newModels.length) register(P, newModels);
syncMenu(P, models);
fs.writeFileSync(outPath, P.text);
console.log('\n' + P.report.join('\n'));
console.log(`\nwrote ${outPath}`);
