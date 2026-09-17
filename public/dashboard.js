const state = {
  timer: null,
  countdownTimer: null,
  data: null,
  activeTab: 'dashboard', // 'dashboard' | 'stats'
  activeCandidateId: null, // null keeps right side blank
  candidateSubTab: 'dashboard', // 'dashboard' | 'jobs'
  selectedJobId: null,
  searchQuery: '',
  globalJobSearch: '',
  operatorEmail: '',
  operatorName: 'Operator',
};

const dateInput = document.querySelector('#date');
const timezoneInput = document.querySelector('#timezone');
const statusText = document.querySelector('#status');

const navDashboardTab = document.querySelector('#nav-dashboard-tab');
const navStatsTab = document.querySelector('#nav-stats-tab');
const refreshBtn = document.querySelector('#refresh-btn');
const syncMappingsBtn = document.querySelector('#sync-mappings-btn');
const logoutBtn = document.querySelector('#logout');

const loginPanel = document.querySelector('#login');
const dashboardViewContainer = document.querySelector('#dashboard-view-container');
const statsViewContainer = document.querySelector('#stats-view-container');

const requestOtpForm = document.querySelector('#request-otp-form');
const verifyOtpForm = document.querySelector('#verify-otp-form');
const emailInput = document.querySelector('#email');
const otpInput = document.querySelector('#otp');
const emailError = document.querySelector('#email-error');
const otpError = document.querySelector('#otp-error');
const otpSentInfo = document.querySelector('#otp-sent-info');

const candidateSearchInput = document.querySelector('#candidate-search');
const candidateList = document.querySelector('#candidate-list');
const directoryCountBadge = document.querySelector('#directory-count-badge');

const emptyWorkspace = document.querySelector('#empty-workspace');
const candidateWorkspace = document.querySelector('#candidate-workspace');
const subnavDashboardBtn = document.querySelector('#subnav-dashboard-btn');
const subnavJobsBtn = document.querySelector('#subnav-jobs-btn');
const candidateDashboardTabContent = document.querySelector('#candidate-dashboard-tab-content');
const candidateJobsTabContent = document.querySelector('#candidate-jobs-tab-content');

const candidateJobsQueue = document.querySelector('#candidate-jobs-queue');
const detailJobCompany = document.querySelector('#detail-job-company');
const detailJobStatus = document.querySelector('#detail-job-status');
const detailJobTitle = document.querySelector('#detail-job-title');
const detailJobUrl = document.querySelector('#detail-job-url');
const sessionMetricsGrid = document.querySelector('#session-metrics-grid');

const globalJobsSearchInput = document.querySelector('#global-jobs-search');

// Default date = today YYYY-MM-DD
const today = new Date();
dateInput.value = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, '0'), String(today.getDate()).padStart(2, '0')].join('-');

// Event Listeners
dateInput.addEventListener('change', loadDashboard);
timezoneInput.addEventListener('change', loadDashboard);
refreshBtn.addEventListener('click', () => window.location.reload());

const copyLinkBtn = document.querySelector('#copy-link-btn');
const showQrBtn = document.querySelector('#show-qr-btn');
const qrModal = document.querySelector('#qr-modal');
const closeQrModalBtn = document.querySelector('#close-qr-modal-btn');
const qrModalBackdrop = document.querySelector('#qr-modal-backdrop');

copyLinkBtn.addEventListener('click', async () => {
  const telegramUrl = (state.data && state.data.telegram_bot_url) || 'https://t.me/dice_apply_bot';
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(telegramUrl);
    } else {
      const input = document.createElement('input');
      input.value = telegramUrl;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
    }
    const originalText = copyLinkBtn.textContent;
    copyLinkBtn.textContent = '✓ Copied!';
    copyLinkBtn.style.background = '#d1fae5';
    setTimeout(() => {
      copyLinkBtn.textContent = originalText;
      copyLinkBtn.style.background = '';
    }, 2000);
  } catch (err) {
    console.error('Failed to copy link:', err);
  }
});

