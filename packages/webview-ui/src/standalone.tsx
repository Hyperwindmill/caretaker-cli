import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

function StandaloneApp() {
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/ws`);

    socket.onopen = () => {
      if (!active) return;
      setConnected(true);
      setError(null);
    };

    socket.onmessage = (event) => {
      if (!active) return;
      try {
        const data = JSON.parse(event.data);
        // Dispatch to window so App.tsx's event listener picks it up
        window.dispatchEvent(new MessageEvent('message', { data }));
      } catch (err) {
        console.error('Failed to parse WebSocket message:', err);
      }
    };

    socket.onerror = (err) => {
      if (!active) return;
      console.error('WebSocket error:', err);
      setError('Connection error. Is the Caretaker server running?');
    };

    socket.onclose = () => {
      if (!active) return;
      setConnected(false);
      // Reconnect after 3 seconds
      setTimeout(() => {
        if (active) {
          setWs(null);
        }
      }, 3000);
    };

    setWs(socket);

    return () => {
      active = false;
      socket.close();
    };
  }, [ws === null]);

  const postMessage = (msg: any) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    } else {
      console.warn('WebSocket is not open. Message dropped:', msg);
    }
  };

  if (error) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        fontFamily: 'system-ui, sans-serif',
        background: '#1e1e1e',
        color: '#f1f1f1',
        padding: '20px',
        textAlign: 'center'
      }}>
        <h3 style={{ color: '#ff6b6b' }}>Caretaker Connection Failed</h3>
        <p>{error}</p>
        <button 
          onClick={() => setWs(null)}
          style={{
            background: '#007acc',
            color: 'white',
            border: 'none',
            padding: '8px 16px',
            borderRadius: '4px',
            cursor: 'pointer',
            marginTop: '10px'
          }}
        >
          Retry Connect
        </button>
      </div>
    );
  }

  if (!connected) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        fontFamily: 'system-ui, sans-serif',
        background: '#1e1e1e',
        color: '#f1f1f1'
      }}>
        <div style={{
          border: '4px solid rgba(255,255,255,0.1)',
          width: '36px',
          height: '36px',
          borderRadius: '50%',
          borderLeftColor: '#007acc',
          animation: 'spin 1s linear infinite',
          marginBottom: '16px'
        }} />
        <span>Connecting to Caretaker server...</span>
        <style>{`
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
        `}</style>
      </div>
    );
  }

  return <App postMessage={postMessage} />;
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');
createRoot(rootEl).render(
  <StrictMode>
    <StandaloneApp />
  </StrictMode>
);
