require('dotenv').config();

const crypto = require('crypto');
const { Bot } = require('node-telegram-bot-api');
const { createPool, createServiceClient } = require('./lib/azure');
const { createDashboardServer } = require('./lib/dashboard-server');
const { fillCurrentStep, isVisibleEnabled, loadApplyProfile } = require('./lib/dice-apply-questions');
const { openBrowser, closeBrowser, closeSharedBrowser, useBrowserbase, maxConcurrent } = require('./lib/browser');
const { createApplyQueue } = require('./lib/apply-queue');
const { startApplyWorkers } = require('./lib/apply-worker');
const { createWorkflowStateStore } = require('./lib/workflow-state');
const { sendEmail } = require('./lib/mailer');

const botToken = process.env.BOT_TOKEN;
const allowedChatId = process.env.CHAT_ID ? Number(process.env.CHAT_ID) : null;
const dicePassword = process.env.DICE_PASSWORD;

if (!botToken) {
  throw new Error('BOT_TOKEN must be set in the environment.');
}
if (!dicePassword) {
  throw new Error('DICE_PASSWORD must be set in the environment.');
}

const azure = createServiceClient();
const pool = createPool();
const dashboardServer = createDashboardServer({ db: pool });
const applyQueue = createApplyQueue(azure);
const workflowStateStore = createWorkflowStateStore(azure);
let applyWorkerController = null;
const loginUrl = 'https://www.dice.com/dashboard/login';
const SESSION_MS = 9 * 60 * 60 * 1000;
const LINK_CUTOFF_MS = (8 * 60 + 32) * 60 * 1000;
const DECISION_TIMEOUT_MS = 15 * 60 * 1000;
const NEXT_LINK_DELAY_MS = 28 * 60 * 1000;
const NEWDAY_LOOKBACK_MS = 24 * 60 * 60 * 1000;

if (!botToken) {
  throw new Error('BOT_TOKEN must be set in the environment.');
}

const bot = new Bot(botToken);
const userStates = new Map();

function stateFor(chatId) {
  if (!userStates.has(chatId)) {
    userStates.set(chatId, {
      conversation: null,
      workflowActive: false,
      jobRunnerActive: false,
      browser: null,
      decisionResolver: null,
      pendingQuestion: null,
      pendingJobUrl: {}, // Store URL by hash for button callbacks
      completionNotified: false,
      knownJobUrls: new Set(),
      sessionStartedAt: null,
      sessionDeadline: null,
      consecutiveNoCount: 0,
      nextScanAt: 0,
      decisionTimer: null,
      currentPromptToken: null,
      currentPromptUrl: null,
      currentPromptSentAt: null,
      currentPromptExpiresAt: null,
      newdayRequestedAt: null,
      runGeneration: 0,
      newdayInProgress: null,
    });
  }
  return userStates.get(chatId);
}

// === TELEGRAM HELPERS ===
async function sendMessage(chatId, text, options = {}) {
  try {
    await bot.api.sendMessage({ chat_id: chatId, text, ...options });
    return true;
  } catch (error) {
    console.error(`[User ${chatId}] Telegram message failed:`, error.message);
    return false;
  }
}

function sendMessageWithButtons(chatId, text, buttons) {
  return sendMessage(chatId, text, {
    reply_markup: {
      inline_keyboard: buttons
    }
  });
}

function waitForConversationReply(chatId) {
  const state = stateFor(chatId);
  return new Promise((resolve, reject) => {
    state.conversation = { resolve, reject };
  });
}

function waitForDecision(chatId, timeoutMs = DECISION_TIMEOUT_MS) {
  const state = stateFor(chatId);
  return new Promise((resolve) => {
    const finish = (result) => {
      if (state.decisionTimer) clearTimeout(state.decisionTimer);
      state.decisionTimer = null;
      state.decisionResolver = null;
      resolve(result);
    };

    state.decisionResolver = (decision) => finish({
      decision,
      clickedAt: Date.now(),
    });
    state.decisionTimer = setTimeout(() => finish({
      decision: null,
      clickedAt: Date.now(),
    }), timeoutMs);
  });
}

function randomMinutes(min, max) {
  return (min + Math.random() * (max - min)) * 60 * 1000;
}

async function waitUntil(timestamp) {
  const remaining = timestamp - Date.now();
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}

async function hydrateWorkflowState(chatId) {
  const state = stateFor(chatId);
  const row = await workflowStateStore.get(chatId);
  if (!row) return state;

  state.sessionStartedAt = row.session_started_at ? Date.parse(row.session_started_at) : null;
  state.sessionDeadline = row.session_deadline ? Date.parse(row.session_deadline) : null;
  state.consecutiveNoCount = row.consecutive_no_count || 0;
  state.nextScanAt = row.next_scan_at ? Date.parse(row.next_scan_at) : 0;
  state.currentPromptToken = row.current_prompt_token;
  state.currentPromptUrl = row.current_prompt_url;
  state.currentPromptSentAt = row.current_prompt_sent_at ? Date.parse(row.current_prompt_sent_at) : null;
  state.currentPromptExpiresAt = row.current_prompt_expires_at ? Date.parse(row.current_prompt_expires_at) : null;
  state.newdayRequestedAt = row.newday_requested_at ? Date.parse(row.newday_requested_at) : null;
  state.lastDecision = row.last_decision || null;

  if (row.last_decision === 'expired' || (state.sessionDeadline && Date.now() >= state.sessionDeadline)) {
    state.completionNotified = true;
  }

  return state;
}

async function persistWorkflowState(chatId, state, changes = {}) {
  await workflowStateStore.save(chatId, {
    session_started_at: state.sessionStartedAt ? new Date(state.sessionStartedAt).toISOString() : null,
    session_deadline: state.sessionDeadline ? new Date(state.sessionDeadline).toISOString() : null,
    consecutive_no_count: state.consecutiveNoCount,
    next_scan_at: state.nextScanAt ? new Date(state.nextScanAt).toISOString() : null,
    current_prompt_token: state.currentPromptToken,
    current_prompt_url: state.currentPromptUrl,
    current_prompt_sent_at: state.currentPromptSentAt ? new Date(state.currentPromptSentAt).toISOString() : null,
    current_prompt_expires_at: state.currentPromptExpiresAt ? new Date(state.currentPromptExpiresAt).toISOString() : null,
    newday_requested_at: state.newdayRequestedAt ? new Date(state.newdayRequestedAt).toISOString() : null,
    ...changes,
    updated_at: new Date().toISOString(),
  });
}

function audit(chatId, event, details = {}) {
  return workflowStateStore.log(chatId, event, details);
}

async function scheduleNextLink(chatId, state, nextScanAt, reason) {
  state.nextScanAt = Math.min(state.sessionDeadline, nextScanAt);
  await persistWorkflowState(chatId, state);
  await audit(chatId, 'next_link_scheduled', {
    reason,
    scheduledAt: new Date(state.nextScanAt).toISOString(),
    delayMs: Math.max(0, state.nextScanAt - Date.now()),
  });
}

