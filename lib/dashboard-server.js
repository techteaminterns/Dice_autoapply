const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sgMail = require('@sendgrid/mail');

if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

const DASHBOARD_TIMEZONES = {
  browser: null,
  UTC: 'UTC',
  Pacific: 'America/Los_Angeles',
  Mountain: 'America/Denver',
  Central: 'America/Chicago',
  Eastern: 'America/New_York',
};
const SESSION_DAYS = 7;
const dashboardRoot = path.join(__dirname, '..', 'public');

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

  if (request.method === 'GET' && pathname === '/dashboard') {
    return sendFile(response, 'dashboard.html', 'text/html; charset=utf-8');
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
    return authenticate(request, response, db, () => readDashboard(requestUrl, response, db));
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
  const fromEmail = process.env.SENDER_EMAIL || process.env.FROM_EMAIL || process.env.SENDGRID_FROM_EMAIL || 'no-reply@example.com';
  if (!process.env.SENDGRID_API_KEY) {
    console.warn(`[operator-otp] SendGrid API key not configured. OTP for ${email} is: ${otp}`);
    return;
  }
  try {
    await sgMail.send({
      to: email,
      from: fromEmail,
      subject: 'Dashboard Operator Verification Code',
      text: `Your OTP verification code for the dashboard is: ${otp}\nThis code expires in 5 minutes.`,
      html: `<p>Your OTP verification code for the dashboard is: <strong>${otp}</strong></p><p>This code expires in 5 minutes.</p>`,
    });
    console.log(`[operator-otp] Verification email sent to ${email}`);
  } catch (error) {
    if (error.response && error.response.body) {
      console.error(`[operator-otp] SendGrid API Error Details:`, JSON.stringify(error.response.body, null, 2));
    }
    throw error;
  }
}

async function requestOtp(request, response, db) {
  const body = await readJson(request);
  const email = String(body.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    return sendJson(response, 400, { error: 'A valid email address is required.' });
  }

  const result = await db.query(
    `select id, email, name, role
       from dice_ca_accounts
      where lower(email) = $1 and disabled = false
      limit 1`,
    [email]
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
    [account.email.toLowerCase(), codeHash, expiresAt]
  );

  try {
    await sendOperatorOTPEmail(account.email, otp);
  } catch (error) {
    console.error(`[operator-otp] Failed to send email to ${account.email}:`, error.message);
    return sendJson(response, 500, { error: 'Failed to send OTP .' });
  }

  sendJson(response, 200, {
    ok: true,
    email: account.email,
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

  const accountResult = await db.query(
    `select id, email, name, role
       from dice_ca_accounts
      where lower(email) = $1 and disabled = false
      limit 1`,
    [email]
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

async function readDashboard(requestUrl, response, db) {
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

  const [users, sessions, audits, prompts, applications, queue, candidateCountRes, totalJobsRes] = await Promise.all([
    db.query(`
      select distinct on (ds.telegram_chat_id)
        ds.telegram_chat_id, ds.client_id, c.full_name, c.company_email, c.applywizz_id
      from dice_sessions ds
      left join clients_additional_info c on c.id = ds.client_id
      order by ds.telegram_chat_id, ds.updated_at desc nulls last`),
    db.query(`
      select telegram_chat_id, session_started_at, session_deadline, next_scan_at,
             last_decision, last_decision_at, current_prompt_url,
             current_prompt_sent_at, current_prompt_expires_at
      from dice_workflow_sessions
      where session_started_at < $2 and coalesce(session_deadline, session_started_at) >= $1`, [startAt, endAt]),
    db.query(`
      select id, telegram_chat_id, event, details, created_at
      from dice_workflow_audit_logs
      where created_at >= $1 and created_at < $2
      order by created_at asc, id asc`, [startAt, endAt]),
    db.query(`
      select id, telegram_chat_id, prompt_token, url, sent_at, expires_at,
             decision, clicked_at
      from dice_workflow_prompt_events
      where sent_at >= $1 and sent_at < $2
      order by sent_at asc, id asc`, [startAt, endAt]),
    db.query(`
      select id, client_id, telegram_chat_id, job_id, url, job_name, status, applied_at
      from dice_applied_jobs
      where applied_at >= $1 and applied_at < $2
      order by applied_at asc, id asc`, [startAt, endAt]),
    db.query(`
      select id, client_id, telegram_chat_id, job_id, url, status, available_at,
             created_at, started_at, finished_at, attempts, max_attempts, last_error
      from dice_apply_queue
      where created_at >= $1 and created_at < $2
      order by created_at asc, id asc`, [startAt, endAt]),
    db.query(`select count(*)::int as count from clients_additional_info`),
    db.query(`select count(*)::int as count from dice_applied_jobs`),
  ]);

  const totalCandidatesCount = candidateCountRes.rows[0]?.count || users.rows.length;
  const totalJobsCount = totalJobsRes.rows[0]?.count || applications.rows.length;

  const userMap = new Map(users.rows.map((user) => [String(user.telegram_chat_id), {
    ...user,
    has_activity: false,
    session: sessions.rows.find((row) => String(row.telegram_chat_id) === String(user.telegram_chat_id)) || null,
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
  }]));
  const ensureUser = (chatId) => {
    const key = String(chatId);
    if (!userMap.has(key)) userMap.set(key, {
      telegram_chat_id: chatId,
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
    });
    return userMap.get(key);
  };

  audits.rows.forEach((row) => { const user = ensureUser(row.telegram_chat_id); user.audit_logs.push(row); user.has_activity = true; });
  prompts.rows.forEach((row) => {
    const user = ensureUser(row.telegram_chat_id);
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
  applications.rows.forEach((row) => { const user = ensureUser(row.telegram_chat_id); user.applications.push(row); user.has_activity = true; });
  queue.rows.forEach((row) => { const user = ensureUser(row.telegram_chat_id); user.queue.push(row); user.has_activity = true; });

  const globalPrompts = {
    total: prompts.rows.length,
    accepted: prompts.rows.filter((p) => p.decision === 'approved' || p.decision === 'yes').length,
    rejected: prompts.rows.filter((p) => p.decision === 'rejected' || p.decision === 'no').length,
    skipped: prompts.rows.filter((p) => p.decision !== 'approved' && p.decision !== 'yes' && p.decision !== 'rejected' && p.decision !== 'no').length,
  };

  const userList = [...userMap.values()].sort((left, right) =>
    String(left.full_name || left.company_email || left.telegram_chat_id).localeCompare(
      String(right.full_name || right.company_email || right.telegram_chat_id)
    )
  );

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
        const owner = userMap.get(String(app.telegram_chat_id));
        return {
          ...app,
          client_name: owner ? owner.full_name : null,
          client_email: owner ? owner.company_email : null,
          applywizz_id: owner ? owner.applywizz_id : null,
        };
      }),
    },
    users: userList,
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
