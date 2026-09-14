const state = {
  data: null,
  activeTab: 'tab-stream',
  eventSource: null,
  isStreamPaused: false,
  streamEvents: [],
  maxStreamEvents: 300,
  countdownTimer: null,
  filters: {
    streamSearch: '',
    streamEvent: 'all',
    queueSearch: '',
    matrixSearch: '',
    errorsSearch: '',
  },
};

// DOM Elements
const streamStatusEl = document.querySelector('#stream-status');
const streamStatusLabel = streamStatusEl.querySelector('.status-label');
const streamToggleBtn = document.querySelector('#stream-toggle-btn');
const refreshDevBtn = document.querySelector('#refresh-dev-btn');
const streamLogContainer = document.querySelector('#stream-log-container');
const autoscrollChk = document.querySelector('#autoscroll-chk');
const modalEl = document.querySelector('#details-modal');
const modalTitle = document.querySelector('#modal-title');
const modalJsonContent = document.querySelector('#modal-json-content');
const modalCloseBtn = document.querySelector('#modal-close-btn');
const modalBackdrop = document.querySelector('#modal-backdrop');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initSearchFilters();
  initModal();
  loadOverview();
  initEventSource();
  startTimers();
});

// Tab Management
function initTabs() {
  document.querySelectorAll('.dev-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.dev-tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.dev-view').forEach((v) => v.classList.remove('active'));

      tab.classList.add('active');
      const targetId = tab.dataset.target;
      document.querySelector(`#${targetId}`).classList.add('active');
      state.activeTab = targetId;
    });
  });
}

// Search & Filter Listeners
function initSearchFilters() {
  document.querySelector('#stream-search').addEventListener('input', (e) => {
    state.filters.streamSearch = e.target.value.toLowerCase().trim();
    renderStreamLog();
  });

  document.querySelector('#stream-event-filter').addEventListener('change', (e) => {
    state.filters.streamEvent = e.target.value;
    renderStreamLog();
  });

  document.querySelector('#clear-stream-btn').addEventListener('click', () => {
    state.streamEvents = [];
    renderStreamLog();
  });

  document.querySelector('#queue-search').addEventListener('input', (e) => {
    state.filters.queueSearch = e.target.value.toLowerCase().trim();
    renderQueueTable();
  });

  document.querySelector('#matrix-search').addEventListener('input', (e) => {
    state.filters.matrixSearch = e.target.value.toLowerCase().trim();
    renderMatrixTable();
  });

  document.querySelector('#errors-search').addEventListener('input', (e) => {
    state.filters.errorsSearch = e.target.value.toLowerCase().trim();
    renderErrorsTable();
  });

  refreshDevBtn.addEventListener('click', () => loadOverview(true));

  streamToggleBtn.addEventListener('click', () => {
    state.isStreamPaused = !state.isStreamPaused;
    if (state.isStreamPaused) {
      streamToggleBtn.textContent = '▶ Resume Stream';
      streamStatusEl.className = 'stream-status paused';
      streamStatusLabel.textContent = 'SSE Stream Paused';
    } else {
      streamToggleBtn.textContent = '⏸ Pause Stream';
      streamStatusEl.className = 'stream-status connected';
      streamStatusLabel.textContent = 'SSE Stream Live';
    }
  });
}

// Load Full Data Snapshot
async function loadOverview(manual = false) {
  try {
    if (manual) refreshDevBtn.textContent = '↻ Loading...';
    const response = await fetch('/api/dev/overview');
    if (response.status === 401 || response.status === 403) {
      window.location.href = '/dashboard';
      return;
    }
    if (!response.ok) throw new Error('Could not load dev telemetry snapshot.');

    state.data = await response.json();
    if (!state.data.ok) throw new Error(state.data.error || 'Failed snapshot');

    // Populate Initial Stream Events if empty
    if (state.streamEvents.length === 0 && state.data.audit_logs) {
      state.streamEvents = [...state.data.audit_logs];
    }

    renderHeaderAndKPIs();
    renderStreamLog();
    renderQueueTable();
    renderMatrixTable();
    renderErrorsTable();
    renderSystemTab();
  } catch (err) {
    console.error('Overview fetch failed:', err);
  } finally {
    if (manual) refreshDevBtn.textContent = '↻ Refresh';
  }
}

