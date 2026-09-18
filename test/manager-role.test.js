const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const stream = require('stream');
const { deriveManagerLinks, runSyncDaily } = require('../scripts/sync-daily-pipeline');
const { createDashboardServer } = require('../lib/dashboard-server');

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

test('deriveManagerLinks updates manager_id when client has career_associate_manager_id', async () => {
  const executedUpdates = [];
  const mockDb = {
    query: async (sql, params) => {
      if (sql.includes('select career_associate_manager_id')) {
        return {
          rows: [
            { career_associate_manager_id: 'bebf9e8d-5bcc-4f77-b0a8-b8b80c3ca700' },
          ],
        };
      }
      if (sql.includes('update dice_ca_accounts')) {
        executedUpdates.push({ sql, params });
        return { rowCount: 1 };
      }
      return { rows: [] };
    },
  };

  const cas = [
    { id: 'ca-uuid-1', email: 'ca1@example.com' },
    { id: 'ca-uuid-2', email: 'ca2@example.com' },
  ];

  const derivedCount = await deriveManagerLinks(mockDb, cas);
  assert.equal(derivedCount, 2);
  assert.equal(executedUpdates.length, 2);
  assert.deepEqual(executedUpdates[0].params, ['bebf9e8d-5bcc-4f77-b0a8-b8b80c3ca700', 'ca-uuid-1']);
  assert.deepEqual(executedUpdates[1].params, ['bebf9e8d-5bcc-4f77-b0a8-b8b80c3ca700', 'ca-uuid-2']);
});

test('deriveManagerLinks leaves manager_id untouched when no client has manager id', async () => {
  const executedUpdates = [];
  const mockDb = {
    query: async (sql, params) => {
      if (sql.includes('select career_associate_manager_id')) {
        return { rows: [] };
      }
      if (sql.includes('update dice_ca_accounts')) {
        executedUpdates.push({ sql, params });
        return { rowCount: 1 };
      }
      return { rows: [] };
    },
  };

  const cas = [{ id: 'ca-uuid-orphan', email: 'orphan@example.com' }];
  const derivedCount = await deriveManagerLinks(mockDb, cas);
  assert.equal(derivedCount, 0);
  assert.equal(executedUpdates.length, 0);
});

test('manager role can access /api/dev/overview while operator is forbidden', async () => {
  const opToken = 'test-op-token';
  const mgrToken = 'test-mgr-token';
  const adminToken = 'test-admin-token';

  const opHash = crypto.createHash('sha256').update(opToken).digest('hex');
  const mgrHash = crypto.createHash('sha256').update(mgrToken).digest('hex');
  const adminHash = crypto.createHash('sha256').update(adminToken).digest('hex');

  const mockDb = {
    query: async (sql, params) => {
      if (sql.includes('dice_ca_sessions')) {
        const hash = params[0];
        if (hash === opHash) {
          return { rows: [{ operator_id: 'op-1', email: 'op@example.com', name: 'CA Op', role: 'operator' }] };
        }
        if (hash === mgrHash) {
          return { rows: [{ operator_id: 'mgr-1', email: 'rk@example.com', name: 'RK Manager', role: 'manager' }] };
        }
        if (hash === adminHash) {
          return { rows: [{ operator_id: 'admin-1', email: 'admin@example.com', name: 'Admin', role: 'admin' }] };
        }
      }
      if (sql.includes('dice_ca_accounts')) {
        return { rows: [] };
      }
      return { rows: [{}] };
    },
  };

  const server = createDashboardServer({ db: mockDb });

  // 1. Regular operator -> 403 Forbidden
  const opRes = await invokeServer(server, {
    method: 'GET',
    url: '/api/dev/overview',
    headers: { cookie: `dashboard_session=${opToken}` },
  });
  assert.equal(opRes.statusCode, 403);
  assert.match(opRes.body.error, /Forbidden/i);

  // 2. Manager -> 200 OK
  const mgrRes = await invokeServer(server, {
    method: 'GET',
    url: '/api/dev/overview',
    headers: { cookie: `dashboard_session=${mgrToken}` },
  });
  assert.equal(mgrRes.statusCode, 200);
  assert.equal(mgrRes.body.ok, true);
  assert.equal(mgrRes.body.operator.role, 'manager');

  // 3. Admin -> 200 OK
  const adminRes = await invokeServer(server, {
    method: 'GET',
    url: '/api/dev/overview',
    headers: { cookie: `dashboard_session=${adminToken}` },
  });
  assert.equal(adminRes.statusCode, 200);
  assert.equal(adminRes.body.ok, true);
  assert.equal(adminRes.body.operator.role, 'admin');
});

test('manager role /api/sync-daily syncs all linked CAs', async () => {
  const mgrToken = 'test-mgr-token-sync';
  const mgrHash = crypto.createHash('sha256').update(mgrToken).digest('hex');

  const originalFetch = global.fetch;
  const originalMappingApi = process.env.CA_CLIENT_MAPPING_API;
  process.env.CA_CLIENT_MAPPING_API = 'https://mock.api/mappings';

  try {
    global.fetch = async () => ({
      ok: true,
      json: async () => [],
    });

    const mockDb = {
      query: async (sql, params) => {
        if (sql.includes('dice_ca_sessions')) {
          return { rows: [{ operator_id: 'mgr-1', email: 'balaji@example.com', name: 'Balaji', role: 'manager' }] };
        }
        if (sql.includes('select id, email, name, role from dice_ca_accounts where manager_id')) {
          // Return two CAs assigned to this manager
          return {
            rows: [
              { id: 'ca-1', email: 'sub1@example.com', name: 'Sub CA 1', role: 'operator' },
              { id: 'ca-2', email: 'sub2@example.com', name: 'Sub CA 2', role: 'operator' },
            ],
          };
        }
        return { rows: [] };
      },
    };

    const server = createDashboardServer({ db: mockDb });

    const res = await invokeServer(server, {
      method: 'POST',
      url: '/api/sync-daily',
      headers: {
        'content-type': 'application/json',
        cookie: `dashboard_session=${mgrToken}`,
      },
      body: {},
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.scoped, true);
    assert.equal(res.body.cas_synced, 2);
  } finally {
    global.fetch = originalFetch;
    process.env.CA_CLIENT_MAPPING_API = originalMappingApi;
  }
});
