import { FontAwesome5, MaterialCommunityIcons } from "@expo/vector-icons";
import { File as FSFile, Paths } from "expo-file-system";
import * as MediaLibrary from "expo-media-library/legacy";
import { BlurView } from "expo-blur";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import * as SecureStore from "expo-secure-store";
import {
  requestRecordingPermissionsAsync,
  RecordingPresets,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import { useVideoPlayer, VideoView } from "expo-video";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import ShimmerPlaceholder from "../components/SkeletonLoading";
import { useKeyboardBehavior } from "../hooks/useKeyboardBehavior";
import CallOverlay from "./CallOverlay";
import SettingsScreen from "./SettingsScreen";
import { useSettingsStore } from "../stores/mainStore";
import { useChatStreamStore } from "../stores/chatStreamStore";
import {
  Animated,
  AppState,
  Dimensions,
  Easing,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Modal,
  PanResponder,
  Platform,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import ReAnimated, {
  FadeIn,
  FadeInDown,
  FadeInUp,
  FadeOut,
  LinearTransition,
  SlideInDown,
  SlideInUp,
  SlideOutDown,
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  withDelay,
} from "react-native-reanimated";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaView } from "react-native-safe-area-context";
import AnimatedPressable from "../components/AnimatedPressable";
import { API_BASE } from "../constants";
import { useDebugStore } from "../stores/debugStore";
import { PRESS_SCALE_SMALL, staggerDelay } from "../utils/motion";

const DRAWER_WIDTH = 340;
const SCREEN_WIDTH = Dimensions.get("window").width;

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
  isNsfw?: boolean;
}

interface VoiceNote {
  filename: string;
}

interface NeuroEvent {
  type: string;
  text?: string;
  error?: boolean;
  raw?: any;
  ts: number;
}

interface Message {
  id: string;
  content: string;
  sender: "user" | "ai";
  createdAt: string;
  isEdited?: boolean;
  isRoutine?: boolean;
  savedMemory?: boolean;
  imageFilenames?: string[];
  searchSources?: SearchSource[];
  productCards?: ProductCard[];
  gifs?: Gif[];
  voiceNotes?: VoiceNote[];
  toolsUsed?: string[];
  fromNeuro?: boolean;
  replyTo?: { id: string; content: string; sender: "user" | "ai" };
  neuroType?: "confirm" | "update" | "question" | "done";
  neuroTaskId?: string;
  neuroChatId?: string;
  neuroText?: string;
  neuroError?: boolean;
  neuroConfirmed?: boolean;
  isCancelled?: boolean;
}

const formatTimestamp = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

let msgCounter = 0;
const newId = () => `msg-${++msgCounter}-${Date.now()}`;

const EMOJI_RE =
  /[\u{1F300}-\u{1FAFF}\u{2300}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F1E0}-\u{1F1FF}]+\u{FE0F}?/gu;
// Em dashes are an LLM tic that prompting alone never fully suppresses — strip them
// deterministically instead, same idea as the emoji cleanup below.
const EM_DASH_RE = /\s*—\s*/g;
// NOTE: only collapse spaces/tabs here, never bare \s — that also matches \n\n,
// which would silently eat the paragraph breaks the live-streaming boundary
// detection below relies on to know where separate chat bubbles go.
const sanitizeAiText = (s: string) =>
  s
    .replace(EMOJI_RE, "")
    .replace(EM_DASH_RE, ", ")
    .replace(/,[ \t]*,/g, ",")
    .replace(/[ \t]+([.,!?;:])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

// Same cleanup, but never trims — for live streaming deltas. Each chunk is a small
// fragment of a longer message, so trimming it eats the space (or newline) that
// separates it from its neighbors, squashing words together as they stream in.
const sanitizeAiTextChunk = (s: string) =>
  s
    .replace(EMOJI_RE, "")
    .replace(EM_DASH_RE, ", ")
    .replace(/,[ \t]*,/g, ",")
    .replace(/[ \t]+([.,!?;:])/g, "$1")
    .replace(/[ \t]{2,}/g, " ");
const TOOL_ACTIVITY_LABELS: Record<string, string> = {
  web_search: "pesquisando na web...",
  search_products: "buscando produtos...",
  save_memory: "salvando memória...",
  execute_command: "executando comando...",
  generate_pixel_art: "gerando pixel art...",
  generate_pixel_art_pro: "gerando pixel art (pro)...",
  convert_to_pixel_art: "convertendo...",
  convert_to_pixel_art_pro: "convertendo...",
  remove_background: "removendo fundo...",
  generate_with_style: "gerando com estilo...",
  send_gif: "procurando gif...",
  send_voice_message: "gravando áudio...",
  send_image: "buscando imagem...",
  create_skill: "criando nova ferramenta...",
  edit_skill: "editando ferramenta...",
  delete_skill: "apagando ferramenta...",
};

const TOOL_ERROR_LABELS: Record<string, string> = {
  web_search: "pesquisa falhou",
  search_products: "busca falhou",
  save_memory: "falha ao salvar memória",
  execute_command: "comando falhou",
  generate_pixel_art: "falha ao gerar",
  generate_pixel_art_pro: "falha ao gerar",
  convert_to_pixel_art: "falha ao converter",
  convert_to_pixel_art_pro: "falha ao converter",
  remove_background: "falha ao remover fundo",
  generate_with_style: "falha ao gerar",
  send_gif: "falha ao buscar gif",
  send_voice_message: "falha no áudio",
  send_image: "falha ao buscar imagem",
  create_skill: "falha ao criar ferramenta",
  edit_skill: "falha ao editar ferramenta",
  delete_skill: "falha ao apagar ferramenta",
  erro: "algo deu errado",
};

const TOOL_ACTIVITY_ICONS: Record<string, string> = {
  web_search: "magnify",
  search_products: "magnify",
  save_memory: "brain",
  execute_command: "console",
  generate_pixel_art: "image-outline",
  generate_pixel_art_pro: "image-outline",
  convert_to_pixel_art: "image-outline",
  convert_to_pixel_art_pro: "image-outline",
  remove_background: "image-outline",
  generate_with_style: "image-outline",
  send_gif: "star-four-points-outline",
  send_voice_message: "microphone-outline",
  send_image: "image-outline",
  create_skill: "wrench-outline",
  edit_skill: "pencil-outline",
  delete_skill: "trash-can-outline",
};

const formatToolLabel = (tool: string) =>
  tool
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

interface ToolActivity {
  key: string;
  kind: "tool" | "error";
  toolName?: string;
  label: string;
  detail?: string;
}

const toFrontendMessages = (raw: any[]): Message[] =>
  raw.map((m) => ({
    id: m._id,
    content: m.content,
    sender: m.role === "assistant" ? "ai" : "user",
    createdAt: m.createdAt,
    isRoutine: Boolean(m.triggeredByRoutine),
    savedMemory: m.savedMemory ?? false,
    imageFilenames:
      Array.isArray(m.imageFilenames) && m.imageFilenames.length > 0
        ? m.imageFilenames
        : undefined,
    searchSources:
      Array.isArray(m.searchSources) && m.searchSources.length > 0
        ? m.searchSources
        : undefined,
    productCards:
      Array.isArray(m.productCards) && m.productCards.length > 0
        ? m.productCards
        : undefined,
    gifs: Array.isArray(m.gifs) && m.gifs.length > 0 ? m.gifs : undefined,
    voiceNotes:
      Array.isArray(m.voiceNotes) && m.voiceNotes.length > 0
        ? m.voiceNotes
        : undefined,
  }));

// ─── Typing Dots ─────────────────────────────────────────────────────────────

const Dot = memo(({ delay }: { delay: number }) => {
  const translateY = useSharedValue(0);

  useEffect(() => {
    translateY.value = withDelay(
      delay,
      withRepeat(
        withSequence(
          withTiming(-6, { duration: 300 }),
          withTiming(0, { duration: 300 }),
        ),
        -1,
        false,
      ),
    );
  }, []);

  const style = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  return (
    <ReAnimated.View
      style={[
        {
          width: 5,
          height: 5,
          borderRadius: 3,
          backgroundColor: "#fff",
          marginHorizontal: 3,
        },
        style,
      ]}
    />
  );
});

const TypingIndicator = memo(() => (
  <ReAnimated.View
    entering={FadeInUp.springify().damping(36).stiffness(420)}
    exiting={FadeOut.duration(160)}
    className="flex-row items-center py-2 gap-2 mb-1"
    style={{ maxWidth: "85%" }}
  >
    <AiAvatar />
    <View
      className="bg-foreground rounded-2xl rounded-bl-sm px-4 py-3 flex-row items-center"
      style={{ flexShrink: 1 }}
    >
      <Dot delay={0} />
      <Dot delay={150} />
      <Dot delay={300} />
    </View>
  </ReAnimated.View>
));

// ─── Tool Activity Pill ───────────────────────────────────────────────────────

const PulseDot = memo(({ color }: { color: string }) => {
  const opacity = useSharedValue(1);

  useEffect(() => {
    opacity.value = withRepeat(
      withSequence(
        withTiming(0.3, { duration: 600 }),
        withTiming(1, { duration: 600 }),
      ),
      -1,
      true,
    );
  }, []);

  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <ReAnimated.View
      style={[
        { width: 6, height: 6, borderRadius: 3, backgroundColor: color },
        style,
      ]}
    />
  );
});

const WAVEFORM_BAR_COUNT = 27;
const WAVEFORM_MIN_HEIGHT = 3;
const WAVEFORM_MAX_HEIGHT = 24;

const WaveformBar = memo(({ height }: { height: number }) => {
  const barHeight = useSharedValue(WAVEFORM_MIN_HEIGHT);

  useEffect(() => {
    barHeight.value = withTiming(height, { duration: 140 });
  }, [height]);

  const style = useAnimatedStyle(() => ({ height: barHeight.value }));

  return (
    <ReAnimated.View
      style={[
        { width: 3, borderRadius: 2, backgroundColor: "#996dff" },
        style,
      ]}
    />
  );
});

// Sobe uma janela deslizante de amostras de metering (dBFS) em barrinhas
// vivas, tipo o áudio ao vivo do WhatsApp — sem depender de FFT real.
const VoiceWaveform = memo(({ metering }: { metering?: number }) => {
  const [levels, setLevels] = useState<number[]>(() =>
    Array(WAVEFORM_BAR_COUNT).fill(WAVEFORM_MIN_HEIGHT),
  );

  useEffect(() => {
    if (metering === undefined) return;
    const clamped = Math.max(-50, Math.min(0, metering));
    const norm = (clamped + 50) / 50;
    const h =
      WAVEFORM_MIN_HEIGHT + norm * (WAVEFORM_MAX_HEIGHT - WAVEFORM_MIN_HEIGHT);
    setLevels((prev) => [...prev.slice(1), h]);
  }, [metering]);

  return (
    <View
      style={{
        flex: 1,
        flexDirection: "row",
        alignItems: "center",
        gap: 3,
        height: WAVEFORM_MAX_HEIGHT,
        marginLeft: 10,
      }}
    >
      {levels.map((h, i) => (
        <WaveformBar key={i} height={h} />
      ))}
    </View>
  );
});

const ToolActivityPill = memo(({ activity }: { activity: ToolActivity }) => {
  const isError = activity.kind === "error";
  const iconName = isError
    ? "alert-circle-outline"
    : (TOOL_ACTIVITY_ICONS[activity.toolName ?? ""] ??
      "star-four-points-outline");
  const dotColor = isError ? "#f87171" : "#996dff";

  return (
    <ReAnimated.View
      entering={FadeIn.springify().damping(34).stiffness(500)}
      exiting={FadeOut.duration(160)}
      layout={LinearTransition.springify().damping(30).stiffness(340)}
      className="flex-row items-center rounded-full px-3 py-1.5 self-start"
      style={{ backgroundColor: "#1e1e2e", gap: 8, maxWidth: "100%" }}
    >
      <PulseDot color={dotColor} />
      <MaterialCommunityIcons
        name={iconName as any}
        size={12}
        color={isError ? "#f87171" : "#9ca3af"}
      />
      <Text
        style={{
          fontSize: 11,
          color: isError ? "#f87171" : "#9ca3af",
          fontWeight: "700",
        }}
      >
        {activity.label}
      </Text>
      {activity.detail && (
        <Text
          numberOfLines={1}
          ellipsizeMode="tail"
          style={{
            fontSize: 10,
            color: isError ? "#f3a5a5" : "#6b7280",
            flexShrink: 1,
          }}
        >
          {activity.detail}
        </Text>
      )}
    </ReAnimated.View>
  );
});

// ─── Neuro Message ───────────────────────────────────────────────────────────

