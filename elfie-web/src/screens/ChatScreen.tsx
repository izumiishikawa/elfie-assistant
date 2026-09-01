import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  ArrowLeft,
  Brain,
  Camera,
  Clock,
  Download,
  ExternalLink,
  Eye,
  Globe,
  Image,
  Mic,
  Pause,
  Pen,
  Pencil,
  Phone,
  Play,
  Plus,
  Reply,
  Rocket,
  Search,
  Send,
  Settings,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  User,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { AnimatePresence, motion, type Variants } from "framer-motion";
import { forwardRef, memo, useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import ShimmerPlaceholder from "../components/SkeletonLoading";
import SkillNeuronGraph from "../components/SkillNeuronGraph";
import SettingsScreen from "./SettingsScreen";
import CallOverlay from "./CallOverlay";
import { useSettingsStore } from "../stores/mainStore";
import { useSkillsStore } from "../stores/skillsStore";
import { useIntegrationsStore } from "../stores/integrationsStore";
import { API_BASE } from "../constants";
import { useDebugStore } from "../stores/debugStore";
import { detectEmotion } from "../utils/emotion";


function splitMessage(text: string): string[] {
  const paras = text
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
  return paras.length ? paras : [text];
}

const extrasMenuVariants: Variants = {
  hidden: { opacity: 0, scale: 0.85, y: 6 },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: { type: "spring", stiffness: 520, damping: 30, staggerChildren: 0.045, delayChildren: 0.02 },
  },
  exit: { opacity: 0, scale: 0.92, y: 4, transition: { duration: 0.12, ease: "easeIn" } },
};
const extrasItemVariants: Variants = {
  hidden: { opacity: 0, x: -8 },
  visible: { opacity: 1, x: 0, transition: { type: "spring", stiffness: 480, damping: 28 } },
};

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2300}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F1E0}-\u{1F1FF}]+\u{FE0F}?/gu;
const EM_DASH_RE = /\s*—\s*/g;
const sanitizeAiText = (s: string) =>
  s
    .replace(EMOJI_RE, "")
    .replace(EM_DASH_RE, ", ")
    .replace(/,[ \t]*,/g, ",")
    .replace(/[ \t]+([.,!?;:])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

const sanitizeAiTextChunk = (s: string) =>
  s
    .replace(EMOJI_RE, "")
    .replace(EM_DASH_RE, ", ")
    .replace(/,[ \t]*,/g, ",")
    .replace(/[ \t]+([.,!?;:])/g, "$1")
    .replace(/[ \t]{2,}/g, " ");


interface ChatMeta {
  _id: string;
  title: string;
  createdAt: string;
}

interface SearchSource {
  title: string;
  url: string;
  snippet: string;
}

interface ProductCard {
  title: string;
  url: string;
  snippet: string;
  image?: string;
}

interface Gif {
  url: string | null;
  mp4: string | null;
}

interface VoiceNote {
  filename: string;
}

interface Message {
  id: string;
  content: string;
  sender: "user" | "ai";
  createdAt: string;
  isNew?: boolean;
  isEdited?: boolean;
  isRoutine?: boolean;
  savedMemory?: boolean;
  toolsUsed?: string[];
  toolErrors?: { tool: string; message: string }[];
  imageFilenames?: string[];
  gifs?: Gif[];
  voiceNotes?: VoiceNote[];
  searchSources?: SearchSource[];
  productCards?: ProductCard[];
  replyTo?: { id: string; content: string; sender: "user" | "ai" };
  neuroType?: "confirm" | "started" | "update" | "question" | "done";
  neuroTaskId?: string;
  neuroText?: string;
  neuroConfirmed?: boolean;
  neuroError?: boolean;
  fromNeuro?: boolean;
  isCancelled?: boolean;
  pendingConfirmation?: {
    confirmationId: string;
    skillName: string;
    skillDescription?: string;
    args: Record<string, unknown>;
    decision?: "approved" | "rejected" | "timeout";
    feedback?: string;
  };
}

interface SelectedImage {
  uri: string;
  base64: string;
  mimeType: string;
}

const formatTimestamp = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

let msgCounter = 0;
const newId = () => `msg-${++msgCounter}-${Date.now()}`;

const toFrontendMessages = (raw: Record<string, unknown>[]): Message[] =>
  raw.flatMap((m) => {
    const base: Message = {
      id: m._id as string,
      content: m.content as string,
      sender: m.role === "assistant" ? "ai" : "user",
      createdAt: m.createdAt as string,
      isRoutine: Boolean(m.triggeredByRoutine),
      savedMemory: (m.savedMemory as boolean) ?? false,
      imageFilenames:
        Array.isArray(m.imageFilenames) && (m.imageFilenames as string[]).length > 0
          ? (m.imageFilenames as string[]) : undefined,
      searchSources:
        Array.isArray(m.searchSources) && (m.searchSources as SearchSource[]).length > 0
          ? (m.searchSources as SearchSource[]) : undefined,
      productCards:
        Array.isArray(m.productCards) && (m.productCards as ProductCard[]).length > 0
          ? (m.productCards as ProductCard[]) : undefined,
      gifs:
        Array.isArray(m.gifs) && (m.gifs as Gif[]).length > 0
          ? (m.gifs as Gif[]) : undefined,
      voiceNotes:
        Array.isArray(m.voiceNotes) && (m.voiceNotes as VoiceNote[]).length > 0
          ? (m.voiceNotes as VoiceNote[]) : undefined,
    };

    const isAiText = base.sender === 'ai' && base.content?.trim() &&
      !base.imageFilenames && !base.gifs && !base.voiceNotes;
    if (!isAiText) return [base];

    const cleanContent = sanitizeAiText(base.content.trim());
    const chunks = splitMessage(cleanContent);
    if (chunks.length <= 1) return [{ ...base, content: cleanContent }];

    return chunks.map((chunk, i) => ({
      ...base,
      id: i === 0 ? base.id : `${base.id}-s${i}`,
      content: chunk,
      savedMemory: i === 0 ? base.savedMemory : false,
      searchSources: i === 0 ? base.searchSources : undefined,
      productCards: i === 0 ? base.productCards : undefined,
    }));
  });

const getDomain = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

function encodeWav(pcm: Float32Array, sampleRate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buf);
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  view.setUint32(4, 36 + pcm.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, "data");
  view.setUint32(40, pcm.length * 2, true);
  let off = 44;
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return buf;
}


const Dot = memo(({ delay }: { delay: number }) => (
  <div
    className="typing-dot rounded-full bg-white mx-[3px]"
    style={{ width: 5, height: 5, animationDelay: `${delay}ms` }}
  />
));

