import { MaterialCommunityIcons } from "@expo/vector-icons";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import * as Updates from "expo-updates";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated, {
  FadeIn,
  FadeInDown,
  FadeInUp,
  FadeOut,
  LinearTransition,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import AnimatedPressable from "../components/AnimatedPressable";
import DebugPanel from "../components/DebugPanel";
import { useKeyboardBehavior } from "../hooks/useKeyboardBehavior";
import { Character, useSettingsStore } from "../stores/mainStore";
import { API_BASE, getDefaultApiBase, setApiBase } from "../constants";
import { useDebugStore } from "../stores/debugStore";
import {
  PRESS_SCALE_SMALL,
  springIndicator,
  staggerDelay,
  timingFast,
} from "../utils/motion";

const PRESET_MODELS = [
  { label: "DeepSeek V3", value: "deepseek-chat" },
  { label: "DeepSeek R1", value: "deepseek-reasoner" },
  { label: "GPT-4o", value: "gpt-4o" },
  { label: "GPT-4o mini", value: "gpt-4o-mini" },
  { label: "Claude 3.5 Sonnet", value: "anthropic/claude-3-5-sonnet" },
  { label: "Claude 3 Haiku", value: "anthropic/claude-3-haiku" },
  { label: "Gemini 2.0 Flash", value: "google/gemini-2.0-flash-001" },
  { label: "Llama 3.1 70B", value: "meta-llama/llama-3.1-70b-instruct" },
  { label: "Cydonia 24B", value: "thedrummer/cydonia-24b-v4.1" },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SectionLabel = ({ label }: { label: string }) => (
  <Text className="text-gray-300 text-xs font-black tracking-widest px-1 mb-2 mt-1">
    {label}
  </Text>
);

const Field = memo(
  ({
    label,
    value,
    onChangeText,
    placeholder,
    multiline,
    hint,
  }: {
    label: string;
    value: string;
    onChangeText: (t: string) => void;
    placeholder?: string;
    multiline?: boolean;
    hint?: string;
  }) => (
    <View className="mb-3 bg-foreground rounded-2xl px-4 py-3 border border-border">
      <Text className="text-gray-300 text-xs font-black mb-2">{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#9ca3af"
        className="text-white text-[14px]"
        multiline={multiline}
        style={
          multiline ? { minHeight: 72, textAlignVertical: "top" } : undefined
        }
      />
      {hint && <Text className="text-gray-300 text-[10px] mt-1.5">{hint}</Text>}
    </View>
  ),
);

const ModelPicker = memo(
  ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <View className="mb-3 bg-foreground rounded-2xl px-4 py-3 border border-border">
      <Text className="text-gray-400 text-[10px] font-bold mb-2">
        MODELO DE IA
      </Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder="Padrão do servidor"
        placeholderTextColor="#9ca3af"
        className="text-white text-[13px] mb-3"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <View className="flex-row flex-wrap gap-1.5">
        {PRESET_MODELS.map((m, idx) => (
          <AnimatedPressable
            key={m.value}
            entering={FadeIn.delay(staggerDelay(idx, 20)).duration(180)}
            onPress={() => onChange(m.value)}
            scaleTo={PRESS_SCALE_SMALL}
            style={{
              paddingHorizontal: 12,
              paddingVertical: 4,
              borderRadius: 20,
              backgroundColor: value === m.value ? "#996dff" : "#17171c",
            }}
          >
            <Text
              style={{
                fontSize: 11,
                fontWeight: "700",
                color: value === m.value ? "#fff" : "#d1d5db",
              }}
            >
              {m.label}
            </Text>
          </AnimatedPressable>
        ))}
      </View>
    </View>
  ),
);

// ─── Provider toggle (pill deslizante, no espírito do indicador com layoutId do elfie-web) ──

const ProviderToggle = memo(
  ({
    value,
    onChange,
  }: {
    value: "openrouter" | "deepseek";
    onChange: (v: "openrouter" | "deepseek") => void;
  }) => {
    const [segmentWidth, setSegmentWidth] = useState(0);
    const pillX = useSharedValue(0);

    useEffect(() => {
      if (!segmentWidth) return;
      pillX.value = withSpring(
        value === "openrouter" ? 0 : segmentWidth + 8,
        springIndicator,
      );
    }, [value, segmentWidth]);

    const pillStyle = useAnimatedStyle(() => ({
      transform: [{ translateX: pillX.value }],
    }));

    return (
      <View
        className="flex-row gap-2 mb-3"
        style={{ position: "relative" }}
        onLayout={(e) => setSegmentWidth((e.nativeEvent.layout.width - 8) / 2)}
      >
        {segmentWidth > 0 && (
          <Animated.View
            pointerEvents="none"
            style={[
              {
                position: "absolute",
                top: 0,
                bottom: 0,
                left: 0,
                width: segmentWidth,
                borderRadius: 12,
                backgroundColor: "#996dff",
              },
              pillStyle,
            ]}
          />
        )}
        {(["openrouter", "deepseek"] as const).map((p) => (
          <AnimatedPressable
            key={p}
            onPress={() => onChange(p)}
            style={{
              flex: 1,
              paddingVertical: 8,
              borderRadius: 12,
              alignItems: "center",
              borderWidth: 1,
              borderColor: value === p ? "transparent" : "#2a2a35",
            }}
          >
            <Text
              style={{
                fontSize: 13,
                fontWeight: "700",
                color: value === p ? "#fff" : "#d1d5db",
              }}
            >
              {p === "openrouter" ? "OpenRouter" : "DeepSeek"}
            </Text>
          </AnimatedPressable>
        ))}
      </View>
    );
  },
);

// ─── Character Editor Modal ───────────────────────────────────────────────────

const CharacterEditor = memo(
  ({
    character,
    onClose,
    onSaved,
  }: {
    character: Partial<Character> | null; // null = new
    onClose: () => void;
    onSaved: () => void;
  }) => {
    const keyboardBehavior = useKeyboardBehavior();
    const [name, setName] = useState(character?.name ?? "");
    const [personality, setPersonality] = useState(
      character?.personality ?? "",
    );
    const [model, setModel] = useState(character?.model ?? "");
    const [localPhoto, setLocalPhoto] = useState<{
      uri: string;
      base64: string;
    } | null>(null);
    const [saving, setSaving] = useState(false);

    const photoUri =
      localPhoto?.uri ??
      (character?.photo ? `${API_BASE}/files/${character.photo}` : null);

    const pickPhoto = useCallback(async () => {
      const { status } =
        await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== "granted") return;
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.8,
        base64: true,
      });
      if (!result.canceled && result.assets[0]?.base64) {
        setLocalPhoto({
          uri: result.assets[0].uri,
          base64: result.assets[0].base64,
        });
      }
    }, []);

    const save = useCallback(async () => {
      if (!name.trim())
        return Alert.alert("Nome obrigatório", "Dê um nome ao personagem.");
      setSaving(true);
      try {
        const body: any = { name: name.trim(), personality, model };
        if (localPhoto) body.photoBase64 = localPhoto.base64;

        const isNew = !character?._id;
        const url = isNew
          ? `${API_BASE}/api/characters`
          : `${API_BASE}/api/characters/${character!._id}`;
        const res = await fetch(url, {
          method: isNew ? "POST" : "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const b = await res.text().catch(() => "");
          console.error("[saveCharacter]", res.status, b);
          throw new Error("Server error");
        }
        onSaved();
      } catch (err) {
        console.error("[saveCharacter]", err);
        Alert.alert("Erro", "Não foi possível salvar o personagem.");
      } finally {
        setSaving(false);
      }
    }, [name, personality, model, localPhoto, character]);

    const deleteCharacter = useCallback(async () => {
      if (!character?._id) return;
      Alert.alert(
        "Apagar personagem",
        `Tem certeza que quer apagar "${character.name}"?`,
        [
          { text: "Cancelar", style: "cancel" },
          {
            text: "Apagar",
            style: "destructive",
            onPress: async () => {
              try {
                await fetch(`${API_BASE}/api/characters/${character._id}`, {
                  method: "DELETE",
                });
                onSaved();
              } catch (err) {
                console.error("[deleteCharacter]", err);
                Alert.alert("Erro", "Não foi possível apagar.");
              }
            },
          },
        ],
      );
    }, [character]);

    return (
      <Modal
        visible
        animationType="slide"
        statusBarTranslucent
        onRequestClose={onClose}
      >
        <SafeAreaView className="flex-1 bg-background">
          <View className="flex-row items-center justify-between px-4 py-3 border-b border-border">
            <AnimatedPressable onPress={onClose} className="p-1">
              <MaterialCommunityIcons
                name="arrow-left"
                size={22}
                color="#8e8e93"
              />
            </AnimatedPressable>
            <Text className="text-white font-bold text-[16px]">
              {character?._id ? "Editar personagem" : "Novo personagem"}
            </Text>
            <AnimatedPressable
              onPress={save}
              disabled={saving}
              className="px-8 py-2 rounded-full bg-accent"
            >
              {saving ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text className="text-white font-bold text-xs">Salvar</Text>
              )}
            </AnimatedPressable>
          </View>

          <KeyboardAvoidingView style={{ flex: 1 }} behavior={keyboardBehavior}>
            <ScrollView
              contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
              keyboardShouldPersistTaps="handled"
            >
              {/* Photo + name */}
              <Animated.View
                entering={FadeInUp.duration(260).springify().damping(18).stiffness(180)}
                className="mb-3 bg-foreground rounded-2xl px-4 py-4 border border-border flex-row items-center gap-4"
              >
                <AnimatedPressable onPress={pickPhoto} style={{ position: "relative" }}>
                  <View className="w-16 h-16 rounded-full overflow-hidden bg-accent items-center justify-center">
                    {photoUri ? (
                      <Image
                        source={{ uri: photoUri }}
                        style={{ width: 64, height: 64 }}
                        contentFit="cover"
                      />
                    ) : (
                      <MaterialCommunityIcons
                        name="account"
                        size={28}
                        color="#fff"
                      />
                    )}
                  </View>
                  <View className="absolute bottom-0 right-0 w-5 h-5 rounded-full bg-accent border-2 border-background items-center justify-center">
                    <MaterialCommunityIcons
                      name="pencil"
                      size={10}
                      color="#fff"
                    />
                  </View>
                </AnimatedPressable>
                <View className="flex-1">
                  <Text className="text-gray-400 text-[10px] font-bold mb-1.5">
                    NOME
                  </Text>
                  <TextInput
                    value={name}
                    onChangeText={setName}
                    placeholder="Nome do personagem"
                    placeholderTextColor="#9ca3af"
                    className="text-white text-[15px] font-bold"
                  />
                </View>
              </Animated.View>

              <Animated.View
                entering={FadeInUp.delay(staggerDelay(1, 40)).duration(260).springify().damping(18).stiffness(180)}
              >
                <Field
                  label="PERSONALIDADE"
                  value={personality}
                  onChangeText={setPersonality}
                  placeholder="Descreva a personalidade, tom e jeito de ser..."
                  multiline
                  hint="Se vazio, usa a personalidade padrão."
                />
              </Animated.View>

              <Animated.View
                entering={FadeInUp.delay(staggerDelay(2, 40)).duration(260).springify().damping(18).stiffness(180)}
              >
                <ModelPicker value={model} onChange={setModel} />
              </Animated.View>

              {character?._id && (
                <AnimatedPressable
                  entering={FadeIn.delay(staggerDelay(3, 40))}
                  onPress={deleteCharacter}
                  className="mt-4 flex-row items-center justify-center gap-2 py-3 rounded-2xl border border-destructive"
                >
                  <MaterialCommunityIcons
                    name="trash-can-outline"
                    size={16}
                    color="#ff382b"
                  />
                  <Text className="text-destructive font-bold text-[13px]">
                    Apagar personagem
                  </Text>
                </AnimatedPressable>
              )}
            </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>
    );
  },
);

