// jsdom doesn't ship CSS.escape — provide a spec-compliant polyfill.
// https://drafts.csswg.org/cssom/#serialize-an-identifier

if (typeof CSS === 'undefined' || !CSS.escape) {
  globalThis.CSS = globalThis.CSS ?? {};
  CSS.escape = function (str) {
    str = String(str);
    if (str.length === 0) return '';
    let result = '';
    const first = str.charCodeAt(0);
    // Leading hyphen
    if (first === 0x002d) {
      if (str.length === 1) return '\\' + str;
      result += str.charAt(0);
      str = str.slice(1);
    } else if (first >= 0x0030 && first <= 0x0039) {
      // Leading digit
      result += '\\' + first.toString(16) + ' ';
      str = str.slice(1);
    }
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      if (code === 0x0000) { result += '�'; continue; }
      if (
        (code >= 0x0001 && code <= 0x001f) || code === 0x007f
      ) { result += '\\' + code.toString(16) + ' '; continue; }
      if (
        code === 0x002d || code === 0x005f ||
        (code >= 0x0030 && code <= 0x0039) ||
        (code >= 0x0041 && code <= 0x005a) ||
        (code >= 0x0061 && code <= 0x007a) ||
        code >= 0x0080
      ) { result += str.charAt(i); continue; }
      result += '\\' + str.charAt(i);
    }
    return result;
  };
}
