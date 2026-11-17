// Modulo Memory Engine & Skill Graph (Idea #5 - Auto-Evolving Memory)
// Gestione memoria persistente aziendale, regole apprese, preferenze, skill graph e custom tools dichiarativi.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const MEMORY_FILE = path.join(__dirname, 'company-memory.json');
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

let broadcastCallback = null;
let memoryState = null;

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
  if (fs.existsSync(MEMORY_FILE)) {
    try {
      const raw = fs.readFileSync(MEMORY_FILE, 'utf8');
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
          skillGraph: (parsed.skillGraph && Array.isArray(parsed.skillGraph.nodes)) ? parsed.skillGraph : buildInitialSkillGraph()
        };
        return;
      }
    } catch (err) {
      console.warn('[Memory Engine] File company-memory.json non valido, ricreo stato base:', err.message);
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
        value: 'Il server AziendaAI va avviato esclusivamente tramite start.vbs --headless via WMI Win32_Process.',
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
    skillGraph: buildInitialSkillGraph()
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
  return {
    version: memoryState.version,
    updatedAt: memoryState.updatedAt,
    rules: [...memoryState.rules],
    preferences: [...memoryState.preferences],
    feedback: [...memoryState.feedback],
    patterns: [...memoryState.patterns],
    facts: [...memoryState.facts],
    customTools: [...memoryState.customTools],
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

function learnFact(category, key, value, source = 'system') {
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

  if (!Array.isArray(memoryState[targetBucket])) {
    memoryState[targetBucket] = [];
  }

  const existingIdx = memoryState[targetBucket].findIndex(item => item.key === key);
  const now = new Date().toISOString();

  let factObj;
  if (existingIdx >= 0) {
    factObj = {
      ...memoryState[targetBucket][existingIdx],
      value: typeof value === 'object' ? value : String(value),
      source: String(source || 'system').trim(),
      timestamp: now
    };
    memoryState[targetBucket][existingIdx] = factObj;
  } else {
    factObj = {
      id: `${targetBucket}-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      category: normCat,
      key,
      value: typeof value === 'object' ? value : String(value),
      source: String(source || 'system').trim(),
      timestamp: now
    };
    memoryState[targetBucket].push(factObj);
  }

  memoryState.updatedAt = now;
  persistMemoryAtomic();

  notifyBroadcast('factLearned', {
    targetBucket,
    fact: factObj,
    memory: getMemory(),
    skillGraph: getSkillGraph()
  });

  return { ok: true, fact: factObj, targetBucket };
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

module.exports = {
  init,
  getMemory,
  getSkillGraph,
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
  buildInitialSkillGraph
};
