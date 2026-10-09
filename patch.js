// Make an unpacked module graph runnable under stock bun on Termux.
//
// Usage: bun patch.js <dir> [<final dir>]
//
// <final dir> is where the tree will live once moved into place (default: <dir>); embedded paths
// point there.
//
// 1. Repoint the embedded absolute `/$bunfs/root/` paths at <final dir>. The needle includes `root/`
//    on purpose: the runtime's own "am I a standalone binary?" regexes match `$bunfs` without it.
// 2. Rename the entry module `cli` to `cli.mjs` and import bun-ant-shim.js as its first statement.
//    The TUI renderer needs Bun.ant.CellSegmenter from Anthropic's private Bun fork; --preload
//    would be lost when the app re-execs itself (e.g. after the folder-trust prompt).
// 3. Turn off the "embedded ugrep/bfs" build flag. When set, the app hides the Grep/Glob tools and
//    wraps the Bash tool's grep/find in functions that re-exec $CLAUDE_CODE_EXECPATH as ugrep/bfs;
//    under stock bun that path is bun itself. Ripgrep already falls back to the system `rg`.
//
// Files are handled as latin1, which round-trips arbitrary bytes.
const fs = require("fs"), path = require("path");

const dir = path.resolve(process.argv[2]);
const final = path.resolve(process.argv[3] ?? dir);
const read = (p) => fs.readFileSync(p, "latin1");
const write = (p, s) => fs.writeFileSync(p, s, "latin1");

// 1
const needle = "/$bunfs/root/";
let files = 0, hits = 0;
for (const ent of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
  if (!ent.isFile() || /\.(zst|node|asset)$/.test(ent.name)) continue;
  const p = path.join(ent.parentPath, ent.name);
  const parts = read(p).split(needle);
  if (parts.length === 1) continue;
  write(p, parts.join(final + "/"));
  files++; hits += parts.length - 1;
}
console.log(`==> rewrote ${hits} paths in ${files} files`);

// 2
fs.copyFileSync(path.join(__dirname, "bun-ant-shim.js"), path.join(dir, "bun-ant-shim.js"));
const cli = read(path.join(dir, "cli"));
const i = cli.search(/^import[\s{*"]/m);
if (i < 0) throw new Error("no import statement in cli");
write(path.join(dir, "cli.mjs"), cli.slice(0, i) + `import"${path.join(final, "bun-ant-shim.js")}";\n` + cli.slice(i));
fs.unlinkSync(path.join(dir, "cli"));
console.log("==> cli.mjs imports bun-ant-shim.js");

// 3
const gate = /(function [\w$]+\(\)\{)if\(![\w$]+\("true"\)\)return!1;if\([\w$]+\(\)\)return!1;return [\w$]+\.CLAUDE_CODE_ENTRYPOINT!=="local-agent"\}/;
const gated = fs.readdirSync(dir).filter((f) => f.endsWith(".js") && gate.test(read(path.join(dir, f))));
if (gated.length !== 1) throw new Error(`embedded-search gate: expected 1 match, found ${gated.length}`);
write(path.join(dir, gated[0]), read(path.join(dir, gated[0])).replace(gate, "$1return!1}"));
console.log(`==> disabled the embedded ugrep/bfs gate in ${gated[0]}`);
