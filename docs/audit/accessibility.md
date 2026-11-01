# Accessibility audit (WCAG 2.2 AA)

Date: 2026-11-01. Branch: `feat/site-audit-2026-11`. Scope: `app/` (routes, components, styles) plus a static check of the live HTML. Method: code read, token contrast calculation, targeted greps. No source files were changed.

Overall: the codebase is in good shape. There is a skip link, one `<main>`, a global `:focus-visible` ring, a real focus trap in `Aside` and `CartAddedDialog`, `prefers-reduced-motion` coverage in 38 CSS blocks plus `MotionConfig reducedMotion="user"`, a 3D hero that is disabled for reduced motion, labelled form fields with `autoComplete`, `eslint-plugin-jsx-a11y` already enabled, and drag gestures that have click alternatives. The issues below are mostly polish. There are no blockers.

## Tooling status

- `@axe-core/cli` and `pa11y` via `npx` could not run here: no Chrome or ChromeDriver on the machine, and pa11y's puppeteer install failed (EPERM, missing `@puppeteer/browsers`). Automated runtime scans were skipped. Run them in CI or on a dev machine (see Tooling plan).
- Static check of live HTML (curl) for `/`, `/shop`, `/support`, `/cart`: `<html lang="en">`, a `<title>`, exactly one `<h1>`, one `<main>`, and a skip link on each page. Each page has 7 `<nav>` elements and only 1 has an `aria-label` (see A-01). `/shop` currently returns a "Signal lost" page.
- Not exercised at runtime: product pages and legal pages (their markup was only read in code).

## Contrast (computed from design tokens, dark theme; the site is forced `class="dark"`)

| Pair | Ratio | Result |
|---|---|---|
| text `#e5e5e5` on bg `#0d0d10` / card `#141417` / elevated `#1a1a1e` | 15.4 / 14.6 / 13.8 | pass |
| muted `#9a9a9a` on bg / card / elevated | 6.9 / 6.5 / 6.2 | pass |
| dim `#8b8b91` on bg / card / elevated | 5.7 / 5.4 / 5.1 | pass |
| gold `#ffb700` on bg / elevated | 11.1 / 9.9 | pass (text and focus ring) |
| dark ink on gold fill (buttons, skip link) | 11.1 | pass |
| green `#4ea866` on bg | 6.6 | pass |
| error `#f87171` on bg | 7.0 | pass |
| `--color-border-strong` `#34343c` on bg (input borders) | 1.57 | fails 1.4.11 (3:1), see A-02 |
| `--color-border` `#24242a` on bg | 1.26 | decorative dividers only, fine |
| `--color-green-deep` `#327014` on bg | 3.2 | ok for non-text, fails as text; check use |
| gold on the light surface `#f7f6f3` | 1.62 | fails if the light theme is ever shipped (tokens comment already says so) |

## Issues

Severity counts: blocker 0, serious 1, moderate 6, minor 8.

### Serious

**A-02 Form field boundaries are below 3:1** (SC 1.4.11 Non-text Contrast, serious)
`app/styles/app.css:17715` (`.sp-input` border `--color-border-strong`, 1.57:1 on the page background), same token on other inputs; `app/components/NewsletterSignup.tsx:~335` uses `--color-border` (1.26:1); `app/routes/cart.$.tsx:678` same. Labels are present, but the field edge is the only affordance on a dark page.
Fix: add a token such as `--color-field-border: #6b6b73` (about 3.6:1 on `#0d0d10`) and use it for `input, select, textarea` borders. Changes appearance, so it needs a design decision.

### Moderate

**A-01 Multiple unlabelled `<nav>` landmarks** (SC 1.3.1, 2.4.1 best practice, moderate)
`app/components/Footer.tsx:383,397,411,436,451` (five footer navs, no name) and `app/components/Header.tsx:557-563` (`HeaderMenu`, no name; the desktop and drawer copies duplicate each other). Live HTML shows 7 navs with 1 labelled.
Fix: `<nav aria-label="Shop">` etc. in the footer, `aria-label={isMobile ? 'Menu' : 'Main'}` on `HeaderMenu`.

**A-03 No focus move or announcement on client-side route change** (SC 2.4.3, 4.1.3, moderate)
`app/root.tsx`, `app/components/PageLayout.tsx`: React Router swaps content without moving focus or announcing the new title; `ScrollRestoration` only scrolls.
Fix: in `PageLayout`, on `pathname` change (skip first render) focus `#main-content` (add `tabIndex={-1}`) or write `document.title` into a visually hidden `role="status"` region.

