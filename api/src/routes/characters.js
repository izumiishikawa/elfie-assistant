import { Router } from 'express';
import {
  listCharacters,
  createCharacter,
  updateCharacter,
  deleteCharacter,
  activateCharacter,
  updateActiveCharacterVoice,
} from '../controllers/characters.controller.js';

export default (app) => {
  const router = Router();

  router.get('/', listCharacters);
  router.post('/', createCharacter);
  router.patch('/active/voice', updateActiveCharacterVoice);
  router.patch('/:id', updateCharacter);
  router.delete('/:id', deleteCharacter);
  router.patch('/:id/activate', activateCharacter);

  app.use('/api/characters', router);
};
