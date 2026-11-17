const { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits, AttachmentBuilder } = require('discord.js');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const routing = require('./routing');
const { resolveLanguageServer } = require('./antigravity-path');

const DAEMON_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'daemon');
let cachedDaemonConfig = null;

async function probeDaemonConfig(cfg) {
  return new Promise(resolve => {
    const body = JSON.stringify({});
    const req = http.request({
      hostname: '127.0.0.1',
      port: cfg.httpPort,
      path: '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary',
      method: 'POST',
      timeout: 1000,
      headers: {
        'Content-Type': 'application/json',
        'x-codeium-csrf-token': cfg.csrfToken,
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });
}

async function getActiveDaemonConfig() {
  if (cachedDaemonConfig && await probeDaemonConfig(cachedDaemonConfig)) {
    return cachedDaemonConfig;
  }
  cachedDaemonConfig = null;
  try {
    if (!fs.existsSync(DAEMON_DIR)) return null;
    const hubFiles = fs.readdirSync(DAEMON_DIR)
      .filter(f => f.startsWith('hub_') && f.endsWith('.json'))
      .map(f => {
        const full = path.join(DAEMON_DIR, f);
        return { file: f, mtime: fs.statSync(full).mtimeMs, path: full };
      })
      .sort((a, b) => b.mtime - a.mtime);

    for (const h of hubFiles) {
      try {
        const cfg = JSON.parse(fs.readFileSync(h.path, 'utf8'));
        if (cfg.httpPort && cfg.csrfToken) {
          if (await probeDaemonConfig(cfg)) {
            cachedDaemonConfig = cfg;
            return cfg;
          }
        }
      } catch {}
    }
  } catch {}
  return null;
}

const CONFIG_PATH = path.join(__dirname, 'discord.config.json');
let BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
try {
  if (fs.existsSync(CONFIG_PATH)) {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (cfg.botToken) BOT_TOKEN = cfg.botToken;
  }
} catch (_) {}

const SUBAGENT_CHANNELS = {
  'alberto-ceo': { id: 10, channelKeyword: 'alberto', subagentId: routing.PRIMARY[10], name: 'Alberto (CEO)', color: 0x58a6ff },
  'luigi-backend': { id: 6, channelKeyword: 'luigi', subagentId: routing.PRIMARY[6], name: 'Luigi (Backend)', color: 0x2ea043 },
  'gabri-frontend': { id: 7, channelKeyword: 'gabri', subagentId: routing.PRIMARY[7], name: 'Gabri (Frontend)', color: 0xbc8cff },
  'carlo-qa': { id: 8, channelKeyword: 'carlo', subagentId: routing.PRIMARY[8], name: 'Carlo (QA & Security)', color: 0xd29922 }
};
try {
  const teamCfgPath = path.join(__dirname, 'team.config.json');
  if (fs.existsSync(teamCfgPath)) {
    const customTeam = JSON.parse(fs.readFileSync(teamCfgPath, 'utf8'));
    if (Array.isArray(customTeam) && customTeam.length > 0) {
      for (const k of Object.keys(SUBAGENT_CHANNELS)) delete SUBAGENT_CHANNELS[k];
      for (const m of customTeam) {
        const key = m.key || `agent-${m.id}`;
        SUBAGENT_CHANNELS[key] = {
          id: Number(m.id),
          channelKeyword: (m.channelKeyword || m.name || '').toLowerCase().split(' ')[0],
          subagentId: routing.PRIMARY[Number(m.id)],
          name: m.name || `Agent ${m.id}`,
          color: Number(m.color) || 0x58a6ff
        };
      }
    }
  }
} catch (_) {}

// ====================================================================
// SICUREZZA & MODERAZIONE DISCORD — ACCESSO ESCLUSIVO ALBERTOESPO
// I membri con ruolo 'Cooksnkrs' e generici hanno accesso in SOLA LETTURA
// ====================================================================
const AUTHORIZED_USERS = ['albertoespo'];
const RESTRICTED_ROLES = ['cooksnkrs'];

function isUserAuthorized(userOrMember, guild = null) {
  if (!userOrMember) return false;

  // 1. Controllo username o tag utente
  const userObj = userOrMember.user || userOrMember;
  const username = String(userObj.username || '').toLowerCase().trim();
  const tag = String(userObj.tag || '').toLowerCase().trim();

  if (AUTHORIZED_USERS.includes(username) || AUTHORIZED_USERS.some(u => tag.startsWith(u))) {
    return true;
  }

  // 2. Controllo ruoli e permessi GuildMember
  let member = userOrMember.roles ? userOrMember : null;
  if (!member && guild && guild.members && userObj.id) {
    member = (guild.members.cache && typeof guild.members.cache.get === 'function')
      ? guild.members.cache.get(userObj.id)
      : null;
  }

  if (member) {
    // Permessi Administrator o ManageGuild sul server
    if (member.permissions && typeof member.permissions.has === 'function') {
      if (member.permissions.has(PermissionFlagsBits.Administrator) || member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return true;
      }
    }

    // Ruoli autorizzati (es. 'CEO', 'Alberto', 'AziendaAI Admin')
    if (member.roles && member.roles.cache) {
      const roleNames = (Array.isArray(member.roles.cache) ? member.roles.cache : Array.from(member.roles.cache.values ? member.roles.cache.values() : member.roles.cache)).map(r => String(r.name || '').toLowerCase());
      if (roleNames.some(r => r === 'ceo' || r === 'alberto' || r === 'aziendaai admin' || r === 'autorizzato')) {
        return true;
      }
      // Se ha il ruolo ristretto 'Cooksnkrs' e nessun ruolo admin
      if (roleNames.some(r => RESTRICTED_ROLES.includes(r))) {
        return false;
      }
    }
  }

  return false;
}

async function applyChannelModerationPermissions(guild) {
  if (!guild || !guild.channels) {
    return { ok: false, error: 'Guild non valida o non disponibile' };
  }

  // Verifica permessi del bot sul server
  const me = guild.members ? guild.members.me : null;
  const canManage = me && me.permissions && typeof me.permissions.has === 'function' &&
    (me.permissions.has(PermissionFlagsBits.ManageChannels) || me.permissions.has(PermissionFlagsBits.Administrator));

  if (!canManage) {
    return { ok: false, error: 'Permessi insufficienti del bot (richiesto ManageChannels o Administrator)' };
  }

  try {
    await guild.channels.fetch().catch(() => {});
    await guild.roles.fetch().catch(() => {});
    await guild.members.fetch().catch(() => {});

    // Ricerca ruolo Cooksnkrs
    const cooksnkrsRole = guild.roles.cache.find(r => String(r.name || '').toLowerCase() === 'cooksnkrs');
    // Ricerca utente autorizzato albertoespo
    const albertoMember = guild.members.cache.find(m => m.user && String(m.user.username || '').toLowerCase() === 'albertoespo');
    const everyoneRole = guild.roles.everyone;

    const managedKeywords = ['alberto', 'ceo', 'luigi', 'backend', 'gabri', 'frontend', 'carlo', 'qa', 'security', 'sala-operativa', 'pannello-controllo', 'monitor-usage'];
    const channelsToSecure = guild.channels.cache.filter(c => c.isTextBased() && managedKeywords.some(kw => c.name.toLowerCase().includes(kw)));

    let configuredCount = 0;

    for (const channel of channelsToSecure.values()) {
      try {
        const overwrites = [];

        // 1. Regola base per @everyone: sola lettura
        if (everyoneRole) {
          overwrites.push({
            id: everyoneRole.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
            deny: [
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.SendMessagesInThreads,
              PermissionFlagsBits.AddReactions,
              PermissionFlagsBits.CreatePublicThreads,
              PermissionFlagsBits.CreatePrivateThreads
            ]
          });
        }

        // 2. Ruolo Cooksnkrs: sola lettura tassativa (SendMessages: false, AddReactions: false)
        if (cooksnkrsRole) {
          overwrites.push({
            id: cooksnkrsRole.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
            deny: [
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.SendMessagesInThreads,
              PermissionFlagsBits.AddReactions,
              PermissionFlagsBits.CreatePublicThreads,
              PermissionFlagsBits.CreatePrivateThreads
            ]
          });
        }

        // 3. Utente autorizzato albertoespo: permessi completi di scrittura e interazione
        if (albertoMember) {
          overwrites.push({
            id: albertoMember.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.SendMessagesInThreads,
              PermissionFlagsBits.AddReactions,
              PermissionFlagsBits.EmbedLinks,
              PermissionFlagsBits.AttachFiles
            ]
          });
        }

        // 4. Bot stesso: permessi completi per funzionamento automazioni
        if (me) {
          overwrites.push({
            id: me.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.SendMessagesInThreads,
              PermissionFlagsBits.AddReactions,
              PermissionFlagsBits.EmbedLinks,
              PermissionFlagsBits.AttachFiles,
              PermissionFlagsBits.ManageMessages
            ]
          });
        }

        if (channel.permissionOverwrites && typeof channel.permissionOverwrites.set === 'function') {
          await channel.permissionOverwrites.set(overwrites);
          configuredCount++;
        }
      } catch (chErr) {
        console.warn(`[Discord Bot] Impossibile applicare permessi su #${channel.name}:`, chErr.message);
      }
    }

    return {
      ok: true,
      channelsConfigured: configuredCount,
      roleFound: Boolean(cooksnkrsRole),
      albertoFound: Boolean(albertoMember)
    };
  } catch (err) {
    console.warn('[Discord Bot] applyChannelModerationPermissions fallita:', err.message);
    return { ok: false, error: err.message };
  }
}

// ====================================================================
// MULTIMODALITÀ & VOICE STT GEMINI FLASH (CHECKLIST CARLO & ALBERTO CEO)
// ====================================================================
const ALLOWED_IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const ALLOWED_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const ALLOWED_AUDIO_EXTS = ['.ogg', '.mp3', '.wav', '.m4a'];
const ALLOWED_AUDIO_MIMES = ['audio/ogg', 'audio/mpeg', 'audio/wav', 'audio/wave', 'audio/x-wav', 'audio/mp4', 'audio/x-m4a'];
const OUTBOUND_BLACKLIST_RE = /(\.env|\.config\.json|tasks_queue\.json|\.git|\.vbs|\.sh|\.bat|node_modules)/i;
const MAX_UPLOAD_SIZE = 10 * 1024 * 1024; // 10 MB (Checklist Carlo)

const uploadRateLimits = new Map(); // userId -> [timestamps]

function checkUploadRateLimit(userId) {
  const now = Date.now();
  const windowMs = 30000; // 30s
  const maxAttempts = 3;   // max 3 tentativi (Checklist Carlo)
  let timestamps = uploadRateLimits.get(userId) || [];
  timestamps = timestamps.filter(t => now - t < windowMs);
  if (timestamps.length >= maxAttempts) {
    uploadRateLimits.set(userId, timestamps);
    return false;
  }
  timestamps.push(now);
  uploadRateLimits.set(userId, timestamps);
  return true;
}

function validateImageMagicBytes(buffer) {
  if (!buffer || buffer.length < 12) return false;
  // PNG: 89 50 4E 47 (\x89PNG)
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return 'png';
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return 'jpeg';
  }
  // GIF: 47 49 46 38 (GIF8)
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    return 'gif';
  }
  // WEBP: RIFF (byte 0-3) ... WEBP (byte 8-11)
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    return 'webp';
  }
  // ⛔ Esclude tassativamente SVG, ICO o eseguibili mascherati
  return false;
}

