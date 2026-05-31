#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile, appendFile, access, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import process from "node:process";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_PLAN = "agent-plans/plan.md";
const STATE_DIR = ".pi-orchestrator";
const OBSERVE_MODES = new Set(["compact", "transcript", "raw", "quiet"]);

function usage(exitCode = 0) {
  console.log(`Usage:
  pi-orchestrator tasks [workspace] [--plan ${DEFAULT_PLAN}]
  pi-orchestrator run [workspace] [--plan ${DEFAULT_PLAN}] [--prompt-file prompt.md] [--observe compact|transcript|raw|quiet] [--pi pi] [--once] [--max-tasks N]
  pi-orchestrator tail [workspace|log.jsonl] [--observe compact|transcript|raw|quiet]
  pi-orchestrator status [workspace]
  pi-orchestrator attach [workspace]

Workspace defaults to current directory.`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const [command = "help", ...rest] = argv;
  if (command === "--help" || command === "-h") usage(0);
  const opts = {
    command,
    workspace: undefined,
    plan: DEFAULT_PLAN,
    pi: "pi",
    promptFile: undefined,
    observe: "compact",
    once: false,
    maxTasks: Number.POSITIVE_INFINITY,
  };

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--help" || arg === "-h") usage(0);
    if (arg === "--plan") opts.plan = requireValue(rest, ++i, "--plan");
    else if (arg === "--pi") opts.pi = requireValue(rest, ++i, "--pi");
    else if (arg === "--prompt-file") opts.promptFile = requireValue(rest, ++i, "--prompt-file");
    else if (arg === "--observe") opts.observe = requireValue(rest, ++i, "--observe");
    else if (arg === "--once") opts.once = true;
    else if (arg === "--max-tasks") opts.maxTasks = Number(requireValue(rest, ++i, "--max-tasks"));
    else if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    else if (!opts.workspace) opts.workspace = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }

  opts.workspace = path.resolve(opts.workspace ?? process.cwd());
  if (!OBSERVE_MODES.has(opts.observe)) {
    throw new Error(`--observe must be one of: ${[...OBSERVE_MODES].join(", ")}`);
  }
  if (opts.maxTasks !== Number.POSITIVE_INFINITY && (!Number.isFinite(opts.maxTasks) || opts.maxTasks < 1)) {
    throw new Error("--max-tasks must be a positive number");
  }
  return opts;
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function statePaths(workspace) {
  const dir = path.join(workspace, STATE_DIR);
  return {
    dir,
    current: path.join(dir, "current.json"),
    runs: path.join(dir, "runs.jsonl"),
    logs: path.join(dir, "logs"),
  };
}

async function ensureStateDir(workspace) {
  const paths = statePaths(workspace);
  await mkdir(paths.logs, { recursive: true });
  return paths;
}

async function readPlan(workspace, planRel) {
  const planPath = path.resolve(workspace, planRel);
  const content = await readFile(planPath, "utf8");
  return { planPath, content };
}

function parseTasks(planContent) {
  const tasks = [];
  const lines = planContent.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^## Task\s+(\d+):\s*(.+?)\s*$/);
    if (!match) continue;
    const title = match[2];
    tasks.push({
      number: Number(match[1]),
      title,
      heading: line,
      line: i + 1,
      done: /(?:^|\s-\s|\b)DONE\b/i.test(line),
    });
  }
  return tasks;
}

function nextPendingTask(tasks) {
  return tasks.find((task) => !task.done);
}

async function commandTasks(opts) {
  const { content, planPath } = await readPlan(opts.workspace, opts.plan);
  const tasks = parseTasks(content);
  console.log(`Plan: ${planPath}`);
  if (tasks.length === 0) {
    console.log("No tasks found.");
    return;
  }
  for (const task of tasks) {
    console.log(`${task.done ? "✓" : "·"} line ${task.line}: ${task.heading}`);
  }
}

async function commandStatus(opts) {
  const current = await readCurrent(opts.workspace);
  if (!current) {
    console.log(`No orchestrator state in ${path.join(opts.workspace, STATE_DIR)}`);
    return;
  }
  console.log(JSON.stringify(current, null, 2));
}

