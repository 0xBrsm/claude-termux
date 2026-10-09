---
name: patch-cli-model
description: FALLBACK ONLY — superseded by unpacking the Bun standalone graph and running the current release under Termux's native bun (see install.sh/bunx.js in this repo). Syncs the locked Termux Claude Code CLI (v2.1.112, last JS build) to a newer version's model menu by extracting the model registry + picker from a newer native binary and porting them onto a pristine 2.1.112 copy. Use only when running the current version is not an option, e.g. no native bun available.
metadata:
  version: 3.0.0
---

# Patch CLI Model

> **Superseded.** Termux is no longer stuck on 2.1.112. `pkg install bun` provides a native
> aarch64-android Bun, and a `--compile` payload keeps full source text for every module (the
> embedded JSC bytecode is only a startup optimization Bun skips when absent), so the current
> release can be unpacked and run directly — see `install.sh` / `bunx.js` in this repo. Prefer
> that: it runs the real version instead of grafting model entries onto an old one, and it is not
> subject to the server-side `claude_code_version_too_old` gate described in step 3 below, so
> models like `claude-opus-5-5` just work. Use this skill only as a fallback, e.g. if `bun` is
> unavailable.

Ports a newer Claude Code version's model menu onto the frozen Termux JS build at:

```
/data/data/com.termux/files/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js
```

Termux can't upgrade past **2.1.112** because 2.1.113+ are Bun-compiled standalone binaries (glibc/musl x64/arm64 only — no `linux-arm64-android`, and Termux is Bionic libc). The newer versions' JS is embedded in those binaries but is Bun-runtime code (`Bun.serve`/`Bun.file`/`bun:sqlite`/`import.meta.dir`) so it can't run under Node — see the "Why not just run the new JS" note below.

## The approach: generic sync, not bespoke patching

2.1.112 is a **fixed target** — its registration sites and picker skeleton never change. So we build the templates once and only ever vary the *source binary*, extracting model DATA from it. No per-entry authoring.

`sync-from-binary.js` does two things against a pristine stock copy:
1. **Registry sync** — extracts every model's provider map / 1M flag from the binary (keyed on stable object shapes, not minified symbols), diffs against stock, and clones the `claude-opus-4-7` analog across all routing sites for each new model. Makes `--model <id>` work.
2. **Menu sync** — keeps 2.1.112's `cjY` branch skeleton but refreshes every place a model name is hardcoded: repoints the default-opus alias (`LE()`) to the newest Opus, relabels the five Opus helpers (`pvK/RvK/V37/IvK/CvK`) and the three Sonnet helpers (`mjY/SvK/bvK`) to the newest Opus/Sonnet, relabels the **static** org-branch entries the helper swaps miss (the `QjY` Sonnet object and the `uT6` "Default (recommended)" description fn), relabels the **separate** `xW()` marketing-name lookup (used for "You are powered by the model named X" system-prompt text — not a picker helper, easy to miss), and adds a Fable line to **all** picker branches (Pro `KA`, default, and both `i7` org/Max sub-branches). Model names live in four kinds of sites — helper fns, static entry objects, description-only fns, and the `xW()` lookup — so all four are covered. It also extends two hardcoded per-family allowlists: `Aw6()` (an **Opus-only** predicate gating the Pro-plan "Opus unavailable" error, 529 opus-fallback, and an Opus kill-switch flag — append opus IDs only) and `vo()` (the **real** local 1M-context-window gate feeding `ff()`/`Jn()`'s auto-compact math, independent of the picker's 1M row — append any ctx1m-capable model). These two were previously conflated (a stale comment called the `Aw6()` site "1M capability"), which let a Sonnet and a Fable model leak into the Opus-only predicate while `vo()` — the site that actually controls the auto-compact window size — went unpatched, silently capping Sonnet 5's context at 200K instead of 1M.

## Workflow

### 1. Get the latest native binary

