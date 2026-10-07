import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  isQuietTime,
  isRootHookEvent,
  jobIsCurrentForTest,
  processHookEvent,
} from "../../adapters/codex/runtime.mts";
import {
  extractChangedFiles,
  extractPendingAction,
  extractValidation,
} from "../../adapters/codex/evidence.mts";
import {
  parseSummaryOutput,
  buildSummaryCommandForTest,
} from "../../adapters/codex/summary.mts";
import {
  redactSensitive,
  secretFreeEnvironmentForTest,
} from "../../adapters/codex/shared.mts";

const runtimePath = fileURLToPath(
  new URL("../../scripts/codex-brief.mts", import.meta.url),
);

const rootBase = {
  session_id: "root-session-1",
  turn_id: "turn-1",
  transcript_path: null,
  cwd: "/Users/test/workspace/project",
  model: "gpt-5.6-sol",
  permission_mode: "default",
};

async function withState<T>(
  name: string,
  callback: (stateDirectory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), `${name}-`));
  const previousState = process.env.CODEX_BRIEF_STATE_DIR;
  const previousLog = process.env.CODEX_BRIEF_LOG_PATH;
  process.env.CODEX_BRIEF_STATE_DIR = directory;
  process.env.CODEX_BRIEF_LOG_PATH = join(directory, "brief.log");
  try {
    return await callback(directory);
  } finally {
    if (previousState === undefined) {
      delete process.env.CODEX_BRIEF_STATE_DIR;
    } else {
      process.env.CODEX_BRIEF_STATE_DIR = previousState;
    }
    if (previousLog === undefined) {
      delete process.env.CODEX_BRIEF_LOG_PATH;
    } else {
      process.env.CODEX_BRIEF_LOG_PATH = previousLog;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

test("root detection fails closed for every child-agent shape", () => {
  assert.equal(isRootHookEvent({ ...rootBase, hook_event_name: "Stop" }), true);
  assert.equal(
    isRootHookEvent({
      ...rootBase,
      hook_event_name: "PreToolUse",
      agent_id: "child-1",
      agent_type: "worker",
    }),
    false,
  );
  assert.equal(
    isRootHookEvent({
      ...rootBase,
      hook_event_name: "PermissionRequest",
      agent_id: "child-1",
    }),
    false,
  );
  assert.equal(
    isRootHookEvent({
      ...rootBase,
      hook_event_name: "UserPromptSubmit",
      agent_type: "worker",
    }),
    false,
  );
  assert.equal(
    isRootHookEvent({
      ...rootBase,
      hook_event_name: "SubagentStop",
      agent_id: "child-1",
      agent_type: "worker",
    }),
    false,
  );
});

test("successful patch evidence extracts changed paths without absolute home paths", () => {
  const files = extractChangedFiles(
    "apply_patch",
    {
      command: [
        "*** Begin Patch",
        "*** Update File: src/notifier.ts",
        "*** Move to: /Users/test/workspace/project/src/notification.ts",
        "*** Add File: tests/notifier.test.ts",
        "*** End Patch",
      ].join("\n"),
    },
    "/Users/test/workspace/project",
  );
  assert.deepEqual(files, [
    "src/notifier.ts",
    "src/notification.ts",
    "tests/notifier.test.ts",
  ]);
  assert.deepEqual(
    extractChangedFiles("Bash", { command: "sed -i x file" }),
    [],
  );
});

test("validation is recorded only from an explicit successful validation result", () => {
  assert.equal(
    extractValidation(
      "Bash",
      { command: "npm test" },
      "Tests passed: 42 passed",
    ),
    "Validation completed successfully.",
  );
  assert.equal(
    extractValidation("Bash", { command: "npm test" }, "no output"),
    undefined,
  );
  assert.equal(
    extractValidation(
      "Bash",
      { command: "npm test" },
      "42 passed, 1 failed; exited with code 1",
    ),
    undefined,
  );
  assert.equal(
    extractValidation("Bash", { command: "echo success" }, "success"),
    undefined,
  );
});

test("pending question extraction prefers the human-facing question", () => {
  assert.equal(
    extractPendingAction("request_user_input", {
      questions: [
        {
          id: "mode",
          question: "请选择一次切换还是渐进迁移。",
          options: [{ label: "渐进迁移" }],
        },
      ],
    }),
    "请选择一次切换还是渐进迁移。",
  );
});

test("summary evidence redacts credentials, IDs, URLs, home paths and hidden blocks", () => {
  const sanitized = redactSensitive(
    [
      "Authorization: Bearer secret-value",
      "FISH_API_KEY=super-secret",
      "sk-1234567890abcdef",
      "dc020cb237df4248907565718715b20b",
      "https://example.test/private",
      "/Users/test/workspace/project/private.txt",
      "<!-- hidden -->",
      "<oai-mem-citation>secret memory</oai-mem-citation>",
    ].join(" "),
  );
  for (const secret of [
    "secret-value",
    "super-secret",
    "sk-1234567890abcdef",
    "dc020cb237df4248907565718715b20b",
    "example.test",
    "/Users/shiro",
    "hidden",
    "secret memory",
  ]) {
    assert.equal(sanitized.includes(secret), false, sanitized);
  }
});

test("summary parsing keeps a natural sentence beyond the soft target intact", () => {
  const natural =
    "Codex 通知逻辑已经完成重写，并通过状态机、并发去重、子代理隔离与密钥脱敏测试；新的摘要代理会根据真实结果生成完整短句，不再按固定字符数截断播报。";
  assert.ok(natural.length > 60);
  const result = parseSummaryOutput(
    JSON.stringify({
      event: "idle",
      text: natural,
      actionRequired: false,
    }),
  );
  assert.equal(result?.text, natural);
  assert.equal(
    parseSummaryOutput(
      JSON.stringify({
        event: "idle",
        text: "详情请查看 Codex",
        actionRequired: false,
      }),
    ),
    undefined,
  );
  assert.equal(
    parseSummaryOutput(
      JSON.stringify({
        event: "permission",
        text: "Codex 正在等待授权。",
        actionRequired: false,
      }),
    ),
    undefined,
  );
});

test("idle summaries report progress without redundant no-action boilerplate", async () => {
  for (const text of [
    "Codex 已完成配置更新，用户无需立即操作。",
    "Codex 已完成配置更新，目前不需要你干预。",
    "Codex 已完成配置更新，无需用户进一步处理。",
    "Codex finished the configuration update. No user action is required.",
  ]) {
    assert.equal(
      parseSummaryOutput(
        JSON.stringify({ event: "idle", text, actionRequired: false }),
      ),
      undefined,
      text,
    );
  }

  assert.deepEqual(
    parseSummaryOutput(
      JSON.stringify({
        event: "question",
        text: "Codex 已完成配置检查，需要你选择部署环境后继续。",
        actionRequired: true,
      }),
    ),
    {
      event: "question",
      text: "Codex 已完成配置检查，需要你选择部署环境后继续。",
      actionRequired: true,
    },
  );
});

test("Summary Agent command is ephemeral, read-only, tool-free and secret-free", () => {
  const command = buildSummaryCommandForTest();
  assert.equal(command.command, "codex");
  assert.ok(command.args.includes("exec"));
  assert.ok(command.args.includes("--ephemeral"));
  assert.ok(command.args.includes("--ignore-user-config"));
  assert.ok(command.args.includes("--ignore-rules"));
  assert.ok(command.args.includes("read-only"));
  assert.ok(command.args.includes("never"));
  assert.ok(command.args.includes("hooks"));
  assert.ok(command.args.includes("shell_tool"));
  assert.ok(command.args.includes("code_mode_host"));
  assert.equal(command.env.CODEX_BRIEF_OBSERVER, "1");
  assert.equal(command.env.FISH_API_KEY, undefined);
  assert.equal(command.env.BARK_DEVICE_KEY, undefined);
});

test("observer environment uses an explicit allowlist and rejects credentialed proxies", () => {
  const environment = secretFreeEnvironmentForTest({
    HOME: "/Users/test",
    PATH: "/usr/bin",
    CODEX_HOME: "/Users/test/.codex",
    CODEX_API_KEY: "codex-secret",
    OPENAI_REQUEST_TOKEN: "request-secret",
    FISH_API_KEY: "fish-secret",
    HTTPS_PROXY: "https://proxy.example.test:8443",
    HTTP_PROXY: "http://user:password@proxy.example.test:8080",
  });
  assert.equal(environment.HOME, "/Users/test");
  assert.equal(environment.CODEX_HOME, "/Users/test/.codex");
  assert.equal(environment.HTTPS_PROXY, "https://proxy.example.test:8443");
  assert.equal(environment.HTTP_PROXY, undefined);
  assert.equal(environment.CODEX_API_KEY, undefined);
  assert.equal(environment.OPENAI_REQUEST_TOKEN, undefined);
  assert.equal(environment.FISH_API_KEY, undefined);
});

test("quiet hours are start-inclusive and end-exclusive across midnight", () => {
  const quiet = {
    enabled: true,
    start: "23:00",
    end: "08:00",
    allowDuringQuietHours: ["permission", "error"] as const,
  };
  assert.equal(isQuietTime(new Date(2026, 0, 1, 23, 0), quiet), true);
  assert.equal(isQuietTime(new Date(2026, 0, 2, 7, 59), quiet), true);
  assert.equal(isQuietTime(new Date(2026, 0, 2, 8, 0), quiet), false);
  assert.equal(isQuietTime(new Date(2026, 0, 2, 12, 0), quiet), false);
});

test("question candidates are cancelled by subsequent root activity", async () => {
  await withState("codex-notify-cancel", async () => {
    const scheduled: Array<Parameters<typeof jobIsCurrentForTest>[0]> = [];
    const schedule = async (
      job: Parameters<typeof jobIsCurrentForTest>[0],
    ): Promise<void> => {
      scheduled.push(job);
    };
    await processHookEvent(
      {
        ...rootBase,
        hook_event_name: "UserPromptSubmit",
        prompt: "实现通知 Hook。",
      },
      1_000,
      schedule,
    );
    const question = await processHookEvent(
      {
        ...rootBase,
        hook_event_name: "PreToolUse",
        tool_name: "request_user_input",
        tool_use_id: "question-1",
        tool_input: {
          questions: [{ question: "请选择部署环境。" }],
        },
      },
      3_000,
      schedule,
    );
    assert.equal(question.length, 1);
    assert.equal(question[0]?.kind, "question");
    assert.equal(await jobIsCurrentForTest(question[0]!), true);

    await processHookEvent(
      {
        ...rootBase,
        hook_event_name: "PostToolUse",
        tool_name: "request_user_input",
        tool_use_id: "question-1",
        tool_input: {
          questions: [{ question: "请选择部署环境。" }],
        },
        tool_response: "prod",
      },
      3_100,
      schedule,
    );
    assert.equal(await jobIsCurrentForTest(question[0]!), false);
    assert.equal(scheduled.length, 1);
  });
});

test("auto-review-safe default records PermissionRequest without speaking immediately", async () => {
  await withState("codex-notify-permission-safe", async () => {
    const scheduled: unknown[] = [];
    const jobs = await processHookEvent(
      {
        ...rootBase,
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: {
          command: "git push",
          description: "发布已经完成的分支",
        },
      },
      2_000,
      async (job) => {
        scheduled.push(job);
      },
    );
    assert.deepEqual(jobs, []);
    assert.deepEqual(scheduled, []);
  });
});

test("a new root prompt cancels an idle candidate while child activity does not", async () => {
  await withState("codex-notify-root", async () => {
    const schedule = async (): Promise<void> => {};
    await processHookEvent(
      {
        ...rootBase,
        hook_event_name: "UserPromptSubmit",
        prompt: "原任务",
      },
      0,
      schedule,
    );
    const stop = await processHookEvent(
      {
        ...rootBase,
        hook_event_name: "Stop",
        stop_hook_active: false,
        last_assistant_message: "原任务已完成。",
      },
      20_000,
      schedule,
    );
    assert.equal(stop.length, 1);
    assert.equal(await jobIsCurrentForTest(stop[0]!), true);

    await processHookEvent(
      {
        ...rootBase,
        hook_event_name: "UserPromptSubmit",
        agent_id: "child-session",
        agent_type: "worker",
        prompt: "子任务",
      },
      21_000,
      schedule,
    );
    assert.equal(await jobIsCurrentForTest(stop[0]!), true);

    await processHookEvent(
      {
        ...rootBase,
        turn_id: "turn-2",
        hook_event_name: "UserPromptSubmit",
        prompt: "继续处理。",
      },
      22_000,
      schedule,
    );
    assert.equal(await jobIsCurrentForTest(stop[0]!), false);
  });
});

test("64 concurrent identical Stop events schedule exactly one job", async () => {
  await withState("codex-notify-dedupe", async () => {
    const jobs: unknown[] = [];
    const schedule = async (job: unknown): Promise<void> => {
      jobs.push(job);
    };
    const event = {
      ...rootBase,
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: "通知逻辑已经完成。",
    };
    const results = await Promise.all(
      Array.from({ length: 64 }, () =>
        processHookEvent(event, 20_000, schedule),
      ),
    );
    assert.equal(results.flat().length, 1);
    assert.equal(jobs.length, 1);
  });
});

test("identical Stop events stay deduplicated across clock-bucket boundaries", async () => {
  await withState("codex-notify-stop-boundary", async () => {
    const jobs: unknown[] = [];
    const event = {
      ...rootBase,
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: "通知逻辑已经完成。",
    };
    const first = await processHookEvent(event, 1_999, async (job) => {
      jobs.push(job);
    });
    const duplicate = await processHookEvent(event, 2_001, async (job) => {
      jobs.push(job);
    });
    assert.equal(first.length, 1);
    assert.deepEqual(duplicate, []);
    assert.equal(jobs.length, 1);
  });
});

test("a synchronous worker spawn failure releases the event claim for retry", async () => {
  await withState("codex-notify-retry", async () => {
    const event = {
      ...rootBase,
      hook_event_name: "Stop",
      last_assistant_message: "通知逻辑已经完成。",
    };
    await assert.rejects(
      processHookEvent(event, 20_000, async () => {
        throw new Error("spawn failed");
      }),
      /spawn failed/,
    );
    const retry = await processHookEvent(event, 20_000, async () => {});
    assert.equal(retry.length, 1);
  });
});

test("separate root sessions keep independent idle generations", async () => {
  await withState("codex-notify-sessions", async () => {
    const schedule = async (): Promise<void> => {};
    const first = await processHookEvent(
      {
        ...rootBase,
        session_id: "session-a",
        hook_event_name: "Stop",
        last_assistant_message: "A 已完成。",
      },
      20_000,
      schedule,
    );
    const second = await processHookEvent(
      {
        ...rootBase,
        session_id: "session-b",
        hook_event_name: "Stop",
        last_assistant_message: "B 已完成。",
      },
      20_000,
      schedule,
    );
    assert.equal(await jobIsCurrentForTest(first[0]!), true);
    assert.equal(await jobIsCurrentForTest(second[0]!), true);
  });
});

test("SessionStart produces no hidden context or stdout", async () => {
  await withState("codex-notify-session", async (directory) => {
    const result = spawnSync(process.execPath, [runtimePath], {
      input: JSON.stringify({
        session_id: "session-start-test",
        turn_id: "session",
        hook_event_name: "SessionStart",
        source: "startup",
      }),
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_BRIEF_STATE_DIR: directory,
        CODEX_BRIEF_LOG_PATH: join(directory, "brief.log"),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });
});