// Setup Server-Sent Events (SSE) Stream
function initEventSource() {
  if (state.eventSource) state.eventSource.close();

  state.eventSource = new EventSource('/api/dev/stream');

  state.eventSource.onopen = () => {
    streamStatusEl.className = 'stream-status connected';
    streamStatusLabel.textContent = 'SSE Stream Live';
  };

  state.eventSource.addEventListener('audit_events', (e) => {
    if (state.isStreamPaused) return;
    try {
      const newLogs = JSON.parse(e.data);
      if (Array.isArray(newLogs) && newLogs.length > 0) {
        state.streamEvents = [...newLogs, ...state.streamEvents].slice(0, state.maxStreamEvents);
        renderStreamLog();
      }
    } catch (err) {
      console.error('Failed to parse incoming audit SSE event:', err);
    }
  });

  state.eventSource.addEventListener('queue_summary', (e) => {
    try {
      const summary = JSON.parse(e.data);
      let running = 0;
      let queued = 0;
      summary.forEach((row) => {
        if (row.status === 'running') running = row.count;
        if (row.status === 'queued') queued = row.count;
      });
      document.querySelector('#kpi-queue-active').textContent = `${running + queued}`;
      document.querySelector('#kpi-queue-breakdown').textContent = `${running} running • ${queued} queued`;
    } catch (_) {}
  });

  state.eventSource.onerror = () => {
    streamStatusEl.className = 'stream-status disconnected';
    streamStatusLabel.textContent = 'SSE Reconnecting...';
  };
}

// Render Top KPIs
function renderHeaderAndKPIs() {
  if (!state.data) return;
  const { stats, system, operator } = state.data;

  document.querySelector('#dev-operator-name').textContent = operator?.name || operator?.email || 'Admin';

  document.querySelector('#kpi-total-candidates').textContent = stats.total_candidates ?? 0;
  document.querySelector('#kpi-linked-candidates').textContent = `${stats.linked_candidates ?? 0} linked to Telegram`;
  document.querySelector('#kpi-active-sessions').textContent = stats.active_sessions ?? 0;
  document.querySelector('#kpi-applied-today').textContent = stats.applied_today ?? 0;

  const running = stats.queue_running ?? 0;
  const queued = stats.queue_queued ?? 0;
  document.querySelector('#kpi-queue-active').textContent = `${running + queued}`;
  document.querySelector('#kpi-queue-breakdown').textContent = `${running} running • ${queued} queued`;

  document.querySelector('#kpi-errors-count').textContent = stats.total_failures ?? 0;
  document.querySelector('#kpi-uptime').textContent = formatUptime(system.uptime_seconds);
  document.querySelector('#kpi-memory').textContent = `RAM: ${system.memory.rss_mb} MB • Node: ${system.node_version}`;

  // Update tab counts
  document.querySelector('#tab-count-events').textContent = state.streamEvents.length;
  document.querySelector('#tab-count-queue').textContent = state.data.queue ? state.data.queue.length : 0;
  document.querySelector('#tab-count-sessions').textContent = state.data.sessions ? state.data.sessions.length : 0;
  document.querySelector('#tab-count-errors').textContent = state.data.applied_jobs
    ? state.data.applied_jobs.filter((j) => j.status === 'failed' || j.status === 'external_or_failed').length
    : 0;
}

