# claude-termux

Run **current** Claude Code natively on Termux (aarch64, Android's Bionic libc).

## The problem, and why it turned out not to be one

From v2.1.113 onward, `@anthropic-ai/claude-code` ships as **Bun-compiled standalone binaries**
(glibc/musl, x64/arm64). There is no `linux-arm64-android` target, so those binaries don't run on
Termux, and the usual conclusion is that Termux is pinned to v2.1.112 — the last pure-JS release.

It isn't. Two things settle it:

1. Termux packages a **native `bun`** (`pkg install bun`, aarch64-android).
2. The Bun standalone payload stores **full source text for every module**. The embedded
   JavaScriptCore bytecode is only a startup optimization that Bun skips when absent — so there is
   no cross-architecture bytecode problem to solve.

So the current release can simply be unpacked and run: extract the module graph, repoint its
absolute `/$bunfs/root/` paths at a real directory, and hand the entry point to Termux's `bun`.
Verified on 2.1.293 and 2.1.295 — `--version`, live API requests, and tool use all work.

## Install

```sh
pkg install bun nodejs
./install.sh            # latest release
./install.sh 2.1.295    # a specific one
```

Installs a tree under `~/.local/share/claude-code-bun/<version>/` and a `claude-bun` wrapper in
`$TERMUX_PREFIX/bin`. An existing npm-installed `claude` is left alone.

The tarball is ~250 MB. To build from one you already have:

```sh
BINARY=path/to/package/claude ./install.sh 2.1.295
```

## How it works

`bunx.js` parses the standalone binary. On Linux the payload lives in an ELF section located via
the `BUN_COMPILED` symbol, laid out as:

```
[u64 payload_len][blob (byte_count bytes)][Offsets (32 bytes)][\n---- Bun! ----\n]
```

`Offsets` is `{ u64 byte_count, StringPointer modules_ptr, u32 entry_point_id,
StringPointer compile_exec_argv_ptr, u32 flags }`, and every `StringPointer { u32 offset, u32 len }`
is relative to the payload base. The module table is `modules_ptr.len / 52` records of
`{ name, contents, sourcemap, bytecode, module_info, bytecode_origin_path }` plus four `u8`
discriminants. Optional trailing records — source hashes, builtin bytecode, the bytecode and
module-info string tables, the prelinked module graph, the linked bytecode payload — are present
according to `flags`.

`bunx.js <binary> [outdir]` prints a summary of all of the above, and extracts every module's
source when given an output directory.

`rewrite.js <dir>` then replaces the literal `/$bunfs/root/` prefix with `<dir>/`. The needle
includes the `root/` segment deliberately: the runtime's own "am I a standalone binary?" regexes
match `$bunfs` *without* it, and must be left intact.

Reference: Bun's `src/standalone_graph/StandaloneModuleGraph.rs`.

## Known gaps

- `audio-capture.node` and `clipboard-napi.node` are x86-64 ELF and cannot load on arm64. Both are
  lazily required, so startup is unaffected, but voice input and the native clipboard will fail if
  used.
- The unpacked tree shares `~/.claude` with any other install. If a newer release migrates state,
  an older fallback may not survive it.

## Why not patch the frozen 2.1.112 build instead

That was this repo's original approach — port newer models into 2.1.112's hardcoded registry and
`/model` picker. It worked, and it's a dead end. Removed in `c16e611`; recoverable from history.

The API refuses newer models for an old client with HTTP 400 `claude_code_version_too_old`, and
**that gate cannot be defeated client-side.** The version is resolved from the OAuth session, not
from anything the client sends. Measured: with both user-agent builders patched and the outbound
request sniffed via `ANTHROPIC_BASE_URL`, the UA was verifiably `claude-cli/2.1.293` while the
server still answered *"Claude Code 2.1.112 does not support this model"*. No `x-*` header carries
a CLI version, and the `anthropic-beta` sets of 2.1.112 and 2.1.293 are identical.

The gate also advances per model — `claude-opus-5-5` required 2.1.280 — so the set of models a
patched 2.1.112 can reach only shrinks. And it's substantive rather than cosmetic: 2.1.293 has
~279 `effort:` sites to 2.1.112's 34, so even with the gate lifted that build probably couldn't
drive a model whose entry defaults to an effort level.

## Files

- `bunx.js` — Bun standalone-graph parser and extractor
- `rewrite.js` — repoints embedded `$bunfs` paths at a real directory
- `install.sh` — download, unpack, rewrite, install the `claude-bun` wrapper

> Unpacks a local copy of Anthropic's Claude Code for personal use on an otherwise-unsupported
> platform. Not affiliated with Anthropic.
