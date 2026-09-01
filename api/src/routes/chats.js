import { Router } from 'express';
import {
  createChat,
  listChats,
  getChat,
  deleteChat,
  sendMessage,
  voiceRespond,
  cancelChat,
  resolveSkillConfirmation,
} from '../controllers/chats.controller.js';
import { summarizeChat } from '../summarizer.js';
import { ingestChatTail } from '../chatHistoryIngest.js';

export default (app) => {
  const router = Router();

  router.post('/', createChat);
  router.get('/', listChats);
  router.get('/:id', getChat);
  router.delete('/:id', deleteChat);
  router.post('/:id/message', sendMessage);
  router.post('/:id/cancel', cancelChat);
  router.post('/:id/confirmations/:confirmationId/resolve', resolveSkillConfirmation);
  router.post('/:id/voice', voiceRespond);
  router.post('/:id/summarize', async (req, res) => {
    try {
      const summary = await summarizeChat(req.params.id);
      ingestChatTail(req.params.id, { force: true }).catch((err) => console.error('[chatHistoryIngest]', err.message));
      res.json({ summary });
    } catch (err) {
      console.error('[summarize route]', err);
      res.status(500).json({ error: 'Failed to summarize' });
    }
  });

  app.use('/api/chats', router);
};
