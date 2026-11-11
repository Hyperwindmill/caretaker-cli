import { readFileSync } from 'node:fs';
import type { Hono } from 'hono';

/**
 * OpenAPI description of the project/task REST routes — the part of the web
 * server's API meant as a contract for external clients. The other `/api/*`
 * routes (voice, filesystem browser, UI state) are reachable the same way but
 * belong to the GUI and are deliberately left out.
 *
 * ponytail: hand-written, so it can drift from the handlers in server.ts.
 * openapi.test.ts fails when a documented path/method is not registered there;
 * request and response shapes are not checked. Upgrade path if that bites:
 * move the routes to @hono/zod-openapi (zod is already a dependency).
 */

type Schema = Record<string, unknown>;

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: Schema) => ({ content: { 'application/json': { schema } } });
const res = (description: string, schema: Schema = ref('Ok')) => ({ description, ...json(schema) });
const errorRes = (description: string) => res(description, ref('Error'));
const body = (schema: Schema) => ({ required: true, ...json(schema) });
const nullable = (type: string, description?: string): Schema => ({
  type: [type, 'null'],
  ...(description ? { description } : {}),
});
const idParam = (what: string) => ({
  name: 'id',
  in: 'path',
  required: true,
  description: `${what} id.`,
  schema: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$' },
});

const TRI_STATE = 'true/false overrides the project; null inherits from it.';
const RUNNING = errorRes('The task is running. Pause it or wait for the cycle to end.');
const NOT_FOUND = errorRes('No task with this id.');

const checklistStatus: Schema = {
  type: 'string',
  enum: ['pending', 'in_progress', 'done', 'skipped'],
};

const roleFields: Record<string, Schema> = {
  agentId: nullable('string', 'Developer agent. Null falls back to the project, then to the first agent.'),
  plannerAgentId: nullable('string', 'Planner agent. Null falls back to the developer.'),
  reviewerAgentId: nullable('string', 'Reviewer agent. Null falls back to the developer.'),
  planningEnabled: nullable('boolean', `Planning phase before execution. ${TRI_STATE}`),
  reviewEnabled: nullable('boolean', `Review gate before done. ${TRI_STATE}`),
  sddEnabled: nullable('boolean', `Let the planner write markdown documents. ${TRI_STATE}`),
  maxRunSeconds: nullable('number', 'Wall-clock budget of one cycle, in seconds. Null inherits.'),
};

