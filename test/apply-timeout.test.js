const test = require('node:test');
const assert = require('node:assert/strict');
const { startApplyWorkers } = require('../lib/apply-worker');
const { createApplyQueue } = require('../lib/apply-queue');

test('applyQueue.markFailed marks queue row failed directly without retrying', async () => {
  let updatedPayload = null;
  let updatedId = null;

  const fakeAzure = {
    from(table) {
      assert.equal(table, 'dice_apply_queue');
      return {
        update(payload) {
          updatedPayload = payload;
          return {
            eq(col, val) {
              assert.equal(col, 'id');
              updatedId = val;
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };

  const queue = createApplyQueue(fakeAzure);
  const result = await queue.markFailed(777, 'application_timeout');

  assert.deepEqual(result, { retried: false });
  assert.equal(updatedId, 777);
  assert.equal(updatedPayload.status, 'failed');
  assert.equal(updatedPayload.last_error, 'application_timeout');
  assert.equal(updatedPayload.worker_id, null);
  assert.equal(updatedPayload.locked_at, null);
  assert.ok(updatedPayload.finished_at);
});

test('startApplyWorkers times out hanging job, aborts signal, marks failed, sends telegram message, and audits', async () => {
  let claimed = false;
  let markFailedCalled = false;
  let markFailedReason = null;
  let markCompletedCalled = false;
  let markFailedOrRetryCalled = false;
  let abortSignalFired = false;
  let timeoutMessageSent = null;
  const auditEvents = [];

  const fakeQueue = {
    claimNextJob: async () => {
      if (!claimed) {
        claimed = true;
        return {
          id: 99,
          telegram_chat_id: '123456',
          company: 'Acme Corp',
          attempts: 1,
          max_attempts: 2,
        };
      }
      return null;
    },
    markCompleted: async () => {
      markCompletedCalled = true;
    },
    markFailed: async (id, reason) => {
      markFailedCalled = true;
      markFailedReason = reason;
      return { retried: false };
    },
    markFailedOrRetry: async () => {
      markFailedOrRetryCalled = true;
      return { retried: true };
    },
  };

  const executeJob = async (job, { signal } = {}) => {
    return new Promise((resolve) => {
      if (signal) {
        signal.addEventListener('abort', () => {
          abortSignalFired = true;
          resolve();
        });
      }
    });
  };

  const controller = startApplyWorkers({
    queue: fakeQueue,
    executeJob,
    audit: async (chatId, event, details) => {
      auditEvents.push({ chatId, event, details });
    },
    concurrency: 1,
    pollMs: 20,
    applyTimeoutMs: 50,
    sendTimeoutMessage: async (chatId, company) => {
      timeoutMessageSent = { chatId, company };
    },
  });

  await new Promise((r) => setTimeout(r, 120));
  controller.stop();
  await controller.done;

  assert.equal(abortSignalFired, true, 'Abort signal should have fired on timeout');
  assert.equal(markFailedCalled, true, 'markFailed should have been called');
  assert.equal(markFailedReason, 'application_timeout');
  assert.equal(markCompletedCalled, false, 'markCompleted should not be called');
  assert.equal(markFailedOrRetryCalled, false, 'markFailedOrRetry should not be called on timeout');

  assert.deepEqual(timeoutMessageSent, {
    chatId: 123456,
    company: 'Acme Corp',
  });

  const timeoutAudit = auditEvents.find((e) => e.event === 'application_timeout');
  assert.ok(timeoutAudit, 'application_timeout audit event should be recorded');
  assert.equal(timeoutAudit.chatId, 123456);
  assert.equal(timeoutAudit.details.queueId, 99);
});

test('startApplyWorkers completes quickly without triggering timeout or timeout message', async () => {
  let claimed = false;
  let markCompletedCalled = false;
  let markFailedCalled = false;
  let timeoutMessageSent = null;

  const fakeQueue = {
    claimNextJob: async () => {
      if (!claimed) {
        claimed = true;
        return {
          id: 102,
          telegram_chat_id: '654321',
          job_title: 'Software Engineer',
          attempts: 1,
          max_attempts: 2,
        };
      }
      return null;
    },
    markCompleted: async () => {
      markCompletedCalled = true;
    },
    markFailed: async () => {
      markFailedCalled = true;
    },
    markFailedOrRetry: async () => {},
  };

  const controller = startApplyWorkers({
    queue: fakeQueue,
    executeJob: async () => {},
    concurrency: 1,
    pollMs: 20,
    applyTimeoutMs: 200,
    sendTimeoutMessage: async (chatId, company) => {
      timeoutMessageSent = { chatId, company };
    },
  });

  await new Promise((r) => setTimeout(r, 50));
  controller.stop();
  await controller.done;

  assert.equal(markCompletedCalled, true, 'markCompleted should be called');
  assert.equal(markFailedCalled, false, 'markFailed should not be called');
  assert.equal(timeoutMessageSent, null, 'No timeout message should be sent');
});
