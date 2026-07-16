import React, { useEffect, useState, useRef } from 'react';
import type { AgentSummary } from './bridge.js';
import { FolderIcon, DeleteIcon, WarningIcon, ToolIcon, PauseIcon, ActivateIcon, GitIcon, ArchiveIcon } from './icons.js';
import FolderPicker from './FolderPicker.js';
import { MessageList } from './MessageList.js';
import type { ChatItem } from './App.js';

interface Project {
  id: number;
  name: string;
  description: string;
  workingDir: string;
  agentId: string;
  active: boolean;
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
  status: 'draft' | 'active' | 'reviewing' | 'paused' | 'blocked' | 'done';
  blockedReason: string | null;
  noProgressCount: number;
  maxNoProgress: number;
  lockedAt: string | null;
  branch: string | null;
  worktreePath: string | null;
  archived?: boolean;
  createdAt: string;
  updatedAt: string;
}

interface TaskMessage {
  id: number;
  taskId: number;
  role: 'user' | 'assistant' | 'tool';
  messageType: 'chat' | 'heartbeat' | 'heartbeat_live' | 'system' | 'block' | 'tool_call' | 'yield' | 'review';
  content: string;
  toolCallId?: string | null;
  createdAt: string;
}

interface ProjectsTabProps {
  agents: AgentSummary[];
}

// Adapt stored TaskMessages to the shared ChatItem shape so the task thread
// reuses the normal chat renderer (MessageList) instead of bespoke inline JSX.
function taskMessagesToChatItems(msgs: TaskMessage[]): ChatItem[] {
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
    items.push({ kind: 'assistant', text, streaming: false });
  }
  return items;
}

