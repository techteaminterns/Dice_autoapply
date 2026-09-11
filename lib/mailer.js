let cachedToken = null;
let tokenExpiresAt = 0;

function getAuthConfig() {
  const clientId = process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;
  const tenantId = process.env.MS365_TENANT_ID || process.env.AZURE_TENANT_ID;
  const senderEmail = process.env.AZURE_SENDER_EMAIL || process.env.SENDER_EMAIL || process.env.FROM_EMAIL;

  return {
    clientId,
    clientSecret,
    tenantId,
    senderEmail,
    isConfigured: Boolean(clientId && clientSecret && tenantId && senderEmail),
  };
}

async function getAccessToken() {
  const { clientId, clientSecret, tenantId } = getAuthConfig();

  // Return cached token if valid for at least another 60 seconds
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedToken;
  }

  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default',
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`Microsoft Entra OAuth token error (HTTP ${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  if (!data.access_token) {
    throw new Error('No access_token returned by Microsoft Entra.');
  }

  cachedToken = data.access_token;
  const expiresInMs = (Number(data.expires_in) || 3599) * 1000;
  tokenExpiresAt = Date.now() + expiresInMs;

  return cachedToken;
}

async function sendEmail({ to, subject, html, text }) {
  const config = getAuthConfig();

  if (!config.isConfigured) {
    console.warn(`[mailer] Azure MS365 credentials not fully configured in environment.`);
    console.warn(`[mailer] Simulated email to ${to}: ${subject}`);
    return { ok: false, simulated: true };
  }

  const token = await getAccessToken();
  const sendMailUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(config.senderEmail)}/sendMail`;

  const recipients = (Array.isArray(to) ? to : [to]).map((email) => ({
    emailAddress: { address: email.trim() },
  }));

  const messagePayload = {
    message: {
      subject,
      body: {
        contentType: html ? 'HTML' : 'Text',
        content: html || text || '',
      },
      toRecipients: recipients,
    },
    saveToSentItems: 'false',
  };

  const response = await fetch(sendMailUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(messagePayload),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Microsoft Graph sendMail error (HTTP ${response.status}): ${errorText}`);
  }

  console.log(`[mailer] Email successfully sent to ${to} (${subject})`);
  return { ok: true };
}

module.exports = {
  sendEmail,
  getAuthConfig,
  getAccessToken,
};
