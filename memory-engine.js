// Modulo Memory Engine & Skill Graph (Idea #5 - Auto-Evolving Memory)
// Gestione memoria persistente aziendale, regole apprese, preferenze, skill graph e custom tools dichiarativi.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const MEMORY_FILE = path.join(__dirname, 'company-memory.json');
const EXAMPLE_MEMORY_FILE = path.join(__dirname, 'company-memory.example.json');
const TMP_MEMORY_FILE = path.join(__dirname, 'company-memory.json.tmp');

// Whitelist binari ammessi per custom tools (ZERO eval, human-in-the-loop)
const ALLOWED_BINARIES = ['git', 'node', 'npm', 'python', 'python3'];

// ReGex validazione chiavi e categorie tassativa da checklist Carlo
const KEY_REGEX = /^[a-zA-Z0-9_\-:.]{2,64}$/;

// Chiavi proibite per Anti-Prototype Pollution
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Pattern anti-leak per rilevare token, segreti, password o chiavi private
const LEAK_PATTERNS = [
  /-----BEGIN\s+(?:[A-Z0-9_-]+\s+)?PRIVATE\s+KEY-----/i,
  /(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*['"]?[^\s'",;]{4,}['"]?/i,
  /ghp_[a-zA-Z0-9]{30,}/,
  /github_pat_[a-zA-Z0-9_]{40,}/,
  /AIza[0-9A-Za-z\-_]{35}/,
  /sk-[a-zA-Z0-9]{20,}/,
  /bearer\s+[a-zA-Z0-9_\-\.]{20,}/i,
  /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/
];

// Checklist Carlo: Redaction automatica dati sensibili e percorsi utente per GitHub pubblico
const REDACT_SECRETS_RE = [
  /(?:password|secret|token|api[_-]?key|passwd)\s*[:=]\s*['"]?[^\s'",;]{4,}['"]?/gi,
  /[a-zA-Z0-9_\-\.]{15,}@[a-zA-Z0-9_\-\.]+\.[a-zA-Z]{2,}/g,
  /ghp_[a-zA-Z0-9]{30,}/g,
  /github_pat_[a-zA-Z0-9_]{40,}/g,
  /AIza[0-9A-Za-z\-_]{35}/g,
  /sk-[a-zA-Z0-9]{20,}/g,
  /bearer\s+[a-zA-Z0-9_\-\.]{20,}/gi,
  /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi,
  /[a-zA-Z]:\\(?:Users|Utenti)\\[^\s\\\/]+/gi
];

function sanitizePublicText(str) {
  if (str === null || str === undefined) return '';
  let clean = String(str);
  // Neutralizza percorsi locali dell'utente (es. C:\Users\Username -> ~)
  clean = clean.replace(/[a-zA-Z]:\\(?:Users|Utenti)\\[^\s\\\/]+/gi, '~');
  // Maschera UUID di sessione
  clean = clean.replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, '[SESSION_ID]');
  for (const re of REDACT_SECRETS_RE) {
    clean = clean.replace(re, '[REDACTED]');
  }
  return clean;
}

let broadcastCallback = null;
let memoryState = null;
let cachedNeuralGraph = null;
let cachedNeuralGraphTime = 0;

// Sub-Brain Isolation State (Innovazione #5)
let currentProjectPath = path.resolve(__dirname);
let currentProjectSlug = 'azienda-ai';
let subBrainState = null;

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'project';
}

function getSubBrainFilePath(projPath) {
  const primary = path.join(projPath, '.agents', 'knowledge', 'company-memory.json');
  const fallback = path.join(projPath, '.project-memory.json');
  if (fs.existsSync(primary)) return primary;
  if (fs.existsSync(fallback)) return fallback;
  return primary;
}

function createEmptySubBrain(projPath) {
  const now = new Date().toISOString();
  const projName = path.basename(projPath);
  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    project: projName,
    projectSlug: slugify(projName),
    rules: [],
    preferences: [],
    facts: []
  };
}

function loadSubBrain(projPath) {
  const filePath = getSubBrainFilePath(projPath);
  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        if (isPolluted(parsed)) {
          console.warn('[Memory Engine] Sub-brain file contaminato da prototype pollution, ignorato:', filePath);
          subBrainState = createEmptySubBrain(projPath);
          return;
        }
        subBrainState = {
          version: parsed.version || 1,
          createdAt: parsed.createdAt || new Date().toISOString(),
          updatedAt: parsed.updatedAt || new Date().toISOString(),
          project: path.basename(projPath),
          projectSlug: slugify(path.basename(projPath)),
          rules: Array.isArray(parsed.rules) ? parsed.rules.filter(r => !scanForLeaks(r) && !isPolluted(r)) : [],
          preferences: Array.isArray(parsed.preferences) ? parsed.preferences : [],
          facts: Array.isArray(parsed.facts) ? parsed.facts : []
        };
        return;
      }
    } catch (err) {
      console.warn('[Memory Engine] Errore lettura sub-brain:', err.message);
    }
  }
  subBrainState = createEmptySubBrain(projPath);
}

function persistSubBrainAtomic(projPath) {
  if (!subBrainState) return true;
  const filePath = getSubBrainFilePath(projPath);
  const tmpPath = filePath + '.tmp';
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(subBrainState, null, 2), 'utf8');
    try {
      fs.renameSync(tmpPath, filePath);
    } catch {
      fs.copyFileSync(tmpPath, filePath);
      try { fs.unlinkSync(tmpPath); } catch {}
    }
    return true;
  } catch (err) {
    console.error('[Memory Engine] Errore persistenza sub-brain:', err.message);
    return false;
  }
}

