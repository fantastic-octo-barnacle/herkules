-- Reader accounts: any GitHub user may sign in; operators are marked by role.
-- Per-user data (favourites, notes, quotas) hangs off users.id and cascades
-- with it, so deleting a user removes everything they own.
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member';  -- admin | member
ALTER TABLE users ADD COLUMN disabled_at INTEGER;                   -- set to lock an account

-- Ledger of every model call. The global daily budget and the per-user chat
-- quota both read from here; user_id is NULL for background generation.
CREATE TABLE ai_usage (
    id                TEXT PRIMARY KEY,
    user_id           TEXT REFERENCES users(id) ON DELETE SET NULL,
    article_id        TEXT REFERENCES articles(id) ON DELETE SET NULL,
    kind              TEXT NOT NULL,          -- generate | chat
    model             TEXT NOT NULL,
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    cached_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd          REAL NOT NULL DEFAULT 0,
    created_at        INTEGER NOT NULL
);
CREATE INDEX ai_usage_created_idx ON ai_usage(created_at);
CREATE INDEX ai_usage_user_idx ON ai_usage(user_id, created_at);

-- Carry existing generation spend into the ledger so totals stay continuous.
INSERT INTO ai_usage (id, user_id, article_id, kind, model, prompt_tokens, cached_tokens,
                      completion_tokens, cost_usd, created_at)
SELECT 'legacy-' || article_id, NULL, article_id, 'generate', COALESCE(model, ''),
       prompt_tokens, cached_tokens, completion_tokens, cost_usd, generated_at
FROM article_ai
WHERE generated_at IS NOT NULL;