showQrBtn.addEventListener('click', () => {
  qrModal.hidden = false;
});

const closeQrModal = () => {
  qrModal.hidden = true;
};

closeQrModalBtn.addEventListener('click', closeQrModal);
qrModalBackdrop.addEventListener('click', closeQrModal);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !qrModal.hidden) {
    closeQrModal();
  }
});

navDashboardTab.addEventListener('click', () => {
  state.activeTab = 'dashboard';
  updateMasterTabUI();
});

navStatsTab.addEventListener('click', () => {
  state.activeTab = 'stats';
  updateMasterTabUI();
});

subnavDashboardBtn.addEventListener('click', () => {
  state.candidateSubTab = 'dashboard';
  updateCandidateSubTabUI();
});

subnavJobsBtn.addEventListener('click', () => {
  state.candidateSubTab = 'jobs';
  updateCandidateSubTabUI();
});

candidateSearchInput.addEventListener('input', (e) => {
  state.searchQuery = e.target.value.toLowerCase().trim();
  renderCandidateDirectory();
});

globalJobsSearchInput.addEventListener('input', (e) => {
  state.globalJobSearch = e.target.value.toLowerCase().trim();
  renderGlobalJobsTable();
});

logoutBtn.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  showLogin();
});

if (syncMappingsBtn) {
  syncMappingsBtn.addEventListener('click', async () => {
    const originalText = syncMappingsBtn.textContent;
    syncMappingsBtn.disabled = true;
    syncMappingsBtn.textContent = '⏳ Syncing...';
    statusText.textContent = 'Syncing CA-client mappings...';

    try {
      const res = await fetch('/api/sync-daily', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();

      if (res.status === 429) {
        syncMappingsBtn.textContent = '⏳ Cooldown Active';
        syncMappingsBtn.style.background = '#fef3c7';
        statusText.textContent = data.error || 'Cooldown active. Please wait before syncing again.';
        setTimeout(() => {
          syncMappingsBtn.textContent = originalText;
          syncMappingsBtn.style.background = '';
          syncMappingsBtn.disabled = false;
        }, 3500);
        return;
      }

      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Sync failed');
      }

      syncMappingsBtn.textContent = '✓ Synced!';
      syncMappingsBtn.style.background = '#d1fae5';
      const scopeLabel = data.scoped ? ` (scoped to ${data.ca_email || 'your account'})` : '';
      statusText.textContent = `Synced ${data.total_mappings || 0} mappings (${data.clients_updated || 0} updated)${scopeLabel}`;
      await loadDashboard();

      setTimeout(() => {
        syncMappingsBtn.textContent = originalText;
        syncMappingsBtn.style.background = '';
        syncMappingsBtn.disabled = false;
      }, 3000);
    } catch (err) {
      console.error('Sync failed:', err);
      syncMappingsBtn.textContent = '❌ Failed';
      syncMappingsBtn.style.background = '#fee2e2';
      statusText.textContent = `Sync error: ${err.message}`;
      setTimeout(() => {
        syncMappingsBtn.textContent = originalText;
        syncMappingsBtn.style.background = '';
        syncMappingsBtn.disabled = false;
      }, 3000);
    }
  });
}

// Step 1: Request OTP
requestOtpForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  emailError.textContent = '';
  const email = emailInput.value.trim();
  if (!email) return;

  const response = await fetch('/api/auth/request-otp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });

  const payload = await response.json();
  if (!response.ok) {
    emailError.textContent = payload.error || 'Failed to send OTP.';
    return;
  }

  state.operatorEmail = email;
  otpSentInfo.textContent = `OTP code sent to ${escapeHtml(email)}. (Valid for 5 minutes)`;
  otpError.textContent = '';
  otpInput.value = '';
  requestOtpForm.hidden = true;
  verifyOtpForm.hidden = false;
  otpInput.focus();
});

