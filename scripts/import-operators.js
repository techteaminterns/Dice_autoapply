require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { createPool } = require('../lib/supabase');
const { mapOperatorRecord } = require('./map-operator-record');

async function loadOperatorRecords() {
  const apiUrl = process.env.OPERATORS_API_URL;
  if (apiUrl) {
    const headers = { Accept: 'application/json' };
    if (process.env.OPERATORS_API_TOKEN) {
      headers.Authorization = `Bearer ${process.env.OPERATORS_API_TOKEN}`;
    }
    const response = await fetch(apiUrl, { headers });
    if (!response.ok) {
      throw new Error(`OPERATORS_API_URL failed: ${response.status} ${response.statusText}`);
    }
    const payload = await response.json();
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload.records)) return payload.records;
    if (Array.isArray(payload.data)) return payload.data;
    if (payload.operator) return [payload];
    throw new Error('API response was not an array of operator records.');
  }

  const filePath = process.argv[2] || path.join('data', 'sample-operators.json');
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Import file not found: ${resolved}`);
  }
  const payload = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  if (Array.isArray(payload)) return payload;
  if (payload.operator) return [payload];
  throw new Error('JSON file must be an array of operator records or a single { operator } object.');
}

async function importOperators(records) {
  const db = createPool();
  let imported = 0;
  let failed = 0;

  try {
    for (const [index, item] of records.entries()) {
      let identifier = `row ${index + 1}`;
      try {
        const mapped = mapOperatorRecord(item);
        identifier = mapped.email;

        await db.query(
          `insert into operator_accounts (id, email, name, role, disabled)
           values ($1, $2, $3, $4, $5)
           on conflict (email) do update set
             name = excluded.name,
             role = excluded.role,
             disabled = excluded.disabled`,
          [mapped.id, mapped.email, mapped.name, mapped.role, mapped.disabled]
        );

        imported += 1;
        console.log(`[ok] ${mapped.id} | ${mapped.email} (${mapped.name} - ${mapped.role})`);
      } catch (error) {
        failed += 1;
        console.error(`[fail] ${identifier}: ${error.message}`);
      }
    }

    console.log(`Operator import finished. imported=${imported} failed=${failed} total=${records.length}`);
  } finally {
    await db.end();
  }

  if (failed > 0 && imported === 0) process.exit(1);
}

loadOperatorRecords()
  .then(importOperators)
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
