// Call em tempo real — porta do elfie-web/src/screens/CallOverlay.tsx para React Native.
// A UI/estado/fluxo (VAD → grava → transcreve → streama resposta em áudio → toca) é o
// mesmo, mas as APIs de baixo nível mudam pra equivalentes RN/Expo:
//   Web Audio AnalyserNode + MediaRecorder  → expo-audio useAudioStream (PCM int16 real-time)
//   HTMLAudioElement                        → expo-audio AudioPlayer (uma instância, .replace())
//   navigator.mediaDevices/SpeechRecognition → não existem no RN — sem seletor de mic e sem
//                                              STT no dispositivo; sempre usa STT do servidor.
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { Image } from "expo-image";
import {
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioStream,
} from "expo-audio";
import { File as FSFile, Paths } from "expo-file-system";
import { LinearGradient } from "expo-linear-gradient";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Dimensions, Modal, Text, View } from "react-native";
import ReAnimated, {
  FadeIn,
  FadeInDown,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import AnimatedPressable from "../components/AnimatedPressable";
import { API_BASE } from "../constants";

const SCREEN_W = Dimensions.get("window").width;

type CallState =
  | "connecting"
  | "calibrating"
  | "listening"
  | "recording"
  | "transcribing"
  | "processing"
  | "speaking";

interface Props {
  chatId: string;
  characterName: string;
  characterAvatar?: string | null;
  onClose: () => void;
}

// ── VAD / áudio ────────────────────────────────────────────────────────────────
const SAMPLE_RATE = 16000;
const CALIB_MS = 2000;
const START_MULT = 2.4;
const STOP_MULT = 1.3;
const START_MIN = 130; // RMS mínima (escala int16 0..32767) pra abrir mesmo em silêncio total
const STOP_MIN = 60;
const START_HOLD_MS = 150;
const SILENCE_MS = 700;
const PRE_ROLL_CHUNKS = 8; // buffers mantidos antes de detectar fala, pra não cortar a sílaba inicial

function rms(samples: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (samples.length || 1));
}

