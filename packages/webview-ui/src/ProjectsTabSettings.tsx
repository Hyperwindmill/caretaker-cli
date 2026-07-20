import { useState } from 'react';
import type { CaretakerConfig, AgentConfig, ProjectConfig } from 'caretaker-types';
import type { ViewToHost } from './bridge.js';
import FolderPicker from './FolderPicker.js';
import { WarningIcon, FolderIcon, EditIcon, DeleteIcon } from './icons.js';

interface ProjectsTabSettingsProps {
  config: CaretakerConfig;
  agents: AgentConfig[];
  postMessage: (msg: ViewToHost) => void;
}

export function ProjectsTabSettings({ config, agents, postMessage }: ProjectsTabSettingsProps) {
  const [editingProject, setEditingProject] = useState<ProjectConfig | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  // Form states
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [workingDir, setWorkingDir] = useState('');
  const [agentId, setAgentId] = useState('');
  const [plannerAgentId, setPlannerAgentId] = useState('');
  const [reviewerAgentId, setReviewerAgentId] = useState('');
  const [planningEnabled, setPlanningEnabled] = useState<boolean | null>(null);
  const [reviewEnabled, setReviewEnabled] = useState<boolean | null>(null);
  const [sddEnabled, setSddEnabled] = useState<boolean | null>(null);
  const [bootstrapText, setBootstrapText] = useState('');
  const [maxRunSecondsText, setMaxRunSecondsText] = useState('');
  const [dockerImage, setDockerImage] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const projects = config.projects || [];

  const startEdit = (proj: ProjectConfig) => {
    setEditingProject(proj);
    setIsCreating(false);
    setName(proj.name);
    setDescription(proj.description || '');
    setWorkingDir(proj.workingDir);
    setAgentId(proj.agentId);
    setPlannerAgentId(proj.plannerAgentId || '');
    setReviewerAgentId(proj.reviewerAgentId || '');
    setPlanningEnabled(proj.planningEnabled !== undefined ? proj.planningEnabled : null);
    setReviewEnabled(proj.reviewEnabled !== undefined ? proj.reviewEnabled : null);
    setSddEnabled(proj.sddEnabled !== undefined ? proj.sddEnabled : null);
    setBootstrapText((proj.bootstrapCommands || []).join('\n'));
    setMaxRunSecondsText(proj.maxRunSeconds ? String(proj.maxRunSeconds) : '');
    setDockerImage(proj.dockerImage || '');
    setErrorMsg(null);
  };

  const startCreate = () => {
    setIsCreating(true);
    setEditingProject(null);
    setName('');
    setDescription('');
    setWorkingDir('');
    setAgentId(agents[0]?.id || '');
    setPlannerAgentId('');
    setReviewerAgentId('');
    setPlanningEnabled(null);
    setReviewEnabled(null);
    setSddEnabled(null);
    setBootstrapText('');
    setMaxRunSecondsText('');
    setDockerImage('');
    setErrorMsg(null);
  };

  const cancelForm = () => {
    setIsCreating(false);
    setEditingProject(null);
    setErrorMsg(null);
  };

  const validateAndSave = () => {
    const trimmedName = name.trim();
    const trimmedDesc = description.trim();
    const trimmedDir = workingDir.trim();

    if (!trimmedName) {
      setErrorMsg('Project Name is required.');
      return;
    }
    if (!trimmedDir) {
      setErrorMsg('Local Working Directory Path is required.');
      return;
    }
    if (!agentId) {
      setErrorMsg('An Agent must be assigned.');
      return;
    }

    const bootstrapCommands = bootstrapText
      .split('\n')
      .map((c) => c.trim())
      .filter(Boolean);

    const parsedMaxRun = parseInt(maxRunSecondsText.trim(), 10);
    const maxRunSeconds = Number.isFinite(parsedMaxRun) && parsedMaxRun > 0 ? parsedMaxRun : null;

    const trimmedDocker = dockerImage.trim();

    const updatedProjects = [...projects];

    if (isCreating) {
      const nextId = projects.length > 0 ? Math.max(...projects.map((p) => p.id)) + 1 : 1;
      const newProj: ProjectConfig = {
        id: nextId,
        name: trimmedName,
        description: trimmedDesc,
        workingDir: trimmedDir,
        agentId,
        active: true,
        plannerAgentId: plannerAgentId || null,
        reviewerAgentId: reviewerAgentId || null,
        planningEnabled,
        reviewEnabled,
        sddEnabled,
        bootstrapCommands,
        maxRunSeconds,
        dockerImage: trimmedDocker || null,
      };
      updatedProjects.push(newProj);
    } else if (editingProject) {
      const idx = updatedProjects.findIndex((p) => p.id === editingProject.id);
      if (idx !== -1) {
        updatedProjects[idx] = {
          ...editingProject,
          name: trimmedName,
          description: trimmedDesc,
          workingDir: trimmedDir,
          agentId,
          plannerAgentId: plannerAgentId || null,
          reviewerAgentId: reviewerAgentId || null,
          planningEnabled,
          reviewEnabled,
          sddEnabled,
          bootstrapCommands,
          maxRunSeconds,
          dockerImage: trimmedDocker || null,
        };
      }
    }

    postMessage({
      type: 'saveConfig',
      config: {
        ...config,
        projects: updatedProjects,
      },
    });

    setIsCreating(false);
    setEditingProject(null);
    setErrorMsg(null);
  };

  const deleteProject = (id: number) => {
    if (!confirm('Are you sure you want to delete this project? All associated tasks will be permanently removed from disk.')) return;
    
    const updatedProjects = projects.filter((p) => p.id !== id);
    postMessage({
      type: 'saveConfig',
      config: {
        ...config,
        projects: updatedProjects,
      },
    });

    // Fire API call to let server clean up tasks from db
    fetch(`/api/projects/${id}`, { method: 'DELETE' }).catch((err) => {
      console.error('Failed to trigger database tasks cleanup on project deletion:', err);
    });
  };

  const showForm = isCreating || editingProject !== null;

  return (
    <div className="tab-pane projects-tab-settings">
      <div className="tab-pane__header">
        <h3>Registered Projects</h3>
        {!showForm && (
          <button className="btn btn--primary btn--xs" onClick={startCreate}>
            + Register Project
          </button>
        )}
      </div>

      {errorMsg && <div className="validation-error"><WarningIcon size={14} /> {errorMsg}</div>}

      {showForm ? (
        <div className="glass-form">
          <h4>{isCreating ? 'Register New Project' : `Edit Project: ${editingProject?.name}`}</h4>

          <div className="glass-form__body">
          <div className="form-group">
            <label htmlFor="project-name">Project Name</label>
            <input
              id="project-name"
              type="text"
              placeholder="e.g. My Caretaker Agent Repo"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label htmlFor="project-description">Description</label>
            <textarea
              id="project-description"
              placeholder="What tasks will this agent perform on this repository?"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              style={{ minHeight: '60px', resize: 'vertical' }}
            />
          </div>

          <div className="form-group">
            <label htmlFor="project-dir">Local Directory Path (Absolute)</label>
            <FolderPicker
              id="project-dir"
              placeholder="e.g. /home/user/workspace/caretaker-cli"
              value={workingDir}
              onChange={setWorkingDir}
            />
          </div>

          <div className="form-group">
            <label htmlFor="project-agent">Assigned Agent</label>
            <select
              id="project-agent"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
            >
              <option value="" disabled>-- Select Agent --</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label htmlFor="project-planner">Planner Agent Override (optional)</label>
            <select
              id="project-planner"
              value={plannerAgentId}
              onChange={(e) => setPlannerAgentId(e.target.value)}
            >
              <option value="">Same as assigned agent</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label htmlFor="project-reviewer">Reviewer Agent Override (optional)</label>
            <select
              id="project-reviewer"
              value={reviewerAgentId}
              onChange={(e) => setReviewerAgentId(e.target.value)}
            >
              <option value="">Same as assigned agent</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </div>

          <div className="form-group" style={{ display: 'flex', gap: '16px' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <label htmlFor="project-planning-enabled">Planning Phase</label>
              <select
                id="project-planning-enabled"
                value={planningEnabled === true ? 'on' : planningEnabled === false ? 'off' : 'default'}
                onChange={(e) => setPlanningEnabled(e.target.value === 'default' ? null : e.target.value === 'on')}
              >
                <option value="default">Default (On)</option>
                <option value="on">On</option>
                <option value="off">Off</option>
              </select>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <label htmlFor="project-review-enabled">Review at DONE</label>
              <select
                id="project-review-enabled"
                value={reviewEnabled === true ? 'on' : reviewEnabled === false ? 'off' : 'default'}
                onChange={(e) => setReviewEnabled(e.target.value === 'default' ? null : e.target.value === 'on')}
              >
                <option value="default">Default (On)</option>
                <option value="on">On</option>
                <option value="off">Off</option>
              </select>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <label htmlFor="project-sdd-enabled">SDD Mode</label>
              <select
                id="project-sdd-enabled"
                value={sddEnabled === true ? 'on' : sddEnabled === false ? 'off' : 'default'}
                onChange={(e) => setSddEnabled(e.target.value === 'default' ? null : e.target.value === 'on')}
              >
                <option value="default">Default (Off)</option>
                <option value="on">On</option>
                <option value="off">Off</option>
              </select>
            </div>
          </div>
          <p style={{ fontSize: '11px', opacity: 0.65, margin: '6px 0 0 0' }}>
            SDD mode lets the planner write markdown documents (specs, plans) during the planning
            phase. How and where they are written is up to this project's own conventions
            (AGENTS.md, agent prompt — e.g. superpowers specs). Everything else stays read-only.
          </p>

          <div className="form-group">
            <label htmlFor="project-bootstrap">Bootstrap Commands (one per line)</label>
            <textarea
              id="project-bootstrap"
              value={bootstrapText}
              onChange={(e) => setBootstrapText(e.target.value)}
              placeholder={'pnpm install\npnpm build'}
              rows={3}
              style={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }}
            />
            <p style={{ fontSize: '11px', opacity: 0.65, margin: '6px 0 0 0', lineHeight: 1.5 }}>
              Run once, in order, right after a task worktree is created (git projects only) — before
              the agent's first cycle, so it doesn't spend tokens on setup like <code>pnpm install</code>.
              The run stops and the task is blocked if any command fails.
              <br />
              <strong>One line = one command.</strong> Each line is run as a <em>separate</em> shell at
              the worktree root — this is <em>not</em> a single script. Shell state does not carry over,
              so a <code>cd</code> on one line has <em>no effect</em> on the next. Chain dependent steps on
              one line with <code>&amp;&amp;</code> instead, e.g.{' '}
              <code>cd sub && composer install</code>.
              <br />
              <strong>Heads up on how tasks work:</strong> each task runs on its own git worktree/branch,
              and every cycle commits <em>all</em> changes in that tree. So anything your bootstrap or the
              agent writes to the workspace that isn't in <code>.gitignore</code> gets committed to the
              branch — e.g. a package manager that drops a local store or cache in the repo (pnpm's
              <code>.pnpm-store/</code> under a bind-mounted Docker worktree is a common one). Make sure
              build/dependency artifacts are gitignored so they don't bloat the task branch.
            </p>
          </div>

          <div className="form-group">
            <label htmlFor="project-max-run">Max run seconds per cycle (optional)</label>
            <input
              id="project-max-run"
              type="number"
              min={1}
              value={maxRunSecondsText}
              onChange={(e) => setMaxRunSecondsText(e.target.value)}
              placeholder="Default: 120 (native) / 900 (claude-code)"
            />
            <p style={{ fontSize: '11px', opacity: 0.65, margin: '6px 0 0 0' }}>
              Wall-clock budget for a single heartbeat cycle, enforced as an abort for every provider.
              Tasks inherit this and can override it. Leave empty for the default.
            </p>
          </div>

          <div className="form-group">
            <label htmlFor="project-docker-image">Docker image (optional)</label>
            <input
              id="project-docker-image"
              type="text"
              value={dockerImage}
              onChange={(e) => setDockerImage(e.target.value)}
              placeholder="e.g. node:22  or  ./Dockerfile"
            />
            <p style={{ fontSize: '11px', opacity: 0.65, margin: '6px 0 0 0', lineHeight: 1.5 }}>
              Run this project's autonomous task agents (dev, planning &amp; review) inside this image. Empty = run on the host.
              <br />
              A value starting with <code>.</code>, <code>/</code> or <code>\</code> is treated as a path to a <strong>Dockerfile</strong> (built per-project); anything else is a pullable image ref (e.g. <code>node:22</code>).
              <br />
              The container runs as your user, so put the package manager <em>in the image</em> (e.g. <code>corepack enable pnpm</code>) — <code>npm i -g</code> fails as non-root. Docker must be installed on the scheduler host.
            </p>
          </div>
          </div>

          <div className="form-actions">
            <button className="btn btn--secondary" onClick={cancelForm}>
              Cancel
            </button>
            <button className="btn btn--primary" onClick={validateAndSave}>
              Save
            </button>
          </div>
        </div>
      ) : (
        <div className="settings-list">
          {projects.length === 0 ? (
            <p className="empty-message">No projects registered in settings. Add one to start organizing your autonomous tasks.</p>
          ) : (
            projects.map((proj) => {
              const assignedAgent = agents.find((a) => a.id === proj.agentId)?.name || 'Unknown Agent';
              return (
                <div key={proj.id} className="settings-card">
                  <div className="settings-card__body">
                    <div className="settings-card__title" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><FolderIcon size={14} /> {proj.name}</div>
                    {proj.description && <div className="settings-card__subtitle" style={{ fontSize: '11px', opacity: 0.8, marginBottom: '4px' }}>{proj.description}</div>}
                    <div className="settings-card__subtitle" style={{ fontFamily: 'var(--font-mono)', fontSize: '10px' }}>{proj.workingDir}</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '6px' }}>
                      <div className="settings-card__badge">Agent: {assignedAgent}</div>
                      {proj.dockerImage && <div className="settings-card__badge">Docker: {proj.dockerImage}</div>}
                    </div>
                  </div>
                  <div className="settings-card__actions">
                    <button
                      className="icon-btn"
                      onClick={() => startEdit(proj)}
                      title="Edit project"
                      aria-label="Edit project"
                    >
                      <EditIcon size={14} />
                    </button>
                    <button
                      className="icon-btn icon-btn--danger"
                      onClick={() => deleteProject(proj.id)}
                      title="Delete project"
                      aria-label="Delete project"
                    >
                      <DeleteIcon size={14} />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
