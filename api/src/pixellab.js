import { writeFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const uploadDir = resolve(__dirname, '..', 'uploads');
const BASE = 'https://api.pixellab.ai/v2';

function headers() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.PIXELLAB_API_KEY}`,
  };
}

function log(fn, ...args) {
  console.log(`\n[pixellab:${fn}]`, ...args);
}

function getImageDimensions(buffer) {
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  return { width: 400, height: 400 };
}

function toBase64Obj(buffer, filename) {
  const ext = filename?.split('.').pop()?.toLowerCase() ?? 'png';
  const formatMap = { jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif', webp: 'webp' };
  const format = formatMap[ext] ?? 'png';
  return { type: 'base64', base64: buffer.toString('base64'), format };
}

async function saveBase64(base64String) {
  const raw = base64String.includes(',') ? base64String.split(',')[1] : base64String;
  const filename = `pixelart-${randomBytes(12).toString('hex')}.png`;
  await writeFile(resolve(uploadDir, filename), Buffer.from(raw, 'base64'));
  return filename;
}

async function pollJob(jobId, label, maxWaitMs = 120000) {
  const start = Date.now();
  let attempt = 0;
  log(label, `polling job ${jobId}`);
  while (Date.now() - start < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 3000));
    attempt++;
    const res = await fetch(`${BASE}/background-jobs/${jobId}`, { headers: headers() });
    if (!res.ok) {
      const body = await res.text().catch(() => res.status.toString());
      console.error(`[pixellab:${label}] poll #${attempt} HTTP ${res.status}:`, body);
      throw new Error(`Poll failed: ${res.status} ${body}`);
    }
    const data = await res.json();
    log(label, `poll #${attempt} → status=${data.status}`);
    if (data.status === 'completed') return data;
    if (data.status === 'failed') {
      console.error(`[pixellab:${label}] job failed:`, JSON.stringify(data));
      throw new Error(`PixelLab job failed: ${JSON.stringify(data.error ?? data)}`);
    }
  }
  throw new Error(`PixelLab job timed out after ${maxWaitMs}ms`);
}

async function pixellabPost(path, body) {
  log(path, 'POST →', JSON.stringify({
    ...body,
    image: body.image ? { ...body.image, base64: `<${body.image.base64?.length ?? 0} chars>` } : undefined,
    style_images: body.style_images?.map((si) => ({
      ...si,
      image: { ...si.image, base64: `<${si.image?.base64?.length ?? 0} chars>` },
    })),
    reference_images: body.reference_images?.map((ri) => ({
      ...ri,
      image: { ...ri.image, base64: `<${ri.image?.base64?.length ?? 0} chars>` },
    })),
    style_image: body.style_image ? {
      ...body.style_image,
      image: { ...body.style_image.image, base64: `<${body.style_image.image?.base64?.length ?? 0} chars>` },
    } : undefined,
  }));

  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });

  const responseText = await res.text();
  log(path, `← HTTP ${res.status}:`, responseText.slice(0, 500));

  if (!res.ok) {
    throw new Error(`PixelLab ${path} error ${res.status}: ${responseText}`);
  }

  return JSON.parse(responseText);
}

export async function generatePixelArt(description, width = 64, height = 64) {
  log('generatePixelArt', `"${description}" ${width}x${height}`);
  const data = await pixellabPost('/create-image-pixflux', {
    description,
    image_size: { width, height },
  });
  if (!data.image?.base64) {
    console.error('[pixellab:generatePixelArt] unexpected response:', JSON.stringify(data));
    throw new Error('No image in response');
  }
  const filename = await saveBase64(data.image.base64);
  log('generatePixelArt', `saved → ${filename}`);
  return filename;
}

export async function convertToPixelArt(buffer, filename, outputWidth = 64, outputHeight = 64) {
  const { width, height } = getImageDimensions(buffer);
  log('convertToPixelArt', `input=${filename} dims=${width}x${height} output=${outputWidth}x${outputHeight}`);
  const data = await pixellabPost('/image-to-pixelart', {
    image: toBase64Obj(buffer, filename),
    image_size: { width: Math.min(width, 512), height: Math.min(height, 512) },
    output_size: { width: outputWidth, height: outputHeight },
  });
  if (!data.image?.base64) {
    console.error('[pixellab:convertToPixelArt] unexpected response:', JSON.stringify(data));
    throw new Error('No image in response');
  }
  const result = await saveBase64(data.image.base64);
  log('convertToPixelArt', `saved → ${result}`);
  return result;
}

export async function convertToPixelArtPro(buffer, filename, description = '') {
  const { width, height } = getImageDimensions(buffer);
  log('convertToPixelArtPro', `input=${filename} dims=${width}x${height} description="${description}"`);
  const body = { image: toBase64Obj(buffer, filename) };
  if (description.trim()) body.description = description.trim();
  const data = await pixellabPost('/image-to-pixelart-pro', body);
  if (!data.background_job_id) {
    console.error('[pixellab:convertToPixelArtPro] no job id in response:', JSON.stringify(data));
    throw new Error('No job ID in response');
  }
  const result = await pollJob(data.background_job_id, 'convertToPixelArtPro');
  log('convertToPixelArtPro', 'job completed, full response keys:', Object.keys(result));
  const img = result.last_response?.image ?? result.image;
  if (!img?.base64) {
    console.error('[pixellab:convertToPixelArtPro] no image in result:', JSON.stringify(result).slice(0, 500));
    throw new Error('No image in job result');
  }
  const saved = await saveBase64(img.base64);
  log('convertToPixelArtPro', `saved → ${saved}`);
  return saved;
}

