import React, { useEffect, useState, useRef } from 'react';
import type { AgentSummary } from './bridge.js';
import { DeleteIcon, WarningIcon, ToolIcon, PauseIcon, ActivateIcon, GitIcon, ArchiveIcon, EditIcon, BackIcon } from './icons.js';
import { MessageList } from './MessageList.js';
import type { ChatItem } from './App.js';

interface Project {
  id: number;
  name: string;
  description: string;
  workingDir: string;
  agentId: string;
  active: boolean;
  plannerAgentId?: string | null;
}

interface ChecklistItem {
  id: string;
  text: string;
  status: 'pending' | 'in_progress' | 'done' | 'skipped';
  order: number;
}

interface Task {
  id: number;
  projectId: number;
  title: string;
  objective: string;
  checklist: ChecklistItem[];
  status: 'draft' | 'planning' | 'active' | 'reviewing' | 'paused' | 'blocked' | 'done';
  blockedReason: string | null;
  noProgressCount: number;
  maxNoProgress: number;
  lockedAt: string | null;
  branch: string | null;
  worktreePath: string | null;
  archived?: boolean;
  agentId?: string | null;
  plannerAgentId?: string | null;
  reviewerAgentId?: string | null;
  planningEnabled?: boolean | null;
  reviewEnabled?: boolean | null;
  sddEnabled?: boolean | null;
  maxRunSeconds?: number | null;
  createdAt: string;
  updatedAt: string;
}

interface TaskMessage {
  id: number;
  taskId: number;
  role: 'user' | 'assistant' | 'tool';
  messageType: 'chat' | 'heartbeat' | 'heartbeat_live' | 'system' | 'block' | 'tool_call' | 'yield' | 'review' | 'plan';
  content: string;
  toolCallId?: string | null;
  createdAt: string;
}

interface ProjectsTabProps {
  agents: AgentSummary[];
}

// --- localStorage persistence keys for the task view ---
const LS_PROJECT_KEY = 'caretaker.taskView.selectedProjectId';
const LS_ARCHIVED_KEY = 'caretaker.taskView.showArchived';

