// Modulo Tunnel Manager: Live Preview Mobile Globale con Cloudflare (Idea #4)
// Sicurezza: porta isolata (3001) per decoupling dal control panel, blacklist su segreti e hard timeout 15m
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn, execFile, execSync } = require('child_process');
const WebSocket = require('ws');
const routing = require('./routing');

const BIN_PATH = path.join(__dirname, 'bin', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
const PREVIEW_PORT = 3001;
const AUTO_STOP_MS = 15 * 60 * 1000; // 15 minuti di inattività per sicurezza
const URL_REGEX = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/i;
const BLACKLIST_RE = /^(\.env.*|.*\.config\.json|\.git.*|node_modules|tasks_queue\.json|.*\.(pem|key)|.*token.*|.*secret.*)$/i;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

let previewServer = null;
let tunnelProcess = null;
let publicUrl = null;
let tunnelStatus = 'inactive'; // 'starting', 'active', 'stopping', 'inactive', 'error'
let targetDirectory = null;
let targetUrl = `http://127.0.0.1:${PREVIEW_PORT}`;
let startedAt = null;
let autoStopTimer = null;
let lastError = null;
let startPromise = null;

function getStatus() {
  return {
    ok: true,
    active: tunnelStatus === 'active',
    status: tunnelStatus,
    url: publicUrl,
    localUrl: targetUrl,
    previewPort: PREVIEW_PORT,
    targetDirectory: targetDirectory,
    startedAt: startedAt,
    autoStopMinutes: 15,
    lastError: lastError,
    binaryExists: fs.existsSync(BIN_PATH)
  };
}

function serveFile(filePath, res) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': mime,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache'
  });
  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
}

// ====================================================================
// REVERSE PROXY API & WEBSOCKET PER TUNNEL PUBBLICO (CHECKLIST CARLO)
// ====================================================================
const TUNNEL_SAFE_API_WHITELIST = new Set([
  '/api/quota',
  '/api/quota/burnout',
  '/api/memory/neural-graph',
  '/api/memory',
  '/api/memory/skills',
  '/api/tasks/queue',
  '/api/project',
  '/api/projects/registry',
  '/api/digest/status',
  '/api/war-room/status',
  '/api/tunnel/status',
  '/api/tunnel',
  '/api/ceo-report'
]);

function isAllowedTunnelApi(pathname, method) {
  if (method !== 'GET') return false; // Solo GET ammessi (Carlo Checklist)
  const cleanPath = String(pathname || '').replace(/\/+$/, '');
  return TUNNEL_SAFE_API_WHITELIST.has(cleanPath);
}

function proxyHttpRequest(req, res, targetPort = 3000) {
  const options = {
    hostname: '127.0.0.1',
    port: targetPort,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      host: `127.0.0.1:${targetPort}`,
      'x-forwarded-for': req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      'x-forwarded-proto': 'https'
    }
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: '502 Bad Gateway: Backend AziendaAI su porta 3000 non raggiungibile.' }));
  });

  req.pipe(proxyReq);
}

