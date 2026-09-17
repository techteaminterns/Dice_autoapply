
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
              <th>CA Email / ID</th>
              <th>Total Clients</th>
              <th>Active Sessions</th>
              <th>Applied Today</th>
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
