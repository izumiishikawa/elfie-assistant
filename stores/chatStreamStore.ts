import { create } from 'zustand';
import { WS_BASE } from '../constants';

interface ChatStreamStore {
  streamingChatId: string | null;
  isAiTyping: boolean;
  currentActivity: string | null;
  locallyStreaming: boolean;
  pendingRefreshChatId: string | null;
  startStream: (chatId: string) => void;
  endStream: () => void;
  setIsAiTyping: (v: boolean) => void;
  setCurrentActivity: (v: string | null) => void;
  clearPendingRefresh: () => void;
  _wsActivity: (chatId: string, activity: string | null) => void;
  _wsDone: (chatId: string) => void;
}

export const useChatStreamStore = create<ChatStreamStore>((set) => ({
  streamingChatId: null,
  isAiTyping: false,
  currentActivity: null,
  locallyStreaming: false,
  pendingRefreshChatId: null,

  startStream: (chatId) => set({
    streamingChatId: chatId,
    isAiTyping: true,
    currentActivity: null,
    locallyStreaming: true,
    pendingRefreshChatId: null,
  }),

  endStream: () => set({
    streamingChatId: null,
    isAiTyping: false,
    currentActivity: null,
    locallyStreaming: false,
  }),

  setIsAiTyping: (v) => set({ isAiTyping: v }),
  setCurrentActivity: (v) => set({ currentActivity: v }),
  clearPendingRefresh: () => set({ pendingRefreshChatId: null }),

  _wsActivity: (chatId, activity) => set((state) => {
    if (state.locallyStreaming) {
      // SSE is authoritative — only mirror activity updates
      return { ...state, currentActivity: activity ?? state.currentActivity };
    }
    return { ...state, streamingChatId: chatId, isAiTyping: true, currentActivity: activity };
  }),

  _wsDone: (chatId) => set((state) => {
    if (state.locallyStreaming) return state;
    if (state.streamingChatId !== chatId) return state;
    return {
      ...state,
      streamingChatId: null,
      isAiTyping: false,
      currentActivity: null,
      pendingRefreshChatId: chatId,
    };
  }),
}));

// WebSocket — lives outside the store so it survives component unmounts.
// Call initChatStream() once, after the persisted API_BASE override (if any)
// has been loaded, so it connects to the right host from the start.
let _ws: WebSocket | null = null;
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function connectWS() {
  if (_ws && (_ws.readyState === WebSocket.CONNECTING || _ws.readyState === WebSocket.OPEN)) return;

  try {
    _ws = new WebSocket(WS_BASE);

    _ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        const store = useChatStreamStore.getState();
        if (msg.type === 'stream_activity') store._wsActivity(msg.chatId, msg.activity ?? null);
        else if (msg.type === 'stream_done') store._wsDone(msg.chatId);
      } catch {}
    };

    _ws.onclose = () => {
      _ws = null;
      if (_reconnectTimer) clearTimeout(_reconnectTimer);
      _reconnectTimer = setTimeout(connectWS, 3000);
    };

    _ws.onerror = () => { _ws?.close(); };
  } catch {}
}

let _started = false;
export function initChatStream() {
  if (_started) return;
  _started = true;
  connectWS();
}
