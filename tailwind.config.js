/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./App.{js,jsx,ts,tsx}",
    "./app/**/*.{js,jsx,ts,tsx}",
    "./components/**/*.{js,jsx,ts,tsx}",
    "./screens/**/*.{js,jsx,ts,tsx}",
  ],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        background: "#17171c",
        foreground: "#1e1e25",
        tertiary: "#282838",
        card: {
          DEFAULT: "#ffffff",
          foreground: "#081c1e",
        },
        popover: {
          DEFAULT: "#e6e6eb",
          foreground: "#000000",
        },
        primary: {
          DEFAULT: "#ffffff",
          foreground: "#ffffff",
        },
        secondary: {
          DEFAULT: "#1e1e25",
          foreground: "#ffffff",
        },
        muted: {
          DEFAULT: "#afb0b4",
          foreground: "#8e8e93",
        },
        accent: {
          DEFAULT: "#996dff",
          foreground: "#ffffff",
        },
        destructive: {
          DEFAULT: "#ff382b",
          foreground: "#ffffff",
        },
        border: "#1e1e25",
        input: "#2a2a35",
        ring: "#996dff",
      },
    },
  },
  plugins: [],
};
