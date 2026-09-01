import { Router } from 'express';
import {
  listRoutines,
  createRoutine,
  updateRoutine,
  deleteRoutine,
  runRoutineNowController,
} from '../controllers/routines.controller.js';

export default (app) => {
  const router = Router();

  router.get('/', listRoutines);
  router.post('/', createRoutine);
  router.patch('/:id', updateRoutine);
  router.delete('/:id', deleteRoutine);
  router.post('/:id/run', runRoutineNowController);

  app.use('/api/routines', router);
};
