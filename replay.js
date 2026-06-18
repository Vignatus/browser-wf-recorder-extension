// replay.js — Replay engine: executes WorkflowStep[] in a tab via CDP + scripting.

const SPEED_DELAYS = { '0.5x': 2000, '1x': 1000, '2x': 500, '4x': 250 };

// ── URL normalization ────────────────────────────────────────────────────────
// Strip tracking/session params before URL comparisons so assertions don't
// break on incidental query noise added by ad networks or analytics.

const NOISY_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'fbclid', 'session', 'timestamp',
]);

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (NOISY_PARAMS.has(key)) u.searchParams.delete(key);
    }
    return u.toString();
  } catch { return url; }
}

function getUrlParts(url) {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (NOISY_PARAMS.has(key)) u.searchParams.delete(key);
    }
    return { pathname: u.pathname, params: u.searchParams };
  } catch { return { pathname: '', params: new URLSearchParams() }; }
}

export class ReplayEngine {
  constructor() {
    this.onDone = null; // optional callback: (state) => void, called when replay reaches 'done'
    this._reset();
  }

  _reset() {
    this.state     = 'idle';  // idle | running | paused | done
    this.status    = null;    // null | 'success' | 'failed'  (final replay result)
    this.steps     = [];
    this.index     = 0;
    this.tabId     = null;
    this.options   = { target: 'new_tab', speed: '1x', mode: 'full' };
    this.log       = [];      // LogEntry[]
    this._attached  = false;
    this._startedAt = 0;
    this._stepGate  = null;   // Promise.resolve fn used in step-by-step mode
    this._running   = false;
    this.finalUrl          = null;
    this.assertionResults  = [];
    this.failedStepIndex   = null;
    this.error             = null;
    this.finalAssertions   = [];
  }

  getState() {
    return {
      state:            this.state,
      status:           this.status,
      index:            this.index,
      total:            this.steps.length,
      elapsed:          this._startedAt ? Date.now() - this._startedAt : 0,
      log:              this.log,
      options:          this.options,
      finalUrl:         this.finalUrl,
      assertionResults: this.assertionResults,
      failedStepIndex:  this.failedStepIndex,
      error:            this.error,
    };
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  async start(recording, options = {}) {
    if (this.state !== 'idle') await this.stop();
    this._reset();

    this.steps           = recording.steps ?? [];
    this.finalAssertions = recording.finalAssertions ?? [];
    this.options         = { ...this.options, ...options };

    if (this.steps.length === 0) throw new Error('Recording has no steps to replay.');

    if (this.options.target === 'new_tab') {
      const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
      this.tabId = tab.id;
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) throw new Error('No active tab found.');
      this.tabId = tab.id;
    }

    await chrome.debugger.attach({ tabId: this.tabId }, '1.3');
    await chrome.debugger.sendCommand({ tabId: this.tabId }, 'Page.enable');
    this._attached  = true;
    this._startedAt = Date.now();
    this.state      = 'running';

    // Fire-and-forget; kept alive by popup polling
    this._loop().catch(err => {
      this.state  = 'done';
      this.status = 'failed';
      this.error  = err.message;
      if (this.onDone) this.onDone(this.getState());
      console.error('[WFR replay] loop error:', err);
    });

    return this.getState();
  }

  pause() {
    if (this.state === 'running') this.state = 'paused';
    return this.getState();
  }

  resume() {
    if (this.state === 'paused') this.state = 'running';
    return this.getState();
  }

  async stop() {
    const midReplay = this.state === 'running' || this.state === 'paused';
    this.state = 'idle'; // causes _loop() to break on its next iteration check
    if (this._stepGate) { this._stepGate(); this._stepGate = null; }
    if (this._attached && this.tabId) {
      await chrome.debugger.detach({ tabId: this.tabId }).catch(() => {});
      this._attached = false;
    }
    this._reset();
    if (midReplay) {
      this.state  = 'done';
      this.status = 'failed';
      this.error  = 'Replay stopped before completion';
      if (this.onDone) this.onDone(this.getState());
    }
    return this.getState();
  }

