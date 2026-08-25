# Design

Visual system for Oh My HuggingFace. Register: **product** — design serves the task.
Mood: "the Hub, distilled into a desktop instrument — cool paper grays, mono repo names,
one yellow wink."

## Design language

We speak huggingface.co's dialect: cool-gray surfaces with faint left-to-right card gradients,
border-heavy depth (shadows near-invisible), 8px radius everywhere with full-round pills, mono
repo names that recolor on hover (follows the accent setting; stock: indigo in light, yellow in
dark), and brand yellow/orange used
only as accents — never as CTAs. Primary actions are near-black pills that invert on hover.
Focus and selection speak blue/indigo, not brand color. We borrow the design language, not the
identity: our own name, logo, and disclaimers; no 🤗 or HF logo in our chrome.

## Color

All colors OKLCH; tokens live in `apps/desktop/src/renderer/src/assets/main.css`
(`--c-*` custom properties → `@theme inline` → Tailwind utilities). Grays are the Tailwind v4
cool-gray ramp; dark mode uses HF's near-black blues, not plain grays.

### Roles (light / dark)

| Role        | Light                | Dark                 | Usage                                      |
| ----------- | -------------------- | -------------------- | ------------------------------------------ |
| bg          | white                | gray-950 `#030712`   | page                                       |
| panel       | gray-50              | `#0b0f19`            | sidebar, toolbars, pre blocks              |
| panel-2     | gray-100             | `#101623`            | hovers, chips, skeletons                   |
| elevated    | white                | `#0b0f19`            | dialog, menu, palette, toast               |
| field       | white                | `#101623`            | input interiors (recessed inset shadow)    |
| border      | gray-200             | gray-800 `#1e2939`   | interactive borders (universal default)    |
| border-card | gray-100 `#f3f4f6`   | `#141c2e`            | card outlines, hairlines                   |
| ink-strong  | gray-900 `#101828`   | gray-100             | headings, repo names, links                |
| ink         | gray-700 `#364153`   | gray-300             | body (10.3:1)                              |
| ink-muted   | gray-600             | gray-400             | secondary text                             |
| ink-faint   | gray-500 `#6a7282`   | custom L 0.63        | metadata TEXT — the ≥4.5:1 floor           |
| decor       | gray-400             | gray-600             | decorative glyphs/dots only, never words   |
| cta / -ink  | gray-900 / white     | gray-100 / gray-950  | black-pill CTA; inverts on hover           |
| link        | gray-900             | gray-200             | inline links, hover underline              |
| hover-title | = select             | yellow-500 / acc-400 | mono-title hover recolor; follows accent   |
| focus       | blue-500             | blue-500             | focus rings (at /25–/50), `::selection`    |
| select      | indigo-600           | indigo-400           | selection tint (/10), progress, switch     |
| brand       | `#FFD21E` (+ orange) | same                 | count badges, unread dots, star fills ONLY |

WCAG deviations from huggingface.co (deliberate): HF sets metadata in gray-400 (≈2.7:1, fails
AA) — our metadata text sits one step darker (`ink-faint`); gray-400 survives only as `decor`
for separator dots and glyphs. Dark `ink-faint` is a custom lightness because gray-500 fails
on `#0b0f19` cards.

Tag category hues (blue, green, indigo `#615fff`, orange `#fe6e00`, purple, red `#fb2c36`,
amber) tint the leading icon tile of task tags; the task→hue/icon mapping is data in
`apps/desktop/src/renderer/src/lib/tag-colors.ts`. Semantic state: Tailwind green/amber/red/blue
(600 light, 400–500 dark); small success badges use the darker `success-ink` role in light mode.
State is never conveyed by color alone.

### Signature textures

- Cards: `bg-card-gradient` (panel → bg, left to right) + `border-border-card`; hover darkens
  the border, never adds shadow.
- Secondary buttons and tags: white → gray-100 vertical gradient, gray-200 border, inset shadow
  on hover (`--shadow-btn-inset`). Inputs are recessed with `--shadow-field-inset`.
- Aurora (`bg-aurora`): the HF multicolor wash at 10% alpha — avatar fallbacks and banners only.
- `shadow-overlay` is reserved for overlays (dialog, menu, palette, toast); in-page depth is
  borders and gradients.

## Typography

**Source Sans 3 Variable** (UI/body) + **IBM Plex Mono** 400/500/600 (code AND repo names —
mono identifiers are a signature). Bundled via fontsource; no font CDNs. CJK fallbacks
(PingFang SC, Hiragino Sans GB, Microsoft YaHei, Noto Sans SC) sit directly after the Latin
face in both stacks. Fixed rem scale: 12 / 13 / 14 (base) / `smd` 15 (titles, buttons, detail
H1 — HF's bespoke size) / 16 / 20 / 24. Weights: 400 body, 500 UI labels, 600 headings and
active states. Prose (model cards) capped at 72ch; prose links are near-black with a light
underline that darkens on hover.

## Layout

App shell: **TopBar (44px, full-width, the macOS drag region)** over sidebar rail + content.
The TopBar hosts identity, sidebar toggle (Cmd+B), history back/forward (Cmd+[ / Cmd+]), the
global-search entry (opens the Cmd+K palette), and account. The sidebar is pure navigation
(panel tone, manual collapse persisted locally, auto-collapse below 860px). Browse pages keep
the three-pane pattern: 22rem virtualized list + detail pane. 4px spacing grid; 56px repo rows.
Every interactive TopBar child opts out of the drag region (`.app-no-drag`).

## Components

Radix + CVA primitives in `components/ui/`. Radius: 8px (`rounded-lg`) everywhere; pills
`rounded-full`; never above 12px. Buttons: `cta` (black pill, inverts on hover — one per
surface, for the standalone primary action), `secondary` (gradient + inset-shadow hover, the
workhorse), `ghost`, `outline`, `danger`. Tags: 28px, 8px radius, gradient fill, optional
32×28 colored icon tile (`components/ui/tag.tsx`); dense list rows use a colored dot + label
instead. Tabs: HF `.tab-alternate` — 2px bottom border, transparent → gray hover → ink +
semibold active. Every control ships default/hover/focus/active/disabled/loading. Skeletons
over spinners; empty states teach quietly (no aurora). Toasts: bottom-right, error 8s,
optional action slot (undo), close icon, hover pauses the timer.

## Motion

150–250ms, `ease-out`, state changes only: fade, fade-rise (route/dialog), pop (anchored
overlays), toast-in, skeleton-pulse. No page-load choreography.
`prefers-reduced-motion: reduce` collapses everything to 0.01ms.

## Iconography

lucide-react, 16px in dense UI, 20px in navigation, 1.5px stroke. Hub-provided emoji (Space
cards, feed items) render as data — that's authentic HF texture. No 🤗 and no HF logo in our
own chrome.