function createPreviewServer(dirPath = routing.getTargetProject()) {
  return http.createServer((req, res) => {
    try {
      const parsedUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      let reqPath = decodeURIComponent(parsedUrl.pathname);

      if (reqPath.includes('\0')) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        return res.end('Bad Request');
      }

      // ====================================================================
      // REVERSE PROXY API CON WHITELIST PERITALE CARLO (SOLO GET SAFE)
      // ====================================================================
      if (reqPath === '/api' || reqPath.startsWith('/api/')) {
        // 1. Rigido Metodo GET: qualsiasi richiesta mutante (POST, PUT, DELETE, PATCH) è respinta con 403
        if (req.method !== 'GET') {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({
            ok: false,
            error: '403 Forbidden: Mutating API disabled on public preview tunnel'
          }));
        }

        // 2. Whitelist Tassativa Endpoint Consentiti (Sola Lettura)
        const cleanPath = reqPath.replace(/\/+$/, '');
        if (!isAllowedTunnelApi(cleanPath, req.method)) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({
            ok: false,
            error: `403 Forbidden: Endpoint '${cleanPath}' non consentito su tunnel pubblico`
          }));
        }

        // 3. Proxy trasparente verso il server principale su porta 3000
        return proxyHttpRequest(req, res, 3000);
      }

      // Blacklist check su tutti i segmenti del percorso file statico
      const segments = reqPath.split(/[\\/]/).filter(Boolean);
      for (const seg of segments) {
        if (BLACKLIST_RE.test(seg)) {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('403 Forbidden: Protected file/directory');
        }
      }

      if (reqPath === '/' || reqPath === '') {
        reqPath = '/index.html';
      }

      const safePath = path.resolve(dirPath, '.' + reqPath);
      if (!safePath.toLowerCase().startsWith(path.resolve(dirPath).toLowerCase())) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        return res.end('Access Denied: Path outside project boundary');
      }

      if (!fs.existsSync(safePath)) {
        // Fallback 1: cerca dentro public/ del target
        const publicFallback = path.join(dirPath, 'public', '.' + reqPath);
        if (fs.existsSync(publicFallback) && !fs.statSync(publicFallback).isDirectory()) {
          return serveFile(publicFallback, res);
        }
        // Fallback 2: cerca dentro la root public/ di AziendaAI
        const rootPublicFallback = path.join(__dirname, 'public', '.' + reqPath);
        if (fs.existsSync(rootPublicFallback) && !fs.statSync(rootPublicFallback).isDirectory()) {
          return serveFile(rootPublicFallback, res);
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Not Found');
      }

      const stat = fs.statSync(safePath);
      if (stat.isDirectory()) {
        const indexPath = path.join(safePath, 'index.html');
        if (fs.existsSync(indexPath)) {
          return serveFile(indexPath, res);
        }
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        return res.end('Directory listing forbidden');
      }

      serveFile(safePath, res);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error: ' + err.message);
    }
  });
}

let tunnelWss = null;

function closePreviewServer() {
  if (tunnelWss) {
    try { tunnelWss.close(); } catch {}
    tunnelWss = null;
  }
  if (previewServer) {
    try { previewServer.close(); } catch {}
    previewServer = null;
  }
}

function startPreviewServer(dirPath, port = PREVIEW_PORT) {
  closePreviewServer();

  return new Promise((resolve, reject) => {
    previewServer = createPreviewServer(dirPath);
    tunnelWss = new WebSocket.Server({ noServer: true });

    // Gestione WebSocket upgrade su porta 3001
    previewServer.on('upgrade', (req, socket, head) => {
      try {
        const parsedUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
        if (parsedUrl.pathname === '/ws') {
          tunnelWss.handleUpgrade(req, socket, head, (clientWs) => {
            tunnelWss.emit('connection', clientWs, req);
          });
        } else {
          socket.destroy();
        }
      } catch (err) {
        socket.destroy();
      }
    });

    // Connessione WebSocket e Proxy Filtrato (Carlo Checklist 2)
    tunnelWss.on('connection', (clientWs, req) => {
      const backendWs = new WebSocket('ws://127.0.0.1:3000/ws');

      // Server (3000) -> Client (Mobile): Tutti gli eventi visuali live fluiscono liberamente
      backendWs.on('message', (data, isBinary) => {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(data, { binary: isBinary });
        }
      });

      // Client (Mobile) -> Server (3000): FILTRO PERITALE ANTI-RCE (SOLO LETTURA / BENIGNI)
      clientWs.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          // Whitelist Carlo: consentiti solo eventi informativi di UI innocui
          if (msg && (msg.type === 'focusAgent' || msg.type === 'webviewReady')) {
            if (backendWs.readyState === WebSocket.OPEN) {
              backendWs.send(JSON.stringify(msg));
            }
          } else {
            console.warn(`[Tunnel Security] Bloccato frame mutante da tunnel pubblico: ${msg?.type || 'unknown'}`);
          }
        } catch {}
      });

      backendWs.on('close', () => {
        if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
      });
      clientWs.on('close', () => {
        if (backendWs.readyState === WebSocket.OPEN) backendWs.close();
      });

      backendWs.on('error', () => {
        try { clientWs.close(1011, 'Backend connection error'); } catch {}
      });
      clientWs.on('error', () => {
        try { backendWs.close(); } catch {}
      });
    });

    previewServer.listen(port, '127.0.0.1', () => {
      console.log(`🔒 [Tunnel Preview Server] Isolato su http://127.0.0.1:${port} con API Proxy & WebSocket sicuro per: ${dirPath}`);
      resolve(previewServer);
    });
    previewServer.on('error', reject);
  });
}

