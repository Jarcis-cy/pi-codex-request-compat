# pi-codex-request-compat

A [Pi](https://pi.dev) extension that converts Pi's OpenAI Responses requests into the **model-specific Codex wire shape** used by strict Codex-compatible gateways.

> This package is version-sensitive compatibility glue, not an authentication bypass. You still need valid provider credentials and an account authorized to use the target model.

## ⚠️ Required configuration

After installation, you **must** create `~/.pi/agent/codex-request-compat/config.json`:

```json
{
  "providerIds": ["codex"],
  "baseUrls": []
}
```

Each `providerIds` value must exactly equal the corresponding provider key in `~/.pi/agent/models.json`; matching is case-sensitive. The packaged default contains only `codex`, so create the user file even when that is already your provider key. User fields override the corresponding packaged fields. Values are trimmed and deduplicated, and invalid fields produce doctor warnings while retaining the valid default for that field.

`baseUrls` is normally empty because the extension discovers base URLs from registered `openai-responses` models during `session_start`. A dynamically implemented custom provider may not expose its model through the normal registry; in that case, list its HTTP(S) API root explicitly:

```json
{
  "providerIds": ["codex"],
  "baseUrls": ["http://127.0.0.1:8787/api/v1"]
}
```

The extension matches only `POST` requests with string bodies whose URL origin and pathname exactly equal the configured API root plus `/responses`. Query strings are allowed. Similar path prefixes and `GET` requests are not transformed.

## Why this exists

Pi uses the OpenAI JavaScript SDK for `openai-responses` providers. Some gateways only accept requests whose wire format matches the Rust Codex CLI. The two clients differ in headers and JSON shape even when they request the same model.

Codex 0.144.1 uses two different request families:

- `gpt-5.4` and `gpt-5.5` use Standard Responses with model-specific top-level `instructions`, top-level `tools`, and parallel tool calls;
- `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna` use Responses Lite with `additional_tools`, serial tool calls, and `reasoning.context: "all_turns"`; Sol and Terra/Luna use different native developer prompts;
- both families use consistent Codex request identity, omit JavaScript SDK fingerprints, and keep standard routing by omitting `service_tier`.

## Install

### Local development

```bash
pi install /absolute/path/to/pi-codex-request-compat
```

### Fixed v0.2.1 release

```bash
pi install git:github.com/Jarcis-cy/pi-codex-request-compat@v0.2.1
```

Restart Pi after installation and use `pi list` to confirm the package is enabled. Then create the required configuration file shown above.

## Provider setup

The selected provider must use Pi's `openai-responses` API adapter. Example `~/.pi/agent/models.json` fragment:

```json
{
  "providers": {
    "codex": {
      "baseUrl": "http://127.0.0.1:8787/api/v1",
      "api": "openai-responses",
      "apiKey": "YOUR_KEY",
      "models": [
        {
          "id": "gpt-5.6-sol",
          "name": "GPT-5.6 Sol",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 372000,
          "maxTokens": 16384
        }
      ]
    }
  }
}
```

Do not commit real API keys. Prefer Pi authentication storage or environment-based secret handling where available.

Supported runtime model IDs are exact and fail closed: `gpt-5.4`, `gpt-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`. Unknown model IDs are left untouched instead of inheriting an incompatible profile; doctor reports the current model as unsupported.

## What it changes

### Headers

- removes all `x-stainless-*` headers and the JavaScript adapter's `session_id` header;
- sets Codex Exec identity, User-Agent, SSE accept, beta feature, and request metadata headers;
- adds `x-openai-internal-codex-responses-lite: true` only for the 5.6 profile and removes it for 5.4/5.5.

### Body

- `gpt-5.4` and `gpt-5.5`: sets the exact model-specific `instructions`, keeps Pi tool schemas at top-level `tools`, enables parallel tool calls, and omits `reasoning.context`;
- `gpt-5.6-*`: moves Pi tools to `input[0].additional_tools`, inserts the exact Sol or Terra/Luna native prompt as the only text-bearing developer message, disables parallel tool calls, and sets `reasoning.context: "all_turns"`;
- all profiles reclassify Pi's system prompt as a typed user message wrapped in `<client_context>`;
- all profiles remove `prompt_cache_retention`, `max_output_tokens`, and `service_tier`, while canonicalizing header/body identity metadata.

Reclassifying Pi's system prompt lowers its instruction priority from developer to user. This is an intentional compatibility trade-off: Pi-specific guidance remains available while the gateway sees the exact versioned Codex instructions for the selected model.

### Standard tier enforcement

The extension deliberately removes `service_tier`. Standard routing is represented by the field being absent. It never opts a request into a premium or fast tier.

## Fallbacks, custom streams, and subagents

Fallback and subagent requests need no external patch when either condition is true:

- Pi's normal provider hooks add the direct `originator: codex_exec` marker; or
- the outgoing request exactly matches an automatically discovered or explicitly configured Responses endpoint.

For an exact endpoint match, the fetch layer is self-contained: it derives installation, session, thread, turn, window, and request-kind metadata from the active session runtime, selects the profile from the JSON body's `model`, adds the matching Codex headers, and canonicalizes body metadata. A custom `streamSimple` implementation therefore does not need to inject its own marker or metadata as long as it ultimately calls the process-global `fetch` with `POST`, a string JSON body, and the configured endpoint URL. Pi subagents that load the package receive the same behavior in their own process.

Custom transports that never call global `fetch`, non-string request bodies, and endpoints absent from both the model registry and `baseUrls` are outside this fallback path.

## Why compaction requires the fetch patch

Pi's regular agent turns call both `before_provider_headers` and `before_provider_request`. Default compact, split-turn compact, and branch-summary paths call the SDK stream function directly: `before_provider_headers` still fires, but the stream options do not carry `onPayload`, so `before_provider_request` cannot rewrite the JSON body.

The process-global fetch patch is therefore required, not optional decoration. It performs the final wire conversion for every matched request after headers exist. During `session_before_compact` it switches metadata to `request_kind: "compaction"`; all requests in one split-turn compaction reuse the same turn ID. `session_compact` advances the window and resets normal-turn state. Tree navigation enters compaction mode only when `preparation.userWantsSummary` is true and resets when `session_tree` completes.

The patch uses a mutable global holder. Hot reload replaces the active runtime state without wrapping fetch again, while shutdown removes only its own instance. The supported production scope is one active CLI session per process; doctor warns if duplicate active extension instances are present.

## Doctor

Run:

```text
/codex-compat:doctor
```

Doctor makes no network requests. It reports package and Codex baseline versions, config source/path, provider IDs, resolved endpoints, current-provider matching, API adapter, selected wire profile, every packaged profile SHA, fetch-patch status, duplicate instances, and standard-tier enforcement. Warnings and errors are explicit. TUI sessions receive a notification; non-UI modes print the report to stdout.

## Prompt baselines

Codex 0.144.1 profile assets are stored under `assets/codex-0.144.1/` and are validated byte-for-byte at startup:

```text
gpt-5.4-standard                  478e8a11b180adb2659f21aba51744711f79f665039bb0bc4a13d3c051fcb76c
gpt-5.5-standard                  c2a980bc28af132eb89e0b4c68ae884043faae83a1afd3fd4889f7e8a1ada7b0
gpt-5.6-sol-responses-lite        e9778714d505f3dd04d44db4394024c5fab5bf6554fc9faa3cdf9cf776b63bb9
gpt-5.6-terra-luna-responses-lite 78a2fc84e1bffa421d865c1a2ade4185d3d33ef38e6a15157f0ff1a89b7d52ec
```

The 5.4/5.5 assets are the official pragmatic-personality `instructions`; Sol and Terra/Luna use separate native Lite developer prompts. Update the assets, profile rules, User-Agent version, expected hashes, and captured baselines together. Legacy user-side prompt overrides are intentionally ignored.

## Diagnostics and privacy

Runtime state is stored under `~/.pi/agent/codex-request-compat/`:

```text
config.json
installation-id
request-debug.log
last-failed-request.json
```

On matched HTTP 4xx/5xx responses, the extension records redacted headers, the transformed body, and the response. Diagnostic files and the installation ID are forced to mode `0600`; the directory is mode `0700`. Request bodies can contain sensitive prompts and file excerpts, so review and redact diagnostics before sharing them.

## Verify

All repository tests use local capture stubs and make no external requests:

```bash
npm install
npm run verify
npm pack --dry-run
```

## Project layout

```text
pi-codex-request-compat/
├── assets/codex-0.144.1/
│   ├── gpt-5.4-standard.txt
│   ├── gpt-5.5-standard.txt
│   ├── gpt-5.6-responses-lite.txt
│   └── gpt-5.6-terra-luna-responses-lite.txt
├── config/default.json
├── extensions/codex-request-compat/
│   ├── index.ts
│   ├── profiles.ts
│   ├── constants.ts
│   ├── config.ts
│   ├── metadata.ts
│   ├── transform.ts
│   └── diagnostics.ts
├── tests/compat.test.mjs
├── tests/compaction.integration.mjs
├── package.json
└── README.md
```

## License

MIT