// Step 2: Verify OTP
verifyOtpForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  otpError.textContent = '';
  const otp = otpInput.value.trim();
  if (!otp) return;

  const response = await fetch('/api/auth/verify-otp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: state.operatorEmail, otp }),
  });

  const payload = await response.json();
  if (!response.ok) {
    otpError.textContent = payload.error || 'Verification failed.';
    return;
  }

  if (payload.name) state.operatorName = payload.name;
  await loadDashboard();
});

// Resend OTP
document.querySelector('#resend-otp-btn').addEventListener('click', async () => {
  otpError.textContent = '';
  if (!state.operatorEmail) return;

  const response = await fetch('/api/auth/resend-otp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: state.operatorEmail }),
  });

  const payload = await response.json();
  if (!response.ok) {
    otpError.textContent = payload.error || 'Failed to resend OTP.';
    return;
  }

  otpInput.value = '';
  otpSentInfo.textContent = `New OTP code sent to ${escapeHtml(state.operatorEmail)}. Previous code invalidated.`;
  otpInput.focus();
});

// Change Email link
document.querySelector('#change-email-btn').addEventListener('click', () => {
  requestOtpForm.hidden = false;
  verifyOtpForm.hidden = true;
  emailError.textContent = '';
  emailInput.focus();
});

async function loadDashboard() {
  const params = new URLSearchParams({ date: dateInput.value, timezone: timezoneInput.value });
  if (timezoneInput.value === 'browser') {
    params.set('timezone_name', getBrowserTimezone());
  }
  const response = await fetch(`/api/dashboard?${params}`);
  if (response.status === 401) return showLogin();
  if (!response.ok) {
    statusText.textContent = 'Dashboard data could not be loaded.';
    return;
  }
  state.data = await response.json();
  render();
  startPolling();
}

function render() {
  if (!state.data) return;
  loginPanel.hidden = true;
  statusText.textContent = `Active: ${state.data.date} (${state.data.timezone})`;

  // Update Top Header Telemetry & Operator Name
  document.querySelector('#candidates-count').textContent = state.data.total_candidates ?? state.data.users.length;
  document.querySelector('#jobs-count').textContent = state.data.total_jobs ?? 0;

  if (state.data.operator) {
    state.operatorName = state.data.operator.name || state.data.operator.email || state.operatorName;
    state.operatorRole = state.data.operator.role || 'operator';
  }
  const opTag = document.querySelector('.op-tag');
  if (opTag) {
    opTag.textContent = state.operatorRole === 'admin' ? 'ADMIN' : 'CA';
    if (state.operatorRole === 'admin') {
      opTag.style.background = '#1d4ed8';
      opTag.style.color = '#ffffff';
    } else {
      opTag.style.background = '';
      opTag.style.color = '';
    }
  }
  document.querySelector('#operator-name').textContent = state.operatorName || 'Operator';

  const devLink = document.querySelector('#dev-portal-link');
  if (devLink) {
    devLink.style.display = state.operatorRole === 'admin' ? 'inline-flex' : 'none';
  }

  updateMasterTabUI();
  renderCandidateDirectory();
  renderCandidateWorkspace();
  renderGlobalStats();
  renderCaStats();
}

function updateMasterTabUI() {
  if (state.activeTab === 'dashboard') {
    navDashboardTab.classList.add('active');
    navStatsTab.classList.remove('active');
    dashboardViewContainer.hidden = false;
    statsViewContainer.hidden = true;
  } else {
    navDashboardTab.classList.remove('active');
    navStatsTab.classList.add('active');
    dashboardViewContainer.hidden = true;
    statsViewContainer.hidden = false;
    renderGlobalStats();
    renderCaStats();
  }
}

function updateCandidateSubTabUI() {
  if (state.candidateSubTab === 'dashboard') {
    subnavDashboardBtn.classList.add('active');
    subnavJobsBtn.classList.remove('active');
    candidateDashboardTabContent.hidden = false;
    candidateJobsTabContent.hidden = true;
  } else {
    subnavDashboardBtn.classList.remove('active');
    subnavJobsBtn.classList.add('active');
    candidateDashboardTabContent.hidden = true;
    candidateJobsTabContent.hidden = false;
    renderCandidateJobsSubTab();
  }
}


