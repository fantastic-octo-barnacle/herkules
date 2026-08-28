-- Timestamps are Unix milliseconds. IDs generated locally are ULIDs.

CREATE TABLE sources (
    id                    TEXT PRIMARY KEY,
    kind                  TEXT NOT NULL,
    name                  TEXT NOT NULL,
    site_url              TEXT NOT NULL,
    enabled               INTEGER NOT NULL DEFAULT 1,
    backfill_next_page    INTEGER NOT NULL DEFAULT 2,
    backfill_completed_at INTEGER,
    initialized_at        INTEGER,
    last_checked_at       INTEGER,
    created_at            INTEGER NOT NULL,
    updated_at            INTEGER NOT NULL
);

CREATE TABLE articles (
    id                 TEXT PRIMARY KEY,
    source_id          TEXT NOT NULL REFERENCES sources(id),
    source_article_id  TEXT NOT NULL,
    canonical_url      TEXT NOT NULL,
    url_hash           TEXT NOT NULL,
    title              TEXT NOT NULL,
    author             TEXT,
    published_at       INTEGER,
    discovered_at      INTEGER NOT NULL,
    fetched_at         INTEGER,
    listing_position   INTEGER NOT NULL DEFAULT 0,
    is_pinned          INTEGER NOT NULL DEFAULT 0,
    introduction       TEXT,
    content_format     TEXT,
    content_raw        TEXT,
    body_text          TEXT,
    content_hash       TEXT,
    parser_version     TEXT,
    status             TEXT NOT NULL DEFAULT 'pending',
    skip_reason        TEXT,
    last_error         TEXT,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL
);
CREATE UNIQUE INDEX articles_source_article_uq ON articles(source_id, source_article_id);
CREATE UNIQUE INDEX articles_source_url_uq ON articles(source_id, url_hash);
CREATE INDEX articles_status_idx ON articles(source_id, status, updated_at);
CREATE INDEX articles_order_idx ON articles(published_at DESC, discovered_at DESC, listing_position ASC);

CREATE TABLE article_tags (
    article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    tag        TEXT NOT NULL,
    PRIMARY KEY (article_id, tag)
);
CREATE INDEX article_tags_tag_idx ON article_tags(tag);

CREATE TABLE article_links (
    id         TEXT PRIMARY KEY,
    article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    url        TEXT NOT NULL,
    kind       TEXT NOT NULL,
    label      TEXT,
    position   INTEGER NOT NULL,
    UNIQUE (article_id, url)
);

CREATE TABLE article_images (
    id         TEXT PRIMARY KEY,
    article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    url        TEXT NOT NULL,
    alt        TEXT,
    position   INTEGER NOT NULL,
    UNIQUE (article_id, url)
);

CREATE TABLE poll_runs (
    id          TEXT PRIMARY KEY,
    source_id   TEXT NOT NULL REFERENCES sources(id),
    trigger     TEXT NOT NULL,
    status      TEXT NOT NULL,
    started_at  INTEGER NOT NULL,
    finished_at INTEGER,
    listed      INTEGER NOT NULL DEFAULT 0,
    discovered  INTEGER NOT NULL DEFAULT 0,
    fetched     INTEGER NOT NULL DEFAULT 0,
    skipped     INTEGER NOT NULL DEFAULT 0,
    failed      INTEGER NOT NULL DEFAULT 0,
    error       TEXT
);
CREATE INDEX poll_runs_started_idx ON poll_runs(source_id, started_at DESC);

-- Abuse-guard state survives restarts so a crash loop cannot hammer the source.
CREATE TABLE source_guard_state (
    source_id  TEXT PRIMARY KEY,
    state_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    github_id     INTEGER NOT NULL UNIQUE,
    github_login  TEXT NOT NULL,
    avatar_url    TEXT,
    created_at    INTEGER NOT NULL,
    last_login_at INTEGER NOT NULL
);

CREATE TABLE sessions (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expires_idx ON sessions(expires_at);

-- Trigram tokenizer gives substring matching, which is what Chinese queries need.
CREATE VIRTUAL TABLE article_search USING fts5(
    article_id UNINDEXED,
    title,
    author,
    tags,
    introduction,
    body_text,
    tokenize = 'trigram'
);