function switchTargetProject(newPath) {
  const resolved = path.resolve(newPath || __dirname);
  currentProjectPath = resolved;
  const isCore = resolved.toLowerCase() === path.resolve(__dirname).toLowerCase();
  const projName = path.basename(resolved);
  currentProjectSlug = isCore ? 'azienda-ai' : slugify(projName);

  if (isCore) {
    subBrainState = null;
  } else {
    loadSubBrain(resolved);
  }

  invalidateNeuralCache();
  return {
    ok: true,
    projectPath: resolved,
    projectName: projName,
    projectSlug: currentProjectSlug,
    isCore,
    rulesCount: getMergedRules().length
  };
}

function getMergedRules() {
  if (!memoryState) loadMemory();
  const coreRules = (memoryState.rules || []).map(r => ({
    ...r,
    project: 'core',
    projectSlug: 'core',
    isCore: true
  }));

  if (!subBrainState || !Array.isArray(subBrainState.rules) || subBrainState.rules.length === 0) {
    return coreRules;
  }

  const subRules = subBrainState.rules.map(r => ({
    ...r,
    project: subBrainState.project || currentProjectSlug,
    projectSlug: currentProjectSlug,
    isCore: false
  }));

  return [...coreRules, ...subRules];
}

function invalidateNeuralCache() {
  cachedNeuralGraph = null;
  cachedNeuralGraphTime = 0;
}

// Verifica Anti-Prototype Pollution
function isPolluted(input) {
  if (input === null || input === undefined) return false;
  if (typeof input === 'string') {
    return FORBIDDEN_KEYS.has(input) || input.includes('__proto__') || input.includes('constructor') || input.includes('prototype');
  }
  if (typeof input === 'object') {
    for (const key of Object.keys(input)) {
      if (FORBIDDEN_KEYS.has(key) || key.includes('__proto__') || key.includes('constructor') || key.includes('prototype')) {
        return true;
      }
      if (typeof input[key] === 'object' && input[key] !== null) {
        if (isPolluted(input[key])) return true;
      }
    }
  }
  return false;
}

// Scansione Anti-Leak
function scanForLeaks(content) {
  if (content === null || content === undefined) return false;
  const str = typeof content === 'object' ? JSON.stringify(content) : String(content);
  for (const pattern of LEAK_PATTERNS) {
    if (pattern.test(str)) {
      return true;
    }
  }
  return false;
}

// Validazione chiave / categoria
function validateKey(key) {
  if (!key || typeof key !== 'string') return false;
  if (isPolluted(key)) return false;
  return KEY_REGEX.test(key);
}

// Validazione valore (lunghezza max 2000 caratteri)
function validateValue(value) {
  if (value === undefined || value === null) {
    return { ok: false, error: 'Valore mancante o nullo' };
  }
  if (isPolluted(value)) {
    return { ok: false, error: 'Violazione di sicurezza: rilevata Prototype Pollution nel valore' };
  }
  const strVal = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (strVal.length > 2000) {
    return { ok: false, error: `Il valore supera il limite consentito di 2000 caratteri (${strVal.length})` };
  }
  return { ok: true, stringValue: strVal };
}

// Scrittura atomica (.tmp -> company-memory.json)
function persistMemoryAtomic() {
  try {
    const data = JSON.stringify(memoryState, null, 2);
    fs.writeFileSync(TMP_MEMORY_FILE, data, 'utf8');
    try {
      fs.renameSync(TMP_MEMORY_FILE, MEMORY_FILE);
    } catch (_) {
      // Fallback robusto su Windows in caso di lock transitorio
      fs.copyFileSync(TMP_MEMORY_FILE, MEMORY_FILE);
      try { fs.unlinkSync(TMP_MEMORY_FILE); } catch (e) {}
    }
    invalidateNeuralCache();
    return true;
  } catch (err) {
    console.error('[Memory Engine] Errore persistenza atomica memoria:', err.message);
    return false;
  }
}

// Grafo iniziale delle skill e degli agenti aziendali
function buildInitialSkillGraph() {
  return {
    nodes: [
      { id: 'agent:10', key: 'alberto-ceo', label: 'Alberto (CEO)', type: 'agent', color: '#58a6ff' },
      { id: 'agent:6', key: 'luigi-backend', label: 'Luigi (Backend)', type: 'agent', color: '#2ea043' },
      { id: 'agent:7', key: 'gabri-frontend', label: 'Gabri (Frontend)', type: 'agent', color: '#bc8cff' },
      { id: 'agent:8', key: 'carlo-qa', label: 'Carlo (QA & Security)', type: 'agent', color: '#d29922' },

      { id: 'skill:orchestration', label: 'Orchestrazione & Leadership', type: 'skill', category: 'management' },
      { id: 'skill:backend-api', label: 'Architettura REST & WebSocket', type: 'skill', category: 'backend' },
      { id: 'skill:tunnel-networking', label: 'Cloudflare Tunnel & Port Decoupling', type: 'skill', category: 'networking' },
      { id: 'skill:canvas-rendering', label: 'Canvas 2D & UI Architecture', type: 'skill', category: 'frontend' },
      { id: 'skill:pwa-service-worker', label: 'PWA, Manifest & Offline Cache', type: 'skill', category: 'frontend' },
      { id: 'skill:qa-testing', label: 'Test Automation & Invariance Testing', type: 'skill', category: 'qa' },
      { id: 'skill:security-auditing', label: 'Penetration Testing & Red Teaming', type: 'skill', category: 'security' },
      { id: 'skill:auto-evolving-memory', label: 'Memory Engine & Skill Graph', type: 'skill', category: 'ai-system' }
    ],
    edges: [
      { from: 'agent:10', to: 'skill:orchestration', relation: 'owner', level: 5 },
      { from: 'agent:6', to: 'skill:backend-api', relation: 'expert', level: 5 },
      { from: 'agent:6', to: 'skill:tunnel-networking', relation: 'expert', level: 5 },
      { from: 'agent:6', to: 'skill:auto-evolving-memory', relation: 'creator', level: 5 },
      { from: 'agent:7', to: 'skill:canvas-rendering', relation: 'expert', level: 5 },
      { from: 'agent:7', to: 'skill:pwa-service-worker', relation: 'expert', level: 5 },
      { from: 'agent:8', to: 'skill:qa-testing', relation: 'expert', level: 5 },
      { from: 'agent:8', to: 'skill:security-auditing', relation: 'expert', level: 5 }
    ]
  };
}

