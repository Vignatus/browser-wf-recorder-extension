// popup.js — Record tab state machine + Replay tab state machine.

// ── Messaging helper ─────────────────────────────────────────────────────────

async function bg(type, payload) {
  const response = await chrome.runtime.sendMessage({ type, payload });
  if (!response.ok) throw new Error(response.error || 'Unknown error');
  return response.result;
}

// ── Tab switching ─────────────────────────────────────────────────────────────

const tabRecord  = document.getElementById('tabRecord');
const tabReplay  = document.getElementById('tabReplay');
const panelRecord = document.getElementById('panelRecord');
const panelReplay = document.getElementById('panelReplay');

let activeTab = 'record';

function switchTab(tab) {
  activeTab = tab;
  tabRecord.classList.toggle('active', tab === 'record');
  tabReplay.classList.toggle('active', tab === 'replay');
  panelRecord.classList.toggle('hidden', tab !== 'record');
  panelReplay.classList.toggle('hidden', tab !== 'replay');
  if (tab === 'replay') refreshReplayRecordingList();
}

tabRecord.addEventListener('click', () => switchTab('record'));
tabReplay.addEventListener('click', () => switchTab('replay'));

// ══════════════════════════════════════════════════════════════════════════════
// RECORD TAB
// ══════════════════════════════════════════════════════════════════════════════

const statusDot      = document.getElementById('statusDot');
const statusLabel    = document.getElementById('statusLabel');
const currentTabEl   = document.getElementById('currentTabDisplay');
const eventCountEl   = document.getElementById('eventCount');
const recordingName  = document.getElementById('recordingName');
const recordingDesc  = document.getElementById('recordingDescription');
const startBtn       = document.getElementById('startBtn');
const startBtnLabel  = document.getElementById('startBtnLabel');
const pauseBtn       = document.getElementById('pauseBtn');
const pauseBtnLabel  = document.getElementById('pauseBtnLabel');
const stopBtn        = document.getElementById('stopBtn');
const viewLiveBtn    = document.getElementById('viewLiveBtn');
const recordingsList = document.getElementById('recordingsList');
const emptyState     = document.getElementById('emptyState');
const liveModal      = document.getElementById('liveModal');
const liveStepsList  = document.getElementById('liveStepsList');
const closeLiveBtn   = document.getElementById('closeLiveModal');
const contextMenu    = document.getElementById('contextMenu');
const ctxDownload    = document.getElementById('ctxDownload');
const ctxReplay      = document.getElementById('ctxReplay');
const ctxDelete      = document.getElementById('ctxDelete');

let currentTab = null;
let recordingState = 'idle'; // idle | recording | paused
let recPollTimer = null;
let contextTarget = null;

// ── Record status UI ──────────────────────────────────────────────────────────

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

  recordingName.disabled = isActive;
  recordingDesc.disabled = isActive;
}

function renderTab(tab) {
  if (!tab) { currentTabEl.textContent = '—'; return; }
  try {
    currentTabEl.textContent = new URL(tab.url).hostname || tab.url;
  } catch {
    currentTabEl.textContent = tab.url || '—';
  }
}