```bash
mkdir -p ~/cc-diff && cd ~/cc-diff
LATEST=$(npm view @anthropic-ai/claude-code-linux-x64 version)
curl -sL "https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-${LATEST}.tgz" -o native.tgz
tar xzf native.tgz   # -> package/claude  (Bun standalone, embeds the JS bundle as plaintext)
```

### 2. Ensure a pristine stock baseline exists

The sync reads from `cli.js.bak.1781844410` (pristine 2.1.112) by default — pass the stock path as arg 2 if yours is named differently (e.g. `cli.js.pristine`). Verify it's pristine — it must have **0** of `claude-opus-4-8` / `_z` vars / `Fable` / `PD_INSTR`. If you don't have a pristine backup, reinstall `@anthropic-ai/claude-code@2.1.112` once to recover it, then back it up. **Never sync on top of an already-patched file** — always start from stock.

### 3. Find the server-side version-gated models, then sync excluding them

The API rejects some newer models for an old client with HTTP 400 `claude_code_version_too_old`: *"Claude Code 2.1.112 does not support this model; version 2.1.280 or newer is required."* This gate is **server-side only** — the binary's model entries carry no min-version field (the `min_claude_code_version` strings in the binary belong to *effort-level* configs, not the model registry), so the sync cannot auto-detect it. It must be probed.

This matters beyond the single model: the sync promotes the **highest-sorting** model per family into the `opus`/`sonnet` aliases (`LE()`/`Af()`), `JK8()`, and every picker label. If that newest model is version-gated, the plain `opus` alias and the default picker row break even though every per-site patch reports `ok`. Probe first, then exclude the gated ids so promotion lands on the newest *usable* model:

```bash
CLI=/data/data/com.termux/files/usr/lib/node_modules/@anthropic-ai/claude-code
# 1. dry sync to list new models, 2. probe each, 3. re-sync with the gated ones excluded
cp cli.js.work _run.mjs
node _run.mjs --model <id> --print "Reply with exactly: OK"   # per new id
```

Distinguish the three failure modes — only the first is a reason to exclude:
- `400 claude_code_version_too_old` → **exclude it**; unusable on 2.1.112, nothing to be done client-side.
- `Usage credits are required for this model` / *"may not exist or you may not have access"* → account/server state, **keep it**; registration is correct and it starts working once access lands.
- anything else → a real patch bug; investigate.

**Spoofing the client version does not defeat this gate — tested, it does not work.** The version the server uses does not arrive in any request field the client controls. Confirmed by patching the version inside both UA builders (`yA()` → `claude-code/<v>`, `OI()` → `claude-cli/<v>`; the version literal is inlined ~130× by the bundler, so patching one function is not enough) and sniffing the real request via `ANTHROPIC_BASE_URL=http://127.0.0.1:8787`:

- outbound UA was verifiably `claude-cli/2.1.293` — the server still answered *"Claude Code **2.1.112** does not support this model"*.
- no `x-*` header carries a CLI version (`x-app:cli`, and `x-stainless-package-version` is the SDK's `0.81.0`, not the CLI's).
- the `anthropic-beta` list is not the fingerprint either: 2.1.112 and 2.1.293 both send `effort-2025-11-24`, and the six betas actually transmitted are identical.

So the version is resolved server-side from the OAuth session / account, not from the request. There is no string to send. Don't spend another cycle here — and note the gate is substantive, not cosmetic: 2.1.293 has ~279 `effort:` sites to 2.1.112's 34, so even with the gate lifted this build likely can't drive a model whose entry defaults to `effort:"medium"`.

```bash
node ~/.claude/skills/patch-cli-model/sync-from-binary.js ~/cc-diff/package/claude \
  "$CLI/cli.js.pristine" --exclude=<gated-id>,<gated-id>
# writes $CLI/cli.js.work ; prints detected-new models + per-site report
```

Excluded models are dropped from the registry entirely, so they're not `--model`-routable and never appear in the picker — strictly better than a visible row that 400s on use.

