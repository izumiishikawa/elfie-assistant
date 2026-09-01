import mongoose, { Schema } from 'mongoose';

const voicePresetSchema = new Schema(
  {
    name: { type: String, required: true, unique: true },
    voiceId: { type: String, required: true },
    provider: { type: String, enum: ['elevenlabs', 'fishaudio'], required: true },
  },
  { timestamps: true },
);

export default mongoose.model('VoicePreset', voicePresetSchema);
