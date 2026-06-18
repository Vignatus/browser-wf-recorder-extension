import { describe, it, expect } from 'vitest';
import { normalizeEvents } from '../normalizer.js';

// ── Event factories ───────────────────────────────────────────────────────────

function inputEvt({ selector, value, timestamp, inputType = 'text', target = null }) {
  return {
    id: 'i' + Math.random().toString(36).slice(2),
    type: 'dom:input',
    timestamp,
    tabUrl: 'https://example.com',
    data: { selector, value, label: 'Field', inputType, target },
  };
}

function clickEvt({ selector, timestamp }) {
  return {
    id: 'c' + Math.random().toString(36).slice(2),
    type: 'dom:click',
    timestamp,
    tabUrl: 'https://example.com',
    data: {
      selector,
      label: 'Button',
      tagName: 'BUTTON',
      role: '',
      href: '',
      coordinates: { x: 10, y: 10 },
      target: null,
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('normalizer — input collapsing', () => {

  // 1. Simple collapsing
  it('collapses consecutive inputs on the same element into one step', () => {
    const raw = [
      inputEvt({ selector: '#email', value: 'h',   timestamp: 1000 }),
      inputEvt({ selector: '#email', value: 'hi',  timestamp: 1200 }),
      inputEvt({ selector: '#email', value: 'hii', timestamp: 1400 }),
    ];
    const steps = normalizeEvents(raw);
    expect(steps).toHaveLength(1);
    expect(steps[0].stepType).toBe('type');
    expect(steps[0].value).toBe('hii');
  });

  // 2. Final value preservation
  it('uses the final value, not the first', () => {
    const raw = [
      inputEvt({ selector: '#name', value: 'Jo',     timestamp: 1000 }),
      inputEvt({ selector: '#name', value: 'John',   timestamp: 1300 }),
      inputEvt({ selector: '#name', value: 'John D', timestamp: 1600 }),
    ];
    const steps = normalizeEvents(raw);
    expect(steps[0].value).toBe('John D');
    expect(steps[0].value).not.toBe('Jo');
  });

  // 3. Different selectors stay separate
  it('does not collapse inputs on different selectors', () => {
    const raw = [
      inputEvt({ selector: '#first', value: 'Alice', timestamp: 1000 }),
      inputEvt({ selector: '#last',  value: 'Smith', timestamp: 1100 }),
    ];
    const steps = normalizeEvents(raw);
    expect(steps).toHaveLength(2);
    expect(steps[0].value).toBe('Alice');
    expect(steps[1].value).toBe('Smith');
  });

  // 4. Click interrupts an input run
  it('splits into separate steps when a click occurs between inputs', () => {
    const raw = [
      inputEvt({ selector: '#q', value: 'foo',    timestamp: 1000 }),
      inputEvt({ selector: '#q', value: 'foobar', timestamp: 1200 }),
      clickEvt({ selector: '#btn',                timestamp: 1300 }),
      inputEvt({ selector: '#q', value: 'new',    timestamp: 1400 }),
    ];
    const steps = normalizeEvents(raw);
    expect(steps).toHaveLength(3);
    expect(steps[0].stepType).toBe('type');
    expect(steps[0].value).toBe('foobar');
    expect(steps[1].stepType).toBe('click');
    expect(steps[2].stepType).toBe('type');
    expect(steps[2].value).toBe('new');
  });

  // 5. Raw events are never mutated
  it('leaves the rawEvents array untouched after normalization', () => {
    const raw = [
      inputEvt({ selector: '#f', value: 'a',  timestamp: 1000 }),
      inputEvt({ selector: '#f', value: 'ab', timestamp: 1100 }),
    ];
    const snapshot = JSON.parse(JSON.stringify(raw));
    normalizeEvents(raw);
    expect(raw).toEqual(snapshot);
  });

  // 6. Consecutive gap exceeds window → separate steps
  it('does not collapse inputs separated by more than the merge window', () => {
    const raw = [
      inputEvt({ selector: '#q', value: 'hello',       timestamp: 1000 }),
      inputEvt({ selector: '#q', value: 'hello world', timestamp: 5000 }), // 4 s gap
    ];
    const steps = normalizeEvents(raw);
    expect(steps).toHaveLength(2);
    expect(steps[0].value).toBe('hello');
    expect(steps[1].value).toBe('hello world');
  });

  // 7. Long session with sub-window consecutive gaps merges completely
  it('merges a long typing session where each consecutive gap is within the window', () => {
    // 1.5 s per keystroke — well within the 2 s per-gap limit even though
    // total elapsed (4.5 s) exceeds the old "from-first" approach.
    const raw = [
      inputEvt({ selector: '#f', value: 'a',    timestamp: 0    }),
      inputEvt({ selector: '#f', value: 'ab',   timestamp: 1500 }),
      inputEvt({ selector: '#f', value: 'abc',  timestamp: 3000 }),
      inputEvt({ selector: '#f', value: 'abcd', timestamp: 4500 }),
    ];
    const steps = normalizeEvents(raw);
    expect(steps).toHaveLength(1);
    expect(steps[0].value).toBe('abcd');
  });

  // 8. Selector comparison uses target.primarySelector when present
  it('treats events with matching primarySelector as the same element regardless of legacy selector', () => {
    const makeTarget = primary => ({ primarySelector: primary, cssSelectors: [primary], tagName: 'input' });
    const raw = [
      { ...inputEvt({ selector: 'input:nth-child(1)', value: 'x', timestamp: 1000 }), data: { ...inputEvt({ selector: 'input:nth-child(1)', value: 'x', timestamp: 1000 }).data, target: makeTarget('[data-testid="name"]') } },
      { ...inputEvt({ selector: 'input:nth-child(1)', value: 'xy', timestamp: 1100 }), data: { ...inputEvt({ selector: 'input:nth-child(1)', value: 'xy', timestamp: 1100 }).data, target: makeTarget('[data-testid="name"]') } },
    ];
    const steps = normalizeEvents(raw);
    expect(steps).toHaveLength(1);
    expect(steps[0].value).toBe('xy');
    expect(steps[0].selector).toBe('[data-testid="name"]');
  });

  // ── Strategy detection ──────────────────────────────────────────────────────

  it('assigns strategy setValue for a normal text input', () => {
    const raw = [inputEvt({ selector: '#name', value: 'Alice', timestamp: 1000, inputType: 'text' })];
    expect(normalizeEvents(raw)[0].strategy).toBe('setValue');
  });

  it('assigns strategy keystrokes for a search input', () => {
    const raw = [inputEvt({ selector: '#q', value: 'query', timestamp: 1000, inputType: 'search' })];
    expect(normalizeEvents(raw)[0].strategy).toBe('keystrokes');
  });

  it('assigns strategy keystrokes when the element role is combobox', () => {
    const target = { primarySelector: '#combo', cssSelectors: ['#combo'], tagName: 'input', role: 'combobox' };
    const raw = [
      inputEvt({ selector: '#combo', value: 'opt', timestamp: 1000, target }),
    ];
    expect(normalizeEvents(raw)[0].strategy).toBe('keystrokes');
  });

  it('assigns strategy keystrokes when the element role is searchbox', () => {
    const target = { primarySelector: '#sb', cssSelectors: ['#sb'], tagName: 'input', role: 'searchbox' };
    const raw = [inputEvt({ selector: '#sb', value: 'q', timestamp: 1000, target })];
    expect(normalizeEvents(raw)[0].strategy).toBe('keystrokes');
  });

  // ── Metadata ────────────────────────────────────────────────────────────────

  it('stores rawEventRange covering all merged events', () => {
    const raw = [
      inputEvt({ selector: '#x', value: 'a',   timestamp: 1000 }),
      inputEvt({ selector: '#x', value: 'ab',  timestamp: 1100 }),
      inputEvt({ selector: '#x', value: 'abc', timestamp: 1200 }),
    ];
    const steps = normalizeEvents(raw);
    expect(steps[0].metadata.rawEventRange).toEqual({ start: 0, end: 2 });
  });

  it('rawEventRange for a single event is start === end', () => {
    const raw = [inputEvt({ selector: '#x', value: 'hi', timestamp: 1000 })];
    const steps = normalizeEvents(raw);
    expect(steps[0].metadata.rawEventRange).toEqual({ start: 0, end: 0 });
  });

  it('rawEventRange correctly offsets when input is not the first event', () => {
    const raw = [
      clickEvt({ selector: '#btn', timestamp: 900 }),
      inputEvt({ selector: '#f', value: 'a',  timestamp: 1000 }),
      inputEvt({ selector: '#f', value: 'ab', timestamp: 1100 }),
    ];
    const steps = normalizeEvents(raw);
    const typeStep = steps.find(s => s.stepType === 'type');
    // The two input events are at raw indices 1 and 2
    expect(typeStep.metadata.rawEventRange).toEqual({ start: 1, end: 2 });
  });

});
