import { Router } from 'express';
import multer from 'multer';
import { writeFile } from 'fs/promises';
import { resolve, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const uploadDir = resolve(__dirname, '..', '..', 'uploads');
const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

export default (app) => {
  const router = Router();

  router.post('/', async (req, res) => {
    try {
      const { images = [] } = req.body;
      if (!Array.isArray(images) || images.length === 0) {
        return res.status(400).json({ error: 'images array required' });
      }

      const extMap = { 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };
      const filenames = await Promise.all(
        images.map(async ({ base64, mimeType }) => {
          const ext = extMap[mimeType] ?? 'jpg';
          const filename = `${randomBytes(16).toString('hex')}.${ext}`;
          await writeFile(resolve(uploadDir, filename), Buffer.from(base64, 'base64'));
          return filename;
        }),
      );

      res.json({ filenames });
    } catch (err) {
      console.error('[upload]', err);
      res.status(500).json({ error: 'Upload failed' });
    }
  });

  router.post('/voice', audioUpload.single('audio'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'audio required' });
      const ext = extname(req.file.originalname || '') || '.m4a';
      const filename = `${randomBytes(16).toString('hex')}${ext}`;
      await writeFile(resolve(uploadDir, filename), req.file.buffer);
      res.json({ filename });
    } catch (err) {
      console.error('[upload:voice]', err);
      res.status(500).json({ error: 'Upload failed' });
    }
  });

  app.use('/api/upload', router);
};