// 1. Render Stream Logs
function renderStreamLog() {
  const container = streamLogContainer;
  const filtered = state.streamEvents.filter((item) => {
    if (state.filters.streamEvent !== 'all' && item.event !== state.filters.streamEvent) return false;
    if (!state.filters.streamSearch) return true;

    const event = String(item.event || '').toLowerCase();
    const user = String(item.full_name || item.company_email || item.applywizz_id || item.telegram_chat_id || '').toLowerCase();
    const details = String(typeof item.details === 'object' ? JSON.stringify(item.details) : item.details || '').toLowerCase();

    return event.includes(state.filters.streamSearch) || user.includes(state.filters.streamSearch) || details.includes(state.filters.streamSearch);
  });

  document.querySelector('#tab-count-events').textContent = filtered.length;

  if (filtered.length === 0) {
    container.innerHTML = '<div class="stream-empty-msg">No events match current filter.</div>';
    return;
  }

  container.innerHTML = filtered.map((log) => {
    const timeStr = formatLogTime(log.created_at);
    const userDisplay = log.full_name || log.company_email || (log.telegram_chat_id ? `Chat ${log.telegram_chat_id}` : 'System');
    const eventClass = `event-${log.event || 'default'}`;
    const detailsStr = formatDetailsPreview(log.details);

    return `
      <div class="log-entry ${eventClass}">
        <div class="log-time">${timeStr}</div>
        <div class="log-user" title="${escapeHtml(userDisplay)}">${escapeHtml(userDisplay)}</div>
        <div class="log-event"><span class="badge ${getEventBadgeClass(log.event)}">${escapeHtml(log.event)}</span></div>
        <div class="log-details" title="${escapeHtml(detailsStr)}">${escapeHtml(detailsStr)}</div>
        <div>
          <button class="log-inspect-btn" onclick="inspectRaw(${escapeHtml(JSON.stringify(JSON.stringify(log)))})">Inspect</button>
        </div>
      </div>
    `;
  }).join('');

  if (autoscrollChk.checked) {
    container.scrollTop = 0;
  }
}

// 2. Render Apply Queue Table & Workers
function renderQueueTable() {
  if (!state.data || !state.data.queue) return;
  const queue = state.data.queue;
  const workersGrid = document.querySelector('#workers-card-grid');
  const tbody = document.querySelector('#queue-table-body');

  // Render Worker Cards (Worker-1 to Worker-N based on max_concurrency or active jobs)
  const maxWorkers = Math.min(10, state.data.system?.max_concurrency || 5);
  const activeWorkerMap = new Map();
  queue.forEach((q) => {
    if (q.status === 'running' && q.worker_id) {
      activeWorkerMap.set(q.worker_id, q);
    }
  });

  let workerCardsHtml = '';
  for (let i = 1; i <= Math.max(2, activeWorkerMap.size); i++) {
    const workerId = `worker-${i}`;
    const activeJob = activeWorkerMap.get(workerId);
    const isRunning = Boolean(activeJob);

    workerCardsHtml += `
      <div class="worker-card ${isRunning ? 'active' : ''}">
        <div class="worker-card-header">
          <strong>${workerId}</strong>
          <span class="badge ${isRunning ? 'badge-green' : 'badge-gray'}">${isRunning ? 'RUNNING' : 'IDLE'}</span>
        </div>
        <div style="font-size:11px; color:var(--text-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
          ${isRunning ? escapeHtml(activeJob.full_name || `Chat ${activeJob.telegram_chat_id}`) : 'Waiting for available job...'}
        </div>
      </div>
    `;
  }
  workersGrid.innerHTML = workerCardsHtml;

  // Filter Queue Table
  const filtered = queue.filter((item) => {
    if (!state.filters.queueSearch) return true;
    const user = String(item.full_name || item.company_email || item.telegram_chat_id || '').toLowerCase();
    const url = String(item.url || '').toLowerCase();
    const status = String(item.status || '').toLowerCase();
    return user.includes(state.filters.queueSearch) || url.includes(state.filters.queueSearch) || status.includes(state.filters.queueSearch);
  });

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted" style="padding:20px;">No matching queue items.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map((item) => {
    const userDisplay = item.full_name || item.company_email || `Chat ${item.telegram_chat_id}`;
    const statusClass = getQueueStatusBadge(item.status);
    const delayInfo = item.available_at ? remaining(item.available_at) : 'Immediate';
    const isDelayed = item.available_at && new Date(item.available_at).getTime() > Date.now();

    return `
      <tr>
        <td><span class="badge ${statusClass}">${escapeHtml(item.status)}</span></td>
        <td><strong>${escapeHtml(userDisplay)}</strong></td>
        <td><a href="${escapeHtml(item.url || '#')}" target="_blank" rel="noopener" style="color:var(--accent-blue); text-decoration:none;">Link ↗</a></td>
        <td><span data-countdown="${escapeHtml(item.available_at || '')}">${isDelayed ? `⏳ In ${delayInfo}` : 'Ready'}</span></td>
        <td><code>${escapeHtml(item.worker_id || '—')}</code></td>
        <td>${item.attempts ?? 0} / ${item.max_attempts ?? 3}</td>
        <td style="color:var(--accent-red); max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(item.last_error || '')}">
          ${escapeHtml(item.last_error || '—')}
        </td>
      </tr>
    `;
  }).join('');
}

