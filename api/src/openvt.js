import { execFile } from "child_process";
import { readFile, unlink } from "fs/promises";
import { promisify } from "util";
import { WebSocket } from "ws";

const execFileAsync = promisify(execFile);

let _wss = null;

export function setWss(wss) {
  _wss = wss;
}

function _broadcast(payload) {
  if (!_wss) return;
  const msg = JSON.stringify(payload);
  for (const client of _wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

export function broadcastEvent(payload) {
  _broadcast(payload);
}

async function _mp3ToWav(mp3Path) {
  const wavPath = mp3Path.replace(/\.mp3$/, ".wav");
  await execFileAsync("ffmpeg", [
    "-y", "-i", mp3Path,
    "-ar", "22050",
    "-ac", "1",
    "-sample_fmt", "s16",
    wavPath,
  ]);
  return wavPath;
}

export async function sendTTS(mp3Path, text = "", expression = "") {
  if (!_wss || _wss.clients.size === 0) {
    console.warn("[openvt] nenhum cliente conectado, ignorando TTS");
    return;
  }

  let wavPath;
  try {
    wavPath = await _mp3ToWav(mp3Path);
    const wavBytes = await readFile(wavPath);
    _broadcast({ type: "tts", data: wavBytes.toString("base64"), text, expression });
    console.log("[openvt] TTS enviado para", _wss.clients.size, "cliente(s)");
  } catch (err) {
    console.error("[openvt] falha ao enviar TTS:", err.message);
  } finally {
    if (wavPath) unlink(wavPath).catch(() => {});
  }
}
