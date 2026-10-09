// Stand-in for Bun.ant.CellSegmenter, the one native API Claude Code's TUI renderer needs from
// Anthropic's private Bun fork (@anthropic-ai/bun-internal). patch.js imports it first thing in cli.mjs.
//
// The contract below is reconstructed from the renderer's call sites (2.1.295):
//   new CellSegmenter({ substitute, screen? })
//   .graphemes / .sgrKeys / .sgrCloseKeys / .uris   interning tables, index 0 = "none"
//   .segment(text, cells, runs, reordered) -> count, or -count when the arrays are too small
//       cells[2g]   grapheme index
//       cells[2g+1] width & 0xff | TAB (0x100) | run << 10
//       runs[2r]    sgr key index, runs[2r+1] uri index
//   .paint(screen, W, x, y, cells, count, _, charMap, words) -> packed damage + end column
//   .setCell(screen, W, x, y, char, word)                    -> packed damage + end column
// Packed result: endX + damageStart * 2^20 + damageEnd * 2^36 (damage is [start, end)).
'use strict';

const TAB = 0x100;
const RUN_SHIFT = 10;
const P20 = 2 ** 20;
const P36 = 2 ** 36;

// SGR code -> the code that turns it off.
const CLOSE = { 1: 22, 2: 22, 3: 23, 4: 24, 5: 25, 6: 25, 7: 27, 8: 28, 9: 29, 21: 24, 53: 55 };
for (let i = 30; i <= 37; i++) CLOSE[i] = 39;
for (let i = 90; i <= 97; i++) CLOSE[i] = 39;
for (let i = 40; i <= 47; i++) CLOSE[i] = 49;
for (let i = 100; i <= 107; i++) CLOSE[i] = 49;
const CLOSERS = new Set(Object.values(CLOSE).concat([59]));
const EXTENDED = { 38: 39, 48: 49, 58: 59 };

const segmenter = new Intl.Segmenter();
const widthOpts = { ambiguousIsNarrow: true };

class CellSegmenter {
  constructor(opts = {}) {
    this.substitute = (opts.substitute || []).map(([lo, hi]) => [lo, hi ?? lo]);
    const s = opts.screen || {};
    this.mask = s.widthMask ?? 3;
    this.narrow = s.narrow ?? 0;
    this.wide = s.wide ?? 1;
    this.spacerTail = s.spacerTail ?? 2;
    this.spacerHead = s.spacerHead ?? 3;
    this.emptyChar = s.emptyCharIndex ?? 0;
    this.spacerChar = s.spacerCharIndex ?? 1;
    this.emptyWord = s.emptyWord ?? 0;
    this.tabWidth = s.tabWidth ?? 8;
    this.graphemes = [];
    this.sgrKeys = [''];
    this.sgrCloseKeys = [''];
    this.uris = [''];
    this._g = new Map();
    this._sgr = new Map([['', 0]]);
    this._uri = new Map([['', 0]]);
  }

  _intern(map, list, key, extra) {
    let i = map.get(key);
    if (i === undefined) {
      i = list.length;
      list.push(key);
      if (extra) extra(i);
      map.set(key, i);
    }
    return i;
  }

