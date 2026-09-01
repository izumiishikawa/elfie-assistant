// Mirror of global.css custom properties — use these in StyleSheet or Reanimated contexts
// where Tailwind class names are not available.

export const colors = {
  background: "hsl(240, 10%, 4%)",
  foreground: "hsl(240, 5%, 96%)",

  card: "hsl(240, 10%, 7%)",
  cardForeground: "hsl(240, 5%, 96%)",

  primary: "hsl(265, 89%, 68%)",
  primaryForeground: "hsl(0, 0%, 100%)",

  secondary: "hsl(265, 30%, 16%)",
  secondaryForeground: "hsl(265, 20%, 80%)",

  accent: "hsl(280, 75%, 72%)",
  accentForeground: "hsl(0, 0%, 100%)",

  muted: "hsl(240, 8%, 12%)",
  mutedForeground: "hsl(240, 5%, 55%)",

  destructive: "hsl(0, 72%, 51%)",
  destructiveForeground: "hsl(0, 0%, 100%)",

  border: "hsl(240, 8%, 14%)",
  ring: "hsl(265, 89%, 68%)",
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  "2xl": 48,
  "3xl": 64,
} as const;

export const radius = {
  sm: 6,
  md: 12,
  lg: 16,
  xl: 24,
  full: 9999,
} as const;

export const typography = {
  xs: 11,
  sm: 13,
  base: 16,
  lg: 18,
  xl: 20,
  "2xl": 24,
  "3xl": 30,
  "4xl": 36,
} as const;
