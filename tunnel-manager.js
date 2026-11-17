// Modulo Tunnel Manager: Live Preview Mobile Globale con Cloudflare (Idea #4)
// Sicurezza: porta isolata (3001) per decoupling dal control panel, blacklist su segreti e hard timeout 15m
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn, execFile, execSync } = require('child_process');
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

function createPreviewServer(dirPath) {
  return http.createServer((req, res) => {
    try {
      const parsedUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      let reqPath = decodeURIComponent(parsedUrl.pathname);

      if (reqPath.includes('\0')) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        return res.end('Bad Request');
      }

      // Blacklist check su tutti i segmenti del percorso
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
        // Fallback: cerca dentro public/ se presente
        const publicFallback = path.join(dirPath, 'public', '.' + reqPath);
        if (fs.existsSync(publicFallback) && !fs.statSync(publicFallback).isDirectory()) {
          return serveFile(publicFallback, res);
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

function startPreviewServer(dirPath, port = PREVIEW_PORT) {
  if (previewServer) {
    try { previewServer.close(); } catch {}
  }
  return new Promise((resolve, reject) => {
    previewServer = createPreviewServer(dirPath);
    previewServer.listen(port, '127.0.0.1', () => {
      console.log(`🔒 [Tunnel Preview Server] Isolato su http://127.0.0.1:${port} per directory: ${dirPath}`);
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
        if (previewServer) { try { previewServer.close(); } catch {} previewServer = null; }
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
      if (previewServer) { try { previewServer.close(); } catch {} previewServer = null; }
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
        if (previewServer) { try { previewServer.close(); } catch {} previewServer = null; }
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
      if (previewServer) { try { previewServer.close(); } catch {} previewServer = null; }

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
  if (previewServer) {
    try { previewServer.close(); } catch {}
    previewServer = null;
  }

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
  if (previewServer) {
    try { previewServer.close(); } catch {}
    previewServer = null;
  }
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
  BLACKLIST_RE
};