async function commandTail(opts) {
  const logPath = await resolveTailLogPath(opts);
  await assertFileReadable(logPath, "Log");

  const observer = new EventObserver({ mode: opts.observe });
  let offset = await replayLog(logPath, observer);
  if (opts.observe !== "raw" && opts.observe !== "quiet") {
    console.log(`\n[tailing ${logPath}; Ctrl+C to stop]`);
  }

  process.on("SIGINT", () => process.exit(0));
  while (true) {
    await delay(1000);
    let info;
    try {
      info = await stat(logPath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (info.size < offset) offset = 0;
    if (info.size > offset) offset = await replayLog(logPath, observer, offset);
  }
}

async function resolveTailLogPath(opts) {
  if (opts.workspace.endsWith(".jsonl")) return opts.workspace;
  const current = await readCurrent(opts.workspace);
  if (!current?.logPath) {
    throw new Error(`No current logPath found in ${statePaths(opts.workspace).current}`);
  }
  return current.logPath;
}

async function replayLog(logPath, observer, start = 0) {
  let size = start;
  await new Promise((resolve, reject) => {
    const stream = createReadStream(logPath, { start, encoding: "utf8" });
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk;
      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) break;
        let line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        processLogLine(line, observer);
      }
    });
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  try {
    size = (await stat(logPath)).size;
  } catch {
    // Keep previous offset if the file disappeared after replay.
  }
  return size;
}

function processLogLine(line, observer) {
  if (!line.trim()) return;
  observer.observeLine(line);
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    if (observer.mode !== "raw" && observer.mode !== "quiet") console.error(`Failed to parse log line: ${line}`);
    return;
  }
  if (message.type !== "response") observer.observeEvent(message);
}

async function commandAttach(opts) {
  const current = await readCurrent(opts.workspace);
  if (!current?.sessionFile) {
    throw new Error("No sessionFile found in current state. Nothing to attach to.");
  }
  console.log(`Attaching to ${current.sessionFile}`);
  const child = spawn(opts.pi, ["--session", current.sessionFile], {
    cwd: current.workspace ?? opts.workspace,
    stdio: "inherit",
  });
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) reject(new Error(`pi exited via signal ${signal}`));
      else if (code && code !== 0) reject(new Error(`pi exited with code ${code}`));
      else resolve();
    });
  });
}

