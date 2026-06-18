// background.js — Service worker (ES module).
// Owns the recording session, attaches CDP via chrome.debugger,
// receives DOM events from content.js, and persists finished recordings.

import { normalizeEvents }   from './normalizer.js';
import { ReplayEngine }     from './replay.js';
import { sanitizeRecording } from './sanitizer.js';

const replay = new ReplayEngine();

// ── Replay backend sync ──────────────────────────────────────────────────────
// When a replay finishes, sync its result to the backend if authenticated.

let pendingReplaySync = null; // { remoteReplayId: string } | null

replay.onDone = async (state) => {
  if (!pendingReplaySync) return;
  const { remoteReplayId } = pendingReplaySync;
  pendingReplaySync = null;
  try {
    await finalizeRemoteReplay(remoteReplayId, state);
  } catch (err) {
    console.warn('[WFR] failed to sync replay result:', err.message);
  }
};

// ── In-memory session ────────────────────────────────────────────────────────
// Lost on service-worker restart, but the popup keeps it alive via 500 ms polls
// while open. Minimal metadata is also persisted to storage.session so we can
// detect a stale "recording" state after a restart.

let session = null;
// session shape:
// {
//   id: string,
//   name: string,
//   description: string,
//   tabId: number,
//   tabUrl: string,      — URL at session start
//   currentUrl: string,  — latest URL (updated on navigation)
//   startTime: number,
//   isPaused: boolean,
//   rawEvents: RawEvent[],
// }

// ── Restore session metadata on service-worker startup ──────────────────────
chrome.storage.session.get('sessionMeta').then(({ sessionMeta }) => {
  if (!sessionMeta) return;
  // A recording was in progress when the service worker was last stopped.
  // We lost rawEvents; clear the stale session so the popup gets idle state.
  chrome.storage.session.remove('sessionMeta');
});

// ── Utilities ────────────────────────────────────────────────────────────────

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function addRawEvent(type, data) {
  if (!session || session.isPaused) return;
  session.rawEvents.push({
    id: uid(),
    type,
    timestamp: Date.now(),
    tabId: session.tabId,
    tabUrl: session.currentUrl,
    data,
  });
  // Persist lightweight metadata so popup can read event count without message round-trips
  persistSessionMeta();
}

function persistSessionMeta() {
  if (!session) return;
  chrome.storage.session
    .set({
      sessionMeta: {
        id: session.id,
        name: session.name,
        tabId: session.tabId,
        currentUrl: session.currentUrl,
        startTime: session.startTime,
        isPaused: session.isPaused,
        eventCount: session.rawEvents.length,
      },
    })
    .catch(() => {});
}

// ── API client ───────────────────────────────────────────────────────────────

async function getApiBase() {
  const { auth } = await chrome.storage.local.get('auth');
  return auth?.apiBase || 'http://localhost:3000';
}

async function apiFetch(path, options = {}) {
  const { auth } = await chrome.storage.local.get('auth');
  const base = auth?.apiBase || 'http://localhost:3000';
  const token = auth?.token;

  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try { const d = await res.json(); msg = d.error?.message || msg; } catch {}
    throw new Error(msg);
  }

  return res.json();
}

// ── Backend sync helpers ─────────────────────────────────────────────────────

async function syncRecordingToBackend(recording) {
  const { auth } = await chrome.storage.local.get('auth');
  if (!auth?.token) return null;

  return apiFetch('/api/recordings', {
    method: 'POST',
    body: JSON.stringify({
      name: recording.name,
      description: recording.description || '',
      tags: [],
      source: 'extension',
      schemaVersion: '1.0',
      startUrl: recording.tabUrl,
      stepCount: recording.steps.length,
      recordingJson: {
        steps: recording.steps,
        startUrl: recording.tabUrl,
        name: recording.name,
        description: recording.description || '',
      },
      rawEventSummary: { count: recording.rawEventCount },
      metadata: { localId: recording.id, recordedAt: recording.startTime },
    }),
  });
}

