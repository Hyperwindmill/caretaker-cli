import { useEffect, useRef, useState } from 'react';
import type { AgentConfig, CaretakerConfig } from 'caretaker-types';
import { buildMemoryConfig, memorySignature } from './memory_tab_utils.js';

export interface MemoryTabProps {
  config: CaretakerConfig;
  agents: AgentConfig[];
  onSave: (config: CaretakerConfig) => void;
}

/** Settings form for the memory subsystem (step 1: the session-digest sweep).
 *  Web GUI / desktop only — the sweep runs in the web server's scheduler, and
 *  the tab is gated like Services/Voice in SettingsPanel. */
export function MemoryTab({ config, agents, onSave }: MemoryTabProps) {
  const current = config.memory;
  const [enabled, setEnabled] = useState(!!current);
  const [agentId, setAgentId] = useState(current?.agentId ?? '');
  const [sweepMinutes, setSweepMinutes] = useState(
    current?.sweepMinutes === undefined ? '' : String(current.sweepMinutes)
  );
  const [minNewMessages, setMinNewMessages] = useState(
    current?.minNewMessages === undefined ? '' : String(current.minNewMessages)
  );
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  /** Signature of the payload the last Save submitted, awaiting confirmation. */
  const pendingSave = useRef<string | null>(null);

  useEffect(() => {
    if (saveState !== 'saving' || pendingSave.current === null) return;
    if (memorySignature(config.memory as Record<string, unknown> | undefined) !== pendingSave.current)
      return;
    setSaveState('saved');
  }, [config.memory, saveState]);

  // Separate effect on purpose (VoiceTab precedent): scheduling the reset in
  // the effect above would cancel the timer the moment saveState flips.
  useEffect(() => {
    if (saveState !== 'saved') return;
    const t = setTimeout(() => setSaveState('idle'), 2000);
    return () => clearTimeout(t);
  }, [saveState]);

  const selectedAgent = agents.find((a) => a.id === agentId);
  const missingAgent = enabled && !selectedAgent;

  const save = () => {
    const memory = buildMemoryConfig({ enabled, agentId, sweepMinutes, minNewMessages });
    pendingSave.current = memorySignature(memory as unknown as Record<string, unknown> | undefined);
    setSaveState('saving');
    const next: CaretakerConfig = { ...config };
    if (memory) next.memory = memory;
    else delete next.memory;
    onSave(next);
  };

  return (
    <div className="glass-form">
      <h4>Memory</h4>
      <div className="glass-form__body">
        <div className="form-group form-group--checkbox">
          <label htmlFor="memory-enabled">
            <input
              id="memory-enabled"
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Enable memory
          </label>
          <small>
            A background sweep keeps a rolling summary of every chat session. It runs only
            while the web server (or the desktop app) is up, like the rest of the scheduler.
          </small>
        </div>

        {enabled && (
          <>
            <div className="form-group">
              <label htmlFor="memory-agent">Memory agent</label>
              <select id="memory-agent" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                <option value="">— select an agent —</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {a.model}
                  </option>
                ))}
              </select>
              <small>
                The agent whose identity (system prompt, provider, model) runs the summarize
                calls — every provider works, Claude Code included. Calls are always fresh
                one-shot conversations, never the agent&apos;s own sessions. A lean dedicated
                agent (short system prompt, no plugins) keeps them cheap.
              </small>
              {missingAgent && agentId && (
                <small className="form-error">This agent no longer exists — pick another.</small>
              )}
            </div>

            <div className="form-group">
              <label htmlFor="memory-sweep-minutes">Sweep interval (minutes)</label>
              <input
                id="memory-sweep-minutes"
                type="number"
                min={1}
                placeholder="5"
                value={sweepMinutes}
                onChange={(e) => setSweepMinutes(e.target.value)}
              />
            </div>

            <div className="form-group">
              <label htmlFor="memory-min-new">Min new messages per session</label>
              <input
                id="memory-min-new"
                type="number"
                min={1}
                placeholder="4"
                value={minNewMessages}
                onChange={(e) => setMinNewMessages(e.target.value)}
              />
              <small>
                A session is re-summarized only once it accumulated at least this many new
                messages since the last pass.
              </small>
            </div>
          </>
        )}
      </div>

      <div className="form-actions">
        <button type="button" onClick={save} disabled={enabled && !agentId}>
          Save
        </button>
        <span role="status" aria-live="polite" className="form-save-state">
          {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved ✓' : ''}
        </span>
      </div>
    </div>
  );
}
