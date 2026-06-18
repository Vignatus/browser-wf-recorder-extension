// background.js — Service worker (ES module).
// Owns the recording session, attaches CDP via chrome.debugger,
// receives DOM events from content.js, and persists finished recordings.

import { normalizeEvents } from './normalizer.js';

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
  // We lost rawEvents; mark the session as orphaned so the popup can show
  // a "session interrupted" state. We'll clear it so the popup gets idle state.
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

async function stopRecording(silent = false) {
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
    name: snap.name,
    description: snap.description,
    tabUrl: snap.tabUrl,
    startTime: snap.startTime,
    endTime: Date.now(),
    stepCount: steps.length,
    rawEventCount: snap.rawEvents.length,
    steps,
    rawEvents: snap.rawEvents,
  };

  // Persist to local storage (keep last 50)
  const { recordings = [] } = await chrome.storage.local.get('recordings');
  recordings.unshift(recording);
  await chrome.storage.local.set({ recordings: recordings.slice(0, 50) });

  return recording;
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
  const { recordings = [] } = await chrome.storage.local.get('recordings');
  return {
    status: session ? (session.isPaused ? 'paused' : 'recording') : 'idle',
    session: sessionMeta(),
    recentRecordings: recordings.slice(0, 5).map(r => ({
      id: r.id,
      name: r.name,
      tabUrl: r.tabUrl,
      startTime: r.startTime,
      endTime: r.endTime,
      stepCount: r.stepCount,
      rawEventCount: r.rawEventCount,
    })),
  };
}

async function getLiveSteps() {
  if (!session) return [];
  return normalizeEvents(session.rawEvents);
}

async function deleteRecording(id) {
  const { recordings = [] } = await chrome.storage.local.get('recordings');
  await chrome.storage.local.set({ recordings: recordings.filter(r => r.id !== id) });
}

async function getRecording(id) {
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
      case 'STOP_RECORDING':    return stopRecording();
      case 'GET_LIVE_STEPS':    return getLiveSteps();
      case 'DELETE_RECORDING':  return deleteRecording(message.payload.id);
      case 'GET_RECORDING':     return getRecording(message.payload.id);
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
