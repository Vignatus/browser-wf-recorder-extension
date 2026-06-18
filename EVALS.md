# Extension Evals

Evaluation of recording and replay behaviour across workflow types.

---

## Unit tests (automated)

All unit tests pass (`npm test`).

| Suite | Coverage |
|---|---|
| `normalizer.test.js` | Input collapsing, keystroke-gap splitting, multi-field separation, click interruption, primarySelector grouping, strategy detection (setValue vs keystrokes), scroll deduplication |
| `replay-fallback.test.js` | Locator fallback chain: CSS → XPath → text match → coordinates; backward compatibility with old-format steps; no-duplicate selector list |
| `locators.test.js` | `getTarget` locator priority (data-testid, id, aria-label, name, placeholder, href, CSS path); XPath generation; `cssQ`/`xpQ` quoting helpers |

---

## Manual workflow evaluations

### Passed

- **Form fill and submit** — navigate to page, type into multiple fields, click submit button, assert final URL path. All steps recorded and replayed correctly.
- **Dropdown (select)** — `<select>` elements matched by value and visible text fallback.
- **Checkbox toggle** — check and uncheck replayed correctly via `.click()` on the element.
- **Multi-step navigation** — recordings spanning multiple page navigations (navigate steps) replay reliably; page-load wait fires before next step.
- **Elements with data-testid** — most stable locator; replays survive UI refactors that change element position or CSS class.
- **Backend sync** — recordings and replay results (status, duration, summary, per-step events) persist to the backend after completion.

### Failed / unreliable

- **Shadow DOM elements** — content inside `<shadow-root>` is not reachable by `document.querySelector`. Steps targeting shadow DOM elements fail at replay with "Element not found".
- **iframes** — elements inside cross-origin or same-origin iframes are not captured during recording and cannot be replayed.
- **File upload inputs** — `<input type="file">` interactions are not captured or replayed.
- **Drag and drop** — no recording support for `dragstart`/`drop` events.
- **Canvas / WebGL interactions** — coordinate-only fallback is used, which breaks on any viewport size change between record and replay.
- **Recordings with no final assertions** — replay always ends with status `failed` and the message "No final assertions defined". A final assertion must be added manually before a replay is meaningful.
- **Dynamic selectors (random IDs)** — when a site generates IDs like `id="input_a3f2c"` on each load, the CSS fallback chain falls back to recorded coordinates.

---

## Known limitations

- **No assertion authoring UI** — final assertions (URL path, element visibility, text presence) must be added by editing the recording JSON directly via the backend API. There is no in-extension UI to create them.
- **Service worker lifetime** — Chrome may terminate the background service worker during a very long replay (>5 min). The replay state is lost and the backend replay row is left in `running` status.
- **Scroll steps are imprecise** — scroll is replayed by calling `window.scrollTo(x, y)`. Pages using virtual scrolling or scroll-driven animations may not behave identically.
- **Single-tab only** — the recorder captures events from one tab at a time. Workflows that open popups or new tabs to complete a flow cannot be fully replayed.
- **Screenshots on failure** — failure screenshots are captured as in-memory JPEG and displayed in the popup UI but are not persisted to the backend.
