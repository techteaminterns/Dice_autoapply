-- Migration 007: Manager role support
-- Adds manager_id column to dice_ca_accounts to link Career Associates (operators) to their manager.

ALTER TABLE dice_ca_accounts
  ADD COLUMN IF NOT EXISTS manager_id UUID REFERENCES dice_ca_accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ca_accounts_manager_id ON dice_ca_accounts(manager_id);
