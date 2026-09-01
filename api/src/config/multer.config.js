import multer from 'multer';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import { existsSync, mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const uploadDir = resolve(__dirname, '..', '..', 'uploads');
if (!existsSync(uploadDir)) mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    randomBytes(16, (err, hash) => {
      if (err) return cb(err);
      const ext = file.originalname.split('.').pop()?.toLowerCase() ?? 'bin';
      cb(null, `${hash.toString('hex')}.${ext}`);
    });
  },
});

const fileFilter = (_req, file, cb) => {
  const allowed = ['image/jpeg', 'image/pjpeg', 'image/png', 'image/gif', 'image/webp'];
  cb(allowed.includes(file.mimetype) ? null : new Error('Tipo de arquivo inválido'), allowed.includes(file.mimetype));
};

export default multer({ storage, fileFilter });
