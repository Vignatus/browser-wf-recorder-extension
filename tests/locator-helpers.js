// locator-helpers.js
// Standalone export of the locator-building logic from content.js for use in tests.
// content.js inlines the same code (can't use ES imports in injected content scripts).

export const TEST_ID_ATTRS = ['data-testid', 'data-test-id', 'data-cy', 'data-qa'];

export function cssQ(v) {
  return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

export function xpQ(v) {
  if (!v.includes("'")) return "'" + v + "'";
  if (!v.includes('"')) return '"' + v + '"';
  return "concat('" + v.replace(/'/g, "',\"'\",'") + "')";
}

export function getSelector(el) {
  if (!el || el === document.body || el === document.documentElement) return 'body';
  if (el.id) return '#' + CSS.escape(el.id);
  const parts = [];
  let cur = el;
  while (cur && cur !== document.body && parts.length < 5) {
    if (cur.id) { parts.unshift('#' + CSS.escape(cur.id)); break; }
    let seg = cur.tagName.toLowerCase();
    const stableClasses = [...cur.classList]
      .filter(c => !/^(is-|has-|active|hover|focus|disabled|selected|checked|open|ng-|js-)/.test(c))
      .slice(0, 2).map(c => '.' + CSS.escape(c)).join('');
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

export function getTarget(el, coords) {
  const tagName = el.tagName.toLowerCase();

  const testIdAttr  = TEST_ID_ATTRS.find(a => el.hasAttribute(a)) ?? null;
  const testId      = testIdAttr ? el.getAttribute(testIdAttr) : null;
  const ariaLabel   = el.getAttribute('aria-label')   || null;
  const role        = el.getAttribute('role')         || null;
  const inputName   = el.getAttribute('name')         || null;
  const inputType   = el.getAttribute('type')         || null;
  const placeholder = el.getAttribute('placeholder')  || null;
  const hrefRaw     = tagName === 'a' ? (el.getAttribute('href') || '') : '';
  const href        = hrefRaw && (hrefRaw.startsWith('/') || hrefRaw.startsWith('#')) ? hrefRaw : null;
  const text        = (el.innerText || el.textContent || '').trim().slice(0, 120) || null;

  const cssSelectors = [];
  if (testIdAttr && testId)  cssSelectors.push(`[${testIdAttr}=${cssQ(testId)}]`);
  if (el.id && !/^\d/.test(el.id)) cssSelectors.push('#' + CSS.escape(el.id));
  if (ariaLabel)             cssSelectors.push(`[aria-label=${cssQ(ariaLabel)}]`);
  if (inputName && ['input', 'select', 'textarea'].includes(tagName)) {
    cssSelectors.push(`${tagName}[name=${cssQ(inputName)}]`);
  }
  if (placeholder && ['input', 'textarea'].includes(tagName)) {
    cssSelectors.push(`${tagName}[placeholder=${cssQ(placeholder)}]`);
  }
  if (href) cssSelectors.push(`a[href=${cssQ(href)}]`);

  const primarySelector = getSelector(el);
  if (!cssSelectors.includes(primarySelector)) cssSelectors.push(primarySelector);

  let xpath = null;
  if (testIdAttr && testId)            xpath = `//${tagName}[@${testIdAttr}=${xpQ(testId)}]`;
  else if (el.id && !/^\d/.test(el.id)) xpath = `//*[@id=${xpQ(el.id)}]`;
  else if (ariaLabel)                  xpath = `//${tagName}[@aria-label=${xpQ(ariaLabel)}]`;
  else if (inputName)                  xpath = `//${tagName}[@name=${xpQ(inputName)}]`;
  else if (href)                       xpath = `//a[@href=${xpQ(href)}]`;
  else if (text && text.length < 60 && !/[\n\t]/.test(text)) {
    xpath = `//${tagName}[normalize-space(.)=${xpQ(text)}]`;
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