  _dropped(cp) {
    if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp < 0xa0)) return true;
    for (const [lo, hi] of this.substitute) if (cp >= lo && cp <= hi) return true;
    return false;
  }

  _clean(text) {
    let out = '';
    for (const ch of text) if (ch === '\t' || !this._dropped(ch.codePointAt(0))) out += ch;
    return out;
  }

  _applySgr(active, params) {
    const p = params === '' ? [0] : params.split(/[;:]/).map((n) => (n === '' ? 0 : +n));
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === 0) { active.length = 0; continue; }
      let open;
      let close;
      if (EXTENDED[c] !== undefined) {
        close = EXTENDED[c];
        if (p[i + 1] === 5) { open = `${c};5;${p[i + 2]}`; i += 2; }
        else if (p[i + 1] === 2) { open = `${c};2;${p[i + 2]};${p[i + 3]};${p[i + 4]}`; i += 4; }
        else continue;
      } else if (CLOSERS.has(c)) {
        for (let j = active.length - 1; j >= 0; j--) if (active[j].close === `\x1b[${c}m`) active.splice(j, 1);
        continue;
      } else if (CLOSE[c] !== undefined) {
        open = String(c);
        close = CLOSE[c];
      } else continue;
      const entry = { open: `\x1b[${open}m`, close: `\x1b[${close}m` };
      // A new colour replaces the old one; attributes sharing a closer (bold/dim) stack.
      const isColor = close === 39 || close === 49 || close === 59;
      for (let j = active.length - 1; j >= 0; j--) {
        if (active[j].open === entry.open || (isColor && active[j].close === entry.close)) active.splice(j, 1);
      }
      active.push(entry);
    }
  }

  segment(text, cells, runs, _reordered) {
    text = String(text);
    const active = [];
    let uri = 0;
    let count = 0;
    let runCount = 0;
    let curStyle = -1;
    let curUri = -1;
    let overflow = false;

    const styleIndex = () => {
      if (!active.length) return 0;
      const key = active.map((a) => a.open).join('\0');
      return this._intern(this._sgr, this.sgrKeys, key, () => this.sgrCloseKeys.push(active.map((a) => a.close).join('\0')));
    };

    const emitText = (chunk) => {
      chunk = this._clean(chunk);
      if (!chunk) return;
      const style = styleIndex();
      for (const { segment: g } of segmenter.segment(chunk)) {
        if (style !== curStyle || uri !== curUri) {
          if (2 * runCount + 1 < runs.length) { runs[2 * runCount] = style; runs[2 * runCount + 1] = uri; }
          else overflow = true;
          runCount++;
          curStyle = style;
          curUri = uri;
        }
        let info;
        let idx;
        if (g === '\t') {
          info = TAB;
          idx = this._intern(this._g, this.graphemes, ' ');
        } else {
          info = Math.min(2, Math.max(0, Bun.stringWidth(g, widthOpts)));
          idx = this._intern(this._g, this.graphemes, g);
        }
        if (2 * count + 1 < cells.length) {
          cells[2 * count] = idx;
          cells[2 * count + 1] = info | ((runCount - 1) << RUN_SHIFT);
        } else overflow = true;
        count++;
      }
    };

    let i = 0;
    let start = 0;
    while (i < text.length) {
      const ch = text.charCodeAt(i);
      if (ch !== 0x1b && ch !== 0x9b && ch !== 0x9d) { i++; continue; }
      if (i > start) emitText(text.slice(start, i));
      let csi = ch === 0x9b;
      let osc = ch === 0x9d;
      let j = i + 1;
      if (ch === 0x1b) {
        const next = text[j];
        if (next === '[') { csi = true; j++; }
        else if (next === ']') { osc = true; j++; }
        else { i = j + 1; start = i; continue; }
      }
      if (csi) {
        let k = j;
        while (k < text.length && (text.charCodeAt(k) < 0x40 || text.charCodeAt(k) > 0x7e)) k++;
        if (text[k] === 'm') this._applySgr(active, text.slice(j, k));
        i = k + 1;
      } else if (osc) {
        let k = j;
        let end = -1;
        while (k < text.length) {
          if (text[k] === '\x07' || text[k] === '\x9c') { end = k + 1; break; }
          if (text[k] === '\x1b' && text[k + 1] === '\\') { end = k + 2; break; }
          k++;
        }
        const body = text.slice(j, k);
        if (body.startsWith('8;')) {
          const url = body.slice(body.indexOf(';', 2) + 1);
          uri = url ? this._intern(this._uri, this.uris, url) : 0;
        }
        i = end < 0 ? text.length : end;
      }
      start = i;
    }
    if (start < text.length) emitText(text.slice(start));
    return overflow ? -Math.max(count, runCount) : count;
  }

  _put(screen, W, row, c, ch, word, dmg) {
    if (c < 0 || c >= W) return;
    const at = (row * W + c) << 1;
    const oldKind = screen[at + 1] & this.mask;
    // Never leave half of a wide character behind.
    if (oldKind === this.spacerTail && c > 0) {
      const prev = at - 2;
      if ((screen[prev + 1] & this.mask) === this.wide) {
        screen[prev] = this.emptyChar;
        screen[prev + 1] = this.emptyWord;
        dmg.mark(c - 1);
      }
    }
    if (oldKind === this.wide && (word & this.mask) !== this.wide && c + 1 < W) {
      const next = at + 2;
      if ((screen[next + 1] & this.mask) === this.spacerTail) {
        screen[next] = this.emptyChar;
        screen[next + 1] = this.emptyWord;
        dmg.mark(c + 1);
      }
    }
    if (screen[at] !== ch || screen[at + 1] !== word) {
      screen[at] = ch;
      screen[at + 1] = word;
      dmg.mark(c);
    }
  }

  _cell(screen, W, row, col, ch, word, kind, dmg) {
    const base = word & ~this.mask;
    if (kind === this.wide) {
      if (col + 1 >= W) {
        this._put(screen, W, row, col, this.emptyChar, base | this.spacerHead, dmg);
      } else {
        this._put(screen, W, row, col, ch, base | this.wide, dmg);
        this._put(screen, W, row, col + 1, this.spacerChar, base | this.spacerTail, dmg);
      }
      return 2;
    }
    this._put(screen, W, row, col, ch, base | kind, dmg);
    return 1;
  }

  paint(screen, W, x, y, cells, count, _unused, charMap, words) {
    const dmg = damage();
    let col = x;
    for (let g = 0; g < count; g++) {
      const info = cells[2 * g + 1];
      const word = words[info >>> RUN_SHIFT] ?? this.emptyWord;
      if (info & TAB) {
        const n = this.tabWidth - (((col % this.tabWidth) + this.tabWidth) % this.tabWidth);
        for (let k = 0; k < n; k++) this._put(screen, W, y, col + k, this.emptyChar, (word & ~this.mask) | this.narrow, dmg);
        col += n;
        continue;
      }
      const w = info & 0xff;
      if (w === 0) continue;
      if (col >= W) { col += w; continue; }
      col += this._cell(screen, W, y, col, charMap[cells[2 * g]], word, w >= 2 ? this.wide : this.narrow, dmg);
    }
    return dmg.pack(col);
  }

  setCell(screen, W, x, y, ch, word) {
    const dmg = damage();
    const kind = word & this.mask;
    const n = this._cell(screen, W, y, x, ch, word, kind === this.wide ? this.wide : kind, dmg);
    return dmg.pack(x + n);
  }
}

function damage() {
  let lo = Infinity;
  let hi = -1;
  return {
    mark(c) { if (c < lo) lo = c; if (c > hi) hi = c; },
    pack(end) {
      const e = Math.max(0, Math.min(end, P20 - 1));
      return hi < lo ? e : e + lo * P20 + (hi + 1) * P36;
    },
  };
}

if (typeof Bun !== 'undefined') {
  Bun.ant = Object.assign(Bun.ant || {}, { CellSegmenter });
}
module.exports = { CellSegmenter };