const NeuroMessage = memo(
  ({
    item,
    onConfirm,
    onAnswer,
    onAvatarPress,
  }: {
    item: Message;
    onConfirm?: (taskId: string, chatId: string, confirmed: boolean) => void;
    onAnswer?: (chatId: string, answer: string) => void;
    onAvatarPress?: (kind: "ai" | "user") => void;
  }) => {
    const [localAnswer, setLocalAnswer] = useState("");
    const nt = item.neuroType;
    const tid = item.neuroTaskId;
    const cid = item.neuroChatId ?? "";

    return (
      <ReAnimated.View
        entering={FadeInUp.springify().damping(36).stiffness(420)}
        exiting={FadeOut.duration(160)}
        layout={LinearTransition.springify().damping(36).stiffness(420)}
        className="mb-2 flex-row items-start"
      >
        <View className="mr-2 mt-auto">
          <AiAvatar
            onPress={onAvatarPress ? () => onAvatarPress("ai") : undefined}
          />
        </View>
        <View className="flex-1 items-start">
          {nt === "confirm" && (
            <>
              <View className="bg-foreground rounded-2xl rounded-bl-sm px-4 py-3 max-w-[85%]">
                <View className="flex-row items-center mb-2" style={{ gap: 6 }}>
                  <MaterialCommunityIcons
                    name="chip"
                    size={10}
                    color="#9ca3af"
                  />
                  <Text
                    className="text-gray-400 font-black"
                    style={{ fontSize: 10 }}
                  >
                    NEURO
                  </Text>
                </View>
                <Text className="text-white">{item.neuroText}</Text>
                <Text className="text-[10px] font-bold text-gray-300 mt-1">
                  {formatTimestamp(item.createdAt)}
                </Text>
              </View>
              {!item.neuroConfirmed && tid && (
                <ReAnimated.View
                  entering={FadeIn.springify().damping(34).stiffness(500)}
                  className="flex-row mt-1.5 ml-1"
                  style={{ gap: 8 }}
                >
                  <AnimatedPressable
                    onPress={() => onConfirm?.(tid, cid, true)}
                    scaleTo={PRESS_SCALE_SMALL}
                    className="bg-accent rounded-full px-4 py-1.5"
                  >
                    <Text
                      className="text-white font-bold"
                      style={{ fontSize: 13 }}
                    >
                      sim
                    </Text>
                  </AnimatedPressable>
                  <AnimatedPressable
                    onPress={() => onConfirm?.(tid, cid, false)}
                    scaleTo={PRESS_SCALE_SMALL}
                    className="bg-foreground rounded-full px-4 py-1.5"
                  >
                    <Text
                      className="text-gray-300 font-bold"
                      style={{ fontSize: 13 }}
                    >
                      não
                    </Text>
                  </AnimatedPressable>
                </ReAnimated.View>
              )}
            </>
          )}
          {nt === "update" && (
            <View className="bg-foreground rounded-2xl rounded-bl-sm px-4 py-3 max-w-[85%]">
              <View className="flex-row items-center mb-1.5" style={{ gap: 6 }}>
                <MaterialCommunityIcons name="chip" size={10} color="#9ca3af" />
                <Text
                  className="text-gray-400 font-black"
                  style={{ fontSize: 10 }}
                >
                  NEURO · trabalhando
                </Text>
              </View>
              <Text className="text-gray-300">{item.neuroText}</Text>
            </View>
          )}
          {nt === "question" && (
            <>
              <View className="bg-foreground rounded-2xl rounded-bl-sm px-4 py-3 max-w-[85%]">
                <View
                  className="flex-row items-center mb-1.5"
                  style={{ gap: 6 }}
                >
                  <MaterialCommunityIcons
                    name="chip"
                    size={10}
                    color="#9ca3af"
                  />
                  <Text
                    className="text-gray-400 font-black"
                    style={{ fontSize: 10 }}
                  >
                    NEURO · pergunta
                  </Text>
                </View>
                <Text className="text-white">{item.neuroText}</Text>
                <Text className="text-[10px] font-bold text-gray-300 mt-1">
                  {formatTimestamp(item.createdAt)}
                </Text>
              </View>
              {!item.neuroConfirmed && cid && (
                <View
                  className="flex-row items-center mt-1.5 ml-1"
                  style={{ maxWidth: "85%", gap: 8 }}
                >
                  <TextInput
                    value={localAnswer}
                    onChangeText={setLocalAnswer}
                    placeholder="Responda aqui..."
                    placeholderTextColor="#9ca3af"
                    className="flex-1 bg-foreground rounded-xl px-3 py-2 text-white"
                    style={{ fontSize: 14, minWidth: 0 }}
                    multiline
                    maxLength={500}
                  />
                  <AnimatedPressable
                    onPress={() => {
                      if (localAnswer.trim()) {
                        onAnswer?.(cid, localAnswer.trim());
                        setLocalAnswer("");
                      }
                    }}
                    scaleTo={PRESS_SCALE_SMALL}
                    className="w-9 h-9 items-center justify-center rounded-full bg-accent"
                  >
                    <FontAwesome5 name="paper-plane" size={13} color="#fff" />
                  </AnimatedPressable>
                </View>
              )}
            </>
          )}
          {nt === "done" && (
            <View
              className="rounded-2xl rounded-bl-sm px-4 py-3 max-w-[85%]"
              style={{
                backgroundColor: item.neuroError ? "#2a1515" : "#13131f",
              }}
            >
              <View className="flex-row items-center mb-1.5" style={{ gap: 6 }}>
                <MaterialCommunityIcons
                  name="chip"
                  size={10}
                  color={item.neuroError ? "#ef4444" : "#9ca3af"}
                />
                <Text
                  className="font-black"
                  style={{
                    fontSize: 10,
                    color: item.neuroError ? "#ef4444" : "#9ca3af",
                  }}
                >
                  {item.neuroError ? "NEURO · erro" : "NEURO · concluído"}
                </Text>
              </View>
              {!!item.neuroText && (
                <Text className="text-white">{item.neuroText}</Text>
              )}
              <Text className="text-[10px] font-bold text-gray-300 mt-1">
                {formatTimestamp(item.createdAt)}
              </Text>
            </View>
          )}
        </View>
      </ReAnimated.View>
    );
  },
);

// ─── Search Sources ───────────────────────────────────────────────────────────

const SearchSources = memo(({ sources }: { sources: SearchSource[] }) => {
  const [expanded, setExpanded] = useState(false);
  const anim = useRef(new Animated.Value(0)).current;

  const toggle = useCallback(() => {
    const toValue = expanded ? 0 : 1;
    setExpanded(!expanded);
    Animated.timing(anim, {
      toValue,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [expanded, anim]);

  const maxHeight = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, sources.length * 90],
  });

  return (
    <View className="mt-1.5 ml-2" style={{ maxWidth: "85%" }}>
      <AnimatedPressable
        onPress={toggle}
        scaleTo={PRESS_SCALE_SMALL}
        className="flex-row items-center gap-1.5"
      >
        <MaterialCommunityIcons name="web" size={11} color="#9ca3af" />
        <Text className="text-gray-400 font-bold" style={{ fontSize: 10 }}>
          {sources.length} {sources.length === 1 ? "fonte" : "fontes"}
        </Text>
        <MaterialCommunityIcons
          name={expanded ? "chevron-up" : "chevron-down"}
          size={12}
          color="#9ca3af"
        />
      </AnimatedPressable>
      <Animated.View style={{ maxHeight, overflow: "hidden" }}>
        <View className="mt-1.5 gap-1.5">
          {sources.map((s, i) => (
            <AnimatedPressable
              key={i}
              entering={FadeIn.delay(staggerDelay(i, 30)).duration(200)}
              onPress={() => Linking.openURL(s.url)}
              className="bg-foreground rounded-xl px-3 py-2"
            >
              <Text
                className="text-white font-semibold"
                style={{ fontSize: 11 }}
                numberOfLines={1}
              >
                {s.title}
              </Text>
              <View className="flex-row items-center gap-1 mt-0.5">
                <MaterialCommunityIcons
                  name="open-in-new"
                  size={9}
                  color="#9ca3af"
                />
                <Text
                  className="text-gray-400"
                  style={{ fontSize: 10 }}
                  numberOfLines={1}
                >
                  {getDomain(s.url)}
                </Text>
              </View>
              {!!s.snippet && (
                <Text
                  className="text-gray-300 mt-0.5"
                  style={{ fontSize: 10 }}
                  numberOfLines={2}
                >
                  {s.snippet}
                </Text>
              )}
            </AnimatedPressable>
          ))}
        </View>
      </Animated.View>
    </View>
  );
});

// ─── Product Cards ────────────────────────────────────────────────────────────

const CARD_W = 148;
const CARD_IMG_H = 96;

const getDomain = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

const ProductCards = memo(({ cards }: { cards: ProductCard[] }) => {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ marginTop: 8 }}
      contentContainerStyle={{ paddingBottom: 2 }}
    >
      {cards.map((card, i) => (
        <AnimatedPressable
          key={i}
          entering={FadeIn.delay(staggerDelay(i, 30))
            .springify()
            .damping(36)
            .stiffness(420)}
          onPress={() => Linking.openURL(card.url)}
          style={{
            width: 148,
            height: 190,
            borderRadius: 14,
            overflow: "hidden",
            backgroundColor: "#1e1e2e",
            marginRight: 8,
          }}
        >
          <Image
            source={
              card.image ? { uri: card.image } : require("../assets/icon.png")
            }
            style={{ width: 148, height: 96 }}
            contentFit="cover"
          />
          <View style={{ padding: 8, height: 94 }}>
            <Text
              style={{
                color: "#fff",
                fontWeight: "600",
                fontSize: 11,
                lineHeight: 15,
              }}
              numberOfLines={2}
            >
              {card.title}
            </Text>
            <Text
              style={{
                color: "#9ca3af",
                fontSize: 10,
                marginTop: 3,
                lineHeight: 13,
              }}
              numberOfLines={2}
            >
              {card.snippet}
            </Text>
            <View
              style={{
                position: "absolute",
                bottom: 8,
                left: 8,
                right: 8,
                flexDirection: "row",
                alignItems: "center",
              }}
            >
              <MaterialCommunityIcons
                name="open-in-new"
                size={9}
                color="#6b7280"
              />
              <Text
                style={{
                  color: "#6b7280",
                  fontSize: 9,
                  marginLeft: 3,
                  flexShrink: 1,
                }}
                numberOfLines={1}
              >
                {getDomain(card.url)}
              </Text>
            </View>
          </View>
        </AnimatedPressable>
      ))}
    </ScrollView>
  );
});

// ─── Chat Skeleton ────────────────────────────────────────────────────────────

const ChatSkeleton = memo(() => (
  <View style={{ paddingHorizontal: 16, paddingTop: 10, gap: 12 }}>
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
      <ShimmerPlaceholder width={32} height={32} style={{ borderRadius: 16 }} />
      <ShimmerPlaceholder width="60%" height={48} />
    </View>
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-end",
        justifyContent: "flex-end",
        gap: 8,
      }}
    >
      <ShimmerPlaceholder width="50%" height={36} />
      <ShimmerPlaceholder width={32} height={32} style={{ borderRadius: 16 }} />
    </View>
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
      <ShimmerPlaceholder width={32} height={32} style={{ borderRadius: 16 }} />
      <ShimmerPlaceholder width="75%" height={64} />
    </View>
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-end",
        justifyContent: "flex-end",
        gap: 8,
      }}
    >
      <ShimmerPlaceholder width="40%" height={36} />
      <ShimmerPlaceholder width={32} height={32} style={{ borderRadius: 16 }} />
    </View>
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
      <ShimmerPlaceholder width={32} height={32} style={{ borderRadius: 16 }} />
      <ShimmerPlaceholder width="65%" height={48} />
    </View>
  </View>
));

// ─── Avatars ──────────────────────────────────────────────────────────────────

const AiAvatar = memo(({ onPress }: { onPress?: () => void }) => {
  const { aiPhoto } = useSettingsStore();
  const uri = aiPhoto ? `${API_BASE}/files/${aiPhoto}` : null;
  const content = (
    <View className="w-8 h-8 rounded-full overflow-hidden bg-foreground items-center justify-center">
      <Image
        source={uri ? { uri } : require("../assets/icon.png")}
        style={{ height: 32, width: 32 }}
        contentFit="cover"
      />
    </View>
  );
  if (!onPress) return content;
  return (
    <AnimatedPressable onPress={onPress} scaleTo={PRESS_SCALE_SMALL}>
      {content}
    </AnimatedPressable>
  );
});

const UserAvatar = memo(({ onPress }: { onPress?: () => void }) => {
  const { userPhoto } = useSettingsStore();
  const uri = userPhoto ? `${API_BASE}/files/${userPhoto}` : null;
  const content = (
    <View className="w-8 h-8 rounded-full overflow-hidden bg-foreground items-center justify-center">
      {uri ? (
        <Image
          source={{ uri }}
          style={{ width: 32, height: 32 }}
          contentFit="cover"
        />
      ) : (
        <FontAwesome5 name="user" size={14} color="#ffffff" />
      )}
    </View>
  );
  if (!onPress) return content;
  return (
    <AnimatedPressable onPress={onPress} scaleTo={PRESS_SCALE_SMALL}>
      {content}
    </AnimatedPressable>
  );
});

// ─── Voice Note Player ────────────────────────────────────────────────────────

const WAVEFORM = [
  3, 5, 8, 12, 6, 14, 10, 5, 8, 16, 9, 4, 11, 7, 13, 6, 9, 14, 5, 8, 12, 6, 4,
  10, 7, 5, 9, 3,
];

const VoiceNotePlayer = memo(({ filename }: { filename: string }) => {
  const player = useAudioPlayer({ uri: `${API_BASE}/files/${filename}` });
  const status = useAudioPlayerStatus(player);
  const [waveformWidth, setWaveformWidth] = useState(0);
  const waveformRef = useRef<View>(null);
  const waveformPageX = useRef(0);

  const progress =
    status.duration > 0 ? status.currentTime / status.duration : 0;

  const toggle = () => {
    if (status.playing) {
      player.pause();
    } else {
      player.play();
    }
  };

  const seekToAbsoluteX = (pageX: number) => {
    if (waveformWidth > 0 && status.duration > 0) {
      const relativeX = pageX - waveformPageX.current;
      const clamped = Math.max(0, Math.min(waveformWidth, relativeX));
      player.seekTo((clamped / waveformWidth) * status.duration);
    }
  };

  const seekPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_evt, gestureState) =>
        Math.abs(gestureState.dx) > Math.abs(gestureState.dy),
      onPanResponderGrant: (evt) => seekToAbsoluteX(evt.nativeEvent.pageX),
      onPanResponderMove: (evt) => seekToAbsoluteX(evt.nativeEvent.pageX),
    }),
  ).current;

  const fmt = (s: number) =>
    `${Math.floor(s / 60)}:${Math.floor(s % 60)
      .toString()
      .padStart(2, "0")}`;

  const displayTime =
    status.playing || progress > 0
      ? fmt(status.currentTime)
      : fmt(status.duration);

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 20,
        borderWidth: 2,
        borderColor: "#2c2c3e",
        backgroundColor: "#1e1e25",
        minWidth: 220,
      }}
    >
      <AnimatedPressable
        onPress={toggle}
        style={{
          width: 36,
          height: 36,
          borderRadius: 18,
          backgroundColor: "#996dff",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <MaterialCommunityIcons
          name={status.playing ? "pause" : "play"}
          size={18}
          color="#fff"
        />
      </AnimatedPressable>
      <View
        ref={waveformRef}
        {...seekPanResponder.panHandlers}
        style={{
          flex: 1,
          flexDirection: "row",
          alignItems: "center",
          gap: 2,
        }}
        onLayout={(e) => {
          setWaveformWidth(e.nativeEvent.layout.width);
          waveformRef.current?.measure((_x, _y, _width, _height, pageX) => {
            waveformPageX.current = pageX;
          });
        }}
      >
        {WAVEFORM.map((h, i) => (
          <View
            key={i}
            style={{
              width: 2.5,
              height: h,
              borderRadius: 2,
              backgroundColor:
                progress * WAVEFORM.length > i ? "#996dff" : "#3a3a4a",
              flexShrink: 0,
            }}
          />
        ))}
      </View>
      <Text
        style={{
          color: "#9ca3af",
          fontFamily: Platform.OS === "ios" ? "Courier" : "monospace",
          fontSize: 11,
          flexShrink: 0,
          minWidth: 30,
          textAlign: "right",
          marginLeft: 12,
        }}
      >
        {displayTime}
      </Text>
    </View>
  );
});

