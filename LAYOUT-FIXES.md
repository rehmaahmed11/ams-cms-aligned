# Layout, spacing and alignment fixes — EdgeCMS admin panel

Scope: CSS + HTML only (spacing, alignment, placement). No logic refactors, no redesign.
Everything below was measured in a real browser before and after the change.

Build state: `tsc --noEmit` clean · `npm run build` clean · **141/141 tests pass** · axe: **0 violations**

---

## 1. Sidebar — the big one

The rail had **two of everything**: two item heights, two icon columns, two label
columns. Measured on all 21 screens at 1440px, identical everywhere.

| | before | after |
|---|---|---|
| Item heights | 34.39px and 35.50px | **36px** everywhere |
| Icon x-position | 16px (section) / 20px (foot) | **20px** everywhere |
| Label x-position | 42.39px / 50.39px | **50.39px** everywhere |
| Separators | 10 hairlines, one between every item | **2**, one per section group |
| Sub-link x | 50.39px (misaligned with its parent label at 42.39px) | **50.39px — exactly the parent label's edge** |

**Root cause I found:** in `app.css` inside the `@media (min-width: 768px)` block,
`.rail__item { padding: var(--space-2) var(--space-2) }` overrode the base 12px
inline padding — but only for *section* items. The foot items
(`.rail__foot button`) kept their own 12px rule. That single 4px difference
produced both misaligned columns.

Fixes in `src/admin/assets/app.css`:
- New token `--rail-row-h: 2.25rem` (`tokens.css`), with `2rem` in compact density.
  Applied as `min-height` to `.rail__item`, `.rail__foot button` **and**
  `.rail__collapse`, so all three row types are the same height.
- Removed the padding override from the media query (kept only the gap).
- `.rail__foot button` font-size `--text-sm` → `--text-base`, matching section items.
- Separator inset now `var(--space-3)` on both sides so it starts at the icon
  column instead of 4px inside it.
- Child-link indent computed from the real geometry:
  `calc(var(--space-3) + 1.15rem + var(--space-3))`, and the links themselves now
  have zero left padding so text starts on the parent label's x.
- `.rail__sub a` given `min-height: 1.75rem` + flex centring (was 27.5px rows).

In `src/lib/ui.ts`:
- `NavGroup` gained an optional `group` field (`content` / `appearance` / `site`);
  the rail now emits **one separator per group change** instead of one per item.
  Ten hairlines read as a ruled list and fought the group spacing.

## 2. Dashboard

- **Stat cards** were icon-on-its-own-line → number → label, with the icon
  `margin-bottom: 8px` pushing everything down. Now a 2-column grid: icon
  vertically centred spanning both text rows, number and label stacked beside it.
  The row is fixed at 3 equal columns (was `auto-fit minmax(8.5rem)`, which put
  three cards on one row but at unpredictable widths); 1 column under 720px.
- **Card headers** holding only a title were 20px tall while ones holding a
  button or badge were 30px — so "Recently edited" and "At a glance" titles sat
  5px apart. `.card__head` now has `min-height: var(--control-h-sm)`.
- Header actions were bottom-aligned to a 3-line title block; the gap is now
  `var(--space-3) var(--space-4)` with wrapping allowed.

## 3. Page headers — 8 hand-rolled copies removed

`settings`, `tools` (5 sub-pages), `plugins` (3), `system`, `users` each built
their own header:

```html
<div class="row between" style="margin-bottom:1rem"><h1 style="margin:0">…</h1><a …></a></div>
```

That is why Settings had no bottom rule and its action link was plain text while
Posts had a full `page-head` with a divider and a button. All **8 now call
`pageHead()`** — same h1 size, same bottom border, same action-button baseline,
same 16px gap to the content.

## 4. Forms — unreadable 1150px fields

A settings input spanned the whole content column (1150px). Added
`--form-max: 48rem` and `--prose-max: 68ch` to `tokens.css`, applied to direct
children of `.card`; `.field-wide` opts a control back to full width.

## 5. Control alignment

