// normalizer.js
// Pure function: raw CDP/DOM events → clean, replayable workflow steps.

const TYPE_MERGE_WINDOW   = 2000; // ms — max gap BETWEEN consecutive keystrokes to collapse
const NAV_DEDUP_WINDOW    = 500;  // ms — collapse redirect chains, keep final URL
const SCROLL_MIN_DISTANCE = 150;  // px — ignore tiny scrolls

// ── Input-collapsing helpers ──────────────────────────────────────────────────

// Stable key for grouping consecutive input events on the same element.
// Prefers target.primarySelector (stable, attribute-based) over the path-based
// CSS selector so the grouping is consistent with the new multi-locator system.
function _selectorKey(evt) {
  return evt.data?.target?.primarySelector ?? evt.data?.selector ?? '';
}

// Decide how the replay engine should re-execute a type step:
//   setValue   — set element.value directly (fast, safe for plain text fields)
//   keystrokes — type character-by-character (needed for inputs that react to
//                each keystroke, e.g. search boxes, comboboxes, spinbuttons)
function _inputStrategy(evt) {
  const role      = evt.data?.target?.role || '';
  const inputType = evt.data?.inputType    || '';
  if (
    inputType === 'search'   ||
    role === 'combobox'      ||
    role === 'searchbox'     ||
    role === 'spinbutton'
  ) return 'keystrokes';
  return 'setValue';
}

