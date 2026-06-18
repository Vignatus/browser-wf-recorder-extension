# AI Usage

This codebase was developed in close collaboration with [Claude](https://claude.ai) (Anthropic), used as an AI coding assistant throughout the project via Claude Code.

---

## Scope of AI involvement

The entire extension codebase (~2,800 lines across core files) was written with AI assistance. The human developer drove all product decisions, reviewed every output, and directed iteration. AI was responsible for implementation.

### Files and what AI contributed

| File | AI contribution |
|---|---|
| `background.js` | Full implementation — recording lifecycle, CDP attachment, storage, backend sync, auth, message bus |
| `replay.js` | Full implementation — `ReplayEngine` class, step dispatch, locator fallback chain, final assertion evaluation, pause/step-by-step mode |
| `normalizer.js` | Full implementation — raw CDP/DOM event pipeline to replayable steps; input collapsing, scroll deduplication, navigation deduplication |
| `sanitizer.js` | Full implementation — sensitive header and URL redaction before persisting to storage |
| `content.js` | Full implementation — DOM event capture (click, input, select, scroll, navigation), `getTarget` locator generation, CSS path builder |
| `popup.js` / `popup.html` | Full implementation — recording controls, replay UI, auth login form, tab switching, context menu, polling loop |
| `popup.css` | Full implementation |
| `tests/` | Full implementation — unit tests for normalizer, locator fallback chain, and locator helper utilities |

---

## Design decisions made with AI

- **Locator fallback chain** — the priority ordering (data-testid → id → aria-label → name → placeholder → href → CSS path → XPath → text match → coordinates) was designed collaboratively based on selector stability tradeoffs.
- **Input collapsing strategy** — merging consecutive keystrokes into a single `type` step using a per-gap window (rather than a total-elapsed window) was an AI suggestion to handle slow typists correctly.
- **Sensitive data redaction** — the sanitizer's header/URL redaction approach and the list of sensitive patterns were designed with AI input.
- **JWT auth flow** — cookie-based session for the web dashboard and Bearer token for the extension API were both architected with AI assistance.
- **Replay event storage** — the decision to POST per-step log entries to `replay_events` after replay completion (rather than streaming them live) was an AI recommendation.

---

## What the human developer directed

- Overall product concept and goals
- Which features to build and in what order
- UI layout and workflow decisions
- Acceptance of, rejection of, and iteration on all AI output
- Identification of bugs (e.g. the race condition in remote replay creation, the missing replay events sync)
- Decision to remove the JSON download feature once the backend was connected

---

## Model

Claude Sonnet 4.6 (`claude-sonnet-4-6`) via Claude Code CLI.
