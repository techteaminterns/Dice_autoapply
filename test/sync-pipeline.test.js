const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const stream = require('stream');
const { getYesterdayDate, runSyncDaily } = require('../scripts/sync-daily-pipeline');
const { createDashboardServer, syncCooldowns, SYNC_COOLDOWN_MS } = require('../lib/dashboard-server');

function invokeServer(server, { method = 'GET', url = '/', headers = {}, body = null }) {
  return new Promise((resolve) => {
    const req = new stream.Readable({
      read() {
        if (body) {
          this.push(typeof body === 'string' ? body : JSON.stringify(body));
        }
        this.push(null);
      },
    });
    req.method = method;
    req.url = url;
    req.headers = headers;

    const chunks = [];
    const res = new stream.Writable({
      write(chunk, encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    res.statusCode = 200;
    res.headers = {};
    res.writeHead = (status, headers = {}) => {
      res.statusCode = status;
      res.headers = { ...res.headers, ...headers };
    };
    res.setHeader = (name, val) => {
      res.headers[name.toLowerCase()] = val;
    };
    res.end = (chunk) => {
      if (chunk) chunks.push(Buffer.from(chunk));
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try {
        json = JSON.parse(rawBody);
      } catch {
        json = null;
      }
      resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: json || rawBody,
      });
    };

    server.emit('request', req, res);
  });
}

test('getYesterdayDate returns a valid YYYY-MM-DD date string exactly 24 hours prior', () => {
  const yesterdayStr = getYesterdayDate();
  assert.match(yesterdayStr, /^\d{4}-\d{2}-\d{2}$/);

  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  assert.equal(yesterdayStr, yesterday.toISOString().slice(0, 10));
});

test('runSyncDaily with targetCA bypasses syncCAs and scopes to targetCA', async () => {
  const originalFetch = global.fetch;
  const originalMappingApi = process.env.CA_CLIENT_MAPPING_API;
  const originalClientsApi = process.env.CLIENTS_API;
  const originalClientsApiUrl = process.env.CLIENTS_API_URL;
  const originalClientApi = process.env.CLIENT_API;

  try {
    process.env.CA_CLIENT_MAPPING_API = 'https://mock.api/mappings';
    delete process.env.CLIENTS_API;
    delete process.env.CLIENTS_API_URL;
    delete process.env.CLIENT_API;

    let fetchCalledWith = null;
    global.fetch = async (url) => {
      fetchCalledWith = url;
      return {
        ok: true,
        json: async () => [
          {
            applywizz_id: 'WIZZ-100',
            client_id: 'client-100',
            client_email: 'candidate@example.com',
            client_name: 'Jane Candidate',
          },
        ],
      };
    };

    const queriedSql = [];
    const mockDb = {
      query: async (sql, params) => {
        queriedSql.push({ sql, params });
        return { rows: [] };
      },
    };

    const targetCA = {
      id: 55,
      email: 'ca_test@example.com',
      name: 'Test CA',
      role: 'ca',
    };

    const result = await runSyncDaily({
      db: mockDb,
      targetCA,
      date: '2026-09-14',
    });

    assert.equal(result.ok, true);
    assert.equal(result.scoped, true);
    assert.equal(result.ca_email, 'ca_test@example.com');
    assert.equal(result.cas_synced, 1);
    assert.equal(result.clients_updated, 1);

    // Verify it called mapping API with ca_email filter
    assert.ok(fetchCalledWith.includes('ca_email=ca_test%40example.com'));

    // Verify it did NOT query all CAs from dice_ca_accounts
    const calledSelectAllCAs = queriedSql.some((q) =>
      q.sql.includes('select id, email, name, role from dice_ca_accounts')
    );
    assert.equal(calledSelectAllCAs, false);
  } finally {
    global.fetch = originalFetch;
    process.env.CA_CLIENT_MAPPING_API = originalMappingApi;
    if (originalClientsApi !== undefined) process.env.CLIENTS_API = originalClientsApi;
    if (originalClientsApiUrl !== undefined) process.env.CLIENTS_API_URL = originalClientsApiUrl;
    if (originalClientApi !== undefined) process.env.CLIENT_API = originalClientApi;
  }
});

test('/api/sync-daily enforces 30m cooldown for non-admins and allows admins to bypass', async () => {
  syncCooldowns.clear();

  const originalFetch = global.fetch;
  const originalMappingApi = process.env.CA_CLIENT_MAPPING_API;
  const originalClientsApi = process.env.CLIENTS_API;
  const originalClientsApiUrl = process.env.CLIENTS_API_URL;
  const originalClientApi = process.env.CLIENT_API;

  try {
    process.env.CA_CLIENT_MAPPING_API = 'https://mock.api/mappings';
    delete process.env.CLIENTS_API;
    delete process.env.CLIENTS_API_URL;
    delete process.env.CLIENT_API;

    global.fetch = async () => ({
      ok: true,
      json: async () => [],
    });

    const caToken = 'test-ca-session-token';
    const adminToken = 'test-admin-session-token';
    const caTokenHash = crypto.createHash('sha256').update(caToken).digest('hex');
    const adminTokenHash = crypto.createHash('sha256').update(adminToken).digest('hex');

    const mockDb = {
      query: async (sql, params) => {
        if (sql.includes('dice_ca_sessions')) {
          const hash = params[0];
          if (hash === caTokenHash) {
            return {
              rows: [
                {
                  operator_id: 101,
                  email: 'ca1@example.com',
                  name: 'CA User',
                  role: 'ca',
                },
              ],
            };
          }
          if (hash === adminTokenHash) {
            return {
              rows: [
                {
                  operator_id: 202,
                  email: 'admin@example.com',
                  name: 'Admin User',
                  role: 'admin',
                },
              ],
            };
          }
        }
        return { rows: [] };
      },
    };

    const server = createDashboardServer({ db: mockDb });

    // 1. Non-admin first request -> Success (200)
    const res1 = await invokeServer(server, {
      method: 'POST',
      url: '/api/sync-daily',
      headers: {
        'content-type': 'application/json',
        cookie: `dashboard_session=${caToken}`,
      },
      body: {},
    });
    assert.equal(res1.statusCode, 200);
    assert.equal(res1.body.ok, true);
    assert.equal(res1.body.scoped, true);
    assert.equal(res1.body.ca_email, 'ca1@example.com');
    assert.ok(syncCooldowns.has(101));

    // 2. Non-admin second request immediately -> 429 Cooldown Active
    const res2 = await invokeServer(server, {
      method: 'POST',
      url: '/api/sync-daily',
      headers: {
        'content-type': 'application/json',
        cookie: `dashboard_session=${caToken}`,
      },
      body: {},
    });
    assert.equal(res2.statusCode, 429);
    assert.equal(res2.body.ok, false);
    assert.match(res2.body.error, /Cooldown active/i);
    assert.ok(res2.body.remaining_seconds > 0);

    // 3. Admin request -> Success (200), bypasses cooldown
    const resAdmin1 = await invokeServer(server, {
      method: 'POST',
      url: '/api/sync-daily',
      headers: {
        'content-type': 'application/json',
        cookie: `dashboard_session=${adminToken}`,
      },
      body: {},
    });
    assert.equal(resAdmin1.statusCode, 200);
    assert.equal(resAdmin1.body.ok, true);
    assert.equal(resAdmin1.body.scoped, false);

    // 4. Admin immediate second request -> Still Success (200), no cooldown
    const resAdmin2 = await invokeServer(server, {
      method: 'POST',
      url: '/api/sync-daily',
      headers: {
        'content-type': 'application/json',
        cookie: `dashboard_session=${adminToken}`,
      },
      body: {},
    });
    assert.equal(resAdmin2.statusCode, 200);

    // 5. Simulate 31 minutes passed for non-admin
    syncCooldowns.set(101, Date.now() - (SYNC_COOLDOWN_MS + 1000));
    const res3 = await invokeServer(server, {
      method: 'POST',
      url: '/api/sync-daily',
      headers: {
        'content-type': 'application/json',
        cookie: `dashboard_session=${caToken}`,
      },
      body: {},
    });
    assert.equal(res3.statusCode, 200);
    assert.equal(res3.body.ok, true);
  } finally {
    global.fetch = originalFetch;
    process.env.CA_CLIENT_MAPPING_API = originalMappingApi;
    if (originalClientsApi !== undefined) process.env.CLIENTS_API = originalClientsApi;
    if (originalClientsApiUrl !== undefined) process.env.CLIENTS_API_URL = originalClientsApiUrl;
    if (originalClientApi !== undefined) process.env.CLIENT_API = originalClientApi;
    syncCooldowns.clear();
  }
});