// ─── Memory Item ──────────────────────────────────────────────────────────────

const MemoryItem = memo(
  ({
    text,
    onDelete,
    onEdit,
  }: {
    text: string;
    onDelete: () => void;
    onEdit: (t: string) => void;
  }) => {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(text);
    const confirm = useCallback(() => {
      if (draft.trim()) onEdit(draft.trim());
      setEditing(false);
    }, [draft, onEdit]);
    return (
      <Animated.View
        entering={FadeIn.duration(200)}
        exiting={FadeOut.duration(160)}
        layout={LinearTransition.springify().damping(38).stiffness(420)}
        className="flex-row items-start gap-3 py-3 px-4 border-b border-border"
      >
        <View className="w-1.5 h-1.5 rounded-full bg-accent mt-1.5 flex-shrink-0" />
        {editing ? (
          <TextInput
            value={draft}
            onChangeText={setDraft}
            onBlur={confirm}
            onSubmitEditing={confirm}
            autoFocus
            className="flex-1 text-white text-[13px]"
            style={{ textAlignVertical: "top" }}
            multiline
          />
        ) : (
          <TouchableOpacity className="flex-1" onPress={() => setEditing(true)}>
            <Text className="text-white text-[13px] leading-5">{text}</Text>
          </TouchableOpacity>
        )}
        <AnimatedPressable
          onPress={onDelete}
          scaleTo={PRESS_SCALE_SMALL}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <MaterialCommunityIcons name="close" size={16} color="#ff382b" />
        </AnimatedPressable>
      </Animated.View>
    );
  },
);