// 3. Render Candidate Matrix Table
function renderMatrixTable() {
  if (!state.data || !state.data.sessions) return;
  const sessions = state.data.sessions;
  const tbody = document.querySelector('#sessions-table-body');

  const filtered = sessions.filter((s) => {
    if (!state.filters.matrixSearch) return true;
    const user = String(s.full_name || s.company_email || s.applywizz_id || s.telegram_chat_id || '').toLowerCase();
    return user.includes(state.filters.matrixSearch);
  });

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted" style="padding:20px;">No candidate sessions found.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map((s) => {
    const name = s.full_name || s.company_email || `Chat ${s.telegram_chat_id}`;
    const isLive = s.session_deadline && new Date(s.session_deadline).getTime() > Date.now();
    const sessionTimer = s.session_deadline ? remaining(s.session_deadline) : '—';
    const nextScan = s.next_scan_at ? new Date(s.next_scan_at).toLocaleTimeString() : '—';
    const decisionBadge = s.last_decision ? getDecisionBadge(s.last_decision) : 'badge-gray';

    return `
      <tr>
        <td><strong>${escapeHtml(name)}</strong></td>
        <td><code>${escapeHtml(String(s.telegram_chat_id))}</code></td>
        <td>${escapeHtml(s.ca_name || 'Unassigned')}</td>
        <td>
          <span class="badge ${isLive ? 'badge-green' : 'badge-gray'}" data-countdown="${escapeHtml(s.session_deadline || '')}">
            ${isLive ? `● ${sessionTimer} left` : 'Expired'}
          </span>
        </td>
        <td><strong>${s.consecutive_no_count ?? 0}</strong> / 3</td>
        <td>${nextScan}</td>
        <td><span class="badge ${decisionBadge}">${escapeHtml(s.last_decision || 'none')}</span></td>
        <td>
          ${s.current_prompt_url ? `<a href="${escapeHtml(s.current_prompt_url)}" target="_blank" rel="noopener" style="color:var(--accent-blue)">Active Prompt ↗</a>` : '<span style="color:var(--text-dim)">None</span>'}
        </td>
      </tr>
    `;
  }).join('');
}

// 4. Render Error Diagnostics Table
function renderErrorsTable() {
  if (!state.data || !state.data.applied_jobs) return;
  const jobs = state.data.applied_jobs;
  const tbody = document.querySelector('#errors-table-body');

  const errorJobs = jobs.filter((j) => j.status === 'failed' || j.status === 'external_or_failed' || j.status === 'external');

  const filtered = errorJobs.filter((j) => {
    if (!state.filters.errorsSearch) return true;
    const user = String(j.full_name || j.company_email || j.telegram_chat_id || '').toLowerCase();
    const title = String(j.job_name || '').toLowerCase();
    const status = String(j.status || '').toLowerCase();
    return user.includes(state.filters.errorsSearch) || title.includes(state.filters.errorsSearch) || status.includes(state.filters.errorsSearch);
  });

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted" style="padding:20px;">No failure records found for this period.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map((j) => {
    const user = j.full_name || j.company_email || `Chat ${j.telegram_chat_id}`;
    const timeStr = j.applied_at ? new Date(j.applied_at).toLocaleString() : '—';

    return `
      <tr>
        <td style="font-family:var(--font-mono); font-size:11px;">${timeStr}</td>
        <td><strong>${escapeHtml(user)}</strong></td>
        <td>${escapeHtml(j.job_name || 'Unnamed job')}</td>
        <td><span class="badge badge-red">${escapeHtml(j.status)}</span></td>
        <td><a href="${escapeHtml(j.url || '#')}" target="_blank" rel="noopener" style="color:var(--accent-blue)">Inspect Link ↗</a></td>
      </tr>
    `;
  }).join('');
}

