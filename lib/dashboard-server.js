const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { sendEmail } = require('./mailer');

const DASHBOARD_TIMEZONES = {
  browser: null,
  UTC: 'UTC',
  Pacific: 'America/Los_Angeles',
  Mountain: 'America/Denver',
  Central: 'America/Chicago',
  Eastern: 'America/New_York',
};
const SESSION_DAYS = 3650; // 10 years (indefinite until explicit logout)
const dashboardRoot = path.join(__dirname, '..', 'public');
let activeSyncPromise = null;

function createDashboardServer({ db }) {
  return http.createServer(async (request, response) => {
    try {
      await routeRequest(request, response, db);
    } catch (error) {
      console.error('[dashboard] request failed:', error.message);
      sendJson(response, 500, { error: 'Dashboard request failed.' });
    }
  });
}

async function routeRequest(request, response, db) {
  const requestUrl = new URL(request.url, 'http://localhost');
  const pathname = requestUrl.pathname;

  if (request.method === 'GET' && (pathname === '/dashboard' || pathname === '/')) {
    return sendFile(response, 'dashboard.html', 'text/html; charset=utf-8');
  }
  if (request.method === 'GET' && (pathname === '/dev' || pathname === '/developer')) {
    return sendFile(response, 'dev.html', 'text/html; charset=utf-8');
  }
  if (request.method === 'GET' && pathname === '/dev.js') {
    return sendFile(response, 'dev.js', 'application/javascript; charset=utf-8');
  }
  if (request.method === 'GET' && pathname === '/dev.css') {
    return sendFile(response, 'dev.css', 'text/css; charset=utf-8');
  }
  if (request.method === 'GET' && pathname === '/api/dev/overview') {
    return authenticateAdmin(request, response, db, (operator) => readDevOverview(requestUrl, response, db, operator));
  }
  if (request.method === 'GET' && pathname === '/api/dev/stream') {
    return authenticateAdmin(request, response, db, (operator) => handleDevStream(request, response, db, operator));
  }
  if (request.method === 'GET' && pathname === '/dashboard.js') {
    return sendFile(response, 'dashboard.js', 'application/javascript; charset=utf-8');
  }
  if (request.method === 'GET' && pathname === '/dashboard.css') {
    return sendFile(response, 'dashboard.css', 'text/css; charset=utf-8');
  }
  if (request.method === 'GET' && (pathname === '/BotDice.png' || pathname === '/botdice.png')) {
    return sendFileFromRoot(response, 'BotDice.png', 'image/png');
  }
  if (request.method === 'POST' && (pathname === '/api/auth/request-otp' || pathname === '/api/auth/resend-otp')) {
    return requestOtp(request, response, db);
  }
  if (request.method === 'POST' && (pathname === '/api/auth/verify-otp' || pathname === '/api/auth/login')) {
    return verifyOtp(request, response, db);
  }
  if (request.method === 'POST' && pathname === '/api/auth/logout') {
    return logout(request, response, db);
  }
  if (request.method === 'GET' && pathname === '/api/auth/session') {
    return authenticate(request, response, db, (operatorId, operator) => sendJson(response, 200, {
      authenticated: true,
      email: operator.email,
      name: operator.name,
      role: operator.role,
    }));
  }
  if (request.method === 'GET' && pathname === '/api/dashboard') {
    return authenticate(request, response, db, (operatorId, operator) => readDashboard(requestUrl, response, db, operatorId, operator));
  }
  if (request.method === 'POST' && pathname === '/api/sync-daily') {
    return authenticate(request, response, db, async () => {
      try {
        const { runSyncDaily } = require('../scripts/sync-daily-pipeline');
        const body = await readJson(request);
        const targetDate = body.date || undefined;

        if (!activeSyncPromise) {
          activeSyncPromise = runSyncDaily({ db, date: targetDate })
            .finally(() => {
              activeSyncPromise = null;
            });
        }

        const result = await activeSyncPromise;
        return sendJson(response, result.ok ? 200 : 500, result);
      } catch (err) {
        return sendJson(response, 500, { ok: false, error: err.message });
      }
    });
  }

  sendJson(response, 404, { error: 'Not found.' });
}

