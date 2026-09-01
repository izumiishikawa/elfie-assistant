import { writeFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const uploadDir = resolve(__dirname, '..', 'uploads');
const BASE = 'https://openrouter.ai/api/v1';

const MODELS = {
  flash: 'google/gemini-3.1-flash-image',
  pro: 'google/gemini-3-pro-image-preview',
};

const MIME_MAP = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

function mimeFromFilename(filename) {
  const ext = filename?.split('.').pop()?.toLowerCase() ?? 'png';
  return MIME_MAP[ext] ?? 'image/png';
}

function extFromMediaType(mediaType) {
  if (mediaType?.includes('png')) return 'png';
  if (mediaType?.includes('webp')) return 'webp';
  return 'jpg';
}

function log(fn, ...args) {
  console.log(`\n[nanoBanana:${fn}]`, ...args);
}

async function saveImage(b64Json, mediaType) {
  const raw = b64Json.includes(',') ? b64Json.split(',')[1] : b64Json;
  const filename = `nanobanana-${randomBytes(12).toString('hex')}.${extFromMediaType(mediaType)}`;
  await writeFile(resolve(uploadDir, filename), Buffer.from(raw, 'base64'));
  return filename;
}

async function createImage(model, prompt, inputReferences, aspectRatio) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set');

  const body = {
    model,
    prompt,
    ...(aspectRatio && { aspect_ratio: aspectRatio }),
    ...(inputReferences?.length > 0 && { input_references: inputReferences }),
  };

  log('createImage', model, `"${prompt.slice(0, 80)}"`, aspectRatio ?? '', `refs=${inputReferences?.length ?? 0}`);

  const res = await fetch(`${BASE}/images`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': process.env.APP_URL ?? 'http://localhost:3000',
      'X-Title': 'Elfie',
    },
    body: JSON.stringify(body),
  });

  const responseText = await res.text();
  if (!res.ok) {
    console.error(`[nanoBanana] HTTP ${res.status}:`, responseText.slice(0, 500));
    throw new Error(`Nano Banana error ${res.status}: ${responseText.slice(0, 300)}`);
  }

  const data = JSON.parse(responseText);
  if (data.usage?.cost !== undefined) {
    log('createImage', `cost: $${data.usage.cost}`);
  }
  const images = data.data ?? [];
  if (images.length === 0) {
    console.error('[nanoBanana] no image in response:', responseText.slice(0, 500));
    throw new Error('No image returned by Nano Banana');
  }
  return images;
}

export async function generateImage(description, { pro = false, aspectRatio } = {}) {
  log('generateImage', description, pro ? 'pro' : 'flash', aspectRatio ?? '');
  const images = await createImage(pro ? MODELS.pro : MODELS.flash, description, null, aspectRatio);
  const saved = await Promise.all(images.map((img) => saveImage(img.b64_json, img.media_type)));
  log('generateImage', `saved → [${saved.join(', ')}]`);
  return saved;
}

export async function editImage(description, buffers, filenames, { pro = false, aspectRatio } = {}) {
  log('editImage', description, `refs=[${filenames.join(', ')}]`, pro ? 'pro' : 'flash');
  const inputReferences = buffers.map((buf, i) => ({
    type: 'image_url',
    image_url: { url: `data:${mimeFromFilename(filenames[i])};base64,${buf.toString('base64')}` },
  }));
  const images = await createImage(pro ? MODELS.pro : MODELS.flash, description, inputReferences, aspectRatio);
  const saved = await Promise.all(images.map((img) => saveImage(img.b64_json, img.media_type)));
  log('editImage', `saved → [${saved.join(', ')}]`);
  return saved;
}