function formatToolLabel(tool: string): string {
  return tool
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

const TOOL_ACTIVITY_LABELS: Record<string, string> = {
  web_search: "searching the web...",
  web_fetch: "reading the page...",
  see_image: "looking at the image...",
  browse_screenshot: "taking a screenshot of the site...",
  search_products: "searching for products...",
  save_memory: "saving memory...",
  execute_command: "running command...",
  generate_pixel_art: "generating pixel art...",
  generate_pixel_art_pro: "generating pixel art (pro)...",
  convert_to_pixel_art: "converting...",
  convert_to_pixel_art_pro: "converting...",
  remove_background: "removing background...",
  generate_with_style: "generating with style...",
  generate_image: "generating image...",
  edit_image: "editing image...",
  send_gif: "looking for a gif...",
  send_voice_message: "recording audio...",
  send_image: "finding image...",
  create_skill: "creating new tool...",
  edit_skill: "editing tool...",
  delete_skill: "deleting tool...",
};

const TOOL_ERROR_LABELS: Record<string, string> = {
  web_search: "search failed",
  web_fetch: "page wouldn't open",
  see_image: "couldn't see it",
  browse_screenshot: "screenshot failed",
  search_products: "search failed",
  execute_command: "command failed",
  generate_pixel_art: "generation failed",
  generate_pixel_art_pro: "generation failed",
  convert_to_pixel_art: "conversion failed",
  convert_to_pixel_art_pro: "conversion failed",
  remove_background: "removal failed",
  generate_with_style: "generation failed",
  generate_image: "generation failed",
  edit_image: "edit failed",
  create_skill: "failed to create tool",
  edit_skill: "failed to edit tool",
  delete_skill: "failed to delete tool",
  erro: "something went wrong",
};

const TOOL_ACTIVITY_ICONS: Record<string, LucideIcon> = {
  web_search: Search,
  web_fetch: Globe,
  see_image: Eye,
  browse_screenshot: Camera,
  search_products: Search,
  save_memory: Brain,
  execute_command: Terminal,
  generate_pixel_art: Image,
  generate_pixel_art_pro: Image,
  convert_to_pixel_art: Image,
  convert_to_pixel_art_pro: Image,
  remove_background: Image,
  generate_with_style: Image,
  generate_image: Image,
  edit_image: Image,
  send_gif: Sparkles,
  send_voice_message: Mic,
  send_image: Image,
  create_skill: Wrench,
  edit_skill: Pencil,
  delete_skill: Trash2,
};

interface ToolActivity {
  key: string;
  kind: "tool" | "error";
  toolName?: string;
  label: string;
  detail?: string;
}

const ToolActivityPill = memo(
  forwardRef<HTMLDivElement, { activity: ToolActivity }>(({ activity }, ref) => {
  const isError = activity.kind === "error";
  const Icon = isError ? AlertTriangle : TOOL_ACTIVITY_ICONS[activity.toolName ?? ""] ?? Sparkles;
  const dotColor = isError ? "#f87171" : "var(--accent)";

  return (
    <div
      ref={ref}
      className="flex items-center gap-2 px-3 py-1.5 rounded-full"
      style={{ background: "#1e1e2e", width: "fit-content", maxWidth: "100%" }}
    >
      <span
        className="neuro-pulse flex-shrink-0"
        style={{ width: 6, height: 6, borderRadius: "50%", background: dotColor, display: "inline-block" }}
      />
      <Icon size={12} color={isError ? "#f87171" : "#9ca3af"} strokeWidth={2.4} className="flex-shrink-0" />
      <span style={{ fontSize: 11, color: isError ? "#f87171" : "#9ca3af", fontWeight: 700, flexShrink: 0 }}>
        {activity.label}
      </span>
      <div className="min-w-0 flex flex-col leading-tight">
        {activity.detail && (
          <span
            className="font-mono truncate"
            style={{ fontSize: 10, color: isError ? "#f3a5a5" : "#6b7280" }}
            title={activity.detail}
          >
            {activity.detail}
          </span>
        )}
      </div>
    </div>
  );
  }),
);

const TypingIndicator = memo(
  () => (
    <div className="flex flex-row items-center py-2 gap-2 mb-1 message-in">
      <AiAvatar />
      <div className="bg-foreground rounded-2xl rounded-bl-sm px-4 py-3 flex flex-row items-center gap-2">
        <Dot delay={0} />
        <Dot delay={150} />
        <Dot delay={300} />
      </div>
    </div>
  ),
);


const SearchSources = memo(({ sources }: { sources: SearchSource[] }) => {
  const [showModal, setShowModal] = useState(false);

  return (
    <div className="flex-shrink-0">
      <motion.button
        onClick={() => setShowModal(true)}
        whileHover={{ scale: 1.04 }}
        whileTap={{ scale: 0.96 }}
        className="flex flex-row items-center gap-1 bg-transparent border-none cursor-pointer p-0"
      >
        <Globe size={9} color="#d1d5db" />
        <span className="text-gray-300 font-black" style={{ fontSize: 10 }}>
          {sources.length} {sources.length === 1 ? "source" : "sources"}
        </span>
      </motion.button>

      <AnimatePresence>
        {showModal && (
          <motion.div
            className="fixed inset-0 z-[150] flex items-center justify-center"
            style={{ backgroundColor: "rgba(0,0,0,0.65)", backdropFilter: "blur(6px)" }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            onClick={(e) => { if (e.target === e.currentTarget) setShowModal(false); }}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.92, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 8 }}
              transition={{ type: "spring", stiffness: 400, damping: 32 }}
              className="w-[92%] max-w-md max-h-[70vh] flex flex-col rounded-2xl bg-foreground p-5"
            >
              <div className="flex items-center justify-between mb-4 flex-shrink-0">
                <div className="flex items-center gap-2">
                  <Globe size={14} color="var(--accent)" />
                  <span className="text-[15px] text-white font-semibold">
                    {sources.length} {sources.length === 1 ? "source" : "sources"}
                  </span>
                </div>
                <motion.button
                  onClick={() => setShowModal(false)}
                  whileHover={{ scale: 1.1 }}
                  whileTap={{ scale: 0.9 }}
                  className="p-1 bg-transparent border-none cursor-pointer"
                >
                  <X size={16} color="#8a8a94" />
                </motion.button>
              </div>
              <div className="flex-1 overflow-y-auto flex flex-col gap-2">
                {sources.map((s, i) => (
                  <motion.button
                    key={i}
                    onClick={() => window.open(s.url, "_blank")}
                    whileHover={{ scale: 1.01 }}
                    whileTap={{ scale: 0.98 }}
                    className="w-full bg-background rounded-xl px-3.5 py-3 text-left border-none cursor-pointer"
                  >
                    <span className="text-white font-semibold text-[13px] block leading-5">
                      {s.title}
                    </span>
                    <div className="flex items-center gap-1 mt-1">
                      <ExternalLink size={10} color="#9ca3af" className="flex-shrink-0" />
                      <span className="text-gray-400 text-[11px] truncate">{getDomain(s.url)}</span>
                    </div>
                    {!!s.snippet && (
                      <span
                        className="text-gray-300 text-[11px] mt-1 block leading-4"
                        style={{
                          display: "-webkit-box",
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: "vertical",
                          overflow: "hidden",
                        }}
                      >
                        {s.snippet}
                      </span>
                    )}
                  </motion.button>
                ))}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});


const ProductCards = memo(({ cards }: { cards: ProductCard[] }) => (
  <div
    className="flex overflow-x-auto mt-2 pb-0.5 gap-2"
    style={{ scrollbarWidth: "none" }}
  >
    {cards.map((card, i) => (
      <button
        key={i}
        onClick={() => window.open(card.url, "_blank")}
        className="flex-shrink-0 overflow-hidden border-none cursor-pointer p-0 text-left"
        style={{
          width: 148,
          height: 190,
          borderRadius: 14,
          backgroundColor: "#1e1e2e",
        }}
      >
        <img
          src={card.image ?? ""}
          alt={card.title}
          style={{
            width: 148,
            height: 96,
            objectFit: "cover",
            display: card.image ? "block" : "none",
          }}
        />
        {!card.image && (
          <div style={{ width: 148, height: 96, backgroundColor: "#2c2c36" }} />
        )}
        <div style={{ padding: 8, height: 94, position: "relative" }}>
          <span
            style={{
              color: "#fff",
              fontWeight: 600,
              fontSize: 11,
              lineHeight: "15px",
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {card.title}
          </span>
          <span
            style={{
              color: "#9ca3af",
              fontSize: 10,
              marginTop: 3,
              lineHeight: "13px",
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {card.snippet}
          </span>
          <div
            style={{
              position: "absolute",
              bottom: 8,
              left: 8,
              right: 8,
              display: "flex",
              alignItems: "center",
            }}
          >
            <ExternalLink size={9} color="#6b7280" />
            <span
              style={{
                color: "#6b7280",
                fontSize: 9,
                marginLeft: 3,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {getDomain(card.url)}
            </span>
          </div>
        </div>
      </button>
    ))}
  </div>
));


const ChatSkeleton = memo(() => (
  <div
    style={{
      padding: "10px 16px 0",
      display: "flex",
      flexDirection: "column",
      gap: 12,
    }}
  >
    <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
      <ShimmerPlaceholder width={32} height={32} style={{ borderRadius: 16 }} />
      <ShimmerPlaceholder width="60%" height={48} />
    </div>
    <div
      style={{
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "flex-end",
        gap: 8,
      }}
    >
      <ShimmerPlaceholder width="50%" height={36} />
      <ShimmerPlaceholder width={32} height={32} style={{ borderRadius: 16 }} />
    </div>
    <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
      <ShimmerPlaceholder width={32} height={32} style={{ borderRadius: 16 }} />
      <ShimmerPlaceholder width="75%" height={64} />
    </div>
    <div
      style={{
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "flex-end",
        gap: 8,
      }}
    >
      <ShimmerPlaceholder width="40%" height={36} />
      <ShimmerPlaceholder width={32} height={32} style={{ borderRadius: 16 }} />
    </div>
    <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
      <ShimmerPlaceholder width={32} height={32} style={{ borderRadius: 16 }} />
      <ShimmerPlaceholder width="65%" height={48} />
    </div>
  </div>
));


const AiAvatar = memo(({ onClick }: { onClick?: () => void } = {}) => {
  const { aiPhoto } = useSettingsStore();
  const uri = aiPhoto ? `${API_BASE}/files/${aiPhoto}` : null;
  const inner = uri ? (
    <img src={uri} className="w-8 h-8 object-cover" alt="" />
  ) : (
    <div className="w-8 h-8 rounded-full bg-accent flex items-center justify-center">
      <span className="text-white text-xs font-bold">AI</span>
    </div>
  );
  if (onClick) {
    return (
      <motion.button
        onClick={onClick}
        whileHover={{ scale: 1.08 }}
        whileTap={{ scale: 0.94 }}
        className="w-8 h-8 rounded-full overflow-hidden bg-foreground flex items-center justify-center flex-shrink-0 border-none p-0 cursor-pointer"
      >
        {inner}
      </motion.button>
    );
  }
  return (
    <div className="w-8 h-8 rounded-full overflow-hidden bg-foreground flex items-center justify-center flex-shrink-0">
      {inner}
    </div>
  );
});

const UserAvatar = memo(({ onClick }: { onClick?: () => void } = {}) => {
  const { userPhoto } = useSettingsStore();
  const uri = userPhoto ? `${API_BASE}/files/${userPhoto}` : null;
  const inner = uri ? (
    <img src={uri} className="w-8 h-8 object-cover" alt="" />
  ) : (
    <User size={14} color="#ffffff" />
  );
  if (onClick) {
    return (
      <motion.button
        onClick={onClick}
        whileHover={{ scale: 1.08 }}
        whileTap={{ scale: 0.94 }}
        className="w-8 h-8 rounded-full overflow-hidden bg-foreground flex items-center justify-center flex-shrink-0 border-none p-0 cursor-pointer"
      >
        {inner}
      </motion.button>
    );
  }
  return (
    <div className="w-8 h-8 rounded-full overflow-hidden bg-foreground flex items-center justify-center flex-shrink-0">
      {inner}
    </div>
  );
});


const ImageGrid = memo(
  ({
    filenames,
    onPress,
  }: {
    filenames: string[];
    onPress: (i: number) => void;
  }) => {
    const uris = filenames.map((f) => `${API_BASE}/files/${f}`);
    const shown = uris.slice(0, 4);
    const extra = filenames.length - 4;

    if (filenames.length === 1) {
      return (
        <button
          onClick={() => onPress(0)}
          className="border-none cursor-pointer p-0 block"
        >
          <img
            src={uris[0]}
            className="border-2 border-tertiary"
            style={{
              maxWidth: 280,
              maxHeight: 280,
              width: "auto",
              height: "auto",
              borderRadius: 10,
              display: "block",
            }}
            alt=""
          />
        </button>
      );
    }

    return (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 3, width: 214 }}>
        {shown.map((uri, i) => (
          <button
            key={i}
            onClick={() => onPress(i)}
            className="border-none cursor-pointer p-0 relative block"
          >
            <img
              src={uri}
              className="border border-tertiary"
              style={{
                width: 105,
                height: 85,
                borderRadius: 7,
                objectFit: "cover",
                display: "block",
              }}
              alt=""
            />
            {i === 3 && extra > 0 && (
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  backgroundColor: "rgba(0,0,0,0.55)",
                  borderRadius: 7,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <span
                  style={{ color: "#fff", fontWeight: "bold", fontSize: 18 }}
                >
                  +{extra + 1}
                </span>
              </div>
            )}
          </button>
        ))}
      </div>
    );
  },
);


const WAVEFORM = [
  3, 5, 8, 12, 6, 14, 10, 5, 8, 16, 9, 4, 11, 7, 13, 6, 9, 14, 5, 8, 12, 6, 4,
  10, 7, 5, 9, 3,
];

const VoiceNotePlayer = memo(({ filename }: { filename: string }) => {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);
  const waveformRef = useRef<HTMLDivElement>(null);

  const toggle = () => {
    if (!audioRef.current) return;
    if (playing) audioRef.current.pause();
    else audioRef.current.play();
    setPlaying(!playing);
  };

  const seekFromClientX = (clientX: number) => {
    if (!audioRef.current || !duration || !waveformRef.current) return;
    const rect = waveformRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    audioRef.current.currentTime = ratio * duration;
    setProgress(ratio);
    setCurrentTime(ratio * duration);
  };

  const handleWaveformPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    seekFromClientX(e.clientX);
  };
  const handleWaveformPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons === 0) return;
    seekFromClientX(e.clientX);
  };

  const fmt = (s: number) =>
    `${Math.floor(s / 60)}:${Math.floor(s % 60)
      .toString()
      .padStart(2, "0")}`;

  return (
    <div
      className="flex items-center gap-3 px-3 py-2.5 rounded-2xl border-2 border-tertiary"
      style={{ background: "#1e1e25", minWidth: 240 }}
    >
      <audio
        ref={audioRef}
        src={`${API_BASE}/files/${filename}`}
        onTimeUpdate={() => {
          if (!audioRef.current) return;
          setCurrentTime(audioRef.current.currentTime);
          setProgress(
            audioRef.current.currentTime / (audioRef.current.duration || 1),
          );
        }}
        onLoadedMetadata={() =>
          audioRef.current && setDuration(audioRef.current.duration)
        }
        onEnded={() => {
          setPlaying(false);
          setProgress(0);
          setCurrentTime(0);
          if (audioRef.current) audioRef.current.currentTime = 0;
        }}
      />
      <button
        onClick={toggle}
        className="w-9 h-9 rounded-full flex items-center justify-center border-none cursor-pointer flex-shrink-0"
        style={{ background: "var(--accent)" }}
      >
        {playing ? (
          <Pause size={15} color="#fff" fill="#fff" />
        ) : (
          <Play size={15} color="#fff" fill="#fff" />
        )}
      </button>
      <div
        ref={waveformRef}
        className="flex items-center gap-[2px] flex-1 cursor-pointer touch-none"
        onPointerDown={handleWaveformPointerDown}
        onPointerMove={handleWaveformPointerMove}
      >
        {WAVEFORM.map((h, i) => (
          <div
            key={i}
            style={{
              width: 2.5,
              height: h,
              borderRadius: 2,
              background:
                progress * WAVEFORM.length > i ? "var(--accent)" : "#3a3a4a",
              flexShrink: 0,
            }}
          />
        ))}
      </div>
      <span
        className="text-gray-400 font-mono flex-shrink-0 ml-3"
        style={{ fontSize: 11 }}
      >
        {playing ? fmt(currentTime) : fmt(duration)}
      </span>
    </div>
  );
});


const ImagePreviewStrip = memo(
  ({
    images,
    onRemove,
  }: {
    images: SelectedImage[];
    onRemove: (i: number) => void;
  }) => {
    if (images.length === 0) return null;
    return (
      <div
        className="border-b border-border bg-background px-4 py-2 flex overflow-x-auto gap-2"
        style={{ scrollbarWidth: "none" }}
      >
        {images.map((img, i) => (
          <div key={i} className="relative flex-shrink-0">
            <img
              src={img.uri}
              style={{
                width: 64,
                height: 64,
                borderRadius: 8,
                objectFit: "cover",
                display: "block",
              }}
              alt=""
            />
            <button
              onClick={() => onRemove(i)}
              className="absolute top-[-4px] right-[-4px] w-4 h-4 rounded-full bg-tertiary flex items-center justify-center border-none cursor-pointer"
            >
              <X size={9} color="#8e8e93" />
            </button>
          </div>
        ))}
      </div>
    );
  },
);


const ImageFullscreenModal = memo(
  ({
    visible,
    uris,
    initialIndex,
    onClose,
  }: {
    visible: boolean;
    uris: string[];
    initialIndex: number;
    onClose: () => void;
  }) => {
    const [current, setCurrent] = useState(initialIndex);

    const handleDownload = async () => {
      const uri = uris[current];
      try {
        const res = await fetch(uri);
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = uri.split("/").pop() || "image";
        a.click();
        URL.revokeObjectURL(blobUrl);
      } catch (err) {
        console.error("[download]", err);
      }
    };

    return (
      <AnimatePresence>
        {visible && (
          <motion.div
            className="fixed inset-0 z-[200] flex flex-col"
            style={{ backgroundColor: "rgba(8,8,12,0.8)", backdropFilter: "blur(24px)" }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
          >
            <motion.button
              onClick={onClose}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.1 }}
              whileHover={{ scale: 1.1, rotate: 90 }}
              whileTap={{ scale: 0.9 }}
              className="absolute top-4 right-4 z-10 p-2 bg-transparent border-none cursor-pointer"
            >
              <X size={28} color="#fff" />
            </motion.button>
            <motion.button
              onClick={handleDownload}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.1 }}
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.9 }}
              className="absolute top-4 left-4 z-10 p-2 bg-black/50 rounded-full border-none cursor-pointer"
              title="Download image"
            >
              <Download size={22} color="#fff" />
            </motion.button>
            {uris.length > 1 && (
              <>
                {current > 0 && (
                  <motion.button
                    onClick={() => setCurrent((c) => Math.max(0, c - 1))}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    whileHover={{ scale: 1.1, x: -2 }}
                    whileTap={{ scale: 0.9 }}
                    className="absolute left-4 top-1/2 -translate-y-1/2 z-10 p-2 bg-black/50 rounded-full border-none cursor-pointer"
                  >
                    <ArrowLeft size={24} color="#fff" />
                  </motion.button>
                )}
                {current < uris.length - 1 && (
                  <motion.button
                    onClick={() => setCurrent((c) => Math.min(uris.length - 1, c + 1))}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    whileHover={{ scale: 1.1, x: 2 }}
                    whileTap={{ scale: 0.9 }}
                    className="absolute right-4 top-1/2 -translate-y-1/2 z-10 p-2 bg-black/50 rounded-full border-none cursor-pointer"
                  >
                    <ArrowLeft size={24} color="#fff" style={{ transform: "rotate(180deg)" }} />
                  </motion.button>
                )}
              </>
            )}
            <div className="flex-1 flex items-center justify-center overflow-hidden">
              <AnimatePresence mode="wait" initial={false}>
                <motion.img
                  key={current}
                  src={uris[current]}
                  initial={{ opacity: 0, scale: 0.94 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  transition={{ type: "spring", stiffness: 380, damping: 34 }}
                  className="max-w-full max-h-full object-contain"
                  alt=""
                />
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    );
  },
);

const AvatarPhotoModal = memo(
  ({
    avatar,
    onClose,
  }: {
    avatar: { uri: string; name: string } | null;
    onClose: () => void;
  }) => (
    <AnimatePresence>
      {avatar && (
        <motion.div
          className="fixed inset-0 z-[200] flex flex-col items-center justify-center"
          style={{ backgroundColor: "rgba(10,10,15,0.45)", backdropFilter: "blur(28px)" }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25, ease: "easeOut" }}
          onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
          <motion.button
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.1 }}
            whileHover={{ scale: 1.1, rotate: 90 }}
            whileTap={{ scale: 0.9 }}
            className="absolute top-5 right-5 z-10 p-2 rounded-full border-none cursor-pointer"
            style={{ background: "rgba(255,255,255,0.1)" }}
          >
            <X size={18} color="#fff" />
          </motion.button>
          <motion.div
            initial={{ opacity: 0, scale: 0.85, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 10 }}
            transition={{ type: "spring", stiffness: 340, damping: 28 }}
            className="flex flex-col items-center gap-4"
          >
            <img
              src={avatar.uri}
              className="rounded-full object-cover"
              style={{ width: 260, height: 260, boxShadow: "0 24px 70px rgba(0,0,0,0.55)" }}
              alt={avatar.name}
            />
            <span className="text-white font-semibold" style={{ fontSize: 15 }}>
              {avatar.name}
            </span>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  ),
);


const ReplyPreview = memo(
  ({
    replyingTo,
    onCancel,
  }: {
    replyingTo: Message | null;
    onCancel: () => void;
  }) => {
    const { aiName } = useSettingsStore();
    return (
      <AnimatePresence>
        {replyingTo && (
          <motion.div
            initial={{ opacity: 0, height: 0, y: -6 }}
            animate={{ opacity: 1, height: "auto", y: 0 }}
            exit={{ opacity: 0, height: 0, y: -6 }}
            transition={{ type: "spring", stiffness: 420, damping: 40 }}
            className="overflow-hidden"
          >
            <div className="mx-4 mt-2 mb-1 flex items-center gap-2.5 rounded-xl bg-foreground px-3 py-2">
              <Reply size={13} color="var(--accent)" className="flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <span className="text-[10px] text-gray-400 font-semibold block">
                  Replying to {replyingTo.sender === "user" ? "you" : aiName}
                </span>
                <span
                  className="mt-0.5 text-[12px] text-gray-300 block overflow-hidden whitespace-nowrap"
                  style={{ textOverflow: "ellipsis" }}
                >
                  {replyingTo.content}
                </span>
              </div>
              <motion.button
                onClick={onCancel}
                whileHover={{ scale: 1.15 }}
                whileTap={{ scale: 0.9 }}
                className="p-1 bg-transparent border-none cursor-pointer flex-shrink-0"
              >
                <X size={14} color="#8a8a94" />
              </motion.button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    );
  },
);


const DeleteMessageModal = memo(
  ({
    visible,
    onConfirm,
    onCancel,
  }: {
    visible: boolean;
    onConfirm: () => void;
    onCancel: () => void;
  }) => (
    <AnimatePresence>
      {visible && (
        <motion.div
          className="fixed inset-0 z-[150] flex items-center justify-center"
          style={{ backgroundColor: "rgba(0,0,0,0.65)", backdropFilter: "blur(6px)" }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.92, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 8 }}
            transition={{ type: "spring", stiffness: 400, damping: 32 }}
            className="w-4/5 max-w-sm flex flex-col rounded-2xl bg-foreground p-5"
          >
            <span className="mb-2 text-[15px] text-white font-semibold">Delete message</span>
            <span className="mb-5 text-[13px] text-gray-300 leading-5">
              Are you sure you want to delete this message?
            </span>
            <div className="w-full flex gap-2">
              <motion.button
                onClick={onCancel}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.96 }}
                className="flex-1 rounded-full bg-background px-4 py-2.5 border-none cursor-pointer"
              >
                <span className="text-[13px] text-gray-300 font-semibold">Cancel</span>
              </motion.button>
              <motion.button
                onClick={onConfirm}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.96 }}
                className="flex-1 rounded-full bg-destructive px-4 py-2.5 border-none cursor-pointer"
              >
                <span className="text-[13px] text-white font-semibold">Delete</span>
              </motion.button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  ),
);

