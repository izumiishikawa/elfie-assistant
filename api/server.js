import 'dotenv/config';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import app from './src/app.js';
import { connectDB } from './src/db.js';
import initRoutes from './src/routes/index.js';
import { setWss } from './src/openvt.js';
import { attachInworldRealtimeWS } from './src/inworldRealtime.js';
import Settings from './src/models/Settings.js';
import { setLLMSettings } from './src/llm.js';
import { setVoiceSettings } from './src/voice.js';
import { setGoogleAuthSettings } from './src/googleAuth.js';
import { setTelegramSettings } from './src/telegram.js';
import { setPixaiSettings } from './src/pixai.js';
import { runRoutinesCheck } from './src/routines.js';
import { runScheduledWorkflowsCheck } from './src/workflows.js';
import { runKnowledgeMaintenanceCheck } from './src/knowledgeMaintenance.js';
import { runChatHistoryFlushCheck } from './src/chatHistoryIngest.js';

const PORT = process.env.PORT ?? 3000;
const WS_PORT = process.env.WS_PORT ?? 41906;

await connectDB();
await initRoutes(app);

const initSettings = await Settings.findOne().lean();
if (initSettings) {
  setLLMSettings(initSettings);
  setVoiceSettings(initSettings);
  setGoogleAuthSettings(initSettings);
  setTelegramSettings(initSettings);
  setPixaiSettings(initSettings);
}

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const httpServer = app.listen(PORT, () => {
  console.log(`Elfie API running on http://localhost:${PORT}`);
});
attachInworldRealtimeWS(httpServer);

// WebSocket server para o OpenVT conectar como cliente
const wss = new WebSocketServer({ port: WS_PORT });
setWss(wss);
wss.on('connection', (ws) => {
  console.log('[openvt] OpenVT conectado');
  ws.on('close', () => console.log('[openvt] OpenVT desconectado'));
});
console.log(`[openvt] WebSocket server ouvindo em ws://localhost:${WS_PORT}`);

// Confere a cada minuto se alguma rotina agendada deve disparar agora, se é hora da
// manutenção noturna da base de conhecimento, e se algum chat "esfriou" com uma cauda
// ainda não indexada no histórico de conversas (cobre tanto chats abandonados sem um
// fechamento explícito quanto o backfill único de chats de antes dessa feature existir).
setInterval(() => {
  runRoutinesCheck().catch((err) => console.error('[routines] check falhou:', err));
  runScheduledWorkflowsCheck().catch((err) => console.error('[workflows] check falhou:', err));
  runKnowledgeMaintenanceCheck().catch((err) => console.error('[knowledgeMaintenance] check falhou:', err));
  runChatHistoryFlushCheck().catch((err) => console.error('[chatHistoryIngest] flush check falhou:', err));
}, 60_000);

