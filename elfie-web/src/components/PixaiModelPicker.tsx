import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, Check, Heart, Image as ImageIcon, Loader2, Search, Sliders, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE } from '../constants';

export type PixaiModel = {
  modelId: string;
  versionId: string;
  versionName: string;
  title: string;
  type: string;
  baseModelType: string;
  isNsfw: boolean;
  likes: number;
  triggerWords: string;
  thumbnail: string;
};

export type PixaiLora = {
  versionId: string;
  title: string;
  thumbnail?: string;
  baseModelType?: string;
  triggerWords?: string;
  weight: number;
};

export type PixaiSelection = {
  versionId: string;
  title: string;
  baseModelType: string;
  thumbnail?: string;
};

const MAX_LORAS = 5;

const fmtLikes = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

// "SD_V1_MODEL" -> "SD v1"
const prettyBase = (t: string) =>
  t.replace(/_MODEL$/, '').replace(/_/g, ' ').replace('SD V1', 'SD v1').toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());


const ModelCard = ({ item, selected, weightBadge, incompatible, onClick }: {
  item: PixaiModel;
  selected: boolean;
  weightBadge?: number;
  incompatible?: boolean;
  onClick: () => void;
}) => (
  <motion.button
    onClick={onClick}
    whileHover={{ scale: 1.03 }}
    whileTap={{ scale: 0.97 }}
    className={`relative flex flex-col text-left rounded-2xl overflow-hidden border-2 cursor-pointer p-0 transition-colors ${
      selected ? 'border-accent bg-accent/[0.08]' : 'border-transparent bg-foreground hover:bg-foreground/70'
    }`}
  >
    <div className="relative w-full bg-background" style={{ aspectRatio: '1 / 1' }}>
      {item.thumbnail ? (
        <img
          src={item.thumbnail}
          alt=""
          loading="lazy"
          className="w-full h-full object-cover"
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center">
          <ImageIcon size={20} color="#555" />
        </div>
      )}

      {item.isNsfw && (
        <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded-md bg-black/70 text-gray-300 text-[9px] font-bold tracking-wide">
          NSFW
        </span>
      )}

      {incompatible && (
        <span className="absolute bottom-1.5 left-1.5 flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-destructive/90">
          <AlertTriangle size={8} color="#fff" />
          <span className="text-white text-[9px] font-bold">WON'T APPLY</span>
        </span>
      )}

      {selected && (
        <div className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-accent flex items-center justify-center">
          <Check size={11} color="#fff" strokeWidth={3} />
        </div>
      )}

      {weightBadge !== undefined && (
        <span className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded-md bg-accent text-white text-[10px] font-bold">
          {weightBadge.toFixed(2)}
        </span>
      )}
    </div>

    <div className="px-2.5 py-2 w-full min-w-0">
      <p className="text-white text-[12px] font-semibold m-0 truncate">{item.title}</p>
      <div className="flex items-center gap-2 mt-1">
        <span className={`text-[10px] ${incompatible ? 'text-destructive font-semibold' : 'text-gray-400'}`}>
          {prettyBase(item.baseModelType || item.type)}
        </span>
        <span className="flex items-center gap-0.5 text-gray-400 text-[10px]">
          <Heart size={8} /> {fmtLikes(item.likes)}
        </span>
      </div>
    </div>
  </motion.button>
);