function loadSavedProjectId(): number | null {
  try {
    const raw = localStorage.getItem(LS_PROJECT_KEY);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function saveProjectId(id: number | null): void {
  try {
    if (id === null) localStorage.removeItem(LS_PROJECT_KEY);
    else localStorage.setItem(LS_PROJECT_KEY, String(id));
  } catch {
    /* ignore */
  }
}

function loadShowArchived(): boolean {
  try {
    return localStorage.getItem(LS_ARCHIVED_KEY) === '1';
  } catch {
    return false;
  }
}

function saveShowArchived(v: boolean): void {
  try {
    localStorage.setItem(LS_ARCHIVED_KEY, v ? '1' : '0');
  } catch {
    /* ignore */
  }
}

// Adapt stored TaskMessages to the shared ChatItem shape so the task thread
// reuses the normal chat renderer (MessageList) instead of bespoke inline JSX.
function taskMessagesToChatItems(
  msgs: TaskMessage[],
  labels?: { developer?: string; planner?: string },
): ChatItem[] {
  const items: ChatItem[] = [];
  for (const msg of msgs) {
    if (msg.messageType === 'system' || msg.messageType === 'block') {
      items.push({ kind: 'notice', text: msg.content, variant: msg.messageType });
      continue;
    }
    if (msg.messageType === 'tool_call') {
      // Stored as `${name} ${JSON.stringify(args)}`; results are not persisted.
      const sp = msg.content.indexOf(' ');
      const name = sp === -1 ? msg.content : msg.content.slice(0, sp);
      let args: unknown = {};
      if (sp !== -1) {
        try {
          args = JSON.parse(msg.content.slice(sp + 1));
        } catch {
          args = msg.content.slice(sp + 1);
        }
      }
      items.push({ kind: 'tool', id: msg.toolCallId || String(msg.id), name, args, result: '' });
      continue;
    }
    if (msg.messageType === 'plan') {
      items.push({ kind: 'assistant', text: `**📋 Plan submitted**\n\n${msg.content}`, streaming: false, label: labels?.planner });
      continue;
    }
    if (msg.role === 'user') {
      items.push({ kind: 'user', text: msg.content });
      continue;
    }
    // assistant (chat / heartbeat / heartbeat_live / review / yield)
    let text = msg.content;
    let thinking = '';
    if (msg.content.startsWith('[')) {
      try {
        const parsed = JSON.parse(msg.content);
        if (Array.isArray(parsed)) {
          const t = parsed.find((b: { type?: string; content?: string }) => b.type === 'thinking');
          const x = parsed.find((b: { type?: string; content?: string }) => b.type === 'text');
          if (t?.content) thinking = t.content;
          if (x?.content) text = x.content;
        }
      } catch {
        // keep raw content
      }
    }
    if (thinking) items.push({ kind: 'thinking', text: thinking });
    items.push({ kind: 'assistant', text, streaming: false, label: labels?.developer });
  }
  return items;
}

const PAGE_SIZE = 20;

export function ProjectsTab({ agents }: ProjectsTabProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(loadSavedProjectId);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [taskMessages, setTaskMessages] = useState<TaskMessage[]>([]);

  // View router: which route is active in the main pane.
  const [view, setView] = useState<'list' | 'log' | 'edit'>('list');
  // Pagination for the list/table view.
  const [page, setPage] = useState(0);

  // Modals / forms
  const [isNewTaskOpen, setIsNewTaskOpen] = useState(false);
  const [newTask, setNewTask] = useState({
    title: '',
    objective: '',
    checklistText: '',
    startActive: true,
    agentId: '',
    plannerAgentId: '',
    reviewerAgentId: '',
  });

  const [composerText, setComposerText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [showArchived, setShowArchived] = useState<boolean>(loadShowArchived);
  // Inline confirm dialog (VSCode webviews disable window.confirm()).
  const [pendingConfirm, setPendingConfirm] = useState<{
    type: 'delete' | 'discard' | 'archive';
    task: Task;
  } | null>(null);
  const [taskError, setTaskError] = useState<string | null>(null);

  const threadIntervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    fetchProjects();
    return () => {
      stopThreadPolling();
    };
  }, []);

  // When projects first load and no saved project is selected, default to the first.
  useEffect(() => {
    if (projects.length > 0 && selectedProjectId === null) {
      setSelectedProjectId(projects[0].id);
    }
    // If the saved project no longer exists, fall back to the first.
    if (projects.length > 0 && selectedProjectId !== null && !projects.some((p) => p.id === selectedProjectId)) {
      setSelectedProjectId(projects[0].id);
    }
    if (projects.length === 0) {
      setSelectedProjectId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects]);

  // Persist selected project + show-archived preference.
  useEffect(() => {
    saveProjectId(selectedProjectId);
  }, [selectedProjectId]);
  useEffect(() => {
    saveShowArchived(showArchived);
  }, [showArchived]);

  useEffect(() => {
    if (selectedProjectId !== null) {
      fetchTasks(selectedProjectId);
      // Switching project returns to the list view and clears any open task.
      setView('list');
      setSelectedTaskId(null);
      setTaskMessages([]);
      setPage(0);
      stopThreadPolling();
    } else {
      setTasks([]);
    }
  }, [selectedProjectId, showArchived]);

  useEffect(() => {
    if (selectedTaskId !== null) {
      fetchTaskMessages(selectedTaskId);
      startThreadPolling(selectedTaskId);
    } else {
      stopThreadPolling();
    }
  }, [selectedTaskId]);

  const fetchProjects = async () => {
    try {
      const res = await fetch('/api/projects');
      if (res.ok) {
        const data = await res.json();
        setProjects(data);
      }
    } catch (err) {
      console.error('Failed to fetch projects:', err);
    }
  };

  const fetchTasks = async (projectId: number) => {
    try {
      const qs = showArchived ? '?archived=true' : '';
      const res = await fetch(`/api/projects/${projectId}/tasks${qs}`);
      if (res.ok) {
        const data = await res.json();
        setTasks(data);
      }
    } catch (err) {
      console.error('Failed to fetch tasks:', err);
    }
  };

  const fetchTaskMessages = async (taskId: number) => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/messages`);
      if (res.ok) {
        const data = await res.json();
        setTaskMessages(data);
      }
    } catch (err) {
      console.error('Failed to fetch messages:', err);
    }
  };

  const startThreadPolling = (taskId: number) => {
    stopThreadPolling();
    // Poll for new messages every 3 seconds while viewing a task to show autonomous progress live!
    threadIntervalRef.current = setInterval(() => {
      fetchTaskMessages(taskId);
      if (selectedProjectId !== null) {
        fetchTasks(selectedProjectId); // Refresh tasks list to sync checklist items too!
      }
    }, 3000);
  };

  const stopThreadPolling = () => {
    if (threadIntervalRef.current) {
      clearInterval(threadIntervalRef.current);
      threadIntervalRef.current = null;
    }
  };

  const handleCreateTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTask.title || selectedProjectId === null) return;

    const checklistItems = newTask.checklistText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((text) => ({ text }));

    try {
      const res = await fetch(`/api/projects/${selectedProjectId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: newTask.title,
          objective: newTask.objective,
          checklist: checklistItems,
          startActive: newTask.startActive,
          agentId: newTask.agentId || undefined,
          plannerAgentId: newTask.plannerAgentId || undefined,
          reviewerAgentId: newTask.reviewerAgentId || undefined,
        }),
      });
      if (res.ok) {
        setIsNewTaskOpen(false);
        setNewTask({ title: '', objective: '', checklistText: '', startActive: true, agentId: '', plannerAgentId: '', reviewerAgentId: '' });
        fetchTasks(selectedProjectId);
      }
    } catch (err) {
      console.error('Failed to create task:', err);
    }
  };
  const handleToggleTaskStatus = async (task: Task) => {
    // Reviewing behaves like active for the toggle: the button pauses it.
    const newStatus =
      task.status === 'active' || task.status === 'reviewing' || task.status === 'planning' ? 'paused' : 'active';
    try {
      const res = await fetch(`/api/tasks/${task.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (res.ok) {
        fetchTasks(task.projectId);
      }
    } catch (err) {
      console.error('Failed to toggle status:', err);
    }
  };

  const handleDiscardWorktree = async (task: Task) => {
    // VSCode webviews disable window.confirm(); use an inline overlay instead.
    setPendingConfirm({ type: 'discard', task });
  };

  const handleArchiveToggle = async (task: Task) => {
    const isArchived = !!task.archived;
    const action = isArchived ? 'unarchive' : 'archive';
    try {
      const res = await fetch(`/api/tasks/${task.id}/${action}`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setTaskError(body.error || `Failed to ${action} task`);
      } else {
        // Navigate back to the list after a successful toggle, mirroring delete.
        // Without this, archiving with "Show archived" off removes the task from
        // `tasks`, leaving the edit/log view pointing at an undefined selectedTask
        // and rendering the alarming "Task not found" fallback.
        if (selectedTaskId === task.id) {
          setSelectedTaskId(null);
          setTaskMessages([]);
          stopThreadPolling();
          setView('list');
        }
        fetchTasks(task.projectId);
      }
    } catch (err) {
      setTaskError(`Failed to ${action} task: ${String(err)}`);
    }
  };

  const handleDeleteTask = async (task: Task) => {
    // VSCode webviews disable window.confirm(); use an inline overlay instead.
    setPendingConfirm({ type: 'delete', task });
  };

  // Inline-archive from the list view (with a confirm overlay, one click).
  const handleArchiveFromList = (task: Task) => {
    setPendingConfirm({ type: 'archive', task });
  };

  const confirmPendingAction = async (): Promise<void> => {
    if (!pendingConfirm) return;
    const { type, task } = pendingConfirm;
    setPendingConfirm(null);

    if (type === 'delete') {
      try {
        const res = await fetch(`/api/tasks/${task.id}`, { method: 'DELETE' });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setTaskError(body.error || 'Failed to delete task');
        } else {
          if (selectedTaskId === task.id) {
            setSelectedTaskId(null);
            setTaskMessages([]);
            stopThreadPolling();
            setView('list');
          }
          fetchTasks(task.projectId);
        }
      } catch (err) {
        setTaskError(`Failed to delete task: ${String(err)}`);
      }
    } else if (type === 'discard') {
      try {
        const res = await fetch(`/api/tasks/${task.id}/discard-worktree`, { method: 'POST' });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setTaskError(body.error || 'Failed to discard worktree');
        } else {
          fetchTasks(task.projectId);
          if (selectedTaskId === task.id) {
            fetchTaskMessages(task.id);
          }
        }
      } catch (err) {
        setTaskError(`Failed to discard worktree: ${String(err)}`);
      }
    } else if (type === 'archive') {
      await handleArchiveToggle(task);
    }
  };

  const cancelPendingAction = (): void => {
    setPendingConfirm(null);
  };

  // Dismiss the confirm dialog on Escape (parity with window.confirm()).
  useEffect(() => {
    if (!pendingConfirm) return;
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        setPendingConfirm(null);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [pendingConfirm]);

  // Auto-dismiss error banner after 5 seconds.
  useEffect(() => {
    if (!taskError) return;
    const t = setTimeout(() => setTaskError(null), 5000);
    return () => clearTimeout(t);
  }, [taskError]);

  const handleToggleChecklistItem = async (task: Task, item: ChecklistItem) => {
    const newStatus = item.status === 'done' ? 'pending' : 'done';
    try {
      const res = await fetch(`/api/tasks/${task.id}/checklist-item`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId: item.id, status: newStatus }),
      });
      if (res.ok) {
        fetchTasks(task.projectId);
      }
    } catch (err) {
      console.error('Failed to toggle checklist item:', err);
    }
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!composerText.trim() || selectedTaskId === null || isSending) return;
    setIsSending(true);
    try {
      const res = await fetch(`/api/tasks/${selectedTaskId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: composerText.trim() }),
      });
      if (res.ok) {
        setComposerText('');
        fetchTaskMessages(selectedTaskId);
        if (selectedProjectId !== null) fetchTasks(selectedProjectId);
      }
    } catch (err) {
      console.error('Failed to send message:', err);
    } finally {
      setIsSending(false);
    }
  };

  // Open a task in the log view.
  const openTaskLog = (task: Task) => {
    setSelectedTaskId(task.id);
    setView('log');
  };

  // Open a task in the edit view.
  const openTaskEdit = (task: Task) => {
    setSelectedTaskId(task.id);
    setView('edit');
  };

  // Reassign a task's agent (null = project default).
  const handleSetTaskAgent = async (task: Task, role: 'developer' | 'planner' | 'reviewer', agentId: string) => {
    try {
      const res = await fetch(`/api/tasks/${task.id}/agent`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: agentId || null, role }),
      });
      if (res.ok) {
        if (selectedProjectId !== null) fetchTasks(selectedProjectId);
      } else {
        const data = await res.json().catch(() => ({}));
        setTaskError(data.error || 'Failed to reassign agent');
      }
    } catch (err) {
      console.error('Failed to set task agent:', err);
      setTaskError('Failed to reassign agent');
    }
  };

  const handleSetTaskFlag = async (task: Task, flag: 'planningEnabled' | 'reviewEnabled' | 'sddEnabled', value: boolean | null) => {
    try {
      const res = await fetch(`/api/tasks/${task.id}/flags`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [flag]: value }),
      });
      if (res.ok) {
        if (selectedProjectId !== null) fetchTasks(selectedProjectId);
      } else {
        const data = await res.json().catch(() => ({}));
        setTaskError(data.error || 'Failed to update task setting');
      }
    } catch (err) {
      console.error('Failed to set task flag:', err);
      setTaskError('Failed to update task setting');
    }
  };

  const handleSetTaskMaxRun = async (task: Task, value: number | null) => {
    try {
      const res = await fetch(`/api/tasks/${task.id}/flags`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxRunSeconds: value }),
      });
      if (res.ok) {
        if (selectedProjectId !== null) fetchTasks(selectedProjectId);
      } else {
        const data = await res.json().catch(() => ({}));
        setTaskError(data.error || 'Failed to update task setting');
      }
    } catch (err) {
      console.error('Failed to set task max run seconds:', err);
      setTaskError('Failed to update task setting');
    }
  };

  // Back to the list view (keeps selected project).
  const backToList = () => {
    setView('list');
    setSelectedTaskId(null);
    setTaskMessages([]);
    stopThreadPolling();
  };

  const selectedProject = projects.find((p) => p.id === selectedProjectId);
  const selectedTask = tasks.find((t) => t.id === selectedTaskId);
  const selectedProjectAgentName = agents.find((a) => a.id === selectedProject?.agentId)?.name || 'Default Agent';

  // Resolve the agent identity (name · model) behind each assistant bubble in the
  // task thread, so it's not just "assistant". Same fallback chain as the runtime:
  // task role id → project role id → project developer → first agent.
  const agentLabelFor = (agentId?: string | null): string | undefined => {
    const a = agents.find((x) => x.id === agentId);
    return a ? `${a.name} · ${a.model}` : undefined;
  };
  const taskAgentLabels = selectedTask
    ? {
        developer: agentLabelFor(selectedTask.agentId || selectedProject?.agentId || agents[0]?.id),
        planner: agentLabelFor(
          selectedTask.plannerAgentId ||
            selectedProject?.plannerAgentId ||
            selectedTask.agentId ||
            selectedProject?.agentId ||
            agents[0]?.id,
        ),
      }
    : undefined;

  const reviewRound = selectedTask
    ? taskMessages.filter((m) => m.messageType === 'review').length + 1
    : 1;
  const isActiveLike = selectedTask
    ? selectedTask.status === 'active' || selectedTask.status === 'reviewing' || selectedTask.status === 'planning'
    : false;

  // --- Status color helper (shared by list + log + edit views) ---
  const statusColor = (status: Task['status']): string => {
    switch (status) {
      case 'active':
        return '#22c55e';
      case 'planning':
        return '#06b6d4';
      case 'reviewing':
        return '#a855f7';
      case 'paused':
        return '#eab308';
      case 'blocked':
        return '#f97316';
      case 'done':
        return '#3b82f6';
      default:
        return '#64748b'; // draft
    }
  };

  // --- Pagination for the list view ---
  const totalPages = Math.max(1, Math.ceil(tasks.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageStart = safePage * PAGE_SIZE;
  const pageTasks = tasks.slice(pageStart, pageStart + PAGE_SIZE);

  return (
    <div className="app" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* MAIN PANE — full width, view router */}
      <main className="app__chat-pane" style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'var(--vscode-editor-background)' }}>
        {projects.length === 0 ? (
          <div className="app__empty-state">
            <p>No projects registered. Create one from the Settings panel to get started.</p>
          </div>
        ) : selectedProject ? (
          view === 'list' ? (
            <TaskListView
              projects={projects}
              selectedProjectId={selectedProjectId}
              onProjectChange={setSelectedProjectId}
              project={selectedProject}
              agentName={selectedProjectAgentName}
              agents={agents}
              tasks={pageTasks}
              allTasksCount={tasks.length}
              page={safePage}
              totalPages={totalPages}
              onPageChange={setPage}
              showArchived={showArchived}
              onToggleArchived={() => setShowArchived(!showArchived)}
              onNewTask={() => setIsNewTaskOpen(true)}
              onOpenLog={openTaskLog}
              onOpenEdit={openTaskEdit}
              onArchive={handleArchiveFromList}
              statusColor={statusColor}
            />
          ) : view === 'log' && selectedTask ? (
            <TaskLogView
              task={selectedTask}
              taskMessages={taskMessages}
              agentLabels={taskAgentLabels}
              isActiveLike={isActiveLike}
              reviewRound={reviewRound}
              composerText={composerText}
              onComposerChange={setComposerText}
              onSend={handleSendMessage}
              isSending={isSending}
              onBack={backToList}
              onToggleChecklistItem={handleToggleChecklistItem}
              onToggleStatus={handleToggleTaskStatus}
              statusColor={statusColor}
            />
          ) : view === 'edit' && selectedTask ? (
            <TaskEditView
              task={selectedTask}
              agents={agents}
              onBack={backToList}
              onToggleStatus={handleToggleTaskStatus}
              onDiscardWorktree={handleDiscardWorktree}
              onArchiveToggle={handleArchiveToggle}
              onDelete={handleDeleteTask}
              onToggleChecklistItem={handleToggleChecklistItem}
              onSetAgent={handleSetTaskAgent}
              onSetFlag={handleSetTaskFlag}
              onSetMaxRun={handleSetTaskMaxRun}
              onOpenLog={() => setView('log')}
              statusColor={statusColor}
            />
          ) : (
            <div className="app__empty-state">
              <p>Task not found. Go back to the list.</p>
              <button className="settings-panel__back-btn" onClick={backToList} style={{ marginTop: '12px' }}>
                ← Back to list
              </button>
            </div>
          )
        ) : null}
      </main>

      {/* NEW TASK MODAL */}
      {isNewTaskOpen && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0,0,0,0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 999,
          }}
        >
          <form
            onSubmit={handleCreateTask}
            className="confirm"
            style={{
              width: '420px',
              border: '1px solid var(--vscode-panel-border, rgba(255,255,255,0.1))',
              background: 'var(--vscode-sideBar-background)',
            }}
          >
            <div className="confirm__header">
              <span style={{ fontSize: '18px', display: 'inline-flex' }}><ToolIcon size={18} /></span>
              <span className="confirm__prompt" style={{ fontSize: '14px' }}>Create New Task</span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <label style={{ fontSize: '11px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                Task Title
                <input
                  type="text"
                  required
                  placeholder="e.g. Implement OIDC Login flow"
                  value={newTask.title}
                  onChange={(e) => setNewTask({ ...newTask, title: e.target.value })}
                  style={{
                    background: 'var(--vscode-input-background, #252526)',
                    color: 'var(--vscode-input-foreground)',
                    border: '1px solid var(--vscode-input-border, #3c3c3c)',
                    borderRadius: '4px',
                    padding: '6px 8px',
                    fontSize: '12px',
                    outline: 'none',
                  }}
                />
              </label>

              <label style={{ fontSize: '11px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                Objective (Extended markdown goal description)
                <textarea
                  required
                  placeholder="Describe in detail what needs to be done. The agent will read this."
                  value={newTask.objective}
                  onChange={(e) => setNewTask({ ...newTask, objective: e.target.value })}
                  style={{
                    background: 'var(--vscode-input-background, #252526)',
                    color: 'var(--vscode-input-foreground)',
                    border: '1px solid var(--vscode-input-border, #3c3c3c)',
                    borderRadius: '4px',
                    padding: '6px 8px',
                    fontSize: '12px',
                    height: '80px',
                    outline: 'none',
                    resize: 'none',
                  }}
                />
              </label>

              <label style={{ fontSize: '11px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                Checklist Items (One item per line)
                <textarea
                  placeholder="Create route handler&#10;Write unit tests&#10;Update documentation"
                  value={newTask.checklistText}
                  onChange={(e) => setNewTask({ ...newTask, checklistText: e.target.value })}
                  style={{
                    background: 'var(--vscode-input-background, #252526)',
                    color: 'var(--vscode-input-foreground)',
                    border: '1px solid var(--vscode-input-border, #3c3c3c)',
                    borderRadius: '4px',
                    padding: '6px 8px',
                    fontSize: '12px',
                    height: '80px',
                    outline: 'none',
                    resize: 'none',
                  }}
                />
              </label>

              <label style={{ fontSize: '11px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                Assigned Agent (optional — overrides project default)
                <select
                  value={newTask.agentId}
                  onChange={(e) => setNewTask({ ...newTask, agentId: e.target.value })}
                  style={{
                    background: 'var(--vscode-input-background, #252526)',
                    color: 'var(--vscode-input-foreground)',
                    border: '1px solid var(--vscode-input-border, #3c3c3c)',
                    borderRadius: '4px',
                    padding: '6px 8px',
                    fontSize: '12px',
                    outline: 'none',
                  }}
                >
                  <option value="">Project default</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.provider})
                    </option>
                  ))}
                </select>
              </label>

              <label style={{ fontSize: '11px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                Planner Agent Override (optional)
                <select
                  value={newTask.plannerAgentId}
                  onChange={(e) => setNewTask({ ...newTask, plannerAgentId: e.target.value })}
                  style={{
                    background: 'var(--vscode-input-background, #252526)',
                    color: 'var(--vscode-input-foreground)',
                    border: '1px solid var(--vscode-input-border, #3c3c3c)',
                    borderRadius: '4px',
                    padding: '6px 8px',
                    fontSize: '12px',
                    outline: 'none',
                  }}
                >
                  <option value="">Project default</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.provider})
                    </option>
                  ))}
                </select>
              </label>

              <label style={{ fontSize: '11px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                Reviewer Agent Override (optional)
                <select
                  value={newTask.reviewerAgentId}
                  onChange={(e) => setNewTask({ ...newTask, reviewerAgentId: e.target.value })}
                  style={{
                    background: 'var(--vscode-input-background, #252526)',
                    color: 'var(--vscode-input-foreground)',
                    border: '1px solid var(--vscode-input-border, #3c3c3c)',
                    borderRadius: '4px',
                    padding: '6px 8px',
                    fontSize: '12px',
                    outline: 'none',
                  }}
                >
                  <option value="">Project default</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.provider})
                    </option>
                  ))}
                </select>
              </label>

              <label style={{ fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', marginTop: '4px' }}>
                <input
                  type="checkbox"
                  checked={newTask.startActive}
                  onChange={(e) => setNewTask({ ...newTask, startActive: e.target.checked })}
                  style={{ cursor: 'pointer' }}
                />
                <span>Start active immediately (Heartbeat loop claims it)</span>
              </label>
            </div>

            <div className="confirm__buttons" style={{ justifyContent: 'flex-end', marginTop: '10px' }}>
              <button type="button" className="confirm__btn" onClick={() => setIsNewTaskOpen(false)}>
                Cancel
              </button>
              <button type="submit" className="confirm__btn confirm__btn--primary">
                Create Task
              </button>
            </div>
          </form>
        </div>
      )}
      {/* Inline confirmation dialog (VSCode webviews disable window.confirm()) */}
      {pendingConfirm && (
        <div className="app__confirm-overlay" onClick={cancelPendingAction}>
          <div className="app__confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="app__confirm-title">
              {pendingConfirm.type === 'delete'
                ? 'Delete task'
                : pendingConfirm.type === 'archive'
                ? 'Archive task'
                : 'Discard worktree'}
            </div>
            <p className="app__confirm-message">
              {pendingConfirm.type === 'delete'
                ? `Permanently delete task #${pendingConfirm.task.id} "${pendingConfirm.task.title}"? This removes the task and all its messages from the store. This action cannot be undone.`
                : pendingConfirm.type === 'archive'
                ? `Archive task #${pendingConfirm.task.id} "${pendingConfirm.task.title}"? It will be hidden from the list and excluded from the scheduler. You can unarchive it later by enabling "Show archived".`
                : `Discard the worktree for task #${pendingConfirm.task.id}? Pending changes are committed to branch ${pendingConfirm.task.branch}; the branch is kept.`}
            </p>
            <div className="app__confirm-buttons">
              <button className="app__confirm-btn" onClick={cancelPendingAction}>Cancel</button>
              <button
                className={`app__confirm-btn ${pendingConfirm.type === 'delete' ? 'app__confirm-btn--danger' : ''}`}
                onClick={confirmPendingAction}
              >
                {pendingConfirm.type === 'delete'
                  ? 'Delete'
                  : pendingConfirm.type === 'archive'
                  ? 'Archive'
                  : 'Discard'}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Error banner for failed task actions (auto-dismisses after 5s) */}
      {taskError && (
        <div className="app__error-banner" onClick={() => setTaskError(null)} title="Click to dismiss">
          {taskError}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// VIEW: LIST (paginated tasks table with project filter dropdown)
// ---------------------------------------------------------------------------

interface TaskListViewProps {
  projects: Project[];
  selectedProjectId: number | null;
  onProjectChange: (id: number) => void;
  project: Project;
  agentName: string;
  agents: AgentSummary[];
  tasks: Task[];
  allTasksCount: number;
  page: number;
  totalPages: number;
  onPageChange: (p: number) => void;
  showArchived: boolean;
  onToggleArchived: () => void;
  onNewTask: () => void;
  onOpenLog: (t: Task) => void;
  onOpenEdit: (t: Task) => void;
  onArchive: (t: Task) => void;
  statusColor: (s: Task['status']) => string;
}

function TaskListView({
  projects,
  selectedProjectId,
  onProjectChange,
  project,
  agentName,
  agents,
  tasks,
  allTasksCount,
  page,
  totalPages,
  onPageChange,
  showArchived,
  onToggleArchived,
  onNewTask,
  onOpenLog,
  onOpenEdit,
  onArchive,
  statusColor,
}: TaskListViewProps) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header: project filter dropdown, agent, + New Task, Show archived */}
      <div className="task-view__header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <select
            className="task-view__project-filter"
            value={selectedProjectId ?? undefined}
            onChange={(e) => onProjectChange(Number(e.target.value))}
            style={{
              background: 'var(--vscode-input-background, #252526)',
              color: 'var(--vscode-input-foreground)',
              border: '1px solid var(--vscode-input-border, #3c3c3c)',
              borderRadius: '4px',
              padding: '4px 8px',
              fontSize: '13px',
              fontWeight: 600,
              outline: 'none',
              cursor: 'pointer',
            }}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <span style={{ fontSize: '10px', opacity: 0.6 }}>Agent: {agentName}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <label className="task-view__archived-toggle">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={onToggleArchived}
              style={{ cursor: 'pointer' }}
            />
            Show archived
          </label>
          <button className="app__new-chat-btn" onClick={onNewTask} style={{ padding: '4px 10px', fontSize: '11px' }}>
            + New Task
          </button>
        </div>
      </div>

      {/* Table */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 16px 16px' }}>
        {allTasksCount === 0 ? (
          <div className="app__empty-state">
            <p>No tasks created for {project.name}. Click "+ New Task" to start.</p>
          </div>
        ) : (
          <table className="task-table">
            <thead>
              <tr>
                <th className="task-table__th" style={{ width: '60px' }}>#</th>
                <th className="task-table__th">Title</th>
                <th className="task-table__th" style={{ width: '90px' }}>Status</th>
                <th className="task-table__th" style={{ width: '100px' }}>Agent</th>
                <th className="task-table__th" style={{ width: '120px' }}>Checklist</th>
                <th className="task-table__th" style={{ width: '180px' }}>Branch</th>
                <th className="task-table__th" style={{ width: '150px' }}>Updated</th>
                <th className="task-table__th" style={{ width: '70px' }}></th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => {
                const completedCount = task.checklist.filter((c) => c.status === 'done').length;
                const totalCount = task.checklist.length;
                const isArchived = !!task.archived;
                const updated = new Date(task.updatedAt);
                const updatedStr = isNaN(updated.getTime())
                  ? task.updatedAt
                  : updated.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                return (
                  <tr
                    key={task.id}
                    className={`task-table__row${isArchived ? ' task-table__row--archived' : ''}`}
                    onClick={() => onOpenLog(task)}
                  >
                    <td className="task-table__td task-table__td--mono">{task.id}</td>
                    <td className="task-table__td">
                      <span className="task-table__title">
                        {isArchived && <ArchiveIcon size={11} />}
                        {task.title}
                      </span>
                    </td>
                    <td className="task-table__td">
                      <span
                        className="task-table__badge"
                        style={{ background: statusColor(task.status) }}
                      >
                        {task.status}
                      </span>
                    </td>
                    <td className="task-table__td" style={{ fontSize: '11px' }}>
                      {task.agentId
                        ? (agents.find((a) => a.id === task.agentId)?.name || task.agentId)
                        : <span style={{ opacity: 0.4 }}>default</span>}
                    </td>
                    <td className="task-table__td">
                      {totalCount > 0 ? (
                        <div className="task-table__progress">
                          <span className="task-table__progress-bar">
                            <span
                              className="task-table__progress-fill"
                              style={{ width: `${(completedCount / totalCount) * 100}%` }}
                            />
                          </span>
                          <span className="task-table__progress-text">{completedCount}/{totalCount}</span>
                        </div>
                      ) : (
                        <span style={{ opacity: 0.4, fontSize: '11px' }}>—</span>
                      )}
                    </td>
                    <td className="task-table__td">
                      {task.branch ? (
                        <span className="task-table__branch">
                          <GitIcon size={11} />
                          <code>{task.branch}</code>
                        </span>
                      ) : (
                        <span style={{ opacity: 0.4, fontSize: '11px' }}>—</span>
                      )}
                    </td>
                    <td className="task-table__td task-table__td--muted">{updatedStr}</td>
                    <td className="task-table__td">
                      <div style={{ display: 'inline-flex', gap: '2px' }}>
                        <button
                          className="task-table__edit-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            onArchive(task);
                          }}
                          title={task.archived ? 'Unarchive task' : 'Archive task'}
                          aria-label={task.archived ? 'Unarchive task' : 'Archive task'}
                        >
                          <ArchiveIcon size={13} />
                        </button>
                        <button
                          className="task-table__edit-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenEdit(task);
                          }}
                          title="Edit task"
                          aria-label="Edit task"
                        >
                          <EditIcon size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination footer */}
      {totalPages > 1 && (
        <div className="task-table__pagination">
          <button
            className="task-table__page-btn"
            disabled={page === 0}
            onClick={() => onPageChange(page - 1)}
          >
            ‹ Prev
          </button>
          <span className="task-table__page-info">
            Page {page + 1} of {totalPages}
          </span>
          <button
            className="task-table__page-btn"
            disabled={page >= totalPages - 1}
            onClick={() => onPageChange(page + 1)}
          >
            Next ›
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// VIEW: LOG (task execution thread + composer)
// ---------------------------------------------------------------------------

interface TaskLogViewProps {
  task: Task;
  taskMessages: TaskMessage[];
  agentLabels?: { developer?: string; planner?: string };
  isActiveLike: boolean;
  reviewRound: number;
  composerText: string;
  onComposerChange: (s: string) => void;
  onSend: (e: React.FormEvent) => void;
  isSending: boolean;
  onBack: () => void;
  onToggleChecklistItem: (t: Task, item: ChecklistItem) => void;
  onToggleStatus: (t: Task) => void;
  statusColor: (s: Task['status']) => string;
}

function TaskLogView({
  task,
  taskMessages,
  agentLabels,
  isActiveLike,
  reviewRound,
  composerText,
  onComposerChange,
  onSend,
  isSending,
  onBack,
  onToggleChecklistItem,
  onToggleStatus,
  statusColor,
}: TaskLogViewProps) {
  const completedCount = task.checklist.filter((c) => c.status === 'done').length;
  const totalCount = task.checklist.length;
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header with back button + task title + status */}
      <header className="app__chat-header task-view__sub-header" style={{ padding: '12px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <button className="settings-panel__back-btn" onClick={onBack} title="Back to task list">
            <BackIcon size={13} />
          </button>
          <div className="app__chat-header-info">
            <h3 className="app__chat-header-title" style={{ fontSize: '13px', margin: 0 }}>
              Task #{task.id}: {task.title}
            </h3>
            <span className="app__chat-header-status" style={{ fontSize: '10px' }}>
              <span
                className={`agent-status-dot agent-status-dot--active ${isActiveLike ? 'agent-status-dot--pulsing' : ''}`}
                style={task.status === 'reviewing' ? { background: '#a855f7' } : task.status === 'planning' ? { background: '#06b6d4' } : undefined}
              />
              {task.status === 'active'
                ? 'Heartbeat loop active'
                : task.status === 'planning'
                ? 'Planning phase — read-only'
                : task.status === 'reviewing'
                ? `In review (round ${reviewRound}/3)`
                : `Task status: ${task.status}`}
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {task.status !== 'done' && (
            <button
              className="confirm__btn confirm__btn--primary"
              onClick={() => onToggleStatus(task)}
              title={isActiveLike ? 'Pause this task (aborts the running agent)' : 'Activate this task'}
              style={{ padding: '3px 10px', fontSize: '10px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
            >
              {isActiveLike ? (
                <>
                  <PauseIcon size={12} /> Pause
                </>
              ) : (
                <>
                  <ActivateIcon size={12} /> Activate
                </>
              )}
            </button>
          )}
          <span
            className="task-table__badge"
            style={{ background: statusColor(task.status) }}
          >
            {task.status}
          </span>
        </div>
      </header>

      {/* Body: checklist sidebar (left) + message thread (right) */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'row' }}>
        {/* Checklist sidebar */}
        <aside
          style={{
            width: '240px',
            minWidth: '200px',
            borderRight: '1px solid var(--vscode-panel-border, rgba(255,255,255,0.08))',
            display: 'flex',
            flexDirection: 'column',
            overflowY: 'auto',
            background: 'var(--vscode-sideBar-background, rgba(0,0,0,0.1))',
          }}
        >
          <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--vscode-panel-border, rgba(255,255,255,0.05))' }}>
            <h4 style={{ margin: 0, fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.08em', opacity: 0.6 }}>
              Checklist
            </h4>
            {totalCount > 0 && (
              <div style={{ fontSize: '10px', opacity: 0.5, marginTop: '2px' }}>
                {completedCount}/{totalCount} done
              </div>
            )}
          </div>
          <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {totalCount === 0 ? (
              <span style={{ fontSize: '11px', opacity: 0.4, padding: '8px 4px' }}>No checklist items.</span>
            ) : (
              (task.checklist || []).map((item) => {
                const isDone = item.status === 'done';
                const isInProgress = item.status === 'in_progress';
                return (
                  <label
                    key={item.id}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '6px',
                      fontSize: '11px',
                      padding: '4px 6px',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      textDecoration: isDone ? 'line-through' : 'none',
                      opacity: isDone ? 0.5 : 1,
                      background: isInProgress ? 'rgba(168,85,247,0.08)' : 'transparent',
                    }}
                    title={isInProgress ? 'In progress' : isDone ? 'Done' : 'Pending'}
                  >
                    <input
                      type="checkbox"
                      checked={isDone}
                      onChange={() => onToggleChecklistItem(task, item)}
                      style={{ marginTop: '2px', cursor: 'pointer', flexShrink: 0 }}
                    />
                    <span style={{ wordBreak: 'break-word' }}>{item.text}</span>
                  </label>
                );
              })
            )}
          </div>
        </aside>

        {/* Message thread */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {taskMessages.length === 0 ? (
            <div className="messages messages--empty">No messages in this execution yet. Agent will start on next tick.</div>
          ) : (
            <MessageList items={taskMessagesToChatItems(taskMessages, agentLabels)} sessionId={null} />
          )}

          {/* Composer */}
          <form className="composer" onSubmit={onSend}>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
              <textarea
                className="composer__input"
                placeholder="Provide feedback or ask the agent to resume..."
                value={composerText}
                onChange={(e) => onComposerChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    onSend(e);
                  }
                }}
                style={{ flex: 1, minHeight: '44px' }}
              />
              <button
                type="submit"
                className="app__new-chat-btn"
                disabled={!composerText.trim() || isSending}
                style={{ height: '40px', padding: '0 16px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                {isSending ? 'Sending...' : 'Send'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// VIEW: EDIT (objective, checklist, status actions, branch info)
// ---------------------------------------------------------------------------

interface TaskEditViewProps {
  task: Task;
  agents: AgentSummary[];
  onBack: () => void;
  onToggleStatus: (t: Task) => void;
  onDiscardWorktree: (t: Task) => void;
  onArchiveToggle: (t: Task) => void;
  onDelete: (t: Task) => void;
  onToggleChecklistItem: (t: Task, item: ChecklistItem) => void;
  onSetAgent: (t: Task, role: 'developer' | 'planner' | 'reviewer', agentId: string) => void;
  onSetFlag: (t: Task, flag: 'planningEnabled' | 'reviewEnabled' | 'sddEnabled', value: boolean | null) => void;
  onSetMaxRun: (t: Task, value: number | null) => void;
  onOpenLog: () => void;
  statusColor: (s: Task['status']) => string;
}

function TaskEditView({
  task,
  agents,
  onBack,
  onToggleStatus,
  onDiscardWorktree,
  onArchiveToggle,
  onDelete,
  onToggleChecklistItem,
  onSetAgent,
  onSetFlag,
  onSetMaxRun,
  onOpenLog,
  statusColor,
}: TaskEditViewProps) {
  const isRunning = task.status === 'active' || task.status === 'reviewing' || task.status === 'planning';
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto' }}>
      {/* Header with back button + title + status actions */}
      <div className="task-view__sub-header" style={{ padding: '12px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <button className="settings-panel__back-btn" onClick={onBack} title="Back to task list">
            <BackIcon size={13} />
          </button>
          <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 700 }}>Task #{task.id}: {task.title}</h3>
          <span
            className="task-table__badge"
            style={{ background: statusColor(task.status) }}
          >
            {task.status}
          </span>
        </div>
        <div style={{ display: 'inline-flex', gap: '6px' }}>
          <button
            className="confirm__btn"
            onClick={onOpenLog}
            title="View execution log"
            style={{ padding: '3px 10px', fontSize: '10px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
          >
            View Log
          </button>
          {task.worktreePath && (
            <button
              className="confirm__btn"
              onClick={() => onDiscardWorktree(task)}
              title={`Commit pending changes to ${task.branch} and remove the worktree`}
              style={{ padding: '3px 10px', fontSize: '10px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
            >
              <GitIcon size={12} /> Discard worktree
            </button>
          )}
          <button
            className="confirm__btn"
            onClick={() => onArchiveToggle(task)}
            title={task.archived ? 'Unarchive this task' : 'Archive this task (hides it from the list, excludes from scheduler)'}
            style={{ padding: '3px 10px', fontSize: '10px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
          >
            <ArchiveIcon size={12} /> {task.archived ? 'Unarchive' : 'Archive'}
          </button>
          <button
            className="confirm__btn confirm__btn--primary"
            onClick={() => onToggleStatus(task)}
            style={{ padding: '3px 10px', fontSize: '10px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
          >
            {task.status === 'active' || task.status === 'reviewing' || task.status === 'planning' ? (
              <>
                <PauseIcon size={12} /> Pause
              </>
            ) : (
              <>
                <ActivateIcon size={12} /> Activate
              </>
            )}
          </button>
          <button
            className="confirm__btn"
            onClick={() => onDelete(task)}
            title="Permanently delete this task and all its messages"
            style={{ padding: '3px 10px', fontSize: '10px', display: 'inline-flex', alignItems: 'center', gap: '4px', color: '#ef4444' }}
          >
            <DeleteIcon size={12} /> Delete
          </button>
        </div>
      </div>

      <div style={{ padding: '16px', maxWidth: '720px' }}>
        {task.branch && (
          <div style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', opacity: 0.75 }}>
            <GitIcon size={12} />
            <code style={{ fontFamily: 'monospace' }}>{task.branch}</code>
            {!task.worktreePath && <span style={{ opacity: 0.6 }}>(worktree removed)</span>}
          </div>
        )}

        <div style={{ marginBottom: '16px' }}>
          <h4 style={{ margin: '0 0 6px 0', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.08em', opacity: 0.6 }}>
            Objective
          </h4>
          <div style={{ fontSize: '12px', background: 'rgba(255,255,255,0.02)', padding: '10px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.05)', whiteSpace: 'pre-wrap' }}>
            {task.objective}
          </div>
        </div>

        <div style={{ marginBottom: '16px' }}>
          <h4 style={{ margin: '0 0 6px 0', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.08em', opacity: 0.6 }}>
            Assigned Agent
          </h4>
          <select
            value={task.agentId || ''}
            onChange={(e) => onSetAgent(task, 'developer', e.target.value)}
            disabled={isRunning}
            style={{
              background: 'var(--vscode-input-background, #252526)',
              color: 'var(--vscode-input-foreground)',
              border: '1px solid var(--vscode-input-border, #3c3c3c)',
              borderRadius: '4px',
              padding: '6px 8px',
              fontSize: '12px',
              outline: 'none',
              width: '100%',
              cursor: isRunning ? 'not-allowed' : 'pointer',
              opacity: isRunning ? 0.6 : 1,
            }}
            title={
              isRunning
                ? 'Pause the task before changing its agent'
                : 'Choose which agent runs this task'
            }
          >
            <option value="">Project default</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.provider})
              </option>
            ))}
          </select>
        </div>

        <div style={{ marginBottom: '16px' }}>
          <h4 style={{ margin: '0 0 6px 0', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.08em', opacity: 0.6 }}>
            Planner Agent
          </h4>
          <select
            value={task.plannerAgentId || ''}
            onChange={(e) => onSetAgent(task, 'planner', e.target.value)}
            disabled={isRunning}
            style={{ background: 'var(--vscode-input-background, #252526)', color: 'var(--vscode-input-foreground)', border: '1px solid var(--vscode-input-border, #3c3c3c)', borderRadius: '4px', padding: '6px 8px', fontSize: '12px', outline: 'none', width: '100%', cursor: isRunning ? 'not-allowed' : 'pointer', opacity: isRunning ? 0.6 : 1 }}
            title={isRunning ? 'Pause the task before changing its planner' : 'Agent that runs the planning phase (read-only). Unset: falls back to the project planner, then the developer.'}
          >
            <option value="">Project default</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name} ({a.provider})</option>
            ))}
          </select>
        </div>

        <div style={{ marginBottom: '16px' }}>
          <h4 style={{ margin: '0 0 6px 0', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.08em', opacity: 0.6 }}>
            Reviewer Agent
          </h4>
          <select
            value={task.reviewerAgentId || ''}
            onChange={(e) => onSetAgent(task, 'reviewer', e.target.value)}
            disabled={isRunning}
            style={{ background: 'var(--vscode-input-background, #252526)', color: 'var(--vscode-input-foreground)', border: '1px solid var(--vscode-input-border, #3c3c3c)', borderRadius: '4px', padding: '6px 8px', fontSize: '12px', outline: 'none', width: '100%', cursor: isRunning ? 'not-allowed' : 'pointer', opacity: isRunning ? 0.6 : 1 }}
            title={isRunning ? 'Pause the task before changing its reviewer' : 'Agent that reviews the branch at DONE. Unset: falls back to the project reviewer, then the developer.'}
          >
            <option value="">Project default</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name} ({a.provider})</option>
            ))}
          </select>
        </div>

        <div style={{ marginBottom: '16px' }}>
          <h4 style={{ margin: '0 0 6px 0', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.08em', opacity: 0.6 }}>
            Phases
          </h4>
          <div style={{ display: 'flex', gap: '12px' }}>
            {(
              [
                { flag: 'planningEnabled' as const, label: 'Planning phase', value: task.planningEnabled },
                { flag: 'reviewEnabled' as const, label: 'Review at DONE', value: task.reviewEnabled },
                { flag: 'sddEnabled' as const, label: 'SDD mode (.md specs)', value: task.sddEnabled },
              ]
            ).map(({ flag, label, value }) => (
              <label key={flag} style={{ fontSize: '11px', display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 }}>
                {label}
                <select
                  value={value === true ? 'on' : value === false ? 'off' : 'inherit'}
                  onChange={(e) => onSetFlag(task, flag, e.target.value === 'inherit' ? null : e.target.value === 'on')}
                  style={{ background: 'var(--vscode-input-background, #252526)', color: 'var(--vscode-input-foreground)', border: '1px solid var(--vscode-input-border, #3c3c3c)', borderRadius: '4px', padding: '6px 8px', fontSize: '12px', outline: 'none' }}
                >
                  <option value="inherit">Project default</option>
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </select>
              </label>
            ))}
          </div>
          <label style={{ fontSize: '11px', display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '12px', maxWidth: '260px' }}>
            Max run seconds per cycle
            <input
              type="number"
              min={1}
              defaultValue={task.maxRunSeconds ?? ''}
              key={task.maxRunSeconds ?? 'default'}
              placeholder="Project default"
              title="Wall-clock budget for one cycle, enforced as an abort. Empty = inherit the project (or the 120s native / 900s claude-code default)."
              onBlur={(e) => {
                const raw = e.target.value.trim();
                const n = raw === '' ? null : parseInt(raw, 10);
                const next = n !== null && Number.isFinite(n) && n > 0 ? n : null;
                if (next !== (task.maxRunSeconds ?? null)) onSetMaxRun(task, next);
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              style={{ background: 'var(--vscode-input-background, #252526)', color: 'var(--vscode-input-foreground)', border: '1px solid var(--vscode-input-border, #3c3c3c)', borderRadius: '4px', padding: '6px 8px', fontSize: '12px', outline: 'none' }}
            />
          </label>
        </div>

        {task.status === 'blocked' && task.blockedReason && (
          <div
            style={{
              marginBottom: '16px',
              padding: '10px',
              background: 'rgba(239, 68, 68, 0.1)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              borderRadius: '6px',
              color: '#ef4444',
              fontSize: '12px',
            }}
          >
            <strong><WarningIcon size={13} /> Blocked Reason:</strong>
            <p style={{ margin: '4px 0 0 0' }}>{task.blockedReason}</p>
          </div>
        )}

        <div>
          <h4 style={{ margin: '0 0 8px 0', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.08em', opacity: 0.6 }}>
            Checklist
          </h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {(task.checklist || []).map((item) => {
              const isDone = item.status === 'done';
              return (
                <label
                  key={item.id}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '8px',
                    fontSize: '12px',
                    padding: '6px 8px',
                    background: 'rgba(255,255,255,0.01)',
                    border: '1px solid rgba(255,255,255,0.03)',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    textDecoration: isDone ? 'line-through' : 'none',
                    opacity: isDone ? 0.6 : 1,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={isDone}
                    onChange={() => onToggleChecklistItem(task, item)}
                    style={{ marginTop: '2px', cursor: 'pointer' }}
                  />
                  <span>{item.text}</span>
                </label>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}