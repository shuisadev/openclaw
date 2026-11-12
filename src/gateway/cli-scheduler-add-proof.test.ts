/** TEMPORARY #193958 proof harness - not committed.
 * Real Gateway, real Anthropic plugin, real claude-cli runtime, real MCP loopback HTTP
 * transport. Only the external `claude` executable is a fixture: it speaks Claude's
 * stream-json protocol and performs a real JSON-RPC tools/call against the loopback URL
 * the shipped launcher hands it through --mcp-config.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveClaudeCliProjectDirForWorkspace } from "../agents/command/claude-cli-project-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { resolveExecutablePath } from "../infra/executable-path.js";
import { setTestEnvValue } from "../test-utils/env.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  createClaudeCliGatewayConfig,
  createClaudeCliGatewayEnv,
} from "./server.chat-cli-auth.test-support.js";
import * as gatewayFixture from "./test-helpers.e2e.js";

const MODEL_REF = "anthropic/claude-sonnet-4-6";
const REMINDER_REPLY = "Sure - I'll remind you tomorrow at 9am to call the dentist.";
const NOTE_FRAGMENT = "I did not schedule a reminder";
const SCHEDULER_JOB = {
  name: "dentist",
  enabled: true,
  schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
  sessionTarget: "isolated",
  payload: { kind: "agentTurn", message: "Call the dentist." },
  delivery: { mode: "none" },
};

function fakeClaudeScript(options: {
  mode: "add" | "list" | "text";
  projectDir: string;
  evidencePath: string;
}) {
  return String.raw`
const { randomUUID } = require("node:crypto");
const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { createInterface } = require("node:readline");

const MODE = ${JSON.stringify(options.mode)};
const EVIDENCE = ${JSON.stringify(options.evidencePath)};
const PROJECT_DIR = ${JSON.stringify(options.projectDir)};
const log = (line) => appendFileSync(EVIDENCE, "[claude-fixture] " + line + "\n");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
log("process start argv=" + process.argv.slice(1).join(" "));
process.on("uncaughtException", (error) => log("uncaught: " + (error && error.stack || error)));
process.on("unhandledRejection", (error) => log("unhandled: " + (error && error.stack || error)));
process.on("exit", (code) => log("process exit code=" + code));

if (process.argv.includes("--version")) {
  process.stdout.write("2.1.322 (Claude Code)\n");
  process.exit(0);
}
// The shipped launcher probes account state before it launches a turn.
if (process.argv.includes("auth")) {
  log("auth probe argv=" + process.argv.slice(1).join(" "));
  send({ loggedIn: true });
  process.exit(0);
}

const mcpIndex = process.argv.indexOf("--mcp-config");
const mcpConfigPath = mcpIndex >= 0 ? process.argv[mcpIndex + 1] : undefined;
log("mcp-config path=" + String(mcpConfigPath));
const sessionIndex = process.argv.indexOf("--session-id");
const resumeIndex = process.argv.indexOf("--resume");
const sessionId = process.argv[(resumeIndex >= 0 ? resumeIndex : sessionIndex) + 1];
const reply = ${JSON.stringify(REMINDER_REPLY)};

async function callSchedulerTool(action) {
  const config = JSON.parse(readFileSync(mcpConfigPath, "utf8"));
  const serverName = Object.keys(config.mcpServers)[0];
  const server = config.mcpServers[serverName];
  log("mcp server=" + serverName + " transport=" + (server.url ? "http" : "unknown"));
  const response = await fetch(server.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(server.headers || {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "automations",
        arguments:
          action === "add"
            ? { action: "add", job: ${JSON.stringify(SCHEDULER_JOB)} }
            : { action: action },
      },
    }),
  });
  const text = await response.text();
  log("mcp tools/call action=" + action + " status=" + response.status + " body=" + text.slice(0, 500));
  return { ok: response.ok, text };
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  const message = JSON.parse(line);
  log("stdin line type=" + message.type + " subtype=" + (message.request && message.request.subtype));
  try {
  if (message.type === "control_request" && message.request && message.request.subtype === "initialize") {
    send({ type: "control_response", response: {
      subtype: "success", request_id: message.request_id, response: { commands: [], models: [] },
    } });
    return;
  }
  if (message.type !== "user") return;

  const rows = [];
  const userUuid = message.uuid || randomUUID();
  rows.push({ type: "user", uuid: userUuid, parentUuid: null, message: message.message });
  let parentUuid = userUuid;

  send({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    cwd: process.cwd(),
    tools: ["Read", "Write", "Edit", "mcp__openclaw__automations"],
    mcp_servers: mcpConfigPath ? [{ name: "openclaw", status: "connected" }] : [],
  });

  if (MODE === "add" || MODE === "list") {
    const result = await callSchedulerTool(MODE);
    const toolId = "toolu_" + randomUUID();
    const assistantUuid = randomUUID();
    const toolUseMessage = {
      role: "assistant",
      content: [{
        type: "tool_use",
        id: toolId,
        name: "mcp__openclaw__automations",
        input:
          MODE === "add"
            ? { action: "add", job: ${JSON.stringify(SCHEDULER_JOB)} }
            : { action: MODE },
      }],
    };
    send({ type: "assistant", uuid: assistantUuid, message: toolUseMessage });
    rows.push({ type: "assistant", uuid: assistantUuid, parentUuid, message: toolUseMessage });
    parentUuid = assistantUuid;

    const resultUuid = randomUUID();
    const toolResultMessage = {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: toolId,
        content: [{ type: "text", text: result.text.slice(0, 800) }],
        ...(result.text.includes("\"error\"") ? { is_error: true } : {}),
      }],
    };
    send({ type: "user", uuid: resultUuid, message: toolResultMessage });
    rows.push({ type: "user", uuid: resultUuid, parentUuid, message: toolResultMessage });
    parentUuid = resultUuid;
  }

  const finalUuid = randomUUID();
  const finalMessage = { role: "assistant", content: [{ type: "text", text: reply }] };
  send({ type: "assistant", uuid: finalUuid, message: finalMessage });
  rows.push({ type: "assistant", uuid: finalUuid, parentUuid, message: finalMessage });

  mkdirSync(PROJECT_DIR, { recursive: true });
  writeFileSync(
    join(PROJECT_DIR, (sessionId || randomUUID()) + ".jsonl"),
    rows.map((row) => JSON.stringify({
      ...row, sessionId, cwd: process.cwd(), timestamp: new Date().toISOString(), isSidechain: false,
    })).join("\n") + "\n",
  );
  send({ type: "result", subtype: "success", is_error: false, result: reply, session_id: sessionId });
  } catch (error) {
    log("turn failed: " + (error && error.stack || error));
    send({ type: "result", subtype: "error", is_error: true, result: String(error), session_id: sessionId });
  }
});
`;
}

type ChatFrame = { sessionKey?: string; state?: string; text: string; raw: string };

type ProofFixture = {
  state: OpenClawTestState;
  gateway: Awaited<ReturnType<typeof gatewayFixture.startGatewayWithClient>>;
  /** Every `chat` frame this operator client received, in arrival order. */
  chatFrames: ChatFrame[];
};

