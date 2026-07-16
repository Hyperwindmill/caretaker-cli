import React, { useEffect, useState, useRef } from 'react';
import type { AgentSummary } from './bridge.js';
import { FolderIcon, DeleteIcon, WarningIcon, ToolIcon, SettingsIcon, PauseIcon, ActivateIcon, GitIcon } from './icons.js';
import FolderPicker from './FolderPicker.js';

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
  status: 'draft' | 'active' | 'paused' | 'blocked' | 'done';
  blockedReason: string | null;
  noProgressCount: number;
  maxNoProgress: number;
  lockedAt: string | null;
  branch: string | null;
  worktreePath: string | null;
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

  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const prevMessagesLengthRef = useRef(0);
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
  }, [selectedProjectId]);

  useEffect(() => {
    if (selectedTaskId !== null) {
      fetchTaskMessages(selectedTaskId);
      startThreadPolling(selectedTaskId);
      prevMessagesLengthRef.current = 0;
    } else {
      stopThreadPolling();
    }
  }, [selectedTaskId]);

  useEffect(() => {
    scrollToBottom();
  }, [taskMessages]);

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
      const res = await fetch(`/api/projects/${projectId}/tasks`);
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

  const scrollToBottom = () => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const isNewMessage = taskMessages.length > prevMessagesLengthRef.current;
    prevMessagesLengthRef.current = taskMessages.length;

    const threshold = 100;
    const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight <= threshold;

    if (isNewMessage || isNearBottom) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
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
    const newStatus = task.status === 'active' ? 'paused' : 'active';
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
    if (!window.confirm(`Discard the worktree for task #${task.id}? Pending changes are committed to branch ${task.branch}; the branch is kept.`)) {
      return;
    }
    try {
      const res = await fetch(`/api/tasks/${task.id}/discard-worktree`, { method: 'POST' });
      if (res.ok) {
        fetchTasks(task.projectId);
        if (selectedTaskId === task.id) {
          fetchTaskMessages(task.id);
        }
      }
    } catch (err) {
      console.error('Failed to discard worktree:', err);
    }
  };

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
                <h4 style={{ margin: '0 0 8px 0', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.08em', opacity: 0.6 }}>
                  Tasks
                </h4>
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
                      
                      let statusColor = '#64748b'; // draft
                      if (task.status === 'active') statusColor = '#22c55e';
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
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '4px' }}>
                            <span style={{ fontWeight: 600, fontSize: '12px', color: 'var(--vscode-foreground)' }}>
                              {task.title}
                            </span>
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
                        className="confirm__btn confirm__btn--primary"
                        onClick={() => handleToggleTaskStatus(selectedTask)}
                        style={{ padding: '3px 10px', fontSize: '10px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                      >
                        {selectedTask.status === 'active' ? (
                          <>
                            <PauseIcon size={12} /> Pause
                          </>
                        ) : (
                          <>
                            <ActivateIcon size={12} /> Activate
                          </>
                        )}
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
                        <span className={`agent-status-dot agent-status-dot--active ${selectedTask.status === 'active' ? 'agent-status-dot--pulsing' : ''}`} />
                        {selectedTask.status === 'active' ? 'Heartbeat loop active' : `Task status: ${selectedTask.status}`}
                      </span>
                    </div>
                  </header>

                  <div ref={messagesContainerRef} className="messages" style={{ flex: 1, padding: '16px', overflowY: 'auto' }}>
                    {taskMessages.length === 0 ? (
                      <div className="messages--empty">No messages in this execution yet. Agent will start on next tick.</div>
                    ) : (
                      taskMessages.map((msg) => {
                        const isUser = msg.role === 'user';
                        const isSystem = msg.messageType === 'system';
                        const isToolCall = msg.messageType === 'tool_call';
                        const isBlock = msg.messageType === 'block';

                        if (isSystem || isToolCall || isBlock) {
                          return (
                            <div
                              key={msg.id}
                              style={{
                                alignSelf: 'center',
                                padding: '6px 12px',
                                background: isBlock ? 'rgba(239, 68, 68, 0.1)' : 'rgba(255,255,255,0.02)',
                                border: `1px solid ${isBlock ? 'rgba(239, 68, 68, 0.2)' : 'rgba(255,255,255,0.05)'}`,
                                borderRadius: '6px',
                                fontSize: '11px',
                                color: isBlock ? '#ef4444' : 'var(--vscode-descriptionForeground)',
                                fontFamily: isToolCall ? 'var(--font-mono)' : 'inherit',
                                margin: '4px 0',
                                maxWidth: '90%',
                                textAlign: 'center',
                              }}
                            >
                              {isBlock ? (
                                <><WarningIcon size={12} /> Task Blocked: </>
                              ) : isToolCall ? (
                                <><ToolIcon size={12} /> Tool Call: </>
                              ) : (
                                <><SettingsIcon size={12} /> </>
                              )}
                              {msg.content}
                            </div>
                          );
                        }

                        // Try to parse thinking blocks if present in assistant messages
                        let text = msg.content;
                        let thinking = '';
                        try {
                          if (msg.content.startsWith('[')) {
                            const parsed = JSON.parse(msg.content);
                            if (Array.isArray(parsed)) {
                              const thinkBlock = parsed.find((b: any) => b.type === 'thinking');
                              const textBlock = parsed.find((b: any) => b.type === 'text');
                              if (thinkBlock) thinking = thinkBlock.content;
                              if (textBlock) text = textBlock.content;
                            }
                          }
                        } catch {
                          // Keep text as-is
                        }

                        return (
                          <div key={msg.id} className={`bubble ${isUser ? 'bubble--user' : 'bubble--assistant'}`}>
                            <div className="bubble__role">{isUser ? 'User' : 'Caretaker Agent'}</div>
                            <div className="bubble__text">
                              {thinking && (
                                <div style={{ fontSize: '11px', fontStyle: 'italic', opacity: 0.6, borderLeft: '2px solid rgba(255,255,255,0.2)', paddingLeft: '8px', marginBottom: '8px' }}>
                                  Thinking: {thinking}
                                </div>
                              )}
                              {text}
                            </div>
                          </div>
                        );
                      })
                    )}
                    <div ref={messagesEndRef} />
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
    </div>
  );
}