// ─── Aspect-ratio-aware image ─────────────────────────────────────────────────

const MAX_MEDIA_W = 280;
const MAX_MEDIA_H = 420;

const AspectImage = memo(
  ({
    uri,
    borderRadius = 10,
    onPress,
  }: {
    uri: string;
    borderRadius?: number;
    onPress?: () => void;
  }) => {
    const [dims, setDims] = useState<{ w: number; h: number } | null>(null);

    const dw = dims ? Math.min(dims.w, MAX_MEDIA_W) : MAX_MEDIA_W;
    const dh = dims
      ? Math.min(dw * (dims.h / dims.w), MAX_MEDIA_H)
      : Math.round(MAX_MEDIA_W * 0.75);

    const img = (
      <Image
        source={{ uri }}
        style={{ width: dw, height: dh, borderRadius }}
        contentFit="cover"
        onLoad={(e) => setDims({ w: e.source.width, h: e.source.height })}
      />
    );

    return onPress ? (
      <AnimatedPressable onPress={onPress}>{img}</AnimatedPressable>
    ) : (
      img
    );
  },
);

// ─── Image Grid (inside message bubble) ──────────────────────────────────────

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
        <AspectImage
          uri={uris[0]}
          borderRadius={10}
          onPress={() => onPress(0)}
        />
      );
    }

    return (
      <View
        style={{ flexDirection: "row", flexWrap: "wrap", gap: 3, width: 214 }}
      >
        {shown.map((uri, i) => (
          <AnimatedPressable
            key={i}
            entering={FadeIn.delay(staggerDelay(i, 25))
              .springify()
              .damping(36)
              .stiffness(420)}
            onPress={() => onPress(i)}
            style={{ position: "relative" }}
          >
            <Image
              source={{ uri }}
              style={{ width: 105, height: 85, borderRadius: 7 }}
              contentFit="cover"
            />
            {i === 3 && extra > 0 && (
              <View
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  backgroundColor: "rgba(0,0,0,0.55)",
                  borderRadius: 7,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text
                  style={{ color: "#fff", fontWeight: "bold", fontSize: 18 }}
                >
                  +{extra + 1}
                </Text>
              </View>
            )}
          </AnimatedPressable>
        ))}
      </View>
    );
  },
);

// ─── Image Preview Strip (before sending) ────────────────────────────────────

