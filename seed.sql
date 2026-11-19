-- Optional seed data (D1 database: bcms)
-- Run: npm run db:seed:local  /  npm run db:seed:remote

INSERT OR IGNORE INTO content (title, slug, type, status, excerpt, body) VALUES
  ('Welcome to AMS CMS', 'welcome', 'page', 'published',
   'Your aligned CMS is live on Cloudflare.',
   '# Welcome

This page was seeded into the **bcms** D1 database.

Edit it from the admin UI, or via the API:

- `GET /api/content`
- `POST /api/content`'),
  ('Getting started', 'getting-started', 'post', 'draft',
   'How to deploy this CMS to Cloudflare.',
   '1. Create the D1 database named **bcms**
2. Create the KV namespace named **bcms**
3. Run migrations
4. Deploy the Worker');