// Inizializzazione o caricamento memoria da file
function loadMemory() {
  let targetFile = null;
  if (fs.existsSync(MEMORY_FILE)) {
    targetFile = MEMORY_FILE;
  } else if (fs.existsSync(EXAMPLE_MEMORY_FILE)) {
    targetFile = EXAMPLE_MEMORY_FILE;
    console.log('[Memory Engine] company-memory.json non presente: caricato template iniziale da company-memory.example.json');
  }

  if (targetFile) {
    try {
      const raw = fs.readFileSync(targetFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        memoryState = {
          version: parsed.version || 1,
          createdAt: parsed.createdAt || new Date().toISOString(),
          updatedAt: parsed.updatedAt || new Date().toISOString(),
          rules: Array.isArray(parsed.rules) ? parsed.rules : [],
          preferences: Array.isArray(parsed.preferences) ? parsed.preferences : [],
          feedback: Array.isArray(parsed.feedback) ? parsed.feedback : [],
          patterns: Array.isArray(parsed.patterns) ? parsed.patterns : [],
          facts: Array.isArray(parsed.facts) ? parsed.facts : [],
          customTools: Array.isArray(parsed.customTools) ? parsed.customTools : [],
          skillGraph: (parsed.skillGraph && Array.isArray(parsed.skillGraph.nodes)) ? parsed.skillGraph : buildInitialSkillGraph(),
          dailyDigest: (parsed.dailyDigest && typeof parsed.dailyDigest === 'object') ? parsed.dailyDigest : {
            enabled: false,
            time: '02:00',
            lastRun: null,
            history: []
          }
        };
        if (targetFile === EXAMPLE_MEMORY_FILE && !fs.existsSync(MEMORY_FILE)) {
          persistMemoryAtomic();
        }
        return;
      }
    } catch (err) {
      console.warn(`[Memory Engine] File ${targetFile} non valido, ricreo stato base:`, err.message);
    }
  }

  // Creazione stato base iniziale se non esiste
  const now = new Date().toISOString();
  memoryState = {
    version: 1,
    createdAt: now,
    updatedAt: now,
    rules: [
      {
        id: 'rule-port-isolation',
        category: 'rules',
        key: 'port-isolation',
        value: 'Il server di preview tunnel deve girare su porta dedicata 3001 separata dalla porta 3000 interna.',
        source: 'Carlo (QA & Security)',
        timestamp: now
      },
      {
        id: 'rule-anti-path-traversal',
        category: 'rules',
        key: 'anti-path-traversal',
        value: 'I percorsi di progetto devono essere confinati e non possono accedere a cartelle di sistema C:\\Windows o C:\\Program Files.',
        source: 'Luigi (Backend)',
        timestamp: now
      },
      {
        id: 'rule-server-headless-start',
        category: 'rules',
        key: 'server-headless-start',
        value: 'Il server Easy Agent Office va avviato esclusivamente tramite start.vbs --headless via WMI Win32_Process.',
        source: 'Alberto (CEO)',
        timestamp: now
      },
      {
        id: 'rule-anti-prototype-pollution',
        category: 'rules',
        key: 'anti-prototype-pollution',
        value: 'Rifiuto tassativo di __proto__, constructor e prototype nelle strutture dati aziendali.',
        source: 'Carlo (QA & Security)',
        timestamp: now
      }
    ],
    preferences: [
      {
        id: 'pref-communication-style',
        category: 'preferences',
        key: 'communication-style',
        value: 'Risposte concise in italiano con link cliccabili con protocollo file:// per file e simboli.',
        source: 'Alberto (CEO)',
        timestamp: now
      },
      {
        id: 'pref-theme-palette',
        category: 'preferences',
        key: 'theme-palette',
        value: 'Palette sartoriale char_3 con abito scuro e cravatta azzurra.',
        source: 'Alberto (CEO)',
        timestamp: now
      }
    ],
    feedback: [
      {
        id: 'feed-war-room-drill',
        category: 'feedback',
        key: 'war-room-success',
        value: 'Collaudo formale Red Team vs Blue Team superato con successo (54/54 asserzioni passate).',
        source: 'Carlo (QA & Security)',
        timestamp: now
      }
    ],
    patterns: [],
    facts: [],
    customTools: [],
    skillGraph: buildInitialSkillGraph(),
    dailyDigest: {
      enabled: false,
      time: '02:00',
      lastRun: null,
      history: []
    }
  };

  persistMemoryAtomic();
}

// Assicura caricamento iniziale
loadMemory();

function notifyBroadcast(eventType, payload) {
  if (typeof broadcastCallback === 'function') {
    try {
      broadcastCallback({
        type: 'memoryUpdated',
        subType: eventType,
        ...payload,
        updatedAt: memoryState ? memoryState.updatedAt : new Date().toISOString()
      });
    } catch (err) {
      console.warn('[Memory Engine] Errore notifica broadcast:', err.message);
    }
  }
}

