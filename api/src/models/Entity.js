import mongoose, { Schema } from 'mongoose';

const mentionSchema = new Schema(
  { folder: String, file: String, snippet: String, chunkId: String },
  { _id: false },
);

const entitySchema = new Schema(
  {
    name: { type: String, required: true },
    type: { type: String, enum: ['person', 'project', 'place', 'date', 'other'], default: 'other' },
    aliases: { type: [String], default: [] },
    embedding: { type: [Number], select: false },
    mentions: { type: [mentionSchema], default: [] },
  },
  { timestamps: true },
);

export default mongoose.model('Entity', entitySchema);