async function readCurrent(workspace) {
  try {
    const raw = await readFile(statePaths(workspace).current, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeCurrent(workspace, state) {
  const paths = await ensureStateDir(workspace);
  await writeFile(paths.current, JSON.stringify(state, null, 2) + "\n", "utf8");
}

async function appendRun(workspace, record) {
  const paths = await ensureStateDir(workspace);
  await appendFile(paths.runs, JSON.stringify(record) + "\n", "utf8");
}

async function commandRun(opts) {
  await assertPlanExists(opts.workspace, opts.plan);
  if (opts.promptFile) await assertFileReadable(resolveWorkspacePath(opts.workspace, opts.promptFile), "Prompt file");
  await ensureStateDir(opts.workspace);

  let completedThisRun = 0;
  while (completedThisRun < opts.maxTasks) {
    const { content } = await readPlan(opts.workspace, opts.plan);
    const tasks = parseTasks(content);
    const task = nextPendingTask(tasks);

    if (!task) {
      const state = baseState(opts, "done", { message: "All tasks are complete." });
      await writeCurrent(opts.workspace, state);
      orchestratorLog(opts, "All tasks are complete.");
      return;
    }

    orchestratorLog(opts, `\n=== Running ${task.heading} ===`);
    const result = await runTask(opts, task);
    completedThisRun++;

    const blocked = result.final.blocked;
    await appendRun(opts.workspace, result.runRecord);

    if (blocked) {
      await writeCurrent(opts.workspace, baseState(opts, "blocked", result.runRecord));
      orchestratorLog(opts, "\nBlocked. Attach with:");
      orchestratorLog(opts, `  cd ${shellQuote(opts.workspace)} && pi --session ${shellQuote(result.runRecord.sessionFile)}`);
      orchestratorLog(opts, `\nMessage: ${result.final.message}`);
      process.exitCode = 2;
      return;
    }

    orchestratorLog(opts, `Completed: ${result.final.message}`);
    if (opts.once) return;
  }
}

function orchestratorLog(opts, message = "") {
  if (opts.observe === "raw") console.error(message);
  else console.log(message);
}

function baseState(opts, status, extra = {}) {
  return {
    status,
    workspace: opts.workspace,
    plan: opts.plan,
    promptFile: opts.promptFile,
    observe: opts.observe,
    updatedAt: new Date().toISOString(),
    ...extra,
  };
}

async function assertPlanExists(workspace, planRel) {
  const planPath = path.resolve(workspace, planRel);
  await assertFileReadable(planPath, "Plan");
}

async function assertFileReadable(filePath, label) {
  try {
    await access(filePath, fsConstants.R_OK);
  } catch {
    throw new Error(`${label} not found or unreadable: ${filePath}`);
  }
}

function resolveWorkspacePath(workspace, filePath) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(workspace, filePath);
}

async function runTask(opts, task) {
  const paths = await ensureStateDir(opts.workspace);
  const startedAt = new Date().toISOString();
  const runId = `${Date.now()}-task-${task.number}`;
  const logPath = path.join(paths.logs, `${runId}.jsonl`);
  const logStream = createWriteStream(logPath, { flags: "a" });
  const rpc = new PiRpcProcess({ piCommand: opts.pi, cwd: opts.workspace, name: task.heading, logStream, observe: opts.observe });

  let sessionState = null;
  let finalText = "";
  try {
    await rpc.start();
    sessionState = await rpc.request({ type: "get_state" });

    const runningState = baseState(opts, "running", {
      task,
      sessionFile: sessionState.sessionFile,
      sessionId: sessionState.sessionId,
      logPath,
      startedAt,
    });
    await writeCurrent(opts.workspace, runningState);

    const prompt = await buildTaskPrompt(opts, task);
    const agentEndPromise = rpc.waitForEvent("agent_end");
    await rpc.request({ type: "prompt", message: prompt });
    await agentEndPromise;

    const last = await rpc.request({ type: "get_last_assistant_text" });
    finalText = last?.text ?? "";
  } finally {
    await rpc.stop();
    await new Promise((resolve) => logStream.end(resolve));
  }

  const parsed = parseFinalJson(finalText);
  const final = parsed.ok
    ? parsed.value
    : { blocked: true, message: `Invalid final JSON from task runner. Raw output saved in ${logPath}` };

  const verifiedDone = await verifyTaskDone(opts.workspace, opts.plan, task);
  if (!final.blocked && !verifiedDone) {
    final.blocked = true;
    final.message = `Task reported success, but heading was not marked DONE in ${opts.plan}. Original heading: ${task.heading}`;
  }

  const finishedAt = new Date().toISOString();
  const runRecord = {
    runId,
    status: final.blocked ? "blocked" : "completed",
    workspace: opts.workspace,
    plan: opts.plan,
    promptFile: opts.promptFile,
    observe: opts.observe,
    task,
    sessionFile: sessionState?.sessionFile,
    sessionId: sessionState?.sessionId,
    logPath,
    startedAt,
    finishedAt,
    final,
    rawFinalText: finalText,
  };

  return { final, runRecord };
}

async function buildTaskPrompt(opts, task) {
  if (opts.promptFile) {
    return renderPromptTemplate(await readPromptTemplate(opts), promptVariables(opts, task));
  }

  return `You are an autonomous task runner for this workspace.

Plan file: ${opts.plan}
Selected task heading: ${task.heading}

Instructions:
1. Read the plan file and implement ONLY the selected task.
2. If you complete the task, update the selected heading in the plan file to append " - DONE". Preserve the task number and title. Do not mark it DONE unless the work is actually complete.
3. If you are blocked, leave the heading unmodified and explain the blocker.
4. If you are done, commit.
5. Your final assistant response must be exactly one JSON object and nothing else. No markdown fence.

Final response schema:
{ "blocked": boolean, "message": string }

Selected task:
${task.heading}
`;
}

async function readPromptTemplate(opts) {
  return readFile(resolveWorkspacePath(opts.workspace, opts.promptFile), "utf8");
}

function promptVariables(opts, task) {
  const planPath = path.resolve(opts.workspace, opts.plan);
  return {
    workspace: opts.workspace,
    plan: opts.plan,
    planPath,
    heading: task.heading,
    taskHeading: task.heading,
    taskNumber: String(task.number),
    taskTitle: task.title,
    taskLine: String(task.line),
    taskJson: JSON.stringify(task, null, 2),
  };
}

function renderPromptTemplate(template, variables) {
  return template.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (match, name) => {
    if (Object.hasOwn(variables, name)) return variables[name];
    return match;
  });
}

async function verifyTaskDone(workspace, planRel, originalTask) {
  const { content } = await readPlan(workspace, planRel);
  const tasks = parseTasks(content);
  const updated = tasks.find((task) => task.number === originalTask.number);
  return Boolean(updated?.done);
}

function parseFinalJson(text) {
  const candidates = jsonCandidates(text.trim());
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const value = JSON.parse(stripJsonFence(candidates[i]));
      if (typeof value?.blocked === "boolean" && typeof value?.message === "string") {
        return { ok: true, value };
      }
    } catch {
      // Try next candidate.
    }
  }
  return { ok: false, error: "No valid {blocked,message} JSON object found" };
}

function stripJsonFence(text) {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fence ? fence[1].trim() : trimmed;
}