**A-04 Fixed header can cover focused elements** (SC 2.4.11 Focus Not Obscured, moderate)
`app/styles/app.css:638` (`.site-header { position: fixed }`); `html` has no `scroll-padding-top`, only some anchors have `scroll-margin-top` (lines 11952, 14108, 15312, ...).
Fix: `html { scroll-padding-top: calc(var(--header-height) + 1rem); }`. Also check the pinned PDP buy rail (z-index 60) with `scroll-padding-bottom`.

**A-05 Focus indicator on the newsletter email field is a 1px border colour change** (SC 1.4.11 and 2.4.7 intent, moderate)
`app/components/NewsletterSignup.tsx:338` (`focus:outline-none focus:border-[var(--color-gold)]`). Same pattern at `app/styles/app.css:9317` (`.account-form`, adds a 25% gold 2px shadow). `.od-input` and `.sp-input` have a later `:focus-visible` ring and are fine.
Fix: replace `focus:outline-none` with `focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)]`, or drop it so the global ring applies.

**A-06 Focusable `<li>` with click handler and no role** (SC 4.1.2, 2.1.1, moderate)
`app/routes/products.$handle.tsx:1584-1601` (teardown pin rows: `tabIndex: 0` and `onClick` on an `<li>`). Focus triggers the highlight, so keyboard users get the effect, but it is announced as a plain list item and the touch toggle has no keyboard equivalent. `InTheBoxImage.tsx:99` does the same idea correctly (`role="button"`, `aria-pressed`, Enter/Space).
Fix: put a `<button type="button" aria-pressed={isActive}>` inside the `<li>` and move the handlers onto it.

**A-07 ChatFPV panel declares `aria-modal="true"` even when docked beside the page** (SC 4.1.2, 2.4.3, moderate, needs runtime check)
`app/components/ChatFpvWidget.tsx:393`. In the docked layout the page behind stays usable. `aria-modal` makes screen readers treat it as inert. The label is also hard-coded English (line 394).
Fix: `aria-modal={sheet ? 'true' : undefined}`; verify with NVDA before changing.

### Minor

**A-08 `aria-expanded` on a link** (SC 4.1.2): `app/components/Header.tsx:488`. Not supported on `role=link`, and the chip navigates rather than toggles. Remove it (no CSS depends on it).

**A-09 Redundant `role="navigation"`**: `app/components/Header.tsx:563`. Replace with the label from A-01.

**A-10 Decorative SVGs in labelled controls lack `aria-hidden`** (SC 1.1.1): `Header.tsx:919`, `ProductGallery.tsx:208,221`, `MobileHome.tsx:264`, `_index.tsx:690,717`. Add `aria-hidden="true" focusable="false"`.

**A-11 Missing fallback on `aria-label={copyText(...)}`** (SC 4.1.2): `ProductGallery.tsx:157,205,218`, `SchematicViewer.tsx:448,571`. A missing copy key leaves the button unnamed. Add `?? 'Previous image'` etc.

**A-12 Footer `<summary>` stays focusable on desktop with pointer events off** (SC 2.1.1, 4.1.2): `app/components/Footer.tsx:124` (`sm:pointer-events-none`). Keyboard users can collapse a column the mouse cannot. On `sm+` render a plain heading, or guard the toggle.

**A-13 Very small text** (SC 1.4.4 readability): about 31 declarations at 10px and 101 at 11px in `app/styles/app.css`. Contrast passes, legibility is poor. Raise informational labels to 12px or more.

**A-14 3D hero is `role="img"` around an interactive canvas** (SC 2.1.1): `app/components/HeroScene.tsx:1801`. Keyboard users reach the same content via the size buttons and parts rail, so no content is lost. Add a short description pointing to the parts list.

**A-15 New-tab links carry no notice** (SC 3.2.5 is AAA, G201): 55 `target="_blank"` uses (e.g. `AccountPages.tsx:68`, `PayTerms.tsx:12`). Add visually hidden "(opens in new tab)".

### Checked and passing

