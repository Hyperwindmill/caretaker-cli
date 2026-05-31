import React, { useState } from 'react';

interface FolderPickerProps {
  id?: string;
  value: string;
  onChange: (path: string) => void;
  placeholder?: string;
}

export default function FolderPicker({ id, value, onChange, placeholder }: FolderPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [directories, setDirectories] = useState<{ name: string; path: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchDir = async (path?: string) => {
    setLoading(true);
    setError(null);
    try {
      const qs = path ? `?path=${encodeURIComponent(path)}` : '';
      const res = await fetch(`/api/fs/ls${qs}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setCurrentPath(data.currentPath);
      setDirectories(data.directories || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to browse directory.');
    } finally {
      setLoading(false);
    }
  };

  const handleOpen = () => {
    setIsOpen(true);
    fetchDir(value || undefined);
  };

  const handleClose = () => {
    setIsOpen(false);
  };

  const traverseUp = () => {
    if (!currentPath) return;

    // Simple robust parent calculation
    const parts = currentPath.split(/[/\\]/);
    if (parts.length > 1) {
      parts.pop();
      let parent = parts.join(currentPath.includes('\\') ? '\\' : '/');
      
      // Unix root fallback
      if (!parent && currentPath.startsWith('/')) {
        parent = '/';
      }
      
      // Windows root fallback (e.g. C:\)
      if (!parent && currentPath.includes(':\\')) {
        parent = currentPath.substring(0, 3);
      }

      if (parent) {
        fetchDir(parent);
      }
    }
  };

  const selectCurrent = () => {
    if (currentPath) {
      onChange(currentPath);
    }
    handleClose();
  };

  // Modern Premium Glassmorphic Styles
  const modalOverlayStyle: React.CSSProperties = {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(5, 5, 8, 0.7)',
    backdropFilter: 'blur(10px)',
    WebkitBackdropFilter: 'blur(10px)',
    zIndex: 9999,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '16px',
  };

  const modalContentStyle: React.CSSProperties = {
    width: '100%',
    maxWidth: '460px',
    background: 'rgba(20, 20, 26, 0.85)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: '16px',
    boxShadow: '0 20px 50px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.05)',
    display: 'flex',
    flexDirection: 'column',
    maxHeight: '75vh',
    overflow: 'hidden',
    color: '#e4e4e7',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    animation: 'slideUp 0.25s cubic-bezier(0.16, 1, 0.3, 1) forwards',
  };

  return (
    <div className="input-with-action" style={{ display: 'flex', gap: '6px', width: '100%' }}>
      <input
        id={id}
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ flex: 1, minWidth: 0 }}
      />
      <button
        type="button"
        className="btn btn--secondary btn--xs"
        onClick={handleOpen}
        style={{ flexShrink: 0, padding: '6px 12px', fontSize: '11px', height: '100%' }}
      >
        Browse...
      </button>

      {isOpen && (
        <div style={modalOverlayStyle} onClick={handleClose}>
          <div style={modalContentStyle} onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div style={{ padding: '16px', borderBottom: '1px solid rgba(255, 255, 255, 0.08)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontWeight: 600, fontSize: '14px', letterSpacing: '0.02em' }}>Select Folder</span>
              <button 
                onClick={handleClose} 
                style={{ background: 'transparent', border: 'none', color: '#a1a1aa', cursor: 'pointer', fontSize: '16px', display: 'flex', alignItems: 'center' }}
              >
                ✕
              </button>
            </div>

            {/* Navigation Path Header */}
            <div style={{ padding: '10px 16px', background: 'rgba(0, 0, 0, 0.2)', borderBottom: '1px solid rgba(255, 255, 255, 0.06)', display: 'flex', gap: '8px', alignItems: 'center' }}>
              <button
                type="button"
                onClick={traverseUp}
                className="btn btn--secondary btn--xs"
                style={{ padding: '4px 10px', fontSize: '10px' }}
              >
                ↑ Up
              </button>
              <div 
                style={{ 
                  flex: 1, 
                  fontSize: '11px', 
                  fontFamily: 'monospace', 
                  whiteSpace: 'nowrap', 
                  overflow: 'hidden', 
                  textOverflow: 'ellipsis', 
                  padding: '5px 8px', 
                  background: 'rgba(255, 255, 255, 0.04)', 
                  border: '1px solid rgba(255, 255, 255, 0.05)', 
                  borderRadius: '4px',
                  color: '#38bdf8'
                }}
              >
                {currentPath || 'Loading directory...'}
              </div>
            </div>

            {/* List Body */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>
              {loading ? (
                <div style={{ padding: '24px', textAlign: 'center', fontSize: '12px', color: '#a1a1aa' }}>
                  Loading directories...
                </div>
              ) : error ? (
                <div style={{ padding: '24px', textAlign: 'center', fontSize: '12px', color: '#ef4444' }}>
                  ⚠ {error}
                </div>
              ) : directories.length === 0 ? (
                <div style={{ padding: '24px', textAlign: 'center', fontSize: '12px', color: '#71717a', fontStyle: 'italic' }}>
                  No subfolders found
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                  {directories.map((dir) => (
                    <button
                      key={dir.path}
                      type="button"
                      onClick={() => fetchDir(dir.path)}
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        padding: '8px 12px',
                        fontSize: '12px',
                        background: 'transparent',
                        border: 'none',
                        borderRadius: '6px',
                        color: '#d4d4d8',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        transition: 'background 0.2s',
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(56, 189, 248, 0.08)'}
                      onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                    >
                      <span style={{ fontSize: '14px' }}>📁</span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {dir.name}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Actions Footer */}
            <div style={{ padding: '12px 16px', borderTop: '1px solid rgba(255, 255, 255, 0.08)', display: 'flex', justifyContent: 'flex-end', gap: '8px', background: 'rgba(0, 0, 0, 0.15)' }}>
              <button
                type="button"
                className="btn btn--secondary"
                onClick={handleClose}
                style={{ padding: '6px 14px', fontSize: '12px' }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={selectCurrent}
                disabled={!currentPath}
                style={{ padding: '6px 14px', fontSize: '12px' }}
              >
                Select Current Folder
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
