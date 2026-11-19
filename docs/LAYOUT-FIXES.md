# CMSv3 — what's in this package

EdgeCMS 0.9.0 with a full admin-panel layout pass. **All changes are CSS, HTML
markup and ARIA** — no logic, database, routing or theme-engine changes.

---

## Quick start (Node)

Requires **Node 22+** (uses the built-in `node:sqlite`).

```bash
cd cmsv3
node --disable-warning=ExperimentalWarning dist/server.mjs
```

`dist/` is a **pre-built, fully bundled** build: it needs no `npm install` and no
`node_modules`. It imports only Node built-ins, so you can copy those four files
somewhere and run them.

Environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | bind address |
| `DATA_DIR` | `./data` | SQLite DB + uploaded media |
| `DB_PASSWORD` | — | optional; 8+ chars encrypts the database |

First run prints a message and serves the installer at `/install`. There is no
`/install` once installed.

From source instead of the bundle:

```bash
npm install
npm run build      # writes dist/
npm start          # build + run
npm run typecheck  # tsc --noEmit
```

## Cloudflare Workers

```bash
npm install
npx wrangler deploy
```

`wrangler.toml` is included. Note that the Worker build is produced by wrangler
from `src/`, not from the Node bundle in `dist/`.

---

## The layout work

Everything below was measured in a real browser before and after. Full detail,
including the reasoning and the numbers, is in **`LAYOUT-FIXES.md`** at the repo root.

### 1. Sidebar alignment

The rail had *two of everything* — two item heights, two icon columns, two label
columns — on all 21 screens. Root cause: a media-query override pulling section
items to 8px inline padding while foot items kept 12px.

| | before | after |
|---|---|---|
| Item heights | 34.39px **and** 35.50px | **36px** |
| Icon x | 16px / 20px | **20px** |
| Label x | 42.39px / 50.39px | **50.39px** |
| Separators | 10 hairlines | 3 group headings |

### 2. Sidebar design pass

Section headings (**Content / Design / System**), 14px medium labels stepping to
13px children, an accent-wash active state instead of a solid blue slab, a
1.25rem icon size, a 1px guide rail tying submenu children to their parent, and
a foot pinned to the bottom with a quiet collapse switch instead of a filled box.

### 3. Dashboard

- `ul.stats` had **no CSS rule at all** — it kept the browser's
  `padding-left: 40px`, `margin-top: 14px` and bullets, pushing all three stat
  cards 40px right of everything else. Reset.
- Stat cards now show icon beside the number instead of stacked.
- **Equal** card widths, with the row flush to the container edge.
- The right column is exactly one stat card wide, so "At a glance" matches the
  card above it (was 428px against 373px).
- Fixed a doubled gap: `.card`'s 16px margin **added** to the flex 16px gap,
  giving 32px between two cards while the rest of the page was 16px.
- Card headings now carry the card's inner padding, so a heading is 16px from the
  edge instead of 1px jammed in the corner, matching its own body text.

### 4. Consistency across all screens

- **8 hand-rolled page headers** (`settings`, 5 `tools` sub-pages, `plugins`,
  `system`, `users`) now use the shared `pageHead()`.
- Every screen has a **uniform 16px** card gap.
- Form fields stop at a readable 48rem instead of spanning 1150px.
- Inputs, selects and buttons share one control height (a search box had been
  3px shorter than its neighbour).
- Media gallery tiles are uniform height with aligned action rows.

### 5. Mobile

- `/terms` no longer scrolls the whole page sideways — its table was the only one
  not wrapped in `.table-wrap`. It now stacks into cards like the posts list.
- **0px horizontal overflow** on all 15 screens at 390px.

### 6. Accessibility

- `--muted` raised from 4.35:1 / 4.01:1 to **4.90 / 4.51** (AA).
- Sort arrow from 1.70:1 to **4.59**.
- Duplicate `palette-cmd-*` ids in every command-palette group fixed.
- Account-menu label no longer fails WCAG 2.5.3.
- `aria-prohibited-attr` fixed in the bundled theme partials.
- **axe: 0 violations**; panel contrast failures **0**.

---

## Verification state

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `npm run build` | clean |
| Unit + integration suite (141 tests) | **141 / 141 pass** |
| Cloudflare e2e (`test:cloudflare`, 38 tests) | 33 pass, **5 pre-existing failures** |
| axe (public site) | 0 violations |
| Panel contrast | 0 failures |
| Horizontal overflow, 15 screens @ 390px | 0px |

### About the 5 Cloudflare e2e failures

These are **not** caused by the layout work and are not regressions. They assert
against demo content that the installer used to create:

```
tests/e2e.mjs:218  assert.match(dash.text, /<b>14<\/b><span>Pages/)   // installer now seeds 1 page
tests/e2e.mjs:384  assert.equal(api.total, 9)                         // "Eight demo posts are seeded at install"
tests/e2e.mjs:460  assert.equal(...total, 9)
tests/e2e.mjs:820  assert.deepEqual(nav(...), ['Home=/', 'Blog=/blog', 'About=/about', ...])
tests/e2e.mjs:1087 'the top bar is on by default'
```

`src/routes/install.ts` now seeds exactly one starter home page (line 140) and
no demo posts or demo menu. The dashboard markup those tests match
(`<b>N</b><span>Label`) is intact — the values are just 1/0/0 instead of 14/8/0.
All 141 Node-runtime tests pass because they don't depend on that seed.

Fix options if you want a green suite: either update those five assertions to the
current seed, or restore the demo-content seeder at install.

---

## What is deliberately not included

- `node_modules/` — run `npm install` if you want to build from source.
- `data/` — no database or uploads are packaged.
- `.dev.vars`, `.wrangler/` — no local secrets or caches.