function generate6DigitOTP() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function hashOtp(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

async function sendOperatorOTPEmail(email, otp) {
  try {
    const res = await sendEmail({
      to: email,
      subject: 'Dashboard Operator Verification Code',
      text: `Your OTP verification code for the dashboard is: ${otp}\nThis code expires in 5 minutes.`,
      html: `<p>Your OTP verification code for the dashboard is: <strong>${otp}</strong></p><p>This code expires in 5 minutes.</p>`,
    });
    console.log(`[operator-otp] Verification email sent to ${email}`);
    return res;
  } catch (error) {
    console.error(`[operator-otp] Failed to send email to ${email}:`, error.message);
    throw error;
  }
}

async function requestOtp(request, response, db) {
  const body = await readJson(request);
  const email = String(body.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    return sendJson(response, 400, { error: 'A valid email address is required.' });
  }

  const alternateEmail = email.endsWith('@applywizz.ai') ? email.replace('@applywizz.ai', '@applywizz.com') : null;
  const queryArgs = [email];
  let whereClause = `lower(email) = $1`;
  
  if (alternateEmail) {
    queryArgs.push(alternateEmail);
    whereClause = `(lower(email) = $1 or lower(email) = $2)`;
  }

  const result = await db.query(
    `select id, email, name, role
       from dice_ca_accounts
      where ${whereClause} and disabled = false
      limit 1`,
    queryArgs
  );
  const account = result.rows[0];
  if (!account) {
    return sendJson(response, 404, { error: 'Operator account not found or disabled.' });
  }

  const otp = generate6DigitOTP();
  const codeHash = hashOtp(otp);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  await db.query(
    `insert into dice_ca_otps (email, code_hash, expires_at)
     values ($1, $2, $3)
     on conflict (email) do update set
       code_hash = excluded.code_hash,
       expires_at = excluded.expires_at,
       created_at = now()`,
    [email, codeHash, expiresAt]
  );

  try {
    await sendOperatorOTPEmail(email, otp);
  } catch (error) {
    console.error(`[operator-otp] Failed to send email to ${email}:`, error.message);
    return sendJson(response, 500, { error: 'Failed to send OTP.' });
  }

  sendJson(response, 200, {
    ok: true,
    email: email,
    message: 'OTP verification code sent to your email.',
  });
}

async function verifyOtp(request, response, db) {
  const body = await readJson(request);
  const email = String(body.email || '').trim().toLowerCase();
  const otp = String(body.otp || body.code || '').trim();
  if (!email || !otp) {
    return sendJson(response, 400, { error: 'Email and OTP code are required.' });
  }

  const alternateEmail = email.endsWith('@applywizz.ai') ? email.replace('@applywizz.ai', '@applywizz.com') : null;
  const queryArgs = [email];
  let whereClause = `lower(email) = $1`;
  
  if (alternateEmail) {
    queryArgs.push(alternateEmail);
    whereClause = `(lower(email) = $1 or lower(email) = $2)`;
  }

  const accountResult = await db.query(
    `select id, email, name, role
       from dice_ca_accounts
      where ${whereClause} and disabled = false
      limit 1`,
    queryArgs
  );
  const account = accountResult.rows[0];
  if (!account) {
    return sendJson(response, 401, { error: 'Invalid operator email.' });
  }

  const otpResult = await db.query(
    `select code_hash, expires_at
       from dice_ca_otps
      where lower(email) = $1
      limit 1`,
    [email]
  );
  const record = otpResult.rows[0];
  if (!record) {
    return sendJson(response, 401, { error: 'No active OTP found. Please request a new code.' });
  }

  if (new Date(record.expires_at).getTime() < Date.now()) {
    await db.query(`delete from dice_ca_otps where lower(email) = $1`, [email]);
    return sendJson(response, 401, { error: 'OTP code has expired. Please request a new code.' });
  }

  if (record.code_hash !== hashOtp(otp)) {
    return sendJson(response, 401, { error: 'Invalid OTP code.' });
  }

  await db.query(`delete from dice_ca_otps where lower(email) = $1`, [email]);

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  await db.query(
    `insert into dice_ca_sessions (token_hash, operator_id, expires_at)
     values ($1, $2, now() + ($3 * interval '1 day'))`,
    [tokenHash, account.id, SESSION_DAYS]
  );
  setCookie(response, 'dashboard_session', rawToken, SESSION_DAYS * 24 * 60 * 60);
  sendJson(response, 200, {
    authenticated: true,
    email: account.email,
    name: account.name,
    role: account.role,
  });
}

async function logout(request, response, db) {
  const token = readCookie(request, 'dashboard_session');
  if (token) {
    await db.query(
      `update dice_ca_sessions set revoked_at = now()
        where token_hash = $1 and revoked_at is null`,
      [hashToken(token)]
    );
  }
  setCookie(response, 'dashboard_session', '', 0);
  sendJson(response, 200, { authenticated: false });
}

async function authenticate(request, response, db, handler) {
  const token = readCookie(request, 'dashboard_session');
  if (!token) return sendJson(response, 401, { error: 'Authentication required.' });
  const result = await db.query(
    `select s.operator_id, a.email, a.name, a.role
       from dice_ca_sessions s
       join dice_ca_accounts a on a.id = s.operator_id
      where s.token_hash = $1
        and s.revoked_at is null
        and s.expires_at > now()
        and a.disabled = false
      limit 1`,
    [hashToken(token)]
  );
  if (!result.rows[0]) return sendJson(response, 401, { error: 'Authentication required.' });
  return handler(result.rows[0].operator_id, result.rows[0]);
}

async function authenticateAdmin(request, response, db, handler) {
  return authenticate(request, response, db, (operatorId, operator) => {
    if (operator.role !== 'admin') {
      return sendJson(response, 403, { error: 'Forbidden: Admin access required.' });
    }
    return handler(operator);
  });
}

async function readDevOverview(requestUrl, response, db, operator) {
  try {
    const [
      queueRes,
      sessionsRes,
      auditRes,
      appliedRes,
      statsRes,
      casRes,
      unknownQRes,
    ] = await Promise.all([
      db.query(`
        select q.id, q.client_id, q.telegram_chat_id, q.job_id, q.url, q.status,
               q.worker_id, q.attempts, q.max_attempts, q.last_error,
               q.available_at, q.locked_at, q.started_at, q.finished_at, q.created_at,
               c.full_name, c.company_email, c.applywizz_id
        from dice_apply_queue q
        left join clients_additional_info c on c.id = q.client_id
        order by q.created_at desc
        limit 150
      `),
      db.query(`
        select s.telegram_chat_id, s.session_started_at, s.session_deadline, s.consecutive_no_count,
               s.next_scan_at, s.last_decision, s.last_decision_at, s.current_prompt_url,
               s.current_prompt_sent_at, s.current_prompt_expires_at, s.newday_requested_at,
               c.id as client_id, c.full_name, c.company_email, c.applywizz_id,
               c.career_associate_id, ca.name as ca_name
        from dice_workflow_sessions s
        left join dice_sessions ds on ds.telegram_chat_id = s.telegram_chat_id
        left join clients_additional_info c on c.id = ds.client_id
        left join dice_ca_accounts ca on ca.id = c.career_associate_id
        order by s.session_started_at desc nulls last
      `),
      db.query(`
        select a.id, a.telegram_chat_id, a.event, a.details, a.created_at,
               c.full_name, c.company_email, c.applywizz_id
        from dice_workflow_audit_logs a
        left join dice_sessions ds on ds.telegram_chat_id = a.telegram_chat_id
        left join clients_additional_info c on c.id = ds.client_id
        order by a.created_at desc, a.id desc
        limit 200
      `),
      db.query(`
        select a.id, a.client_id, a.telegram_chat_id, a.job_id, a.url, a.job_name, a.status, a.applied_at,
               c.full_name, c.company_email, c.applywizz_id
        from dice_applied_jobs a
        left join clients_additional_info c on c.id = a.client_id
        order by a.applied_at desc, a.id desc
        limit 150
      `),
      db.query(`
        select
          (select count(*)::int from clients_additional_info) as total_candidates,
          (select count(*)::int from dice_sessions) as linked_candidates,
          (select count(*)::int from dice_workflow_sessions where session_deadline > now()) as active_sessions,
          (select count(*)::int from dice_applied_jobs where applied_at >= current_date) as applied_today,
          (select count(*)::int from dice_applied_jobs where status in ('failed', 'external_or_failed')) as total_failures,
          (select count(*)::int from dice_apply_queue where status = 'queued') as queue_queued,
          (select count(*)::int from dice_apply_queue where status = 'running') as queue_running,
          (select count(*)::int from dice_apply_queue where status = 'failed') as queue_failed
      `),
      db.query(`
        select id, email, name, role, disabled, created_at
        from dice_ca_accounts
        order by role asc, name asc
      `),
      db.query(`
        select q.id, q.client_id, q.question_text, q.question_type, q.options, q.answer, q.source, q.created_at,
               c.full_name, c.company_email
        from dice_unknown_questions q
        left join clients_additional_info c on c.id = q.client_id
        order by q.created_at desc
        limit 100
      `).catch(() => ({ rows: [] })),
    ]);

    const mem = process.memoryUsage();
    const system = {
      uptime_seconds: Math.floor(process.uptime()),
      node_version: process.version,
      platform: process.platform,
      memory: {
        rss_mb: Math.round(mem.rss / 1024 / 1024),
        heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
        heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
      },
      browser_mode: process.env.USE_BROWSERBASE === 'true' ? 'Browserbase Cloud' : 'Local Chromium (Playwright)',
      max_concurrency: Number(process.env.BROWSERBASE_MAX_CONCURRENT || 20),
    };

    sendJson(response, 200, {
      ok: true,
      operator: {
        id: operator.operator_id,
        email: operator.email,
        name: operator.name,
        role: operator.role,
      },
      stats: statsRes.rows[0] || {},
      system,
      queue: queueRes.rows || [],
      sessions: sessionsRes.rows || [],
      audit_logs: auditRes.rows || [],
      applied_jobs: appliedRes.rows || [],
      ca_accounts: casRes.rows || [],
      unknown_questions: unknownQRes?.rows || [],
    });
  } catch (err) {
    console.error('[dev-dashboard] overview failed:', err.message);
    sendJson(response, 500, { ok: false, error: err.message });
  }
}

function handleDevStream(request, response, db, operator) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });

  response.write(': connected\n\n');

  let lastAuditId = 0;
  let isClosed = false;

  db.query(`select max(id) as max_id from dice_workflow_audit_logs`).then((res) => {
    lastAuditId = Number(res.rows[0]?.max_id || 0);
  }).catch(() => {});

  const interval = setInterval(async () => {
    if (isClosed) return;
    try {
      const auditRes = await db.query(`
        select a.id, a.telegram_chat_id, a.event, a.details, a.created_at,
               c.full_name, c.company_email, c.applywizz_id
        from dice_workflow_audit_logs a
        left join dice_sessions ds on ds.telegram_chat_id = a.telegram_chat_id
        left join clients_additional_info c on c.id = ds.client_id
        where a.id > $1
        order by a.id asc
        limit 50
      `, [lastAuditId]);

      if (auditRes.rows.length > 0) {
        lastAuditId = auditRes.rows[auditRes.rows.length - 1].id;
        response.write(`event: audit_events\ndata: ${JSON.stringify(auditRes.rows)}\n\n`);
      }

      const queueSummary = await db.query(`
        select status, count(*)::int as count from dice_apply_queue group by status
      `);
      response.write(`event: queue_summary\ndata: ${JSON.stringify(queueSummary.rows)}\n\n`);

      response.write(`event: ping\ndata: ${JSON.stringify({ time: new Date().toISOString() })}\n\n`);
    } catch (err) {
      // Ignore write errors during socket disconnects
    }
  }, 2500);

  request.on('close', () => {
    isClosed = true;
    clearInterval(interval);
    response.end();
  });
}

