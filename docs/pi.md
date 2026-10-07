# Agent Brief for Pi

Short voice and push notifications for [Pi](https://pi.dev). Hear what changed, when your input is needed, or why a task stopped—without keeping the terminal in view.

- **Fish Audio** turns a brief recap into speech, played locally on macOS.
- **Bark** sends the same recap to your configured devices and works independently of audio.
- **Useful summaries** follow the active Pi model, preserve relevant details, and stay quiet when there is nothing worth reporting.
- **Background delivery** keeps Pi responsive while credentials, summaries, or notification services are unavailable.

## Requirements

- **Pi 0.99.1 or later** and **Node.js 22.19.0 or later**. The development host is pinned to Pi 0.99.1 to test the minimum supported version.
- A Fish Audio API key and voice reference ID for speech, or a Bark server URL and device key for push notifications.
- macOS with `afplay` for local speech playback. Bark and the portable transport tests also work on Linux.

The extension uses Pi's host modules and Node.js built-ins. No build step or additional runtime npm dependencies are required.

## Install

Install from GitHub:

```bash
pi install git:github.com/vizmoe/agent-brief
```

Then configure a backend and run `/reload` in an existing Pi session. A fresh installation stays disabled until a configuration file is present.

For local development:

```bash
git clone https://github.com/vizmoe/agent-brief.git
cd agent-brief
npm ci --ignore-scripts
pi -e ./index.ts
```

Use one installation method. A checkout under `~/.pi/agent/extensions/agent-brief` (or the old `pi-brief` directory) is already discovered automatically; adding a second Git installation can load another copy.

## Configure

Create `~/.pi/agent/pi-brief/config.json`. For English voice notifications:

```json
{
  "language": "en",
  "fishAudio": {
    "apiKey": "$FISH_API_KEY",
    "referenceId": "$FISH_REFERENCE_ID"
  }
}
```

Set those environment variables in the environment that starts Pi, or use a command to retrieve each value. Keep personal configuration outside the repository. [config.example.json](../config.example.json) is a minimal example using the default Chinese notification language.

For Bark only:

```json
{
  "language": "en",
  "bark": {
    "serverUrl": "$BARK_SERVER_URL",
    "deviceKeys": ["$BARK_DEVICE_KEY"]
  }
}
```

Provide both backend objects to enable both. Omit a backend or set it to `false` to disable it. Set `enabled` to `false` to disable the extension entirely, including credential lookup.

Configuration is loaded from the first applicable location:

1. The shared `AGENT_BRIEF_CONFIG` override, when set.
2. The path in `PI_BRIEF_CONFIG`, when set.
3. `pi-brief/config.json` inside Pi's `getAgentDir()` directory, normally `~/.pi/agent/pi-brief/config.json`. Pi's `PI_CODING_AGENT_DIR` override is respected.

Files are not merged. A missing or invalid file leaves notifications disabled. The repository's example and any `config.json` in the extension directory are never loaded implicitly. Configuration follows one current schema and has no version field.

### Credentials from commands

Backend credentials and `fishAudio.model` accept:

| Value | Behavior |
| --- | --- |
| `"$NAME"` or `"${NAME}"` | Read an environment variable; an unset or empty variable fails lookup. |
| `"!{command}"` | Run a command and use its trimmed standard output. |
| Any other string | Use the literal value. |

For example:

```json
{
  "fishAudio": {
    "apiKey": "!{op read 'op://Private/Fish Audio/api-key'}",
    "referenceId": "$FISH_REFERENCE_ID"
  }
}
```

`!{...}` must occupy the entire field. Pipes, quotes, and shell variable expansion are supported. The command runs through `pi.exec()` using `$SHELL`, or `/bin/sh` when unset, without loading a login shell. Its working directory is the configuration file's directory. Use trusted configuration and have the command print only the requested value to stdout.

Lookups start when a notification needs them. Concurrent lookups share work, successful values are cached for the session, and failures are retried on the next notification. `/reload`, session replacement, and shutdown cancel old lookups and clear their cache. The extension does not modify the process environment or depend on any particular secret manager, including Infisical.

A command must finish within 10 seconds, exit successfully, and return a nonempty value no larger than 64 KiB. Commands, stdout, stderr, and raw exception text are not included in local error messages.

Bark device keys also accept a JSON array, a JSON string, or comma-separated values returned by a command. If any configured key lookup fails, the entire Bark delivery fails rather than silently omitting a device.

### Optional settings

```json
{
  "language": "en",
  "summary": {
    "model": "provider/model-id",
    "instructions": "Lead with the result. Mention a limitation only when it matters."
  },
  "notify": {
    "idleDelaySeconds": 30,
    "minTaskSeconds": 10,
    "quietHours": { "start": "23:00", "end": "08:00" }
  },
  "fishAudio": {
    "apiKey": "$FISH_API_KEY",
    "referenceId": "$FISH_REFERENCE_ID",
    "model": "s2-pro"
  }
}
```

| Setting | Default and behavior |
| --- | --- |
| `language` | `zh-CN`; set `en` for English recaps. |
| `summary` | Follow the active Pi model, including model changes. `false` uses local evidence only. |
| `summary.model` | Optional `provider/model-id`; the model ID may contain `/`. |
| `summary.instructions` | Optional writing preferences for recaps. |
| `notify.idleDelaySeconds` | Wait 30 seconds after final settlement; further user activity cancels the notice. |
| `notify.minTaskSeconds` | Skip ordinary completion notices for tasks shorter than 10 seconds. |
| `notify.quietHours` | Disabled by default. Uses local time; permission and error notices remain enabled. |
| `fishAudio.model` | `s2-pro`. |

Summary, HTTP, and playback deadlines, output limits, deduplication, and audio settings have built-in defaults. They are not additional configuration knobs.

## How notifications work

Pi's `agent_settled` event decides when a run has actually finished, after automatic retries, compaction, and queued work. `before_agent_start`, message events, and tool events collect bounded evidence about the current task, changed files, validation, and the latest response. Notification hooks return without waiting for delivery.

Summaries use `ctx.modelRegistry.complete()` with Pi's registered model and authentication. They receive sanitized, length-limited evidence, have no tools, and do not modify the main conversation or system prompt. A failed or unavailable summary falls back to the available evidence. Empty acknowledgments and idle results without useful evidence remain silent. Permission, question, and error events retain an actionable fallback.

Native `ui_prompt_start` and `ui_prompt_end` hooks track blocking dialogs, including custom UI. Known question tools share their dialog's notification. Optional `permissions:ui_prompt` and `permissions:decision` events carry details from a compatible permission extension; these are third-party integration contracts, not built-in Pi events. No private permission files are read. An unmatched public permission event expires after 10 minutes; a linked native dialog keeps its actual UI lifetime.

Session replacement, tree navigation, and shutdown clear stale state and cancel pending work. Shutdown cleanup is idempotent. Worker detection supports `pi-subagents` and `pi-landstrip`, so their inherited copies do not register notifications.

Fish Audio playback is serialized. Bark delivery runs independently. Notification work shares the Pi process and, when summaries are enabled, the model provider's quota. It provides best-effort delivery, not a separate process or a guaranteed queue.

In print and JSON modes, enabled backends are still attempted while Pi is running. Pending notifications are cancelled at shutdown; a short `pi -p` invocation may exit before a delayed completion notice. Diagnostics go to stderr, leaving stdout available for Pi's output.

### Data and limits

- The summary provider receives the sanitized task evidence; Fish Audio receives the spoken recap; Bark receives the recap and notification title. Redaction reduces accidental disclosure but is not a complete data-loss prevention system.
- Fish Audio uses the official `https://api.fish.audio/v1/tts` endpoint. Its 20-second request deadline includes reading the response; audio is limited to 10 MiB.
- Temporary audio files use mode `0600` and are removed after playback or failure. Playback has a 60-second deadline. A leading `Pi` is pronounced `/paɪ/`.
- Bark has a 10-second request deadline and checks the response for every configured device.
- The package includes both native entrypoints, the shared core, and their configuration examples and guides. Personal configuration, tests, dependencies, and temporary files are excluded.

## Diagnostics and manual testing

Delivery failures appear through Pi's native `ctx.ui.notify(..., "warning")`. RPC clients receive an `extension_ui_request` notification that needs no response. Headless modes, or a failed UI notification, use stderr. These warnings do not add conversation messages or start another agent turn.

Diagnostics distinguish credential lookup, HTTP requests, responses, temporary storage, and playback. Diagnostic text is currently Chinese; `language` controls recaps and notification presentation. Fish Audio errors include safe service details and guidance for:

| Status | Meaning |
| --- | --- |
| 400 | Invalid parameters or an unavailable voice reference. |
| 401 | Missing or invalid API key. |
| 402 | Insufficient API credit. |
| 403 | Insufficient permissions for the resource. |
| 404 | Model or voice not found. |
| 422 | Request validation failure. |
| 429 | Rate limit reached; a valid `Retry-After` hint is shown. |
| 5xx | Service failure. |

Error bodies are limited to 16 KiB. Known request secrets and text are redacted; HTML error pages and validation `input` / `ctx` fields are omitted. DNS, connection, TLS, and filesystem failures retain a safe error code. For example, `ECONNRESET` indicates a transport reset and does not establish whether Fish Audio or an intermediary disconnected.

Repeated errors from the same backend and cause are shown once per session. A successful delivery resets that backend's suppression. Cancellation and stale results stay quiet. Delivery is not retried immediately; the next notification or a manual test tries again. The extension does not keep a persistent request log.

Run one of these commands in Pi to test the configured path:

```text
/pi-brief-test idle
/pi-brief-test permission
/pi-brief-test question
/pi-brief-test error
```

The command returns immediately and reports its summary and backend results when background work finishes. These manual tests call the configured model and notification services and may incur their normal usage charges. After changing configuration or rotating command-provided credentials, run `/reload` first.

## Development and verification

```bash
npm ci --ignore-scripts
npm run check
```

`npm run check` runs strict TypeScript checking and the test suite. Tests cover lifecycle handling, native Pi UI events, cancellation, lazy credentials, summary suppression, redaction, backend failures, and package contents. Fish HTTP tests use controlled responses and an injected player; only the native player test requires macOS.

The package integration test launches the real pinned Pi CLI with a fresh profile and an unpacked tarball that has no local `node_modules`. It exercises command discovery, a credential command, RPC responsiveness while a local Bark server delays its response, successful delivery, and a safe failure notification. Model summarization is disabled for this test; it does not use personal configuration, a live model provider, Fish Audio, or real Bark devices.

The [check workflow](../.github/workflows/check.yml) defines the supported Node and OS matrix. The [Gitleaks workflow](../.github/workflows/gitleaks.yml) runs on pushes, pull requests, and manual dispatches, scans the full fetched Git history, and redacts findings. Actions are pinned to commit SHAs; the Gitleaks binary is pinned to a release and verified against its SHA-256 checksum. Workflows use read-only repository permissions.

## References

- [Pi extensions and lifecycle](https://github.com/earendil-works/pi/blob/v0.99.2/packages/coding-agent/docs/extensions.md)
- [Pi package distribution and host dependencies](https://github.com/earendil-works/pi/blob/v0.99.2/packages/coding-agent/docs/packages.md)
- [Pi RPC protocol](https://github.com/earendil-works/pi/blob/v0.99.2/packages/coding-agent/docs/rpc.md)
- [Fish Audio errors](https://docs.fish.audio/api-reference/errors) and [TTS endpoint](https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech)

## License

[MIT](../LICENSE) © 2026 vizmoe.
