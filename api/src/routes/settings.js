import { Router } from 'express';
import { getSettings, updateSettings } from '../controllers/settings.controller.js';
import upload from '../config/multer.config.js';
import Settings from '../models/Settings.js';

const handleUpload = (req, res, next) => {
  if (!(req.headers['content-type'] ?? '').includes('multipart/form-data')) {
    return next();
  }
  upload.fields([{ name: 'aiPhoto', maxCount: 1 }, { name: 'userPhoto', maxCount: 1 }])(req, res, (err) => {
    if (err) {
      console.error('[settings PATCH] multer error:', err);
      return res.status(400).json({ error: err.message });
    }
    next();
  });
};

export default (app) => {
  const router = Router();

  router.get('/', getSettings);
  router.patch('/', handleUpload, updateSettings);
  router.post('/push-token', async (req, res) => {
    try {
      const { token } = req.body;
      if (!token) return res.status(400).json({ error: 'token required' });
      await Settings.findOneAndUpdate({}, { pushToken: token }, { upsert: true });
      res.json({ ok: true });
    } catch (err) {
      console.error('[push-token]', err);
      res.status(500).json({ error: 'Failed to save token' });
    }
  });

  app.use('/api/settings', router);
};