function validateOutboundImagePath(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') return { ok: false, error: 'Percorso file non valido' };
  let clean = rawPath.trim().replace(/^file:\/\/\/?/i, '');
  if (process.platform === 'win32' && clean.startsWith('/') && clean.length > 2 && clean[2] === ':') {
    clean = clean.slice(1);
  }
  const resolved = path.resolve(clean);
  if (!fs.existsSync(resolved)) {
    return { ok: false, error: `File immagine non trovato sul disco: ${resolved}` };
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    return { ok: false, error: `Il percorso non corrisponde a un file: ${resolved}` };
  }
  if (stat.size > MAX_UPLOAD_SIZE) {
    return { ok: false, error: `Dimensione immagine supera il limite massimo consentito di 10MB (${(stat.size / (1024 * 1024)).toFixed(1)}MB)` };
  }
  const ext = path.extname(resolved).toLowerCase();
  if (!ALLOWED_IMAGE_EXTS.includes(ext)) {
    return { ok: false, error: `Estensione file non consentita: ${ext} (ammessi: png, jpg, jpeg, webp, gif)` };
  }
  if (OUTBOUND_BLACKLIST_RE.test(resolved)) {
    return { ok: false, error: 'Accesso a file protetti o di configurazione aziendale vietato' };
  }
  return { ok: true, path: resolved, filename: path.basename(resolved) };
}

function getGeminiApiKey() {
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim()) return process.env.GEMINI_API_KEY.trim();
  if (process.env.GOOGLE_API_KEY && process.env.GOOGLE_API_KEY.trim()) return process.env.GOOGLE_API_KEY.trim();
  try {
    const cfgPath = path.join(__dirname, 'discord.config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (cfg.geminiApiKey && String(cfg.geminiApiKey).trim()) return String(cfg.geminiApiKey).trim();
      if (cfg.googleApiKey && String(cfg.googleApiKey).trim()) return String(cfg.googleApiKey).trim();
    }
  } catch {}
  return null;
}

async function downloadAttachment(url, targetPath, maxSize = MAX_UPLOAD_SIZE) {
  return new Promise((resolve, reject) => {
    const parentDir = path.dirname(targetPath);
    if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });

    const fileStream = fs.createWriteStream(targetPath);
    let downloadedBytes = 0;

    const req = https.get(url, { timeout: 10000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fileStream.close();
        try { fs.unlinkSync(targetPath); } catch {}
        return downloadAttachment(res.headers.location, targetPath, maxSize).then(resolve).catch(reject);
      }

      if (res.statusCode !== 200) {
        fileStream.close();
        try { fs.unlinkSync(targetPath); } catch {}
        return reject(new Error(`Download fallito con status HTTP ${res.statusCode}`));
      }

      const contentLength = parseInt(res.headers['content-length'] || '0', 10);
      if (contentLength > maxSize) {
        req.destroy();
        fileStream.close();
        try { fs.unlinkSync(targetPath); } catch {}
        return reject(new Error(`Dimensione file supera il limite massimo di ${maxSize / (1024 * 1024)}MB`));
      }

      res.on('data', chunk => {
        downloadedBytes += chunk.length;
        if (downloadedBytes > maxSize) {
          req.destroy();
          fileStream.close();
          try { fs.unlinkSync(targetPath); } catch {}
          return reject(new Error(`Dimensione file supera il limite massimo di ${maxSize / (1024 * 1024)}MB`));
        }
      });

      res.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close(() => resolve({ path: targetPath, size: downloadedBytes }));
      });
    });

    req.on('timeout', () => {
      req.destroy();
      fileStream.close();
      try { fs.unlinkSync(targetPath); } catch {}
      reject(new Error('Timeout durante il download dell\'allegato (10s)'));
    });

    req.on('error', err => {
      fileStream.close();
      try { fs.unlinkSync(targetPath); } catch {}
      reject(err);
    });
  });
}

