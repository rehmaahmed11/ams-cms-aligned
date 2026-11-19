-- AMS CMS — initial schema (D1 database: bcms)

CREATE TABLE IF NOT EXISTS content (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  type        TEXT NOT NULL DEFAULT 'page',      -- page | post | ...
  status      TEXT NOT NULL DEFAULT 'draft',     -- draft | published
  excerpt     TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  cover_image TEXT NOT NULL DEFAULT '',
  meta        TEXT NOT NULL DEFAULT '{}',        -- JSON string
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_content_slug   ON content (slug);
CREATE INDEX IF NOT EXISTS idx_content_status ON content (status);
CREATE INDEX IF NOT EXISTS idx_content_type   ON content (type);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO settings (key, value) VALUES ('site_name', 'AMS CMS');
INSERT OR IGNORE INTO settings (key, value) VALUES ('site_tagline', 'Aligned content management');
