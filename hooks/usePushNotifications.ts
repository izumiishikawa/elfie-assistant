import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { useEffect } from "react";
import { Platform } from "react-native";
import { API_BASE } from "../constants";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

async function registerForPushNotifications(): Promise<string | null> {
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "default",
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
    });
  }

  const { status: existing } = await Notifications.getPermissionsAsync();
  const { status } =
    existing !== "granted"
      ? await Notifications.requestPermissionsAsync()
      : { status: existing };

  if (status !== "granted") return null;

  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ??
    (Constants as any).easConfig?.projectId;

  if (!projectId) {
    console.warn("[push] projectId not found — skipping token registration");
    return null;
  }

  const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
  return token;
}

async function saveTokenToBackend(token: string) {
  await fetch(`${API_BASE}/api/settings/push-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

export function usePushNotifications(ready: boolean) {
  useEffect(() => {
    if (!ready) return;

    registerForPushNotifications()
      .then((token) => {
        if (token) {
          console.log("[push] token:", token);
          saveTokenToBackend(token).catch((err) =>
            console.error("[push] failed to save token:", err),
          );
        }
      })
      .catch((err) => console.error("[push] registration error:", err));

    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data;
      console.log("[push] notification tapped:", data);
      // App is single-screen — just opening it is enough
    });

    return () => sub.remove();
  }, [ready]);
}