const ImagePreviewStrip = memo(
  ({
    images,
    onRemove,
  }: {
    images: ImagePicker.ImagePickerAsset[];
    onRemove: (i: number) => void;
  }) => {
    if (images.length === 0) return null;
    return (
      <ReAnimated.View
        entering={FadeIn.duration(180)}
        exiting={FadeOut.duration(160)}
        className="border-b border-border bg-background px-4 py-2"
      >
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {images.map((img, i) => (
              <ReAnimated.View
                key={i}
                entering={FadeIn.springify().damping(36).stiffness(420)}
                exiting={FadeOut.duration(160)}
                layout={LinearTransition.springify().damping(36).stiffness(420)}
                style={{ position: "relative" }}
              >
                <Image
                  source={{ uri: img.uri }}
                  style={{ width: 64, height: 64, borderRadius: 8 }}
                  contentFit="cover"
                />
                <AnimatedPressable
                  onPress={() => onRemove(i)}
                  scaleTo={PRESS_SCALE_SMALL}
                  style={{
                    position: "absolute",
                    top: -4,
                    right: -4,
                    width: 20,
                    height: 20,
                    borderRadius: 10,
                    backgroundColor: "#ff382b",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <MaterialCommunityIcons name="close" size={12} color="#fff" />
                </AnimatedPressable>
              </ReAnimated.View>
            ))}
          </View>
        </ScrollView>
      </ReAnimated.View>
    );
  },
);

// ─── Inline Video Player ──────────────────────────────────────────────────────

const InlineVideo = memo(
  ({
    uri,
    style,
    isMuted = false,
    useNativeControls = false,
  }: {
    uri: string;
    style: object;
    isMuted?: boolean;
    useNativeControls?: boolean;
  }) => {
    const player = useVideoPlayer(uri, (p) => {
      p.loop = true;
      p.muted = isMuted;
      p.play();
    });
    return (
      <VideoView
        player={player}
        style={style}
        contentFit="contain"
        nativeControls={useNativeControls}
      />
    );
  },
);

// ─── Fullscreen Image Modal ───────────────────────────────────────────────────

const AvatarPhotoModal = memo(
  ({
    avatar,
    onClose,
  }: {
    avatar: { uri: string; name: string } | null;
    onClose: () => void;
  }) => (
    <Modal
      visible={!!avatar}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <BlurView
        intensity={45}
        tint="dark"
        blurMethod="dimezisBlurView"
        style={{ flex: 1 }}
      >
        <AnimatedPressable
          entering={FadeIn.duration(200)}
          onPress={onClose}
          scaleTo={1}
          style={{
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(10,10,15,0.45)",
          }}
        >
          <AnimatedPressable
            entering={FadeIn.delay(60).duration(180)}
            onPress={onClose}
            scaleTo={PRESS_SCALE_SMALL}
            style={{
              position: "absolute",
              top: 50,
              right: 20,
              padding: 8,
              borderRadius: 999,
              backgroundColor: "rgba(255,255,255,0.1)",
            }}
          >
            <MaterialCommunityIcons name="close" size={18} color="#fff" />
          </AnimatedPressable>
          <ReAnimated.View
            entering={FadeIn.springify().damping(30).stiffness(340).mass(0.9)}
            style={{ alignItems: "center", gap: 16 }}
          >
            <View
              style={{
                width: 260,
                height: 260,
                borderRadius: 130,
                shadowColor: "#000",
                shadowOpacity: 0.55,
                shadowRadius: 35,
                shadowOffset: { width: 0, height: 24 },
                elevation: 20,
              }}
            >
              {avatar && (
                <Image
                  source={{ uri: avatar.uri }}
                  style={{ width: 260, height: 260, borderRadius: 130 }}
                  contentFit="cover"
                />
              )}
            </View>
            <Text style={{ color: "#fff", fontWeight: "600", fontSize: 15 }}>
              {avatar?.name}
            </Text>
          </ReAnimated.View>
        </AnimatedPressable>
      </BlurView>
    </Modal>
  ),
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
    const [currentIndex, setCurrentIndex] = useState(initialIndex);
    const [downloading, setDownloading] = useState(false);

    useEffect(() => {
      setCurrentIndex(initialIndex);
    }, [initialIndex, visible]);

    const handleDownload = useCallback(async () => {
      const uri = uris[currentIndex];
      if (!uri || downloading) return;
      setDownloading(true);
      try {
        const { status } = await MediaLibrary.requestPermissionsAsync();
        if (status !== "granted") return;
        const ext = uri.split("?")[0].split(".").pop() ?? "jpg";
        const destFile = new FSFile(Paths.cache, `elfie_${Date.now()}.${ext}`);
        const downloaded = await FSFile.downloadFileAsync(uri, destFile, {
          idempotent: true,
        });
        await MediaLibrary.saveToLibraryAsync(downloaded.uri);
      } catch (err) {
        console.error("[download]", err);
      } finally {
        setDownloading(false);
      }
    }, [uris, currentIndex, downloading]);

    const isVideo = uris[currentIndex]?.includes(".mp4");

    return (
      <Modal
        visible={visible}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={onClose}
      >
        <View style={{ flex: 1, backgroundColor: "#000" }}>
          <AnimatedPressable
            entering={FadeIn.delay(60).duration(180)}
            onPress={onClose}
            scaleTo={PRESS_SCALE_SMALL}
            style={{
              position: "absolute",
              top: 50,
              right: 20,
              zIndex: 10,
              padding: 8,
            }}
          >
            <MaterialCommunityIcons name="close" size={28} color="#fff" />
          </AnimatedPressable>
          {!isVideo && (
            <AnimatedPressable
              entering={FadeIn.delay(60).duration(180)}
              onPress={handleDownload}
              scaleTo={PRESS_SCALE_SMALL}
              style={{
                position: "absolute",
                bottom: 50,
                right: 20,
                zIndex: 10,
                padding: 10,
                backgroundColor: "rgba(0,0,0,0.55)",
                borderRadius: 50,
              }}
            >
              <MaterialCommunityIcons
                name={downloading ? "loading" : "download"}
                size={26}
                color="#fff"
              />
            </AnimatedPressable>
          )}
          <ScrollView
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            contentOffset={{ x: initialIndex * SCREEN_WIDTH, y: 0 }}
            style={{ flex: 1 }}
            onMomentumScrollEnd={(e) => {
              const idx = Math.round(
                e.nativeEvent.contentOffset.x / SCREEN_WIDTH,
              );
              setCurrentIndex(idx);
            }}
          >
            {uris.map((uri, i) => (
              <View
                key={i}
                style={{
                  width: SCREEN_WIDTH,
                  flex: 1,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {uri.includes(".mp4") ? (
                  <InlineVideo
                    uri={uri}
                    style={{ width: SCREEN_WIDTH, height: SCREEN_WIDTH * 0.75 }}
                    useNativeControls
                  />
                ) : (
                  <Image
                    source={{ uri }}
                    style={{ width: SCREEN_WIDTH, flex: 1 }}
                    contentFit="contain"
                  />
                )}
              </View>
            ))}
          </ScrollView>
        </View>
      </Modal>
    );
  },
);

// ─── Reply Preview ────────────────────────────────────────────────────────────

const ReplyPreview = memo(
  ({
    replyingTo,
    onCancel,
  }: {
    replyingTo: Message | null;
    onCancel: () => void;
  }) => {
    const { aiName } = useSettingsStore();
    if (!replyingTo) return null;
    const senderName = replyingTo.sender === "user" ? "Você" : aiName;
    return (
      <ReAnimated.View
        entering={SlideInDown.duration(220)}
        exiting={FadeOut.duration(150)}
        style={{
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderTopWidth: 1,
          borderTopColor: "#1e1e2e",
          backgroundColor: "#17171c",
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            backgroundColor: "#1e1e25",
            borderRadius: 12,
            borderLeftWidth: 3,
            borderLeftColor: "#996dff",
            paddingHorizontal: 10,
            paddingVertical: 8,
          }}
        >
          <MaterialCommunityIcons name="reply" size={15} color="#996dff" />
          <View style={{ flex: 1 }}>
            <Text
              style={{
                fontSize: 11,
                fontWeight: "700",
                color: "#996dff",
                marginBottom: 1,
              }}
            >
              {senderName}
            </Text>
            <Text style={{ fontSize: 12, color: "#9ca3af" }} numberOfLines={1}>
              {replyingTo.content || "Mídia"}
            </Text>
          </View>
          <AnimatedPressable
            onPress={onCancel}
            scaleTo={PRESS_SCALE_SMALL}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <MaterialCommunityIcons name="close" size={15} color="#9ca3af" />
          </AnimatedPressable>
        </View>
      </ReAnimated.View>
    );
  },
);

// ─── Modals ───────────────────────────────────────────────────────────────────

const DeleteMessageModal = memo(
  ({
    visible,
    onRequestClose,
    onConfirm,
    onCancel,
  }: {
    visible: boolean;
    onRequestClose: () => void;
    onConfirm: () => void;
    onCancel: () => void;
  }) => (
    <Modal
      animationType="fade"
      transparent
      statusBarTranslucent
      visible={visible}
      onRequestClose={onRequestClose}
    >
      <ReAnimated.View
        entering={FadeIn.duration(200)}
        className="flex-1 items-center justify-center bg-black/70"
      >
        <ReAnimated.View
          entering={FadeIn.springify().damping(30).stiffness(340).mass(0.9)}
          className="w-4/5 items-center rounded-2xl bg-foreground p-5"
        >
          <Text className="mb-4 text-xl text-white font-black">
            Apagar mensagem
          </Text>
          <Text className="mb-6 text-center text-gray-300">
            Tem certeza que deseja apagar esta mensagem?
          </Text>
          <View className="w-full gap-2">
            <AnimatedPressable
              onPress={onConfirm}
              className="w-full rounded-full bg-destructive px-6 py-3"
            >
              <Text className="text-center text-white font-bold">Apagar</Text>
            </AnimatedPressable>
            <AnimatedPressable
              onPress={onCancel}
              className="w-full rounded-full bg-background px-6 py-3"
            >
              <Text className="text-center text-gray-300 font-bold">
                Cancelar
              </Text>
            </AnimatedPressable>
          </View>
        </ReAnimated.View>
      </ReAnimated.View>
    </Modal>
  ),
);

const EditMessageModal = memo(
  ({
    visible,
    onRequestClose,
    onConfirm,
    onCancel,
    value,
    onChangeText,
  }: {
    visible: boolean;
    onRequestClose: () => void;
    onConfirm: () => void;
    onCancel: () => void;
    value: string;
    onChangeText: (t: string) => void;
  }) => (
    <Modal
      animationType="fade"
      transparent
      statusBarTranslucent
      visible={visible}
      onRequestClose={onRequestClose}
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ReAnimated.View
          entering={FadeIn.duration(200)}
          className="flex-1 items-center justify-center bg-black/70"
        >
          <ReAnimated.View
            entering={FadeIn.springify().damping(30).stiffness(340).mass(0.9)}
            className="w-4/5 items-center rounded-2xl bg-foreground p-5"
          >
            <Text className="mb-4 text-xl text-white font-black">
              Editar mensagem
            </Text>
            <TextInput
              value={value}
              onChangeText={onChangeText}
              placeholder="Digite sua mensagem..."
              placeholderTextColor="#9ca3af"
              className="mb-6 w-full rounded-2xl bg-background p-4 text-white border-b-2 border-b-accent"
              multiline
              maxLength={2000}
              autoFocus
            />
            <View className="w-full gap-2">
              <AnimatedPressable
                onPress={onConfirm}
                disabled={!value.trim()}
                className={`w-full rounded-full px-6 py-3 ${value.trim() ? "bg-accent" : "bg-background opacity-50"}`}
              >
                <Text className="text-center text-white font-bold">Salvar</Text>
              </AnimatedPressable>
              <AnimatedPressable
                onPress={onCancel}
                className="w-full rounded-full bg-background px-6 py-3"
              >
                <Text className="text-center text-gray-300 font-bold">
                  Cancelar
                </Text>
              </AnimatedPressable>
            </View>
          </ReAnimated.View>
        </ReAnimated.View>
      </KeyboardAvoidingView>
    </Modal>
  ),
);

const MessageActionsModal = memo(
  ({
    visible,
    isOwn,
    onClose,
    onReply,
    onEdit,
    onDelete,
  }: {
    visible: boolean;
    isOwn: boolean;
    onClose: () => void;
    onReply: () => void;
    onEdit: () => void;
    onDelete: () => void;
  }) => (
    <Modal
      animationType="fade"
      transparent
      statusBarTranslucent
      visible={visible}
      onRequestClose={onClose}
    >
      <AnimatedPressable
        entering={FadeIn.duration(200)}
        className="flex-1 bg-black/50"
        onPress={onClose}
        scaleTo={1}
      >
        <ReAnimated.View
          entering={SlideInUp.springify().damping(30).stiffness(340).mass(0.9)}
          exiting={SlideOutDown.duration(180)}
          className="absolute bottom-0 left-0 right-0 bg-foreground rounded-t-3xl pb-8"
        >
          <View className="w-10 h-1 rounded-full bg-border self-center mt-3 mb-2" />
          <AnimatedPressable
            onPress={onReply}
            className="flex-row items-center gap-3 px-5 py-4 border-t border-border"
          >
            <MaterialCommunityIcons name="reply" color="#ffffff" size={18} />
            <Text className="text-white font-bold">Responder</Text>
          </AnimatedPressable>
          {isOwn && (
            <>
              <AnimatedPressable
                onPress={onEdit}
                className="flex-row items-center gap-3 px-5 py-4 border-t border-border"
              >
                <MaterialCommunityIcons
                  name="pencil"
                  color="#ffffff"
                  size={18}
                />
                <Text className="text-white font-bold">Editar</Text>
              </AnimatedPressable>
              <AnimatedPressable
                onPress={onDelete}
                className="flex-row items-center gap-3 px-5 py-4 border-t border-border"
              >
                <MaterialCommunityIcons
                  name="trash-can"
                  color="#ff382b"
                  size={18}
                />
                <Text className="text-white font-bold">Apagar</Text>
              </AnimatedPressable>
            </>
          )}
        </ReAnimated.View>
      </AnimatedPressable>
    </Modal>
  ),
);

// ─── Message Item ─────────────────────────────────────────────────────────────

const MessageItem = memo(
  ({
    item,
    onLongPress,
    onImagePress,
    onGifPress,
    onAvatarPress,
  }: {
    item: Message;
    onLongPress: (msg: Message) => void;
    onImagePress: (filenames: string[], index: number) => void;
    onGifPress?: (uri: string) => void;
    onAvatarPress?: (kind: "ai" | "user") => void;
  }) => {
    const { aiName } = useSettingsStore();
    const isOwn = item.sender === "user";

    return (
        <ReAnimated.View
          entering={FadeInUp.springify().damping(36).stiffness(420)}
          exiting={FadeOut.duration(160)}
          layout={LinearTransition.springify().damping(36).stiffness(420)}
          className="mb-2 flex-row items-start"
        >
          {!isOwn && (
            <View className="mr-2 mt-auto">
              <AiAvatar
                onPress={onAvatarPress ? () => onAvatarPress("ai") : undefined}
              />
            </View>
          )}
          <View className={`flex-1 ${isOwn ? "items-end" : "items-start"}`}>
            {item.replyTo && (
              <View
                className={`mb-1 max-w-[85%] rounded-lg border-l-4 border-l-accent bg-foreground p-2 ${isOwn ? "self-end" : "self-start"}`}
              >
                <Text className="text-xs text-gray-300 font-bold">
                  {item.replyTo.sender === "user" ? "Você" : aiName}
                </Text>
                <Text className="text-sm text-gray-300" numberOfLines={1}>
                  {item.replyTo.content}
                </Text>
              </View>
            )}
            {isOwn && item.isRoutine && (
              <View className="mr-2 mb-1 flex-row items-center gap-1 self-end">
                <MaterialCommunityIcons name="clock-outline" size={9} color="#d1d5db" />
                <Text className="text-[10px] text-gray-300">rotina agendada</Text>
              </View>
            )}
            {item?.toolsUsed?.map((tool) => {
              const TOOL_LABELS: Record<
                string,
                { label: string; icon: React.ReactNode }
              > = {
                execute_command: {
                  label: "terminal",
                  icon: <Text className="text-xs text-gray-300">&gt;_</Text>,
                },
                save_memory: {
                  label: "memória salva",
                  icon: (
                    <MaterialCommunityIcons
                      name="pen"
                      size={8}
                      color="#d1d5db"
                    />
                  ),
                },
                generate_pixel_art: {
                  label: "pixel art gerada",
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
                  label: "gerado com estilo",
                  icon: (
                    <PixelGridIcon
                      size={10}
                      color="#d1d5db"
                      dimColor="rgba(209,213,219,0.3)"
                    />
                  ),
                },
                remove_background: {
                  label: "fundo removido",
                  icon: (
                    <PixelGridIcon
                      size={10}
                      color="#d1d5db"
                      dimColor="rgba(209,213,219,0.3)"
                    />
                  ),
                },
                web_search: {
                  label: "pesquisa web",
                  icon: (
                    <MaterialCommunityIcons
                      name="pen"
                      size={8}
                      color="#d1d5db"
                    />
                  ),
                },
                search_products: {
                  label: "busca produtos",
                  icon: (
                    <MaterialCommunityIcons
                      name="pen"
                      size={8}
                      color="#d1d5db"
                    />
                  ),
                },
                send_gif: {
                  label: "gif",
                  icon: <Text className="text-xs text-gray-300">GIF</Text>,
                },
                send_voice_message: {
                  label: "áudio",
                  icon: (
                    <MaterialCommunityIcons
                      name="pen"
                      size={8}
                      color="#d1d5db"
                    />
                  ),
                },
                create_skill: {
                  label: "nova ferramenta",
                  icon: (
                    <MaterialCommunityIcons
                      name="wrench-outline"
                      size={8}
                      color="#d1d5db"
                    />
                  ),
                },
                edit_skill: {
                  label: "ferramenta editada",
                  icon: (
                    <MaterialCommunityIcons
                      name="pencil-outline"
                      size={8}
                      color="#d1d5db"
                    />
                  ),
                },
                delete_skill: {
                  label: "ferramenta removida",
                  icon: (
                    <MaterialCommunityIcons
                      name="trash-can-outline"
                      size={8}
                      color="#d1d5db"
                    />
                  ),
                },
              };
              const meta = TOOL_LABELS[tool] ?? {
                label: tool,
                icon: (
                  <MaterialCommunityIcons name="pen" size={8} color="#d1d5db" />
                ),
              };
              return (
                <View key={tool} className="flex-row ml-2 items-center gap-0.5 mb-1 self-start">
                  <MaterialCommunityIcons name="pen" size={8} color="#d1d5db" />
                  <Text
                    className="text-gray-300 font-black"
                    style={{ fontSize: 10 }}
                  >
                    {meta.label}
                  </Text>
                </View>
              );
            })}

            {item.imageFilenames && item.imageFilenames.length > 0 && (
              <View
                className="border-2 border-tertiary rounded-2xl overflow-hidden"
                style={{ marginBottom: item.content ? 6 : 0 }}
              >
                <ImageGrid
                  filenames={item.imageFilenames}
                  onPress={(idx) => onImagePress(item.imageFilenames!, idx)}
                />
              </View>
            )}
            {item.gifs &&
              item.gifs.length > 0 &&
              item.gifs.map((gif, i) => {
                const gifUri = gif.mp4 ?? gif.url;
                if (!gifUri) return null;
                const isMp4 = gifUri.endsWith(".mp4");
                return (
                  <AnimatedPressable
                    key={i}
                    onPress={() => onGifPress?.(gifUri)}
                    className={`border-2 border-tertiary ${isOwn ? "self-end" : "self-start"} rounded-2xl overflow-hidden`}
                    style={{ marginBottom: 6 }}
                  >
                    {isMp4 ? (
                      <InlineVideo
                        uri={gifUri}
                        style={{
                          width: MAX_MEDIA_W,
                          height: Math.round(MAX_MEDIA_W * 0.75),
                        }}
                        isMuted
                      />
                    ) : (
                      <AspectImage uri={gifUri} borderRadius={0} />
                    )}
                  </AnimatedPressable>
                );
              })}
            {item.voiceNotes &&
              item.voiceNotes.length > 0 &&
              item.voiceNotes.map((vn, i) => (
                <View
                  key={i}
                  className={isOwn ? "self-end" : "self-start"}
                  style={{ marginBottom: 6 }}
                >
                  <VoiceNotePlayer filename={vn.filename} />
                </View>
              ))}
            {!!item.content && (
              <AnimatedPressable
                onLongPress={() => onLongPress(item)}
                scaleTo={1}
                className={`relative max-w-[85%] px-4 py-3 ${isOwn ? "bg-[#1b1b22] rounded-2xl rounded-br-sm self-end" : "bg-foreground rounded-2xl rounded-bl-sm self-start"}`}
              >
                <Text className="text-white">{item.content}</Text>
                {!isOwn && item.fromNeuro && (
                  <View
                    className="absolute bottom-2 right-2 px-2"
                    style={{
                      height: 20,
                      borderRadius: 999,
                      backgroundColor: "rgba(255,255,255,0.12)",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <MaterialCommunityIcons
                      name="lightning-bolt"
                      size={11}
                      color="#fff"
                    />
                  </View>
                )}
                <View className="mt-1 flex-row items-center justify-between">
                  <Text className="text-[10px] font-bold text-gray-300">
                    {formatTimestamp(item.createdAt)}
                  </Text>
                  {item.isEdited && (
                    <Text className="text-[9px] text-gray-300 ml-2">
                      editado
                    </Text>
                  )}
                </View>
              </AnimatedPressable>
            )}
            {!isOwn && item.searchSources && item.searchSources.length > 0 && (
              <SearchSources sources={item.searchSources} />
            )}
            {!isOwn && item.productCards && item.productCards.length > 0 && (
              <ProductCards cards={item.productCards} />
            )}
          </View>
          {isOwn && (
            <View className="ml-2 mt-auto">
              <UserAvatar
                onPress={
                  onAvatarPress ? () => onAvatarPress("user") : undefined
                }
              />
            </View>
          )}
        </ReAnimated.View>
    );
  },
);

// ─── Neuro Panel (terminal-style, web sidebar) ───────────────────────────────

const NeuroPanel = memo(
  ({
    events,
    chatId,
    isRunning,
    onSend,
    onInterrupt,
  }: {
    events: NeuroEvent[];
    chatId: string | null;
    isRunning: boolean;
    onSend: (msg: string) => void;
    onInterrupt: () => void;
  }) => {
    const [input, setInput] = useState("");
    const scrollRef = useRef<ScrollView>(null);

    useEffect(() => {
      scrollRef.current?.scrollToEnd({ animated: false });
    }, [events.length]);

    if (!chatId && events.length === 0) return null;

    // Merge consecutive neuro_text chunks for display
    const grouped = events.reduce<NeuroEvent[]>((acc, ev) => {
      if (
        ev.type === "neuro_text" &&
        acc.length > 0 &&
        acc[acc.length - 1].type === "neuro_text"
      ) {
        const last = acc[acc.length - 1];
        return [
          ...acc.slice(0, -1),
          { ...last, text: (last.text ?? "") + (ev.text ?? "") },
        ];
      }
      return [...acc, ev];
    }, []);

    const send = () => {
      if (!input.trim()) return;
      onSend(input.trim());
      setInput("");
    };

    return (
      <View
        style={{
          width: 320,
          borderLeftWidth: 1,
          borderLeftColor: "#1e1e2e",
          backgroundColor: "#0d0d1a",
          flexDirection: "column",
        }}
      >
        {/* Header */}
        <View
          style={{
            paddingHorizontal: 14,
            paddingVertical: 11,
            borderBottomWidth: 1,
            borderBottomColor: "#1e1e2e",
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
          }}
        >
          <MaterialCommunityIcons name="chip" size={13} color="#9ca3af" />
          <Text
            style={{
              color: "#9ca3af",
              fontWeight: "900",
              fontSize: 11,
              flex: 1,
            }}
          >
            NEURO · claude code
          </Text>
          {isRunning && (
            <>
              <View
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: "#22c55e",
                }}
              />
              <TouchableOpacity
                onPress={onInterrupt}
                style={{
                  paddingHorizontal: 8,
                  paddingVertical: 4,
                  borderRadius: 6,
                  backgroundColor: "#1e1e2e",
                }}
              >
                <Text
                  style={{ color: "#ef4444", fontSize: 10, fontWeight: "700" }}
                >
                  stop
                </Text>
              </TouchableOpacity>
            </>
          )}
        </View>

        {/* Event stream */}
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 12, gap: 4 }}
        >
          {grouped.length === 0 && (
            <Text
              style={{ color: "#4b5563", fontSize: 12, fontStyle: "italic" }}
            >
              aguardando...
            </Text>
          )}
          {grouped.map((ev, i) => {
            if (ev.type === "neuro_user_message") {
              return (
                <Text
                  key={i}
                  style={{ color: "#6b7280", fontSize: 11, marginBottom: 6 }}
                >
                  {"› "}
                  {ev.text}
                </Text>
              );
            }
            if (ev.type === "neuro_tool") {
              return (
                <View
                  key={i}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 5,
                    marginBottom: 4,
                    backgroundColor: "#1e1e2e",
                    borderRadius: 6,
                    paddingHorizontal: 8,
                    paddingVertical: 4,
                  }}
                >
                  <MaterialCommunityIcons
                    name="wrench"
                    size={10}
                    color="#996dff"
                  />
                  <Text
                    style={{
                      color: "#996dff",
                      fontSize: 10,
                      fontFamily:
                        Platform.OS === "web" ? "monospace" : undefined,
                    }}
                  >
                    {ev.text ?? "tool"}
                  </Text>
                </View>
              );
            }
            if (ev.type === "neuro_text" || ev.type === "neuro_update") {
              return (
                <Text
                  key={i}
                  style={{
                    color: "#d1d5db",
                    fontSize: 12,
                    lineHeight: 18,
                    marginBottom: 2,
                  }}
                >
                  {ev.text}
                </Text>
              );
            }
            if (ev.type === "neuro_question") {
              return (
                <Text
                  key={i}
                  style={{
                    color: "#60a5fa",
                    fontSize: 12,
                    lineHeight: 18,
                    marginBottom: 4,
                  }}
                >
                  {"❓ "}
                  {ev.text}
                </Text>
              );
            }
            if (ev.type === "neuro_done") {
              return (
                <Text
                  key={i}
                  style={{
                    color: ev.error ? "#ef4444" : "#22c55e",
                    fontSize: 11,
                    fontWeight: "700",
                    marginTop: 8,
                    marginBottom: 4,
                  }}
                >
                  {ev.error ? "✗ erro" : "✓ concluído"}
                </Text>
              );
            }
            if (ev.type === "neuro_interrupted") {
              return (
                <Text
                  key={i}
                  style={{
                    color: "#f59e0b",
                    fontSize: 11,
                    fontWeight: "700",
                    marginTop: 4,
                  }}
                >
                  ⚡ interrompido
                </Text>
              );
            }
            return null;
          })}
        </ScrollView>

        {/* Input */}
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: "#1e1e2e",
            padding: 10,
            flexDirection: "row",
            gap: 8,
            alignItems: "center",
          }}
        >
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder="Enviar para Claude..."
            placeholderTextColor="#9ca3af"
            style={{
              flex: 1,
              color: "#fff",
              fontSize: 12,
              backgroundColor: "#1e1e2e",
              borderRadius: 8,
              paddingHorizontal: 10,
              paddingVertical: 6,
            }}
            onSubmitEditing={send}
            blurOnSubmit={false}
          />
          <TouchableOpacity
            onPress={send}
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              backgroundColor: input.trim() ? "#996dff" : "#1e1e2e",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <FontAwesome5 name="paper-plane" size={11} color="#fff" />
          </TouchableOpacity>
        </View>
      </View>
    );
  },
);