// === OTP HELPERS ===
function generateOTP() {
  return crypto.randomInt(100000, 999999).toString();
}

function hashOtp(code) {
  return crypto.createHash('sha256').update(String(code).trim()).digest('hex');
}

async function saveOTP(chatId, email, otp) {
  const { error } = await azure.from('dice_telegram_otps').upsert(
    {
      telegram_chat_id: chatId,
      email,
      code_hash: hashOtp(otp),
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      created_at: new Date().toISOString(),
    },
    { onConflict: 'telegram_chat_id' }
  );
  if (error) throw new Error(`Could not save OTP: ${error.message}`);
}

async function verifyOTP(chatId, enteredCode) {
  const { data, error } = await azure
    .from('dice_telegram_otps')
    .select('code_hash, expires_at')
    .eq('telegram_chat_id', chatId)
    .maybeSingle();

  if (error) throw new Error(`Could not read OTP: ${error.message}`);
  if (!data) return { ok: false, reason: 'expired' };
  if (Date.parse(data.expires_at) <= Date.now()) {
    await deleteOTP(chatId);
    return { ok: false, reason: 'expired' };
  }
  if (data.code_hash !== hashOtp(enteredCode)) return { ok: false, reason: 'invalid' };
  return { ok: true };
}

async function deleteOTP(chatId) {
  const { error } = await azure.from('dice_telegram_otps').delete().eq('telegram_chat_id', chatId);
  if (error) console.error(`[User ${chatId}] Failed to delete OTP:`, error.message);
}

async function sendOTPEmail(email, otp, chatId = null) {
  try {
    const res = await sendEmail({
      to: email,
      subject: 'Your OTP Verification Code',
      text: `Your OTP code is: ${otp}\nThis code expires in 5 minutes.`,
      html: `<p>Your OTP code is: <strong>${otp}</strong></p><p>This code expires in 5 minutes.</p>`,
    });
    if (chatId && res.ok) await audit(chatId, 'otp_sent', { email }).catch(() => { });
    return res.ok;
  } catch (error) {
    console.error(`[OTP] Failed to send email to ${email}:`, error.message);
    return false;
  }
}

// === USER MATCHING HELPERS ===
async function findUserByEmail(companyEmail) {
  const { data, error } = await azure
    .from('clients_additional_info')
    .select('id, applywizz_id, company_email, full_name')
    .eq('company_email', companyEmail.trim())
    .maybeSingle();

  if (error) {
    console.error('Supabase client lookup failed:', error.message);
    return null;
  }

  return data;
}

async function linkTelegramChat(chatId, clientId) {
  // Check if any other telegram_chat_id was previously linked to this client
  const { data: previousLinks, error: lookupError } = await azure
    .from('dice_telegram_connection')
    .select('telegram_chat_id')
    .eq('client_id', clientId)
    .neq('telegram_chat_id', chatId);

  if (lookupError) {
    console.error(`[User ${chatId}] Could not check previous links:`, lookupError.message);
  }

  if (Array.isArray(previousLinks) && previousLinks.length > 0) {
    for (const link of previousLinks) {
      const oldChatId = link.telegram_chat_id;
      console.log(`[User ${chatId}] Client ${clientId} was previously linked to Telegram Chat ${oldChatId}. Replacing with new chat ${chatId}.`);

      if (userStates.has(oldChatId)) {
        const oldState = userStates.get(oldChatId);
        oldState.jobRunnerActive = false;
        if (oldState.browser) {
          await oldState.browser.close().catch(() => {});
        }
      }
    }

    // Delete old links and sessions for this client (except the current chatId)
    await azure
      .from('dice_telegram_connection')
      .delete()
      .eq('client_id', clientId)
      .neq('telegram_chat_id', chatId);

    await azure
      .from('dice_sessions')
      .delete()
      .eq('client_id', clientId)
      .neq('telegram_chat_id', chatId);
  }

  const { error } = await azure.from('dice_telegram_connection').upsert(
    {
      telegram_chat_id: chatId,
      client_id: clientId,
      linked_at: new Date().toISOString(),
    },
    { onConflict: 'telegram_chat_id' }
  );

  if (error) {
    throw new Error(`Failed to save telegram link: ${error.message}`);
  }
}

async function getClientIdForChat(chatId) {
  const { data, error } = await azure
    .from('dice_telegram_connection')
    .select('client_id')
    .eq('telegram_chat_id', chatId)
    .maybeSingle();

  if (error) {
    console.error(`[User ${chatId}] Failed to load telegram link:`, error.message);
    return null;
  }
  return data?.client_id || null;
}

function storageStateIsValid(storageState) {
  return Boolean(storageState) && Array.isArray(storageState.cookies) && Array.isArray(storageState.origins);
}

async function readActiveSession(chatId) {
  const { data, error } = await azure
    .from('dice_sessions')
    .select('telegram_chat_id, client_id, email, applywizz_id, storage_state')
    .eq('telegram_chat_id', chatId)
    .maybeSingle();

  if (error) {
    console.error(`[User ${chatId}] Failed to load Dice session:`, error.message);
    return null;
  }
  if (!data || !storageStateIsValid(data.storage_state)) return null;

  return {
    chatId,
    email: data.email,
    applywizz_id: data.applywizz_id,
    clientId: data.client_id,
    storageState: data.storage_state,
  };
}

async function saveSession(context, chatId, email, applywizz_id, clientId) {
  const storageState = await context.storageState();
  const resolvedClientId = clientId || await getClientIdForChat(chatId);
  if (!resolvedClientId) {
    throw new Error('Cannot save Dice session: Telegram chat is not linked to a client.');
  }

  // Clear any stale dice_sessions for this client under older chat IDs
  await azure
    .from('dice_sessions')
    .delete()
    .eq('client_id', resolvedClientId)
    .neq('telegram_chat_id', chatId);

  const { error } = await azure.from('dice_sessions').upsert(
    {
      telegram_chat_id: chatId,
      client_id: resolvedClientId,
      email,
      applywizz_id: applywizz_id || null,
      storage_state: storageState,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'telegram_chat_id' }
  );
  if (error) throw new Error(`Could not save Dice session: ${error.message}`);

  return {
    chatId,
    email,
    applywizz_id,
    clientId: resolvedClientId,
    storageState,
  };
}

async function getAllRegisteredUsers() {
  const { data, error } = await azure.from('dice_sessions').select('telegram_chat_id');
  if (error) {
    console.error('Failed to list Dice sessions:', error.message);
    return [];
  }
  return (data || []).map((row) => Number(row.telegram_chat_id));
}

