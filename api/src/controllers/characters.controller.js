import { randomBytes } from 'crypto';
import { readFile, writeFile } from 'fs/promises';
import { basename, resolve, dirname } from 'path';
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

// Campos que viajam num arquivo de personagem. Memórias, resumos de chat e os dados
// do usuário ficam de fora de propósito: o arquivo descreve a persona, não o histórico.
const PORTABLE_FIELDS = [
  'name', 'personality', 'model', 'voiceId', 'greatSageWarnings',
  'inworldRealtimeEnabled', 'inworldVoice', 'inworldLLMModel',
];
const EXPORT_FORMAT = 'elfie.character';
const EXPORT_VERSION = 1;

const asString = (v) => (typeof v === 'string' ? v : '');

// "Elfie" -> "Elfie (2)" quando já existe alguém com o mesmo nome.
async function uniqueName(name) {
  const taken = new Set((await Character.find({}, 'name').lean()).map((c) => c.name));
  if (!taken.has(name)) return name;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${name} (${i})`;
    if (!taken.has(candidate)) return candidate;
  }
  return name;
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
    const {
      name, personality, model, photoBase64, voiceId, greatSageWarnings,
      inworldRealtimeEnabled, inworldVoice, inworldLLMModel,
    } = req.body;
    const data = { name: name || 'Novo personagem', personality: personality || '', model: model || '' };
    if (voiceId !== undefined) data.voiceId = voiceId;
    if (greatSageWarnings !== undefined) data.greatSageWarnings = !!greatSageWarnings;
    if (inworldRealtimeEnabled !== undefined) data.inworldRealtimeEnabled = !!inworldRealtimeEnabled;
    if (inworldVoice !== undefined) data.inworldVoice = inworldVoice;
    if (inworldLLMModel !== undefined) data.inworldLLMModel = inworldLLMModel;
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
    const {
      name, personality, model, photoBase64, voiceId, userName, userBasicData, longTermMemory, greatSageWarnings,
      inworldRealtimeEnabled, inworldVoice, inworldLLMModel,
    } = req.body;
    const patch = {};
    if (name !== undefined) patch.name = name;
    if (personality !== undefined) patch.personality = personality;
    if (model !== undefined) patch.model = model;
    if (photoBase64) patch.photo = await saveBase64(photoBase64);
    if (voiceId !== undefined) patch.voiceId = voiceId;
    if (greatSageWarnings !== undefined) patch.greatSageWarnings = !!greatSageWarnings;
    if (inworldRealtimeEnabled !== undefined) patch.inworldRealtimeEnabled = !!inworldRealtimeEnabled;
    if (inworldVoice !== undefined) patch.inworldVoice = inworldVoice;
    if (inworldLLMModel !== undefined) patch.inworldLLMModel = inworldLLMModel;
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

export async function exportCharacter(req, res) {
  try {
    const character = await Character.findById(req.params.id).lean();
    if (!character) return res.status(404).json({ error: 'Character not found' });

    const payload = {};
    for (const field of PORTABLE_FIELDS) payload[field] = character[field];
    payload.greatSageWarnings = character.greatSageWarnings !== false;
    payload.inworldRealtimeEnabled = !!character.inworldRealtimeEnabled;
    payload.photoBase64 = '';

    if (character.photo) {
      try {
        const buf = await readFile(resolve(uploadDir, basename(character.photo)));
        payload.photoBase64 = buf.toString('base64');
      } catch (err) {
        console.warn('[exportCharacter] foto não encontrada:', character.photo, err.message);
      }
    }

    res.json({
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      character: payload,
    });
  } catch (err) {
    console.error('[exportCharacter]', err);
    res.status(500).json({ error: 'Failed to export character' });
  }
}

export async function importCharacter(req, res) {
  try {
    // Aceita tanto o arquivo inteiro ({ format, character }) quanto só o objeto do personagem.
    const file = req.body?.character && typeof req.body.character === 'object' ? req.body : { character: req.body };
    const src = file.character;
    if (!src || typeof src !== 'object' || Array.isArray(src)) {
      return res.status(400).json({ error: 'Invalid character file' });
    }
    if (file.format && file.format !== EXPORT_FORMAT) {
      return res.status(400).json({ error: 'This file is not an elfie character export' });
    }
    if (Number(file.version) > EXPORT_VERSION) {
      return res.status(400).json({ error: 'This file was exported by a newer version of elfie' });
    }

    const rawName = asString(src.name).trim();
    const data = {
      name: await uniqueName(rawName || 'Imported character'),
      personality: asString(src.personality),
      model: asString(src.model),
      voiceId: asString(src.voiceId).trim(),
      greatSageWarnings: src.greatSageWarnings !== false,
      inworldRealtimeEnabled: !!src.inworldRealtimeEnabled,
      inworldVoice: asString(src.inworldVoice),
      inworldLLMModel: asString(src.inworldLLMModel),
    };

    const photoBase64 = asString(src.photoBase64).replace(/^data:image\/[a-z+]+;base64,/i, '');
    if (photoBase64) data.photo = await saveBase64(photoBase64);

    const character = await Character.create(data);

    const count = await Character.countDocuments();
    if (count === 1) {
      await Settings.findOneAndUpdate({}, { activeCharacterId: character._id }, { upsert: true });
    }

    res.status(201).json(sanitiseChar(character));
  } catch (err) {
    console.error('[importCharacter]', err);
    res.status(500).json({ error: 'Failed to import character' });
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
