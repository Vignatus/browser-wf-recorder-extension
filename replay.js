// replay.js — Replay engine: executes WorkflowStep[] in a tab via CDP + scripting.

const SPEED_DELAYS = { '0.5x': 2000, '1x': 1000, '2x': 500, '4x': 250 };

export class ReplayEngine {
  constructor() {
    this._reset();
  }

  _reset() {
    this.state     = 'idle';  // idle | running | paused | done
    this.steps     = [];
    this.index     = 0;
    this.tabId     = null;
    this.options   = { target: 'new_tab', speed: '1x', mode: 'full' };
    this.log       = [];      // LogEntry[]
    this._attached  = false;
    this._startedAt = 0;
    this._stepGate  = null;   // Promise.resolve fn used in step-by-step mode
    this._running   = false;
  }

  getState() {
    return {
      state:   this.state,
      index:   this.index,
      total:   this.steps.length,
      elapsed: this._startedAt ? Date.now() - this._startedAt : 0,
      log:     this.log,
      options: this.options,
    };
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  async start(recording, options = {}) {
    if (this.state !== 'idle') await this.stop();
    this._reset();

    this.steps   = recording.steps ?? [];
    this.options = { ...this.options, ...options };

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
      this.state = 'idle';
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
    this.state = 'idle';
    if (this._stepGate) { this._stepGate(); this._stepGate = null; }
    if (this._attached && this.tabId) {
      await chrome.debugger.detach({ tabId: this.tabId }).catch(() => {});
      this._attached = false;
    }
    this._reset();
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
      if (this.state === 'idle') break;

      if (this.options.mode === 'step') {
        await new Promise(r => { this._stepGate = r; });
        if (this.state === 'idle') break;
      }

      await this._executeStep(this.steps[this.index], this.index);
      this.index++;

      if (this.options.mode === 'full' && this.index < this.steps.length && this.state === 'running') {
        await sleep(delay);
      }
    }

    if (this.state === 'running' || this.state === 'paused') {
      this.state = 'done';
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
          return;
        default:
          entry.status = 'skip';
          return;
      }
      entry.status = 'ok';
    } catch (err) {
      entry.status = 'fail';
      entry.detail = err.message;
      // Screenshot on failure for debugging
      try {
        const { data } = await chrome.debugger.sendCommand(
          { tabId: this.tabId }, 'Page.captureScreenshot', { format: 'jpeg', quality: 60 }
        );
        entry.screenshot = 'data:image/jpeg;base64,' + data;
      } catch {}
    }
  }

  _stepLabel(step) {
    const h = u => { try { return new URL(u).hostname || u; } catch { return u || ''; } };
    switch (step.stepType) {
      case 'navigate':    return 'Navigated to ' + h(step.url);
      case 'click':       return 'Clicked ' + (step.label ? `"${step.label}"` : step.selector);
      case 'type':        return `Typed "${step.value || ''}" into ${step.label || step.selector}`;
      case 'select':
      case 'select_radio':return 'Selected "' + (step.metadata?.selectedText || step.value || '') + '"';
      case 'check':       return (step.value === 'checked' ? 'Checked' : 'Unchecked') + ' ' + (step.label || step.selector);
      case 'scroll':      return `Scrolled to (${step.metadata?.x ?? 0}, ${step.metadata?.y ?? 0})`;
      case 'network_request': return (step.metadata?.method || 'GET') + ' ' + (step.metadata?.requestUrl || '');
      case 'tab_opened':  return 'Tab opened: ' + h(step.url);
      case 'tab_closed':  return 'Tab closed';
      default:            return step.stepType;
    }
  }

  // ── Action implementations ──────────────────────────────────────────────────

  async _doNavigate(step) {
    await chrome.debugger.sendCommand({ tabId: this.tabId }, 'Page.navigate', { url: step.url });
    await this._waitForLoad();
  }

  async _doClick(step) {
    const pos = await this._findElement(step);
    if (!pos) throw new Error(
      `Element not found (all 3 strategies failed)\n  selector: "${step.selector}"\n  label: "${step.label}"`
    );
    await this._mouseClick(pos.x, pos.y);
    await sleep(200);
  }

  async _doType(step) {
    const ok = await this._runInPage((selector, label) => {
      let el = null;
      try { el = document.querySelector(selector); } catch {}
      if (!el) {
        const lc = label?.toLowerCase() ?? '';
        el = [...document.querySelectorAll('input:not([type=hidden]):not([type=password]), textarea')]
          .find(e =>
            (e.placeholder?.toLowerCase() === lc) ||
            (e.getAttribute('aria-label')?.toLowerCase() === lc)
          ) ?? null;
      }
      if (!el) return false;
      el.focus();
      // React-compatible clear via native value setter
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) { setter.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })); }
      else el.value = '';
      return true;
    }, [step.selector, step.label || '']);

    if (!ok) throw new Error(`Input field not found\n  selector: "${step.selector}"\n  label: "${step.label}"`);

    await chrome.debugger.sendCommand({ tabId: this.tabId }, 'Input.insertText', {
      text: step.value || '',
    });
    await sleep(100);
  }

  async _doSelect(step) {
    const result = await this._runInPage((selector, value, selectedText) => {
      let el = null;
      try { el = document.querySelector(selector); } catch {}
      if (!el) {
        const lc = selectedText?.toLowerCase() ?? '';
        el = [...document.querySelectorAll('select')].find(e =>
          e.getAttribute('aria-label')?.toLowerCase().includes(lc)
        ) ?? null;
      }
      if (!el) return 'not_found';
      const opt =
        [...el.options].find(o => o.value === value) ||
        [...el.options].find(o => o.text === selectedText);
      if (!opt) return 'option_not_found';
      el.value = opt.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    }, [step.selector, step.value || '', step.metadata?.selectedText || '']);

    if (result !== 'ok') throw new Error(`Select failed (${result}): "${step.selector}"`);
  }

  async _doCheck(step) {
    const targetChecked = step.metadata?.checked ?? (step.value === 'checked');
    const ok = await this._runInPage((selector, target) => {
      let el = null;
      try { el = document.querySelector(selector); } catch {}
      if (!el) return false;
      if (el.checked !== target) el.click();
      return true;
    }, [step.selector, targetChecked]);

    if (!ok) throw new Error(`Checkbox not found: "${step.selector}"`);
  }

  async _doScroll(step) {
    await this._runInPage((x, y) => {
      window.scrollTo({ left: x, top: y, behavior: 'smooth' });
      return true;
    }, [step.metadata?.x ?? 0, step.metadata?.y ?? 0]);
    await sleep(500);
  }

  // ── Element finding — 3-strategy fallback ───────────────────────────────────

  async _findElement(step) {
    // 1. Stable CSS selector
    const r1 = await this._runInPage(selector => {
      let el = null;
      try { el = document.querySelector(selector); } catch { return null; }
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, strategy: 'selector' };
    }, [step.selector]);
    if (r1) return r1;

    // 2. Text / aria-label / role match
    const label = step.label || '';
    if (label) {
      const r2 = await this._runInPage(label => {
        const norm = s => s?.toLowerCase().trim() ?? '';
        const target = norm(label);
        const candidates = [
          ...document.querySelectorAll(
            'a, button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="menuitem"], [role="option"]'
          ),
        ];
        const el = candidates.find(e => {
          const texts = [
            e.getAttribute('aria-label'),
            e.textContent,
            e.getAttribute('placeholder'),
            e.getAttribute('title'),
          ];
          return texts.some(t => norm(t) === target || (target.length > 3 && norm(t).includes(target)));
        });
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return null;
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, strategy: 'text_match' };
      }, [label]);
      if (r2) return r2;
    }

    // 3. Recorded coordinates
    const coords = step.metadata?.coordinates;
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
