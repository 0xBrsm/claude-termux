# claude-termux

Run current Claude Code on Termux (aarch64, Android's Bionic libc) under Termux's own `bun`,
including the real interactive TUI.

```sh
pkg install bun ripgrep
./install.sh            # latest release; run again to upgrade
./install.sh 2.1.295    # a specific one
claude
```

This installs the unpacked release to `~/.local/share/claude-code-bun/<version>/` and a `claude`
wrapper to `$TERMUX_PREFIX/bin`. After the new version starts, older version directories are
deleted. The repo contains no Claude Code code. The installer downloads the official release
(~250 MB) and patches it locally. To reuse a binary you already have:

```sh
BINARY=path/to/package/claude ./install.sh 2.1.295
```

If an npm-installed `claude` is present, the wrapper replaces its launcher, but npm may restore
it later. Run `npm uninstall -g @anthropic-ai/claude-code` first.

## Status

Tested on 2.1.293 and 2.1.295 under Termux's `bun` 1.4.2. These all work:

- the interactive TUI, with multi-turn conversation, streaming, and Ctrl-C
- `-p` / `--print`, subcommands, and live API requests
- tools: Bash, file edits, Grep, Glob
- current models: `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`

The current models are the reason this repo exists. The server refuses them to the frozen 2.1.112
build (see below).

## How it works

From v2.1.113 onward, Claude Code ships only as **Bun-compiled standalone binaries**, with no
`linux-arm64-android` target. Two facts get past that:

1. Termux packages a **native `bun`**.
2. The standalone payload stores **full source text for every module**. The embedded bytecode is
   only a startup optimization that Bun skips when absent, so the binary's architecture doesn't
   matter.

`install.sh` runs two scripts:

**`extract.js <binary> <dir>`** reads the module graph from the payload's tail and writes out each
module's source. The format is documented at the top of the file and in Bun's
`src/standalone_graph/StandaloneModuleGraph.rs`.

**`patch.js <dir>`** makes three changes:

1. **Paths.** It replaces the embedded `/$bunfs/root/` prefix with the install directory. The
   pattern includes `root/` on purpose: the runtime's own "am I a standalone binary?" checks match
   `$bunfs` without it, and they must stay intact.
2. **Renderer shim.** The TUI renderer calls `Bun.ant.CellSegmenter`, a native API in
   **Anthropic's private Bun fork** (`@anthropic-ai/bun-internal`). Stock bun doesn't have it:

   ```
   Error: This runtime has no Bun.ant.CellSegmenter.
   ```

   The error is thrown on every render, and no fallback renderer exists. `bun-ant-shim.js`
   reimplements the API in JavaScript, reconstructed from the renderer's call sites; its header
   documents the contract. It segments graphemes with `Intl.Segmenter`, measures width with
   `Bun.stringWidth`, and paints into the renderer's packed cell grid. `patch.js` renames the
   entry module to `cli.mjs` and imports the shim as its first statement. `bun --preload` wouldn't
   work, because the app re-execs itself (for example after the folder-trust prompt) and the
   preload would be lost. The code references four other `Bun.ant` APIs, but none of them block
   startup.
3. **Search tools.** The upstream binary also embeds `ugrep` and `bfs`, and a build-time flag tells
   the app so. With the flag set, the app hides the Grep and Glob tools. It also makes the Bash
   tool's `grep` and `find` re-run the app's own executable, which under stock bun is `bun`, so
   they printed bun's help instead. `patch.js` turns the flag off. Ripgrep already falls back to
   the system `rg`.

Steps 2 and 3 depend on minified code. If a release changes it, `patch.js` stops with an error;
it doesn't install a half-patched tree. If the TUI renders corrupted output after an upgrade, the
renderer's contract has probably changed. `-p` and `--input-format stream-json` don't use the
renderer, so they keep working.

## Known gaps

- `audio-capture.node` and `clipboard-napi.node` are x86-64 binaries and can't load on arm64. Both
  load lazily, so startup works, but voice input and the native clipboard fail.
- Upgrade by re-running `install.sh`. Claude Code's built-in updater expects the standalone binary.

## Why not patch the frozen 2.1.112 build instead

That was this repo's original approach: add newer models to 2.1.112's hardcoded model list and
`/model` picker. It worked, but it can't keep working. It was removed in `c16e611` and is still in
history.

For newer models, the API answers an old client with HTTP 400 `claude_code_version_too_old`.
**That check can't be defeated on the client side.** The server resolves the version from the
OAuth session, not from anything the client sends. In a test with both user-agent builders patched
and the outbound request sniffed via `ANTHROPIC_BASE_URL`, the user agent read
`claude-cli/2.1.293`, and the server still answered *"Claude Code 2.1.112 does not support this
model"*.

The minimum version also rises with each model; `claude-opus-5-5` requires 2.1.280. So the set of
models a patched 2.1.112 can reach only shrinks.

## Files

- `install.sh` downloads, extracts, patches, and installs the `claude` wrapper.
- `extract.js` extracts the module sources from a Bun standalone binary.
- `patch.js` rewrites the paths, injects the shim, and disables the search-tools flag.
- `bun-ant-shim.js` is the JavaScript stand-in for `Bun.ant.CellSegmenter`.

> This repo unpacks a local copy of Anthropic's Claude Code for personal use on an otherwise
> unsupported platform. It is not affiliated with Anthropic.
