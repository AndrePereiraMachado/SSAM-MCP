-- The token records of the served MCP (server-tokens-pg.mjs), one row per tokens.json record of schema
-- ssam-server-tokens/1: the two secrets only as SHA-256 (hex), the customer, the dates, the lanes. The columns are the
-- fields of the record; `record` keeps the whole record as it was written, so a field a later server adds is never lost
-- by an older one (the file never dropped unknown fields either).
CREATE TABLE server_tokens (
  id               text PRIMARY KEY,
  customer         text NOT NULL,
  created_at       timestamptz NOT NULL,
  expires_at       timestamptz,
  revoked_at       timestamptz,
  token_sha256     text NOT NULL,
  agent_sha256     text,
  agent_issued_at  timestamptz,
  lanes            text[] NOT NULL DEFAULT ARRAY['odc', 'o11'],
  record           jsonb NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX server_tokens_token_sha256 ON server_tokens (token_sha256);
CREATE UNIQUE INDEX server_tokens_agent_sha256 ON server_tokens (agent_sha256) WHERE agent_sha256 IS NOT NULL;
