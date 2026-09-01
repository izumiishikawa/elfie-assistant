import { Router } from 'express';
import {
  listSkillPackages,
  createSkillPackage,
  updateSkillPackage,
  deleteSkillPackage,
} from '../controllers/skillPackages.controller.js';

export default (app) => {
  const router = Router();

  router.get('/', listSkillPackages);
  router.post('/', createSkillPackage);
  router.patch('/:id', updateSkillPackage);
  router.delete('/:id', deleteSkillPackage);

  app.use('/api/skill-packages', router);
};
