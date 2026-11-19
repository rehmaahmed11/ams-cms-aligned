# AMS CMS — Aligned

A deploy-ready CMS running entirely on **Cloudflare Workers**, with:

| Resource | Name | Binding | Purpose |
|----------|------|---------|---------|
| **D1 Database** | `bcms` | `DB` | Content + settings tables |
| **KV Namespace** | `bcms` | `KV` | Settings + content-list cache (60s) |

Stack: Cloudflare Worker (plain JavaScript, no build step) + D1 + KV.

---

## Quick deploy (Cloudflare)

### 1. Install & log in

```bash
npm install
npx wrangler login
```

### 2. Create the D1 database named `bcms`

```bash
npm run db:create
# wrangler d1 create bcms
```

Copy the returned `database_id` into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "bcms"
database_id = "<paste-database-id-here>"
```

### 3. Create the KV namespace named `bcms`

```bash
npm run kv:create
# wrangler kv namespace create bcms
```

Copy the returned `id` (and `preview_id`) into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "KV"
id = "<paste-kv-id-here>"
preview_id = "<paste-kv-preview-id-here>"
```

> In the Cloudflare dashboard this namespace will appear as **bcms**.

### 4. Apply the database schema

```bash
npm run db:migrate:remote
# optional seed data:
npm run db:seed:remote
```

### 5. (Recommended) Protect writes with a token

```bash
npx wrangler secret put ADMIN_TOKEN
# paste a strong random token, e.g. from: openssl rand -hex 32
```

If `ADMIN_TOKEN` is not set, create/edit/delete are open — fine for local dev only.

### 6. Deploy

```bash
npm run deploy
# wrangler deploy
```

Your CMS will be live at `https://ams-cms-aligned.<your-subdomain>.workers.dev`

Open it in a browser → paste your `ADMIN_TOKEN` in the sidebar → create content.

---

## Local development

```bash
cp .dev.vars.example .dev.vars   # then edit ADMIN_TOKEN
npm run db:migrate:local         # create tables in local D1
npm run db:seed:local            # optional demo content
npm run dev                      # wrangler dev → http://localhost:8787
```

Local D1/KV are simulated by Wrangler — no real IDs needed to run `wrangler dev`.

---

## API

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/` | Admin UI |
| `GET` | `/api/health` | D1 + KV status |
| `GET` | `/api/stats` | Content counts |
| `GET` | `/api/content?status=published&type=post` | List content (KV-cached 60s) |
| `POST` | `/api/content` | Create content |
| `GET` | `/api/content/:id` | Get one item |
| `PUT` | `/api/content/:id` | Update one item |
| `DELETE` | `/api/content/:id` | Delete one item |
| `GET` | `/api/settings` | Get settings (KV) |
| `PUT` | `/api/settings` | Save settings (KV) |
| `POST` | `/api/cache/clear` | Clear KV content cache |

Writes (`POST`/`PUT`/`DELETE`) require `Authorization: Bearer <ADMIN_TOKEN>` when the token is set.

```bash
curl https://ams-cms-aligned.<subdomain>.workers.dev/api/content
curl -X POST https://ams-cms-aligned.<subdomain>.workers.dev/api/content \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"title":"Hello","slug":"hello","type":"post","status":"published","body":"# Hello"}'
```

---

## Project structure

```
wrangler.toml          # Worker + D1 (bcms) + KV (bcms) bindings
package.json           # scripts: dev / deploy / db:* / kv:create
src/index.js           # Worker: API + admin UI (single file, no build)
migrations/0001_init.sql  # D1 schema
seed.sql               # Optional demo content
.dev.vars.example      # Local secrets template
```

## Notes

- **Database name is `bcms`** and **KV namespace name is `bcms`** — both are set in `wrangler.toml` and in the `db:create` / `kv:create` scripts.
- The content list is cached in KV for 60 seconds and automatically invalidated on every create/update/delete.
- The Worker auto-creates tables if migrations haven't run yet, so the API never crashes on a fresh database.
