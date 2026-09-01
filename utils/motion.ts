// Vocabulário de animação portado do elfie-web (framer-motion) para
// react-native-reanimated. Os valores de spring abaixo espelham as
// convenções usadas lá (SettingsScreen/ChatScreen web) para que o app
// mobile tenha a mesma sensação de fluidez.
import { Easing, type WithSpringConfig, type WithTimingConfig } from "react-native-reanimated";

// Painel/modal grande entrando (equivalente ao motion.div do modal no web)
export const springPanel: WithSpringConfig = {
  stiffness: 340,
  damping: 30,
  mass: 0.9,
};

// Item de lista / card (equivalente ao stagger de listas no web)
export const springItem: WithSpringConfig = {
  stiffness: 420,
  damping: 36,
  mass: 0.8,
};

// Indicador compartilhado (pill de nav ativa, dot de personagem ativo,
// thumb do switch) — mais seco/rápido
export const springIndicator: WithSpringConfig = {
  stiffness: 500,
  damping: 34,
};

// Feedback de toque (whileTap) em botões
export const springPress: WithSpringConfig = {
  stiffness: 500,
  damping: 30,
};

export const timingFade: WithTimingConfig = {
  duration: 220,
  easing: Easing.out(Easing.ease),
};

export const timingFast: WithTimingConfig = {
  duration: 180,
  easing: Easing.out(Easing.ease),
};

// Delay de stagger por índice (em ms) — mesma proporção usada no web
// (delay: idx * 0.025~0.04s)
export const staggerDelay = (index: number, stepMs = 32, baseMs = 0) =>
  baseMs + index * stepMs;

export const PRESS_SCALE = 0.96;
export const PRESS_SCALE_SMALL = 0.9;