async function transcribeAudioWithGemini(audioBuffer, mimeType = 'audio/ogg') {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    return {
      ok: false,
      error: 'Chiave GEMINI_API_KEY non configurata. Imposta "geminiApiKey" in discord.config.json o la variabile d\'ambiente GEMINI_API_KEY.'
    };
  }

  const base64Audio = audioBuffer.toString('base64');
  const payload = JSON.stringify({
    contents: [
      {
        parts: [
          {
            inlineData: {
              mimeType: mimeType || 'audio/ogg',
              data: base64Audio
            }
          },
          {
            text: 'Trascrivi fedelmente e integralmente questo messaggio vocale in italiano. Restituisci SOLO ed esclusivamente la trascrizione testuale, senza aggiungere commenti, punteggiature fittizie o preamboli.'
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 1024
    }
  });

  const models = ['gemini-2.0-flash', 'gemini-1.5-flash'];
  let lastErr = null;

  for (const model of models) {
    try {
      const transcription = await new Promise((resolve, reject) => {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const req = https.request(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          },
          timeout: 20000 // 20s timeout da checklist Carlo
        }, (res) => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              try {
                const json = JSON.parse(data);
                const text = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
                if (text) {
                  resolve(text);
                } else {
                  reject(new Error('Nessun testo estratto dalla risposta del modello'));
                }
              } catch (e) {
                reject(e);
              }
            } else {
              reject(new Error(`Gemini API HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
            }
          });
        });

        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Timeout durante la trascrizione con Gemini Flash (20s)'));
        });

        req.write(payload);
        req.end();
      });

      return { ok: true, text: transcription, modelUsed: model };
    } catch (err) {
      lastErr = err;
    }
  }

  return { ok: false, error: lastErr ? lastErr.message : 'Trascrizione vocale non riuscita' };
}

async function sendDiscordImage(agentIdOrChannelName, imagePath, caption = '') {
  if (!client || !client.isReady()) {
    return { ok: false, error: 'Client Discord non connesso o non pronto' };
  }
  const valid = validateOutboundImagePath(imagePath);
  if (!valid.ok) {
    return valid;
  }

  let channelKey = null;
  const numId = Number(agentIdOrChannelName);
  if (!isNaN(numId)) {
    const entry = Object.entries(SUBAGENT_CHANNELS).find(([, a]) => a.id === numId);
    if (entry) channelKey = entry[0];
  } else {
    channelKey = String(agentIdOrChannelName || '').toLowerCase().trim();
  }

  const agentEntry = SUBAGENT_CHANNELS[channelKey] || Object.values(SUBAGENT_CHANNELS)[0];
  const attachment = new AttachmentBuilder(valid.path, { name: valid.filename });

  let sentCount = 0;
  for (const guild of client.guilds.cache.values()) {
    const channel = guild.channels.cache.find(c =>
      c.isTextBased() && c.name && (c.name === agentEntry.channelName || c.name.toLowerCase().includes(agentEntry.channelKeyword.toLowerCase()))
    );
    if (channel) {
      try {
        const embed = new EmbedBuilder()
          .setTitle(`🖼️ Output Visivo da ${agentEntry.name}`)
          .setDescription(caption ? caption.slice(0, 2000) : `Allegato: \`${valid.filename}\``)
          .setColor(agentEntry.color)
          .setImage(`attachment://${valid.filename}`)
          .setFooter({ text: 'AziendaAI • Output Multimodale' })
          .setTimestamp();

        await channel.send({ embeds: [embed], files: [attachment] });
        sentCount++;
      } catch (err) {
        console.warn(`[Discord Bot] Errore invio immagine in #${channel.name}:`, err.message);
      }
    }
  }

  return { ok: sentCount > 0, sentCount, filename: valid.filename };
}

let client = null;
let broadcastCallback = null;

function dispatchTaskToSubagent(targetId, targetName, content, username = 'Discord', onDone = null) {
  const activeProj = routing.getTargetProject();
  const msgContent = `[Progetto Target Attivo: ${activeProj}] Messaggio operativo ricevuto da Discord (${username}): ${content}`;

  getActiveDaemonConfig().then(daemonCfg => {
    const childEnv = Object.assign({}, process.env);
    if (daemonCfg && daemonCfg.httpPort) {
      childEnv.ANTIGRAVITY_LS_ADDRESS = `127.0.0.1:${daemonCfg.httpPort}`;
    }
    if (daemonCfg && daemonCfg.csrfToken) {
      childEnv.ANTIGRAVITY_CSRF_TOKEN = daemonCfg.csrfToken;
    }

    execFile(resolveLanguageServer(), ['agentapi', 'send-message', routing.resolveSubagent(targetId), msgContent], { timeout: 15000, windowsHide: true, env: childEnv }, (err, stdout, stderr) => {
      if (err) {
        console.warn(`[Discord Bot] Errore recapito a ${targetName}: ${err.message}`);
        if (onDone) onDone(err);
      } else {
        if (broadcastCallback) {
          broadcastCallback({
            type: 'agentActivity',
            id: targetId,
            agentId: targetId,
            tool: 'Discord Inbound',
            status: `Task da Discord: ${content.slice(0, 50)}`,
            log: `[${new Date().toLocaleTimeString()}] 💬 Ricevuto da Discord (${username}): "${content}"`
          });
        }
        if (onDone) onDone(null);
      }
    });
  }).catch(daemonErr => {
    console.warn(`[Discord Bot] Errore interno connessione Antigravity: ${daemonErr.message}`);
    if (onDone) onDone(daemonErr);
  });
}

function buildPanelActionRows() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('panel_ceo_report').setLabel('📊 Report CEO').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('panel_standup').setLabel('📢 Standup Meeting').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('panel_team_status').setLabel('👥 Stato Squadra').setStyle(ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('panel_tunnel_toggle').setLabel('🌐 Live Preview Mobile').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('panel_war_room').setLabel('⚔️ War Room / Red Team Drill').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('panel_security_audit').setLabel('🛡️ Audit Sicurezza').setStyle(ButtonStyle.Secondary)
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('panel_memory_view').setLabel('🧬 Memoria & Skill').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('panel_digest_toggle').setLabel('🌙 Daily Digest').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('panel_git_check').setLabel('🐙 Git Check').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('panel_refresh_quota').setLabel('🔄 Aggiorna Quote').setStyle(ButtonStyle.Primary)
  );
  return [row1, row2, row3];
}

function getControlPanelEmbed() {
  return new EmbedBuilder()
    .setTitle('🎛️ Centro di Comando Rapido — AziendaAI')
    .setDescription('Seleziona un pulsante per impartire un ordine immediato ad **Alberto (CEO)**.\nOgni richiesta verrà inoltrata nella sua chat operativa.')
    .setColor(0x58a6ff)
    .addFields(
      { name: '📊 Report CEO', value: 'Genera il report esecutivo sprint', inline: true },
      { name: '📢 Standup Meeting', value: 'Convoca la riunione generale', inline: true },
      { name: '👥 Stato Squadra', value: 'Check attività e agenti attivi', inline: true },
      { name: '🌐 Live Preview Mobile', value: 'Tunnel pubblico Cloudflare (HTTPS) per test da smartphone', inline: true },
      { name: '⚔️ War Room Drill', value: 'Red Team (Carlo) vs Blue Team (Luigi)', inline: true },
      { name: '🛡️ Audit Sicurezza', value: 'Ispezione codice e dipendenze', inline: true },
      { name: '🧬 Memoria & Skill', value: 'Riepilogo regole, preferenze e grafo skill', inline: true },
      { name: '🌙 Daily Digest', value: 'Toggle digest notturno (Zero consumo quote se OFF)', inline: true },
      { name: '🐙 Git Check', value: 'Verifica branch e modifiche git', inline: true },
      { name: '🔄 Aggiorna Quote', value: 'Sincronizza telemetria quote live', inline: true }
    )
    .setFooter({ text: 'AziendaAI Control Panel • Digita !panel per rigenerare questo pannello' })
    .setTimestamp();
}

async function renderControlPanelMessage(channel) {
  try {
    const rows = buildPanelActionRows();
    const embed = getControlPanelEmbed();
    const msgs = await channel.messages.fetch({ limit: 10 }).catch(() => null);
    if (msgs && msgs.size > 0) {
      const existingMsg = msgs.find(m => m.author.id === client.user.id && m.components && m.components.length > 0);
      if (existingMsg) {
        await existingMsg.edit({ embeds: [embed], components: rows }).catch(() => {});
        return;
      }
    }
    await channel.send({ embeds: [embed], components: rows }).catch(err => {
      console.warn('[Discord Bot] Invio pannello di controllo fallito:', err.message);
    });
  } catch (err) {
    console.warn('[Discord Bot] renderControlPanelMessage error:', err.message);
  }
}

async function ensureControlPanel(guild) {
  try {
    await guild.channels.fetch().catch(() => {});
    let panelChannel = guild.channels.cache.find(c => c.isTextBased() && c.name.includes('pannello-controllo'));
    const salaChannel = guild.channels.cache.find(c => c.isTextBased() && c.name.includes('sala-operativa'));
    const parentCategory = salaChannel ? salaChannel.parentId : null;

    if (!panelChannel) {
      panelChannel = await guild.channels.create({
        name: '🎛️-pannello-controllo',
        type: ChannelType.GuildText,
        parent: parentCategory,
        topic: '🎛️ Pannello di controllo interattivo per inviare ordini rapidi ad Alberto (CEO).'
      }).catch(err => {
        console.warn('[Discord Bot] Creazione canale pannello-controllo non riuscita:', err.message);
        return null;
      });
    }

    if (panelChannel) {
      await renderControlPanelMessage(panelChannel);
    }
  } catch (err) {
    console.warn('[Discord Bot] ensureControlPanel error:', err.message);
  }
}

function initDiscordBot(onBroadcast) {
  broadcastCallback = onBroadcast;

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel, Partials.Message]
  });

  client.once('clientReady', async () => {
    console.log(`🤖 [Discord Bot] Connesso con successo come ${client.user.tag}`);
    console.log(`📡 [Discord Bot] Monitoraggio canali e invio risposte finali attivo.`);
    if (pendingAnnouncements.length > 0) {
      const queued = pendingAnnouncements.splice(0, pendingAnnouncements.length);
      for (const item of queued) {
        await sendDiscordAnnouncement(item.text, item.color, item.modeKey);
      }
    }
    for (const guild of client.guilds.cache.values()) {
      await ensureControlPanel(guild);
      await applyChannelModerationPermissions(guild);
    }
  });

  // Ricezione comandi dai canali Discord per inviarli ad Antigravity
  client.on('messageCreate', async message => {
    if (message.author.bot) return;

    // CONTROLLO DI SICUREZZA & MODERAZIONE DISCORD
    // Solo l'utente autorizzato ('albertoespo') o membri con ruoli amministrativi possono interagire
    const isAuthorized = isUserAuthorized(message.member || message.author, message.guild);
    const content = message.content.trim();
    const channelName = message.channel.name ? message.channel.name.toLowerCase() : '';

    // Comando manuale per riapplicare i permessi del server se invocato da albertoespo
    if (isAuthorized && (content.toLowerCase() === '!securechannels' || content.toLowerCase() === '!lockdown' || content.toLowerCase() === '!permessi')) {
      if (message.guild) {
        const res = await applyChannelModerationPermissions(message.guild);
        if (res.ok) {
          await message.channel.send(`🛡️ **Permessi di moderazione applicati sui canali aziendali!**\n• Canali protetti: \`${res.channelsConfigured}\`\n• Ruolo \`Cooksnkrs\`: ${res.roleFound ? '🔒 Sola lettura applicata (scrittura e reazioni vietate)' : 'ℹ️ Ruolo non presente sul server'}\n• Utente \`albertoespo\`: ${res.albertoFound ? '✅ Accesso completo scrittura/comandi accordato' : 'ℹ️ Non presente nella cache membri'}`).catch(() => {});
        } else {
          await message.channel.send(`⚠️ Errore applicazione permessi canali: ${res.error}`).catch(() => {});
        }
      }
      return;
    }

    if (!isAuthorized) {
      if (channelName.includes('pannello-controllo')) {
        try { await message.delete().catch(() => {}); } catch {}
        return;
      }
      const isAgentChannel = ['alberto', 'ceo', 'luigi', 'backend', 'gabri', 'frontend', 'carlo', 'qa', 'security', 'sala-operativa'].some(k => channelName.includes(k));
      if (content.startsWith('!') || isAgentChannel) {
        await message.reply('⛔ **Accesso non autorizzato:** Solo **albertoespo** ha i permessi di scrittura e comando nei canali operativi di AziendaAI. I membri del ruolo `Cooksnkrs` hanno accesso in sola lettura.').catch(() => {});
        return;
      }
      return;
    }

    let target = null;

    if (channelName.includes('alberto') || channelName.includes('ceo')) {
      target = SUBAGENT_CHANNELS['alberto-ceo'];
    } else if (channelName.includes('luigi') || channelName.includes('backend')) {
      target = SUBAGENT_CHANNELS['luigi-backend'];
    } else if (channelName.includes('gabri') || channelName.includes('frontend')) {
      target = SUBAGENT_CHANNELS['gabri-frontend'];
    } else if (channelName.includes('carlo') || channelName.includes('qa') || channelName.includes('security')) {
      target = SUBAGENT_CHANNELS['carlo-qa'];
    }

    if (content.toLowerCase().startsWith('!panel')) {
      for (const guild of client.guilds.cache.values()) {
        await ensureControlPanel(guild);
      }
      if (channelName.includes('pannello-controllo')) {
        try { await message.delete().catch(() => {}); } catch {}
      } else {
        await message.channel.send('✅ **Pannello di controllo sincronizzato** nel canale `#🎛️-pannello-controllo`!').catch(() => {});
      }
      return;
    }

    if (channelName.includes('pannello-controllo')) {
      try { await message.delete().catch(() => {}); } catch {}
      return;
    }
    if (content.toLowerCase().startsWith('!project') || content.toLowerCase().startsWith('!workspace') || content.toLowerCase().startsWith('!progetto')) {
      const arg = content.replace(/^!(project|workspace|progetto)\s*/i, '').trim();
      if (!arg || arg.toLowerCase() === 'list') {
        const cur = routing.getTargetProject();
        const list = typeof routing.getProjectsList === 'function' ? routing.getProjectsList() : [];
        let listStr = list.map(p => (p.isActive ? '👉 **[ATTIVO]** ' : '• ') + '**' + p.name + '**: `' + p.path + '`').join('\n');
        await message.channel.send('🏢 **Progetti Software House Registrati:**\n' + (listStr || 'Nessuno') + '\n\n💡 *Usa `!project <nome o percorso>` oppure `!project add <nome> <percorso>`*').catch(() => {});
        return;
      }
      if (arg.toLowerCase().startsWith('add ')) {
        const parts = arg.slice(4).trim().split(/\s+/);
        const name = parts[0];
        const pPath = parts.slice(1).join(' ');
        if (!name || !pPath) {
          await message.channel.send('⚠️ Sintassi corretta: `!project add <NomeProgetto> <PercorsoAssoluto>`').catch(() => {});
          return;
        }
        const res = routing.addProjectToRegistry(name, pPath);
        if (!res.ok) {
          await message.channel.send('❌ **Errore aggiunta progetto:** ' + res.error).catch(() => {});
          return;
        }
        await message.channel.send('🎉 **Progetto "' + name + '" aggiunto e attivato!**\n📂 Percorso: `' + res.projectPath + '`').catch(() => {});
        if (broadcastCallback) {
          broadcastCallback({ type: 'targetProjectChanged', projectPath: res.projectPath, projectName: res.projectName, projects: routing.getProjectsList(), source: 'Discord (' + message.author.username + ')' });
        }
        return;
      }
      const res = typeof routing.selectProjectByNameOrPath === 'function' ? routing.selectProjectByNameOrPath(arg) : routing.setTargetProject(arg);
      if (!res.ok) {
        await message.channel.send('❌ **Errore cambio progetto:** ' + res.error).catch(() => {});
        return;
      }
      await message.channel.send('✅ **Progetto Target aggiornato!**\n📂 Ora il team lavora su: `' + res.projectPath + '`').catch(() => {});
      if (broadcastCallback) {
        broadcastCallback({ type: 'targetProjectChanged', projectPath: res.projectPath, projectName: res.projectName, projects: typeof routing.getProjectsList === 'function' ? routing.getProjectsList() : [], source: 'Discord (' + message.author.username + ')' });
      }
      return;
    }

    if (content.toLowerCase().startsWith('!learn')) {
      const learnArg = content.replace(/^!learn\s*/i, '').trim();
      if (!learnArg) {
        await message.channel.send('💡 **Sintassi comando !learn:**\n`!learn <regola o preferenza>`\n*Esempio:* `!learn preferenza communication-style: Risposte concise e link cliccabili`\n*Esempio:* `!learn regola zero-eval: Vietato l\'uso di eval nei custom tools`').catch(() => {});
        return;
      }

      try {
        const memoryEngine = require('./memory-engine');
        let category = 'rules';
        let key = '';
        let value = learnArg;

        const lower = learnArg.toLowerCase();
        let stripped = learnArg;
        if (lower.startsWith('regola ') || lower.startsWith('rule ')) {
          category = 'rules';
          stripped = learnArg.replace(/^(regola|rule)\s+/i, '');
        } else if (lower.startsWith('preferenza ') || lower.startsWith('preference ')) {
          category = 'preferences';
          stripped = learnArg.replace(/^(preferenza|preference)\s+/i, '');
        } else if (lower.startsWith('feedback ')) {
          category = 'feedback';
          stripped = learnArg.replace(/^feedback\s+/i, '');
        }

        const colonIdx = stripped.indexOf(':');
        const eqIdx = stripped.indexOf('=');
        const splitIdx = (colonIdx > 0 && (eqIdx === -1 || colonIdx < eqIdx)) ? colonIdx : eqIdx;

        if (splitIdx > 1 && splitIdx <= 30) {
          const candidateKey = stripped.slice(0, splitIdx).trim().replace(/[^a-zA-Z0-9_\-:. ]/g, '').replace(/\s+/g, '-').toLowerCase();
          const candidateVal = stripped.slice(splitIdx + 1).trim();
          if (candidateKey.length >= 2 && candidateKey.length <= 64 && candidateVal.length > 0) {
            key = candidateKey;
            value = candidateVal;
          }
        }

        if (!key) {
          const words = stripped.split(/\s+/).slice(0, 4).join('-').replace(/[^a-zA-Z0-9_\-]/g, '').toLowerCase();
          key = words.slice(0, 32) || `learned-${Date.now().toString(36)}`;
          if (key.length < 2) key = `fact-${Date.now().toString(36)}`;
          value = stripped;
        }

        const authorName = message.author.tag || message.author.username || 'Discord User';
        const res = memoryEngine.learnFact(category, key, value, `Discord (${authorName})`);

        if (!res.ok) {
          await message.channel.send(`❌ **Impossibile memorizzare:** ${res.error}`).catch(() => {});
          return;
        }

        const embedSuccess = new EmbedBuilder()
          .setTitle('🧬 Nuova Conoscenza Appresa!')
          .setDescription('L\'informazione è stata acquisita e sincronizzata nel **Memory Engine** aziendale.')
          .setColor(0x2ea043)
          .addFields(
            { name: 'Categoria', value: `\`${res.fact.category}\``, inline: true },
            { name: 'Chiave', value: `\`${res.fact.key}\``, inline: true },
            { name: 'Fonte', value: `\`${res.fact.source}\``, inline: true },
            { name: 'Valore', value: `${res.fact.value}` }
          )
          .setTimestamp();

        await message.channel.send({ embeds: [embedSuccess] }).catch(() => {});

        if (broadcastCallback) {
          broadcastCallback({
            type: 'memoryUpdated',
            subType: 'factLearned',
            fact: res.fact,
            memory: memoryEngine.getMemory(),
            skillGraph: memoryEngine.getSkillGraph(),
            source: `Discord (${authorName})`
          });
        }
      } catch (err) {
        await message.channel.send(`⚠️ Errore durante l'apprendimento: ${err.message}`).catch(() => {});
      }
      return;
    }

    if (content.toLowerCase().startsWith('!digest')) {
      const digestArg = content.replace(/^!digest\s*/i, '').trim().toLowerCase();
      try {
        const memoryEngine = require('./memory-engine');
        if (digestArg === 'run' || digestArg === 'now') {
          const res = memoryEngine.generateDigest({ force: true, source: `Discord (${message.author.username})` });
          if (res.ok) {
            const embed = new EmbedBuilder()
              .setTitle('🌙 Daily Digest Notturno Generato (On-Demand)')
              .setDescription(res.digest.summaryText)
              .setColor(0x58a6ff)
              .addFields(
                { name: 'Workspace', value: `\`${res.digest.activeProject}\``, inline: true },
                { name: 'Regole Apprese', value: `${res.digest.metrics.rulesLearned}`, inline: true },
                { name: 'Preferenze', value: `${res.digest.metrics.preferencesStored}`, inline: true }
              )
              .setTimestamp();
            await message.channel.send({ embeds: [embed] }).catch(() => {});
          } else {
            await message.channel.send(`⚠️ ${res.message}`).catch(() => {});
          }
          return;
        }

        // Toggle on/off
        const newStatus = memoryEngine.toggleDigest();
        const embed = new EmbedBuilder()
          .setTitle(`🌙 Daily Digest Notturno: ${newStatus.enabled ? '🟢 ATTIVO' : '💤 IN PAUSA (ZERO SPRECO)'}`)
          .setDescription(newStatus.enabled
            ? `Daily Digest Notturno **attivato**! Verrà compilato alle ore \`${newStatus.time}\`.`
            : `Daily Digest Notturno **disattivato** per preservare quote AI ed evitare consumi inutili.`)
          .setColor(newStatus.enabled ? 0x2ea043 : 0x8b949e)
          .setTimestamp();
        await message.channel.send({ embeds: [embed] }).catch(() => {});
      } catch (err) {
        await message.channel.send(`⚠️ Errore comando digest: ${err.message}`).catch(() => {});
      }
      return;
    }

    if (content.startsWith('!')) {
      const parts = content.slice(1).split(' ');
      const prefix = parts[0].toLowerCase();
      if (SUBAGENT_CHANNELS[prefix] || SUBAGENT_CHANNELS[`${prefix}-ceo`] || SUBAGENT_CHANNELS[`${prefix}-backend`]) {
        target = SUBAGENT_CHANNELS[prefix] || SUBAGENT_CHANNELS[`${prefix}-ceo`] || SUBAGENT_CHANNELS[`${prefix}-backend`];
      }
    }

    let finalPrompt = content;

    // GESTIONE ALLEGATI MULTIMODALI (FOTO & NOTE VOCALI)
    if (message.attachments && message.attachments.size > 0) {
      if (!target) {
        target = SUBAGENT_CHANNELS['alberto-ceo']; // Default a CEO se allegato inviato in canale generale
      }

      // Rate limit anti-DoS (max 3 ogni 30s)
      if (!checkUploadRateLimit(message.author.id)) {
        await message.reply('⏳ **Rate limit superato:** Massimo 3 upload o note vocali ogni 30 secondi. Riprova tra poco.').catch(() => {});
        return;
      }

      for (const attachment of message.attachments.values()) {
        const mime = (attachment.contentType || '').toLowerCase();
        const ext = path.extname(attachment.name || '').toLowerCase();
        const isVoice = (message.flags && typeof message.flags.has === 'function' && message.flags.has(1 << 13)) || attachment.name?.includes('voice-message');
        const isAudio = isVoice || mime.startsWith('audio/') || ALLOWED_AUDIO_EXTS.includes(ext);
        const isImage = mime.startsWith('image/') || ALLOWED_IMAGE_EXTS.includes(ext);

        // 1. GESTIONE VOCALE CON TRASCRIZIONE GEMINI FLASH
        if (isAudio) {
          if (attachment.size > MAX_UPLOAD_SIZE) {
            await message.reply('⚠️ **File audio troppo grande:** Il limite massimo consentito è 10MB.').catch(() => {});
            return;
          }
          if (!ALLOWED_AUDIO_EXTS.includes(ext) && !ALLOWED_AUDIO_MIMES.some(m => mime.startsWith(m)) && !isVoice) {
            await message.reply(`⚠️ **Formato audio non consentito:** \`${ext || mime}\`. Formati supportati: \`.ogg\`, \`.mp3\`, \`.wav\`, \`.m4a\`.`).catch(() => {});
            return;
          }

          const tempDir = path.join(__dirname, '.tmp', 'audio');
          if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
          const tempAudioPath = path.join(tempDir, `voice_${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ext || '.ogg'}`);

          try {
            await message.channel.sendTyping().catch(() => {});
            await downloadAttachment(attachment.url, tempAudioPath, MAX_UPLOAD_SIZE);
            const audioBuf = fs.readFileSync(tempAudioPath);

            const sttRes = await transcribeAudioWithGemini(audioBuf, mime || 'audio/ogg');
            if (sttRes.ok && sttRes.text) {
              const transcribedText = sttRes.text.trim();
              await message.reply(`🎙️ **Trascrizione vocale (Gemini Flash):**\n> "*${transcribedText}*"`).catch(() => {});
              finalPrompt = `[Nota Vocale Discord da @${message.author.username}]: "${transcribedText}"${finalPrompt ? `\nTesto allegato: ${finalPrompt}` : ''}`;
            } else {
              await message.reply(`⚠️ **Impossibile trascrivere il vocale:** ${sttRes.error}`).catch(() => {});
              return;
            }
          } catch (sttErr) {
            console.warn('[Discord Bot] Errore STT:', sttErr.message);
            await message.reply(`❌ **Errore trascrizione vocale:** ${sttErr.message}`).catch(() => {});
            return;
          } finally {
            try { if (fs.existsSync(tempAudioPath)) fs.unlinkSync(tempAudioPath); } catch {}
          }
          break;
        }

        // 2. GESTIONE FOTO INBOUND
        else if (isImage) {
          if (attachment.size > MAX_UPLOAD_SIZE) {
            await message.reply('⚠️ **Immagine troppo grande:** Il limite massimo consentito è 10MB.').catch(() => {});
            return;
          }
          if (!ALLOWED_IMAGE_EXTS.includes(ext) || !ALLOWED_IMAGE_MIMES.includes(mime)) {
            await message.reply(`⛔ **Formato immagine non consentito:** \`${ext || mime}\`. Formati ammessi: \`.png\`, \`.jpg\`, \`.jpeg\`, \`.webp\`, \`.gif\` (SVG escluso per sicurezza).`).catch(() => {});
            return;
          }

          const uploadsDir = path.join(__dirname, 'uploads', 'inbound_images');
          if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
          const safeName = path.basename(attachment.name || 'image.png').replace(/[^a-zA-Z0-9_\-\.]/g, '_');
          const savedPath = path.join(uploadsDir, `${Date.now()}_${safeName}`);

          try {
            await downloadAttachment(attachment.url, savedPath, MAX_UPLOAD_SIZE);
            const imgBuf = fs.readFileSync(savedPath);
            const detected = validateImageMagicBytes(imgBuf);

            if (!detected) {
              try { fs.unlinkSync(savedPath); } catch {}
              await message.reply('⛔ **Validazione Magic Bytes fallita:** Il file inviato non è un\'immagine valida (PNG, JPEG, WEBP, GIF). Scartato per sicurezza.').catch(() => {});
              return;
            }

            const normalizedPath = `file:///${savedPath.replace(/\\/g, '/')}`;
            finalPrompt = `[Foto allegata: ${normalizedPath}] ${finalPrompt || "Analizza l'immagine allegata."}`;
            await message.reply(`🖼️ **Immagine ricevuta e validata (${detected.toUpperCase()}):** \`${safeName}\``).catch(() => {});
          } catch (imgErr) {
            console.warn('[Discord Bot] Errore salvataggio immagine:', imgErr.message);
            try { if (fs.existsSync(savedPath)) fs.unlinkSync(savedPath); } catch {}
            await message.reply(`❌ **Errore download immagine:** ${imgErr.message}`).catch(() => {});
            return;
          }
        }
      }
    }

    if (!target) return;
    if (!finalPrompt || !finalPrompt.trim()) return;

    // Tutti a riposo: mette il task in coda per eseguirlo automaticamente al risveglio
    if (routing.isResting()) {
      const qPos = routing.enqueueRestTask({ agentId: target.id, text: finalPrompt, source: `Discord (${message.author.username})` });
      message.channel.send(`💤 ${routing.restMessage()}\n📥 **Task messo in coda (#${qPos})**: verrà inviato automaticamente a **${target.name}** appena la quota si ricarica!`).catch(() => {});
      return;
    }

    // Notifica di presa in carico con reazione
    try {
      await message.react('⚡');
    } catch {}

    dispatchTaskToSubagent(target.id, target.name, finalPrompt, message.author.username, (err) => {
      if (err) {
        message.channel.send(`❌ Errore recapito a ${target.name}: ${err.message}`).catch(() => {});
      } else {
        try { message.react('✅'); } catch {}
      }
    });
  });

  // Gestione pulsanti interattivi di autorizzazione permessi su Discord
  client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;

    // CONTROLLO DI SICUREZZA & MODERAZIONE DISCORD PER PULSANTI
    if (!isUserAuthorized(interaction.member || interaction.user, interaction.guild)) {
      await interaction.reply({
        content: '⛔ **Accesso negato:** Solo **albertoespo** ha i permessi di interazione nel Centro di Comando AziendaAI. I membri del ruolo `Cooksnkrs` hanno accesso in sola lettura.',
        ephemeral: true
      }).catch(() => {});
      return;
    }

    if (interaction.customId.startsWith('panel_')) {
      await interaction.reply({
        content: '⚡ Ordine inviato nella chat di Alberto',
        ephemeral: true
      }).catch(() => {});

      const userTag = interaction.user.tag || interaction.user.username;
      let actionTitle = '';
      let actionInstruction = '';

      switch (interaction.customId) {
        case 'panel_ceo_report':
          actionTitle = '📊 Richiesta Report Esecutivo CEO';
          actionInstruction = 'Genera subito il report esecutivo CEO per il progetto e allinea lo stato sprint.';
          break;
        case 'panel_standup':
          actionTitle = '📢 Convocazione Riunione Generale (Standup Meeting)';
          actionInstruction = 'Convoca subito uno Standup Meeting generale con Luigi, Gabri e Carlo per sincronizzare i task.';
          if (broadcastCallback) {
            broadcastCallback({
              type: 'standupMeetingStarted',
              leaderId: 10,
              leaderName: 'Alberto (CEO)',
              topic: 'Standup convocato da Pannello di Controllo Discord',
              durationMs: 15000
            });
          }
          break;
        case 'panel_team_status':
          actionTitle = '👥 Richiesta Verifica Stato Squadra';
          actionInstruction = 'Verifica lo stato operativo della squadra (Luigi, Gabri, Carlo) e riepiloga la situazione corrente.';
          break;
        case 'panel_tunnel_toggle': {
          actionTitle = '🌐 Live Preview Mobile: Gestione Tunnel Cloudflare';
          actionInstruction = 'Attiva o disattiva il tunnel globale Cloudflare su porta isolata 3001 per test da mobile.';
          try {
            const tunnelManager = require('./tunnel-manager');
            const currentStatus = tunnelManager.getStatus();
            const guildObj = interaction.guild;
            const albertoChannel = guildObj ? guildObj.channels.cache.find(c => c.isTextBased() && (c.name.includes('alberto') || c.name.includes('ceo'))) : null;

            if (currentStatus.active) {
              await tunnelManager.stopTunnel(broadcastCallback, 'discord_button');
              if (albertoChannel) {
                const embedClose = new EmbedBuilder()
                  .setTitle('🌐 Live Preview Mobile — Tunnel Disattivato')
                  .setDescription(`Il tunnel pubblico Cloudflare è stato **chiuso** da <@${interaction.user.id}>.\nL'accesso esterno da mobile è ora disattivato.`)
                  .setColor(0xda3633)
                  .setTimestamp();
                await albertoChannel.send({ embeds: [embedClose] }).catch(() => {});
              }
            } else {
              if (albertoChannel) {
                await albertoChannel.send('⏳ *Avvio tunnel Cloudflare isolato (preview porta 3001)... Generazione URL HTTPS...*').catch(() => {});
              }
              const resTunnel = await tunnelManager.startTunnel({ broadcastFn: broadcastCallback });
              if (resTunnel.ok && resTunnel.url) {
                if (albertoChannel) {
                  const embedActive = new EmbedBuilder()
                    .setTitle('🌐 Live Preview Mobile — URL Pubblica HTTPS Attiva!')
                    .setDescription(`Il tunnel globale Cloudflare è **attivo** per la live preview mobile!\n\n🔗 **URL Pubblica:**\n# [${resTunnel.url}](${resTunnel.url})\n\n📱 *Apri questo link da smartphone o browser esterno per visualizzare il progetto live!*\n⏱️ *Auto-spegnimento di sicurezza dopo 15 minuti.*`)
                    .setColor(0x2ea043)
                    .addFields(
                      { name: 'Porta Isolata Preview', value: `\`${resTunnel.previewPort || 3001}\` (Decoupled)`, inline: true },
                      { name: 'Auto-Shutdown', value: '15 minuti', inline: true },
                      { name: 'Richiesto Da', value: `<@${interaction.user.id}>`, inline: true }
                    )
                    .setTimestamp();
                  await albertoChannel.send({ embeds: [embedActive] }).catch(() => {});
                }
              } else {
                if (albertoChannel) {
                  await albertoChannel.send(`❌ **Errore avvio tunnel Cloudflare:** ${resTunnel.error || 'Impossibile estrarre URL'}`).catch(() => {});
                }
              }
            }
          } catch (err) {
            console.warn('[Discord Bot] Errore tunnel_toggle da bottone:', err.message);
          }
          break;
        }
        case 'panel_war_room':
          actionTitle = '⚔️ Avvio Esercitazione War Room (Red Team vs Blue Team)';
          actionInstruction = 'Avvia subito una sessione War Room: Carlo (Red Team) simula attacchi di sicurezza su target, Luigi (Blue Team) risponde e difende.';
          try {
            const warRoomMod = require('./war-room');
            warRoomMod.startWarRoom({
              broadcastFn: broadcastCallback,
              dispatchFn: (agentId, agentName, prompt) => {
                dispatchTaskToSubagent(agentId, agentName, prompt, userTag);
              }
            });
          } catch (err) {
            console.warn('[Discord Bot] Errore startWarRoom da bottone:', err.message);
          }
          break;
        case 'panel_security_audit':
          actionTitle = '🛡️ Richiesta Audit Sicurezza';
          actionInstruction = 'Coordina con Carlo un audit di sicurezza completo del backend, routing e dipendenze.';
          break;
        case 'panel_memory_view': {
          actionTitle = '🧬 Consultazione Memoria & Skill Graph Aziendale';
          actionInstruction = 'Genera e visualizza il riepilogo delle regole operative, preferenze e grafo skill appreso.';
          try {
            const memoryEngine = require('./memory-engine');
            const mem = memoryEngine.getMemory();
            const skills = memoryEngine.getSkillGraph();
            const guildObj = interaction.guild;
            const albertoChannel = guildObj ? guildObj.channels.cache.find(c => c.isTextBased() && (c.name.includes('alberto') || c.name.includes('ceo'))) : null;

            if (albertoChannel) {
              const rulesText = mem.rules && mem.rules.length > 0
                ? mem.rules.slice(0, 5).map(r => `• **${r.key}**: ${r.value} *(da ${r.source})*`).join('\n')
                : '*Nessuna regola salvata*';
              const prefsText = mem.preferences && mem.preferences.length > 0
                ? mem.preferences.slice(0, 5).map(p => `• **${p.key}**: ${p.value} *(da ${p.source})*`).join('\n')
                : '*Nessuna preferenza salvata*';
              const toolsText = mem.customTools && mem.customTools.length > 0
                ? mem.customTools.slice(0, 5).map(t => `• **${t.name}** [${t.binary}]: ${t.description} (${t.approved ? '✅ Approvato' : '⏳ In attesa di approvazione'})`).join('\n')
                : '*Nessun custom tool registrato*';

              const memEmbed = new EmbedBuilder()
                .setTitle('🧬 Memoria Aziendale & Grafo Competenze — AziendaAI')
                .setDescription('Riepilogo delle regole operative, preferenze e competenze attive nel sistema auto-evolutivo.')
                .setColor(0x2ea043)
                .addFields(
                  { name: `📜 Regole Operative (${mem.rules.length})`, value: rulesText.slice(0, 1024) },
                  { name: `⭐ Preferenze Utente (${mem.preferences.length})`, value: prefsText.slice(0, 1024) },
                  { name: `🛠️ Custom Tools Dichiarativi (${mem.customTools.length})`, value: toolsText.slice(0, 1024) },
                  { name: `🌐 Grafo Competenze`, value: `**Nodi totali:** ${skills.nodes.length} (${skills.totalSkills} skill, ${skills.totalTools} tool, ${skills.totalAgents} agenti)\n**Connessioni:** ${skills.edges.length} relazioni attive`, inline: false }
                )
                .setFooter({ text: `Auto-Evolving Memory • Ultimo aggiornamento: ${new Date(mem.updatedAt).toLocaleTimeString()}` })
                .setTimestamp();

              await albertoChannel.send({ embeds: [memEmbed] }).catch(() => {});
            }
          } catch (err) {
            console.warn('[Discord Bot] Errore visualizzazione memoria da bottone:', err.message);
          }
          break;
        }
        case 'panel_digest_toggle': {
          actionTitle = '🌙 Gestione Daily Digest Notturno';
          actionInstruction = 'Attiva o disattiva il Daily Digest Notturno aziendale per preservare le quote AI.';
          try {
            const memoryEngine = require('./memory-engine');
            const newStatus = memoryEngine.toggleDigest();
            const guildObj = interaction.guild;
            const albertoChannel = guildObj ? guildObj.channels.cache.find(c => c.isTextBased() && (c.name.includes('alberto') || c.name.includes('ceo'))) : null;

            if (albertoChannel) {
              const digestEmbed = new EmbedBuilder()
                .setTitle(`🌙 Daily Digest Notturno: ${newStatus.enabled ? '🟢 ATTIVO' : '💤 IN PAUSA (ZERO SPRECO)'}`)
                .setDescription(newStatus.enabled
                  ? `Il Daily Digest Notturno è stato **attivato** da <@${interaction.user.id}>.\nVerrà generato alle ore \`${newStatus.time}\` con riepilogo sprint e regole apprese.`
                  : `Il Daily Digest Notturno è stato **disattivato** da <@${interaction.user.id}> per preservare quote AI ed energia elettrica. Nessuna risorsa verrà consumata a vuoto durante la notte.`)
                .setColor(newStatus.enabled ? 0x2ea043 : 0x8b949e)
                .addFields(
                  { name: 'Stato', value: newStatus.enabled ? '🟢 Abilitato' : '💤 Pausa per Risparmio Quote', inline: true },
                  { name: 'Orario Programmato', value: `\`${newStatus.time}\``, inline: true },
                  { name: 'Storico Report', value: `${newStatus.historyCount} archiviati`, inline: true }
                )
                .setFooter({ text: 'Daily Digest Config • Risparmio energetico e quote attivo' })
                .setTimestamp();

              await albertoChannel.send({ embeds: [digestEmbed] }).catch(() => {});
            }
          } catch (err) {
            console.warn('[Discord Bot] Errore toggle digest da bottone:', err.message);
          }
          break;
        }
        case 'panel_git_check':
          actionTitle = '🐙 Richiesta Git Status & Check';
          actionInstruction = 'Controlla lo stato git del repository (git status, branch, file modificati).';
          break;
        case 'panel_refresh_quota':
          actionTitle = '🔄 Richiesta Sincronizzazione Telemetria Quote';
          actionInstruction = 'Aggiorna e verifica le quote live di Gemini e Claude e sincronizza la telemetria.';
          break;
        default:
          actionTitle = '⚡ Ordine Operativo';
          actionInstruction = `Esegui comando: ${interaction.customId}`;
      }

      const guild = interaction.guild;
      if (guild) {
        const albertoChannel = guild.channels.cache.find(c => c.isTextBased() && (c.name.includes('alberto') || c.name.includes('ceo')));
        if (albertoChannel) {
          const embedForward = new EmbedBuilder()
            .setTitle(actionTitle)
            .setDescription(`**Mittente:** <@${interaction.user.id}> (\`${userTag}\`)\n**Istruzione inoltrata:**\n> ${actionInstruction}`)
            .setColor(0x58a6ff)
            .setTimestamp();
          await albertoChannel.send({ embeds: [embedForward] }).catch(err => console.warn('[Discord Bot] Inoltro su canale Alberto fallito:', err.message));
        }
      }

      dispatchTaskToSubagent(10, 'Alberto (CEO)', actionInstruction, userTag);
      return;
    }

    const [action, requestId, agentIdStr] = interaction.customId.split('_');
    const agentId = Number(agentIdStr) || 10;
    const isApproved = action === 'approve';

    await interaction.deferUpdate();

    if (broadcastCallback) {
      broadcastCallback({
        type: 'permissionResponseFromDiscord',
        agentId: agentId,
        requestId: requestId,
        approved: isApproved
      });
    }

    const embed = new EmbedBuilder()
      .setTitle(`🛡️ Permesso Risolto da Discord`)
      .setDescription(`Esito: **${isApproved ? '✅ AUTORIZZATO' : '❌ RIFIUTATO'}** dall'Entità Suprema su Discord.`)
      .setColor(isApproved ? 0x2ea043 : 0xda3633)
      .setTimestamp();

    await interaction.editReply({ embeds: [embed], components: [] });
  });

  client.login(BOT_TOKEN).catch(err => {
    console.error('❌ [Discord Bot] Errore login:', err.message);
  });
}

