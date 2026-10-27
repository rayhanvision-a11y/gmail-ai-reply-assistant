# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Two parallel implementations of the same product (**Gmail AI Reply Assistant**) coexist in this directory. They are independent — a change to one does not propagate to the other.

1. **Chrome Extension (Manifest V3)** — the primary, actively-developed implementation. Injects a UI into `mail.google.com` and calls AI providers directly from a service worker.
2. **Google Apps Script Gmail Add-on** (`*.gs` + `appsscript.json`) — a legacy/alternate implementation using CardService. Only Gemini is wired up here.

If a task doesn't specify which, assume the Chrome extension.

## Build / run / test

There is no build step, bundler, package manager, or test suite. Code is loaded directly by Chrome / Apps Script.

**Chrome extension — load & reload:**
1. `chrome://extensions` → Developer mode → "Load unpacked" → select this directory.
2. After edits: click the reload icon (🔄) on the extension card, then reload `mail.google.com`.
3. Logs: service worker logs in the extension's "service worker" devtools link; content script and popup logs in their respective page devtools.

**Apps Script — deploy:** push the `*.gs` files + `appsscript.json` with `clasp` or via the Apps Script editor; test as a Gmail add-on compose action.

## Architecture — Chrome extension

Three isolated contexts communicate via `chrome.runtime.sendMessage` / `chrome.storage.local`:

- **`content/content.js`** (708 lines, runs on `mail.google.com`) — The heavy piece. Uses a `MutationObserver` to detect Gmail compose toolbars and inject the "✨ AI Reply" button, modal UI, smart reply chips, length selector, and the post-generation "Try Another Version / Undo" floating actions. Also **intercepts clicks on Gmail's native "Help me write" / Submit pen icon** and redirects them to open our modal (see click listener near top of file — be careful not to break this when touching event handling). Extracts incoming email context (sender/subject/body) from Gmail's DOM and posts a `GENERATE_REPLY` or `POLISH_DRAFT` message to the service worker.
- **`background/service-worker.js`** — Single message router (`GENERATE_REPLY`, `POLISH_DRAFT`, `VALIDATE_API_KEY`). The `callAiProvider` function dispatches to one of three provider-specific functions (`callGemini`, `callOpenAI`, `callClaude`) based on `aiProvider` in `chrome.storage.local`. Prompt construction (`handleGenerateReply`, `handlePolishDraft`) composes a system prompt from tone / length / language / sign-off settings and delegates. Gemini has a **model-fallback cascade**: it iterates through a candidate list on 429/503/quota/not-found errors and caches the first working model as `activeModel`. OpenAI and Claude call fixed user-selected models with no fallback.
- **`popup/popup.{html,js,css}`** — Settings UI only (provider tabs, per-provider API key + model dropdown, tone/language/sign-off defaults, "⚡ Test Key" which sends `VALIDATE_API_KEY`). All state persisted in `chrome.storage.local`.

**Storage keys** (shared across contexts; grep for them before renaming): `aiProvider`, `geminiApiKey` / `openaiApiKey` / `claudeApiKey`, `openaiModel` / `claudeModel`, `activeModel` (Gemini's resolved model), `userSignOff`.

**Host permissions** are the three AI endpoints plus `mail.google.com`. Adding a new provider requires updating `manifest.json` host_permissions, popup UI, storage keys, and `callAiProvider` dispatch.

## Architecture — Apps Script add-on

- `Code.gs` — entry point `onGmailCompose(e)`, extracts email context via Gmail advanced service.
- `UI.gs` — `CardService` card builders.
- `GeminiService.gs` — Gemini-only API call via `UrlFetchApp`.
- `Settings.gs` — reads/writes `PropertiesService` for the API key.
- `appsscript.json` — manifest; OAuth scopes include `gmail.readonly` and `script.external_request`.

Note: the Apps Script side does **not** share code or storage with the Chrome extension — they're separate products that happen to live in one folder.

## Conventions worth knowing

- `cleanAiOutput()` in the service worker strips triple-backtick code fences from model output — all provider responses go through it. Replicate this if adding a new provider.
- Gemini uses a single-string prompt (system+user concatenated); OpenAI uses `messages` with a `system` role; Claude uses a top-level `system` field + `messages`. Keep the per-provider branches in `callAiProvider` aligned when changing prompt shape.
- The Claude call sets `anthropic-dangerous-direct-browser-access: true` because the request originates from the extension's service worker (browser context).
- README is primarily in Bengali; UI copy supports Bengali ("bn") and English ("en") with auto-detect as default.
