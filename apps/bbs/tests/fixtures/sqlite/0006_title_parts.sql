-- Title parts: season / team / topic / generic labels split from `title` by
-- `wenku_core::title::split` when a title is written, so readers never re-parse
-- and the parts can become facets later. `title_labels` is a JSON array.
-- NULL `title_topic` marks rows written before this migration: readers split
-- `title` on the fly and `wenku retitle` backfills the columns.
ALTER TABLE articles ADD COLUMN title_season TEXT;
ALTER TABLE articles ADD COLUMN title_team TEXT;
ALTER TABLE articles ADD COLUMN title_topic TEXT;
ALTER TABLE articles ADD COLUMN title_labels TEXT;