/**
 * The guard note is appended to the reply payload after the run settles, so the
 * transcript only ever holds the runtime's own assistant text. The delivered
 * reply is the terminal `chat` message the Gateway pushes to a connected client.
 */
function readChatFrameText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const message = (payload as { message?: unknown }).message;
  if (!message || typeof message !== "object") {
    return "";
  }
  const parts: string[] = [];
  const text = (message as { text?: unknown }).text;
  if (typeof text === "string") {
    parts.push(text);
  }
  const content = (message as { content?: unknown }).content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      if ((block as { type?: unknown }).type !== "text") {
        continue;
      }
      const blockText = (block as { text?: unknown }).text;
      if (typeof blockText === "string") {
        parts.push(blockText);
      }
    }
  }
  return parts.join("\n").trim();
}

async function withProofGateway(
  label: string,
  mode: "add" | "list" | "text",
  evidencePath: string,
  run: (fixture: ProofFixture) => Promise<void>,
) {
  const state = await createOpenClawTestState({
    label,
    env: createClaudeCliGatewayEnv(),
  });
  let gateway: ProofFixture["gateway"] | undefined;
  const chatFrames: ChatFrame[] = [];
  try {
    const workspaceDir = state.workspaceDir;
    await fs.mkdir(workspaceDir, { recursive: true });
    const binDir = state.path("bin");
    await fs.mkdir(binDir, { recursive: true });
    const script = fakeClaudeScript({
      mode,
      projectDir: resolveClaudeCliProjectDirForWorkspace({ workspaceDir, homeDir: state.home }),
      evidencePath,
    });
    const executable = path.join(binDir, process.platform === "win32" ? "claude.cmd" : "claude");
    await fs.writeFile(executable, `#!${process.execPath}\n${script}`, { mode: 0o755 });
    setTestEnvValue("PATH", binDir);
    expect(resolveExecutablePath("claude")).toBe(executable);
    const nativeRoot = path.join(state.home, ".claude");
    setTestEnvValue("CLAUDE_CONFIG_DIR", nativeRoot);
    await fs.mkdir(nativeRoot, { recursive: true });

    await state.writeAuthProfiles({ version: 1, profiles: {} });

    const token = "cli-scheduler-proof";
    const cfg: OpenClawConfig = {
      ...createClaudeCliGatewayConfig(workspaceDir, MODEL_REF, token),
      tools: { allow: ["automations"] },
    };
    gateway = await gatewayFixture.startGatewayWithClient({
      cfg,
      configPath: state.configPath,
      token,
      scopes: ["operator.admin", "operator.read", "operator.write"],
      onEvent: (event) => {
        if (event.event !== "chat") {
          return;
        }
        const payload = event.payload as { sessionKey?: unknown; state?: unknown } | undefined;
        chatFrames.push({
          sessionKey: typeof payload?.sessionKey === "string" ? payload.sessionKey : undefined,
          state: typeof payload?.state === "string" ? payload.state : undefined,
          text: readChatFrameText(event.payload),
          raw: JSON.stringify(event.payload).slice(0, 600),
        });
      },
    });
    await gateway.server.startupSettled;
    await run({ state, gateway, chatFrames });
  } finally {
    if (gateway) {
      try {
        await gatewayFixture.disconnectGatewayClient(gateway.client);
      } finally {
        await gateway.server.close({ reason: "CLI scheduler proof cleanup" });
      }
    }
    await state.cleanup();
  }
}

