import SkillPackage from '../models/SkillPackage.js';
import Skill from '../models/Skill.js';

const NAME_RE = /^[a-z0-9_]+$/;

export async function listSkillPackages(_req, res) {
  try {
    const packages = await SkillPackage.find().sort({ createdAt: 1 });
    res.json(packages);
  } catch (err) {
    console.error('[listSkillPackages]', err);
    res.status(500).json({ error: 'Failed to list skill packages' });
  }
}

export async function createSkillPackage(req, res) {
  try {
    const { name, description } = req.body;
    const trimmedName = (name ?? '').trim();
    if (!trimmedName || !NAME_RE.test(trimmedName)) {
      return res.status(400).json({ error: 'Nome inválido — use apenas letras minúsculas, números e "_".' });
    }
    if (await SkillPackage.findOne({ name: trimmedName })) {
      return res.status(409).json({ error: 'Já existe um pacote com esse nome.' });
    }
    const pkg = await SkillPackage.create({ name: trimmedName, description: description || '' });
    res.status(201).json(pkg);
  } catch (err) {
    console.error('[createSkillPackage]', err);
    res.status(500).json({ error: 'Failed to create skill package' });
  }
}

export async function updateSkillPackage(req, res) {
  try {
    const { name, description } = req.body;
    const patch = {};
    if (name !== undefined) {
      const trimmedName = name.trim();
      if (!trimmedName || !NAME_RE.test(trimmedName)) {
        return res.status(400).json({ error: 'Nome inválido — use apenas letras minúsculas, números e "_".' });
      }
      if (await SkillPackage.findOne({ name: trimmedName, _id: { $ne: req.params.id } })) {
        return res.status(409).json({ error: 'Já existe um pacote com esse nome.' });
      }
      patch.name = trimmedName;
    }
    if (description !== undefined) patch.description = description;

    const pkg = await SkillPackage.findByIdAndUpdate(req.params.id, { $set: patch }, { new: true });
    if (!pkg) return res.status(404).json({ error: 'Skill package not found' });
    res.json(pkg);
  } catch (err) {
    console.error('[updateSkillPackage]', err);
    res.status(500).json({ error: 'Failed to update skill package' });
  }
}

export async function deleteSkillPackage(req, res) {
  try {
    const pkg = await SkillPackage.findById(req.params.id);
    if (!pkg) return res.status(404).json({ error: 'Skill package not found' });
    await Skill.updateMany({ packageId: pkg._id }, { packageId: null });
    await SkillPackage.findByIdAndDelete(req.params.id);
    res.json({ message: 'Deleted' });
  } catch (err) {
    console.error('[deleteSkillPackage]', err);
    res.status(500).json({ error: 'Failed to delete skill package' });
  }
}