// ── Recordings list ───────────────────────────────────────────────────────────

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)  return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60)  return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24)  return h + 'h ago';
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
    recordingsList.querySelectorAll('.recording-item').forEach(el => el.remove());
    return;
  }
  emptyState.style.display = 'none';
  const existing = new Set([...recordingsList.querySelectorAll('.recording-item')].map(el => el.dataset.id));
  const incoming = new Set(recordings.map(r => r.id));

  recordingsList.querySelectorAll('.recording-item').forEach(el => {
    if (!incoming.has(el.dataset.id)) el.remove();
  });

  recordings.forEach((rec, idx) => {
    if (existing.has(rec.id)) return;
    let hostname = rec.tabUrl;
    try { hostname = new URL(rec.tabUrl).hostname; } catch {}

    const el = document.createElement('div');
    el.className = 'recording-item';
    el.dataset.id = rec.id;
    el.innerHTML = `
      <div class="rec-icon ${idx % 2 === 1 ? 'purple' : ''}">${recIcon()}</div>
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
    recordingsList.appendChild(el);
  });
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Live steps modal ──────────────────────────────────────────────────────────

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
    liveStepsList.innerHTML = '<div class="modal-empty">No steps captured yet.</div>';
    return;
  }
  liveStepsList.innerHTML = steps.map(step => {
    const badge = stepBadgeClass(step.stepType);
    const label = step.label || step.url || step.stepType;
    let detail = '';
    if (step.stepType === 'type')           detail = `<div class="step-detail">Value: "${escHtml(step.value || '')}"</div>`;
    else if (step.stepType === 'navigate')  detail = `<div class="step-detail">${escHtml(step.url)}</div>`;
    else if (step.stepType === 'click')     detail = `<div class="step-detail">${escHtml(step.selector || '')}</div>`;
    else if (step.stepType === 'select')    detail = `<div class="step-detail">Selected: "${escHtml(step.metadata?.selectedText || step.value || '')}"</div>`;
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

// ── JSON download ─────────────────────────────────────────────────────────────

function downloadJson(recording) {
  const blob = new Blob([JSON.stringify(recording, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = (recording.name || 'workflow').replace(/[^a-z0-9]/gi, '_') + '_' + recording.id + '.json';
  a.click();
  URL.revokeObjectURL(url);
}

// ── Polling for record tab ────────────────────────────────────────────────────

function startRecPoll() {
  stopRecPoll();
  recPollTimer = setInterval(async () => {
    try {
      const state = await bg('GET_STATE');
      if (state.status === 'idle') { stopRecPoll(); syncState(state); return; }
      eventCountEl.textContent = state.session?.eventCount ?? 0;
    } catch {}
  }, 500);
}

function stopRecPoll() {
  if (recPollTimer) { clearInterval(recPollTimer); recPollTimer = null; }
}

async function syncState(state) {
  setStatus(state.status, state.session?.eventCount ?? 0);
  if (state.session && recordingName.value === '') {
    recordingName.value = state.session.name;
    recordingDesc.value = state.session.description || '';
  }
  renderRecordings(state.recentRecordings || []);
  if (state.status !== 'idle') startRecPoll();
}

// ── Record button handlers ────────────────────────────────────────────────────

startBtn.addEventListener('click', async () => {
  try {
    if (recordingState === 'idle') {
      const name = recordingName.value.trim() || 'Untitled workflow';
      await bg('START_RECORDING', {
        name,
        description: recordingDesc.value.trim(),
        tabId:  currentTab.id,
        tabUrl: currentTab.url,
      });
      setStatus('recording', 0);
      startRecPoll();
    } else if (recordingState === 'paused') {
      await bg('RESUME_RECORDING');
      setStatus('recording', parseInt(eventCountEl.textContent, 10));
      startRecPoll();
    }
  } catch (err) { alert(err.message); }
});

pauseBtn.addEventListener('click', async () => {
  try {
    if (recordingState === 'recording') {
      await bg('PAUSE_RECORDING');
      stopRecPoll();
      setStatus('paused', parseInt(eventCountEl.textContent, 10));
    } else if (recordingState === 'paused') {
      await bg('RESUME_RECORDING');
      setStatus('recording', parseInt(eventCountEl.textContent, 10));
      startRecPoll();
    }
  } catch (err) { alert(err.message); }
});

stopBtn.addEventListener('click', async () => {
  try {
    stopRecPoll();
    const recording = await bg('STOP_RECORDING');
    setStatus('idle', 0);
    recordingName.value = '';
    recordingDesc.value = '';
    downloadJson(recording);
    const state = await bg('GET_STATE');
    renderRecordings(state.recentRecordings || []);
  } catch (err) { alert(err.message); }
});

viewLiveBtn.addEventListener('click', async () => {
  try {
    const steps = await bg('GET_LIVE_STEPS');
    renderLiveSteps(steps);
    liveModal.classList.remove('hidden');
  } catch (err) { alert(err.message); }
});

closeLiveBtn.addEventListener('click', () => liveModal.classList.add('hidden'));
liveModal.addEventListener('click', e => {
  if (e.target === liveModal) liveModal.classList.add('hidden');
});

// ── Context menu ──────────────────────────────────────────────────────────────

recordingsList.addEventListener('click', e => {
  const menuBtn = e.target.closest('.rec-menu-btn');
  if (!menuBtn) return;
  e.stopPropagation();
  contextTarget = menuBtn.dataset.id;
  const rect = menuBtn.getBoundingClientRect();

  // Reveal off-screen to measure actual height, then place correctly
  contextMenu.style.visibility = 'hidden';
  contextMenu.style.top  = '0px';
  contextMenu.style.left = '0px';
  contextMenu.classList.remove('hidden');
  const menuH = contextMenu.offsetHeight;
  contextMenu.style.visibility = '';

  const left = Math.max(4, rect.right - contextMenu.offsetWidth - 4);
  const spaceBelow = window.innerHeight - rect.bottom;
  const top = spaceBelow >= menuH + 8 ? rect.bottom + 4 : rect.top - menuH - 4;
  contextMenu.style.top  = top + 'px';
  contextMenu.style.left = left + 'px';
});

document.addEventListener('click', () => contextMenu.classList.add('hidden'));

ctxDownload.addEventListener('click', async () => {
  if (!contextTarget) return;
  try {
    const recording = await bg('GET_RECORDING', { id: contextTarget });
    if (recording) downloadJson(recording);
  } catch (err) { alert(err.message); }
});

ctxReplay.addEventListener('click', () => {
  if (!contextTarget) return;
  switchTab('replay');
  // Pre-select the recording in the replay tab
  setTimeout(() => {
    const select = document.getElementById('replayRecSelect');
    if (select) { select.value = contextTarget; select.dispatchEvent(new Event('change')); }
  }, 50);
  contextTarget = null;
});

ctxDelete.addEventListener('click', async () => {
  if (!contextTarget) return;
  try {
    await bg('DELETE_RECORDING', { id: contextTarget });
    const state = await bg('GET_STATE');
    renderRecordings(state.recentRecordings || []);
    if (activeTab === 'replay') refreshReplayRecordingList();
  } catch (err) { alert(err.message); }
  contextTarget = null;
});

document.getElementById('viewAllBtn').addEventListener('click', () => {});
document.getElementById('openDashboardBtn').addEventListener('click', () => {});

// ══════════════════════════════════════════════════════════════════════════════
// REPLAY TAB
// ══════════════════════════════════════════════════════════════════════════════

const replayRecSelect   = document.getElementById('replayRecSelect');
const replayRecInfo     = document.getElementById('replayRecInfo');
const replayTarget      = document.getElementById('replayTarget');
const replaySpeed       = document.getElementById('replaySpeed');
const modeBtns          = document.getElementById('modeBtns');
const replayStartBtn    = document.getElementById('replayStartBtn');
const replayPauseBtn    = document.getElementById('replayPauseBtn');
const replayPauseBtnLabel = document.getElementById('replayPauseBtnLabel');
const replayStopBtn     = document.getElementById('replayStopBtn');
const replayStepBtn     = document.getElementById('replayStepBtn');
const replayLog         = document.getElementById('replayLog');
const replayLogEmpty    = document.getElementById('replayLogEmpty');
const clearLogBtn       = document.getElementById('clearLogBtn');
const replayProgress    = document.getElementById('replayProgress');
const progressMeta      = document.getElementById('progressMeta');
const progressFill      = document.getElementById('progressFill');
const progressPct       = document.getElementById('progressPct');
const screenshotModal   = document.getElementById('screenshotModal');
const screenshotImg     = document.getElementById('screenshotImg');
const closeScreenshotModal = document.getElementById('closeScreenshotModal');

let replayState = 'idle';   // idle | running | paused | done
let replayMode  = 'full';   // full | step
let replayPollTimer = null;
let renderedLogCount = 0;
let allRecordings = [];

// ── Mode button selection ─────────────────────────────────────────────────────

modeBtns.addEventListener('click', e => {
  const btn = e.target.closest('.mode-btn');
  if (!btn || btn.disabled) return;
  modeBtns.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  replayMode = btn.dataset.mode;
  // Step button only useful in step mode
  replayStepBtn.disabled = replayState !== 'running' || replayMode !== 'step';
});

// ── Recording selector ────────────────────────────────────────────────────────

async function refreshReplayRecordingList() {
  try {
    const state = await bg('GET_STATE');
    allRecordings = state.allRecordings || [];
    const prev = replayRecSelect.value;

    // Keep the placeholder option, replace the rest
    while (replayRecSelect.options.length > 1) replayRecSelect.remove(1);

    allRecordings.forEach(rec => {
      let host = rec.tabUrl;
      try { host = new URL(rec.tabUrl).hostname; } catch {}
      const opt = document.createElement('option');
      opt.value = rec.id;
      opt.textContent = `${rec.name} — ${host} • ${rec.stepCount ?? 0} steps`;
      replayRecSelect.appendChild(opt);
    });

    // Restore previous selection if still present
    if (prev && [...replayRecSelect.options].some(o => o.value === prev)) {
      replayRecSelect.value = prev;
      updateRecInfo(prev);
    } else {
      replayRecInfo.classList.add('hidden');
    }
  } catch {}
}

replayRecSelect.addEventListener('change', () => {
  updateRecInfo(replayRecSelect.value);
});

function updateRecInfo(id) {
  const rec = allRecordings.find(r => r.id === id);
  if (!rec) { replayRecInfo.classList.add('hidden'); return; }

  let host = rec.tabUrl;
  try { host = new URL(rec.tabUrl).hostname; } catch {}

  const ago = timeAgo(rec.startTime);
  replayRecInfo.innerHTML = `
    <div class="replay-rec-info-name">${escHtml(rec.name)}</div>
    <div class="replay-rec-info-meta">${escHtml(host)} &bull; ${rec.stepCount ?? 0} steps &bull; ${ago}</div>`;
  replayRecInfo.classList.remove('hidden');
}

// ── Replay state UI ───────────────────────────────────────────────────────────

function setReplayStatus(state) {
  replayState = state;
  const isActive = state === 'running' || state === 'paused';

  if (state === 'idle') {
    replayStartBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4l14 8-14 8V4z"/></svg> Start Replay`;
    replayStartBtn.disabled = false;
    replayStartBtn.classList.remove('is-running');
  } else if (state === 'done') {
    replayStartBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4l14 8-14 8V4z"/></svg> Replay Again`;
    replayStartBtn.disabled = false;
    replayStartBtn.classList.remove('is-running');
  } else {
    replayStartBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg> Replaying…`;
    replayStartBtn.disabled = true;
    replayStartBtn.classList.add('is-running');
  }

  replayPauseBtn.disabled  = !isActive;
  replayStopBtn.disabled   = !isActive;
  replayStepBtn.disabled   = !(state === 'running' && replayMode === 'step');

  if (state === 'running') {
    replayPauseBtnLabel.textContent = 'Pause';
  } else if (state === 'paused') {
    replayPauseBtnLabel.textContent = 'Resume';
    replayStepBtn.disabled = false; // allow stepping while paused too
  }

  replayRecSelect.disabled  = isActive;
  replayTarget.disabled     = isActive;
  replaySpeed.disabled      = isActive;
  modeBtns.querySelectorAll('.mode-btn').forEach(b => { b.disabled = isActive || b.dataset.mode === 'custom'; });

  if (!isActive && state !== 'done') {
    replayProgress.classList.add('hidden');
  }
}

// ── Replay log rendering ──────────────────────────────────────────────────────

const STATUS_ICONS = {
  ok:      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>',
  fail:    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>',
  skip:    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2"><path stroke-linecap="round" d="M13 5l7 7-7 7M5 5l7 7-7 7"/></svg>',
  running: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4f6ef7" stroke-width="2"><circle cx="12" cy="12" r="9" stroke-dasharray="28" stroke-dashoffset="0"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></circle></svg>',
  pending: '',
};

function formatTime(ts) {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
}

function appendLogEntries(logEntries, startFrom = 0) {
  if (logEntries.length === 0 && startFrom === 0) {
    replayLogEmpty.style.display = '';
    return;
  }
  replayLogEmpty.style.display = 'none';

  for (let i = startFrom; i < logEntries.length; i++) {
    const entry = logEntries[i];
    const div = document.createElement('div');
    div.className = `log-entry status-${entry.status}`;
    div.dataset.idx = entry.idx;

    const badgeClass = entry.stepType.replace('_radio', '');

    let extra = '';
    if (entry.status === 'fail' && entry.screenshot) {
      extra = `<button class="log-fail-btn" data-idx="${entry.idx}">Screenshot</button>`;
    }

    div.innerHTML = `
      <span class="log-time">${formatTime(entry.timestamp)}</span>
      <span class="log-badge ${badgeClass}">${entry.stepType.replace(/_/g, ' ')}</span>
      <span class="log-label" title="${escHtml(entry.label)}">${escHtml(entry.label)}</span>
      ${extra}
      <span class="log-status">${STATUS_ICONS[entry.status] || ''}</span>`;

    replayLog.appendChild(div);
    replayLog.scrollTop = replayLog.scrollHeight;
  }
}

function refreshLogEntry(entry) {
  const existing = replayLog.querySelector(`.log-entry[data-idx="${entry.idx}"]`);
  if (!existing) return;
  existing.className = `log-entry status-${entry.status}`;

  let extra = '';
  if (entry.status === 'fail' && entry.screenshot) {
    extra = `<button class="log-fail-btn" data-idx="${entry.idx}">Screenshot</button>`;
  }
  const badgeClass = entry.stepType.replace('_radio', '');

  existing.innerHTML = `
    <span class="log-time">${formatTime(entry.timestamp)}</span>
    <span class="log-badge ${badgeClass}">${entry.stepType.replace(/_/g, ' ')}</span>
    <span class="log-label" title="${escHtml(entry.label)}">${escHtml(entry.label)}</span>
    ${extra}
    <span class="log-status">${STATUS_ICONS[entry.status] || ''}</span>`;
}

replayLog.addEventListener('click', e => {
  const btn = e.target.closest('.log-fail-btn');
  if (!btn) return;
  const idx = parseInt(btn.dataset.idx, 10);
  const state = lastReplayState;
  const entry = state?.log?.[idx];
  if (entry?.screenshot) {
    screenshotImg.src = entry.screenshot;
    screenshotModal.classList.remove('hidden');
  }
});

closeScreenshotModal.addEventListener('click', () => screenshotModal.classList.add('hidden'));
screenshotModal.addEventListener('click', e => {
  if (e.target === screenshotModal) screenshotModal.classList.add('hidden');
});

// ── Replay polling ────────────────────────────────────────────────────────────

let lastReplayState = null;

function startReplayPoll() {
  stopReplayPoll();
  replayPollTimer = setInterval(async () => {
    try {
      const rs = await bg('GET_REPLAY_STATE');
      applyReplayState(rs);
      if (rs.state === 'done' || rs.state === 'idle') stopReplayPoll();
    } catch {}
  }, 500);
}

function stopReplayPoll() {
  if (replayPollTimer) { clearInterval(replayPollTimer); replayPollTimer = null; }
}

function applyReplayState(rs) {
  lastReplayState = rs;

  if (rs.state !== replayState) setReplayStatus(rs.state);

  // Append new log entries
  if (rs.log && rs.log.length > renderedLogCount) {
    appendLogEntries(rs.log, renderedLogCount);
    renderedLogCount = rs.log.length;
  }
  // Refresh last entry in case its status changed (running → ok/fail)
  if (rs.log && rs.log.length > 0) {
    refreshLogEntry(rs.log[rs.log.length - 1]);
  }

  // Progress bar
  if (rs.state !== 'idle' && rs.total > 0) {
    replayProgress.classList.remove('hidden');
    const pct = Math.round((rs.index / rs.total) * 100);
    progressFill.style.width = pct + '%';
    progressPct.textContent  = pct + '%';
    progressMeta.innerHTML   = `Elapsed: ${formatElapsed(rs.elapsed)} &bull; Step ${rs.index} of ${rs.total}`;
  }
}

function formatElapsed(ms) {
  const s = Math.floor((ms || 0) / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  return [h, m % 60, s % 60].map(n => String(n).padStart(2, '0')).join(':');
}

// ── Replay button handlers ────────────────────────────────────────────────────

replayStartBtn.addEventListener('click', async () => {
  const recId = replayRecSelect.value;
  if (!recId) { alert('Please select a recording first.'); return; }

  if (replayState === 'done') {
    // Reset for replay again
    replayLog.querySelectorAll('.log-entry').forEach(el => el.remove());
    renderedLogCount = 0;
    replayLogEmpty.style.display = '';
    replayProgress.classList.add('hidden');
    lastReplayState = null;
  }

  try {
    await bg('START_REPLAY', {
      recordingId: recId,
      options: {
        target: replayTarget.value,
        speed:  replaySpeed.value,
        mode:   replayMode,
      },
    });
    setReplayStatus('running');
    startReplayPoll();
  } catch (err) { alert(err.message); }
});

replayPauseBtn.addEventListener('click', async () => {
  try {
    if (replayState === 'running') {
      await bg('PAUSE_REPLAY');
      setReplayStatus('paused');
    } else if (replayState === 'paused') {
      await bg('RESUME_REPLAY');
      setReplayStatus('running');
      startReplayPoll();
    }
  } catch (err) { alert(err.message); }
});

replayStopBtn.addEventListener('click', async () => {
  try {
    stopReplayPoll();
    await bg('STOP_REPLAY');
    setReplayStatus('idle');
  } catch (err) { alert(err.message); }
});

replayStepBtn.addEventListener('click', async () => {
  try {
    await bg('STEP_REPLAY');
    // Poll once immediately to update UI
    const rs = await bg('GET_REPLAY_STATE');
    applyReplayState(rs);
  } catch (err) { alert(err.message); }
});

clearLogBtn.addEventListener('click', () => {
  replayLog.querySelectorAll('.log-entry').forEach(el => el.remove());
  renderedLogCount = 0;
  replayLogEmpty.style.display = '';
  replayProgress.classList.add('hidden');
  lastReplayState = null;
  if (replayState === 'idle' || replayState === 'done') setReplayStatus('idle');
});

// ══════════════════════════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════════════════════════

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;
  renderTab(tab);

  try {
    const state = await bg('GET_STATE');
    await syncState(state);

    // Sync replay state on open (in case replay was running from before)
    if (state.replayState && state.replayState.state !== 'idle') {
      switchTab('replay');
      setReplayStatus(state.replayState.state);
      applyReplayState(state.replayState);
      if (state.replayState.state === 'running' || state.replayState.state === 'paused') {
        startReplayPoll();
      }
    }
  } catch (err) {
    console.error('[WFR popup] init error:', err);
  }
})();
