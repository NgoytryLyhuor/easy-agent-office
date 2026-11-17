const { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } = require('discord.js');
const http = require('http');
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
    }
  });

  // Ricezione comandi dai canali Discord per inviarli ad Antigravity
  client.on('messageCreate', async message => {
    if (message.author.bot) return;

    const channelName = message.channel.name ? message.channel.name.toLowerCase() : '';
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

    const content = message.content.trim();
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

    if (content.startsWith('!')) {
      const parts = content.slice(1).split(' ');
      const prefix = parts[0].toLowerCase();
      if (SUBAGENT_CHANNELS[prefix] || SUBAGENT_CHANNELS[`${prefix}-ceo`] || SUBAGENT_CHANNELS[`${prefix}-backend`]) {
        target = SUBAGENT_CHANNELS[prefix] || SUBAGENT_CHANNELS[`${prefix}-ceo`] || SUBAGENT_CHANNELS[`${prefix}-backend`];
      }
    }

    if (!target) return;

    // Tutti a riposo: mette il task in coda per eseguirlo automaticamente al risveglio
    if (routing.isResting()) {
      const qPos = routing.enqueueRestTask({ agentId: target.id, text: content, source: `Discord (${message.author.username})` });
      message.channel.send(`💤 ${routing.restMessage()}\n📥 **Task messo in coda (#${qPos})**: verrà inviato automaticamente a **${target.name}** appena la quota si ricarica!`).catch(() => {});
      return;
    }

    // Notifica di presa in carico con reazione
    try {
      await message.react('⚡');
    } catch {}

    dispatchTaskToSubagent(target.id, target.name, content, message.author.username, (err) => {
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

  client.guilds.cache.forEach(guild => {
    // Trova ESATTAMENTE il canale testuale dedicato all'agente (senza inviare a canali duplicati o non pertinenti)
    const channel = guild.channels.cache.find(c => c.isTextBased() && c.name.toLowerCase().includes(agentEntry.channelKeyword.toLowerCase()));
    if (channel) {
      channel.send({ embeds: [embed] }).catch(err => {
        console.warn(`[Discord Bot] Errore invio risposta su #${channel.name}:`, err.message);
      });
    }
  });
}

// Invia richiesta di autorizzazione interattiva con pulsanti su Discord (SOLO nel canale dell'agente o altrimenti solo in sala-operativa)
function sendDiscordPermissionPrompt(requestId, agentId, agentName, tool, command, desc) {
  if (!client || !client.isReady()) return;

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
  updateDiscordUsageMonitor,
  ensureControlPanel,
  renderControlPanelMessage,
  getClient: () => client
};
