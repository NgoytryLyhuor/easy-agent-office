// Routing Gemini <-> Claude (alterego) + Coda di ripresa post-riposo e lettura da agents.config.json
const fs = require('fs');
const path = require('path');

const DEFAULT_PRIMARY = {
  10: '00000000-0000-4000-8000-000000000010', // Alberto (CEO) — esegui `node setup-agents.js` per generare i tuoi UUID
  6:  '00000000-0000-4000-8000-000000000006', // Luigi (Backend)
  7:  '00000000-0000-4000-8000-000000000007', // Gabri (Frontend)
  8:  '00000000-0000-4000-8000-000000000008'  // Carlo (QA)
};

const DEFAULT_ALTEREGO = {
  10: '00000000-0000-4000-9000-000000000010', // alberto-ceo-alterego
  6:  '00000000-0000-4000-9000-000000000006', // luigi-backend-alterego
  7:  '00000000-0000-4000-9000-000000000007', // gabri-frontend-alterego
  8:  '00000000-0000-4000-9000-000000000008'  // carlo-revisor-alterego
};

let PRIMARY = { ...DEFAULT_PRIMARY };
let ALTEREGO = { ...DEFAULT_ALTEREGO };
let PARENT_SESSION = null;

try {
  const cfgPath = path.join(__dirname, 'agents.config.json');
  if (fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (cfg.primary) {
      for (const [k, v] of Object.entries(cfg.primary)) if (v) PRIMARY[Number(k)] = v;
    }
    if (cfg.alterego) {
      for (const [k, v] of Object.entries(cfg.alterego)) if (v) ALTEREGO[Number(k)] = v;
    }
    if (cfg.parent) {
      PARENT_SESSION = String(cfg.parent).trim();
    }
  }
} catch (_) {}

const LAST_MODE_FILE = path.join(__dirname, '.last_announced_mode');
let lastDiskMode = null;
try {
  if (fs.existsSync(LAST_MODE_FILE)) {
    lastDiskMode = fs.readFileSync(LAST_MODE_FILE, 'utf8').trim() || null;
  }
} catch (_) {}

// Stati: 'gemini' (agenti primari) -> 'claude' (alterego) -> 'rest' (tutti a riposo)
const state = {
  claudeActive: false,
  mode: null,
  lastDiskMode,
  resumeAt: null,
  geminiResetAt: null,
  claudeResetAt: null,
  restQueue: [],
  targetProject: path.resolve(__dirname)
};

function getTargetProject() {
  return state.targetProject || path.resolve(__dirname);
}