async function createRemoteReplay(remoteRecordingId, versionId) {
  const data = await apiFetch(`/api/recordings/${remoteRecordingId}/replays`, {
    method: 'POST',
    body: JSON.stringify({
      versionId: versionId || null,
      status: 'running',
      startedAt: new Date().toISOString(),
      environment: { extensionVersion: '1.0.0' },
    }),
  });
  return data.replay;
}

async function finalizeRemoteReplay(replayId, state) {
  await apiFetch(`/api/replays/${replayId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: state.status || 'failed',
      endedAt: new Date().toISOString(),
      durationMs: state.elapsed || null,
      summary: {
        finalUrl: state.finalUrl || null,
        assertionResults: state.assertionResults || [],
        failedStepIndex: state.failedStepIndex ?? null,
      },
      error: state.error ? { message: state.error } : null,
    }),
  });
}

// ── CDP helpers ──────────────────────────────────────────────────────────────

async function attachDebugger(tabId) {
  await chrome.debugger.attach({ tabId }, '1.3');
  await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
}

async function detachDebugger(tabId) {
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

// ── Content-script injection ─────────────────────────────────────────────────

async function injectContentScript(tabId) {
  await chrome.scripting
    .executeScript({ target: { tabId }, files: ['content.js'] })
    .catch(err => console.warn('[WFR] content script injection failed:', err.message));
}

// ── Recording lifecycle ──────────────────────────────────────────────────────

async function startRecording({ name, description, tabId, tabUrl }) {
  if (session) await stopRecording(true /* silent */);

  session = {
    id: uid(),
    name: name || 'Untitled workflow',
    description: description || '',
    tabId,
    tabUrl,
    currentUrl: tabUrl,
    startTime: Date.now(),
    isPaused: false,
    rawEvents: [],
  };

  try {
    await attachDebugger(tabId);
  } catch (err) {
    session = null;
    const msg = err.message || String(err);
    throw new Error(
      msg.includes('Another debugger') || msg.includes('already attached')
        ? 'Cannot record: Chrome DevTools is open on this tab. Close DevTools and try again.'
        : 'Failed to attach debugger: ' + msg
    );
  }

  await injectContentScript(tabId);

  // Synthesise an initial navigate event so the first step is always "navigate to <url>"
  addRawEvent('cdp:Page.frameNavigated', { frame: { url: tabUrl, parentId: null, id: 'initial', name: '' } });

  persistSessionMeta();
  return sessionMeta();
}

async function pauseRecording() {
  if (!session) throw new Error('No active session');
  session.isPaused = true;
  persistSessionMeta();
  return sessionMeta();
}

async function resumeRecording() {
  if (!session) throw new Error('No active session');
  session.isPaused = false;
  persistSessionMeta();
  return sessionMeta();
}

async function stopRecording(silent = false, nameMeta = {}) {
  if (!session) {
    if (silent) return null;
    throw new Error('No active session');
  }

  const snap = session;
  session = null;
  await chrome.storage.session.remove('sessionMeta');

  await detachDebugger(snap.tabId);

  const steps = normalizeEvents(snap.rawEvents);

  const recording = {
    id: snap.id,
    name: nameMeta?.name?.trim() || snap.name,
    description: nameMeta?.description ?? snap.description,
    tabUrl: snap.tabUrl,
    startTime: snap.startTime,
    endTime: Date.now(),
    stepCount: steps.length,
    rawEventCount: snap.rawEvents.length,
    steps,
    rawEvents: snap.rawEvents,
  };

  // Sanitize credentials before writing to storage
  const sanitized = sanitizeRecording(recording);

  // Persist to local storage (keep last 50)
  const { recordings = [] } = await chrome.storage.local.get('recordings');
  recordings.unshift(sanitized);
  await chrome.storage.local.set({ recordings: recordings.slice(0, 50) });

  // Sync to backend (fire and forget — don't block the popup)
  syncRecordingToBackend(sanitized)
    .then(result => {
      if (!result) return;
      chrome.storage.local.get('recordings').then(({ recordings: saved = [] }) => {
        const idx = saved.findIndex(r => r.id === sanitized.id);
        if (idx !== -1) {
          saved[idx] = {
            ...saved[idx],
            remoteId: result.recording.id,
            remoteVersionId: result.version?.id || null,
            synced: true,
          };
          chrome.storage.local.set({ recordings: saved });
        }
      });
    })
    .catch(err => console.warn('[WFR] recording sync failed:', err.message));

  return sanitized;
}

function sessionMeta() {
  if (!session) return null;
  return {
    id: session.id,
    name: session.name,
    description: session.description,
    tabId: session.tabId,
    tabUrl: session.tabUrl,
    currentUrl: session.currentUrl,
    startTime: session.startTime,
    isPaused: session.isPaused,
    eventCount: session.rawEvents.length,
  };
}

async function getState() {
  const { auth = null } = await chrome.storage.local.get('auth');

  let allRecordings = [];
  if (auth?.token) {
    try {
      const data = await apiFetch('/api/recordings?limit=50&sort=created_at');
      allRecordings = (data.recordings || []).map(r => ({
        id: r.id,
        name: r.name,
        tabUrl: r.startUrl || '',
        startTime: new Date(r.createdAt).getTime(),
        endTime: new Date(r.updatedAt).getTime(),
        stepCount: r.stepCount,
        rawEventCount: r.rawEventSummary?.count || 0,
        synced: true,
        remoteId: r.id,
      }));
    } catch (err) {
      console.warn('[WFR] failed to fetch recordings from backend:', err.message);
    }
  }

  return {
    status: session ? (session.isPaused ? 'paused' : 'recording') : 'idle',
    session: sessionMeta(),
    recentRecordings: allRecordings.slice(0, 5),
    allRecordings,
    replayState: replay.getState(),
    auth: auth ? { user: auth.user } : null,
  };
}

async function getLiveSteps() {
  if (!session) return [];
  return normalizeEvents(session.rawEvents);
}

async function deleteRecording(id) {
  const { auth } = await chrome.storage.local.get('auth');
  if (auth?.token) {
    await apiFetch(`/api/recordings/${id}`, { method: 'DELETE' });
  }
  const { recordings = [] } = await chrome.storage.local.get('recordings');
  await chrome.storage.local.set({
    recordings: recordings.filter(r => r.id !== id && r.remoteId !== id),
  });
}

async function getRecording(id) {
  const { auth } = await chrome.storage.local.get('auth');
  if (auth?.token) {
    const data = await apiFetch(`/api/recordings/${id}`);
    const rec = data.recording;
    return {
      id: rec.id,
      name: rec.name,
      tabUrl: rec.startUrl || '',
      startTime: new Date(rec.createdAt).getTime(),
      stepCount: rec.stepCount,
      steps: Array.isArray(rec.recordingJson?.steps) ? rec.recordingJson.steps : [],
      remoteId: rec.id,
    };
  }
  const { recordings = [] } = await chrome.storage.local.get('recordings');
  return recordings.find(r => r.id === id) || null;
}

// ── Message bus ──────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handle = async () => {
    switch (message.type) {
      case 'GET_STATE':         return getState();
      case 'START_RECORDING':   return startRecording(message.payload);
      case 'PAUSE_RECORDING':   return pauseRecording();
      case 'RESUME_RECORDING':  return resumeRecording();
      case 'STOP_RECORDING':    return stopRecording(false, message.payload ?? {});
      case 'GET_LIVE_STEPS':    return getLiveSteps();
      case 'DELETE_RECORDING':  return deleteRecording(message.payload.id);
      case 'GET_RECORDING':     return getRecording(message.payload.id);

      case 'START_REPLAY': {
        if (session) throw new Error('Stop the active recording before starting a replay.');
        const rec = await getRecording(message.payload.recordingId);
        if (!rec) throw new Error('Recording not found.');
        const replayResult = await replay.start(rec, message.payload.options ?? {});

        // Create remote replay entry (rec.id is the DB UUID since we fetch from API)
        const remoteRecordingId = rec.remoteId || rec.id;
        if (remoteRecordingId) {
          const { auth } = await chrome.storage.local.get('auth');
          if (auth?.token) {
            createRemoteReplay(remoteRecordingId, null)
              .then(remoteReplay => { pendingReplaySync = { remoteReplayId: remoteReplay.id }; })
              .catch(err => console.warn('[WFR] failed to create remote replay:', err.message));
          }
        }

        return replayResult;
      }

      case 'PAUSE_REPLAY':      return replay.pause();
      case 'RESUME_REPLAY':     return replay.resume();
      case 'STOP_REPLAY':       return replay.stop();
      case 'STEP_REPLAY':       return replay.stepOnce();
      case 'GET_REPLAY_STATE':  return replay.getState();

      case 'GET_AUTH_STATE': {
        const { auth = null } = await chrome.storage.local.get('auth');
        return auth ? { user: auth.user } : null;
      }

      case 'SIGN_IN': {
        const { apiBase, email, password } = message.payload;
        const base = (apiBase || '').trim() || 'http://localhost:3000';
        const res = await fetch(`${base}/api/auth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
        if (!res.ok) {
          let msg = 'Login failed';
          try { const d = await res.json(); msg = d.error?.message || msg; } catch {}
          throw new Error(msg);
        }
        const data = await res.json();
        const auth = { token: data.token, user: data.user, apiBase: base };
        await chrome.storage.local.set({ auth });
        return { user: data.user };
      }

      case 'SIGN_OUT': {
        await chrome.storage.local.remove('auth');
        pendingReplaySync = null;
        return { ok: true };
      }

      case 'DOM_EVENT': {
        // Validate the message came from the tab we are recording
        if (sender.tab && session && sender.tab.id === session.tabId) {
          const { type, data } = message.payload;
          addRawEvent(type, data);
        }
        return { ok: true };
      }

      default:
        throw new Error('Unknown message type: ' + message.type);
    }
  };

  handle()
    .then(result => sendResponse({ ok: true, result }))
    .catch(err => sendResponse({ ok: false, error: err.message }));

  return true; // keep the message channel open for async sendResponse
});