  stepOnce() {
    if (this._stepGate) {
      const fn = this._stepGate;
      this._stepGate = null;
      fn();
    }
    return this.getState();
  }

  // ── Main loop ───────────────────────────────────────────────────────────────

  async _loop() {
    if (this._running) return;
    this._running = true;

    const delay = SPEED_DELAYS[this.options.speed] ?? 1000;

    while (this.index < this.steps.length) {
      while (this.state === 'paused') await sleep(150);
      if (this.state === 'idle' || this.state === 'done') break; // manual stop

      if (this.options.mode === 'step') {
        await new Promise(r => { this._stepGate = r; });
        if (this.state === 'idle' || this.state === 'done') break;
      }

      const result = await this._executeStep(this.steps[this.index], this.index);
      this.index++;

      if (!result.ok) {
        this.failedStepIndex = this.index - 1;
        this.error           = result.error;
        this.status          = 'failed';
        break;
      }

      if (this.options.mode === 'full' && this.index < this.steps.length && this.state === 'running') {
        await sleep(delay);
      }
    }

    // Natural completion (not aborted by stop()): evaluate final assertions
    if (this.state === 'running' || this.state === 'paused') {
      if (this.status !== 'failed') {
        const allPassed = await this._evaluateFinalAssertions();
        if (this.finalAssertions.length === 0) {
          this.status = 'failed';
          this.error  = 'No final assertions defined — cannot confirm workflow completed.';
        } else if (!allPassed) {
          this.status = 'failed';
        } else {
          this.status = 'success';
        }
      }
      this.state = 'done';
      if (this.onDone) this.onDone(this.getState());
    }

    if (this._attached && this.tabId) {
      await chrome.debugger.detach({ tabId: this.tabId }).catch(() => {});
      this._attached = false;
    }
    this._running = false;
  }

  // ── Step dispatch ───────────────────────────────────────────────────────────

  async _executeStep(step, idx) {
    const entry = {
      timestamp: Date.now(),
      idx,
      stepType: step.stepType,
      label:    this._stepLabel(step),
      status:   'running',
      detail:   '',
      screenshot: null,
    };
    this.log.push(entry);

    try {
      switch (step.stepType) {
        case 'navigate':               await this._doNavigate(step); break;
        case 'click':                  await this._doClick(step);    break;
        case 'type':                   await this._doType(step);     break;
        case 'select':
        case 'select_radio':           await this._doSelect(step);   break;
        case 'check':                  await this._doCheck(step);    break;
        case 'scroll':                 await this._doScroll(step);   break;
        case 'network_request':
        case 'tab_opened':
        case 'tab_closed':
          entry.status = 'skip';
          entry.detail = 'Observational step — skipped';
          return { ok: true, skipped: true };
        default:
          entry.status = 'skip';
          return { ok: true, skipped: true };
      }
      entry.status = 'ok';
      return { ok: true };
    } catch (err) {
      entry.status = 'fail';
      entry.detail = err.message;
      try {
        const { data } = await chrome.debugger.sendCommand(
          { tabId: this.tabId }, 'Page.captureScreenshot', { format: 'jpeg', quality: 60 }
        );
        entry.screenshot = 'data:image/jpeg;base64,' + data;
      } catch {}
      return { ok: false, error: err.message };
    }
  }

  _stepLabel(step) {
    const h = u => { try { return new URL(u).hostname || u; } catch { return u || ''; } };
    const t = step.target;
    switch (step.stepType) {
      case 'navigate':     return 'Navigated to ' + h(step.url);
      case 'click':        return 'Clicked ' + (step.label ? `"${step.label}"` : (t?.text || t?.ariaLabel || step.selector));
      case 'type':         return `Typed "${step.value || ''}" into ${step.label || t?.placeholder || step.selector}`;
      case 'select':
      case 'select_radio': return 'Selected "' + (step.metadata?.selectedText || step.value || '') + '"';
      case 'check':        return (step.value === 'checked' ? 'Checked' : 'Unchecked') + ' ' + (step.label || step.selector);
      case 'scroll':       return `Scrolled to (${step.metadata?.x ?? 0}, ${step.metadata?.y ?? 0})`;
      case 'network_request': return (step.metadata?.method || 'GET') + ' ' + (step.metadata?.requestUrl || '');
      case 'tab_opened':   return 'Tab opened: ' + h(step.url);
      case 'tab_closed':   return 'Tab closed';
      default:             return step.stepType;
    }
  }

