-- Personal access tokens for scripts and MCP clients. Only the SHA-256 of the
-- token is stored; `prefix` (the first characters) lets owners tell tokens
-- apart in a list. A token carries its owner's role and dies with the account.
CREATE TABLE api_tokens (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    prefix       TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER,
    expires_at   INTEGER,
    revoked_at   INTEGER
);
CREATE INDEX api_tokens_user_idx ON api_tokens(user_id, created_at);
