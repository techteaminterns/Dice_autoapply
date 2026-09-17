const test = require('node:test');
const assert = require('node:assert/strict');
const { createApplyQueue } = require('../lib/apply-queue');

test('hasActiveClientJob detects queued or running work for the same client', async () => {
  const supabase = {
    from(table) {
      assert.equal(table, 'dice_apply_queue');
      return {
        select() {
          return {
            eq() {
              return {
                in() {
                  return {
                    maybeSingle: async () => ({
                      data: { id: 101, status: 'queued' },
                      error: null,
                    }),
                  };
                },
              };
            },
          };
        },
      };
    },
  };

  const queue = createApplyQueue(supabase);
  const active = await queue.hasActiveClientJob(42);
  assert.equal(active, true);
});

test('query builder in lib/azure supports neq and delete chaining', () => {
  const { createServiceClient } = require('../lib/azure');
  const azure = createServiceClient();
  const query = azure
    .from('dice_telegram_connection')
    .delete()
    .eq('client_id', 'test-client-id')
    .neq('telegram_chat_id', 12345);

  assert.equal(typeof query.neq, 'function');
  assert.equal(typeof query.eq, 'function');
  assert.equal(typeof query.delete, 'function');
  assert.equal(typeof query.limit, 'function');
});

test('hasActiveClientJob returns true when multiple active jobs exist (limit check)', async () => {
  const supabase = {
    from(table) {
      assert.equal(table, 'dice_apply_queue');
      return {
        select() {
          return {
            eq() {
              return {
                in() {
                  return {
                    limit: async (n) => {
                      assert.equal(n, 1);
                      return {
                        data: [
                          { id: 101, status: 'queued' },
                        ],
                        error: null,
                      };
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };

  const queue = createApplyQueue(supabase);
  const active = await queue.hasActiveClientJob(42);
  assert.equal(active, true, 'Should detect active work when at least 1 job is queued/running');
});

test('hasActiveClientJob returns false when no active jobs exist', async () => {
  const supabase = {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                in() {
                  return {
                    limit: async () => ({
                      data: [],
                      error: null,
                    }),
                  };
                },
              };
            },
          };
        },
      };
    },
  };

  const queue = createApplyQueue(supabase);
  const active = await queue.hasActiveClientJob(999);
  assert.equal(active, false, 'Should return false when queue has 0 active jobs');
});
