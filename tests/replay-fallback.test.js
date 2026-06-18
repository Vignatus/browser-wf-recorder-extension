import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReplayEngine } from '../replay.js';

// ── Minimal chrome API stubs ─────────────────────────────────────────────────
// These are set before importing replay.js so the module-level references resolve.
globalThis.chrome = {
  tabs:      { create: vi.fn(), query: vi.fn() },
  debugger:  { attach: vi.fn(), sendCommand: vi.fn(), detach: vi.fn() },
  scripting: { executeScript: vi.fn() },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEngine() {
  const engine = new ReplayEngine();
  engine.tabId     = 1;
  engine._attached = true;
  engine.state     = 'running';
  return engine;
}

/** Replace _runInPage with a function that returns successive values from `results`. */
function mockRunInPage(engine, results) {
  let call = 0;
  engine._runInPage = vi.fn(async () => results[call++] ?? null);
}

const FOUND_POS = { x: 50, y: 80, strategy: 'css:#btn' };
const COORDS    = { x: 100, y: 200, strategy: 'coordinates' };

// ── _findElement — fallback priority ────────────────────────────────────────

describe('ReplayEngine._findElement — fallback order', () => {

  it('returns CSS result immediately when first call succeeds', async () => {
    const engine = makeEngine();
    engine._runInPage = vi.fn(async () => FOUND_POS);

    const step = {
      target: { cssSelectors: ['#btn'], xpath: '//button', text: 'Click', fallbackCoordinates: COORDS },
      selector: '#btn',
    };
    const result = await engine._findElement(step);

    expect(result).toEqual(FOUND_POS);
    expect(engine._runInPage).toHaveBeenCalledTimes(1); // stopped after CSS
  });

  it('falls through to XPath when CSS selectors return null', async () => {
    const engine = makeEngine();
    const xpathPos = { x: 30, y: 40, strategy: 'xpath' };
    mockRunInPage(engine, [null, xpathPos]);

    const step = {
      target: { cssSelectors: ['#missing'], xpath: '//button[@id="missing"]', fallbackCoordinates: COORDS },
      selector: '#missing',
    };
    const result = await engine._findElement(step);

    expect(result).toEqual(xpathPos);
    expect(engine._runInPage).toHaveBeenCalledTimes(2);
  });

  it('falls through to text match when CSS + XPath return null', async () => {
    const engine = makeEngine();
    const textPos = { x: 60, y: 70, strategy: 'text_match' };
    mockRunInPage(engine, [null, null, textPos]);

    const step = {
      target: { cssSelectors: ['.gone'], xpath: '//button', text: 'Submit', fallbackCoordinates: COORDS },
      selector: '.gone',
    };
    const result = await engine._findElement(step);

    expect(result).toEqual(textPos);
    expect(engine._runInPage).toHaveBeenCalledTimes(3);
  });

  it('falls back to coordinates when all page strategies return null', async () => {
    const engine = makeEngine();
    mockRunInPage(engine, [null, null, null]);

    const step = {
      target: {
        cssSelectors: ['.gone'],
        xpath: '//button',
        text: 'Submit',
        fallbackCoordinates: { x: 100, y: 200 },
      },
      selector: '.gone',
    };
    const result = await engine._findElement(step);

    expect(result).toEqual({ x: 100, y: 200, strategy: 'coordinates' });
  });

  it('returns null when all strategies including coordinates are absent', async () => {
    const engine = makeEngine();
    mockRunInPage(engine, [null, null, null]);

    const step = {
      target: { cssSelectors: ['.gone'], xpath: '//button', text: 'X', fallbackCoordinates: null },
      selector: '.gone',
    };
    const result = await engine._findElement(step);

    expect(result).toBeNull();
  });

  it('skips XPath strategy when step.target has no xpath', async () => {
    const engine = makeEngine();
    const textPos = { x: 9, y: 9, strategy: 'text_match' };
    mockRunInPage(engine, [null, textPos]);

    const step = {
      target: { cssSelectors: ['.x'], text: 'Go' },
    };
    const result = await engine._findElement(step);

    expect(result).toEqual(textPos);
    // CSS call + text_match call = 2; XPath was skipped
    expect(engine._runInPage).toHaveBeenCalledTimes(2);
  });

  it('skips text-match strategy when label/text/role are all absent', async () => {
    const engine = makeEngine();
    mockRunInPage(engine, [null]);

    const step = {
      target: { cssSelectors: ['.x'], fallbackCoordinates: { x: 5, y: 6 } },
      label: '',
    };
    const result = await engine._findElement(step);

    expect(result).toEqual({ x: 5, y: 6, strategy: 'coordinates' });
    // Only one _runInPage call (CSS); text_match and xpath both skipped
    expect(engine._runInPage).toHaveBeenCalledTimes(1);
  });

  // ── Backward compatibility: old recordings lack `target` ──────────────────

  it('still works with old-format steps that only have selector + label', async () => {
    const engine = makeEngine();
    const legacyPos = { x: 10, y: 20, strategy: 'css:#oldBtn' };
    engine._runInPage = vi.fn(async () => legacyPos);

    const step = {
      // No `target` field — pre-existing recording
      selector: '#oldBtn',
      label:    'Save',
      metadata: { coordinates: { x: 99, y: 88 } },
    };
    const result = await engine._findElement(step);

    expect(result).toEqual(legacyPos);
  });

  it('old-format step falls back to metadata.coordinates when selector fails', async () => {
    const engine = makeEngine();
    mockRunInPage(engine, [null, null]); // CSS + text both fail (xpath skipped, no target)

    const step = {
      selector: '#gone',
      label:    'Save',
      metadata: { coordinates: { x: 77, y: 88 } },
    };
    const result = await engine._findElement(step);

    expect(result).toEqual({ x: 77, y: 88, strategy: 'coordinates' });
  });

  // ── CSS selector priority order ────────────────────────────────────────────

  it('passes all cssSelectors in a single _runInPage call', async () => {
    const engine = makeEngine();
    let capturedSelectors;
    engine._runInPage = vi.fn(async (fn, args) => {
      capturedSelectors = args[0];
      return null; // force fallthrough
    });

    const step = {
      target: {
        cssSelectors: ['[data-testid="btn"]', '#btn-id', '[aria-label="Submit"]', 'button.submit'],
        fallbackCoordinates: { x: 1, y: 1 },
      },
    };
    await engine._findElement(step);

    expect(capturedSelectors).toEqual([
      '[data-testid="btn"]',
      '#btn-id',
      '[aria-label="Submit"]',
      'button.submit',
    ]);
    // All selectors in one call — not separate calls per selector
    expect(engine._runInPage).toHaveBeenCalledOnce();
  });

  it('appends step.selector to cssSelectors for compat without duplicating', async () => {
    const engine = makeEngine();
    let capturedSelectors;
    engine._runInPage = vi.fn(async (fn, args) => {
      if (capturedSelectors === undefined) capturedSelectors = args[0];
      return null;
    });

    const step = {
      target: { cssSelectors: ['#btn'], fallbackCoordinates: null },
      selector: '#btn', // already in cssSelectors — should not be duplicated
    };
    await engine._findElement(step);

    expect(capturedSelectors).toEqual(['#btn']);
  });

  it('step.selector is appended if not already in cssSelectors', async () => {
    const engine = makeEngine();
    let capturedSelectors;
    engine._runInPage = vi.fn(async (fn, args) => {
      if (capturedSelectors === undefined) capturedSelectors = args[0];
      return null;
    });

    const step = {
      target: { cssSelectors: ['[data-testid="x"]'], fallbackCoordinates: null },
      selector: 'div.legacy-class',
    };
    await engine._findElement(step);

    expect(capturedSelectors).toContain('div.legacy-class');
    expect(capturedSelectors.indexOf('div.legacy-class'))
      .toBeGreaterThan(capturedSelectors.indexOf('[data-testid="x"]'));
  });
});
