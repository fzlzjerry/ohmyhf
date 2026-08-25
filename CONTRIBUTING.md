# Contributing to Oh My HuggingFace

Thanks for helping! This project is an unofficial, community-built desktop client for the
Hugging Face Hub, licensed under Apache-2.0.

## Ground rules

- **English** for code, identifiers, comments, commit messages, and repository docs.
- **No hardcoded user-facing strings.** Every string a user can see goes through i18n
  (`react-i18next` in the renderer, the `t()` helper in the main process). CI enforces this with
  `eslint-plugin-i18next`.
- **No Hugging Face branding.** Never add the 🤗 emoji, HF logos, or anything implying official
  status.
- **Privacy-first.** Optional pseudonymous usage telemetry is on by default in packaged releases
  and must remain immediately opt-out from Settings. Its event allow-list is `telemetry_enabled`,
  `app_launched`, `star_prompt_shown`, `star_prompt_opened`, `star_prompt_snoozed`,
  `star_prompt_disabled`, and `star_prompt_exhausted`; the last event is restricted to prompt 2
  with `action=exhausted`. Keep properties limited to a random installation ID that persists only
  while telemetry remains enabled, schema/app version, platform, architecture, locale, and fixed
  prompt fields. Never include accounts, tokens, repository data, local paths, or file names, and
  preserve the immediate opt-out path. PostHog may see the source IP during transport: the project
  must disable IP capture in PostHog, and `$geoip_disable` must remain set while being documented
  accurately as disabling only geographic enrichment. New events or properties must update tests
  and the documented [telemetry contract](docs/telemetry.md). Tokens are only ever stored
  encrypted via `safeStorage`.
- **Security baseline.** Renderer stays sandboxed (`contextIsolation`, no `nodeIntegration`);
  all IPC goes through the typed contract in `packages/shared` and validates input in the handler.

## Setup

```sh
corepack enable
pnpm install
pnpm dev
```

## Workflow

1. Fork / branch from `main`.
2. Make your change. Keep the app runnable — `pnpm dev` must work at every commit.
3. `pnpm typecheck && pnpm lint && pnpm test` must pass.
4. If you touched UI strings, run `pnpm i18n:extract` and fill in **both** `en` and `zh-CN`
   locales (machine-translated zh-CN is fine; mark it with `// TODO(i18n): review`).
5. Open a PR with a clear description.

## Adding a language

1. Copy `apps/desktop/src/renderer/src/i18n/locales/en` to `locales/<your-lang>/`.
2. Translate each namespace JSON file.
3. Add the locale to `SUPPORTED_LOCALES` in `packages/shared/src/index.ts`.
4. Add a main-process locale file under `apps/desktop/src/main/i18n/locales/`.
5. Add the language name to the settings language picker (it reads `SUPPORTED_LOCALES`).

## Project layout

See the Architecture section in [README.md](README.md). Rule of thumb: network/disk/OS work goes
in `apps/desktop/src/main` (or `packages/hub-api` if it's pure API logic); anything visual goes in
`apps/desktop/src/renderer`; anything both sides need goes in `packages/shared`.
