---
name: patch-cli-model
description: Sync the locked Termux Claude Code CLI (v2.1.112, last JS build — Termux is stuck here because 2.1.113+ ship Bun-compiled native binaries with no Android target) to a newer version's model menu. Extracts the model registry + picker from any newer native binary and ports it onto a pristine 2.1.112 copy. Use when a new model/version has shipped and the locked CLI's /model picker or --model flag is out of date.
metadata:
  version: 2.0.0
---

# Patch CLI Model

Ports a newer Claude Code version's model menu onto the frozen Termux JS build at:

```
/data/data/com.termux/files/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js
```

Termux can't upgrade past **2.1.112** because 2.1.113+ are Bun-compiled standalone binaries (glibc/musl x64/arm64 only — no `linux-arm64-android`, and Termux is Bionic libc). The newer versions' JS is embedded in those binaries but is Bun-runtime code (`Bun.serve`/`Bun.file`/`bun:sqlite`/`import.meta.dir`) so it can't run under Node — see the "Why not just run the new JS" note below.

## The approach: generic sync, not bespoke patching

2.1.112 is a **fixed target** — its registration sites and picker skeleton never change. So we build the templates once and only ever vary the *source binary*, extracting model DATA from it. No per-entry authoring.

`sync-from-binary.js` does two things against a pristine stock copy:
1. **Registry sync** — extracts every model's provider map / 1M flag from the binary (keyed on stable object shapes, not minified symbols), diffs against stock, and clones the `claude-opus-4-7` analog across all routing sites for each new model. Makes `--model <id>` work.
2. **Menu sync** — keeps 2.1.112's `cjY` branch skeleton, repoints the default-opus alias (`LE()`) to the newest Opus, relabels the five Opus picker helpers, and adds a Fable line if present.

## Workflow

### 1. Get the latest native binary

```bash
mkdir -p ~/cc-diff && cd ~/cc-diff
LATEST=$(npm view @anthropic-ai/claude-code-linux-x64 version)
curl -sL "https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-${LATEST}.tgz" -o native.tgz
tar xzf native.tgz   # -> package/claude  (Bun standalone, embeds the JS bundle as plaintext)
```

### 2. Ensure a pristine stock baseline exists

The sync reads from `cli.js.bak.1781844410` (pristine 2.1.112) by default. Verify it's pristine — it must have **0** of `claude-opus-4-8` / `_z` vars / `Fable` / `PD_INSTR`. If you don't have a pristine backup, reinstall `@anthropic-ai/claude-code@2.1.112` once to recover it, then back it up. **Never sync on top of an already-patched file** — always start from stock.

### 3. Run the sync

```bash
CLI=/data/data/com.termux/files/usr/lib/node_modules/@anthropic-ai/claude-code
node ~/.claude/skills/patch-cli-model/sync-from-binary.js ~/cc-diff/package/claude
# writes $CLI/cli.js.work ; prints detected-new models + per-site report
```

### 4. Verify (on the .work copy, before installing)

```bash
cd "$CLI"
cp cli.js.work _syn.mjs && node --check _syn.mjs && echo "SYNTAX OK"; rm -f _syn.mjs
cp cli.js.work _run.mjs
node _run.mjs --model claude-opus-4-8 --print "Reply with exactly: OK"   # new model routes
node _run.mjs --model opus            --print "Reply with exactly: OK"   # alias -> newest opus
rm -f _run.mjs
```

A model that is server-side offline/no-access returns *"It may not exist or you may not have access"* — that's the server, not a patch bug (registration is still correct).

### 5. Install

```bash
cp cli.js cli.js.bak.$(date +%s)   # back up current
cp cli.js.work cli.js && rm -f cli.js.work
```

Takes effect on next CLI launch (the running process already loaded the old file). Then open `/model` to eyeball the picker.

## Per-plan picker branches

`cjY()` renders a different menu per account type. Selectors map to the newer binary's equivalents:
- `i7()` (org/enterprise OAuth token w/ scopes) → sub-branch `ch()||Yq6()` = **Max / Team-Premium(`default_claude_max_5x`) / Enterprise-usage-based** (1M + extra-usage lines).
- `KA()` (`firstParty`/`anthropicAws`) → **Pro** and raw API key.
- default → bedrock/vertex/foundry.

You can only render-test the branch your login falls under. `--print` tests routing regardless of branch.

## Adapting if symbol mapping drifts

The generator hardcodes a small, stable set tied to 2.1.112 internals: stock anchor strings (the `claude-opus-4-7` analogs), pricing consts (`jB`/`GQ`/`_T1`), the alias resolver `LE()`, the five Opus helpers (`pvK/RvK/V37/IvK/CvK`), and the `cjY` branch shape. These belong to the *frozen 2.1.112*, so they don't change. If a future binary restructures the registry/menu *object shapes* (what we parse out), update the regexes in `extractModels()` only.

## Availability filtering (good news, not a limitation)

2.1.112 gates the picker by availability on its own. `cjY()`'s list passes through `RM6()`, which — when the account exposes an `availableModels` list — keeps only `Default` plus models that pass `Kq6()` (membership in that list). So a ported model the account can't use yet (offline, or access not granted) is **hidden automatically**, and shows up once it lands in `availableModels` — no re-patching. This differs from 2.1.113+, which grey such entries out as `(disabled)` rather than hiding them. Only accounts with no `availableModels` list see every ported entry unfiltered. Either way, selecting an unavailable model errors at request time, not in the CLI.

## Why not just run the new JS directly

The native binary's embedded `cli.js` is extractable (plaintext in the `$bunfs` section) but compiled for the **Bun** runtime (`Bun.serve` ×30, `Bun.file`, `bun:sqlite`, `import.meta.dir`, embedded x64 `.node` addons). Node can't run it, and Bun needs glibc (Termux is Bionic). Running it would mean a glibc env (proot) — at which point you'd just run the glibc `claude` binary directly. The JS-patch route is the only one that stays native on bare Termux.
