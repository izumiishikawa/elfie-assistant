import Constants from "expo-constants";
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

export const isEmulator = !Constants.isDevice;

const API_BASE_OVERRIDE_KEY = "elfie_api_base_override";

// EXPO_PUBLIC_API_URL is injected at build time via eas.json env
// Falls back to emulator address or LAN IP for local dev
const envUrl = process.env.EXPO_PUBLIC_API_URL;

const DEFAULT_API_BASE: string =
  envUrl ??
  (isEmulator && Platform.OS === "android"
    ? "http://10.0.2.2:3000"
    : "http://localhost:3000");

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function computeWsBase(apiBase: string): string {
  return apiBase.replace(/^http(s?)/, "ws$1").replace(/:\d+$/, ":41906");
}

// Mutable — SettingsScreen can override this at runtime via setApiBase().
// Consumers import { API_BASE } and read it at call time, so this stays
// in sync everywhere without needing a store or context.
export let API_BASE: string = DEFAULT_API_BASE;
export let WS_BASE: string = computeWsBase(API_BASE);

export function getDefaultApiBase(): string {
  return DEFAULT_API_BASE;
}

// Must be awaited before any network call is made (see App.tsx), so the
// persisted override is applied before anything reads API_BASE/WS_BASE.
export async function loadApiBaseOverride(): Promise<void> {
  try {
    const saved = await SecureStore.getItemAsync(API_BASE_OVERRIDE_KEY);
    if (saved) {
      API_BASE = stripTrailingSlash(saved);
      WS_BASE = computeWsBase(API_BASE);
    }
  } catch (err) {
    console.error("[constants] loadApiBaseOverride", err);
  }
  console.log("[constants] API_BASE =", API_BASE);
}

// Pass null to clear the override and go back to the default.
export async function setApiBase(url: string | null): Promise<void> {
  if (url) {
    const trimmed = stripTrailingSlash(url.trim());
    API_BASE = trimmed;
    WS_BASE = computeWsBase(trimmed);
    await SecureStore.setItemAsync(API_BASE_OVERRIDE_KEY, trimmed);
  } else {
    API_BASE = DEFAULT_API_BASE;
    WS_BASE = computeWsBase(DEFAULT_API_BASE);
    await SecureStore.deleteItemAsync(API_BASE_OVERRIDE_KEY);
  }
}
