// Repoint embedded absolute `$bunfs` paths at the real extraction directory.
const fs = require('fs');
const path = require('path');

const dir = path.resolve(process.argv[2]);
const needle = '/$bunfs/root/';
let changed = 0, hits = 0;
for (const ent of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
  if (!ent.isFile() || /\.(zst|node|asset)$/.test(ent.name)) continue;
  const p = path.join(ent.parentPath, ent.name);
  const src = fs.readFileSync(p, 'latin1');
  if (!src.includes(needle)) continue;
  const n = src.split(needle).length - 1;
  fs.writeFileSync(p, src.split(needle).join(dir + '/'), 'latin1');
  changed++; hits += n;
}
console.log(`rewrote ${hits} paths in ${changed} files -> ${dir}/`);
