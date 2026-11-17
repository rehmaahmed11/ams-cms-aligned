# Edge CMS — deep study of `CMS/` (CMSV1.zip)

**Source archive:** `CMS/CMSV1.zip` (671 KB) → contained one folder, `ams-builds.online-main/`.
Extracted flat into `CMS/`, archive deleted. **150 files, ~36k lines, 2.3 MB.**
Package `edge-cms@0.9.0`, private, ESM, Node ≥ 22.13.

Everything below was verified by reading the source *and* running it: `tsc --noEmit`,
`npm run build`, `npm run check:assets`, `npm run check:budgets`, the unit suites, the
HTTP/panel/E2E suites, and a live server (install → home page → JSON API).

---

## 1. What this product is

A WordPress-shaped CMS that runs as **one process with no external services**:

| Runtime | Database | Files | KV / config / cache | Cron |
|---|---|---|---|---|
| Cloudflare Worker | D1 | KV (`media:*` keys, 20 MB cap) | KV | Cron Trigger, 5 min |
| Node 22.13+ / Docker | SQLite file (`node:sqlite`) | `data/media/` on disk | `_kv` table in the same SQLite file | `setInterval`, 60 s |

Same app code, two storage shims (`src/node/storage.ts` re-implements D1 + KV + FileStore
against `node:sqlite`). No R2, no S3, no Postgres, no PHP, no native modules. Hono for
routing, esbuild for the build, zero runtime dependencies beyond `hono` and
`@hono/node-server`.

**Scale:** 88 source files, ~19.4k lines TypeScript, ~1.7k lines CSS, 6.1k lines of tests,
1.6k lines of docs. Roughly a 12–15k-line TS application once comments are discounted —
unusually well-documented (a short design essay heads almost every module).

---

## 2. Request lifecycle

```
app.use('*')  → install gate (KV `installed`)   /api/health exempt
app.route('/install'), app.route('/api')
app.all('*')  → getConfig(KV) → if path starts with `/{adminSlug}`:
                  strip prefix → admin sub-app (cfgFor WeakMap hand-off)
                else → public sub-app
```

* **Install lock** is a KV key. No flag ⇒ every URL 302s to `/install`; flag present ⇒
  `/install` is a permanent 404. The installer *also* checks D1 for an existing user, so
  KV's eventual consistency cannot let a second install slip through.
* **Per-isolate memo** (`installedMemo`) avoids a KV read per request; `resetInstallState()`
  is the one hook that clears it, because the factory reset deletes the flag in-process.
* **Config** (`adminSlug`, `secret`, `cacheV`, `primaryDomain`, `domains`) lives in one KV
  JSON value, read on every request — deliberately tiny.
* **CSRF/session** are signed with `cfg.secret` (HMAC-SHA256); the session MAC also covers
  the password hash, so **changing a password signs out every other device** for free.

---

## 3. Data model (`src/db/schema.sql`, 17 tables)

`sites`, `users`, `settings`, `media`, `content`, `content_revisions`, `content_lock`,
`terms`, `content_terms`, `content_pages`, `menus`, `menu_items`, `themes`, `theme_assets`,
`theme_versions`, `theme_settings`, `redirects`, `hooks`, `backups`, `audit_log`.

Design notes worth crediting:

* **`site_id` on every content table** (default 1) plus a `sites(hostname)` table — the
  multi-site door is left open without reshaping anything later. Still unused ("later" in
  the README); all queries hard-code `site_id=1`.
* **`content_pages`** — posts can be *assigned to CMS pages*, and a post with no row here is
  "main blog". `listPosts` uses `NOT EXISTS (...)` to keep assigned posts out of `/blog`,
  and `/feed.xml` does the same. That's a thoughtful content-architecture decision, not a
  feature bolted on.
* **Hierarchical pages** (`content.parent_id`), per-page icons, per-item `template`
  override, sticky `pinned`, `menu_order`.
* **`content_revisions` is append-only**, `content_lock` is advisory and expires.
* **Schema is split in two**: `schema.sql` is the full current schema the installer runs;
  `migrations/index.ts` is a forward-only list (v3…v13) that upgrades old databases. Both
  must be kept in step by hand — see §10.

---

## 4. Public site (`src/routes/public.ts`, 559 lines)

