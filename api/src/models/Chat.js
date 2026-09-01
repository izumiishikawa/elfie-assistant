import mongoose, { Schema } from 'mongoose';

const messageSchema = new Schema(
  {
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, default: '' },
    imageFilenames: [{ type: String }],
    savedMemory: { type: Boolean, default: false },
    searchSources: [{ title: String, url: String, snippet: String }],
    productCards: [{ title: String, url: String, snippet: String, image: String }],
    gifs: [{ url: String, mp4: String }],
    voiceNotes: [{ filename: String }],
    triggeredByRoutine: { type: Schema.Types.ObjectId, ref: 'Routine', default: null },
    triggeredByWorkflow: { type: Schema.Types.ObjectId, ref: 'Workflow', default: null },
    toolLog: [{ name: String, result: String, _id: false }],
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

const chatSchema = new Schema(
  {
    title: { type: String, default: 'Nova conversa' },
    characterId: { type: Schema.Types.ObjectId, ref: 'Character', default: null },
    messages: [messageSchema],
    lastIngestedIndex: { type: Number, default: 0 },
    toolsOpen: { type: Boolean, default: false },
    toolsIdleTurns: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export default mongoose.model('Chat', chatSchema);
