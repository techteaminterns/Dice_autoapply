require('dotenv').config();

const { createPool } = require('../lib/supabase');

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const [key, value] = process.argv[index].split('=', 2);
  if (key && value) args.set(key.replace(/^--/, ''), value);
}

const email = String(args.get('email') || '').trim().toLowerCase();
const name = String(args.get('name') || '').trim() || (email ? email.split('@')[0] : '');
const role = String(args.get('role') || '').trim() || 'operator';

if (!email || !email.includes('@')) {
  console.error('Usage: npm run create-operator -- --email=operator@example.com [--name="Operator Name"] [--role=admin]');
  process.exit(1);
}

(async () => {
  const db = createPool();
  await db.query(
    `insert into operator_accounts (email, name, role, disabled)
     values ($1, $2, $3, false)
     on conflict (email) do update set
       name = excluded.name,
       role = excluded.role,
       disabled = false`,
    [email, name, role]
  );
  console.log(`Operator account ready: ${email} (${name} - ${role})`);
  await db.end();
})().catch(async (error) => {
  console.error(`Could not create operator: ${error.message}`);
  process.exitCode = 1;
});
