// content.js — injected into the recorded page.
// Captures DOM-level semantic events and forwards them to the background worker.
// Wrapped in an IIFE with a guard flag so re-injection on navigation is safe.

(function () {
  if (window.__wfRecorderInjected) return;
  window.__wfRecorderInjected = true;

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function send(type, data) {
    // Guard: chrome.runtime.id is undefined when the extension context has been
    // invalidated (e.g. extension reloaded while this content script is still live).
    // sendMessage would throw synchronously in that case, which .catch() can't handle.
    if (!chrome.runtime?.id) return;
    try {
      chrome.runtime
        .sendMessage({ type: 'DOM_EVENT', payload: { type, data, tabUrl: location.href, timestamp: Date.now() } })
        .catch(() => {}); // silently drop "receiving end does not exist" (service worker asleep)
    } catch {
      // synchronous throw if context was invalidated between the guard and the call
    }
  }

  // CSS path-based selector — used as a higher-priority fallback behind attribute selectors.
  function getSelector(el) {
    if (!el || el === document.body || el === document.documentElement) return 'body';
    if (el.id) return '#' + CSS.escape(el.id);

    const parts = [];
    let cur = el;

    while (cur && cur !== document.body && parts.length < 5) {
      if (cur.id) {
        parts.unshift('#' + CSS.escape(cur.id));
        break;
      }

      let seg = cur.tagName.toLowerCase();

      const stableClasses = [...cur.classList]
        .filter(c => !/^(is-|has-|active|hover|focus|disabled|selected|checked|open|ng-|js-)/.test(c))
        .slice(0, 2)
        .map(c => '.' + CSS.escape(c))
        .join('');
      if (stableClasses) seg += stableClasses;

      const parent = cur.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter(s => s.tagName === cur.tagName);
        if (siblings.length > 1) seg += ':nth-of-type(' + (siblings.indexOf(cur) + 1) + ')';
      }

      parts.unshift(seg);
      cur = cur.parentElement;
    }

    return parts.join(' > ');
  }

  function getLabel(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const ref = document.getElementById(labelledBy);
      if (ref) return ref.innerText.trim();
    }

    if (el.id) {
      const lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lbl) return lbl.innerText.trim();
    }

    const parentLbl = el.closest('label');
    if (parentLbl) {
      const clone = parentLbl.cloneNode(true);
      clone.querySelectorAll('input, select, textarea').forEach(n => n.remove());
      const t = clone.innerText.trim();
      if (t) return t;
    }

    if (el.placeholder) return el.placeholder;
    if (el.title) return el.title;

    const text = (el.innerText || el.textContent || '').trim().slice(0, 80);
    if (text) return text;

    if (el.name) return el.name;
    return el.tagName.toLowerCase();
  }

  // Escape a string for use as the value in a CSS attribute selector, e.g. [attr="value"].
  function _cssQ(v) {
    return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }

  // Return a valid XPath string literal for `v`, handling embedded quotes via concat().
  function _xpQ(v) {
    if (!v.includes("'")) return "'" + v + "'";
    if (!v.includes('"')) return '"' + v + '"';
    // Rare: both quote types — split on single quotes and concat()
    return "concat('" + v.replace(/'/g, "',\"'\",'") + "')";
  }

  // Test-ID attributes checked in priority order.
  const TEST_ID_ATTRS = ['data-testid', 'data-test-id', 'data-cy', 'data-qa'];

  /**
   * Build a rich, multi-locator target descriptor for a DOM element.
   * Locators are ordered from most stable (test-id, id, aria-label) to
   * least stable (path-based CSS selector). Coordinates are the last resort.
   *
   * @param {Element} el
   * @param {{ x: number, y: number } | null} coords  — pointer coordinates from the event
   * @returns {object}
   */
  function getTarget(el, coords) {
    const tagName = el.tagName.toLowerCase();

    const testIdAttr  = TEST_ID_ATTRS.find(a => el.hasAttribute(a)) ?? null;
    const testId      = testIdAttr ? el.getAttribute(testIdAttr) : null;
    const ariaLabel   = el.getAttribute('aria-label')   || null;
    const role        = el.getAttribute('role')         || null;
    const inputName   = el.getAttribute('name')         || null;
    const inputType   = el.getAttribute('type')         || null;
    const placeholder = el.getAttribute('placeholder')  || null;
    // Only store relative hrefs — absolute URLs contain domains that may change.
    const hrefRaw     = tagName === 'a' ? (el.getAttribute('href') || '') : '';
    const href        = hrefRaw && (hrefRaw.startsWith('/') || hrefRaw.startsWith('#')) ? hrefRaw : null;
    const text        = (el.innerText || el.textContent || '').trim().slice(0, 120) || null;

    // ── CSS selector candidates in priority order ────────────────────────────
    // Each entry is a self-contained selector that can be passed to querySelector.
    const cssSelectors = [];

    if (testIdAttr && testId)  cssSelectors.push(`[${testIdAttr}=${_cssQ(testId)}]`);
    if (el.id && !/^\d/.test(el.id)) cssSelectors.push('#' + CSS.escape(el.id));
    if (ariaLabel)             cssSelectors.push(`[aria-label=${_cssQ(ariaLabel)}]`);
    if (inputName && ['input', 'select', 'textarea'].includes(tagName)) {
      cssSelectors.push(`${tagName}[name=${_cssQ(inputName)}]`);
    }
    if (placeholder && ['input', 'textarea'].includes(tagName)) {
      cssSelectors.push(`${tagName}[placeholder=${_cssQ(placeholder)}]`);
    }
    if (href) cssSelectors.push(`a[href=${_cssQ(href)}]`);

    const primarySelector = getSelector(el);
    if (!cssSelectors.includes(primarySelector)) cssSelectors.push(primarySelector);

    // ── XPath ────────────────────────────────────────────────────────────────
    // Build the most specific stable XPath available.
    let xpath = null;
    if (testIdAttr && testId)            xpath = `//${tagName}[@${testIdAttr}=${_xpQ(testId)}]`;
    else if (el.id && !/^\d/.test(el.id)) xpath = `//*[@id=${_xpQ(el.id)}]`;
    else if (ariaLabel)                  xpath = `//${tagName}[@aria-label=${_xpQ(ariaLabel)}]`;
    else if (inputName)                  xpath = `//${tagName}[@name=${_xpQ(inputName)}]`;
    else if (href)                       xpath = `//a[@href=${_xpQ(href)}]`;
    else if (text && text.length < 60 && !/[\n\t]/.test(text)) {
      xpath = `//${tagName}[normalize-space(.)=${_xpQ(text)}]`;
    }

    return {
      primarySelector,
      cssSelectors,
      ...(xpath        && { xpath }),
      ...(text         && { text }),
      ...(ariaLabel    && { ariaLabel }),
      ...(role         && { role }),
      tagName,
      ...(href         && { href }),
      ...(inputName    && { inputName }),
      ...(inputType    && { inputType }),
      ...(placeholder  && { placeholder }),
      ...(testId       && { testId }),
      fallbackCoordinates: coords ?? null,
    };
  }

  // ── Click ────────────────────────────────────────────────────────────────────
  document.addEventListener(
    'click',
    e => {
      const el =
        e.target.closest('a, button, [role="button"], input[type="submit"], input[type="button"], label') ||
        e.target;
      const coords = { x: Math.round(e.clientX), y: Math.round(e.clientY) };

      send('dom:click', {
        target:   getTarget(el, coords),
        // Legacy fields kept for backward compat with stored recordings that lack `target`
        selector: getSelector(el),
        label:    getLabel(el),
        tagName:  el.tagName,
        role:     el.getAttribute('role') || '',
        href:     el.href || '',
        coordinates: coords,
      });
    },
    true
  );

  // ── Input / Textarea (value changes) ────────────────────────────────────────
  document.addEventListener(
    'input',
    e => {
      const el = e.target;
      if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return;
      if (el.type === 'password' || el.type === 'hidden') return;

      send('dom:input', {
        target:    getTarget(el, null),
        selector:  getSelector(el),
        label:     getLabel(el),
        value:     el.value,
        inputType: el.type || 'text',
      });
    },
    true
  );

  // ── Select / Checkbox / Radio (change events) ────────────────────────────────
  document.addEventListener(
    'change',
    e => {
      const el = e.target;

      if (el.tagName === 'SELECT') {
        const opt = el.options[el.selectedIndex];
        send('dom:change', {
          target:       getTarget(el, null),
          selector:     getSelector(el),
          label:        getLabel(el),
          value:        el.value,
          inputType:    'select',
          selectedText: opt ? opt.text : '',
        });
      } else if (el.type === 'checkbox') {
        send('dom:change', {
          target:    getTarget(el, null),
          selector:  getSelector(el),
          label:     getLabel(el),
          checked:   el.checked,
          inputType: 'checkbox',
        });
      } else if (el.type === 'radio') {
        send('dom:change', {
          target:    getTarget(el, null),
          selector:  getSelector(el),
          label:     getLabel(el),
          value:     el.value,
          inputType: 'radio',
        });
      }
    },
    true
  );

  // ── Scroll (500 ms debounce to avoid flooding) ───────────────────────────────
  let scrollTimer = null;
  document.addEventListener(
    'scroll',
    () => {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        send('dom:scroll', { x: Math.round(scrollX), y: Math.round(scrollY) });
      }, 500);
    },
    { passive: true, capture: true }
  );
})();