**As of 2026-10-07** (binary 2.1.293): `claude-opus-5-5` needs 2.1.280 and `claude-fable-5-1` needs 2.1.251 — both excluded. Usable: `claude-opus-5`, `claude-opus-4-8`, `claude-sonnet-5`, `claude-sonnet-5-5`, `claude-fable-5` (credit-gated). So `opus` → Opus 5, `sonnet` → Sonnet 5.5.

### 4. Verify (on the .work copy, before installing)

```bash
cd "$CLI"
cp cli.js.work _syn.mjs && node --check _syn.mjs && echo "SYNTAX OK"; rm -f _syn.mjs
cp cli.js.work _run.mjs
node _run.mjs --model claude-opus-4-8 --print "Reply with exactly: OK"   # new model routes
node _run.mjs --model opus            --print "Reply with exactly: OK"   # alias -> newest opus
rm -f _run.mjs
```

A model that is server-side offline/no-access returns *"It may not exist or you may not have access"* — that's the server, not a patch bug (registration is still correct). But a `400 claude_code_version_too_old` on the bare `opus`/`sonnet` alias means promotion landed on a version-gated model: go back to step 3 and re-sync with that id in `--exclude=`.

Also spot-check the three non-routing sites the sync touches (`xW`/`Aw6`/`vo` — see "Adapting if symbol mapping drifts" below for what each does). These don't show up in a `--print` routing test, so check the report line and the source directly:

```bash
cd "$CLI"
node ~/.claude/skills/patch-cli-model/sync-from-binary.js ~/cc-diff/package/claude \
  "$CLI/cli.js.pristine" --exclude=<same-ids-as-step-3> 2>&1 | grep -E "^(ok|MISS|MULTI)\s+(xW|S5|S5b)"
# every line should read "ok   ..." — a MISS/MULTI means that site's anchor text no longer
# matches (stock text changed, or you synced on top of an already-patched file)
grep -o 'function xW(q){[^}]*}' cli.js.work | head -c 400   # newest opus/sonnet/fable ids present?
grep -o 'function vo(q){[^}]*}' cli.js.work                # newest ctx1m-capable ids present?
grep -o 'function Aw6(q){[^}]*}' cli.js.work                # only opus ids present — no sonnet/fable
```

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

The generator hardcodes a small, stable set tied to 2.1.112 internals: stock anchor strings (the `claude-opus-4-7` analogs), pricing consts (`jB`/`GQ`/`_T1`), the alias resolver `LE()`, the Opus helpers (`pvK/RvK/V37/IvK/CvK`), the Sonnet helpers (`mjY/SvK/bvK`), the static org-branch entries (`QjY`, `uT6`), the marketing-name lookup `xW()`, the Opus-tier predicate `Aw6()`, the 1M-context-window gate `vo()`, and the `cjY` branch shape. These belong to the *frozen 2.1.112*, so they don't change.

Two independent things can drift, on the **source binary** side only:
- **Registry/object shapes** (what we parse out of the binary). 2.1.197 moved from flat `{firstParty:..}` objects to declarative `{id,family,provider_ids:{first_party,..,gateway},..,supports_1m_beta}` entries plus an explicit id→key map; `extractModels()` already handles that shape. If a future binary restructures it again, update the regexes in `extractModels()` only.
- **New picker *slots*** in the menu. The skill refreshes the slots 2.1.112 already has. If the newer version adds a brand-new hardcoded model-name site to 2.1.112's skeleton (a new static entry object or description fn, like `QjY`/`uT6` were), add a matching `P.patch(...)` in `syncMenu()`. Symptom: the picker shows a stale model name that none of the existing relabels touch — grep the installed `cli.js` for the stale string in a `label:`/`description:`/`return"…"` context to find the site.

## Known coverage gaps

