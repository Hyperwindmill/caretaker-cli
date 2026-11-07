import { useEffect, useRef, useState } from 'react';
import type { AgentConfig, CaretakerConfig } from 'caretaker-types';
import {
  buildDesktopAssistantConfig,
  desktopAssistantSignature,
  DEFAULT_ASSISTANT_SHORTCUT,
} from './desktop_tab_utils.js';

export interface DesktopTabProps {
  config: CaretakerConfig;
  agents: AgentConfig[];
  onSave: (config: CaretakerConfig) => void;
}

/** Settings form for the desktop assistant (global shortcut → new
 *  conversation with this agent). Only the Electron desktop app acts on it;
 *  the tab is gated like Voice/Memory in SettingsPanel. */
export function DesktopTab({ config, agents, onSave }: DesktopTabProps) {
  const current = config.desktopAssistant;
  const [enabled, setEnabled] = useState(!!current);
  const [agentId, setAgentId] = useState(current?.agentId ?? '');
  const [shortcut, setShortcut] = useState(current?.shortcut ?? '');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  /** Signature of the payload the last Save submitted, awaiting confirmation. */
  const pendingSave = useRef<string | null>(null);

  useEffect(() => {
    if (saveState !== 'saving' || pendingSave.current === null) return;
    if (
      desktopAssistantSignature(config.desktopAssistant as Record<string, unknown> | undefined) !==
      pendingSave.current
    )
      return;
    setSaveState('saved');
  }, [config.desktopAssistant, saveState]);

  // Separate effect on purpose (MemoryTab precedent).
  useEffect(() => {
    if (saveState !== 'saved') return;
    const t = setTimeout(() => setSaveState('idle'), 2000);
    return () => clearTimeout(t);
  }, [saveState]);

  const missingAgent = enabled && !!agentId && !agents.some((a) => a.id === agentId);

  const save = () => {
    const cfg = buildDesktopAssistantConfig({ enabled, agentId, shortcut });
    pendingSave.current = desktopAssistantSignature(cfg as unknown as Record<string, unknown> | undefined);
    setSaveState('saving');
    const next: CaretakerConfig = { ...config };
    if (cfg) next.desktopAssistant = cfg;
    else delete next.desktopAssistant;
    onSave(next);
  };

  return (
    <div className="glass-form">
      <h4>Desktop assistant</h4>
      <div className="glass-form__body">
        <div className="form-group form-group--checkbox">
          <label htmlFor="desktop-assistant-enabled">
            <input
              id="desktop-assistant-enabled"
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Enable desktop assistant
          </label>
          <small>
            Desktop app only. Press the shortcut from any app to open caretaker on a new
            conversation with this agent — in voice conversation mode when voice is configured.
          </small>
        </div>

        {enabled && (
          <>
            <div className="form-group">
              <label htmlFor="desktop-assistant-agent">Assistant agent</label>
              <select
                id="desktop-assistant-agent"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
              >
                <option value="">— select an agent —</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {a.model}
                  </option>
                ))}
              </select>
              <small>
                To let it move the conversation into one of your projects, enable the
                set_workspace tool on the agent. That needs a native agent: Claude Code and ACP
                agents have no caretaker tools.
              </small>
              {missingAgent && (
                <small className="form-error">This agent no longer exists — pick another.</small>
              )}
            </div>

            <div className="form-group">
              <label htmlFor="desktop-assistant-shortcut">Global shortcut</label>
              <input
                id="desktop-assistant-shortcut"
                type="text"
                placeholder={DEFAULT_ASSISTANT_SHORTCUT}
                value={shortcut}
                onChange={(e) => setShortcut(e.target.value)}
              />
              <small>
                An Electron accelerator. On Linux under Wayland the global shortcut does not fire:
                bind this command to a keyboard shortcut in your desktop environment instead —{' '}
                <code>caretaker-desktop --assistant</code>
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
