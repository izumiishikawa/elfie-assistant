import { Router } from 'express';
import {
  listSkills,
  createSkill,
  updateSkill,
  deleteSkill,
  testSkill,
} from '../controllers/skills.controller.js';

export default (app) => {
  const router = Router();

  router.get('/', listSkills);
  router.post('/', createSkill);
  router.patch('/:id', updateSkill);
  router.delete('/:id', deleteSkill);
  router.post('/:id/test', testSkill);

  app.use('/api/skills', router);
};
