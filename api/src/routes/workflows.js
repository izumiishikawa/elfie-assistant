import { Router } from 'express';
import {
  listWorkflows,
  getWorkflow,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  regenerateWebhook,
  runWorkflowNowController,
  listWorkflowRuns,
  getWorkflowRun,
} from '../controllers/workflows.controller.js';

export default (app) => {
  const router = Router();

  router.get('/', listWorkflows);
  router.post('/', createWorkflow);
  router.get('/:id', getWorkflow);
  router.patch('/:id', updateWorkflow);
  router.delete('/:id', deleteWorkflow);
  router.post('/:id/regenerate-webhook', regenerateWebhook);
  router.post('/:id/run', runWorkflowNowController);
  router.get('/:id/runs', listWorkflowRuns);
  router.get('/:id/runs/:runId', getWorkflowRun);

  app.use('/api/workflows', router);
};