function updateSkillGraphForTool(tool) {
  if (!memoryState.skillGraph || !Array.isArray(memoryState.skillGraph.nodes)) {
    memoryState.skillGraph = buildInitialSkillGraph();
  }

  const toolNodeId = `tool:${tool.name}`;
  const existingNodeIdx = memoryState.skillGraph.nodes.findIndex(n => n.id === toolNodeId);
  const toolNode = {
    id: toolNodeId,
    label: tool.name,
    type: 'tool',
    approved: Boolean(tool.approved),
    binary: tool.binary,
    description: tool.description,
    registeredBy: tool.registeredBy
  };

  if (existingNodeIdx >= 0) {
    memoryState.skillGraph.nodes[existingNodeIdx] = toolNode;
  } else {
    memoryState.skillGraph.nodes.push(toolNode);
  }

  // Edge dall'agente registratore (o Luigi) al custom tool
  const agentEdgeId = tool.registeredBy && tool.registeredBy.toLowerCase().includes('carlo') ? 'agent:8' : 'agent:6';
  const existingEdge = memoryState.skillGraph.edges.find(e => e.from === agentEdgeId && e.to === toolNodeId);
  if (!existingEdge) {
    memoryState.skillGraph.edges.push({
      from: agentEdgeId,
      to: toolNodeId,
      relation: 'registered-tool'
    });
  }
}

// ====================================================================
// FUNZIONI PUBBLICHE ESPORTATE
// ====================================================================

function init({ broadcastFn } = {}) {
  if (typeof broadcastFn === 'function') {
    broadcastCallback = broadcastFn;
  }
  loadMemory();
  return { ok: true };
}

function getMemory() {
  if (!memoryState) loadMemory();
  const mergedRules = getMergedRules();
  const subPrefs = (subBrainState && Array.isArray(subBrainState.preferences)) ? subBrainState.preferences : [];
  const subFacts = (subBrainState && Array.isArray(subBrainState.facts)) ? subBrainState.facts : [];
  return {
    version: memoryState.version,
    updatedAt: memoryState.updatedAt,
    activeProject: path.basename(currentProjectPath),
    projectPath: currentProjectPath,
    projectSlug: currentProjectSlug,
    isSubBrainActive: Boolean(subBrainState),
    coreRulesCount: (memoryState.rules || []).length,
    subBrainRulesCount: subBrainState ? (subBrainState.rules || []).length : 0,
    rules: mergedRules,
    preferences: [...(memoryState.preferences || []), ...subPrefs],
    feedback: [...(memoryState.feedback || [])],
    patterns: [...(memoryState.patterns || [])],
    facts: [...(memoryState.facts || []), ...subFacts],
    customTools: [...(memoryState.customTools || [])],
    skillGraph: getSkillGraph()
  };
}

function getSkillGraph() {
  if (!memoryState) loadMemory();
  const nodes = memoryState.skillGraph && Array.isArray(memoryState.skillGraph.nodes) ? memoryState.skillGraph.nodes : [];
  const edges = memoryState.skillGraph && Array.isArray(memoryState.skillGraph.edges) ? memoryState.skillGraph.edges : [];
  return {
    nodes: [...nodes],
    edges: [...edges],
    totalSkills: nodes.filter(n => n.type === 'skill').length,
    totalTools: nodes.filter(n => n.type === 'tool').length,
    totalAgents: nodes.filter(n => n.type === 'agent').length,
    updatedAt: memoryState.updatedAt
  };
}

