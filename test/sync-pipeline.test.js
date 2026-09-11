const test = require('node:test');
const assert = require('node:assert/strict');
const { getYesterdayDate } = require('../scripts/sync-daily-pipeline');

test('getYesterdayDate returns a valid YYYY-MM-DD date string exactly 24 hours prior', () => {
  const yesterdayStr = getYesterdayDate();
  assert.match(yesterdayStr, /^\d{4}-\d{2}-\d{2}$/);

  const today = new Date();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  assert.equal(yesterdayStr, yesterday.toISOString().slice(0, 10));
});
