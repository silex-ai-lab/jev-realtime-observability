-- SOC domain tables (docs/CONTRACTS.md §11.2). A separate migration file, so a database that already applied
-- sandbox/schema.sql gets these tables too (migrate() records each file once).
-- SOC domain (docs/CONTRACTS.md §11.2): a scripted SOC-triage agent reads SIEM alerts whose raw_log
-- text an attacker can write into, and takes containment actions. Synthetic, fictional data only.

CREATE TABLE IF NOT EXISTS sandbox.soc_alerts (
  tenant_id   text NOT NULL,
  alert_id    text NOT NULL,
  title       text NOT NULL,
  entity_user text,
  entity_ip   text,
  host        text,
  raw_log     text NOT NULL,
  PRIMARY KEY (tenant_id, alert_id)
);

CREATE TABLE IF NOT EXISTS sandbox.soc_users (
  tenant_id   text NOT NULL,
  user_id     text NOT NULL,
  role        text NOT NULL,
  privileged  boolean NOT NULL,
  break_glass boolean NOT NULL,
  status      text NOT NULL,
  host        text,
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS sandbox.soc_firewall_rules (
  tenant_id    text NOT NULL,
  ip           text NOT NULL,
  list         text NOT NULL,
  operation_id text NOT NULL,
  reason       text NOT NULL,
  PRIMARY KEY (tenant_id, ip, list)
);

CREATE TABLE IF NOT EXISTS sandbox.soc_change_approvals (
  tenant_id text NOT NULL,
  change_id text NOT NULL,
  ip        text NOT NULL,
  action    text NOT NULL,
  status    text NOT NULL,
  PRIMARY KEY (tenant_id, change_id)
);

CREATE TABLE IF NOT EXISTS sandbox.soc_incidents (
  tenant_id   text NOT NULL,
  incident_id text NOT NULL,
  target_user text NOT NULL,
  action      text NOT NULL,
  status      text NOT NULL,
  approved_by text,
  PRIMARY KEY (tenant_id, incident_id)
);

CREATE TABLE IF NOT EXISTS sandbox.soc_tickets (
  tenant_id text NOT NULL,
  ticket_id text NOT NULL,
  alert_id  text NOT NULL,
  status    text NOT NULL,
  note      text,
  PRIMARY KEY (tenant_id, ticket_id)
);

CREATE TABLE IF NOT EXISTS sandbox.soc_webhook_sink (
  tenant_id    text NOT NULL,
  delivery_id  text NOT NULL,
  operation_id text NOT NULL,
  url          text NOT NULL,
  body_digest  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, delivery_id)
);
