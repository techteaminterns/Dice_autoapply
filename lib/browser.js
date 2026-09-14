const { chromium: localChromium } = require('playwright');
const { chromium: remoteChromium } = require('playwright-core');
const Browserbase = require('@browserbasehq/sdk');

function envFlag(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return defaultValue;
  return String(raw).split('#')[0].trim().toLowerCase() === 'true';
}

function envInt(name, defaultValue) {
  const raw = process.env[name];
  if (raw == null || raw === '') return defaultValue;
  const value = Number(String(raw).split('#')[0].trim());
  return Number.isFinite(value) && value > 0 ? value : defaultValue;
}

const useBrowserbase = envFlag('USE_BROWSERBASE', false);
const localMaxConcurrent = envInt('LOCAL_MAX_CONCURRENT', 5);
const maxConcurrent = useBrowserbase
  ? envInt('BROWSERBASE_MAX_CONCURRENT', 20)
  : localMaxConcurrent;

let bbClient = null;
let activeSessions = 0;
const waitQueue = [];

let sharedBrowser = null;
let sharedBrowserPromise = null;
let activeLocalContexts = 0;
let totalJobsProcessed = 0;
const RECYCLE_THRESHOLD = envInt('BROWSER_RECYCLE_THRESHOLD', 150);

function getBrowserbase() {
  if (!bbClient) {
    const apiKey = process.env.BROWSERBASE_API_KEY;
    if (!apiKey) {
      throw new Error('BROWSERBASE_API_KEY must be set when USE_BROWSERBASE=true.');
    }
    bbClient = new Browserbase({ apiKey });
  }
  return bbClient;
}

function acquireSlot() {
  if (activeSessions < maxConcurrent) {
    activeSessions += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waitQueue.push(resolve);
  }).then(() => {
    activeSessions += 1;
  });
}

function releaseSlot() {
  activeSessions = Math.max(0, activeSessions - 1);
  const next = waitQueue.shift();
  if (next) next();
}

async function getSharedBrowser() {
  if (sharedBrowser && sharedBrowser.isConnected()) {
    return sharedBrowser;
  }
  if (sharedBrowserPromise) {
    return sharedBrowserPromise;
  }

  sharedBrowserPromise = (async () => {
    try {
      console.log('[browser] Launching shared Chromium instance...');
      const browser = await localChromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-software-rasterizer',
          '--no-zygote',
        ],
      });
      browser.on('disconnected', () => {
        console.log('[browser] Shared Chromium disconnected. Resetting instance.');
        sharedBrowser = null;
        sharedBrowserPromise = null;
      });
      sharedBrowser = browser;
      return browser;
    } finally {
      sharedBrowserPromise = null;
    }
  })();

  return sharedBrowserPromise;
}

async function openLocalBrowser({ storageState = null, headless = true } = {}) {
  const browser = await getSharedBrowser();
  activeLocalContexts += 1;
  totalJobsProcessed += 1;
  const context = await browser.newContext(storageState ? { storageState } : undefined);
  const page = await context.newPage();
  return {
    browser,
    context,
    page,
    sessionId: null,
    provider: 'local',
    isShared: true,
  };
}

async function openBrowserbaseBrowser({ storageState = null } = {}) {
  await acquireSlot();
  let browser = null;
  try {
    const bb = getBrowserbase();
    const projectId = (process.env.BROWSERBASE_PROJECT_ID || '').split('#')[0].trim();
    if (!projectId) {
      throw new Error(
        'BROWSERBASE_PROJECT_ID must be set when USE_BROWSERBASE=true. Find it in Browserbase Settings.'
      );
    }

    const session = await bb.sessions.create({ projectId });
    console.log(`[browser] Browserbase session created: ${session.id}`);
    console.log(`[browser] Replay: https://www.browserbase.com/sessions/${session.id}`);

    const connectUrl = session.connectUrl || session.connect_url;
    if (!connectUrl) {
      throw new Error('Browserbase session response did not include connectUrl.');
    }

    browser = await remoteChromium.connectOverCDP(connectUrl);

    let context;
    if (storageState) {
      context = await browser.newContext({ storageState });
    } else {
      context = browser.contexts()[0] || await browser.newContext();
    }

    const page = context.pages()[0] || await context.newPage();
    return {
      browser,
      context,
      page,
      sessionId: session.id,
      provider: 'browserbase',
    };
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    releaseSlot();
    throw error;
  }
}

/**
 * Opens a browser either on Browserbase or locally based on USE_BROWSERBASE.
 * @param {{ storageState?: object|null, headless?: boolean }} options
 */
async function openBrowser(options = {}) {
  if (useBrowserbase) {
    return openBrowserbaseBrowser(options);
  }
  return openLocalBrowser(options);
}

async function closeBrowser(handle) {
  if (!handle) return;
  try {
    if (handle.page) await handle.page.close().catch(() => {});
  } finally {
    try {
      if (handle.context) await handle.context.close().catch(() => {});
    } finally {
      if (handle.provider === 'browserbase') {
        if (handle.browser) await handle.browser.close().catch(() => {});
        releaseSlot();
      } else if (handle.isShared) {
        activeLocalContexts = Math.max(0, activeLocalContexts - 1);
        if (totalJobsProcessed >= RECYCLE_THRESHOLD && activeLocalContexts === 0 && sharedBrowser) {
          console.log(`[browser] Recycling shared Chromium after ${totalJobsProcessed} jobs...`);
          const browserToClose = sharedBrowser;
          sharedBrowser = null;
          totalJobsProcessed = 0;
          await browserToClose.close().catch(() => {});
        }
      } else if (handle.browser) {
        await handle.browser.close().catch(() => {});
      }
    }
  }
}

async function closeSharedBrowser() {
  if (sharedBrowser) {
    console.log('[browser] Closing shared Chromium instance...');
    const browser = sharedBrowser;
    sharedBrowser = null;
    activeLocalContexts = 0;
    await browser.close().catch(() => {});
  }
}

module.exports = {
  openBrowser,
  closeBrowser,
  closeSharedBrowser,
  getSharedBrowser,
  useBrowserbase,
  maxConcurrent,
};