- `input`/`select`/`textarea` got an explicit `height: var(--control-h)`,
  `box-sizing: border-box` and `line-height: 1.25`. Previously only
  `min-height` was set and padding was hard-coded `0.4rem`, so a search box sat
  3px shorter than the button next to it.
- `textarea { height: auto }` so the fixed height doesn't clamp multi-line fields.
- **Media toolbar** rebuilt on the shared control tokens: view toggle is now a
  proper segmented control, selects and buttons all `--control-h-sm`, search
  field aligned to the same baseline (it was 4px proud of the selects). The
  hand-rolled `0.2rem` radii and `0.84rem` type sizes are gone.
- **Media gallery**: thumbnails were 1.25:1 with the Delete/Copy buttons wrapping
  on narrow tiles, so cards differed in height by ~30px and the last row floated.
  Fixed to 4:3 thumbs, caption reserving both name and meta lines, action row
  pinned to the bottom with `margin-top: auto`, buttons `flex: 1 1 0`.
- `.media-heading-row` now matches `page-head` (size, divider, baseline).

## 6. Vertical rhythm

Card-to-card gap audited on all 21 screens by walking the DOM:

- **Every screen: uniform 16px** (`--space-4`).
- `appearance`: the customiser's control stack was 12px → now 16px.
- Two inline `style="margin-top:1.4rem"` on `<h2>` in `plugins.ts` and
  `themes.ts` forced 22.4px where every other section heading sits at 16px.
  Removed; `h2`/`h3` introducing content now get `var(--space-4)` from a rule
  (scoped away from card/dialog headings, which must stay flush).
- `h2, h3, h4` got `scroll-margin-top` so anchor jumps don't hide headings
  under the sticky topbar.

## 7. Mobile

- **`/terms` scrolled sideways**: its table was the only list not wrapped in
  `.table-wrap`, so 4 columns forced the document to 460px on a 375px phone.
  Now wrapped **and** given the same `.list-table` + `data-label` treatment the
  posts list uses, so rows become labelled cards instead of a clipped table.
- `html { overflow-x: clip }` as a global guard (`clip`, not `hidden`, so
  `position: sticky` keeps working).
- Verified: **0px horizontal overflow on all 15 screens at 390px.**
- `/posts` toolbar now wraps into clean groups: search row, then two rows of
  evenly-sized selects.

## 8. Contrast and ARIA (found while fixing markup)

- `--muted`: `#677386` (4.35 on `--bg`, **4.01** on `--surface-3`, both under AA
  for the 12–14px text it is used for) → **`#5f6b7d`** (4.90 / 4.51 / 5.40).
  Panel contrast failures: **all cleared**.
- `.th-sort__arrow` was `--line-strong` at **1.70:1** → `--muted` (4.59).
- Duplicate `id="palette-cmd-0"` in every group of the command palette → ids
  now numbered across all commands, restoring `aria-activedescendant`.
- Account `<summary aria-label="Account menu">` failed WCAG 2.5.3 (visible text
  not in the accessible name) → label moved to an `sr-only` span.
- `aria-prohibited-attr` (2 serious): `div[aria-label]` with no role in the
  bundled theme partials → `role="group"`. The page-level contact strip got
  `role="complementary"`. **axe is now clean on the public site.**

---

## 9. Dashboard — the "odd" stack (follow-up)

You were right, and the cause was a single unstyled element.

**`ul.stats` had no CSS rule matching it at all.** It was the only list in the
whole panel without a reset, so it kept the browser's defaults:

- `padding-left: 40px` — all three cards sat **40px right** of the header above
  them and of every card below. That is the odd offset you saw.
- `margin-top: 14px` — an arbitrary gap that then **doubled** with the flex gap
  to 32px above the row, so the spacing above and below the cards didn't match.
- `list-style: disc` — bullets on the `li`s.

Measured before: `ul` at x=296 while `.main__inner` was at x=256.

Fixed in `src/admin/assets/screens/dashboard.css`:
- Full reset on `.dash .stats` (`margin: 0; padding: 0; list-style: none`).
- Three **equal** cards (373.3px each). An earlier attempt derived them from the
  `1.65fr / 1fr` split below, which made the middle card 262px against the outer
  cards' 428px — technically aligned, but it read as a mistake.
