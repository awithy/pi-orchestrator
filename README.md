# pi-orchestrator

MVP orchestrator for running `pi` task sessions from `agent-plans/plan.md`.

## Plan format

Tasks are discovered from headings like:

```md
## Task 1: Add auth middleware
## Task 2: Update tests - DONE
```

The first heading that matches `## Task N: ...` and does not contain `DONE` is selected.

## Usage

From this repo:

```bash
node ./src/cli.js tasks /path/to/workspace
node ./src/cli.js run /path/to/workspace
node ./src/cli.js run /path/to/workspace --prompt-file prompts/task-runner.md
node ./src/cli.js run /path/to/workspace --observe transcript
node ./src/cli.js tail /path/to/workspace
node ./src/cli.js status /path/to/workspace
node ./src/cli.js attach /path/to/workspace
```

Or link it:

```bash
npm link
pi-orchestrator run /path/to/workspace
```

## Run behavior

For each pending task, the orchestrator:

1. Starts a fresh `pi --mode rpc` process in the workspace.
2. Sends a task-runner prompt for the selected `## Task N: ...` heading.
3. Expects final assistant output to be JSON:

```json
{ "blocked": false, "message": "completed" }
```

4. Re-reads `agent-plans/plan.md` to verify the selected task is marked `DONE`.
5. Continues until all tasks are done or a task is blocked.

State is written under:

```text
<workspace>/.pi-orchestrator/
  current.json
  runs.jsonl
  logs/
```

If blocked, use:

```bash
node ./src/cli.js attach /path/to/workspace
```

to open the blocked Pi session interactively.

## Prompt templates

By default, the task prompt is embedded in `src/cli.js`. To use a workspace-specific prompt instead, pass:

```bash
node ./src/cli.js run /path/to/workspace --prompt-file prompts/task-runner.md
```

Relative prompt paths are resolved from the target workspace. Available variables:

| Variable | Description |
| --- | --- |
| `{{workspace}}` | Absolute workspace path |
| `{{plan}}` | Plan path as passed to `--plan` |
| `{{planPath}}` | Absolute plan path |
| `{{heading}}` / `{{taskHeading}}` | Full selected task heading |
| `{{taskNumber}}` | Selected task number |
| `{{taskTitle}}` | Selected task title text |
| `{{taskLine}}` | Line number of selected heading |
| `{{taskJson}}` | Full task metadata as pretty JSON |

See `templates/task-prompt.md` for a starter template.

## Observation

Live output is controlled with:

```bash
node ./src/cli.js run /path/to/workspace --observe compact
```

Modes:

| Mode | Description |
| --- | --- |
| `compact` | Default. Assistant text, tool calls, and truncated tool results. |
| `transcript` | Role-labeled conversation view with larger tool-result excerpts. |
| `raw` | Raw Pi RPC JSONL, including responses. |
| `quiet` | Suppress per-event output; only orchestrator task/block/done messages. |

To observe a current run from another terminal:

```bash
node ./src/cli.js tail /path/to/workspace --observe transcript
```

You can also tail a specific raw log file:

```bash
node ./src/cli.js tail /path/to/workspace/.pi-orchestrator/logs/<run>.jsonl --observe compact
```

## Options

```bash
node ./src/cli.js run [workspace] [--plan agent-plans/plan.md] [--prompt-file prompt.md] [--observe compact|transcript|raw|quiet] [--pi pi] [--once] [--max-tasks N]
node ./src/cli.js tail [workspace|log.jsonl] [--observe compact|transcript|raw|quiet]
```