  // ── Action implementations ──────────────────────────────────────────────────

  async _doNavigate(step) {
    await chrome.debugger.sendCommand({ tabId: this.tabId }, 'Page.navigate', { url: step.url });
    await this._waitForLoad();
  }

  async _doClick(step) {
    const pos = await this._findElement(step);
    if (!pos) {
      const t = step.target;
      const tried = _selectorList(step).join(', ') || step.selector;
      throw new Error(
        `Element not found — all strategies failed\n` +
        `  CSS selectors: [${tried}]\n` +
        `  XPath: "${t?.xpath ?? ''}"\n` +
        `  text: "${t?.text || step.label}"`
      );
    }
    await this._mouseClick(pos.x, pos.y);
    await sleep(200);
  }

  async _doType(step) {
    const selectors  = _selectorList(step);
    const label      = step.target?.text || step.target?.ariaLabel || step.label || '';
    const placeholder = step.target?.placeholder || '';

    const ok = await this._runInPage((selectors, label, placeholder) => {
      let el = null;
      for (const sel of selectors) {
        try { el = document.querySelector(sel); } catch {}
        if (el) break;
      }
      if (!el) {
        const lc = label?.toLowerCase()       ?? '';
        const pc = placeholder?.toLowerCase() ?? '';
        el = [...document.querySelectorAll('input:not([type=hidden]):not([type=password]), textarea')]
          .find(e =>
            (pc && e.placeholder?.toLowerCase()              === pc) ||
            (lc && e.getAttribute('aria-label')?.toLowerCase() === lc) ||
            (lc && e.placeholder?.toLowerCase()              === lc)
          ) ?? null;
      }
      if (!el) return false;
      el.focus();
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) { setter.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })); }
      else el.value = '';
      return true;
    }, [selectors, label, placeholder]);

    if (!ok) throw new Error(
      `Input field not found\n  selectors: [${selectors.join(', ')}]\n  label: "${label}"`
    );

    await chrome.debugger.sendCommand({ tabId: this.tabId }, 'Input.insertText', {
      text: step.value || '',
    });
    await sleep(100);
  }

  async _doSelect(step) {
    const selectors = _selectorList(step);
    const label     = step.target?.ariaLabel || step.label || '';

    const result = await this._runInPage((selectors, value, selectedText, label) => {
      let el = null;
      for (const sel of selectors) {
        try { el = document.querySelector(sel); } catch {}
        if (el) break;
      }
      if (!el) {
        const lc = label?.toLowerCase() ?? '';
        el = [...document.querySelectorAll('select')].find(e =>
          e.getAttribute('aria-label')?.toLowerCase().includes(lc)
        ) ?? null;
      }
      if (!el) return 'not_found';
      const opt =
        [...el.options].find(o => o.value === value) ||
        [...el.options].find(o => o.text  === selectedText);
      if (!opt) return 'option_not_found';
      el.value = opt.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    }, [selectors, step.value || '', step.metadata?.selectedText || '', label]);

    if (result !== 'ok') throw new Error(
      `Select failed (${result})\n  selectors: [${selectors.join(', ')}]`
    );
  }

  async _doCheck(step) {
    const selectors    = _selectorList(step);
    const targetChecked = step.metadata?.checked ?? (step.value === 'checked');

    const ok = await this._runInPage((selectors, target) => {
      for (const sel of selectors) {
        let el;
        try { el = document.querySelector(sel); } catch { continue; }
        if (!el) continue;
        if (el.checked !== target) el.click();
        return true;
      }
      return false;
    }, [selectors, targetChecked]);

    if (!ok) throw new Error(
      `Checkbox not found\n  selectors: [${selectors.join(', ')}]`
    );
  }

  async _doScroll(step) {
    await this._runInPage((x, y) => {
      window.scrollTo({ left: x, top: y, behavior: 'smooth' });
      return true;
    }, [step.metadata?.x ?? 0, step.metadata?.y ?? 0]);
    await sleep(500);
  }

  // ── Final assertion evaluation ───────────────────────────────────────────────

  async _evaluateFinalAssertions() {
    const tab = await chrome.tabs.get(this.tabId).catch(() => null);
    this.finalUrl = tab?.url ?? null;

    const results = [];
    let allPassed = true;

    for (const assertion of this.finalAssertions) {
      const result = await this._evaluateAssertion(assertion);
      results.push(result);
      if (!result.passed) allPassed = false;
    }

    this.assertionResults = results;
    return allPassed;
  }

  async _evaluateAssertion(assertion) {
    const { type, value, selector } = assertion;
    const parts = this.finalUrl
      ? getUrlParts(this.finalUrl)
      : { pathname: '', params: new URLSearchParams() };

    try {
      switch (type) {
        case 'path_equals': {
          const passed = parts.pathname === value;
          return { type, passed, expected: value, actual: parts.pathname,
            message: passed ? 'Path matches' : `Expected path "${value}", got "${parts.pathname}"` };
        }
        case 'path_contains': {
          const passed = parts.pathname.includes(value);
          return { type, passed, expected: value, actual: parts.pathname,
            message: passed ? 'Path contains expected value' : `Path "${parts.pathname}" does not contain "${value}"` };
        }
        case 'url_regex': {
          const normalized = this.finalUrl ? normalizeUrl(this.finalUrl) : '';
          const passed = new RegExp(value).test(normalized);
          return { type, passed, expected: value, actual: normalized,
            message: passed ? 'URL matches regex' : `URL "${normalized}" does not match regex "${value}"` };
        }
        case 'query_param_exists': {
          const passed = parts.params.has(value);
          return { type, passed, expected: value, actual: parts.params.toString(),
            message: passed ? `Query param "${value}" exists` : `Query param "${value}" not found` };
        }
        case 'query_param_equals': {
          const [paramName, paramValue] = (value || '').split('=');
          const actual = parts.params.get(paramName);
          const passed = actual === paramValue;
          return { type, passed, expected: `${paramName}=${paramValue}`, actual: `${paramName}=${actual}`,
            message: passed ? 'Query param matches' : `Expected "${paramName}=${paramValue}", got "${paramName}=${actual}"` };
        }
        case 'element_visible': {
          const found = await this._runInPage(sel => {
            const el = document.querySelector(sel);
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          }, [selector]);
          return { type, passed: !!found, expected: selector, actual: found ? 'visible' : 'not visible',
            message: found ? `Element "${selector}" is visible` : `Element "${selector}" not found or not visible` };
        }
        case 'element_text_visible': {
          const found = await this._runInPage(text => {
            const pageText = document.body?.innerText?.replace(/\s+/g, ' ').toLowerCase() ?? '';
            return pageText.includes(text.toLowerCase());
          }, [value]);
          return { type, passed: !!found, expected: value, actual: found ? 'found' : 'not found',
            message: found ? `Text "${value}" found on page` : `Text "${value}" not found on page` };
        }
        default:
          return { type, passed: false, expected: null, actual: null,
            message: `Unknown assertion type: "${type}"` };
      }
    } catch (err) {
      return { type, passed: false, expected: value ?? selector ?? null, actual: null, message: err.message };
    }
  }

  // ── Element finding — priority-ordered locator fallback chain ───────────────
  //
  // Priority:  CSS selectors (in order) → XPath → text/role match → coordinates
  //
  // The `target` object holds locators ordered from most to least stable:
  //   1. data-testid selector
  //   2. #id selector
  //   3. [aria-label="..."] selector
  //   4. input[name="..."] selector
  //   5. input[placeholder="..."] selector
  //   6. a[href="..."] selector
  //   7. CSS path selector (getSelector fallback)
  //   8. XPath (attribute-based or text-based)
  //   9. Text / aria / role content search
  //   10. Recorded coordinates

  async _findElement(step) {
    const t = step.target;

    // ── Strategy 1: CSS selectors (all tried in one page call) ──────────────
    const selectors = _selectorList(step);
    if (selectors.length > 0) {
      const r = await this._runInPage(selectors => {
        for (const sel of selectors) {
          let el;
          try { el = document.querySelector(sel); } catch { continue; }
          if (!el) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, strategy: 'css:' + sel };
        }
        return null;
      }, [selectors]);
      if (r) return r;
    }

    // ── Strategy 2: XPath ────────────────────────────────────────────────────
    if (t?.xpath) {
      const r = await this._runInPage(xpath => {
        try {
          const res = document.evaluate(
            xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
          );
          const el = res.singleNodeValue;
          if (!el) return null;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) return null;
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, strategy: 'xpath' };
        } catch { return null; }
      }, [t.xpath]);
      if (r) return r;
    }

    // ── Strategy 3: Text / aria-label / role match ───────────────────────────
    const label = t?.text || t?.ariaLabel || step.label || '';
    const role  = t?.role || '';
    if (label || role) {
      const r = await this._runInPage((label, role) => {
        const norm = s => s?.toLowerCase().trim() ?? '';
        const targetText = norm(label);
        const targetRole = norm(role);
        const candidates = [
          ...document.querySelectorAll(
            'a, button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="menuitem"], [role="option"]'
          ),
        ];
        const el = candidates.find(e => {
          if (targetRole && norm(e.getAttribute('role') ?? '') !== targetRole) return false;
          if (!targetText) return true;
          const texts = [
            e.getAttribute('aria-label'),
            e.textContent,
            e.getAttribute('placeholder'),
            e.getAttribute('title'),
          ];
          return texts.some(
            t => norm(t) === targetText || (targetText.length > 3 && norm(t).includes(targetText))
          );
        });
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return null;
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, strategy: 'text_match' };
      }, [label, role]);
      if (r) return r;
    }

    // ── Strategy 4: Recorded coordinates ─────────────────────────────────────
    const coords = t?.fallbackCoordinates ?? step.metadata?.coordinates;
    if (coords?.x != null && coords?.y != null) {
      return { x: coords.x, y: coords.y, strategy: 'coordinates' };
    }

    return null;
  }

  // ── CDP / scripting helpers ─────────────────────────────────────────────────

  async _runInPage(fn, args = []) {
    const results = await chrome.scripting.executeScript({
      target: { tabId: this.tabId },
      func: fn,
      args,
    }).catch(() => []);
    return results?.[0]?.result ?? null;
  }

  async _mouseClick(x, y) {
    const base = { x, y, button: 'left', clickCount: 1, modifiers: 0 };
    await chrome.debugger.sendCommand(
      { tabId: this.tabId }, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }
    );
    await chrome.debugger.sendCommand(
      { tabId: this.tabId }, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' }
    );
  }

  async _waitForLoad(timeout = 12000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const res = await chrome.debugger.sendCommand(
        { tabId: this.tabId }, 'Runtime.evaluate', { expression: 'document.readyState' }
      ).catch(() => null);
      if (res?.result?.value === 'complete') return;
      await sleep(300);
    }
  }
}

// Build the ordered CSS selector list for a step, deduplicating while preserving order.
// `target.cssSelectors` is already ordered best-first; `step.selector` is appended only
// if not already present (backward compat for recordings that lack a `target`).
function _selectorList(step) {
  const selectors = [...(step.target?.cssSelectors ?? [])];
  if (step.selector && !selectors.includes(step.selector)) selectors.push(step.selector);
  return selectors;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