const EditMessageModal = memo(
  ({
    visible,
    onConfirm,
    onCancel,
    value,
    onChange,
  }: {
    visible: boolean;
    onConfirm: () => void;
    onCancel: () => void;
    value: string;
    onChange: (t: string) => void;
  }) => (
    <AnimatePresence>
      {visible && (
        <motion.div
          className="fixed inset-0 z-[150] flex items-center justify-center"
          style={{ backgroundColor: "rgba(0,0,0,0.65)", backdropFilter: "blur(6px)" }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.92, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 8 }}
            transition={{ type: "spring", stiffness: 400, damping: 32 }}
            className="w-4/5 max-w-sm flex flex-col rounded-2xl bg-foreground p-5"
          >
            <span className="mb-3 text-[15px] text-white font-semibold">Edit message</span>
            <textarea
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder="Type your message..."
              className="mb-5 w-full rounded-xl bg-background px-4 py-3 text-white text-[13px] border border-foreground outline-none resize-none min-h-[80px] placeholder:text-gray-400"
              maxLength={2000}
              autoFocus
            />
            <div className="w-full flex gap-2">
              <motion.button
                onClick={onCancel}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.96 }}
                className="flex-1 rounded-full bg-background px-4 py-2.5 border-none cursor-pointer"
              >
                <span className="text-[13px] text-gray-300 font-semibold">Cancel</span>
              </motion.button>
              <motion.button
                onClick={onConfirm}
                disabled={!value.trim()}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.96 }}
                className={`flex-1 rounded-full px-4 py-2.5 border-none cursor-pointer disabled:opacity-50 ${value.trim() ? "bg-accent" : "bg-background"}`}
              >
                <span className="text-[13px] text-white font-semibold">Save</span>
              </motion.button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  ),
);


const NeuroMessage = memo(
  ({
    item,
    onConfirm,
    onAvatarPress,
  }: {
    item: Message;
    onConfirm: (taskId: string, confirmed: boolean) => void;
    onAvatarPress?: (kind: "ai" | "user") => void;
  }) => {
    return (
      <div className="mb-1 flex flex-row items-start message-in">
        <div className="mr-2 mt-auto">
          <AiAvatar onClick={onAvatarPress ? () => onAvatarPress("ai") : undefined} />
        </div>
        <div className="flex flex-col items-start">
          <div
            className="bg-foreground rounded-2xl rounded-bl-sm px-4 py-3"
            style={{ maxWidth: "85%" }}
          >
            <div className="flex flex-row items-center gap-1.5 mb-1.5">
              <span style={{ fontSize: 10, color: "#9ca3af", fontWeight: 900 }}>
                NEURO
              </span>
            </div>
            <span className="text-white" style={{ fontSize: 14 }}>
              {item.neuroText ?? item.content}
            </span>
            <div
              className="text-gray-300 font-bold mt-1"
              style={{ fontSize: 10 }}
            >
              {formatTimestamp(item.createdAt)}
            </div>
          </div>
          {!item.neuroConfirmed && item.neuroTaskId && (
            <div className="flex flex-row mt-1.5 ml-1 gap-2">
              <button
                onClick={() => onConfirm(item.neuroTaskId!, true)}
                className="rounded-full px-4 py-1.5 text-white font-bold border-none cursor-pointer"
                style={{ background: "var(--accent)", fontSize: 13 }}
              >
                yes
              </button>
              <button
                onClick={() => onConfirm(item.neuroTaskId!, false)}
                className="bg-foreground rounded-full px-4 py-1.5 text-gray-300 font-bold border-none cursor-pointer"
                style={{ fontSize: 13 }}
              >
                no
              </button>
            </div>
          )}
        </div>
      </div>
    );
  },
);


const SkillConfirmationMessage = memo(
  ({
    item,
    onResolve,
    onAvatarPress,
  }: {
    item: Message;
    onResolve: (confirmationId: string, action: "approve" | "reject", feedback?: string) => void;
    onAvatarPress?: (kind: "ai" | "user") => void;
  }) => {
    const [feedback, setFeedback] = useState("");
    const conf = item.pendingConfirmation;
    if (!conf) return null;
    const { decision } = conf;

    return (
      <div className="mb-1 flex flex-row items-start message-in">
        <div className="mr-2 mt-auto">
          <AiAvatar onClick={onAvatarPress ? () => onAvatarPress("ai") : undefined} />
        </div>
        <div className="flex flex-col items-start" style={{ maxWidth: "85%" }}>
          <div className="bg-foreground rounded-2xl rounded-bl-sm px-4 py-3 w-full">
            <div className="flex flex-row items-center gap-1.5 mb-1.5">
              <AlertTriangle size={11} color="var(--accent)" />
              <span style={{ fontSize: 10, color: "var(--accent)", fontWeight: 900 }}>
                CONFIRMATION NEEDED
              </span>
            </div>
            <p className="text-white font-semibold m-0" style={{ fontSize: 14 }}>
              {conf.skillName}
            </p>
            {conf.skillDescription && (
              <p className="text-gray-300 m-0 mt-0.5" style={{ fontSize: 12 }}>
                {conf.skillDescription}
              </p>
            )}
            <pre
              className="mt-2 mb-0 whitespace-pre-wrap break-all font-mono bg-background rounded-lg px-3 py-2 text-gray-300"
              style={{ fontSize: 11, maxHeight: 220, overflowY: "auto" }}
            >
              {JSON.stringify(conf.args, null, 2)}
            </pre>
            <div className="text-gray-300 font-bold mt-1.5" style={{ fontSize: 10 }}>
              {formatTimestamp(item.createdAt)}
            </div>
          </div>

          {!decision ? (
            <div className="flex flex-col mt-1.5 ml-1 gap-2 w-full">
              <div className="flex flex-row gap-2">
                <button
                  onClick={() => onResolve(conf.confirmationId, "approve")}
                  className="rounded-full px-4 py-1.5 text-white font-bold border-none cursor-pointer"
                  style={{ background: "var(--accent)", fontSize: 13 }}
                >
                  Approve
                </button>
                <button
                  onClick={() => onResolve(conf.confirmationId, "reject")}
                  className="bg-foreground rounded-full px-4 py-1.5 text-gray-300 font-bold border-none cursor-pointer"
                  style={{ fontSize: 13 }}
                >
                  Don't approve
                </button>
              </div>
              <div className="flex flex-row gap-2">
                <input
                  type="text"
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  placeholder="Explain what to change (optional)..."
                  className="flex-1 rounded-full bg-background px-3.5 py-2 text-white border border-foreground outline-none placeholder:text-gray-400"
                  style={{ fontSize: 12 }}
                />
                <button
                  onClick={() => onResolve(conf.confirmationId, "reject", feedback)}
                  disabled={!feedback.trim()}
                  className="rounded-full px-4 py-2 text-white font-bold border-none cursor-pointer disabled:opacity-40"
                  style={{ background: "#3a3a46", fontSize: 12 }}
                >
                  Send
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-1.5 ml-1" style={{ fontSize: 11, color: "#9ca3af", fontWeight: 700 }}>
              {decision === "approved" && "✓ approved"}
              {decision === "rejected" &&
                (conf.feedback ? `✕ changes requested: "${conf.feedback}"` : "✕ not approved")}
              {decision === "timeout" && "⏱ timed out with no response"}
            </div>
          )}
        </div>
      </div>
    );
  },
);


