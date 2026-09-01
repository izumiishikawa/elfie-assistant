import mongoose, { Schema } from 'mongoose';

const routineSchema = new Schema(
  {
    name: { type: String, required: true },
    prompt: { type: String, required: true },
    characterId: { type: Schema.Types.ObjectId, ref: 'Character', default: null },
    hour: { type: Number, required: true, min: 0, max: 23 },
    minute: { type: Number, required: true, min: 0, max: 59 },
    daysOfWeek: { type: [Number], default: [] },
    runOnce: { type: Boolean, default: false },
    scheduledDate: { type: Date, default: null },
    enabled: { type: Boolean, default: true },
    notify: { type: Boolean, default: true },
    forceTts: { type: Boolean, default: false },
    triggeredWorkflowIds: { type: [{ type: Schema.Types.ObjectId, ref: 'Workflow' }], default: [] },
    lastRunAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export default mongoose.model('Routine', routineSchema);
