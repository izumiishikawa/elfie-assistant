import { BookOpen, Brain, Bug, Check, CheckCircle2, ChevronDown, ChevronLeft, Clock, Copy, Cpu, Eye, ExternalLink, FileText, Folder, MapPin, Mic, Network, Package, Palette, Pencil, Play, Plug, Plus, RefreshCw, Search, Send, Trash2, Unlink, User, Users, Webhook, Workflow as FlowIcon, X } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import DebugPanel from '../components/DebugPanel';
import SkillNeuronGraph from '../components/SkillNeuronGraph';
import { GmailIcon, GoogleCalendarIcon, GoogleDriveIcon, GooglePlayIcon } from '../components/icons/GoogleBrandIcons';
import { TelegramIcon } from '../components/icons/TelegramIcon';
import { API_BASE } from '../constants';
import { useDebugStore } from '../stores/debugStore';
import { Integration, IntegrationService, useIntegrationsStore } from '../stores/integrationsStore';
import { Character, useSettingsStore } from '../stores/mainStore';
import {
  Skill, SkillAuthType, SkillHeader, SkillMethod, SkillPackage, SkillParam, SkillParamLocation, SkillParamType,
  SkillResponseMode, useSkillsStore,
} from '../stores/skillsStore';
import { IngestStatus, KnowledgeFolder, KnowledgeSearchResult, useKnowledgeStore } from '../stores/knowledgeStore';
import { VoicePreset, VoiceProvider, useVoicePresetsStore } from '../stores/voicePresetsStore';
import TagChipInput from '../components/TagChipInput';
import { Routine, useRoutinesStore } from '../stores/routinesStore';
import { Workflow, useWorkflowsStore } from '../stores/workflowsStore';
import WorkflowEditor from '../components/WorkflowEditor';

const DEEPSEEK_MODELS = [
  { label: 'DeepSeek Flash', value: 'deepseek-v4-flash' },
  { label: 'DeepSeek Pro', value: 'deepseek-v4-pro' },
];

const PRESET_MODELS = [
  ...DEEPSEEK_MODELS,
  { label: 'GPT-4o', value: 'gpt-4o' },
  { label: 'GPT-4o mini', value: 'gpt-4o-mini' },
  { label: 'Claude 3.5 Sonnet', value: 'anthropic/claude-3-5-sonnet' },
  { label: 'Claude 3 Haiku', value: 'anthropic/claude-3-haiku' },
  { label: 'Gemini 2.0 Flash', value: 'google/gemini-2.0-flash-001' },
  { label: 'Llama 3.1 70B', value: 'meta-llama/llama-3.1-70b-instruct' },
  { label: 'Cydonia 24B', value: 'thedrummer/cydonia-24b-v4.1' },
];

const Spinner = () => (
  <div className="w-4 h-4 rounded-full border-2 border-white border-t-transparent spin" />
);


const Switch = ({ checked, onChange, size = 'md' }: {
  checked: boolean; onChange: () => void; size?: 'sm' | 'md';
}) => {
  const dims = size === 'sm' ? { w: 34, h: 20, thumb: 14 } : { w: 40, h: 24, thumb: 18 };
  const pad = (dims.h - dims.thumb) / 2;
  return (
    <motion.button
      type="button"
      onClick={onChange}
      whileTap={{ scale: 0.92 }}
      className="relative rounded-full border-none cursor-pointer p-0 flex-shrink-0"
      style={{ width: dims.w, height: dims.h, backgroundColor: checked ? '#3a3a46' : '#232329' }}
      animate={{ backgroundColor: checked ? '#3a3a46' : '#232329' }}
      transition={{ duration: 0.2 }}
    >
      <motion.div
        className="absolute rounded-full shadow-sm"
        style={{ width: dims.thumb, height: dims.thumb, top: pad }}
        animate={{ x: checked ? dims.w - dims.thumb - pad : pad, backgroundColor: checked ? 'var(--accent)' : '#8a8a94' }}
        transition={{ type: 'spring', stiffness: 500, damping: 32 }}
      />
    </motion.button>
  );
};


const MemoryItem = memo(({ text, onDelete, onEdit }: {
  text: string; onDelete: () => void; onEdit: (t: string) => void;
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);

  const confirm = useCallback(() => {
    if (draft.trim()) onEdit(draft.trim());
    setEditing(false);
  }, [draft, onEdit]);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -12, height: 0, transition: { duration: 0.15 } }}
      transition={{ type: 'spring', stiffness: 420, damping: 40 }}
      className="group flex items-start gap-3 p-4 rounded-2xl bg-foreground hover:bg-foreground/70 overflow-hidden"
      style={{ transition: 'background-color 0.2s' }}
    >
      {editing ? (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={confirm}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); confirm(); } }}
          autoFocus
          className="flex-1 text-white text-[13px] bg-transparent border-none outline-none resize-none leading-5 placeholder:text-gray-400"
        />
      ) : (
        <button
          className="flex-1 text-left bg-transparent border-none cursor-pointer p-0"
          onClick={() => setEditing(true)}
        >
          <span className="text-gray-300 text-[13px] leading-5">{text}</span>
        </button>
      )}
      <motion.button
        onClick={onDelete}
        whileHover={{ scale: 1.15 }}
        whileTap={{ scale: 0.9 }}
        className="bg-transparent border-none cursor-pointer p-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
      >
        <X size={13} color="#ff382b" />
      </motion.button>
    </motion.div>
  );
});


interface ElevenVoice { voice_id: string; name: string; category: string; preview_url: string | null; }

const VoicePicker = memo(({ value, onChange, provider }: {
  value: string; onChange: (id: string) => void; provider: 'elevenlabs' | 'fishaudio';
}) => {
  const [voices, setVoices]   = useState<ElevenVoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState<string | null>(null);
  const audioRef              = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch(`${API_BASE}/api/voices?provider=${provider}`)
      .then((r) => r.json())
      .then((d) => setVoices(d.voices ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [provider]);

  const preview = useCallback((voice: ElevenVoice) => {
    if (!voice.preview_url) return;
    if (playing === voice.voice_id) {
      audioRef.current?.pause();
      setPlaying(null);
      return;
    }
    audioRef.current?.pause();
    const audio = new Audio(voice.preview_url);
    audioRef.current = audio;
    audio.onended = () => setPlaying(null);
    audio.play().then(() => setPlaying(voice.voice_id)).catch(() => {});
  }, [playing]);

  if (loading) return <p className="text-gray-400 text-[12px]">Carregando vozes...</p>;
  if (!voices.length) return <p className="text-gray-400 text-[12px]">Nenhuma voz disponível.</p>;

  const grouped = voices.reduce<Record<string, ElevenVoice[]>>((acc, v) => {
    const key = v.category === 'premade' ? 'Padrão' : 'Suas vozes';
    (acc[key] ??= []).push(v);
    return acc;
  }, {});

  return (
    <div className="flex flex-col max-h-64 overflow-y-auto rounded-2xl border border-foreground bg-foreground">
      {Object.entries(grouped).map(([group, list]) => (
        <div key={group}>
          <p className="text-gray-400 text-[9px] font-bold tracking-widest px-3 pt-2.5 pb-1 m-0 sticky top-0 bg-foreground">{group.toUpperCase()}</p>
          {list.map((v) => {
            const selected = value === v.voice_id;
            return (
              <div
                key={v.voice_id}
                className={`flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors ${selected ? 'bg-accent/[0.12]' : 'hover:bg-foreground/50'}`}
                onClick={() => onChange(v.voice_id)}
              >
                <div className="flex-1 min-w-0">
                  <p className={`m-0 text-[13px] font-medium truncate ${selected ? 'text-accent' : 'text-gray-300'}`}>{v.name}</p>
                </div>
                {v.preview_url && (
                  <button
                    onClick={(e) => { e.stopPropagation(); preview(v); }}
                    className={`w-6 h-6 rounded-full flex items-center justify-center border-none cursor-pointer flex-shrink-0 transition-colors ${playing === v.voice_id ? 'bg-accent' : 'bg-foreground hover:bg-foreground'}`}
                  >
                    <Play size={9} color="#fff" fill="#fff" />
                  </button>
                )}
                {selected && <div className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
});


const CROP_VIEWPORT = 280;
const CROP_OUTPUT   = 640;

const PhotoCropModal = memo(({ src, onCancel, onCrop }: {
  src: string; onCancel: () => void; onCrop: (base64: string) => void;
}) => {
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const imgRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  const minScale = (w: number, h: number) => Math.max(CROP_VIEWPORT / w, CROP_VIEWPORT / h);

  const clampOffset = (ox: number, oy: number, s: number, w: number, h: number) => {
    const dispW = w * s, dispH = h * s;
    const minX = CROP_VIEWPORT - dispW, minY = CROP_VIEWPORT - dispH;
    return { x: Math.min(0, Math.max(minX, ox)), y: Math.min(0, Math.max(minY, oy)) };
  };

  const handleImgLoad = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;
    const w = img.naturalWidth, h = img.naturalHeight;
    const s = minScale(w, h);
    setNatural({ w, h });
    setScale(s);
    setOffset(clampOffset((CROP_VIEWPORT - w * s) / 2, (CROP_VIEWPORT - h * s) / 2, s, w, h));
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: offset.x, origY: offset.y };
  }, [offset]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current || !natural) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    setOffset(clampOffset(dragRef.current.origX + dx, dragRef.current.origY + dy, scale, natural.w, natural.h));
  }, [natural, scale]);

  const onPointerUp = useCallback(() => { dragRef.current = null; }, []);

  const onWheel = useCallback((e: React.WheelEvent) => {
    if (!natural) return;
    e.preventDefault();
    const min = minScale(natural.w, natural.h);
    const next = Math.min(min * 4, Math.max(min, scale - e.deltaY * 0.001 * scale));
    const c = CROP_VIEWPORT / 2;
    const ratio = next / scale;
    const nx = c - (c - offset.x) * ratio;
    const ny = c - (c - offset.y) * ratio;
    setScale(next);
    setOffset(clampOffset(nx, ny, next, natural.w, natural.h));
  }, [natural, scale, offset]);

  const applyCrop = useCallback(() => {
    const img = imgRef.current;
    if (!img || !natural) return;
    const canvas = document.createElement('canvas');
    canvas.width = CROP_OUTPUT;
    canvas.height = CROP_OUTPUT;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const ratio = CROP_OUTPUT / CROP_VIEWPORT;
    ctx.drawImage(
      img,
      offset.x * ratio, offset.y * ratio,
      natural.w * scale * ratio, natural.h * scale * ratio,
    );
    onCrop(canvas.toDataURL('image/jpeg', 0.92).split(',')[1]);
  }, [natural, scale, offset, onCrop]);

  return (
    <div className="fixed inset-0 z-[500] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.75)' }}>
      <div className="bg-background rounded-2xl p-5 flex flex-col items-center gap-4" style={{ width: CROP_VIEWPORT + 40 }}>
        <span className="text-white font-semibold text-[14px]">Ajustar foto</span>
        <div
          className="relative overflow-hidden rounded-2xl bg-foreground cursor-move touch-none select-none"
          style={{ width: CROP_VIEWPORT, height: CROP_VIEWPORT }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
        >
          <img
            ref={imgRef}
            src={src}
            onLoad={handleImgLoad}
            draggable={false}
            alt=""
            style={{
              position: 'absolute',
              left: offset.x,
              top: offset.y,
              width: natural ? natural.w * scale : undefined,
              height: natural ? natural.h * scale : undefined,
              maxWidth: 'none',
              pointerEvents: 'none',
            }}
          />
          <div
            className="absolute inset-0 pointer-events-none"
            style={{ boxShadow: '0 0 0 9999px rgba(0,0,0,0.4)', borderRadius: '50%' }}
          />
        </div>
        <p className="text-gray-300 text-[11px] m-0 text-center">Arraste pra posicionar, use o scroll pra dar zoom</p>
        <div className="flex gap-2 w-full">
          <motion.button
            onClick={onCancel}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.96 }}
            className="flex-1 py-2.5 rounded-full bg-foreground border-none cursor-pointer"
          >
            <span className="text-gray-300 font-semibold text-[12px]">Cancelar</span>
          </motion.button>
          <motion.button
            onClick={applyCrop}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.96 }}
            className="flex-1 py-2.5 rounded-full bg-accent border-none cursor-pointer"
          >
            <span className="text-white font-semibold text-[12px]">Usar foto</span>
          </motion.button>
        </div>
      </div>
    </div>
  );
});


const CharacterEditor = memo(({ character, ttsProvider, onClose, onSaved }: {
  character: Partial<Character> | null;
  ttsProvider: 'elevenlabs' | 'fishaudio';
  onClose: () => void;
  onSaved: () => void;
}) => {
  const [name, setName] = useState(character?.name ?? '');
  const [personality, setPersonality] = useState(character?.personality ?? '');
  const [model, setModel] = useState(character?.model ?? '');
  const [voiceId, setVoiceId] = useState(character?.voiceId ?? '');
  const [localPhoto, setLocalPhoto] = useState<{ uri: string; base64: string } | null>(null);
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const photoUri = localPhoto?.uri ?? (character?.photo ? `${API_BASE}/files/${character.photo}` : null);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setCropSrc(URL.createObjectURL(file));
  }, []);

  const handleCropped = useCallback((base64: string) => {
    setLocalPhoto({ uri: `data:image/jpeg;base64,${base64}`, base64 });
    if (cropSrc) URL.revokeObjectURL(cropSrc);
    setCropSrc(null);
  }, [cropSrc]);

  const handleCropCancel = useCallback(() => {
    if (cropSrc) URL.revokeObjectURL(cropSrc);
    setCropSrc(null);
  }, [cropSrc]);

  const save = useCallback(async () => {
    if (!name.trim()) { window.alert('Nome obrigatório.'); return; }
    setSaving(true);
    try {
      const body: Record<string, unknown> = { name: name.trim(), personality, model, voiceId };
      if (localPhoto) body.photoBase64 = localPhoto.base64;
      const isNew = !character?._id;
      const url = isNew ? `${API_BASE}/api/characters` : `${API_BASE}/api/characters/${character!._id}`;
      const res = await fetch(url, {
        method: isNew ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error();
      onSaved();
    } catch { window.alert('Erro ao salvar.'); }
    finally { setSaving(false); }
  }, [name, personality, model, voiceId, localPhoto, character, onSaved]);

  const deleteCharacter = useCallback(async () => {
    if (!character?._id) return;
    if (!window.confirm(`Apagar "${character.name}"?`)) return;
    try {
      await fetch(`${API_BASE}/api/characters/${character._id}`, { method: 'DELETE' });
      onSaved();
    } catch { window.alert('Erro ao apagar.'); }
  }, [character, onSaved]);

  return (
    <div className="flex flex-col h-full">
      <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />
      {cropSrc && <PhotoCropModal src={cropSrc} onCancel={handleCropCancel} onCrop={handleCropped} />}

      <div className="flex items-center gap-3 px-4 py-3.5 border-b border-foreground flex-shrink-0">
        <motion.button
          onClick={onClose}
          whileHover={{ scale: 1.08 }}
          whileTap={{ scale: 0.92 }}
          className="w-8 h-8 rounded-full flex items-center justify-center bg-foreground border-none cursor-pointer hover:bg-foreground transition-colors flex-shrink-0"
        >
          <ChevronLeft size={16} color="#888" />
        </motion.button>
        <span className="text-white font-semibold text-[14px] flex-1 truncate">
          {character?._id ? 'Editar personagem' : 'Novo personagem'}
        </span>
        <motion.button
          onClick={save}
          disabled={saving}
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.95 }}
          className="h-8 px-5 rounded-full bg-accent border-none cursor-pointer flex items-center justify-center min-w-[70px] disabled:opacity-50 transition-opacity flex-shrink-0"
        >
          {saving ? <Spinner /> : <span className="text-white font-bold text-[12px]">Salvar</span>}
        </motion.button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="flex items-center gap-5 mb-6">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="relative bg-transparent border-none cursor-pointer p-0 flex-shrink-0"
          >
            <div
              className="overflow-hidden flex items-center justify-center bg-foreground"
              style={{ width: 72, height: 72, borderRadius: 18 }}
            >
              {photoUri
                ? <img src={photoUri} style={{ width: 72, height: 72, objectFit: 'cover' }} alt="" />
                : <User size={26} color="#555" />
              }
            </div>
            <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-accent border-2 border-background flex items-center justify-center">
              <Pencil size={9} color="#fff" />
            </div>
          </button>
          <div className="flex-1 min-w-0">
            <p className="text-gray-400 text-[10px] font-bold tracking-widest mb-1.5 m-0">NOME</p>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nome do personagem"
              className="text-white text-[17px] font-bold bg-transparent border-none outline-none w-full placeholder:text-gray-400"
            />
          </div>
        </div>

        <div className="mb-5">
          <p className="text-gray-400 text-[10px] font-bold tracking-widest mb-2 m-0">PERSONALIDADE</p>
          <textarea
            value={personality}
            onChange={(e) => setPersonality(e.target.value)}
            placeholder="Descreva a personalidade, tom e jeito de ser..."
            className="text-white text-[13px] border border-foreground rounded-2xl px-4 py-3 outline-none resize-none w-full placeholder:text-gray-400 bg-foreground"
            style={{ minHeight: 220 }}
          />
          <p className="text-gray-300 text-[11px] mt-1.5 m-0">Se vazio, usa a personalidade padrão.</p>
        </div>

        <div className="mb-5">
          <p className="text-gray-400 text-[10px] font-bold tracking-widest mb-2 m-0">MODELO DE IA</p>
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="Padrão do servidor"
            className="text-white text-[13px] bg-transparent border-b border-foreground outline-none w-full pb-2 mb-3 placeholder:text-gray-400"
          />
          <div className="flex flex-wrap gap-1.5">
            {PRESET_MODELS.map((m) => (
              <motion.button
                key={m.value}
                onClick={() => setModel(m.value)}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                className={`px-3 py-1 rounded-full text-[11px] font-semibold border-none cursor-pointer transition-colors ${
                  model === m.value ? 'bg-accent text-white' : 'bg-foreground text-gray-400 hover:text-gray-200'
                }`}
              >
                {m.label}
              </motion.button>
            ))}
          </div>
        </div>

        <div className="mb-5">
          <p className="text-gray-400 text-[10px] font-bold tracking-widest mb-2 m-0">
            VOZ ({ttsProvider === 'fishaudio' ? 'FISH AUDIO' : 'ELEVENLABS'})
          </p>
          <input
            type="text"
            value={voiceId}
            onChange={(e) => setVoiceId(e.target.value.trim())}
            placeholder={ttsProvider === 'fishaudio' ? 'ID do modelo (reference_id)' : 'ID da voz (voice_id)'}
            className="text-white text-[13px] bg-transparent border-b border-foreground outline-none w-full pb-2 mb-3 placeholder:text-gray-400"
            autoComplete="off"
            spellCheck={false}
          />
          <VoicePicker value={voiceId} onChange={setVoiceId} provider={ttsProvider} />
          {!voiceId && <p className="text-gray-300 text-[11px] mt-1.5 m-0">Se vazia, usa a voz padrão do servidor.</p>}
        </div>

        {character?._id && (
          <motion.button
            onClick={deleteCharacter}
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.96 }}
            className="flex items-center gap-2 py-2 px-4 rounded-full border border-destructive/30 bg-transparent cursor-pointer hover:bg-destructive/10 transition-colors"
          >
            <X size={12} color="#ff382b" />
            <span className="text-destructive font-semibold text-[12px]">Apagar personagem</span>
          </motion.button>
        )}
      </div>
    </div>
  );
});


