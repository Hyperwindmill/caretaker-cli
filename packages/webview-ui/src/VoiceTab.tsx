import { useState } from 'react';
import type { CaretakerConfig, VoiceConfig } from 'caretaker-types';

export interface VoiceTabProps {
  config: CaretakerConfig;
  onSave: (config: CaretakerConfig) => void;
}

const EMPTY: VoiceConfig = { enabled: false, endpoint: '', sttModel: '' };

export function VoiceTab({ config, onSave }: VoiceTabProps) {
  const current = config.voice ?? EMPTY;
  const [enabled, setEnabled] = useState(current.enabled);
  const [endpoint, setEndpoint] = useState(current.endpoint);
  const [apiKey, setApiKey] = useState(current.apiKey ?? '');
  const [sttModel, setSttModel] = useState(current.sttModel);
  const [ttsModel, setTtsModel] = useState(current.ttsModel ?? '');
  const [ttsVoice, setTtsVoice] = useState(current.ttsVoice ?? '');
  const [lang, setLang] = useState(current.lang ?? '');

  const save = () => {
    const voice: VoiceConfig = { enabled, endpoint: endpoint.trim(), sttModel: sttModel.trim() };
    if (apiKey.trim()) voice.apiKey = apiKey.trim();
    if (ttsModel.trim()) voice.ttsModel = ttsModel.trim();
    if (ttsVoice.trim()) voice.ttsVoice = ttsVoice.trim();
    if (lang.trim()) voice.lang = lang.trim();
    onSave({ ...config, voice });
  };

  return (
    <div className="glass-form">
      <h4>Voice</h4>
      <div className="glass-form__body">
        <div className="form-group form-group--checkbox">
          <label htmlFor="voice-enabled">
            <input
              id="voice-enabled"
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Enable voice mode
          </label>
        </div>

        <div className="form-group">
          <label htmlFor="voice-endpoint">Speech Endpoint</label>
          <input
            id="voice-endpoint"
            type="text"
            placeholder="http://127.0.0.1:8000/v1"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
          />
          <small>
            OpenAI-compatible speech endpoint — e.g. a local Speaches container.
            Transcription posts to <code>/audio/transcriptions</code>, synthesis to{' '}
            <code>/audio/speech</code>. Leave the synthesis fields empty for dictation
            only. Voice is unavailable in the VSCode sidebar.
          </small>
        </div>

        <div className="form-group">
          <label htmlFor="voice-key">API Key (optional)</label>
          <input
            id="voice-key"
            type="password"
            placeholder="Leave empty for a local server with no auth"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <small>Stored encrypted. Never sent to the browser — requests are proxied.</small>
        </div>

        <div className="form-group">
          <label htmlFor="voice-stt">Transcription Model</label>
          <input
            id="voice-stt"
            type="text"
            placeholder="e.g. Systran/faster-whisper-small"
            value={sttModel}
            onChange={(e) => setSttModel(e.target.value)}
          />
        </div>

        <div className="form-group">
          <label htmlFor="voice-tts">Synthesis Model (optional)</label>
          <input
            id="voice-tts"
            type="text"
            placeholder="e.g. speaches-ai/Kokoro-82M-v1.0-ONNX"
            value={ttsModel}
            onChange={(e) => setTtsModel(e.target.value)}
          />
          <small>Required for conversation mode. Without it, only dictation is offered.</small>
        </div>

        <div className="form-group">
          <label htmlFor="voice-voice">Voice (optional)</label>
          <input
            id="voice-voice"
            type="text"
            placeholder="e.g. af_heart"
            value={ttsVoice}
            onChange={(e) => setTtsVoice(e.target.value)}
          />
        </div>

        <div className="form-group">
          <label htmlFor="voice-lang">Language (optional)</label>
          <input
            id="voice-lang"
            type="text"
            placeholder="e.g. it-IT — defaults to the browser language"
            value={lang}
            onChange={(e) => setLang(e.target.value)}
          />
        </div>
      </div>

      <div className="form-actions">
        <button type="button" onClick={save}>
          Save
        </button>
      </div>
    </div>
  );
}
