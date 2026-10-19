<div align="center">

<img src="icon.svg" width="112" height="112" alt="dsh-auto-rename icon" />

# dsh-auto-rename

**Automatic conversation naming for DeepSeek Harness.**
Titles name themselves, refresh as the conversation grows, and the rename dialog streams
AI suggestions.

[![version](https://img.shields.io/badge/version-0.2.0-4176e6)](package.json)
[![license](https://img.shields.io/badge/license-MIT-4176e6)](LICENSE)
[![dsh](https://img.shields.io/badge/DSH-0.2.1--rc.2-6b7280)](#known-limits)
[![node](https://img.shields.io/badge/node-%E2%89%A522.19-6b7280)](package.json)
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/theflippy978/dsh-auto-rename)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

English · [中文](README.zh.md)

</div>

---

## Features

**Names the conversation, and keeps up with it.** The first human message gets an AI title;
after that, every new message re-reads the recent ones and refreshes it, so the title follows
a topic that has moved on. Turn "Refresh title as the conversation grows" off and it goes back
to naming the first message once. A manual rename pins the title either way, so it is never
rewritten under your hands.

**Suggests titles when you rename.** The **AI Name** button sits at the top of the conversation
page. Its dialog looks and behaves like DSH's native rename window, with three extra things:

| | |
|---|---|
| Streaming candidates | Suggestions arrive one at a time (NDJSON), each revealed by a 500 ms left-to-right sweep |
| One-click apply | Click a chip to fill the input; **Regenerate** for a fresh set |
| Native feel | Enter confirms, Esc closes, and Enter during IME composition never submits by mistake |

**Uses a model you choose.** Naming follows the conversation's main model by default, or pins a
cheaper one. The dropdown is built from the host's `remote.session.modelCatalog()`, which
enumerates providers one by one and drops those that return nothing — so every entry is a model
the host has actually authenticated and can really call.

**Reasoning, handled for you.** A title needs three or four words, but a reasoning model spends
the budget thinking first — the same `max_tokens` the answer draws from. So four things happen
automatically:

| | |
|---|---|
| Off when it can be | The model's own switch-off level is sent when it declares one (named `off` on some gateways, `none` on others; only declared levels are ever trusted) |
| Lowest level when it can't | Otherwise the lowest effort the model itself declares. Some gateways silently ignore an undeclared level instead of erroring, so a hand-typed level just makes the UI lie |
| A bigger cap for reasoning models | Thinking that eats the budget returns an empty title; measured on one reasoning model, thinking ran 325–3172 tokens, so reasoning models get 4096 (the schema ceiling). The cap only bounds generation and returns at `stop`, so it does not slow anything down — the timeout is the real guard |
| One retry when thinking ate it | Retried only on a `max-tokens` cut, at most twice, each attempt getting its own full timeout; other failures repeat identically so they are not retried |

The in-dialog settings panel states which of the four applies: reasoning switched off / fell back
to the lowest level / not a reasoning model so no effort is sent / this model's capability could
not be read. Switching model refreshes that
line and the level list immediately.

**Leaves the audit trail.** The provider id `dsh-auto-rename` is written into `source.provider`
of every `session/title` event, so you can always tell which titles this plugin produced.

<details>
<summary><b>Why it builds its own dialog instead of extending the native one</b></summary>

The native rename window is an internal host component with no extension point: `RenameForm`
declares no injectable slot, the `requestSessionRename` it needs is passed only as a prop into
sidebar menu items, and nothing in the bundle `ctx.provide`s it. The plugin can therefore
neither insert a suggestion row into it nor open it programmatically. It builds its own dialog
and copies the native window's CSS rules one by one, so the two are visually indistinguishable.

</details>

## Install

```sh
dsh plugin add dsh-auto-rename
```

From a checkout instead:

```powershell
dsh plugin --profile desktop add <path-to-this-repo>
```

The package declares `dsh.bundle.patch`, so installing it also inserts `dsh-auto-rename` into
the profile's bundle stack **and disables the built-in `session-title-llm` row from dsh-base**.
That second part is required: `SessionTitleService.register()` accepts exactly one provider
globally, so if the built-in row registers first, this plugin's registration throws.

Restart DSH afterwards. Client-side changes hot-reload; host-side changes need the restart.

## Settings

Open the **AI Name** dialog and click the gear in its title row, left of the close button. The
panel expands inside the same dialog. Edits are staged in a draft and written only when you
press **Save**; an empty field means "use the default".

| Field | Default | Notes |
|---|---|---|
| Refresh title as the conversation grows | on | On: every new message re-reads the recent ones and refreshes. Off: the first message is named once. Suggestions keep working either way |
| Naming model | Follow main model | Lists only models the host has authenticated and can currently list |
| Reasoning level | auto | The levels offered are the ones **this model declares**; auto = switch it off if possible, otherwise the lowest |
| Suggestions | 3 | Candidates fetched per dialog open (1–5) |
| Output limit (tokens) | 256 | Per-generation cap (8–4096); raised to 4096 automatically when the model thinks |
| Timeout (ms) | 60000 | Longest wait for one generated title (1000–600000). A retry gets its own full budget, so the worst case is twice this |
| Title width (CJK characters) | 12 | **The only length knob** (1–400); longer output is truncated |

If the host has no remote assembled, or listing fails, the model row falls back to manual
**Provider** / **Model** fields. They must be filled in pairs: a half-set route logs a warning
at startup and errors clearly when used, rather than silently doing nothing.

## How it works

**It reads only what you typed.** Neither path looks at assistant replies: automatic naming
takes the six most recent human messages (only the first one is ever scheduled when the refresh
toggle is off), suggestions take the three most recent ones, so both describe the topic in
progress. Each message is clipped to `maxInputBytes` (default 4096) before it reaches the model,
because the official shared implementation throws on oversized input.

**Length is measured in display width, not characters.** One CJK character costs 2 half-width
units, everything else — spaces included — costs 1. The budget is `Title width × 2`, so the
default `12` allows 12 Chinese characters or 24 Latin characters including spaces, roughly
3–4 words. One knob governs both scripts; there is no separate word count for English, because
word lengths vary too much for a count to mean anything.

The official shared implementation still wants a `targetWords` value (prompt-only, never
truncating), so it is derived from the same budget at ~6 units per word — `12` yields `4`. That
keeps the model's target close to the hard cut instead of writing long and being trimmed.

**Truncation avoids mangling words.** A cut landing mid-word falls back to the previous space,
so you never get `sessio`. When there is no space to fall back to — a `provider/model` route, a
URL — the title is left alone: slightly too wide beats a broken word.

<details>
<summary><b>Why the plugin has to truncate at all</b></summary>

The official caller passes `Number.MAX_SAFE_INTEGER` as the truncation argument of
`normalizeSessionTitle` — that is, no truncation whatsoever. The host does enforce a
`maxTitleBytes` ceiling (80 bytes ≈ 26 CJK characters), but it is far too loose to keep titles
short. So "not too long" is this plugin's job, and the practical ceiling of the width knob sits
below the host's byte limit.

</details>

## Project layout

```
lib/config.js    Pure logic: config merge, source-message picking, title truncation.
                 Zero imports, testable on its own.
lib/index.js     Host half — registers the title provider and the HTTP bridge.
lib/client.js    Client half — header button, rename dialog, in-dialog settings panel.
cordis.patch.yml Bundle patch: insert this plugin, disable built-in session-title-llm.
locale/          Display metadata for the plugin manager (title, description).
test/            Self-checks: logic, host apply, client render, locale audit, patch.
```

The two halves talk over three HTTP routes, each accepting loopback origins only
(`127.0.0.1`, `::1`, `::ffff:127.0.0.1`) and rejecting `sec-fetch-site: cross-site`:

| Route | Purpose |
|---|---|
| `POST /dsh-auto-rename/suggest` | Stream N candidate titles as NDJSON |
| `POST /dsh-auto-rename/config` | Echo the currently effective config plus that model's reasoning capability (including whether reasoning was actually switched off), for debugging; with a `provider`/`model` pair it **only probes** that model and writes nothing |
| `POST /dsh-auto-rename/settings` | Write config through the host `settings` service, whitelist-filtered |

The write route answers **503** when the host `settings` service is absent, rather than
reporting success it did not achieve.

## Development

```powershell
npm run check
```

Six gates, all fast and all offline:

1. Syntax check of the host and config modules, plus a parse check of the client bundle.
2. Pure-logic self-test — config merge, message picking, the width budget and the byte budget.
3. Host `apply()` smoke against a fake context: metadata, degradation paths, provider shape,
   route guards, and the exact Config schema field list. The draft route on `/config` is
   probe-only and never mutates the effective config.
4. Client `apply()` smoke: renders the header entry and the settings panel for real, and covers
   all three catalog degradations. The fake context reproduces the host's restricted facade,
   including the fact that reading `ctx.inject` throws. The four reasoning states, the re-probe
   after switching model, and "only the host decides whether the switch-off level is `off` or
   `none`" are pinned down here too.
5. Locale audit: every dictionary key used in code exists in both zh and en.
6. Patch check: `cordis.patch.yml` disables the built-in row, inserts this one, and touches
   nothing else.

The smokes need `@deepseek-ai/schemastery`. Locally, junction it from an installed profile:

```powershell
New-Item -ItemType Junction -Path node_modules\@deepseek-ai\schemastery `
  -Target "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@deepseek-ai\schemastery"
```

`test/stubs/` holds a `dsh-session-title-llm` stand-in that echoes the arguments it receives, so
the call wiring can be verified outside DSH without reimplementing the official provider.

## Known limits

- **Slot renames fail silently.** The header button depends on `conversation.session.header.actions`,
  declared in DSH 0.2.1-rc.2. When a slot is not declared, the `slots.inject` callback never fires
  and nothing throws — so a host upgrade that renames it makes the button vanish without a
  trace. The version badge above records the host this was last verified against.
- **Settings are deliberately not on the host settings page.** Both available slots were tried
  (`plugins.bundle.config` and `plugins.item`): registration succeeds inside an instrumented
  stand-in, renders nothing in the real UI, and reports no error. The panel is therefore drawn
  inside the dialog and reads/writes over the HTTP bridge.
- **Prompts are the official ones.** Automatic naming and suggestions share a single LLM call
  path, delegated to the shared implementation in `@deepseek-ai/dsh-session-title-llm`, so
  prompts, timeouts and normalisation match the built-in provider exactly. Only the length cap
  is this plugin's addition.
- **Suggestions are not logged.** They do not write a `session/title-llm-request` event: that
  event is the one-shot audit record for automatic naming, and suggestions can be regenerated
  without limit, so logging them would bloat the session log.
- **The 4096 floor is a measured calibration, not a theory.** It was raised step by step from
  one and the same model repeatedly eating smaller budgets dry; a model that thinks even more
  verbosely needs a retest. Also, "the model declares a switch-off level" only means that level
  is sent to it — some gateways map it elsewhere and keep thinking anyway, and that case is
  covered by the retry, not by the judgement here.

## License

[MIT](LICENSE)
