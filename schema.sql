-- medbook-rag schema.  Works on SQLite >= 3.34 (trigram tokenizer) and Cloudflare D1.
-- Plain tables are the source of truth; the two FTS5 tables are derived and can be rebuilt with
-- the INSERT ... SELECT statements at the bottom (this is also how D1 is populated).

CREATE TABLE IF NOT EXISTS books (
  book_id   TEXT PRIMARY KEY,
  title     TEXT NOT NULL,
  edition   TEXT,
  publisher TEXT,
  pub_year  INTEGER,
  kind      TEXT NOT NULL DEFAULT 'book'          -- book | guideline
);

CREATE TABLE IF NOT EXISTS chapters (
  chapter_id       TEXT PRIMARY KEY,               -- '<book_id>:ch01'
  book_id          TEXT NOT NULL,
  chapter_no       INTEGER,
  title            TEXT,
  page_start       INTEGER,
  page_end         INTEGER,
  source_format    TEXT,
  text_reliability TEXT,                           -- copied from the transcription frontmatter
  notes            TEXT
);

CREATE TABLE IF NOT EXISTS sections (
  section_id          TEXT PRIMARY KEY,            -- '<chapter_id>:A'
  chapter_id          TEXT NOT NULL,
  letter              TEXT,
  title               TEXT,
  page_start          INTEGER,
  page_end            INTEGER,
  author              TEXT,
  transcription_notes TEXT
);

-- "parent" = the unit we hand to the model for context (small-to-big retrieval)
CREATE TABLE IF NOT EXISTS parents (
  parent_id  TEXT PRIMARY KEY,
  chapter_id TEXT NOT NULL,
  book_id    TEXT NOT NULL,
  section_id TEXT,
  path       TEXT,
  page_start INTEGER,
  page_end   INTEGER,
  text       TEXT NOT NULL,
  char_count INTEGER
);

CREATE TABLE IF NOT EXISTS chunks (
  chunk_id         TEXT PRIMARY KEY,
  chapter_id       TEXT NOT NULL,
  book_id          TEXT NOT NULL,
  seq              INTEGER,
  parent_id        TEXT,
  section_id       TEXT,
  path             TEXT,
  kind             TEXT NOT NULL,                  -- body|key_points|table|figure|figure_aid|references
  provenance       TEXT NOT NULL,                  -- book | transcriber
  page_start       INTEGER,
  page_end         INTEGER,
  page_label       TEXT,
  text             TEXT NOT NULL,
  index_text       TEXT NOT NULL,                  -- NFKC, markup stripped, heading path prepended
  bigram           TEXT NOT NULL,                  -- bigram tokens of index_text (see ingest/tokenize.py)
  figure_id        TEXT,
  image            TEXT,
  author           TEXT,
  numeric_critical INTEGER NOT NULL DEFAULT 0,
  numeric_flags    TEXT,
  transcriber_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_chunks_parent ON chunks(parent_id);
CREATE INDEX IF NOT EXISTS idx_chunks_book_kind ON chunks(book_id, kind);

CREATE TABLE IF NOT EXISTS refs (
  ref_id     TEXT PRIMARY KEY,
  chapter_id TEXT NOT NULL,
  section_id TEXT,
  label      TEXT,
  text       TEXT,
  pmid       TEXT,
  page_start INTEGER
);

CREATE TABLE IF NOT EXISTS chunk_refs (
  chunk_id TEXT NOT NULL,
  ref_id   TEXT NOT NULL,
  PRIMARY KEY (chunk_id, ref_id)
);

CREATE TABLE IF NOT EXISTS issues (
  issue_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  chapter_id TEXT,
  chunk_id   TEXT,
  section_id TEXT,
  level      TEXT,                                 -- error|warn|info
  code       TEXT,
  message    TEXT,
  source     TEXT                                  -- ingest | conversion-log | manual
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_tri USING fts5(chunk_id UNINDEXED, content, tokenize='trigram');
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_bi  USING fts5(chunk_id UNINDEXED, content, tokenize='unicode61');