// Invia SOLO LA RISPOSTA FINALE nel canale specifico dell'agente (zero spam di editing o tool)
const recentSentResponses = new Map(); // deduplica messaggi identici inviati a Discord entro 10 secondi

function sendFinalAgentResponse(agentId, text) {
  if (!client || !client.isReady() || !text || !text.trim()) return;

  const agentEntry = Object.values(SUBAGENT_CHANNELS).find(a => a.id === Number(agentId));
  if (!agentEntry) return;

  // Pulisce markdown o link superflui
  const cleanText = text.trim();
  if (cleanText.length === 0) return;

  const dedupKey = `${agentId}:${cleanText.slice(0, 100)}`;
  const lastSentTime = recentSentResponses.get(dedupKey) || 0;
  if (Date.now() - lastSentTime < 10000) {
    return; // Evita duplicazione
  }
  recentSentResponses.set(dedupKey, Date.now());

  const embed = new EmbedBuilder()
    .setTitle(`💬 Risposta di ${agentEntry.name}`)
    .setDescription(cleanText.slice(0, 3950))
    .setColor(agentEntry.color)
    .setFooter({ text: 'AziendaAI • Lavoro completato' })
    .setTimestamp();

  // Outbound image detection: controlla se la risposta dell'agente contiene riferimenti a immagini locali
  const imgMatch = /!\[.*?\]\((file:\/\/\/[^)]+|\S+?\.(?:png|jpg|jpeg|webp|gif))\)/i.exec(cleanText) ||
                   /(?:^|\s)(file:\/\/\/\S+?\.(?:png|jpg|jpeg|webp|gif)|[a-zA-Z]:[\\/][^\s"]+?\.(?:png|jpg|jpeg|webp|gif))/i.exec(cleanText);

  let attachment = null;
  if (imgMatch) {
    const candidatePath = imgMatch[1];
    const valid = validateOutboundImagePath(candidatePath);
    if (valid.ok) {
      attachment = new AttachmentBuilder(valid.path, { name: valid.filename });
      embed.setImage(`attachment://${valid.filename}`);
    }
  }

  client.guilds.cache.forEach(guild => {
    // Trova ESATTAMENTE il canale testuale dedicato all'agente (senza inviare a canali duplicati o non pertinenti)
    const channel = guild.channels.cache.find(c => c.isTextBased() && c.name.toLowerCase().includes(agentEntry.channelKeyword.toLowerCase()));
    if (channel) {
      channel.send({
        embeds: [embed],
        files: attachment ? [attachment] : []
      }).catch(err => {
        console.warn(`[Discord Bot] Errore invio risposta su #${channel.name}:`, err.message);
      });
    }
  });
}

// Invia richiesta di autorizzazione interattiva con pulsanti su Discord
function isPermissionPromptEnabled() {
  return process.env.DISCORD_ENABLE_PERMISSION_PROMPTS === 'true';
}

function sendDiscordPermissionPrompt(requestId, agentId, agentName, tool, command, desc, options = {}) {
  // 1. Circoscritto: disabilitato di default quando Antigravity opera in auto-approvazione / turbo
  const isEnabled = isPermissionPromptEnabled() || Boolean(options && options.forceDiscordPrompt);
  if (!isEnabled) {
    return false;
  }

  // 2. Filtro anti-fantasma: blocca categoricamente simulazioni, test o richieste fittizie
  const reqStr = String(requestId || '').toLowerCase();
  const descStr = String(desc || '').toLowerCase();
  const cmdStr = String(command || '').toLowerCase();
  const isSimOrTest = Boolean(
    (options && options.isSimulation) ||
    reqStr.includes('sim') ||
    reqStr.includes('test') ||
    descStr.includes('simulaz') ||
    descStr.includes('test autorizz') ||
    cmdStr.includes('echo x')
  );

  if (isSimOrTest) {
    return false;
  }

  if (!client || !client.isReady()) return false;

  const agentEntry = Object.values(SUBAGENT_CHANNELS).find(a => a.id === Number(agentId));
  const keyword = agentEntry ? agentEntry.channelKeyword : 'sala-operativa';

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`approve_${requestId}_${agentId}`)
      .setLabel('✅ Autorizza')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`reject_${requestId}_${agentId}`)
      .setLabel('❌ Rifiuta')
      .setStyle(ButtonStyle.Danger)
  );

  const embed = new EmbedBuilder()
    .setTitle(`⚠️ RICHIESTA AUTORIZZAZIONE: ${agentName}`)
    .setDescription(`**Tool:** \`${tool}\`\n**Comando:** \`\`\`bash\n${command}\n\`\`\`\n*${desc}*`)
    .setColor(0xd29922)
    .setFooter({ text: 'Puoi autorizzare o rifiutare direttamente premendo uno dei pulsanti sottostanti' })
    .setTimestamp();

  // Invia ESCLUSIVAMENTE a UN SOLO canale di pertinenza (canale dell'agente, oppure sala-operativa se non trovato)
  client.guilds.cache.forEach(guild => {
    let targetChannel = guild.channels.cache.find(c => c.isTextBased() && c.name.includes(keyword));
    if (!targetChannel) {
      targetChannel = guild.channels.cache.find(c => c.isTextBased() && c.name.includes('sala-operativa'));
    }

    if (targetChannel) {
      targetChannel.send({ embeds: [embed], components: [row] }).catch(err => {
        console.warn(`[Discord Bot] Impossibile inviare prompt su #${targetChannel.name}:`, err.message);
      });
    }
  });

  return true;
}

