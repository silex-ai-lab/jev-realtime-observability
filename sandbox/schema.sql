-- Sandbox schema (RFC §3 sandbox, plan §4). A separate Postgres schema "sandbox" holds
-- synthetic, fictional AP data. Applied by seedSandbox() via migrate(db, [{set:'sandbox', dir:...}]).
-- Amounts are double precision: fictional money, precision is not a concern.

CREATE SCHEMA IF NOT EXISTS sandbox;

CREATE TABLE IF NOT EXISTS sandbox.tenant_policies (
  tenant_id          text PRIMARY KEY,
  approval_limit_usd double precision NOT NULL,
  domain_allowlist   jsonb NOT NULL,
  stale_after_ms     integer NOT NULL,
  repeat_failure_n   integer NOT NULL
);

CREATE TABLE IF NOT EXISTS sandbox.vendors (
  tenant_id  text NOT NULL,
  vendor_id  text NOT NULL,
  legal_name text NOT NULL,
  aliases    jsonb NOT NULL,
  PRIMARY KEY (tenant_id, vendor_id)
);

CREATE TABLE IF NOT EXISTS sandbox.accounts (
  tenant_id      text NOT NULL,
  account_ref    text NOT NULL,
  holder_name    text NOT NULL,
  account_number text NOT NULL,
  PRIMARY KEY (tenant_id, account_ref)
);

CREATE TABLE IF NOT EXISTS sandbox.account_vendors (
  tenant_id   text NOT NULL,
  account_ref text NOT NULL,
  vendor_id   text NOT NULL,
  PRIMARY KEY (tenant_id, account_ref, vendor_id)
);

CREATE TABLE IF NOT EXISTS sandbox.purchase_orders (
  tenant_id  text NOT NULL,
  po_id      text NOT NULL,
  vendor_id  text NOT NULL,
  amount_usd double precision NOT NULL,
  status     text NOT NULL,
  version    integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, po_id)
);

CREATE TABLE IF NOT EXISTS sandbox.invoices (
  tenant_id  text NOT NULL,
  invoice_id text NOT NULL,
  po_id      text NOT NULL,
  vendor_name text NOT NULL,
  amount_usd double precision NOT NULL,
  note       text,
  PRIMARY KEY (tenant_id, invoice_id)
);

CREATE TABLE IF NOT EXISTS sandbox.approvals (
  tenant_id  text NOT NULL,
  approval_id text NOT NULL,
  invoice_id text NOT NULL,
  status     text NOT NULL,
  approver   text NOT NULL,
  PRIMARY KEY (tenant_id, approval_id)
);

CREATE TABLE IF NOT EXISTS sandbox.ledger (
  tenant_id    text NOT NULL,
  tx_id        text NOT NULL,
  operation_id text NOT NULL,
  invoice_id   text NOT NULL,
  amount_usd   double precision NOT NULL,
  payee        text NOT NULL,
  account_ref  text NOT NULL,
  status       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, tx_id)
);

CREATE TABLE IF NOT EXISTS sandbox.mail_sink (
  tenant_id   text NOT NULL,
  message_id  text NOT NULL,
  operation_id text NOT NULL,
  to_addr     text NOT NULL,
  subject     text NOT NULL,
  body_digest text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, message_id)
);

CREATE TABLE IF NOT EXISTS sandbox.receipts (
  tenant_id    text NOT NULL,
  operation_id text NOT NULL,
  receipt      jsonb NOT NULL,
  result       jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, operation_id)
);
