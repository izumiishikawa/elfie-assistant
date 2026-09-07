import { memo, useEffect, useRef, useState, useCallback } from 'react';
import { Mic, PhoneOff } from 'lucide-react';
import { motion, useMotionValue, useTransform, type MotionValue } from 'framer-motion';
import { API_BASE } from '../constants';

// Experimental "fast lane" call: full-duplex audio straight to Inworld's Speech-to-Speech
// Realtime API via api/src/inworldRealtime.js (their own STT+LLM+TTS, one WebSocket).
// No VAD/turn-splitting/tool-calling here on purpose — that all lives in CallOverlay.tsx
// for the normal pipeline. This is only meant to test raw round-trip latency.

type CallState = 'connecting' | 'listening' | 'speaking' | 'error';

interface Props {
  characterName: string;
  characterAvatar?: string | null;
  onClose: () => void;
}

const WS_BASE = API_BASE.replace(/^http/, 'ws');
const INPUT_RATE = 16000;

function downsampleTo16k(input: Float32Array, inputRate: number): Int16Array {
  if (inputRate === INPUT_RATE) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }
  const ratio  = inputRate / INPUT_RATE;
  const outLen = Math.floor(input.length / ratio);
  const out    = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcIdx = i * ratio;
    const i0 = Math.floor(srcIdx);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = srcIdx - i0;
    const sample = input[i0] * (1 - frac) + input[i1] * frac;
    const s = Math.max(-1, Math.min(1, sample));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function int16ToBase64(int16: Int16Array): string {
  const buf  = new ArrayBuffer(int16.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < int16.length; i++) view.setInt16(i * 2, int16[i], true);
  const bytes = new Uint8Array(buf);
  let binary  = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToFloat32(b64: string): Float32Array {
  const binary = atob(b64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  const out  = new Float32Array(bytes.length / 2);
  for (let i = 0; i < out.length; i++) {
    const s = view.getInt16(i * 2, true);
    out[i] = s / (s < 0 ? 0x8000 : 0x7fff);
  }
  return out;
}

const WAVE_BAR_MULT = [12, 18, 24, 30, 24, 18, 12];
const WaveBar = memo(({ mv, idx, active }: { mv: MotionValue<number>; idx: number; active: boolean }) => {
  const height = useTransform(mv, (v) => 4 + v * WAVE_BAR_MULT[idx % WAVE_BAR_MULT.length]);
  const background = useTransform(mv, (v) =>
    active ? `rgba(255,255,255,${0.55 + v * 0.45})` : 'rgba(255,255,255,0.25)',
  );
  return <motion.div className="w-[3px] rounded-full" style={{ height, background }} />;
});

export default memo(function InworldCallOverlay({ characterName, characterAvatar, onClose }: Props) {
  const [state, setState] = useState<CallState>('connecting');
  const [errorMsg, setErrorMsg] = useState('');
  const [userTranscript, setUserTranscript] = useState('');
  const [aiTranscript, setAiTranscript] = useState('');
  const assistantTranscriptRef = useRef('');

  const activityMV = useMotionValue(0);
  const isMountedRef = useRef(true);
  const wsRef = useRef<WebSocket | null>(null);

  const micCtxRef  = useRef<AudioContext | null>(null);
  const micNodeRef = useRef<ScriptProcessorNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);

  const playCtxRef   = useRef<AudioContext | null>(null);
  const nextStartRef = useRef(0);
  const isPlayingRef = useRef(false);
  const rafRef        = useRef(0);

  const schedulePcm = useCallback((base64: string, rate: number) => {
    const ctx = playCtxRef.current;
    if (!ctx) return;
    const float32 = base64ToFloat32(base64);
    if (float32.length === 0) return;
    const buffer = ctx.createBuffer(1, float32.length, rate);
    buffer.getChannelData(0).set(float32);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime, nextStartRef.current);
    src.start(startAt);
    nextStartRef.current = startAt + buffer.duration;
    isPlayingRef.current = true;
    if (isMountedRef.current) setState('speaking');
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    let closedByUs = false;

    const playCtx = new AudioContext();
    playCtxRef.current = playCtx;
    nextStartRef.current = playCtx.currentTime;

    const tick = () => {
      if (!isMountedRef.current) return;
      const ctx = playCtxRef.current;
      if (ctx && isPlayingRef.current) {
        const remaining = nextStartRef.current - ctx.currentTime;
        activityMV.set(remaining > 0 ? 0.4 + 0.6 * Math.abs(Math.sin(ctx.currentTime * 8)) : 0);
        if (remaining <= 0) {
          isPlayingRef.current = false;
          if (isMountedRef.current) setState('listening');
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    const ws = new WebSocket(`${WS_BASE}/ws/inworld-call`);
    wsRef.current = ws;

    ws.onmessage = (evt) => {
      let msg: any;
      try { msg = JSON.parse(evt.data); } catch { return; }

      if (msg.type === 'elfie.ready') {
        if (isMountedRef.current) setState('listening');
        startMic();
        return;
      }
      if (msg.type === 'error') {
        // Erro nativo do Inworld vem aninhado em error.{message,code,type} (protocolo
        // OpenAI-like) — msg.message só existe nos erros que o próprio backend sintetiza.
        const detail = msg.message ?? msg.error?.message ?? JSON.stringify(msg.error ?? msg);
        console.error('[inworld-call] error:', detail);
        if (isMountedRef.current) { setErrorMsg(detail || 'Erro desconhecido'); setState('error'); }
        return;
      }

      if (msg.type === 'conversation.item.input_audio_transcription.completed') {
        const text = (msg.transcript ?? '').trim();
        if (text && isMountedRef.current) setUserTranscript(text);
        return;
      }

      if (msg.type === 'response.output_audio_transcript.delta') {
        assistantTranscriptRef.current += msg.delta ?? '';
        return;
      }
      if (msg.type === 'response.output_audio_transcript.done') {
        const text = (msg.transcript ?? assistantTranscriptRef.current).trim();
        assistantTranscriptRef.current = '';
        if (text && isMountedRef.current) setAiTranscript(text);
        return;
      }

      // Housekeeping do protocolo (confirmado em tráfego real 2026-09-04) sem ação
      // necessária da nossa parte: ciclo de sessão, VAD do lado deles, eco item-a-item,
      // e a estrutura da resposta (já cobrimos o que interessa via audio_transcript acima).
      const KNOWN_NOOP_EVENTS = new Set([
        'session.created', 'session.updated',
        'input_audio_buffer.speech_started', 'input_audio_buffer.speech_stopped',
        'input_audio_buffer.committed', 'input_audio_buffer.turn_suggestion',
        'conversation.item.added', 'conversation.item.done',
        'conversation.item.input_audio_transcription.delta',
        'response.created', 'response.output_item.added', 'response.output_item.done',
        'response.content_part.added', 'response.content_part.done',
        'response.output_text.done', 'response.output_audio.done',
      ]);
      if (KNOWN_NOOP_EVENTS.has(msg.type)) return;

      const audioDelta = typeof msg.type === 'string' && /audio\.delta$/.test(msg.type) ? msg.delta : null;
      if (audioDelta) {
        schedulePcm(audioDelta, 24000);
        return;
      }

      // Protocolo ainda sendo confirmado contra tráfego real do Inworld — loga
      // qualquer evento que a gente não trata explicitamente pra facilitar ajuste.
      console.debug('[inworld-call] evento não tratado:', msg.type, msg);
    };

    ws.onerror = () => {
      if (isMountedRef.current) { setErrorMsg('Falha na conexão com o Inworld'); setState('error'); }
    };
    ws.onclose = () => {
      if (!closedByUs && isMountedRef.current) { setErrorMsg('Conexão encerrada'); setState('error'); }
    };

    function startMic() {
      navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      }).then((stream) => {
        if (!isMountedRef.current) { stream.getTracks().forEach((t) => t.stop()); return; }
        micStreamRef.current = stream;
        const micCtx = new AudioContext();
        micCtxRef.current = micCtx;
        const src = micCtx.createMediaStreamSource(stream);
        const processor = micCtx.createScriptProcessor(4096, 1, 1);
        micNodeRef.current = processor;
        processor.onaudioprocess = (e) => {
          if (wsRef.current?.readyState !== WebSocket.OPEN) return;
          const input = e.inputBuffer.getChannelData(0);
          const pcm16 = downsampleTo16k(input, micCtx.sampleRate);
          wsRef.current.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: int16ToBase64(pcm16),
          }));
        };
        src.connect(processor);
        // ScriptProcessorNode só dispara com um destino conectado; silencioso pro usuário.
        const silentGain = micCtx.createGain();
        silentGain.gain.value = 0;
        processor.connect(silentGain);
        silentGain.connect(micCtx.destination);
      }).catch((err) => {
        console.error('[inworld-call] getUserMedia:', err);
        if (isMountedRef.current) { setErrorMsg('Não consegui acessar o microfone'); setState('error'); }
      });
    }

    return () => {
      isMountedRef.current = false;
      closedByUs = true;
      cancelAnimationFrame(rafRef.current);
      try { ws.close(); } catch {}
      micNodeRef.current?.disconnect();
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      micCtxRef.current?.close().catch(() => {});
      playCtxRef.current?.close().catch(() => {});
    };
  }, [activityMV, schedulePcm]);

  const handleClose = () => {
    isMountedRef.current = false;
    onClose();
  };

  const isSpeaking  = state === 'speaking';
  const isListening = state === 'listening';

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
          className="absolute top-4 left-4 rounded-full px-3 py-1.5"
          style={{ background: 'rgba(255,255,255,0.06)', backdropFilter: 'blur(12px)', border: '1px solid rgba(255,255,255,0.08)' }}
        >
          <span className="text-xs" style={{ color: '#999' }}>Inworld S2S · beta</span>
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
            <motion.div
              className={`relative rounded-full overflow-hidden border-4 z-20 call-breathe ${isSpeaking ? 'call-breathe--active' : ''}`}
              style={{
                width: 192, height: 192,
                borderColor: isSpeaking ? 'var(--accent)' : 'rgba(255,255,255,0.15)',
              }}
            >
              {characterAvatar
                ? <img src={characterAvatar} className="w-full h-full object-cover" alt="" />
                : <div className="w-full h-full bg-tertiary flex items-center justify-center"><span className="text-5xl">🎙</span></div>
              }
            </motion.div>
          </div>

          <div className="flex flex-col items-center gap-3">
            <h2 className="text-white text-[24px] font-semibold tracking-tight m-0">{characterName}</h2>
            <div className="flex items-end gap-[3px] h-5">
              {[0,1,2,3,4,5,6].map((i) => (
                <WaveBar key={i} mv={activityMV} idx={i} active={isSpeaking} />
              ))}
            </div>
            <p className="text-gray-300 text-[12px] m-0">
              {state === 'connecting' && 'Conectando…'}
              {state === 'listening' && 'Ouvindo (full-duplex)'}
              {state === 'speaking' && 'Falando…'}
              {state === 'error' && (errorMsg || 'Erro')}
            </p>
            {aiTranscript && (
              <p className="text-white text-[14px] max-w-[85%] text-center m-0">{aiTranscript}</p>
            )}
            {userTranscript && (
              <p className="text-gray-300 text-[13px] max-w-[85%] text-center m-0">"{userTranscript}"</p>
            )}
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
