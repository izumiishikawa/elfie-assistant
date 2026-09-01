import mongoose, { Schema } from 'mongoose';

const integrationSchema = new Schema(
  {
    service: { type: String, enum: ['gmail', 'calendar', 'drive', 'playconsole'], required: true, unique: true },
    googleEmail: { type: String, default: '' },
    scopes: { type: [String], default: [] },
    accessToken: { type: String, default: '', select: false },
    refreshToken: { type: String, default: '', select: false },
    tokenExpiry: { type: Date, default: null },
    connectedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export default mongoose.model('Integration', integrationSchema);