// Aggiorna la dashboard live delle quote nel canale #📊-monitor-usage
let lastUsageMessageId = null;

async function updateDiscordUsageMonitor(quotaData) {
  if (!client || !client.isReady() || !quotaData) return;

  const geminiWeekly = quotaData.gemini?.weekly ?? 'N/A';
  const gemini5h = quotaData.gemini?.fiveHour ?? 'N/A';
  const claudeWeekly = quotaData.claude?.weekly ?? '100%';
  const claude5h = quotaData.claude?.fiveHour ?? '100%';

  const embed = new EmbedBuilder()
    .setTitle('📊 Monitoraggio Quote & Modelli Antigravity (Live)')
    .setDescription('Stato delle quote e allocazione modelli in tempo reale rilevati direttamente dal Language Server di Antigravity.')
    .setColor(0x58a6ff)
    .addFields(
      {
        name: '🤖 Gemini Models (Flash / Pro)',
        value: `• **Finestra 5 Ore:** \`${gemini5h}\` rimanente (reset: ${quotaData.gemini?.reset5h || 'N/A'})\n• **Finestra Settimanale:** \`${geminiWeekly}\` rimanente (reset: ${quotaData.gemini?.resetWeekly || 'N/A'})`,
        inline: false
      },
      {
        name: '🧠 Claude & GPT Models (Fallback)',
        value: `• **Finestra 5 Ore:** \`${claude5h}\` rimanente (reset: ${quotaData.claude?.reset5h || 'N/A'})\n• **Finestra Settimanale:** \`${claudeWeekly}\` rimanente (reset: ${quotaData.claude?.resetWeekly || 'N/A'})\n• Stato: ${quotaData.resting ? '💤 **TUTTI A RIPOSO**' : (quotaData.claude?.isFallbackActive ? '⚡ **ATTIVO COME FALLBACK**' : '🟢 Pronto per fallback')}`,
        inline: false
      },
      {
        name: '👥 Modelli Subagenti Attivi',
        value: (quotaData.subagents || [
          { name: 'Alberto (CEO)', model: 'Gemini 3.8 Flash (Low)' },
          { name: 'Luigi (Backend)', model: 'Gemini 3.8 Flash (Tiered)' },
          { name: 'Gabri (Frontend)', model: 'Gemini 3.8 Flash (Tiered)' },
          { name: 'Carlo (QA & Revisor)', model: 'Gemini 3.8 Flash (Tiered)' }
        ]).map(a => `• **${a.name}:** \`${a.model}\``).join('\n'),
        inline: false
      }
    )
    .setFooter({ text: 'AziendaAI Telemetry • Aggiornato in tempo reale' })
    .setTimestamp();

  for (const guild of client.guilds.cache.values()) {
    const channel = guild.channels.cache.find(c => c.isTextBased() && (c.name.includes('monitor-usage') || c.name.includes('usage')));
    if (!channel) continue;

    try {
      if (lastUsageMessageId) {
        const msg = await channel.messages.fetch(lastUsageMessageId).catch(() => null);
        if (msg) {
          await msg.edit({ embeds: [embed] });
          continue;
        }
      }
      const newMsg = await channel.send({ embeds: [embed] });
      lastUsageMessageId = newMsg.id;
    } catch (e) {
      console.warn('[Discord Bot] Errore aggiornamento #monitor-usage:', e.message);
    }
  }
}