function validateProjectPath(newPath) {
  const cleaned = String(newPath || '').trim().replace(/^["']|["']$/g, '');
  if (!cleaned) return { ok: false, error: 'Percorso vuoto' };
  if (cleaned.includes('\0')) return { ok: false, error: 'Caratteri non validi (null byte) nel percorso' };

  const resolved = path.resolve(cleaned);
  const parsed = path.parse(resolved);

  // Confinamento / Anti-Traversal: impedisce di impostare la root del filesystem come target
  if (resolved.toLowerCase() === parsed.root.toLowerCase()) {
    return { ok: false, error: 'Impossibile selezionare la directory radice come cartella di progetto' };
  }

  // Protezione percorsi di sistema critici (Windows / Linux / macOS)
  const isWin = process.platform === 'win32';
  // Windows e macOS usano di default filesystem case-insensitive (/ETC == /etc)
  const caseInsensitive = isWin || process.platform === 'darwin';
  const norm = p => caseInsensitive ? p.toLowerCase() : p;
  const cmp = norm(resolved);
  const forbidden = isWin ? [
    'c:\\windows',
    'c:\\program files',
    'c:\\program files (x86)',
    'c:\\programdata',
    'c:\\recovery',
    'c:\\$recycle.bin',
    'c:\\system volume information'
  ] : [
    '/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64', '/libx32',
    '/proc', '/root', '/sbin', '/sys', '/usr',
    '/System', '/Library', '/private'
  ];
  if (forbidden.map(norm).some(f => cmp === f || cmp.startsWith(f + path.sep))) {
    return { ok: false, error: 'Accesso negato: directory di sistema protetta' };
  }

  if (!fs.existsSync(resolved)) {
    return { ok: false, error: `Cartella non trovata: ${resolved}` };
  }

  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    return { ok: false, error: `Il percorso specificato non è una directory: ${resolved}` };
  }

  return { ok: true, projectPath: resolved, projectName: path.basename(resolved) };
}

function setTargetProject(newPath) {
  try {
    const val = validateProjectPath(newPath);
    if (!val.ok) return val;
    state.targetProject = val.projectPath;
    return val;
  } catch (err) {
    return { ok: false, error: `Errore validazione percorso: ${err.message}` };
  }
}

function updateMode({ g5h, gWeekly = 1, c5h, cWeekly, resumeAt, geminiResetAt, claudeResetAt }) {
  const prev = state.mode;
  const geminiLow = g5h < 0.02 || gWeekly < 0.02;
  const geminiOk = g5h > 0.10 && gWeekly > 0.05;
  const claudeLow = c5h < 0.02 || cWeekly < 0.02;
  const claudeOk = c5h > 0.02 && cWeekly > 0.02;
  const claudeRecovered = c5h > 0.10 && cWeekly > 0.10;
  let next = prev || 'gemini';
  if (geminiOk) next = 'gemini';
  else if (!prev || prev === 'gemini') {
    if (geminiLow) next = claudeOk ? 'claude' : 'rest';
  } else if (prev === 'claude') {
    if (claudeLow) next = 'rest';
  } else if (prev === 'rest') {
    if (claudeRecovered) next = 'claude';
  }
  if (typeof cWeekly === 'number' && typeof gWeekly === 'number' && cWeekly < 0.02 && gWeekly < 0.02) {
    next = 'rest';
  }
  state.mode = next;
  state.claudeActive = next === 'claude';
  state.resumeAt = next === 'rest' ? (resumeAt || state.resumeAt) : null;
  state.geminiResetAt = geminiResetAt || state.geminiResetAt;
  state.claudeResetAt = claudeResetAt || state.claudeResetAt;
  // Emetti changed=true SOLO quando avviene un vero cambio di stato tra modelli/riposo (mai al primo avvio del server 'init')
  let realChange = false;
  let effectivePrev = prev;
  if (prev) {
    realChange = (next !== prev);
  } else {
    if (state.lastDiskMode && next !== state.lastDiskMode) {
      realChange = true;
      effectivePrev = state.lastDiskMode;
    } else if (next !== 'gemini') {
      realChange = true;
      effectivePrev = state.lastDiskMode || 'gemini';
    } else {
      effectivePrev = 'init';
    }
  }
  return { mode: next, changed: realChange, prev: effectivePrev || 'init', isInit: !prev };
}

function getMode() { return state.mode || 'gemini'; }
function isResting() { return state.mode === 'rest'; }
function restMessage() {
  const gTime = state.geminiResetAt || 'N/A';
  const cTime = state.claudeResetAt || 'N/A';
  const nextWake = state.resumeAt || gTime;
  const qCount = state.restQueue.length;
  return `💤 Agenti a riposo per quota 5h esaurita. Prossimo risveglio automatico alle **${nextWake}** (🤖 Reset Gemini 5h: **${gTime}** | 🧠 Reset Claude 5h: **${cTime}**).${qCount > 0 ? ` 📥 Task in coda pronti a partire al risveglio: **${qCount}**.` : ''}`;
}

function enqueueRestTask(task) {
  state.restQueue.push({ ...task, queuedAt: new Date().toISOString() });
  return state.restQueue.length;
}

function flushRestQueue() {
  return state.restQueue.splice(0, state.restQueue.length);
}

function setClaudeActive(v) { state.claudeActive = !!v; }
function isClaudeActive() { return state.claudeActive; }
function resolveSubagent(agentId) {
  const id = Number(agentId) || 10;
  return (state.claudeActive ? ALTEREGO[id] : PRIMARY[id]) || PRIMARY[10];
}

function allSessionsMap() {
  const m = {};
  for (const [a, s] of Object.entries(PRIMARY)) m[s] = Number(a);
  for (const [a, s] of Object.entries(ALTEREGO)) m[s] = Number(a);
  return m;
}

// ====================================================================
// REGISTRO PROGETTI & MULTI-PROJECT SANDBOX (INNOVAZIONE #5)
// ====================================================================
const REGISTRY_FILE = path.join(__dirname, 'projects_registry.json');
const EXAMPLE_REGISTRY_FILE = path.join(__dirname, 'projects_registry.example.json');
const LEGACY_PROJECTS_FILE = path.join(__dirname, 'projects.json');

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'project';
}

function getGitInfo(projPath) {
  try {
    const gitDir = path.join(projPath, '.git');
    if (!fs.existsSync(gitDir)) return { isGit: false, branch: null };
    const headFile = path.join(gitDir, 'HEAD');
    if (fs.existsSync(headFile)) {
      const head = fs.readFileSync(headFile, 'utf8').trim();
      const branch = head.startsWith('ref: refs/heads/')
        ? head.replace('ref: refs/heads/', '')
        : (head.slice(0, 8) || 'detached');
      return { isGit: true, branch };
    }
    return { isGit: true, branch: 'unknown' };
  } catch {
    return { isGit: false, branch: null };
  }
}