const schemas: Record<string, Schema> = {
  Ok: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean', const: true } } },
  Error: {
    type: 'object',
    required: ['error'],
    properties: { ok: { type: 'boolean', const: false }, error: { type: 'string' } },
  },
  ChecklistItem: {
    type: 'object',
    required: ['id', 'text', 'status', 'order'],
    properties: {
      id: { type: 'string' },
      text: { type: 'string' },
      status: checklistStatus,
      order: { type: 'integer', description: 'Position in the checklist, from 0.' },
    },
  },
  ChecklistItemInput: {
    type: 'object',
    required: ['text'],
    properties: {
      id: { type: 'string', description: 'Keep this id. Omit it to get a new one.' },
      text: { type: 'string', minLength: 1 },
      status: {
        ...checklistStatus,
        description: 'Optional when creating a task (defaults to pending). Required when replacing a checklist.',
      },
    },
  },
  Task: {
    type: 'object',
    required: ['id', 'projectId', 'seq', 'title', 'objective', 'checklist', 'status', 'createdAt', 'updatedAt'],
    properties: {
      id: { type: 'string', description: 'Opaque. Do not parse it; use projectId and seq.' },
      projectId: { type: 'string' },
      seq: { type: 'integer', description: 'Per-project sequence number, never reused.' },
      title: { type: 'string' },
      objective: { type: 'string' },
      checklist: { type: 'array', items: ref('ChecklistItem') },
      status: {
        type: 'string',
        enum: ['draft', 'planning', 'active', 'reviewing', 'paused', 'blocked', 'done'],
        description:
          'planning, active and reviewing are advanced by the scheduler. blocked needs a person: see blockedReason.',
      },
      blockedReason: nullable('string', 'Why the task is blocked. Null otherwise.'),
      noProgressCount: { type: 'integer' },
      maxNoProgress: { type: 'integer' },
      lockedAt: nullable('string', 'Set while a cycle is running.'),
      branch: nullable('string', 'Git branch holding the task work, for projects in a git repository.'),
      worktreePath: nullable('string', 'Null once the worktree is removed (done or discarded).'),
      dockerContainer: nullable('string'),
      archived: { type: 'boolean' },
      ...roleFields,
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  TaskMessage: {
    type: 'object',
    required: ['id', 'taskId', 'role', 'messageType', 'content', 'createdAt'],
    properties: {
      id: { type: 'integer' },
      taskId: { type: 'string' },
      role: { type: 'string', enum: ['user', 'assistant', 'tool'] },
      messageType: {
        type: 'string',
        enum: ['chat', 'heartbeat', 'heartbeat_live', 'system', 'block', 'tool_call', 'yield', 'review', 'plan', 'cycle'],
        description:
          'chat: a note from a person or an agent handoff. plan / review: the planner and reviewer output. block: why the task was blocked. cycle: one autonomous run (see cycleRole and cycleOutcome). system: an audit note.',
      },
      content: { type: 'string' },
      agentId: nullable('string'),
      agentLabel: nullable('string', '"name · model" of the agent that produced the message, as it was then.'),
      sessionId: nullable('string', 'cycle messages: the session recording the run.'),
      sessionAgentId: nullable('string'),
      cycleRole: { type: ['string', 'null'], enum: ['developer', 'planner', 'reviewer', null] },
      cycleOutcome: {
        type: ['string', 'null'],
        enum: ['running', 'handoff', 'completed', 'blocked', 'plan', 'review-pass', 'review-changes', 'aborted', 'failed', null],
        description: 'running until the cycle closes.',
      },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  Project: {
    type: 'object',
    required: ['id', 'name'],
    properties: {
      id: { type: 'string', description: 'Slug chosen at creation, immutable.' },
      name: { type: 'string' },
      description: { type: 'string' },
      workingDir: { type: 'string', description: 'Blank for a remote-backed project using a managed clone.' },
      active: { type: 'boolean' },
      ...roleFields,
      bootstrapCommands: {
        type: ['array', 'null'],
        items: { type: 'string' },
        description: 'Run once in a new task worktree, each in its own shell.',
      },
      dockerImage: nullable('string', 'Image reference, or a Dockerfile path, isolating the task runs.'),
      repositoryUrl: nullable('string', 'HTTPS URL without credentials.'),
      repositoryToken: nullable('string', 'Write-only in practice: read back as an encrypted value.'),
    },
  },
  ProjectInput: {
    type: 'object',
    required: ['id', 'name'],
    properties: {
      id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$' },
      name: { type: 'string' },
      description: { type: 'string' },
      workingDir: { type: 'string' },
      ...roleFields,
      bootstrapCommands: { type: 'array', items: { type: 'string' } },
      dockerImage: { type: 'string' },
      repositoryUrl: { type: 'string' },
      repositoryToken: { type: 'string' },
    },
  },
  TaskInput: {
    type: 'object',
    required: ['title', 'objective'],
    properties: {
      title: { type: 'string' },
      objective: { type: 'string' },
      checklist: { type: 'array', items: ref('ChecklistItemInput') },
      startActive: {
        type: 'boolean',
        description: 'true starts the task at once (planning, or active when planning is off). Default: draft.',
      },
      ...roleFields,
    },
  },
};

const task = [idParam('Task')];
const project = [idParam('Project')];

const paths: Record<string, Record<string, unknown>> = {
  '/api/projects': {
    get: {
      tags: ['Projects'],
      summary: 'List projects',
      responses: { 200: res('The configured projects.', { type: 'array', items: ref('Project') }) },
    },
    post: {
      tags: ['Projects'],
      summary: 'Create a project',
      requestBody: body(ref('ProjectInput')),
      responses: {
        200: res('Created.'),
        400: errorRes('Invalid or duplicate id, or a repository URL that is not credential-free HTTPS.'),
      },
    },
  },
  '/api/projects/{id}': {
    delete: {
      tags: ['Projects'],
      summary: 'Delete a project with its tasks',
      description:
        'Removes the project, every task and message in it, and its managed repository clone. A working directory you chose is never touched.',
      parameters: project,
      responses: { 200: res('Deleted.'), 400: errorRes('Invalid id.') },
    },
  },
  '/api/projects/{id}/sync': {
    post: {
      tags: ['Projects'],
      summary: 'Clone or pull the project repository',
      description: 'Progress is streamed as newline-delimited JSON; a failure arrives as a line with step "error".',
      parameters: project,
      responses: {
        200: {
          description: 'Progress lines.',
          content: { 'application/x-ndjson': { schema: { type: 'object', properties: { step: { type: 'string' } } } } },
        },
        400: errorRes('Invalid id, or the project has no repository URL.'),
        404: errorRes('No project with this id.'),
        409: errorRes('A sync is already running.'),
      },
    },
  },
  '/api/projects/{id}/repo-status': {
    get: {
      tags: ['Projects'],
      summary: 'State of the project repository on disk',
      parameters: project,
      responses: {
        200: res('Derived at request time, never stored.', {
          type: 'object',
          required: ['state'],
          properties: { state: { type: 'string' } },
          additionalProperties: true,
        }),
        400: errorRes('Invalid id, or the project has no repository URL.'),
        404: errorRes('No project with this id.'),
      },
    },
  },
  '/api/projects/{id}/tasks': {
    get: {
      tags: ['Tasks'],
      summary: 'List the tasks of a project',
      description: 'An unknown project answers an empty list.',
      parameters: [
        ...project,
        {
          name: 'archived',
          in: 'query',
          description: 'true includes archived tasks.',
          schema: { type: 'string', enum: ['true'] },
        },
      ],
      responses: { 200: res('Tasks, with status, checklist and blockedReason.', { type: 'array', items: ref('Task') }) },
    },
    post: {
      tags: ['Tasks'],
      summary: 'Create a task',
      description: 'Tasks advance only while a web server process is running.',
      parameters: project,
      requestBody: body(ref('TaskInput')),
      responses: {
        200: res('The created task, with its id and the ids of its checklist items.', {
          type: 'object',
          required: ['ok', 'task'],
          properties: { ok: { type: 'boolean', const: true }, task: ref('Task') },
        }),
        400: errorRes('Unknown agent id, or an invalid checklist.'),
      },
    },
  },
  '/api/tasks/{id}': {
    patch: {
      tags: ['Tasks'],
      summary: 'Change the title or the objective',
      description: 'An absent key is left unchanged. The next cycle reads the new text; a running one is not interrupted.',
      parameters: task,
      requestBody: body({
        type: 'object',
        minProperties: 1,
        properties: { title: { type: 'string', minLength: 1 }, objective: { type: 'string' } },
      }),
      responses: {
        200: res('The stored values.', {
          type: 'object',
          properties: { ok: { type: 'boolean', const: true }, title: { type: 'string' }, objective: { type: 'string' } },
        }),
        400: errorRes('Nothing to update, a wrong type, or a blank title.'),
        404: NOT_FOUND,
      },
    },
    delete: {
      tags: ['Tasks'],
      summary: 'Delete a task and its messages',
      description: 'Permanent. The worktree is removed; the branch is pushed first when the project has a repository.',
      parameters: task,
      responses: { 200: res('Deleted.'), 404: NOT_FOUND, 409: RUNNING },
    },
  },
  '/api/tasks/{id}/messages': {
    get: {
      tags: ['Tasks'],
      summary: 'Read the task thread',
      description: 'Oldest first. An unknown task answers an empty list.',
      parameters: task,
      responses: { 200: res('Messages.', { type: 'array', items: ref('TaskMessage') }) },
    },
    post: {
      tags: ['Tasks'],
      summary: 'Send a message to the task',
      description:
        'Stored as a chat message from a person, read by the agent on its next cycle. It also reactivates the task whatever its status — paused, blocked and done included — so read the status first if that is not wanted.',
      parameters: task,
      requestBody: body({ type: 'object', required: ['content'], properties: { content: { type: 'string' } } }),
      responses: { 200: res('Stored.') },
    },
  },
  '/api/tasks/{id}/status': {
    post: {
      tags: ['Tasks'],
      summary: 'Pause, block or reactivate a task',
      description:
        '"active" reactivates: the task goes to planning when planning is on and no plan exists yet, otherwise to active, and blockedReason is cleared. Any other status is stored as given and aborts the cycle in flight. An unknown task still answers ok.',
      parameters: task,
      requestBody: body({
        type: 'object',
        required: ['status'],
        properties: { status: { type: 'string', enum: ['active', 'paused', 'blocked', 'draft', 'done'] } },
      }),
      responses: { 200: res('Applied.') },
    },
  },
  '/api/tasks/{id}/checklist': {
    put: {
      tags: ['Tasks'],
      summary: 'Replace the checklist',
      description: 'Items with an id keep it, the others get a new one. Order follows the array. Every item needs a status.',
      parameters: task,
      requestBody: body({
        type: 'object',
        required: ['checklist'],
        properties: { checklist: { type: 'array', items: ref('ChecklistItemInput') } },
      }),
      responses: {
        200: res('The stored checklist.', {
          type: 'object',
          required: ['ok', 'checklist'],
          properties: { ok: { type: 'boolean', const: true }, checklist: { type: 'array', items: ref('ChecklistItem') } },
        }),
        400: errorRes('Blank text, a missing or unknown status, or a duplicate id.'),
        404: NOT_FOUND,
      },
    },
  },
  '/api/tasks/{id}/checklist-item': {
    post: {
      tags: ['Tasks'],
      summary: 'Set the status of one checklist item',
      description: 'An unknown task or item still answers ok and changes nothing.',
      parameters: task,
      requestBody: body({
        type: 'object',
        required: ['itemId', 'status'],
        properties: { itemId: { type: 'string' }, status: checklistStatus },
      }),
      responses: { 200: res('Applied.'), 400: errorRes('Unknown status.') },
    },
  },
  '/api/tasks/{id}/agent': {
    patch: {
      tags: ['Tasks'],
      summary: 'Assign the agent of a role',
      parameters: task,
      requestBody: body({
        type: 'object',
        properties: {
          agentId: nullable('string', 'Null clears the override.'),
          role: { type: 'string', enum: ['developer', 'planner', 'reviewer'], default: 'developer' },
        },
      }),
      responses: {
        200: res('The assignment.', {
          type: 'object',
          properties: { ok: { type: 'boolean', const: true }, role: { type: 'string' }, agentId: nullable('string') },
        }),
        400: errorRes('Unknown agent id.'),
        404: NOT_FOUND,
        409: RUNNING,
      },
    },
  },
  '/api/tasks/{id}/flags': {
    patch: {
      tags: ['Tasks'],
      summary: 'Set the phase gates and the time budget',
      description: 'An absent key is left unchanged; null goes back to inheriting from the project.',
      parameters: task,
      requestBody: body({
        type: 'object',
        properties: {
          planningEnabled: roleFields.planningEnabled,
          reviewEnabled: roleFields.reviewEnabled,
          sddEnabled: roleFields.sddEnabled,
          maxRunSeconds: roleFields.maxRunSeconds,
        },
      }),
      responses: { 200: res('The stored values.', { type: 'object', additionalProperties: true }), 404: NOT_FOUND },
    },
  },
  '/api/tasks/{id}/archive': {
    post: {
      tags: ['Tasks'],
      summary: 'Archive a task',
      description: 'Hidden from the default list and skipped by the scheduler. An active or reviewing task is paused.',
      parameters: task,
      responses: { 200: res('Archived.'), 404: NOT_FOUND },
    },
  },
  '/api/tasks/{id}/unarchive': {
    post: {
      tags: ['Tasks'],
      summary: 'Unarchive a task',
      parameters: task,
      responses: { 200: res('Unarchived.'), 404: NOT_FOUND },
    },
  },
  '/api/tasks/{id}/discard-worktree': {
    post: {
      tags: ['Tasks'],
      summary: 'Remove the task worktree, keeping the branch',
      description: 'The branch is pushed first when the project has a repository; a failed push keeps the worktree.',
      parameters: task,
      responses: {
        200: res('Removed.', {
          type: 'object',
          properties: { ok: { type: 'boolean', const: true }, branch: nullable('string') },
        }),
        400: errorRes('The task has no worktree.'),
        404: NOT_FOUND,
        409: RUNNING,
        500: errorRes('The push failed; the worktree is kept.'),
      },
    },
  },
};

export function openApiDocument(version: string): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Caretaker API',
      version,
      description:
        'Projects and autonomous tasks of a Caretaker web server.\n\nOn the API port every request needs `Authorization: Bearer <token>`; create a token in Settings → API. The main port serves the same routes without authentication and is meant for the local GUI.',
    },
    servers: [{ url: '/', description: 'The server this document was loaded from.' }],
    tags: [{ name: 'Projects' }, { name: 'Tasks' }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'An API token (`ctk_…`). Not needed on the main port.' },
      },
      schemas,
    },
    paths,
  };
}

