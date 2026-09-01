import { Router } from 'express';
import {
  listVoicePresets,
  createVoicePreset,
  updateVoicePreset,
  deleteVoicePreset,
} from '../controllers/voicePresets.controller.js';

export default (app) => {
  const router = Router();

  router.get('/', listVoicePresets);
  router.post('/', createVoicePreset);
  router.patch('/:id', updateVoicePreset);
  router.delete('/:id', deleteVoicePreset);

  app.use('/api/voice-presets', router);
};
