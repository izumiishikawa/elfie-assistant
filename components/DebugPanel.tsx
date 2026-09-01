import { MaterialCommunityIcons } from "@expo/vector-icons";
import { Modal, Platform, ScrollView, Text, View } from "react-native";
import Animated, { FadeIn, LinearTransition } from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import AnimatedPressable from "./AnimatedPressable";
import { API_BASE, isEmulator } from "../constants";
import { useDebugStore } from "../stores/debugStore";
import { PRESS_SCALE_SMALL } from "../utils/motion";

export default function DebugPanel({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { logs, clear } = useDebugStore();
  const errorCount = logs.filter((l) => l.level === "error").length;

  return (
    <Modal visible={visible} animationType="slide" statusBarTranslucent onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: "#0a0a0f" }}>
        {/* Header */}
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between",
          padding: 16, borderBottomWidth: 1, borderBottomColor: "#1e1e2e" }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ color: "#fff", fontWeight: "700", fontSize: 15 }}>Debug</Text>
            {errorCount > 0 && (
              <View style={{ backgroundColor: "#ff382b", borderRadius: 10, paddingHorizontal: 7, paddingVertical: 2 }}>
                <Text style={{ color: "#fff", fontSize: 10, fontWeight: "700" }}>{errorCount}</Text>
              </View>
            )}
          </View>
          <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
            <AnimatedPressable onPress={clear} scaleTo={PRESS_SCALE_SMALL}>
              <Text style={{ color: "#666", fontSize: 12 }}>limpar</Text>
            </AnimatedPressable>
            <AnimatedPressable onPress={onClose} scaleTo={PRESS_SCALE_SMALL}>
              <MaterialCommunityIcons name="close" size={20} color="#8e8e93" />
            </AnimatedPressable>
          </View>
        </View>

        {/* API info */}
        <View style={{ padding: 12, backgroundColor: "#111118", margin: 12, marginBottom: 0, borderRadius: 12,
          borderWidth: 1, borderColor: "#1e1e2e", gap: 8 }}>
          <View>
            <Text style={{ color: "#555", fontSize: 10, fontWeight: "700", marginBottom: 2 }}>API_BASE</Text>
            <Text style={{ color: "#996dff", fontSize: 13, fontFamily: "monospace" }}>{API_BASE}</Text>
          </View>
          <View style={{ flexDirection: "row", gap: 16 }}>
            <View>
              <Text style={{ color: "#555", fontSize: 10, fontWeight: "700", marginBottom: 2 }}>PLATFORM</Text>
              <Text style={{ color: "#aaa", fontSize: 12, fontFamily: "monospace" }}>{Platform.OS}</Text>
            </View>
            <View>
              <Text style={{ color: "#555", fontSize: 10, fontWeight: "700", marginBottom: 2 }}>DEVICE</Text>
              <Text style={{ color: "#aaa", fontSize: 12, fontFamily: "monospace" }}>{isEmulator ? "emulador" : "físico"}</Text>
            </View>
          </View>
        </View>

        {/* Logs */}
        <ScrollView style={{ flex: 1, paddingHorizontal: 12, marginTop: 12 }} showsVerticalScrollIndicator={false}>
          {logs.length === 0 ? (
            <Text style={{ color: "#444", fontSize: 12, textAlign: "center", marginTop: 24 }}>
              Nenhum log ainda
            </Text>
          ) : (
            logs.map((entry) => (
              <Animated.View
                key={entry.id}
                entering={FadeIn.springify().damping(36).stiffness(420)}
                layout={LinearTransition.springify().damping(36).stiffness(420)}
                style={{ marginBottom: 8, padding: 10, backgroundColor: "#111118",
                borderRadius: 8, borderLeftWidth: 3,
                borderLeftColor: entry.level === "error" ? "#ff382b" : "#996dff" }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 3 }}>
                  <Text style={{ color: entry.level === "error" ? "#ff382b" : "#996dff",
                    fontSize: 10, fontWeight: "700" }}>
                    {entry.level.toUpperCase()}
                  </Text>
                  <Text style={{ color: "#444", fontSize: 10 }}>{entry.time}</Text>
                </View>
                <Text style={{ color: "#ccc", fontSize: 12, lineHeight: 18 }}>{entry.message}</Text>
              </Animated.View>
            ))
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}
