import { Router } from 'express';
import { getActiveChatStreamIds, abortAllChatStreams } from '../controllers/chats.controller.js';
import { getRunningSessions, sendToDaemon } from '../neuroStore.js';

export default (app) => {
  const router = Router();

  router.get('/status', (_req, res) => {
    const chatStreamIds = getActiveChatStreamIds();
    const neuroSessions = getRunningSessions();
    res.json({
      active: chatStreamIds.length > 0 || neuroSessions.length > 0,
      chatStreamIds,
      neuroSessions,
    });
  });

  router.post('/stop-all', async (_req, res) => {
    try {
      const neuroSessions = getRunningSessions();
      const [stoppedChats, killResults] = await Promise.all([
        abortAllChatStreams(),
        Promise.allSettled(
          neuroSessions.map((s) => sendToDaemon({ cmd: 'neuro_kill', chatId: s.chatId })),
        ),
      ]);
      res.json({
        ok: true,
        stoppedChats,
        stoppedNeuroSessions: neuroSessions.map((s) => s.chatId),
        neuroKillFailures: killResults.filter((r) => r.status === 'rejected').length,
      });
    } catch (err) {
      console.error('[activity/stop-all] error:', err);
      res.status(500).json({ error: 'Failed to stop everything' });
    }
  });

  app.use('/api/activity', router);
};