- Row now spans **256.0 → 1408.0**, exactly the container, so its left and right
  edges coincide with the header and with the grid below.
- Gaps above and below the row are now **16px / 16px** (were 32px / 16px).

Global fix in `src/admin/assets/app.css` so this cannot recur:
```css
ul, ol { margin: 0; padding: 0; list-style: none; }
```
Every list in the panel already sets its own spacing; this stops an unstyled one
from drifting 40px to the right of its neighbours.

Verified: card widths `[373.3, 373.3, 373.3]`, row `256.0 .. 1408.0`,
gaps `16.0 / 16.0`, 0px horizontal overflow at 1440 / 900 / 390,
`tsc` clean, **141/141 tests pass**.

---

## 10. Card interiors and the right column (second follow-up)

### "Text looks poked into the corner"

`card--flush` sets `padding: 0`, and `.card__head` had **no padding of its own**.
So the heading sat at **x=257** — 1px inside the border, hard against the
top-left corner — while the list text below it started at **x=273**. A 16px
mismatch between a card's own heading and its own content is what read as
"poked in the corner".

Now the **header owns the card's inner padding** (`12px 16px`), and:

| | before | after |
|---|---|---|
| Card box | 256 | 256 |
| Heading | **257** (1px inset) | **273** (16px inset) |
| Body text | 273 | **273** (16px inset) |

Padded (non-flush) cards reset the header's padding to 0 so the card's own 16px
padding still governs — verified on `/users`: card 256 → heading 273.

### Row spacing inside the cards

- `.list--rows li` was `padding: var(--space-2) var(--space-4)` — **8px** above
  and below against 16px at the sides. Now `space-3 / space-4` (12/16), the row
  gap is 16px, the title uses `--text-base` on a tight leading and the meta line
  sits 2px under it.
- `.attention__item` padding `space-3 space-4` → `space-4` (16px all round), gap
  `space-3 space-4`.
- Rows are inset with **padding, not margin**, so the divider and the hover
  background still reach the card edge — which is the whole point of flush.

### "Right side still has alignment problems"

Two real defects, both now fixed:

1. **A doubled gap.** `.card` carries `margin-bottom: 16px`, and the flex column
   also sets `gap: 16px`, so the space between the two cards in the main column
   was **32px** while every other gap on the page — including the whole right
   column — was 16px. That single mismatch is what made the right side look off
   against the left. `.dash__main > .card, .dash__side > .card { margin-bottom: 0 }`.
2. **The right card's key/value list.** It used a fixed `minmax(7rem, 12rem)`
   label track and `space-1 space-3` gaps, so its values started at an arbitrary
   x and its three rows were packed at 8px while every other list in the panel
   uses 12–16px. Now `grid-template-columns: max-content minmax(0, 1fr)` with
   `space-3 space-4` gaps and baseline alignment, so each value sits right after
   its own label and the rows breathe.