// ─── Drawer ───────────────────────────────────────────────────────────────────

const ChatsDrawer = memo(
  ({
    anim,
    isOpen,
    chats,
    activeChatId,
    onSelectChat,
    onNewChat,
    onDeleteChat,
    onClose,
    onOpenSettings,
  }: {
    anim: Animated.Value;
    isOpen: boolean;
    chats: ChatMeta[];
    activeChatId: string | null;
    onSelectChat: (id: string) => void;
    onNewChat: () => void;
    onDeleteChat: (id: string) => void;
    onClose: () => void;
    onOpenSettings: () => void;
  }) => {
    const { aiName, aiPhoto } = useSettingsStore();
    const aiPhotoUri = aiPhoto ? `${API_BASE}/files/${aiPhoto}` : null;

    const panResponder = useRef(
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gs) =>
          gs.dx > 8 && Math.abs(gs.dx) > Math.abs(gs.dy),
        onPanResponderMove: (_, gs) => {
          if (gs.dx > 0) anim.setValue(1 - gs.dx / DRAWER_WIDTH);
        },
        onPanResponderRelease: (_, gs) => {
          if (gs.dx > DRAWER_WIDTH / 3 || gs.vx > 0.5) {
            Animated.timing(anim, {
              toValue: 0,
              duration: 200,
              easing: Easing.in(Easing.cubic),
              useNativeDriver: true,
            }).start(() => onClose());
          } else {
            Animated.timing(anim, {
              toValue: 1,
              duration: 200,
              easing: Easing.out(Easing.cubic),
              useNativeDriver: true,
            }).start();
          }
        },
        onPanResponderTerminate: () => {
          Animated.timing(anim, {
            toValue: 1,
            duration: 200,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }).start();
        },
      }),
    ).current;

    const translateX = anim.interpolate({
      inputRange: [0, 1],
      outputRange: [DRAWER_WIDTH, 0],
    });
    const overlayOpacity = anim.interpolate({
      inputRange: [0, 1],
      outputRange: [0, 0.6],
    });

    return (
      <View
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 100,
        }}
        pointerEvents={isOpen ? "box-none" : "none"}
      >
        <Animated.View
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "#000",
            opacity: overlayOpacity,
          }}
          pointerEvents="none"
        />
        <TouchableOpacity
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: DRAWER_WIDTH,
            bottom: 0,
          }}
          activeOpacity={1}
          onPress={onClose}
        />
        <Animated.View
          {...panResponder.panHandlers}
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            bottom: 0,
            borderBottomLeftRadius: 30,
            borderTopLeftRadius: 30,
            width: DRAWER_WIDTH,
            transform: [{ translateX }],
          }}
          className="bg-background border-l border-border"
        >
          <SafeAreaView style={{ flex: 1 }} edges={["top", "bottom", "right"]}>
            <View className="flex-row items-center px-4 py-3 border-b border-tertiary gap-3">
              <AnimatedPressable onPress={onOpenSettings} scaleTo={PRESS_SCALE_SMALL}>
                <View className="w-10 h-10 rounded-full overflow-hidden bg-accent">
                  <Image
                    source={
                      aiPhotoUri
                        ? { uri: aiPhotoUri }
                        : require("../assets/icon.png")
                    }
                    style={{ height: 40, width: 40 }}
                    contentFit="cover"
                  />
                </View>
              </AnimatedPressable>
              <View className="flex-1">
                <Text className="text-white font-bold">{aiName}</Text>
              </View>
              <AnimatedPressable
                onPress={onNewChat}
                className="h-8 rounded-full bg-foreground px-4 items-center justify-center"
                style={{
                  elevation: 4,
                  shadowOffset: { width: 0, height: 2 },
                  shadowOpacity: 0.4,
                  shadowRadius: 6,
                }}
              >
                <MaterialCommunityIcons name="plus" size={18} color="#fff" />
              </AnimatedPressable>
            </View>

            <Text className="text-gray-300 mt-4 mb-2 font-black text-xs tracking-widest px-4 pt-3 pb-1">
              RECENTES
            </Text>

            <ScrollView showsVerticalScrollIndicator={false}>
              {chats.map((item, idx) => {
                const isActive = item._id === activeChatId;
                return (
                  <ReAnimated.View
                    key={item._id}
                    entering={FadeIn.delay(staggerDelay(idx, 25))
                      .springify()
                      .damping(36)
                      .stiffness(420)}
                    exiting={FadeOut.duration(160)}
                    layout={LinearTransition.springify().damping(36).stiffness(420)}
                    style={{ borderRadius: 14 }}
                    className={`flex-row flex-1 items-center justify-between px-4 rounded-2xl mx-2 mb-0.5 ${isActive ? "bg-foreground" : ""}`}
                  >
                    <AnimatedPressable
                      onPress={() => onSelectChat(item._id)}
                      className="flex-1 flex-row items-center py-4"
                    >
                      <Text
                        className={`w-[80%] text-sm ${isActive ? "text-white font-bold" : "text-gray-300"}`}
                        numberOfLines={1}
                      >
                        {item.title}
                      </Text>
                    </AnimatedPressable>
                    <AnimatedPressable
                      onPress={() => onDeleteChat(item._id)}
                      scaleTo={PRESS_SCALE_SMALL}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <MaterialCommunityIcons
                        name="trash-can-outline"
                        size={14}
                        color="#fff"
                      />
                    </AnimatedPressable>
                  </ReAnimated.View>
                );
              })}
            </ScrollView>
          </SafeAreaView>
        </Animated.View>
      </View>
    );
  },
);

