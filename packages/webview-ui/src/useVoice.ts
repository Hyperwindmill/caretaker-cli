import { useCallback, useEffect, useRef, useState } from 'react';
import type { VoiceClientConfig } from './bridge.js';
import {
  nextPhase,
  toBcp47,
  stripMarkdownForSpeech,
  takeFinalizedBubbles,
  END_OF_TURN_MS,
  IDLE_WINDOW_MS,
  POST_PLAYBACK_MS,
  type SpokenItem,
  type VoiceMode,
  type VoicePhase,
} from './voice_utils.js';

export type UseVoiceResult = {
  available: boolean;
  phase: VoicePhase;
  mode: VoiceMode;
  setMode: (mode: VoiceMode) => void;
  toggle: () => void;
  error: string | null;
};

/** The Web Speech API is NOT usable here: in Electron both SpeechRecognition
 *  constructors exist but recognition fails with error:network and synthesis
 *  reports zero voices. Capability detection therefore keys off capture, which
 *  the probe confirmed works. See the design spec. */
function canCapture(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof MediaRecorder !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

type VadInstance = { start: () => void; pause: () => void; destroy: () => void };

/** Load the VAD library from the served assets. Not bundled — see esbuild.config.mjs. */
let vadScriptPromise: Promise<any> | null = null;
function loadVadLibrary(): Promise<any> {
  if (vadScriptPromise) return vadScriptPromise;
  vadScriptPromise = new Promise((resolve, reject) => {
    const existing = (window as any).vad;
    if (existing) return resolve(existing);
    const script = document.createElement('script');
    script.src = '/vad/bundle.min.js';
    script.onload = () => {
      const lib = (window as any).vad;
      lib ? resolve(lib) : reject(new Error('VAD library loaded but window.vad is missing'));
    };
    script.onerror = () => reject(new Error('Could not load /vad/bundle.min.js'));
    document.head.appendChild(script);
  });
  return vadScriptPromise;
}

export function useVoice(opts: {
  voice: VoiceClientConfig | null;
  chatStatus: 'idle' | 'streaming' | 'error';
  pendingConfirmCount: number;
  items: readonly SpokenItem[];
  onTranscript: (text: string, mode: VoiceMode) => void;
}): UseVoiceResult {
  const { voice, chatStatus, pendingConfirmCount, items, onTranscript } = opts;

  const available = !!voice && voice.enabled && voice.configured && canCapture();
  const canSpeak = !!voice?.canSpeak;

  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [mode, setMode] = useState<VoiceMode>('dictate');
  const [error, setError] = useState<string | null>(null);

  // Latest-value refs so async callbacks never read stale state.
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const chatStatusRef = useRef(chatStatus);
  chatStatusRef.current = chatStatus;

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const vadRef = useRef<VadInstance | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heardSpeechRef = useRef(false);
  /** Secondary guard only. The primary one is `turnComplete` — see the awaiting
   *  branch of `nextPhase`. This covers a surface that sends without ever
   *  flipping status to 'streaming'. */
  const sawStreamingRef = useRef(false);
  /** Next item index not yet considered for speech. Set at send time, so the
   *  previous turn's reply is unreachable by construction — the off-by-one
   *  invariant 3 was protecting, expressed once instead of via a baseline. */
  const cursorRef = useRef(0);
  /** Assistant texts finalized but not yet played. Drained by `speakReply`,
   *  one item per synthesis+playback cycle, chaining inside `audio.onended`. */
  const queueRef = useRef<string[]>([]);

  const apply = useCallback((event: Parameters<typeof nextPhase>[1]) => {
    setPhase((current) => nextPhase(current, event));
  }, []);

  const clearIdleTimer = () => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = null;
  };

  const teardownCapture = useCallback(() => {
    clearIdleTimer();
    try {
      vadRef.current?.destroy();
    } catch {
      /* the library throws if already destroyed; nothing to do */
    }
    vadRef.current = null;
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.onstop = null;
      recorderRef.current.stop();
    }
    recorderRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    chunksRef.current = [];
    heardSpeechRef.current = false;
  }, []);

  const stopPlayback = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
      audioRef.current = null;
    }
  }, []);

  const fail = useCallback(
    (message: string) => {
      teardownCapture();
      stopPlayback();
      setError(message);
      apply({ kind: 'failed', mode: modeRef.current });
    },
    [apply, teardownCapture, stopPlayback],
  );

  /** Stop the recorder and hand the audio to the transcription proxy. */
  const finishRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    recorder.onstop = async () => {
      const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
      teardownCapture();
      try {
        const form = new FormData();
        form.set('file', blob, 'turn.webm');
        const res = await fetch('/api/voice/transcribe', { method: 'POST', body: form });
        if (!res.ok) return fail(await res.text());
        const { text } = (await res.json()) as { text?: string };
        const trimmed = (text ?? '').trim();
        const currentMode = modeRef.current;
        if (trimmed) {
          if (currentMode === 'conversation') {
            sawStreamingRef.current = false;
            // Set the cursor to the current list length. The user item that
            // lands at this index is skipped by the selector (non-assistant),
            // and any prior reply is unreachable — no baseline needed.
            cursorRef.current = itemsRef.current.length;
            queueRef.current = [];
          }
          onTranscriptRef.current(trimmed, currentMode);
        }
        apply({ kind: 'transcribed', mode: currentMode, empty: trimmed.length === 0 });
      } catch (err) {
        fail(`Transcription failed: ${err}`);
      }
    };
    recorder.stop();
  }, [apply, fail, teardownCapture]);

  /** Open the mic. In conversation mode the VAD decides when the turn is over; in
   *  dictation the user does, because dictating involves pauses. */
  const startRecording = useCallback(async () => {
    setError(null);
    chunksRef.current = [];
    heardSpeechRef.current = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorderRef.current = recorder;
      recorder.start();

      if (modeRef.current === 'conversation') {
        const lib = await loadVadLibrary();
        const vad = await lib.MicVAD.new({
          stream,
          baseAssetPath: '/vad/',
          onnxWASMBasePath: '/vad/',
          // `redemptionMs`, not `redemptionFrames`: this version derives the frame
          // count itself (redemptionMs / msPerFrame), so passing frames was ignored
          // and the end-of-turn silently used the library default of 1400 ms.
          redemptionMs: END_OF_TURN_MS,
          onSpeechStart: () => {
            heardSpeechRef.current = true;
            clearIdleTimer();
          },
          onSpeechEnd: () => {
            if (phaseRef.current !== 'recording') return;
            apply({ kind: 'speechEnded', mode: 'conversation' });
            finishRecording();
          },
        });
        vadRef.current = vad;
        vad.start();

        // Nothing said at all within the idle window ends the loop.
        idleTimerRef.current = setTimeout(() => {
          if (heardSpeechRef.current) return;
          teardownCapture();
          apply({ kind: 'idleWindowElapsed', mode: 'conversation' });
        }, IDLE_WINDOW_MS);
      }
    } catch (err) {
      fail(`Microphone unavailable: ${err}`);
    }
  }, [apply, fail, finishRecording, teardownCapture]);

  /** Synthesize and play the next queued bubble, then chain to the next one
   *  or reopen the mic. The chaining happens inside `audio.onended` rather than
   *  via a `speaking → speaking` phase transition, because the phase effect only
   *  fires on a phase *change* — re-entering `speaking` would not re-trigger it.
   *  An empty queue on entry emits `playbackEnded` immediately, as the old code
   *  did when there was nothing new to say. */
  const speakReply = useCallback(async () => {
    const text = queueRef.current.shift();
    if (!text) {
      // Nothing to say — the turn produced no new text, or the queue already
      // drained. Report playback ended so the phase machine can advance.
      apply({
        kind: 'playbackEnded',
        mode: 'conversation',
        turnComplete: chatStatusRef.current === 'idle',
      });
      return;
    }
    try {
      const res = await fetch('/api/voice/speak', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: stripMarkdownForSpeech(text) }),
      });
      if (!res.ok) return fail(await res.text());
      const url = URL.createObjectURL(await res.blob());
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => {
        URL.revokeObjectURL(url);
        audioRef.current = null;
        // Chain the next queued bubble or, when the queue is empty, emit
        // playbackEnded. INVARIANT 1: the mic reopens only here, and only when
        // the harness turn is also over — a queue drained mid-turn returns to
        // awaiting, not recording.
        setTimeout(() => {
          if (queueRef.current.length > 0) {
            void speakReply();
          } else {
            apply({
              kind: 'playbackEnded',
              mode: 'conversation',
              turnComplete: chatStatusRef.current === 'idle',
            });
          }
        }, POST_PLAYBACK_MS);
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        fail('Could not play the synthesized reply.');
      };
      await audio.play();
    } catch (err) {
      fail(`Synthesis failed: ${err}`);
    }
  }, [apply, fail]);

  // Observe streaming so `awaiting` can distinguish "my turn started" from
  // "the previous turn was already finished".
  useEffect(() => {
    if (chatStatus === 'streaming') sawStreamingRef.current = true;
  }, [chatStatus]);

  // Bubbles become speakable as they close, mid-turn. Declared BEFORE the
  // turnFinished effect so a bubble closed by `done` is queued in the same
  // commit that reports the turn over — effect ordering must not be able to
  // lose a bubble.
  useEffect(() => {
    if (modeRef.current !== 'conversation') return;
    if (phaseRef.current === 'idle') return;
    const { texts, cursor } = takeFinalizedBubbles(items, cursorRef.current);
    cursorRef.current = cursor;
    if (texts.length === 0) return;
    queueRef.current.push(...texts);
    apply({ kind: 'speechQueued', mode: 'conversation', canSpeak });
  }, [items, canSpeak, apply]);

  // Drive the awaiting → speaking/recording transition off the existing chat
  // reducer rather than adding protocol events.
  useEffect(() => {
    if (phase !== 'awaiting') return;
    if (chatStatus === 'error') {
      apply({ kind: 'failed', mode: 'conversation' });
      return;
    }
    apply({
      kind: 'turnFinished',
      mode: 'conversation',
      canSpeak,
      // The reducer sets status 'streaming' in the same batch as the send, so
      // reaching 'awaiting' says nothing about the turn being over. Without this
      // the loop advances mid-stream and speaks the previous reply.
      turnComplete: chatStatus === 'idle',
      sawStreaming: sawStreamingRef.current,
      confirmPending: pendingConfirmCount > 0,
      // Text queued but not yet played. Non-zero drives awaiting → speaking
      // regardless of turnComplete, so a bubble closed in the same commit as
      // the turn ending is never lost to effect ordering.
      pendingSpeech: queueRef.current.length,
    });
  }, [phase, chatStatus, pendingConfirmCount, canSpeak, apply]);

  // Perform the side effect each phase implies. One effect, so the phase is the
  // single source of truth for what the hook is doing.
  const prevPhase = useRef<VoicePhase>('idle');
  useEffect(() => {
    const from = prevPhase.current;
    prevPhase.current = phase;
    if (from === phase) return;
    if (phase === 'recording') void startRecording();
    if (phase === 'speaking') void speakReply();
    if (phase === 'idle') {
      teardownCapture();
      stopPlayback();
      queueRef.current = [];
    }
  }, [phase, startRecording, speakReply, teardownCapture, stopPlayback]);

  // Release the mic and stop audio if the component unmounts mid-loop.
  useEffect(
    () => () => {
      teardownCapture();
      stopPlayback();
    },
    [teardownCapture, stopPlayback],
  );

  const toggle = useCallback(() => {
    if (!available) return;
    const current = phaseRef.current;
    if (current === 'idle') {
      apply({ kind: 'micClick', mode: modeRef.current });
      return;
    }
    if (current === 'recording' && modeRef.current === 'dictate') {
      apply({ kind: 'micClick', mode: 'dictate' });
      finishRecording();
      return;
    }
    apply({ kind: 'userStop', mode: modeRef.current });
  }, [available, apply, finishRecording]);

  const changeMode = useCallback(
    (next: VoiceMode) => {
      apply({ kind: 'userStop', mode: modeRef.current });
      setMode(next);
    },
    [apply],
  );

  return { available, phase, mode, setMode: changeMode, toggle, error };
}