function renderCandidateDirectory() {
  if (!state.data || !state.data.users) return;
  const users = state.data.users;

  const filtered = users.filter((u) => {
    if (!state.searchQuery) return true;
    const name = String(u.full_name || '').toLowerCase();
    const email = String(u.company_email || '').toLowerCase();
    const awl = String(u.applywizz_id || '').toLowerCase();
    const chat = String(u.telegram_chat_id || '').toLowerCase();
    const cid = String(u.client_id || '').toLowerCase();
    const ca = String(u.ca_name || u.career_associate_id || '').toLowerCase();
    return name.includes(state.searchQuery) || email.includes(state.searchQuery) || awl.includes(state.searchQuery) || chat.includes(state.searchQuery) || cid.includes(state.searchQuery) || ca.includes(state.searchQuery);
  });

  directoryCountBadge.textContent = `${filtered.length} / ${users.length}`;

  if (!filtered.length) {
    candidateList.innerHTML = '<p class="muted" style="padding:10px;">No candidates match search.</p>';
    return;
  }

  // Group filtered users by CA
  const groups = {};
  for (const user of filtered) {
    const caName = user.ca_name || user.career_associate_id || 'Unassigned';
    if (!groups[caName]) groups[caName] = [];
    groups[caName].push(user);
  }

  // Sort CA names alphabetically
  const sortedCaNames = Object.keys(groups).sort((a, b) => a.localeCompare(b));

  let html = '';
  for (const caName of sortedCaNames) {
    if (state.data.operator && state.data.operator.role === 'admin') {
      html += `<div class="ca-sidebar-header">${escapeHtml(caName)}</div>`;
    }
    
    html += groups[caName].map((user) => {
      const id = String(user.client_id || user.telegram_chat_id || user.id);
      const isSelected = String(state.activeCandidateId) === id;
      const name = user.full_name || user.company_email || (user.telegram_chat_id ? `User ${user.telegram_chat_id}` : `Candidate ${id.slice(0, 8)}`);
      const initials = getInitials(name);
      const awlId = formatAwlId(user.applywizz_id, user.client_id || user.telegram_chat_id || id);
      const jobsCount = user.applications ? user.applications.length : 0;
      const isLinked = Boolean(user.telegram_chat_id);
      const isLive = isLinked && Boolean(
        user.has_activity ||
        (user.session?.session_deadline && new Date(user.session.session_deadline).getTime() > Date.now())
      );
      const statusClass = !isLinked ? 'pending' : (isLive ? 'active' : 'idle');
      const statusText = !isLinked ? 'Not Linked' : (isLive ? 'Linked' : 'Idle');

      return `
      <div class="candidate-card ${isSelected ? 'active' : ''}" onclick="selectCandidate('${escapeHtml(id)}')">
        <div class="card-top">
          <div class="avatar-awl">
            <span class="avatar">${initials}</span>
            <span class="awl-pill">${escapeHtml(awlId)}</span>
          </div>
          <span class="status-badge ${statusClass}">${statusText}</span>
        </div>
        <div class="cand-name">${escapeHtml(name)}</div>
        <div class="cand-footer">
          <span class="cand-email">${escapeHtml(user.company_email || '')}</span>
          <span class="jobs-count-pill">${jobsCount} ${jobsCount === 1 ? 'Job' : 'Jobs'}</span>
        </div>
      </div>
      `;
    }).join('');
  }

  candidateList.innerHTML = html;
}

window.selectCandidate = function (candidateId) {
  state.activeCandidateId = String(candidateId);
  state.selectedJobId = null; // Auto-select most recent job
  renderCandidateDirectory();
  renderCandidateWorkspace();
};