// ─── Settings Screen ──────────────────────────────────────────────────────────

export default function SettingsScreen({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const { characters, activeCharacterId, loadSettings } = useSettingsStore();
  const keyboardBehavior = useKeyboardBehavior();

  // Global (shared across characters)
  const [userPhoto, setUserPhoto] = useState("");
  const [localUserPhoto, setLocalUserPhoto] = useState<{
    uri: string;
    base64: string;
  } | null>(null);
  const [llmProvider, setLlmProvider] = useState<"openrouter" | "deepseek">("openrouter");
  const [deepseekApiKey, setDeepseekApiKey] = useState("");

  // Per-character
  const [userName, setUserName] = useState("");
  const [userBasicData, setUserBasicData] = useState("");
  const [longTermMemory, setLongTermMemory] = useState<string[]>([]);

  const [newMemory, setNewMemory] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editingCharacter, setEditingCharacter] = useState<
    Partial<Character> | null | undefined
  >(undefined);
  const [showDebug, setShowDebug] = useState(false);
  const [apiUrlDraft, setApiUrlDraft] = useState(API_BASE);
  const [applyingApiUrl, setApplyingApiUrl] = useState(false);
  const newMemoryRef = useRef<TextInput>(null);
  const errorCount = useDebugStore(
    (s) => s.logs.filter((l) => l.level === "error").length,
  );

  const hasNewMemory = useSharedValue(0);
  const addMemoryBtnStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      hasNewMemory.value,
      [0, 1],
      ["#2a2a35", "#996dff"],
    ),
  }));

  const loadCharacterData = useCallback(
    (chars: Character[], activeId: string | null) => {
      const active = chars.find((c) => c._id === activeId) ?? chars[0];
      if (active) {
        setUserName(active.userName || "");
        setUserBasicData(active.userBasicData || "");
        setLongTermMemory(
          Array.isArray(active.longTermMemory) ? active.longTermMemory : [],
        );
      }
    },
    [],
  );

  useEffect(() => {
    if (!visible) return;
    setApiUrlDraft(API_BASE);
    setLoading(true);
    Promise.all([
      fetch(`${API_BASE}/api/settings`).then((r) => r.json()),
      fetch(`${API_BASE}/api/characters`).then((r) => r.json()),
    ])
      .then(([settings, charsData]) => {
        setUserPhoto(settings.userPhoto ?? "");
        setLocalUserPhoto(null);
        setLlmProvider(settings.llmProvider === "deepseek" ? "deepseek" : "openrouter");
        setDeepseekApiKey(settings.deepseekApiKey ?? "");
        loadCharacterData(
          charsData.characters ?? [],
          String(charsData.activeCharacterId),
        );
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [visible, loadCharacterData]);

  const pickUserPhoto = useCallback(async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
      base64: true,
    });
    if (!result.canceled && result.assets[0]?.base64)
      setLocalUserPhoto({
        uri: result.assets[0].uri,
        base64: result.assets[0].base64,
      });
  }, []);

  const onChangeNewMemory = useCallback(
    (t: string) => {
      setNewMemory(t);
      hasNewMemory.value = withTiming(t.trim() ? 1 : 0, timingFast);
    },
    [hasNewMemory],
  );

  const addMemory = useCallback(() => {
    const text = newMemory.trim();
    if (!text) return;
    setLongTermMemory((prev) => [...prev, text]);
    setNewMemory("");
    hasNewMemory.value = withTiming(0, timingFast);
  }, [newMemory, hasNewMemory]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      // Save global settings (photo + provider)
      const globalPatch: Record<string, string> = { llmProvider, deepseekApiKey };
      if (localUserPhoto) globalPatch.userPhotoBase64 = localUserPhoto.base64;
      const r = await fetch(`${API_BASE}/api/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(globalPatch),
      });
      if (!r.ok) throw new Error(`Settings ${r.status}`);
      // Save per-character user data to active character
      if (activeCharacterId) {
        const r = await fetch(
          `${API_BASE}/api/characters/${activeCharacterId}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userName, userBasicData, longTermMemory }),
          },
        );
        if (!r.ok) throw new Error(`Character ${r.status}`);
      }
      await loadSettings();
      onClose();
    } catch (err) {
      console.error("[save settings]", err);
      Alert.alert("Erro", "Não foi possível salvar as configurações.");
    } finally {
      setSaving(false);
    }
  }, [
    localUserPhoto,
    llmProvider,
    deepseekApiKey,
    activeCharacterId,
    userName,
    userBasicData,
    longTermMemory,
    loadSettings,
    onClose,
  ]);

  const activateCharacter = useCallback(
    async (id: string) => {
      try {
        await fetch(`${API_BASE}/api/characters/${id}/activate`, {
          method: "PATCH",
        });
        await loadSettings();
        // Reload per-character data for newly activated character
        const char = characters.find((c) => c._id === id);
        if (char) {
          setUserName(char.userName || "");
          setUserBasicData(char.userBasicData || "");
          setLongTermMemory(
            Array.isArray(char.longTermMemory) ? char.longTermMemory : [],
          );
        }
      } catch (err) {
        console.error("[activateCharacter]", err);
      }
    },
    [loadSettings, characters],
  );

  const restartToApply = useCallback(async () => {
    try {
      await Updates.reloadAsync();
    } catch (err) {
      Alert.alert(
        "Reinicie o app",
        "Feche e abra o app novamente para aplicar a nova URL.",
      );
    }
  }, []);

  const applyApiUrl = useCallback(async () => {
    const trimmed = apiUrlDraft.trim();
    if (!trimmed) return;
    try {
      new URL(trimmed);
    } catch {
      return Alert.alert(
        "URL inválida",
        "Digite uma URL válida, ex: http://192.168.0.10:3000",
      );
    }
    setApplyingApiUrl(true);
    await setApiBase(trimmed);
    await restartToApply();
    setApplyingApiUrl(false);
  }, [apiUrlDraft, restartToApply]);

  const resetApiUrl = useCallback(async () => {
    setApplyingApiUrl(true);
    await setApiBase(null);
    setApiUrlDraft(getDefaultApiBase());
    await restartToApply();
    setApplyingApiUrl(false);
  }, [restartToApply]);

  const userPhotoUri =
    localUserPhoto?.uri ??
    (userPhoto ? `${API_BASE}/files/${userPhoto}` : null);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <SafeAreaView className="flex-1 bg-background">
        {/* Header */}
        <Animated.View
          entering={FadeInDown.duration(240)}
          className="flex-row items-center justify-between px-4 py-3 border-b border-border"
        >
          <AnimatedPressable onPress={onClose} className="p-1">
            <MaterialCommunityIcons name="close" size={22} color="#8e8e93" />
          </AnimatedPressable>
          <Text className="text-white font-bold text-[16px]">
            Configurações
          </Text>
          <AnimatedPressable
            onPress={save}
            disabled={saving}
            className="px-8 py-2 rounded-full bg-accent"
          >
            {saving ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text className="text-white font-black text-xs">Salvar</Text>
            )}
          </AnimatedPressable>
        </Animated.View>

        {loading ? (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator color="#996dff" />
          </View>
        ) : (
          <KeyboardAvoidingView style={{ flex: 1 }} behavior={keyboardBehavior}>
            <ScrollView
              contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {/* ── Personagens ── */}
              <Animated.View
                entering={FadeInUp.delay(staggerDelay(0, 50)).duration(280).springify().damping(20).stiffness(180)}
                className="flex-row items-center justify-between mb-2"
              >
                <SectionLabel label="PERSONAGENS" />
                <AnimatedPressable
                  onPress={() => setEditingCharacter(null)}
                  scaleTo={PRESS_SCALE_SMALL}
                  className="flex-row bg-foreground px-4 py-1 rounded-full items-center gap-1"
                >
                  <MaterialCommunityIcons
                    name="plus"
                    size={14}
                    color="#996dff"
                  />
                  <Text className="text-accent text-[11px] font-bold">
                    Novo
                  </Text>
                </AnimatedPressable>
              </Animated.View>

              <Animated.View
                entering={FadeInUp.delay(staggerDelay(0, 50) + 30).duration(280).springify().damping(20).stiffness(180)}
              >
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ gap: 10, paddingBottom: 4 }}
                  className="mb-4"
                >
                  {characters.map((char, idx) => {
                    const isActive = char._id === activeCharacterId;
                    const uri = char.photo
                      ? `${API_BASE}/files/${char.photo}`
                      : null;
                    return (
                      <Animated.View
                        key={char._id}
                        entering={FadeIn.delay(staggerDelay(idx, 30)).springify().damping(36).stiffness(420)}
                        layout={LinearTransition.springify()}
                        style={{ alignItems: "center", width: 72 }}
                      >
                        <AnimatedPressable
                          onPress={() => activateCharacter(char._id)}
                          style={{ alignItems: "center", width: 72 }}
                        >
                          <View
                            style={{
                              width: 56,
                              height: 56,
                              borderRadius: 28,
                              overflow: "hidden",
                              borderWidth: 4,
                              borderColor: isActive ? "#996dff" : "transparent",
                              marginBottom: 6,
                            }}
                            className="bg-foreground items-center justify-center"
                          >
                            {uri ? (
                              <Image
                                source={{ uri }}
                                style={{ width: 56, height: 56 }}
                                contentFit="cover"
                              />
                            ) : (
                              <MaterialCommunityIcons
                                name="account"
                                size={24}
                                color="#666"
                              />
                            )}
                          </View>
                          <Text
                            className="text-white text-[11px] text-center"
                            numberOfLines={1}
                            style={{ fontWeight: isActive ? "700" : "400" }}
                          >
                            {char.name}
                          </Text>
                        </AnimatedPressable>

                        <AnimatedPressable
                          onPress={() => setEditingCharacter(char)}
                          scaleTo={PRESS_SCALE_SMALL}
                          className="mt-1 px-4 bg-foreground rounded-full py-1"
                          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                        >
                          <MaterialCommunityIcons
                            name="pencil"
                            size={12}
                            color="#555"
                          />
                        </AnimatedPressable>
                      </Animated.View>
                    );
                  })}
                </ScrollView>
              </Animated.View>

              {/* ── Sobre mim ── */}
              <View className="h-px bg-border my-3" />
              <Animated.View
                entering={FadeInUp.delay(staggerDelay(1, 50)).duration(280).springify().damping(20).stiffness(180)}
              >
                <SectionLabel label="SOBRE MIM" />

                <View className="mb-3 bg-foreground rounded-2xl px-4 py-4 border border-border flex-row items-center gap-4">
                  <AnimatedPressable onPress={pickUserPhoto} style={{ position: "relative" }}>
                    <View className="w-16 h-16 rounded-full overflow-hidden bg-accent items-center justify-center">
                      {userPhotoUri ? (
                        <Image
                          source={{ uri: userPhotoUri }}
                          style={{ width: 64, height: 64 }}
                          contentFit="cover"
                        />
                      ) : (
                        <MaterialCommunityIcons
                          name="account"
                          size={28}
                          color="#fff"
                        />
                      )}
                    </View>
                    <View className="absolute bottom-0 right-0 w-5 h-5 rounded-full bg-accent border-2 border-background items-center justify-center">
                      <MaterialCommunityIcons
                        name="pencil"
                        size={10}
                        color="#fff"
                      />
                    </View>
                  </AnimatedPressable>
                  <View className="flex-1">
                    <Text className="text-gray-300 text-xs font-bold mb-1.5">
                      SEU NOME
                    </Text>
                    <TextInput
                      value={userName}
                      onChangeText={setUserName}
                      placeholder="Como a Elfie deve te chamar"
                      placeholderTextColor="#9ca3af"
                      className="text-white text-[15px] font-bold"
                    />
                  </View>
                </View>

                <Field
                  label="DADOS BÁSICOS"
                  value={userBasicData}
                  onChangeText={setUserBasicData}
                  placeholder="Idade, cidade, interesses, trabalho..."
                  multiline
                  hint="Enviado em todo prompt."
                />
              </Animated.View>

              {/* ── Memória ── */}
              <View className="h-px bg-border my-3" />
              <Animated.View
                entering={FadeInUp.delay(staggerDelay(2, 50)).duration(280).springify().damping(20).stiffness(180)}
              >
                <SectionLabel label="MEMÓRIA DE LONGO PRAZO" />

                <Animated.View
                  layout={LinearTransition.springify().damping(38).stiffness(420)}
                  className="bg-foreground rounded-2xl border border-border overflow-hidden mb-2"
                >
                  {longTermMemory.length === 0 && (
                    <Animated.View
                      entering={FadeIn}
                      exiting={FadeOut}
                      className="px-4 py-5 items-center"
                    >
                      <Text className="text-gray-300 text-[13px]">
                        Nenhuma memória ainda
                      </Text>
                    </Animated.View>
                  )}
                  {longTermMemory.map((m, idx) => (
                    <MemoryItem
                      key={idx}
                      text={m}
                      onDelete={() =>
                        setLongTermMemory((prev) =>
                          prev.filter((_, i) => i !== idx),
                        )
                      }
                      onEdit={(t) =>
                        setLongTermMemory((prev) => {
                          const next = [...prev];
                          next[idx] = t;
                          return next;
                        })
                      }
                    />
                  ))}
                  <View className="flex-row items-center gap-2 px-3 py-2 border-t border-border">
                    <TextInput
                      ref={newMemoryRef}
                      value={newMemory}
                      onChangeText={onChangeNewMemory}
                      placeholder="Adicionar memória..."
                      placeholderTextColor="#9ca3af"
                      className="flex-1 text-white text-[13px] py-2"
                      onSubmitEditing={addMemory}
                      returnKeyType="done"
                      blurOnSubmit={false}
                    />
                    <AnimatedPressable
                      onPress={addMemory}
                      disabled={!newMemory.trim()}
                      scaleTo={PRESS_SCALE_SMALL}
                      style={[
                        {
                          width: 28,
                          height: 28,
                          borderRadius: 14,
                          alignItems: "center",
                          justifyContent: "center",
                        },
                        addMemoryBtnStyle,
                      ]}
                    >
                      <MaterialCommunityIcons
                        name="plus"
                        size={16}
                        color="#fff"
                      />
                    </AnimatedPressable>
                  </View>
                </Animated.View>
                <Text className="text-gray-300 text-[10px] px-1 mb-4">
                  Toque em uma memória para editar. A Elfie usa isso para te
                  conhecer melhor.
                </Text>
              </Animated.View>

              {/* ── Provedor de IA ── */}
              <View className="h-px bg-border my-3" />
              <Animated.View
                entering={FadeInUp.delay(staggerDelay(3, 50)).duration(280).springify().damping(20).stiffness(180)}
              >
                <SectionLabel label="PROVEDOR DE IA" />

                <Animated.View
                  layout={LinearTransition.springify().damping(30).stiffness(260)}
                  className="mb-3 bg-foreground rounded-2xl px-4 py-3 border border-border"
                >
                  <ProviderToggle value={llmProvider} onChange={setLlmProvider} />

                  {llmProvider === "deepseek" && (
                    <Animated.View
                      entering={FadeIn.duration(220)}
                      exiting={FadeOut.duration(160)}
                    >
                      <Text className="text-gray-400 text-[10px] font-bold mb-2">
                        DEEPSEEK API KEY
                      </Text>
                      <TextInput
                        value={deepseekApiKey}
                        onChangeText={setDeepseekApiKey}
                        placeholder="sk-..."
                        placeholderTextColor="#9ca3af"
                        className="text-white text-[13px]"
                        autoCapitalize="none"
                        autoCorrect={false}
                        secureTextEntry
                      />
                    </Animated.View>
                  )}

                  <Text className="text-gray-300 text-[10px] mt-2">
                    {llmProvider === "deepseek"
                      ? "Usa deepseek-chat por padrão. Embeddings continuam via OpenRouter."
                      : "Acessa qualquer modelo via openrouter.ai."}
                  </Text>
                </Animated.View>
              </Animated.View>

              {/* ── Servidor ── */}
              <View className="h-px bg-border my-3" />
              <Animated.View
                entering={FadeInUp.delay(staggerDelay(4, 50)).duration(280).springify().damping(20).stiffness(180)}
              >
                <SectionLabel label="SERVIDOR" />

                <View className="mb-3 bg-foreground rounded-2xl px-4 py-3 border border-border">
                  <Text className="text-gray-400 text-[10px] font-bold mb-2">
                    API URL
                  </Text>
                  <TextInput
                    value={apiUrlDraft}
                    onChangeText={setApiUrlDraft}
                    placeholder={getDefaultApiBase()}
                    placeholderTextColor="#9ca3af"
                    className="text-white text-[13px]"
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                  />
                  <Text className="text-gray-300 text-[10px] mt-2 mb-3">
                    Endereço do backend que o app usa. Aplicar reinicia o app.
                  </Text>
                  <View className="flex-row gap-2">
                    <AnimatedPressable
                      onPress={resetApiUrl}
                      disabled={applyingApiUrl}
                      className="flex-1 py-2.5 rounded-xl items-center border border-border"
                    >
                      <Text className="text-gray-300 text-[12px] font-bold">
                        Restaurar padrão
                      </Text>
                    </AnimatedPressable>
                    <AnimatedPressable
                      onPress={applyApiUrl}
                      disabled={applyingApiUrl || !apiUrlDraft.trim()}
                      className="flex-1 py-2.5 rounded-xl items-center bg-accent"
                    >
                      {applyingApiUrl ? (
                        <ActivityIndicator size="small" color="#fff" />
                      ) : (
                        <Text className="text-white text-[12px] font-bold">
                          Aplicar
                        </Text>
                      )}
                    </AnimatedPressable>
                  </View>
                </View>
              </Animated.View>

              {/* ── Debug ── */}
              <View className="h-px bg-border my-3" />
              <AnimatedPressable
                entering={FadeInUp.delay(staggerDelay(5, 50)).duration(280).springify().damping(20).stiffness(180)}
                onPress={() => setShowDebug(true)}
                className="flex-row items-center justify-between bg-foreground rounded-2xl px-4 py-3 border border-border"
              >
                <View className="flex-row items-center gap-3">
                  <MaterialCommunityIcons
                    name="bug-outline"
                    size={18}
                    color="#666"
                  />
                  <Text className="text-gray-300 text-[14px]">Debug</Text>
                </View>
                <View className="flex-row items-center gap-2">
                  {errorCount > 0 && (
                    <Animated.View
                      entering={FadeIn.springify()}
                      style={{
                        backgroundColor: "#ff382b",
                        borderRadius: 10,
                        paddingHorizontal: 7,
                        paddingVertical: 2,
                      }}
                    >
                      <Text
                        style={{
                          color: "#fff",
                          fontSize: 11,
                          fontWeight: "700",
                        }}
                      >
                        {errorCount}
                      </Text>
                    </Animated.View>
                  )}
                  <MaterialCommunityIcons
                    name="chevron-right"
                    size={18}
                    color="#555"
                  />
                </View>
              </AnimatedPressable>
            </ScrollView>
          </KeyboardAvoidingView>
        )}

        <DebugPanel visible={showDebug} onClose={() => setShowDebug(false)} />
      </SafeAreaView>

      {/* Character editor */}
      {editingCharacter !== undefined && (
        <CharacterEditor
          character={editingCharacter}
          onClose={() => setEditingCharacter(undefined)}
          onSaved={async () => {
            await loadSettings();
            setEditingCharacter(undefined);
          }}
        />
      )}
    </Modal>
  );
}
