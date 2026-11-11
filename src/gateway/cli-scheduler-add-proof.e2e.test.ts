/** TEMPORARY #193958 proof harness - not committed.
 * Real Gateway + real MCP loopback HTTP transport + real `claude` CLI subprocess.
 * Only the Anthropic provider responses are scripted (no credentials available).
 * Evidence is written to ./proof-evidence.txt because Vitest silences console here.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readRequestText } from "../../test/helpers/gateway-integration-fixtures.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createChatFixture } from "./gateway-chat-fixture.test-support.js";
import { KERNEL_TEST_ENV } from "./test-helpers.env.js";

const CLAUDE_BIN =
  process.env.OPENCLAW_PROOF_CLAUDE_BIN ?? "/tmp/claude-cli/node_modules/.bin/claude";
const MODEL_REF = "claude-cli/claude-sonnet-5";
const REMINDER_REPLY = "Sure - I'll remind you tomorrow at 9am to call the dentist.";
const NOTE_FRAGMENT = "I did not schedule a reminder";
const SCHEDULER_TOOL = "mcp__openclaw__automations";
const EVIDENCE_FILE = path.join(process.cwd(), "proof-evidence.txt");
const CLAUDE_STDERR_FILE = path.join(os.tmpdir(), "proof-claude-stderr.log");

let providerPort = 0;
let scenario: "scheduled" | "control" = "scheduled";
const providerBodies: string[] = [];
const evidence: string[] = [];

function record(line: string) {
  evidence.push(line);
  fs.writeFileSync(EVIDENCE_FILE, evidence.join("\n"));
}

function messageStart() {
  return {
    type: "message_start",
    message: {
      id: `msg_${randomUUID()}`,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 0 },
    },
  };
}

function textTurnEvents(text: string) {
  return [
    messageStart(),
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 18 } },
    { type: "message_stop" },
  ];
}

function toolUseTurnEvents() {
  const input = {
    action: "add",
    job: {
      name: "dentist",
      schedule: { kind: "at", at: "2026-11-12T01:00:00.000Z" },
      prompt: "Call the dentist.",
    },
  };
  return [
    messageStart(),
    {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: `toolu_${randomUUID().slice(0, 12)}`,
        name: SCHEDULER_TOOL,
        input: {},
      },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
    },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 24 } },
    { type: "message_stop" },
  ];
}

function writeSse(response: ServerResponse, events: unknown[]) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const event of events) {
    const type = (event as { type: string }).type;
    response.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  response.end();
}

describe("#193958 real CLI path proof", () => {
  const provider = createServer((request, response) => {
    void (async () => {
      const body = await readRequestText(request);
      providerBodies.push(body);
      if (request.url?.includes("count_tokens")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ input_tokens: 12 }));
        return;
      }
      const hasToolResult = body.includes('"tool_result"');
      if (!hasToolResult && scenario === "scheduled") {
        writeSse(response, toolUseTurnEvents());
        return;
      }
      writeSse(response, textTurnEvents(REMINDER_REPLY));
    })().catch(() => {
      response.writeHead(500).end("proof provider failed");
    });
  });

  const originalPath = process.env.PATH;

  beforeAll(async () => {
    fs.writeFileSync(EVIDENCE_FILE, "");
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    providerPort = (provider.address() as { port: number }).port;
    expect(fs.existsSync(CLAUDE_BIN)).toBe(true);

    // The shipped backend resolves `claude` from PATH; the shim only injects the
    // scripted provider endpoint and tees stderr, so binary and transports stay real.
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-shim-"));
    const shim = path.join(binDir, "claude");
    fs.writeFileSync(
      shim,
      [
        "#!/bin/bash",
        `export ANTHROPIC_BASE_URL="http://127.0.0.1:${providerPort}"`,
        'export ANTHROPIC_AUTH_TOKEN="proof-token"',
        'export ANTHROPIC_API_KEY="proof-token"',
        `echo "[shim] $*" >> "${CLAUDE_STDERR_FILE}"`,
        `"${CLAUDE_BIN}" "$@" 2> >(tee -a "${CLAUDE_STDERR_FILE}" >&2)`,
        "status=$?",
        `echo "[shim] exit=$status" >> "${CLAUDE_STDERR_FILE}"`,
        "exit $status",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    process.env.PATH = originalPath;
  }, 60_000);

  async function runTurn(label: string) {
    return await withOpenClawTestState(
      {
        label,
        env: {
          ...KERNEL_TEST_ENV,
          VITEST: process.env.VITEST,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          // Bundled plugins stay enabled: the anthropic plugin owns the claude-cli backend.
        },
      },
      async () => {
        const fixture = createChatFixture("cli-scheduler-proof", {
          configure: (config) => ({
            ...config,
            agents: {
              defaults: { ...config.agents?.defaults, model: { primary: MODEL_REF } },
              entries: {
                main: { models: { [MODEL_REF]: { agentRuntime: { id: "claude-cli" } } } },
              },
            },
          }),
        });
        await fixture.start();
        try {
          const sessionKey = `agent:main:proof-${randomUUID()}`;
          const accepted = await fixture.client.request<{ runId: string }>("chat.send", {
            sessionKey,
            message: "Remind me tomorrow at 9am to call the dentist.",
            deliver: true,
            idempotencyKey: randomUUID(),
          });
          const completed = await fixture.client.request("agent.wait", {
            runId: accepted.runId,
            timeoutMs: 150_000,
          });
          const history = await fixture.client.request<{ messages: unknown[] }>("chat.history", {
            sessionKey,
            limit: 100,
          });
          const historyJson = JSON.stringify(history.messages);
          const sawToolResult = providerBodies.some((body) => body.includes('"tool_result"'));
          const sawSchedulerToolUse = providerBodies.some((body) => body.includes(SCHEDULER_TOOL));
          const notePresent = historyJson.includes(NOTE_FRAGMENT);

          record(`\n===== ${label} =====`);
          record(`agent.wait: ${JSON.stringify(completed).slice(0, 1200)}`);
          record(`fixture.errors: ${JSON.stringify(fixture.errors).slice(0, 1200)}`);
          record(`provider requests: ${providerBodies.length}`);
          record(`provider saw tool_result: ${sawToolResult}`);
          record(`provider saw scheduler tool_use: ${sawSchedulerToolUse}`);
          record(`false reminder note present: ${notePresent}`);
          record(`history: ${historyJson.slice(0, 2500)}`);
          const stderr = fs.existsSync(CLAUDE_STDERR_FILE)
            ? fs.readFileSync(CLAUDE_STDERR_FILE, "utf8")
            : "(none)";
          record(`claude stderr (last 2500): ${stderr.slice(-2500)}`);
          return { notePresent, sawToolResult, sawSchedulerToolUse, completed, historyJson };
        } finally {
          await fixture.close();
        }
      },
    );
  }

  it("suppresses the false note after a real claude CLI scheduler add", async () => {
    scenario = "scheduled";
    const result = await runTurn("SCHEDULED (real claude CLI, mcp add)");
    expect(result.sawSchedulerToolUse).toBe(true);
    expect(result.sawToolResult).toBe(true);
    expect(result.notePresent).toBe(false);
  }, 300_000);

  it("still reports the note when no scheduler add happened", async () => {
    scenario = "control";
    const result = await runTurn("CONTROL (real claude CLI, no add)");
    expect(result.sawToolResult).toBe(false);
    expect(result.notePresent).toBe(true);
  }, 300_000);
});