const METHODS: SkillMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const PARAM_LOCATIONS: SkillParamLocation[] = ['path', 'query', 'header', 'body'];
const PARAM_TYPES: SkillParamType[] = ['string', 'number', 'boolean'];
const SKILL_NAME_RE = /^[a-z0-9_]+$/;
const AUTH_TYPES: [SkillAuthType, string][] = [
  ['none', 'Nenhuma'], ['bearer', 'Bearer Token'], ['apiKeyHeader', 'Header customizado'], ['basic', 'Basic Auth'],
];

const fieldLabel = 'text-gray-400 text-[10px] font-bold tracking-widest mb-1.5 m-0';
const smallInput = 'text-white text-[13px] bg-foreground border border-foreground rounded-xl px-3 py-2 outline-none w-full placeholder:text-gray-400';

function methodColor(method: SkillMethod) {
  switch (method) {
    case 'GET': return 'bg-blue-500/15 text-blue-300';
    case 'POST': return 'bg-green-500/15 text-green-300';
    case 'PUT':
    case 'PATCH': return 'bg-amber-500/15 text-amber-300';
    case 'DELETE': return 'bg-destructive/15 text-destructive';
    default: return 'bg-foreground text-gray-300';
  }
}


const PackageCard = memo(({ pkg, count, idx, onOpen, onEdit }: {
  pkg: SkillPackage; count: number; idx: number;
  onOpen: () => void; onEdit: () => void;
}) => (
  <motion.div
    layout
    initial={{ opacity: 0, y: 10 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, scale: 0.92 }}
    transition={{ type: 'spring', stiffness: 420, damping: 36, delay: idx * 0.03 }}
    whileHover={{ scale: 1.02 }}
    whileTap={{ scale: 0.98 }}
    onClick={onOpen}
    className="group relative flex flex-col gap-3 p-4 rounded-2xl bg-foreground hover:bg-foreground/70 cursor-pointer"
    style={{ transition: 'background-color 0.2s' }}
  >
    <motion.button
      onClick={(e) => { e.stopPropagation(); onEdit(); }}
      whileHover={{ scale: 1.15 }}
      whileTap={{ scale: 0.9 }}
      className="absolute top-3 right-3 p-1 rounded-full border-none cursor-pointer bg-background/60 transition-opacity opacity-0 group-hover:opacity-100"
    >
      <Pencil size={10} color="#999" />
    </motion.button>

    <div className="flex items-center gap-2">
      <div className="w-7 h-7 rounded-full flex items-center justify-center bg-background flex-shrink-0">
        <Package size={13} color="#8a8a94" />
      </div>
      <p className="text-white text-[13px] font-semibold m-0 truncate pr-4">{pkg.name}</p>
    </div>
    <p className="text-gray-400 text-[11px] leading-4 m-0 overflow-hidden" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
      {pkg.description || 'Sem descrição.'}
    </p>
    <p className="text-gray-500 text-[10px] font-semibold tracking-wide m-0">
      {count} {count === 1 ? 'skill' : 'skills'}
    </p>
  </motion.div>
));


const SkillRow = memo(({ skill, idx, onOpen, onToggle }: {
  skill: Skill; idx: number; onOpen: () => void; onToggle: () => void;
}) => (
  <motion.div
    layout
    initial={{ opacity: 0, y: 10 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, x: -12, transition: { duration: 0.15 } }}
    transition={{ type: 'spring', stiffness: 420, damping: 38, delay: idx * 0.025 }}
    whileHover={{ scale: 1.01 }}
    className="flex items-center gap-3 py-3 px-4 rounded-2xl bg-foreground hover:bg-foreground/60 cursor-pointer"
    style={{ transition: 'background-color 0.2s' }}
    onClick={onOpen}
  >
    <span className={`flex-shrink-0 px-2 py-0.5 rounded-full text-[10px] font-bold ${methodColor(skill.method)}`}>
      {skill.method}
    </span>
    <div className="flex-1 min-w-0">
      <p className="text-white text-[13px] font-semibold m-0 truncate">{skill.name}</p>
      <p className="text-gray-400 text-[11px] m-0 truncate">{skill.urlTemplate}</p>
    </div>
    <div onClick={(e) => e.stopPropagation()} className="flex-shrink-0">
      <Switch checked={skill.enabled} onChange={onToggle} size="sm" />
    </div>
    <Pencil size={12} color="#777" className="flex-shrink-0" />
  </motion.div>
));


const PackageEditor = memo(({ pkg, onClose, onSaved, onDeleted }: {
  pkg: Partial<SkillPackage> | null;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) => {
  const [name, setName] = useState(pkg?.name ?? '');
  const [description, setDescription] = useState(pkg?.description ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const isNew = !pkg?._id;

  const save = useCallback(async () => {
    const trimmedName = name.trim();
    if (!trimmedName || !SKILL_NAME_RE.test(trimmedName)) {
      setError('Nome inválido — use apenas letras minúsculas, números e "_".');
      return;
    }
    setError('');
    setSaving(true);
    try {
      const url = isNew ? `${API_BASE}/api/skill-packages` : `${API_BASE}/api/skill-packages/${pkg!._id}`;
      const res = await fetch(url, {
        method: isNew ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmedName, description }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Erro ao salvar.'); return; }
      onSaved();
    } catch { setError('Erro ao salvar.'); }
    finally { setSaving(false); }
  }, [name, description, isNew, pkg, onSaved]);

  const remove = useCallback(async () => {
    if (!pkg?._id) return;
    if (!window.confirm(`Apagar pacote "${pkg.name}"? As skills dele voltam a ficar sem pacote.`)) return;
    try {
      await fetch(`${API_BASE}/api/skill-packages/${pkg._id}`, { method: 'DELETE' });
      onDeleted();
    } catch { window.alert('Erro ao apagar.'); }
  }, [pkg, onDeleted]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-4 py-3.5 border-b border-foreground flex-shrink-0">
        <motion.button
          onClick={onClose}
          whileHover={{ scale: 1.08 }}
          whileTap={{ scale: 0.92 }}
          className="w-8 h-8 rounded-full flex items-center justify-center bg-foreground border-none cursor-pointer hover:bg-foreground transition-colors flex-shrink-0"
        >
          <ChevronLeft size={16} color="#888" />
        </motion.button>
        <span className="text-white font-semibold text-[14px] flex-1 truncate">
          {isNew ? 'Novo pacote' : 'Editar pacote'}
        </span>
        <motion.button
          onClick={save}
          disabled={saving}
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.95 }}
          className="h-8 px-5 rounded-full bg-accent border-none cursor-pointer flex items-center justify-center min-w-[70px] disabled:opacity-50 transition-opacity flex-shrink-0"
        >
          {saving ? <Spinner /> : <span className="text-white font-bold text-[12px]">Salvar</span>}
        </motion.button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {error && (
          <div className="mb-4 px-4 py-2.5 rounded-xl bg-destructive/10 border border-destructive/30">
            <span className="text-destructive text-[12px]">{error}</span>
          </div>
        )}

        <div className="mb-5">
          <p className={fieldLabel}>NOME (IDENTIFICADOR)</p>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="ex: crm"
            className={smallInput}
          />
          <p className="text-gray-300 text-[11px] mt-1.5 m-0">
            Apenas letras minúsculas, números e "_".
          </p>
        </div>

        <div className="mb-5">
          <p className={fieldLabel}>DESCRIÇÃO</p>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Quando a IA deve abrir esse pacote..."
            className="text-white text-[13px] border border-foreground rounded-2xl px-4 py-3 outline-none resize-none w-full placeholder:text-gray-400 bg-foreground"
            style={{ minHeight: 100 }}
          />
          <p className="text-gray-300 text-[11px] mt-1.5 m-0">
            É isso que diz à IA quando abrir esse pacote — seja específico.
          </p>
        </div>

        {!isNew && (
          <motion.button
            onClick={remove}
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.96 }}
            className="flex items-center gap-2 py-2 px-4 rounded-full border border-destructive/30 bg-transparent cursor-pointer hover:bg-destructive/10 transition-colors"
          >
            <X size={12} color="#ff382b" />
            <span className="text-destructive font-semibold text-[12px]">Apagar pacote</span>
          </motion.button>
        )}
      </div>
    </div>
  );
});


const VOICE_PROVIDERS: VoiceProvider[] = ['elevenlabs', 'fishaudio'];

const VoicePresetCard = memo(({ preset, idx, onEdit }: {
  preset: VoicePreset; idx: number; onEdit: () => void;
}) => (
  <motion.div
    layout
    initial={{ opacity: 0, y: 10 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, scale: 0.92 }}
    transition={{ type: 'spring', stiffness: 420, damping: 36, delay: idx * 0.03 }}
    whileHover={{ scale: 1.02 }}
    whileTap={{ scale: 0.98 }}
    onClick={onEdit}
    className="group relative flex flex-col gap-3 p-4 rounded-2xl bg-foreground hover:bg-foreground/70 cursor-pointer"
    style={{ transition: 'background-color 0.2s' }}
  >
    <div className="flex items-center gap-2">
      <div className="w-7 h-7 rounded-full flex items-center justify-center bg-background flex-shrink-0">
        <Mic size={13} color="#8a8a94" />
      </div>
      <p className="text-white text-[13px] font-semibold m-0 truncate pr-4">{preset.name}</p>
    </div>
    <p className="text-gray-400 text-[11px] leading-4 m-0 truncate">{preset.voiceId}</p>
    <p className="text-gray-500 text-[10px] font-semibold tracking-wide m-0">
      {preset.provider === 'fishaudio' ? 'Fish Audio' : 'ElevenLabs'}
    </p>
  </motion.div>
));

const VoicePresetEditor = memo(({ preset, onClose, onSaved, onDeleted }: {
  preset: Partial<VoicePreset> | null;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) => {
  const [name, setName] = useState(preset?.name ?? '');
  const [voiceId, setVoiceId] = useState(preset?.voiceId ?? '');
  const [provider, setProvider] = useState<VoiceProvider>(preset?.provider ?? 'elevenlabs');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const isNew = !preset?._id;

  const save = useCallback(async () => {
    const trimmedName = name.trim();
    const trimmedVoiceId = voiceId.trim();
    if (!trimmedName) { setError('Nome é obrigatório.'); return; }
    if (!trimmedVoiceId) { setError('Voice ID é obrigatório.'); return; }
    setError('');
    setSaving(true);
    try {
      const url = isNew ? `${API_BASE}/api/voice-presets` : `${API_BASE}/api/voice-presets/${preset!._id}`;
      const res = await fetch(url, {
        method: isNew ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmedName, voiceId: trimmedVoiceId, provider }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Erro ao salvar.'); return; }
      onSaved();
    } catch { setError('Erro ao salvar.'); }
    finally { setSaving(false); }
  }, [name, voiceId, provider, isNew, preset, onSaved]);

  const remove = useCallback(async () => {
    if (!preset?._id) return;
    if (!window.confirm(`Apagar a voz "${preset.name}"?`)) return;
    try {
      await fetch(`${API_BASE}/api/voice-presets/${preset._id}`, { method: 'DELETE' });
      onDeleted();
    } catch { window.alert('Erro ao apagar.'); }
  }, [preset, onDeleted]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-4 py-3.5 border-b border-foreground flex-shrink-0">
        <motion.button
          onClick={onClose}
          whileHover={{ scale: 1.08 }}
          whileTap={{ scale: 0.92 }}
          className="w-8 h-8 rounded-full flex items-center justify-center bg-foreground border-none cursor-pointer hover:bg-foreground transition-colors flex-shrink-0"
        >
          <ChevronLeft size={16} color="#888" />
        </motion.button>
        <span className="text-white font-semibold text-[14px] flex-1 truncate">
          {isNew ? 'Nova voz' : 'Editar voz'}
        </span>
        <motion.button
          onClick={save}
          disabled={saving}
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.95 }}
          className="h-8 px-5 rounded-full bg-accent border-none cursor-pointer flex items-center justify-center min-w-[70px] disabled:opacity-50 transition-opacity flex-shrink-0"
        >
          {saving ? <Spinner /> : <span className="text-white font-bold text-[12px]">Salvar</span>}
        </motion.button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {error && (
          <div className="mb-4 px-4 py-2.5 rounded-xl bg-destructive/10 border border-destructive/30">
            <span className="text-destructive text-[12px]">{error}</span>
          </div>
        )}

        <div className="mb-5">
          <p className={fieldLabel}>NOME</p>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="ex: Robótica"
            className={smallInput}
          />
          <p className="text-gray-300 text-[11px] mt-1.5 m-0">
            É por esse nome que ela reconhece a voz quando você (ou ela mesma, via change_voice) pedir pra trocar.
          </p>
        </div>

        <div className="mb-5">
          <p className={fieldLabel}>PROVEDOR</p>
          <div className="flex gap-2">
            {VOICE_PROVIDERS.map((p) => (
              <button
                key={p}
                onClick={() => setProvider(p)}
                className={`flex-1 py-2.5 rounded-xl text-[13px] font-semibold border cursor-pointer transition-colors ${
                  provider === p
                    ? 'bg-accent text-white border-accent'
                    : 'bg-foreground text-gray-400 border-foreground hover:text-gray-200'
                }`}
              >
                {p === 'fishaudio' ? 'Fish Audio' : 'ElevenLabs'}
              </button>
            ))}
          </div>
        </div>

        <div className="mb-5">
          <p className={fieldLabel}>{provider === 'fishaudio' ? 'ID DO MODELO (REFERENCE_ID)' : 'ID DA VOZ (VOICE_ID)'}</p>
          <input
            type="text"
            value={voiceId}
            onChange={(e) => setVoiceId(e.target.value)}
            placeholder={provider === 'fishaudio' ? 'ID do modelo (reference_id)' : 'ID da voz (voice_id)'}
            className={smallInput}
          />
        </div>

        {!isNew && (
          <motion.button
            onClick={remove}
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.96 }}
            className="flex items-center gap-2 py-2 px-4 rounded-full border border-destructive/30 bg-transparent cursor-pointer hover:bg-destructive/10 transition-colors"
          >
            <X size={12} color="#ff382b" />
            <span className="text-destructive font-semibold text-[12px]">Apagar voz</span>
          </motion.button>
        )}
      </div>
    </div>
  );
});


