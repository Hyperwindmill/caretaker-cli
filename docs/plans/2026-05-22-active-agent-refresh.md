# VSCode Webview Handshake and Active Agent Refresh Implementation Plan

> **For Antigravity:** REQUIRED WORKFLOW: Use `.agent/workflows/execute-plan.md` to execute this plan in single-flow mode.

**Goal:** Resolve the empty agent dropdown race condition in Caretaker's VSCode extension using a ready-handshake protocol, fix the import-time CARETAKER_HOME environment bug, and implement an active file watcher to refresh the agent list dynamically on change.

**Architecture:** 
1. Convert `dataDir` and `sessionsRoot` in the session store to functions to dynamically evaluate environment variables.
2. Introduce a `'webviewReady'` message from the Webview (App.tsx) to the Extension Host (sidebar.ts) during React mount.
3. Defer initial agents/sessions load in the Host until `'webviewReady'` is received, eliminating the initialization race condition.
4. Add an `fs.watch` file watcher in the Host targeting `dataDir()` to dynamically monitor changes to `agents.json` and post updates to the Webview.

**Tech Stack:** Node.js, TypeScript, VSCode Extension API, React.

---

### Task 1: Fix CARETAKER_HOME Import-Time Env Bug

**Files:**
- Modify: `packages/cli/src/session/store.ts`
- Modify: `packages/cli/src/session/public_api.test.ts`

**Step 1: Write the failing test**
Since `store.ts` evaluates `dataDir` at import time, tests must expect it to be a function rather than a static string to ensure dynamic environment resolution.
In `packages/cli/src/session/public_api.test.ts`:
Replace:
```typescript
  assert.equal(typeof session.dataDir, 'string');
```
with:
```typescript
  assert.equal(typeof session.dataDir, 'function');
  assert.equal(typeof session.sessionsRoot, 'function');
```

**Step 2: Run test to verify it fails**
Run: `pnpm --filter caretaker-cli test`
Expected: FAIL with assertion error.

**Step 3: Write minimal implementation**
Modify `packages/cli/src/session/store.ts` to export `dataDir` and `sessionsRoot` as functions and update internal usage.
```typescript
export function dataDir(): string {
  return process.env.CARETAKER_HOME ?? join(homedir(), '.caretaker');
}

export function sessionsRoot(): string {
  return join(dataDir(), 'sessions');
}

function agentDir(agentId: string): string {
  return join(sessionsRoot(), agentId);
}

function sessionPath(agentId: string, sessionId: string): string {
  return join(agentDir(agentId), `${sessionId}.jsonl`);
}
```

**Step 4: Run test to verify it passes**
Run: `pnpm --filter caretaker-cli test`
Expected: PASS

**Step 5: Commit**
```bash
git add packages/cli/src/session/store.ts packages/cli/src/session/public_api.test.ts
git commit -m "fix: make dataDir and sessionsRoot functions in session store to prevent import-time env bugs"
```

---

### Task 2: Extend the Webview/Host Wire Protocol

**Files:**
- Modify: `packages/vscode-extension/src/bridge.ts`

**Step 1: Write the failing test**
No automated unit tests for webview/extension messaging, but we can verify typescript type checking will fail until bridge protocol changes are implemented.

**Step 2: Run type check**
Run: `pnpm --filter caretaker-vscode typecheck`
Expected: SUCCESS (pre-change)

**Step 3: Update `bridge.ts`**
Add `'webviewReady'` to `ViewToHost` union type and update `parseViewToHost` to validate it.
In `packages/vscode-extension/src/bridge.ts`:
```typescript
export type ViewToHost =
  | { type: 'start'; prompt: string }
  | { type: 'abort' }
  | { type: 'permission_response'; id: string; decision: ConfirmDecision }
  | { type: 'selectAgent'; agentId: string }
  | { type: 'selectSession'; sessionId: string }
  | { type: 'createSession' }
  | { type: 'webviewReady' };

export function parseViewToHost(value: unknown): ViewToHost | null {
  if (!isRecord(value)) return null;
  const type = value.type;

  switch (type) {
    case 'start':
      return typeof value.prompt === 'string' ? { type, prompt: value.prompt } : null;
    case 'abort':
      return { type };
    case 'permission_response': {
      const { id, decision } = value;
      if (typeof id !== 'string') return null;
      if (decision !== 'once' && decision !== 'always' && decision !== 'reject') return null;
      return { type, id, decision };
    }
    case 'selectAgent':
      return typeof value.agentId === 'string' ? { type, agentId: value.agentId } : null;
    case 'selectSession':
      return typeof value.sessionId === 'string' ? { type, sessionId: value.sessionId } : null;
    case 'createSession':
      return { type };
    case 'webviewReady':
      return { type };
    default:
      return null;
  }
}
```