- Skip link (`PageLayout.tsx:46`, `app.css:12047`), one `<main id="main-content">`, `<header>`, `<footer>`.
- `<html lang>` derives from the loader locale (`root.tsx:266,293`); legal language links carry `lang`/`hrefLang` (`LangToggle.tsx`). Confirm on a client-side `/nl/...` to `/fr/...` switch that `<html lang>` follows.
- Images: every `<img>` has an `alt` attribute (script check over `app/**/*.tsx`).
- Heading order: one `<h1>` per route (home has a second for the phone variant `MobileHome`).
- Dialogs: `Aside` and `CartAddedDialog` trap Tab, handle Escape and restore focus; the collapsed aside uses `visibility: hidden`; ChatFPV uses `inert` when closed.
- Forms: labels, `autoComplete`, `required`, `aria-invalid`, `aria-describedby`, `role="alert"` errors; honeypots are `aria-hidden` and out of the tab order.
- Dragging (2.5.7): `HeroSizeSlider` has click buttons for every position.
- Accessible authentication (3.3.8): login is an emailed code; the field allows paste and has `autocomplete="one-time-code"` (`AccountPages.tsx:182-200`). Verify the Turnstile widget uses a non-interactive mode.
- Target size (2.5.8): primary controls are 44px; gallery arrows 28px desktop (above the 24px minimum), 44px on touch.
- Motion: `prefers-reduced-motion` in 38 `app.css` blocks, `MotionConfig reducedMotion="user"`, 3D hero skipped (`HeroDroneStage.tsx:27`).

## Per-page remediation plan

| Page | Items |
|---|---|
| All pages (layout) | A-01 nav labels, A-03 route-change focus, A-04 scroll padding, A-08/A-09 header ARIA, A-12 footer summary, A-15 |
| Home `/` | A-10 (`_index.tsx:690,717`, `MobileHome.tsx:264`), A-14, A-13; check the second `<h1>` is hidden on the other breakpoint |
| Product `/products/:handle` | A-06 teardown pins, A-11 gallery labels, A-10 gallery arrows, A-04 pinned buy rail vs focus, visible arrow-key hint on board and schematic rails |
| `/shop`, `/products` | Sort `<select>` is labelled; verify card focus order and that hover-only content is reachable by keyboard |
| `/support`, `/support/find` | A-02 field borders; error focus already handled |
| `/cart`, checkout | A-02 (`cart.$.tsx:678`), A-05; check coupon errors are announced |
| Account | A-05 `.account-form`; verify the code field announces success and failure |
| Legal pages (locked paths) | Owners to review: markdown table header `scope`, language toggle `aria-current`; language links already carry `lang` |

## Tooling plan (recommendation only; `.github/` is a locked path, nothing was changed)

1. `eslint-plugin-jsx-a11y` is already in `eslint.config.js`. Tighten it: move from `recommended` to `strict`, and burn down the `eslint-disable` blocks for `no-noninteractive-tabindex` and `no-noninteractive-element-interactions` in `BoardArt.tsx`, `SchematicViewer.tsx` and `Header.tsx` (each remaining one gets a reason comment).
2. Add an accessibility job to `.github/workflows/ci.yml` against the preview URL, using `@axe-core/playwright` or `pa11y-ci` with a URL list: `/`, one product page, `/products`, `/support`, `/cart`, `/privacy`, `/nl/privacy`. Fail on serious and critical. Example `.pa11yci.json`: `{"defaults":{"standard":"WCAG2AA","runners":["axe"],"chromeLaunchConfig":{"args":["--no-sandbox"]}},"urls":["https://<preview>/","https://<preview>/support"]}`.
3. Add Lighthouse CI (`@lhci/cli`) asserting an accessibility score of at least 0.95 on the same URLs, as a second signal.
4. Add a Vitest source check that fails when a `<nav>` has no `aria-label` or `aria-labelledby`, and a token test asserting the new field-border token keeps 3:1 against `--color-bg` (extend `opendrone-tokens.test.ts`).

## Manual screen-reader checklist (NVDA with Firefox/Chrome on Windows; VoiceOver with Safari on macOS and iOS)

- Landmarks list: banner, a named navigation per region, one main, contentinfo. No unnamed repeats.
- First Tab stop is the skip link, it is visible, and Enter lands on main content.
- Headings list: one `<h1>`, sensible order on `/`, a product page and `/support`.
- Mobile menu: focus moves in, Tab is trapped, Escape closes, focus returns to the menu button.
- Add to cart: the dialog is announced with its title, focus moves in, Escape closes, focus returns.
- Header family popovers: ArrowDown opens, Escape closes and returns focus, no keyboard trap.
- Product gallery: buttons have names, the counter is announced politely, no announcement storm when swiping.
- Teardown list, in-the-box list, board rail, schematic rail: operable by keyboard alone, state announced.
- Forms (support, newsletter, cart code, account): label read with each field, required state, error read on submit with focus on the error, code field accepts paste.
- Route change: after following a link, the new title or main heading is announced.
- Language: on `/nl/...` and `/fr/...` the reader switches voice; `/` restores English.
- Reduced motion: with the OS setting on there is no 3D hero, no auto-playing motion, no scramble text.
- 200% zoom and 320px width: no horizontal scroll or clipped controls; text-spacing override causes no loss.
- Forced-colors mode: focus ring and borders stay visible.
