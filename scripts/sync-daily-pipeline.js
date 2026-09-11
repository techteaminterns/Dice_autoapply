require('dotenv').config();

const path = require('path');
const { createPool, createServiceClient } = require('../lib/azure');
const { mapImportItem } = require('./map-client-record');

function getYesterdayDate() {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return yesterday.toISOString().slice(0, 10);
}

function parseCliArgs() {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 1) {
    const [key, value] = process.argv[index].split('=', 2);
    if (key && value) args.set(key.replace(/^--/, ''), value);
  }
  return args;
}

async function fetchJson(url, options = {}) {
  const headers = {
    Accept: 'application/json',
    ...(options.headers || {}),
  };
  if (process.env.CLIENTS_API_TOKEN && !headers.Authorization) {
    headers.Authorization = `Bearer ${process.env.CLIENTS_API_TOKEN}`;
  }

  const response = await fetch(url, { ...options, headers });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} from ${url}`);
  }
  return response.json();
}

async function syncCAs(db) {
  const caApiUrl = process.env.CA_DETAILS_API || process.env.CA_DETAILS_API_URL;
  if (!caApiUrl) {
    console.warn('[sync] CA_DETAILS_API not configured in environment. Fetching existing CAs from database.');
    const result = await db.query(`select id, email, name, role from dice_ca_accounts where disabled = false`);
    return result.rows;
  }

  console.log(`[sync] Step 1: Fetching CA details from ${caApiUrl}...`);
  const payload = await fetchJson(caApiUrl);
  const rawList = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.users)
      ? payload.users
      : Array.isArray(payload.data)
        ? payload.data
        : Array.isArray(payload.records)
          ? payload.records
          : Array.isArray(payload.cas)
            ? payload.cas
            : Array.isArray(payload.career_associates)
              ? payload.career_associates
              : [];

  if (rawList.length === 0) {
    console.warn('[sync] No CA records returned from CA_DETAILS_API.');
    const result = await db.query(`select id, email, name, role from dice_ca_accounts where disabled = false`);
    return result.rows;
  }

  const syncedCAs = [];
  for (const item of rawList) {
    const email = String(item.email || item.ca_email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) continue;

    const name = String(item.name || item.ca_name || item.full_name || email.split('@')[0]).trim();
    const role = String(item.role || 'operator').trim();
    const id = item.id || item.ca_id || null;

    let res;
    if (id) {
      const existing = await db.query(
        `select id from dice_ca_accounts where id = $1 or email = $2 limit 1`,
        [id, email]
      );
      if (existing.rows.length > 0) {
        const targetId = existing.rows[0].id;
        res = await db.query(
          `update dice_ca_accounts
              set id = $1, email = $2, name = $3, role = $4, disabled = false
            where id = $5
            returning id, email, name, role`,
          [id, email, name, role, targetId]
        );
      } else {
        res = await db.query(
          `insert into dice_ca_accounts (id, email, name, role, disabled)
           values ($1, $2, $3, $4, false)
           returning id, email, name, role`,
          [id, email, name, role]
        );
      }
    } else {
      res = await db.query(
        `insert into dice_ca_accounts (email, name, role, disabled)
         values ($1, $2, $3, false)
         on conflict (email) do update set
           name = excluded.name,
           role = excluded.role,
           disabled = false
         returning id, email, name, role`,
        [email, name, role]
      );
    }

    if (res.rows[0]) {
      syncedCAs.push(res.rows[0]);
    }
  }

  console.log(`[sync] Step 1 Complete: Synced ${syncedCAs.length} CAs in dice_ca_accounts.`);
  return syncedCAs;
}

async function syncMappings(db, azure, targetDate, cas) {
  const mappingApiUrl = process.env.CA_CLIENT_MAPPING_API || process.env.CA_CLIENT_MAPPING_API_URL;
  if (!mappingApiUrl) {
    throw new Error('CA_CLIENT_MAPPING_API is not configured in environment.');
  }

  console.log(`[sync] Step 2: Fetching CA-Client mappings for date: ${targetDate}...`);

  const clientApiUrl = process.env.CLIENTS_API || process.env.CLIENTS_API_URL || process.env.CLIENT_API;
  let totalMappingsFound = 0;
  let clientsUpdated = 0;
  let clientsHydrated = 0;
  let failedCount = 0;

  for (const ca of cas) {
    const email = ca.email.toLowerCase();
    const caId = ca.id;

    const separator = mappingApiUrl.includes('?') ? '&' : '?';
    const url = `${mappingApiUrl}${separator}from=${targetDate}&to=${targetDate}&ca_email=${encodeURIComponent(email)}`;

    let payload;
    try {
      payload = await fetchJson(url);
    } catch (error) {
      console.warn(`[sync] Mapping fetch failed for ${email}: ${error.message}`);
      continue;
    }

    const records = Array.isArray(payload)
      ? payload
      : Array.isArray(payload.records)
        ? payload.records
        : Array.isArray(payload.data)
          ? payload.data
          : [];

    if (records.length === 0) continue;

    totalMappingsFound += records.length;
    console.log(`[sync] Found ${records.length} mapped clients for CA: ${ca.name || email}`);

    for (const record of records) {
      const applywizzId = String(record.applywizz_id || '').trim();
      if (!applywizzId) continue;

      try {
        const clientId = record.client_id || record.id || null;
        const updateRes = await db.query(
          `update clients_additional_info
              set career_associate_id = $1
            where applywizz_id = $2
               or ($3::uuid is not null and id = $3::uuid)
            returning id`,
          [caId, applywizzId, clientId]
        );

        if (updateRes.rowCount > 0) {
          clientsUpdated += 1;
          continue;
        }

        // If client doesn't exist yet, attempt to hydrate from CLIENTS_API
        if (clientApiUrl) {
          const clientSeparator = clientApiUrl.includes('?') ? '&' : '?';
          const clientFetchUrl = `${clientApiUrl}${clientSeparator}applywizz_id=${encodeURIComponent(applywizzId)}`;

          try {
            const clientPayload = await fetchJson(clientFetchUrl);
            const { clientRow, profileRow } = mapImportItem(clientPayload);
            clientRow.career_associate_id = caId;

            const { error: clientError } = await azure
              .from('clients_additional_info')
              .upsert(clientRow, { onConflict: 'id' });
            if (clientError) throw clientError;

            if (profileRow) {
              const { error: profileError } = await azure
                .from('client_profiles')
                .upsert(profileRow, { onConflict: 'id' });
              if (profileError) throw profileError;
            }

            clientsHydrated += 1;
            console.log(`[sync] Hydrated new client from API: ${applywizzId}`);
          } catch (fetchError) {
            failedCount += 1;
            console.warn(`[sync] Could not hydrate client ${applywizzId}: ${fetchError.message}`);
          }
        } else {
          // If no CLIENTS_API configured, insert minimal stub record so dashboard has it
          const clientId = record.client_id || record.id || require('crypto').randomUUID();
          const clientEmail = String(record.client_email || '').trim().toLowerCase();
          const clientName = String(record.client_name || '').trim();

          if (clientEmail) {
            await db.query(
              `insert into clients_additional_info (id, applywizz_id, full_name, company_email, career_associate_id, raw_payload)
               values ($1, $2, $3, $4, $5, $6)
               on conflict (id) do update set
                 career_associate_id = excluded.career_associate_id,
                 full_name = coalesce(clients_additional_info.full_name, excluded.full_name)`,
              [clientId, applywizzId, clientName || null, clientEmail, caId, JSON.stringify(record)]
            );
            clientsUpdated += 1;
          }
        }
      } catch (err) {
        failedCount += 1;
        console.error(`[sync] Failed to map client ${applywizzId}:`, err.message);
      }
    }
  }

  console.log(`[sync] Step 2 Complete for ${targetDate}: ${totalMappingsFound} mapped, ${clientsUpdated} updated, ${clientsHydrated} hydrated, ${failedCount} failed.`);
  return {
    date: targetDate,
    total_mappings: totalMappingsFound,
    clients_updated: clientsUpdated,
    clients_hydrated: clientsHydrated,
    failed: failedCount,
  };
}

async function runSyncDaily(options = {}) {
  const db = options.db || createPool();
  const azure = options.azure || createServiceClient();
  const targetDate = options.date || getYesterdayDate();

  console.log(`=== Starting Daily Sync Pipeline for date: ${targetDate} ===`);
  const startTime = Date.now();

  try {
    const cas = await syncCAs(db);
    const mappingStats = await syncMappings(db, azure, targetDate, cas);

    const durationSeconds = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`=== Daily Sync Finished successfully in ${durationSeconds}s ===`);

    return {
      ok: true,
      duration_seconds: durationSeconds,
      date: targetDate,
      cas_synced: cas.length,
      ...mappingStats,
    };
  } catch (error) {
    console.error('[sync] Daily sync failed:', error.message);
    return {
      ok: false,
      error: error.message,
    };
  }
}

if (require.main === module) {
  const cliArgs = parseCliArgs();
  const targetDate = cliArgs.get('date') || getYesterdayDate();

  runSyncDaily({ date: targetDate })
    .then((result) => {
      if (!result.ok) process.exit(1);
      process.exit(0);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = {
  runSyncDaily,
  getYesterdayDate,
};
