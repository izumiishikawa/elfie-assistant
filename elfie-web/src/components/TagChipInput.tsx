import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useMemo, useState } from 'react';
import { X } from 'lucide-react';

interface TagChipInputProps {
  tags: string[];
  onChange: (tags: string[]) => void;
  suggestions?: string[];
  placeholder?: string;
}

export default function TagChipInput({ tags, onChange, suggestions = [], placeholder }: TagChipInputProps) {
  const [draft, setDraft] = useState('');
  const [focused, setFocused] = useState(false);

  const addTag = useCallback((raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const lower = trimmed.toLowerCase();
    if (tags.some((t) => t.toLowerCase() === lower)) { setDraft(''); return; }
    onChange([...tags, trimmed]);
    setDraft('');
  }, [tags, onChange]);

  const removeTag = useCallback((tag: string) => {
    onChange(tags.filter((t) => t !== tag));
  }, [tags, onChange]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag(draft);
    } else if (e.key === 'Backspace' && !draft && tags.length > 0) {
      removeTag(tags[tags.length - 1]);
    }
  }, [draft, addTag, removeTag, tags]);

  const matchingSuggestions = useMemo(() => {
    if (!focused || !draft.trim()) return [];
    const lower = draft.toLowerCase();
    return suggestions
      .filter((s) => s.toLowerCase().includes(lower) && !tags.some((t) => t.toLowerCase() === s.toLowerCase()))
      .slice(0, 6);
  }, [focused, draft, suggestions, tags]);

  return (
    <div className="relative">
      <div className="flex flex-wrap items-center gap-1.5 text-white text-[13px] bg-foreground border border-foreground rounded-xl px-3 py-2 min-h-[42px]">
        <AnimatePresence initial={false}>
          {tags.map((tag) => (
            <motion.span
              key={tag}
              layout
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              transition={{ type: 'spring', stiffness: 460, damping: 38 }}
              className="flex items-center gap-1 pl-2.5 pr-1.5 py-1 rounded-full bg-accent/[0.15] text-accent text-[11px] font-semibold"
            >
              {tag}
              <button
                type="button"
                onClick={() => removeTag(tag)}
                className="flex items-center justify-center bg-transparent border-none cursor-pointer p-0.5 opacity-70 hover:opacity-100"
              >
                <X size={10} color="var(--accent)" />
              </button>
            </motion.span>
          ))}
        </AnimatePresence>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => { addTag(draft); setFocused(false); }}
          placeholder={tags.length === 0 ? placeholder ?? 'Adicionar tag...' : ''}
          className="flex-1 min-w-[100px] bg-transparent border-none outline-none text-white placeholder:text-gray-400"
        />
      </div>
      {matchingSuggestions.length > 0 && (
        <div className="absolute left-0 right-0 top-full mt-1 z-10 rounded-xl border border-foreground bg-background overflow-hidden shadow-lg">
          {matchingSuggestions.map((s) => (
            <button
              key={s}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); addTag(s); }}
              className="w-full text-left px-3 py-2 bg-transparent border-none cursor-pointer text-gray-300 text-[12px] hover:bg-foreground"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
