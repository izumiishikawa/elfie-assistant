import mongoose, { Schema } from 'mongoose';

const memorySchema = new Schema(
  { text: String, embedding: { type: [Number], select: false } },
  { _id: false },
);

const summarySchema = new Schema(
  {
    text: String,
    embedding: { type: [Number], select: false },
    chatId: { type: Schema.Types.ObjectId, ref: 'Chat' },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const characterSchema = new Schema(
  {
    name: { type: String, default: 'Elfie' },
    personality: { type: String, default: '' },
    model: { type: String, default: '' },
    photo: { type: String, default: '' },
    voiceId: { type: String, default: '' },
    userName: { type: String, default: '' },
    userBasicData: { type: String, default: '' },
    longTermMemory: { type: [memorySchema], default: [] },
    chatSummaries: { type: [summarySchema], default: [] },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export default mongoose.model('Character', characterSchema);