function resetAutoStopTimer(broadcastFn) {
  if (autoStopTimer) {
    clearTimeout(autoStopTimer);
    autoStopTimer = null;
  }
  autoStopTimer = setTimeout(async () => {
    console.log('⏰ [Tunnel Manager] Auto-spegnimento per timeout inattività (15 minuti).');
    await stopTunnel(broadcastFn, 'timeout_15m');
  }, AUTO_STOP_MS);
}

function killProcessTreeSync(proc) {
  if (!proc || !proc.pid) return;
  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: 'ignore', windowsHide: true });
    } catch {}
  } else {
    try {
      proc.kill('SIGKILL');
    } catch {}
  }
}

function startTunnel({ targetDir = null, port = PREVIEW_PORT, broadcastFn = null } = {}) {
  if (tunnelStatus === 'active' && publicUrl && tunnelProcess) {
    resetAutoStopTimer(broadcastFn);
    return Promise.resolve({
      ok: true,
      active: true,
      url: publicUrl,
      localUrl: targetUrl,
      previewPort: port,
      targetDirectory,
      status: tunnelStatus,
      startedAt,
      timeoutMinutes: 15,
      message: 'Tunnel già attivo'
    });
  }

  if (startPromise) {
    return startPromise;
  }

  if (!fs.existsSync(BIN_PATH)) {
    lastError = `Eseguibile cloudflared non trovato in ${BIN_PATH}`;
    tunnelStatus = 'error';
    return Promise.resolve({ ok: false, error: lastError });
  }

  targetDirectory = targetDir ? path.resolve(targetDir) : routing.getTargetProject();
  if (!fs.existsSync(targetDirectory)) {
    lastError = `Directory target non trovata: ${targetDirectory}`;
    return Promise.resolve({ ok: false, error: lastError });
  }

  targetUrl = `http://127.0.0.1:${port}`;
  tunnelStatus = 'starting';
  lastError = null;

  startPromise = new Promise(async (resolve) => {
    try {
      await startPreviewServer(targetDirectory, port);
    } catch (serverErr) {
      startPromise = null;
      lastError = `Errore avvio preview server su porta ${port}: ${serverErr.message}`;
      tunnelStatus = 'error';
      resolve({ ok: false, error: lastError });
      return;
    }

    let resolved = false;
    const timeoutHandle = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        startPromise = null;
        lastError = 'Timeout attesa URL trycloudflare.com (25s)';
        tunnelStatus = 'error';
        killProcessTreeSync(tunnelProcess);
        tunnelProcess = null;
        closePreviewServer();
        resolve({ ok: false, error: lastError });
      }
    }, 25000);

    try {
      tunnelProcess = spawn(BIN_PATH, ['tunnel', '--url', targetUrl, '--no-autoupdate'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (spawnErr) {
      clearTimeout(timeoutHandle);
      startPromise = null;
      lastError = `Errore spawn cloudflared: ${spawnErr.message}`;
      tunnelStatus = 'error';
      closePreviewServer();
      resolve({ ok: false, error: lastError });
      return;
    }

    const checkOutput = (dataChunk) => {
      const text = dataChunk.toString();
      const match = text.match(URL_REGEX);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timeoutHandle);
        startPromise = null;
        publicUrl = match[0].trim();
        tunnelStatus = 'active';
        startedAt = new Date().toISOString();
        resetAutoStopTimer(broadcastFn);

        console.log(`🌐 [Tunnel Manager] Live Preview attiva con successo: ${publicUrl} -> ${targetUrl} (target: ${targetDirectory})`);

        if (typeof broadcastFn === 'function') {
          broadcastFn({
            type: 'tunnelStatusChanged',
            status: 'active',
            active: true,
            url: publicUrl,
            localUrl: targetUrl,
            previewPort: port,
            targetDirectory,
            startedAt,
            timeoutMinutes: 15
          });
        }

        resolve({
          ok: true,
          active: true,
          url: publicUrl,
          localUrl: targetUrl,
          previewPort: port,
          targetDirectory,
          startedAt,
          timeoutMinutes: 15
        });
      }
    };

    if (tunnelProcess.stdout) tunnelProcess.stdout.on('data', checkOutput);
    if (tunnelProcess.stderr) tunnelProcess.stderr.on('data', checkOutput);

    tunnelProcess.on('error', (err) => {
      console.warn('[Tunnel Manager] Process error:', err.message);
      lastError = err.message;
      if (!resolved) {
        resolved = true;
        clearTimeout(timeoutHandle);
        startPromise = null;
        tunnelStatus = 'error';
        closePreviewServer();
        resolve({ ok: false, error: err.message });
      }
    });

    tunnelProcess.on('exit', (code, signal) => {
      console.log(`[Tunnel Manager] Processo cloudflared terminato (code: ${code}, signal: ${signal})`);
      if (autoStopTimer) {
        clearTimeout(autoStopTimer);
        autoStopTimer = null;
      }
      const wasActive = tunnelStatus === 'active';
      tunnelProcess = null;
      publicUrl = null;
      tunnelStatus = 'inactive';
      startedAt = null;
      startPromise = null;
      closePreviewServer();

      if (!resolved) {
        resolved = true;
        clearTimeout(timeoutHandle);
        resolve({ ok: false, error: `cloudflared è uscito prematuramente con codice ${code}` });
      }

      if (wasActive && typeof broadcastFn === 'function') {
        broadcastFn({
          type: 'tunnelStatusChanged',
          status: 'inactive',
          active: false,
          url: null,
          reason: 'process_exit'
        });
      }
    });
  });

  return startPromise;
}