// === AUTOMATION HELPERS ===
function randomDelay(minSeconds, maxSeconds) {
  const minMs = minSeconds * 1000;
  const maxMs = maxSeconds * 1000;
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

async function waitRandom(minSeconds, maxSeconds, label = null) {
  const ms = randomDelay(minSeconds, maxSeconds);
  if (label) console.log(`${label}: waiting ${ms / 1000} seconds...`);
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function typeWithHumanDelay(page, selector, value) {
  const field = page.locator(selector);
  await field.fill('');
  await field.pressSequentially(value, { delay: 90 + Math.random() * 140 });
}

// === LOGIN ===
async function runLogin(chatId, credentials, isBackgroundRefresh = false) {
  const state = stateFor(chatId);
  const handle = await openBrowser({ headless: isBackgroundRefresh || useBrowserbase });
  if (!isBackgroundRefresh) state.browser = handle.browser;
  const { context, page, sessionId } = handle;

  try {
    await audit(chatId, 'dice_login_started', { background: isBackgroundRefresh });
    if (sessionId) {
      console.log(`[User ${chatId}] Login browser session: ${sessionId}`);
      if (!isBackgroundRefresh) {
        await sendMessage(chatId, 'Opening remote browser for login...\n');
        // Replay: https://www.browserbase.com/sessions/${sessionId}`);
      }
    }

    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input[type="email"]', { timeout: 30000 });
    await typeWithHumanDelay(page, 'input[type="email"]', credentials.email);
    await waitRandom(2, 5);
    await page.click('[data-testid="sign-in-button"]');

    await page.waitForSelector('input[type="password"]', { timeout: 30000 });
    await typeWithHumanDelay(page, 'input[type="password"]', dicePassword);
    await waitRandom(2, 6);
    await page.click('[data-testid="submit-password"]');
    await waitRandom(5, 15);
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => { });
    await page.waitForTimeout(3000);

    if (page.url().includes('/login')) {
      throw new Error(`Login did not complete. Current URL: ${page.url()}`);
    }

    const savedSession = await saveSession(
      context,
      chatId,
      credentials.email,
      credentials.applywizz_id,
      credentials.clientId
    );
    console.log(`[User ${chatId}] Login completed successfully.`);
    await audit(chatId, 'dice_login_completed');
    return savedSession;
  } finally {
    await closeBrowser(handle);
    if (!isBackgroundRefresh) state.browser = null;
  }
}

async function refreshLogin(chatId) {
  console.log(`[User ${chatId}] Dice session is missing or expired. Running background auto-login...`);
  const activeSession = await readActiveSession(chatId);
  if (!activeSession || !activeSession.email) {
    throw new Error('No email found in active session to refresh.');
  }

  await runLogin(chatId, {
    email: activeSession.email,
    applywizz_id: activeSession.applywizz_id,
    clientId: activeSession.clientId,
  }, true);
  const refreshedSession = await readActiveSession(chatId);
  if (!refreshedSession) throw new Error('Background login completed without creating an active session.');

  return refreshedSession;
}

// === JOBS & APPLICATIONS ===
async function readJobUrls(clientId, applywizzId, scrapedAfter = null) {
  if (!applywizzId || !clientId) return [];

  const pool = createPool();
  const scrapedAfterIso = scrapedAfter ? new Date(scrapedAfter).toISOString() : null;

  try {
    const result = await pool.query(
      `SELECT j.id, j.url, j.title, j.company, j.applywizz_id, j.company_email, j.scraped_at
       FROM dice_scraped_jobs j
       WHERE j.applywizz_id = $1
         AND ($2::timestamptz IS NULL OR j.scraped_at >= $2::timestamptz)
         AND NOT EXISTS (
           SELECT 1 FROM dice_applied_jobs a
           WHERE a.client_id = $3 AND a.url = j.url
         )
         AND NOT EXISTS (
           SELECT 1 FROM dice_apply_queue q
           WHERE q.client_id = $3 AND q.url = j.url
         )
       ORDER BY j.scraped_at DESC`,
      [applywizzId, scrapedAfterIso, clientId]
    );

    return (result.rows || []).map((job) => ({
      id: job.id,
      url: job.url,
      title: job.title,
      company: job.company,
      applywizzId: job.applywizz_id,
      companyEmail: job.company_email,
      scrapedAt: job.scraped_at,
    }));
  } catch (error) {
    console.error('Failed to load unhandled jobs:', error.message);
    return [];
  }
}

async function saveAppliedJob(chatId, url, jobName, status) {
  const clientId = await getClientIdForChat(chatId);
  if (!clientId) {
    console.error(`[User ${chatId}] Cannot save application: no linked client.`);
    return;
  }

  const { data: job } = await azure.from('dice_scraped_jobs').select('id').eq('url', url).maybeSingle();
  const { error } = await azure.from('dice_applied_jobs').upsert(
    {
      client_id: clientId,
      telegram_chat_id: chatId,
      job_id: job?.id || null,
      url,
      job_name: jobName || 'Unknown Job',
      status,
      applied_at: new Date().toISOString(),
    },
    { onConflict: 'client_id,url' }
  );

  if (error) {
    console.error(`[User ${chatId}] Failed to save application:`, error.message);
    return;
  }
  console.log(`[User ${chatId}] Saved job decision: ${status} for ${url}`);
}

async function hasHandledJob(chatId, url) {
  const clientId = await getClientIdForChat(chatId);
  if (!clientId) return false;

  const { data, error } = await azure
    .from('dice_applied_jobs')
    .select('id')
    .eq('client_id', clientId)
    .eq('url', url)
    .maybeSingle();

  if (error) {
    console.error(`[User ${chatId}] Failed to check applications:`, error.message);
    return false;
  }
  if (data) {
    await applyQueue.clearStaleClientJobs(clientId).catch(() => { });
    return true;
  }

  const handled = await applyQueue.hasActiveOrFinishedQueueItem(clientId, url);
  if (handled) {
    await applyQueue.clearStaleClientJobs(clientId).catch(() => { });
  }
  return handled;
}

// === JOB APPLICATION FLOW ===
function sessionExpiredError() {
  const error = new Error('Dice session expired.');
  error.code = 'SESSION_EXPIRED';
  return error;
}

async function getJobName(page) {
  const jobTitle = (await page.locator('h1').first().textContent() || '').trim();
  const company = (await page.locator('[data-wa-click="djv-job-company-profile-click"]').first().textContent() || '').trim();
  return company ? `${jobTitle} (${company})` : jobTitle;
}

async function prevalidateJob(chatId, job) {
  const activeSession = await readActiveSession(chatId);
  const storageState = activeSession?.storageState || null;
  if (!storageState) {
    console.warn(`[User ${chatId}] No Dice storageState found for pre-flight check.`);
    return { ok: true, jobName: job.title || 'Unknown Job' };
  }

  let handle = null;
  try {
    handle = await openBrowser({ storageState });
    const { page } = handle;
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle').catch(() => {});

    const jobName = await getJobName(page).catch(() => job.title || 'Unknown Job');

    if (page.url().includes('/login')) {
      console.warn(`[User ${chatId}] Session expired during pre-flight check for ${job.url}`);
      return { ok: false, reason: 'session_expired', jobName };
    }

    const applyButton = page.getByTestId('apply-button');
    const applyCount = await applyButton.count().catch(() => 0);
    if (applyCount === 0) {
      return { ok: false, reason: 'no_apply_button', jobName };
    }

    const isVisible = await applyButton.first().isVisible().catch(() => false);
    if (!isVisible) {
      return { ok: false, reason: 'no_apply_button', jobName };
    }

    const popupPromise = page.context()
      .waitForEvent('page', { timeout: 4000 })
      .catch(() => null);

    await applyButton.first().click().catch(() => {});

    const applicationPage = await Promise.race([
      popupPromise,
      new Promise((resolve) => setTimeout(() => resolve(null), 4000)),
    ]) || page;

    await applicationPage.waitForLoadState('domcontentloaded').catch(() => {});

    if (!applicationPage.url().includes('dice.com')) {
      return { ok: false, reason: 'external', jobName };
    }

    return { ok: true, jobName };
  } catch (error) {
    console.warn(`[User ${chatId}] Pre-flight validation error for ${job.url}:`, error.message);
    return { ok: true, jobName: job.title || 'Unknown Job' };
  } finally {
    if (handle) {
      await closeBrowser(handle).catch(() => {});
    }
  }
}

async function applyToJobOnPage(page, jobName, url, chatId) {
  await waitRandom(5, 15, 'After opening URL');

  const applyButton = page.getByTestId('apply-button');
  const applyCount = await applyButton.count();
  if (applyCount === 0) {
    console.log(`Apply button not found; skipping URL: ${url}`);
    return false;
  }

  await applyButton.waitFor({ state: 'visible', timeout: 30000 });
  await applyButton.scrollIntoViewIfNeeded();

  const popupPromise = page.context()
    .waitForEvent('page', { timeout: 5000 })
    .catch(() => null);
  await applyButton.click();
  const applicationPage = await Promise.race([
    popupPromise,
    new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
  ]) || page;

  await applicationPage.waitForLoadState('domcontentloaded').catch(() => { });
  await applicationPage.waitForLoadState('networkidle').catch(() => { });
  await waitRandom(5, 15, 'After Apply opens application page');
  if (applicationPage.url().includes('/login')) throw sessionExpiredError();

  if (!applicationPage.url().includes('dice.com')) {
    console.warn(`[User ${chatId}] Skipped ${jobName}: Redirected to external site.`);
    await saveAppliedJob(chatId, url, jobName, 'external');
    sendMessage(chatId, 'application failed, reviewing.');
    return false;
  }

  const clientId = await getClientIdForChat(chatId);
  const applyProfile = await loadApplyProfile(azure, clientId);
  console.log('[apply-questions] loaded profile', {
    clientId: clientId || null,
    hasOffice: applyProfile.can_work_3_days_in_office ?? null,
  });

  function createTelegramQuestionPrompt(targetChatId, currentJobName) {
    return async function onPromptFallback({ question, options = [], type = 'text' }) {
      const state = stateFor(targetChatId);
      let msg = `❓ Application Question Needed\nJob: ${currentJobName}\n\nQuestion: ${question}`;
      if (options && options.length) {
        msg += '\n\nOptions:';
        options.forEach((opt, idx) => {
          msg += `\n${idx + 1}. ${opt}`;
        });
      }
      msg += `\n\n⏳ Please reply with your answer (or reply 'skip' to skip this job) within 15 minutes.`;

      await sendMessage(targetChatId, msg);

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (state.pendingQuestion === pending) {
            state.pendingQuestion = null;
          }
          sendMessage(targetChatId, "you didn't give response, job missed.");
          reject(new Error("You didn't give response, job missed."));
        }, 15 * 60 * 1000);

        const pending = {
          resolve,
          reject,
          timer,
          options,
          question,
        };

        state.pendingQuestion = pending;
      });
    };
  }

  while (true) {
    if (applicationPage.url().includes('/login')) throw sessionExpiredError();

    const nextButton = applicationPage.getByRole('button', { name: /^Next$/i });
    const submitButton = applicationPage.getByRole('button', { name: /^Submit$/i });

    try {
      await Promise.any([
        nextButton.waitFor({ state: 'visible', timeout: 10000 }),
        submitButton.waitFor({ state: 'visible', timeout: 10000 })
      ]);
    } catch (e) {
      console.warn(`[User ${chatId}] Skipped ${jobName}: Missing Next/Submit (likely an extra question we could not fill).`);
      await saveAppliedJob(chatId, url, jobName, 'external_or_failed');
      sendMessage(chatId, 'application failed, reviewing.');
      return false;
    }

    const nextVisible = await nextButton.count() > 0 && await nextButton.first().isVisible().catch(() => false);
    const submitVisible = await submitButton.count() > 0 && await submitButton.first().isVisible().catch(() => false);

    if (submitVisible && !nextVisible) {
      break;
    }

    if (nextVisible) {
      const onPromptFallback = createTelegramQuestionPrompt(chatId, jobName);
      const filled = await fillCurrentStep(applicationPage, applyProfile, {
        dbPool: pool,
        onPromptFallback,
      });
      if (!filled.ok) {
        if (filled.reason === 'SKIPPED_BY_USER' || filled.reason?.includes("didn't give response")) {
          console.log(`[User ${chatId}] Job skipped: ${filled.reason}`);
          await saveAppliedJob(chatId, url, jobName, 'skipped');
          return false;
        }
        console.warn(`[User ${chatId}] Skipped ${jobName}: ${filled.reason || 'Could not answer an application question.'}`);
        await saveAppliedJob(chatId, url, jobName, 'external_or_failed');
        sendMessage(chatId, 'application failed, reviewing.');
        return false;
      }

      if (!await isVisibleEnabled(nextButton)) {
        console.warn(`[User ${chatId}] Skipped ${jobName}: Next stayed disabled after filling questions.`);
        await saveAppliedJob(chatId, url, jobName, 'external_or_failed');
        sendMessage(chatId, 'application failed, reviewing.');
        return false;
      }

      await nextButton.first().scrollIntoViewIfNeeded();
      await nextButton.first().click();
      await applicationPage.waitForLoadState('networkidle').catch(() => { });
      await waitRandom(10, 20, 'After Next opens new page');
      continue;
    }

    break;
  }

  if (applicationPage.url().includes('/login')) throw sessionExpiredError();

  const submitButton = applicationPage.getByRole('button', { name: /^Submit$/i });
  if (await isVisibleEnabled(submitButton)) {
    await submitButton.first().scrollIntoViewIfNeeded();
    await submitButton.first().click();
    await applicationPage.waitForLoadState('networkidle').catch(() => { });
    await waitRandom(1, 4, 'After Submit opens next page');

    await saveAppliedJob(chatId, url, jobName, 'completed');
    sendMessage(chatId, `✅ Application submitted successfully for:\n${jobName}`);
    return true;
  }

  console.warn(`[User ${chatId}] Skipped ${jobName}: Could not complete application.`);
  await saveAppliedJob(chatId, url, jobName, 'failed');
  sendMessage(chatId, 'application failed, reviewing.');
  return false;
}

