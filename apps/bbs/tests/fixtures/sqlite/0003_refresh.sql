-- Refresh queue: readers of a stale article ask for it to be fetched again in
-- the background; the row stays visible (status unchanged) until the new
-- content lands. `content_changed_at` lets the AI queue ignore refreshes that
-- brought back identical text.
ALTER TABLE articles ADD COLUMN refresh_requested_at INTEGER;
ALTER TABLE articles ADD COLUMN content_changed_at INTEGER;
UPDATE articles SET content_changed_at = fetched_at WHERE fetched_at IS NOT NULL;
CREATE INDEX articles_refresh_idx ON articles(source_id, refresh_requested_at) WHERE refresh_requested_at IS NOT NULL;

ALTER TABLE poll_runs ADD COLUMN refreshed INTEGER NOT NULL DEFAULT 0;
