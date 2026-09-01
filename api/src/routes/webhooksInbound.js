import { Router } from 'express';
import { resolveWebhookWorkflow, executeWorkflow } from '../workflows.js';

export default (app) => {
  const router = Router();

  router.post('/:workflowId/:token', async (req, res) => {
    let workflow;
    try {
      workflow = await resolveWebhookWorkflow(req.params.workflowId, req.params.token, req.get('X-Webhook-Secret'));
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }

    res.status(202).json({ received: true });

    executeWorkflow(workflow, { type: 'webhook', payload: req.body, headers: req.headers }).catch((err) => {
      console.error(`[webhooks] "${workflow.name}" falhou:`, err.message);
    });
  });

  app.use('/api/webhooks', router);
};
