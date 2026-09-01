import { X } from 'lucide-react';
import { API_BASE } from '../constants';
import { useDebugStore } from '../stores/debugStore';

export default function DebugPanel({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { logs, clear } = useDebugStore();
  const errorCount = logs.filter((l) => l.level === 'error').length;

  if (!visible) return null;

  return (
    <div className="fixed inset-0 z-[200] flex flex-col bg-[#0a0a0f]">
      <div className="flex items-center justify-between p-4 border-b border-[#1e1e2e]">
        <div className="flex items-center gap-2">
          <span className="text-white font-bold text-[15px]">Debug</span>
          {errorCount > 0 && (
            <span className="bg-[#ff382b] rounded-full px-[7px] py-[2px] text-white text-[10px] font-bold">{errorCount}</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <button onClick={clear} className="text-[#666] text-xs">limpar</button>
          <button onClick={onClose}><X size={20} color="#8e8e93" /></button>
        </div>
      </div>

      <div className="m-3 mb-0 p-3 bg-[#111118] rounded-xl border border-[#1e1e2e] flex flex-col gap-2">
        <div>
          <div className="text-[#555] text-[10px] font-bold mb-0.5">API_BASE</div>
          <div className="text-[var(--accent)] text-[13px] font-mono">{API_BASE}</div>
        </div>
        <div className="flex gap-4">
          <div>
            <div className="text-[#555] text-[10px] font-bold mb-0.5">PLATFORM</div>
            <div className="text-[#aaa] text-[12px] font-mono">web</div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 mt-3 pb-8">
        {logs.length === 0 ? (
          <p className="text-[#444] text-xs text-center mt-6">Nenhum log ainda</p>
        ) : (
          logs.map((entry) => (
            <div
              key={entry.id}
              className="mb-2 p-2.5 bg-[#111118] rounded-lg"
              style={{ borderLeft: `3px solid ${entry.level === 'error' ? '#ff382b' : 'var(--accent)'}` }}
            >
              <div className="flex justify-between mb-1">
                <span style={{ color: entry.level === 'error' ? '#ff382b' : 'var(--accent)', fontSize: 10, fontWeight: 700 }}>
                  {entry.level.toUpperCase()}
                </span>
                <span className="text-[#444] text-[10px]">{entry.time}</span>
              </div>
              <p className="text-[#ccc] text-xs leading-[18px] m-0">{entry.message}</p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
