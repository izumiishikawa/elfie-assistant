import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Mic, PhoneOff } from 'lucide-react';
import { AnimatePresence, motion, useMotionValue, useTransform, type MotionValue } from 'framer-motion';
import { API_BASE } from '../constants';
import { detectEmotion } from '../utils/emotion';

type CallState = 'connecting' | 'calibrating' | 'listening' | 'recording' | 'transcribing' | 'processing' | 'speaking';
type BgState   = 'idle' | 'transcribing' | 'generating' | 'ready';

interface Props {
  chatId: string;
  characterName: string;
  characterAvatar?: string | null;
  onClose: () => void;
}


const CALIB_FRAMES    = 60;
const START_MULT      = 4.2;
const START_MIN       = 24;
const STOP_MULT       = 1.6;
const STOP_MIN        = 7;
const START_HOLD_MS   = 250;
const SILENCE_MS      = 550;

function encodeWav(pcm: Float32Array, sampleRate: number): ArrayBuffer {
  const buf  = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buf);
  const str  = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, 36 + pcm.length * 2, true);
  str(8, 'WAVE'); str(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, pcm.length * 2, true);
  let off = 44;
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return buf;
}

async function resampleAndEncode(blob: Blob): Promise<ArrayBuffer> {
  const arrayBuf = await blob.arrayBuffer();
  const actx     = new AudioContext();
  const decoded  = await actx.decodeAudioData(arrayBuf);
  const targetSR = 16000;
  const offline  = new OfflineAudioContext(1, Math.ceil(decoded.duration * targetSR), targetSR);
  const src      = offline.createBufferSource();
  src.buffer     = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  actx.close();
  return encodeWav(rendered.getChannelData(0), targetSR);
}