export function normalizeEvents(rawEvents) {
  if (!rawEvents || rawEvents.length === 0) return [];

  const steps = [];
  let i = 0;

  while (i < rawEvents.length) {
    const evt = rawEvents[i];

    // ── Text input: merge runs of input events on the same element ──────────
    // Collapse consecutive dom:input events into one step when:
    //   • they target the same element (matched by primarySelector or CSS selector)
    //   • each keystroke arrives within TYPE_MERGE_WINDOW of the previous one
    //   • no other event type (click, navigation, …) interrupts the run
    // The final value wins. strategy tells the replay engine how to re-execute.
    if (evt.type === 'dom:input') {
      const key      = _selectorKey(evt);
      const strategy = _inputStrategy(evt);
      let j        = i + 1;
      let finalEvt = evt; // tracks the last accepted event in the run

      while (
        j < rawEvents.length &&
        rawEvents[j].type === 'dom:input' &&
        _selectorKey(rawEvents[j]) === key &&
        // Compare consecutive gaps, not total elapsed from the first event.
        // This allows long typing sessions (e.g. 10 chars at 1 s each) to
        // merge correctly while still splitting on pauses > TYPE_MERGE_WINDOW.
        rawEvents[j].timestamp - rawEvents[j - 1].timestamp < TYPE_MERGE_WINDOW
      ) {
        finalEvt = rawEvents[j];
        j++;
      }

      steps.push({
        id: uid(),
        stepType: 'type',
        strategy,
        timestamp: evt.timestamp,
        url: evt.tabUrl,
        selector: evt.data.target?.primarySelector ?? evt.data.selector,
        label: evt.data.label,
        value: finalEvt.data.value,
        target: evt.data.target ?? null,
        metadata: {
          inputType:     evt.data.inputType,
          rawEventRange: { start: i, end: j - 1 },
        },
      });
      i = j;
      continue;
    }

    // ── Navigation: collapse redirect chains, skip chrome:// / about: ───────
    if (evt.type === 'cdp:Page.frameNavigated') {
      let j = i + 1;
      let finalFrame = evt.data.frame;

      while (
        j < rawEvents.length &&
        rawEvents[j].type === 'cdp:Page.frameNavigated' &&
        rawEvents[j].timestamp - rawEvents[i].timestamp < NAV_DEDUP_WINDOW
      ) {
        finalFrame = rawEvents[j].data.frame;
        j++;
      }

      const url = finalFrame.url;
      if (!url.startsWith('chrome://') && !url.startsWith('about:') && url !== 'about:blank') {
        steps.push({
          id: uid(),
          stepType: 'navigate',
          timestamp: evt.timestamp,
          url,
          metadata: { title: finalFrame.name || '' },
        });
      }
      i = j;
      continue;
    }

    // ── Click ────────────────────────────────────────────────────────────────
    if (evt.type === 'dom:click') {
      steps.push({
        id: uid(),
        stepType: 'click',
        timestamp: evt.timestamp,
        url: evt.tabUrl,
        selector: evt.data.target?.primarySelector ?? evt.data.selector,
        label: evt.data.label,
        target: evt.data.target ?? null,
        metadata: {
          tagName:     evt.data.tagName     ?? evt.data.target?.tagName,
          role:        evt.data.role        ?? evt.data.target?.role,
          href:        evt.data.href        ?? evt.data.target?.href,
          coordinates: evt.data.coordinates ?? evt.data.target?.fallbackCoordinates,
        },
      });
      i++;
      continue;
    }

    // ── Select dropdown ──────────────────────────────────────────────────────
    if (evt.type === 'dom:change' && evt.data.inputType === 'select') {
      steps.push({
        id: uid(),
        stepType: 'select',
        timestamp: evt.timestamp,
        url: evt.tabUrl,
        selector: evt.data.target?.primarySelector ?? evt.data.selector,
        label: evt.data.label,
        value: evt.data.value,
        target: evt.data.target ?? null,
        metadata: { selectedText: evt.data.selectedText },
      });
      i++;
      continue;
    }

    // ── Checkbox ─────────────────────────────────────────────────────────────
    if (evt.type === 'dom:change' && evt.data.inputType === 'checkbox') {
      steps.push({
        id: uid(),
        stepType: 'check',
        timestamp: evt.timestamp,
        url: evt.tabUrl,
        selector: evt.data.target?.primarySelector ?? evt.data.selector,
        label: evt.data.label,
        value: evt.data.checked ? 'checked' : 'unchecked',
        target: evt.data.target ?? null,
        metadata: { checked: evt.data.checked },
      });
      i++;
      continue;
    }

    // ── Radio ────────────────────────────────────────────────────────────────
    if (evt.type === 'dom:change' && evt.data.inputType === 'radio') {
      steps.push({
        id: uid(),
        stepType: 'select_radio',
        timestamp: evt.timestamp,
        url: evt.tabUrl,
        selector: evt.data.target?.primarySelector ?? evt.data.selector,
        label: evt.data.label,
        value: evt.data.value,
        target: evt.data.target ?? null,
      });
      i++;
      continue;
    }

    // ── Scroll: skip insignificant movement relative to last scroll step ─────
    if (evt.type === 'dom:scroll') {
      const last = steps[steps.length - 1];
      const significant =
        !last ||
        last.stepType !== 'scroll' ||
        Math.abs(evt.data.y - (last.metadata?.y ?? 0)) >= SCROLL_MIN_DISTANCE ||
        Math.abs(evt.data.x - (last.metadata?.x ?? 0)) >= SCROLL_MIN_DISTANCE;

      if (significant) {
        steps.push({
          id: uid(),
          stepType: 'scroll',
          timestamp: evt.timestamp,
          url: evt.tabUrl,
          metadata: { x: evt.data.x, y: evt.data.y },
        });
      }
      i++;
      continue;
    }

    // ── Network XHR/Fetch (already pre-filtered in background) ──────────────
    if (evt.type === 'cdp:Network.requestWillBeSent') {
      const { request, resourceType } = evt.data;
      if (resourceType === 'XHR' || resourceType === 'Fetch') {
        steps.push({
          id: uid(),
          stepType: 'network_request',
          timestamp: evt.timestamp,
          url: evt.tabUrl,
          metadata: {
            method: request.method,
            requestUrl: request.url,
            resourceType,
          },
        });
      }
      i++;
      continue;
    }

    // ── Tab lifecycle ────────────────────────────────────────────────────────
    if (evt.type === 'tab:created') {
      steps.push({
        id: uid(),
        stepType: 'tab_opened',
        timestamp: evt.timestamp,
        url: evt.data.url || 'about:blank',
      });
      i++;
      continue;
    }

    if (evt.type === 'tab:removed') {
      steps.push({
        id: uid(),
        stepType: 'tab_closed',
        timestamp: evt.timestamp,
        url: evt.data.url || '',
      });
      i++;
      continue;
    }

    // Unknown type — skip
    i++;
  }

  return steps;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
