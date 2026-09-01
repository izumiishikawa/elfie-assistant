import mongoose, { Schema } from 'mongoose';

const skillPackageSchema = new Schema(
  {
    name: { type: String, required: true, unique: true },
    description: { type: String, default: '' },
  },
  { timestamps: true },
);

export default mongoose.model('SkillPackage', skillPackageSchema);
