# claude-termux

Keep the **model menu** of Claude Code current on Termux, where the CLI is permanently frozen at **v2.1.112** — the last JavaScript build.

## The problem

From v2.1.113 onward, `@anthropic-ai/claude-code` ships as **Bun-compiled native binaries** (glibc/musl, x64/arm64). There is no `linux-arm64-android` target, and Termux runs Android's Bionic libc, so the native binaries don't run. The JS *is* embedded inside those binaries, but it's compiled for the Bun runtime (`Bun.serve`, `bun:sqlite`, `import.meta.dir`, embedded x64 `.node` addons), so it can't run under Node either.

That leaves one native route on bare Termux: **stay on the 2.1.112 JS build and patch it.** The catch is that 2.1.112's model registry, normalizer, display switch, and `/model` picker hardcode the models that existed at the time — so every newer model silently falls back to Opus 4.

## The approach

`2.1.112` is a **fixed target**. Its registration sites and picker skeleton never change, so the templates are written once and only the *source binary* varies. `sync-from-binary.js` extracts model **data** from any newer native binary and ports it onto a pristine 2.1.112 copy:

1. **Registry sync** — reads every model's provider map / 1M flag from the binary (keyed on stable object shapes, not minified symbols), diffs against stock, and clones the `claude-opus-4-7` analog across all routing sites for each new model. Makes `--model <id>` work.
2. **Menu sync** — keeps 2.1.112's picker branch skeleton, repoints the default-opus alias to the newest Opus, relabels the Opus picker entries, and adds a Fable line when present.

No per-entry authoring — adding a model or bumping the primary is a data change.

## Usage

```bash
# 1. grab the latest native binary (any platform tarball embeds the same JS)
mkdir -p ~/cc-diff && cd ~/cc-diff
LATEST=$(npm view @anthropic-ai/claude-code-linux-x64 version)
curl -sL "https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-${LATEST}.tgz" -o native.tgz
tar xzf native.tgz   # -> package/claude

# 2. sync onto a PRISTINE stock 2.1.112 copy (never an already-patched file)
node sync-from-binary.js ~/cc-diff/package/claude   # writes cli.js.work

# 3. verify, then install
CLI=/data/data/com.termux/files/usr/lib/node_modules/@anthropic-ai/claude-code
cd "$CLI"
cp cli.js.work _run.mjs
node _run.mjs --model claude-opus-4-8 --print "Reply with exactly: OK"
node _run.mjs --model opus            --print "Reply with exactly: OK"
rm -f _run.mjs
cp cli.js cli.js.bak.$(date +%s) && cp cli.js.work cli.js && rm -f cli.js.work
```

Takes effect on next launch. See [`SKILL.md`](./SKILL.md) for the full workflow, per-plan picker branches, and how to adapt if upstream changes the registry/menu object shapes.

## Availability filtering

2.1.112 gates the picker by availability on its own. The assembled list passes through `RM6()`, which — when your account exposes an `availableModels` list — keeps only `Default` plus models that pass the membership check `Kq6()`. So a ported model the account can't use yet (offline, or access not granted) is **hidden automatically**, and appears once it lands in `availableModels` — no re-patching. This differs from 2.1.113+, which grey such entries out as `(disabled)` rather than hiding them. Only accounts with no `availableModels` list see every ported entry unfiltered. Selecting an unavailable model errors at request time, not in the CLI.

## Files

- `sync-from-binary.js` — the generator
- `SKILL.md` — Claude Code skill manifest + full reference

> Patches a local copy of Anthropic's Claude Code for personal use on an otherwise-unsupported platform. Not affiliated with Anthropic.
