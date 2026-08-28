-- AI layer: per-article overview + knowledge-base entry, image captions,
-- entities for cross-article linking, and a search index over the KB text.

CREATE TABLE article_ai (
    article_id        TEXT PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
    status            TEXT NOT NULL DEFAULT 'pending',   -- pending | ready | failed
    prompt_version    TEXT NOT NULL,
    model             TEXT,
    -- Hash of the exact material sent to the model; unchanged hash + same
    -- prompt version means nothing to regenerate.
    context_hash      TEXT,
    -- The material itself (body, attachment text, README, image list), kept so
    -- chat can reuse the identical prefix and hit the provider's prompt cache.
    context_text      TEXT,
    overview_json     TEXT,
    kb_json           TEXT,
    images_json       TEXT,
    attempts          INTEGER NOT NULL DEFAULT 0,
    error             TEXT,
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    cached_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd          REAL NOT NULL DEFAULT 0,
    generated_at      INTEGER,
    updated_at        INTEGER NOT NULL
);
CREATE INDEX article_ai_status_idx ON article_ai(status, updated_at);
CREATE INDEX article_ai_generated_idx ON article_ai(generated_at);

ALTER TABLE article_images ADD COLUMN caption TEXT;
ALTER TABLE article_images ADD COLUMN image_kind TEXT;
ALTER TABLE article_images ADD COLUMN image_text TEXT;

-- Canonical names the model extracted (型号、算法、拓扑…). `key` is the
-- lookup form (lowercase, alphanumeric only); `name` keeps the first spelling.
CREATE TABLE kb_entities (
    key           TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    article_count INTEGER NOT NULL DEFAULT 0,
    updated_at    INTEGER NOT NULL
);
CREATE INDEX kb_entities_count_idx ON kb_entities(article_count DESC, name);

CREATE TABLE article_entities (
    article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    entity_key TEXT NOT NULL REFERENCES kb_entities(key) ON DELETE CASCADE,
    PRIMARY KEY (article_id, entity_key)
);
CREATE INDEX article_entities_entity_idx ON article_entities(entity_key);

CREATE VIRTUAL TABLE kb_search USING fts5(
    article_id UNINDEXED,
    tldr,
    problem,
    approach,
    components,
    parameters,
    decisions,
    pitfalls,
    entities,
    keywords,
    captions,
    tokenize = 'trigram'
);
