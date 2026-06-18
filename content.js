// content.js — injected into the recorded page.
// Captures DOM-level semantic events and forwards them to the background worker.
// Wrapped in an IIFE with a guard flag so re-injection on navigation is safe.

(function () {
  if (window.__wfRecorderInjected) return;
  window.__wfRecorderInjected = true;

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function send(type, data) {
    chrome.runtime
      .sendMessage({ type: 'DOM_EVENT', payload: { type, data, tabUrl: location.href, timestamp: Date.now() } })
      .catch(() => {}); // silently drop if background isn't ready
  }

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
    // aria-label wins
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();

    // aria-labelledby
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const ref = document.getElementById(labelledBy);
      if (ref) return ref.innerText.trim();
    }

    // <label for="id">
    if (el.id) {
      const lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lbl) return lbl.innerText.trim();
    }

    // ancestor <label>
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

  // ── Click ────────────────────────────────────────────────────────────────────
  document.addEventListener(
    'click',
    e => {
      // Walk up to find the most meaningful interactive ancestor
      const el =
        e.target.closest('a, button, [role="button"], input[type="submit"], input[type="button"], label') ||
        e.target;

      send('dom:click', {
        selector: getSelector(el),
        label: getLabel(el),
        tagName: el.tagName,
        role: el.getAttribute('role') || '',
        href: el.href || '',
        coordinates: { x: Math.round(e.clientX), y: Math.round(e.clientY) },
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
      // Never capture passwords or hidden fields
      if (el.type === 'password' || el.type === 'hidden') return;

      send('dom:input', {
        selector: getSelector(el),
        label: getLabel(el),
        value: el.value,
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
          selector: getSelector(el),
          label: getLabel(el),
          value: el.value,
          inputType: 'select',
          selectedText: opt ? opt.text : '',
        });
      } else if (el.type === 'checkbox') {
        send('dom:change', {
          selector: getSelector(el),
          label: getLabel(el),
          checked: el.checked,
          inputType: 'checkbox',
        });
      } else if (el.type === 'radio') {
        send('dom:change', {
          selector: getSelector(el),
          label: getLabel(el),
          value: el.value,
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