function jsonCandidates(text) {
  const stripped = stripJsonFence(text);
  const candidates = [stripped];
  const stack = [];
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (stack.length === 0) start = i;
      stack.push(ch);
    } else if (ch === "}") {
      stack.pop();
      if (stack.length === 0 && start >= 0) {
        candidates.push(stripped.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return [...new Set(candidates)];
}

class EventObserver {
  constructor({ mode = "compact" } = {}) {
    this.mode = mode;
    this.needsNewline = false;
    this.activeAssistantHadDelta = false;
  }

  observeLine(line) {
    if (this.mode === "raw") console.log(line);
  }

  observeEvent(event) {
    if (this.mode === "raw" || this.mode === "quiet") return;
    if (this.mode === "transcript") this.observeTranscript(event);
    else this.observeCompact(event);
  }

  observeCompact(event) {
    if (event.type === "tool_execution_start") {
      this.println(formatToolStart(event));
    } else if (event.type === "tool_execution_end") {
      this.println(`${event.isError ? "✗" : "✓"} ${event.toolName}`);
      const text = extractResultText(event.result);
      if (text) this.printIndented(truncateText(text, event.isError ? 3000 : 1200));
    } else if (event.type === "message_start" && event.message?.role === "assistant") {
      this.activeAssistantHadDelta = false;
    } else if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      this.activeAssistantHadDelta = true;
      this.write(event.assistantMessageEvent.delta);
    } else if (event.type === "message_end" && event.message?.role === "assistant" && !this.activeAssistantHadDelta) {
      const text = extractMessageText(event.message);
      if (text) this.write(text);
    } else if (event.type === "agent_end") {
      this.println("[agent complete]");
    } else if (event.type === "compaction_start") {
      this.println(`[compaction started: ${event.reason ?? "manual"}]`);
    } else if (event.type === "compaction_end") {
      this.println(`[compaction ${event.aborted ? "aborted" : event.result ? "complete" : "failed"}]`);
    } else if (event.type === "auto_retry_start") {
      this.println(`[retry ${event.attempt}/${event.maxAttempts} in ${event.delayMs}ms] ${event.errorMessage ?? ""}`.trim());
    } else if (event.type === "auto_retry_end") {
      this.println(`[retry ${event.success ? "succeeded" : "failed"}]`);
    } else if (event.type === "queue_update") {
      this.println(`[queue] steering=${event.steering?.length ?? 0} followUp=${event.followUp?.length ?? 0}`);
    }
  }

  observeTranscript(event) {
    if (event.type === "message_end" && event.message?.role === "user") {
      this.println("\nuser>");
      this.printIndented(truncateText(extractMessageText(event.message), 2500));
    } else if (event.type === "message_start" && event.message?.role === "assistant") {
      this.activeAssistantHadDelta = false;
      this.println("\nassistant>");
    } else if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      this.activeAssistantHadDelta = true;
      this.write(event.assistantMessageEvent.delta);
    } else if (event.type === "message_end" && event.message?.role === "assistant" && !this.activeAssistantHadDelta) {
      const text = extractMessageText(event.message);
      if (text) this.write(text);
    } else if (event.type === "tool_execution_start") {
      this.println(`\ntool> ${formatToolStart(event)}`);
    } else if (event.type === "tool_execution_end") {
      this.println(`${event.isError ? "✗" : "✓"} ${event.toolName}`);
      const text = extractResultText(event.result);
      if (text) this.printIndented(truncateText(text, 5000));
    } else if (event.type === "agent_end") {
      this.println("\n[agent complete]");
    } else if (event.type === "compaction_start" || event.type === "compaction_end" || event.type === "auto_retry_start" || event.type === "auto_retry_end" || event.type === "queue_update") {
      this.observeCompact(event);
    }
  }

  write(text) {
    if (!text) return;
    process.stdout.write(text);
    this.needsNewline = !String(text).endsWith("\n");
  }

  println(text = "") {
    if (this.needsNewline) process.stdout.write("\n");
    console.log(text);
    this.needsNewline = false;
  }

  printIndented(text) {
    if (!text) return;
    this.println(indent(text.trimEnd(), "  "));
  }
}

class PiRpcProcess {
  constructor({ piCommand, cwd, name, logStream, observe = "compact" }) {
    this.piCommand = piCommand;
    this.cwd = cwd;
    this.name = name;
    this.logStream = logStream;
    this.observer = new EventObserver({ mode: observe });
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.eventWaiters = [];
    this.stderr = "";
  }

  async start() {
    this.proc = spawn(this.piCommand, ["--mode", "rpc", "--name", this.name], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    attachJsonlReader(this.proc.stdout, (line) => this.handleLine(line));
    this.proc.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      this.stderr += text;
      process.stderr.write(text);
    });