function concatInt16(chunks: Int16Array[]): Int16Array {
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function encodeWav(samples: Int16Array, sampleRate: number): Uint8Array {
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  new Int16Array(buffer, 44).set(samples);
  return new Uint8Array(buffer);
}

async function saveWavToFile(bytes: Uint8Array): Promise<FSFile> {
  const file = new FSFile(Paths.cache, `call_${Date.now()}.wav`);
  file.create();
  file.write(bytes);
  return file;
}

// expo's fetch (SDK 56+) only accepts real Blob/File FormData parts — passing a plain
// { uri, name, type } object (the old RN idiom) throws "Unsupported FormDataPart
// implementation" before the request is even sent, so an FSFile (which implements Blob)
// must be appended directly instead.
async function transcribeAudio(file: FSFile, provider: string): Promise<string> {
  const form = new FormData();
  form.append("audio", file as any);
  form.append("provider", provider);
  const r = await fetch(`${API_BASE}/api/transcribe`, { method: "POST", body: form as any });
  const data = await r.json();
  return data.transcript?.trim() ?? "";
}

async function streamVoiceResponse(
  chatId: string,
  text: string,
  signal: AbortSignal,
  onChunk: (filename: string, chunkText: string) => void,
  onDone: () => void,
) {
  const res = await fetch(`${API_BASE}/api/chats/${chatId}/voice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal,
  });
  const reader = res.body?.getReader();
  if (!reader) throw new Error("no body");
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      try {
        const ev = JSON.parse(line.slice(5).trim());
        if (ev.type === "audio_chunk") onChunk(ev.filename, ev.text ?? "");
        if (ev.type === "done") onDone();
      } catch {}
    }
  }
}

// ── Waveform bars — lêem o shared value direto, sem re-render por frame ────────
const WAVEFORM_HEIGHTS = [3, 5, 9, 14, 8, 18, 12, 6, 10, 20, 11, 5, 14, 9, 16, 7, 11, 17, 6, 4];
const BAR_COUNT = WAVEFORM_HEIGHTS.length;

const WaveformBar = memo(({ volume, h, side }: { volume: any; h: number; side: number }) => {
  const style = useAnimatedStyle(() => ({
    height: 8 + h * volume.value * 2.5 * side,
    opacity: 0.4 + volume.value * 0.6,
  }));
  return (
    <ReAnimated.View
      style={[{ width: 3, borderRadius: 2, flexShrink: 0, backgroundColor: "#996dff" }, style]}
    />
  );
});

const WAVE_BAR_MULT = [12, 18, 24, 30, 24, 18, 12];
const WaveBar = memo(({ volume, idx, active }: { volume: any; idx: number; active: boolean }) => {
  const style = useAnimatedStyle(() => ({
    // altura cresce a partir do centro (linha do meio do container) — a barra sobe e
    // desce ao mesmo tempo, como um medidor de áudio de verdade, em vez de só subir
    height: 4 + volume.value * WAVE_BAR_MULT[idx % WAVE_BAR_MULT.length],
    backgroundColor: active
      ? `rgba(255,255,255,${0.55 + volume.value * 0.45})`
      : "rgba(255,255,255,0.25)",
  }));
  return <ReAnimated.View style={[{ width: 3, borderRadius: 2 }, style]} />;
});

// ── Palavras em cascata — texto sem balão, cada palavra entra com seu próprio delay,
// tipo legenda de jogo. Chaveado por índice: como o texto só cresce (chunks vão sendo
// concatenados), palavras já montadas mantêm a key e não replay a animação — só as
// novas, no fim, entram animadas.
const AnimatedWords = memo(({ text, textStyle }: { text: string; textStyle?: any }) => {
  const words = text.split(" ").filter(Boolean);
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center" }}>
      {words.map((w, i) => (
        <ReAnimated.Text
          key={i}
          entering={FadeInDown.delay(Math.min(i * 30, 340))
            .springify()
            .damping(14)
            .mass(0.5)
            .stiffness(120)}
          style={[textStyle, { marginRight: 5, marginBottom: 2 }]}
        >
          {w}
        </ReAnimated.Text>
      ))}
    </View>
  );
});

export default memo(function CallOverlay({ chatId, characterName, characterAvatar, onClose }: Props) {
  const [state, setState] = useState<CallState>("connecting");
  const [isUserSpeaking, setIsUserSpeaking] = useState(false);
  const [userTranscript, setUserTranscript] = useState("");
  const [aiText, setAiText] = useState("");

  // Sem Web Audio no RN — os níveis vivem em shared values do reanimated (equivalente
  // aos MotionValue do framer-motion), fora do estado React, pra não gerar re-render a cada buffer.
  const userVolume = useSharedValue(0);
  const aiVolume = useSharedValue(0);

  const isMountedRef = useRef(true);
  const isProcessingRef = useRef(false);
  const isPlayingRef = useRef(false);
  const audioQueueRef = useRef<string[]>([]);
  const abortCtrlRef = useRef<AbortController | null>(null);
  const aiRafRef = useRef<number>(0);

  const player = useAudioPlayer(null);

  // ── Waveform falsa da IA (mesma abordagem do web: oscila enquanto toca) ────
  const stopAiWaveform = useCallback(() => {
    cancelAnimationFrame(aiRafRef.current);
    aiVolume.value = 0;
  }, [aiVolume]);

  const startAiWaveform = useCallback(() => {
    let t = 0;
    const tick = () => {
      if (!isPlayingRef.current) {
        aiVolume.value = 0;
        return;
      }
      aiVolume.value = 0.4 + 0.6 * Math.abs(Math.sin(t++ * 0.12));
      aiRafRef.current = requestAnimationFrame(tick);
    };
    aiRafRef.current = requestAnimationFrame(tick);
  }, [aiVolume]);

  const stopAudio = useCallback(() => {
    abortCtrlRef.current?.abort();
    abortCtrlRef.current = null;
    stopAiWaveform();
    try {
      player.pause();
    } catch {}
    audioQueueRef.current = [];
    isPlayingRef.current = false;
  }, [player, stopAiWaveform]);

  const resumeListening = useCallback(() => {
    if (!isMountedRef.current) return;
    isProcessingRef.current = false;
    setState("listening");
  }, []);

  const playNextRef = useRef<() => void>(() => {});

  const playNext = useCallback(() => {
    if (isPlayingRef.current || audioQueueRef.current.length === 0 || !isMountedRef.current) return;
    isPlayingRef.current = true;
    setState("speaking");
    const filename = audioQueueRef.current.shift()!;
    startAiWaveform();
    try {
      player.replace({ uri: `${API_BASE}/files/${filename}` });
      player.play();
    } catch {
      isPlayingRef.current = false;
      stopAiWaveform();
      playNext();
    }
  }, [player, startAiWaveform, stopAiWaveform]);

  useEffect(() => {
    playNextRef.current = playNext;
  }, [playNext]);

  const onTrackFinished = useCallback(() => {
    isPlayingRef.current = false;
    stopAiWaveform();

    if (audioQueueRef.current.length > 0) playNext();
    else if (!isProcessingRef.current) resumeListening();
  }, [playNext, resumeListening, stopAiWaveform]);

  useEffect(() => {
    // @ts-ignore — AudioPlayer é um SharedObject com addListener/remove (mesma API do expo-audio)
    const sub = player.addListener("playbackStatusUpdate", (status: any) => {
      if (status?.didJustFinish) onTrackFinished();
    });
    return () => sub?.remove?.();
  }, [player, onTrackFinished]);

  const enqueueAudio = useCallback(
    (filename: string) => {
      audioQueueRef.current.push(filename);
      playNext();
    },
    [playNext],
  );

  // ── Resposta em primeiro plano ──────────────────────────────────────────────
  const sendToAIRef = useRef<(text: string) => Promise<void>>(async () => {});

  const sendToAI = useCallback(
    async (text: string) => {
      if (!isMountedRef.current) return;
      stopAudio();
      isProcessingRef.current = true;
      setState("processing");
      setUserTranscript(text);
      setAiText("");

      const ctrl = new AbortController();
      abortCtrlRef.current = ctrl;
      try {
        await streamVoiceResponse(
          chatId,
          text,
          ctrl.signal,
          (filename, chunkText) => {
            enqueueAudio(filename);
            if (isMountedRef.current) setAiText((p) => p + (p ? " " : "") + chunkText);
          },
          () => {
            isProcessingRef.current = false;
            if (!isPlayingRef.current && audioQueueRef.current.length === 0) resumeListening();
          },
        );
      } catch (err: any) {
        if (err?.name !== "AbortError") console.error("[sendToAI]", err);
        isProcessingRef.current = false;
        if (isMountedRef.current && !isPlayingRef.current) resumeListening();
      }
    },
    [chatId, enqueueAudio, resumeListening, stopAudio],
  );

  useEffect(() => {
    sendToAIRef.current = sendToAI;
  }, [sendToAI]);

  // ── Captura de mic + VAD (PCM real-time via expo-audio) ────────────────────
  const stream = useAudioStream({ sampleRate: SAMPLE_RATE, channels: 1, encoding: "int16" });

  useEffect(() => {
    isMountedRef.current = true;
    let cancelled = false;

    let vadState: "idle" | "hold" | "recording" = "idle";
    let holdStart = 0;
    let silenceStart = 0;
    let calibStart = 0;
    let calibSum = 0;
    let calibCount = 0;
    let startThreshold = START_MIN;
    let stopThreshold = STOP_MIN;
    let calibrated = false;

    const preRoll: Int16Array[] = [];
    let takenChunks: Int16Array[] = [];
    let wasUserSpeaking = false;

    async function finalizeUtterance() {
      const chunks = takenChunks;
      takenChunks = [];
      const samples = concatInt16(chunks);
      const durationMs = (samples.length / SAMPLE_RATE) * 1000;
      // muito curto — provável ruído, não vale a pena mandar pro servidor
      if (durationMs < 400) {
        if (!isPlayingRef.current && !isProcessingRef.current && isMountedRef.current) {
          setState("listening");
        }
        return;
      }

      if (isPlayingRef.current || isProcessingRef.current) return;

      const wav = encodeWav(samples, SAMPLE_RATE);
      const file = await saveWavToFile(wav);

      isProcessingRef.current = true;
      if (isMountedRef.current) setState("transcribing");
      try {
        const transcript = await transcribeAudio(file, "fishaudio");
        if (transcript.length >= 2) await sendToAIRef.current(transcript);
        else {
          isProcessingRef.current = false;
          if (isMountedRef.current) setState("listening");
        }
      } catch (err) {
        console.error("[call] transcribe failed:", err);
        isProcessingRef.current = false;
        if (isMountedRef.current) setState("listening");
      }
    }

    async function start() {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted || cancelled) {
        if (isMountedRef.current) setState("listening");
        return;
      }
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
        interruptionMode: "doNotMix",
        shouldPlayInBackground: false,
      });

      if (cancelled) return;
      if (isMountedRef.current) setState("calibrating");
      calibStart = Date.now();

      // @ts-ignore — onBuffer é passado via evento nativo (não via options do hook nesta versão)
      const sub = stream.stream.addListener("audioStreamBuffer", (buf: { data: ArrayBuffer }) => {
        if (cancelled || !isMountedRef.current) return;
        const samples = new Int16Array(buf.data);
        const energy = rms(samples);

        if (!calibrated) {
          calibSum += energy;
          calibCount += 1;
          if (Date.now() - calibStart >= CALIB_MS) {
            const ambient = calibCount > 0 ? calibSum / calibCount : 0;
            startThreshold = Math.max(START_MIN, ambient * START_MULT);
            stopThreshold = Math.max(STOP_MIN, ambient * STOP_MULT);
            calibrated = true;
            if (isMountedRef.current) setState("listening");
          }
          return;
        }

        const vol = Math.min(
          1,
          Math.max(0, (energy - stopThreshold) / (startThreshold - stopThreshold + 1)),
        );
        userVolume.value = vol;
        const speakingNow = vol > 0.15;
        if (speakingNow !== wasUserSpeaking) {
          wasUserSpeaking = speakingNow;
          setIsUserSpeaking(speakingNow);
        }

        // não escuta nem acumula pre-roll enquanto ela fala ou processa — sem AEC no RN
        // (diferente da web, que pede echoCancellation no getUserMedia), o mic capta o
        // próprio áudio dela saindo do alto-falante. Se o pre-roll continuasse gravando
        // esses frames, eles ficavam guardados e viravam o início da "gravação do usuário"
        // assim que o VAD reabria — ou seja, a IA acabava transcrevendo a própria fala.
        if (isProcessingRef.current || isPlayingRef.current) {
          vadState = "idle";
          silenceStart = 0;
          takenChunks = [];
          preRoll.length = 0;
          return;
        }

        // pre-roll — mantém as últimas amostras mesmo em idle, pra não perder a
        // primeira sílaba quando a fala é detectada
        preRoll.push(samples);
        if (preRoll.length > PRE_ROLL_CHUNKS) preRoll.shift();

        switch (vadState) {
          case "idle":
            if (energy > startThreshold) {
              vadState = "hold";
              holdStart = Date.now();
            }
            break;
          case "hold":
            // usa stopThreshold (limiar baixo) em vez de startThreshold aqui — fala real
            // oscila em energia entre sílabas, então checar contra o limiar alto fazia o
            // hold voltar pra idle a cada micro-queda e nunca acumular os START_HOLD_MS,
            // mesmo com a pessoa falando (o indicador de volume reage porque é atualizado
            // fora dessa state machine, então parecia "detectar" sem nunca gravar).
            if (energy < stopThreshold) {
              vadState = "idle";
            } else if (Date.now() - holdStart >= START_HOLD_MS) {
              vadState = "recording";
              takenChunks = [...preRoll];
              if (isMountedRef.current) setState("recording");
            }
            break;
          case "recording":
            takenChunks.push(samples);
            if (energy < stopThreshold) {
              if (silenceStart === 0) silenceStart = Date.now();
              else if (Date.now() - silenceStart >= SILENCE_MS) {
                vadState = "idle";
                silenceStart = 0;
                finalizeUtterance();
              }
            } else {
              silenceStart = 0;
            }
            break;
        }
      });

      await stream.stream.start();
      // the outer effect cleanup below always calls stream.stream.stop() and this
      // closure on unmount/cancel — no need to duplicate that handling here.
      return () => {
        sub.remove();
      };
    }

    let cleanupListener: (() => void) | undefined;
    start().then((cleanup) => {
      cleanupListener = cleanup;
    });

    return () => {
      cancelled = true;
      cleanupListener?.();
      try {
        stream.stream.stop();
      } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      cancelAnimationFrame(aiRafRef.current);
      stopAudio();
    };
  }, [stopAudio]);

  const handleClose = useCallback(() => {
    isMountedRef.current = false;
    cancelAnimationFrame(aiRafRef.current);
    stopAudio();
    onClose();
  }, [onClose, stopAudio]);

  const isSpeaking = state === "speaking";
  const isListening = state === "listening" || state === "recording";
  const portraitStyle = useAnimatedStyle(() => ({
    borderColor: isSpeaking ? "#996dff" : "rgba(255,255,255,0.15)",
    shadowOpacity: isSpeaking ? 0.28 + aiVolume.value * 0.42 : 0.14,
    shadowRadius: isSpeaking ? 20 + aiVolume.value * 34 : 24,
  }));

  const activityVolume = useDerivedMax(aiVolume, userVolume);

  return (
    <Modal visible transparent statusBarTranslucent animationType="none" onRequestClose={handleClose}>
      <ReAnimated.View
        entering={FadeIn.duration(300)}
        exiting={FadeOut.duration(220)}
        style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "#0a0a0f", zIndex: 300 }}
      >
      <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}>
        {characterAvatar ? (
          <Image
            source={{ uri: characterAvatar }}
            style={{ width: "100%", height: "100%" }}
            contentFit="cover"
            blurRadius={60}
          />
        ) : (
          <View style={{ width: "100%", height: "100%", backgroundColor: "#0a0a0f" }} />
        )}
        <LinearGradient
          colors={["rgba(8,8,12,0.55)", "rgba(8,8,12,0.72)", "rgba(8,8,12,0.97)"]}
          locations={[0, 0.45, 1]}
          style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
        />
      </View>

      <View style={{ flex: 1, alignItems: "center", paddingBottom: 40, paddingTop: 60 }}>
        {/* Hero */}
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 20, width: "100%" }}>
          <View style={{ alignItems: "center", justifyContent: "center" }}>
            {isSpeaking && (
              <View
                style={{
                  position: "absolute",
                  width: 230,
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  zIndex: 10,
                }}
              >
                {WAVEFORM_HEIGHTS.map((h, i) => {
                  const side = i < BAR_COUNT / 2 ? i / (BAR_COUNT / 2) : (BAR_COUNT - i) / (BAR_COUNT / 2);
                  return <WaveformBar key={i} volume={aiVolume} h={h} side={side} />;
                })}
              </View>
            )}

            <ReAnimated.View
              style={[
                {
                  width: 192,
                  height: 192,
                  borderRadius: 96,
                  overflow: "hidden",
                  borderWidth: 4,
                  zIndex: 20,
                  shadowColor: "#996dff",
                  shadowOffset: { width: 0, height: 0 },
                  elevation: 12,
                },
                portraitStyle,
              ]}
            >
              {characterAvatar ? (
                <Image source={{ uri: characterAvatar }} style={{ width: "100%", height: "100%" }} contentFit="cover" />
              ) : (
                <View style={{ flex: 1, backgroundColor: "#1e1e2e", alignItems: "center", justifyContent: "center" }}>
                  <Text style={{ fontSize: 48 }}>🎙</Text>
                </View>
              )}
            </ReAnimated.View>
          </View>

          <View style={{ alignItems: "center", gap: 10, marginTop: 14 }}>
            <Text style={{ color: "#fff", fontSize: 24, fontWeight: "700" }}>{characterName}</Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 3, height: 34 }}>
              {[0, 1, 2, 3, 4, 5, 6].map((i) => (
                <WaveBar key={i} volume={activityVolume} idx={i} active={isUserSpeaking || isSpeaking} />
              ))}
            </View>
          </View>

          <View style={{ gap: 14, width: "100%", maxWidth: 480, paddingHorizontal: 24, marginTop: 8, alignItems: "center" }}>
            {!!aiText && (
              <AnimatedWords
                text={aiText}
                textStyle={{ color: "#fff", fontSize: 17, lineHeight: 24, fontWeight: "600", textAlign: "center" }}
              />
            )}
            {!!userTranscript && (
              <AnimatedWords
                text={userTranscript}
                textStyle={{ color: "rgba(255,255,255,0.75)", fontSize: 14, lineHeight: 20, textAlign: "center" }}
              />
            )}
          </View>
        </View>

        {/* Dock de controle */}
        <ReAnimated.View
          entering={FadeInDown.delay(150).duration(260)}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 32,
            borderRadius: 999,
            paddingHorizontal: 32,
            paddingVertical: 16,
            overflow: "hidden",
          }}
        >
          <BlurView
            intensity={30}
            tint="dark"
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              borderRadius: 999,
            }}
          />
          <View style={{ alignItems: "center", justifyContent: "center" }}>
            <View
              style={{
                width: 56,
                height: 56,
                borderRadius: 28,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: isListening ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.08)",
              }}
            >
              <MaterialCommunityIcons name="microphone" size={22} color="#fff" />
            </View>
          </View>

          <AnimatedPressable
            onPress={handleClose}
            scaleTo={0.9}
            style={{
              width: 56,
              height: 56,
              borderRadius: 28,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: "rgba(0,0,0,0.3)",
              borderWidth: 1,
              borderColor: "rgba(255,255,255,0.1)",
            }}
          >
            <MaterialCommunityIcons name="phone-hangup" size={22} color="#fff" />
          </AnimatedPressable>
        </ReAnimated.View>
      </View>
      </ReAnimated.View>
    </Modal>
  );
});

// Equivalente ao useTransform([aiVolume, userVolume], Math.max) do framer-motion —
// reanimated não tem combinação direta de shared values num componente memo simples
// sem worklets extras, então mantemos um shared value derivado atualizado por um
// pequeno efeito ligado aos dois.
function useDerivedMax(a: any, b: any) {
  const result = useSharedValue(0);
  useEffect(() => {
    const id = setInterval(() => {
      result.value = Math.max(a.value, b.value);
    }, 33);
    return () => clearInterval(id);
  }, [a, b, result]);
  return result;
}