/** Routes that describe the API rather than expose data: served without a
 *  token on the API port too, or Swagger UI's Authorize could never load. */
export const OPENAPI_PUBLIC_PATHS = ['/api/openapi.json', '/api/docs'];

// Pinned; the assets come from a CDN, so the page needs network access. The
// JSON document above does not.
const SWAGGER_UI = 'https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14';

const DOCS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Caretaker API</title>
<link rel="stylesheet" href="${SWAGGER_UI}/swagger-ui.css">
</head>
<body>
<div id="ui"><p style="font-family:sans-serif;padding:1rem">Loading the API explorer needs network access. The description itself is at <a href="/api/openapi.json">/api/openapi.json</a>.</p></div>
<script src="${SWAGGER_UI}/swagger-ui-bundle.js"></script>
<script>
  window.SwaggerUIBundle && SwaggerUIBundle({ url: '/api/openapi.json', dom_id: '#ui', persistAuthorization: true });
</script>
</body>
</html>`;

/** Same guarded read as cli/index.ts: package.json is not always shipped next
 *  to dist/ (the desktop bundle), and that must only degrade the version. */
function cliVersion(): string {
  try {
    return (
      JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string }
    ).version;
  } catch {
    return '0.0.0';
  }
}

export function registerOpenApi(app: Hono): void {
  const version = cliVersion();
  app.get('/api/openapi.json', (c) => c.json(openApiDocument(version)));
  app.get('/api/docs', (c) => c.html(DOCS_HTML));
}
