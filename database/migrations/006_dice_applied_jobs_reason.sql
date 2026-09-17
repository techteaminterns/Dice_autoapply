alter table if exists public.dice_applied_jobs
  add column if not exists reason text;