// Annuncio di transizione di stato in #sala-operativa (con coda se il client non è ancora pronto e deduplica su disco per non ripetere mai lo stesso stato ai riavvii)
const pendingAnnouncements = [];
const LAST_MODE_FILE = path.join(__dirname, '.last_announced_mode');

function getLastAnnouncedMode() {
  try {
    if (fs.existsSync(LAST_MODE_FILE)) {
      return fs.readFileSync(LAST_MODE_FILE, 'utf8').trim();
    }
  } catch {}
  return '';
}

function setLastAnnouncedMode(modeKey) {
  try {
    if (modeKey) fs.writeFileSync(LAST_MODE_FILE, String(modeKey).trim(), 'utf8');
  } catch {}
}

async function sendDiscordAnnouncement(text, color, modeKey = null) {
  if (modeKey) {
    const lastKey = getLastAnnouncedMode();
    if (lastKey === modeKey) return; // Già annunciato questo stato, non inviare duplicati!
  }
  if (!client || !client.isReady()) {
    pendingAnnouncements.push({ text, color, modeKey });
    return;
  }
  let sent = false;
  const embed = new EmbedBuilder().setTitle('🔄 Stato Operativo Squadra & Quote').setDescription(text).setColor(color || 0x58a6ff).setTimestamp();
  for (const guild of client.guilds.cache.values()) {
    const channel = guild.channels.cache.find(c => c.isTextBased() && c.name.includes('sala-operativa'));
    if (channel) {
      const res = await channel.send({ embeds: [embed] }).catch(e => console.warn('[Discord Bot] Annuncio fallito:', e.message));
      if (res) sent = true;
    }
  }
  if (sent && modeKey) {
    setLastAnnouncedMode(modeKey);
    if (typeof routing.setLastDiskMode === 'function') {
      routing.setLastDiskMode(modeKey);
    }
  }
}

module.exports = {
  sendDiscordAnnouncement,
  initDiscordBot,
  sendFinalAgentResponse,
  sendDiscordPermissionPrompt,
  isPermissionPromptEnabled,
  updateDiscordUsageMonitor,
  ensureControlPanel,
  renderControlPanelMessage,
  isUserAuthorized,
  applyChannelModerationPermissions,
  AUTHORIZED_USERS,
  RESTRICTED_ROLES,
  validateImageMagicBytes,
  validateOutboundImagePath,
  checkUploadRateLimit,
  transcribeAudioWithGemini,
  sendDiscordImage,
  MAX_UPLOAD_SIZE,
  ALLOWED_IMAGE_EXTS,
  ALLOWED_AUDIO_EXTS,
  getClient: () => client
};
