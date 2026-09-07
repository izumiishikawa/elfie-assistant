import { Router } from 'express';
import { getModelVersion, hasPixaiToken, searchModels } from '../pixai.js';

function handle(res, err) {
  const message = err?.message ?? 'PixAI request failed';
  const status = /token/i.test(message) ? 401 : 502;
  console.error('[pixai route]', message);
  res.status(status).json({ error: message });
}

export default (app) => {
  const router = Router();

  router.get('/status', (_req, res) => res.json({ configured: hasPixaiToken() }));

  router.get('/search', async (req, res) => {
    try {
      res.json(await searchModels({
        keyword: req.query.q ?? '',
        kind: req.query.kind === 'lora' ? 'lora' : 'model',
        cursor: req.query.cursor ?? null,
        limit: req.query.limit ?? 24,
        baseModelType: req.query.baseModel ?? '',
      }));
    } catch (err) { handle(res, err); }
  });

  router.get('/versions/:id', async (req, res) => {
    try {
      const version = await getModelVersion(req.params.id);
      if (!version) return res.status(404).json({ error: 'Model version not found' });
      res.json(version);
    } catch (err) { handle(res, err); }
  });

  app.use('/api/pixai', router);
};