function loadProjectsRegistry() {
  let rawList = [];
  try {
    if (fs.existsSync(REGISTRY_FILE)) {
      const data = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
      if (Array.isArray(data)) rawList = data;
    } else if (fs.existsSync(LEGACY_PROJECTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(LEGACY_PROJECTS_FILE, 'utf8'));
      if (Array.isArray(data)) rawList = data;
    } else if (fs.existsSync(EXAMPLE_REGISTRY_FILE)) {
      const data = JSON.parse(fs.readFileSync(EXAMPLE_REGISTRY_FILE, 'utf8'));
      if (Array.isArray(data)) rawList = data;
    }
  } catch (_) {}

  if (rawList.length === 0) {
    const rootPath = path.resolve(__dirname);
    const git = getGitInfo(rootPath);
    rawList = [
      {
        id: 'azienda-ai',
        name: 'AziendaAI',
        path: rootPath,
        branch: git.branch,
        isGit: git.isGit,
        lastActive: new Date().toISOString(),
        isDefault: true
      }
    ];
    saveProjectsRegistry(rawList);
  }

  // Normalizza e rinfresca metadati puliti { id, name, path, branch, isGit, lastActive, isDefault }
  return rawList.map(p => {
    const resolvedPath = path.resolve(p.path);
    const git = getGitInfo(resolvedPath);
    const projName = p.name || path.basename(resolvedPath) || 'Progetto';
    return {
      id: p.id || slugify(projName),
      name: projName,
      path: resolvedPath,
      branch: git.branch,
      isGit: git.isGit,
      lastActive: p.lastActive || new Date().toISOString(),
      isDefault: Boolean(p.isDefault || resolvedPath.toLowerCase() === path.resolve(__dirname).toLowerCase())
    };
  });
}

function saveProjectsRegistry(list) {
  try {
    const cleanJson = JSON.stringify(list, null, 2);
    fs.writeFileSync(REGISTRY_FILE, cleanJson, 'utf8');
    // Mantiene allineato anche il legacy file
    try { fs.writeFileSync(LEGACY_PROJECTS_FILE, cleanJson, 'utf8'); } catch (_) {}
    return true;
  } catch (_) {
    return false;
  }
}

function getProjectsList() {
  const list = loadProjectsRegistry();
  const current = getTargetProject();
  return list.map(p => ({
    ...p,
    isActive: path.resolve(p.path).toLowerCase() === path.resolve(current).toLowerCase()
  }));
}

function addProjectToRegistry(name, rawPath) {
  const val = validateProjectPath(rawPath);
  if (!val.ok) return val;
  const projPath = val.projectPath;
  const list = loadProjectsRegistry();
  const rawName = String(name || val.projectName).trim();
  const projName = rawName.slice(0, 64).replace(/[^\p{L}\p{N}\s\-_.]/gu, '').trim() || 'Progetto';
  const git = getGitInfo(projPath);
  const existingIdx = list.findIndex(p => path.resolve(p.path).toLowerCase() === projPath.toLowerCase());

  const projMeta = {
    id: slugify(projName),
    name: projName,
    path: projPath,
    branch: git.branch,
    isGit: git.isGit,
    lastActive: new Date().toISOString(),
    isDefault: projPath.toLowerCase() === path.resolve(__dirname).toLowerCase()
  };

  if (existingIdx >= 0) {
    list[existingIdx] = { ...list[existingIdx], ...projMeta };
  } else {
    list.push(projMeta);
  }

  state.targetProject = projPath;
  saveProjectsRegistry(list);
  return {
    ok: true,
    projectPath: projPath,
    projectName: projName,
    project: { ...projMeta, isActive: true },
    list: getProjectsList()
  };
}

function switchProject(query) {
  if (!query) return { ok: false, error: 'Identificatore progetto o percorso mancante' };
  const q = String(query).trim().toLowerCase();
  const list = loadProjectsRegistry();

  // 1. Cerca per id esatto, nome case-insensitive, o percorso assoluto
  const found = list.find(p =>
    (p.id && p.id.toLowerCase() === q) ||
    (p.name && p.name.toLowerCase() === q) ||
    (path.resolve(p.path).toLowerCase() === q) ||
    (path.resolve(p.path).toLowerCase() === path.resolve(query).toLowerCase())
  );

  if (found) {
    const val = validateProjectPath(found.path);
    if (!val.ok) return val;
    found.lastActive = new Date().toISOString();
    const git = getGitInfo(found.path);
    found.branch = git.branch;
    found.isGit = git.isGit;
    state.targetProject = found.path;
    saveProjectsRegistry(list);
    return {
      ok: true,
      projectPath: found.path,
      projectName: found.name,
      project: { ...found, isActive: true },
      list: getProjectsList()
    };
  }

  // 2. Se non presente nel registro, tenta validazione come nuovo percorso
  const val = validateProjectPath(query);
  if (!val.ok) {
    return { ok: false, error: `Progetto '${query}' non trovato nel registro e percorso non valido: ${val.error}` };
  }

  return addProjectToRegistry(val.projectName, val.projectPath);
}

function selectProjectByNameOrPath(query) {
  return switchProject(query);
}

module.exports = {
  getProjectsList,
  addProjectToRegistry,
  switchProject,
  selectProjectByNameOrPath,
  validateProjectPath,
  getGitInfo,
  updateMode,
  getMode,
  isResting,
  restMessage,
  enqueueRestTask,
  flushRestQueue,
  getTargetProject,
  setTargetProject,
  PRIMARY,
  ALTEREGO,
  setClaudeActive,
  isClaudeActive,
  resolveSubagent,
  getLastDiskMode: () => state.lastDiskMode,
  setLastDiskMode: (m) => { state.lastDiskMode = m; },
  allSessionsMap,
  REGISTRY_FILE
};
