import { Router } from 'express';
import { broadcastEvent } from '../openvt.js';

export default (app) => {
  const router = Router();

  router.post('/state', (req, res) => {
    const { muted } = req.body ?? {};
    broadcastEvent({ type: 'state', muted: !!muted });
    res.json({ ok: true });
  });

  app.use('/api/avatar', router);
};
