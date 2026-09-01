import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { execFile } from "child_process";

export const AGENT_SKILLS_DIR = join(homedir(), ".claude", "skills");

const MAX_SKILL_BODY_CHARS = 12000;

function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { name: "", description: "", body: raw.trim() };
  const [, front, body] = match;
  const strip = (s) => (s ?? "").trim().replace(/^["']|["']$/g, "");
  return {
    name: strip(front.match(/^name:\s*(.+)$/m)?.[1]),
    description: strip(front.match(/^description:\s*(.+)$/m)?.[1]),
    body: body.trim(),
  };
}

async function scanSkillDirs() {
  let entries;
  try {
    entries = await readdir(AGENT_SKILLS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const results = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    try {
      const raw = await readFile(join(AGENT_SKILLS_DIR, entry.name, "SKILL.md"), "utf-8");
      const parsed = parseFrontmatter(raw);
      results.push({ dir: entry.name, name: parsed.name || entry.name, description: parsed.description, body: parsed.body });
    } catch {
    }
  }
  return results;
}

export async function listAgentSkills() {
  const skills = await scanSkillDirs();
  return skills.map(({ name, description }) => ({ name, description: description || "(sem descrição)" }));
}

export async function readAgentSkillBody(skillName) {
  const skills = await scanSkillDirs();
  const match = skills.find((s) => s.name.toLowerCase() === skillName.trim().toLowerCase());
  if (!match) return null;
  return match.body.length > MAX_SKILL_BODY_CHARS
    ? `${match.body.slice(0, MAX_SKILL_BODY_CHARS)}\n\n[...instruções truncadas, skill maior que o limite]`
    : match.body;
}

function execFileAsync(file, args, opts) {
  return new Promise((resolvePromise) => {
    execFile(file, args, opts, (err, stdout, stderr) => {
      resolvePromise({ err, stdout: stdout?.trim() ?? "", stderr: stderr?.trim() ?? "" });
    });
  });
}

export async function installAgentSkill(source, skillFilter) {
  const args = ["-y", "skills", "add", source, "--agent", "claude-code", "--global", "-y"];
  if (skillFilter) args.push("--skill", skillFilter);
  const { err, stdout, stderr } = await execFileAsync("npx", args, {
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  if (err && !stdout && !stderr) return `Install failed: ${err.message}`;
  const parts = [];
  if (stdout) parts.push(stdout);
  if (stderr) parts.push(`[stderr]\n${stderr}`);
  if (err) parts.push(`[exit ${err.code ?? 1}]`);
  return parts.join("\n") || "(no output)";
}
