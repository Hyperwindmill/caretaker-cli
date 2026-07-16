---
'caretaker-cli': minor
'webview-ui': minor
---

Add per-task agent assignment, allowing a specific agent to be assigned to
a task to override the project's default agent.

- **Task schema**: the `Task` record gains an optional `agentId` field
  (`string | null`). When `null` or unset, the project's default agent is
  used (existing behaviour).
- **MCP tools**: `task_create` accepts a new optional `agent_id` parameter.
  A new `task_set_agent` tool allows reassigning a task's agent at any time
  (refused while the task is running).
- **REST API**: `POST /api/projects/:id/tasks` accepts `agentId` in the
  request body. A new `PATCH /api/tasks/:id/agent` endpoint reassigns the
  agent (409 if the task is currently running).
- **Scheduler heartbeat**: `runTaskHeartbeatTick` resolves the agent as
  `task.agentId` → `project.agentId` → first agent in `agents.json`.
- **Web UI**: the New Task form has an agent selector dropdown ("Project
  default" + all configured agents). The task list table has a new "Agent"
  column. The task edit view has an agent selector that is disabled while
  the task is active/reviewing (pause first to reassign).
- **`task_get_state`** now includes `agentId` in its response.