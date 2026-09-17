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
    return name.includes(state.searchQuery) || email.includes(state.searchQuery) || awl.includes(state.searchQuery) || chat.includes(state.searchQuery) || cid.includes(state.searchQuery);
  });

  directoryCountBadge.textContent = `${filtered.length} / ${users.length}`;

  if (!filtered.length) {
    candidateList.innerHTML = '<p class="muted" style="padding:10px;">No candidates match search.</p>';
    return;
  }

  // Group filtered users by CA
  const groups = {};
  for (const user of filtered) {
    const caId = user.career_associate_id || 'Unassigned';
    if (!groups[caId]) groups[caId] = [];
    groups[caId].push(user);
  }

  // Sort CA names alphabetically
  const sortedCaNames = Object.keys(groups).sort((a, b) => a.localeCompare(b));

  let html = '';
  for (const caId of sortedCaNames) {
    if (state.data.operator && state.data.operator.role === 'admin') {
      html += `<div class="ca-sidebar-header">${escapeHtml(caId)}</div>`;
    }
    
    html += groups[caId].map((user) => {
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
      const statusText = !isLinked ? 'Not Linked' : (isLive ? (user.has_activity ? `${user.audit_logs.length + user.applications.length} events` : 'Active') : 'Idle');

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