**Step 4: Run type check**
Run: `pnpm --filter caretaker-vscode typecheck`
Expected: SUCCESS

**Step 5: Commit**
```bash
git add packages/vscode-extension/src/bridge.ts
git commit -m "feat: add webviewReady signal to wire bridge protocol"
```

---

### Task 3: Implement Webview Handshake Ready Signal

**Files:**
- Modify: `packages/vscode-extension/src/webview/App.tsx`

**Step 1: Run type check**
Run: `pnpm --filter caretaker-vscode typecheck`
Expected: SUCCESS (pre-change)

**Step 2: Update `App.tsx`**
Send `'webviewReady'` once the component mounts and registers message listeners.
In `packages/vscode-extension/src/webview/App.tsx`:
Add a separate `useEffect` to post message on mount:
```typescript
  useEffect(() => {
    postMessage({ type: 'webviewReady' });
  }, []);
```

**Step 3: Run type check**
Run: `pnpm --filter caretaker-vscode typecheck`
Expected: SUCCESS

**Step 4: Commit**
```bash
git add packages/vscode-extension/src/webview/App.tsx
git commit -m "feat: post webviewReady from App component on mount"
```

---

### Task 4: Integrate Webview Handshake and Active Watcher in Host

**Files:**
- Modify: `packages/vscode-extension/src/sidebar.ts`

**Step 1: Run type check**
Run: `pnpm --filter caretaker-vscode typecheck`
Expected: SUCCESS (pre-change)

**Step 2: Update `sidebar.ts`**
1. Remove `void this.initializeView(view.webview)` from `resolveWebviewView` execution.
2. In `handleMessage`, listen for `'webviewReady'` and execute `initializeView` there.
3. Import `dataDir`, `agentsPath` from `caretaker-cli/store`.
4. Import `watch`, `existsSync`, `mkdirSync` from `node:fs`.
5. Implement `setupWatcher` to monitor `agents.json` and post updates on change.
6. Clean up the file watcher on view dispose.
In `packages/vscode-extension/src/sidebar.ts`:
```typescript
import { watch, existsSync, mkdirSync } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { dataDir, agentsPath, loadAgents, loadConfig } from 'caretaker-cli/store';

// Inside SidebarWebviewProvider class:
  private watcher: FSWatcher | null = null;

// In resolveWebviewView:
    view.onDidDispose(() => {
      this.resolveAllPending('reject');
      this.controller?.abort();
      this.controller = null;
      if (this.watcher) {
        this.watcher.close();
        this.watcher = null;
      }
      this.view = null;
    });

// In handleMessage switch statement:
      case 'webviewReady':
        void this.initializeView(webview);
        return;

// In initializeView:
  private async initializeView(webview: vscode.Webview): Promise<void> {
    this.post(webview, { type: 'ready' });
    await this.loadAgentsAndSend(webview);
    this.setupWatcher(webview);
  }

// New method:
  private setupWatcher(webview: vscode.Webview): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    try {
      const dir = dataDir();
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      }

      this.watcher = watch(dir, (eventType, filename) => {
        if (filename === 'agents.json') {
          void this.loadAgentsAndSend(webview);
        }
      });
    } catch (err) {
      console.warn('[caretaker] failed to set up agents.json watcher:', err);
    }
  }
```

**Step 3: Compile and Build VSCode Extension**
Run: `pnpm --filter caretaker-vscode build`
Expected: SUCCESS

**Step 4: Commit**
```bash
git add packages/vscode-extension/src/sidebar.ts
git commit -m "feat: complete webviewReady handshake and setup active agents.json fs watcher"
```

---

## Verification Plan

### Automated Tests
- Run `pnpm --filter caretaker-cli test` to verify no regressions in CLI store modules.
- Run `pnpm --filter caretaker-vscode build` to ensure the compilation of extension and webview succeeds.

### Manual Verification
- Test dropdown populating successfully in the Caretaker sidebar on VSCode extension startup.
- Add/update/delete an agent in `~/.caretaker/agents.json` manually (or via CLI) and verify the dropdown updates dynamically without reloading VSCode.
