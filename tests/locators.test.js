import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getTarget, cssQ, xpQ } from './locator-helpers.js';

// jsdom is set as the vitest environment in vitest.config.js

// ── cssQ / xpQ helpers ──────────────────────────────────────────────────────

describe('cssQ', () => {
  it('wraps a plain string in double quotes', () => {
    expect(cssQ('hello')).toBe('"hello"');
  });
  it('escapes double quotes in the value', () => {
    expect(cssQ('say "hi"')).toBe('"say \\"hi\\""');
  });
  it('escapes backslashes before double quotes', () => {
    expect(cssQ('a\\b')).toBe('"a\\\\b"');
  });
});

describe('xpQ', () => {
  it('uses single quotes when value has no single quotes', () => {
    expect(xpQ('hello')).toBe("'hello'");
  });
  it('uses double quotes when value contains single quotes', () => {
    expect(xpQ("it's")).toBe('"it\'s"');
  });
  it('uses concat() when value contains both quote types', () => {
    const result = xpQ(`it's a "test"`);
    expect(result).toMatch(/^concat\(/);
  });
});

// ── getTarget — locator priority ────────────────────────────────────────────

describe('getTarget', () => {
  let container;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.removeChild(container);
  });

  it('data-testid selector is first in cssSelectors', () => {
    container.innerHTML = '<button data-testid="submit-btn">Submit</button>';
    const el = container.querySelector('button');
    const t = getTarget(el, null);

    expect(t.testId).toBe('submit-btn');
    expect(t.cssSelectors[0]).toBe('[data-testid="submit-btn"]');
    expect(t.xpath).toBe("//button[@data-testid='submit-btn']");
  });

  it('data-cy attribute is recognised as a test-id', () => {
    container.innerHTML = '<button data-cy="my-btn">OK</button>';
    const el = container.querySelector('button');
    const t = getTarget(el, null);

    expect(t.testId).toBe('my-btn');
    expect(t.cssSelectors[0]).toBe('[data-cy="my-btn"]');
    expect(t.xpath).toBe("//button[@data-cy='my-btn']");
  });

  it('id selector placed before aria-label in cssSelectors', () => {
    container.innerHTML = '<button id="save" aria-label="Save document">Save</button>';
    const el = container.querySelector('button');
    const t = getTarget(el, null);

    const idIdx    = t.cssSelectors.indexOf('#save');
    const ariaIdx  = t.cssSelectors.findIndex(s => s.includes('aria-label'));
    expect(idIdx).toBeLessThan(ariaIdx);
    expect(t.xpath).toBe("//*[@id='save']"); // id xpath wins over aria-label xpath
  });

  it('aria-label selector is generated when no id/testid', () => {
    container.innerHTML = '<button aria-label="Close dialog">×</button>';
    const el = container.querySelector('button');
    const t = getTarget(el, null);

    expect(t.ariaLabel).toBe('Close dialog');
    expect(t.cssSelectors).toContain('[aria-label="Close dialog"]');
    expect(t.xpath).toBe("//button[@aria-label='Close dialog']");
  });

  it('input[name] selector is included for input elements', () => {
    container.innerHTML = '<input type="text" name="email" />';
    const el = container.querySelector('input');
    const t = getTarget(el, null);

    expect(t.inputName).toBe('email');
    expect(t.cssSelectors).toContain('input[name="email"]');
    expect(t.xpath).toContain('[@name=');
  });

  it('input[placeholder] selector is included when no higher-priority locator', () => {
    container.innerHTML = '<input type="text" placeholder="Enter email" />';
    const el = container.querySelector('input');
    const t = getTarget(el, null);

    expect(t.placeholder).toBe('Enter email');
    expect(t.cssSelectors).toContain('input[placeholder="Enter email"]');
  });

  it('relative href selector included for anchor tags', () => {
    container.innerHTML = '<a href="/dashboard">Dashboard</a>';
    const el = container.querySelector('a');
    const t = getTarget(el, null);

    expect(t.href).toBe('/dashboard');
    expect(t.cssSelectors).toContain('a[href="/dashboard"]');
    expect(t.xpath).toBe("//a[@href='/dashboard']");
  });

  it('absolute href is NOT included as a selector (too brittle)', () => {
    container.innerHTML = '<a href="https://example.com/page">Link</a>';
    const el = container.querySelector('a');
    const t = getTarget(el, null);

    // href is an optional field — absent (undefined) when the value is not relative
    expect(t.href).toBeUndefined();
    expect(t.cssSelectors.join(' ')).not.toContain('href');
  });

  it('text-based XPath generated when element has only stable text', () => {
    container.innerHTML = '<button>Save Changes</button>';
    const el = container.querySelector('button');
    const t = getTarget(el, null);

    expect(t.text).toBe('Save Changes');
    expect(t.xpath).toBe("//button[normalize-space(.)='Save Changes']");
  });

  it('XPath not generated from text when text is too long (>= 60 chars)', () => {
    const longText = 'A'.repeat(61);
    container.innerHTML = `<button>${longText}</button>`;
    const el = container.querySelector('button');
    const t = getTarget(el, null);

    // xpath is an optional field — absent (undefined) when no stable locator can be built
    expect(t.xpath).toBeUndefined();
  });

  it('primarySelector is included in cssSelectors when no stable locators exist', () => {
    // No id, no testid, no aria-label, no name, no placeholder
    container.innerHTML = '<span class="icon-close"></span>';
    const el = container.querySelector('span');
    const t = getTarget(el, null);

    expect(t.cssSelectors).toContain(t.primarySelector);
  });

  it('fallbackCoordinates are stored from coords argument', () => {
    container.innerHTML = '<button>Click</button>';
    const el = container.querySelector('button');
    const coords = { x: 120, y: 340 };
    const t = getTarget(el, coords);

    expect(t.fallbackCoordinates).toEqual({ x: 120, y: 340 });
  });

  it('fallbackCoordinates is null when no coords given', () => {
    container.innerHTML = '<button>Click</button>';
    const el = container.querySelector('button');
    const t = getTarget(el, null);

    expect(t.fallbackCoordinates).toBeNull();
  });

  it('role is captured from attribute', () => {
    container.innerHTML = '<div role="menuitem">File</div>';
    const el = container.querySelector('div');
    const t = getTarget(el, null);

    expect(t.role).toBe('menuitem');
  });

  it('tagName is always present', () => {
    container.innerHTML = '<input type="checkbox" />';
    const el = container.querySelector('input');
    const t = getTarget(el, null);

    expect(t.tagName).toBe('input');
    expect(t.inputType).toBe('checkbox');
  });

  it('CSS selectors are deduplicated (path selector not added twice if already present)', () => {
    container.innerHTML = '<button id="ok">OK</button>';
    const el = container.querySelector('button');
    const t = getTarget(el, null);

    // #ok should appear exactly once
    const idSelectors = t.cssSelectors.filter(s => s === '#ok');
    expect(idSelectors).toHaveLength(1);
  });

  it('testId of first matching attribute wins when multiple test-id attrs are present', () => {
    container.innerHTML = '<button data-testid="tid" data-cy="cy-val">X</button>';
    const el = container.querySelector('button');
    const t = getTarget(el, null);

    // data-testid has higher priority than data-cy per TEST_ID_ATTRS order
    expect(t.cssSelectors[0]).toBe('[data-testid="tid"]');
  });
});
