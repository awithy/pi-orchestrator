# Requirements

## Purpose

Pi Orchestrator automates execution of task plans using `pi` coding-agent sessions. It repeatedly selects pending tasks from a workspace plan, runs each task in an isolated Pi session, observes progress, records state, and stops when work is complete or human intervention is required.

## Goals

- Run a multi-task plan with minimal manual supervision.
- Preserve human ability to inspect and resume any blocked task session.
- Keep the task plan as the source of truth for task completion.
- Provide useful live and historical observability into agent work.
- Avoid coupling task execution to a specific terminal pane or interactive UI.

## Non-goals

- Pi Orchestrator is not a general-purpose job scheduler.
- Pi Orchestrator is not responsible for generating the initial task plan.
- Pi Orchestrator is not responsible for judging implementation quality beyond explicit task-runner output and plan-state verification.
- Pi Orchestrator does not replace Pi's interactive session UI for manual follow-up.

## Workspace and Plan Requirements

### Workspace

- The user shall run the orchestrator against a target workspace directory.
- The workspace shall contain a task plan file.
- The default task plan path shall be `agent-plans/plan.md` relative to the workspace.
- The user shall be able to provide an alternate plan path.

### Task Discovery

- The orchestrator shall discover tasks from Markdown headings matching:

  ```text
  ## Task N: task title
  ```

- `N` shall be interpreted as the task number.
- The full matching heading line shall identify the selected task.
- A task shall be considered complete when its heading contains `DONE`.
- A task shall be considered pending when its heading matches the task pattern and does not contain `DONE`.
- The orchestrator shall select the first pending task in plan order.
- If no pending tasks remain, the orchestrator shall report that all tasks are complete.

## Task Execution Requirements

- Each selected task shall run in a fresh Pi session.
- The orchestrator shall send a task prompt instructing Pi to work only on the selected task.
- The task runner shall be instructed to mark the selected task heading as `DONE` only when the task is complete.
- The task runner shall be instructed to leave the task unmodified when blocked.
- The task runner shall be instructed to end with a JSON object containing:

  ```json
  { "blocked": true, "message": "reason" }
  ```

  or:

  ```json
  { "blocked": false, "message": "summary" }
  ```

- The orchestrator shall parse the final task-runner response as the task result.
- If the final response cannot be parsed as the expected JSON shape, the orchestrator shall treat the task as blocked.
- If the task runner reports success but the selected task heading is not marked `DONE`, the orchestrator shall treat the task as blocked.
- If the task runner reports blocked, the orchestrator shall stop processing additional tasks.
- If the task runner reports success and plan verification succeeds, the orchestrator shall continue to the next pending task.
- The user shall be able to run only one task and then stop.
- The user shall be able to limit the maximum number of tasks processed in one run.

## Prompt Requirements

- The orchestrator shall provide a default task prompt.
- The user shall be able to provide a prompt template file.
- Relative prompt-template paths shall resolve from the target workspace.
- Prompt templates shall support variable substitution for task and workspace metadata.
- Unknown template variables shall be preserved rather than removed.

## State and Audit Requirements

- The orchestrator shall store state in the target workspace.
- The orchestrator shall record current run state.
- The orchestrator shall append completed run records to an audit log.
- The orchestrator shall record enough information to resume or inspect a blocked Pi session.
- The orchestrator shall record raw Pi event logs for each task run.
- State files shall be kept separate from the task plan.

## Blocked Task Requirements

- When a task is blocked, the orchestrator shall stop processing further tasks.
- The blocked state shall include:
  - workspace path
  - plan path
  - task metadata
  - Pi session file path when available
  - run log path
  - final blocked message
- The user shall be able to attach to or reopen the blocked Pi session.

## Observability Requirements

- The orchestrator shall provide live progress output during task execution.
- The user shall be able to choose among observation modes.
- Observation modes shall include:
  - compact summary output
  - transcript-like output
  - raw event output
  - quiet output
- The orchestrator shall show assistant text as it is produced when supported by the observation mode.
- The orchestrator shall show tool calls and tool completion status when supported by the observation mode.
- The orchestrator shall show useful excerpts of tool results when supported by the observation mode.
- The orchestrator shall save raw event logs so sessions can be inspected after the fact.
- The user shall be able to tail the current run log from another terminal.
- The user shall be able to tail a specific historical run log.

## Command Requirements

- The orchestrator shall provide a command to list discovered tasks.
- The orchestrator shall provide a command to run pending tasks.
- The orchestrator shall provide a command to show current state.
- The orchestrator shall provide a command to attach to a blocked/current session.
- The orchestrator shall provide a command to tail a current or historical log.

## Reliability Requirements

- Missing or unreadable plan files shall produce a clear error.
- Missing or unreadable prompt files shall produce a clear error.
- Invalid observation modes shall produce a clear error.
- Raw event logs shall be written before formatted observation output is derived from events.
- The orchestrator shall handle unexpected or malformed event lines without crashing when possible.
- The orchestrator shall preserve blocked-session information even when a task fails validation.

## Safety Requirements

- The orchestrator shall not mark tasks complete itself based only on successful process exit.
- The orchestrator shall require plan-state verification after task success.
- The orchestrator shall not continue automatically after a blocked task.
- The orchestrator shall make blocked-session recovery instructions visible to the user.
