import { randomBytes } from 'crypto';
import { writeFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import Character from '../models/Character.js';
import Settings from '../models/Settings.js';
import { getEmbedding, normaliseMemories, sanitiseMemories } from '../embeddings.js';
import { switchActiveVoice } from '../voicePresets.js';

function sanitiseChar(char) {
  if (!char) return char;
  const obj = char.toObject ? char.toObject() : { ...char };
  obj.longTermMemory = sanitiseMemories(obj.longTermMemory);
  delete obj.chatSummaries;
  return obj;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const uploadDir = resolve(__dirname, '..', '..', 'uploads');

async function saveBase64(base64) {
  const filename = `${randomBytes(16).toString('hex')}.jpg`;
  await writeFile(resolve(uploadDir, filename), Buffer.from(base64, 'base64'));
  return filename;
}

async function getOrCreateSettings() {
  let s = await Settings.findOne();
  if (!s) s = await Settings.create({});
  return s;
}

export async function listCharacters(_req, res) {
  try {
    const [characters, settings] = await Promise.all([
      Character.find().sort({ createdAt: 1 }),
      getOrCreateSettings(),
    ]);
    res.json({ characters: characters.map(sanitiseChar), activeCharacterId: settings.activeCharacterId });
  } catch (err) {
    console.error('[listCharacters]', err);
    res.status(500).json({ error: 'Failed to list characters' });
  }
}

export async function createCharacter(req, res) {
  try {
    const { name, personality, model, photoBase64, voiceId } = req.body;
    const data = { name: name || 'Novo personagem', personality: personality || '', model: model || '' };
    if (voiceId !== undefined) data.voiceId = voiceId;
    if (photoBase64) data.photo = await saveBase64(photoBase64);

    const character = await Character.create(data);

    const count = await Character.countDocuments();
    if (count === 1) {
      await Settings.findOneAndUpdate({}, { activeCharacterId: character._id }, { upsert: true });
    }

    res.status(201).json(character);
  } catch (err) {
    console.error('[createCharacter]', err);
    res.status(500).json({ error: 'Failed to create character' });
  }
}

export async function updateCharacter(req, res) {
  try {
    const { name, personality, model, photoBase64, voiceId, userName, userBasicData, longTermMemory } = req.body;
    const patch = {};
    if (name !== undefined) patch.name = name;
    if (personality !== undefined) patch.personality = personality;
    if (model !== undefined) patch.model = model;
    if (photoBase64) patch.photo = await saveBase64(photoBase64);
    if (voiceId !== undefined) patch.voiceId = voiceId;
    if (userName !== undefined) patch.userName = userName;
    if (userBasicData !== undefined) patch.userBasicData = userBasicData;
    if (longTermMemory !== undefined) {
      const current = (await Character.findById(req.params.id).lean())?.longTermMemory ?? [];
      const currentMap = new Map(normaliseMemories(current).map((m) => [m.text, m]));
      patch.longTermMemory = await Promise.all(
        longTermMemory.map(async (text) => {
          const existing = currentMap.get(text);
          if (existing?.embedding) return existing;
          const embedding = await getEmbedding(text);
          return { text, embedding };
        }),
      );
    }

    const character = await Character.findByIdAndUpdate(req.params.id, { $set: patch }, { new: true });
    if (!character) return res.status(404).json({ error: 'Character not found' });
    res.json(sanitiseChar(character));
  } catch (err) {
    console.error('[updateCharacter]', err);
    res.status(500).json({ error: 'Failed to update character' });
  }
}

export async function deleteCharacter(req, res) {
  try {
    await Character.findByIdAndDelete(req.params.id);

    const settings = await getOrCreateSettings();
    if (String(settings.activeCharacterId) === req.params.id) {
      const next = await Character.findOne();
      await Settings.findOneAndUpdate({}, { activeCharacterId: next?._id ?? null });
    }

    res.json({ message: 'Deleted' });
  } catch (err) {
    console.error('[deleteCharacter]', err);
    res.status(500).json({ error: 'Failed to delete character' });
  }
}

export async function updateActiveCharacterVoice(req, res) {
  try {
    const { character, voiceId, provider } = await switchActiveVoice({
      voiceId: req.body?.voiceId,
      name: req.body?.name,
    });
    res.json({ message: 'Voice updated', name: character.name, voiceId, provider });
  } catch (err) {
    if (err.code === 'BAD_REQUEST') return res.status(400).json({ error: err.message });
    if (err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message });
    console.error('[updateActiveCharacterVoice]', err);
    res.status(500).json({ error: 'Failed to update voice' });
  }
}

export async function activateCharacter(req, res) {
  try {
    const character = await Character.findById(req.params.id);
    if (!character) return res.status(404).json({ error: 'Character not found' });
    await Settings.findOneAndUpdate({}, { activeCharacterId: character._id }, { upsert: true });
    res.json({ activeCharacterId: character._id });
  } catch (err) {
    console.error('[activateCharacter]', err);
    res.status(500).json({ error: 'Failed to activate character' });
  }
}
