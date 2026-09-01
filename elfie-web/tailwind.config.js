/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "#17171c",
        foreground: "#1e1e25",
        tertiary: "#282838",
        card: { DEFAULT: "#ffffff", foreground: "#081c1e" },
        popover: { DEFAULT: "#e6e6eb", foreground: "#000000" },
        primary: { DEFAULT: "#ffffff", foreground: "#ffffff" },
        secondary: { DEFAULT: "#1e1e25", foreground: "#ffffff" },
        muted: { DEFAULT: "#afb0b4", foreground: "#8e8e93" },
        accent: { DEFAULT: "rgb(var(--accent-rgb) / <alpha-value>)", foreground: "#ffffff" },
        destructive: { DEFAULT: "#ff382b", foreground: "#ffffff" },
        border: "#1e1e25",
        input: "#2a2a35",
        ring: "rgb(var(--accent-rgb) / <alpha-value>)",
      },
    },
  },
  plugins: [],
}