const MessageItem = memo(
  ({
    item,
    hideAvatar = false,
    isLastInGroup = true,
    onReply,
    onEdit,
    onDelete,
    onImagePress,
    onAvatarPress,
  }: {
    item: Message;
    hideAvatar?: boolean;
    isLastInGroup?: boolean;
    onReply: (msg: Message) => void;
    onEdit: (msg: Message) => void;
    onDelete: (msg: Message) => void;
    onImagePress: (filenames: string[], index: number) => void;
    onAvatarPress?: (kind: "ai" | "user") => void;
  }) => {
    const { aiName } = useSettingsStore();
    const isOwn = item.sender === "user";

    return (
      <div
        className={`${hideAvatar ? 'mb-1' : 'mb-2'} group flex flex-row items-start${item.isNew ? " message-in" : ""}`}
      >
        {!isOwn && (
          <div className="mr-2 mt-auto" style={{ width: 28, flexShrink: 0 }}>
            {!hideAvatar && (
              <AiAvatar onClick={onAvatarPress ? () => onAvatarPress("ai") : undefined} />
            )}
          </div>
        )}
        <div
          className={`flex-1 flex flex-col ${isOwn ? "items-end" : "items-start"}`}
        >
          {item.replyTo && (
            <div
              className={`mb-1 max-w-[85%] flex items-center gap-2 rounded-xl bg-foreground px-3 py-2 ${isOwn ? "self-end" : "self-start"}`}
            >
              <Reply size={11} color="var(--accent)" className="flex-shrink-0" />
              <div className="min-w-0">
                <span className="text-[10px] text-gray-400 font-semibold block">
                  {item.replyTo.sender === "user" ? "You" : aiName}
                </span>
                <span
                  className="text-[12px] text-gray-300 block overflow-hidden whitespace-nowrap"
                  style={{ textOverflow: "ellipsis" }}
                >
                  {item.replyTo.content}
                </span>
              </div>
            </div>
          )}
          {isOwn && item.isRoutine && (
            <div className="flex flex-row items-center gap-1.5 mr-2 mb-1 self-end">
              <Clock size={9} color="#d1d5db" />
              <span className="text-[10px] text-gray-300">scheduled routine</span>
            </div>
          )}
          {item.toolErrors && item.toolErrors.length > 0 && (
            <div className="flex flex-col ml-2 gap-0.5 mb-1 self-start">
              {item.toolErrors.map((e, i) => (
                <div
                  key={i}
                  className="flex flex-row items-start gap-1 bg-foreground rounded-lg px-2 py-1"
                >
                  <X
                    size={9}
                    color="#f87171"
                    style={{ flexShrink: 0, marginTop: 1 }}
                  />
                  <span
                    className="text-red-400 font-mono"
                    style={{ fontSize: 9, wordBreak: "break-all" }}
                  >
                    {e.tool}: {e.message}
                  </span>
                </div>
              ))}
            </div>
          )}
          {item.voiceNotes && item.voiceNotes.length > 0 && (
            <div
              className={`mb-1 flex flex-col gap-1 ${isOwn ? "self-end items-end" : "self-start items-start"}`}
            >
              {item.voiceNotes.map((vn, i) => (
                <VoiceNotePlayer key={i} filename={vn.filename} />
              ))}
            </div>
          )}
          {item.gifs && item.gifs.length > 0 && (
            <div className={`mb-1 ${isOwn ? "self-end" : "self-start"}`}>
              {item.gifs.map((gif, i) =>
                gif.mp4 ? (
                  <video
                    key={i}
                    src={gif.mp4}
                    autoPlay
                    loop
                    muted
                    playsInline
                    className="border-2 border-tertiary"
                    style={{
                      maxWidth: 640,
                      maxHeight: 480,
                      width: "auto",
                      height: "auto",
                      borderRadius: 12,
                      display: "block",
                    }}
                  />
                ) : gif.url ? (
                  <img
                    key={i}
                    src={gif.url}
                    alt=""
                    className="border-2 border-tertiary"
                    style={{
                      maxWidth: 640,
                      maxHeight: 480,
                      width: "auto",
                      height: "auto",
                      borderRadius: 12,
                      display: "block",
                    }}
                  />
                ) : null,
              )}
            </div>
          )}

          {item.imageFilenames && item.imageFilenames.length > 0 && (
            <div className={`mb-1 ${isOwn ? "self-end" : "self-start"}`}>
              <ImageGrid
                filenames={item.imageFilenames}
                onPress={(idx) => onImagePress(item.imageFilenames!, idx)}
              />
            </div>
          )}

          {!!item.content ? (
            <div
              className={`max-w-[85%] px-4 py-3 ${isOwn ? "rounded-2xl rounded-br-sm self-end" : "bg-foreground rounded-2xl rounded-bl-sm self-start"}`}
              style={isOwn ? { backgroundColor: "#1b1b22" } : undefined}
            >
              <div
                className="markdown-body text-white text-[13px]"
                style={{ wordBreak: "break-word" }}
              >
                <ReactMarkdown
                  remarkPlugins={[remarkGfm, remarkBreaks]}
                  components={{
                    p: ({ children }) => (
                      <p className="mb-1 last:mb-0 leading-snug">{children}</p>
                    ),
                    strong: ({ children }) => (
                      <strong className="font-bold">{children}</strong>
                    ),
                    em: ({ children }) => (
                      <em className="italic">{children}</em>
                    ),
                    code: ({ children, className }) => {
                      const isBlock = className?.includes("language-");
                      return isBlock ? (
                        <code className="block bg-black/30 rounded px-2 py-1 font-mono text-[12px] overflow-x-auto my-1">
                          {children}
                        </code>
                      ) : (
                        <code className="bg-black/30 rounded px-1 font-mono text-[12px]">
                          {children}
                        </code>
                      );
                    },
                    pre: ({ children }) => (
                      <pre className="my-1 overflow-x-auto">{children}</pre>
                    ),
                    ul: ({ children }) => (
                      <ul className="list-disc list-inside mb-1 space-y-0.5">
                        {children}
                      </ul>
                    ),
                    ol: ({ children }) => (
                      <ol className="list-decimal list-inside mb-1 space-y-0.5">
                        {children}
                      </ol>
                    ),
                    li: ({ children }) => (
                      <li className="leading-snug">{children}</li>
                    ),
                    h1: ({ children }) => (
                      <h1 className="text-base font-black mb-1">{children}</h1>
                    ),
                    h2: ({ children }) => (
                      <h2 className="text-[14px] font-black mb-1">
                        {children}
                      </h2>
                    ),
                    h3: ({ children }) => (
                      <h3 className="text-[13px] font-bold mb-0.5">
                        {children}
                      </h3>
                    ),
                    a: ({ href, children }) => (
                      <a
                        href={href}
                        target="_blank"
                        rel="noreferrer"
                        className="underline opacity-80"
                      >
                        {children}
                      </a>
                    ),
                    blockquote: ({ children }) => (
                      <blockquote className="border-l-2 border-white/30 pl-3 opacity-80 my-1">
                        {children}
                      </blockquote>
                    ),
                    hr: () => <hr className="border-white/20 my-2" />,
                    table: ({ children }) => (
                      <div className="my-1.5 rounded-lg border border-white/10">
                        <table className="w-full table-fixed border-collapse text-[12px]">
                          {children}
                        </table>
                      </div>
                    ),
                    thead: ({ children }) => (
                      <thead className="bg-white/[0.06]">{children}</thead>
                    ),
                    tr: ({ children }) => (
                      <tr className="border-b border-white/10 last:border-b-0 even:bg-white/[0.03]">
                        {children}
                      </tr>
                    ),
                    th: ({ children }) => (
                      <th className="px-2 py-1.5 text-left font-bold text-white break-words border-r border-white/10 last:border-r-0">
                        {children}
                      </th>
                    ),
                    td: ({ children }) => (
                      <td className="px-2 py-1.5 text-gray-300 align-top break-words border-r border-white/10 last:border-r-0">
                        {children}
                      </td>
                    ),
                  }}
                >
                  {item.content}
                </ReactMarkdown>
              </div>
              <div className="mt-1 flex flex-row items-center justify-between gap-2">
                <span className="text-[9px] font-bold text-gray-300">
                  {formatTimestamp(item.createdAt)}
                </span>
                <div className="flex items-center gap-1.5">
                  {item.isEdited && (
                    <span className="text-[8px] text-gray-300">edited</span>
                  )}
                  {item.fromNeuro && (
                    <span
                      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5"
                      style={{ background: "rgba(255,255,255,0.08)", fontSize: 9, color: "#d1d5db", fontWeight: 600, letterSpacing: 0.3 }}
                    >
                      <Zap size={8} color="#d1d5db" /> neuro
                    </span>
                  )}
                </div>
              </div>
            </div>
          ) :
          item.gifs?.length ||
            item.imageFilenames?.length ||
            item.voiceNotes?.length ? (
            <span
              className={`text-[9px] font-bold text-gray-600 px-1 ${isOwn ? "self-end" : "self-start"}`}
            >
              {formatTimestamp(item.createdAt)}
            </span>
          ) : null}

          {((item.toolsUsed && item.toolsUsed.length > 0) ||
            (!isOwn && item.searchSources && item.searchSources.length > 0)) && (
            <div className="flex flex-row flex-wrap items-center ml-2 gap-2 mt-1 self-start">
              {Array.from(new Set(item.toolsUsed)).map((tool) => {
                const TOOL_LABELS: Record<
                  string,
                  { label: string; icon: React.ReactNode }
                > = {
                  execute_command: {
                    label: "terminal",
                    icon: (
                      <span
                        style={{
                          fontSize: 8,
                          fontFamily: "monospace",
                          color: "#d1d5db",
                        }}
                      >
                        &gt;_
                      </span>
                    ),
                  },
                  save_memory: {
                    label: "memory saved",
                    icon: <Pen size={8} color="#d1d5db" />,
                  },
                  generate_pixel_art: {
                    label: "pixel art generated",
                    icon: (
                      <PixelGridIcon
                        size={10}
                        color="#d1d5db"
                        dimColor="rgba(209,213,219,0.3)"
                      />
                    ),
                  },
                  generate_pixel_art_pro: {
                    label: "pixel art pro",
                    icon: (
                      <PixelGridIcon
                        size={10}
                        color="#d1d5db"
                        dimColor="rgba(209,213,219,0.3)"
                      />
                    ),
                  },
                  convert_to_pixel_art: {
                    label: "pixel art",
                    icon: (
                      <PixelGridIcon
                        size={10}
                        color="#d1d5db"
                        dimColor="rgba(209,213,219,0.3)"
                      />
                    ),
                  },
                  convert_to_pixel_art_pro: {
                    label: "pixel art pro",
                    icon: (
                      <PixelGridIcon
                        size={10}
                        color="#d1d5db"
                        dimColor="rgba(209,213,219,0.3)"
                      />
                    ),
                  },
                  generate_with_style: {
                    label: "generated with style",
                    icon: (
                      <PixelGridIcon
                        size={10}
                        color="#d1d5db"
                        dimColor="rgba(209,213,219,0.3)"
                      />
                    ),
                  },
                  remove_background: {
                    label: "background removed",
                    icon: (
                      <PixelGridIcon
                        size={10}
                        color="#d1d5db"
                        dimColor="rgba(209,213,219,0.3)"
                      />
                    ),
                  },
                  web_search: {
                    label: "web search",
                    icon: <Globe size={8} color="#d1d5db" />,
                  },
                  search_products: {
                    label: "product search",
                    icon: <Globe size={8} color="#d1d5db" />,
                  },
                  send_gif: {
                    label: "gif",
                    icon: <span style={{ fontSize: 9 }}>GIF</span>,
                  },
                  send_voice_message: {
                    label: "audio",
                    icon: <Mic size={8} color="#d1d5db" />,
                  },
                  create_skill: {
                    label: "new tool",
                    icon: <Wrench size={8} color="#d1d5db" />,
                  },
                  edit_skill: {
                    label: "tool edited",
                    icon: <Pencil size={8} color="#d1d5db" />,
                  },
                  delete_skill: {
                    label: "tool removed",
                    icon: <Trash2 size={8} color="#d1d5db" />,
                  },
                };
                const meta = TOOL_LABELS[tool] ?? {
                  label: formatToolLabel(tool),
                  icon: <Pen size={8} color="#d1d5db" />,
                };
                return (
                  <div
                    key={tool}
                    className="flex flex-row items-center gap-0.5"
                  >
                    {meta.icon}
                    <span
                      className="text-gray-300 font-black"
                      style={{ fontSize: 10 }}
                    >
                      {meta.label}
                    </span>
                  </div>
                );
              })}
              {!isOwn && item.searchSources && item.searchSources.length > 0 && (
                <SearchSources sources={item.searchSources} />
              )}
            </div>
          )}

          {isLastInGroup && <div
            className={`flex items-center gap-0.5 mt-1 opacity-0 group-hover:opacity-100 transition-opacity ${isOwn ? "self-end" : "self-start ml-1"}`}
          >
            <button
              onClick={() => onReply(item)}
              title="Reply"
              className="p-1.5 rounded-full bg-transparent hover:bg-foreground border-none cursor-pointer"
            >
              <Reply size={12} color="#9ca3af" />
            </button>
            {isOwn && (
              <>
                <button
                  onClick={() => onEdit(item)}
                  title="Edit"
                  className="p-1.5 rounded-full bg-transparent hover:bg-foreground border-none cursor-pointer"
                >
                  <Pencil size={12} color="#9ca3af" />
                </button>
                <button
                  onClick={() => onDelete(item)}
                  title="Delete"
                  className="p-1.5 rounded-full bg-transparent hover:bg-foreground border-none cursor-pointer"
                >
                  <Trash2 size={12} color="#9ca3af" />
                </button>
              </>
            )}
          </div>}

          {!isOwn && item.productCards && item.productCards.length > 0 && (
            <ProductCards cards={item.productCards} />
          )}
        </div>
        {isOwn && (
          <div className="ml-2 mt-auto">
            <UserAvatar onClick={onAvatarPress ? () => onAvatarPress("user") : undefined} />
          </div>
        )}
      </div>
    );
  },
);


