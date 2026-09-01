import mongoose, { Schema } from 'mongoose';

const knowledgeTagSchema = new Schema(
  {
    name: { type: String, required: true, unique: true },
    description: { type: String, default: '' },
    embedding: { type: [Number], select: false },
  },
  { timestamps: true },
);

export default mongoose.model('KnowledgeTag', knowledgeTagSchema);