function learnFact(category, key, value, source = 'system', targetProject = null) {
  if (!memoryState) loadMemory();

  // 1. Anti-Prototype Pollution
  if (isPolluted(category) || isPolluted(key) || isPolluted(source)) {
    return { ok: false, error: 'Violazione di sicurezza: Prototype Pollution rilevata nei metadati' };
  }

  // 2. Validazione chiave regex
  if (!validateKey(key)) {
    return { ok: false, error: 'Formato chiave non valido: deve corrispondere a /^[a-zA-Z0-9_\\-:.]{2,64}$/' };
  }

  // Validazione categoria regex (se fornita)
  const normCat = String(category || 'facts').toLowerCase().trim();
  if (!validateKey(normCat)) {
    return { ok: false, error: 'Formato categoria non valido: deve corrispondere a /^[a-zA-Z0-9_\\-:.]{2,64}$/' };
  }

  // 3. Validazione valore (lunghezza max 2000 char & anti-prototype pollution)
  const valRes = validateValue(value);
  if (!valRes.ok) {
    return valRes;
  }

  // 4. Scansione anti-leak (blocca token, secret, password, chiavi private)
  if (scanForLeaks(key) || scanForLeaks(normCat) || scanForLeaks(valRes.stringValue) || scanForLeaks(source)) {
    return { ok: false, error: 'Violazione di sicurezza: rilevato potenziale secret, token o credenziale privata nel testo' };
  }

  // Normalizzazione lista di destinazione
  let targetBucket = 'facts';
  if (normCat === 'rule' || normCat === 'rules') {
    targetBucket = 'rules';
  } else if (normCat === 'preference' || normCat === 'preferences') {
    targetBucket = 'preferences';
  } else if (normCat === 'feedback') {
    targetBucket = 'feedback';
  } else if (normCat === 'pattern' || normCat === 'patterns') {
    targetBucket = 'patterns';
  }

  const isSubBrain = Boolean(targetProject || (currentProjectPath && currentProjectPath.toLowerCase() !== path.resolve(__dirname).toLowerCase()));
  const targetState = isSubBrain ? (subBrainState || createEmptySubBrain(targetProject || currentProjectPath)) : memoryState;
  if (isSubBrain && !subBrainState) subBrainState = targetState;

  if (!Array.isArray(targetState[targetBucket])) {
    targetState[targetBucket] = [];
  }

  const existingIdx = targetState[targetBucket].findIndex(item => item.key === key);
  const now = new Date().toISOString();

  let factObj;
  if (existingIdx >= 0) {
    factObj = {
      ...targetState[targetBucket][existingIdx],
      value: typeof value === 'object' ? value : String(value),
      source: String(source || 'system').trim(),
      timestamp: now,
      project: isSubBrain ? (targetState.project || currentProjectSlug) : 'core',
      projectSlug: isSubBrain ? currentProjectSlug : 'core',
      isCore: !isSubBrain
    };
    targetState[targetBucket][existingIdx] = factObj;
  } else {
    factObj = {
      id: `${targetBucket}-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      category: normCat,
      key,
      value: typeof value === 'object' ? value : String(value),
      source: String(source || 'system').trim(),
      timestamp: now,
      project: isSubBrain ? (targetState.project || currentProjectSlug) : 'core',
      projectSlug: isSubBrain ? currentProjectSlug : 'core',
      isCore: !isSubBrain
    };
    targetState[targetBucket].push(factObj);
  }

  targetState.updatedAt = now;

  if (isSubBrain) {
    persistSubBrainAtomic(targetProject || currentProjectPath);
  } else {
    persistMemoryAtomic();
  }

  invalidateNeuralCache();

  notifyBroadcast('factLearned', {
    targetBucket,
    fact: factObj,
    isSubBrain,
    project: factObj.project,
    memory: getMemory(),
    skillGraph: getSkillGraph()
  });

  return { ok: true, fact: factObj, targetBucket, isSubBrain, project: factObj.project };
}

function registerCustomTool(toolName, code, description, options = {}) {
  if (!memoryState) loadMemory();

  // 1. Anti-Prototype Pollution
  if (isPolluted(toolName) || isPolluted(code) || isPolluted(description)) {
    return { ok: false, error: 'Violazione di sicurezza: Prototype Pollution rilevata' };
  }

  // 2. Validazione nome chiave regex
  if (!validateKey(toolName)) {
    return { ok: false, error: 'Nome tool non valido: deve corrispondere a /^[a-zA-Z0-9_\\-:.]{2,64}$/' };
  }

  // 3. Scansione anti-leak
  if (scanForLeaks(toolName) || scanForLeaks(code) || scanForLeaks(description)) {
    return { ok: false, error: 'Violazione di sicurezza: rilevato potenziale secret o credenziale nel custom tool' };
  }

  // 4. Zero eval: estrazione binario e verifica whitelist tassativa
  const rawCommand = String(code || '').trim();
  let binary = (options.binary || rawCommand.split(/\s+/)[0] || '').toLowerCase();
  binary = binary.replace(/^.*[\\\/]/, '').replace(/\.exe$/i, '');

  if (!ALLOWED_BINARIES.includes(binary)) {
    return {
      ok: false,
      error: `Binario '${binary}' non consentito. Binari ammessi: ${ALLOWED_BINARIES.join(', ')}`
    };
  }

  // Verifica lunghezza codice e descrizione
  if (rawCommand.length > 2000 || String(description || '').length > 2000) {
    return { ok: false, error: 'Codice comando o descrizione superano i 2000 caratteri' };
  }

  // 5. Stato iniziale: approved: false (Human-in-the-loop)
  const now = new Date().toISOString();
  const toolObj = {
    name: toolName,
    binary,
    command: rawCommand,
    description: String(description || '').trim(),
    approved: false, // Tassativo: richiede approvazione esplicita
    approvedBy: null,
    approvedAt: null,
    registeredBy: options.source || 'Luigi (Backend)',
    registeredAt: now
  };

  const existingIdx = memoryState.customTools.findIndex(t => t.name === toolName);
  if (existingIdx >= 0) {
    memoryState.customTools[existingIdx] = toolObj;
  } else {
    memoryState.customTools.push(toolObj);
  }

  updateSkillGraphForTool(toolObj);
  memoryState.updatedAt = now;
  persistMemoryAtomic();

  notifyBroadcast('toolRegistered', {
    tool: toolObj,
    memory: getMemory(),
    skillGraph: getSkillGraph()
  });

  return { ok: true, tool: toolObj };
}

function approveCustomTool(toolName, approvedBy = 'Alberto (CEO)') {
  if (!memoryState) loadMemory();
  const tool = memoryState.customTools.find(t => t.name === toolName);
  if (!tool) {
    return { ok: false, error: `Tool '${toolName}' non trovato` };
  }

  tool.approved = true;
  tool.approvedBy = approvedBy;
  tool.approvedAt = new Date().toISOString();
  memoryState.updatedAt = new Date().toISOString();

  updateSkillGraphForTool(tool);
  persistMemoryAtomic();

  notifyBroadcast('toolApproved', {
    tool,
    memory: getMemory(),
    skillGraph: getSkillGraph()
  });

  return { ok: true, tool };
}

function executeCustomTool(toolName, args = null, timeoutMs = 10000) {
  if (!memoryState) loadMemory();
  const tool = memoryState.customTools.find(t => t.name === toolName);
  if (!tool) {
    return Promise.resolve({ ok: false, error: `Tool '${toolName}' non trovato` });
  }

  // Verifica stato approvazione human-in-the-loop
  if (!tool.approved) {
    return Promise.resolve({
      ok: false,
      error: `Il tool '${toolName}' non è approvato. Autorizzazione esplicita richiesta (human-in-the-loop).`
    });
  }

  return new Promise(resolve => {
    // Se args non specificati, estrae gli argomenti di default dal comando dichiarato
    let parsedArgs = [];
    if (args !== null && args !== undefined && (Array.isArray(args) ? args.length > 0 : String(args).trim().length > 0)) {
      parsedArgs = Array.isArray(args) ? args : String(args).trim().split(/\s+/).filter(Boolean);
    } else {
      const parts = String(tool.command || '').trim().split(/\s+/).filter(Boolean);
      parsedArgs = parts.slice(1);
    }

    // Esecuzione dichiarativa con execFile senza shell (shell: false)
    execFile(tool.binary, parsedArgs, { cwd: __dirname, shell: false, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        return resolve({ ok: false, error: err.message, stderr: String(stderr || '') });
      }
      return resolve({ ok: true, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() });
    });
  });
}

// ====================================================================
// THE LIVING BRAIN 3D — MAPPA NEURALE 3D DELLA MEMORIA CONDIVISA
// ====================================================================

function hashStringToUnit(str, seed = 0) {
  let h = seed ^ 0x12345678;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 2654435761);
  }
  return ((h >>> 0) % 1000000) / 1000000;
}

function getNeuralGraph() {
  if (cachedNeuralGraph && (Date.now() - cachedNeuralGraphTime < 15000)) {
    return cachedNeuralGraph;
  }

  if (!memoryState) loadMemory();

  const nodes = [];
  const synapses = [];

  // 1. Agenti Centrali (Cluster Emissivi Fondamentali)
  const agentDefs = [
    { id: 'agent:10', label: 'Alberto (CEO)', role: 'CEO & Orchestrator', hemisphere: 'right', basePos: [55, 25, 20], color: '#58a6ff', emissive: '#79c0ff', size: 16, pulse: 1.5 },
    { id: 'agent:6', label: 'Luigi (Backend)', role: 'Backend & Systems Engineer', hemisphere: 'left', basePos: [-55, 20, 15], color: '#2ea043', emissive: '#56d364', size: 15, pulse: 1.4 },
    { id: 'agent:7', label: 'Gabri (Frontend)', role: 'Frontend Architect & UI Dev', hemisphere: 'right', basePos: [55, -20, 15], color: '#bc8cff', emissive: '#d2a8ff', size: 15, pulse: 1.3 },
    { id: 'agent:8', label: 'Carlo (QA & Security)', role: 'Security Auditor & Code Revisor', hemisphere: 'left', basePos: [-55, -25, -15], color: '#d29922', emissive: '#e3b341', size: 15, pulse: 1.4 }
  ];

  agentDefs.forEach(a => {
    nodes.push({
      id: a.id,
      label: sanitizePublicText(a.label),
      type: 'agent',
      role: sanitizePublicText(a.role),
      hemisphere: a.hemisphere,
      position: { x: a.basePos[0], y: a.basePos[1], z: a.basePos[2] },
      size: a.size,
      color: a.color,
      emissive: a.emissive,
      emissiveIntensity: 1.2,
      pulseSpeed: a.pulse,
      weight: 5.0,
      activity: 0.95
    });
  });

  // 2. Hub Centrale (Corpus Callosum / Brain Core)
  const coreHubId = 'core:memory-engine';
  nodes.push({
    id: coreHubId,
    label: 'Auto-Evolving Memory Hub',
    type: 'core',
    hemisphere: 'core',
    position: { x: 0, y: 5, z: 30 },
    size: 14,
    color: '#f0f6fc',
    emissive: '#388bfd',
    emissiveIntensity: 1.5,
    pulseSpeed: 1.6,
    weight: 4.8,
    activity: 0.98
  });

  // Sinapsi dal core verso tutti e 4 gli agenti
  agentDefs.forEach(a => {
    synapses.push({
      id: `syn:${coreHubId}->${a.id}`,
      source: coreHubId,
      target: a.id,
      type: 'structural',
      synapticStrength: 0.95,
      pulseSpeed: 1.5,
      color: a.color,
      pulsing: true
    });
  });

  // 3. Competenze Fondamentali (Skills)
  const skillNodes = (memoryState.skillGraph && Array.isArray(memoryState.skillGraph.nodes)) ? memoryState.skillGraph.nodes.filter(n => n.type === 'skill') : [];
  skillNodes.forEach(s => {
    const isLeft = ['backend', 'networking', 'security', 'qa'].some(cat => (s.category || '').toLowerCase().includes(cat) || s.id.includes('backend') || s.id.includes('tunnel') || s.id.includes('security') || s.id.includes('qa'));
    const hemi = isLeft ? 'left' : (s.id.includes('memory') ? 'core' : 'right');
    const u1 = hashStringToUnit(s.id, 11);
    const u2 = hashStringToUnit(s.id, 23);
    const u3 = hashStringToUnit(s.id, 37);

    const x = hemi === 'core' ? (u1 - 0.5) * 20 : (hemi === 'left' ? -(35 + u1 * 40) : +(35 + u1 * 40));
    const y = (u2 - 0.5) * 80;
    const z = (u3 - 0.5) * 60;

    nodes.push({
      id: s.id,
      label: sanitizePublicText(s.label || s.id),
      type: 'skill',
      category: sanitizePublicText(s.category || 'core'),
      hemisphere: hemi,
      position: { x: Number(x.toFixed(2)), y: Number(y.toFixed(2)), z: Number(z.toFixed(2)) },
      size: 11,
      color: hemi === 'left' ? '#3fb950' : (hemi === 'right' ? '#d2a8ff' : '#58a6ff'),
      emissive: hemi === 'left' ? '#56d364' : (hemi === 'right' ? '#e2c5ff' : '#79c0ff'),
      emissiveIntensity: 0.9,
      pulseSpeed: 1.2,
      weight: 3.5,
      activity: 0.85
    });
  });

  // Archi skillGraph esistenti
  const skillEdges = (memoryState.skillGraph && Array.isArray(memoryState.skillGraph.edges)) ? memoryState.skillGraph.edges : [];
  skillEdges.forEach(e => {
    synapses.push({
      id: `syn:${e.from}->${e.to}`,
      source: e.from,
      target: e.to,
      type: e.relation || 'active',
      synapticStrength: 0.85,
      pulseSpeed: 1.2,
      color: '#58a6ff',
      pulsing: true
    });
  });

  // 4. Regole Operative (Emisfero Sinistro - Logica & Rigore)
  const rules = getMergedRules();
  rules.forEach(r => {
    const u1 = hashStringToUnit(r.key || r.id, 41);
    const u2 = hashStringToUnit(r.key || r.id, 53);
    const u3 = hashStringToUnit(r.key || r.id, 67);

    const x = -(40 + u1 * 55);
    const y = (u2 - 0.5) * 85;
    const z = (u3 - 0.5) * 65;

    const ruleNodeId = `rule:${r.projectSlug || 'core'}:${r.key || r.id}`;
    const isCoreRule = r.isCore !== false;
    nodes.push({
      id: ruleNodeId,
      label: sanitizePublicText(r.key),
      snippet: sanitizePublicText(String(r.value || '').slice(0, 100)),
      type: 'rule',
      category: 'operational-rule',
      hemisphere: 'left',
      position: { x: Number(x.toFixed(2)), y: Number(y.toFixed(2)), z: Number(z.toFixed(2)) },
      size: 8,
      color: isCoreRule ? '#3fb950' : '#e3b341',
      emissive: isCoreRule ? '#56d364' : '#d29922',
      emissiveIntensity: 0.8,
      pulseSpeed: 1.0,
      weight: 2.8,
      activity: 0.75,
      source: sanitizePublicText(r.source),
      project: r.project || 'core',
      projectSlug: r.projectSlug || 'core',
      isCore: isCoreRule
    });

    const targetAgent = (r.source && r.source.includes('Carlo')) ? 'agent:8' : 'agent:6';
    synapses.push({
      id: `syn:${targetAgent}->${ruleNodeId}`,
      source: targetAgent,
      target: ruleNodeId,
      type: 'reinforced',
      synapticStrength: 0.75,
      pulseSpeed: 0.9,
      color: isCoreRule ? '#3fb950' : '#e3b341',
      pulsing: true
    });
  });

  // 5. Preferenze Utente (Emisfero Destro - Stile, Visione & UI)
  const preferences = memoryState.preferences || [];
  preferences.forEach(p => {
    const u1 = hashStringToUnit(p.key || p.id, 71);
    const u2 = hashStringToUnit(p.key || p.id, 83);
    const u3 = hashStringToUnit(p.key || p.id, 97);

    const x = +(40 + u1 * 55);
    const y = (u2 - 0.5) * 85;
    const z = (u3 - 0.5) * 65;

    const prefNodeId = `pref:${p.key || p.id}`;
    nodes.push({
      id: prefNodeId,
      label: sanitizePublicText(p.key),
      snippet: sanitizePublicText(String(p.value || '').slice(0, 100)),
      type: 'preference',
      category: 'user-preference',
      hemisphere: 'right',
      position: { x: Number(x.toFixed(2)), y: Number(y.toFixed(2)), z: Number(z.toFixed(2)) },
      size: 8,
      color: '#d2a8ff',
      emissive: '#e2c5ff',
      emissiveIntensity: 0.8,
      pulseSpeed: 1.0,
      weight: 2.5,
      activity: 0.7,
      source: sanitizePublicText(p.source)
    });

    const targetAgent = (p.source && p.source.includes('Gabri')) ? 'agent:7' : 'agent:10';
    synapses.push({
      id: `syn:${targetAgent}->${prefNodeId}`,
      source: targetAgent,
      target: prefNodeId,
      type: 'reinforced',
      synapticStrength: 0.7,
      pulseSpeed: 0.9,
      color: '#d2a8ff',
      pulsing: true
    });
  });

  // 6. Custom Tools Dichiarativi (Lobo Frontale Sinistro)
  const tools = memoryState.customTools || [];
  tools.forEach(t => {
    const u1 = hashStringToUnit(t.name, 101);
    const u2 = hashStringToUnit(t.name, 113);
    const u3 = hashStringToUnit(t.name, 127);

    const x = -(45 + u1 * 35);
    const y = 30 + (u2 - 0.5) * 35;
    const z = (u3 - 0.5) * 45;

    const toolNodeId = `tool:${t.name}`;
    nodes.push({
      id: toolNodeId,
      label: sanitizePublicText(t.name),
      snippet: sanitizePublicText(`${t.binary}: ${t.description}`),
      type: 'tool',
      category: 'custom-tool',
      hemisphere: 'left',
      approved: Boolean(t.approved),
      position: { x: Number(x.toFixed(2)), y: Number(y.toFixed(2)), z: Number(z.toFixed(2)) },
      size: 9,
      color: t.approved ? '#58a6ff' : '#8b949e',
      emissive: t.approved ? '#79c0ff' : '#484f58',
      emissiveIntensity: t.approved ? 1.0 : 0.4,
      pulseSpeed: t.approved ? 1.3 : 0.4,
      weight: 3.0,
      activity: t.approved ? 0.8 : 0.2
    });

    synapses.push({
      id: `syn:agent:6->${toolNodeId}`,
      source: 'agent:6',
      target: toolNodeId,
      type: t.approved ? 'active' : 'inhibitory',
      synapticStrength: t.approved ? 0.8 : 0.3,
      pulseSpeed: t.approved ? 1.2 : 0.5,
      color: t.approved ? '#58a6ff' : '#6e7681',
      pulsing: Boolean(t.approved)
    });
  });

  // Ottimizzazione WebGL: Tetto massimo 300 nodi (Checklist Carlo)
  const boundedNodes = nodes.slice(0, 300);
  const validNodeIds = new Set(boundedNodes.map(n => n.id));
  const boundedSynapses = synapses.filter(s => validNodeIds.has(s.source) && validNodeIds.has(s.target));

  const leftCount = boundedNodes.filter(n => n.hemisphere === 'left').length;
  const rightCount = boundedNodes.filter(n => n.hemisphere === 'right').length;
  const coreCount = boundedNodes.filter(n => n.hemisphere === 'core').length;
  const density = boundedNodes.length > 0 ? Number((boundedSynapses.length / boundedNodes.length).toFixed(2)) : 0;

  const result = {
    ok: true,
    model: 'The Living Brain 3D (Dual-Hemisphere Neural Topology)',
    activeProject: path.basename(currentProjectPath),
    projectPath: currentProjectPath,
    projectSlug: currentProjectSlug,
    isSubBrainActive: Boolean(subBrainState),
    nodes: boundedNodes,
    synapses: boundedSynapses,
    totalNodes: boundedNodes.length,
    totalSynapses: boundedSynapses.length,
    hemispheres: {
      left: leftCount,
      right: rightCount,
      core: coreCount
    },
    synapticDensity: density,
    brainActivityIndex: 0.92,
    cameraRecommendation: {
      position: { x: 0, y: 25, z: 220 },
      lookAt: { x: 0, y: 0, z: 10 },
      fov: 45
    },
    updatedAt: memoryState.updatedAt || new Date().toISOString()
  };

  cachedNeuralGraph = result;
  cachedNeuralGraphTime = Date.now();
  return result;
}

// ====================================================================
// DAILY DIGEST NOTTURNO CONFIGURABILE (ZERO QUOTA/CPU SE DISATTIVATO)
// ====================================================================

function getDigestStatus() {
  if (!memoryState) loadMemory();
  const digest = memoryState.dailyDigest || { enabled: false, time: '02:00', lastRun: null, history: [] };
  return {
    ok: true,
    enabled: Boolean(digest.enabled),
    time: digest.time || '02:00',
    lastRun: digest.lastRun || null,
    historyCount: Array.isArray(digest.history) ? digest.history.length : 0,
    quotePreservationActive: !digest.enabled
  };
}

function toggleDigest(enabled = null) {
  if (!memoryState) loadMemory();
  if (!memoryState.dailyDigest) {
    memoryState.dailyDigest = { enabled: false, time: '02:00', lastRun: null, history: [] };
  }

  if (enabled === null || enabled === undefined) {
    memoryState.dailyDigest.enabled = !memoryState.dailyDigest.enabled;
  } else {
    memoryState.dailyDigest.enabled = Boolean(enabled);
  }

  memoryState.updatedAt = new Date().toISOString();
  persistMemoryAtomic();

  const status = getDigestStatus();
  notifyBroadcast('digestStatusChanged', { status });
  return status;
}

function generateDigest({ force = false, source = 'system' } = {}) {
  if (!memoryState) loadMemory();
  const digest = memoryState.dailyDigest || { enabled: false, time: '02:00', lastRun: null, history: [] };

  if (!digest.enabled && !force) {
    return {
      ok: false,
      preserved: true,
      message: 'Daily Digest Notturno è disattivato per preservare quote ed energia. Attivalo tramite toggleDigest() o specifica force: true.'
    };
  }

  const now = new Date();
  const dateStr = now.toLocaleDateString('it-IT');
  const rules = memoryState.rules || [];
  const preferences = memoryState.preferences || [];
  const tools = memoryState.customTools || [];
  const feedback = memoryState.feedback || [];

  const routingMod = require('./routing');
  const rawProj = typeof routingMod.getTargetProject === 'function' ? routingMod.getTargetProject() : 'Easy Agent Office';
  const cleanProj = sanitizePublicText(path.basename(rawProj));

  const reportItem = {
    id: `digest-${Date.now()}`,
    date: now.toISOString().split('T')[0],
    timestamp: now.toISOString(),
    source: sanitizePublicText(source || 'Nightly Scheduler'),
    activeProject: cleanProj,
    metrics: {
      rulesLearned: rules.length,
      preferencesStored: preferences.length,
      toolsActive: tools.length,
      feedbackLogged: feedback.length
    },
    highlights: [
      `Memoria aziendale aggiornata: ${rules.length} regole operative e ${preferences.length} preferenze`,
      `Custom tools verificati: ${tools.filter(t => t.approved).length}/${tools.length} approvati per l'uso`,
      `Workspace attivo: ${cleanProj}`
    ],
    summaryText: sanitizePublicText(`🌙 Daily Digest [${dateStr}] — Workspace: ${cleanProj} | Regole: ${rules.length} | Preferenze: ${preferences.length} | Tools: ${tools.length}`)
  };

  if (!Array.isArray(digest.history)) {
    digest.history = [];
  }
  digest.history.unshift(reportItem);
  if (digest.history.length > 14) {
    digest.history = digest.history.slice(0, 14);
  }
  digest.lastRun = reportItem.timestamp;
  memoryState.dailyDigest = digest;
  memoryState.updatedAt = now.toISOString();
  persistMemoryAtomic();

  notifyBroadcast('digestGenerated', { digest: reportItem });
  return { ok: true, digest: reportItem };
}

module.exports = {
  init,
  getMemory,
  getSkillGraph,
  getNeuralGraph,
  getDigestStatus,
  toggleDigest,
  generateDigest,
  sanitizePublicText,
  invalidateNeuralCache,
  learnFact,
  registerCustomTool,
  approveCustomTool,
  executeCustomTool,
  isPolluted,
  validateKey,
  validateValue,
  scanForLeaks,
  ALLOWED_BINARIES,
  KEY_REGEX,
  buildInitialSkillGraph,
  MEMORY_FILE,
  EXAMPLE_MEMORY_FILE,
  // Innovazione #5 Multi-Project Sandbox Switcher & Sub-Brain Isolation
  switchTargetProject,
  getSubBrainFilePath,
  getCurrentProjectPath: () => currentProjectPath,
  getCurrentProjectSlug: () => currentProjectSlug,
  getSubBrainState: () => subBrainState,
  getMergedRules
};