function renderCandidateWorkspace() {
  if (!state.activeCandidateId || !state.data) {
    emptyWorkspace.hidden = false;
    candidateWorkspace.hidden = true;
    return;
  }

  const user = state.data.users.find((u) =>
    String(u.client_id || u.telegram_chat_id || u.id) === String(state.activeCandidateId) ||
    (u.client_id && String(u.client_id) === String(state.activeCandidateId)) ||
    (u.telegram_chat_id && String(u.telegram_chat_id) === String(state.activeCandidateId))
  );
  if (!user) {
    emptyWorkspace.hidden = false;
    candidateWorkspace.hidden = true;
    return;
  }

  emptyWorkspace.hidden = true;
  candidateWorkspace.hidden = false;
  updateCandidateSubTabUI();

  // Render Candidate Dashboard Sub-Tab
  const applications = user.applications || [];
  if (applications.length > 0) {
    if (!state.selectedJobId) {
      state.selectedJobId = applications[applications.length - 1].id;
    }
  }

  // Jobs Queue horizontal list
  if (!applications.length) {
    candidateJobsQueue.innerHTML = '<p class="muted">No applications recorded for this candidate on this date.</p>';
  } else {
    candidateJobsQueue.innerHTML = applications.map((app) => {
      const isSel = String(app.id) === String(state.selectedJobId);
      return `
        <div class="job-item-card ${isSel ? 'selected' : ''}" onclick="selectJob('${app.id}')">
          <div class="card-header-bar">
            <span class="badge-pill blue">${escapeHtml(app.job_name || 'Job')}</span>
            <span class="badge-pill green">${escapeHtml(app.status || 'Applied')}</span>
          </div>
          <strong>${escapeHtml(app.job_name || 'Unnamed job')}</strong>
          <small class="muted">${formatTime(app.applied_at, state.data.timezone_name)}</small>
        </div>
      `;
    }).join('');
  }

  // Selected Job Details
  const selectedJob = applications.find((app) => String(app.id) === String(state.selectedJobId)) || applications[applications.length - 1];
  if (selectedJob) {
    detailJobCompany.textContent = selectedJob.job_name ? selectedJob.job_name.split('-')[0] : 'Company';
    detailJobStatus.textContent = selectedJob.status || 'Applied';
    detailJobTitle.textContent = selectedJob.job_name || 'Unnamed Job';
    detailJobUrl.href = selectedJob.url || '#';
    detailJobUrl.textContent = selectedJob.url ? `${selectedJob.url} ↗` : 'No URL link';
  } else {
    detailJobCompany.textContent = 'Company';
    detailJobStatus.textContent = 'No Jobs';
    detailJobTitle.textContent = 'No job selected';
    detailJobUrl.href = '#';
    detailJobUrl.textContent = '—';
  }

  // Telegram Session Metrics
  const session = user.session;
  if (session) {
    sessionMetricsGrid.innerHTML = `
      <div class="metric-box">
        <strong>${formatTime(session.session_started_at, state.data.timezone_name)}</strong>
        <span>9-hr Window start</span>
      </div>
      <div class="metric-box">
        <strong>${formatTime(session.session_deadline, state.data.timezone_name)}</strong>
        <span>Window Deadline</span>
      </div>
      <div class="metric-box">
        <strong data-countdown="${escapeHtml(session.session_deadline || '')}">${remaining(session.session_deadline)}</strong>
        <span>Window Remaining</span>
      </div>
      <div class="metric-box">
        <strong>${formatTime(session.next_scan_at, state.data.timezone_name)}</strong>
        <span>Next Scan Link</span>
      </div>
    `;
    startTimers();
  } else if (!user.telegram_chat_id) {
    sessionMetricsGrid.innerHTML = `
      <div class="metric-box" style="grid-column: 1 / -1; text-align: left; padding: 12px; background: #fffbeb; border: 1px dashed #f59e0b; border-radius: 6px;">
        <span class="status-badge pending" style="display:inline-block; margin-bottom: 6px;">Pending Telegram Connection</span>
        <p class="muted" style="margin: 0; font-size: 13px; color: #78350f;">This candidate is synced with Applywizz, but hasn't linked their Telegram account yet. Once they authenticate via Telegram, the bot will begin scanning and applying for jobs.</p>
      </div>
    `;
  } else {
    sessionMetricsGrid.innerHTML = '<p class="muted">Telegram linked. No active workflow session recorded for this date.</p>';
  }
}