    this.proc.on("exit", (code, signal) => {
      const error = new Error(`pi rpc exited before response: code=${code} signal=${signal}${this.stderr ? `\nstderr:\n${this.stderr}` : ""}`);
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
      for (const waiter of this.eventWaiters) waiter.reject(error);
      this.eventWaiters = [];
    });

    // A quick health check also waits until the process can parse commands.
    await this.request({ type: "get_state" });
  }

  request(command) {
    if (!this.proc || !this.proc.stdin.writable) throw new Error("pi rpc process is not running");
    const id = `req-${this.nextId++}`;
    const payload = { id, ...command };
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, command: command.type });
    });
    this.proc.stdin.write(JSON.stringify(payload) + "\n");
    return promise;
  }

  waitForEvent(type) {
    return new Promise((resolve, reject) => {
      this.eventWaiters.push({ type, resolve, reject });
    });
  }

  handleLine(line) {
    if (!line.trim()) return;
    this.logStream?.write(line + "\n");
    this.observer.observeLine(line);

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      if (this.observer.mode !== "raw" && this.observer.mode !== "quiet") console.error(`Failed to parse pi RPC line: ${line}`);
      return;
    }

    if (message.type === "response") {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        if (message.success) pending.resolve(message.data);
        else pending.reject(new Error(message.error || `${pending.command} failed`));
      }
      return;
    }

    this.observer.observeEvent(message);
    const matching = this.eventWaiters.filter((waiter) => waiter.type === message.type);
    this.eventWaiters = this.eventWaiters.filter((waiter) => waiter.type !== message.type);
    for (const waiter of matching) waiter.resolve(message);
  }

  async stop() {
    if (!this.proc) return;
    if (!this.proc.killed) {
      this.proc.stdin.end();
      await Promise.race([
        new Promise((resolve) => this.proc.once("exit", resolve)),
        delay(1000).then(() => {
          if (!this.proc.killed) this.proc.kill("SIGTERM");
        }),
      ]);
    }
  }
}

function attachJsonlReader(stream, onLine) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  stream.on("data", (chunk) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) break;
      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      onLine(line);
    }
  });

  stream.on("end", () => {
    buffer += decoder.end();
    if (buffer.length > 0) onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
  });
}

function formatToolStart(event) {
  const args = event.args ?? {};
  if (event.toolName === "bash" && args.command) return `$ ${truncateLine(args.command)}`;
  if (event.toolName === "read" && args.path) return `read ${args.path}${args.offset ? `:${args.offset}` : ""}`;
  if (event.toolName === "edit" && args.path) return `edit ${args.path}${Array.isArray(args.edits) ? ` (${args.edits.length} edit${args.edits.length === 1 ? "" : "s"})` : ""}`;
  if (event.toolName === "write" && args.path) return `write ${args.path}`;
  if (event.toolName === "grep") return `grep ${args.pattern ? JSON.stringify(args.pattern) : ""}${args.path ? ` in ${args.path}` : ""}`.trim();
  if (event.toolName === "find") return `find ${args.path ?? "."}${args.pattern ? ` ${JSON.stringify(args.pattern)}` : ""}`;
  if (event.toolName === "ls") return `ls ${args.path ?? "."}`;
  return `tool: ${event.toolName}${Object.keys(args).length ? ` ${truncateLine(JSON.stringify(args), 160)}` : ""}`;
}

function extractResultText(result) {
  return extractContentText(result?.content);
}

function extractMessageText(message) {
  return extractContentText(message?.content);
}

function extractContentText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part) return "";
      if (typeof part === "string") return part;
      if (part.type === "text") return part.text ?? "";
      if (part.type === "thinking") return part.thinking ? `[thinking]\n${part.thinking}` : "";
      if (part.type === "toolCall") return `[tool call: ${part.name ?? "unknown"}]`;
      if (part.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function truncateText(text, max = 1200) {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n… [truncated ${value.length - max} chars]`;
}

function indent(text, prefix = "  ") {
  return String(text).split("\n").map((line) => `${prefix}${line}`).join("\n");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncateLine(text, max = 120) {
  const oneLine = String(text).replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

async function main() {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.command === "help") usage(0);
    if (opts.command === "tasks") await commandTasks(opts);
    else if (opts.command === "run") await commandRun(opts);
    else if (opts.command === "tail") await commandTail(opts);
    else if (opts.command === "status") await commandStatus(opts);
    else if (opts.command === "attach") await commandAttach(opts);
    else usage(1);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
