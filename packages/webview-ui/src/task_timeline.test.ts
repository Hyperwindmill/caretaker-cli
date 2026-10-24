import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskMessagesToChatItems, type TaskMessage } from './task_timeline.js';

const m = (over: Partial<TaskMessage>): TaskMessage => ({
  id: 1,
  taskId: 'p-1',
  role: 'assistant',
  messageType: 'chat',
  content: '',
  createdAt: '',
  ...over,
});

test('maps a mixed legacy + cycle thread in order without throwing', () => {
  const items = taskMessagesToChatItems([
    m({ messageType: 'heartbeat', content: 'old text' }),
    m({ messageType: 'tool_call', content: 'read_file {"path":"a"}' }),
    m({ messageType: 'cycle', sessionId: 's', sessionAgentId: 'a', cycleRole: 'developer', cycleOutcome: 'running' }),
    m({ messageType: 'chat', role: 'assistant', content: 'handoff' }),
  ]);
  assert.deepEqual(items.map((i) => i.kind), ['assistant', 'tool', 'cycle', 'assistant']);
});

test('a cycle message maps to a card with its session, role and outcome', () => {
  const [item] = taskMessagesToChatItems([
    m({ id: 7, messageType: 'cycle', sessionId: 'sess-7', sessionAgentId: 'ag', cycleRole: 'planner', cycleOutcome: 'plan', agentLabel: 'Planner · m', createdAt: 'T' }),
  ]);
  assert.deepEqual(item, {
    kind: 'cycle',
    sessionId: 'sess-7',
    agentId: 'ag',
    role: 'planner',
    outcome: 'plan',
    label: 'Planner · m',
    createdAt: 'T',
  });
});