export async function removeBackground(buffer, filename, complex = false) {
  const { width, height } = getImageDimensions(buffer);
  const task = complex ? 'remove_complex_background' : 'remove_simple_background';
  log('removeBackground', `input=${filename} dims=${width}x${height} task=${task}`);
  const data = await pixellabPost('/remove-background', {
    image: toBase64Obj(buffer, filename),
    image_size: { width: Math.min(width, 512), height: Math.min(height, 512) },
    background_removal_task: task,
  });
  if (!data.image?.base64) {
    console.error('[pixellab:removeBackground] unexpected response:', JSON.stringify(data));
    throw new Error('No image in response');
  }
  const result = await saveBase64(data.image.base64);
  log('removeBackground', `saved → ${result}`);
  return result;
}

export async function generateWithStyle(buffers, filenames, description, width = 64, height = 64) {
  log('generateWithStyle', `refs=[${filenames.join(', ')}] output=${width}x${height} description="${description}"`);
  const style_images = buffers.map((buf, i) => {
    const { width: w, height: h } = getImageDimensions(buf);
    log('generateWithStyle', `  ref[${i}] ${filenames[i]} → detected ${w}x${h}, capped to ${Math.min(w,512)}x${Math.min(h,512)}`);
    return {
      image: toBase64Obj(buf, filenames[i]),
      width: Math.min(w, 512),
      height: Math.min(h, 512),
    };
  });
  const data = await pixellabPost('/generate-with-style-v2', {
    style_images,
    description,
    image_size: { width, height },
  });
  if (!data.background_job_id) {
    console.error('[pixellab:generateWithStyle] no job id:', JSON.stringify(data));
    throw new Error('No job ID in response');
  }
  const result = await pollJob(data.background_job_id, 'generateWithStyle');
  log('generateWithStyle', 'job completed, response keys:', Object.keys(result));
  const payload = result.last_response ?? result;
  log('generateWithStyle', 'payload keys:', Object.keys(payload));
  const imgs = payload.images ?? (payload.image ? [payload.image] : []);
  log('generateWithStyle', `found ${imgs.length} image(s)`);
  if (imgs.length === 0) {
    console.error('[pixellab:generateWithStyle] full payload:', JSON.stringify(payload).slice(0, 1000));
    throw new Error('No images in job result');
  }
  const saved = await Promise.all(imgs.map((img) => saveBase64(img.base64)));
  log('generateWithStyle', `saved → [${saved.join(', ')}]`);
  return saved;
}

export async function generateImagePro(
  description,
  width = 64,
  height = 64,
  referenceBuffers = [],
  referenceFilenames = [],
  styleBuffer = null,
  styleFilename = null,
) {
  log('generateImagePro', `"${description}" ${width}x${height} refs=[${referenceFilenames.join(', ')}] style=${styleFilename ?? 'none'}`);
  const body = { description, image_size: { width, height }, no_background: true };

  if (referenceBuffers.length > 0) {
    body.reference_images = referenceBuffers.slice(0, 4).map((buf, i) => {
      const { width: w, height: h } = getImageDimensions(buf);
      log('generateImagePro', `  ref[${i}] ${referenceFilenames[i]} → ${w}x${h}`);
      return {
        image: toBase64Obj(buf, referenceFilenames[i]),
        size: { width: Math.min(w, 1024), height: Math.min(h, 1024) },
      };
    });
  }

  if (styleBuffer) {
    const { width: sw, height: sh } = getImageDimensions(styleBuffer);
    log('generateImagePro', `  style ${styleFilename} → ${sw}x${sh}`);
    body.style_image = {
      image: toBase64Obj(styleBuffer, styleFilename),
      size: { width: Math.min(sw, 1024), height: Math.min(sh, 1024) },
    };
  }

  const data = await pixellabPost('/generate-image-v2', body);
  if (!data.background_job_id) {
    console.error('[pixellab:generateImagePro] no job id:', JSON.stringify(data));
    throw new Error('No job ID in response');
  }
  const result = await pollJob(data.background_job_id, 'generateImagePro');
  log('generateImagePro', 'job completed, response keys:', Object.keys(result));
  const payload = result.last_response ?? result;
  log('generateImagePro', 'payload keys:', Object.keys(payload));
  const imgs = payload.images ?? (payload.image ? [payload.image] : []);
  log('generateImagePro', `found ${imgs.length} image(s)`);
  if (imgs.length === 0) {
    console.error('[pixellab:generateImagePro] full payload:', JSON.stringify(payload).slice(0, 1000));
    throw new Error('No images in generate-image-v2 result');
  }
  const saved = await Promise.all(imgs.map((img) => saveBase64(img.base64)));
  log('generateImagePro', `saved → [${saved.join(', ')}]`);
  return saved;
}
