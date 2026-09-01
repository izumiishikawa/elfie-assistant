import { Router } from 'express';
import {
  listFolders,
  postFolder,
  patchFolder,
  removeFolder,
  getFile,
  putFile,
  removeFile,
  getFileStatus,
  reindexAll,
  searchKnowledge,
  listTags,
} from '../controllers/knowledge.controller.js';

export default (app) => {
  const router = Router();

  router.get('/', listFolders);
  router.get('/search', searchKnowledge);
  router.get('/tags', listTags);
  router.post('/folders', postFolder);
  router.patch('/folders/:name', patchFolder);
  router.delete('/folders/:name', removeFolder);
  router.get('/folders/:name/files/:file', getFile);
  router.put('/folders/:name/files/:file', putFile);
  router.delete('/folders/:name/files/:file', removeFile);
  router.get('/folders/:name/files/:file/status', getFileStatus);
  router.post('/reindex', reindexAll);

  app.use('/api/knowledge', router);
};
