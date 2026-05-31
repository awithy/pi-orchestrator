# Design

## Overview

Pi Orchestrator is a small Node.js CLI that automates task execution using Pi's RPC mode. It treats a workspace Markdown plan as the source of truth, launches one fresh Pi process per task, sends a task-specific prompt, observes the RPC event stream, records logs/state, and either proceeds to the next task or stops for human intervention.

The current implementation lives primarily in:

```text
src/cli.js
```

and is intentionally dependency-free.

## Architecture

```text
CLI command
  |
  +-- plan parser
  |
  +-- run loop
        |
        +-- PiRpcProcess
        |     |
        |     +-- child_process.spawn("pi", ["--mode", "rpc", ...])
        |     +-- JSONL reader
        |     +-- request/response correlation
        |     +-- event waiting
        |
        +-- EventObserver
        |     |
        |     +-- compact formatter
        |     +-- transcript formatter
        |     +-- raw output
        |     +-- quiet output
        |
        +-- state/log writer
```

## File Layout

```text
pi-orchestrator/
  src/cli.js
  templates/task-prompt.md
  docs/requirements.md
  docs/design.md
```

Runtime state is written into the target workspace:

```text
<workspace>/.pi-orchestrator/
  current.json
  runs.jsonl
  logs/
    <runId>.jsonl
```

## CLI

Supported commands:

```bash
pi-orchestrator tasks [workspace] [--plan agent-plans/plan.md]
pi-orchestrator run [workspace] [--plan agent-plans/plan.md] [--prompt-file prompt.md] [--observe compact|transcript|raw|quiet] [--pi pi] [--once] [--max-tasks N]
pi-orchestrator tail [workspace|log.jsonl] [--observe compact|transcript|raw|quiet]
pi-orchestrator status [workspace]
pi-orchestrator attach [workspace]
```

The workspace defaults to the current working directory.

## Plan Parsing

The plan parser reads the configured plan file and scans line-by-line for headings matching:

```js
/^## Task\s+(\d+):\s*(.+?)\s*$/
```

Each task object contains:

```js
{
  number,
  title,
  heading,
  line,
  done
}
```

Completion is detected by checking the heading for `DONE` using a case-insensitive regular expression.

The run loop selects:

```js
nextPendingTask(tasks) // first task where done === false
```

## Run Loop

`commandRun()` performs the orchestration loop:

1. Validate the plan file.
2. Validate the prompt file if one is configured.
3. Ensure the workspace state directory exists.
4. Read and parse the plan.
5. Select the first pending task.
6. If none exists, write `status: "done"` to `current.json` and exit.
7. Run the task through `runTask()`.
8. Append the run record to `runs.jsonl`.
9. If blocked, write blocked state and stop.
10. If successful, continue unless `--once` or `--max-tasks` stops the loop.

## Pi Process Model

Each task uses a new Pi RPC process:

```bash
pi --mode rpc --name "## Task N: title"
```

The process is spawned in the target workspace. Communication uses LF-delimited JSONL over stdin/stdout. This follows Pi's RPC protocol and avoids scraping an interactive TUI.

### Request/Response Correlation

`PiRpcProcess.request()` assigns an ID:

```js
{ id: "req-1", type: "get_state" }
```

Responses are matched by `id` and resolve/reject the pending promise.

### Event Waiting

`PiRpcProcess.waitForEvent(type)` registers a waiter. The task runner waits for:

```js
agent_end
```

before requesting the last assistant text.

## Task Prompting

The default prompt is embedded in `buildTaskPrompt()`.

If `--prompt-file` is provided, the file is read and rendered using simple variable substitution:

```text
{{workspace}}
{{plan}}
{{planPath}}
{{heading}}
{{taskHeading}}
{{taskNumber}}
{{taskTitle}}
{{taskLine}}
{{taskJson}}
```

Prompt paths are resolved as follows:

- absolute path: used as-is
- relative path: resolved relative to the target workspace

Unknown variables are preserved.

## Task Result Parsing

After `agent_end`, the orchestrator sends:

```json
{ "type": "get_last_assistant_text" }
```

The response is parsed by `parseFinalJson()`.

The parser:

1. Trims the response.
2. Removes a JSON Markdown fence if the entire response is fenced.
3. Attempts to parse the whole text.
4. Extracts JSON-object candidates from the text.
5. Accepts the last candidate matching:

```js
{
  blocked: boolean,
  message: string
}
```

If parsing fails, the task is treated as blocked.

## Completion Verification

A non-blocked final result is not sufficient. The orchestrator re-reads the plan and confirms the same task number is now marked `DONE`.

If the task runner reports success but the heading is not marked `DONE`, the orchestrator changes the result to blocked with an explanatory message.

This prevents accidental continuation when the model says it is done but did not update the plan.

## State Model

### `current.json`

`current.json` stores the latest orchestrator state. Typical states:

```json
{
  "status": "running",
  "workspace": "/path/to/workspace",
  "plan": "agent-plans/plan.md",
  "promptFile": "prompts/task-runner.md",
  "observe": "compact",
  "task": {},
  "sessionFile": "/home/user/.pi/agent/sessions/...jsonl",
  "sessionId": "...",
  "logPath": "/path/to/workspace/.pi-orchestrator/logs/...jsonl",
  "startedAt": "...",
  "updatedAt": "..."
}
```

Blocked state includes the run record and final blocked message.

Done state includes:

```json
{
  "status": "done",
  "message": "All tasks are complete."
}
```

### `runs.jsonl`

Each completed task attempt appends one JSON object containing:

```js
{
  runId,
  status,
  workspace,
  plan,
  promptFile,
  observe,
  task,
  sessionFile,
  sessionId,
  logPath,
  startedAt,
  finishedAt,
  final,
  rawFinalText
}
```

### Raw Event Logs

Every line received from Pi RPC stdout is written to:

```text
<workspace>/.pi-orchestrator/logs/<runId>.jsonl
```

The log includes both command responses and streamed events. This makes log replay/tailing independent of the live process.

## Observability

Observation is handled by `EventObserver`.

### Modes

| Mode | Behavior |
| --- | --- |
| `compact` | Assistant text, tool calls, tool completion, truncated tool results. |
| `transcript` | Role-labeled conversation output with larger tool result excerpts. |
| `raw` | Prints raw JSONL lines. Orchestrator messages go to stderr during `run`. |
| `quiet` | Suppresses Pi event output. |

### Compact Mode

Compact mode handles:

- `tool_execution_start`
- `tool_execution_end`
- assistant `message_update` text deltas
- assistant `message_end` fallback text
- `agent_end`
- queue, compaction, and retry events

Tool starts are formatted by tool name:

```text
$ npm test
read src/index.ts
edit src/index.ts (2 edits)
grep "pattern" in src/
find . "*.ts"
ls .
```

Tool result text is extracted from `result.content` and truncated.

### Transcript Mode

Transcript mode adds role labels:

```text
user>
  ...

assistant>
...

tool> $ npm test
✓ bash
  ...
```

It is intended for monitoring a live conversation from another terminal.

### Raw Mode

Raw mode prints unformatted JSONL. This is useful for debugging the Pi RPC protocol or adding new observers.

### Quiet Mode

Quiet mode suppresses event output while preserving orchestrator-level lifecycle messages.

## Tailing Logs

The `tail` command accepts either:

- a workspace path, or
- a direct `.jsonl` log path

If a workspace path is provided, the command reads:

```text
<workspace>/.pi-orchestrator/current.json
```

and uses its `logPath`.

The tail implementation:

1. Replays the existing log from offset `0`.
2. Prints a tailing notice unless in `raw` or `quiet` mode.
3. Polls file size every second.
4. Replays only newly appended bytes.
5. Resets offset to zero if the file shrinks.

This avoids external dependencies while providing a usable live observer.

## Attach Flow

`attach` reads `current.json`, extracts `sessionFile`, and runs:

```bash
pi --session <sessionFile>
```

in the recorded workspace.

This opens the Pi session interactively so the user can continue a blocked conversation.

## Error Handling

- Missing plan: clear error before execution starts.
- Missing prompt file: clear error before execution starts.
- Invalid observation mode: clear error during argument parsing.
- Malformed RPC line: logged as parse failure unless in raw/quiet mode.
- Invalid final JSON: task becomes blocked.
- Successful JSON but missing `DONE`: task becomes blocked.
- Pi process exits before pending responses complete: pending requests and event waiters reject.

## Design Tradeoffs

### RPC Instead of Tmux Scraping

Pi RPC provides structured commands and events, reliable final-message access, and session file metadata. Tmux remains useful for human observability, but scraping panes is not the primary control plane.

### Plan as Source of Truth

The orchestrator verifies task completion from the plan file rather than trusting model output alone. This matches the user's existing workflow and keeps progress visible in `agent-plans/plan.md`.

### One Pi Process Per Task

A fresh process gives each task a new session and isolated context. It also makes blocked sessions easy to reopen by session file.

### Simple Template Engine

Prompt templates use simple `{{name}}` replacement rather than a full templating engine. This avoids dependencies and keeps prompt behavior predictable.

### Polling Tail

The tail command polls file size once per second instead of using filesystem watchers. Polling is portable and sufficient for the expected log volume.

## Future Design Ideas

- Write a Markdown transcript beside each raw JSONL log.
- Export Pi HTML sessions after each task.
- Add replay mode that exits after printing a historical log once.
- Add task selection strategies beyond first pending task.
- Add lock files to prevent two orchestrators from running against the same workspace.
- Add structured run summaries for dashboards.
- Add tmux integration for launching monitor panes.
