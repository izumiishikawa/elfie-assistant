# Elfie

Elfie is an AI companion app with a persistent memory, voice conversations, dynamic skills (custom tools the AI can call or teach itself), a desktop overlay daemon for Linux, and an optional Live2D avatar. The project has a few independent pieces that work together: a mobile app, a web app, a backend API, a desktop daemon, and a Live2D overlay.

This project is open for anyone to fork, modify, and build on. There are no restrictions on changing, extending, or repurposing any part of it.

## Project layout

| Folder | What it is |
|---|---|
| `/` (root) | The mobile app, built with Expo / React Native. This is the primary client. |
| `api/` | The backend: Node.js + Express + MongoDB. Handles chat, memory, voice, image generation, integrations, and the dynamic skills system. |
| `elfie-web/` | A web client built with Vite + React, mirroring most of the mobile app's functionality in the browser. |
| `daemon/` | A Python background process for Linux that shows a floating overlay indicator on the desktop, handles global hotkeys, voice capture, and an optional hand tracking mode for a "mind graph" visualization. |
| `waifu-persona/` | A vendored Godot project (OpenVT) used to render an optional 2D Live2D avatar overlay. It has its own license and README; see `waifu-persona/README.md`. |

You don't need all of these running at once. The API is required for everything else to work; the mobile app, web app, and daemon are independent clients on top of it.

## Prerequisites

- Node.js 20 or newer
- npm
- MongoDB (running locally or reachable over the network)
- Python 3.10 or newer (only needed for `daemon/`)
- Godot 4.6 (only needed if you want to build `waifu-persona/` yourself)

## 1. Backend API (`api/`)

```bash
cd api
npm install
cp .env.example .env
```

Fill in `.env` with at least an LLM provider key (OpenRouter is the default; DeepSeek is also supported). Check `.env.example` for the full list of optional keys (voice providers, image generation, search, browser automation).

Make sure MongoDB is running, then start the server:

```bash
npm start
```

By default the API listens on `http://localhost:3000`.

## 2. Web app (`elfie-web/`)

```bash
cd elfie-web
npm install
cp .env.example .env
npm run dev
```

`VITE_API_URL` in `.env` should point at your running API (defaults to `http://localhost:3000`).

## 3. Mobile app (root)

```bash
npm install
cp .env.example .env
npx expo start
```

`EXPO_PUBLIC_API_URL` in `.env` should point at your running API. If you're testing on a physical device over Wi-Fi, use your machine's LAN IP instead of `localhost`, since the phone can't resolve `localhost` as your computer.

Run on a connected Android device or emulator with:

```bash
npm run android
```

## 4. Desktop daemon (`daemon/`)

The daemon is Linux only, and specifically targets Wayland compositors with layer-shell support (Hyprland, Sway, and similar). It shows a floating overlay avatar, listens for a mute/unmute hotkey, and streams your microphone to the API for voice conversations.

System dependencies (package names below are for Arch Linux; adjust for your distro):

```bash
sudo pacman -S python-gobject gtk3 gtk-layer-shell webkit2gtk-4.1 ffmpeg mpg123 xdotool grim
```

- `ffmpeg` and `mpg123` handle microphone capture and audio playback.
- `xdotool` and `grim` are used by the AI's computer control tools (mouse, keyboard, screenshots).
- Your user needs to be in the `input` group for the global mute hotkey to work; the install script below handles that.

Install:

```bash
cd daemon
pip3 install -r requirements.txt --break-system-packages
./install.sh
```

This installs an `elfie-daemon` and `elfie` command into `~/.local/bin`. Log out and back in once (so the `input` group membership takes effect), then:

```bash
elfie-daemon &
elfie switch <chatId>
```

The daemon reads its config from `~/.config/elfie/daemon.json`, including which API URL to talk to (defaults to `http://localhost:3000`).

### Optional: hand tracking

The "show me your mind" feature can respond to hand gestures via webcam. It's an optional, separate install that keeps its heavier dependencies (mediapipe, opencv) out of the main daemon environment:

```bash
cd daemon
./setup_hand_tracking.sh
```

## 5. Live2D avatar (`waifu-persona/`)

This is a vendored copy of OpenVT, a separate open source 2D VTubing project, used here to render an optional avatar. It's a Godot 4.6 project; open the `waifu-persona/` folder in Godot to build it. See `waifu-persona/README.md` for details specific to that project.

## Contributing

Pull requests, forks, and modifications of any kind are welcome. There's no formal contribution process; open an issue or a PR.
