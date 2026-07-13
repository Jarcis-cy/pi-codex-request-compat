# pi-codex-request-compat

A [Pi](https://pi.dev) extension that converts Pi's OpenAI Responses requests into the **Codex Responses Lite** wire shape used by strict Codex-compatible gateways.

> This package is version-sensitive compatibility glue, not an authentication bypass. You still need valid provider credentials and an account authorized to use the target model.

## Why this exists

Pi uses the OpenAI JavaScript SDK for `openai-responses` providers. Some gateways only accept requests whose wire format matches the Rust Codex CLI. The two clients differ in headers and JSON shape even when they request the same model.

For custom models such as `gpt-5.6-sol`, Codex 0.144.1 uses Responses Lite:

- tools live in an `input` item with `type: "additional_tools"`;
- the Codex base prompt is a typed developer message;
- `tool_choice`, `parallel_tool_calls`, reasoning context, and text controls are explicit;
- request identity appears in both headers and `client_metadata`;
- JavaScript SDK fingerprint headers are absent.

This extension performs that conversion immediately before `fetch`, so it also covers Pi paths that skip `before_provider_request`, including compaction and branch summaries.

## Compatibility

The current baseline was verified with:

| Component | Version / value |
| --- | --- |
| Pi | 0.80.6 |
| Codex CLI baseline | 0.144.1 |
| API | OpenAI Responses / SSE |
| Wire mode | Codex Responses Lite |
| Model used for verification | `gpt-5.6-sol` |

Strict gateways can change their validation rules. Re-capture a request from the matching Codex release before updating the constants or wire shape.

## What it changes

### Headers

- removes all `x-stainless-*` headers;
- removes the JavaScript adapter's `session_id` header;
- sets `accept: text/event-stream`;
- emits the accepted Codex Exec originator and User-Agent;
- emits Responses Lite and Codex beta feature headers;
- maintains session, thread, window, turn, and installation identity headers.

### Body

- moves top-level tools to `input[0]` as `additional_tools` without renaming Pi tools or changing their JSON schemas;
- inserts the packaged Codex prompt as the only text-bearing developer message;
- reclassifies Pi's system prompt as a typed user message wrapped in `<client_context>`, preserving Pi tool, skill, and project instructions without presenting a non-native developer prompt;
- canonicalizes role messages to `type: "message"` with typed content arrays;
- removes non-Codex fields such as `prompt_cache_retention` and `max_output_tokens`;
- sets Lite controls such as `tool_choice: "auto"`, `parallel_tool_calls: false`, and `reasoning.context: "all_turns"`;
- keeps header and body metadata projections consistent.

Reclassifying Pi's system prompt lowers its instruction priority from developer to user. This is an intentional compatibility trade-off: Pi-specific guidance remains available to the model, while the gateway sees an unmodified, version-matched Codex developer prompt.

### Service tier and billing

The extension deliberately **omits `service_tier`**.

Do not add this unless the user explicitly requests a premium tier:

```json
{ "service_tier": "priority" }
```

Codex maps `priority` to **Fast mode**. Providers may charge a higher multiplier for it. Standard routing is represented by the field being absent.

A separate Codex CLI configuration such as this also enables Fast mode for Codex itself:

```toml
service_tier = "fast"
```

Remove it or use `service_tier = "default"` when standard routing is desired.

## Install

### Local development

```bash
pi install /absolute/path/to/pi-codex-request-compat
```

### GitHub

Install directly from GitHub:

```bash
pi install git:github.com/Jarcis-cy/pi-codex-request-compat
```

Pin a release for reproducible behavior:

```bash
pi install git:github.com/Jarcis-cy/pi-codex-request-compat@v0.1.1
```

Restart Pi after installation. Use `pi list` to confirm that the package is enabled.

## Provider setup

The target provider must use Pi's `openai-responses` API adapter. Example `~/.pi/agent/models.json` fragment:

```json
{
  "providers": {
    "vendor-codex": {
      "baseUrl": "https://provider.example/codex/v1",
      "api": "openai-responses",
      "apiKey": "YOUR_KEY",
      "models": [
        {
          "id": "gpt-5.6-sol",
          "name": "GPT-5.6 Sol",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 372000,
          "maxTokens": 10000
        }
      ]
    }
  }
}
```

Do not commit real API keys. Prefer Pi authentication storage or environment-based secret handling where available.

The extension currently recognizes these provider IDs:

- `vendor-codex`
- `packyapi`
- `neibu`
- `404`

Edit `TARGET_PROVIDERS` when using a different provider ID.

## Fallback and subagents

Pi subagents run as isolated Pi processes and automatically load user-level packages. No special `pi-subagents` patch is required.

A custom fallback provider is different: its `streamSimple` implementation can bypass Pi's provider hooks. Before calling the real provider, it must attach the marker and consistent metadata expected by this package:

```ts
headers.originator = "codex_exec";
headers["x-codex-installation-id"] = installationId;
headers["x-codex-window-id"] = windowId;
headers["x-codex-turn-metadata"] = turnMetadataJson;
headers["session-id"] = sessionId;
headers["thread-id"] = threadId;
headers["x-client-request-id"] = threadId;
```

The JSON stored in `x-codex-turn-metadata` must be identical in the header and in `client_metadata`. Include at least:

```json
{
  "installation_id": "...",
  "session_id": "...",
  "thread_id": "...",
  "turn_id": "...",
  "window_id": "...:0",
  "request_kind": "turn",
  "thread_source": "user",
  "sandbox": "none",
  "turn_started_at_unix_ms": 0
}
```

If these projections drift, strict gateways may reject fallback and subagent requests while direct Pi requests continue to work.

## Prompt baseline

The version-matched native Codex prompt is stored at:

```text
assets/codex-instructions.txt
```

The packaged asset takes precedence because strict gateways may validate the prompt byte-for-byte. The legacy user-side file is used only if the packaged asset cannot be read:

```text
~/.pi/agent/codex-request-compat/codex-instructions.txt
```

Update the asset, User-Agent version, prompt hash regression test, and captured baseline together. Pi's actual tool list is transported separately through `additional_tools`.

## Diagnostics and privacy

Runtime state is stored outside the package:

```text
~/.pi/agent/codex-request-compat/
├── installation-id
├── request-debug.log
├── last-failed-request.json
└── codex-instructions.txt        # legacy fallback if the packaged asset is unavailable
```

On HTTP 4xx/5xx responses, the extension records:

- request headers with `Authorization` redacted;
- the transformed request body;
- response headers and body;
- a full latest-failure snapshot with mode `0600`.

Request bodies can contain prompts, file excerpts, tool schemas, and conversation history. **Never commit or publish runtime diagnostics without reviewing and redacting them.** The repository `.gitignore` excludes known runtime filenames, but runtime data should remain under the Pi data directory.

## Verify

```bash
npm install
npm run verify
npm run pack:check
```

A minimal live check:

```bash
pi --provider vendor-codex \
  --model gpt-5.6-sol \
  --no-session \
  --no-context-files \
  -p 'Reply with exactly OK.'
```

A tool-loop check should require one Pi tool call, then confirm that the second request also succeeds.

## Project layout

```text
pi-codex-request-compat/
├── assets/
│   └── codex-instructions.txt
├── extensions/
│   └── codex-request-compat.ts
├── tests/
│   └── compat.test.mjs
├── .gitignore
├── LICENSE
├── package.json
├── README.md
└── tsconfig.json
```

## Updating the Codex baseline

1. Install the target Codex release.
2. Point a temporary Codex provider at a local redacting capture proxy.
3. Send one minimal turn and one tool turn.
4. Compare headers, top-level body keys, input item types, metadata, and service tier.
5. Update the package constants and prompt asset.
6. Run type checks, unit tests, a standard-tier live request, and a tool-loop request.
7. Confirm provider billing did not switch to Fast unexpectedly.

Do not infer protocol requirements from a single user configuration. Fields such as `service_tier` may be user preferences rather than gateway fingerprints.

## License

MIT