export function ProjectsTab({ agents }: ProjectsTabProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [taskMessages, setTaskMessages] = useState<TaskMessage[]>([]);

  // Modals / forms
  const [isNewProjectOpen, setIsNewProjectOpen] = useState(false);
  const [newProject, setNewProject] = useState({
    name: '',
    description: '',
    workingDir: '',
    agentId: '',
  });

  const [isNewTaskOpen, setIsNewTaskOpen] = useState(false);
  const [newTask, setNewTask] = useState({
    title: '',
    objective: '',
    checklistText: '',
    startActive: true,
  });

  const [composerText, setComposerText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  // Inline confirm dialog (VSCode webviews disable window.confirm()).
  const [pendingConfirm, setPendingConfirm] = useState<{
    type: 'delete' | 'discard';
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

  useEffect(() => {
    if (selectedProjectId !== null) {
      fetchTasks(selectedProjectId);
      setSelectedTaskId(null);
      setTaskMessages([]);
      stopThreadPolling();
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

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProject.name || !newProject.workingDir) return;
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...newProject,
          agentId: newProject.agentId || (agents[0]?.id ?? ''),
        }),
      });
      if (res.ok) {
        setIsNewProjectOpen(false);
        setNewProject({ name: '', description: '', workingDir: '', agentId: '' });
        fetchProjects();
      }
    } catch (err) {
      console.error('Failed to create project:', err);
    }
  };

  const handleDeleteProject = async (id: number) => {
    if (!confirm('Are you sure you want to delete this project? All associated tasks will be deleted.')) return;
    try {
      const res = await fetch(`/api/projects/${id}`, { method: 'DELETE' });
      if (res.ok) {
        if (selectedProjectId === id) setSelectedProjectId(null);
        fetchProjects();
      }
    } catch (err) {
      console.error('Failed to delete project:', err);
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
        }),
      });
      if (res.ok) {
        setIsNewTaskOpen(false);
        setNewTask({ title: '', objective: '', checklistText: '', startActive: true });
        fetchTasks(selectedProjectId);
      }
    } catch (err) {
      console.error('Failed to create task:', err);
    }
  };
  const handleToggleTaskStatus = async (task: Task) => {
    // Reviewing behaves like active for the toggle: the button pauses it.
    const newStatus =
      task.status === 'active' || task.status === 'reviewing' ? 'paused' : 'active';
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

  const selectedProject = projects.find((p) => p.id === selectedProjectId);
  const selectedTask = tasks.find((t) => t.id === selectedTaskId);
  const selectedProjectAgentName = agents.find((a) => a.id === selectedProject?.agentId)?.name || 'Default Agent';

  const reviewRound = selectedTask
    ? taskMessages.filter((m) => m.messageType === 'review').length + 1
    : 1;
  const isActiveLike = selectedTask
    ? selectedTask.status === 'active' || selectedTask.status === 'reviewing'
    : false;

  return (
    <div className="app app--with-sidebar" style={{ height: '100%' }}>
      {/* LEFT PROJECTS SIDEBAR */}
      <aside className="app__sidebar" style={{ width: '260px' }}>
        <div className="app__sidebar-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="app__sidebar-section-title" style={{ fontSize: '11px', fontWeight: 'bold' }}>PROJECTS</span>
          <button
            className="app__new-chat-btn"
            onClick={() => setIsNewProjectOpen(true)}
            style={{ padding: '2px 8px', fontSize: '10px' }}
          >
            + Add
          </button>
        </div>

        <div className="app__sidebar-content" style={{ padding: '8px' }}>
          <div className="app__sidebar-sessions-list">
            {projects.length === 0 ? (
              <div className="app__sidebar-empty-text">No projects registered.</div>
            ) : (
              projects.map((project) => {
                const isSelected = selectedProjectId === project.id;
                return (
                  <div
                    key={project.id}
                    className={`app__sidebar-session-item ${isSelected ? 'app__sidebar-session-item--active' : ''}`}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '6px 8px',
                      cursor: 'pointer',
                      borderRadius: '6px',
                      marginBottom: '4px',
                    }}
                    onClick={() => setSelectedProjectId(project.id)}
                  >
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}><FolderIcon size={12} /> {project.name}</div>
                      <div style={{ fontSize: '10px', opacity: 0.7 }} title={project.workingDir}>
                        {project.workingDir.length > 25 ? `...${project.workingDir.slice(-22)}` : project.workingDir}
                      </div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteProject(project.id);
                      }}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: isSelected ? '#ffffff' : '#ef4444',
                        cursor: 'pointer',
                        padding: '4px',
                        fontSize: '12px',
                        opacity: 0.8,
                      }}
                      title="Delete Project"
                      aria-label="Delete Project"
                    >
                      <DeleteIcon size={12} />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </aside>

      {/* MIDDLE & RIGHT PANEL */}
      <main className="app__chat-pane" style={{ flex: 1, display: 'flex', flexDirection: 'row', background: 'var(--vscode-editor-background)' }}>
        {selectedProject ? (
          <>
            {/* TASKS COLUMN */}
            <div
              style={{
                width: '300px',
                borderRight: '1px solid var(--vscode-panel-border, rgba(255,255,255,0.08))',
                display: 'flex',
                flexDirection: 'column',
                height: '100%',
              }}
            >
              <div
                style={{
                  padding: '12px 14px',
                  borderBottom: '1px solid var(--vscode-panel-border, rgba(255,255,255,0.08))',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <div>
                  <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 700 }}>{selectedProject.name}</h3>
                  <span style={{ fontSize: '10px', opacity: 0.6 }}>Agent: {selectedProjectAgentName}</span>
                </div>
                <button
                  className="app__new-chat-btn"
                  onClick={() => setIsNewTaskOpen(true)}
                  style={{ padding: '4px 8px', fontSize: '11px' }}
                >
                  + New Task
                </button>
              </div>

              <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  <h4 style={{ margin: 0, fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.08em', opacity: 0.6 }}>
                    Tasks
                  </h4>
                  <label style={{ fontSize: '10px', display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', opacity: 0.7 }}>
                    <input
                      type="checkbox"
                      checked={showArchived}
                      onChange={(e) => setShowArchived(e.target.checked)}
                      style={{ cursor: 'pointer' }}
                    />
                    Show archived
                  </label>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {tasks.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '20px', color: 'var(--vscode-descriptionForeground)', fontStyle: 'italic', fontSize: '12px' }}>
                      No tasks created.
                    </div>
                  ) : (
                    tasks.map((task) => {
                      const isSelected = selectedTaskId === task.id;
                      const completedCount = task.checklist.filter((c) => c.status === 'done').length;
                      const totalCount = task.checklist.length;
                      const isArchived = !!task.archived;
                      
                      let statusColor = '#64748b'; // draft
                      if (task.status === 'active') statusColor = '#22c55e';
                      if (task.status === 'reviewing') statusColor = '#a855f7';
                      if (task.status === 'paused') statusColor = '#eab308';
                      if (task.status === 'blocked') statusColor = '#f97316';
                      if (task.status === 'done') statusColor = '#3b82f6';

                      return (
                        <div
                          key={task.id}
                          onClick={() => setSelectedTaskId(task.id)}
                          style={{
                            padding: '10px',
                            borderRadius: '8px',
                            background: isSelected ? 'rgba(255,255,255,0.05)' : 'transparent',
                            border: `1px solid ${isSelected ? 'var(--primary-blue)' : 'var(--vscode-panel-border, rgba(255,255,255,0.05))'}`,
                            cursor: 'pointer',
                            transition: 'all 0.2s ease',
                            opacity: isArchived ? 0.55 : 1,
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '4px' }}>
                            <span style={{ fontWeight: 600, fontSize: '12px', color: 'var(--vscode-foreground)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                              {isArchived && <ArchiveIcon size={11} />}
                              {task.title}
                            </span>
                            <div style={{ display: 'flex', gap: '3px', alignItems: 'center' }}>
                              {isArchived && (
                                <span
                                  style={{
                                    fontSize: '9px',
                                    fontWeight: 'bold',
                                    color: '#ffffff',
                                    background: '#78716c',
                                    padding: '1px 5px',
                                    borderRadius: '4px',
                                    textTransform: 'uppercase',
                                  }}
                                >
                                  archived
                                </span>
                              )}
                              <span
                                style={{
                                  fontSize: '9px',
                                  fontWeight: 'bold',
                                  color: '#ffffff',
                                  background: statusColor,
                                  padding: '1px 5px',
                                  borderRadius: '4px',
                                  textTransform: 'uppercase',
                                }}
                              >
                                {task.status}
                              </span>
                            </div>
                          </div>
                          <div style={{ fontSize: '11px', opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', marginBottom: '6px' }}>
                            {task.objective}
                          </div>
                          {totalCount > 0 && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '10px', opacity: 0.6 }}>
                              <span style={{ flex: 1, height: '4px', background: 'rgba(255,255,255,0.1)', borderRadius: '2px', overflow: 'hidden' }}>
                                <span
                                  style={{
                                    display: 'block',
                                    height: '100%',
                                    width: `${(completedCount / totalCount) * 100}%`,
                                    background: 'var(--accent-cyan)',
                                  }}
                                />
                              </span>
                              <span>
                                {completedCount}/{totalCount}
                              </span>
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>

            {/* DETAIL & CHAT PANE */}
            {selectedTask ? (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'row', height: '100%' }}>
                {/* TASK METADATA & CHECKLIST (LEFT COLUMN) */}
                <div
                  style={{
                    width: '320px',
                    borderRight: '1px solid var(--vscode-panel-border, rgba(255,255,255,0.08))',
                    display: 'flex',
                    flexDirection: 'column',
                    height: '100%',
                    padding: '16px',
                    overflowY: 'auto',
                  }}
                >
                  <div style={{ marginBottom: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 700 }}>Task #{selectedTask.id}</h3>
                    <div style={{ display: 'inline-flex', gap: '6px' }}>
                      {selectedTask.worktreePath && (
                        <button
                          className="confirm__btn"
                          onClick={() => handleDiscardWorktree(selectedTask)}
                          title={`Commit pending changes to ${selectedTask.branch} and remove the worktree`}
                          style={{ padding: '3px 10px', fontSize: '10px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                        >
                          <GitIcon size={12} /> Discard worktree
                        </button>
                      )}
                      <button
                        className="confirm__btn"
                        onClick={() => handleArchiveToggle(selectedTask)}
                        title={selectedTask.archived ? 'Unarchive this task' : 'Archive this task (hides it from the list, excludes from scheduler)'}
                        style={{ padding: '3px 10px', fontSize: '10px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                      >
                        <ArchiveIcon size={12} /> {selectedTask.archived ? 'Unarchive' : 'Archive'}
                      </button>
                      <button
                        className="confirm__btn confirm__btn--primary"
                        onClick={() => handleToggleTaskStatus(selectedTask)}
                        style={{ padding: '3px 10px', fontSize: '10px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                      >
                        {selectedTask.status === 'active' || selectedTask.status === 'reviewing' ? (
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
                        onClick={() => handleDeleteTask(selectedTask)}
                        title="Permanently delete this task and all its messages"
                        style={{ padding: '3px 10px', fontSize: '10px', display: 'inline-flex', alignItems: 'center', gap: '4px', color: '#ef4444' }}
                      >
                        <DeleteIcon size={12} /> Delete
                      </button>
                    </div>
                  </div>

                  {selectedTask.branch && (
                    <div style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', opacity: 0.75 }}>
                      <GitIcon size={12} />
                      <code style={{ fontFamily: 'monospace' }}>{selectedTask.branch}</code>
                      {!selectedTask.worktreePath && <span style={{ opacity: 0.6 }}>(worktree removed)</span>}
                    </div>
                  )}

                  <div style={{ marginBottom: '16px' }}>
                    <h4 style={{ margin: '0 0 6px 0', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.08em', opacity: 0.6 }}>
                      Objective
                    </h4>
                    <div style={{ fontSize: '12px', background: 'rgba(255,255,255,0.02)', padding: '10px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.05)', whiteSpace: 'pre-wrap' }}>
                      {selectedTask.objective}
                    </div>
                  </div>

                  {selectedTask.status === 'blocked' && selectedTask.blockedReason && (
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
                      <p style={{ margin: '4px 0 0 0' }}>{selectedTask.blockedReason}</p>
                    </div>
                  )}

                  <div>
                    <h4 style={{ margin: '0 0 8px 0', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.08em', opacity: 0.6 }}>
                      Checklist
                    </h4>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      {(selectedTask.checklist || []).map((item) => {
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
                              onChange={() => handleToggleChecklistItem(selectedTask, item)}
                              style={{ marginTop: '2px', cursor: 'pointer' }}
                            />
                            <span>{item.text}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* TASK INTERACTIVE CHAT (RIGHT COLUMN) */}
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }}>
                  <header className="app__chat-header" style={{ padding: '12px 14px' }}>
                    <div className="app__chat-header-info">
                      <h3 className="app__chat-header-title" style={{ fontSize: '13px', margin: 0 }}>Execution Thread</h3>
                      <span className="app__chat-header-status" style={{ fontSize: '10px' }}>
                        <span
                          className={`agent-status-dot agent-status-dot--active ${isActiveLike ? 'agent-status-dot--pulsing' : ''}`}
                          style={selectedTask.status === 'reviewing' ? { background: '#a855f7' } : undefined}
                        />
                        {selectedTask.status === 'active'
                          ? 'Heartbeat loop active'
                          : selectedTask.status === 'reviewing'
                          ? `In review (round ${reviewRound}/3)`
                          : `Task status: ${selectedTask.status}`}
                      </span>
                    </div>
                  </header>

                  <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                    {taskMessages.length === 0 ? (
                      <div className="messages messages--empty">No messages in this execution yet. Agent will start on next tick.</div>
                    ) : (
                      <MessageList items={taskMessagesToChatItems(taskMessages)} sessionId={null} />
                    )}
                  </div>

                  <form className="composer" onSubmit={handleSendMessage}>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
                      <textarea
                        className="composer__input"
                        placeholder="Provide feedback or ask the agent to resume..."
                        value={composerText}
                        onChange={(e) => setComposerText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            handleSendMessage(e);
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
            ) : (
              <div className="app__empty-state">
                <p>Select a task or create a new one to view objective, checklist, and execution stream</p>
              </div>
            )}
          </>
        ) : (
          <div className="app__empty-state">
            <p>Select a project from the sidebar to view tasks and coordinate autonomous iterations</p>
          </div>
        )}
      </main>

      {/* NEW PROJECT MODAL */}
      {isNewProjectOpen && (
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
            onSubmit={handleCreateProject}
            className="confirm"
            style={{
              width: '400px',
              border: '1px solid var(--vscode-panel-border, rgba(255,255,255,0.1))',
              background: 'var(--vscode-sideBar-background)',
            }}
          >
            <div className="confirm__header">
              <span style={{ fontSize: '18px', display: 'inline-flex' }}><FolderIcon size={18} /></span>
              <span className="confirm__prompt" style={{ fontSize: '14px' }}>Register New Project</span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <label style={{ fontSize: '11px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                Project Name
                <input
                  type="text"
                  required
                  placeholder="e.g. My Codebase"
                  value={newProject.name}
                  onChange={(e) => setNewProject({ ...newProject, name: e.target.value })}
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
                Description
                <textarea
                  placeholder="What is this codebase about?"
                  value={newProject.description}
                  onChange={(e) => setNewProject({ ...newProject, description: e.target.value })}
                  style={{
                    background: 'var(--vscode-input-background, #252526)',
                    color: 'var(--vscode-input-foreground)',
                    border: '1px solid var(--vscode-input-border, #3c3c3c)',
                    borderRadius: '4px',
                    padding: '6px 8px',
                    fontSize: '12px',
                    height: '50px',
                    outline: 'none',
                    resize: 'none',
                  }}
                />
              </label>

              <div className="form-group" style={{ fontSize: '11px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label htmlFor="project-workingDir">Local Working Directory Path (Absolute)</label>
                <FolderPicker
                  id="project-workingDir"
                  placeholder="e.g. /home/user/projects/my-code"
                  value={newProject.workingDir}
                  onChange={(path) => setNewProject({ ...newProject, workingDir: path })}
                />
              </div>

              <label style={{ fontSize: '11px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                Agent to assign
                <select
                  required
                  value={newProject.agentId}
                  onChange={(e) => setNewProject({ ...newProject, agentId: e.target.value })}
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
                  <option value="" disabled>-- Select Agent --</option>
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="confirm__buttons" style={{ justifyContent: 'flex-end', marginTop: '10px' }}>
              <button type="button" className="confirm__btn" onClick={() => setIsNewProjectOpen(false)}>
                Cancel
              </button>
              <button type="submit" className="confirm__btn confirm__btn--primary">
                Add Project
              </button>
            </div>
          </form>
        </div>
      )}

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
              {pendingConfirm.type === 'delete' ? 'Delete task' : 'Discard worktree'}
            </div>
            <p className="app__confirm-message">
              {pendingConfirm.type === 'delete'
                ? `Permanently delete task #${pendingConfirm.task.id} "${pendingConfirm.task.title}"? This removes the task and all its messages from the store. This action cannot be undone.`
                : `Discard the worktree for task #${pendingConfirm.task.id}? Pending changes are committed to branch ${pendingConfirm.task.branch}; the branch is kept.`}
            </p>
            <div className="app__confirm-buttons">
              <button className="app__confirm-btn" onClick={cancelPendingAction}>Cancel</button>
              <button
                className={`app__confirm-btn ${pendingConfirm.type === 'delete' ? 'app__confirm-btn--danger' : ''}`}
                onClick={confirmPendingAction}
              >
                {pendingConfirm.type === 'delete' ? 'Delete' : 'Discard'}
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