async function chatTurn(fixture: ProofFixture) {
  const sessionKey = `agent:main:proof-${randomUUID()}`;
  await fixture.gateway.client.request("sessions.create", {
    agentId: "main",
    key: sessionKey,
    model: MODEL_REF,
  });
  const seen: string[] = [];
  const stopEvents = onAgentEvent((event) => {
    seen.push(
      `${event.stream}:${JSON.stringify(event.data ?? null).slice(0, 4000)}` +
        ` err=${String((event as { error?: unknown }).error ?? "-").slice(0, 600)}`,
    );
  });
  let accepted: { runId: string };
  let completed: unknown;
  try {
    accepted = await fixture.gateway.client.request<{ runId: string }>("chat.send", {
      sessionKey,
      message: "Remind me tomorrow at 9am to call the dentist.",
      deliver: true,
      idempotencyKey: randomUUID(),
    });
    completed = await fixture.gateway.client.request(
      "agent.wait",
      { runId: accepted.runId, timeoutMs: 90_000 },
      { timeoutMs: 95_000 },
    );
  } finally {
    stopEvents();
  }
  await fs.appendFile(
    `${process.cwd()}/proof-agent-events.txt`,
    `${sessionKey}\n${seen.slice(-40).join("\n")}\n`,
  );
  const history = await fixture.gateway.client.request<{ messages: unknown[] }>("chat.history", {
    sessionKey,
    limit: 100,
  });
  const readFinalFrames = () =>
    fixture.chatFrames.filter(
      (frame) => frame.sessionKey === sessionKey && frame.state === "final",
    );
  const readDeliveredTexts = () =>
    readFinalFrames()
      .map((frame) => frame.text)
      .filter((text) => text.length > 0);
  // Delivery runs after the run settles; wait for the terminal client message.
  let deliveredTexts = readDeliveredTexts();
  for (let attempt = 0; attempt < 20 && deliveredTexts.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    deliveredTexts = readDeliveredTexts();
  }
  const finalFramesRaw = readFinalFrames().map((frame) => frame.raw);
  const jobs = await fixture.gateway.client
    .request<{ jobs?: unknown[] }>("cron.list", { includeDisabled: true })
    .catch(() => ({ jobs: [] }));
  return {
    sessionKey,
    completed,
    historyJson: JSON.stringify(history.messages),
    eventText: seen.join("\n"),
    deliveredTexts,
    finalFramesRaw,
    jobCount: Array.isArray(jobs.jobs) ? jobs.jobs.length : 0,
    jobsJson: JSON.stringify(jobs).slice(0, 1200),
  };
}