**Check the "new:" line against the binary's own key map every run.** A model that fails the `provider_ids` regex used to be skipped in silence, indistinguishable from one the binary doesn't ship — that's how `claude-haiku-5-5` (whose entry has **no `gateway` slot**) got left out of an entire sync while all 33 patch sites still reported `ok`. `extractModels()` now treats `anthropic_google_cloud` and `gateway` as optional and prints `WARN unparsed (...)` for anything in the authoritative key map it couldn't parse. That warning means those models are **not ported** — fix the regex, don't ship around it. To audit independently:

```bash
# every id in the binary's routable key map should appear in "new:" or already be in stock
grep -ao '{"claude-3-5-haiku":"haiku35".\{0,900\}' ~/cc-diff/package/claude | head -1
```

**Haiku promotion moves the background model.** Opus, Sonnet and Haiku all get promoted now, but Haiku is not a cosmetic relabel like the other two: `VQ` is the alias key `xT6()` resolves, and Haiku is what Claude Code runs for summarization and title generation. Promoting it changes which model does that work. `UjY()` compares `xT6()` against the same key, so `VQ` and `UjY()` must move together — patch one without the other and the picker silently falls through to `gjY()`, dropping the Haiku row entirely. Fable is still never promoted: its row uses the *first* fable in map order, not the newest.

**Mythos is absent by design, not by oversight.** `claude-mythos-5`/`-5-1` exist as model entries but are missing from the binary's id→key map, so they aren't routable in the stock client either. The `FAMILIES` filter and the `if (!key) continue` guard both drop them; that matches upstream.

## Availability filtering (good news, not a limitation)

2.1.112 gates the picker by availability on its own. `cjY()`'s list passes through `RM6()`, which — when the account exposes an `availableModels` list — keeps only `Default` plus models that pass `Kq6()` (membership in that list). So a ported model the account can't use yet (offline, or access not granted) is **hidden automatically**, and shows up once it lands in `availableModels` — no re-patching. This differs from 2.1.113+, which grey such entries out as `(disabled)` rather than hiding them. Only accounts with no `availableModels` list see every ported entry unfiltered. Either way, selecting an unavailable model errors at request time, not in the CLI.

## Why not just run the new JS directly

The embedded bundle is Bun-runtime code (`Bun.serve` ×30, `Bun.file`, `bun:sqlite`, `import.meta.dir`), so **Node** can't run it. That part still holds, and it's why this skill patches JS rather than running the new bundle.

**But the old reason — "Bun needs glibc, Termux is Bionic" — is obsolete as of 2026-10.** Verified on this device:

- Termux packages Bun natively: `pkg install bun` → `bun/stable 1.4.2-4 aarch64`, 24 MB, no deps. `bun -e 'console.log(process.platform,process.arch)'` → `android arm64`.
- Bun hosts Claude Code's JS fine: `bun cli.js --version` → `2.1.112 (Claude Code)`, and `bun cli.js --model claude-haiku-5-5 --print …` completes a real API round trip.

So a native newer client is no longer categorically blocked — it's an unpacking problem. Still **no official target**: 2.1.295's `optionalDependencies` lists 8 platform packages (linux/win32/darwin × x64/arm64, +2 musl) and none is android/Bionic.

What a port would require, from inspecting the 2.1.293 arm64-era binary:
- Unpack the `$bunfs` archive: **2273 `.js` modules** plus ~135 `.zst`, 71 `.md`, 2 `.asset`. It is not one carvable `cli.js` — there's a structured file table near EOF (`bunfs` magic at ~252543854 of 252755128, trailing little-endian u64 offsets), so this needs a real Bun standalone-trailer parser.
- JSC bytecode is present alongside the source (`@bun @bytecode` marker), so confirm the plaintext modules are complete and not lazy-compile stubs.
- Native addons are a non-issue: only **two** (`clipboard-napi.node`, `audio-capture.node`), both peripheral and stubbable. No embedded ripgrep — Termux has its own.

Scope it as a project, not a patch. Until it's done, the JS-patch route in this skill remains the working path.