Measured after: all dashboard gaps **16px** (head→stats, stats→cols, card→card),
heading inset **16px**, body inset **16px**, right column heading inset **17px**
(16 + the card's 1px border). 0px horizontal overflow at 1440 / 900 / 390.
`tsc` clean, **141/141 tests pass**.

---

## 11. "At a glance" card was bigger and wider (third follow-up)

The right card was **428.67px** wide against the **373.3px** stat card sitting
directly above it — **55px wider, and starting 55px further left**. Its right
edge lined up, but because it was wider it began well left of the stat card's
left edge, so the right stack read as a heavier, different-sized card.

Cause: `.dash__cols` used `1.65fr / 1fr`, while the stats row is three equal
columns. Those two ratios cannot agree, so the side card was always going to be
wider than a stat card.

Fix: give the side column exactly one stat card's width.

```css
.dash__cols {
  grid-template-columns:
    minmax(0, 1fr)
    minmax(0, calc((100% - 2 * var(--space-4)) / 3));
}
```

The stats row is `(100% - 2 gaps) / 3` per card, so the same expression makes the
right card identical in size and puts its left *and* right edge on the stat
card's lines.

Measured after (side card vs. the third stat card):

| viewport | stat card | side card | stat3 left | side left | match |
|---|---|---|---|---|---|
| 1440 | 373.3 | 373.3 | 1034.7 | 1034.7 | yes |
| 1200 | 293.3 | 293.3 | 874.7 | 874.7 | yes |
| 1080 | 253.3 | 253.3 | 794.7 | 794.7 | yes |
| 1000 | 226.7 | 226.7 | 741.3 | 741.3 | yes |
| 970  | 216.7 | 216.7 | 721.3 | 721.3 | yes |

Right edge on the container edge in every case, 0px horizontal overflow, and the
`max-width: 960px` single-column stack is unaffected. `tsc` clean,
**141/141 tests pass**.

---

## 12. Sidebar "beauty surgery"

Every rail option, in all four states (expanded, collapsed, mobile drawer, and
with a section open).

### What was wrong

| Problem | Was | Now |
|---|---|---|
| Section breaks | 3 hairlines that only said "something ends" | **Content / Design / System** micro-caps headings |
| Labels | 14px **regular** — thin on a dark ground | 14px **medium**, children step down to 13px medium |
| Active row | solid `--accent` blue slab, white text | soft accent wash + 2px accent edge, 650 weight |
| Icons | 1.15rem at 0.82 opacity, undersized by the labels | **1.25rem** at 0.75, lifting to 0.95 on hover |
| Submenu | flat indented list, no tie to its parent | 1px **guide rail** down the icon column, current child marked with an accent dot |
| Foot rows | 13px, floating mid-column | **pinned to the bottom**, 14px, matching the sections |
| Collapse Menu | filled `--rail-hover` box that looked like the selected item | quiet text row with an inset top rule, muted colour |
| Corner radius | `--radius-sm` (5px) on 36px rows | `--radius-md` |
| Focus | none | `focus-visible` accent outline, inset |

The active row was the worst of these: a full-bleed blue slab at 14px regular
competed with the page title, and because it was solid it *swallowed* the
parent/child relationship with the submenu sitting directly underneath. The
wash + edge keeps the accent signal without the banner.

The submenu was the other: four indented links with nothing showing they
belonged to "Posts". The guide rail draws that relationship at 1px, and the
current child gets a dot on the rail instead of a filled block (which had made
it look like a second active section).

### Structure

- `NavGroup` gained `group?: string`; `RAIL_GROUP_LABELS` maps those keys to the
  visible headings. Headings are `aria-hidden` — they are visual grouping, the
  nav's own structure carries the semantics.
- `.rail` is now a flex column with `.rail__section { flex: 1 }` and
  `.rail__foot { flex: 0 0 auto }`, so the foot sits at the bottom instead of
  floating after the last item.
- Group headings hide with the labels when the rail is collapsed; the collapsed
  rail also gets `--space-1` between icon rows for air.

### Colour note

`--rail-muted` (#8c98a9) is tuned for 13–14px secondary text and effectively
vanishes at 11px uppercase, so the headings use
`color-mix(in srgb, var(--rail-fg) 58%, var(--rail-bg))` — **5.74:1** on the
rail background.

### Verified

Rail items still **36px tall, icons at x=20, labels at x=50.39** on every screen
— the alignment work from section 1 is intact. Collapsed rail, mobile drawer and
the open-submenu state all verified visually. Panel contrast failures: **0**.
axe: **0 violations**. `tsc` clean, **141/141 tests pass**, 0px overflow.

---

## Verification

- `measure-before.json` / `measure-after.json` — 21 screens × 2 viewports,
  block rects, rail item/icon/label x, separators, doc-vs-window width.
- `before/` and `after/` — 15 screens at 1440 and 390 (30 PNGs).
- Rail after: every row 36px, every icon x=20, every label x=50.39, 2 separators.
- Card gaps after: 16px on every screen (the one 48px is a section heading
  between two cards, which is correct).
