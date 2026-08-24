# Optional pseudonymous usage telemetry

Oh My HuggingFace can send seven fixed, pseudonymous product events to PostHog. This telemetry is
not anonymous: opted-in events share a persistent, randomly generated installation identifier so
launches from one installation can be counted consistently.

Telemetry is **disabled by default**. The app sends nothing to PostHog until the user explicitly
opts in, and the user can turn it off again at any time from **Settings → Privacy & data**. Release
builds without a PostHog project key disable the telemetry subsystem and do not show its consent
prompt.

## Build configuration

Telemetry is configured at build time:

| Variable              | Required               | Meaning                                                                                                                                                                                                                              |
| --------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POSTHOG_PROJECT_KEY` | For publishable builds | PostHog project ingestion key. An absent or empty value disables telemetry and its consent prompt. The key is embedded in every released desktop binary, so it is a public ingestion identifier rather than an authorization secret. |
| `POSTHOG_HOST`        | No                     | HTTPS PostHog ingestion origin. Defaults to `https://eu.i.posthog.com`.                                                                                                                                                              |

Provide the same values to every platform build so macOS, Windows, and Linux releases have the
same behavior. For example:

```sh
POSTHOG_PROJECT_KEY=phc_PROJECT_KEY \
POSTHOG_HOST=https://eu.i.posthog.com \
pnpm build
```

For this repository's GitHub Actions release workflow, create Actions secrets named
`POSTHOG_PROJECT_KEY` and, optionally, `POSTHOG_HOST`. The reusable packaging workflow passes them
to each platform build without printing their values.

- Ordinary non-publishable smoke builds may omit the project key. They exercise the deliberately
  disabled telemetry path.
- A build with `publishable: true`, including a formal release dry run, must fail when
  `POSTHOG_PROJECT_KEY` is empty or whitespace.
- After `electron-vite` builds the main process, the publishable workflow verifies without logging
  the key that the compiled bundle contains the configured key and PostHog ingestion marker.

The client posts to the configured HTTPS host's `/i/v0/e/` endpoint. Arbitrary HTTP origins and
origins containing credentials are rejected. A project ingestion key in a distributed application
cannot provide access control; protect the PostHog project with event allow-lists, quotas, and
ingestion rate limits.

Requests use the app's currently configured HTTP(S) proxy when present. Otherwise they resolve the
operating system's proxy for each request. Changing **Settings → Network** takes effect for later
telemetry without restarting the app. A direct connection is used only when the operating-system
resolver explicitly returns `DIRECT`; resolver errors, malformed routes, and unsupported proxy
types fail closed for that event rather than bypassing the proxy configuration.

## Consent and persistent installation identity

- Telemetry starts in the off state for every installation.
- No consent-screen impression or pre-consent launch event is sent.
- `telemetry_enabled` is the first event after an explicit opt-in.
- Turning telemetry off stops new events immediately. Re-enabling it requires another explicit
  user action.
- Telemetry consent is installation-local: exports omit it, and imports (including older files
  containing `telemetryEnabled`) preserve the receiving installation's current choice.
- PostHog's `distinct_id` is a randomly generated installation UUID stored in the app's local
  SQLite `kv` data. It persists across launches only while telemetry remains enabled. Turning
  telemetry off or clearing the related local `kv` data deletes it; a later explicit opt-in creates
  a new UUID. It is a pseudonymous identifier and is not derived from hardware, an operating-system
  account, a Hugging Face account, a GitHub account, or another user identifier.
- The app does not enable PostHog autocapture, session replay, or person profiles. Every event sets
  `$process_person_profile` to `false`.

The GitHub Star reminder is locally scheduled. It remains functional while telemetry is off;
reminder events are sent only while telemetry is enabled. Opening GitHub or explicitly disabling
the reminder ends it permanently. Choosing “later” on the first prompt snoozes it for 30 days;
the second prompt's corresponding action is explicitly labeled “Don't remind me again” and
permanently exhausts the reminder.

## Event allow-list

Only these event names are accepted:

| Event                   | When it is emitted                                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `telemetry_enabled`     | The user explicitly enables pseudonymous telemetry.                                                               |
| `app_launched`          | An opted-in user launches the packaged desktop app.                                                               |
| `star_prompt_shown`     | The locally scheduled GitHub Star reminder is shown.                                                              |
| `star_prompt_opened`    | The user chooses the action that opens the project on GitHub.                                                     |
| `star_prompt_snoozed`   | On prompt 1, the user chooses to be reminded later.                                                               |
| `star_prompt_disabled`  | The user explicitly disables future Star reminders.                                                               |
| `star_prompt_exhausted` | On prompt 2, the user chooses the final “Don't remind me again” action; `prompt_number=2` and `action=exhausted`. |

Every event contains only fields from this fixed allow-list:

- PostHog's required `distinct_id`: the opted-in-lifecycle installation UUID described above;
- `schema_version`;
- `app_version`;
- `platform`;
- `arch`;
- `locale`;
- `prompt_number` and `action` for Star reminder events, using fixed values enforced by the
  client.

No API accepts arbitrary event names or arbitrary properties.

## IP addresses and GeoIP

The client does not put an IP address in the event payload. Nevertheless, as with any HTTPS
request, the PostHog service can see the source IP at the network transport layer.

`$geoip_disable: true` disables PostHog's geographic enrichment. It does **not** prevent the
PostHog server or an upstream proxy from observing, capturing, or logging the source IP. Therefore:

1. The PostHog project used for releases **must disable IP capture in its project settings**.
2. Any proxy in front of PostHog must be configured not to retain client IPs in logs.
3. The maintainer must verify these server-side settings before enabling the project key in a
   publishable build.

Every event also sets `$process_person_profile: false`, preventing creation or update of PostHog
person profiles.

## Data that is never sent as telemetry

The event payload never contains:

- names, email addresses, Hugging Face usernames, organization names, or GitHub accounts;
- Hugging Face access tokens, web-session cookies, credentials, or authentication scopes;
- repository IDs, model or dataset names, viewed pages, search queries, filters, or content;
- download URLs, file names, local paths, cache paths, file sizes, or file hashes;
- configured Hub endpoints, proxy URLs, or other network configuration;
- device fingerprints, hardware serial numbers, advertising identifiers, or operating-system
  account identifiers;
- autocaptured clicks, text input, screenshots, session recordings, or person profiles.

Adding an event or property requires code review, tests that enforce the allow-list, and an update
to this document in the same change.

## GitHub Star reminder

The reminder opens the canonical project page:
[github.com/fzlzjerry/ohmyhf](https://github.com/fzlzjerry/ohmyhf). It does not authenticate to
GitHub, inspect a user's GitHub account, or claim that a Star was actually created. A click means
only that the project page was opened in the system browser.

The reminder is driven entirely by device-local SQLite state and is independent of telemetry
consent. It becomes eligible only after at least three real app launches and meaningful local use:
a completed download, at least one favorite, or at least five local history entries. The renderer
waits 30 seconds, a visible and focused app window, and the absence of the Settings, command
palette, shortcuts, dialog, menu, or select overlays before showing a non-modal card.

The main process reserves a candidate reminder first; it increments the lifetime display count and
emits `star_prompt_shown` only after the foreground renderer acknowledges that the card was
rendered. A random per-claim UUID and an atomic SQLite transaction ensure duplicate or concurrent
responses cannot open multiple browser windows or emit multiple outcome events.
