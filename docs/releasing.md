# Releasing

Releases are built and verified before GitHub receives a tag or draft release. The workflow supports
both a release commit on `main` and a side-effect-free manual dry-run.

## Release contract

All four workspace manifests must contain the same plain `x.y.z` version:

- `package.json`
- `apps/desktop/package.json`
- `packages/shared/package.json`
- `packages/hub-api/package.json`

A push to `main` starts a real release only when the head commit subject matches
`[RELEASE] Vx.y.z`. The `V` is optional and case-insensitive, and the parsed version must equal all
four manifest versions. Other pushes finish after detection without creating release resources.

## Cutting a release

1. Update all four manifest versions in one change and run the full local verification suite.
2. Land the release commit as the head of `main` with subject `[RELEASE] Vx.y.z`.
3. Monitor `.github/workflows/release.yml`. It runs these gates in order:
   - **detect** parses the version and verifies the four manifests;
   - **verify** runs production dependency audit, format, lint, typecheck, coverage, build, and the
     full Ubuntu E2E suite;
   - **build** packages macOS, Windows, and Linux with `--publish never`, then runs the packaged
     smoke test on each platform; publishable smoke coverage includes the configured telemetry
     consent path, legacy consent-state migration, and the same-session Star eligibility retry;
   - **preflight** checks required installers, updater manifests, every referenced file, and its
     SHA-512 value;
   - **publish** creates or resumes the draft, uploads only preflight-approved assets, downloads
     them again to verify the remote asset set and hashes, and only then removes draft status.

Only `publish` has `contents: write`. A failure in any earlier stage cannot create a tag or GitHub
Release.

The regular CI workflow runs the full Ubuntu E2E suite for every pull request. After verification,
pushes to `main` also run the reusable macOS, Windows, and Linux packaged smoke matrix with
publishing disabled.

Non-publishable packaged smoke runs verify the intentionally disabled telemetry path because they
do not receive the release ingestion key. Publishable runs receive only a non-sensitive boolean
expectation in the test process; the existing build gate separately verifies, without logging it,
that the exact configured key, explicit region-matching HTTPS ingestion origin, and collector
marker are present in the compiled main bundle. Both `POSTHOG_PROJECT_KEY` and `POSTHOG_HOST` are
required for publishable builds. The project key comes from an Actions secret; this repository's
US Cloud ingestion origin is pinned visibly in the workflow to `https://us.i.posthog.com`.

## Dry-run

Run the **Release** workflow manually with `dry_run=true` (the default). It executes verification,
all three platform builds, packaged smoke tests, and preflight, but it never creates a tag, draft, or
published release. Dry-run macOS artifacts use the configured ad-hoc identity; real releases require
the `MAC_CSC_LINK` and `MAC_CSC_KEY_PASSWORD` secrets described in [signing.md](signing.md).

Use dry-run before changing release automation or updater configuration.

## Recovery and idempotency

Release runs share a repository-wide concurrency lock and are not canceled by newer runs. If a real
publish job is retried:

- an existing tag must point to the exact verified commit;
- an existing draft is reused and its assets are replaced from the verified artifact set;
- a published release is treated as complete only when downloading it reproduces the preflight
  asset list, sizes, and SHA-512 hashes;
- a tag pointing elsewhere or any asset mismatch stops the workflow without altering the release.

Do not delete and recreate a successful release merely to rerun CI. For a genuinely new release,
bump the patch version and land a new release commit.

## Updater contract

Packaged builds use the electron-builder generated `app-update.yml` and the release's `latest.yml`,
`latest-mac.yml`, or `latest-linux.yml`. The macOS zip is required by Squirrel.Mac. Keep each updater
manifest and all files it references in the same release; preflight rejects missing files or SHA-512
mismatches.

The application checks only published releases. Update discovery, download, and restart-install are
separate user actions, and development builds do not load the updater.
