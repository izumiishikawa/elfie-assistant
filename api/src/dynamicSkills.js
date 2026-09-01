import Skill from './models/Skill.js';
import SkillPackage from './models/SkillPackage.js';

const METHODS_WITH_BODY = ['POST', 'PUT', 'PATCH', 'DELETE'];

const SCALAR_PARAM_TYPES = new Set(['number', 'boolean']);

export function buildToolSchema(skill) {
  const properties = {};
  const required = [];
  for (const p of skill.params ?? []) {
    if (!p.name) continue;
    const description = p.description || `The "${p.name}" parameter.`;
    if (p.type === 'array') {
      properties[p.name] = { type: 'array', items: {}, description };
    } else if (p.type === 'object') {
      properties[p.name] = { type: 'object', description };
    } else {
      properties[p.name] = { type: SCALAR_PARAM_TYPES.has(p.type) ? p.type : 'string', description };
    }
    if (p.required) required.push(p.name);
  }
  return {
    type: 'function',
    function: {
      name: skill.name,
      description: skill.description || '',
      parameters: {
        type: 'object',
        properties,
        ...(required.length ? { required } : {}),
      },
    },
  };
}

function buildOpenerToolSchema(pkg) {
  return {
    type: 'function',
    function: {
      name: `open_pkg_${pkg.name}`,
      description: pkg.description || `Abre o pacote de skills "${pkg.name}" e revela as skills disponíveis nele.`,
      parameters: { type: 'object', properties: {} },
    },
  };
}

export async function loadSkillToolState() {
  const [packages, skills] = await Promise.all([
    SkillPackage.find().sort({ _id: 1 }).lean(),
    Skill.find({ enabled: true }).sort({ _id: 1 }).lean(),
  ]);

  const imageSkillNames = new Set(skills.filter((s) => s.responseMode === 'image').map((s) => s.name));

  const skillsByPackage = new Map();
  const ungrouped = [];
  const alwaysVisible = [];
  for (const skill of skills) {
    if (skill.alwaysVisible) {
      alwaysVisible.push(skill);
    } else if (skill.packageId) {
      const key = String(skill.packageId);
      if (!skillsByPackage.has(key)) skillsByPackage.set(key, []);
      skillsByPackage.get(key).push(skill);
    } else {
      ungrouped.push(skill);
    }
  }

  const packageEntries = packages
    .map((pkg) => {
      const pkgSkills = skillsByPackage.get(String(pkg._id)) ?? [];
      if (pkgSkills.length === 0) return null;
      return {
        id: String(pkg._id),
        openerTool: buildOpenerToolSchema(pkg),
        skillTools: pkgSkills.map(buildToolSchema),
      };
    })
    .filter(Boolean);

  return {
    ungroupedTools: ungrouped.map(buildToolSchema),
    alwaysVisibleTools: alwaysVisible.map(buildToolSchema),
    packages: packageEntries,
    imageSkillNames,
  };
}

function dropImageTools(tools, imageSkillNames) {
  return tools.filter((t) => !imageSkillNames.has(t.function.name));
}

export function alwaysVisibleDynamicTools(state, { excludeImage = false } = {}) {
  const tools = state?.alwaysVisibleTools ?? [];
  return excludeImage ? dropImageTools(tools, state?.imageSkillNames ?? new Set()) : tools;
}

export function visibleDynamicTools(state, openedPackageIds, { excludeImage = false } = {}) {
  if (!state) return [];
  const packaged = state.packages.flatMap((p) =>
    openedPackageIds.has(p.id) ? p.skillTools : [p.openerTool],
  );
  const tools = [...state.alwaysVisibleTools, ...state.ungroupedTools, ...packaged];
  return excludeImage ? dropImageTools(tools, state.imageSkillNames) : tools;
}

function basicAuthHeader(value) {
  return `Basic ${Buffer.from(value).toString('base64')}`;
}

export async function runSkill(skill, args = {}) {
  const params = skill.params ?? [];

  const missing = params
    .filter((p) => p.required && (args[p.name] === undefined || args[p.name] === '' || args[p.name] === null))
    .map((p) => p.name);
  if (missing.length) {
    return { ok: false, status: 0, durationMs: 0, body: `Missing required parameter(s): ${missing.join(', ')}` };
  }

  let url = skill.urlTemplate;
  for (const p of params.filter((p) => p.in === 'path')) {
    if (args[p.name] === undefined) continue;
    url = url.replace(`{${p.name}}`, encodeURIComponent(String(args[p.name])));
  }

  const queryParams = params.filter((p) => p.in === 'query' && args[p.name] !== undefined);
  if (queryParams.length) {
    const usp = new URLSearchParams();
    for (const p of queryParams) usp.append(p.name, String(args[p.name]));
    url += (url.includes('?') ? '&' : '?') + usp.toString();
  }

  const headers = {};
  for (const h of skill.headers ?? []) {
    if (h.key) headers[h.key] = h.value ?? '';
  }
  for (const p of params.filter((p) => p.in === 'header' && args[p.name] !== undefined)) {
    headers[p.name] = String(args[p.name]);
  }

  if (skill.authType === 'bearer' && skill.authValue) {
    headers.Authorization = `Bearer ${skill.authValue}`;
  } else if (skill.authType === 'apiKeyHeader' && skill.authValue) {
    headers[skill.authHeaderName || 'X-API-Key'] = skill.authValue;
  } else if (skill.authType === 'basic' && skill.authValue) {
    headers.Authorization = basicAuthHeader(skill.authValue);
  }

  const bodyParams = params.filter((p) => p.in === 'body' && args[p.name] !== undefined);
  let body;
  if (bodyParams.length && METHODS_WITH_BODY.includes(skill.method)) {
    const obj = {};
    for (const p of bodyParams) {
      let value = args[p.name];
      if (skill.stripEmDash && typeof value === 'string') {
        value = value.replace(/\s*[—–]\s*/g, ', ').replace(/,\s*,/g, ',');
      }
      obj[p.name] = value;
    }
    body = JSON.stringify(obj);
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  }

  const timeoutMs = skill.timeoutMs || 15000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, { method: skill.method, headers, body, signal: controller.signal });
    const durationMs = Date.now() - started;
    const buffer = Buffer.from(await res.arrayBuffer());
    const text = buffer.toString('utf8');
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch {
    }
    const bodyOut = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
    return {
      ok: res.ok,
      status: res.status,
      durationMs,
      body: bodyOut,
      buffer,
      contentType: res.headers.get('content-type') ?? '',
    };
  } catch (err) {
    const durationMs = Date.now() - started;
    const message = err.name === 'AbortError' ? `Timed out after ${timeoutMs}ms` : err.message;
    return { ok: false, status: 0, durationMs, body: message };
  } finally {
    clearTimeout(timeout);
  }
}