async function stopTunnel(broadcastFn = null, reason = 'user_request') {
  if (autoStopTimer) {
    clearTimeout(autoStopTimer);
    autoStopTimer = null;
  }
  startPromise = null;

  const oldUrl = publicUrl;
  tunnelStatus = 'stopping';

  if (tunnelProcess) {
    killProcessTreeSync(tunnelProcess);
    tunnelProcess = null;
  }
  closePreviewServer();

  publicUrl = null;
  tunnelStatus = 'inactive';
  startedAt = null;

  console.log(`🛑 [Tunnel Manager] Live Preview tunnel fermato (${reason}).`);

  if (typeof broadcastFn === 'function') {
    broadcastFn({
      type: 'tunnelStatusChanged',
      status: 'inactive',
      active: false,
      url: null,
      previousUrl: oldUrl,
      reason
    });
  }

  return { ok: true, active: false, status: 'inactive', reason };
}

// Chiusura anti-zombie al terminare del processo server principale
const cleanupAntiZombie = () => {
  if (tunnelProcess) {
    killProcessTreeSync(tunnelProcess);
    tunnelProcess = null;
  }
  closePreviewServer();
};
process.on('exit', cleanupAntiZombie);
process.on('SIGINT', cleanupAntiZombie);
process.on('SIGTERM', cleanupAntiZombie);

module.exports = {
  getStatus,
  startTunnel,
  stopTunnel,
  getPublicUrl: () => publicUrl,
  isActive: () => tunnelStatus === 'active',
  PREVIEW_PORT,
  BLACKLIST_RE,
  TUNNEL_SAFE_API_WHITELIST,
  isAllowedTunnelApi,
  createPreviewServer,
  startPreviewServer,
  proxyHttpRequest,
  closePreviewServer
};
