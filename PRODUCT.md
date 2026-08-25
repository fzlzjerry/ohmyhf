# Product

## Register

product

## Users

ML engineers, researchers, and local-AI hobbyists who live on the Hugging Face Hub: they browse
models/datasets/spaces daily, download large model weights to run locally (llama.cpp, Ollama,
ComfyUI, transformers), and follow orgs/papers to keep up. They are keyboard-fluent, tool-savvy
(Linear, Raycast, VS Code), and often on flaky or metered connections where resumable, rate-limited
downloads matter. They value privacy and expect every outbound data flow to be transparent and
under their control. Optional pseudonymous usage telemetry is on by default in packaged releases
and can be turned off at any time. When enabled, it sends only seven fixed events to PostHog with
a random installation identifier that persists across launches while telemetry stays enabled, plus
the app version, platform, architecture, and locale. Disabling telemetry deletes that identifier;
turning it back on later creates a new one.

## Product Purpose

Oh My HuggingFace is an unofficial, open-source, cross-platform desktop client for the Hugging Face
Hub. It does what the website cannot: a resumable, parallel, checksummed download manager that
writes into the standard HF cache (interoperable with transformers/CLI), local cache visualization
and cleanup, system notifications for follows and daily papers, and export into the local AI
toolchain (Ollama, LM Studio, ComfyUI). Success: a user manages their entire Hub workflow — browse,
auth, download, clean, follow — without opening a browser, and trusts the app with their token.

It is NOT affiliated with or endorsed by Hugging Face, Inc. "Hugging Face" appears only as a
referential nod to the service it connects to. No 🤗 emoji, no HF logos, nothing that implies
official status.

## Brand Personality

Feels like home for Hub natives. The app speaks huggingface.co's visual dialect — cool paper
grays, gradient-washed cards, mono repo names, a yellow wink where a count needs attention —
tuned for a dense, keyboard-first desktop instrument. Brand color is an accent, never a shout:
primary actions are near-black pills, focus is blue, selection is indigo; yellow and orange
appear only where a highlight earns it. Familiarity does the welcoming; density and speed do
the persuading.

## Anti-references

- Identity impersonation: no HF logo or wordmark, no 🤗 in our own chrome, nothing implying
  official status. We adopt the Hub's _design language_ (grays, gradients, tags, mono titles)
  while keeping our own name, icon, and disclaimers.
- Brand-color abuse: yellow/orange CTAs, yellow links, yellow selection states. On
  huggingface.co the brand is an accent — it stays one here.
- Electron-app slop: web page in a frame, spinner-centric loading, mouse-only interaction.
- SaaS dashboard clichés: hero metrics, saturated gradient accents, identical card grids with
  heavy drop shadows (our depth comes from hairline borders and faint gradients).

## Design Principles

1. **Keyboard-first, always.** Every browse/filter/download action reachable via Cmd+K or a
   shortcut; mouse is the fallback, not the default.
2. **The list is the app.** Virtualized, instant, dense lists with a live preview pane; no
   navigation dead-ends, no full-page reloads.
3. **Trust through visibility.** Downloads show bytes, hashes, and cache paths; auth shows exactly
   what is stored and where. Optional pseudonymous telemetry uses a documented, minimal event
   allow-list, is on by default, and has a readily available off switch. PostHog may see the
   source IP during transport, so its project settings must disable IP capture;
   `$geoip_disable` only disables geographic enrichment. See
   [`docs/telemetry.md`](docs/telemetry.md) for the complete data contract.
4. **Native citizen.** System notifications, native menus, OS conventions per platform, localized
   everywhere (en, zh-CN at launch).
5. **Interoperate, don't silo.** Standard HF cache layout, exports into local tools; the app is an
   entry point to the local AI toolchain, not a walled garden.

## Accessibility & Inclusion

WCAG 2.1 AA. Radix-based components for focus management and ARIA. Full keyboard operability.
Body text ≥ 4.5:1 contrast in both themes. `prefers-reduced-motion` honored (state changes become
instant/crossfade). i18n as a first-class constraint: no hardcoded strings, CJK line-length and
font fallbacks considered from day one.
