# agent-brief

Short voice and push notifications for **Codex and Pi**, maintained as one package with one version and a shared core. Fish Audio produces local speech; Bark sends push notifications. Native host adapters collect task evidence, preserve cancellation, and keep notification work outside the foreground agent turn.

| Native entrypoint | Install and use |
| --- | --- |
| Codex lifecycle plugin | [Codex guide](docs/codex.md); hooks, `/codex-brief` skill, and `scripts/codex-brief.mts` diagnostics |
| Pi extension | [Pi guide](docs/pi.md); `index.ts` and `/pi-brief-test` |

Node's minimum version is declared in [package.json](package.json). Pi supplies its host modules; Codex uses a logged-in Codex CLI for summaries. Local speech needs macOS and `afplay`; Bark and the portable checks work on Linux too. There are no runtime npm dependencies or build steps, and Codex does not load Pi's modules.

## Install

For Pi:

```bash
pi install git:github.com/vizmoe/agent-brief
```

For Codex, register the repository marketplace:

```bash
codex plugin marketplace add vizmoe/agent-brief
```

Then select **Agent Brief** in the desktop Plugins Directory, install the plugin, and review and trust its hooks. Start a new chat to load them. The [repository marketplace](.agents/plugins/marketplace.json) points at the same root package used by Pi. See the [official Codex packaging guide](https://developers.openai.com/plugins/build/plugins) for native marketplace and hook-trust setup.

## Configure

Notifications stay disabled until a user configuration is present. Both entrypoints accept this schema:

```json
{
  "language": "en",
  "fishAudio": {
    "apiKey": "$FISH_API_KEY",
    "referenceId": "$FISH_REFERENCE_ID"
  },
  "bark": {
    "serverUrl": "$BARK_SERVER_URL",
    "deviceKeys": ["$BARK_DEVICE_KEY"]
  }
}
```

Omit a backend, or set it to `false`, to disable it. `enabled: false` disables all delivery. Credential fields accept literal values, `$NAME` / `${NAME}`, or a whole `!{command}` expression. Keep personal files outside the checkout.

| Host | Default configuration | Host override |
| --- | --- | --- |
| Codex | `$CODEX_HOME/codex-brief/config.json`, normally `~/.codex/codex-brief/config.json` | `CODEX_BRIEF_CONFIG` |
| Pi | `pi-brief/config.json` under Pi's agent directory, normally `~/.pi/agent/pi-brief/config.json` | `PI_BRIEF_CONFIG` |

Set `AGENT_BRIEF_CONFIG` to share one file across both hosts; it takes precedence over the host override. Files are never merged. Native summary providers, voice-model defaults, and command working directories remain host-specific; see each guide before sharing command expressions. The [example](config.example.json) is a template, never an implicit configuration source.

## Migrate existing installations

The repository was renamed from `vizmoe/pi-brief`; the maintained Codex plugin was imported from the local `tts/codex-brief` source. Git history for Pi is preserved. No media, personal settings, credentials, or older Doubao tools are included.

- **Pi:** remove the old Git installation with `pi remove git:github.com/vizmoe/pi-brief`, then install the new URL and run `/reload`. For an automatically discovered local checkout, update that checkout instead of installing a second copy. The existing configuration and `/pi-brief-test` command still work.
- **Codex:** disable the old `codex-brief@personal` plugin, install Agent Brief, trust its hooks, and open a new chat. Keep the old configuration: `fishAudio.voiceId`, `bark.deviceKey`, and top-level `quietHours` are normalized by the Codex adapter. New installations can use the shared schema above. Existing `--check`, `--check-summary`, `--test`, and `--paths` commands remain at `scripts/codex-brief.mts`.

Only one copy per host should be enabled to avoid duplicate notifications. Repository consolidation does not reinstall an active plugin or alter user hook trust. New changes belong in this repository; the old local Codex source is no longer the development entrypoint.

## Development

```bash
git clone https://github.com/vizmoe/agent-brief.git
cd agent-brief
npm ci --ignore-scripts
npm run check
npm run audit
```

`core/` owns configuration parsing, credential resolution, safe errors, evidence redaction, policy, Fish Audio transport/playback, and Bark transport. It imports only Node built-ins and other core modules. `adapters/pi/` owns Pi lifecycle, UI and model integration. `adapters/codex/` owns Codex hooks, persistent cancellation/deduplication, isolated CLI summaries, and the cross-process playback lock. The root entrypoints load only their own adapter.

The root [package.json](package.json) is the version authority. Use `npm version <version> --no-git-tag-version` on a delivery branch: its version hook updates the Codex manifest, and npm updates the lockfile. `npm run check:version` rejects drift. There are no independent host releases or timestamp cache-buster versions. Git/tarball distribution includes both native entrypoints; npm registry publication is disabled.

Tests use isolated profiles, packaged artifacts and a local Bark fixture. Pi integration launches the pinned real CLI; Codex integration runs the packaged hook and detached worker, with a local executable fixture for model output. This verifies process wiring, not live model generation. Fish transport uses controlled HTTP responses and a player fixture; the native player test runs only on macOS. Manual service checks are documented in the host guides and use the configured service quota. CI runs both adapters through the [existing Node/OS matrix](.github/workflows/check.yml), audit policy and [Gitleaks](.github/workflows/gitleaks.yml).

[MIT](LICENSE) © 2026 vizmoe.