// Runs one queued apply on Browserbase/local. Throws on hard failure.
async function executeQueuedApply(job) {
  const chatId = Number(job.telegram_chat_id);
  const url = job.url;

  await sendMessage(chatId, 'applying to the job');

  let activeSession = await readActiveSession(chatId);
  if (!activeSession) {
    activeSession = await refreshLogin(chatId);
  }

  let handle = await openBrowser({
    storageState: activeSession.storageState,
    headless: useBrowserbase,
  });
  if (handle.sessionId) {
    console.log(`[User ${chatId}] Apply browser session: ${handle.sessionId}`);
  }

  try {
    let retryAfterLogin = true;
    while (retryAfterLogin) {
      retryAfterLogin = false;
      const page = await handle.context.newPage();
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(3000);

        if (page.url().includes('/login')) {
          activeSession = await refreshLogin(chatId);
          await closeBrowser(handle);
          handle = await openBrowser({
            storageState: activeSession.storageState,
            headless: useBrowserbase,
          });
          retryAfterLogin = true;
          continue;
        }

        const jobName = await getJobName(page);
        await applyToJobOnPage(page, jobName, url, chatId);
      } catch (error) {
        if (error.code === 'SESSION_EXPIRED') {
          activeSession = await refreshLogin(chatId);
          await closeBrowser(handle);
          handle = await openBrowser({
            storageState: activeSession.storageState,
            headless: useBrowserbase,
          });
          retryAfterLogin = true;
        } else {
          console.error(`[User ${chatId}] Failed to apply to ${url}:`, error.message);
          await saveAppliedJob(chatId, url, 'Failed', 'failed');
          sendMessage(chatId, 'application failed, reviewing.');
          throw error;
        }
      } finally {
        if (page && !page.isClosed()) await page.close().catch(() => { });
      }
    }
  } finally {
    await closeBrowser(handle);
  }
}

