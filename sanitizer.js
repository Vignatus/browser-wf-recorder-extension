// sanitizer.js
//
// WHY this module exists:
//   Chrome DevTools Protocol hands us complete request headers for every XHR
//   and Fetch captured during recording. Those headers routinely carry
//   Authorization tokens, session cookies, SAPISID hashes, and Google-specific
//   auth identifiers. POST bodies can be gzip-compressed binary blobs. URLs
//   embed auth state in query params (token=, ouid=, authuser=, etc.).
//
//   None of this should be written to chrome.storage.local. A compromised
//   extension installation, a carelessly shared JSON export, or a bug that
//   exposes storage to a web page would leak live credentials.
//
//   sanitizeRecording() is called in stopRecording() before the recording is
//   persisted. It is a pure transformation — the original in-memory session
//   object is not mutated.

// ── Sensitive header definitions ─────────────────────────────────────────────

// Headers that are always redacted regardless of value.
const SENSITIVE_HEADER_EXACT = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-goog-authuser',
  'x-goog-visitor-id',
  'x-goog-pageid',
  'x-goog-encode-response-if-executable',
  'x-same-domain',
]);

// Headers whose lowercased name contains any of these substrings are also
// redacted. Kept to targeted patterns to avoid over-matching innocent headers.
const SENSITIVE_HEADER_SUBSTRINGS = [
  'token', 'auth', 'secret', 'session', 'csrf', 'xsrf',
  'sapisid', 'credential',
  // 'key' and 'sid' are intentionally not here — too short, risk false positives
  // on Content-Type, X-Request-Id, etc. Add the exact header names above instead.
];

// URL query parameters whose values are always redacted.
const SENSITIVE_QUERY_PARAMS = new Set([
  'token', 'authuser', 'ouid', 'key',
  'access_token', 'refresh_token',
  'code', 'state',
  'session', 'sid',
  'csrf', 'xsrf',
]);

// ── Internal helpers ──────────────────────────────────────────────────────────

function _headerCategory(name) {
  const l = name.toLowerCase();
  if (l === 'cookie' || l === 'set-cookie') return 'COOKIE';
  if (l.includes('auth'))       return 'AUTH_HEADER';
  if (l.includes('token'))      return 'TOKEN';
  if (l.includes('secret'))     return 'SECRET';
  if (l.includes('session'))    return 'SESSION';
  if (l.includes('csrf') || l.includes('xsrf')) return 'CSRF';
  if (l.includes('sapisid'))    return 'SESSION_ID';
  if (l.includes('credential')) return 'CREDENTIAL';
  return 'SENSITIVE_HEADER';
}

function _isSensitiveHeader(name) {
  const lower = name.toLowerCase();
  if (SENSITIVE_HEADER_EXACT.has(lower)) return true;
  return SENSITIVE_HEADER_SUBSTRINGS.some(kw => lower.includes(kw));
}

function _redactHeaders(headers) {
  if (!headers || typeof headers !== 'object') return headers;
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (_isSensitiveHeader(name)) {
      const len = typeof value === 'string' ? value.length : 0;
      out[name] = `[REDACTED:${_headerCategory(name)}:length=${len}]`;
    } else {
      out[name] = value;
    }
  }
  return out;
}

function _redactUrl(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  let parsed;
  try { parsed = new URL(raw); } catch { return raw; }
  let dirty = false;
  for (const key of [...parsed.searchParams.keys()]) {
    if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) {
      parsed.searchParams.set(key, '[REDACTED]');
      dirty = true;
    }
  }
  return dirty ? parsed.toString() : raw;
}

function _sanitizeRequest(req) {
  if (!req || typeof req !== 'object') return req;
  const out = { ...req };

  if (out.headers)  out.headers = _redactHeaders(out.headers);
  if (out.url)      out.url     = _redactUrl(out.url);

  // Replace raw POST body with metadata only. Storing postData / postDataEntries
  // is never useful for replay (we don't reconstruct bodies) and can contain
  // arbitrary binary payloads including encrypted user content.
  if ('postData' in out) {
    const len = typeof out.postData === 'string' ? out.postData.length : 0;
    out.postData         = `[REDACTED:POST_DATA:length=${len}]`;
    out.postDataRedacted = true;
    out.postDataLength   = len;
  }
  if (Array.isArray(out.postDataEntries)) {
    out.postDataEntries = out.postDataEntries.map(entry => {
      if (!entry || !('bytes' in entry)) return entry;
      const len = typeof entry.bytes === 'string' ? entry.bytes.length : 0;
      return { ...entry, bytes: `[REDACTED:POST_DATA_BYTES:length=${len}]` };
    });
  }
  return out;
}

function _sanitizeResponse(resp) {
  if (!resp || typeof resp !== 'object') return resp;
  const out = { ...resp };
  if (out.headers)     out.headers     = _redactHeaders(out.headers);
  if (out.headersText) out.headersText = '[REDACTED:HEADERS_TEXT]';
  if (out.url)         out.url         = _redactUrl(out.url);
  return out;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns a sanitized copy of a single raw event.
 * Non-network events are returned with only their tabUrl field sanitized.
 *
 * @param {object} event
 * @returns {object}
 */
export function sanitizeRawEvent(event) {
  if (!event || typeof event !== 'object') return event;

  const out = { ...event };
  if (out.tabUrl) out.tabUrl = _redactUrl(out.tabUrl);

  if (event.type === 'cdp:Network.requestWillBeSent') {
    const data = { ...event.data };
    if (data.request)         data.request         = _sanitizeRequest(data.request);
    if (data.redirectResponse) data.redirectResponse = _sanitizeResponse(data.redirectResponse);
    if (data.documentURL)     data.documentURL     = _redactUrl(data.documentURL);
    out.data = data;
    return out;
  }

  if (event.type === 'cdp:Network.responseReceived') {
    const data = { ...event.data };
    if (data.response) data.response = _sanitizeResponse(data.response);
    out.data = data;
    return out;
  }

  if (event.type === 'cdp:Page.frameNavigated') {
    const data = { ...event.data };
    if (data.frame?.url) {
      data.frame = { ...data.frame, url: _redactUrl(data.frame.url) };
    }
    out.data = data;
    return out;
  }

  return out;
}

/**
 * Returns a sanitized copy of a normalized workflow step.
 * Only the `url` and `metadata.requestUrl` fields are candidates for redaction
 * here; steps never carry headers or POST bodies.
 *
 * @param {object} step
 * @returns {object}
 */
function _sanitizeStep(step) {
  if (!step || typeof step !== 'object') return step;
  const out = { ...step };
  if (out.url) out.url = _redactUrl(out.url);
  if (out.metadata) {
    const meta = { ...out.metadata };
    if (meta.requestUrl) meta.requestUrl = _redactUrl(meta.requestUrl);
    out.metadata = meta;
  }
  return out;
}

/**
 * Returns a sanitized copy of a complete recording object.
 * Sanitizes both `rawEvents` and `steps`.
 *
 * @param {object} recording
 * @returns {object}
 */
export function sanitizeRecording(recording) {
  if (!recording || typeof recording !== 'object') return recording;
  return {
    ...recording,
    rawEvents: Array.isArray(recording.rawEvents)
      ? recording.rawEvents.map(sanitizeRawEvent)
      : recording.rawEvents,
    steps: Array.isArray(recording.steps)
      ? recording.steps.map(_sanitizeStep)
      : recording.steps,
  };
}