const SkillEditor = memo(({ skill, packages, onClose, onSaved }: {
  skill: Partial<Skill> | null;
  packages: SkillPackage[];
  onClose: () => void;
  onSaved: () => void;
}) => {
  const [name, setName] = useState(skill?.name ?? '');
  const [description, setDescription] = useState(skill?.description ?? '');
  const [packageId, setPackageId] = useState<string>(skill?.packageId ?? '');
  const [method, setMethod] = useState<SkillMethod>(skill?.method ?? 'GET');
  const [urlTemplate, setUrlTemplate] = useState(skill?.urlTemplate ?? '');
  const [authType, setAuthType] = useState<SkillAuthType>(skill?.authType ?? 'none');
  const [authHeaderName, setAuthHeaderName] = useState(skill?.authHeaderName ?? '');
  const [authValue, setAuthValue] = useState('');
  const [headers, setHeaders] = useState<SkillHeader[]>(skill?.headers ?? []);
  const [params, setParams] = useState<SkillParam[]>(skill?.params ?? []);
  const [enabled, setEnabled] = useState(skill?.enabled ?? true);
  const [requiresConfirmation, setRequiresConfirmation] = useState(skill?.requiresConfirmation ?? false);
  const [alwaysVisible, setAlwaysVisible] = useState(skill?.alwaysVisible ?? false);
  const [responseMode, setResponseMode] = useState<SkillResponseMode>(skill?.responseMode ?? 'text');
  const [imageUrlField, setImageUrlField] = useState(skill?.imageUrlField ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [sampleArgs, setSampleArgs] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; status: number; durationMs: number; body: string } | null>(null);

  const isNew = !skill?._id;

  const addHeader = useCallback(() => setHeaders((prev) => [...prev, { key: '', value: '' }]), []);
  const updateHeader = useCallback((idx: number, patch: Partial<SkillHeader>) => {
    setHeaders((prev) => prev.map((h, i) => (i === idx ? { ...h, ...patch } : h)));
  }, []);
  const removeHeader = useCallback((idx: number) => setHeaders((prev) => prev.filter((_, i) => i !== idx)), []);

  const addParam = useCallback(() => {
    setParams((prev) => [...prev, { name: '', in: 'query', type: 'string', required: false, description: '' }]);
  }, []);
  const updateParam = useCallback((idx: number, patch: Partial<SkillParam>) => {
    setParams((prev) => prev.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  }, []);
  const removeParam = useCallback((idx: number) => setParams((prev) => prev.filter((_, i) => i !== idx)), []);

  const save = useCallback(async () => {
    const trimmedName = name.trim();
    if (!trimmedName || !SKILL_NAME_RE.test(trimmedName)) {
      setError('Nome inválido — use apenas letras minúsculas, números e "_".');
      return;
    }
    if (!urlTemplate.trim()) {
      setError('URL obrigatória.');
      return;
    }
    setError('');
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        name: trimmedName, description, packageId: packageId || null, method, urlTemplate: urlTemplate.trim(),
        authType, authHeaderName, headers, params, enabled, requiresConfirmation, alwaysVisible,
        responseMode, imageUrlField: imageUrlField.trim(),
      };
      if (authValue.trim()) body.authValue = authValue.trim();
      const url = isNew ? `${API_BASE}/api/skills` : `${API_BASE}/api/skills/${skill!._id}`;
      const res = await fetch(url, {
        method: isNew ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Erro ao salvar.'); return; }
      onSaved();
    } catch { setError('Erro ao salvar.'); }
    finally { setSaving(false); }
  }, [name, description, packageId, method, urlTemplate, authType, authHeaderName, authValue, headers, params, enabled, requiresConfirmation, alwaysVisible, responseMode, imageUrlField, isNew, skill, onSaved]);

  const removeSkill = useCallback(async () => {
    if (!skill?._id) return;
    if (!window.confirm(`Apagar skill "${skill.name}"?`)) return;
    try {
      await fetch(`${API_BASE}/api/skills/${skill._id}`, { method: 'DELETE' });
      onSaved();
    } catch { window.alert('Erro ao apagar.'); }
  }, [skill, onSaved]);

  const runTest = useCallback(async () => {
    if (!skill?._id) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`${API_BASE}/api/skills/${skill._id}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sampleArgs }),
      });
      setTestResult(await res.json());
    } catch {
      setTestResult({ ok: false, status: 0, durationMs: 0, body: 'Falha ao executar teste.' });
    } finally { setTesting(false); }
  }, [skill, sampleArgs]);

  const namedParams = params.filter((p) => p.name.trim());

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-4 py-3.5 border-b border-foreground flex-shrink-0">
        <motion.button
          onClick={onClose}
          whileHover={{ scale: 1.08 }}
          whileTap={{ scale: 0.92 }}
          className="w-8 h-8 rounded-full flex items-center justify-center bg-foreground border-none cursor-pointer hover:bg-foreground transition-colors flex-shrink-0"
        >
          <ChevronLeft size={16} color="#888" />
        </motion.button>
        <span className="text-white font-semibold text-[14px] flex-1 truncate">
          {isNew ? 'Nova skill' : 'Editar skill'}
        </span>
        <motion.button
          onClick={save}
          disabled={saving}
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.95 }}
          className="h-8 px-5 rounded-full bg-accent border-none cursor-pointer flex items-center justify-center min-w-[70px] disabled:opacity-50 transition-opacity flex-shrink-0"
        >
          {saving ? <Spinner /> : <span className="text-white font-bold text-[12px]">Salvar</span>}
        </motion.button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {error && (
          <div className="mb-4 px-4 py-2.5 rounded-xl bg-destructive/10 border border-destructive/30">
            <span className="text-destructive text-[12px]">{error}</span>
          </div>
        )}

        <div className="mb-5">
          <p className={fieldLabel}>NOME (IDENTIFICADOR)</p>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="ex: criar_tarefa"
            className={smallInput}
          />
          <p className="text-gray-300 text-[11px] mt-1.5 m-0">
            Apenas letras minúsculas, números e "_". É o identificador interno da skill.
          </p>
        </div>

        <div className="mb-5">
          <p className={fieldLabel}>DESCRIÇÃO</p>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Descreva o que essa skill faz e QUANDO a IA deve usá-la..."
            className="text-white text-[13px] border border-foreground rounded-2xl px-4 py-3 outline-none resize-none w-full placeholder:text-gray-400 bg-foreground"
            style={{ minHeight: 100 }}
          />
          <p className="text-gray-300 text-[11px] mt-1.5 m-0">
            É isso que diz à IA quando usar essa skill — seja específico.
          </p>
        </div>

        <div className="mb-5">
          <p className={fieldLabel}>PACOTE</p>
          <select
            value={packageId}
            onChange={(e) => setPackageId(e.target.value)}
            className={smallInput}
          >
            <option value="">Nenhum (sempre visível)</option>
            {packages.map((pkg) => (
              <option key={pkg._id} value={pkg._id}>{pkg.name}</option>
            ))}
          </select>
          <p className="text-gray-300 text-[11px] mt-1.5 m-0">
            Skills sem pacote ficam sempre visíveis para a IA. Skills num pacote só aparecem depois que a IA abrir esse pacote.
          </p>
        </div>

        <div className="mb-5">
          <p className={fieldLabel}>MÉTODO E URL</p>
          <div className="flex gap-2 mb-1.5">
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value as SkillMethod)}
              className="text-white text-[13px] bg-foreground border border-foreground rounded-xl px-3 py-2 outline-none flex-shrink-0"
            >
              {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <input
              type="text"
              value={urlTemplate}
              onChange={(e) => setUrlTemplate(e.target.value)}
              placeholder="https://api.exemplo.com/tarefas/{id}"
              className={`${smallInput} flex-1`}
            />
          </div>
          <p className="text-gray-300 text-[11px] m-0">
            {'Use {nome} na URL para parâmetros de path (ex: /tarefas/{id}).'}
          </p>
        </div>

        <div className="mb-5">
          <p className={fieldLabel}>AUTENTICAÇÃO</p>
          <div className="flex gap-1.5 mb-2 flex-wrap">
            {AUTH_TYPES.map(([val, label]) => (
              <motion.button
                key={val}
                onClick={() => setAuthType(val)}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                className={`px-3 py-1.5 rounded-full text-[11px] font-semibold border-none cursor-pointer transition-colors ${
                  authType === val ? 'bg-accent text-white' : 'bg-foreground text-gray-400 hover:text-gray-200'
                }`}
              >
                {label}
              </motion.button>
            ))}
          </div>
          {authType === 'apiKeyHeader' && (
            <input
              type="text"
              value={authHeaderName}
              onChange={(e) => setAuthHeaderName(e.target.value)}
              placeholder="Nome do header (ex: X-API-Key)"
              className={`${smallInput} mb-2`}
            />
          )}
          {authType !== 'none' && (
            <input
              type="password"
              value={authValue}
              onChange={(e) => setAuthValue(e.target.value)}
              placeholder={skill?.hasAuthValue ? '•••• (mantido — deixe em branco para não alterar)' : authType === 'basic' ? 'usuario:senha' : 'valor do token'}
              className={smallInput}
              autoComplete="off"
            />
          )}
        </div>

        <div className="mb-5">
          <div className="flex items-center justify-between mb-2">
            <p className={`${fieldLabel} mb-0`}>HEADERS ESTÁTICOS</p>
            <motion.button
              onClick={addHeader}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              className="flex items-center gap-1 px-2.5 py-1 rounded-full border-none cursor-pointer bg-accent/[0.12] hover:bg-accent/20 transition-colors"
            >
              <Plus size={11} color="var(--accent)" /><span className="text-accent font-semibold text-[11px]">Adicionar</span>
            </motion.button>
          </div>
          {headers.length === 0 && <p className="text-gray-500 text-[12px] m-0">Nenhum header.</p>}
          <div className="flex flex-col gap-1.5">
            <AnimatePresence initial={false}>
              {headers.map((h, idx) => (
                <motion.div
                  key={idx}
                  layout
                  initial={{ opacity: 0, x: -12 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -12 }}
                  transition={{ type: 'spring', stiffness: 460, damping: 38 }}
                  className="flex items-center gap-1.5"
                >
                  <input type="text" value={h.key} onChange={(e) => updateHeader(idx, { key: e.target.value })} placeholder="Header" className={`${smallInput} flex-1`} />
                  <input type="text" value={h.value} onChange={(e) => updateHeader(idx, { value: e.target.value })} placeholder="Valor" className={`${smallInput} flex-1`} />
                  <motion.button
                    onClick={() => removeHeader(idx)}
                    whileHover={{ scale: 1.15 }}
                    whileTap={{ scale: 0.9 }}
                    className="p-1.5 rounded-full border-none cursor-pointer bg-transparent opacity-40 hover:opacity-100 transition-opacity flex-shrink-0"
                  >
                    <X size={13} color="#ff382b" />
                  </motion.button>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </div>

        <div className="mb-5">
          <div className="flex items-center justify-between mb-2">
            <p className={`${fieldLabel} mb-0`}>PARÂMETROS</p>
            <button
              onClick={addParam}
              className="flex items-center gap-1 px-2.5 py-1 rounded-full border-none cursor-pointer bg-accent/[0.12] hover:bg-accent/20 transition-colors"
            >
              <Plus size={11} color="var(--accent)" /><span className="text-accent font-semibold text-[11px]">Adicionar</span>
            </button>
          </div>
          <p className="text-gray-300 text-[11px] mt-0 mb-2">
            A descrição de cada parâmetro é o que orienta a IA a preenchê-lo corretamente.
          </p>
          {params.length === 0 && <p className="text-gray-500 text-[12px] m-0">Nenhum parâmetro.</p>}
          <div className="flex flex-col gap-2">
            <AnimatePresence initial={false}>
              {params.map((p, idx) => (
                <motion.div
                  key={idx}
                  layout
                  initial={{ opacity: 0, y: -10, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={{ type: 'spring', stiffness: 460, damping: 38 }}
                  className="flex flex-col gap-1.5 p-3 rounded-xl bg-foreground border border-foreground"
                >
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      value={p.name}
                      onChange={(e) => updateParam(idx, { name: e.target.value })}
                      placeholder="nome"
                      className="text-white text-[12px] bg-background border border-foreground rounded-lg px-2.5 py-1.5 outline-none flex-1 placeholder:text-gray-400"
                    />
                    <select
                      value={p.in}
                      onChange={(e) => updateParam(idx, { in: e.target.value as SkillParamLocation })}
                      className="text-white text-[12px] bg-background border border-foreground rounded-lg px-2 py-1.5 outline-none flex-shrink-0"
                    >
                      {PARAM_LOCATIONS.map((loc) => <option key={loc} value={loc}>{loc}</option>)}
                    </select>
                    <select
                      value={p.type}
                      onChange={(e) => updateParam(idx, { type: e.target.value as SkillParamType })}
                      className="text-white text-[12px] bg-background border border-foreground rounded-lg px-2 py-1.5 outline-none flex-shrink-0"
                    >
                      {PARAM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                    <label className="flex items-center gap-1 flex-shrink-0 cursor-pointer">
                      <input type="checkbox" checked={p.required} onChange={(e) => updateParam(idx, { required: e.target.checked })} />
                      <span className="text-gray-400 text-[10px]">obrig.</span>
                    </label>
                    <motion.button
                      onClick={() => removeParam(idx)}
                      whileHover={{ scale: 1.15 }}
                      whileTap={{ scale: 0.9 }}
                      className="p-1 rounded-full border-none cursor-pointer bg-transparent opacity-40 hover:opacity-100 transition-opacity flex-shrink-0"
                    >
                      <X size={12} color="#ff382b" />
                    </motion.button>
                  </div>
                  <input
                    type="text"
                    value={p.description}
                    onChange={(e) => updateParam(idx, { description: e.target.value })}
                    placeholder="O que a IA deve preencher aqui..."
                    className="text-white text-[12px] bg-background border border-foreground rounded-lg px-2.5 py-1.5 outline-none w-full placeholder:text-gray-400"
                  />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </div>

        <div className="mb-5 flex items-center justify-between">
          <div>
            <p className={`${fieldLabel} mb-0.5`}>ATIVA</p>
            <p className="text-gray-300 text-[11px] m-0">Skills desativadas não são usadas pela IA.</p>
          </div>
          <Switch checked={enabled} onChange={() => setEnabled((v) => !v)} />
        </div>

        <div className="mb-5 flex items-center justify-between">
          <div>
            <p className={`${fieldLabel} mb-0.5`}>PEDIR CONFIRMAÇÃO</p>
            <p className="text-gray-300 text-[11px] m-0">
              Antes de chamar essa skill de verdade, a IA para e mostra a chamada pra você aprovar, recusar ou pedir mudanças no chat.
            </p>
          </div>
          <Switch checked={requiresConfirmation} onChange={() => setRequiresConfirmation((v) => !v)} />
        </div>

        <div className="mb-5 flex items-center justify-between">
          <div>
            <p className={`${fieldLabel} mb-0.5`}>SEMPRE VISÍVEL</p>
            <p className="text-gray-300 text-[11px] m-0">
              Normalmente a IA só enxerga essa skill depois de decidir abrir seu conjunto de ferramentas
              (economiza tokens em conversas comuns). Ative isso só se ela precisa perceber sozinha quando
              usar essa skill, sem você pedir de forma explícita — igual memória e busca no conhecimento.
            </p>
          </div>
          <Switch checked={alwaysVisible} onChange={() => setAlwaysVisible((v) => !v)} />
        </div>

        <div className="mb-5 flex items-center justify-between">
          <div>
            <p className={`${fieldLabel} mb-0.5`}>RESPOSTA É UMA IMAGEM</p>
            <p className="text-gray-300 text-[11px] m-0">
              Em vez de devolver o texto da resposta pra IA ler, o resultado é baixado e enviado como imagem
              direto no chat — use pra qualquer skill que busca/gera uma imagem (ex.: um buscador de imagens
              numa API externa).
            </p>
          </div>
          <Switch checked={responseMode === 'image'} onChange={() => setResponseMode((v) => (v === 'image' ? 'text' : 'image'))} />
        </div>

        {responseMode === 'image' && (
          <div className="mb-5">
            <p className={fieldLabel}>CAMPO DA URL DA IMAGEM (opcional)</p>
            <input
              type="text"
              value={imageUrlField}
              onChange={(e) => setImageUrlField(e.target.value)}
              placeholder="ex.: file_url ou items.0.url"
              className={smallInput}
            />
            <p className="text-gray-300 text-[11px] mt-1.5 m-0">
              Se a API responde com JSON contendo a URL da imagem (não a imagem em si), diga aqui o caminho
              até esse campo. Deixe em branco se a própria resposta da chamada já for os bytes da imagem.
            </p>
          </div>
        )}

        <div className="mb-5 pt-4 border-t border-foreground">
          <p className={fieldLabel}>TESTAR</p>
          {isNew ? (
            <p className="text-gray-500 text-[12px] m-0">Salve a skill primeiro para poder testá-la.</p>
          ) : (
            <>
              {namedParams.length > 0 && (
                <div className="flex flex-col gap-1.5 mb-2">
                  {namedParams.map((p) => (
                    <div key={p.name} className="flex items-center gap-2">
                      <span className="text-gray-400 text-[11px] w-24 flex-shrink-0 truncate">{p.name}</span>
                      <input
                        type="text"
                        value={sampleArgs[p.name] ?? ''}
                        onChange={(e) => setSampleArgs((prev) => ({ ...prev, [p.name]: e.target.value }))}
                        placeholder={p.description || 'valor de teste'}
                        className={`${smallInput} flex-1`}
                      />
                    </div>
                  ))}
                </div>
              )}
              <motion.button
                onClick={runTest}
                disabled={testing}
                whileHover={{ scale: 1.04 }}
                whileTap={{ scale: 0.95 }}
                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border-none cursor-pointer transition-colors bg-accent/[0.12] hover:bg-accent/20 disabled:opacity-50"
              >
                {testing ? <Spinner /> : <Play size={11} color="var(--accent)" />}
                <span className="text-accent font-semibold text-[12px]">Executar teste</span>
              </motion.button>
              <AnimatePresence>
                {testResult && (
                  <motion.div
                    initial={{ opacity: 0, height: 0, marginTop: 0 }}
                    animate={{ opacity: 1, height: 'auto', marginTop: 12 }}
                    exit={{ opacity: 0, height: 0, marginTop: 0 }}
                    transition={{ type: 'spring', stiffness: 420, damping: 40 }}
                    className={`overflow-hidden rounded-xl border ${testResult.ok ? 'border-foreground bg-foreground' : 'border-destructive/30 bg-destructive/10'}`}
                  >
                    <div className="p-3">
                      <p className={`m-0 text-[11px] font-semibold mb-1.5 ${testResult.ok ? 'text-gray-300' : 'text-destructive'}`}>
                        {testResult.status || '—'} · {testResult.durationMs}ms
                      </p>
                      <pre className="m-0 text-[11px] text-gray-300 whitespace-pre-wrap break-all font-mono max-h-40 overflow-y-auto">{testResult.body}</pre>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </>
          )}
        </div>

        {!isNew && (
          <motion.button
            onClick={removeSkill}
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.96 }}
            className="flex items-center gap-2 py-2 px-4 rounded-full border border-destructive/30 bg-transparent cursor-pointer hover:bg-destructive/10 transition-colors"
          >
            <X size={12} color="#ff382b" />
            <span className="text-destructive font-semibold text-[12px]">Apagar skill</span>
          </motion.button>
        )}
      </div>
    </div>
  );
});


const DAY_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const pad2 = (n: number) => String(n).padStart(2, '0');

function routineScheduleText(routine: Pick<Routine, 'hour' | 'minute' | 'daysOfWeek' | 'runOnce' | 'scheduledDate'>) {
  const time = `${pad2(routine.hour)}:${pad2(routine.minute)}`;
  if (routine.runOnce) {
    const dateLabel = routine.scheduledDate
      ? new Date(routine.scheduledDate).toLocaleDateString('pt-BR')
      : '?';
    return `${time} · uma vez em ${dateLabel}`;
  }
  if (routine.daysOfWeek.length === 0 || routine.daysOfWeek.length === 7) return `${time} · todo dia`;
  const days = [...routine.daysOfWeek].sort().map((d) => DAY_LABELS[d]).join(', ');
  return `${time} · ${days}`;
}

const RoutineRow = memo(({ routine, idx, onOpen, onToggle }: {
  routine: Routine; idx: number; onOpen: () => void; onToggle: () => void;
}) => (
  <motion.div
    layout
    initial={{ opacity: 0, y: 10 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, x: -12, transition: { duration: 0.15 } }}
    transition={{ type: 'spring', stiffness: 420, damping: 38, delay: idx * 0.025 }}
    whileHover={{ scale: 1.01 }}
    className="flex items-center gap-3 py-3 px-4 rounded-2xl bg-foreground hover:bg-foreground/60 cursor-pointer"
    style={{ transition: 'background-color 0.2s' }}
    onClick={onOpen}
  >
    <div className="w-7 h-7 rounded-full flex items-center justify-center bg-background flex-shrink-0">
      <Clock size={13} color="#8a8a94" />
    </div>
    <div className="flex-1 min-w-0">
      <p className="text-white text-[13px] font-semibold m-0 truncate">{routine.name}</p>
      <p className="text-gray-400 text-[11px] m-0 truncate">{routineScheduleText(routine)}</p>
    </div>
    <div onClick={(e) => e.stopPropagation()} className="flex-shrink-0">
      <Switch checked={routine.enabled} onChange={onToggle} size="sm" />
    </div>
    <Pencil size={12} color="#777" className="flex-shrink-0" />
  </motion.div>
));

const RoutineEditor = memo(({ routine, characters, workflows, onClose, onSaved }: {
  routine: Partial<Routine> | null;
  characters: Character[];
  workflows: Workflow[];
  onClose: () => void;
  onSaved: () => void;
}) => {
  const [name, setName] = useState(routine?.name ?? '');
  const [prompt, setPrompt] = useState(routine?.prompt ?? '');
  const [characterId, setCharacterId] = useState<string>(routine?.characterId ?? '');
  const [time, setTime] = useState(`${pad2(routine?.hour ?? 9)}:${pad2(routine?.minute ?? 0)}`);
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>(routine?.daysOfWeek ?? []);
  const [enabled, setEnabled] = useState(routine?.enabled ?? true);
  const [notify, setNotify] = useState(routine?.notify ?? true);
  const [forceTts, setForceTts] = useState(routine?.forceTts ?? false);
  const [triggeredWorkflowIds, setTriggeredWorkflowIds] = useState<string[]>(routine?.triggeredWorkflowIds ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<string | null>(null);

  const { createRoutine, updateRoutine, deleteRoutine, runRoutineNow } = useRoutinesStore();

  const isNew = !routine?._id;

  const toggleDay = useCallback((d: number) => {
    setDaysOfWeek((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort()));
  }, []);

  const toggleTriggeredWorkflow = useCallback((id: string) => {
    setTriggeredWorkflowIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const save = useCallback(async () => {
    if (!name.trim()) { setError('Nome obrigatório.'); return; }
    if (!prompt.trim()) { setError('Prompt obrigatório.'); return; }
    const [hourStr, minuteStr] = time.split(':');
    const hour = Number(hourStr), minute = Number(minuteStr);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) { setError('Horário inválido.'); return; }
    setError('');
    setSaving(true);
    const input = { name: name.trim(), prompt: prompt.trim(), characterId: characterId || null, hour, minute, daysOfWeek, enabled, notify, forceTts, triggeredWorkflowIds };
    const result = isNew ? await createRoutine(input) : await updateRoutine(routine!._id!, input);
    setSaving(false);
    if (!result.ok) { setError(result.error || 'Erro ao salvar.'); return; }
    onSaved();
  }, [name, prompt, characterId, time, daysOfWeek, enabled, notify, forceTts, triggeredWorkflowIds, isNew, routine, createRoutine, updateRoutine, onSaved]);

  const remove = useCallback(async () => {
    if (!routine?._id) return;
    if (!window.confirm(`Apagar rotina "${routine.name}"?`)) return;
    await deleteRoutine(routine._id);
    onSaved();
  }, [routine, deleteRoutine, onSaved]);

  const runNow = useCallback(async () => {
    if (!routine?._id) return;
    setRunning(true);
    setRunResult(null);
    const result = await runRoutineNow(routine._id);
    setRunResult(result.ok ? 'Executada — confira a conversa.' : (result.error || 'Falhou.'));
    setRunning(false);
  }, [routine, runRoutineNow]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-4 py-3.5 border-b border-foreground flex-shrink-0">
        <motion.button
          onClick={onClose}
          whileHover={{ scale: 1.08 }}
          whileTap={{ scale: 0.92 }}
          className="w-8 h-8 rounded-full flex items-center justify-center bg-foreground border-none cursor-pointer hover:bg-foreground transition-colors flex-shrink-0"
        >
          <ChevronLeft size={16} color="#888" />
        </motion.button>
        <span className="text-white font-semibold text-[14px] flex-1 truncate">
          {isNew ? 'Nova rotina' : 'Editar rotina'}
        </span>
        <motion.button
          onClick={save}
          disabled={saving}
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.95 }}
          className="h-8 px-5 rounded-full bg-accent border-none cursor-pointer flex items-center justify-center min-w-[70px] disabled:opacity-50 transition-opacity flex-shrink-0"
        >
          {saving ? <Spinner /> : <span className="text-white font-bold text-[12px]">Salvar</span>}
        </motion.button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {error && (
          <div className="mb-4 px-4 py-2.5 rounded-xl bg-destructive/10 border border-destructive/30">
            <span className="text-destructive text-[12px]">{error}</span>
          </div>
        )}

        <div className="mb-5">
          <p className={fieldLabel}>NOME</p>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="ex: Bom dia"
            className={smallInput}
          />
        </div>

        <div className="mb-5">
          <p className={fieldLabel}>PROMPT</p>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Instrução que a Elfie vai executar sozinha, ex: dê um bom dia carinhoso e resuma minha agenda de hoje..."
            className="text-white text-[13px] border border-foreground rounded-2xl px-4 py-3 outline-none resize-none w-full placeholder:text-gray-400 bg-foreground"
            style={{ minHeight: 120 }}
          />
          <p className="text-gray-300 text-[11px] mt-1.5 m-0">
            Ela pode usar as mesmas ferramentas de uma conversa normal (Gmail, Calendar, busca, etc.) se conectadas.
          </p>
        </div>

        <div className="mb-5">
          <p className={fieldLabel}>HORÁRIO</p>
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className={smallInput}
          />
        </div>

        <div className="mb-5">
          <p className={fieldLabel}>DIAS DA SEMANA</p>
          <div className="flex flex-wrap gap-1.5">
            {DAY_LABELS.map((label, d) => (
              <motion.button
                key={d}
                onClick={() => toggleDay(d)}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                className={`px-3 py-1.5 rounded-full text-[11px] font-semibold border-none cursor-pointer transition-colors ${
                  daysOfWeek.includes(d) ? 'bg-accent text-white' : 'bg-foreground text-gray-400 hover:text-gray-200'
                }`}
              >
                {label}
              </motion.button>
            ))}
          </div>
          <p className="text-gray-300 text-[11px] mt-1.5 m-0">Nenhum dia selecionado = todo dia.</p>
        </div>

        <div className="mb-5">
          <p className={fieldLabel}>PERSONAGEM</p>
          <select
            value={characterId}
            onChange={(e) => setCharacterId(e.target.value)}
            className={smallInput}
          >
            <option value="">Personagem ativo</option>
            {characters.map((c) => (
              <option key={c._id} value={c._id}>{c.name}</option>
            ))}
          </select>
        </div>

        <div className="mb-5 flex items-center justify-between">
          <div>
            <p className={`${fieldLabel} mb-0.5`}>ATIVA</p>
            <p className="text-gray-300 text-[11px] m-0">Rotinas desativadas não disparam.</p>
          </div>
          <Switch checked={enabled} onChange={() => setEnabled((v) => !v)} />
        </div>

        <div className="mb-5 flex items-center justify-between">
          <div>
            <p className={`${fieldLabel} mb-0.5`}>NOTIFICAÇÃO PUSH</p>
            <p className="text-gray-300 text-[11px] m-0">Além de salvar no chat, envia uma notificação.</p>
          </div>
          <Switch checked={notify} onChange={() => setNotify((v) => !v)} />
        </div>

        <div className="mb-5 flex items-center justify-between">
          <div>
            <p className={`${fieldLabel} mb-0.5`}>FORÇAR TTS</p>
            <p className="text-gray-300 text-[11px] m-0">
              Liga o daemon local, fala a resposta em voz alta e já deixa o microfone ativo.
            </p>
          </div>
          <Switch checked={forceTts} onChange={() => setForceTts((v) => !v)} />
        </div>

        <div className="mb-5">
          <p className={fieldLabel}>AUTOMAÇÕES DISPARADAS</p>
          <p className="text-gray-300 text-[11px] mt-0.5 mb-2 m-0">
            Além do prompt acima, dispara essas automações sempre que a rotina roda.
          </p>
          {workflows.length === 0 ? (
            <p className="text-gray-500 text-[12px] m-0">Nenhuma automação cadastrada ainda.</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {workflows.map((w) => (
                <label
                  key={w._id}
                  className="flex items-center gap-2.5 py-2 px-3 rounded-xl bg-foreground cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={triggeredWorkflowIds.includes(w._id)}
                    onChange={() => toggleTriggeredWorkflow(w._id)}
                    className="accent-accent"
                  />
                  <span className="text-white text-[12px] font-medium truncate">{w.name}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        {!isNew && (
          <div className="mb-5 pt-4 border-t border-foreground">
            <p className={fieldLabel}>TESTAR</p>
            <motion.button
              onClick={runNow}
              disabled={running}
              whileHover={{ scale: 1.04 }}
              whileTap={{ scale: 0.95 }}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border-none cursor-pointer transition-colors bg-accent/[0.12] hover:bg-accent/20 disabled:opacity-50"
            >
              {running ? <Spinner /> : <Play size={11} color="var(--accent)" />}
              <span className="text-accent font-semibold text-[12px]">Executar agora</span>
            </motion.button>
            {runResult && <p className="text-gray-300 text-[11px] mt-2 m-0">{runResult}</p>}
          </div>
        )}

        {!isNew && (
          <motion.button
            onClick={remove}
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.96 }}
            className="flex items-center gap-2 py-2 px-4 rounded-full border border-destructive/30 bg-transparent cursor-pointer hover:bg-destructive/10 transition-colors"
          >
            <X size={12} color="#ff382b" />
            <span className="text-destructive font-semibold text-[12px]">Apagar rotina</span>
          </motion.button>
        )}
      </div>
    </div>
  );
});


function workflowTriggerLabel(workflow: Pick<Workflow, 'nodes'>) {
  const types = new Set(workflow.nodes.map((n) => n.type));
  const parts: string[] = [];
  if (types.has('webhook')) parts.push('Webhook');
  if (types.has('schedule')) parts.push('Agendado');
  if (types.has('routine')) parts.push('Rotina');
  return parts.length ? parts.join(' + ') : 'Sem gatilho';
}

const WorkflowRow = memo(({ workflow, idx, onOpen, onToggle }: {
  workflow: Workflow; idx: number; onOpen: () => void; onToggle: () => void;
}) => (
  <motion.div
    layout
    initial={{ opacity: 0, y: 10 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, x: -12, transition: { duration: 0.15 } }}
    transition={{ type: 'spring', stiffness: 420, damping: 38, delay: idx * 0.025 }}
    whileHover={{ scale: 1.01 }}
    className="flex items-center gap-3 py-3 px-4 rounded-2xl bg-foreground hover:bg-foreground/60 cursor-pointer"
    style={{ transition: 'background-color 0.2s' }}
    onClick={onOpen}
  >
    <div className="w-7 h-7 rounded-full flex items-center justify-center bg-background flex-shrink-0">
      <FlowIcon size={13} color="#8a8a94" />
    </div>
    <div className="flex-1 min-w-0">
      <p className="text-white text-[13px] font-semibold m-0 truncate">{workflow.name}</p>
      <p className="text-gray-400 text-[11px] m-0 truncate">
        {workflowTriggerLabel(workflow)} · {workflow.nodes.length} nó{workflow.nodes.length === 1 ? '' : 's'}
      </p>
    </div>
    <div onClick={(e) => e.stopPropagation()} className="flex-shrink-0">
      <Switch checked={workflow.enabled} onChange={onToggle} size="sm" />
    </div>
    <Pencil size={12} color="#777" className="flex-shrink-0" />
  </motion.div>
));


const FolderCard = memo(({ folder, idx, onOpen, onEdit }: {
  folder: KnowledgeFolder; idx: number; onOpen: () => void; onEdit: () => void;
}) => (
  <motion.div
    layout
    initial={{ opacity: 0, y: 10 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, scale: 0.92 }}
    transition={{ type: 'spring', stiffness: 420, damping: 36, delay: idx * 0.03 }}
    whileHover={{ scale: 1.02 }}
    whileTap={{ scale: 0.98 }}
    onClick={onOpen}
    className="group relative flex flex-col gap-3 p-4 rounded-2xl bg-foreground hover:bg-foreground/70 cursor-pointer"
    style={{ transition: 'background-color 0.2s' }}
  >
    <motion.button
      onClick={(e) => { e.stopPropagation(); onEdit(); }}
      whileHover={{ scale: 1.15 }}
      whileTap={{ scale: 0.9 }}
      className="absolute top-3 right-3 p-1 rounded-full border-none cursor-pointer bg-background/60 transition-opacity opacity-0 group-hover:opacity-100"
    >
      <Pencil size={10} color="#999" />
    </motion.button>

    <div className="flex items-center gap-2">
      <div className="w-7 h-7 rounded-full flex items-center justify-center bg-background flex-shrink-0">
        <Folder size={13} color="#f2b84b" />
      </div>
      <p className="text-white text-[13px] font-semibold m-0 truncate pr-4">{folder.name}</p>
    </div>
    <p className="text-gray-400 text-[11px] leading-4 m-0 overflow-hidden" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
      {folder.description || 'Sem descrição.'}
    </p>
    {folder.tags.length > 0 && (
      <div className="flex flex-wrap gap-1">
        {folder.tags.map((t) => (
          <span key={t} className="px-2 py-0.5 rounded-full bg-background text-gray-300 text-[10px] font-semibold">
            {t}
          </span>
        ))}
      </div>
    )}
    <p className="text-gray-500 text-[10px] font-semibold tracking-wide m-0">
      {folder.files.length} {folder.files.length === 1 ? 'arquivo' : 'arquivos'}
    </p>
  </motion.div>
));


const FileRow = memo(({ file, idx, onOpen }: { file: string; idx: number; onOpen: () => void }) => (
  <motion.div
    layout
    initial={{ opacity: 0, y: 10 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, x: -12, transition: { duration: 0.15 } }}
    transition={{ type: 'spring', stiffness: 420, damping: 38, delay: idx * 0.025 }}
    whileHover={{ scale: 1.01 }}
    className="flex items-center gap-3 py-3 px-4 rounded-2xl bg-foreground hover:bg-foreground/60 cursor-pointer"
    style={{ transition: 'background-color 0.2s' }}
    onClick={onOpen}
  >
    <FileText size={14} color="#c9954f" className="flex-shrink-0" />
    <p className="text-white text-[13px] font-semibold m-0 flex-1 truncate">{file}</p>
    <Pencil size={12} color="#777" className="flex-shrink-0" />
  </motion.div>
));


const KnowledgeSearchResultRow = memo(({ result, idx, onOpen }: {
  result: KnowledgeSearchResult; idx: number; onOpen: () => void;
}) => (
  <motion.div
    layout
    initial={{ opacity: 0, y: 10 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, transition: { duration: 0.15 } }}
    transition={{ type: 'spring', stiffness: 420, damping: 38, delay: idx * 0.03 }}
    whileHover={{ scale: 1.01 }}
    className="flex flex-col gap-1.5 p-4 rounded-2xl bg-foreground hover:bg-foreground/60 cursor-pointer"
    style={{ transition: 'background-color 0.2s' }}
    onClick={onOpen}
  >
    <div className="flex items-center gap-2">
      <FileText size={12} color="#c9954f" className="flex-shrink-0" />
      <p className="text-gray-400 text-[11px] font-semibold m-0 truncate">{result.folder}/{result.file}</p>
    </div>
    <p className="text-white text-[13px] leading-5 m-0 overflow-hidden" style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' }}>
      {result.text}
    </p>
    {result.tags.length > 0 && (
      <div className="flex flex-wrap gap-1 mt-0.5">
        {result.tags.map((t) => (
          <span key={t} className="px-2 py-0.5 rounded-full bg-background text-gray-300 text-[10px] font-semibold">{t}</span>
        ))}
      </div>
    )}
  </motion.div>
));


const FolderEditor = memo(({ folder, onClose, onSaved, onDeleted }: {
  folder: Partial<KnowledgeFolder> | null;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) => {
  const [name, setName] = useState(folder?.name ?? '');
  const [description, setDescription] = useState(folder?.description ?? '');
  const [tags, setTags] = useState<string[]>(folder?.tags ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const { createFolder, updateFolder, deleteFolder, tags: tagTaxonomy, loadTags } = useKnowledgeStore();
  useEffect(() => { loadTags(); }, [loadTags]);

  const isNew = !folder?.name;

  const save = useCallback(async () => {
    const trimmedName = name.trim();
    if (!trimmedName) { setError('Nome da pasta é obrigatório.'); return; }
    setError('');
    setSaving(true);
    const result = isNew
      ? await createFolder(trimmedName, description, tags)
      : await updateFolder(trimmedName, description, tags);
    setSaving(false);
    if (!result.ok) { setError(result.error || 'Erro ao salvar.'); return; }
    onSaved();
  }, [name, description, tags, isNew, createFolder, updateFolder, onSaved]);

  const remove = useCallback(async () => {
    if (!folder?.name) return;
    if (!window.confirm(`Apagar a pasta "${folder.name}" e todos os arquivos dentro dela? Isso não pode ser desfeito.`)) return;
    await deleteFolder(folder.name);
    onDeleted();
  }, [folder, deleteFolder, onDeleted]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-4 py-3.5 border-b border-foreground flex-shrink-0">
        <motion.button
          onClick={onClose}
          whileHover={{ scale: 1.08 }}
          whileTap={{ scale: 0.92 }}
          className="w-8 h-8 rounded-full flex items-center justify-center bg-foreground border-none cursor-pointer hover:bg-foreground transition-colors flex-shrink-0"
        >
          <ChevronLeft size={16} color="#888" />
        </motion.button>
        <span className="text-white font-semibold text-[14px] flex-1 truncate">
          {isNew ? 'Nova pasta de conhecimento' : 'Editar pasta'}
        </span>
        <motion.button
          onClick={save}
          disabled={saving}
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.95 }}
          className="h-8 px-5 rounded-full bg-accent border-none cursor-pointer flex items-center justify-center min-w-[70px] disabled:opacity-50 transition-opacity flex-shrink-0"
        >
          {saving ? <Spinner /> : <span className="text-white font-bold text-[12px]">Salvar</span>}
        </motion.button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {error && (
          <div className="mb-4 px-4 py-2.5 rounded-xl bg-destructive/10 border border-destructive/30">
            <span className="text-destructive text-[12px]">{error}</span>
          </div>
        )}

        <div className="mb-5">
          <p className={fieldLabel}>NOME DA PASTA (CATEGORIA)</p>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="ex: receitas"
            disabled={!isNew}
            className={`${smallInput} disabled:opacity-50`}
          />
          {!isNew && <p className="text-gray-300 text-[11px] mt-1.5 m-0">O nome da pasta não pode ser alterado depois de criada.</p>}
        </div>

        <div className="mb-5">
          <p className={fieldLabel}>DESCRIÇÃO</p>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Do que se trata essa pasta — ajuda ela a saber quando é relevante..."
            className="text-white text-[13px] border border-foreground rounded-2xl px-4 py-3 outline-none resize-none w-full placeholder:text-gray-400 bg-foreground"
            style={{ minHeight: 80 }}
          />
        </div>

        <div className="mb-5">
          <p className={fieldLabel}>TAGS</p>
          <TagChipInput
            tags={tags}
            onChange={setTags}
            suggestions={tagTaxonomy.map((t) => t.name)}
            placeholder="comida, cozinha, receitas rápidas..."
          />
        </div>

        {!isNew && (
          <motion.button
            onClick={remove}
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.96 }}
            className="flex items-center gap-2 py-2 px-4 rounded-full border border-destructive/30 bg-transparent cursor-pointer hover:bg-destructive/10 transition-colors"
          >
            <X size={12} color="#ff382b" />
            <span className="text-destructive font-semibold text-[12px]">Apagar pasta</span>
          </motion.button>
        )}
      </div>
    </div>
  );
});


const STATUS_LABEL: Record<string, string> = {
  queued: 'Na fila...',
  enriching: 'Analisando...',
  embedding: 'Indexando...',
  done: 'Pronto',
  error: 'Erro ao indexar',
};

const IngestStatusBadge = ({ status }: { status: IngestStatus | null }) => {
  if (!status || status.status === 'unknown') return null;
  const isBusy = status.status === 'queued' || status.status === 'enriching' || status.status === 'embedding';
  const color = status.status === 'done' ? '#4ade80' : status.status === 'error' ? '#ff382b' : '#f2b84b';
  return (
    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-foreground flex-shrink-0" title={status.error}>
      {isBusy ? <div className="w-2.5 h-2.5 rounded-full border-2 border-t-transparent spin" style={{ borderColor: color, borderTopColor: 'transparent' }} />
        : <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: color }} />}
      <span className="text-[10px] font-semibold" style={{ color }}>{STATUS_LABEL[status.status] ?? status.status}</span>
    </div>
  );
};

const FileEditor = memo(({ folderName, fileName, onClose, onSaved, onDeleted }: {
  folderName: string;
  fileName?: string;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) => {
  const [filename, setFilename] = useState(fileName ?? '');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(!!fileName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<IngestStatus | null>(null);

  const { getFileContent, saveFile, deleteFile, pollFileStatus } = useKnowledgeStore();
  const isNew = !fileName;

  useEffect(() => {
    if (!fileName) return;
    setLoading(true);
    getFileContent(folderName, fileName)
      .then((c) => { if (c !== null) setContent(c); else setError('Erro ao carregar arquivo.'); })
      .finally(() => setLoading(false));
    pollFileStatus(folderName, fileName).then(setStatus);
  }, [folderName, fileName, getFileContent, pollFileStatus]);

  useEffect(() => {
    if (!status || (status.status !== 'queued' && status.status !== 'enriching' && status.status !== 'embedding')) return;
    if (!filename) return;
    const id = setTimeout(() => pollFileStatus(folderName, filename).then(setStatus), 2000);
    return () => clearTimeout(id);
  }, [status, folderName, filename, pollFileStatus]);

  const save = useCallback(async () => {
    const trimmed = filename.trim();
    if (!trimmed) { setError('Nome do arquivo é obrigatório.'); return; }
    if (!/\.(txt|md)$/i.test(trimmed)) { setError('O nome precisa terminar em .txt ou .md.'); return; }
    setError('');
    setSaving(true);
    const result = await saveFile(folderName, trimmed, content);
    setSaving(false);
    if (!result.ok) { setError(result.error || 'Erro ao salvar.'); return; }
    setStatus({ status: 'queued' });
    onSaved();
  }, [folderName, filename, content, saveFile, onSaved]);

  const remove = useCallback(async () => {
    if (!fileName) return;
    if (!window.confirm(`Apagar o arquivo "${fileName}"?`)) return;
    await deleteFile(folderName, fileName);
    onDeleted();
  }, [folderName, fileName, deleteFile, onDeleted]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-4 py-3.5 border-b border-foreground flex-shrink-0">
        <motion.button
          onClick={onClose}
          whileHover={{ scale: 1.08 }}
          whileTap={{ scale: 0.92 }}
          className="w-8 h-8 rounded-full flex items-center justify-center bg-foreground border-none cursor-pointer hover:bg-foreground transition-colors flex-shrink-0"
        >
          <ChevronLeft size={16} color="#888" />
        </motion.button>
        <span className="text-white font-semibold text-[14px] flex-1 truncate">
          {isNew ? 'Novo arquivo' : filename}
        </span>
        <IngestStatusBadge status={status} />
        <motion.button
          onClick={save}
          disabled={saving || loading}
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.95 }}
          className="h-8 px-5 rounded-full bg-accent border-none cursor-pointer flex items-center justify-center min-w-[70px] disabled:opacity-50 transition-opacity flex-shrink-0"
        >
          {saving ? <Spinner /> : <span className="text-white font-bold text-[12px]">Salvar</span>}
        </motion.button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {error && (
          <div className="mb-4 px-4 py-2.5 rounded-xl bg-destructive/10 border border-destructive/30">
            <span className="text-destructive text-[12px]">{error}</span>
          </div>
        )}

        <div className="mb-5">
          <p className={fieldLabel}>NOME DO ARQUIVO</p>
          <input
            type="text"
            value={filename}
            onChange={(e) => setFilename(e.target.value)}
            placeholder="ex: bolo-de-chocolate.md"
            disabled={!isNew}
            className={`${smallInput} disabled:opacity-50`}
          />
          <p className="text-gray-300 text-[11px] mt-1.5 m-0">Precisa terminar em .txt ou .md.</p>
        </div>

        <div className="mb-5">
          <p className={fieldLabel}>CONTEÚDO</p>
          {loading ? (
            <div className="flex items-center justify-center py-10"><Spinner /></div>
          ) : (
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Conteúdo do arquivo..."
              className="text-white text-[13px] border border-foreground rounded-2xl px-4 py-3 outline-none resize-none w-full placeholder:text-gray-400 bg-foreground"
              style={{ minHeight: 280, fontFamily: 'monospace' }}
            />
          )}
        </div>

        {!isNew && (
          <motion.button
            onClick={remove}
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.96 }}
            className="flex items-center gap-2 py-2 px-4 rounded-full border border-destructive/30 bg-transparent cursor-pointer hover:bg-destructive/10 transition-colors"
          >
            <X size={12} color="#ff382b" />
            <span className="text-destructive font-semibold text-[12px]">Apagar arquivo</span>
          </motion.button>
        )}
      </div>
    </div>
  );
});


type Tab = 'personagens' | 'sobre-mim' | 'memoria' | 'provedor' | 'voz' | 'skills' | 'rotinas' | 'automacoes' | 'conhecimento' | 'mind' | 'aparencia' | 'integracoes' | 'debug';

export default function SettingsScreen({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { characters, activeCharacterId, loadSettings, aiName, accentColor, setAccentColor } = useSettingsStore();
  const { skills, packages, loadSkills, loadPackages } = useSkillsStore();
  const { voicePresets, loadVoicePresets } = useVoicePresetsStore();
  const {
    folders: knowledgeFolders, loadFolders, search: searchKnowledge, searchResults: knowledgeSearchResults,
    searching: knowledgeSearching, clearSearch: clearKnowledgeSearch, reindexAll: reindexKnowledge,
  } = useKnowledgeStore();
  const { integrations, loadIntegrations, disconnect: disconnectIntegration } = useIntegrationsStore();
  const { routines, loadRoutines, updateRoutine: patchRoutine } = useRoutinesStore();
  const { workflows, loadWorkflows, updateWorkflow: patchWorkflow, createWorkflow } = useWorkflowsStore();
  const errorCount = useDebugStore((s) => s.logs.filter((l) => l.level === 'error').length);

  const [tab, setTab] = useState<Tab>('personagens');
  const [editingCharacter, setEditingCharacter] = useState<Partial<Character> | null | undefined>(undefined);
  const [editingSkill, setEditingSkill] = useState<Partial<Skill> | null | undefined>(undefined);
  const [editingPackage, setEditingPackage] = useState<Partial<SkillPackage> | null | undefined>(undefined);
  const [editingVoicePreset, setEditingVoicePreset] = useState<Partial<VoicePreset> | null | undefined>(undefined);
  const [editingRoutine, setEditingRoutine] = useState<Partial<Routine> | null | undefined>(undefined);
  const [openWorkflowId, setOpenWorkflowId] = useState<string | null>(null);
  const [creatingWorkflow, setCreatingWorkflow] = useState(false);
  const [selectedPackageId, setSelectedPackageId] = useState<string | null>(null);
  const [editingFolder, setEditingFolder] = useState<Partial<KnowledgeFolder> | null | undefined>(undefined);
  const [editingFile, setEditingFile] = useState<{ folder: string; file?: string } | undefined>(undefined);
  const [selectedFolderName, setSelectedFolderName] = useState<string | null>(null);
  const [knowledgeQuery, setKnowledgeQuery] = useState('');
  const [reindexing, setReindexing] = useState(false);
  const [reindexMessage, setReindexMessage] = useState<string | null>(null);

  const [userPhoto, setUserPhoto] = useState('');
  const [localUserPhoto, setLocalUserPhoto] = useState<{ uri: string; base64: string } | null>(null);
  const [userName, setUserName] = useState('');
  const [userBasicData, setUserBasicData] = useState('');
  const [userCity, setUserCity] = useState('');
  const [detectingCity, setDetectingCity] = useState(false);
  const [longTermMemory, setLongTermMemory] = useState<string[]>([]);
  const [newMemory, setNewMemory] = useState('');
  const [llmProvider, setLlmProvider] = useState<'openrouter' | 'deepseek'>('openrouter');
  const [deepseekApiKey, setDeepseekApiKey] = useState('');
  const [deepseekModel, setDeepseekModel] = useState('deepseek-v4-flash');
  const [unlimitedTools, setUnlimitedTools] = useState(false);
  const [ttsProvider, setTtsProvider] = useState<'elevenlabs' | 'fishaudio'>('elevenlabs');
  const [sttProvider, setSttProvider] = useState<'elevenlabs' | 'fishaudio'>('elevenlabs');
  const [fishaudioApiKey, setFishaudioApiKey] = useState('');
  const [googleClientId, setGoogleClientId] = useState('');
  const [googleClientSecret, setGoogleClientSecret] = useState('');
  const [googleRedirectUri, setGoogleRedirectUri] = useState('');
  const [googleConfigured, setGoogleConfigured] = useState(false);
  const [googleConfigOpen, setGoogleConfigOpen] = useState(false);
  const [savingGoogle, setSavingGoogle] = useState(false);
  const [copiedRedirectUri, setCopiedRedirectUri] = useState(false);
  const [telegramBotToken, setTelegramBotToken] = useState('');
  const [telegramOwnerId, setTelegramOwnerId] = useState('');
  const [savingTelegram, setSavingTelegram] = useState(false);
  const [unlinkingTelegram, setUnlinkingTelegram] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showDebug, setShowDebug] = useState(false);

  const userPhotoFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    Promise.all([
      fetch(`${API_BASE}/api/settings`).then((r) => r.json()),
      fetch(`${API_BASE}/api/characters`).then((r) => r.json()),
      fetch(`${API_BASE}/api/integrations/google/config`).then((r) => r.json()).catch(() => ({ redirectUri: '', configured: false })),
    ])
      .then(([settings, charsData, googleConfig]) => {
        setUserPhoto(settings.userPhoto ?? '');
        setLocalUserPhoto(null);
        setUserCity(settings.userCity ?? '');
        setLlmProvider(settings.llmProvider === 'deepseek' ? 'deepseek' : 'openrouter');
        setDeepseekApiKey(settings.deepseekApiKey ?? '');
        setDeepseekModel(settings.deepseekModel || 'deepseek-v4-flash');
        setUnlimitedTools(!!settings.unlimitedTools);
        setTtsProvider(settings.ttsProvider === 'fishaudio' ? 'fishaudio' : 'elevenlabs');
        setSttProvider(settings.sttProvider === 'fishaudio' ? 'fishaudio' : 'elevenlabs');
        setFishaudioApiKey(settings.fishaudioApiKey ?? '');
        setGoogleClientId(settings.googleClientId ?? '');
        setGoogleClientSecret(settings.googleClientSecret ?? '');
        setGoogleRedirectUri(googleConfig.redirectUri ?? '');
        setGoogleConfigured(!!googleConfig.configured);
        setGoogleConfigOpen(!googleConfig.configured);
        setTelegramBotToken(settings.telegramBotToken ?? '');
        setTelegramOwnerId(settings.telegramOwnerId ?? '');
        const active =
          (charsData.characters ?? []).find((c: Character) => c._id === String(charsData.activeCharacterId))
          ?? charsData.characters?.[0];
        if (active) {
          setUserName(active.userName || '');
          setUserBasicData(active.userBasicData || '');
          setLongTermMemory(Array.isArray(active.longTermMemory) ? active.longTermMemory : []);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [visible]);

  useEffect(() => {
    if (visible) { loadSkills(); loadPackages(); loadVoicePresets(); loadFolders(); loadIntegrations(); loadRoutines(); loadWorkflows(); }
  }, [visible, loadSkills, loadPackages, loadVoicePresets, loadFolders, loadIntegrations, loadRoutines, loadWorkflows]);

  useEffect(() => {
    if (!visible) return;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== new URL(API_BASE).origin) return;
      if (e.data?.type === 'elfie-integration-connected') loadIntegrations();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [visible, loadIntegrations]);

  const connectGoogleService = useCallback((service: IntegrationService) => {
    const popup = window.open(
      `${API_BASE}/api/integrations/google/start?service=${service}`,
      'elfie-google-oauth',
      'width=520,height=650',
    );
    if (!popup) return;
    const poll = setInterval(() => {
      if (popup.closed) {
        clearInterval(poll);
        loadIntegrations();
      }
    }, 500);
  }, [loadIntegrations]);

  const toggleSkillEnabled = useCallback(async (s: Skill) => {
    try {
      await fetch(`${API_BASE}/api/skills/${s._id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !s.enabled }),
      });
      await loadSkills();
    } catch (err) { console.error('[toggleSkillEnabled]', err); }
  }, [loadSkills]);

  const toggleRoutineEnabled = useCallback(async (r: Routine) => {
    await patchRoutine(r._id, { enabled: !r.enabled });
  }, [patchRoutine]);

  const toggleWorkflowEnabled = useCallback(async (w: Workflow) => {
    await patchWorkflow(w._id, { enabled: !w.enabled });
  }, [patchWorkflow]);

  const createAndOpenWorkflow = useCallback(async () => {
    setCreatingWorkflow(true);
    const result = await createWorkflow({ name: 'Nova automação', nodes: [], edges: [] });
    setCreatingWorkflow(false);
    if (result.ok && result.workflow) setOpenWorkflowId(result.workflow._id);
  }, [createWorkflow]);

  const knowledgeSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleKnowledgeQueryChange = useCallback((q: string) => {
    setKnowledgeQuery(q);
    if (knowledgeSearchTimer.current) clearTimeout(knowledgeSearchTimer.current);
    if (!q.trim()) { clearKnowledgeSearch(); return; }
    knowledgeSearchTimer.current = setTimeout(() => searchKnowledge(q), 350);
  }, [searchKnowledge, clearKnowledgeSearch]);

  const runKnowledgeReindex = useCallback(async () => {
    setReindexing(true);
    setReindexMessage(null);
    const result = await reindexKnowledge();
    setReindexing(false);
    setReindexMessage(result.ok ? `${result.filesIndexed ?? 0} arquivo(s) reindexado(s).` : (result.error ?? 'Erro ao reindexar.'));
  }, [reindexKnowledge]);

  const ungroupedSkills = skills.filter((s) => !s.packageId);
  const selectedPackage = packages.find((p) => p._id === selectedPackageId) ?? null;
  const packageSkills = skills.filter((s) => s.packageId === selectedPackageId);
  const selectedFolder = knowledgeFolders.find((f) => f.name === selectedFolderName) ?? null;

  const handleUserPhotoChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const uri = URL.createObjectURL(file);
    const reader = new FileReader();
    reader.onload = () => setLocalUserPhoto({ uri, base64: (reader.result as string).split(',')[1] });
    reader.readAsDataURL(file);
  }, []);

  const activateCharacter = useCallback(async (id: string) => {
    try {
      await fetch(`${API_BASE}/api/characters/${id}/activate`, { method: 'PATCH' });
      await loadSettings();
      const char = characters.find((c) => c._id === id);
      if (char) {
        setUserName(char.userName || '');
        setUserBasicData(char.userBasicData || '');
        setLongTermMemory(Array.isArray(char.longTermMemory) ? char.longTermMemory : []);
      }
    } catch (err) { console.error('[activateCharacter]', err); }
  }, [loadSettings, characters]);

  const saveSobreMim = useCallback(async () => {
    setSaving(true);
    try {
      const settingsPatch: Record<string, unknown> = { userCity };
      if (localUserPhoto) settingsPatch.userPhotoBase64 = localUserPhoto.base64;
      const r = await fetch(`${API_BASE}/api/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settingsPatch),
      });
      if (!r.ok) throw new Error();
      if (activeCharacterId) {
        const r2 = await fetch(`${API_BASE}/api/characters/${activeCharacterId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userName, userBasicData }),
        });
        if (!r2.ok) throw new Error();
      }
      await loadSettings();
    } catch { window.alert('Erro ao salvar.'); }
    finally { setSaving(false); }
  }, [localUserPhoto, activeCharacterId, userName, userBasicData, userCity, loadSettings]);

  const detectCity = useCallback(() => {
    if (!navigator.geolocation) {
      window.alert('Geolocalização não suportada neste navegador.');
      return;
    }
    setDetectingCity(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const { latitude, longitude } = pos.coords;
          const res = await fetch(
            `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=pt`,
          );
          const data = await res.json();
          const city = data.city || data.locality || data.principalSubdivision || '';
          if (city) setUserCity(data.countryName ? `${city}, ${data.countryName}` : city);
          else window.alert('Não foi possível identificar a cidade a partir da sua localização.');
        } catch { window.alert('Erro ao buscar a cidade.'); }
        finally { setDetectingCity(false); }
      },
      () => { window.alert('Não foi possível obter sua localização. Verifique as permissões do navegador.'); setDetectingCity(false); },
      { enableHighAccuracy: false, timeout: 10000 },
    );
  }, []);

  const persistMemory = useCallback(async (next: string[]) => {
    if (!activeCharacterId) return;
    try {
      const r = await fetch(`${API_BASE}/api/characters/${activeCharacterId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ longTermMemory: next }),
      });
      if (!r.ok) throw new Error();
    } catch { window.alert('Erro ao salvar memória.'); }
  }, [activeCharacterId]);

  const saveProvider = useCallback(async () => {
    setSaving(true);
    try {
      const r = await fetch(`${API_BASE}/api/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ llmProvider, deepseekApiKey, deepseekModel, unlimitedTools }),
      });
      if (!r.ok) throw new Error();
      await loadSettings();
    } catch { window.alert('Erro ao salvar.'); }
    finally { setSaving(false); }
  }, [llmProvider, deepseekApiKey, deepseekModel, unlimitedTools, loadSettings]);

  const saveVoiceSettings = useCallback(async () => {
    setSaving(true);
    try {
      const r = await fetch(`${API_BASE}/api/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttsProvider, sttProvider, fishaudioApiKey }),
      });
      if (!r.ok) throw new Error();
    } catch { window.alert('Erro ao salvar.'); }
    finally { setSaving(false); }
  }, [ttsProvider, sttProvider, fishaudioApiKey]);

  const saveGoogleCredentials = useCallback(async () => {
    setSavingGoogle(true);
    try {
      const r = await fetch(`${API_BASE}/api/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ googleClientId, googleClientSecret }),
      });
      if (!r.ok) throw new Error();
      setGoogleConfigured(!!googleClientId.trim() && !!googleClientSecret.trim());
    } catch { window.alert('Erro ao salvar.'); }
    finally { setSavingGoogle(false); }
  }, [googleClientId, googleClientSecret]);

  const saveTelegramToken = useCallback(async () => {
    setSavingTelegram(true);
    try {
      const r = await fetch(`${API_BASE}/api/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telegramBotToken }),
      });
      if (!r.ok) throw new Error();
    } catch { window.alert('Erro ao salvar.'); }
    finally { setSavingTelegram(false); }
  }, [telegramBotToken]);

  const unlinkTelegram = useCallback(async () => {
    if (!window.confirm('Desvincular o Telegram? A próxima pessoa a mandar mensagem pro bot vira a nova dona da conversa.')) return;
    setUnlinkingTelegram(true);
    try {
      const r = await fetch(`${API_BASE}/api/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telegramUnlink: true }),
      });
      if (!r.ok) throw new Error();
      setTelegramOwnerId('');
    } catch { window.alert('Erro ao desvincular.'); }
    finally { setUnlinkingTelegram(false); }
  }, []);

  const copyRedirectUri = useCallback(() => {
    navigator.clipboard.writeText(googleRedirectUri).then(() => {
      setCopiedRedirectUri(true);
      setTimeout(() => setCopiedRedirectUri(false), 1500);
    }).catch(() => {});
  }, [googleRedirectUri]);

  const accentSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleAccentChange = useCallback((hex: string) => {
    setAccentColor(hex);
    if (accentSaveTimer.current) clearTimeout(accentSaveTimer.current);
    accentSaveTimer.current = setTimeout(() => {
      fetch(`${API_BASE}/api/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accentColor: hex }),
      }).catch((err) => console.error('[accentColor]', err));
    }, 400);
  }, [setAccentColor]);

  const [accentDraft, setAccentDraft] = useState(accentColor);
  useEffect(() => { setAccentDraft(accentColor); }, [accentColor]);
  const commitAccentDraft = useCallback(() => {
    const trimmed = accentDraft.trim();
    const normalized = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
    if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(normalized)) {
      handleAccentChange(normalized);
    } else {
      setAccentDraft(accentColor);
    }
  }, [accentDraft, accentColor, handleAccentChange]);

  const addMemory = useCallback(() => {
    const text = newMemory.trim();
    if (!text) return;
    const next = [...longTermMemory, text];
    setLongTermMemory(next);
    setNewMemory('');
    persistMemory(next);
  }, [newMemory, longTermMemory, persistMemory]);

  const userPhotoUri = localUserPhoto?.uri ?? (userPhoto ? `${API_BASE}/files/${userPhoto}` : null);

  const NAV: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'personagens', label: 'Personagens', icon: <Users size={14} /> },
    { id: 'sobre-mim',   label: 'Sobre mim',   icon: <User size={14} /> },
    { id: 'memoria',     label: 'Memória',      icon: <Brain size={14} /> },
    { id: 'provedor',    label: 'Provedor de IA', icon: <Cpu size={14} /> },
    { id: 'voz',         label: 'Voz',            icon: <Mic size={14} /> },
    { id: 'skills',      label: 'Skills',       icon: <Webhook size={14} /> },
    { id: 'rotinas',     label: 'Rotinas',      icon: <Clock size={14} /> },
    { id: 'automacoes', label: 'Automações',   icon: <FlowIcon size={14} /> },
    { id: 'conhecimento', label: 'Conhecimento', icon: <BookOpen size={14} /> },
    { id: 'mind',         label: 'Mind',          icon: <Network size={14} /> },
    { id: 'aparencia',   label: 'Aparência',    icon: <Palette size={14} /> },
    { id: 'integracoes', label: 'Integrações',  icon: <Plug size={14} /> },
    { id: 'debug',       label: 'Debug',        icon: <Bug size={14} /> },
  ];

  const isEditing = editingCharacter !== undefined || editingSkill !== undefined || editingPackage !== undefined
    || editingVoicePreset !== undefined
    || editingRoutine !== undefined || editingFolder !== undefined || editingFile !== undefined || openWorkflowId !== null;
  const isKnowledgeExpanded = tab === 'conhecimento' || tab === 'mind' || editingFolder !== undefined || editingFile !== undefined
    || openWorkflowId !== null;

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          className="fixed inset-0 z-[100] flex items-center justify-center"
          style={{ backgroundColor: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(6px)' }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.22, ease: 'easeOut' }}
          onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
          <input ref={userPhotoFileRef} type="file" accept="image/*" className="hidden" onChange={handleUserPhotoChange} />

          <motion.div
            layout
            className="flex overflow-hidden border border-foreground shadow-2xl bg-background"
            style={{
              width: isKnowledgeExpanded ? '80vw' : 880,
              height: isKnowledgeExpanded ? '80vh' : 600,
              borderRadius: 18,
            }}
            initial={{ opacity: 0, scale: 0.92, y: 18 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ type: 'spring', stiffness: 340, damping: 30, mass: 0.9 }}
          >
            <div className="flex flex-col flex-shrink-0 border-r border-foreground bg-background" style={{ width: 196 }}>
              <motion.div
                className="px-5 pt-5 pb-4 flex-shrink-0"
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.08, duration: 0.25 }}
              >
                <span className="text-white font-semibold text-[14px]">Configurações</span>
              </motion.div>

              <nav className="flex-1 px-2 flex flex-col gap-0.5">
                {NAV.map(({ id, label, icon }, navIdx) => {
                  const isActive = tab === id && !isEditing;
                  return (
                    <motion.button
                      key={id}
                      onClick={() => { setTab(id); setEditingCharacter(undefined); setEditingSkill(undefined); setEditingPackage(undefined); setEditingVoicePreset(undefined); setSelectedPackageId(null); setEditingFolder(undefined); setEditingFile(undefined); setSelectedFolderName(null); setOpenWorkflowId(null); }}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.1 + navIdx * 0.04, duration: 0.25 }}
                      whileTap={{ scale: 0.96 }}
                      className={`relative px-3 py-2 rounded-full border-none cursor-pointer text-left w-full ${
                        isActive ? 'text-white' : 'text-gray-500 hover:bg-foreground/50 hover:text-gray-300'
                      }`}
                      style={{ transition: 'color 0.2s, background-color 0.2s' }}
                    >
                      {isActive && (
                        <motion.div
                          layoutId="nav-active-pill"
                          className="absolute inset-0 bg-foreground rounded-full"
                          transition={{ type: 'spring', stiffness: 500, damping: 38 }}
                        />
                      )}
                      <span className="relative z-10 flex items-center gap-2.5">
                        {icon}
                        <span className="text-[13px] font-medium">{label}</span>
                        {id === 'debug' && errorCount > 0 && (
                          <span
                            className="ml-auto rounded-full px-1.5 text-white text-[10px] font-bold bg-destructive"
                            style={{ paddingTop: 2, paddingBottom: 2 }}
                          >
                            {errorCount}
                          </span>
                        )}
                      </span>
                    </motion.button>
                  );
                })}
              </nav>
            </div>

            <div className="flex-1 flex flex-col overflow-hidden relative">

              {!isEditing && (
                <motion.button
                  onClick={onClose}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.12 }}
                  whileHover={{ scale: 1.1, rotate: 90 }}
                  whileTap={{ scale: 0.9 }}
                  className="absolute top-3.5 right-4 z-10 p-1.5 rounded-full border-none cursor-pointer transition-colors bg-transparent hover:bg-foreground/60"
                >
                  <X size={15} color="#555" />
                </motion.button>
              )}

              <AnimatePresence mode="wait" initial={false}>
                {loading ? (
                  <motion.div
                    key="loading"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="flex-1 flex items-center justify-center"
                  >
                    <div className="w-5 h-5 rounded-full border-2 border-accent border-t-transparent spin" />
                  </motion.div>
                ) : editingCharacter !== undefined ? (
                  <motion.div
                    key="char-editor"
                    initial={{ opacity: 0, x: 28 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 28 }}
                    transition={{ type: 'spring', stiffness: 420, damping: 38 }}
                    className="h-full"
                  >
                    <CharacterEditor
                      character={editingCharacter}
                      ttsProvider={ttsProvider}
                      onClose={() => setEditingCharacter(undefined)}
                      onSaved={async () => { await loadSettings(); setEditingCharacter(undefined); }}
                    />
                  </motion.div>
                ) : editingSkill !== undefined ? (
                  <motion.div
                    key="skill-editor"
                    initial={{ opacity: 0, x: 28 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 28 }}
                    transition={{ type: 'spring', stiffness: 420, damping: 38 }}
                    className="h-full"
                  >
                    <SkillEditor
                      skill={editingSkill}
                      packages={packages}
                      onClose={() => setEditingSkill(undefined)}
                      onSaved={async () => { await loadSkills(); setEditingSkill(undefined); }}
                    />
                  </motion.div>
                ) : editingPackage !== undefined ? (
                  <motion.div
                    key="package-editor"
                    initial={{ opacity: 0, x: 28 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 28 }}
                    transition={{ type: 'spring', stiffness: 420, damping: 38 }}
                    className="h-full"
                  >
                    <PackageEditor
                      pkg={editingPackage}
                      onClose={() => setEditingPackage(undefined)}
                      onSaved={async () => { await loadPackages(); setEditingPackage(undefined); }}
                      onDeleted={async () => { await Promise.all([loadPackages(), loadSkills()]); setEditingPackage(undefined); setSelectedPackageId(null); }}
                    />
                  </motion.div>
                ) : editingVoicePreset !== undefined ? (
                  <motion.div
                    key="voice-preset-editor"
                    initial={{ opacity: 0, x: 28 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 28 }}
                    transition={{ type: 'spring', stiffness: 420, damping: 38 }}
                    className="h-full"
                  >
                    <VoicePresetEditor
                      preset={editingVoicePreset}
                      onClose={() => setEditingVoicePreset(undefined)}
                      onSaved={async () => { await loadVoicePresets(); setEditingVoicePreset(undefined); }}
                      onDeleted={async () => { await loadVoicePresets(); setEditingVoicePreset(undefined); }}
                    />
                  </motion.div>
                ) : editingRoutine !== undefined ? (
                  <motion.div
                    key="routine-editor"
                    initial={{ opacity: 0, x: 28 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 28 }}
                    transition={{ type: 'spring', stiffness: 420, damping: 38 }}
                    className="h-full"
                  >
                    <RoutineEditor
                      routine={editingRoutine}
                      characters={characters}
                      workflows={workflows}
                      onClose={() => setEditingRoutine(undefined)}
                      onSaved={async () => { await loadRoutines(); setEditingRoutine(undefined); }}
                    />
                  </motion.div>
                ) : openWorkflowId !== null ? (
                  <motion.div
                    key="workflow-editor"
                    initial={{ opacity: 0, x: 28 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 28 }}
                    transition={{ type: 'spring', stiffness: 420, damping: 38 }}
                    className="h-full"
                  >
                    <WorkflowEditor
                      workflowId={openWorkflowId}
                      characters={characters}
                      routines={routines}
                      onClose={async () => { await loadWorkflows(); setOpenWorkflowId(null); }}
                    />
                  </motion.div>
                ) : editingFolder !== undefined ? (
                  <motion.div
                    key="folder-editor"
                    initial={{ opacity: 0, x: 28 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 28 }}
                    transition={{ type: 'spring', stiffness: 420, damping: 38 }}
                    className="h-full"
                  >
                    <FolderEditor
                      folder={editingFolder}
                      onClose={() => setEditingFolder(undefined)}
                      onSaved={async () => { await loadFolders(); setEditingFolder(undefined); }}
                      onDeleted={async () => { await loadFolders(); setEditingFolder(undefined); setSelectedFolderName(null); }}
                    />
                  </motion.div>
                ) : editingFile !== undefined ? (
                  <motion.div
                    key="file-editor"
                    initial={{ opacity: 0, x: 28 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 28 }}
                    transition={{ type: 'spring', stiffness: 420, damping: 38 }}
                    className="h-full"
                  >
                    <FileEditor
                      folderName={editingFile.folder}
                      fileName={editingFile.file}
                      onClose={() => setEditingFile(undefined)}
                      onSaved={async () => { await loadFolders(); setEditingFile(undefined); }}
                      onDeleted={async () => { await loadFolders(); setEditingFile(undefined); }}
                    />
                  </motion.div>
                ) : (
                  <motion.div
                    key={tab}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.2, ease: 'easeOut' }}
                    className="h-full"
                  >
              {tab === 'personagens' && (
                <div className="flex flex-col h-full overflow-hidden">
                  <div className="flex items-center justify-between px-6 py-4 border-b border-foreground flex-shrink-0 pr-12">
                    <span className="text-white font-semibold text-[14px]">Personagens</span>
                    <motion.button
                      onClick={() => setEditingCharacter(null)}
                      whileHover={{ scale: 1.04 }}
                      whileTap={{ scale: 0.95 }}
                      className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border-none cursor-pointer transition-colors bg-accent/[0.12] hover:bg-accent/20"
                    >
                      <Plus size={12} color="var(--accent)" />
                      <span className="text-accent font-semibold text-[12px]">Novo</span>
                    </motion.button>
                  </div>

                  <div className="flex-1 overflow-y-auto p-5">
                    <div
                      className="grid gap-2"
                      style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))' }}
                    >
                      <AnimatePresence initial={false}>
                        {characters.map((char, idx) => {
                          const isActive = char._id === activeCharacterId;
                          const uri = char.photo ? `${API_BASE}/files/${char.photo}` : null;
                          return (
                            <motion.div
                              key={char._id}
                              layout
                              initial={{ opacity: 0, scale: 0.85 }}
                              animate={{ opacity: 1, scale: 1 }}
                              exit={{ opacity: 0, scale: 0.85 }}
                              transition={{ type: 'spring', stiffness: 420, damping: 34, delay: idx * 0.03 }}
                              whileHover={{ scale: 1.04 }}
                              whileTap={{ scale: 0.97 }}
                              className={`group relative flex flex-col items-center gap-2.5 py-5 px-3 rounded-2xl cursor-pointer ${
                                isActive ? 'bg-foreground' : 'bg-foreground hover:bg-foreground/60'
                              }`}
                              style={{ transition: 'background-color 0.2s' }}
                              onClick={() => activateCharacter(char._id)}
                            >
                              <motion.button
                                onClick={(e) => { e.stopPropagation(); setEditingCharacter(char); }}
                                whileHover={{ scale: 1.15 }}
                                whileTap={{ scale: 0.9 }}
                                className="absolute top-2 right-2 p-1 rounded-full border-none cursor-pointer bg-background/60 transition-opacity opacity-0 group-hover:opacity-100"
                              >
                                <Pencil size={10} color="#777" />
                              </motion.button>

                              <div className="relative flex-shrink-0">
                                <div
                                  className="rounded-full overflow-hidden flex items-center justify-center bg-background"
                                  style={{ width: 56, height: 56 }}
                                >
                                  {uri
                                    ? <img src={uri} style={{ width: 56, height: 56, objectFit: 'cover' }} alt="" />
                                    : <User size={22} color="#555" />
                                  }
                                </div>
                                {isActive && (
                                  <motion.div
                                    layoutId="active-character-dot"
                                    className="absolute bottom-0 right-0 w-3.5 h-3.5 rounded-full bg-accent border-2 border-background"
                                    transition={{ type: 'spring', stiffness: 500, damping: 35 }}
                                  />
                                )}
                              </div>

                              <p className={`text-[12px] font-semibold truncate w-full text-center m-0 ${isActive ? 'text-white' : 'text-gray-400'}`}>
                                {char.name}
                              </p>
                            </motion.div>
                          );
                        })}
                      </AnimatePresence>
                    </div>
                  </div>
                </div>
              )}

              {tab === 'sobre-mim' && (
                <div className="flex flex-col h-full overflow-hidden">
                  <div className="px-6 py-4 border-b border-foreground flex-shrink-0 pr-12">
                    <span className="text-white font-semibold text-[14px]">Sobre mim</span>
                  </div>

                  <div className="flex-1 overflow-y-auto px-6 py-5">
                    <div className="flex items-center gap-5 mb-6">
                      <button
                        onClick={() => userPhotoFileRef.current?.click()}
                        className="relative bg-transparent border-none cursor-pointer p-0 flex-shrink-0"
                      >
                        <div
                          className="overflow-hidden flex items-center justify-center bg-foreground"
                          style={{ width: 68, height: 68, borderRadius: 18 }}
                        >
                          {userPhotoUri
                            ? <img src={userPhotoUri} style={{ width: 68, height: 68, objectFit: 'cover' }} alt="" />
                            : <User size={26} color="#555" />
                          }
                        </div>
                        <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-accent border-2 border-background flex items-center justify-center">
                          <Pencil size={9} color="#fff" />
                        </div>
                      </button>
                      <div className="flex-1 min-w-0">
                        <p className="text-gray-400 text-[10px] font-bold tracking-widest mb-1.5 m-0">SEU NOME</p>
                        <input
                          type="text"
                          value={userName}
                          onChange={(e) => setUserName(e.target.value)}
                          placeholder="Como a Elfie deve te chamar"
                          className="text-white text-[17px] font-bold bg-transparent border-none outline-none w-full placeholder:text-gray-400"
                        />
                      </div>
                    </div>

                    <div className="mb-6">
                      <p className="text-gray-400 text-[10px] font-bold tracking-widest mb-2 m-0">CIDADE</p>
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={userCity}
                          onChange={(e) => setUserCity(e.target.value)}
                          placeholder="Sua cidade"
                          className="text-white text-[13px] bg-foreground border border-foreground rounded-xl px-3 py-2 outline-none flex-1 placeholder:text-gray-400"
                        />
                        <motion.button
                          type="button"
                          onClick={detectCity}
                          disabled={detectingCity}
                          whileHover={{ scale: 1.04 }}
                          whileTap={{ scale: 0.95 }}
                          className="flex items-center gap-1.5 px-3 py-2 rounded-xl border-none cursor-pointer bg-accent/[0.12] hover:bg-accent/20 disabled:opacity-50 transition-colors flex-shrink-0"
                        >
                          {detectingCity ? <Spinner /> : <MapPin size={13} color="var(--accent)" />}
                          <span className="text-accent font-semibold text-[12px]">Detectar</span>
                        </motion.button>
                      </div>
                      <p className="text-gray-300 text-[11px] mt-1.5 m-0">
                        Enviado em todo prompt, junto com data, horário e dia da semana.
                      </p>
                    </div>

                    <div>
                      <p className="text-gray-400 text-[10px] font-bold tracking-widest mb-2 m-0">DADOS BÁSICOS</p>
                      <textarea
                        value={userBasicData}
                        onChange={(e) => setUserBasicData(e.target.value)}
                        placeholder="Idade, cidade, interesses, trabalho..."
                        className="text-white text-[13px] border border-foreground rounded-2xl px-4 py-3 outline-none resize-none w-full placeholder:text-gray-400 bg-foreground"
                        style={{ minHeight: 220 }}
                      />
                      <p className="text-gray-300 text-[11px] mt-1.5 m-0">Enviado em todo prompt.</p>
                    </div>
                  </div>

                  <div className="flex justify-end px-6 py-3.5 border-t border-foreground flex-shrink-0">
                    <motion.button
                      onClick={saveSobreMim}
                      disabled={saving}
                      whileHover={{ scale: 1.04 }}
                      whileTap={{ scale: 0.95 }}
                      className="h-8 px-6 rounded-full bg-accent border-none cursor-pointer flex items-center justify-center min-w-[76px] disabled:opacity-50 transition-opacity"
                    >
                      {saving ? <Spinner /> : <span className="text-white font-bold text-[12px]">Salvar</span>}
                    </motion.button>
                  </div>
                </div>
              )}

              {tab === 'memoria' && (
                <div className="flex flex-col h-full overflow-hidden">
                  <div className="px-6 py-4 border-b border-foreground flex-shrink-0 pr-12">
                    <span className="text-white font-semibold text-[14px]">Memória de longo prazo</span>
                    <p className="text-gray-400 text-[11px] mt-1 m-0">Fatos permanentes que a Elfie vai lembrar em toda conversa.</p>
                  </div>

                  <div className="flex-1 overflow-y-auto p-5">
                    {longTermMemory.length === 0 && (
                      <div className="flex items-center justify-center py-12">
                        <span className="text-gray-500 text-[13px]">Nenhuma memória ainda</span>
                      </div>
                    )}
                    <div className="flex flex-col gap-2">
                      <AnimatePresence initial={false}>
                        {longTermMemory.map((m, idx) => (
                          <MemoryItem
                            key={idx}
                            text={m}
                            onDelete={() => {
                              const next = longTermMemory.filter((_, i) => i !== idx);
                              setLongTermMemory(next);
                              persistMemory(next);
                            }}
                            onEdit={(t) => {
                              const next = [...longTermMemory];
                              next[idx] = t;
                              setLongTermMemory(next);
                              persistMemory(next);
                            }}
                          />
                        ))}
                      </AnimatePresence>
                    </div>
                  </div>

                  <div className="flex-shrink-0 border-t border-foreground p-4">
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={newMemory}
                        onChange={(e) => setNewMemory(e.target.value)}
                        placeholder="Adicionar memória..."
                        className={smallInput}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addMemory(); } }}
                      />
                      <motion.button
                        onClick={addMemory}
                        disabled={!newMemory.trim()}
                        whileHover={{ scale: 1.08 }}
                        whileTap={{ scale: 0.92 }}
                        animate={{ backgroundColor: newMemory.trim() ? 'var(--accent)' : '#232329' }}
                        transition={{ duration: 0.2 }}
                        className="w-9 h-9 rounded-full flex items-center justify-center border-none cursor-pointer flex-shrink-0 disabled:opacity-40"
                      >
                        <Plus size={15} color="#fff" />
                      </motion.button>
                    </div>
                  </div>
                </div>
              )}

              {tab === 'provedor' && (
                <div className="flex flex-col h-full overflow-hidden">
                  <div className="px-6 py-4 border-b border-foreground flex-shrink-0 pr-12">
                    <span className="text-white font-semibold text-[14px]">Provedor de IA</span>
                  </div>

                  <div className="flex-1 overflow-y-auto px-6 py-5">
                    <p className="text-gray-400 text-[10px] font-bold tracking-widest mb-3 m-0">PROVEDOR</p>
                    <div className="flex gap-2 mb-6">
                      {(['openrouter', 'deepseek'] as const).map((p) => (
                        <button
                          key={p}
                          onClick={() => setLlmProvider(p)}
                          className={`flex-1 py-2.5 rounded-xl text-[13px] font-semibold border cursor-pointer transition-colors ${
                            llmProvider === p
                              ? 'bg-accent text-white border-accent'
                              : 'bg-foreground text-gray-400 border-foreground hover:text-gray-200'
                          }`}
                        >
                          {p === 'openrouter' ? 'OpenRouter' : 'DeepSeek'}
                        </button>
                      ))}
                    </div>

                    {llmProvider === 'deepseek' && (
                      <div className="mb-6">
                        <p className="text-gray-400 text-[10px] font-bold tracking-widest mb-2 m-0">DEEPSEEK API KEY</p>
                        <input
                          type="password"
                          value={deepseekApiKey}
                          onChange={(e) => setDeepseekApiKey(e.target.value)}
                          placeholder="sk-..."
                          className="text-white text-[13px] bg-foreground border border-foreground rounded-xl px-4 py-2.5 outline-none w-full placeholder:text-gray-400"
                          autoComplete="off"
                        />
                      </div>
                    )}

                    {llmProvider === 'deepseek' && (
                      <div className="mb-6">
                        <p className="text-gray-400 text-[10px] font-bold tracking-widest mb-2 m-0">MODELO PADRÃO</p>
                        <div className="flex gap-2">
                          {DEEPSEEK_MODELS.map((m) => (
                            <button
                              key={m.value}
                              onClick={() => setDeepseekModel(m.value)}
                              className={`flex-1 py-2.5 rounded-xl text-[13px] font-semibold border cursor-pointer transition-colors ${
                                deepseekModel === m.value
                                  ? 'bg-accent text-white border-accent'
                                  : 'bg-foreground text-gray-400 border-foreground hover:text-gray-200'
                              }`}
                            >
                              {m.label}
                            </button>
                          ))}
                        </div>
                        <p className="text-gray-500 text-[11px] mt-1.5 m-0">
                          Usado quando um personagem não tem um modelo específico definido.
                        </p>
                      </div>
                    )}

                    <p className="text-gray-500 text-[12px] leading-5 m-0">
                      {llmProvider === 'deepseek'
                        ? 'Embeddings continuam via OpenRouter.'
                        : 'Acessa qualquer modelo via openrouter.ai.'}
                    </p>

                    <div className="mt-6 pt-5 border-t border-foreground flex items-center justify-between">
                      <div>
                        <p className={`${fieldLabel} mb-0.5`}>MODO SEM LIMITE</p>
                        <p className="text-gray-300 text-[11px] m-0 max-w-[320px]">
                          O conjunto de ferramentas do dia a dia fica sempre visível pra ela, em vez de só
                          aparecer quando ela decide que precisa. Gmail, Play Console, pixel art e afins
                          continuam abrindo sob demanda do mesmo jeito — isso só afeta o básico. Gasta mais
                          em toda mensagem. Ative só se custo não for problema.
                        </p>
                      </div>
                      <Switch checked={unlimitedTools} onChange={() => setUnlimitedTools((v) => !v)} />
                    </div>
                  </div>

                  <div className="flex justify-end px-6 py-3.5 border-t border-foreground flex-shrink-0">
                    <motion.button
                      onClick={saveProvider}
                      disabled={saving}
                      whileHover={{ scale: 1.04 }}
                      whileTap={{ scale: 0.95 }}
                      className="h-8 px-6 rounded-full bg-accent border-none cursor-pointer flex items-center justify-center min-w-[76px] disabled:opacity-50 transition-opacity"
                    >
                      {saving ? <Spinner /> : <span className="text-white font-bold text-[12px]">Salvar</span>}
                    </motion.button>
                  </div>
                </div>
              )}

              {tab === 'voz' && (
                <div className="flex flex-col h-full overflow-hidden">
                  <div className="px-6 py-4 border-b border-foreground flex-shrink-0 pr-12">
                    <span className="text-white font-semibold text-[14px]">Voz</span>
                  </div>

                  <div className="flex-1 overflow-y-auto px-6 py-5">
                    <p className="text-gray-400 text-[10px] font-bold tracking-widest mb-3 m-0">TEXT-TO-SPEECH</p>
                    <div className="flex gap-2 mb-6">
                      {(['elevenlabs', 'fishaudio'] as const).map((p) => (
                        <button
                          key={p}
                          onClick={() => setTtsProvider(p)}
                          className={`flex-1 py-2.5 rounded-xl text-[13px] font-semibold border cursor-pointer transition-colors ${
                            ttsProvider === p
                              ? 'bg-accent text-white border-accent'
                              : 'bg-foreground text-gray-400 border-foreground hover:text-gray-200'
                          }`}
                        >
                          {p === 'elevenlabs' ? 'ElevenLabs' : 'Fish Audio'}
                        </button>
                      ))}
                    </div>

                    <p className="text-gray-400 text-[10px] font-bold tracking-widest mb-3 m-0">RECONHECIMENTO DE VOZ</p>
                    <div className="flex gap-2 mb-6">
                      {(['elevenlabs', 'fishaudio'] as const).map((p) => (
                        <button
                          key={p}
                          onClick={() => setSttProvider(p)}
                          className={`flex-1 py-2.5 rounded-xl text-[13px] font-semibold border cursor-pointer transition-colors ${
                            sttProvider === p
                              ? 'bg-accent text-white border-accent'
                              : 'bg-foreground text-gray-400 border-foreground hover:text-gray-200'
                          }`}
                        >
                          {p === 'elevenlabs' ? 'ElevenLabs' : 'Fish Audio'}
                        </button>
                      ))}
                    </div>

                    {(ttsProvider === 'fishaudio' || sttProvider === 'fishaudio') && (
                      <div className="mb-6">
                        <p className="text-gray-400 text-[10px] font-bold tracking-widest mb-2 m-0">FISH AUDIO API KEY</p>
                        <input
                          type="password"
                          value={fishaudioApiKey}
                          onChange={(e) => setFishaudioApiKey(e.target.value)}
                          placeholder="fa-..."
                          className="text-white text-[13px] bg-foreground border border-foreground rounded-xl px-4 py-2.5 outline-none w-full placeholder:text-gray-400"
                          autoComplete="off"
                        />
                      </div>
                    )}

                    <p className="text-gray-500 text-[12px] leading-5 m-0">
                      ElevenLabs usa a chave configurada no servidor (ELEVENLABS_API_KEY).
                    </p>

                    <div className="mt-6 pt-5 border-t border-foreground">
                      <div className="flex items-center justify-between mb-3">
                        <p className={`${fieldLabel} mb-0`}>VOZES SALVAS</p>
                        <motion.button
                          onClick={() => setEditingVoicePreset(null)}
                          whileHover={{ scale: 1.04 }}
                          whileTap={{ scale: 0.95 }}
                          className="flex items-center gap-1.5 px-3 py-1 rounded-full border-none cursor-pointer transition-colors bg-accent/[0.12] hover:bg-accent/20"
                        >
                          <Plus size={11} color="var(--accent)" />
                          <span className="text-accent font-semibold text-[11px]">Nova</span>
                        </motion.button>
                      </div>
                      {voicePresets.length === 0 ? (
                        <p className="text-gray-500 text-[12px] m-0">Nenhuma voz salva ainda.</p>
                      ) : (
                        <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}>
                          <AnimatePresence initial={false}>
                            {voicePresets.map((preset, idx) => (
                              <VoicePresetCard
                                key={preset._id}
                                preset={preset}
                                idx={idx}
                                onEdit={() => setEditingVoicePreset(preset)}
                              />
                            ))}
                          </AnimatePresence>
                        </div>
                      )}
                      <p className="text-gray-300 text-[11px] mt-3 m-0">
                        Dê nomes que ela consiga reconhecer — ela pode trocar de voz sozinha durante a
                        conversa quando você pedir, tipo "fala com a voz X".
                      </p>
                    </div>
                  </div>

                  <div className="flex justify-end px-6 py-3.5 border-t border-foreground flex-shrink-0">
                    <motion.button
                      onClick={saveVoiceSettings}
                      disabled={saving}
                      whileHover={{ scale: 1.04 }}
                      whileTap={{ scale: 0.95 }}
                      className="h-8 px-6 rounded-full bg-accent border-none cursor-pointer flex items-center justify-center min-w-[76px] disabled:opacity-50 transition-opacity"
                    >
                      {saving ? <Spinner /> : <span className="text-white font-bold text-[12px]">Salvar</span>}
                    </motion.button>
                  </div>
                </div>
              )}

              {tab === 'skills' && (
                <div className="flex flex-col h-full overflow-hidden">
                  <AnimatePresence mode="wait" initial={false}>
                    {selectedPackageId === null ? (
                      <motion.div
                        key="pkg-overview"
                        initial={{ opacity: 0, x: -14 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -14 }}
                        transition={{ type: 'spring', stiffness: 420, damping: 38 }}
                        className="flex flex-col h-full overflow-hidden"
                      >
                        <div className="flex items-center justify-between px-6 py-4 border-b border-foreground flex-shrink-0 pr-12">
                          <span className="text-white font-semibold text-[14px]">Skills</span>
                          <div className="flex items-center gap-1.5">
                            <motion.button
                              onClick={() => setEditingPackage(null)}
                              whileHover={{ scale: 1.04 }}
                              whileTap={{ scale: 0.95 }}
                              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border-none cursor-pointer transition-colors bg-foreground hover:bg-foreground/70 text-gray-300"
                            >
                              <Package size={12} color="#8a8a94" />
                              <span className="font-semibold text-[12px]">Pacote</span>
                            </motion.button>
                            <motion.button
                              onClick={() => setEditingSkill(null)}
                              whileHover={{ scale: 1.04 }}
                              whileTap={{ scale: 0.95 }}
                              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border-none cursor-pointer transition-colors bg-accent/[0.12] hover:bg-accent/20"
                            >
                              <Plus size={12} color="var(--accent)" />
                              <span className="text-accent font-semibold text-[12px]">Nova</span>
                            </motion.button>
                          </div>
                        </div>

                        <div className="flex-1 overflow-y-auto p-5">
                          {packages.length === 0 && ungroupedSkills.length === 0 && (
                            <div className="flex items-center justify-center py-12">
                              <span className="text-gray-500 text-[13px]">Nenhuma skill cadastrada</span>
                            </div>
                          )}

                          {packages.length > 0 && (
                            <div className="mb-6">
                              <p className={fieldLabel}>PACOTES</p>
                              <div className="grid gap-2 mt-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}>
                                <AnimatePresence initial={false}>
                                  {packages.map((pkg, idx) => (
                                    <PackageCard
                                      key={pkg._id}
                                      pkg={pkg}
                                      idx={idx}
                                      count={skills.filter((s) => s.packageId === pkg._id).length}
                                      onOpen={() => setSelectedPackageId(pkg._id)}
                                      onEdit={() => setEditingPackage(pkg)}
                                    />
                                  ))}
                                </AnimatePresence>
                              </div>
                            </div>
                          )}

                          {ungroupedSkills.length > 0 && (
                            <div>
                              <p className={fieldLabel}>SEM PACOTE</p>
                              <div className="flex flex-col gap-2 mt-2">
                                <AnimatePresence initial={false}>
                                  {ungroupedSkills.map((s, idx) => (
                                    <SkillRow
                                      key={s._id}
                                      skill={s}
                                      idx={idx}
                                      onOpen={() => setEditingSkill(s)}
                                      onToggle={() => toggleSkillEnabled(s)}
                                    />
                                  ))}
                                </AnimatePresence>
                              </div>
                            </div>
                          )}
                        </div>
                      </motion.div>
                    ) : (
                      <motion.div
                        key="pkg-detail"
                        initial={{ opacity: 0, x: 14 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: 14 }}
                        transition={{ type: 'spring', stiffness: 420, damping: 38 }}
                        className="flex flex-col h-full overflow-hidden"
                      >
                        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-foreground flex-shrink-0 pr-12">
                          <motion.button
                            onClick={() => setSelectedPackageId(null)}
                            whileHover={{ scale: 1.08 }}
                            whileTap={{ scale: 0.92 }}
                            className="w-8 h-8 rounded-full flex items-center justify-center bg-foreground border-none cursor-pointer hover:bg-foreground transition-colors flex-shrink-0"
                          >
                            <ChevronLeft size={16} color="#888" />
                          </motion.button>
                          <span className="text-white font-semibold text-[14px] flex-1 truncate">{selectedPackage?.name}</span>
                          <motion.button
                            onClick={() => setEditingPackage(selectedPackage)}
                            whileHover={{ scale: 1.1 }}
                            whileTap={{ scale: 0.9 }}
                            className="p-1.5 rounded-full border-none cursor-pointer bg-transparent hover:bg-foreground transition-colors flex-shrink-0"
                          >
                            <Pencil size={12} color="#999" />
                          </motion.button>
                          <motion.button
                            onClick={() => setEditingSkill({ packageId: selectedPackageId })}
                            whileHover={{ scale: 1.04 }}
                            whileTap={{ scale: 0.95 }}
                            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border-none cursor-pointer transition-colors bg-accent/[0.12] hover:bg-accent/20 flex-shrink-0"
                          >
                            <Plus size={12} color="var(--accent)" />
                            <span className="text-accent font-semibold text-[12px]">Nova</span>
                          </motion.button>
                        </div>

                        {selectedPackage?.description && (
                          <p className="text-gray-400 text-[12px] leading-5 m-0 px-6 pt-3">{selectedPackage.description}</p>
                        )}

                        <div className="flex-1 overflow-y-auto p-5">
                          {packageSkills.length === 0 && (
                            <div className="flex items-center justify-center py-12">
                              <span className="text-gray-500 text-[13px]">Nenhuma skill neste pacote</span>
                            </div>
                          )}
                          <div className="flex flex-col gap-2">
                            <AnimatePresence initial={false}>
                              {packageSkills.map((s, idx) => (
                                <SkillRow
                                  key={s._id}
                                  skill={s}
                                  idx={idx}
                                  onOpen={() => setEditingSkill(s)}
                                  onToggle={() => toggleSkillEnabled(s)}
                                />
                              ))}
                            </AnimatePresence>
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )}

              {tab === 'rotinas' && (
                <div className="flex flex-col h-full overflow-hidden">
                  <div className="flex items-center justify-between px-6 py-4 border-b border-foreground flex-shrink-0 pr-12">
                    <span className="text-white font-semibold text-[14px]">Rotinas</span>
                    <motion.button
                      onClick={() => setEditingRoutine(null)}
                      whileHover={{ scale: 1.04 }}
                      whileTap={{ scale: 0.95 }}
                      className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border-none cursor-pointer transition-colors bg-accent/[0.12] hover:bg-accent/20"
                    >
                      <Plus size={12} color="var(--accent)" />
                      <span className="text-accent font-semibold text-[12px]">Nova</span>
                    </motion.button>
                  </div>

                  <div className="flex-1 overflow-y-auto p-5">
                    {routines.length === 0 && (
                      <div className="flex items-center justify-center py-12">
                        <span className="text-gray-500 text-[13px]">Nenhuma rotina cadastrada</span>
                      </div>
                    )}
                    <div className="flex flex-col gap-2">
                      <AnimatePresence initial={false}>
                        {routines.map((r, idx) => (
                          <RoutineRow
                            key={r._id}
                            routine={r}
                            idx={idx}
                            onOpen={() => setEditingRoutine(r)}
                            onToggle={() => toggleRoutineEnabled(r)}
                          />
                        ))}
                      </AnimatePresence>
                    </div>
                  </div>
                </div>
              )}

              {tab === 'automacoes' && (
                <div className="flex flex-col h-full overflow-hidden">
                  <div className="flex items-center justify-between px-6 py-4 border-b border-foreground flex-shrink-0 pr-12">
                    <span className="text-white font-semibold text-[14px]">Automações</span>
                    <motion.button
                      onClick={createAndOpenWorkflow}
                      disabled={creatingWorkflow}
                      whileHover={{ scale: 1.04 }}
                      whileTap={{ scale: 0.95 }}
                      className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border-none cursor-pointer transition-colors bg-accent/[0.12] hover:bg-accent/20 disabled:opacity-50"
                    >
                      {creatingWorkflow ? <Spinner /> : <Plus size={12} color="var(--accent)" />}
                      <span className="text-accent font-semibold text-[12px]">Nova</span>
                    </motion.button>
                  </div>

                  <div className="flex-1 overflow-y-auto p-5">
                    {workflows.length === 0 && (
                      <div className="flex items-center justify-center py-12">
                        <span className="text-gray-500 text-[13px]">Nenhuma automação cadastrada</span>
                      </div>
                    )}
                    <div className="flex flex-col gap-2">
                      <AnimatePresence initial={false}>
                        {workflows.map((w, idx) => (
                          <WorkflowRow
                            key={w._id}
                            workflow={w}
                            idx={idx}
                            onOpen={() => setOpenWorkflowId(w._id)}
                            onToggle={() => toggleWorkflowEnabled(w)}
                          />
                        ))}
                      </AnimatePresence>
                    </div>
                  </div>
                </div>
              )}

              {tab === 'conhecimento' && (
                <div className="flex flex-col h-full overflow-hidden">
                  <AnimatePresence mode="wait" initial={false}>
                    {selectedFolderName === null ? (
                      <motion.div
                        key="folder-overview"
                        initial={{ opacity: 0, x: -14 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -14 }}
                        transition={{ type: 'spring', stiffness: 420, damping: 38 }}
                        className="flex flex-col h-full overflow-hidden"
                      >
                        <div className="flex items-center justify-between px-6 py-4 border-b border-foreground flex-shrink-0 pr-12">
                          <span className="text-white font-semibold text-[14px]">Conhecimento</span>
                          <div className="flex items-center gap-1.5">
                            <motion.button
                              onClick={runKnowledgeReindex}
                              disabled={reindexing}
                              whileHover={{ scale: 1.04 }}
                              whileTap={{ scale: 0.95 }}
                              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border-none cursor-pointer transition-colors bg-foreground hover:bg-foreground/70 text-gray-300 disabled:opacity-50"
                            >
                              {reindexing ? <Spinner /> : <RefreshCw size={12} color="#8a8a94" />}
                              <span className="font-semibold text-[12px]">Reindexar</span>
                            </motion.button>
                            <motion.button
                              onClick={() => setEditingFolder(null)}
                              whileHover={{ scale: 1.04 }}
                              whileTap={{ scale: 0.95 }}
                              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border-none cursor-pointer transition-colors bg-accent/[0.12] hover:bg-accent/20"
                            >
                              <Plus size={12} color="var(--accent)" />
                              <span className="text-accent font-semibold text-[12px]">Nova pasta</span>
                            </motion.button>
                          </div>
                        </div>

                        <div className="px-6 pt-4 flex-shrink-0">
                          <div className="relative">
                            <Search size={13} color="#8a8a94" className="absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                            <input
                              type="text"
                              value={knowledgeQuery}
                              onChange={(e) => handleKnowledgeQueryChange(e.target.value)}
                              placeholder="Buscar na base de conhecimento..."
                              className="w-full text-white text-[13px] bg-foreground border border-foreground rounded-full pl-9 pr-4 py-2.5 outline-none placeholder:text-gray-400"
                            />
                          </div>
                          {reindexMessage && <p className="text-gray-300 text-[11px] mt-2 m-0">{reindexMessage}</p>}
                        </div>

                        <div className="flex-1 overflow-y-auto p-5">
                          {knowledgeQuery.trim() ? (
                            <>
                              {knowledgeSearching && (
                                <div className="flex items-center justify-center py-12"><Spinner /></div>
                              )}
                              {!knowledgeSearching && knowledgeSearchResults.length === 0 && (
                                <div className="flex items-center justify-center py-12">
                                  <span className="text-gray-500 text-[13px]">Nada encontrado.</span>
                                </div>
                              )}
                              <div className="flex flex-col gap-2">
                                <AnimatePresence initial={false}>
                                  {knowledgeSearchResults.map((r, idx) => (
                                    <KnowledgeSearchResultRow
                                      key={r.id}
                                      result={r}
                                      idx={idx}
                                      onOpen={() => setEditingFile({ folder: r.folder, file: r.file })}
                                    />
                                  ))}
                                </AnimatePresence>
                              </div>
                            </>
                          ) : (
                            <>
                              {knowledgeFolders.length === 0 && (
                                <div className="flex items-center justify-center py-12">
                                  <span className="text-gray-500 text-[13px]">Nenhuma pasta de conhecimento cadastrada</span>
                                </div>
                              )}
                              <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}>
                                <AnimatePresence initial={false}>
                                  {knowledgeFolders.map((f, idx) => (
                                    <FolderCard
                                      key={f.name}
                                      folder={f}
                                      idx={idx}
                                      onOpen={() => setSelectedFolderName(f.name)}
                                      onEdit={() => setEditingFolder(f)}
                                    />
                                  ))}
                                </AnimatePresence>
                              </div>
                            </>
                          )}
                        </div>
                      </motion.div>
                    ) : (
                      <motion.div
                        key="folder-detail"
                        initial={{ opacity: 0, x: 14 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: 14 }}
                        transition={{ type: 'spring', stiffness: 420, damping: 38 }}
                        className="flex flex-col h-full overflow-hidden"
                      >
                        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-foreground flex-shrink-0 pr-12">
                          <motion.button
                            onClick={() => setSelectedFolderName(null)}
                            whileHover={{ scale: 1.08 }}
                            whileTap={{ scale: 0.92 }}
                            className="w-8 h-8 rounded-full flex items-center justify-center bg-foreground border-none cursor-pointer hover:bg-foreground transition-colors flex-shrink-0"
                          >
                            <ChevronLeft size={16} color="#888" />
                          </motion.button>
                          <span className="text-white font-semibold text-[14px] flex-1 truncate">{selectedFolder?.name}</span>
                          <motion.button
                            onClick={() => setEditingFolder(selectedFolder)}
                            whileHover={{ scale: 1.1 }}
                            whileTap={{ scale: 0.9 }}
                            className="p-1.5 rounded-full border-none cursor-pointer bg-transparent hover:bg-foreground transition-colors flex-shrink-0"
                          >
                            <Pencil size={12} color="#999" />
                          </motion.button>
                          <motion.button
                            onClick={() => setEditingFile({ folder: selectedFolderName })}
                            whileHover={{ scale: 1.04 }}
                            whileTap={{ scale: 0.95 }}
                            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border-none cursor-pointer transition-colors bg-accent/[0.12] hover:bg-accent/20 flex-shrink-0"
                          >
                            <Plus size={12} color="var(--accent)" />
                            <span className="text-accent font-semibold text-[12px]">Novo arquivo</span>
                          </motion.button>
                        </div>

                        {selectedFolder?.description && (
                          <p className="text-gray-400 text-[12px] leading-5 m-0 px-6 pt-3">{selectedFolder.description}</p>
                        )}

                        <div className="flex-1 overflow-y-auto p-5">
                          {(selectedFolder?.files.length ?? 0) === 0 && (
                            <div className="flex items-center justify-center py-12">
                              <span className="text-gray-500 text-[13px]">Nenhum arquivo nesta pasta</span>
                            </div>
                          )}
                          <div className="flex flex-col gap-2">
                            <AnimatePresence initial={false}>
                              {selectedFolder?.files.map((file, idx) => (
                                <FileRow
                                  key={file}
                                  file={file}
                                  idx={idx}
                                  onOpen={() => setEditingFile({ folder: selectedFolderName!, file })}
                                />
                              ))}
                            </AnimatePresence>
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )}

              {tab === 'mind' && (
                <div className="flex flex-col h-full overflow-hidden">
                  <div className="flex items-center justify-between px-6 py-4 border-b border-foreground flex-shrink-0 pr-12">
                    <span className="text-white font-semibold text-[14px]">Mind</span>
                  </div>
                  <div className="flex-1 p-5 overflow-hidden">
                    <SkillNeuronGraph
                      packages={packages}
                      skills={skills}
                      knowledgeFolders={knowledgeFolders}
                      integrations={integrations}
                      aiName={aiName}
                      onOpenPackage={(pkg) => setEditingPackage(pkg)}
                      onOpenSkill={(s) => setEditingSkill(s)}
                      onOpenKnowledgeFolder={(f) => setEditingFolder(f)}
                      onOpenKnowledgeFile={(f, file) => setEditingFile({ folder: f.name, file })}
                      onOpenIntegration={() => setTab('integracoes')}
                      emptyMessage="Nada cadastrado ainda — crie uma skill ou uma pasta de conhecimento"
                    />
                  </div>
                </div>
              )}

              {tab === 'aparencia' && (
                <div className="flex flex-col h-full overflow-hidden">
                  <div className="px-6 py-4 border-b border-foreground flex-shrink-0 pr-12">
                    <span className="text-white font-semibold text-[14px]">Aparência</span>
                  </div>
                  <div className="flex-1 overflow-y-auto p-6">
                    <p className={fieldLabel}>COR DE DESTAQUE</p>
                    <div className="flex items-center gap-3 mt-2">
                      <label
                        className="relative rounded-full flex-shrink-0 cursor-pointer overflow-hidden"
                        style={{ width: 44, height: 44, background: accentColor, border: '2px solid #2a2a35' }}
                      >
                        <input
                          type="color"
                          value={accentColor}
                          onChange={(e) => handleAccentChange(e.target.value)}
                          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                        />
                      </label>
                      <input
                        type="text"
                        value={accentDraft}
                        onChange={(e) => setAccentDraft(e.target.value)}
                        onBlur={commitAccentDraft}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') e.currentTarget.blur();
                        }}
                        placeholder="#996dff"
                        maxLength={7}
                        spellCheck={false}
                        className="text-gray-300 text-[13px] font-mono uppercase bg-foreground border border-foreground rounded-lg px-3 py-2 outline-none w-28 placeholder:text-gray-500 placeholder:normal-case"
                      />
                    </div>
                    <p className="text-gray-500 text-[11px] mt-2 m-0">
                      Usada em botões, links e destaques pelo app inteiro. Muda na hora. Digite um hex (#RRGGBB) ou escolha na roda de cores.
                    </p>

                    <div className="flex items-center gap-2 mt-4 flex-wrap">
                      {['#996dff', '#5b9bff', '#3ddc97', '#ff8a5b', '#ff5b8f', '#f5d547'].map((c) => (
                        <motion.button
                          key={c}
                          onClick={() => handleAccentChange(c)}
                          whileHover={{ scale: 1.12 }}
                          whileTap={{ scale: 0.92 }}
                          className="rounded-full border-none cursor-pointer flex-shrink-0"
                          style={{
                            width: 26,
                            height: 26,
                            background: c,
                            outline: accentColor.toLowerCase() === c ? '2px solid #fff' : 'none',
                            outlineOffset: 2,
                          }}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {tab === 'integracoes' && (
                <div className="flex flex-col h-full overflow-hidden">
                  <div className="px-6 py-4 border-b border-foreground flex-shrink-0 pr-12">
                    <span className="text-white font-semibold text-[14px]">Integrações</span>
                  </div>
                  <div className="flex-1 overflow-y-auto p-5">
                    <div className="rounded-2xl bg-foreground p-4 mb-4">
                      <button
                        onClick={() => setGoogleConfigOpen((v) => !v)}
                        className="flex items-center justify-between w-full bg-transparent border-none cursor-pointer p-0"
                      >
                        <span className="text-white text-[13px] font-semibold">Configurar acesso ao Google</span>
                        <motion.div animate={{ rotate: googleConfigOpen ? 180 : 0 }} transition={{ duration: 0.2 }}>
                          <ChevronDown size={16} className="text-gray-400" />
                        </motion.div>
                      </button>

                      <AnimatePresence initial={false}>
                        {googleConfigOpen && (
                          <motion.div
                            key="google-config-content"
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.25, ease: 'easeInOut' }}
                            style={{ overflow: 'hidden' }}
                          >
                            <div className="pt-3">
                              <ol className="flex flex-col gap-2.5 m-0 p-0" style={{ listStyle: 'none' }}>
                                {[
                                  <>Abra o <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer" className="text-accent inline-flex items-center gap-0.5">console.cloud.google.com<ExternalLink size={10} /></a> e crie (ou selecione) um projeto.</>,
                                  <>Em <b className="text-white">APIs e Serviços → Biblioteca</b>, ative a Gmail API, a Google Calendar API e a Google Drive API.</>,
                                  <>Em <b className="text-white">Tela de consentimento OAuth</b>, tipo Externo, adicione os escopos do Gmail, Calendar e Drive, e coloque sua própria conta Google como <b className="text-white">Test user</b>.</>,
                                  <>Em <b className="text-white">Credenciais → Criar credenciais → ID do cliente OAuth</b>, tipo <b className="text-white">Aplicativo da Web</b>, cole o Redirect URI abaixo exatamente como está.</>,
                                  <>Copie o Client ID e o Client Secret gerados e cole nos campos abaixo.</>,
                                ].map((text, i) => (
                                  <li key={i} className="flex items-start gap-2.5">
                                    <span
                                      className="flex-shrink-0 flex items-center justify-center rounded-full bg-accent/[0.15] text-accent text-[11px] font-bold"
                                      style={{ width: 18, height: 18, marginTop: 1 }}
                                    >
                                      {i + 1}
                                    </span>
                                    <span className="text-gray-300 text-[12.5px] leading-5">{text}</span>
                                  </li>
                                ))}
                              </ol>

                              <p className="text-gray-400 text-[10px] font-bold tracking-widest mt-4 mb-1.5 m-0">REDIRECT URI</p>
                              <div className="flex items-center gap-2 bg-background rounded-xl px-3 py-2.5">
                                <span className="text-gray-300 text-[12px] font-mono flex-1 truncate">{googleRedirectUri || '—'}</span>
                                <button
                                  onClick={copyRedirectUri}
                                  className="flex-shrink-0 bg-transparent border-none cursor-pointer text-gray-300 hover:text-white transition-colors"
                                >
                                  {copiedRedirectUri ? <Check size={13} color="#3ddc97" /> : <Copy size={13} />}
                                </button>
                              </div>

                              <div className="flex gap-3 mt-3">
                                <div className="flex-1">
                                  <p className="text-gray-400 text-[10px] font-bold tracking-widest mb-1.5 m-0">CLIENT ID</p>
                                  <input
                                    type="text"
                                    value={googleClientId}
                                    onChange={(e) => setGoogleClientId(e.target.value)}
                                    placeholder="xxxx.apps.googleusercontent.com"
                                    spellCheck={false}
                                    autoComplete="off"
                                    className="text-white text-[13px] bg-background border border-foreground rounded-xl px-3.5 py-2.5 outline-none w-full placeholder:text-gray-400"
                                  />
                                </div>
                                <div className="flex-1">
                                  <p className="text-gray-400 text-[10px] font-bold tracking-widest mb-1.5 m-0">CLIENT SECRET</p>
                                  <input
                                    type="password"
                                    value={googleClientSecret}
                                    onChange={(e) => setGoogleClientSecret(e.target.value)}
                                    placeholder="GOCSPX-..."
                                    autoComplete="off"
                                    className="text-white text-[13px] bg-background border border-foreground rounded-xl px-3.5 py-2.5 outline-none w-full placeholder:text-gray-400"
                                  />
                                </div>
                              </div>

                              <div className="flex justify-end mt-3">
                                <motion.button
                                  onClick={saveGoogleCredentials}
                                  disabled={savingGoogle}
                                  whileHover={{ scale: 1.04 }}
                                  whileTap={{ scale: 0.95 }}
                                  className="h-8 px-5 rounded-full bg-accent border-none cursor-pointer flex items-center justify-center min-w-[76px] disabled:opacity-50 transition-opacity"
                                >
                                  {savingGoogle ? <Spinner /> : <span className="text-white font-bold text-[12px]">Salvar</span>}
                                </motion.button>
                              </div>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>

                    <div className="grid grid-cols-3 gap-3">
                      {(
                        [
                          { service: 'gmail', label: 'Gmail', Icon: GmailIcon, actions: [Eye, Send, Trash2] },
                          { service: 'calendar', label: 'Calendar', Icon: GoogleCalendarIcon, actions: [Eye, Pencil, Trash2] },
                          { service: 'drive', label: 'Drive', Icon: GoogleDriveIcon, actions: [Eye, Pencil] },
                          { service: 'playconsole', label: 'Play Console', Icon: GooglePlayIcon, actions: [Eye, Pencil] },
                        ] as { service: IntegrationService; label: string; Icon: typeof GmailIcon; actions: typeof Eye[] }[]
                      ).map(({ service, label, Icon, actions }) => {
                        const integration: Integration | undefined = integrations.find((i) => i.service === service);
                        const connected = integration?.connected ?? false;
                        return (
                          <div
                            key={service}
                            className="relative flex flex-col items-center gap-2 px-3 py-4 rounded-2xl bg-foreground"
                          >
                            {connected && (
                              <div className="absolute top-2.5 right-2.5" title={integration?.googleEmail ?? 'Conectado'}>
                                <CheckCircle2 size={14} className="text-green-300" />
                              </div>
                            )}
                            <Icon size={30} />
                            <span className="text-white text-[12px] font-medium">{label}</span>
                            <div className="flex items-center gap-1.5 text-gray-500">
                              {actions.map((ActionIcon, i) => (
                                <ActionIcon key={i} size={11} />
                              ))}
                            </div>
                            {connected ? (
                              <motion.button
                                onClick={() => disconnectIntegration(service)}
                                title="Desconectar"
                                whileHover={{ scale: 1.08 }}
                                whileTap={{ scale: 0.92 }}
                                className="mt-1 w-7 h-7 flex items-center justify-center rounded-full border-none cursor-pointer bg-destructive/[0.12] hover:bg-destructive/20 text-destructive transition-colors"
                              >
                                <Unlink size={13} />
                              </motion.button>
                            ) : (
                              <motion.button
                                onClick={() => connectGoogleService(service)}
                                disabled={!googleConfigured}
                                title={googleConfigured ? 'Conectar' : 'Preencha o Client ID e Client Secret acima primeiro'}
                                whileHover={googleConfigured ? { scale: 1.08 } : undefined}
                                whileTap={googleConfigured ? { scale: 0.92 } : undefined}
                                className="mt-1 w-7 h-7 flex items-center justify-center rounded-full border-none cursor-pointer bg-accent/[0.12] hover:bg-accent/20 text-accent disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                              >
                                <Plug size={13} />
                              </motion.button>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    <p className="text-gray-400 text-[10px] mt-3 m-0">
                      Conectar só funciona no navegador da máquina onde a API roda.
                    </p>

                    <div className="rounded-2xl bg-foreground p-4 mt-4">
                      <div className="flex items-center gap-2.5 mb-3">
                        <TelegramIcon size={22} />
                        <span className="text-white text-[13px] font-semibold flex-1">Telegram</span>
                        {telegramOwnerId && (
                          <span className="flex items-center gap-1 text-[10px] font-bold text-green-300">
                            <CheckCircle2 size={12} /> vinculado
                          </span>
                        )}
                      </div>
                      <p className="text-gray-300 text-[11px] leading-4 mt-0 mb-3">
                        Canal completo de conversa com a Elfie pelo Telegram — texto, imagens, tudo que o chat faz.
                        Crie um bot com o{' '}
                        <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="text-accent inline-flex items-center gap-0.5">
                          @BotFather<ExternalLink size={10} />
                        </a>{' '}
                        e cole o token abaixo. A primeira pessoa a mandar mensagem pro bot vira a dona da conversa —
                        mantenha o token e o nome de usuário do bot em segredo.
                      </p>
                      <div className="flex gap-2">
                        <input
                          type="password"
                          value={telegramBotToken}
                          onChange={(e) => setTelegramBotToken(e.target.value)}
                          placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
                          autoComplete="off"
                          spellCheck={false}
                          className="text-white text-[13px] bg-background border border-foreground rounded-xl px-3.5 py-2.5 outline-none flex-1 placeholder:text-gray-400"
                        />
                        <motion.button
                          onClick={saveTelegramToken}
                          disabled={savingTelegram}
                          whileHover={{ scale: 1.04 }}
                          whileTap={{ scale: 0.95 }}
                          className="h-[42px] px-5 rounded-xl bg-accent border-none cursor-pointer flex items-center justify-center min-w-[76px] disabled:opacity-50 transition-opacity flex-shrink-0"
                        >
                          {savingTelegram ? <Spinner /> : <span className="text-white font-bold text-[12px]">Salvar</span>}
                        </motion.button>
                      </div>
                      {telegramOwnerId && (
                        <div className="flex items-center justify-between mt-3">
                          <span className="text-gray-400 text-[11px]">
                            Vinculado ao usuário Telegram <span className="font-mono text-gray-300">{telegramOwnerId}</span>
                          </span>
                          <motion.button
                            onClick={unlinkTelegram}
                            disabled={unlinkingTelegram}
                            whileHover={{ scale: 1.03 }}
                            whileTap={{ scale: 0.96 }}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border-none cursor-pointer bg-destructive/[0.12] hover:bg-destructive/20 disabled:opacity-50 transition-colors flex-shrink-0"
                          >
                            {unlinkingTelegram ? <Spinner /> : <Unlink size={11} color="#ff382b" />}
                            <span className="text-destructive font-semibold text-[11px]">Desvincular</span>
                          </motion.button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {tab === 'debug' && (
                <div className="flex flex-col h-full overflow-hidden">
                  <div className="px-6 py-4 border-b border-foreground flex-shrink-0 pr-12">
                    <span className="text-white font-semibold text-[14px]">Debug</span>
                  </div>
                  <div className="flex-1 flex items-center justify-center">
                    <button
                      onClick={() => setShowDebug(true)}
                      className="flex items-center gap-3 px-5 py-3 rounded-full border border-foreground bg-transparent cursor-pointer transition-colors hover:bg-foreground"
                    >
                      <Bug size={16} color="#555" />
                      <span className="text-gray-300 text-[13px]">Abrir painel de debug</span>
                      {errorCount > 0 && (
                        <span
                          className="rounded-full px-2 text-white text-[10px] font-bold bg-destructive"
                          style={{ paddingTop: 2, paddingBottom: 2 }}
                        >
                          {errorCount}
                        </span>
                      )}
                    </button>
                  </div>
                </div>
              )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>

          <DebugPanel visible={showDebug} onClose={() => setShowDebug(false)} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
