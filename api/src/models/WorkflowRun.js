import mongoose, { Schema } from 'mongoose';

const stepSchema = new Schema(
  {
    nodeId: { type: String, required: true },
    nodeType: { type: String, required: true },
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date, default: null },
    status: { type: String, enum: ['success', 'error', 'skipped'], default: 'success' },
    output: { type: Schema.Types.Mixed, default: null },
    error: { type: String, default: null },
  },
  { _id: false },
);

const workflowRunSchema = new Schema(
  {
    workflowId: { type: Schema.Types.ObjectId, ref: 'Workflow', required: true, index: true },
    trigger: {
      type: { type: String, enum: ['webhook', 'schedule', 'routine', 'manual'], required: true },
      payload: { type: Schema.Types.Mixed, default: {} },
    },
    status: { type: String, enum: ['running', 'success', 'error'], default: 'running' },
    steps: { type: [stepSchema], default: [] },
    startedAt: { type: Date, default: Date.now },
    finishedAt: { type: Date, default: null },
    error: { type: String, default: null },
  },
  { timestamps: true },
);

export default mongoose.model('WorkflowRun', workflowRunSchema);
