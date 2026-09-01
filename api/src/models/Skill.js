import mongoose, { Schema } from 'mongoose';

const paramSchema = new Schema(
  {
    name: { type: String, required: true },
    in: { type: String, enum: ['path', 'query', 'header', 'body'], default: 'query' },
    type: { type: String, enum: ['string', 'number', 'boolean', 'array', 'object'], default: 'string' },
    required: { type: Boolean, default: false },
    description: { type: String, default: '' },
  },
  { _id: false },
);

const headerSchema = new Schema(
  {
    key: { type: String, default: '' },
    value: { type: String, default: '' },
  },
  { _id: false },
);

const skillSchema = new Schema(
  {
    name: { type: String, required: true, unique: true },
    description: { type: String, default: '' },
    packageId: { type: Schema.Types.ObjectId, ref: 'SkillPackage', default: null },
    method: { type: String, enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], default: 'GET' },
    urlTemplate: { type: String, required: true },
    responseMode: { type: String, enum: ['text', 'image'], default: 'text' },
    imageUrlField: { type: String, default: '' },
    authType: { type: String, enum: ['none', 'bearer', 'apiKeyHeader', 'basic'], default: 'none' },
    authHeaderName: { type: String, default: '' },
    authValue: { type: String, default: '', select: false },
    headers: { type: [headerSchema], default: [] },
    params: { type: [paramSchema], default: [] },
    timeoutMs: { type: Number, default: 15000 },
    enabled: { type: Boolean, default: true },
    requiresConfirmation: { type: Boolean, default: false },
    stripEmDash: { type: Boolean, default: false },
    alwaysVisible: { type: Boolean, default: false },
  },
  { timestamps: true },
);

export default mongoose.model('Skill', skillSchema);
