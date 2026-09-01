import mongoose, { Schema } from 'mongoose';

const settingsSchema = new Schema({
  aiName: { type: String, default: '' },
  aiPersonality: { type: String, default: '' },
  aiModel: { type: String, default: '' },
  aiPhoto: { type: String, default: '' },
  activeCharacterId: { type: Schema.Types.ObjectId, ref: 'Character', default: null },
  userName: { type: String, default: '' },
  userPhoto: { type: String, default: '' },
  userBasicData: { type: String, default: '' },
  userCity: { type: String, default: '' },
  longTermMemory: { type: [String], default: [] },
  pushToken: { type: String, default: '' },
  lastProactiveAt: { type: Date, default: null },
  proactiveCountToday: { type: Number, default: 0 },
  proactiveDateReset: { type: Date, default: null },
  llmProvider: { type: String, default: 'openrouter' },
  deepseekApiKey: { type: String, default: '' },
  deepseekModel: { type: String, default: 'deepseek-v4-flash' },
  ttsProvider: { type: String, default: 'elevenlabs' },
  sttProvider: { type: String, default: 'elevenlabs' },
  fishaudioApiKey: { type: String, default: '' },
  googleClientId: { type: String, default: '' },
  googleClientSecret: { type: String, default: '' },
  telegramBotToken: { type: String, default: '' },
  telegramOwnerId: { type: String, default: '' },
  telegramChatId: { type: Schema.Types.ObjectId, ref: 'Chat', default: null },
  accentColor: { type: String, default: '#996dff' },
  unlimitedTools: { type: Boolean, default: false },
});

export default mongoose.model('Settings', settingsSchema);
