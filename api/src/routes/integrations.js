import { Router } from 'express';
import {
  listIntegrations,
  getGoogleConfig,
  startGoogleOAuth,
  googleOAuthCallback,
  disconnectIntegration,
} from '../controllers/integrations.controller.js';

export default (app) => {
  const router = Router();

  router.get('/', listIntegrations);
  router.get('/google/config', getGoogleConfig);
  router.get('/google/start', startGoogleOAuth);
  router.get('/google/callback', googleOAuthCallback);
  router.delete('/:service', disconnectIntegration);

  app.use('/api/integrations', router);
};
