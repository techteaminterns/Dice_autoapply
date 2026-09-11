const test = require('node:test');
const assert = require('node:assert/strict');
const { getAuthConfig, sendEmail } = require('../lib/mailer');

test('getAuthConfig returns isConfigured = false when environment variables are missing', () => {
  const originalEnv = { ...process.env };
  delete process.env.AZURE_CLIENT_ID;
  delete process.env.AZURE_CLIENT_SECRET;
  delete process.env.MS365_TENANT_ID;
  delete process.env.AZURE_SENDER_EMAIL;

  const config = getAuthConfig();
  assert.equal(config.isConfigured, false);

  process.env = originalEnv;
});

test('sendEmail gracefully simulates when Azure credentials are not configured', async () => {
  const originalEnv = { ...process.env };
  delete process.env.AZURE_CLIENT_ID;
  delete process.env.AZURE_CLIENT_SECRET;
  delete process.env.MS365_TENANT_ID;
  delete process.env.AZURE_SENDER_EMAIL;

  const result = await sendEmail({
    to: 'test@example.com',
    subject: 'Test Subject',
    html: '<p>123456</p>',
  });

  assert.equal(result.ok, false);
  assert.equal(result.simulated, true);

  process.env = originalEnv;
});