Route surface: `/`, `/search?q=`, `/blog`, `/blog/page/N`, `/category/{slug}`,
`/tag/{slug}`, `/{page-slug}`, `/{yyyy}/{mm}/{slug}` (dated permalinks), `/media/*`,
`/theme-assets/{slug}/{path}`, `/sitemap.xml`, `/robots.txt`, `/feed.xml`,
`/__pyapp/runner`, plus `?preview=1` (signed-in only) and `?theme=` (capability-gated).

* **Permalink styles**: `blog` (`/blog/slug`), `plain` (`/slug`), `dated` (`/2026/11/slug`),
  chosen per site in Settings.
* **Page cache**: rendered HTML in KV, TTL 24 h, key = `page:{cacheV}:{host}{path}`.
  Any mutation bumps `cacheV`, which invalidates the world. `X-Cache: HIT/MISS` is exposed
  for debugging. Sessions bypass the cache entirely (`private, no-store`).
* Search is *never* cached (the key omits the query string, so it is skipped deliberately).
* **CSP is real and per-response**: nonce minted per render (or read back out of cached
  HTML), `script-src 'self' 'nonce-…'`, `object-src 'none'`, `base-uri 'self'`,
  `frame-ancestors` relaxed to `'self'` only for `?preview=1`. Ships as
  `report-only` by default (`csp` setting: `off|report|enforce`) — the safe rollout order.
* **Media and theme assets are served sandboxed**: `nosniff`, immutable 1-year cache,
  ETag/304, and a `default-src 'none'; … sandbox` CSP so an uploaded SVG cannot run script
  in the site origin.
* **Page hierarchy + page-posts** are rendered *by the CMS*, not the theme, so any theme
  gets breadcrumbs, child-page cards and assigned-post grids for free — and the code checks
  whether the template already draws posts itself (`drawsPostsItself`) to avoid duplication.
* **Title follows the domain** (`lib/origin.ts`): an unrenamed title is derived from the
  request host, with `vercel.app` / `workers.dev` suffixes and preview hashes stripped. Nice
  touch for redeploys.
* **Landing screen**: an optional first-visit splash injected over `/` (not a CMS page), with
  an optional looping audio playlist from the media library, wearing the active theme's tokens.
* **Python apps**: `<figure class="python-app"><pre><code>…</code></pre></figure>` renders as a
  code listing without JS and becomes an iframe of `/__pyapp/runner` with JS. Pyodide runs
  **in the visitor's browser** inside a Web Worker inside a double-sandboxed iframe (opaque
  origin, no cookies/storage). Network APIs are stubbed out *before* author code runs.

---

## 5. Template engine v2 (`src/lib/template.ts` + `theme-store.ts`)

The strongest part of the codebase. **Templates are data, never code**: the parser builds a
small AST and the renderer walks it against a scope stack; there is no `eval`, no function
calls, and a test asserts a hostile template can't break out.

Supported: `{{v}}` / `{{{v}}}` (escaped/raw), dotted paths, `{{this}}`, `{{@index}}
{{@key}} {{@first}} {{@last}} {{@number}}`, `{{#if}}/{{#unless}}` with `and or not eq ne gt
gte lt lte` and parentheses, `{{#each rows limit=3}}` incl. objects and `{{else}}`,
`{{> partial}}`, `{{> @theme "name"}}` (cross-theme), pipe filters
(`date`, `truncate`, `default`, `upper`, `escape`, `slug`, `json`, …), `{{asset "x.png"}}`,
`{{#block content}}` layout inheritance, theme settings via `{{theme.key}}`, widget areas.

Themes are **packages**: `theme.json` v2/v3 manifest (slug, version, parent for inheritance,
templates map, partials map, css entry, assets, screenshot, `settings` schema with types,
widget areas, changelog, CMS compatibility, required/optional templates), shipped as a zip.
Upload limits: 6 MB zip, 512 KB/asset, 80 assets, 4 MB total. **SVG/HTML/PDF/XML refused on
purpose** because assets are served from your own origin. `src/lib/zip.ts` is a hand-rolled
ZIP reader on `DecompressionStream` with a decompressed-size cap *and* a compression-ratio
cap — a real zip-bomb defence.

Every activation writes a `theme_versions` snapshot first, which is what makes "Revert" work.
`theme_assets` indexes the binary blobs held in the file store under `themes/{slug}/{path}`.
The app itself ships **no theme** (`themes/blank.ts` is the unstyled fallback) — migration 13
deliberately removes every bundled theme so an install is a clean slate.

---

## 6. Admin panel (`src/routes/admin/*`, 6.8k lines)

116 routes across 18 route modules. Notable engineering:

* **Middlewares in order**: config + security headers + CSRF-for-every-non-GET → public
  asset routes → session guard → **error boundary** (`guardPage`) that turns a thrown route
  error into a styled page naming the route instead of a bare 500.
* **Capabilities instead of roles** (`lib/capabilities.ts`): 15 named permissions, three role
  bundles (`author`, `editor`, `admin`). Screens ask `can(user, 'manage_pages')`, so the
  role→permission map is one file instead of `can(user,'admin')` scattered through 40 routes.
* **Editor**: 1,355-line client script — formatting bar with shortcuts, link dialog, image
  blocks with caption/alt/link, drag anchors, paste-or-drop upload, paste-as-text, page
  breaks, word count, slug preview, mark-up tidying, **autosave**, **revisions with line
  diff**, **advisory edit locks** with heartbeat/takeover.
* **Media**: library with grid/list, type/month/search filters, bulk delete, alt-text repair
  view linked from the dashboard; browser-side **size-targeted WebP compression** before
  upload (`admin/media-compress.ts`), with originals kept when already small/animated/vector.
* **Appearance hub**: design tokens (~92 in `tokens.css`), signed-cookie **live preview**
  channel (`lib/preview.ts` — never query-string, never cached, `HttpOnly SameSite=Strict`,
  30-min TTL), per-theme settings form generated from the manifest, widget areas, identity
  (logo/social), per-page templates.
* **Tools**: redirects, import/export v2, backups, site health, audit log, factory reset
  (`lib/reset.ts` — drops CMS tables, empties runtime tables, purges files and KV, clears
  both the schema probe cache and the install memo).
* **i18n**: panel strings go through `t()` with a single `en` catalogue; a test asserts every
  key used in source exists. Coverage today: **72 call sites, 95 keys** — the mechanism is
  real but only applied to part of the panel (§10).
* **Performance budgets are enforced**, not aspirational: `lib/budgets.ts` states 4 limits,
  `scripts/measure.mjs` measures the *built* bundle and fails `npm test` if exceeded. The
  panel displays the measured numbers so limits are visible where the site is managed.

---

## 7. Security review (what I checked, not just what's claimed)