// Background loop for an individual user: prompt Yes/No, enqueue on Yes.
async function runJobsLoop(chatId) {
  const state = stateFor(chatId);
  try {
    await hydrateWorkflowState(chatId);
  } catch (error) {
    console.error(`[User ${chatId}] Could not restore workflow state:`, error.message);
  }
  const runGeneration = state.runGeneration;
  state.jobRunnerActive = true;
  console.log(`[User ${chatId}] Job loop started.`);

  while (state.jobRunnerActive && state.runGeneration === runGeneration) {
    if (state.nextScanAt > Date.now()) {
      await waitUntil(state.nextScanAt);
      continue;
    }

    if (state.sessionDeadline && Date.now() >= state.sessionDeadline) {
      if (!state.completionNotified && state.lastDecision !== 'expired') {
        state.completionNotified = true;
        await sendMessage(chatId, 'The 9-hour job application window has ended.');
      }
      state.lastDecision = 'expired';
      await persistWorkflowState(chatId, state, {
        last_decision: 'expired',
        last_decision_at: new Date().toISOString(),
      });
      state.jobRunnerActive = false;
      break;
    }

    if (state.currentPromptToken && state.currentPromptExpiresAt <= Date.now()) {
      const missedUrl = state.currentPromptUrl;
      const missedAt = state.currentPromptExpiresAt;
      await workflowStateStore.recordDecision(chatId, state.currentPromptToken, 'missed', missedAt).catch(() => { });
      state.currentPromptToken = null;
      state.currentPromptUrl = null;
      state.currentPromptSentAt = null;
      state.currentPromptExpiresAt = null;
      state.nextScanAt = Math.min(state.sessionDeadline, missedAt + randomMinutes(30, 40));
      await persistWorkflowState(chatId, state, {
        last_decision: 'missed',
        last_decision_at: new Date(missedAt).toISOString(),
      });
      await saveAppliedJob(chatId, missedUrl, 'Job missed', 'missed');
      await sendMessage(chatId, 'Job missed');
      continue;
    }

    const clientId = await getClientIdForChat(chatId);
    const applyProfile = clientId ? await loadApplyProfile(azure, clientId) : {};

    const scrapedAfter = state.newdayRequestedAt
      ? state.newdayRequestedAt - NEWDAY_LOOKBACK_MS
      : null;
    const jobs = await readJobUrls(clientId, applyProfile.applywizz_id, scrapedAfter);
    const urls = jobs.map((job) => job.url);
    const hasNewUrl = urls.some((url) => !state.knownJobUrls.has(url));
    state.knownJobUrls = new Set(urls);

    if (state.completionNotified && !hasNewUrl) {
      await new Promise((r) => setTimeout(r, 10000));
      continue;
    }

    if (hasNewUrl) {
      state.completionNotified = false;
      console.log(`[User ${chatId}] New job URL detected; resuming scanner.`);
    }

    let offeredAny = false;
    let unhandledUrlFound = false;

    console.log(`[User ${chatId}] Processing ${jobs.length} unhandled jobs. Profile AWL ID: '${applyProfile.applywizz_id}'`);
    for (const job of jobs) {
      const { url } = job;
      if (!state.jobRunnerActive || state.runGeneration !== runGeneration) {
        console.log(`[User ${chatId}] Job runner stopped.`);
        break;
      }

      if (await hasHandledJob(chatId, url)) {
        console.log(`[User ${chatId}] Skipping ${url}: Already handled (in applications or queue).`);
        continue;
      }

      if (state.workflowActive) {
        console.log(`[User ${chatId}] Workflow active, waiting 5s...`);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }

      if (!clientId) {
        await sendMessage(chatId, 'Cannot queue apply: Telegram is not linked to a client.');
        continue;
      }

      const linkCutoff = state.sessionStartedAt && state.sessionStartedAt + LINK_CUTOFF_MS;
      const promptStillOpen = state.currentPromptToken && state.currentPromptExpiresAt > Date.now();
      if (linkCutoff && Date.now() >= linkCutoff && !promptStillOpen) {
        if (!state.completionNotified && state.lastDecision !== 'expired') {
          state.completionNotified = true;
          await sendMessage(chatId, 'The 9-hour job application window has ended.');
        }
        state.lastDecision = 'expired';
        await persistWorkflowState(chatId, state, { last_decision: 'expired', last_decision_at: new Date().toISOString() });
        state.jobRunnerActive = false;
        break;
      }

      if (String(job.applywizzId || '') !== String(applyProfile.applywizz_id || '')) {
        console.log(`[User ${chatId}] Skipping ${url}: applywizz_id mismatch. Job: '${job.applywizzId}', Profile: '${applyProfile.applywizz_id}'`);
        continue;
      }

      const isResumingPrompt = state.currentPromptToken && state.currentPromptUrl === url;

      // Pre-flight check: Verify Apply button & internal Dice application before sending prompt
      if (!isResumingPrompt) {
        console.log(`[User ${chatId}] Running pre-flight check on ${url}...`);
        const precheck = await prevalidateJob(chatId, job);
        if (!precheck.ok) {
          console.log(`[User ${chatId}] Pre-flight check failed for ${url}: ${precheck.reason}. Skipping silently.`);
          await saveAppliedJob(chatId, url, precheck.jobName || job.title || 'Unknown Job', precheck.reason);
          continue;
        }
      }

      if (!state.sessionStartedAt) {
        state.sessionStartedAt = Date.now();
        state.sessionDeadline = state.sessionStartedAt + SESSION_MS;
        state.consecutiveNoCount = 0;
        await persistWorkflowState(chatId, state);
        await audit(chatId, 'session_started', {
          startedAt: new Date(state.sessionStartedAt).toISOString(),
          deadlineAt: new Date(state.sessionDeadline).toISOString(),
          linkCutoffAt: new Date(state.sessionStartedAt + LINK_CUTOFF_MS).toISOString(),
        });
      }

      unhandledUrlFound = true;

      console.log(`[User ${chatId}] ${isResumingPrompt ? 'Resuming' : 'Prompting for'} job: ${url}`);
      offeredAny = true;
      const promptToken = isResumingPrompt ? state.currentPromptToken : crypto.randomUUID();
      state.pendingJobUrl[promptToken] = url;
      const promptSentAt = isResumingPrompt ? state.currentPromptSentAt : Date.now();
      const promptExpiresAt = isResumingPrompt
        ? state.currentPromptExpiresAt
        : Math.min(state.sessionDeadline, promptSentAt + DECISION_TIMEOUT_MS);
      if (!isResumingPrompt) {
        state.currentPromptToken = promptToken;
        state.currentPromptUrl = url;
        state.currentPromptSentAt = promptSentAt;
        state.currentPromptExpiresAt = promptExpiresAt;
        await workflowStateStore.recordPrompt(chatId, {
          token: promptToken,
          url,
          sentAt: promptSentAt,
          expiresAt: promptExpiresAt,
        });
        await persistWorkflowState(chatId, state);
        await audit(chatId, 'job_prompt_sent', { url, expiresAt: promptExpiresAt });
        await audit(chatId, 'prompt_timer_started', {
          url,
          startedAt: new Date(promptSentAt).toISOString(),
          expiresAt: new Date(promptExpiresAt).toISOString(),
          durationMs: promptExpiresAt - promptSentAt,
        });
      }

      let promptText = 'New Job Found:\n';
      if (job.title) promptText += `Title: ${job.title}\n`;
      if (job.company) promptText += `Company: ${job.company}\n`;
      promptText += `Link: ${url}\n\nDo you want to apply?`;

      await sendMessageWithButtons(chatId, promptText, [
        [{ text: '✅ Yes', callback_data: `job_yes_${promptToken}` }],
        [{ text: '❌ No', callback_data: `job_no_${promptToken}` }],
      ]);

      const decisionWaitMs = Math.min(
        DECISION_TIMEOUT_MS,
        Math.max(0, state.sessionDeadline - promptSentAt)
      );
      const response = await waitForDecision(chatId, decisionWaitMs);
      if (state.runGeneration !== runGeneration) break;
      const clickAt = response.clickedAt || Date.now();
      await audit(chatId, response.decision === null ? 'job_missed' : response.decision ? 'job_yes' : 'job_no', {
        url,
        clickedAt: new Date(clickAt).toISOString(),
      });
      await persistWorkflowState(chatId, state, {
        current_prompt_token: null,
        current_prompt_url: null,
        current_prompt_sent_at: null,
        current_prompt_expires_at: null,
        last_decision: response.decision === null ? 'missed' : response.decision ? 'yes' : 'no',
        last_decision_at: new Date(clickAt).toISOString(),
      });
      state.currentPromptToken = null;
      state.currentPromptUrl = null;
      state.currentPromptSentAt = null;
      state.currentPromptExpiresAt = null;

      if (response.decision === null) {
        await saveAppliedJob(chatId, url, 'Job missed', 'missed');
        await sendMessage(chatId, 'Job missed');
        state.nextScanAt = Math.min(state.sessionDeadline, promptSentAt + DECISION_TIMEOUT_MS + NEXT_LINK_DELAY_MS);
        await persistWorkflowState(chatId, state);
        await audit(chatId, 'next_link_scheduled', {
          reason: 'job_missed',
          scheduledAt: new Date(state.nextScanAt).toISOString(),
          delayMs: state.nextScanAt - Date.now(),
        });
        break;
      }

      if (!response.decision) {
        await saveAppliedJob(chatId, url, 'Skipped by user', 'rejected');
        await sendMessage(chatId, 'response noted-no');
        state.consecutiveNoCount += 1;
        if (state.consecutiveNoCount >= 3) {
          state.consecutiveNoCount = 0;
          state.nextScanAt = Math.min(state.sessionDeadline, clickAt + NEXT_LINK_DELAY_MS);
        } else {
          state.nextScanAt = clickAt;
        }
        await persistWorkflowState(chatId, state);
        await audit(chatId, 'next_link_scheduled', {
          reason: state.consecutiveNoCount === 0 ? 'third_no' : 'no_response',
          scheduledAt: new Date(state.nextScanAt).toISOString(),
          delayMs: Math.max(0, state.nextScanAt - Date.now()),
        });
        break;
      }

      state.consecutiveNoCount = 0;
      await sendMessage(chatId, 'response noted-yes');

      const availableAt = Date.now() + randomMinutes(15, 20);
      console.log(`[User ${chatId}] Yes accepted; automation available at ${new Date(availableAt).toISOString()}`);
      await audit(chatId, 'automation_delay_started', {
        url,
        startedAt: new Date().toISOString(),
        availableAt: new Date(availableAt).toISOString(),
        delayMs: availableAt - Date.now(),
      });

      const { data: jobRow } = await azure.from('dice_scraped_jobs').select('id').eq('url', url).maybeSingle();

      try {
        const { row, created, alreadyDone, activeClientJob } = await applyQueue.enqueueApplyJob({
          clientId,
          telegramChatId: chatId,
          url,
          jobId: jobRow?.id || null,
          availableAt: new Date(availableAt).toISOString(),
        });
        await audit(chatId, 'job_queued', { url, queueId: row?.id || null, availableAt });

        if (activeClientJob) {
          await sendMessage(chatId, 'An application for this client is already running. I’ll offer the next job once it finishes.');
          state.nextScanAt = Math.min(state.sessionDeadline, clickAt + NEXT_LINK_DELAY_MS);
          await persistWorkflowState(chatId, state);
          await audit(chatId, 'next_link_scheduled', {
            reason: 'yes',
            scheduledAt: new Date(state.nextScanAt).toISOString(),
            delayMs: Math.max(0, state.nextScanAt - Date.now()),
          });
          break;
        }

        if (alreadyDone) {
          await sendMessage(chatId, 'This job was already completed earlier. Skipping.');
          state.nextScanAt = Math.min(state.sessionDeadline, clickAt + NEXT_LINK_DELAY_MS);
          await persistWorkflowState(chatId, state);
          await audit(chatId, 'next_link_scheduled', {
            reason: 'yes',
            scheduledAt: new Date(state.nextScanAt).toISOString(),
            delayMs: Math.max(0, state.nextScanAt - Date.now()),
          });
          break;
        }

        state.nextScanAt = Math.min(state.sessionDeadline, clickAt + NEXT_LINK_DELAY_MS);
        await audit(chatId, 'next_link_scheduled', {
          reason: created ? 'yes' : 'yes_existing_queue',
          scheduledAt: new Date(state.nextScanAt).toISOString(),
          delayMs: Math.max(0, state.nextScanAt - Date.now()),
        });
        break;
      } catch (error) {
        console.error(`[User ${chatId}] Enqueue failed:`, error.message);
        await sendMessage(chatId, `Could not queue apply: ${error.message}`);
      }
    }

    const activeClientJob = clientId
      ? await applyQueue.hasActiveClientJob(clientId)
      : false;
    const allRecentJobsHandled = urls.length > 0 && !unhandledUrlFound && !activeClientJob;
    if (
      allRecentJobsHandled &&
      !state.completionNotified &&
      state.jobRunnerActive &&
      state.runGeneration === runGeneration
    ) {
      const details = {
        jobCount: urls.length,
        checkedAt: new Date().toISOString(),
      };
      await audit(chatId, 'all_jobs_completed', details);
      const sent = await sendMessage(
        chatId,
        'All jobs from the CSV have been completed. I will wait for new job links.'
      );
      if (sent) state.completionNotified = true;
    }

    if (!offeredAny && state.jobRunnerActive) {
      await new Promise((r) => setTimeout(r, 10000));
    }
  }

  console.log(`[User ${chatId}] Job runner stopped.`);
}

