// popup.js — manages UI state and talks to the background service worker.

// ── Messaging helpers ────────────────────────────────────────────────────────

async function bg(type, payload) {
  const response = await chrome.runtime.sendMessage({ type, payload });
  if (!response.ok) throw new Error(response.error || 'Unknown error from background');
  return response.result;
}

// ── DOM refs ─────────────────────────────────────────────────────────────────

const statusDot     = document.getElementById('statusDot');
const statusLabel   = document.getElementById('statusLabel');
const currentTabEl  = document.getElementById('currentTabDisplay');
const eventCountEl  = document.getElementById('eventCount');
const recordingName = document.getElementById('recordingName');
const recordingDesc = document.getElementById('recordingDescription');
const startBtn      = document.getElementById('startBtn');
const startBtnLabel = document.getElementById('startBtnLabel');
const pauseBtn      = document.getElementById('pauseBtn');
const pauseBtnLabel = document.getElementById('pauseBtnLabel');
const stopBtn       = document.getElementById('stopBtn');
const viewLiveBtn   = document.getElementById('viewLiveBtn');
const recordingsList = document.getElementById('recordingsList');
const emptyState    = document.getElementById('emptyState');
const liveModal     = document.getElementById('liveModal');
const liveStepsList = document.getElementById('liveStepsList');
const closeLiveBtn  = document.getElementById('closeLiveModal');
const contextMenu   = document.getElementById('contextMenu');
const ctxDownload   = document.getElementById('ctxDownload');
const ctxDelete     = document.getElementById('ctxDelete');

// ── State ────────────────────────────────────────────────────────────────────

let currentTab = null;    // chrome.tabs.Tab
let recordingState = 'idle'; // 'idle' | 'recording' | 'paused'
let pollTimer = null;
let contextTarget = null; // recording id for context menu

// ── UI updater ───────────────────────────────────────────────────────────────

function setStatus(state, eventCount = 0) {
  recordingState = state;

  statusDot.className = 'status-dot';
  statusLabel.className = 'status-label';

  if (state === 'recording') {
    statusDot.classList.add('recording');
    statusLabel.classList.add('recording');
    statusLabel.textContent = 'Recording…';
  } else if (state === 'paused') {
    statusDot.classList.add('paused');
    statusLabel.classList.add('paused');
    statusLabel.textContent = 'Paused';
  } else {
    statusLabel.textContent = 'Ready to record';
  }

  eventCountEl.textContent = eventCount;

  const isActive = state !== 'idle';
  startBtn.disabled = false;
  pauseBtn.disabled = !isActive;
  stopBtn.disabled  = !isActive;

  startBtn.classList.toggle('is-recording', state === 'recording');

  if (state === 'idle') {
    startBtnLabel.textContent = 'Start Recording';
    startBtn.querySelector('svg circle:last-child').setAttribute('fill', 'currentColor');
    pauseBtnLabel.textContent = 'Pause';
    viewLiveBtn.classList.remove('active');
  } else if (state === 'recording') {
    startBtnLabel.textContent = 'Recording…';
    pauseBtnLabel.textContent = 'Pause';
    viewLiveBtn.classList.add('active');
  } else if (state === 'paused') {
    startBtnLabel.textContent = 'Resume';
    pauseBtnLabel.textContent = 'Resume';
    viewLiveBtn.classList.add('active');
  }

  // Lock name/desc fields while recording
  recordingName.disabled = isActive;
  recordingDesc.disabled = isActive;
}

function renderTab(tab) {
  if (!tab) { currentTabEl.textContent = '—'; return; }
  try {
    const url = new URL(tab.url);
    currentTabEl.textContent = url.hostname || tab.url;
  } catch {
    currentTabEl.textContent = tab.url || '—';
  }
}

// ── Recording items ──────────────────────────────────────────────────────────

const COLORS = ['', 'purple', '', 'purple', ''];

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 60)   return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60)   return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24)   return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

