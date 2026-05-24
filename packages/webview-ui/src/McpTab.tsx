import { useState } from 'react';
import type { McpServersFile, McpServerConfig, McpTransport } from 'caretaker-cli/types';
import type { ViewToHost } from './bridge.js';

interface McpTabProps {
  mcpServersFile: McpServersFile;
  postMessage: (msg: ViewToHost) => void;
}

export function McpTab({ mcpServersFile, postMessage }: McpTabProps) {
  const [editingServer, setEditingServer] = useState<McpServerConfig | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  // Form states
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<McpTransport>('stdio');
  const [enabled, setEnabled] = useState(true);

  // stdio fields
  const [command, setCommand] = useState('');
  const [argsStr, setArgsStr] = useState('');
  const [envStr, setEnvStr] = useState(''); // KEY=VALUE lines

  // HTTP fields
  const [url, setUrl] = useState('');
  const [headersStr, setHeadersStr] = useState(''); // KEY=VALUE lines

  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const startCreate = () => {
    setIsCreating(true);
    setEditingServer(null);
    setName('');
    setTransport('stdio');
    setEnabled(true);
    setCommand('');
    setArgsStr('');
    setEnvStr('');
    setUrl('');
    setHeadersStr('');
    setErrorMsg(null);
  };

  const startEdit = (server: McpServerConfig) => {
    if (server.pluginId) {
      setErrorMsg('Managed servers cannot be fully edited. You can only toggle them on/off.');
      return;
    }
    setEditingServer(server);
    setIsCreating(false);
    setName(server.name);
    setTransport(server.transport);
    setEnabled(server.enabled);
    setCommand(server.command || '');
    setArgsStr(server.args ? server.args.join(' ') : '');
    
    // Env formatting
    if (server.env) {
      const lines = Object.entries(server.env).map(([k, v]) => `${k}=${v}`);
      setEnvStr(lines.join('\n'));
    } else {
      setEnvStr('');
    }

    setUrl(server.url || '');

    // Headers formatting
    if (server.headers) {
      const lines = Object.entries(server.headers).map(([k, v]) => `${k}=${v}`);
      setHeadersStr(lines.join('\n'));
    } else {
      setHeadersStr('');
    }

    setErrorMsg(null);
  };

  const cancelForm = () => {
    setIsCreating(false);
    setEditingServer(null);
    setErrorMsg(null);
  };

  const toggleServerEnabled = (server: McpServerConfig) => {
    postMessage({
      type: 'saveMcpServer',
      server: {
        ...server,
        enabled: !server.enabled,
      },
    });
  };

  const validateAndSave = () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setErrorMsg('Name is required.');
      return;
    }

    const payload: Partial<McpServerConfig> = {
      id: editingServer ? editingServer.id : `mcp-${Math.random().toString(36).substring(2, 10)}`,
      name: trimmedName,
      transport,
      enabled,
    };

    if (transport === 'stdio') {
      const trimmedCommand = command.trim();
      if (!trimmedCommand) {
        setErrorMsg('Command path/executable is required.');
        return;
      }
      payload.command = trimmedCommand;
      
      // Parse args by spaces (simple parsing)
      const parsedArgs = argsStr.trim() ? argsStr.trim().split(/\s+/) : [];
      payload.args = parsedArgs;

      // Parse env lines (KEY=VALUE)
      const parsedEnv: Record<string, string> = {};
      const lines = envStr.split('\n');
      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) continue;
        const eqIdx = trimmedLine.indexOf('=');
        if (eqIdx === -1) {
          setErrorMsg(`Invalid environment line: "${trimmedLine}". Must be KEY=VALUE.`);
          return;
        }
        const key = trimmedLine.substring(0, eqIdx).trim();
        const value = trimmedLine.substring(eqIdx + 1).trim();
        if (!key) {
          setErrorMsg(`Invalid environment line: "${trimmedLine}". Key cannot be empty.`);
          return;
        }
        parsedEnv[key] = value;
      }
      payload.env = parsedEnv;
    } else {
      // HTTP transport
      const trimmedUrl = url.trim();
      if (!trimmedUrl) {
        setErrorMsg('HTTP endpoint URL is required.');
        return;
      }
      try {
        new URL(trimmedUrl);
      } catch {
        setErrorMsg('HTTP endpoint must be a valid URL.');
        return;
      }
      payload.url = trimmedUrl;

      // Parse headers lines (KEY=VALUE)
      const parsedHeaders: Record<string, string> = {};
      const lines = headersStr.split('\n');
      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) continue;
        const eqIdx = trimmedLine.indexOf('=');
        if (eqIdx === -1) {
          setErrorMsg(`Invalid header line: "${trimmedLine}". Must be KEY=VALUE.`);
          return;
        }
        const key = trimmedLine.substring(0, eqIdx).trim();
        const value = trimmedLine.substring(eqIdx + 1).trim();
        if (!key) {
          setErrorMsg(`Invalid header line: "${trimmedLine}". Key cannot be empty.`);
          return;
        }
        parsedHeaders[key] = value;
      }
      payload.headers = parsedHeaders;
    }

    const duplicate = mcpServersFile.servers.find(s => s.name.toLowerCase() === trimmedName.toLowerCase());
    if (isCreating && duplicate) {
      setErrorMsg(`An MCP server named "${trimmedName}" already exists.`);
      return;
    }
    if (editingServer && editingServer.name !== trimmedName && duplicate) {
      setErrorMsg(`An MCP server named "${trimmedName}" already exists.`);
      return;
    }

    postMessage({
      type: 'saveMcpServer',
      server: payload,
    });

    setIsCreating(false);
    setEditingServer(null);
    setErrorMsg(null);
  };

  const deleteServer = (serverId: string) => {
    postMessage({
      type: 'deleteMcpServer',
      serverId,
    });
  };

  const showForm = isCreating || editingServer !== null;

  return (
    <div className="tab-pane mcp-tab">
      <div className="tab-pane__header">
        <h3>Model Context Protocol</h3>
        {!showForm && (
          <button className="btn btn--primary btn--xs" onClick={startCreate}>
            + Register Server
          </button>
        )}
      </div>

      {errorMsg && <div className="validation-error">⚠ {errorMsg}</div>}

      {showForm ? (
        <div className="glass-form glass-form--scrollable">
          <h4>{isCreating ? 'Register MCP Server' : `Edit MCP Server: ${editingServer?.name}`}</h4>

          <div className="form-group">
            <label htmlFor="mcp-name">Server Name</label>
            <input
              id="mcp-name"
              type="text"
              placeholder="e.g. filesystem-server"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label>Connection Protocol</label>
            <div className="radio-group">
              <label className="radio-label">
                <input
                  type="radio"
                  name="mcp-transport"
                  checked={transport === 'stdio'}
                  onChange={() => setTransport('stdio')}
                />
                <span>Stdio Command (Local)</span>
              </label>
              <label className="radio-label">
                <input
                  type="radio"
                  name="mcp-transport"
                  checked={transport === 'http'}
                  onChange={() => setTransport('http')}
                />
                <span>HTTP Stream (Remote)</span>
              </label>
            </div>
          </div>

          <div className="form-group form-group--checkbox">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              <span>Enabled</span>
            </label>
          </div>

          {transport === 'stdio' ? (
            <>
              <div className="form-group">
                <label htmlFor="mcp-command">Executable / Command</label>
                <input
                  id="mcp-command"
                  type="text"
                  placeholder="e.g. node or /usr/local/bin/mcp-server"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label htmlFor="mcp-args">Command Arguments (Space separated)</label>
                <input
                  id="mcp-args"
                  type="text"
                  placeholder="e.g. ./dist/index.js /home/workspace"
                  value={argsStr}
                  onChange={(e) => setArgsStr(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label htmlFor="mcp-env">Environment Variables (KEY=VALUE, one per line)</label>
                <textarea
                  id="mcp-env"
                  rows={3}
                  placeholder="MY_VAR=hello&#10;OTHER_VAR=world"
                  value={envStr}
                  onChange={(e) => setEnvStr(e.target.value)}
                />
              </div>
            </>
          ) : (
            <>
              <div className="form-group">
                <label htmlFor="mcp-url">HTTP Endpoint URL</label>
                <input
                  id="mcp-url"
                  type="text"
                  placeholder="e.g. http://localhost:3000/sse"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label htmlFor="mcp-headers">HTTP Headers (KEY=VALUE, one per line)</label>
                <textarea
                  id="mcp-headers"
                  rows={3}
                  placeholder="Authorization=Bearer myToken"
                  value={headersStr}
                  onChange={(e) => setHeadersStr(e.target.value)}
                />
              </div>
            </>
          )}

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
          {mcpServersFile.servers.length === 0 ? (
            <p className="empty-message">No MCP servers registered. Connect filesystem tools or semantic indexes.</p>
          ) : (
            mcpServersFile.servers.map((server) => (
              <div key={server.id} className="settings-card">
                <div className="settings-card__body">
                  <div className="settings-card__title">
                    {server.name}
                    <div className="toggle-pill-wrapper">
                      <button
                        className={`toggle-pill ${server.enabled ? 'toggle-pill--active' : ''}`}
                        onClick={() => toggleServerEnabled(server)}
                        title={server.enabled ? 'Disable server' : 'Enable server'}
                      >
                        <span className="toggle-pill__handle"></span>
                      </button>
                    </div>
                  </div>
                  <div className="settings-card__subtitle">
                    {server.transport === 'stdio' ? 'Stdio Stdio' : 'SSE Stream'}
                    {server.pluginId && (
                      <span className="settings-card__badge-managed" title="Managed by a plugin sync">
                        Managed
                      </span>
                    )}
                  </div>
                  {server.transport === 'stdio' ? (
                    <div className="settings-card__metadata text-ellipsis" title={`${server.command} ${server.args?.join(' ')}`}>
                      Cmd: {server.command} {server.args?.join(' ')}
                    </div>
                  ) : (
                    <div className="settings-card__metadata text-ellipsis" title={server.url}>
                      URL: {server.url}
                    </div>
                  )}
                  {server.lastConnectError && (
                    <div className="settings-card__error-text text-ellipsis" title={server.lastConnectError}>
                      ⚠ Connect Error: {server.lastConnectError}
                    </div>
                  )}
                </div>

                {!server.pluginId && (
                  <div className="settings-card__actions">
                    <button
                      className="icon-btn"
                      onClick={() => startEdit(server)}
                      title="Edit server"
                    >
                      ✏️
                    </button>
                    <button
                      className="icon-btn icon-btn--danger"
                      onClick={() => deleteServer(server.id)}
                      title="Delete server"
                    >
                      🗑️
                    </button>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
