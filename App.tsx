import "./global.css";

import { useEffect, useState } from "react";
import { StatusBar } from "expo-status-bar";
import ChatScreen from "./screens/ChatScreen";
import { useAutoUpdate } from "./hooks/useAutoUpdate";
import { usePushNotifications } from "./hooks/usePushNotifications";
import { loadApiBaseOverride } from "./constants";
import { initChatStream } from "./stores/chatStreamStore";

export default function App() {
  const [ready, setReady] = useState(false);

  useAutoUpdate();
  usePushNotifications(ready);

  useEffect(() => {
    loadApiBaseOverride().finally(() => {
      initChatStream();
      setReady(true);
    });
  }, []);

  if (!ready) return null;

  return (
    <>
      <ChatScreen />
      <StatusBar style="light" />
    </>
  );
}
