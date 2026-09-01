import { randomBytes } from 'crypto';
import { writeFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import Settings from '../models/Settings.js';
import Character from '../models/Character.js';
import { setLLMSettings } from '../llm.js';
import { setVoiceSettings } from '../voice.js';
import { setGoogleAuthSettings } from '../googleAuth.js';
import { setTelegramSettings } from '../telegram.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const uploadDir = resolve(__dirname, '..', '..', 'uploads');

async function saveBase64(base64) {
  const filename = `${randomBytes(16).toString('hex')}.jpg`;
  await writeFile(resolve(uploadDir, filename), Buffer.from(base64, 'base64'));
  return filename;
}

async function getOrCreate() {
  let s = await Settings.findOne();
  if (!s) s = await Settings.create({});

  const charCount = await Character.countDocuments();
  if (charCount === 0 && (s.aiName || s.aiPersonality || s.aiModel || s.aiPhoto || s.userName || s.userBasicData)) {
    const char = await Character.create({
      name: s.aiName || 'Elfie',
      personality: s.aiPersonality || '',
      model: s.aiModel || '',
      photo: s.aiPhoto || '',
      userName: s.userName || '',
      userBasicData: s.userBasicData || '',
      longTermMemory: s.longTermMemory || [],
    });
    s = await Settings.findByIdAndUpdate(s._id, { activeCharacterId: char._id }, { new: true });
  }

  return s;
}

export async function getSettings(_req, res) {
  try {
    res.json(await getOrCreate());
  } catch (err) {
    console.error('[getSettings]', err);
    res.status(500).json({ error: 'Failed to get settings' });
  }
}

export async function updateSettings(req, res) {
  try {
    const patch = {};
    if (req.body.userPhotoBase64) patch.userPhoto = await saveBase64(req.body.userPhotoBase64);
    if (req.body.userCity !== undefined) patch.userCity = req.body.userCity;
    if (req.body.llmProvider !== undefined) patch.llmProvider = req.body.llmProvider;
    if (req.body.deepseekApiKey !== undefined) patch.deepseekApiKey = req.body.deepseekApiKey;
    if (req.body.deepseekModel !== undefined) patch.deepseekModel = req.body.deepseekModel;
    if (req.body.accentColor !== undefined) patch.accentColor = req.body.accentColor;
    if (req.body.ttsProvider !== undefined) patch.ttsProvider = req.body.ttsProvider;
    if (req.body.sttProvider !== undefined) patch.sttProvider = req.body.sttProvider;
    if (req.body.fishaudioApiKey !== undefined) patch.fishaudioApiKey = req.body.fishaudioApiKey;
    if (req.body.googleClientId !== undefined) patch.googleClientId = req.body.googleClientId;
    if (req.body.googleClientSecret !== undefined) patch.googleClientSecret = req.body.googleClientSecret;
    if (req.body.telegramBotToken !== undefined) patch.telegramBotToken = req.body.telegramBotToken;
    if (req.body.unlimitedTools !== undefined) patch.unlimitedTools = !!req.body.unlimitedTools;
    if (req.body.telegramUnlink === true) patch.telegramOwnerId = '';

    const settings = await Settings.findOneAndUpdate(
      {},
      { $set: patch },
      { new: true, upsert: true },
    );
    setLLMSettings(settings);
    setVoiceSettings(settings);
    setGoogleAuthSettings(settings);
    setTelegramSettings(settings);
    res.json(settings);
  } catch (err) {
    console.error('[updateSettings]', err);
    res.status(500).json({ error: 'Failed to update settings' });
  }
}