const ChatsDrawer = memo(
  ({
    chats,
    activeChatId,
    onSelectChat,
    onNewChat,
    onDeleteChat,
    onOpenSettings,
    onOpenAiPhoto,
  }: {
    chats: ChatMeta[];
    activeChatId: string | null;
    onSelectChat: (id: string) => void;
    onNewChat: () => void;
    onDeleteChat: (id: string) => void;
    onOpenSettings: () => void;
    onOpenAiPhoto?: () => void;
  }) => {
    const { aiName, aiPhoto } = useSettingsStore();
    const aiPhotoUri = aiPhoto ? `${API_BASE}/files/${aiPhoto}` : null;
    const { skills, packages, loadSkills, loadPackages } = useSkillsStore();
    const { integrations, loadIntegrations } = useIntegrationsStore();

    useEffect(() => {
      loadSkills();
      loadPackages();
      loadIntegrations();
    }, [loadSkills, loadPackages, loadIntegrations]);

    return (
      <div
        className="flex flex-col border-r border-border bg-background flex-shrink-0"
        style={{ width: 248 }}
      >
        <div className="flex items-center px-4 py-3.5 gap-2.5 flex-shrink-0">
          <motion.button
            onClick={onOpenAiPhoto}
            whileHover={aiPhotoUri ? { scale: 1.08 } : undefined}
            whileTap={aiPhotoUri ? { scale: 0.94 } : undefined}
            className="w-8 h-8 rounded-full overflow-hidden bg-accent flex-shrink-0 flex items-center justify-center border-none p-0 cursor-pointer"
          >
            {aiPhotoUri ? (
              <img src={aiPhotoUri} className="w-8 h-8 object-cover" alt="" />
            ) : (
              <span className="text-white text-[10px] font-bold">AI</span>
            )}
          </motion.button>
          <span className="text-white font-semibold text-[13px] flex-1 truncate">{aiName}</span>
          <motion.button
            onClick={onNewChat}
            whileHover={{ scale: 1.08 }}
            whileTap={{ scale: 0.92 }}
            className="h-7 w-7 rounded-full bg-foreground flex items-center justify-center border-none cursor-pointer flex-shrink-0 hover:bg-foreground/70 transition-colors"
          >
            <Plus size={14} color="#fff" />
          </motion.button>
        </div>

        <p className="text-gray-500 font-semibold text-[10px] tracking-widest px-4 pt-3 pb-2 m-0">
          RECENT
        </p>

        <div className="flex-1 overflow-y-auto px-2">
          <AnimatePresence initial={false}>
            {chats.map((item, idx) => {
              const isActive = item._id === activeChatId;
              return (
                <motion.div
                  key={item._id}
                  layout
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: -12, transition: { duration: 0.15 } }}
                  transition={{ type: "spring", stiffness: 460, damping: 40, delay: idx * 0.02 }}
                  className={`group flex items-center mb-0.5 rounded-xl ${isActive ? "bg-foreground" : "hover:bg-foreground/50"}`}
                  style={{ transition: "background-color 0.15s" }}
                >
                  <button
                    onClick={() => onSelectChat(item._id)}
                    className="flex-1 flex items-center py-2.5 px-3 bg-transparent border-none cursor-pointer text-left min-w-0"
                  >
                    <span
                      className={`text-[13px] truncate ${isActive ? "text-white font-medium" : "text-gray-400"}`}
                    >
                      {item.title}
                    </span>
                  </button>
                  <motion.button
                    onClick={() => onDeleteChat(item._id)}
                    whileHover={{ scale: 1.15 }}
                    whileTap={{ scale: 0.9 }}
                    className="bg-transparent border-none cursor-pointer p-2 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <Trash2 size={12} color="#8a8a94" />
                  </motion.button>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>

        {(packages.length > 0 || skills.length > 0 || integrations.some((i) => i.connected)) && (
          <div className="px-2.5 pt-1 flex-shrink-0">
            <div
              className="w-full rounded-2xl bg-foreground overflow-hidden"
              style={{ height: 150 }}
            >
              <SkillNeuronGraph
                packages={packages}
                skills={skills}
                integrations={integrations}
                aiName={aiName}
                onOpenPackage={onOpenSettings}
                onOpenSkill={onOpenSettings}
                onOpenIntegration={onOpenSettings}
                showLabels={false}
                zoomPan={true}
              />
            </div>
          </div>
        )}

        <div className="p-2.5 flex-shrink-0">
          <motion.button
            onClick={onOpenSettings}
            whileHover={{ scale: 1.01 }}
            whileTap={{ scale: 0.98 }}
            className="flex items-center gap-2.5 w-full px-3 py-2.5 rounded-xl bg-transparent border-none cursor-pointer hover:bg-foreground transition-colors"
          >
            <Settings size={14} color="#8a8a94" />
            <span className="text-gray-400 text-[12px]">Settings</span>
          </motion.button>
        </div>
      </div>
    );
  },
);


const PixelGridIcon = memo(
  ({
    size = 16,
    color = "#fff",
    dimColor = "rgba(255,255,255,0.18)",
  }: {
    size?: number;
    color?: string;
    dimColor?: string;
  }) => {
    const cell = size / 4;
    const gap = Math.max(0.5, cell / 4);
    const total = cell * 4 + gap * 3;
    const pattern = [
      [1, 0, 1, 0],
      [0, 1, 0, 1],
      [1, 0, 1, 0],
      [0, 1, 0, 1],
    ];
    return (
      <svg width={total} height={total} viewBox={`0 0 ${total} ${total}`}>
        {pattern.map((row, r) =>
          row.map((on, c) => (
            <rect
              key={`${r}-${c}`}
              x={c * (cell + gap)}
              y={r * (cell + gap)}
              width={cell}
              height={cell}
              fill={on ? color : dimColor}
            />
          )),
        )}
      </svg>
    );
  },
);

type PixelLabActionId = "force";


export default function ChatScreen() {
  const [chats, setChats] = useState<ChatMeta[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [message, setMessage] = useState("");
  const [selectedImages, setSelectedImages] = useState<SelectedImage[]>([]);
  const [isAiTyping, setIsAiTyping] = useState(false);
  const [activity, setActivity] = useState<ToolActivity | null>(null);
  const activityErrorTimerRef = useRef<number | null>(null);
  const [neuroRunning, setNeuroRunning] = useState(false);
  const [neuroActivity, setNeuroActivity] = useState<string | null>(null);
  const [activeNeuroChatId, setActiveNeuroChatId] = useState<string | null>(null);
  const [neuroMode, setNeuroMode] = useState(false);
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [showCall, setShowCall] = useState(false);
  const [selectedMessage, setSelectedMessage] = useState<Message | null>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editMessageText, setEditMessageText] = useState("");
  const [fullscreenUris, setFullscreenUris] = useState<string[]>([]);
  const [fullscreenIndex, setFullscreenIndex] = useState(0);
  const [showFullscreen, setShowFullscreen] = useState(false);
  const [fullscreenOpenId, setFullscreenOpenId] = useState(0);
  const [avatarModal, setAvatarModal] = useState<{ uri: string; name: string } | null>(null);
  const [pixelLabActiveId, setPixelLabActiveId] =
    useState<PixelLabActionId | null>(null);
  const [forceThinking, setForceThinking] = useState(false);
  const [forcePro, setForcePro] = useState(false);
  const [showExtrasMenu, setShowExtrasMenu] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [globalActive, setGlobalActive] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isAtBottomRef = useRef(true);
  const dragCounterRef = useRef(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const speechRecognitionRef = useRef<any>(null);
  const handleSendRef = useRef<(text?: string) => void>(() => {});
  const abortControllerRef = useRef<AbortController | null>(null);
  const isCancelledRef = useRef(false);
  const currentAiMsgIdRef = useRef<string | null>(null);

  const { aiName, aiPhoto, userPhoto, loadSettings, activeCharacterId, llmProvider } =
    useSettingsStore();

  const showToolActivity = useCallback((toolName: string, detail?: string) => {
    if (activityErrorTimerRef.current) {
      clearTimeout(activityErrorTimerRef.current);
      activityErrorTimerRef.current = null;
    }
    setActivity({
      key: newId(),
      kind: "tool",
      toolName,
      label: TOOL_ACTIVITY_LABELS[toolName] ?? "processing...",
      detail,
    });
  }, []);

  const showToolError = useCallback((toolName: string, message: string) => {
    if (activityErrorTimerRef.current) clearTimeout(activityErrorTimerRef.current);
    const key = newId();
    setActivity({
      key,
      kind: "error",
      toolName,
      label: TOOL_ERROR_LABELS[toolName] ?? "something went wrong",
      detail: message,
    });
    activityErrorTimerRef.current = window.setTimeout(() => {
      setActivity((cur) => (cur?.key === key ? null : cur));
      activityErrorTimerRef.current = null;
    }, 3200);
  }, []);

  const clearToolActivity = useCallback(() => {
    setActivity((cur) => (cur?.kind === "error" ? cur : null));
  }, []);

  const forceClearToolActivity = useCallback(() => {
    if (activityErrorTimerRef.current) {
      clearTimeout(activityErrorTimerRef.current);
      activityErrorTimerRef.current = null;
    }
    setActivity(null);
  }, []);

  const lastChatKey = useCallback(
    (charId: string | null) => `elfie_last_chat_${charId ?? "default"}`,
    [],
  );

  const handleScroll = useCallback(() => {
    if (!listRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = listRef.current;
    isAtBottomRef.current = scrollHeight - scrollTop - clientHeight < 100;
  }, []);

  const scrollToBottom = useCallback(() => {
    if (listRef.current)
      listRef.current.scrollTop = listRef.current.scrollHeight;
  }, []);

  useEffect(() => {
    if (isAtBottomRef.current) scrollToBottom();
  }, [messages, isAiTyping, scrollToBottom]);

  useEffect(() => {
    scrollToBottom();
  }, [isLoading, scrollToBottom]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/activity/status`);
        const data = await res.json();
        if (!cancelled) setGlobalActive(!!data.active);
      } catch {
      }
    };
    poll();
    const interval = setInterval(poll, 4000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const loadChats = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/chats`);
      const data: ChatMeta[] = await res.json();
      setChats(data);
      useDebugStore.getState().log(`loadChats ok — ${data.length} chat(s)`);
      return data;
    } catch (err) {
      console.error("[loadChats] API_BASE:", API_BASE, "error:", err);
      useDebugStore
        .getState()
        .error(
          `loadChats: ${err instanceof Error ? err.message : String(err)}`,
        );
      return [];
    }
  }, []);

  const createChat = useCallback(async (): Promise<ChatMeta | null> => {
    try {
      const res = await fetch(`${API_BASE}/api/chats`, { method: "POST" });
      const chat: ChatMeta = await res.json();
      setChats((prev) => [chat, ...prev]);
      return chat;
    } catch {
      return null;
    }
  }, []);

  const openChat = useCallback(async (chatId: string) => {
    setActiveChatId(chatId);
    setMessages([]);
    setIsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/chats/${chatId}`);
      const data = await res.json();
      setMessages(toFrontendMessages([...data.messages].reverse()));
    } catch {}
    setIsLoading(false);
  }, []);

  const switchToChat = useCallback(
    async (chatId: string) => {
      if (activeChatId && activeChatId !== chatId) {
        fetch(`${API_BASE}/api/chats/${activeChatId}/summarize`, {
          method: "POST",
        }).catch(() => {});
      }
      await openChat(chatId);
    },
    [activeChatId, openChat],
  );

  const handleNewChat = useCallback(async () => {
    if (activeChatId) {
      fetch(`${API_BASE}/api/chats/${activeChatId}/summarize`, {
        method: "POST",
      }).catch(() => {});
    }
    const chat = await createChat();
    if (chat) {
      setActiveChatId(chat._id);
      setMessages([]);
    }
  }, [createChat, activeChatId]);

  const handleDeleteChat = useCallback(
    async (id: string) => {
      await fetch(`${API_BASE}/api/chats/${id}`, { method: "DELETE" });
      const remaining = chats.filter((c) => c._id !== id);
      setChats(remaining);
      if (activeChatId === id) {
        if (remaining.length > 0) {
          await openChat(remaining[0]._id);
        } else {
          const chat = await createChat();
          if (chat) {
            setActiveChatId(chat._id);
            setMessages([]);
          }
        }
      }
    },
    [activeChatId, chats, createChat, openChat],
  );

  const initChats = useCallback(
    async (charId: string | null) => {
      setIsLoading(true);
      const existing = await loadChats();
      if (existing.length > 0) {
        const savedId = localStorage.getItem(lastChatKey(charId));
        const target =
          savedId && existing.find((c) => c._id === savedId)
            ? savedId
            : existing[0]._id;
        const toSummarize = existing.find((c) => c._id !== target);
        if (toSummarize) {
          fetch(`${API_BASE}/api/chats/${toSummarize._id}/summarize`, {
            method: "POST",
          }).catch(() => {});
        }
        await openChat(target);
      } else {
        const chat = await createChat();
        if (chat) {
          setActiveChatId(chat._id);
          setMessages([]);
        }
      }
      setIsLoading(false);
    },
    [loadChats, createChat, openChat, lastChatKey],
  );

  useEffect(() => {
    (async () => {
      await loadSettings();
      const { activeCharacterId: charId } = useSettingsStore.getState();
      await initChats(charId);
    })();
  }, []);


  const processImageFiles = useCallback((files: File[]) => {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (!images.length) return;
    images.forEach((file) => {
      const uri = URL.createObjectURL(file);
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(",")[1];
        setSelectedImages((prev) => [
          ...prev,
          { uri, base64, mimeType: file.type || "image/jpeg" },
        ]);
      };
      reader.readAsDataURL(file);
    });
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      processImageFiles(Array.from(e.target.files ?? []));
      e.target.value = "";
    },
    [processImageFiles],
  );

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current++;
    const hasImage = Array.from(e.dataTransfer.items).some(
      (item) => item.kind === "file" && item.type.startsWith("image/"),
    );
    if (hasImage) setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragCounterRef.current = 0;
      setIsDragging(false);
      processImageFiles(Array.from(e.dataTransfer.files));
    },
    [processImageFiles],
  );

  const handleRemoveImage = useCallback((index: number) => {
    setSelectedImages((prev) => {
      URL.revokeObjectURL(prev[index].uri);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const openFullscreen = useCallback((filenames: string[], index: number) => {
    setFullscreenUris(filenames.map((f) => `${API_BASE}/files/${f}`));
    setFullscreenIndex(index);
    setShowFullscreen(true);
    setFullscreenOpenId((id) => id + 1);
  }, []);

  const openAvatarModal = useCallback(
    (kind: "ai" | "user") => {
      const filename = kind === "ai" ? aiPhoto : userPhoto;
      if (!filename) return;
      setAvatarModal({
        uri: `${API_BASE}/files/${filename}`,
        name: kind === "ai" ? aiName : "You",
      });
    },
    [aiPhoto, userPhoto, aiName],
  );


  const subscribeToNeuroStream = useCallback(async (chatId: string) => {
    setNeuroRunning(true);
    setNeuroActivity(null);
    setActiveNeuroChatId(chatId);
    let lastMsgId: string | null = null;
    try {
      const response = await fetch(
        `${API_BASE}/api/neuro/session/${chatId}/stream`,
      );
      const reader = response.body?.getReader();
      if (!reader) {
        setNeuroRunning(false);
        setActiveNeuroChatId(null);
        return;
      }
      const decoder = new TextDecoder();
      let buf = "";
      let streamDone = false;
      while (!streamDone) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            if (ev.type === "neuro_tool") {
              setNeuroActivity(ev.label ?? ev.tool ?? "using tool...");
            }
            if (ev.type === "neuro_update" && ev.text) {
              setNeuroActivity(ev.text);
            }
            if (ev.type === "neuro_text" && ev.text) {
              setIsAiTyping(false);
              setNeuroActivity(null);
              const id = newId();
              lastMsgId = id;
              setMessages((prev) => [
                {
                  id,
                  content: ev.text,
                  sender: "ai" as const,
                  createdAt: new Date().toISOString(),
                  isNew: true,
                  fromNeuro: true,
                },
                ...prev,
              ]);
            }
            if (ev.type === "neuro_question" && ev.text) {
              setIsAiTyping(false);
              setNeuroActivity(null);
              const id = newId();
              lastMsgId = id;
              setMessages((prev) => [
                {
                  id,
                  content: ev.text,
                  sender: "ai" as const,
                  createdAt: new Date().toISOString(),
                  isNew: true,
                  fromNeuro: true,
                },
                ...prev,
              ]);
            }
            if (ev.type === "neuro_waiting") {
              setIsAiTyping(false);
              setNeuroActivity(null);
              lastMsgId = null;
            }
            if (ev.type === "neuro_done") {
              setIsAiTyping(false);
              if (lastMsgId) {
                const id = lastMsgId;
                const finalText = ev.text || undefined;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === id
                      ? { ...m, fromNeuro: false, ...(finalText ? { content: finalText } : {}) }
                      : m,
                  ),
                );
                lastMsgId = null;
              }
              setNeuroRunning(false);
              setNeuroActivity(null);
              setActiveNeuroChatId(null);
              streamDone = true;
              break;
            }
            if (ev.type === "neuro_session_ended" || ev.type === "neuro_interrupted") {
              setIsAiTyping(false);
              if (lastMsgId) {
                const id = lastMsgId;
                setMessages((prev) =>
                  prev.map((m) => (m.id === id ? { ...m, fromNeuro: false } : m)),
                );
                lastMsgId = null;
              }
              setNeuroRunning(false);
              setNeuroActivity(null);
              setActiveNeuroChatId(null);
              streamDone = true;
              break;
            }
          } catch {}
        }
      }
      reader.cancel().catch(() => {});
    } catch (err) {
      console.error("[neuro] stream error:", err);
    }
    setNeuroRunning(false);
    setNeuroActivity(null);
    setActiveNeuroChatId(null);
  }, []);


  const handleSendMessage = useCallback(
    async (textOverride?: string) => {
      const text = (textOverride ?? message).trim();
      if ((!text && selectedImages.length === 0) || isAiTyping || !activeChatId)
        return;

      const imagesToSend = selectedImages;
      const currentReplyTo = replyingTo;
      const forcePixelLab = pixelLabActiveId !== null;
      setMessage("");
      setSelectedImages([]);
      setReplyingTo(null);
      setPixelLabActiveId(null);
      setIsAiTyping(true);
      forceClearToolActivity();

      try {
        localStorage.setItem(lastChatKey(activeCharacterId), activeChatId);
      } catch {}

      let currentMsgId = newId();
      let currentBubbleAdded = false;
      let anyBubbleAdded = false;
      let currentBubbleRaw = "";
      let currentBubbleSentUpTo = 0;

      isCancelledRef.current = false;
      currentAiMsgIdRef.current = currentMsgId;

      try {
        let filenames: string[] = [];
        if (imagesToSend.length > 0) {
          const uploadRes = await fetch(`${API_BASE}/api/upload`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              images: imagesToSend.map((img) => ({
                base64: img.base64,
                mimeType: img.mimeType,
              })),
            }),
          });
          const uploadData = await uploadRes.json();
          filenames = uploadData.filenames ?? [];
        }

        const userMsg: Message = {
          id: newId(),
          content: text,
          sender: "user",
          createdAt: new Date().toISOString(),
          isNew: true,
          imageFilenames: filenames.length > 0 ? filenames : undefined,
          replyTo: currentReplyTo
            ? {
                id: currentReplyTo.id,
                content: currentReplyTo.content,
                sender: currentReplyTo.sender,
              }
            : undefined,
        };
        setMessages((prev) => [userMsg, ...prev]);

        const ac = new AbortController();
        abortControllerRef.current = ac;
        const response = await fetch(
          `${API_BASE}/api/chats/${activeChatId}/message`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: text,
              imageFilenames: filenames,
              forcePixelLab,
              forceNeuro: neuroMode,
              forceThinking,
              forcePro,
            }),
            signal: ac.signal,
          },
        );

        const reader = response.body?.getReader();
        if (!reader) throw new Error("No response body");
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const event = JSON.parse(line.slice(6));
              if (event.type === "tool_call" && event.name) {
                showToolActivity(event.name, event.detail);
              }
              if (event.type === "delta" && event.text) {
                currentBubbleRaw += event.text;
                setIsAiTyping(false);
                clearToolActivity();

                for (;;) {
                  const boundary = currentBubbleRaw.match(/\n{2,}/);
                  if (!boundary || boundary.index === undefined) break;
                  const finishedRaw = currentBubbleRaw.slice(0, boundary.index);
                  const restRaw = currentBubbleRaw.slice(boundary.index + boundary[0].length);
                  const finishedClean = sanitizeAiText(finishedRaw);
                  const finishedId = currentMsgId;
                  if (finishedClean) {
                    currentBubbleAdded = true;
                    anyBubbleAdded = true;
                    setMessages((prev) => {
                      const existing = prev.find((m) => m.id === finishedId);
                      if (existing)
                        return prev.map((m) =>
                          m.id === finishedId ? { ...m, content: finishedClean } : m,
                        );
                      return [
                        {
                          id: finishedId,
                          content: finishedClean,
                          sender: "ai",
                          createdAt: new Date().toISOString(),
                          isNew: true,
                        },
                        ...prev,
                      ];
                    });
                  }
                  currentMsgId = newId();
                  currentAiMsgIdRef.current = currentMsgId;
                  currentBubbleAdded = false;
                  currentBubbleRaw = restRaw;
                  currentBubbleSentUpTo = 0;
                }

                const HOLDBACK = 4;
                const safeUpTo = Math.max(0, currentBubbleRaw.length - HOLDBACK);
                if (safeUpTo > currentBubbleSentUpTo) {
                  const piece = sanitizeAiTextChunk(
                    currentBubbleRaw.slice(currentBubbleSentUpTo, safeUpTo),
                  );
                  currentBubbleSentUpTo = safeUpTo;
                  const msgId = currentMsgId;
                  if (!currentBubbleAdded) {
                    currentBubbleAdded = true;
                    anyBubbleAdded = true;
                    setMessages((prev) => {
                      const existing = prev.find((m) => m.id === msgId);
                      if (existing)
                        return prev.map((m) =>
                          m.id === msgId ? { ...m, content: m.content + piece } : m,
                        );
                      return [
                        {
                          id: msgId,
                          content: piece.replace(/^\s+/, ""),
                          sender: "ai",
                          createdAt: new Date().toISOString(),
                          isNew: true,
                        },
                        ...prev,
                      ];
                    });
                  } else {
                    setMessages((prev) =>
                      prev.map((m) =>
                        m.id === msgId ? { ...m, content: m.content + piece } : m,
                      ),
                    );
                  }
                }
              }
              if (
                event.type === "search_results" &&
                Array.isArray(event.sources) &&
                event.sources.length > 0
              ) {
                setMessages((prev) => {
                  const hasMsg = prev.some((m) => m.id === currentMsgId);
                  if (hasMsg)
                    return prev.map((m) =>
                      m.id === currentMsgId
                        ? { ...m, searchSources: [...(m.searchSources ?? []), ...event.sources] }
                        : m,
                    );
                  return [
                    {
                      id: currentMsgId,
                      content: "",
                      sender: "ai",
                      createdAt: new Date().toISOString(),
                      isNew: true,
                      searchSources: event.sources,
                    },
                    ...prev,
                  ];
                });
              }
              if (
                event.type === "product_cards" &&
                Array.isArray(event.cards) &&
                event.cards.length > 0
              ) {
                setMessages((prev) => {
                  const hasMsg = prev.some((m) => m.id === currentMsgId);
                  if (hasMsg)
                    return prev.map((m) =>
                      m.id === currentMsgId
                        ? { ...m, productCards: [...(m.productCards ?? []), ...event.cards] }
                        : m,
                    );
                  return [
                    {
                      id: currentMsgId,
                      content: "",
                      sender: "ai",
                      createdAt: new Date().toISOString(),
                      isNew: true,
                      productCards: event.cards,
                    },
                    ...prev,
                  ];
                });
              }
              if (event.type === "confirmation_required" && event.confirmationId) {
                setIsAiTyping(false);
                clearToolActivity();
                setMessages((prev) => [
                  {
                    id: newId(),
                    content: "",
                    sender: "ai",
                    createdAt: new Date().toISOString(),
                    isNew: true,
                    pendingConfirmation: {
                      confirmationId: event.confirmationId,
                      skillName: event.skillName,
                      skillDescription: event.skillDescription,
                      args: event.args ?? {},
                    },
                  },
                  ...prev,
                ]);
              }
              if (event.type === "confirmation_resolved" && event.confirmationId) {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.pendingConfirmation?.confirmationId === event.confirmationId
                      ? {
                          ...m,
                          pendingConfirmation: {
                            ...m.pendingConfirmation,
                            decision: event.decision,
                            feedback: event.feedback,
                          } as Message["pendingConfirmation"],
                        }
                      : m,
                  ),
                );
              }
              if (
                event.type === "generated_images" &&
                Array.isArray(event.filenames) &&
                event.filenames.length > 0
              ) {
                if (!currentBubbleAdded) {
                  currentBubbleAdded = true;
                  anyBubbleAdded = true;
                  setIsAiTyping(false);
                  setMessages((prev) => {
                    if (prev.some((m) => m.id === currentMsgId)) return prev;
                    return [
                      {
                        id: currentMsgId,
                        content: "",
                        sender: "ai",
                        createdAt: new Date().toISOString(),
                        isNew: true,
                        imageFilenames: Array.from(new Set(event.filenames)),
                      },
                      ...prev,
                    ];
                  });
                } else {
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === currentMsgId
                        ? {
                            ...m,
                            imageFilenames: Array.from(
                              new Set([...(m.imageFilenames ?? []), ...event.filenames]),
                            ),
                          }
                        : m,
                    ),
                  );
                }
              }
              if (event.type === "reaction_gif" && (event.url || event.mp4)) {
                setMessages((prev) => {
                  const hasMsg = prev.some((m) => m.id === currentMsgId);
                  const gif: Gif = { url: event.url ?? null, mp4: event.mp4 ?? null };
                  if (hasMsg)
                    return prev.map((m) =>
                      m.id === currentMsgId
                        ? { ...m, gifs: [...(m.gifs ?? []), gif] }
                        : m,
                    );
                  return [
                    {
                      id: currentMsgId,
                      content: "",
                      sender: "ai",
                      createdAt: new Date().toISOString(),
                      isNew: true,
                      gifs: [gif],
                    },
                    ...prev,
                  ];
                });
              }
              if (event.type === "voice_note" && event.filename) {
                setIsAiTyping(false);
                setMessages((prev) => {
                  const hasMsg = prev.some((m) => m.id === currentMsgId);
                  const vn: VoiceNote = { filename: event.filename };
                  if (hasMsg)
                    return prev.map((m) =>
                      m.id === currentMsgId
                        ? { ...m, voiceNotes: [...(m.voiceNotes ?? []), vn] }
                        : m,
                    );
                  return [
                    {
                      id: currentMsgId,
                      content: "",
                      sender: "ai",
                      createdAt: new Date().toISOString(),
                      isNew: true,
                      voiceNotes: [vn],
                    },
                    ...prev,
                  ];
                });
              }
              if (event.type === "tool_error") {
                showToolError(event.tool ?? "erro", event.message ?? "something went wrong");
                const toolError = { tool: event.tool, message: event.message };
                setMessages((prev) => {
                  const hasMsg = prev.some((m) => m.id === currentMsgId);
                  if (hasMsg)
                    return prev.map((m) =>
                      m.id === currentMsgId
                        ? { ...m, toolErrors: [...(m.toolErrors ?? []), toolError] }
                        : m,
                    );
                  return [
                    {
                      id: currentMsgId,
                      content: "",
                      sender: "ai",
                      createdAt: new Date().toISOString(),
                      isNew: true,
                      toolErrors: [toolError],
                    },
                    ...prev,
                  ];
                });
              }
              if (event.type === "neuro_confirm") {
                setIsAiTyping(false);
                currentBubbleAdded = true;
                anyBubbleAdded = true;
                setMessages((prev) => [
                  {
                    id: currentMsgId,
                    content: "",
                    sender: "ai",
                    createdAt: new Date().toISOString(),
                    isNew: true,
                    neuroType: "confirm",
                    neuroTaskId: event.taskId,
                    neuroText: event.confirmText,
                  },
                  ...prev,
                ]);
              }
              if (event.type === "neuro_started") {
                setIsAiTyping(false);
                currentBubbleAdded = true;
                subscribeToNeuroStream(event.chatId);
              }
              if (event.type === "error") {
                setIsAiTyping(false);
                showToolError("erro", event.message ?? "Unknown error");
                const errEntry = { tool: "erro", message: event.message ?? "Unknown error" };
                setMessages((prev) => {
                  const hasMsg = prev.some((m) => m.id === currentMsgId);
                  if (hasMsg)
                    return prev.map((m) =>
                      m.id === currentMsgId
                        ? { ...m, toolErrors: [...(m.toolErrors ?? []), errEntry] }
                        : m,
                    );
                  return [
                    {
                      id: currentMsgId,
                      content: "",
                      sender: "ai",
                      createdAt: new Date().toISOString(),
                      isNew: true,
                      toolErrors: [errEntry],
                    },
                    ...prev,
                  ];
                });
                currentAiMsgIdRef.current = null;
              }
              if (event.type === "chat_title" && event.chatTitle) {
                setChats((prev) =>
                  prev.map((c) =>
                    c._id === activeChatId ? { ...c, title: event.chatTitle } : c,
                  ),
                );
              }
              if (event.type === "done") {
                clearToolActivity();
                if (event.chatTitle)
                  setChats((prev) =>
                    prev.map((c) =>
                      c._id === activeChatId
                        ? { ...c, title: event.chatTitle }
                        : c,
                    ),
                  );
                const finalClean = sanitizeAiText(currentBubbleRaw);
                const doneId = currentMsgId;
                setMessages((prev) => {
                  const existing = prev.find((m) => m.id === doneId);
                  const meta = { savedMemory: event.savedMemory ?? false, toolsUsed: event.toolsUsed ?? [] };
                  if (existing)
                    return prev.map((m) =>
                      m.id === doneId
                        ? { ...m, ...(finalClean ? { content: finalClean } : {}), ...meta }
                        : m,
                    );
                  if (!finalClean) return prev;
                  return [
                    { id: doneId, content: finalClean, sender: "ai", createdAt: new Date().toISOString(), isNew: true, ...meta },
                    ...prev,
                  ];
                });
                currentAiMsgIdRef.current = null;
              }
            } catch {}
          }
        }
      } catch (err) {
        if (isCancelledRef.current || (err instanceof Error && err.name === "AbortError")) {
          setIsAiTyping(false);
          forceClearToolActivity();
          currentAiMsgIdRef.current = null;
          return;
        }
        console.error("API error:", err);
        useDebugStore
          .getState()
          .error(
            `sendMessage: ${err instanceof Error ? err.message : String(err)}`,
          );
        setIsAiTyping(false);
        forceClearToolActivity();
        if (!anyBubbleAdded) {
          setMessages((prev) => [
            {
              id: currentMsgId,
              content: "Connection error. Please try again.",
              sender: "ai",
              createdAt: new Date().toISOString(),
            },
            ...prev,
          ]);
        }
      }
    },
    [
      message,
      selectedImages,
      isAiTyping,
      replyingTo,
      activeChatId,
      activeCharacterId,
      lastChatKey,
      subscribeToNeuroStream,
      neuroMode,
      pixelLabActiveId,
      forceThinking,
      forcePro,
      showToolActivity,
      showToolError,
      clearToolActivity,
      forceClearToolActivity,
    ],
  );

  useEffect(() => {
    handleSendRef.current = handleSendMessage;
  }, [handleSendMessage]);

  const stopAllFetch = useCallback(async () => {
    try {
      await fetch(`${API_BASE}/api/activity/stop-all`, { method: "POST" });
    } catch (err) {
      console.error("[stop-all]", err);
    } finally {
      setGlobalActive(false);
    }
  }, []);

  const handleCancelResponse = useCallback(() => {
    isCancelledRef.current = true;
    abortControllerRef.current?.abort();
    setIsAiTyping(false);
    forceClearToolActivity();
    const cancelledMsgId = currentAiMsgIdRef.current;
    if (cancelledMsgId) {
      setMessages((prev) => prev.filter((m) => m.id !== cancelledMsgId));
      currentAiMsgIdRef.current = null;
    }
    setMessages((prev) => [
      {
        id: newId(),
        content: "",
        sender: "ai" as const,
        createdAt: new Date().toISOString(),
        isCancelled: true,
        isNew: true,
      },
      ...prev,
    ]);
    stopAllFetch();
  }, [forceClearToolActivity, stopAllFetch]);

  const toggleVoice = useCallback(async () => {
    if (isRecording) {
      mediaRecorderRef.current?.stop();
      speechRecognitionRef.current?.stop();
      speechRecognitionRef.current = null;
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return;
    }

    const SR =
      (window as any).SpeechRecognition ??
      (window as any).webkitSpeechRecognition;
    if (SR) {
      const recognition = new SR();
      recognition.lang = "pt-BR";
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.onresult = (e: any) => {
        let t = "";
        for (let i = 0; i < e.results.length; i++)
          t += e.results[i][0].transcript;
        setMessage(t);
      };
      recognition.onerror = () => {};
      recognition.onend = () => {
        if (mediaRecorderRef.current?.state === "recording") {
          try {
            recognition.start();
          } catch {}
        }
      };
      speechRecognitionRef.current = recognition;
      recognition.start();
    }

    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream);

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      setIsRecording(false);
      setMessage("");
      setIsTranscribing(true);
      try {
        const blob = new Blob(chunks, { type: recorder.mimeType });
        const arrayBuffer = await blob.arrayBuffer();

        const audioCtx = new AudioContext();
        const decoded = await audioCtx.decodeAudioData(arrayBuffer);
        await audioCtx.close();

        const targetSR = 16000;
        const offlineCtx = new OfflineAudioContext(
          1,
          Math.ceil(decoded.duration * targetSR),
          targetSR,
        );
        const src = offlineCtx.createBufferSource();
        src.buffer = decoded;
        src.connect(offlineCtx.destination);
        src.start();
        const resampled = await offlineCtx.startRendering();
        const pcm = resampled.getChannelData(0);

        const formData = new FormData();
        formData.append(
          "audio",
          new Blob([encodeWav(pcm, targetSR)], { type: "audio/wav" }),
          "audio.wav",
        );

        const res = await fetch(`${API_BASE}/api/transcribe`, {
          method: "POST",
          body: formData,
        });
        const data = await res.json();
        const transcript = (data.transcript ?? "").trim();
        if (transcript) handleSendRef.current(transcript);
      } catch (err) {
        console.error("[voice]", err);
      } finally {
        setIsTranscribing(false);
      }
    };

    mediaRecorderRef.current = recorder;
    recorder.start();
    setIsRecording(true);
  }, [isRecording]);

  const handleNeuroConfirm = useCallback(
    async (taskId: string, confirmed: boolean) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.neuroTaskId === taskId ? { ...m, neuroConfirmed: true } : m,
        ),
      );
      if (!confirmed) return;
      try {
        await fetch(`${API_BASE}/api/neuro/${taskId}/confirm`, {
          method: "POST",
        });
      } catch (err) {
        console.error("[neuro] confirm error:", err);
        return;
      }
      subscribeToNeuroStream(taskId);
    },
    [subscribeToNeuroStream],
  );

  const handleSkillConfirmation = useCallback(
    async (confirmationId: string, action: "approve" | "reject", feedback?: string) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.pendingConfirmation?.confirmationId === confirmationId
            ? {
                ...m,
                pendingConfirmation: {
                  ...m.pendingConfirmation,
                  decision: action === "approve" ? "approved" : "rejected",
                  feedback,
                } as Message["pendingConfirmation"],
              }
            : m,
        ),
      );
      if (!activeChatId) return;
      try {
        await fetch(
          `${API_BASE}/api/chats/${activeChatId}/confirmations/${confirmationId}/resolve`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action, feedback }),
          },
        );
      } catch (err) {
        console.error("[skill confirmation] resolve error:", err);
      }
    },
    [activeChatId],
  );

  const handleReply = useCallback((msg: Message) => {
    setReplyingTo(msg);
    textareaRef.current?.focus();
  }, []);

  const handleEditOpen = useCallback((msg: Message) => {
    setSelectedMessage(msg);
    setEditMessageText(msg.content);
    setShowEditModal(true);
  }, []);

  const handleEditConfirm = useCallback(async () => {
    if (!selectedMessage || !editMessageText.trim()) return;
    setShowEditModal(false);
    try {
      await fetch(`${API_BASE}/api/messages/${selectedMessage.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: editMessageText.trim() }),
      });
      setMessages((prev) =>
        prev.map((m) =>
          m.id === selectedMessage.id
            ? { ...m, content: editMessageText.trim(), isEdited: true }
            : m,
        ),
      );
    } catch (err) {
      console.error("[editMessage]", err);
    }
  }, [selectedMessage, editMessageText]);

  const handleDeleteOpen = useCallback((msg: Message) => {
    setSelectedMessage(msg);
    setShowDeleteModal(true);
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    if (!selectedMessage) return;
    setShowDeleteModal(false);
    try {
      await fetch(`${API_BASE}/api/messages/${selectedMessage.id}`, {
        method: "DELETE",
      });
      setMessages((prev) => prev.filter((m) => m.id !== selectedMessage.id));
    } catch (err) {
      console.error("[deleteMessage]", err);
    }
  }, [selectedMessage]);


  useEffect(() => {
    const el = textareaRef.current;
    if (!el || !isRecording) return;
    el.style.height = "auto";
    el.style.height = Math.min(Math.max(el.scrollHeight, 80), 200) + "px";
  }, [message, isRecording]);

  const handleTextareaChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setMessage(e.target.value);
      e.target.style.height = "auto";
      e.target.style.height =
        Math.min(Math.max(e.target.scrollHeight, 80), 200) + "px";
    },
    [],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSendMessage();
      }
    },
    [handleSendMessage],
  );


  const activeChat = chats.find((c) => c._id === activeChatId);
  const lastAiMessage = [...messages].reverse().find((m) => m.sender === "ai");
  const currentEmotion = detectEmotion(lastAiMessage);

  return (
    <div
      className="flex bg-background"
      style={{ height: "100vh", overflow: "hidden" }}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div
          className="fixed inset-0 flex items-center justify-center pointer-events-none"
          style={{
            zIndex: 100,
            backgroundColor: "rgba(23,23,28,0.82)",
            backdropFilter: "blur(6px)",
          }}
        >
          <div
            className="flex flex-col items-center gap-3 rounded-3xl border border-tertiary px-16 py-12"
            style={{ backgroundColor: "rgba(30,30,37,0.7)" }}
          >
            <div className="w-14 h-14 rounded-2xl bg-foreground flex items-center justify-center">
              <Image size={24} color="#8e8e93" />
            </div>
            <div className="text-center">
              <p className="text-white font-semibold" style={{ fontSize: 15 }}>
                Drop to add
              </p>
              <p className="text-gray-500 mt-1" style={{ fontSize: 12 }}>
                to the open conversation
              </p>
            </div>
          </div>
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={handleFileChange}
      />

      <ChatsDrawer
        chats={chats}
        activeChatId={activeChatId}
        onSelectChat={switchToChat}
        onNewChat={handleNewChat}
        onDeleteChat={handleDeleteChat}
        onOpenSettings={() => setShowSettings(true)}
        onOpenAiPhoto={() => openAvatarModal("ai")}
      />

      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex items-center px-6 py-2.5 border-b border-border flex-shrink-0 gap-3">
          <div className="relative w-10 h-10 flex-shrink-0">
            <motion.button
              onClick={() => openAvatarModal("ai")}
              whileHover={aiPhoto ? { scale: 1.06 } : undefined}
              whileTap={aiPhoto ? { scale: 0.94 } : undefined}
              className="w-10 h-10 rounded-full overflow-hidden bg-foreground flex items-center justify-center border-none p-0 cursor-pointer"
            >
              {aiPhoto ? (
                <img
                  src={`${API_BASE}/files/${aiPhoto}`}
                  className="w-10 h-10 object-cover"
                  alt=""
                />
              ) : (
                <div className="w-7 h-7 rounded-full bg-accent flex items-center justify-center">
                  <span className="text-white text-[10px] font-bold">AI</span>
                </div>
              )}
            </motion.button>
            <AnimatePresence mode="wait">
              <motion.div
                key={currentEmotion.key}
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0, opacity: 0 }}
                transition={{ type: "spring", stiffness: 500, damping: 26 }}
                className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-background flex items-center justify-center"
                style={{ fontSize: 9, lineHeight: 1 }}
                title={currentEmotion.key}
              >
                {currentEmotion.emoji}
              </motion.div>
            </AnimatePresence>
          </div>
          <div className="min-w-0 flex-1">
            <span className="text-white font-bold text-[13px] block">
              {aiName}
            </span>
            {activeChat && (
              <span className="text-gray-300 font-medium text-[11px] block truncate">
                {activeChat.title}
              </span>
            )}
          </div>
          {activeChatId && (
            <button
              onClick={() => setShowCall(true)}
              className="w-8 h-8 rounded-full flex items-center justify-center border-none cursor-pointer hover:bg-foreground transition-colors"
              style={{ background: "transparent" }}
              title="Call"
            >
              <Phone size={16} color="#fff" />
            </button>
          )}
        </div>

        <div
          ref={listRef}
          className="chat-messages flex-1 overflow-y-auto"
          onScroll={handleScroll}
        >
          <div className="max-w-[800px] mx-auto w-full px-4 py-2">
            {isLoading ? (
              <ChatSkeleton />
            ) : (
              [...messages]
                .reverse()
                .map((item, idx, arr) => {
                  const prev = arr[idx - 1];
                  const next = arr[idx + 1];
                  const hideAvatar = item.neuroType !== "confirm" && !item.fromNeuro && !item.pendingConfirmation && prev?.sender === item.sender;
                  const isLastInGroup = !next || next.sender !== item.sender || next.neuroType === "confirm" || !!next.pendingConfirmation;
                  if (item.isCancelled) {
                    return (
                      <div key={item.id} className="flex items-center justify-center my-2">
                        <div className="flex items-center gap-1.5 px-3 py-1 rounded-full" style={{ backgroundColor: "#1a1a24" }}>
                          <X size={9} color="#6b7280" />
                          <span style={{ fontSize: 10, color: "#6b7280", fontWeight: 600 }}>response cancelled</span>
                        </div>
                      </div>
                    );
                  }
                  if (item.pendingConfirmation) {
                    return (
                      <SkillConfirmationMessage
                        key={item.id}
                        item={item}
                        onResolve={handleSkillConfirmation}
                        onAvatarPress={openAvatarModal}
                      />
                    );
                  }
                  return item.neuroType === "confirm" ? (
                    <NeuroMessage
                      key={item.id}
                      item={item}
                      onConfirm={handleNeuroConfirm}
                      onAvatarPress={openAvatarModal}
                    />
                  ) : (
                    <MessageItem
                      key={item.id}
                      item={item}
                      hideAvatar={hideAvatar}
                      isLastInGroup={isLastInGroup}
                      onReply={handleReply}
                      onEdit={handleEditOpen}
                      onDelete={handleDeleteOpen}
                      onImagePress={openFullscreen}
                      onAvatarPress={openAvatarModal}
                    />
                  );
                })
            )}
            {isAiTyping && <TypingIndicator />}
          </div>
        </div>

        <AnimatePresence>
          {activity && (
            <motion.div
              key={activity.key}
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="flex-shrink-0 overflow-hidden"
            >
              <div className="px-4 py-1.5">
                <div className="max-w-[800px] mx-auto">
                  <ToolActivityPill activity={activity} />
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {neuroRunning && (
          <div className="flex-shrink-0 px-4 py-1.5">
            <div className="max-w-[800px] mx-auto">
              <div
                className="flex items-center gap-2 px-3 py-1.5 rounded-full"
                style={{ background: "#1e1e2e", width: "fit-content" }}
              >
                <span
                  className="neuro-pulse"
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: "var(--accent)",
                    display: "inline-block",
                  }}
                />
                <span
                  style={{ fontSize: 11, color: "#9ca3af", fontWeight: 700 }}
                >
                  {neuroActivity ?? "Neuro running"}
                </span>
                {activeNeuroChatId && (
                  <button
                    onClick={async () => {
                      try {
                        await fetch(
                          `${API_BASE}/api/neuro/session/${activeNeuroChatId}`,
                          { method: "DELETE" },
                        );
                      } catch (err) {
                        console.error("[neuro] stop error:", err);
                      }
                    }}
                    className="border-none bg-transparent cursor-pointer p-0 ml-1"
                    style={{ fontSize: 10, color: "#f87171", fontWeight: 700 }}
                    title="Stop Neuro"
                  >
                    stop
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        <div className="flex-shrink-0">
          <div className="max-w-[800px] mx-auto w-full">
            <ReplyPreview
              replyingTo={replyingTo}
              onCancel={() => setReplyingTo(null)}
            />
            <ImagePreviewStrip
              images={selectedImages}
              onRemove={handleRemoveImage}
            />
          </div>
        </div>

        <div className="flex-shrink-0 px-4 pb-4 pt-2">
          <div className="max-w-[800px] mx-auto w-full">
            <div className="bg-foreground rounded-2xl px-4 pt-3 pb-3 border border-border">
              <textarea
                ref={textareaRef}
                value={message}
                onChange={handleTextareaChange}
                onKeyDown={handleKeyDown}
                placeholder="Message..."
                className="w-full text-white border-none outline-none resize-none text-[14px] leading-[1.4] bg-transparent block"
                style={{
                  minHeight: 80,
                  maxHeight: 200,
                  color: "#fff",
                  caretColor: "var(--accent)",
                }}
                rows={3}
              />
              <div className="flex items-center mt-2">
                <div className="flex items-center gap-2">
                  <motion.button
                    onClick={() => fileInputRef.current?.click()}
                    whileHover={{ scale: 1.1 }}
                    whileTap={{ scale: 0.9 }}
                    title="Attach image"
                    className="p-2 rounded-full border-none bg-transparent cursor-pointer hover:bg-white/5 transition-colors"
                  >
                    <Plus size={15} color="#6b7280" />
                  </motion.button>

                  <div className="relative">
                    <motion.button
                      onClick={() => setShowExtrasMenu((v) => !v)}
                      whileHover={{ scale: 1.1 }}
                      whileTap={{ scale: 0.9 }}
                      title="More options"
                      className="p-2 rounded-full border-none bg-transparent cursor-pointer hover:bg-white/5 transition-colors"
                    >
                      <Sparkles
                        size={15}
                        color={pixelLabActiveId !== null || neuroMode || forceThinking || forcePro ? "var(--accent)" : "#6b7280"}
                      />
                    </motion.button>

                    <AnimatePresence>
                      {showExtrasMenu && (
                        <>
                          <motion.div
                            className="fixed inset-0 z-40"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            onClick={() => setShowExtrasMenu(false)}
                          />
                          <motion.div
                            variants={extrasMenuVariants}
                            initial="hidden"
                            animate="visible"
                            exit="exit"
                            style={{ transformOrigin: "bottom left" }}
                            className="absolute bottom-full left-0 mb-2 w-40 rounded-xl bg-foreground border border-border overflow-hidden z-50 shadow-2xl"
                          >
                            <motion.button
                              variants={extrasItemVariants}
                              onClick={() => {
                                setNeuroMode((v) => !v);
                                setShowExtrasMenu(false);
                              }}
                              whileHover={{ backgroundColor: "rgba(255,255,255,0.06)" }}
                              className="flex items-center gap-2.5 w-full px-3 py-2 border-none bg-transparent cursor-pointer text-left"
                            >
                              <span style={{ fontSize: 12, lineHeight: 1, opacity: neuroMode ? 1 : 0.6 }}>⚡</span>
                              <span className="flex-1 min-w-0 text-[12px] text-gray-200 font-bold truncate">Neuro</span>
                              {neuroMode && <div className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />}
                            </motion.button>
                            <motion.button
                              variants={extrasItemVariants}
                              onClick={() => {
                                setForceThinking((v) => !v);
                                setShowExtrasMenu(false);
                              }}
                              whileHover={{ backgroundColor: "rgba(255,255,255,0.06)" }}
                              className="flex items-center gap-2.5 w-full px-3 py-2 border-none bg-transparent cursor-pointer text-left"
                            >
                              <Brain
                                size={12}
                                color={forceThinking ? "var(--accent)" : "#9ca3af"}
                                style={{ opacity: forceThinking ? 1 : 0.6 }}
                              />
                              <span className="flex-1 min-w-0 text-[12px] text-gray-200 font-bold truncate">Think</span>
                              {forceThinking && (
                                <div className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />
                              )}
                            </motion.button>
                            {llmProvider === "deepseek" && (
                              <motion.button
                                variants={extrasItemVariants}
                                onClick={() => {
                                  setForcePro((v) => !v);
                                  setShowExtrasMenu(false);
                                }}
                                whileHover={{ backgroundColor: "rgba(255,255,255,0.06)" }}
                                className="flex items-center gap-2.5 w-full px-3 py-2 border-none bg-transparent cursor-pointer text-left"
                              >
                                <Rocket
                                  size={12}
                                  color={forcePro ? "var(--accent)" : "#9ca3af"}
                                  style={{ opacity: forcePro ? 1 : 0.6 }}
                                />
                                <span className="flex-1 min-w-0 text-[12px] text-gray-200 font-bold truncate">Pro</span>
                                {forcePro && (
                                  <div className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />
                                )}
                              </motion.button>
                            )}
                          </motion.div>
                        </>
                      )}
                    </AnimatePresence>
                  </div>
                </div>

                <div className="flex-1" />

                <div
                  style={{
                    width: 1,
                    height: 16,
                    background: "#2a2a3a",
                    marginRight: 10,
                  }}
                />

                <div className="flex items-center gap-2.5">
                  <motion.button
                    onClick={toggleVoice}
                    disabled={isTranscribing}
                    whileHover={{ scale: 1.08 }}
                    whileTap={{ scale: 0.9 }}
                    title={
                      isRecording
                        ? "Stop"
                        : isTranscribing
                          ? "Transcribing…"
                          : "Record"
                    }
                    className={`w-8 h-8 rounded-full flex items-center justify-center border-none cursor-pointer ${isRecording ? "mic-pulse" : ""}`}
                    style={{
                      background: isRecording ? "var(--accent)" : "#16161f",
                      opacity: isTranscribing ? 0.4 : 1,
                      transition: "background-color 0.2s, opacity 0.2s",
                    }}
                  >
                    <Mic size={14} color={isRecording ? "#fff" : "#6b7280"} />
                  </motion.button>
                  <AnimatePresence mode="wait" initial={false}>
                    {isAiTyping || globalActive ? (
                      <motion.button
                        key="stop"
                        onClick={isAiTyping ? handleCancelResponse : stopAllFetch}
                        initial={{ opacity: 0, scale: 0.7 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.7 }}
                        transition={{ type: "spring", stiffness: 500, damping: 28 }}
                        whileHover={{ scale: 1.08 }}
                        whileTap={{ scale: 0.9 }}
                        className="w-8 h-8 rounded-full flex items-center justify-center border-none cursor-pointer"
                        style={{ background: "#2a1a1a" }}
                        title="Stop all"
                      >
                        <Square size={13} color="#ef4444" />
                      </motion.button>
                    ) : (
                      <motion.button
                        key="send"
                        onClick={() => handleSendMessage()}
                        disabled={!message.trim() && selectedImages.length === 0}
                        initial={{ opacity: 0, scale: 0.7 }}
                        animate={{
                          opacity: 1,
                          scale: 1,
                          backgroundColor: (!message.trim() && selectedImages.length === 0) ? "#16161f" : "var(--accent)",
                        }}
                        exit={{ opacity: 0, scale: 0.7 }}
                        transition={{ type: "spring", stiffness: 500, damping: 28 }}
                        whileHover={{ scale: 1.08 }}
                        whileTap={{ scale: 0.9 }}
                        className="w-8 h-8 rounded-full flex items-center justify-center border-none cursor-pointer disabled:cursor-default"
                        title="Send"
                      >
                        <Send size={14} color="#fff" />
                      </motion.button>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <SettingsScreen
        visible={showSettings}
        onClose={() => setShowSettings(false)}
      />

      <AnimatePresence>
        {showCall && activeChatId && (
          <CallOverlay
            chatId={activeChatId}
            characterName={aiName}
            characterAvatar={aiPhoto ? `${API_BASE}/files/${aiPhoto}` : null}
            onClose={() => setShowCall(false)}
          />
        )}
      </AnimatePresence>

      <DeleteMessageModal
        visible={showDeleteModal}
        onConfirm={handleDeleteConfirm}
        onCancel={() => setShowDeleteModal(false)}
      />
      <EditMessageModal
        visible={showEditModal}
        value={editMessageText}
        onChange={setEditMessageText}
        onConfirm={handleEditConfirm}
        onCancel={() => setShowEditModal(false)}
      />
      <ImageFullscreenModal
        key={fullscreenOpenId}
        visible={showFullscreen}
        uris={fullscreenUris}
        initialIndex={fullscreenIndex}
        onClose={() => setShowFullscreen(false)}
      />
      <AvatarPhotoModal avatar={avatarModal} onClose={() => setAvatarModal(null)} />
    </div>
  );
}