window.selectJob = function (jobId) {
  state.selectedJobId = jobId;
  renderCandidateWorkspace();
};

function renderCandidateJobsSubTab() {
  if (!state.activeCandidateId || !state.data) return;
  const user = state.data.users.find((u) =>
    String(u.client_id || u.telegram_chat_id || u.id) === String(state.activeCandidateId) ||
    (u.client_id && String(u.client_id) === String(state.activeCandidateId)) ||
    (u.telegram_chat_id && String(u.telegram_chat_id) === String(state.activeCandidateId))
  );
  if (!user) return;

  const summary = user.prompts_summary || { total: 0, accepted: 0, rejected: 0, skipped: 0 };
  document.querySelector('#cand-stat-total-prompts').textContent = summary.total;
  document.querySelector('#cand-stat-accepted-prompts').textContent = summary.accepted;
  document.querySelector('#cand-stat-rejected-prompts').textContent = summary.rejected;
  document.querySelector('#cand-stat-skipped-prompts').textContent = summary.skipped;

  const promptEvents = user.prompt_events || [];
  const promptsContainer = document.querySelector('#candidate-prompts-list');
  if (!promptEvents.length) {
    promptsContainer.innerHTML = '<p class="muted">No Telegram bot prompts sent for this candidate on this date.</p>';
  } else {
    promptsContainer.innerHTML = promptEvents.map((p) => {
      let badgeClass = 'badge-pill blue';
      if (p.decision === 'approved' || p.decision === 'yes') badgeClass = 'badge-pill green';
      else if (p.decision === 'rejected' || p.decision === 'no') badgeClass = 'badge-pill red';

      return `
        <div class="log" style="padding:10px 0; border-bottom:1px solid #e2e8f0;">
          <time>${formatTime(p.sent_at, state.data.timezone_name)}</time>
          <div>
            <span class="${badgeClass}">${escapeHtml(p.decision || 'waiting')}</span>
            <pre style="margin:4px 0 0; font-size:12px;">URL: ${escapeHtml(p.url || '')}\nExpires: ${formatTime(p.expires_at, state.data.timezone_name)}</pre>
          </div>
        </div>
      `;
    }).join('');
  }
}

function renderGlobalStats() {
  if (!state.data || !state.data.global_stats) return;
  const stats = state.data.global_stats;

  document.querySelector('#stats-total-candidates').textContent = stats.total_candidates ?? 0;
  document.querySelector('#stats-total-applications').textContent = stats.total_applications ?? 0;
  document.querySelector('#stats-prompts-accepted').textContent = stats.prompts?.accepted ?? 0;
  document.querySelector('#stats-prompts-rejected').textContent = stats.prompts?.rejected ?? 0;
  document.querySelector('#stats-prompts-skipped').textContent = stats.prompts?.skipped ?? 0;

  renderGlobalJobsTable();
}