// ── CDP event listener ───────────────────────────────────────────────────────

chrome.debugger.onEvent.addListener((debuggeeId, method, params) => {
  if (!session || debuggeeId.tabId !== session.tabId) return;
  if (session.isPaused) return;

  if (method === 'Page.frameNavigated') {
    // Only track main-frame navigations (parentId is absent/empty for main frame)
    if (!params.frame.parentId) {
      session.currentUrl = params.frame.url;
      addRawEvent('cdp:Page.frameNavigated', params);
    }
    return;
  }

  if (method === 'Network.requestWillBeSent') {
    // Only capture XHR and Fetch — static assets are noise
    if (params.type === 'XHR' || params.type === 'Fetch') {
      addRawEvent('cdp:Network.requestWillBeSent', params);
    }
    return;
  }
});

// If the debugger is detached externally (e.g. user opened DevTools), end the session
chrome.debugger.onDetach.addListener((debuggeeId) => {
  if (!session || debuggeeId.tabId !== session.tabId) return;
  stopRecording().catch(() => {});
});

// ── Re-inject content script after in-tab navigation ────────────────────────
// (The page is fresh after navigation, so __wfRecorderInjected is gone)

chrome.webNavigation.onCompleted.addListener(async ({ tabId, frameId, url }) => {
  if (!session || tabId !== session.tabId || frameId !== 0) return;
  if (url.startsWith('chrome://') || url.startsWith('about:')) return;
  await injectContentScript(tabId);
});

// ── Tab lifecycle events ─────────────────────────────────────────────────────

chrome.tabs.onCreated.addListener(tab => {
  if (!session || session.isPaused) return;
  addRawEvent('tab:created', { url: tab.url || '', tabId: tab.id });
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  if (!session) return;
  if (!session.isPaused) {
    addRawEvent('tab:removed', { tabId, url: '' });
  }
  // If the recorded tab itself was closed, stop and save
  if (tabId === session.tabId) {
    stopRecording().catch(() => {});
  }
});
