import mongoose, { Schema } from 'mongoose';

const nodeSchema = new Schema(
  {
    id: { type: String, required: true },
    type: {
      type: String,
      required: true,
      enum: ['webhook', 'schedule', 'routine', 'prompt', 'condition', 'http_request'],
    },
    position: {
      x: { type: Number, default: 0 },
      y: { type: Number, default: 0 },
    },
    data: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: false },
);

const edgeSchema = new Schema(
  {
    id: { type: String, required: true },
    source: { type: String, required: true },
    target: { type: String, required: true },
    sourceHandle: { type: String, default: null },
  },
  { _id: false },
);

const workflowSchema = new Schema(
  {
    name: { type: String, required: true },
    enabled: { type: Boolean, default: true },
    characterId: { type: Schema.Types.ObjectId, ref: 'Character', default: null },
    nodes: { type: [nodeSchema], default: [] },
    edges: { type: [edgeSchema], default: [] },
    webhookToken: { type: String, default: null, index: true },
    webhookSecret: { type: String, default: null },
    lastRunAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export default mongoose.model('Workflow', workflowSchema);
