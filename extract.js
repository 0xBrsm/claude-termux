// Extract every module's source from a Bun --compile standalone binary.
//
// Usage: bun extract.js <binary> <outdir>
//
// The payload ends with [Offsets (32 bytes)][TRAILER], preceded by byte_count bytes of blob:
//   Offsets = { u64 byte_count, StringPointer modules, u32 entry_point_id,
//               StringPointer compile_exec_argv, u32 flags }
// `modules` is an array of 52-byte records: six StringPointers { u32 offset, u32 len }
// (name, contents, sourcemap, bytecode, module_info, bytecode_origin_path) and four u8s
// (encoding, loader, format, side). Offsets are relative to the start of the blob.
// Reference: Bun's src/standalone_graph/StandaloneModuleGraph.rs.
const fs = require("fs"), path = require("path");

const TRAILER = Buffer.from("\n---- Bun! ----\n");
const OFFSETS_SIZE = 32, RECORD_SIZE = 52, ENCODING_UTF16 = 2;

const [file, outDir] = process.argv.slice(2);
if (!file || !outDir) throw new Error("usage: extract.js <binary> <outdir>");
const buf = fs.readFileSync(file);

// The graph is the last thing appended, so take the last trailer.
const trailerAt = buf.lastIndexOf(TRAILER);
if (trailerAt < 0) throw new Error("no Bun trailer found");
const offAt = trailerAt - OFFSETS_SIZE;
const base = offAt - Number(buf.readBigUInt64LE(offAt));
if (base < 0) throw new Error("bad byte_count");
const modulesOff = buf.readUInt32LE(offAt + 8), modulesLen = buf.readUInt32LE(offAt + 12);

const slice = (at) => {
  const off = buf.readUInt32LE(at), len = buf.readUInt32LE(at + 4);
  return buf.subarray(base + off, base + off + len);
};

let n = 0;
for (let r = base + modulesOff; r + RECORD_SIZE <= base + modulesOff + modulesLen; r += RECORD_SIZE) {
  const name = slice(r).toString("latin1");
  const rel = name.replace(/^.*?\/\$bunfs\/root\//, "").replace(/^\/+/, "");
  if (!rel || rel.includes("..")) { console.error(`skipping odd module name ${name}`); continue; }
  let data = slice(r + 8);
  if (buf.readUInt8(r + 48) === ENCODING_UTF16) data = Buffer.from(data.toString("utf16le"), "utf8");
  const dst = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, data);
  n++;
}
console.log(`==> extracted ${n} modules to ${outDir}`);
