#!/usr/bin/env node
// Parse a Bun --compile standalone binary's embedded module graph.
// Layout (src/standalone_graph/StandaloneModuleGraph.rs):
//   ELF section payload = [blob (byte_count bytes)][Offsets (32)][TRAILER (15)]
//   all StringPointer offsets are relative to the payload base.
const fs = require('fs');
const path = require('path');

const TRAILER = Buffer.from('\n---- Bun! ----\n');
const OFFSETS_SIZE = 32;
const REC_SIZE = 52;

const FLAGS = {
  SOURCE_TEXT_CONTIGUOUS: 1 << 4,
  HAS_SOURCE_HASHES: 1 << 5,
  HAS_BUILTIN_BYTECODE: 1 << 6,
  HAS_BYTECODE_STRING_TABLE: 1 << 7,
  HAS_STARTUP_MODULE_COUNT: 1 << 8,
  HAS_MODULE_INFO_STRING_TABLE: 1 << 9,
  CROSS_COMPILED_BYTECODE: 1 << 10,
  HAS_PRELINKED_MODULE_GRAPH: 1 << 11,
  HAS_RUNTIME_OPTIONS: 1 << 12,
  HAS_LINKED_BYTECODE_PAYLOAD: 1 << 13,
};
const LOADERS = ['jsx', 'js', 'ts', 'tsx', 'css', 'file', 'json', 'jsonc', 'toml', 'wasm', 'napi', 'base64', 'dataurl', 'text', 'sqlite', 'html'];
const ENCODING = { 0: 'binary', 1: 'latin1', 2: 'utf16' };
const FORMAT = { 0: 'none', 1: 'esm', 2: 'cjs' };

function findTrailer(buf) {
  // Last occurrence: the graph is the final thing injected.
  let at = -1, from = 0;
  for (;;) {
    const i = buf.indexOf(TRAILER, from);
    if (i < 0) break;
    at = i; from = i + 1;
  }
  if (at < 0) throw new Error('no Bun trailer found');
  return at;
}

function parse(buf) {
  const trailerAt = findTrailer(buf);
  const offAt = trailerAt - OFFSETS_SIZE;
  const byteCount = Number(buf.readBigUInt64LE(offAt));
  const o = {
    byteCount,
    modulesOff: buf.readUInt32LE(offAt + 8),
    modulesLen: buf.readUInt32LE(offAt + 12),
    entryPointId: buf.readUInt32LE(offAt + 16),
    argvOff: buf.readUInt32LE(offAt + 20),
    argvLen: buf.readUInt32LE(offAt + 24),
    flags: buf.readUInt32LE(offAt + 28),
  };
  const base = trailerAt - OFFSETS_SIZE - byteCount;
  if (base < 0) throw new Error(`bad byte_count ${byteCount} (trailer at ${trailerAt})`);
  const payloadLen = byteCount + OFFSETS_SIZE + TRAILER.length;

  const sp = (at) => ({ off: buf.readUInt32LE(base + at), len: buf.readUInt32LE(base + at + 4) });
  const slice = (p) => buf.subarray(base + p.off, base + p.off + p.len);

  const count = Math.floor(o.modulesLen / REC_SIZE);
  const files = [];
  for (let i = 0; i < count; i++) {
    const r = base + o.modulesOff + i * REC_SIZE;
    const p = (k) => ({ off: buf.readUInt32LE(r + k * 8), len: buf.readUInt32LE(r + k * 8 + 4) });
    files.push({
      index: i,
      namePtr: p(0), contentsPtr: p(1), sourcemapPtr: p(2),
      bytecodePtr: p(3), moduleInfoPtr: p(4), originPtr: p(5),
      encoding: buf.readUInt8(r + 48),
      loader: buf.readUInt8(r + 49),
      format: buf.readUInt8(r + 50),
      side: buf.readUInt8(r + 51),
    });
  }

  // Trailing records after the module table, in flag order.
  let cur = base + o.modulesOff + o.modulesLen;
  const u32 = () => { const v = buf.readUInt32LE(cur); cur += 4; return v; };
  const extra = {};
  if (o.flags & FLAGS.HAS_SOURCE_HASHES) cur += 4 * count;
  if (o.flags & FLAGS.HAS_BUILTIN_BYTECODE) {
    const n = u32();
    extra.builtinBytecode = [];
    for (let i = 0; i < n; i++) extra.builtinBytecode.push({ id: u32(), off: u32(), len: u32() });
  }
  if (o.flags & FLAGS.HAS_BYTECODE_STRING_TABLE) extra.bytecodeStringTable = { off: u32(), len: u32() };
  if (o.flags & FLAGS.HAS_STARTUP_MODULE_COUNT) extra.startupModuleCount = u32();
  if (o.flags & FLAGS.HAS_MODULE_INFO_STRING_TABLE) extra.moduleInfoStringTable = { off: u32(), len: u32() };
  if (o.flags & FLAGS.HAS_PRELINKED_MODULE_GRAPH) {
    extra.prelinkedGraph = { off: u32(), len: u32() };
    const n = u32();
    extra.prelinkedFiles = n;
    cur += 4 * n;
  }
  if (o.flags & FLAGS.HAS_RUNTIME_OPTIONS) extra.runtimeOptions = { flags: u32(), value: u32() };
  if (o.flags & FLAGS.HAS_LINKED_BYTECODE_PAYLOAD) {
    extra.linkedPayload = { off: u32(), len: u32() };
    extra.linkedRegionEnds = [u32(), u32(), u32(), u32(), u32(), u32()];
  }

  return { buf, base, payloadLen, trailerAt, o, files, extra, slice, name: (f) => slice(f.namePtr).toString('latin1') };
}