async function readDashboard(requestUrl, response, db, operatorId, operator) {
  const date = requestUrl.searchParams.get('date');
  const timezone = requestUrl.searchParams.get('timezone') || 'browser';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return sendJson(response, 400, { error: 'date must be YYYY-MM-DD.' });
  if (!(timezone in DASHBOARD_TIMEZONES)) return sendJson(response, 400, { error: 'Unsupported timezone.' });

  const timezoneName = timezone === 'browser'
    ? requestUrl.searchParams.get('timezone_name')
    : DASHBOARD_TIMEZONES[timezone];
  if (!timezoneName || !isSupportedTimezone(timezoneName)) {
    return sendJson(response, 400, { error: 'A valid browser timezone is required.' });
  }

  const zone = timezoneName;
  const bounds = await db.query(
    `select ($1::date::timestamp at time zone $2) as start_at,
            (($1::date + interval '1 day')::timestamp at time zone $2) as end_at`,
    [date, zone]
  );
  const { start_at: startAt, end_at: endAt } = bounds.rows[0];

  const isAdmin = Boolean(operator && operator.role === 'admin');
  const hasOperatorFilter = Boolean(operatorId) && !isAdmin;

  const [users, sessions, audits, prompts, applications, queue, candidateCountRes, totalJobsRes] = await Promise.all([
    hasOperatorFilter
      ? db.query(`
          select distinct on (c.id)
            c.id as client_id, c.full_name, c.company_email, c.applywizz_id, ds.telegram_chat_id
          from clients_additional_info c
          left join dice_sessions ds on ds.client_id = c.id
          where c.career_associate_id = $1
          order by c.id, ds.updated_at desc nulls last`, [operatorId])
      : db.query(`
          select distinct on (c.id)
            c.id as client_id, c.full_name, c.company_email, c.applywizz_id, ds.telegram_chat_id
          from clients_additional_info c
          left join dice_sessions ds on ds.client_id = c.id
          order by c.id, ds.updated_at desc nulls last`),

    hasOperatorFilter
      ? db.query(`
          select s.telegram_chat_id, s.session_started_at, s.session_deadline, s.next_scan_at,
                 s.last_decision, s.last_decision_at, s.current_prompt_url,
                 s.current_prompt_sent_at, s.current_prompt_expires_at,
                 ds.client_id
          from dice_workflow_sessions s
          join dice_sessions ds on ds.telegram_chat_id = s.telegram_chat_id
          join clients_additional_info c on c.id = ds.client_id
          where s.session_started_at < $2 and coalesce(s.session_deadline, s.session_started_at) >= $1
            and c.career_associate_id = $3`, [startAt, endAt, operatorId])
      : db.query(`
          select telegram_chat_id, session_started_at, session_deadline, next_scan_at,
                 last_decision, last_decision_at, current_prompt_url,
                 current_prompt_sent_at, current_prompt_expires_at
          from dice_workflow_sessions
          where session_started_at < $2 and coalesce(session_deadline, session_started_at) >= $1`, [startAt, endAt]),

    hasOperatorFilter
      ? db.query(`
          select a.id, a.telegram_chat_id, a.event, a.details, a.created_at, ds.client_id
          from dice_workflow_audit_logs a
          join dice_sessions ds on ds.telegram_chat_id = a.telegram_chat_id
          join clients_additional_info c on c.id = ds.client_id
          where a.created_at >= $1 and a.created_at < $2
            and c.career_associate_id = $3
          order by a.created_at asc, a.id asc`, [startAt, endAt, operatorId])
      : db.query(`
          select id, telegram_chat_id, event, details, created_at
          from dice_workflow_audit_logs
          where created_at >= $1 and created_at < $2
          order by created_at asc, id asc`, [startAt, endAt]),

    hasOperatorFilter
      ? db.query(`
          select p.id, p.telegram_chat_id, p.prompt_token, p.url, p.sent_at, p.expires_at,
                 p.decision, p.clicked_at, ds.client_id
          from dice_workflow_prompt_events p
          join dice_sessions ds on ds.telegram_chat_id = p.telegram_chat_id
          join clients_additional_info c on c.id = ds.client_id
          where p.sent_at >= $1 and p.sent_at < $2
            and c.career_associate_id = $3
          order by p.sent_at asc, p.id asc`, [startAt, endAt, operatorId])
      : db.query(`
          select id, telegram_chat_id, prompt_token, url, sent_at, expires_at,
                 decision, clicked_at
          from dice_workflow_prompt_events
          where sent_at >= $1 and sent_at < $2
          order by sent_at asc, id asc`, [startAt, endAt]),

    hasOperatorFilter
      ? db.query(`
          select a.id, a.client_id, a.telegram_chat_id, a.job_id, a.url, a.job_name, a.status, a.applied_at
          from dice_applied_jobs a
          join clients_additional_info c on c.id = a.client_id
          where a.applied_at >= $1 and a.applied_at < $2
            and c.career_associate_id = $3
          order by a.applied_at asc, a.id asc`, [startAt, endAt, operatorId])
      : db.query(`
          select id, client_id, telegram_chat_id, job_id, url, job_name, status, applied_at
          from dice_applied_jobs
          where applied_at >= $1 and applied_at < $2
          order by applied_at asc, id asc`, [startAt, endAt]),

    hasOperatorFilter
      ? db.query(`
          select q.id, q.client_id, q.telegram_chat_id, q.job_id, q.url, q.status, q.available_at,
                 q.created_at, q.started_at, q.finished_at, q.attempts, q.max_attempts, q.last_error
          from dice_apply_queue q
          join clients_additional_info c on c.id = q.client_id
          where q.created_at >= $1 and q.created_at < $2
            and c.career_associate_id = $3
          order by q.created_at asc, q.id asc`, [startAt, endAt, operatorId])
      : db.query(`
          select id, client_id, telegram_chat_id, job_id, url, status, available_at,
                 created_at, started_at, finished_at, attempts, max_attempts, last_error
          from dice_apply_queue
          where created_at >= $1 and created_at < $2
          order by created_at asc, id asc`, [startAt, endAt]),

    hasOperatorFilter
      ? db.query(`select count(*)::int as count from clients_additional_info where career_associate_id = $1`, [operatorId])
      : db.query(`select count(*)::int as count from clients_additional_info`),

    hasOperatorFilter
      ? db.query(`
          select count(*)::int as count
          from dice_applied_jobs a
          join clients_additional_info c on c.id = a.client_id
          where c.career_associate_id = $1`, [operatorId])
      : db.query(`select count(*)::int as count from dice_applied_jobs`),
  ]);

  const totalCandidatesCount = candidateCountRes.rows[0]?.count || users.rows.length;
  const totalJobsCount = totalJobsRes.rows[0]?.count || applications.rows.length;

  const userByClientId = new Map();
  const userByChatId = new Map();

  for (const user of users.rows) {
    const candidateId = user.client_id ? String(user.client_id) : (user.telegram_chat_id ? String(user.telegram_chat_id) : null);
    const userObj = {
      ...user,
      id: candidateId,
      has_activity: false,
      session: sessions.rows.find((row) =>
        (user.client_id && row.client_id && String(row.client_id) === String(user.client_id)) ||
        (user.telegram_chat_id && row.telegram_chat_id && String(row.telegram_chat_id) === String(user.telegram_chat_id))
      ) || null,
      audit_logs: [],
      prompt_events: [],
      applications: [],
      queue: [],
      prompts_summary: {
        total: 0,
        accepted: 0,
        rejected: 0,
        skipped: 0,
      },
    };
    if (user.client_id) userByClientId.set(String(user.client_id), userObj);
    if (user.telegram_chat_id) userByChatId.set(String(user.telegram_chat_id), userObj);
  }

  const findOrCreateUser = (chatId, clientId) => {
    if (clientId && userByClientId.has(String(clientId))) {
      return userByClientId.get(String(clientId));
    }
    if (chatId && userByChatId.has(String(chatId))) {
      return userByChatId.get(String(chatId));
    }
    const fallbackKey = clientId ? String(clientId) : (chatId ? String(chatId) : 'unknown');
    const newUser = {
      id: fallbackKey,
      client_id: clientId || null,
      telegram_chat_id: chatId || null,
      full_name: null,
      company_email: null,
      applywizz_id: null,
      has_activity: false,
      session: null,
      audit_logs: [],
      prompt_events: [],
      applications: [],
      queue: [],
      prompts_summary: {
        total: 0,
        accepted: 0,
        rejected: 0,
        skipped: 0,
      },
    };
    if (clientId) userByClientId.set(String(clientId), newUser);
    if (chatId) userByChatId.set(String(chatId), newUser);
    return newUser;
  };

  audits.rows.forEach((row) => {
    const user = findOrCreateUser(row.telegram_chat_id, row.client_id);
    user.audit_logs.push(row);
    user.has_activity = true;
  });

  prompts.rows.forEach((row) => {
    const user = findOrCreateUser(row.telegram_chat_id, row.client_id);
    user.prompt_events.push(row);
    user.has_activity = true;
    user.prompts_summary.total += 1;
    if (row.decision === 'approved' || row.decision === 'yes') {
      user.prompts_summary.accepted += 1;
    } else if (row.decision === 'rejected' || row.decision === 'no') {
      user.prompts_summary.rejected += 1;
    } else {
      user.prompts_summary.skipped += 1;
    }
  });

  applications.rows.forEach((row) => {
    const user = findOrCreateUser(row.telegram_chat_id, row.client_id);
    user.applications.push(row);
    user.has_activity = true;
  });

  queue.rows.forEach((row) => {
    const user = findOrCreateUser(row.telegram_chat_id, row.client_id);
    user.queue.push(row);
    user.has_activity = true;
  });

  const globalPrompts = {
    total: prompts.rows.length,
    accepted: prompts.rows.filter((p) => p.decision === 'approved' || p.decision === 'yes').length,
    rejected: prompts.rows.filter((p) => p.decision === 'rejected' || p.decision === 'no').length,
    skipped: prompts.rows.filter((p) => p.decision !== 'approved' && p.decision !== 'yes' && p.decision !== 'rejected' && p.decision !== 'no').length,
  };

  function getCandidateSortRank(user) {
    const isLinked = Boolean(user.telegram_chat_id);
    const isLive = Boolean(
      user.has_activity ||
      (user.session?.session_deadline && new Date(user.session.session_deadline).getTime() > Date.now())
    );
    const statusTier = isLinked ? (isLive ? 3 : 2) : 1;
    const appCount = user.applications ? user.applications.length : 0;

    let latestTimestamp = 0;
    if (user.applications?.length) {
      for (const app of user.applications) {
        if (app.applied_at) latestTimestamp = Math.max(latestTimestamp, new Date(app.applied_at).getTime());
      }
    }
    if (user.prompt_events?.length) {
      for (const p of user.prompt_events) {
        if (p.sent_at) latestTimestamp = Math.max(latestTimestamp, new Date(p.sent_at).getTime());
        if (p.clicked_at) latestTimestamp = Math.max(latestTimestamp, new Date(p.clicked_at).getTime());
      }
    }
    if (user.audit_logs?.length) {
      for (const a of user.audit_logs) {
        if (a.created_at) latestTimestamp = Math.max(latestTimestamp, new Date(a.created_at).getTime());
      }
    }
    if (user.session?.session_started_at) {
      latestTimestamp = Math.max(latestTimestamp, new Date(user.session.session_started_at).getTime());
    }

    return { statusTier, appCount, latestTimestamp };
  }

  const uniqueUsers = Array.from(new Set([...userByClientId.values(), ...userByChatId.values()]));
  const userList = uniqueUsers.sort((left, right) => {
    const leftRank = getCandidateSortRank(left);
    const rightRank = getCandidateSortRank(right);

    // 1. Status tier: Active (3) > Idle (2) > Unlinked (1)
    if (rightRank.statusTier !== leftRank.statusTier) {
      return rightRank.statusTier - leftRank.statusTier;
    }

    // 2. Total submitted applications (descending)
    if (rightRank.appCount !== leftRank.appCount) {
      return rightRank.appCount - leftRank.appCount;
    }

    // 3. Most recent activity timestamp (descending)
    if (rightRank.latestTimestamp !== leftRank.latestTimestamp) {
      return rightRank.latestTimestamp - leftRank.latestTimestamp;
    }

    // 4. Alphabetical tie-breaker
    const leftName = String(left.full_name || left.company_email || left.applywizz_id || left.telegram_chat_id || left.client_id);
    const rightName = String(right.full_name || right.company_email || right.applywizz_id || right.telegram_chat_id || right.client_id);
    return leftName.localeCompare(rightName);
  });

  sendJson(response, 200, {
    date,
    timezone,
    timezone_name: timezoneName,
    telegram_bot_url: process.env.TELEGRAM_BOT_URL || 'https://t.me/dice_apply_bot',
    start_at: startAt,
    end_at: endAt,
    total_candidates: totalCandidatesCount,
    total_jobs: totalJobsCount,
    global_stats: {
      total_candidates: totalCandidatesCount,
      total_applications: applications.rows.length,
      total_jobs: totalJobsCount,
      prompts: globalPrompts,
      all_applications: applications.rows.map((app) => {
        const owner = findOrCreateUser(app.telegram_chat_id, app.client_id);
        return {
          ...app,
          client_name: owner ? owner.full_name : null,
          client_email: owner ? owner.company_email : null,
          applywizz_id: owner ? owner.applywizz_id : null,
        };
      }),
    },
    users: userList,
    operator: operator ? {
      id: operator.operator_id,
      email: operator.email,
      name: operator.name,
      role: operator.role,
    } : null,
  });
}

