# claude-termux

Unpack current Claude Code and run it on Termux (aarch64, Android's Bionic libc) under stock
`bun`. The upstream TUI cannot run here, so `claude-repl` provides an interactive client over the
CLI's own stream-json session mode. See [Status](#status-what-works-and-what-doesnt) first.

## The problem

From v2.1.113 onward, `@anthropic-ai/claude-code` ships as **Bun-compiled standalone binaries**
(glibc/musl, x64/arm64). There is no `linux-arm64-android` target, so those binaries don't run on
Termux, and the usual conclusion is that Termux is pinned to v2.1.112 — the last pure-JS release.

Two things get you most of the way past that:

1. Termux packages a **native `bun`** (`pkg install bun`, aarch64-android).
2. The Bun standalone payload stores **full source text for every module**. The embedded
   JavaScriptCore bytecode is only a startup optimization that Bun skips when absent — so there is
   no cross-architecture bytecode problem to solve.

So the payload can be unpacked and run: extract the module graph, repoint its absolute
`/$bunfs/root/` paths at a real directory, and hand the entry point to Termux's `bun`.

## Status: what works and what doesn't

Tested on 2.1.293 and 2.1.295 under Termux's `bun` 1.4.2:

| | |
|---|---|
| `--version`, `--help`, subcommands | works |
| `-p` / `--print`, live API requests | works |
| tool use (Bash, file edits) | works |
| multi-turn conversation, streaming, Ctrl-C | works, via `claude-repl` |
| **upstream interactive TUI** | **does not start** |

Current models work: `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` and the
`opus`/`sonnet`/`haiku` aliases all respond, which is the whole point — the server-side
`claude_code_version_too_old` gate is what the frozen 2.1.112 build can never get past.

The upstream TUI, though, cannot be fixed by unpacking. Claude Code's renderer calls
`Bun.ant.CellSegmenter` — a native API in **Anthropic's private Bun fork**
(`@anthropic-ai/bun-internal`), not in stock Bun:

```
Error: This runtime has no Bun.ant.CellSegmenter.
Run Claude Code on the @anthropic-ai/bun-internal version pinned in package.json.
```

It throws on every render, so nothing ever paints and the process sits idle until killed. There is
no fallback renderer and no env flag to select one — `CLAUDE_CODE_LEGACY_BUNDLE` is about git
bundle uploads and `CLAUDE_CODE_TUI_TRIAL` is a fullscreen upsell latch, neither is a renderer
switch. Five `Bun.ant` APIs are referenced in total (`CellSegmenter`, `memoryPressureLevel`,
`getPeerUid`, `getPeerPid`, `setDumpable`); only `CellSegmenter` blocks startup.

`CellSegmenter` is not a thin shim: it shapes text directly into a packed terminal cell grid
(`Int32Array`/`BigInt64Array` screen buffers, width masks, wide-char spacer head/tail, char-pool
indices). A JS polyfill is conceivable via `Intl.Segmenter` plus an East-Asian-width table, but it
means reimplementing a native hot path from its observed surface, and any mismatch shows up as
corrupted rendering.

Waiting for an older release doesn't help either: 2.1.280 — the oldest version the Opus 5.5
server gate accepts — already contains the `CellSegmenter` guard, so no version can be both
new enough for the 5.5 models and old enough to predate the native renderer.

## The interactive path: `claude-repl`

The renderer is the only thing that needs the private fork. The conversation engine doesn't, and
the CLI exposes it directly:

```sh
claude --print --verbose --input-format stream-json --output-format stream-json
```

That is a persistent multi-turn session — not one shot per process — speaking newline-delimited
JSON in both directions, with no renderer anywhere in the path. `claude-repl.js` is a ~90-line
client over it: readline prompt, token-by-token streaming via `--include-partial-messages`, tool
calls and results shown as they happen, type-ahead queued while a turn runs, and Ctrl-C mapped to
the session's `interrupt` control request (the turn aborts, the session survives).

```sh
claude-repl                                   # defaults
claude-repl --model claude-opus-5-5           # extra flags pass through to the CLI
claude-repl --permission-mode acceptEdits
```

Two notes on Ctrl-C: readline swallows it on a TTY and emits its own event, so the client listens
on both `rl` and `process`; and at an idle prompt it exits rather than interrupting. Slash
commands are the CLI's, not the TUI's — `/exit` and `/quit` are handled locally.

What's missing relative to the real TUI is the TUI: no scrollback pane, no diff viewer, no
interactive permission prompts (pick a `--permission-mode` up front), no `/`-menu.

## Install

```sh
pkg install bun nodejs
./install.sh            # latest release
./install.sh 2.1.295    # a specific one
```

Installs a tree under `~/.local/share/claude-code-bun/<version>/` plus two wrappers in
`$TERMUX_PREFIX/bin`: `claude-bun` (the CLI) and `claude-repl` (the interactive client). An
existing npm-installed `claude` is left alone.

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
- `claude-repl` has no interactive permission prompt, so tool-heavy work needs an explicit
  `--permission-mode`.

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
- `claude-repl.js` — interactive client over the CLI's stream-json session mode
- `install.sh` — download, unpack, rewrite, install the `claude-bun` / `claude-repl` wrappers

> Unpacks a local copy of Anthropic's Claude Code for personal use on an otherwise-unsupported
> platform. Not affiliated with Anthropic.