// 5. Render System Tab
function renderSystemTab() {
  if (!state.data || !state.data.system) return;
  const { system, ca_accounts } = state.data;

  document.querySelector('#sys-node-ver').textContent = system.node_version || '—';
  document.querySelector('#sys-platform').textContent = system.platform || '—';
  document.querySelector('#sys-uptime-long').textContent = formatUptime(system.uptime_seconds);
  document.querySelector('#sys-browser-mode').textContent = system.browser_mode || 'Local Playwright';
  document.querySelector('#sys-max-concurrency').textContent = `${system.max_concurrency || 20} concurrent slots`;

  document.querySelector('#sys-mem-rss').textContent = `${system.memory.rss_mb} MB`;
  document.querySelector('#sys-mem-heap-used').textContent = `${system.memory.heap_used_mb} MB`;
  document.querySelector('#sys-mem-heap-total').textContent = `${system.memory.heap_total_mb} MB`;

  const casTableBody = document.querySelector('#cas-table-body');
  if (ca_accounts && ca_accounts.length > 0) {
    casTableBody.innerHTML = ca_accounts.map((ca) => `
      <tr>
        <td><strong>${escapeHtml(ca.name || 'Unnamed')}</strong></td>
        <td>${escapeHtml(ca.email || '—')}</td>
        <td><span class="badge ${ca.role === 'admin' ? 'badge-purple' : 'badge-blue'}">${escapeHtml(ca.role)}</span></td>
        <td><span class="badge ${ca.disabled ? 'badge-red' : 'badge-green'}">${ca.disabled ? 'Disabled' : 'Active'}</span></td>
      </tr>
    `).join('');
  }
}

// Modal Inspector
function initModal() {
  const closeModal = () => { modalEl.hidden = true; };
  modalCloseBtn.addEventListener('click', closeModal);
  modalBackdrop.addEventListener('click', closeModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modalEl.hidden) closeModal();
  });
}

window.inspectRaw = function(jsonStr) {
  try {
    const parsed = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
    modalTitle.textContent = `Event #${parsed.id || 'Details'} - ${parsed.event || 'Audit'}`;
    modalJsonContent.textContent = JSON.stringify(parsed, null, 2);
    modalEl.hidden = false;
  } catch (err) {
    console.error('Could not parse modal JSON:', err);
  }
};

// Utilities
function formatLogTime(val) {
  if (!val) return '—';
  const d = new Date(val);
  return d.toLocaleTimeString() + `.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function formatDetailsPreview(details) {
  if (!details) return '';
  if (typeof details === 'string') return details;
  const parts = [];
  if (details.url) parts.push(`url: ${details.url}`);
  if (details.reason) parts.push(`reason: ${details.reason}`);
  if (details.delayMs) parts.push(`delay: ${Math.round(details.delayMs / 60000)}m`);
  if (details.durationMs) parts.push(`duration: ${Math.round(details.durationMs / 1000)}s`);
  return parts.length > 0 ? parts.join(' | ') : JSON.stringify(details);
}

function getEventBadgeClass(event) {
  switch (event) {
    case 'job_yes': return 'badge-green';
    case 'job_no': return 'badge-red';
    case 'job_missed': return 'badge-amber';
    case 'job_prompt_sent': return 'badge-blue';
    case 'job_queued': return 'badge-purple';
    case 'automation_delay_started': return 'badge-amber';
    default: return 'badge-gray';
  }
}

function getQueueStatusBadge(status) {
  switch (status) {
    case 'running': return 'badge-green';
    case 'queued': return 'badge-amber';
    case 'completed': return 'badge-blue';
    case 'failed': return 'badge-red';
    default: return 'badge-gray';
  }
}

function getDecisionBadge(decision) {
  switch (decision) {
    case 'yes':
    case 'approved': return 'badge-green';
    case 'no':
    case 'rejected': return 'badge-red';
    case 'missed': return 'badge-amber';
    default: return 'badge-gray';
  }
}

function formatUptime(seconds) {
  if (!seconds) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

function startTimers() {
  if (state.countdownTimer) clearInterval(state.countdownTimer);
  state.countdownTimer = setInterval(() => {
    document.querySelectorAll('[data-countdown]').forEach((el) => {
      const deadline = el.dataset.countdown;
      if (deadline) {
        const text = remaining(deadline);
        if (el.textContent.includes('●')) {
          el.textContent = `● ${text} left`;
        } else if (el.textContent.includes('In')) {
          el.textContent = `⏳ In ${text}`;
        }
      }
    });
  }, 1000);
}

function remaining(deadline) {
  if (!deadline) return '—';
  const seconds = Math.max(0, Math.floor((new Date(deadline).getTime() - Date.now()) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
}

function escapeHtml(val) {
  return String(val ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
