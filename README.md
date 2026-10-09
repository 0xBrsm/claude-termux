# claude-termux

Run **current** Claude Code natively on Termux (aarch64, Android's Bionic libc).

## The problem, and why it turned out not to be one

From v2.1.113 onward, `@anthropic-ai/claude-code` ships as **Bun-compiled standalone binaries**
(glibc/musl, x64/arm64). There is no `linux-arm64-android` target, so those binaries don't run on
Termux. For a long time the only native option was to stay on **v2.1.112** — the last pure-JS
release — and patch newer models into its frozen model menu. That's the `sync-from-binary.js`
route, still in this repo and described below.

It's no longer necessary. Two things changed the picture:

1. Termux now packages a **native `bun`** (`pkg install bun`, aarch64-android).
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
`$TERMUX_PREFIX/bin`. An existing npm-installed `claude` is left alone, so you keep a fallback.

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

## Legacy: patching the frozen 2.1.112 build

Superseded by the above, kept because it still works and needs no `bun`.

v2.1.112's model registry, normalizer, display switch, and `/model` picker hardcode the models that
existed at the time, so every newer model silently falls back to Opus 4. Since 2.1.112 is a **fixed
target** — its registration sites and picker skeleton never change — the templates are written once
and only the *source binary* varies. `sync-from-binary.js` extracts model **data** from any newer
native binary and ports it onto a pristine 2.1.112 copy:

1. **Registry sync** — reads every model's provider map / 1M flag from the binary (keyed on stable
   object shapes, not minified symbols), diffs against stock, and clones the `claude-opus-4-7`
   analog across all routing sites for each new model. Makes `--model <id>` work.
2. **Menu sync** — keeps 2.1.112's picker branch skeleton, repoints the default aliases to the
   newest Opus/Sonnet/Haiku, relabels the picker entries, and adds a Fable line when present.

```bash
node sync-from-binary.js path/to/package/claude   # writes cli.js.work next to the install
```

Note that this route is subject to a server-side `claude_code_version_too_old` gate: a model newer
than some minimum client version is refused no matter what the local CLI claims, and spoofing the
client version string does not defeat it (measured — the gate does not read it from the request).
Running the real current version, as above, sidesteps the gate entirely.

See [`SKILL.md`](./SKILL.md) for the full workflow, per-plan picker branches, and how to adapt if
upstream changes the registry/menu object shapes.

### Availability filtering

2.1.112 gates the picker by availability on its own. The assembled list passes through `RM6()`,
which — when your account exposes an `availableModels` list — keeps only `Default` plus models that
pass the membership check `Kq6()`. So a ported model the account can't use yet is **hidden
automatically**, and appears once it lands in `availableModels`. This differs from 2.1.113+, which
greys such entries out as `(disabled)` rather than hiding them.

## Files

- `bunx.js` — Bun standalone-graph parser and extractor
- `rewrite.js` — repoints embedded `$bunfs` paths at a real directory
- `install.sh` — download, unpack, rewrite, install the `claude-bun` wrapper
- `sync-from-binary.js` — legacy 2.1.112 model-menu generator
- `SKILL.md` — Claude Code skill manifest + full reference for the legacy route

> Unpacks and patches local copies of Anthropic's Claude Code for personal use on an
> otherwise-unsupported platform. Not affiliated with Anthropic.