// === TELEGRAM COMMAND HANDLER ===
async function runSignInWorkflow(chatId, { greet = false } = {}) {
  const state = stateFor(chatId);
  if (state.workflowActive) {
    await sendMessage(chatId, 'An operation is already running. Complete it or use /cancel first.');
    return;
  }

  state.workflowActive = true;
  try {
    if (greet) {
      await sendMessage(chatId, 'Welcome');
    }

    let email;
    while (true) {
      await sendMessage(chatId, 'Enter email id');
      email = await waitForConversationReply(chatId);
      if (email === '/cancel') throw new Error('Cancelled by user.');

      const otp = generateOTP();
      await saveOTP(chatId, email, otp);
      await sendOTPEmail(email, otp, chatId);
      await sendMessage(chatId, 'An OTP has been sent to your email. Please enter it below (expires in 5 minutes).');

      let otpVerified = false;
      while (true) {
        const enteredOTP = await waitForConversationReply(chatId);
        if (enteredOTP === '/cancel') throw new Error('Cancelled by user.');

        const otpResult = await verifyOTP(chatId, enteredOTP);
        if (otpResult.ok) {
          otpVerified = true;
          break;
        }

        if (otpResult.reason === 'expired') {
          await sendMessage(chatId, 'OTP expired. Please enter your email again.');
          break;
        }

        await sendMessage(chatId, 'Invalid OTP. Please enter the OTP again.');
      }

      if (otpVerified) break;
    }

    await deleteOTP(chatId);
    await sendMessage(chatId, 'Email verified!\nYour application process will start shortly.');

    const user = await findUserByEmail(email);
    if (!user) {
      throw new Error('Email not found in our database. Please check and try again.');
    }

    await linkTelegramChat(chatId, user.id);


    await runLogin(chatId, { email, applywizz_id: user.applywizz_id, clientId: user.id });
    await sendMessage(chatId, 'Dice login successful.');

    state.workflowActive = false;
    if (!state.jobRunnerActive) {
      state.jobRunnerActive = true;
      runJobsLoop(chatId).catch(console.error);
    }
  } catch (e) {
    await sendMessage(chatId, `Operation failed: ${e.message}`);
    state.workflowActive = false;
  }
}