function renderGlobalJobsTable() {
  if (!state.data || !state.data.global_stats) return;
  const applications = state.data.global_stats.all_applications || [];
  const tbody = document.querySelector('#master-jobs-tbody');

  const filtered = applications.filter((app) => {
    if (!state.globalJobSearch) return true;
    const client = String(app.client_name || app.client_email || '').toLowerCase();
    const title = String(app.job_name || '').toLowerCase();
    const status = String(app.status || '').toLowerCase();
    const awl = String(app.applywizz_id || '').toLowerCase();
    return client.includes(state.globalJobSearch) || title.includes(state.globalJobSearch) || status.includes(state.globalJobSearch) || awl.includes(state.globalJobSearch);
  });

  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted" style="text-align:center;">No matching applications found for this date.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map((app) => `
    <tr>
      <td><strong>${escapeHtml(app.client_name || app.client_email || `Chat ${app.telegram_chat_id}`)}</strong></td>
      <td><span class="awl-pill">${escapeHtml(formatAwlId(app.applywizz_id, app.telegram_chat_id))}</span></td>
      <td>${escapeHtml(app.job_name || 'Unnamed job')}</td>
      <td><span class="badge-pill green">${escapeHtml(app.status || 'Applied')}</span></td>
      <td>${formatTime(app.applied_at, state.data.timezone_name)}</td>
      <td><a href="${escapeHtml(app.url || '#')}" target="_blank" rel="noopener">Link ↗</a></td>
    </tr>
  `).join('');
}

function showLogin() {
  if (state.timer) clearInterval(state.timer);
  loginPanel.hidden = false;
  dashboardViewContainer.hidden = true;
  statsViewContainer.hidden = true;
  requestOtpForm.hidden = false;
  verifyOtpForm.hidden = true;
  emailError.textContent = '';
  otpError.textContent = '';
  statusText.textContent = 'Sign in with Email and OTP to view workflow activity.';
}

function startPolling() {
  if (state.timer) return;
  state.timer = setInterval(loadDashboard, 30 * 60 * 1000);
}

function startTimers() {
  if (state.countdownTimer) clearInterval(state.countdownTimer);
  state.countdownTimer = setInterval(() => {
    document.querySelectorAll('[data-countdown]').forEach((element) => {
      element.textContent = remaining(element.dataset.countdown);
    });
  }, 1000);
}

function remaining(deadline) {
  if (!deadline) return '—';
  const seconds = Math.max(0, Math.floor((new Date(deadline).getTime() - Date.now()) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(remainder).padStart(2, '0')}s`;
}

function formatTime(value, timezoneName) {
  if (!value) return '—';
  return new Date(value).toLocaleString(undefined, { timeZone: timezoneName });
}

function getBrowserTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function getInitials(name) {
  if (!name) return 'CW';
  const parts = String(name).trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function formatAwlId(value, fallback) {
  const raw = String(value || (fallback ? (String(fallback).startsWith('AWL-') ? fallback : fallback.slice(0, 8)) : '')).trim();
  if (!raw) return 'AWL';
  const cleaned = raw.replace(/^(awl[-_:\s]*)+/i, '');
  return cleaned ? `AWL-${cleaned}` : raw;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

loadDashboard();

function renderCaStats() {
  const container = document.querySelector('#ca-stats-container');
  if (!container) return;
  
  if (!state.data || !state.data.operator || state.data.operator.role !== 'admin' || !state.data.ca_stats) {
    container.innerHTML = '';
    return;
  }
  
  const stats = state.data.ca_stats;
  if (!stats.length) {
    container.innerHTML = '<p class="muted">No CA stats available.</p>';
    return;
  }
  
  let html = `
    <section class="panel-card margin-top">
      <div class="card-header-bar">
        <h3>Career Associate Directory</h3>
      </div>
      <div class="table-responsive">
        <table class="data-table">
          <thead>
            <tr>
              <th>CA Name</th>
              <th>Total Clients</th>
              <th>Active Sessions</th>
              <th>Applications Prompted</th>
            </tr>
          </thead>
          <tbody>
  `;
  
  for (const ca of stats) {
    html += `
      <tr>
        <td><strong>${escapeHtml(ca.ca_name || 'Unassigned')}</strong></td>
        <td>${ca.total_clients || 0}</td>
        <td>${ca.active_sessions || 0}</td>
        <td><span class="badge-pill blue">${ca.applied_today || 0}</span></td>
      </tr>
    `;
  }
  
  html += `
          </tbody>
        </table>
      </div>
    </section>
  `;
  
  container.innerHTML = html;
}