function isSupportedTimezone(timezoneName) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezoneName }).format();
    return true;
  } catch {
    return false;
  }
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) reject(new Error('Request body is too large.'));
    });
    request.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(new Error('Invalid JSON body.')); }
    });
    request.on('error', reject);
  });
}

function sendFile(response, fileName, contentType) {
  const filePath = path.join(dashboardRoot, fileName);
  if (!fs.existsSync(filePath)) return sendJson(response, 404, { error: 'Dashboard asset not found.' });
  response.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
  response.end(fs.readFileSync(filePath));
}

function sendFileFromRoot(response, fileName, contentType) {
  const filePath = path.join(__dirname, '..', fileName);
  if (!fs.existsSync(filePath)) return sendJson(response, 404, { error: 'Asset not found.' });
  response.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
  response.end(fs.readFileSync(filePath));
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function readCookie(request, name) {
  const cookies = String(request.headers.cookie || '').split(';');
  const item = cookies.find((cookie) => cookie.trim().startsWith(`${name}=`));
  return item ? decodeURIComponent(item.trim().slice(name.length + 1)) : null;
}

function setCookie(response, name, value, maxAge) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  response.setHeader('set-cookie', `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`);
}

module.exports = {
  createDashboardServer,
  DASHBOARD_TIMEZONES,
  hashOtp,
  generate6DigitOTP,
};