export default function PixaiModelPicker({ open, onClose, model, loras, onChange }: {
  open: boolean;
  onClose: () => void;
  model: PixaiSelection | null;
  loras: PixaiLora[];
  onChange: (next: { model: PixaiSelection | null; loras: PixaiLora[] }) => void;
}) {
  const [tab, setTab] = useState<'model' | 'lora'>('model');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [items, setItems] = useState<PixaiModel[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [onlyCompatible, setOnlyCompatible] = useState(true);
  const reqId = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 350);
    return () => clearTimeout(t);
  }, [query]);

  const baseFilter = tab === 'lora' && onlyCompatible ? (model?.baseModelType ?? '') : '';

  // Base diferente = a pixai aceita a LoRA e simplesmente não aplica ela.
  const isIncompatible = (base?: string) =>
    !!model?.baseModelType && !!base && base !== model.baseModelType;
  const badLoras = loras.filter((l) => isIncompatible(l.baseModelType));

  const fetchPage = useCallback(async (after: string | null) => {
    const mine = ++reqId.current;
    after ? setLoadingMore(true) : setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ kind: tab, limit: '24' });
      if (debounced) params.set('q', debounced);
      if (after) params.set('cursor', after);
      if (baseFilter) params.set('baseModel', baseFilter);

      const r = await fetch(`${API_BASE}/api/pixai/search?${params}`);
      const data = await r.json();
      if (reqId.current !== mine) return;
      if (!r.ok) { setError(data?.error ?? 'Search failed.'); return; }

      setItems((prev) => (after ? [...prev, ...data.items] : data.items));
      setCursor(data.nextCursor ?? null);
      setTotal(data.totalCount ?? 0);
    } catch {
      if (reqId.current === mine) setError('Could not reach PixAI.');
    } finally {
      if (reqId.current === mine) { setLoading(false); setLoadingMore(false); }
    }
  }, [tab, debounced, baseFilter]);

  useEffect(() => {
    if (!open) return;
    setItems([]);
    setCursor(null);
    fetchPage(null);
  }, [open, fetchPage]);

  const selectModel = (item: PixaiModel) => {
    onChange({
      model: {
        versionId: item.versionId,
        title: item.title,
        baseModelType: item.baseModelType || item.type,
        thumbnail: item.thumbnail,
      },
      // LoRAs de outra base não valem mais nada com o checkpoint novo
      loras: [],
    });
  };

  const toggleLora = (item: PixaiModel) => {
    const existing = loras.find((l) => l.versionId === item.versionId);
    if (existing) {
      onChange({ model, loras: loras.filter((l) => l.versionId !== item.versionId) });
      return;
    }
    if (loras.length >= MAX_LORAS) {
      window.alert(`You can stack at most ${MAX_LORAS} LoRAs.`);
      return;
    }
    onChange({
      model,
      loras: [...loras, {
        versionId: item.versionId, title: item.title, thumbnail: item.thumbnail,
        baseModelType: item.baseModelType, triggerWords: item.triggerWords, weight: 0.8,
      }],
    });
  };

  const setWeight = (versionId: string, weight: number) => {
    onChange({ model, loras: loras.map((l) => (l.versionId === versionId ? { ...l, weight } : l)) });
  };

  const setTriggerWords = (versionId: string, triggerWords: string) => {
    onChange({ model, loras: loras.map((l) => (l.versionId === versionId ? { ...l, triggerWords } : l)) });
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[60] flex items-center justify-center p-6"
          style={{ backgroundColor: 'rgba(0,0,0,0.65)' }}
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.96, y: 12 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.96, y: 12 }}
            transition={{ type: 'spring', stiffness: 380, damping: 32 }}
            onClick={(e) => e.stopPropagation()}
            className="flex flex-col w-full max-w-[900px] rounded-3xl bg-background overflow-hidden"
            style={{ height: 'min(760px, 88vh)', boxShadow: '0 24px 60px rgba(0,0,0,0.55)' }}
          >
            {/* header */}
            <div className="flex items-center gap-3 px-5 py-4 border-b border-foreground flex-shrink-0">
              <span className="text-white font-semibold text-[14px] flex-1">Models &amp; LoRAs</span>
              <motion.button
                onClick={onClose}
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.9 }}
                className="w-8 h-8 rounded-full flex items-center justify-center bg-foreground border-none cursor-pointer"
              >
                <X size={14} color="#888" />
              </motion.button>
            </div>

            {/* tabs + busca */}
            <div className="px-5 py-3 border-b border-foreground flex-shrink-0 flex flex-col gap-3">
              <div className="flex gap-2">
                {(['model', 'lora'] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => { setTab(t); setQuery(''); }}
                    className={`px-4 py-1.5 rounded-full text-[12px] font-semibold border cursor-pointer transition-colors ${
                      tab === t
                        ? 'bg-accent text-white border-accent'
                        : 'bg-foreground text-gray-400 border-foreground hover:text-gray-200'
                    }`}
                  >
                    {t === 'model' ? 'Checkpoint' : `LoRAs${loras.length ? ` (${loras.length})` : ''}`}
                  </button>
                ))}

                <div className="flex-1" />

                {tab === 'lora' && model?.baseModelType && (
                  <label className="flex items-center gap-1.5 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={onlyCompatible}
                      onChange={(e) => setOnlyCompatible(e.target.checked)}
                      className="accent-[var(--accent)] cursor-pointer"
                    />
                    <span className="text-gray-300 text-[11px]">
                      Only {prettyBase(model.baseModelType)}
                    </span>
                  </label>
                )}
              </div>

              <div className="relative">
                <Search size={13} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={tab === 'model' ? 'Search checkpoints…' : 'Search LoRAs…'}
                  className="w-full text-white text-[13px] bg-foreground border border-foreground rounded-full pl-9 pr-4 py-2.5 outline-none placeholder:text-gray-400"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>

              {tab === 'lora' && !model && (
                <p className="text-gray-300 text-[11px] m-0">
                  Pick a checkpoint first — LoRAs only work on the base model they were trained for.
                </p>
              )}

              {badLoras.length > 0 && (
                <div className="flex items-start gap-2 rounded-xl bg-destructive/[0.12] px-3 py-2">
                  <AlertTriangle size={12} className="text-destructive flex-shrink-0 mt-0.5" />
                  <p className="text-gray-300 text-[11px] leading-[1.5] m-0">
                    <span className="text-destructive font-semibold">
                      {badLoras.length} LoRA{badLoras.length > 1 ? 's' : ''} won't do anything:
                    </span>{' '}
                    {badLoras.map((l) => `${l.title} (${prettyBase(l.baseModelType!)})`).join(', ')} —
                    trained for a different base than {prettyBase(model!.baseModelType)}. PixAI accepts them
                    and silently ignores them, so the image comes out as if no LoRA was set.
                  </p>
                </div>
              )}
            </div>

            {/* resultados */}
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {loading ? (
                <div className="flex items-center justify-center h-full gap-2">
                  <Loader2 size={16} className="text-gray-400 spin" />
                  <span className="text-gray-300 text-[13px]">Searching PixAI…</span>
                </div>
              ) : error ? (
                <div className="flex flex-col items-center justify-center h-full gap-2">
                  <p className="text-destructive text-[13px] m-0">{error}</p>
                  <button
                    onClick={() => fetchPage(null)}
                    className="text-gray-300 text-[12px] underline bg-transparent border-none cursor-pointer"
                  >
                    Try again
                  </button>
                </div>
              ) : items.length === 0 ? (
                <p className="text-gray-300 text-[13px] text-center mt-10">
                  Nothing found.
                </p>
              ) : (
                <>
                  <p className="text-gray-400 text-[10px] font-bold tracking-widest mb-3 m-0">
                    {total >= 10000 ? '10000+' : total} RESULTS
                  </p>
                  <div
                    className="grid gap-3"
                    style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(148px, 1fr))' }}
                  >
                    {items.map((item) => {
                      const lora = loras.find((l) => l.versionId === item.versionId);
                      return (
                        <ModelCard
                          key={item.versionId}
                          item={item}
                          selected={tab === 'model'
                            ? model?.versionId === item.versionId
                            : !!lora}
                          weightBadge={tab === 'lora' ? lora?.weight : undefined}
                          incompatible={tab === 'lora' && isIncompatible(item.baseModelType)}
                          onClick={() => (tab === 'model' ? selectModel(item) : toggleLora(item))}
                        />
                      );
                    })}
                  </div>

                  {cursor && (
                    <div className="flex justify-center mt-4">
                      <motion.button
                        onClick={() => fetchPage(cursor)}
                        disabled={loadingMore}
                        whileHover={{ scale: 1.03 }}
                        whileTap={{ scale: 0.97 }}
                        className="px-5 py-2 rounded-full bg-foreground border-none cursor-pointer hover:bg-foreground/70 disabled:opacity-50 min-w-[120px]"
                      >
                        {loadingMore
                          ? <Loader2 size={13} className="text-gray-300 spin mx-auto" />
                          : <span className="text-gray-300 text-[12px] font-semibold">Load more</span>}
                      </motion.button>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* pesos das loras escolhidas */}
            {tab === 'lora' && loras.length > 0 && (
              <div className="border-t border-foreground px-5 py-3 flex-shrink-0 max-h-[210px] overflow-y-auto">
                <div className="flex items-center gap-1.5 mb-2">
                  <Sliders size={11} className="text-gray-400" />
                  <p className="text-gray-400 text-[10px] font-bold tracking-widest m-0">
                    WEIGHTS &amp; TRIGGER WORDS ({loras.length}/{MAX_LORAS})
                  </p>
                </div>
                <p className="text-gray-300 text-[11px] leading-[1.5] mt-0 mb-2">
                  Trigger words are appended to every prompt automatically — a LoRA barely does anything
                  without them. Edit them here to drop the parts you don't want.
                </p>
                {loras.map((l) => (
                  <div key={l.versionId} className="py-1.5">
                  <div className="flex items-center gap-3">
                    <span className="flex items-center gap-1.5 flex-1 min-w-0">
                      {isIncompatible(l.baseModelType) && (
                        <AlertTriangle size={10} className="text-destructive flex-shrink-0" />
                      )}
                      <span className={`text-[12px] truncate ${isIncompatible(l.baseModelType) ? 'text-gray-400 line-through' : 'text-white'}`}>
                        {l.title || l.versionId}
                      </span>
                    </span>
                    <input
                      type="range"
                      min={-1}
                      max={2}
                      step={0.05}
                      value={l.weight}
                      onChange={(e) => setWeight(l.versionId, Number(e.target.value))}
                      className="w-[180px] accent-[var(--accent)] cursor-pointer flex-shrink-0"
                    />
                    <span className="text-gray-300 text-[11px] font-mono w-10 text-right flex-shrink-0">
                      {l.weight.toFixed(2)}
                    </span>
                    <button
                      onClick={() => toggleLora({ versionId: l.versionId } as PixaiModel)}
                      className="p-1 rounded-full bg-transparent border-none cursor-pointer hover:bg-foreground flex-shrink-0"
                    >
                      <X size={11} color="#888" />
                    </button>
                  </div>

                  <div className="flex items-center gap-2 mt-1 pl-0.5">
                    <span className="text-gray-400 text-[9px] font-bold tracking-widest flex-shrink-0">TRIGGER</span>
                    <input
                      type="text"
                      value={l.triggerWords ?? ''}
                      onChange={(e) => setTriggerWords(l.versionId, e.target.value)}
                      placeholder="no trigger words for this LoRA"
                      className="flex-1 min-w-0 text-gray-300 text-[11px] font-mono bg-background border border-background rounded-lg px-2.5 py-1.5 outline-none placeholder:text-gray-400"
                      spellCheck={false}
                    />
                  </div>
                  </div>
                ))}
              </div>
            )}

            {/* rodapé */}
            <div className="flex items-center gap-3 px-5 py-3.5 border-t border-foreground flex-shrink-0">
              <p className="text-gray-300 text-[11px] m-0 flex-1 truncate">
                {model ? `Checkpoint: ${model.title}` : 'No checkpoint selected — the server default is used.'}
                {loras.length > 0 && ` · ${loras.length} LoRA${loras.length > 1 ? 's' : ''}`}
              </p>
              <motion.button
                onClick={onClose}
                whileHover={{ scale: 1.04 }}
                whileTap={{ scale: 0.95 }}
                className="h-8 px-6 rounded-full bg-accent border-none cursor-pointer flex items-center justify-center"
              >
                <span className="text-white font-bold text-[12px]">Done</span>
              </motion.button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
