const test = require('node:test');
const assert = require('node:assert/strict');
const { mapOperatorRecord } = require('../scripts/map-operator-record');
const { hashOtp, generate6DigitOTP } = require('../lib/dashboard-server');

test('mapOperatorRecord maps valid operator JSON payload', () => {
  const result = mapOperatorRecord({
    email: 'Test.Operator@Example.com ',
    name: '  Jane Doe ',
    role: 'admin',
  });

  assert.equal(result.email, 'test.operator@example.com');
  assert.equal(result.name, 'Jane Doe');
  assert.equal(result.role, 'admin');
  assert.equal(result.disabled, false);
});

test('mapOperatorRecord unwraps operator object and defaults missing name and role', () => {
  const result = mapOperatorRecord({
    operator: {
      email: 'john@example.com',
    },
  });

  assert.equal(result.email, 'john@example.com');
  assert.equal(result.name, 'john');
  assert.equal(result.role, 'operator');
});

test('mapOperatorRecord throws error on invalid or missing email', () => {
  assert.throws(() => {
    mapOperatorRecord({ name: 'No Email' });
  }, /missing valid email/);
});

test('generate6DigitOTP produces a 6-digit numeric string', () => {
  const otp = generate6DigitOTP();
  assert.equal(typeof otp, 'string');
  assert.equal(otp.length, 6);
  assert.match(otp, /^\d{6}$/);
});

test('hashOtp computes deterministic SHA-256 hash', () => {
  const hash1 = hashOtp('123456');
  const hash2 = hashOtp('123456');
  const hashDiff = hashOtp('654321');

  assert.equal(hash1, hash2);
  assert.notEqual(hash1, hashDiff);
  assert.equal(hash1.length, 64);
});
