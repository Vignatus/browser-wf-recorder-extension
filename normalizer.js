// normalizer.js
// Pure function: raw CDP/DOM events → clean, replayable workflow steps.

const TYPE_MERGE_WINDOW   = 2000; // ms — collapse consecutive inputs on same element
const NAV_DEDUP_WINDOW    = 500;  // ms — collapse redirect chains, keep final URL
const SCROLL_MIN_DISTANCE = 150;  // px — ignore tiny scrolls

export function normalizeEvents(rawEvents) {
  if (!rawEvents || rawEvents.length === 0) return [];

  const steps = [];
  let i = 0;

  while (i < rawEvents.length) {
    const evt = rawEvents[i];

    // ── Text input: merge runs of input events on the same element ──────────
    if (evt.type === 'dom:input') {
      const { selector } = evt.data;
      let j = i + 1;
      let finalValue = evt.data.value;

      while (
        j < rawEvents.length &&
        rawEvents[j].type === 'dom:input' &&
        rawEvents[j].data.selector === selector &&
        rawEvents[j].timestamp - rawEvents[i].timestamp < TYPE_MERGE_WINDOW
      ) {
        finalValue = rawEvents[j].data.value;
        j++;
      }

      steps.push({
        id: uid(),
        stepType: 'type',
        timestamp: evt.timestamp,
        url: evt.tabUrl,
        selector,
        label: evt.data.label,
        value: finalValue,
        metadata: { inputType: evt.data.inputType },
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
        selector: evt.data.selector,
        label: evt.data.label,
        metadata: {
          tagName: evt.data.tagName,
          role: evt.data.role,
          href: evt.data.href,
          coordinates: evt.data.coordinates,
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
        selector: evt.data.selector,
        label: evt.data.label,
        value: evt.data.value,
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
        selector: evt.data.selector,
        label: evt.data.label,
        value: evt.data.checked ? 'checked' : 'unchecked',
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
        selector: evt.data.selector,
        label: evt.data.label,
        value: evt.data.value,
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