// ─── PixelLab ─────────────────────────────────────────────────────────────────

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
    const cell = Math.max(2, Math.floor(size / 4));
    const gap = Math.max(1, Math.floor(cell / 3));
    const pattern = [
      [1, 0, 1, 0],
      [0, 1, 0, 1],
      [1, 0, 1, 0],
      [0, 1, 0, 1],
    ];
    return (
      <View style={{ gap }}>
        {pattern.map((row, r) => (
          <View key={r} style={{ flexDirection: "row", gap }}>
            {row.map((on, c) => (
              <View
                key={c}
                style={{
                  width: cell,
                  height: cell,
                  backgroundColor: on ? color : dimColor,
                }}
              />
            ))}
          </View>
        ))}
      </View>
    );
  },
);

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function ChatScreen() {
  const [chats, setChats] = useState<ChatMeta[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [showCall, setShowCall] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [message, setMessage] = useState("");
  const [selectedImages, setSelectedImages] = useState<
    ImagePicker.ImagePickerAsset[]
  >([]);
  const [voiceRecordingState, setVoiceRecordingState] = useState<
    "idle" | "recording" | "sending"
  >("idle");
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const voiceRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const voiceRecorderState = useAudioRecorderState(voiceRecorder, 90);
  const recordingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  useEffect(() => {
    return () => {
      if (recordingIntervalRef.current) clearInterval(recordingIntervalRef.current);
    };
  }, []);
  const streamIsAiTyping = useChatStreamStore(
    (s) => s.streamingChatId === activeChatId && s.isAiTyping,
  );
  const currentActivity = useChatStreamStore((s) =>
    s.streamingChatId === activeChatId ? s.currentActivity : null,
  );
  const [toolActivity, setToolActivity] = useState<ToolActivity | null>(null);
  const activityErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [selectedMessage, setSelectedMessage] = useState<Message | null>(null);
  const [showActionsModal, setShowActionsModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editMessageText, setEditMessageText] = useState("");
  const [fullscreenUris, setFullscreenUris] = useState<string[]>([]);
  const [fullscreenIndex, setFullscreenIndex] = useState(0);
  const [showFullscreen, setShowFullscreen] = useState(false);
  const [avatarModal, setAvatarModal] = useState<{
    uri: string;
    name: string;
  } | null>(null);
  const [activeNeuroChatId, setActiveNeuroChatId] = useState<string | null>(
    null,
  );
  const [neuroRunning, setNeuroRunning] = useState(false);
  const [neuroMode, setNeuroMode] = useState(false);
  const neuroReaderRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(
    null,
  );
  const neuroStreamAbortRef = useRef<AbortController | null>(null);
  // Last time any byte (real event or heartbeat) arrived on the neuro SSE
  // stream — lets the watchdog below notice a silently-dead connection.
  const lastNeuroEventAtRef = useRef<number>(0);

  // Always reflects "Neuro or Elfie is doing something right now for this chat" —
  // combines the local SSE stream flag with the neuro session's own running state
  // (which resyncNeuroSession keeps accurate even across app close/reopen, since it
  // re-checks the daemon's live sessions on every mount/foreground transition).
  const isAiTyping =
    streamIsAiTyping || (neuroRunning && activeNeuroChatId === activeChatId);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isCancelledRef = useRef(false);
  const currentAiMsgIdRef = useRef<string | null>(null);

  const keyboardBehavior = useKeyboardBehavior();
  const flatListRef = useRef<FlatList>(null);
  const inputRef = useRef<TextInput>(null);
  const selectedMessageRef = useRef<Message | null>(null);
  const drawerAnim = useRef(new Animated.Value(0)).current;

  const openDrawer = useCallback(() => {
    setDrawerOpen(true);
    Animated.timing(drawerAnim, {
      toValue: 1,
      duration: 240,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [drawerAnim]);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    Animated.timing(drawerAnim, {
      toValue: 0,
      duration: 200,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [drawerAnim]);

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

  const switchToChat = useCallback(
    async (chatId: string) => {
      if (activeChatId && activeChatId !== chatId) {
        fetch(`${API_BASE}/api/chats/${activeChatId}/summarize`, {
          method: "POST",
        }).catch(() => {});
      }
      setActiveChatId(chatId);
      setMessages([]);
      setIsLoading(true);
      closeDrawer();
      try {
        const res = await fetch(`${API_BASE}/api/chats/${chatId}`);
        const data = await res.json();
        setMessages(toFrontendMessages([...data.messages].reverse()));
      } catch {}
      setIsLoading(false);
    },
    [closeDrawer, activeChatId],
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
      closeDrawer();
    }
  }, [createChat, closeDrawer, activeChatId]);

  const handleDeleteChat = useCallback(
    async (id: string) => {
      // Update state immediately (optimistic) so the UI responds instantly
      let remaining: ChatMeta[] = [];
      setChats((prev) => {
        remaining = prev.filter((c) => c._id !== id);
        return remaining;
      });
      fetch(`${API_BASE}/api/chats/${id}`, { method: "DELETE" }).catch(() => {});
      if (activeChatId === id) {
        if (remaining.length > 0) {
          setActiveChatId(remaining[0]._id);
          setMessages([]);
          setIsLoading(true);
          try {
            const res = await fetch(
              `${API_BASE}/api/chats/${remaining[0]._id}`,
            );
            const data = await res.json();
            setMessages(toFrontendMessages([...data.messages].reverse()));
          } catch {}
          setIsLoading(false);
        } else {
          const chat = await createChat();
          if (chat) {
            setActiveChatId(chat._id);
            setMessages([]);
          }
        }
      }
    },
    [activeChatId, createChat],
  );

  const { aiName, aiPhoto, userPhoto, loadSettings, activeCharacterId } =
    useSettingsStore();

  const openAvatarModal = useCallback(
    (kind: "ai" | "user") => {
      const filename = kind === "ai" ? aiPhoto : userPhoto;
      if (!filename) return;
      setAvatarModal({
        uri: `${API_BASE}/files/${filename}`,
        name: kind === "ai" ? aiName : "Você",
      });
    },
    [aiPhoto, userPhoto, aiName],
  );

  const showToolActivity = useCallback((toolName: string, detail?: string) => {
    if (activityErrorTimerRef.current) {
      clearTimeout(activityErrorTimerRef.current);
      activityErrorTimerRef.current = null;
    }
    setToolActivity({
      key: newId(),
      kind: "tool",
      toolName,
      label: TOOL_ACTIVITY_LABELS[toolName] ?? formatToolLabel(toolName),
      detail,
    });
  }, []);

  const showToolError = useCallback((toolName: string, message: string) => {
    if (activityErrorTimerRef.current) {
      clearTimeout(activityErrorTimerRef.current);
    }
    const key = newId();
    setToolActivity({
      key,
      kind: "error",
      toolName,
      label: TOOL_ERROR_LABELS[toolName] ?? "algo deu errado",
      detail: message,
    });
    activityErrorTimerRef.current = setTimeout(() => {
      setToolActivity((cur) => (cur?.key === key ? null : cur));
      activityErrorTimerRef.current = null;
    }, 3200);
  }, []);

  const clearToolActivity = useCallback(() => {
    setToolActivity((cur) => (cur?.kind === "error" ? cur : null));
  }, []);

  const forceClearToolActivity = useCallback(() => {
    if (activityErrorTimerRef.current) {
      clearTimeout(activityErrorTimerRef.current);
      activityErrorTimerRef.current = null;
    }
    setToolActivity(null);
  }, []);

  const lastChatKey = useCallback(
    (charId: string | null) => `elfie_last_chat_${charId ?? "default"}`,
    [],
  );

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

  // When the WS signals stream_done (backend finished while app was closed/away),
  // fetch the latest messages and clear the pending refresh flag.
  const pendingRefreshChatId = useChatStreamStore(
    (s) => s.pendingRefreshChatId,
  );
  useEffect(() => {
    if (!pendingRefreshChatId || pendingRefreshChatId !== activeChatId) return;
    useChatStreamStore.getState().clearPendingRefresh();
    fetch(`${API_BASE}/api/chats/${activeChatId}`)
      .then((r) => r.json())
      .then((data) =>
        setMessages(toFrontendMessages([...data.messages].reverse())),
      )
      .catch(() => {});
  }, [pendingRefreshChatId, activeChatId]); // eslint-disable-line react-hooks/exhaustive-deps

  // When user navigates back to a chat that was streaming locally,
  // fetch final messages once the local stream ends.
  useEffect(() => {
    if (!activeChatId) return;
    const store = useChatStreamStore.getState();
    if (!store.locallyStreaming || store.streamingChatId !== activeChatId)
      return;
    const unsub = useChatStreamStore.subscribe((state, prev) => {
      if (
        prev.locallyStreaming &&
        !state.locallyStreaming &&
        prev.streamingChatId === activeChatId
      ) {
        fetch(`${API_BASE}/api/chats/${activeChatId}`)
          .then((r) => r.json())
          .then((data) =>
            setMessages(toFrontendMessages([...data.messages].reverse())),
          )
          .catch(() => {});
        unsub();
      }
    });
    return () => unsub();
  }, [activeChatId]); // eslint-disable-line react-hooks/exhaustive-deps

  const initChats = useCallback(
    async (charId: string | null) => {
      setIsLoading(true);
      const existing = await loadChats();
      if (existing.length > 0) {
        const savedId = await SecureStore.getItemAsync(lastChatKey(charId));
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

  const handlePickImages = useCallback(async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      quality: 0.7,
      base64: true,
    });
    if (!result.canceled) {
      setSelectedImages((prev) => [...prev, ...result.assets]);
    }
  }, []);

  const handleRemoveImage = useCallback((index: number) => {
    setSelectedImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const openFullscreen = useCallback((filenames: string[], index: number) => {
    setFullscreenUris(filenames.map((f) => `${API_BASE}/files/${f}`));
    setFullscreenIndex(index);
    setShowFullscreen(true);
  }, []);

  const openGifFullscreen = useCallback((uri: string) => {
    setFullscreenUris([uri]);
    setFullscreenIndex(0);
    setShowFullscreen(true);
  }, []);

  const subscribeToNeuroSession = useCallback(async (chatId: string, initiallyBusy = true) => {
    // Cancel any existing subscription — abort() (not just reader.cancel(), which
    // doesn't reliably tear down the underlying HTTP connection on RN/Hermes) so the
    // old server-side SSE connection actually closes instead of leaking. Left alone,
    // every follow-up neuro turn opened a new stream on top of the still-open old
    // one, and after enough turns the app ran out of concurrent connections to the
    // host and simply stopped receiving neuro's messages.
    if (neuroStreamAbortRef.current) {
      try {
        neuroStreamAbortRef.current.abort();
      } catch {}
      neuroStreamAbortRef.current = null;
    }
    neuroReaderRef.current = null;
    lastNeuroEventAtRef.current = Date.now();

    setActiveNeuroChatId(chatId);
    setNeuroRunning(initiallyBusy);

    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let lastMsgId: string | null = null;
    const ac = new AbortController();
    neuroStreamAbortRef.current = ac;

    try {
      const response = await fetch(
        `${API_BASE}/api/neuro/session/${chatId}/stream`,
        { signal: ac.signal },
      );
      reader = response.body?.getReader() ?? null;
      if (!reader) return;
      neuroReaderRef.current = reader;

      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        lastNeuroEventAtRef.current = Date.now();
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const ev: NeuroEvent = JSON.parse(line.slice(6));

            if (ev.type === "neuro_text" && ev.text) {
              const id = newId();
              lastMsgId = id;
              setMessages((prev) => [
                {
                  id,
                  content: ev.text!,
                  sender: "ai" as const,
                  createdAt: new Date().toISOString(),
                  fromNeuro: true,
                },
                ...prev,
              ]);
            }

            if (ev.type === "neuro_question" && ev.text) {
              const id = newId();
              lastMsgId = id;
              setMessages((prev) => [
                {
                  id,
                  content: ev.text!,
                  sender: "ai" as const,
                  createdAt: new Date().toISOString(),
                  fromNeuro: true,
                },
                ...prev,
              ]);
            }

            if (ev.type === "neuro_done") {
              setNeuroRunning(false);
              useChatStreamStore.getState().endStream();
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
              } else if (ev.text) {
                setMessages((prev) => [
                  {
                    id: newId(),
                    content: ev.text!,
                    sender: "ai" as const,
                    createdAt: new Date().toISOString(),
                  },
                  ...prev,
                ]);
              }
            }

            if (ev.type === "neuro_waiting") {
              setNeuroRunning(false);
              useChatStreamStore.getState().endStream();
              lastMsgId = null;
            }

            if (ev.type === "neuro_interrupted") {
              setNeuroRunning(false);
              useChatStreamStore.getState().endStream();
              lastMsgId = null;
            }

            if (ev.type === "neuro_session_ended") {
              setActiveNeuroChatId(null);
              setNeuroRunning(false);
              useChatStreamStore.getState().endStream();
              if (neuroReaderRef.current === reader) {
                neuroReaderRef.current = null;
                if (neuroStreamAbortRef.current === ac) neuroStreamAbortRef.current = null;
              }
              return;
            }
          } catch {}
        }
      }
    } catch (err) {
      console.error("[neuro] session stream error:", err);
    }

    // Cleanup if this subscription is still current
    if (neuroReaderRef.current === reader) {
      neuroReaderRef.current = null;
      if (neuroStreamAbortRef.current === ac) neuroStreamAbortRef.current = null;
      setActiveNeuroChatId((prev) => (prev === chatId ? null : prev));
      setNeuroRunning(false);
      useChatStreamStore.getState().endStream();
    }
  }, []);

  // Reconnecting the app (cold start or coming back to foreground) drops the
  // neuro SSE stream silently — the reader dies with the old JS context and
  // nothing tells the new one a session is still running on the daemon. So on
  // every mount / foreground transition we ask the API which chats currently
  // have a live session and reattach the stream for the one we're viewing.
  const activeChatIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeChatIdRef.current = activeChatId;
  }, [activeChatId]);

  const resyncNeuroSession = useCallback(async () => {
    const chatId = activeChatIdRef.current;
    if (!chatId) return;
    try {
      const res = await fetch(`${API_BASE}/api/neuro/active`);
      const running: { chatId: string; status?: string }[] = await res.json();
      const match = running.find((s) => s.chatId === chatId);
      if (match) {
        // Reattach the stream whenever the session is alive (running OR waiting
        // between turns) so it keeps receiving events either way — but only flip
        // the "digitando" indicator on if Claude Code is actually generating right
        // now, so reopening the app doesn't falsely show it as busy while idle.
        subscribeToNeuroSession(chatId, match.status === "running");
      } else {
        // No live session for the chat we're viewing — drop any stale
        // subscription so the indicator doesn't lie about neuro running.
        if (neuroStreamAbortRef.current) {
          try {
            neuroStreamAbortRef.current.abort();
          } catch {}
          neuroStreamAbortRef.current = null;
        }
        neuroReaderRef.current = null;
        setActiveNeuroChatId((prev) => (prev === chatId ? null : prev));
        setNeuroRunning(false);
        useChatStreamStore.getState().endStream();
      }
    } catch {}
  }, [subscribeToNeuroSession]);

  useEffect(() => {
    resyncNeuroSession();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") resyncNeuroSession();
    });
    return () => sub.remove();
  }, [activeChatId, resyncNeuroSession]);

  // The persistent neuro SSE stream is meant to survive across an entire
  // multi-turn session so follow-up messages don't have to reopen it (see
  // subscribeToNeuroSession above). But if that single connection dies
  // silently mid-app-session — carrier/NAT/proxy reaping an idle socket
  // between turns — reader.read() just hangs forever with no error, so the
  // app never notices: no more real-time events, the "neuro rodando"
  // indicator goes stale, and a follow-up message sent over it vanishes until
  // the user backgrounds and reopens the app (the only other trigger for
  // resyncNeuroSession). Poll for that staleness — using the heartbeat the
  // backend now writes every 15s — and reattach the same way foreground does.
  useEffect(() => {
    const NEURO_STREAM_STALE_MS = 40_000;
    const id = setInterval(() => {
      if (!neuroReaderRef.current) return;
      if (Date.now() - lastNeuroEventAtRef.current > NEURO_STREAM_STALE_MS) {
        resyncNeuroSession();
      }
    }, 10_000);
    return () => clearInterval(id);
  }, [resyncNeuroSession]);

  const handleNeuroConfirm = useCallback(
    async (taskId: string, chatId: string, confirmed: boolean) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.neuroTaskId === taskId && m.neuroType === "confirm"
            ? { ...m, neuroConfirmed: true }
            : m,
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

      subscribeToNeuroSession(chatId);
    },
    [subscribeToNeuroSession],
  );

  const handleNeuroAnswer = useCallback(
    async (chatId: string, answer: string) => {
      if (!answer.trim()) return;

      setMessages((prev) => [
        {
          id: newId(),
          content: answer,
          sender: "user",
          createdAt: new Date().toISOString(),
        },
        ...prev,
      ]);

      setMessages((prev) =>
        prev.map((m) =>
          m.neuroChatId === chatId &&
          m.neuroType === "question" &&
          !m.neuroConfirmed
            ? { ...m, neuroConfirmed: true }
            : m,
        ),
      );

      try {
        await fetch(`${API_BASE}/api/neuro/session/${chatId}/answer`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answer }),
        });
      } catch (err) {
        console.error("[neuro] answer error:", err);
      }
    },
    [],
  );

  const handleSendToNeuro = useCallback(
    async (msg: string) => {
      if (!activeNeuroChatId || !msg.trim()) return;
      try {
        await fetch(`${API_BASE}/api/neuro/session/${activeNeuroChatId}/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: msg }),
        });
      } catch (err) {
        console.error("[neuro] send error:", err);
      }
    },
    [activeNeuroChatId],
  );

  const handleNeuroInterrupt = useCallback(async () => {
    if (!activeNeuroChatId) return;
    try {
      await fetch(
        `${API_BASE}/api/neuro/session/${activeNeuroChatId}/interrupt`,
        {
          method: "POST",
        },
      );
    } catch (err) {
      console.error("[neuro] interrupt error:", err);
    }
  }, [activeNeuroChatId]);

  const handleSendMessage = useCallback(async (voiceNote?: { filename: string; transcript: string }) => {
    const text = (voiceNote ? voiceNote.transcript : message).trim();
    if (
      (!text && selectedImages.length === 0 && !voiceNote) ||
      useChatStreamStore.getState().isAiTyping ||
      (neuroRunning && activeNeuroChatId === activeChatId) ||
      !activeChatId
    )
      return;

    const imagesToSend = selectedImages;
    const currentReplyTo = replyingTo;

    const forceNeuro = neuroMode;
    setMessage("");
    setSelectedImages([]);
    setReplyingTo(null);
    forceClearToolActivity();
    useChatStreamStore.getState().startStream(activeChatId);

    SecureStore.setItemAsync(
      lastChatKey(activeCharacterId),
      activeChatId,
    ).catch(() => {});

    // The AI's reply is split into separate message bubbles wherever it writes a
    // blank line (same convention as elfie-web) — currentMsgId tracks whichever
    // bubble is currently being written and is reassigned every time a blank line
    // completes one bubble and starts the next, so every event handler below that
    // attaches to "the AI's message" naturally lands on the right bubble.
    let currentMsgId = newId();
    let currentBubbleAdded = false;
    let anyBubbleAdded = false;
    let currentBubbleRaw = ""; // raw text of the in-progress bubble, for boundary detection
    let currentBubbleSentUpTo = 0; // chars of currentBubbleRaw already shown
    let neuroStarted = false;

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
              mimeType: img.mimeType || "image/jpeg",
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
        imageFilenames: filenames.length > 0 ? filenames : undefined,
        voiceNotes: voiceNote ? [{ filename: voiceNote.filename }] : undefined,
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
            voiceNotes: voiceNote ? [{ filename: voiceNote.filename }] : undefined,
            forceNeuro,
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
            if (event.type === "delta" && event.text) {
              currentBubbleRaw += event.text;
              useChatStreamStore.getState().setIsAiTyping(false);
              useChatStreamStore.getState().setCurrentActivity(null);
              clearToolActivity();

              // Close out and start a new bubble for every blank line found — a burst
              // of text can contain more than one, so loop until none remain.
              for (;;) {
                const boundary = currentBubbleRaw.match(/\n{2,}/);
                if (!boundary || boundary.index === undefined) break;
                const finishedRaw = currentBubbleRaw.slice(0, boundary.index);
                const restRaw = currentBubbleRaw.slice(
                  boundary.index + boundary[0].length,
                );
                const finishedClean = sanitizeAiText(finishedRaw);
                const finishedId = currentMsgId;
                if (finishedClean) {
                  currentBubbleAdded = true;
                  anyBubbleAdded = true;
                  setMessages((prev) => {
                    const existing = prev.find((m) => m.id === finishedId);
                    if (existing)
                      return prev.map((m) =>
                        m.id === finishedId
                          ? { ...m, content: finishedClean }
                          : m,
                      );
                    return [
                      {
                        id: finishedId,
                        content: finishedClean,
                        sender: "ai" as const,
                        createdAt: new Date().toISOString(),
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

              // Stream the still-open bubble live, holding back a few characters in
              // case they're the start of the next blank-line boundary — otherwise a
              // "\n" that's about to become "\n\n" would flash inside the bubble first.
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
                        m.id === msgId
                          ? { ...m, content: m.content + piece }
                          : m,
                      );
                    return [
                      {
                        id: msgId,
                        // Only a bubble's very first chunk needs its leading whitespace
                        // trimmed — later chunks must keep theirs, or words run together.
                        content: piece.replace(/^\s+/, ""),
                        sender: "ai" as const,
                        createdAt: new Date().toISOString(),
                      },
                      ...prev,
                    ];
                  });
                } else {
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === msgId
                        ? { ...m, content: m.content + piece }
                        : m,
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
                      ? {
                          ...m,
                          searchSources: [
                            ...(m.searchSources ?? []),
                            ...event.sources,
                          ],
                        }
                      : m,
                  );
                return [
                  {
                    id: currentMsgId,
                    content: "",
                    sender: "ai" as const,
                    createdAt: new Date().toISOString(),
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
                      ? {
                          ...m,
                          productCards: [
                            ...(m.productCards ?? []),
                            ...event.cards,
                          ],
                        }
                      : m,
                  );
                return [
                  {
                    id: currentMsgId,
                    content: "",
                    sender: "ai" as const,
                    createdAt: new Date().toISOString(),
                    productCards: event.cards,
                  },
                  ...prev,
                ];
              });
            }
            if (
              event.type === "generated_images" &&
              Array.isArray(event.filenames) &&
              event.filenames.length > 0
            ) {
              if (!currentBubbleAdded) {
                currentBubbleAdded = true;
                anyBubbleAdded = true;
                useChatStreamStore.getState().setIsAiTyping(false);
                setMessages((prev) => {
                  if (prev.some((m) => m.id === currentMsgId)) return prev;
                  return [
                    {
                      id: currentMsgId,
                      content: "",
                      sender: "ai" as const,
                      createdAt: new Date().toISOString(),
                      imageFilenames: Array.from(
                        new Set(event.filenames as string[]),
                      ),
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
                            new Set([
                              ...(m.imageFilenames ?? []),
                              ...(event.filenames as string[]),
                            ]),
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
                const gif: Gif = {
                  url: event.url ?? null,
                  mp4: event.mp4 ?? null,
                };
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
                    sender: "ai" as const,
                    createdAt: new Date().toISOString(),
                    gifs: [gif],
                  },
                  ...prev,
                ];
              });
            }
            if (event.type === "voice_note" && event.filename) {
              useChatStreamStore.getState().setIsAiTyping(false);
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
                    sender: "ai" as const,
                    createdAt: new Date().toISOString(),
                    voiceNotes: [vn],
                  },
                  ...prev,
                ];
              });
            }
            if (event.type === "neuro_confirm") {
              useChatStreamStore.getState().setIsAiTyping(false);
              currentBubbleAdded = true;
              anyBubbleAdded = true;
              setMessages((prev) => [
                {
                  id: currentMsgId,
                  content: "",
                  sender: "ai",
                  createdAt: new Date().toISOString(),
                  neuroType: "confirm",
                  neuroTaskId: event.taskId,
                  neuroChatId: event.chatId,
                  neuroText: event.confirmText,
                },
                ...prev,
              ]);
            }
            if (event.type === "neuro_started") {
              neuroStarted = true;
              currentBubbleAdded = true;
              anyBubbleAdded = true;
              subscribeToNeuroSession(event.chatId);
            }
            // Follow-up turn on an already-alive neuro session (see the bypass
            // branch in chats.controller.js) — the persistent session stream
            // opened by the first neuro_started stays subscribed and keeps
            // delivering events, so we just flip the busy flags back on instead
            // of reconnecting.
            if (event.type === "neuro_resumed") {
              neuroStarted = true;
              setNeuroRunning(true);
              setActiveNeuroChatId(event.chatId ?? activeChatId);
            }
            if (event.type === "tool_call" && event.name) {
              const label =
                TOOL_ACTIVITY_LABELS[event.name as string] ?? "processando...";
              const detail = event.detail
                ? ` "${(event.detail as string).slice(0, 60)}"`
                : "";
              useChatStreamStore.getState().setCurrentActivity(label + detail);
              showToolActivity(
                event.name as string,
                event.detail
                  ? (event.detail as string).slice(0, 60)
                  : undefined,
              );
            }
            if (event.type === "tool_error") {
              showToolError(
                event.tool ?? "erro",
                event.message ?? "algo deu errado",
              );
            }
            if (event.type === "done") {
              useChatStreamStore.getState().setCurrentActivity(null);
              forceClearToolActivity();
              if (event.chatTitle) {
                setChats((prev) =>
                  prev.map((c) =>
                    c._id === activeChatId
                      ? { ...c, title: event.chatTitle }
                      : c,
                  ),
                );
              }
              // Earlier bubbles were already finalized live as blank lines completed
              // them — this just finalizes whichever bubble is still open (sanitized,
              // trimmed) and attaches the turn's metadata to it.
              const finalClean = sanitizeAiText(currentBubbleRaw);
              const doneId = currentMsgId;
              const doneMeta = {
                savedMemory: event.savedMemory ? true : false,
                toolsUsed:
                  Array.isArray(event.toolsUsed) && event.toolsUsed.length > 0
                    ? event.toolsUsed
                    : [],
              };
              setMessages((prev) => {
                const existing = prev.find((m) => m.id === doneId);
                if (existing)
                  return prev.map((m) =>
                    m.id === doneId
                      ? {
                          ...m,
                          ...(finalClean ? { content: finalClean } : {}),
                          savedMemory: doneMeta.savedMemory || m.savedMemory,
                          toolsUsed:
                            doneMeta.toolsUsed.length > 0
                              ? doneMeta.toolsUsed
                              : m.toolsUsed,
                        }
                      : m,
                  );
                if (!finalClean) return prev;
                return [
                  {
                    id: doneId,
                    content: finalClean,
                    sender: "ai" as const,
                    createdAt: new Date().toISOString(),
                    savedMemory: doneMeta.savedMemory || undefined,
                    toolsUsed:
                      doneMeta.toolsUsed.length > 0
                        ? doneMeta.toolsUsed
                        : undefined,
                  },
                  ...prev,
                ];
              });
              currentAiMsgIdRef.current = null;
            }
          } catch {}
        }
      }
      useChatStreamStore.getState().setIsAiTyping(false);
      if (!neuroStarted) {
        useChatStreamStore.getState().endStream();
      }
      // If neuroStarted, subscribeToNeuroSession calls endStream() when done
    } catch (err) {
      if (
        isCancelledRef.current ||
        (err instanceof Error && err.name === "AbortError")
      ) {
        useChatStreamStore.getState().endStream();
        currentAiMsgIdRef.current = null;
        return;
      }
      console.error("API error:", err);
      useDebugStore
        .getState()
        .error(
          `sendMessage: ${err instanceof Error ? err.message : String(err)}`,
        );
      useChatStreamStore.getState().endStream();
      if (!anyBubbleAdded) {
        setMessages((prev) => [
          {
            id: currentMsgId,
            content: "Erro ao conectar. Tente novamente.",
            sender: "ai",
            createdAt: new Date().toISOString(),
          },
          ...prev,
        ]);
      }
    }
  }, [
    message,
    selectedImages,
    replyingTo,
    activeChatId,
    neuroMode,
    neuroRunning,
    activeNeuroChatId,
    subscribeToNeuroSession,
    forceClearToolActivity,
  ]);

  const startVoiceRecording = useCallback(async () => {
    if (voiceRecordingState !== "idle" || isAiTyping || !activeChatId) return;
    try {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) return;
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await voiceRecorder.prepareToRecordAsync({ isMeteringEnabled: true });
      voiceRecorder.record();
      setRecordingSeconds(0);
      recordingIntervalRef.current = setInterval(() => {
        setRecordingSeconds((s) => s + 1);
      }, 1000);
      setVoiceRecordingState("recording");
    } catch (err) {
      console.error("[voice note] start recording failed:", err);
    }
  }, [voiceRecorder, voiceRecordingState, isAiTyping, activeChatId]);

  const cancelVoiceRecording = useCallback(async () => {
    if (recordingIntervalRef.current) clearInterval(recordingIntervalRef.current);
    recordingIntervalRef.current = null;
    try {
      await voiceRecorder.stop();
    } catch (err) {
      console.error("[voice note] cancel recording failed:", err);
    }
    setVoiceRecordingState("idle");
    setRecordingSeconds(0);
  }, [voiceRecorder]);

  const stopAndSendVoiceRecording = useCallback(async () => {
    if (recordingIntervalRef.current) clearInterval(recordingIntervalRef.current);
    recordingIntervalRef.current = null;
    setVoiceRecordingState("sending");
    try {
      await voiceRecorder.stop();
      const uri = voiceRecorder.uri;
      if (!uri) {
        setVoiceRecordingState("idle");
        return;
      }
      // expo's fetch (SDK 56+) only accepts real Blob/File FormData parts — the old RN
      // { uri, name, type } object throws "Unsupported FormDataPart implementation"
      // before the request is even sent, so wrap the recorder's uri in an FSFile instead.
      const audioFile = new FSFile(uri);

      const uploadForm = new FormData();
      uploadForm.append("audio", audioFile as any);
      const uploadRes = await fetch(`${API_BASE}/api/upload/voice`, {
        method: "POST",
        body: uploadForm as any,
      });
      const uploadData = await uploadRes.json();
      const filename = uploadData.filename;
      if (!filename) throw new Error("voice upload returned no filename");

      let sttProvider = "elevenlabs";
      try {
        const settingsRes = await fetch(`${API_BASE}/api/settings`);
        const settingsData = await settingsRes.json();
        if (settingsData.sttProvider === "fishaudio") sttProvider = "fishaudio";
      } catch {}

      const transcribeForm = new FormData();
      transcribeForm.append("audio", audioFile as any);
      transcribeForm.append("provider", sttProvider);
      const transcribeRes = await fetch(`${API_BASE}/api/transcribe`, {
        method: "POST",
        body: transcribeForm as any,
      });
      const transcribeData = await transcribeRes.json();
      const transcript: string = transcribeData.transcript?.trim() ?? "";

      await handleSendMessage({ filename, transcript });
    } catch (err) {
      console.error("[voice note] send failed:", err);
    } finally {
      setVoiceRecordingState("idle");
      setRecordingSeconds(0);
    }
  }, [voiceRecorder, handleSendMessage]);

  const handleCancelResponse = useCallback(() => {
    isCancelledRef.current = true;
    abortControllerRef.current?.abort();
    useChatStreamStore.getState().endStream();
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
      },
      ...prev,
    ]);
    if (activeChatId) {
      fetch(`${API_BASE}/api/chats/${activeChatId}/cancel`, {
        method: "POST",
      }).catch(() => {});
    }
  }, [activeChatId, forceClearToolActivity]);

  const handleLongPress = useCallback((msg: Message) => {
    selectedMessageRef.current = msg;
    setSelectedMessage(msg);
    setShowActionsModal(true);
  }, []);

  const handleReply = useCallback(() => {
    if (selectedMessageRef.current) {
      setReplyingTo(selectedMessageRef.current);
      setShowActionsModal(false);
      inputRef.current?.focus();
    }
  }, []);

  const handleEdit = useCallback(() => {
    if (selectedMessageRef.current) {
      setEditMessageText(selectedMessageRef.current.content);
      setShowActionsModal(false);
      setShowEditModal(true);
    }
  }, []);

  const handleDelete = useCallback(() => {
    setShowActionsModal(false);
    setShowDeleteModal(true);
  }, []);

  const confirmDelete = useCallback(() => {
    if (selectedMessageRef.current) {
      setMessages((prev) =>
        prev.filter((m) => m.id !== selectedMessageRef.current!.id),
      );
      setShowDeleteModal(false);
      selectedMessageRef.current = null;
      setSelectedMessage(null);
    }
  }, []);

  const confirmEdit = useCallback(() => {
    if (selectedMessageRef.current && editMessageText.trim()) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === selectedMessageRef.current!.id
            ? { ...m, content: editMessageText, isEdited: true }
            : m,
        ),
      );
      setShowEditModal(false);
      selectedMessageRef.current = null;
      setSelectedMessage(null);
      setEditMessageText("");
    }
  }, [editMessageText]);

  const renderMessage = useCallback(
    ({ item }: { item: Message }) => {
      if (item.isCancelled) {
        return (
          <ReAnimated.View
            entering={FadeIn.springify().damping(34).stiffness(500)}
            layout={LinearTransition.springify().damping(36).stiffness(420)}
            style={{ alignItems: "center", marginVertical: 6 }}
          >
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 5,
                paddingHorizontal: 10,
                paddingVertical: 4,
                borderRadius: 20,
                backgroundColor: "#1a1a24",
              }}
            >
              <MaterialCommunityIcons
                name="stop-circle-outline"
                size={9}
                color="#6b7280"
              />
              <Text
                style={{ fontSize: 10, color: "#6b7280", fontWeight: "600" }}
              >
                resposta cancelada
              </Text>
            </View>
          </ReAnimated.View>
        );
      }
      if (item.neuroType === "confirm") {
        return (
          <NeuroMessage
            item={item}
            onConfirm={handleNeuroConfirm}
            onAnswer={handleNeuroAnswer}
            onAvatarPress={openAvatarModal}
          />
        );
      }
      return (
        <MessageItem
          item={item}
          onLongPress={handleLongPress}
          onImagePress={openFullscreen}
          onGifPress={openGifFullscreen}
          onAvatarPress={openAvatarModal}
        />
      );
    },
    [
      handleLongPress,
      openFullscreen,
      openGifFullscreen,
      handleNeuroConfirm,
      handleNeuroAnswer,
      openAvatarModal,
    ],
  );

  const aiPhotoUri = aiPhoto ? `${API_BASE}/files/${aiPhoto}` : null;
  const activeChat = chats.find((c) => c._id === activeChatId);
  const canSend =
    (message.trim().length > 0 || selectedImages.length > 0) && !isAiTyping;

  return (
    <GestureHandlerRootView
      className="flex-1 bg-background"
      style={Platform.OS === "web" ? { flexDirection: "row" } : undefined}
    >
      <SettingsScreen
        visible={showSettings}
        onClose={async () => {
          setShowSettings(false);
          await loadSettings();
          const { activeCharacterId: charId } = useSettingsStore.getState();
          await initChats(charId);
        }}
      />
      <SafeAreaView className="flex-1 bg-background">
        {neuroRunning && (
          <ReAnimated.View
            entering={FadeIn.duration(200)}
            exiting={FadeOut.duration(200)}
            pointerEvents="none"
            style={{
              position: "absolute",
              top: 66,
              right: 14,
              zIndex: 999,
              flexDirection: "row",
              alignItems: "center",
              backgroundColor: "#1e1e2e",
              borderRadius: 999,
              paddingHorizontal: 10,
              paddingVertical: 5,
              gap: 6,
              borderWidth: 1,
              borderColor: "#2a2a3a",
            }}
          >
            <PulseDot color="#996dff" />
            <MaterialCommunityIcons
              name="lightning-bolt"
              size={11}
              color="#996dff"
            />
            <Text style={{ fontSize: 10, color: "#c9b8ff", fontWeight: "700" }}>
              NEURO ATIVA
            </Text>
          </ReAnimated.View>
        )}
        <DeleteMessageModal
          visible={showDeleteModal}
          onRequestClose={() => setShowDeleteModal(false)}
          onConfirm={confirmDelete}
          onCancel={() => setShowDeleteModal(false)}
        />
        <EditMessageModal
          visible={showEditModal}
          onRequestClose={() => setShowEditModal(false)}
          onConfirm={confirmEdit}
          onCancel={() => {
            setShowEditModal(false);
            setEditMessageText("");
          }}
          value={editMessageText}
          onChangeText={setEditMessageText}
        />
        <MessageActionsModal
          visible={showActionsModal}
          isOwn={selectedMessage?.sender === "user"}
          onClose={() => setShowActionsModal(false)}
          onReply={handleReply}
          onEdit={handleEdit}
          onDelete={handleDelete}
        />
        <ImageFullscreenModal
          visible={showFullscreen}
          uris={fullscreenUris}
          initialIndex={fullscreenIndex}
          onClose={() => setShowFullscreen(false)}
        />
        <AvatarPhotoModal
          avatar={avatarModal}
          onClose={() => setAvatarModal(null)}
        />
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={keyboardBehavior}>
          <ReAnimated.View
            entering={FadeInDown.duration(240)}
            className="flex-row items-center px-4 py-3 border-b border-border bg-background"
          >
            <AnimatedPressable
              onPress={() => openAvatarModal("ai")}
              scaleTo={PRESS_SCALE_SMALL}
              className="w-9 h-9 rounded-full overflow-hidden bg-foreground mr-2.5"
            >
              <Image
                source={
                  aiPhotoUri
                    ? { uri: aiPhotoUri }
                    : require("../assets/icon.png")
                }
                style={{ height: 36, width: 36 }}
                contentFit="cover"
              />
            </AnimatedPressable>
            <View className="flex-1">
              <Text className="text-white font-bold text-[15px]">{aiName}</Text>
              <Text className="text-gray-300 text-[11px]" numberOfLines={1}>
                {activeChat?.title ?? "Nova conversa"}
              </Text>
            </View>
            {activeChatId && (
              <AnimatedPressable
                onPress={() => setShowCall(true)}
                scaleTo={PRESS_SCALE_SMALL}
                className="mr-2 w-9 h-9 items-center justify-center rounded-full"
              >
                <MaterialCommunityIcons name="phone" size={17} color="#ffffff" />
              </AnimatedPressable>
            )}
            <AnimatedPressable
              onPress={openDrawer}
              scaleTo={PRESS_SCALE_SMALL}
              className="ml-1 p-1 px-4 rounded-xl"
            >
              <MaterialCommunityIcons name="menu" size={22} color="#ffffff" />
            </AnimatedPressable>
          </ReAnimated.View>

          {showCall && activeChatId && (
            <CallOverlay
              chatId={activeChatId}
              characterName={aiName}
              characterAvatar={aiPhotoUri}
              onClose={() => setShowCall(false)}
            />
          )}

          {isLoading ? (
            <View className="flex-1">
              <ChatSkeleton />
            </View>
          ) : (
            <FlatList
              ref={flatListRef}
              data={messages}
              renderItem={renderMessage}
              keyExtractor={(item) => item.id}
              className="flex-1 px-4"
              contentContainerStyle={{ paddingBottom: 10, paddingTop: 10 }}
              showsVerticalScrollIndicator={false}
              inverted
              maxToRenderPerBatch={10}
              windowSize={10}
              initialNumToRender={15}
              ListHeaderComponent={isAiTyping ? <TypingIndicator /> : null}
            />
          )}

          {(toolActivity ||
            (currentActivity && !toolActivity && isAiTyping)) && (
            <ReAnimated.View
              entering={FadeIn.duration(160)}
              exiting={FadeOut.duration(160)}
              style={{ paddingHorizontal: 16, paddingVertical: 6 }}
            >
              <ToolActivityPill
                activity={
                  toolActivity ?? {
                    key: "ws-activity",
                    kind: "tool",
                    label: currentActivity as string,
                  }
                }
              />
            </ReAnimated.View>
          )}

          <ReplyPreview
            replyingTo={replyingTo}
            onCancel={() => setReplyingTo(null)}
          />
          <ImagePreviewStrip
            images={selectedImages}
            onRemove={handleRemoveImage}
          />

          <View className="border-t border-border bg-background px-4 pb-4 pt-2">
            <View
              className="flex-col bg-foreground rounded-2xl px-4"
              style={{
                borderWidth: 1,
                borderColor: "#1e1e2e",
                paddingTop: voiceRecordingState !== "idle" ? 10 : 12,
                paddingBottom: voiceRecordingState !== "idle" ? 10 : 12,
              }}
            >
              {voiceRecordingState !== "idle" ? (
                <ReAnimated.View
                  key="waveform"
                  entering={FadeIn.duration(140)}
                  exiting={FadeOut.duration(120)}
                  style={{
                    height: 32,
                    flexDirection: "row",
                    alignItems: "center",
                  }}
                >
                  <PulseDot color="#ef4444" />
                  <Text
                    className="text-white text-xs font-bold"
                    style={{ marginLeft: 8 }}
                  >
                    {voiceRecordingState === "sending"
                      ? "Enviando…"
                      : `${Math.floor(recordingSeconds / 60)}:${String(recordingSeconds % 60).padStart(2, "0")}`}
                  </Text>
                  <VoiceWaveform metering={voiceRecorderState.metering} />
                </ReAnimated.View>
              ) : (
                <ReAnimated.View
                  key="textinput"
                  entering={FadeIn.duration(140)}
                  exiting={FadeOut.duration(100)}
                >
                  <TextInput
                    ref={inputRef}
                    style={{ minHeight: 56, maxHeight: 140 }}
                    className="text-white w-full"
                    value={message}
                    onChangeText={setMessage}
                    placeholder="Mensagem..."
                    placeholderTextColor="#9ca3af"
                    multiline
                    maxLength={2000}
                    blurOnSubmit={false}
                    onSubmitEditing={() => {
                      if (Platform.OS === "ios" && canSend) handleSendMessage();
                    }}
                  />
                </ReAnimated.View>
              )}
              <View className="flex-row items-center mt-2" style={{ gap: 4 }}>
                {voiceRecordingState !== "idle" ? (
                  <ReAnimated.View
                    key="recording-controls"
                    entering={FadeIn.duration(140)}
                    exiting={FadeOut.duration(120)}
                    className="flex-row items-center flex-1"
                    style={{ gap: 4 }}
                  >
                    {/* Spacer */}
                    <View style={{ flex: 1 }} />

                    <AnimatedPressable
                      onPress={cancelVoiceRecording}
                      disabled={voiceRecordingState === "sending"}
                      scaleTo={PRESS_SCALE_SMALL}
                      className="w-9 h-9 items-center justify-center rounded-full"
                    >
                      <MaterialCommunityIcons
                        name="trash-can-outline"
                        size={16}
                        color="#6b7280"
                      />
                    </AnimatedPressable>
                    <AnimatedPressable
                      onPress={stopAndSendVoiceRecording}
                      disabled={voiceRecordingState === "sending"}
                      scaleTo={PRESS_SCALE_SMALL}
                      style={{
                        height: 32,
                        width: 32,
                        borderRadius: 16,
                        backgroundColor: "#996dff",
                        opacity: voiceRecordingState === "sending" ? 0.5 : 1,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <MaterialCommunityIcons
                        name="check"
                        size={16}
                        color="#fff"
                      />
                    </AnimatedPressable>
                  </ReAnimated.View>
                ) : (
                  <ReAnimated.View
                    key="idle-controls"
                    entering={FadeIn.duration(140)}
                    exiting={FadeOut.duration(120)}
                    className="flex-row items-center flex-1"
                    style={{ gap: 4 }}
                  >
                    {/* Utility tools */}
                    <AnimatedPressable
                      onPress={handlePickImages}
                      scaleTo={PRESS_SCALE_SMALL}
                      className="w-9 h-9 items-center justify-center rounded-full"
                    >
                      <MaterialCommunityIcons
                        name="plus"
                        size={16}
                        color="#6b7280"
                      />
                    </AnimatedPressable>
                    <AnimatedPressable
                      onPress={() => setNeuroMode((v) => !v)}
                      scaleTo={PRESS_SCALE_SMALL}
                      className="w-9 h-9 items-center justify-center rounded-full"
                    >
                      <Text
                        style={{
                          fontSize: 15,
                          lineHeight: 18,
                          opacity: neuroMode ? 1 : 0.35,
                        }}
                      >
                        <MaterialCommunityIcons
                          name="lightning-bolt"
                          color={"#fff"}
                          size={20}
                        />
                      </Text>
                    </AnimatedPressable>

                    {/* Spacer */}
                    <View style={{ flex: 1 }} />

                    <AnimatedPressable
                      onPress={startVoiceRecording}
                      scaleTo={PRESS_SCALE_SMALL}
                      className="w-9 h-9 items-center justify-center rounded-full"
                    >
                      <MaterialCommunityIcons
                        name="microphone"
                        size={16}
                        color="#6b7280"
                      />
                    </AnimatedPressable>

                    {/* Divider */}
                    <View
                      style={{
                        width: 1,
                        height: 16,
                        backgroundColor: "#2a2a3a",
                        marginHorizontal: 6,
                      }}
                    />

                    {/* Send / Cancel — only swaps to Cancel for a locally-owned stream;
                        handleCancelResponse has no daemon-side effect, so a neuro session
                        merely resynced from the background (no local fetch to abort) keeps
                        showing Send, disabled via canSend below. */}
                    {streamIsAiTyping ? (
                      <AnimatedPressable
                        key="cancel"
                        onPress={handleCancelResponse}
                        style={{
                          height: 32,
                          paddingHorizontal: 14,
                          borderRadius: 16,
                          backgroundColor: "#2a1a1a",
                          alignItems: "center",
                          justifyContent: "center",
                          flexDirection: "row",
                          gap: 6,
                        }}
                      >
                        <MaterialCommunityIcons
                          name="stop"
                          size={13}
                          color="#ef4444"
                        />
                      </AnimatedPressable>
                    ) : (
                      <AnimatedPressable
                        key="send"
                        onPress={() => handleSendMessage()}
                        disabled={!canSend}
                        style={{
                          height: 32,
                          paddingHorizontal: 14,
                          borderRadius: 16,
                          backgroundColor: canSend ? "#996dff" : "#16161f",
                          opacity: canSend ? 1 : 0.4,
                          alignItems: "center",
                          justifyContent: "center",
                          flexDirection: "row",
                          gap: 6,
                        }}
                      >
                        <FontAwesome5 name="paper-plane" size={13} color="#fff" />
                      </AnimatedPressable>
                    )}
                  </ReAnimated.View>
                )}
              </View>
            </View>
          </View>
        </KeyboardAvoidingView>

        <ChatsDrawer
          anim={drawerAnim}
          isOpen={drawerOpen}
          chats={chats}
          activeChatId={activeChatId}
          onSelectChat={switchToChat}
          onNewChat={handleNewChat}
          onDeleteChat={handleDeleteChat}
          onClose={closeDrawer}
          onOpenSettings={() => {
            closeDrawer();
            setShowSettings(true);
          }}
        />
      </SafeAreaView>
    </GestureHandlerRootView>
  );
}