function flagNames(f) {
  return Object.entries(FLAGS).filter(([, v]) => f & v).map(([k]) => k);
}

const file = process.argv[2];
const outDir = process.argv[3];
const g = parse(fs.readFileSync(file));

console.log(`file            ${file} (${fs.statSync(file).size} bytes)`);
console.log(`payload         [${g.base}, ${g.base + g.payloadLen}) = ${g.payloadLen} bytes`);
console.log(`byte_count      ${g.o.byteCount}`);
console.log(`modules         ${g.files.length} records @ +${g.o.modulesOff}`);
console.log(`entry_point_id  ${g.o.entryPointId} -> ${g.o.entryPointId < g.files.length ? g.name(g.files[g.o.entryPointId]) : '??'}`);
console.log(`exec_argv       ${JSON.stringify(g.slice({ off: g.o.argvOff, len: g.o.argvLen }).toString())}`);
console.log(`flags           0x${g.o.flags.toString(16)} ${flagNames(g.o.flags).join(' ')}`);
for (const [k, v] of Object.entries(g.extra)) {
  console.log(`  ${k.padEnd(20)} ${Array.isArray(v) ? v.length + ' entries' : JSON.stringify(v)}`);
}

let withSrc = 0, withBc = 0, srcBytes = 0, bcBytes = 0;
for (const f of g.files) {
  if (f.contentsPtr.len) { withSrc++; srcBytes += f.contentsPtr.len; }
  if (f.bytecodePtr.len) { withBc++; bcBytes += f.bytecodePtr.len; }
}
console.log(`contents        ${withSrc}/${g.files.length} have source (${srcBytes} bytes)`);
console.log(`bytecode        ${withBc}/${g.files.length} have bytecode (${bcBytes} bytes)`);

const byLoader = {};
for (const f of g.files) byLoader[LOADERS[f.loader] ?? f.loader] = (byLoader[LOADERS[f.loader] ?? f.loader] || 0) + 1;
console.log(`loaders         ${JSON.stringify(byLoader)}`);

console.log('\nfirst 15 modules:');
for (const f of g.files.slice(0, 15)) {
  console.log(`  [${String(f.index).padStart(4)}] ${LOADERS[f.loader] ?? f.loader}/${FORMAT[f.format]}/${ENCODING[f.encoding]} src=${f.contentsPtr.len} bc=${f.bytecodePtr.len} ${g.name(f)}`);
}

if (outDir) {
  let n = 0;
  for (const f of g.files) {
    const nm = g.name(f);
    const rel = nm.replace(/^.*?\/\$bunfs\/root\//, '').replace(/^\/+/, '');
    if (!rel || rel.includes('..')) { console.error(`skip odd name ${nm}`); continue; }
    const dst = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    let data = g.slice(f.contentsPtr);
    if (f.encoding === 2) data = Buffer.from(data.toString('utf16le'), 'utf8');
    fs.writeFileSync(dst, data);
    n++;
  }
  console.log(`\nwrote ${n} files to ${outDir}`);
}