**Solid:**
- PBKDF2-SHA256, 100k iterations (Workers' ceiling), per-password salt, `timingSafeEqual`
  compare; login always runs PBKDF2 even for unknown users so timing doesn't leak existence.
- Session cookie: HttpOnly, `SameSite=Lax`, `Secure` when HTTPS, HMAC-signed, MAC bound to
  password hash. CSRF: signed double-submit (`HMAC(secret,'csrf:'+cookie)`) **plus** an
  Origin check on every state-changing request. 5 failed logins / IP / 15 min via KV counter.
- Allow-list HTML sanitizer for non-admin content: tag/attr allow-lists, `safeUrl`,
  YouTube-embed-only iframes, a *value-checked* inline-style subset
  (`safeStyle`), forced `rel="noopener noreferrer"` on `target="_blank"`, and whole-element
  dropping of `script/style/svg/math/form/…`. Admins may save raw HTML — documented as such.
- Uploads: extension decides Content-Type (browser MIME never trusted), SVG uploads are
  admin-only and served under a `sandbox` CSP, `..` traversal blocked in both `/media/*` and
  `/theme-assets/*`, backups prefix not servable.
- SQL: everything I sampled is parameterised; ORDER BY fragments come from a fixed
  `sortSql` map, `direction` is a two-value ternary. No user string reaches a query
  unbound. `PRAGMA table_info(${table})` uses a validated identifier.
- `X-Frame-Options: DENY` on the panel, `noindex` on the panel and on previews, factory reset
  and version screen behind `manage_tools` / `manage_updates`.
- Optional `DB_PASSWORD` on Node: PBKDF2 hash stored beside the data, checked *before* the
  server listens, `DB_PASSWORD_UNLOCK=1` escape hatch, `0700/0600` file modes. Honestly
  documented as an access check, not encryption at rest.

**Worth knowing (not exploitable as written, but real):**
1. **Rate limiting is KV-based** → on Cloudflare it is per-colo and eventually consistent; a
   distributed password spray can exceed 5/15-min per IP. Acceptable, worth stating.
2. **Sanitizer is regex-based.** It handles the malformed-markup cases I threw at it, but a
   regex allow-list sanitiser is the class of code that eventually loses. Every bypass would
   need a *non-admin* author account, so blast radius is limited — still the highest-risk
   component in the repo.
3. **Page cache serves a stale CSP nonce** for up to 24 h (documented in a comment). The
   nonce is in the HTML, so this is fine in practice; it means "nonce rotates per hour at
   most", not per request, for anonymous visitors.
4. `clientIp()` falls back to the literal `'local'` when there's no `cf-connecting-ip` — so
   behind a proxy without trust configured, **all users share one rate-limit bucket** (DoS on
   login by exhausting it). `TRUST_PROXY=1` fixes it; the default is the safe one anyway.
5. Preview cookies are `SameSite=Strict` + `HttpOnly` + signed and path-scoped — good — but
   the signing key is the same `cfg.secret` used for sessions/CSRF (domain-separated by
   prefix strings, so fine; just noting the single-key design).

---

## 8. What I actually ran (Node 22.20; the sandbox ships Node 20, which fails on `node:sqlite`)

| Command | Result |
|---|---|
| `npx tsc --noEmit` (strict) | **clean, 0 errors** |
| `npm run build` (esbuild) | clean; `dist/server.mjs` 1.03 MB, plus 3 library bundles |
| `npm run check:assets` | 92 design tokens, 70 referenced; all asset budgets met (largest 34.6 KB) |
| `npm run check:budgets` | public page 4.6/45 KB · panel HTML 49/60 KB · CSS 17.9/25 KB · JS 28.6/30 KB — **all met but JS at 95% and HTML at 82%** |
| `template + origin + landing` tests | 24/24 pass |
| `panel + system` tests | 65/65 pass (CSRF, login by email, DB password, factory reset, …) |
| `editor + pyapp` tests | pass, incl. 21 Python samples executed in real Pyodide |
| **full `tests/e2e.mjs`** | **4 of 78 fail** — see below |
| live boot (`PORT=8899`) | `/api/health` 200 (db+kv+media ok), `/`→`/install`, install wizard → home page renders, `/api/posts` JSON ok |

### The 4 E2E failures are test-suite drift, not product bugs

`tests/e2e.mjs` still asserts content that the product stopped creating:

| Failing test | Expects | Reality |
|---|---|---|
| `5. admin panel …` | dashboard `<b>14</b> Pages`, `<b>8</b> Posts` | install seeds **1 page, 0 posts** (test comment literally says "the installer seeds a home page plus demo pages and posts") |
| `8. posts …` | `/api/posts` `total === 9` (8 seeded + 1) | `total === 1` |
| `9. drafts/scheduled` | seeded demo content | none seeded |
| `12a. menus …` | Pages named *Movies*, *Bollywood*, *Hollywood* | no such pages exist anywhere in `src/`, which contradicts `test 4`'s assertion that no theme is bundled |

So `npm test` is **red on a fresh checkout at 0.9.0** (~74/78 E2E + everything else green).
Fix is small: either seed the demo content in `install.ts`, or rewrite those four tests against
a 1-page/0-post install. I'd do the latter — the product's "clean slate" stance is deliberate.

---

## 9. Architecture verdict

**Strengths**
- One deployable, two runtimes, zero managed services beyond D1/KV. Deployment story is
  genuinely honest (free-plan limits, Termux, Docker, Cloudflare one-click).
- Cache invalidation is a single generation counter — simple and correct.
- Theme engine: data-only templates, inheritance, packages, versions/rollback, CSP-aware
  asset serving. This is better than most hobby CMS theme systems.
- Capabilities-over-roles, audit log with retention, enforced byte budgets, `t()` catalogue
  with a CI check, forward-only migrations with a tolerant-statement mechanism.
- Comments were **removed** deliberately (migration 12 drops the table and its settings)
  rather than left rotting — a good sign about maintenance intent.
- Documentation is *design documentation*: each module explains the constraint that shaped it.

**Weaknesses / risks**
1. **Monolith files**: `routes/admin/content.ts` 1,934 lines, `admin/editor-js.ts` 1,355,
   `routes/admin/themes.ts` 1,052, `lib/template.ts` 768. Readable, but the next refactor
   gets harder each release.
2. **Two sources of schema truth** (`schema.sql` vs. `migrations`) — every new column must be
   added in both, and the tolerant-`ADD COLUMN` trick only covers "duplicate column".
3. **KV as a database** on Cloudflare: 1,000 writes/day free tier, 25 MB per value, page cache
   and media share the quota, rate limiting is per-colo. Fine for the stated audience, sharp
   edge past it.
4. **i18n is half-applied**: 95 keys for 18 route modules — the mechanism exists but the bulk
   of the panel is still inline English.
5. **`site_id` is scaffolding, not a feature** — "multi-site: later" and every query hard-codes 1.
6. **E2E suite is stale** (§8) and the `e2e.cloudflare.mjs` runner needs wrangler/network, so
   the "same tests on both runtimes" promise isn't regularly exercised.
7. **`docs/panel-overhaul-roadmap.md` is a 652-line historical proposal** that still describes
   problems already fixed (no revisions, no autosave, 31 KB inline CSS). It's archaeology, not
   current truth — and it contradicts the README in places.
8. **Two large `.patch` files** (`final-ams-update.patch` 2,492 lines,
   `ams-builds.online-tools-and-privacy.patch` 227) sit in the repo root next to the code they
   patch, with no README note on whether they still apply. They look like release artifacts
   that should live in a changelog or be deleted.
9. **Version lag**: `package.json` 0.9.0, `APP_VERSION` 0.9.0, `SCHEMA_VERSION` 13 — consistent
   today, but three places to bump per release.
10. `landing_enabled` defaults **on**, with audio autoplay-ish affordances — a first-visit
    splash that most site owners will not expect to be enabled by default.

---

## 10. If I were the maintainer, next five moves

1. **Green the suite**: rewrite `tests/e2e.mjs` tests 5, 8, 9, 12a for the 1-page/0-post
   install (or add an explicit `SEED_DEMO=1` fixture). A red `npm test` on a fresh clone is the
   single most expensive bug in this repo.
2. **Split `routes/admin/content.ts`** into `content-list.ts` / `content-edit.ts` /
   `content-save.ts` behind the same router — mechanical, no behaviour change, halves the
   largest file.
3. **Generate the migration list from `schema.sql`** (or assert both in a test: install fresh,
   then run all migrations, and diff `PRAGMA table_info` against the installed schema).
   That closes the "two truths" risk permanently.
4. **Replace the hand-rolled sanitiser** with a small battle-tested one, or at minimum add a
   fuzz corpus of known-bypass payloads to `tests/`. Keep the CSP sandbox as the second layer.
5. **Delete or archive `docs/panel-overhaul-roadmap.md` and the two root `.patch` files**, and
   point the README's "Status" table at `APP_VERSION`. Three documents currently disagree about
   what the product does.

---

## 11. File map (where to look for what)

```
src/index.ts                  install gate · admin/public dispatch · cron
src/routes/public.ts          themed site, media, theme assets, sitemap/robots/feed, pyapp runner
src/routes/api.ts             read-only JSON API (+ /api/health)
src/routes/install.ts         3-step wizard, seeds home page + primary menu
src/routes/admin/index.ts     CSRF, login, dashboard, profile, error boundary, route mounting
src/routes/admin/content.ts   pages & posts lists, editor, save, bulk, order, revisions, locks (1.9k)
src/routes/admin/themes.ts    upload, preview, edit, export, rollback (1.0k)
src/routes/admin/appearance.ts tokens, live preview, per-theme settings, widgets (777)
src/routes/admin/tools.ts     redirects, import/export, backups, health, audit (687)
src/lib/template.ts           template engine v2 (AST, no eval) (768)
src/lib/theme-manifest.ts     theme.json validation, zip reading, inheritance, settings (695)
src/lib/render.ts             theme bundle → HTML, page cache keys, page hierarchy injection
src/lib/security.ts           esc · slugify · sanitizer · CSP · rate limit
src/lib/auth.ts               PBKDF2, signed sessions, CSRF, role levels
src/lib/capabilities.ts       15 capabilities, 3 role bundles
src/lib/content.ts            queries, permalinks, views, scheduled publish
src/lib/pyapp.ts / pyapp-bootstrap.ts   Pyodide in a sandboxed worker (890 combined)
src/lib/zip.ts                zip reader with bomb guards
src/lib/reset.ts              factory reset
src/node/server.ts            Node entry (PORT, DATA_DIR, TRUST_PROXY, DB_PASSWORD)
src/node/storage.ts           D1/KV/FileStore on node:sqlite + disk
src/db/schema.sql             17 tables (installer)
src/db/migrations/index.ts    forward-only v3…v13
tests/                        12 suites, 6.1k lines, incl. tests/fixtures/site-theme (a full v3 theme)
docs/                         panel guide, theme developer guide, theme spec, architecture, roadmap
```