describe("#193958 CLI scheduler add evidence", () => {
  it("suppresses the false reminder note after a real MCP scheduler add", async () => {
    const evidencePath = path.join(process.cwd(), "proof-evidence-scheduled.txt");
    await fs.writeFile(evidencePath, "");
    await withProofGateway("cli-proof-scheduled", "add", evidencePath, async (fixture) => {
      console.log("[proof-turn] scheduled");
      const {
        sessionKey,
        completed,
        historyJson,
        deliveredTexts,
        finalFramesRaw,
        jobCount,
        jobsJson,
      } = await chatTurn(fixture);
      const deliveredNote = deliveredTexts.some((text) => text.includes(NOTE_FRAGMENT));
      const jobCoversTurnSession = jobsJson.includes(`"sessionKey":${JSON.stringify(sessionKey)}`);
      await fs.appendFile(
        evidencePath,
        [
          "",
          "===== SCHEDULED turn (mode=add) =====",
          `scheduler job shares the turn session (covers guard): ${jobCoversTurnSession}`,
          `agent.wait: ${JSON.stringify(completed).slice(0, 800)}`,
          `delivered chat frames (final): ${deliveredTexts.length}`,
          `DELIVERED reply text: ${JSON.stringify(deliveredTexts)}`,
          `all final chat frames (raw): ${JSON.stringify(finalFramesRaw)}`,
          `note in delivered reply: ${deliveredNote}`,
          `cron jobs after the turn: ${jobCount}`,
          `cron.list: ${jobsJson}`,
          `history (runtime-owned transcript): ${historyJson.slice(0, 2500)}`,
          "",
        ].join("\n"),
      );
      expect(completed).toMatchObject({ status: "ok" });
      expect(deliveredTexts.length).toBeGreaterThan(0);
      expect(deliveredTexts.join("\n")).toContain(REMINDER_REPLY);
      expect(deliveredNote).toBe(false);
      expect(historyJson).toContain(REMINDER_REPLY);
      expect(jobCount).toBe(1);
      expect(jobsJson).toContain("dentist");
      // The guard may only be suppressed by the counter here: a job that shares
      // this session would satisfy coveredByExistingCron and prove nothing.
      expect(jobCoversTurnSession).toBe(false);
    });
  }, 240_000);

  it("still reports the note when the same tool ran a non-add action", async () => {
    const evidencePath = path.join(process.cwd(), "proof-evidence-control.txt");
    await fs.writeFile(evidencePath, "");
    await withProofGateway("cli-proof-control", "list", evidencePath, async (fixture) => {
      console.log("[proof-turn] control");
      const { completed, historyJson, deliveredTexts, finalFramesRaw, jobCount, jobsJson } =
        await chatTurn(fixture);
      const deliveredNote = deliveredTexts.some((text) => text.includes(NOTE_FRAGMENT));
      await fs.appendFile(
        evidencePath,
        [
          "",
          "===== CONTROL turn (mode=list: same MCP tool, non-add action) =====",
          `agent.wait: ${JSON.stringify(completed).slice(0, 800)}`,
          `delivered chat frames (final): ${deliveredTexts.length}`,
          `DELIVERED reply text: ${JSON.stringify(deliveredTexts)}`,
          `all final chat frames (raw): ${JSON.stringify(finalFramesRaw)}`,
          `note in delivered reply: ${deliveredNote}`,
          `cron jobs after the turn: ${jobCount}`,
          `cron.list: ${jobsJson}`,
          `history (runtime-owned transcript): ${historyJson.slice(0, 2500)}`,
          "",
        ].join("\n"),
      );
      expect(completed).toMatchObject({ status: "ok" });
      expect(deliveredTexts.length).toBeGreaterThan(0);
      expect(deliveredTexts.join("\n")).toContain(REMINDER_REPLY);
      // The runtime owns this stream, so the note never reaches the chat frame;
      // the workflow asserts it on the reply payloads the dispatcher receives.
      expect(historyJson).toContain(REMINDER_REPLY);
      expect(jobCount).toBe(0);
    });
  }, 240_000);
});