async function startNewday(chatId) {
  const state = stateFor(chatId);
  if (state.newdayInProgress) return state.newdayInProgress;

  state.newdayInProgress = (async () => {
    await hydrateWorkflowState(chatId);
    if (Number.isFinite(state.sessionDeadline) && state.sessionDeadline > Date.now()) {
      await sendMessage(chatId, 'Your 9-hour job session is still active. Try /newday after it ends.');
      return;
    }

    const activeSession = await readActiveSession(chatId);
    if (!activeSession) {
      await sendMessage(chatId, 'Please sign in first with /start.');
      return;
    }

    state.jobRunnerActive = false;
    state.runGeneration += 1;
    if (state.decisionTimer) clearTimeout(state.decisionTimer);
    if (state.decisionResolver) state.decisionResolver(false);
    state.decisionTimer = null;
    state.decisionResolver = null;
    state.currentPromptToken = null;
    state.currentPromptUrl = null;
    state.currentPromptSentAt = null;
    state.currentPromptExpiresAt = null;
    state.sessionStartedAt = null;
    state.sessionDeadline = null;
    state.nextScanAt = 0;
    state.consecutiveNoCount = 0;
    state.completionNotified = false;
    state.knownJobUrls = new Set();
    state.pendingJobUrl = {};
    state.newdayRequestedAt = Date.now();

    await persistWorkflowState(chatId, state, {
      session_started_at: null,
      session_deadline: null,
      next_scan_at: null,
      consecutive_no_count: 0,
      current_prompt_token: null,
      current_prompt_url: null,
      current_prompt_sent_at: null,
      current_prompt_expires_at: null,
      last_decision: null,
      last_decision_at: null,
    });
    await audit(chatId, 'newday_started', {
      requestedAt: new Date(state.newdayRequestedAt).toISOString(),
      jobsSince: new Date(state.newdayRequestedAt - NEWDAY_LOOKBACK_MS).toISOString(),
    });

    state.jobRunnerActive = true;
    runJobsLoop(chatId).catch((error) => {
      console.error(`[User ${chatId}] New-day job loop failed:`, error.message);
    });
    await sendMessage(chatId, 'New day started. I will send the first eligible job scraped within the last 24 hours.');
  })().finally(() => {
    state.newdayInProgress = null;
  });

  return state.newdayInProgress;
}

