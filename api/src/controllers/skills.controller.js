import Skill from '../models/Skill.js';
import { runSkill } from '../dynamicSkills.js';

const NAME_RE = /^[a-z0-9_]+$/;

function sanitiseSkill(doc) {
  const obj = doc.toObject ? doc.toObject() : { ...doc };
  const hasAuthValue = !!obj.authValue;
  delete obj.authValue;
  return { ...obj, hasAuthValue };
}

export async function listSkills(_req, res) {
  try {
    const skills = await Skill.find().select('+authValue').sort({ createdAt: 1 });
    res.json(skills.map(sanitiseSkill));
  } catch (err) {
    console.error('[listSkills]', err);
    res.status(500).json({ error: 'Failed to list skills' });
  }
}

export async function createSkill(req, res) {
  try {
    const {
      name, description, packageId, method, urlTemplate,
      authType, authHeaderName, authValue,
      headers, params, timeoutMs, enabled, requiresConfirmation, alwaysVisible,
      responseMode, imageUrlField,
    } = req.body;

    const trimmedName = (name ?? '').trim();
    if (!trimmedName || !NAME_RE.test(trimmedName)) {
      return res.status(400).json({ error: 'Nome inválido — use apenas letras minúsculas, números e "_".' });
    }
    if (!urlTemplate?.trim()) {
      return res.status(400).json({ error: 'URL obrigatória.' });
    }
    if (await Skill.findOne({ name: trimmedName })) {
      return res.status(409).json({ error: 'Já existe uma skill com esse nome.' });
    }

    const skill = await Skill.create({
      name: trimmedName,
      description: description || '',
      packageId: packageId || null,
      method: method || 'GET',
      urlTemplate: urlTemplate.trim(),
      authType: authType || 'none',
      authHeaderName: authHeaderName || '',
      authValue: authValue || '',
      headers: Array.isArray(headers) ? headers : [],
      params: Array.isArray(params) ? params : [],
      timeoutMs: timeoutMs || 15000,
      enabled: enabled !== undefined ? !!enabled : true,
      requiresConfirmation: !!requiresConfirmation,
      alwaysVisible: !!alwaysVisible,
      responseMode: responseMode === 'image' ? 'image' : 'text',
      imageUrlField: imageUrlField || '',
    });
    res.status(201).json(sanitiseSkill(await Skill.findById(skill._id).select('+authValue')));
  } catch (err) {
    console.error('[createSkill]', err);
    res.status(500).json({ error: 'Failed to create skill' });
  }
}

export async function updateSkill(req, res) {
  try {
    const {
      name, description, packageId, method, urlTemplate,
      authType, authHeaderName, authValue,
      headers, params, timeoutMs, enabled, requiresConfirmation, alwaysVisible,
      responseMode, imageUrlField,
    } = req.body;

    const patch = {};
    if (name !== undefined) {
      const trimmedName = name.trim();
      if (!trimmedName || !NAME_RE.test(trimmedName)) {
        return res.status(400).json({ error: 'Nome inválido — use apenas letras minúsculas, números e "_".' });
      }
      if (await Skill.findOne({ name: trimmedName, _id: { $ne: req.params.id } })) {
        return res.status(409).json({ error: 'Já existe uma skill com esse nome.' });
      }
      patch.name = trimmedName;
    }
    if (description !== undefined) patch.description = description;
    if (packageId !== undefined) patch.packageId = packageId || null;
    if (method !== undefined) patch.method = method;
    if (urlTemplate !== undefined) patch.urlTemplate = urlTemplate.trim();
    if (authType !== undefined) patch.authType = authType;
    if (authHeaderName !== undefined) patch.authHeaderName = authHeaderName;
    if (authValue) patch.authValue = authValue;
    if (headers !== undefined) patch.headers = headers;
    if (params !== undefined) patch.params = params;
    if (timeoutMs !== undefined) patch.timeoutMs = timeoutMs;
    if (enabled !== undefined) patch.enabled = !!enabled;
    if (requiresConfirmation !== undefined) patch.requiresConfirmation = !!requiresConfirmation;
    if (alwaysVisible !== undefined) patch.alwaysVisible = !!alwaysVisible;
    if (responseMode !== undefined) patch.responseMode = responseMode === 'image' ? 'image' : 'text';
    if (imageUrlField !== undefined) patch.imageUrlField = imageUrlField;

    const skill = await Skill.findByIdAndUpdate(req.params.id, { $set: patch }, { new: true }).select('+authValue');
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    res.json(sanitiseSkill(skill));
  } catch (err) {
    console.error('[updateSkill]', err);
    res.status(500).json({ error: 'Failed to update skill' });
  }
}

export async function deleteSkill(req, res) {
  try {
    const skill = await Skill.findByIdAndDelete(req.params.id);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    res.json({ message: 'Deleted' });
  } catch (err) {
    console.error('[deleteSkill]', err);
    res.status(500).json({ error: 'Failed to delete skill' });
  }
}

export async function testSkill(req, res) {
  try {
    const skill = await Skill.findById(req.params.id).select('+authValue');
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    const result = await runSkill(skill, req.body?.sampleArgs || {});
    res.json(result);
  } catch (err) {
    console.error('[testSkill]', err);
    res.status(500).json({ error: 'Failed to test skill' });
  }
}
