-- Migration: 003_operator_otp.sql
-- Remove password_hash from operator_accounts, add name and role, and create operator_otps table.

alter table public.operator_accounts
  drop column if exists password_hash;

alter table public.operator_accounts
  add column if not exists name text,
  add column if not exists role text not null default 'operator';

create table if not exists public.operator_otps (
  email text primary key,
  code_hash text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists operator_otps_expires_idx
  on public.operator_otps (expires_at);
