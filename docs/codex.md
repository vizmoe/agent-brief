# Agent Brief for Codex

The Codex entrypoint provides native lifecycle hooks, background delivery and concise task summaries. Install it from the [root guide](../README.md#install). Codex hook installation requires the user's trust review; installation alone does not activate untrusted hooks.

## Configuration

Use the [shared schema](../README.md#configure) in `~/.codex/codex-brief/config.json`. `CODEX_HOME`, `CODEX_BRIEF_CONFIG`, and the higher-priority `AGENT_BRIEF_CONFIG` override are supported. The Codex adapter also accepts existing `fishAudio.voiceId`, `bark.deviceKey`, and top-level `quietHours`; canonical fields take precedence when both are present.

```json
{
  "fishAudio": {
    "apiKey": "!{security find-generic-password -s fish-audio-api-key -w}",
    "referenceId": "$FISH_REFERENCE_ID"
  }
}
```

Fish Audio and Bark can be enabled separately. The native Fish model default remains in [the Codex configuration adapter](../adapters/codex/config.mts); specify `fishAudio.model` to override it. Bark uses the shared `/push` batch endpoint and verifies every device result. `language` controls recap and notification language. `notify.quietHours` suppresses ordinary completion; questions, permissions and errors remain eligible.

Codex's credential commands run from the user's home directory, through the user's shell, with stdin closed. Values must resolve to one nonempty line. Each channel resolves its fields sequentially and stops after a failure. Commands, stdout, stderr and credentials are excluded from evidence and error logs. Command exit, cancellation, and timeout clean up the process group. Command limits live in [the adapter policy](../adapters/codex/config.mts).

Commands must work without interactive login. For secret-manager CLIs that automatically open a browser, first check login status and exit if unavailable, for example `!{secret-cli login status --silent >/dev/null 2>&1 && secret-cli read ...}`. Complete login manually outside the background hook. Agent Brief has no dependency on a particular secret manager.

`summary.model` can select a Codex CLI model. Pi's model references use its own `provider/model-id` format, so omit this field when sharing a configuration unless both hosts accept the chosen value. `summary: false` disables model calls; an explicit pending question still gets an evidence-based fallback. Invalid model output without such a question stays silent.

## Lifecycle and state

[hooks/hooks.json](../hooks/hooks.json) uses `PLUGIN_ROOT` to locate `scripts/codex-brief.mts`. The foreground hook records bounded evidence and cancellation markers; summary, HTTP requests and playback run in a detached worker.

| Event | Native behavior |
| --- | --- |
| `SessionStart` | Reset notification state and cancel stale work |
| `UserPromptSubmit` | Start a new turn and cancel stale work |
| `PreToolUse` / `PostToolUse` | Record evidence; new activity cancels old notifications |
| `PermissionRequest` | Record a candidate; subsequent evidence must show authorization is still needed |
| `Stop` | Summarize the final outcome, delaying ordinary completion to allow further activity |
| `Interrupt` / `SessionEnd` | Cancel pending notifications and stale playback |

Child agents and the summary observer stay quiet. Short tasks and empty acknowledgments do not produce ordinary completion notices. Shared policy lives in [core/policy.ts](../core/policy.ts); host process and summary settings live in [the Codex adapter](../adapters/codex/config.mts). Native summaries run in an isolated, ephemeral, read-only Codex CLI process without tools and without the main conversation or notification credentials.

State uses `PLUGIN_DATA` when provided; direct commands fall back to the user's Codex Brief data directory. Logs remain at `~/.codex/codex-brief/brief.log`. Configuration and credentials never go into the plugin cache. Fish audio uses the shared bounded transport and private temporary files, while Codex's process-wide lock serializes native playback. New host activity cancels delivery and stops stale audio.

## Diagnostics

From the installed plugin root:

```bash
node scripts/codex-brief.mts --paths
node scripts/codex-brief.mts --check
node scripts/codex-brief.mts --check-summary
node scripts/codex-brief.mts --test
```

`--paths` is read-only. `--check` resolves the Fish API key and checks the service without playing audio. `--check-summary` calls the configured summary model without retrieving Fish credentials. `--test` plays a short voice test. Networked diagnostics consume normal service quota.

After installing or updating, open a new Codex chat to load the current hooks and skill. The native `codex-brief` skill is preserved for configuration and diagnosis.