function recIcon() {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <path stroke-linecap="round" stroke-linejoin="round"
      d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"/>
  </svg>`;
}

function renderRecordings(recordings) {
  if (!recordings || recordings.length === 0) {
    emptyState.style.display = '';
    // Remove existing items
    [...recordingsList.querySelectorAll('.recording-item')].forEach(el => el.remove());
    return;
  }

  emptyState.style.display = 'none';
  const existing = new Set([...recordingsList.querySelectorAll('.recording-item')].map(el => el.dataset.id));
  const incoming = new Set(recordings.map(r => r.id));

  // Remove items no longer in the list
  [...recordingsList.querySelectorAll('.recording-item')].forEach(el => {
    if (!incoming.has(el.dataset.id)) el.remove();
  });

  // Insert/update items
  recordings.forEach((rec, idx) => {
    if (existing.has(rec.id)) return; // already rendered

    const color = COLORS[idx % COLORS.length];
    let hostname = rec.tabUrl;
    try { hostname = new URL(rec.tabUrl).hostname; } catch {}

    const el = document.createElement('div');
    el.className = 'recording-item';
    el.dataset.id = rec.id;
    el.innerHTML = `
      <div class="rec-icon ${color}">${recIcon()}</div>
      <div class="rec-body">
        <div class="rec-name">${escHtml(rec.name)}</div>
        <div class="rec-meta">${escHtml(hostname)} &bull; ${rec.stepCount ?? 0} steps</div>
      </div>
      <div class="rec-right">
        <span class="rec-time">${timeAgo(rec.startTime)}</span>
        <button class="rec-menu-btn" data-id="${rec.id}" title="Options">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="5"  r="1.5"/>
            <circle cx="12" cy="12" r="1.5"/>
            <circle cx="12" cy="19" r="1.5"/>
          </svg>
        </button>
      </div>`;

    // Append after the empty-state div
    recordingsList.appendChild(el);
  });
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Live steps modal ─────────────────────────────────────────────────────────

function stepBadgeClass(stepType) {
  const map = {
    navigate: 'navigate', click: 'click', type: 'type',
    select: 'select', select_radio: 'select', check: 'check',
    scroll: 'scroll', network_request: 'network_request',
    tab_opened: 'tab_opened', tab_closed: 'tab_closed',
  };
  return map[stepType] || 'scroll';
}

function renderLiveSteps(steps) {
  if (!steps || steps.length === 0) {
    liveStepsList.innerHTML = '<div class="modal-empty">No steps captured yet. Start recording to see events here.</div>';
    return;
  }

  liveStepsList.innerHTML = steps.map(step => {
    const badge = stepBadgeClass(step.stepType);
    const label = step.label || step.url || step.stepType;
    let detail = '';
    if (step.stepType === 'type')            detail = `<div class="step-detail">Value: "${escHtml(step.value || '')}"</div>`;
    else if (step.stepType === 'navigate')   detail = `<div class="step-detail">${escHtml(step.url)}</div>`;
    else if (step.stepType === 'click')      detail = `<div class="step-detail">${escHtml(step.selector || '')}</div>`;
    else if (step.stepType === 'select')     detail = `<div class="step-detail">Selected: "${escHtml(step.metadata?.selectedText || step.value || '')}"</div>`;
    else if (step.stepType === 'network_request') detail = `<div class="step-detail">${step.metadata?.method} ${escHtml(step.metadata?.requestUrl || '')}</div>`;

    return `<div class="step-item">
      <span class="step-badge ${badge}">${step.stepType.replace('_', ' ')}</span>
      <div class="step-body">
        <div class="step-label">${escHtml(label)}</div>
        ${detail}
      </div>
    </div>`;
  }).join('');
}

// ── Download helper ──────────────────────────────────────────────────────────

function downloadJson(recording) {
  const blob = new Blob([JSON.stringify(recording, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = (recording.name || 'workflow').replace(/[^a-z0-9]/gi, '_') + '_' + recording.id + '.json';
  a.click();
  URL.revokeObjectURL(url);
}

// ── Poll while recording (keeps event count live) ────────────────────────────

function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    try {
      const state = await bg('GET_STATE');
      if (state.status === 'idle') { stopPolling(); syncState(state); return; }
      eventCountEl.textContent = state.session?.eventCount ?? 0;
    } catch {}
  }, 500);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ── Full state sync from background ─────────────────────────────────────────

async function syncState(state) {
  setStatus(state.status, state.session?.eventCount ?? 0);

  // If recording was started from a previous popup open, restore name
  if (state.session && recordingName.value === '') {
    recordingName.value = state.session.name;
    recordingDesc.value = state.session.description || '';
  }

  renderRecordings(state.recentRecordings || []);

  if (state.status !== 'idle') startPolling();
}

// ── Event handlers ───────────────────────────────────────────────────────────

startBtn.addEventListener('click', async () => {
  try {
    if (recordingState === 'idle') {
      const name = recordingName.value.trim() || 'Untitled workflow';
      await bg('START_RECORDING', {
        name,
        description: recordingDesc.value.trim(),
        tabId: currentTab.id,
        tabUrl: currentTab.url,
      });
      setStatus('recording', 0);
      startPolling();
    } else if (recordingState === 'recording') {
      // Clicking start again while recording → do nothing (button label says "Recording…")
    } else if (recordingState === 'paused') {
      await bg('RESUME_RECORDING');
      setStatus('recording', parseInt(eventCountEl.textContent, 10));
      startPolling();
    }
  } catch (err) {
    alert(err.message);
  }
});

pauseBtn.addEventListener('click', async () => {
  try {
    if (recordingState === 'recording') {
      await bg('PAUSE_RECORDING');
      stopPolling();
      setStatus('paused', parseInt(eventCountEl.textContent, 10));
    } else if (recordingState === 'paused') {
      await bg('RESUME_RECORDING');
      setStatus('recording', parseInt(eventCountEl.textContent, 10));
      startPolling();
    }
  } catch (err) {
    alert(err.message);
  }
});

stopBtn.addEventListener('click', async () => {
  try {
    stopPolling();
    const recording = await bg('STOP_RECORDING');
    setStatus('idle', 0);
    recordingName.value = '';
    recordingDesc.value = '';

    // Download JSON automatically
    downloadJson(recording);

    // Refresh recordings list
    const state = await bg('GET_STATE');
    renderRecordings(state.recentRecordings || []);
  } catch (err) {
    alert(err.message);
  }
});

viewLiveBtn.addEventListener('click', async () => {
  try {
    const steps = await bg('GET_LIVE_STEPS');
    renderLiveSteps(steps);
    liveModal.classList.remove('hidden');
  } catch (err) {
    alert(err.message);
  }
});

closeLiveBtn.addEventListener('click', () => liveModal.classList.add('hidden'));
liveModal.addEventListener('click', e => {
  if (e.target === liveModal) liveModal.classList.add('hidden');
});

// ── Context menu for recording items ────────────────────────────────────────

recordingsList.addEventListener('click', e => {
  const menuBtn = e.target.closest('.rec-menu-btn');
  if (!menuBtn) return;
  e.stopPropagation();

  contextTarget = menuBtn.dataset.id;
  const rect = menuBtn.getBoundingClientRect();
  contextMenu.style.top  = (rect.bottom + 4) + 'px';
  contextMenu.style.left = Math.max(0, rect.right - 160) + 'px';
  contextMenu.classList.remove('hidden');
});

document.addEventListener('click', () => contextMenu.classList.add('hidden'));

ctxDownload.addEventListener('click', async () => {
  if (!contextTarget) return;
  try {
    const recording = await bg('GET_RECORDING', { id: contextTarget });
    if (recording) downloadJson(recording);
  } catch (err) {
    alert(err.message);
  }
});

ctxDelete.addEventListener('click', async () => {
  if (!contextTarget) return;
  try {
    await bg('DELETE_RECORDING', { id: contextTarget });
    const state = await bg('GET_STATE');
    renderRecordings(state.recentRecordings || []);
  } catch (err) {
    alert(err.message);
  }
  contextTarget = null;
});

document.getElementById('viewAllBtn').addEventListener('click', () => {
  // Dashboard not built yet — no-op
});

document.getElementById('openDashboardBtn').addEventListener('click', () => {
  // Dashboard not built yet — no-op
});

// ── Initialise ───────────────────────────────────────────────────────────────

(async () => {
  // Get the active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;
  renderTab(tab);

  // Sync with background state
  try {
    const state = await bg('GET_STATE');
    await syncState(state);
  } catch (err) {
    console.error('[WFR popup] init error:', err);
  }
})();