async function handleCommand(chatId, text) {
  const state = stateFor(chatId);
  const normalized = text.toLowerCase().replace(/^[/#]+/, '').trim();

  if (['continue', 'yes', 'y'].includes(normalized) && state.decisionResolver) {
    const resolver = state.decisionResolver;
    resolver(true);
    return;
  }
  if (['stop', 'no', 'n'].includes(normalized) && state.decisionResolver) {
    const resolver = state.decisionResolver;
    resolver(false);
    return;
  }

  if (normalized === 'cancel') {
    if (state.conversation) {
      const conversation = state.conversation;
      state.conversation = null;
      conversation.resolve('/cancel');
      await sendMessage(chatId, 'Cancelled.');
    }
    return;
  }

  if (state.conversation) {
    const conversation = state.conversation;
    state.conversation = null;
    conversation.resolve(text.trim());
    return;
  }

  if (state.workflowActive) {
    await sendMessage(chatId, 'An operation is already running. Complete it or use /cancel first.');
    return;
  }

  if (normalized === 'newday') {
    await startNewday(chatId);
    return;
  }

  // First link /start: welcome + ask for email (no Sign In / Sign Up buttons)
  if (
    normalized === 'start' ||
    ['sign in', 'signin', 'login', 'log in'].includes(normalized)
  ) {
    await runSignInWorkflow(chatId, { greet: normalized === 'start' });
    return;
  }

  // Ignore any other random text when not in an active conversation
  return;
}

bot.on('message', (ctx) => {
  const chatId = ctx.message?.chat.id;
  if (!chatId || (allowedChatId && chatId !== allowedChatId) || typeof ctx.message.text !== 'string') return;

  const text = ctx.message.text.trim();
  const state = stateFor(chatId);

  // Check if candidate is responding to an application question prompt
  if (state.pendingQuestion) {
    const pending = state.pendingQuestion;
    if (/^(\/)?skip$/i.test(text)) {
      clearTimeout(pending.timer);
      state.pendingQuestion = null;
      sendMessage(chatId, 'Application skipped as requested.');
      pending.reject(new Error('SKIPPED_BY_USER'));
      return;
    }

    let selectedAnswer = text;
    if (pending.options && pending.options.length) {
      const num = parseInt(text, 10);
      if (!Number.isNaN(num) && num >= 1 && num <= pending.options.length) {
        selectedAnswer = pending.options[num - 1];
      } else {
        const lowerText = text.toLowerCase();
        const matched = pending.options.find((opt) => opt.toLowerCase() === lowerText)
          || pending.options.find((opt) => opt.toLowerCase().includes(lowerText));
        if (matched) selectedAnswer = matched;
      }
    }

    clearTimeout(pending.timer);
    state.pendingQuestion = null;
    sendMessage(chatId, 'response noted-question answered.');
    pending.resolve(selectedAnswer);
    return;
  }

  handleCommand(chatId, ctx.message.text).catch(async (error) => {
    stateFor(chatId).conversation = null;
    console.error(`Command failed: ${error.message}`);
    await sendMessage(chatId, `Operation failed: ${error.message}`);
  });
});

bot.on('callback_query', async (ctx) => {
  const chatId = ctx.from?.id;
  const data = ctx.callbackQuery?.data;
  const message = ctx.callbackQuery?.message;

  if (!chatId || !data) {
    console.warn('Received callback_query without chatId or data:', { chatId, data, ctx });
    return;
  }

  try {
    await ctx.answerCallbackQuery().catch(() => { });
    if (message) {
      await bot.api.editMessageReplyMarkup({
        chat_id: message.chat?.id || chatId,
        message_id: message.message_id,
        reply_markup: { inline_keyboard: [] },
      }).catch(() => { });
    }
  } catch (error) {
    console.warn('[callback] failed to clear button markup:', error.message);
  }

  // Handle job yes/no buttons
  if (data.startsWith('job_yes_')) {
    const state = stateFor(chatId);
    const token = data.slice('job_yes_'.length);
    if (state.currentPromptToken !== token || Date.now() >= state.currentPromptExpiresAt) return;
    await workflowStateStore.recordDecision(chatId, token, 'yes', Date.now()).catch((error) => {
      console.error(`[User ${chatId}] Failed to record Yes decision:`, error.message);
    });
    const resolver = state.decisionResolver;
    if (resolver) {
      resolver(true);
    }
    return;
  }

  if (data.startsWith('job_no_')) {
    const state = stateFor(chatId);
    const token = data.slice('job_no_'.length);
    if (state.currentPromptToken !== token || Date.now() >= state.currentPromptExpiresAt) return;
    await workflowStateStore.recordDecision(chatId, token, 'no', Date.now()).catch((error) => {
      console.error(`[User ${chatId}] Failed to record No decision:`, error.message);
    });
    const resolver = state.decisionResolver;
    if (resolver) {
      resolver(false);
    }
    return;
  }
});

// === BOOTSTRAP ===
(async () => {
  const dashboardPort = Number(process.env.PORT || 3000);
  dashboardServer.listen(dashboardPort, '0.0.0.0', () => {
    console.log(`[Init] Dashboard listening on port ${dashboardPort} at /dashboard`);
  });

  console.log('[Init] Testing bot token...');
  try {
    await bot.api.getMe();
    console.log('[Init] Bot token verified.');
  } catch (e) {
    console.error('[Init] Bot token test failed:', e.message);
    throw e;
  }

  console.log('[Init] Starting Telegram polling...');
  bot.startPolling();
  console.log('Main Telegram controller is running.');
  console.log(`[Init] Browser provider: ${useBrowserbase ? `browserbase (max ${maxConcurrent} concurrent)` : 'local'}`);

  applyWorkerController = startApplyWorkers({
    queue: applyQueue,
    executeJob: executeQueuedApply,
    audit,
    concurrency: maxConcurrent,
    pollMs: 2000,
  });
  console.log(`[Init] Apply queue workers: ${maxConcurrent}`);

  const users = await getAllRegisteredUsers();
  console.log(`[Startup] Found ${users.length} registered user(s).`);
  for (const chatId of users) {
    const activeSession = await readActiveSession(chatId);
    if (activeSession) {
      const workflowRow = await workflowStateStore.get(chatId).catch(() => null);
      const deadline = workflowRow?.session_deadline ? Date.parse(workflowRow.session_deadline) : null;
      const isExpired = workflowRow?.last_decision === 'expired' || (deadline && Date.now() >= deadline);

      if (isExpired) {
        console.log(`[Startup] User ${chatId} 9-hour session has already ended. Waiting for /newday.`);
        continue;
      }

      console.log(`[Startup] Auto-starting background job scanner for user ${chatId}`);
      const state = stateFor(chatId);
      state.jobRunnerActive = true;
      runJobsLoop(chatId).catch(console.error);
    }
  }
})().catch((error) => {
  console.error(`Could not start controller: ${error.message}`);
  process.exit(1);
});

async function shutdown() {
  if (applyWorkerController) applyWorkerController.stop();
  for (const state of userStates.values()) {
    if (state.pendingQuestion) {
      clearTimeout(state.pendingQuestion.timer);
      state.pendingQuestion.reject(new Error('Controller stopped.'));
      state.pendingQuestion = null;
    }
    if (state.conversation) state.conversation.reject(new Error('Controller stopped.'));
    if (state.decisionResolver) state.decisionResolver(false);
    if (state.browser) await state.browser.close().catch(() => { });
    state.jobRunnerActive = false;
  }
  if (bot.isRunning()) await bot.stopPolling().catch(() => { });
  await closeSharedBrowser().catch(() => { });
  await new Promise((resolve) => dashboardServer.close(resolve));
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);


// npm run import-clients -- /full/path/to/new-clients.json --if i store a json file and want to push to azure
//CLIENTS_API_URL=https://your-crm.example/clients
//CLIENTS_API_TOKEN=optional-bearer-token
//npm run import-clients ---if i want to connect api and add json files directly.