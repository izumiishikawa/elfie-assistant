import { Router } from 'express';
import { backupInfo, backupUpload, exportBackup, importBackup } from '../controllers/backup.controller.js';

export default (app) => {
  const router = Router();

  router.get('/info', backupInfo);
  router.get('/export', exportBackup);
  router.post('/import', backupUpload, importBackup);

  app.use('/api/backup', router);
};