async function transcribeAudio(wav: ArrayBuffer, provider: string): Promise<string> {
  const form = new FormData();
  form.append('audio', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
  form.append('provider', provider);
  const r = await fetch(`${API_BASE}/api/transcribe`, { method: 'POST', body: form });
  const { transcript } = await r.json();
  return transcript?.trim() ?? '';
}

const BAR_COUNT       = 20;
const WAVEFORM_HEIGHTS = [3,5,9,14,8,18,12,6,10,20,11,5,14,9,16,7,11,17,6,4];

const WaveformBar = memo(({ mv, h, side }: { mv: MotionValue<number>; h: number; side: number }) => {
  const height = useTransform(mv, (v) => 8 + h * v * 2.5 * side);
  const opacity = useTransform(mv, (v) => 0.4 + v * 0.6);
  return (
    <motion.div
      style={{ width: 3, height, borderRadius: 2, flexShrink: 0, background: 'var(--accent)', opacity }}
    />
  );
});

const WAVE_BAR_MULT = [12, 18, 24, 30, 24, 18, 12];
const WaveBar = memo(({ mv, idx, active }: { mv: MotionValue<number>; idx: number; active: boolean }) => {
  const height = useTransform(mv, (v) => 4 + v * WAVE_BAR_MULT[idx % WAVE_BAR_MULT.length]);
  const background = useTransform(mv, (v) =>
    active ? `rgba(255,255,255,${0.55 + v * 0.45})` : 'rgba(255,255,255,0.25)',
  );
  return <motion.div className="w-[3px] rounded-full" style={{ height, background }} />;
});

const AnimatedWords = memo(({ text, className }: { text: string; className?: string }) => {
  const words = text.split(' ').filter(Boolean);
  return (
    <p className={className} style={{ margin: 0 }}>
      {words.map((w, i) => (
        <motion.span
          key={i}
          initial={{ opacity: 0, y: 6, filter: 'blur(3px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          transition={{ duration: 0.28, delay: Math.min(i * 0.025, 0.3), ease: 'easeOut' }}
          style={{ display: 'inline-block' }}
        >
          {w}
          {i < words.length - 1 ? ' ' : ''}
        </motion.span>
      ))}
    </p>
  );
});

const browserSTTSupported = typeof window !== 'undefined'
  && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);

export default memo(function CallOverlay({ chatId, characterName, characterAvatar, onClose }: Props) {
  const [state, setState]           = useState<CallState>('connecting');
  const [isUserSpeaking, setIsUserSpeaking] = useState(false);
  const [userTranscript, setUserTranscript] = useState('');
  const [aiText, setAiText]         = useState('');
  const [sttProvider, setSttProvider] = useState<'whisper' | 'elevenlabs' | 'fishaudio' | 'browser'>(
    browserSTTSupported ? 'browser' : 'elevenlabs',
  );

  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState('');

  const refreshDevices = useCallback(() => {
    navigator.mediaDevices?.enumerateDevices?.()
      .then((devices) => setAudioDevices(devices.filter((d) => d.kind === 'audioinput')))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refreshDevices);
  }, [refreshDevices]);

  const userVolumeMV = useMotionValue(0);
  const aiVolumeMV    = useMotionValue(0);

  const isMountedRef    = useRef(true);
  const isProcessingRef = useRef(false);
  const isPlayingRef    = useRef(false);
  const audioQueueRef   = useRef<string[]>([]);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const abortCtrlRef    = useRef<AbortController | null>(null);
  const aiRafRef        = useRef<number>(0);
  const sttProviderRef  = useRef(sttProvider);
  useEffect(() => { sttProviderRef.current = sttProvider; }, [sttProvider]);

  useEffect(() => {
    if (browserSTTSupported) return;
    fetch(`${API_BASE}/api/settings`)
      .then((r) => r.json())
      .then((d) => { if (d.sttProvider === 'fishaudio') setSttProvider('fishaudio'); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (sttProvider !== 'browser' || !browserSTTSupported) return;

    const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const recognition = new SR();
    recognition.lang = 'pt-BR';
    recognition.continuous = true;
    recognition.interimResults = false;

    recognition.onresult = (event: any) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result.isFinal) continue;
        const transcript = (result[0]?.transcript ?? '').trim();
        if (transcript.length < 2) continue;
        if (isPlayingRef.current || bgStateRef.current !== 'idle') {
          clearBackground();
          sendBgToAIRef.current(transcript);
        } else if (!isProcessingRef.current) {
          sendToAIRef.current(transcript);
        }
      }
    };
    recognition.onerror = (e: any) => console.error('[browser-stt]', e.error);
    recognition.onend = () => {
      if (sttProviderRef.current === 'browser' && isMountedRef.current) {
        try { recognition.start(); } catch {}
      }
    };

    try { recognition.start(); } catch {}
    if (isMountedRef.current) setState('listening');

    return () => {
      recognition.onend = null;
      try { recognition.stop(); } catch {}
    };
  }, [sttProvider, browserSTTSupported]);

  const bgStateRef  = useRef<BgState>('idle');
  const bgAbortRef  = useRef<AbortController | null>(null);
  const bgQueueRef  = useRef<string[]>([]);
  const bgTextRef   = useRef('');

  function clearBackground() {
    bgAbortRef.current?.abort();
    bgAbortRef.current = null;
    bgQueueRef.current = [];
    bgTextRef.current  = '';
    bgStateRef.current = 'idle';
  }

  const stopAiWaveform = useCallback(() => {
    cancelAnimationFrame(aiRafRef.current);
    aiVolumeMV.set(0);
  }, [aiVolumeMV]);

  const startAiWaveform = useCallback(() => {
    let t = 0;
    const tick = () => {
      if (!isPlayingRef.current) { aiVolumeMV.set(0); return; }
      aiVolumeMV.set(0.4 + 0.6 * Math.abs(Math.sin(t++ * 0.12)));
      aiRafRef.current = requestAnimationFrame(tick);
    };
    aiRafRef.current = requestAnimationFrame(tick);
  }, [aiVolumeMV]);

  const stopAudio = useCallback(() => {
    abortCtrlRef.current?.abort();
    abortCtrlRef.current = null;
    stopAiWaveform();
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current.src = '';
      currentAudioRef.current = null;
    }
    audioQueueRef.current = [];
    isPlayingRef.current  = false;
  }, [stopAiWaveform]);

  const resumeListening = useCallback(() => {
    if (!isMountedRef.current) return;
    isProcessingRef.current = false;
    setState('listening');
  }, []);

  const playNextRef = useRef<() => void>(() => {});

  const activatePending = useCallback(() => {
    audioQueueRef.current   = bgQueueRef.current;
    bgQueueRef.current      = [];
    const text              = bgTextRef.current;
    bgTextRef.current       = '';
    bgStateRef.current      = 'idle';
    isProcessingRef.current = false;
    if (isMountedRef.current) setAiText(text);
    if (audioQueueRef.current.length > 0) playNextRef.current();
    else resumeListening();
  }, [resumeListening]);

  const activatePendingRef = useRef(activatePending);
  useEffect(() => { activatePendingRef.current = activatePending; }, [activatePending]);

  const playNext = useCallback(() => {
    if (isPlayingRef.current || audioQueueRef.current.length === 0 || !isMountedRef.current) return;
    isPlayingRef.current = true;
    setState('speaking');
    const filename = audioQueueRef.current.shift()!;
    const audio    = new Audio(`${API_BASE}/files/${filename}`);
    currentAudioRef.current = audio;
    startAiWaveform();

    audio.onended = () => {
      isPlayingRef.current    = false;
      currentAudioRef.current = null;
      stopAiWaveform();

      if (bgStateRef.current === 'ready' || bgQueueRef.current.length > 0) {
        audioQueueRef.current = [];
        activatePendingRef.current();
        return;
      }
      if (bgStateRef.current === 'transcribing' || bgStateRef.current === 'generating') {
        audioQueueRef.current = [];
        setState('processing');
        return;
      }

      if (audioQueueRef.current.length > 0) playNext();
      else if (!isProcessingRef.current) resumeListening();
    };

    audio.onerror = () => { isPlayingRef.current = false; stopAiWaveform(); playNext(); };
    audio.play().catch(() => { isPlayingRef.current = false; stopAiWaveform(); playNext(); });
  }, [resumeListening, startAiWaveform, stopAiWaveform]);

  useEffect(() => { playNextRef.current = playNext; }, [playNext]);

  const enqueueAudio = useCallback((filename: string) => {
    audioQueueRef.current.push(filename);
    playNext();
  }, [playNext]);

  async function streamVoiceResponse(
    text: string,
    signal: AbortSignal,
    onChunk: (filename: string, chunkText: string) => void,
    onDone: () => void,
  ) {
    const res = await fetch(`${API_BASE}/api/chats/${chatId}/voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal,
    });
    if (!res.body) throw new Error('no body');
    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (isMountedRef.current) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        try {
          const ev = JSON.parse(line.slice(5).trim());
          if (ev.type === 'audio_chunk') onChunk(ev.filename, ev.text ?? '');
          if (ev.type === 'done') onDone();
        } catch {}
      }
    }
  }

  const sendToAIRef = useRef<(text: string) => Promise<void>>(async () => {});

  const sendToAI = useCallback(async (text: string) => {
    if (!isMountedRef.current) return;
    clearBackground();
    stopAudio();
    isProcessingRef.current = true;
    setState('processing');
    setUserTranscript(text);
    setAiText('');

    const ctrl = new AbortController();
    abortCtrlRef.current = ctrl;
    try {
      await streamVoiceResponse(
        text,
        ctrl.signal,
        (filename, chunkText) => {
          enqueueAudio(filename);
          if (isMountedRef.current) setAiText((p) => p + (p ? ' ' : '') + chunkText);
        },
        () => {
          isProcessingRef.current = false;
          if (!isPlayingRef.current && audioQueueRef.current.length === 0) resumeListening();
        },
      );
    } catch (err: any) {
      if (err?.name !== 'AbortError') console.error('[sendToAI]', err);
      isProcessingRef.current = false;
      if (isMountedRef.current && !isPlayingRef.current) resumeListening();
    }
  }, [chatId, enqueueAudio, resumeListening, stopAudio]);

  useEffect(() => { sendToAIRef.current = sendToAI; }, [sendToAI]);

  const sendBgToAI = useCallback(async (text: string) => {
    if (!isMountedRef.current) return;
    bgStateRef.current = 'generating';
    setUserTranscript(text);

    const ctrl = new AbortController();
    bgAbortRef.current = ctrl;
    try {
      await streamVoiceResponse(
        text,
        ctrl.signal,
        (filename, chunkText) => {
          bgQueueRef.current.push(filename);
          bgTextRef.current  += (bgTextRef.current ? ' ' : '') + chunkText;
          bgStateRef.current  = 'ready';
        },
        () => {
          bgStateRef.current = 'ready';
          if (!isPlayingRef.current) activatePendingRef.current();
        },
      );
    } catch (err: any) {
      if (err?.name !== 'AbortError') console.error('[sendBgToAI]', err);
      bgStateRef.current = 'idle';
      if (!isPlayingRef.current && !isProcessingRef.current) resumeListening();
    }
  }, [chatId, resumeListening]);

  const sendBgToAIRef = useRef(sendBgToAI);
  useEffect(() => { sendBgToAIRef.current = sendBgToAI; }, [sendBgToAI]);

  useEffect(() => {
    isMountedRef.current = true;
    let running = true;
    let rafId   = 0;
    let wasUserSpeaking = false;
    let stream: MediaStream | null = null;
    let audioCtx: AudioContext | null = null;
    let recorder: MediaRecorder | null = null;
    let isRecording = false;

    navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true, noiseSuppression: true, autoGainControl: true,
        ...(selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : {}),
      },
    }).then((mediaStream) => {
      if (!running) { mediaStream.getTracks().forEach(t => t.stop()); return; }
      stream = mediaStream;
      refreshDevices();

      audioCtx = new AudioContext();
      const src = audioCtx.createMediaStreamSource(stream);

      const highpass = audioCtx.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = 80;

      const lowpass = audioCtx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = 8000;

      src.connect(highpass);
      highpass.connect(lowpass);

      const analyser = audioCtx.createAnalyser();
      analyser.fftSize              = 1024;
      analyser.smoothingTimeConstant = 0.4;
      lowpass.connect(analyser);

      const dest = audioCtx.createMediaStreamDestination();
      lowpass.connect(dest);

      const dataArr = new Uint8Array(analyser.frequencyBinCount);

      const binHz  = audioCtx.sampleRate / analyser.fftSize;
      const loiBin = Math.floor(300  / binHz);
      const hiBin  = Math.floor(3400 / binHz);

      function getSpeechEnergy(): number {
        analyser.getByteFrequencyData(dataArr);
        let sum = 0;
        for (let i = loiBin; i <= hiBin; i++) sum += dataArr[i];
        return sum / (hiBin - loiBin + 1);
      }

      setState('calibrating');
      const calibSamples: number[] = [];
      let startThreshold = START_MIN;
      let stopThreshold  = STOP_MIN;

      let chunks:   Blob[]               = [];
      let recordingStart = 0;

      function startRecording() {
        if (isRecording) return;
        isRecording    = true;
        recordingStart = Date.now();
        if (sttProviderRef.current === 'browser') {
          if (!isPlayingRef.current) setState('recording');
          return;
        }
        chunks         = [];
        recorder       = new MediaRecorder(dest.stream);
        recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
        recorder.onstop = async () => {
          isRecording = false;
          const duration = Date.now() - recordingStart;
          const blob  = new Blob(chunks, { type: 'audio/webm' });
          if (duration < 700 || blob.size < 4000) {
            if (!isPlayingRef.current && !isProcessingRef.current && isMountedRef.current) setState('listening');
            return;
          }
          const wav = await resampleAndEncode(blob);

          if (isPlayingRef.current || bgStateRef.current !== 'idle') {
            clearBackground();
            bgStateRef.current = 'transcribing';
            try {
              const transcript = await transcribeAudio(wav, sttProviderRef.current);
              if (transcript.length >= 2) await sendBgToAIRef.current(transcript);
              else bgStateRef.current = 'idle';
            } catch { bgStateRef.current = 'idle'; }
          } else {
            if (isProcessingRef.current) return;
            isProcessingRef.current = true;
            if (isMountedRef.current) setState('transcribing');
            try {
              const transcript = await transcribeAudio(wav, sttProviderRef.current);
              if (transcript.length >= 2) await sendToAIRef.current(transcript);
              else { isProcessingRef.current = false; if (isMountedRef.current) setState('listening'); }
            } catch {
              isProcessingRef.current = false;
              if (isMountedRef.current) setState('listening');
            }
          }
        };
        recorder.start();
        if (!isPlayingRef.current) setState('recording');
      }

      function stopRecording() {
        if (!isRecording) return;
        if (sttProviderRef.current === 'browser' || !recorder) {
          isRecording = false;
          if (!isPlayingRef.current && !isProcessingRef.current && isMountedRef.current) setState('listening');
          return;
        }
        try { recorder.stop(); } catch {}
      }

      let vadState: 'idle' | 'hold' | 'recording' = 'idle';
      let holdStart    = 0;
      let silenceStart = 0;

      function vadLoop() {
        if (!running || !isMountedRef.current) return;
        const energy = getSpeechEnergy();

        if (calibSamples.length < CALIB_FRAMES) {
          calibSamples.push(energy);
          if (calibSamples.length === CALIB_FRAMES) {
            const ambient  = calibSamples.reduce((a, b) => a + b, 0) / CALIB_FRAMES;
            startThreshold = Math.max(START_MIN, ambient * START_MULT);
            stopThreshold  = Math.max(STOP_MIN,  ambient * STOP_MULT);
            console.log(`[VAD] ambient=${ambient.toFixed(1)} start=${startThreshold.toFixed(1)} stop=${stopThreshold.toFixed(1)}`);
            setState('listening');
          }
          rafId = requestAnimationFrame(vadLoop);
          return;
        }

        const vol = Math.min(1, Math.max(0, (energy - stopThreshold) / (startThreshold - stopThreshold + 1)));
        userVolumeMV.set(vol);
        const speakingNow = vol > 0.15;
        if (speakingNow !== wasUserSpeaking) {
          wasUserSpeaking = speakingNow;
          setIsUserSpeaking(speakingNow);
        }

        if (!isProcessingRef.current) {
          switch (vadState) {
            case 'idle':
              if (energy > startThreshold) {
                vadState  = 'hold';
                holdStart = Date.now();
              }
              break;

            case 'hold':
              if (energy < startThreshold) {
                vadState = 'idle';
              } else if (Date.now() - holdStart >= START_HOLD_MS) {
                vadState = 'recording';
                startRecording();
              }
              break;

            case 'recording':
              if (energy < stopThreshold) {
                if (silenceStart === 0) silenceStart = Date.now();
                else if (Date.now() - silenceStart >= SILENCE_MS) {
                  vadState     = 'idle';
                  silenceStart = 0;
                  stopRecording();
                }
              } else {
                silenceStart = 0;
              }
              break;
          }
        } else {
          vadState     = 'idle';
          silenceStart = 0;
        }

        rafId = requestAnimationFrame(vadLoop);
      }

      rafId = requestAnimationFrame(vadLoop);
    }).catch((err) => {
      console.error('[VAD] getUserMedia:', err);
      if (isMountedRef.current) setState('listening');
    });

    return () => {
      running = false;
      cancelAnimationFrame(rafId);
      try { if (isRecording) recorder?.stop(); } catch {}
      stream?.getTracks().forEach(t => t.stop());
      audioCtx?.close();
    };
  }, [selectedDeviceId]);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      cancelAnimationFrame(aiRafRef.current);
      clearBackground();
      stopAudio();
    };
  }, [stopAudio]);

  const handleClose = () => {
    isMountedRef.current = false;
    cancelAnimationFrame(aiRafRef.current);
    clearBackground();
    stopAudio();
    onClose();
  };

  const isSpeaking  = state === 'speaking';
  const isListening = state === 'listening' || state === 'recording';
  const isBgActive  = isSpeaking && bgStateRef.current !== 'idle';
  const emotion     = detectEmotion({ content: aiText });

  const avatarGlow = useTransform(aiVolumeMV, (v) => `0 0 ${20 + v * 34}px rgb(var(--accent-rgb) / ${0.28 + v * 0.42})`);
  const micRing     = useTransform(userVolumeMV, (v) => `0 0 0 ${6 + v * 14}px rgba(255,255,255,${0.1 + v * 0.18})`);
  const activityVolumeMV = useTransform([aiVolumeMV, userVolumeMV], (values: number[]) => Math.max(values[0], values[1]));

  return (
    <motion.div
      className="fixed inset-0 z-[300] overflow-hidden"
      style={{ background: '#0a0a0f' }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
    >
      <div className="absolute inset-0">
        {characterAvatar ? (
          <motion.img
            src={characterAvatar}
            alt=""
            className="w-full h-full object-cover"
            initial={{ scale: 1.15, opacity: 0 }}
            animate={{ scale: 1.12, opacity: 1 }}
            transition={{ duration: 0.6, ease: 'easeOut' }}
            style={{ filter: 'blur(50px) brightness(0.4) saturate(1.25)' }}
          />
        ) : (
          <div className="w-full h-full" style={{ background: '#0a0a0f' }} />
        )}
        <div
          className="absolute inset-0"
          style={{ background: 'linear-gradient(180deg, rgba(8,8,12,0.55) 0%, rgba(8,8,12,0.72) 45%, rgba(8,8,12,0.95) 100%)' }}
        />
      </div>

      <div className="relative z-10 h-full flex flex-col items-center pb-10 pt-14">

        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="absolute top-4 left-4 flex items-center gap-1.5 rounded-full pl-3 pr-2 py-1.5"
          style={{ background: 'rgba(255,255,255,0.06)', backdropFilter: 'blur(12px)', border: '1px solid rgba(255,255,255,0.08)', maxWidth: 190 }}
        >
          <Mic size={12} color="#999" style={{ flexShrink: 0 }} />
          <select
            value={selectedDeviceId}
            onChange={(e) => setSelectedDeviceId(e.target.value)}
            className="text-xs bg-transparent border-none outline-none cursor-pointer truncate"
            style={{ color: '#fff', minWidth: 0, flex: 1 }}
          >
            <option value="" style={{ background: '#17171c', color: '#fff' }}>Padrão do sistema</option>
            {audioDevices.map((d, i) => (
              <option key={d.deviceId || i} value={d.deviceId} style={{ background: '#17171c', color: '#fff' }}>
                {d.label || `Microfone ${i + 1}`}
              </option>
            ))}
          </select>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="absolute top-4 right-4 flex items-center gap-1 rounded-full p-1"
          style={{ background: 'rgba(255,255,255,0.06)', backdropFilter: 'blur(12px)', border: '1px solid rgba(255,255,255,0.08)' }}
        >
          {(['elevenlabs', 'fishaudio', 'whisper', ...(browserSTTSupported ? ['browser'] as const : [])] as const)
            .map((p) => (
            <motion.button
              key={p}
              onClick={() => setSttProvider(p)}
              whileHover={{ scale: 1.04 }}
              whileTap={{ scale: 0.95 }}
              className="text-xs px-3 py-1 rounded-full border-none cursor-pointer"
              style={{
                background:  sttProvider === p ? 'var(--accent)' : 'transparent',
                color:       sttProvider === p ? '#fff'    : '#999',
                fontWeight:  sttProvider === p ? 600       : 400,
                transition:  'background-color 0.2s, color 0.2s',
              }}
            >
              {p === 'elevenlabs' ? 'Scribe v2' : p === 'fishaudio' ? 'Fish Audio' : p === 'whisper' ? 'Whisper' : 'Navegador'}
            </motion.button>
          ))}
        </motion.div>

        <motion.div
          className="flex-1 flex flex-col items-center justify-center gap-5"
          initial={{ opacity: 0, y: 14, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ type: 'spring', stiffness: 260, damping: 26, delay: 0.05 }}
        >
          <div className="relative flex items-center justify-center">
            <div
              className="absolute rounded-full pointer-events-none call-glow"
              style={{ width: 300, height: 300, background: 'radial-gradient(circle, rgb(var(--accent-rgb) / 0.4), transparent 70%)' }}
              data-speaking={isSpeaking}
            />

            {isSpeaking && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
                <div className="flex items-center gap-[3px]" style={{ width: 230, justifyContent: 'space-between' }}>
                  {WAVEFORM_HEIGHTS.map((h, i) => {
                    const side = i < BAR_COUNT / 2 ? i / (BAR_COUNT / 2) : (BAR_COUNT - i) / (BAR_COUNT / 2);
                    return <WaveformBar key={i} mv={aiVolumeMV} h={h} side={side} />;
                  })}
                </div>
              </div>
            )}

            <motion.div
              className={`relative rounded-full overflow-hidden border-4 z-20 call-breathe ${isSpeaking ? 'call-breathe--active' : ''}`}
              style={{
                width: 192, height: 192,
                borderColor: isSpeaking ? 'var(--accent)' : 'rgba(255,255,255,0.15)',
                boxShadow: isSpeaking ? avatarGlow : '0 0 24px rgb(var(--accent-rgb) / 0.14)',
              }}
            >
              {characterAvatar
                ? <img src={characterAvatar} className="w-full h-full object-cover" alt="" />
                : <div className="w-full h-full bg-tertiary flex items-center justify-center"><span className="text-5xl">🎙</span></div>
              }
            </motion.div>

            <AnimatePresence mode="wait">
              <motion.div
                key={emotion.key}
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0, opacity: 0 }}
                transition={{ type: 'spring', stiffness: 460, damping: 24 }}
                className="absolute bottom-1 right-1 z-30 rounded-full flex items-center justify-center"
                style={{ width: 36, height: 36, background: '#17171c', border: '2px solid rgba(10,10,15,0.9)', fontSize: 18, lineHeight: 1 }}
              >
                {emotion.emoji}
              </motion.div>
            </AnimatePresence>
          </div>

          <div className="flex flex-col items-center gap-3">
            <h2 className="text-white text-[24px] font-semibold tracking-tight m-0">{characterName}</h2>
            <div className="flex items-end gap-[3px] h-5">
              {[0,1,2,3,4,5,6].map((i) => (
                <WaveBar key={i} mv={activityVolumeMV} idx={i} active={isUserSpeaking || isSpeaking} />
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-2.5 w-full max-w-lg px-6 mt-2">
            <AnimatePresence mode="popLayout">
              {aiText && (
                <motion.div
                  key={`ai-${aiText.slice(0, 24)}`}
                  layout
                  initial={{ opacity: 0, y: 10, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.97 }}
                  transition={{ type: 'spring', stiffness: 380, damping: 34 }}
                  className="self-start max-w-[85%] rounded-2xl px-4 py-3"
                  style={{ background: 'rgba(255,255,255,0.07)', backdropFilter: 'blur(16px)', border: '1px solid rgba(255,255,255,0.06)' }}
                >
                  <AnimatedWords text={aiText} className="text-white text-sm leading-relaxed" />
                </motion.div>
              )}
              {userTranscript && (
                <motion.div
                  key={`user-${userTranscript.slice(0, 24)}`}
                  layout
                  initial={{ opacity: 0, y: 10, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.97 }}
                  transition={{ type: 'spring', stiffness: 380, damping: 34 }}
                  className="self-end max-w-[85%] rounded-2xl px-4 py-3"
                  style={{ background: 'rgb(var(--accent-rgb) / 0.22)', backdropFilter: 'blur(16px)' }}
                >
                  <AnimatedWords text={userTranscript} className="text-white text-sm leading-relaxed" />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>

        <motion.div
          className="flex-shrink-0 flex items-center gap-8 rounded-full px-8 py-4"
          style={{ background: 'rgba(255,255,255,0.06)', backdropFilter: 'blur(20px)', border: '1px solid rgba(255,255,255,0.08)' }}
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15, type: 'spring', stiffness: 320, damping: 30 }}
        >
          <div className="relative flex items-center justify-center">
            {isListening && (
              <motion.div
                className="absolute rounded-full pointer-events-none"
                style={{ width: 56, height: 56, border: '1.5px solid rgba(255,255,255,0.35)' }}
                animate={{ scale: [1, 1.5], opacity: [0.5, 0] }}
                transition={{ duration: 1.6, repeat: Infinity, ease: 'easeOut' }}
              />
            )}
            <motion.div
              className="w-14 h-14 rounded-full flex items-center justify-center relative z-10"
              animate={{ backgroundColor: isListening ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.08)' }}
              style={{ boxShadow: isUserSpeaking ? micRing : '0 0 0 0px rgba(255,255,255,0)' }}
              transition={{ duration: 0.2 }}
            >
              <Mic size={22} color="#fff" />
            </motion.div>
          </div>

          <motion.button
            onClick={handleClose}
            whileHover={{ scale: 1.08 }}
            whileTap={{ scale: 0.9 }}
            className="w-14 h-14 rounded-full flex items-center justify-center border-none cursor-pointer"
            style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)' }}
          >
            <PhoneOff size={22} color="#fff" />
          </motion.button>
        </motion.div>
      </div>
    </motion.div>
  );
});
