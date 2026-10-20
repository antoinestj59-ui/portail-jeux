const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const app = express();
// Render et la plupart des plateformes placent un reverse proxy devant Node.
// Ajuste TRUST_PROXY_HOPS si ton hébergeur utilise une chaîne différente.
const configuredProxyHops = process.env.TRUST_PROXY_HOPS === 'false' ? false : Number.parseInt(process.env.TRUST_PROXY_HOPS || '1', 10);
app.set('trust proxy', configuredProxyHops === false ? false : (Number.isFinite(configuredProxyHops) ? configuredProxyHops : 1));
const server = http.createServer(app);
const requestContext = new AsyncLocalStorage();

const io = new Server(server, { cors: { origin: "*" }, maxHttpBufferSize: 5e7 });
app.use(express.json({ limit: '50mb' }));
app.use((req, res, next) => { if (req.body === undefined) req.body = {}; next(); });

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
// En l'absence de configuration, préférer l'arrêt du serveur à un stockage local éphémère.
// Pour le développement local, .env.example définit explicitement PERSISTENCE_MODE=local.
const PERSISTENCE_MODE = (process.env.PERSISTENCE_MODE || 'supabase').toLowerCase();
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!['local', 'supabase'].includes(PERSISTENCE_MODE)) {
  throw new Error('PERSISTENCE_MODE doit être "local" ou "supabase".');
}
if (PERSISTENCE_MODE === 'supabase' && (!SUPABASE_URL || !SUPABASE_SECRET_KEY)) {
  throw new Error('Mode Supabase activé mais SUPABASE_URL ou SUPABASE_SECRET_KEY manque.');
}
const supabase = PERSISTENCE_MODE === 'supabase'
  ? createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    })
  : null;
const ASSETS_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'portal-assets';

const PUBLIC_DIR = path.join(__dirname, 'public');
const GAMES_DIR = path.join(PUBLIC_DIR, 'games');
const MUSIC_DIR = path.join(PUBLIC_DIR, 'music');
const DB_FILE = path.join(__dirname, 'database.json');

if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
if (!fs.existsSync(GAMES_DIR)) fs.mkdirSync(GAMES_DIR, { recursive: true });
if (!fs.existsSync(MUSIC_DIR)) fs.mkdirSync(MUSIC_DIR, { recursive: true });

const activeAdminTokens = new Set();
const frozenIPs = new Set();
const warningsQueue = {};

let db = {
  portalSettings: {
    title: "PORTAIL ARCADE 3D",
    neonColor: "#5ffff6",
    logoUrl: ""
  },
  players: {},
  bans: [],
  frozenIPs: [],
  games: [],
  playlist: [],
  reviews: [],
  bugs: [],
  logs: [],
  teams: {},
  weeklyChallenge: {
    active: true,
    title: "Défi Hebdomadaire",
    gameId: "",
    targetScore: 500,
    rewardXp: 300
  },
  featuredRotation: { active: true, intervalMinutes: 15, currentIdx: 0 },
  promocodes: {
    "AUDI2026": { rewardXp: 200, badge: "pionnier", uses: 0 }
  },
  eventMultiplier: { active: false, factor: 2, name: "Week-end Double XP !" },
  maintenance: { active: false, message: "Mise à jour en cours...", estimatedDuration: "30 minutes", bypassKey: "TEST-777" },
  adConfig: { enabled: false, customHeadSnippet: "", bannerTopHtml: "", bannerBottomHtml: "" },
  announcement: { active: false, text: "Bienvenue sur notre portail !", type: "info" }
};

function addLog(action, details = "") {
  db.logs.unshift({ timestamp: new Date().toISOString(), action, details });
  if (db.logs.length > 200) db.logs.pop();
  saveDB();
}

function isBundledDropzoneGame(game) {
  if (!game || typeof game !== 'object') return false;
  const rawUrl = String(game.url || '').split(/[?#]/, 1)[0].toLowerCase();
  const title = String(game.title || '').trim().toLowerCase();
  return /^\/dropzone(?:\/|$)/.test(rawUrl) || (title === 'dropzone' && !/^\/games\//.test(rawUrl));
}

function normalizeDB() {
  if (!db || typeof db !== 'object') db = {};
  if (!db.portalSettings) db.portalSettings = { title: "PORTAIL ARCADE 3D", neonColor: "#5ffff6", logoUrl: "" };
  if (!db.players || typeof db.players !== 'object') db.players = {};
  if (!Array.isArray(db.bans)) db.bans = [];
  if (!Array.isArray(db.games)) db.games = [];
  // L'ancien jeu intégré Dropzone a été retiré : seuls les jeux ajoutés volontairement restent.
  db.games = db.games.filter(game => !isBundledDropzoneGame(game));
  if (!Array.isArray(db.playlist)) db.playlist = [];
  if (!Array.isArray(db.reviews)) db.reviews = [];
  if (!Array.isArray(db.bugs)) db.bugs = [];
  if (!Array.isArray(db.logs)) db.logs = [];
  if (!Array.isArray(db.frozenIPs)) db.frozenIPs = [];
  if (!db.teams || typeof db.teams !== 'object') db.teams = {};
  if (!db.weeklyChallenge) db.weeklyChallenge = { active: true, title: "Défi Hebdomadaire", gameId: "", targetScore: 500, rewardXp: 300 };
  if (!db.featuredRotation) db.featuredRotation = { active: true, intervalMinutes: 15, currentIdx: 0 };
  if (!db.promocodes || typeof db.promocodes !== 'object') db.promocodes = {};
  if (!db.eventMultiplier) db.eventMultiplier = { active: false, factor: 2, name: "Week-end Double XP !" };
  if (!db.maintenance) db.maintenance = { active: false, message: "Mise à jour en cours...", estimatedDuration: "30 minutes", bypassKey: "TEST-777" };
  if (!db.adConfig) db.adConfig = { enabled: false, customHeadSnippet: "", bannerTopHtml: "", bannerBottomHtml: "" };
  if (!db.announcement) db.announcement = { active: false, text: "Bienvenue sur notre portail !", type: "info" };
  frozenIPs.clear();
  db.frozenIPs.forEach(ip => frozenIPs.add(ip));
}

function loadLocalDB() {
  if (!fs.existsSync(DB_FILE)) return;
  try {
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    Object.assign(db, data);
    normalizeDB();
  } catch (e) {
    console.error("Erreur database.json:", e.message);
  }
}

let persistenceQueue = Promise.resolve();
let lastPersistenceError = null;
let lastSuccessfulSave = null;

function saveDB() {
  const snapshot = JSON.parse(JSON.stringify(db));
  const context = requestContext.getStore();
  if (context) context.mutated = true;

  let writeTask;
  // Mode local : une écriture atomique évite les fichiers JSON partiellement écrits.
  if (!supabase) {
    try {
      const tempFile = DB_FILE + '.tmp';
      fs.writeFileSync(tempFile, JSON.stringify(snapshot, null, 2), 'utf8');
      fs.renameSync(tempFile, DB_FILE);
      lastSuccessfulSave = new Date().toISOString();
      lastPersistenceError = null;
      writeTask = Promise.resolve();
    } catch (e) {
      lastPersistenceError = e.message || String(e);
      console.error('Erreur sauvegarde DB locale:', lastPersistenceError);
      writeTask = Promise.reject(e);
    }
  } else {
    // Les sauvegardes distantes sont sérialisées. Chaque requête peut attendre
    // sa propre écriture, et une panne n'empêche pas les tentatives suivantes.
    writeTask = persistenceQueue.then(async () => {
      const { error } = await supabase
        .from('portal_state')
        .upsert({ id: 1, state: snapshot, updated_at: new Date().toISOString() }, { onConflict: 'id' });
      if (error) throw error;
      lastSuccessfulSave = new Date().toISOString();
      lastPersistenceError = null;
    }).catch((e) => {
      lastPersistenceError = e.message || String(e);
      console.error('Erreur de sauvegarde Supabase:', lastPersistenceError);
      throw e;
    });
    persistenceQueue = writeTask.catch(() => undefined);
  }

  if (context) context.lastSave = writeTask;
  // Les événements Socket.IO ne retournent pas toujours une Promise; ce catch
  // évite les rejets non gérés, tandis que les requêtes HTTP attendent writeTask.
  writeTask.catch(() => undefined);
  return writeTask;
}

async function persistDBOrThrow() {
  // La Promise de cette écriture reflète son propre résultat; pas un état global
  // qui pourrait avoir été modifié par une autre requête concurrente.
  await saveDB();
}

async function initializePersistence() {
  loadLocalDB();
  if (!supabase) {
    console.log('Stockage local activé (développement uniquement).');
    return;
  }

  const { data: bucketInfo, error: bucketError } = await supabase.storage.getBucket(ASSETS_BUCKET);
  if (bucketError || !bucketInfo) {
    throw new Error(`Le bucket Supabase privé « ${ASSETS_BUCKET} » est introuvable ou inaccessible. Crée-le dans Storage avant le démarrage.`);
  }

  const { data, error } = await supabase
    .from('portal_state')
    .select('state, updated_at')
    .eq('id', 1)
    .maybeSingle();
  if (error) throw new Error('Impossible de lire portal_state dans Supabase: ' + error.message);

  if (data && data.state && typeof data.state === 'object') {
    const gamesBeforeNormalization = Array.isArray(data.state.games) ? data.state.games.length : 0;
    Object.assign(db, data.state);
    normalizeDB();
    lastSuccessfulSave = data.updated_at || null;
    if (db.games.length < gamesBeforeNormalization) {
      await persistDBOrThrow();
      console.log('Entrée(s) Dropzone intégrée(s) retirée(s) de la base persistante.');
    }
    console.log('État du portail chargé depuis Supabase.');
  } else {
    console.log('Aucun état distant : initialisation de la base persistante avec la base locale actuelle.');
    await saveDB();
    if (lastPersistenceError) throw new Error('Initialisation Supabase échouée: ' + lastPersistenceError);
  }
}

async function uploadStoredAsset(objectPath, body, contentType) {
  const { error } = await supabase.storage.from(ASSETS_BUCKET).upload(objectPath, body, {
    contentType,
    upsert: true,
    cacheControl: '3600'
  });
  if (error) throw error;
}

async function downloadStoredAsset(objectPath) {
  const { data, error } = await supabase.storage.from(ASSETS_BUCKET).download(objectPath);
  if (error || !data) return null;
  return Buffer.from(await data.arrayBuffer());
}

function getIP(req) {
  return String(req.ip || req.socket.remoteAddress || '127.0.0.1').replace(/^::ffff:/, '').trim();
}

function parseCookieHeader(header) {
  const cookies = {};
  String(header || '').split(';').forEach(part => {
    const at = part.indexOf('=');
    if (at <= 0) return;
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    try { cookies[name] = decodeURIComponent(value); } catch (_) { cookies[name] = value; }
  });
  return cookies;
}

// Une identité aléatoire par navigateur remplace progressivement l'IP comme identifiant joueur.
// L'IP est conservée pour la modération et la migration des anciens comptes.
app.use((req, res, next) => {
  const cookies = parseCookieHeader(req.headers.cookie);
  let playerId = cookies.arcade_player_id;
  if (!playerId || !/^[a-f0-9]{64}$/.test(playerId)) {
    playerId = crypto.randomBytes(32).toString('hex');
    const secure = req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
    const cookie = `arcade_player_id=${playerId}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
    res.append('Set-Cookie', cookie);
  }
  req.playerId = playerId;
  next();
});

// Une mutation HTTP ne doit jamais répondre « succès » avant la fin de sa sauvegarde distante.
app.use((req, res, next) => {
  const context = { mutated: false, lastSave: null };
  const originalJson = res.json.bind(res);
  req.persistenceContext = context;
  res.json = function durableJson(payload) {
    if (!supabase || !context.mutated || !context.lastSave) return originalJson(payload);
    const statusBefore = res.statusCode;
    context.lastSave.then(() => {
      originalJson(payload);
    }).catch(() => {
      if (res.headersSent) return;
      // Si le handler a déjà prévu une erreur précise, la conserver.
      if (statusBefore >= 400 || (payload && payload.success === false)) return originalJson(payload);
      res.status(503);
      originalJson({ success: false, message: 'La sauvegarde persistante a échoué. Réessaie dans quelques secondes.' });
    });
    return res;
  };
  requestContext.run(context, next);
});

function findPlayerForRequest(req) {
  const players = Object.values(db.players || {});
  const byId = players.find(p => p && p.playerId === req.playerId);
  if (byId) return byId;
  // Ancien compte créé avant les cookies : rattache-le à ce navigateur une seule fois.
  const ip = getIP(req);
  const legacy = players.find(p => p && !p.playerId && p.ip === ip);
  if (legacy) {
    legacy.playerId = req.playerId;
    return legacy;
  }
  return null;
}

function findPlayerEntry(player) {
  return Object.entries(db.players || {}).find(([, value]) => value === player) || null;
}

app.get('/api/ping', (req, res) => res.json({ pong: Date.now() }));

app.get('/api/persistence/status', (req, res) => {
  res.json({
    mode: supabase ? 'supabase' : 'local',
    persistent: Boolean(supabase),
    healthy: !supabase || !lastPersistenceError,
    lastSuccessfulSave,
    lastError: supabase && lastPersistenceError ? 'Échec de sauvegarde distante' : null
  });
});

// Les fichiers téléversés sont servis par le serveur depuis Supabase Storage en production.
// En mode local, express.static(PUBLIC_DIR) sert les fichiers directement et ces routes passent leur tour.
app.get(['/games/:slug', '/games/:slug/'], async (req, res, next) => {
  if (!supabase) return next();
  const slug = req.params.slug;
  if (!/^[a-z0-9-]+$/.test(slug)) return res.sendStatus(400);
  try {
    const body = await downloadStoredAsset(`games/${slug}/index.html`);
    if (!body) return res.sendStatus(404);
    res.type('html').send(body);
  } catch (e) {
    console.error('Erreur lecture jeu depuis Storage:', e.message);
    res.sendStatus(502);
  }
});

app.get('/music/:filename', async (req, res, next) => {
  if (!supabase) return next();
  const filename = req.params.filename;
  if (!/^[a-zA-Z0-9._-]+$/.test(filename)) return res.sendStatus(400);
  try {
    const body = await downloadStoredAsset(`music/${filename}`);
    if (!body) return res.sendStatus(404);
    const ext = path.extname(filename).toLowerCase();
    const types = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.aac': 'audio/aac', '.webm': 'audio/webm' };
    res.type(types[ext] || 'application/octet-stream').send(body);
  } catch (e) {
    console.error('Erreur lecture musique depuis Storage:', e.message);
    res.sendStatus(502);
  }
});

// Les pages publiques restent servies depuis public/. Les routes de stockage distant ci-dessus
// ont priorité afin qu'un ancien fichier local ne masque jamais sa version persistante.
app.use(express.static(PUBLIC_DIR, { dotfiles: 'ignore', index: 'index.html' }));

app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get(['/admin', '/admin.html'], (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
app.get('/play', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'play.html')));

app.get('/api/admin/backup', async (req, res) => {
  if (!activeAdminTokens.has(req.query.token)) return res.status(403).send("Non autorisé.");
  try { await persistenceQueue; } catch (_) { return res.status(503).send('Sauvegarde distante indisponible.'); }
  if (lastPersistenceError) return res.status(503).send('Sauvegarde distante indisponible.');
  const filename = "backup-arcade-" + new Date().toISOString().slice(0, 10) + ".json";
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(JSON.stringify(db, null, 2));
});

app.get('/api/config/portal', (req, res) => {
  const userKey = req.query.bypassKey || '';
  const isBypassed = db.maintenance.active && userKey && userKey === db.maintenance.bypassKey;
  let featuredGame = null;
  const playable = db.games.filter(g => g.status === 'playable');
  if (playable.length > 0) {
    featuredGame = playable[db.featuredRotation.currentIdx % playable.length];
  }
  res.json({
    portalSettings: db.portalSettings,
    maintenance: {
      active: Boolean(db.maintenance.active),
      message: db.maintenance.message,
      estimatedDuration: db.maintenance.estimatedDuration,
      isBypassed
    },
    announcement: db.announcement,
    adConfig: db.adConfig,
    eventMultiplier: db.eventMultiplier,
    playlist: db.playlist,
    weeklyChallenge: db.weeklyChallenge,
    featuredGame
  });
});

app.get('/api/games', (req, res) => res.json(db.games));
app.get('/api/playlist', (req, res) => res.json(db.playlist));

app.post('/api/admin/login', (req, res) => {
  const { pass } = req.body;
  if (!ADMIN_PASSWORD) return res.status(503).json({ success: false, message: 'ADMIN_PASSWORD doit être configuré dans les variables d’environnement du serveur.' });
  if (pass === ADMIN_PASSWORD) {
    const token = crypto.randomBytes(32).toString('hex');
    activeAdminTokens.add(token);
    addLog("ADMIN_LOGIN", `Connexion réussie depuis ${getIP(req)}`);
    return res.json({
      success: true,
      token,
      portalSettings: db.portalSettings,
      allPlayers: db.players,
      bans: db.bans,
      games: db.games,
      playlist: db.playlist,
      reviews: db.reviews,
      bugs: db.bugs,
      teams: db.teams,
      promocodes: db.promocodes,
      announcement: db.announcement,
      maintenance: db.maintenance,
      eventMultiplier: db.eventMultiplier,
      weeklyChallenge: db.weeklyChallenge,
      featuredRotation: db.featuredRotation,
      logs: db.logs
    });
  }
  res.status(401).json({ success: false, message: "Mot de passe incorrect !" });
});

app.get('/api/admin/session', (req, res) => {
  const token = req.headers['authorization'];
  if (!activeAdminTokens.has(token)) return res.status(401).json({ success: false, message: 'Session expirée.' });
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    success: true,
    portalSettings: db.portalSettings,
    allPlayers: db.players,
    bans: db.bans,
    games: db.games,
    playlist: db.playlist,
    reviews: db.reviews,
    bugs: db.bugs,
    teams: db.teams,
    promocodes: db.promocodes,
    announcement: db.announcement,
    maintenance: db.maintenance,
    eventMultiplier: db.eventMultiplier,
    weeklyChallenge: db.weeklyChallenge,
    featuredRotation: db.featuredRotation,
    logs: db.logs
  });
});

app.post('/api/admin/portal-settings', (req, res) => {
  const token = req.headers['authorization'];
  if (!activeAdminTokens.has(token)) return res.status(403).json({ success: false });
  const { title, neonColor, logoUrl } = req.body;
  db.portalSettings = {
    title: title || "PORTAIL ARCADE 3D",
    neonColor: neonColor || "#5ffff6",
    logoUrl: logoUrl || ""
  };
  saveDB();
  io.emit('portalSettings:updated', db.portalSettings);
  res.json({ success: true, settings: db.portalSettings });
});

app.post('/api/admin/games/reorder', async (req, res) => {
  const token = req.headers['authorization'];
  if (!activeAdminTokens.has(token)) return res.status(403).json({ success: false, message: 'Session expirée.' });
  const { gameId, direction } = req.body || {};
  if (!['up', 'down'].includes(direction)) return res.status(400).json({ success: false, message: 'Direction invalide.' });
  const index = db.games.findIndex(game => game.id === gameId);
  if (index < 0) return res.status(404).json({ success: false, message: 'Jeu introuvable.' });
  const target = direction === 'up' ? index - 1 : index + 1;
  if (target < 0 || target >= db.games.length) return res.json({ success: true, games: db.games });
  [db.games[index], db.games[target]] = [db.games[target], db.games[index]];
  db.featuredRotation.currentIdx = Math.min(Number(db.featuredRotation.currentIdx) || 0, Math.max(0, db.games.length - 1));
  try { await persistDBOrThrow(); }
  catch (e) {
    [db.games[index], db.games[target]] = [db.games[target], db.games[index]];
    return res.status(503).json({ success: false, message: 'La nouvelle position n’a pas été sauvegardée.' });
  }
  io.emit('games:updated', db.games);
  return res.json({ success: true, games: db.games });
});

// Injecte automatiquement le SDK de sauvegarde dans chaque HTML importé.
// Le jeu peut ensuite appeler Arcade.save({ score, level, ... }) et Arcade.load().
function prepareImportedGameHtml(sourceHtml, gameId) {
  let html = String(sourceHtml || '');
  const idLiteral = JSON.stringify(String(gameId));
  if (!/<html\b|<!doctype\s+html/i.test(html)) {
    throw new Error('Le fichier importé ne semble pas être un document HTML complet.');
  }

  // Retire les injections précédentes et les anciennes initialisations SDK pour
  // éviter un double comptage de session ou une progression associée au mauvais jeu.
  html = html.replace(/<!-- ARCADE_PORTAL_SDK_START -->[\s\S]*?<!-- ARCADE_PORTAL_SDK_END -->\s*/gi, '');
  html = html.replace(/<script\b(?=[^>]*\bsrc\s*=\s*(['"])[^'"]*arcade-sdk\.js(?:\?[^'"]*)?\1)[^>]*>\s*<\/script\s*>/gi, '');
  html = html.replace(/(?:window\s*\.\s*)?Arcade\s*\.\s*init\s*\(\s*(['"`])[^)]*?\1\s*\)\s*;?/gi, '');

  const block = `<!-- ARCADE_PORTAL_SDK_START -->\n<script src="/arcade-sdk.js"></script>\n<script>window.Arcade && window.Arcade.init(${idLiteral});</script>\n<!-- ARCADE_PORTAL_SDK_END -->`;
  const headTag = /<head\b[^>]*>/i;
  const doctype = /<!doctype\s+html[^>]*>/i;
  if (headTag.test(html)) {
    html = html.replace(headTag, match => `${match}\n${block}`);
  } else if (doctype.test(html)) {
    html = html.replace(doctype, match => `${match}\n${block}`);
  } else {
    html = `${block}\n${html}`;
  }
  return html;
}

app.post('/api/admin/games/save', async (req, res) => {
  const token = req.headers['authorization'];
  if (!activeAdminTokens.has(token)) return res.status(403).json({ success: false, message: "Session expirée." });

  const { id, title, description, icon, thumbnail, category, status, url, fileContent } = req.body;
  if (!title) return res.status(400).json({ success: false, message: "Le titre est obligatoire !" });

  let finalUrl = url || '#';
  const resolvedGameId = id || ('game_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex'));
  if (fileContent) {
    const existingGame = id ? db.games.find(game => game.id === id) : null;
    const existingSlugMatch = existingGame && typeof existingGame.url === 'string'
      ? /^\/games\/([a-z0-9-]+)\/?$/i.exec(existingGame.url)
      : null;
    let cleanSlug = (title.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 64).replace(/-+$/g, ''));
    if (existingSlugMatch) cleanSlug = existingSlugMatch[1].toLowerCase();
    if (!cleanSlug) cleanSlug = 'jeu-' + Date.now();
    const slugInUse = db.games.some(game => game.id !== id && typeof game.url === 'string' && game.url.replace(/\/$/, '') === `/games/${cleanSlug}`);
    if (slugInUse && !existingSlugMatch) cleanSlug = `${cleanSlug}-${crypto.randomBytes(3).toString('hex')}`;
    try {
      if (supabase) {
        await uploadStoredAsset(`games/${cleanSlug}/index.html`, Buffer.from(prepareImportedGameHtml(fileContent, resolvedGameId), 'utf8'), 'text/html; charset=utf-8');
      } else {
        const gameFolder = path.join(GAMES_DIR, cleanSlug);
        if (!fs.existsSync(gameFolder)) fs.mkdirSync(gameFolder, { recursive: true });
        fs.writeFileSync(path.join(gameFolder, 'index.html'), prepareImportedGameHtml(fileContent, resolvedGameId), 'utf8');
      }
    } catch (e) {
      console.error('Erreur stockage du jeu:', e.message);
      return res.status(502).json({ success: false, message: 'Le jeu n’a pas pu être enregistré dans le stockage persistant.' });
    }
    finalUrl = '/games/' + cleanSlug + '/';
  }

  if (id) {
    const g = db.games.find(x => x.id === id);
    if (!g) return res.status(404).json({ success: false, message: "Jeu introuvable." });
    Object.assign(g, { title, description, icon, thumbnail, category, status });
    if (finalUrl !== '#') g.url = finalUrl;
    addLog("JEU_MODIFIÉ", title);
  } else {
    db.games.push({
      id: resolvedGameId,
      title,
      description: description || '',
      icon: icon || '🎮',
      thumbnail: thumbnail || '',
      category: category || 'Action',
      url: finalUrl,
      status: status || 'playable',
      likes: 0,
      votes: 0,
      plays: 0,
      totalPlaytimeSeconds: 0
    });
    addLog("JEU_AJOUTÉ", title);
  }

  try { await persistDBOrThrow(); }
  catch (e) { return res.status(503).json({ success: false, message: 'Le jeu a été reçu mais sa fiche ne peut pas être sauvegardée durablement. Vérifie Supabase puis réessaie.' }); }
  io.emit('games:updated', db.games);
  res.json({ success: true, games: db.games });
});

app.post('/api/admin/music/upload', async (req, res) => {
  const token = req.headers['authorization'];
  if (!activeAdminTokens.has(token)) return res.status(403).json({ success: false });

  const { title, artist, fileContent, url } = req.body;
  if (!title) return res.status(400).json({ success: false, message: "Titre requis." });

  let finalUrl = url || '';
  if (fileContent) {
    if (typeof fileContent !== 'string' || fileContent.length > 48 * 1024 * 1024) {
      return res.status(413).json({ success: false, message: 'Fichier audio trop volumineux (limite de sécurité : 36 Mo environ).' });
    }
    const dataUrlMatch = /^data:([^;,]+);base64,([\s\S]+)$/.exec(fileContent);
    const contentType = dataUrlMatch ? dataUrlMatch[1].toLowerCase() : 'audio/mpeg';
    const base64Data = dataUrlMatch ? dataUrlMatch[2] : String(fileContent).replace(/^data:[^,]+,/, '');
    const extensionByType = { 'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'audio/aac': '.aac', 'audio/webm': '.webm' };
    const cleanName = 'track_' + Date.now() + (extensionByType[contentType] || '.mp3');
    const bytes = Buffer.from(base64Data, 'base64');
    try {
      if (supabase) {
        await uploadStoredAsset(`music/${cleanName}`, bytes, contentType);
      } else {
        fs.writeFileSync(path.join(MUSIC_DIR, cleanName), bytes);
      }
    } catch (e) {
      console.error('Erreur stockage musique:', e.message);
      return res.status(502).json({ success: false, message: 'La musique n’a pas pu être enregistrée dans le stockage persistant.' });
    }
    finalUrl = '/music/' + cleanName;
  }

  const newTrack = {
    id: 'track_' + Date.now(),
    title: title.trim(),
    artist: (artist || 'Artiste').trim(),
    url: finalUrl
  };

  db.playlist.push(newTrack);
  addLog("MUSIQUE_AJOUTÉE", newTrack.title);
  try { await persistDBOrThrow(); }
  catch (e) { return res.status(503).json({ success: false, message: 'Le fichier audio a été téléversé, mais la playlist n’a pas pu être sauvegardée. Réessaie.' }); }
  io.emit('playlist:updated', db.playlist);
  res.json({ success: true, playlist: db.playlist });
});

app.post('/api/admin/music/delete', async (req, res) => {
  const token = req.headers['authorization'];
  if (!activeAdminTokens.has(token)) return res.status(403).json({ success: false });
  const track = db.playlist.find(t => t.id === req.body.id);
  const oldPlaylist = db.playlist.slice();
  db.playlist = db.playlist.filter(t => t.id !== req.body.id);
  try { await persistDBOrThrow(); }
  catch (e) { db.playlist = oldPlaylist; return res.status(503).json({ success: false, message: 'La suppression n’a pas pu être sauvegardée. Réessaie.' }); }
  if (supabase && track && typeof track.url === 'string' && track.url.startsWith('/music/')) {
    const filename = path.basename(track.url);
    const { error } = await supabase.storage.from(ASSETS_BUCKET).remove([`music/${filename}`]);
    if (error) console.error('Suppression du fichier audio impossible:', error.message);
  }
  io.emit('playlist:updated', db.playlist);
  res.json({ success: true, playlist: db.playlist });
});

app.post('/api/admin/give-rewards', (req, res) => {
  const token = req.headers['authorization'];
  if (!activeAdminTokens.has(token)) return res.status(403).json({ success: false });
  const { username, xp, badge } = req.body;
  const p = db.players[username];
  if (!p) return res.status(404).json({ success: false, message: "Joueur introuvable." });

  if (xp) {
    p.xp = (p.xp || 0) + Number(xp);
    p.level = Math.floor(p.xp / 100) + 1;
  }
  if (!Array.isArray(p.badges)) p.badges = [];
  if (badge && !p.badges.includes(badge)) p.badges.push(badge);

  saveDB();
  addLog("DON_RESSOURCE", `+${xp||0} XP pour ${username}`);
  io.emit('player:rewarded', { username, xp, badge });
  res.json({ success: true, player: p });
});

app.post('/api/admin/freeze', (req, res) => {
  const token = req.headers['authorization'];
  if (!activeAdminTokens.has(token)) return res.status(403).json({ success: false });
  const { ip, freeze } = req.body;

  if (freeze) frozenIPs.add(ip);
  else frozenIPs.delete(ip);
  db.frozenIPs = Array.from(frozenIPs);

  addLog("FREEZE", `IP ${ip}: ${freeze}`);
  io.emit('player:freeze_status', { ip, frozen: !!freeze });
  res.json({ success: true, frozen: !!freeze });
});

app.post('/api/admin/broadcast', (req, res) => {
  const token = req.headers['authorization'];
  if (!activeAdminTokens.has(token)) return res.status(403).json({ success: false });
  const { message } = req.body;
  if (!message) return res.status(400).json({ success: false });

  addLog("BROADCAST", message);
  io.emit('broadcast:alert', { message });
  res.json({ success: true });
});

app.post('/api/admin/weekly-challenge', (req, res) => {
  const token = req.headers['authorization'];
  if (!activeAdminTokens.has(token)) return res.status(403).json({ success: false });
  Object.assign(db.weeklyChallenge, req.body);
  saveDB();
  io.emit('challenge:updated', db.weeklyChallenge);
  res.json({ success: true, challenge: db.weeklyChallenge });
});

app.post('/api/player/transfer-key/generate', async (req, res) => {
  const ip = getIP(req);
  const player = findPlayerForRequest(req);
  if (!player) return res.status(400).json({ success: false, message: "Enregistrez d'abord un pseudo." });

  const forceNew = req.body && req.body.force === true;
  const oldKey = player.transferKey;
  const oldExpiry = player.transferKeyExpiresAt;
  const oldPlayerId = player.playerId;
  const oldIp = player.ip;
  const existingKeyIsUsable = /^ARCADE-[A-F0-9]{32}$/.test(String(oldKey || '').toUpperCase())
    && Number(oldExpiry || 0) > Date.now();
  if (!forceNew && existingKeyIsUsable) {
    // Réutilise uniquement une clé déjà enregistrée, sans en créer une seconde.
    return res.json({ success: true, transferKey: oldKey, expiresAt: oldExpiry, reused: true });
  }

  // 128 bits aléatoires, unicité vérifiée et durée de validité de 24 heures.
  let transferKey;
  do {
    transferKey = 'ARCADE-' + crypto.randomBytes(16).toString('hex').toUpperCase();
  } while (Object.values(db.players).some(p => p && String(p.transferKey || '').toUpperCase() === transferKey));
  player.playerId = req.playerId;
  player.ip = ip;
  player.transferKey = transferKey;
  player.transferKeyExpiresAt = Date.now() + 24 * 60 * 60 * 1000;
  try {
    await persistDBOrThrow();
    return res.json({ success: true, transferKey, expiresAt: player.transferKeyExpiresAt });
  } catch (e) {
    // Ne conserve pas une nouvelle clé dans la mémoire si elle n'a pas pu être
    // enregistrée : le prochain appel ne doit pas afficher une clé inutilisable.
    player.transferKey = oldKey || null;
    if (oldExpiry === undefined) delete player.transferKeyExpiresAt;
    else player.transferKeyExpiresAt = oldExpiry;
    if (oldPlayerId === undefined) delete player.playerId;
    else player.playerId = oldPlayerId;
    if (oldIp === undefined) delete player.ip;
    else player.ip = oldIp;
    return res.status(503).json({ success: false, message: 'Clé non enregistrée durablement. Vérifie la sauvegarde du serveur puis réessaie.' });
  }
});

app.post('/api/player/transfer-key/claim', async (req, res) => {
  const ip = getIP(req);
  const key = String(req.body.transferKey || '').trim().toUpperCase();
  if (!/^ARCADE-[A-F0-9]{6,32}$/.test(key)) {
    return res.status(400).json({ success: false, message: 'Format de clé invalide.' });
  }

  const targetEntry = Object.entries(db.players).find(([, p]) => p && String(p.transferKey || '').toUpperCase() === key);
  if (!targetEntry) return res.status(404).json({ success: false, message: 'Clé de transfert invalide ou déjà utilisée.' });
  const [targetName, targetPlayer] = targetEntry;
  const expiry = Number(targetPlayer.transferKeyExpiresAt || 0);
  if (!Number.isFinite(expiry) || expiry <= 0 || Date.now() > expiry) {
    const oldKey = targetPlayer.transferKey;
    const oldExpiry = targetPlayer.transferKeyExpiresAt;
    targetPlayer.transferKey = null;
    delete targetPlayer.transferKeyExpiresAt;
    try { await persistDBOrThrow(); }
    catch (_) {
      targetPlayer.transferKey = oldKey;
      if (oldExpiry === undefined) delete targetPlayer.transferKeyExpiresAt;
      else targetPlayer.transferKeyExpiresAt = oldExpiry;
      return res.status(503).json({ success: false, message: 'Cette clé semble expirée, mais son état n’a pas pu être sauvegardé. Réessaie.' });
    }
    return res.status(410).json({ success: false, message: 'Cette clé a expiré. Génère une nouvelle clé sur l’ancien appareil.' });
  }

  // Important : ne fais pas de rapprochement par IP ici. Un appareil neuf peut
  // partager la même IP publique que l'ancien, ce qui bloquait parfois un vrai
  // transfert avec une réponse 409. Seul un compte déjà attaché à ce cookie compte.
  const currentPlayer = Object.values(db.players).find(p => p && p.playerId === req.playerId);
  if (currentPlayer && currentPlayer !== targetPlayer) {
    return res.status(409).json({ success: false, message: 'Un autre compte est déjà associé à ce navigateur. Utilise un navigateur vierge ou retire ses données de site avant le transfert.' });
  }

  const oldPlayerSnapshot = JSON.parse(JSON.stringify(targetPlayer));
  targetPlayer.playerId = req.playerId;
  targetPlayer.ip = ip;
  targetPlayer.lastActive = new Date().toISOString();
  targetPlayer.transferKey = null;
  delete targetPlayer.transferKeyExpiresAt;
  try {
    await persistDBOrThrow();
    return res.json({ success: true, player: targetPlayer });
  } catch (e) {
    // Un transfert annoncé comme réussi doit survivre au prochain redémarrage.
    db.players[targetName] = oldPlayerSnapshot;
    return res.status(503).json({ success: false, message: 'La clé a été reconnue, mais le transfert n’a pas pu être sauvegardé. Réessaie.', error: supabase ? undefined : e.message });
  }
});

app.get('/api/player/me', (req, res) => {
  const ip = getIP(req);
  if (db.bans.includes(ip)) return res.status(403).json({ banned: true, message: "IP bannie." });

  const found = findPlayerForRequest(req);
  const isFrozen = frozenIPs.has(ip);
  const warning = warningsQueue[ip] || null;
  delete warningsQueue[ip];

  res.json({ ip, player: found, isFrozen, warning });
});

app.post('/api/player/set-pseudo', async (req, res) => {
  const ip = getIP(req);
  if (db.bans.includes(ip)) return res.status(403).json({ success: false, message: "IP bannie." });

  const requestedName = String(req.body.username || '').trim().replace(/[\u0000-\u001f]/g, '').substring(0, 16);
  if (!requestedName) return res.status(400).json({ success: false, message: 'Pseudo invalide.' });

  const currentPlayer = findPlayerForRequest(req);
  const existingEntry = Object.entries(db.players).find(([name, p]) => name.toLowerCase() === requestedName.toLowerCase() && p !== currentPlayer);
  if (existingEntry) return res.status(409).json({ success: false, message: 'Ce pseudo appartient déjà à un autre joueur !' });

  let player = currentPlayer;
  if (player) {
    const oldEntry = findPlayerEntry(player);
    if (oldEntry && oldEntry[0] !== requestedName) delete db.players[oldEntry[0]];
    player.username = requestedName;
    player.ip = ip;
    player.playerId = req.playerId;
    player.lastActive = new Date().toISOString();
    if (!Array.isArray(player.badges)) player.badges = [];
    if (!Array.isArray(player.favorites)) player.favorites = [];
    if (!Array.isArray(player.friends)) player.friends = [];
    if (!player.games || typeof player.games !== 'object') player.games = {};
    db.players[requestedName] = player;
  } else {
    player = {
      username: requestedName,
      ip,
      playerId: req.playerId,
      level: 1,
      xp: 0,
      totalPlaytimeMinutes: 0,
      noAds: false,
      extraAds: false,
      friends: [],
      favorites: [],
      badges: ['pionnier'],
      frame: 'neon',
      team: null,
      lastPlayedGame: null,
      createdAt: new Date().toISOString(),
      lastActive: new Date().toISOString(),
      games: {}
    };
    db.players[requestedName] = player;
    addLog('NOUVEAU_JOUEUR', `${requestedName} (${ip})`);
  }

  try {
    await persistDBOrThrow();
    return res.json({ success: true, player });
  } catch (e) {
    return res.status(503).json({ success: false, message: 'Le profil n’a pas pu être sauvegardé. Réessaie.', error: supabase ? undefined : e.message });
  }
});

app.post('/api/player/heartbeat', (req, res) => {
  const player = findPlayerForRequest(req);
  if (!player) return res.json({ success: false });

  const mult = db.eventMultiplier.active ? db.eventMultiplier.factor : 1;
  player.totalPlaytimeMinutes = (player.totalPlaytimeMinutes || 0) + 1;
  player.xp = (player.xp || 0) + (10 * mult);
  player.level = Math.floor(player.xp / 100) + 1;
  player.lastActive = new Date().toISOString();

  if (player.team && db.teams[player.team]) {
    db.teams[player.team].score += (10 * mult);
  }

  saveDB();
  res.json({ success: true, level: player.level, xp: player.xp, playtime: player.totalPlaytimeMinutes });
});

app.post('/api/wheel/spin', (req, res) => {
  const player = findPlayerForRequest(req);
  if (!player) return res.status(400).json({ success: false, message: "Enregistrez d'abord un pseudo." });

  const now = Date.now();
  if (player.lastWheelSpin && (now - player.lastWheelSpin < 24 * 3600 * 1000)) {
    return res.status(429).json({ success: false, message: "Roue déjà tournée aujourd'hui !" });
  }

  const rewards = [
    { text: "+50 XP", xp: 50 },
    { text: "+100 XP", xp: 100 },
    { text: "+250 XP", xp: 250 },
    { text: "Cadre Or", frame: "gold" },
    { text: "+30 XP", xp: 30 }
  ];
  const chosen = rewards[Math.floor(Math.random() * rewards.length)];

  if (chosen.xp) {
    player.xp = (player.xp || 0) + chosen.xp;
    player.level = Math.floor(player.xp / 100) + 1;
  }
  if (chosen.frame) player.frame = chosen.frame;

  player.lastWheelSpin = now;
  saveDB();
  res.json({ success: true, reward: chosen, player });
});

app.post('/api/promocodes/redeem', (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const player = findPlayerForRequest(req);
  if (!player) return res.status(400).json({ success: false, message: "Enregistrez d'abord un pseudo." });

  const promo = db.promocodes[code];
  if (!promo) return res.status(404).json({ success: false, message: "Code invalide !" });

  if (promo.usedBy && promo.usedBy.includes(player.username)) {
    return res.status(400).json({ success: false, message: "Code déjà utilisé !" });
  }

  if (!promo.usedBy) promo.usedBy = [];
  promo.usedBy.push(player.username);
  promo.uses = (promo.uses || 0) + 1;

  if (promo.rewardXp) {
    player.xp = (player.xp || 0) + promo.rewardXp;
    player.level = Math.floor(player.xp / 100) + 1;
  }
  saveDB();
  res.json({ success: true, message: `Code validé ! +${promo.rewardXp || 0} XP`, player });
});

app.post('/api/teams/action', (req, res) => {
  const { action, teamTag, teamName } = req.body;
  const player = findPlayerForRequest(req);
  if (!player) return res.status(400).json({ success: false });

  const tag = (teamTag || '').trim().toUpperCase().substring(0, 5);
  if (action === 'create') {
    if (db.teams[tag]) return res.status(409).json({ success: false, message: "Tag déjà pris !" });
    db.teams[tag] = { tag, name: teamName || tag, leader: player.username, members: [player.username], score: player.xp || 0 };
    player.team = tag;
  } else if (action === 'join') {
    if (!db.teams[tag]) return res.status(404).json({ success: false, message: "Équipe introuvable." });
    if (!db.teams[tag].members.includes(player.username)) {
      db.teams[tag].members.push(player.username);
      db.teams[tag].score += (player.xp || 0);
    }
    player.team = tag;
  }
  saveDB();
  res.json({ success: true, team: db.teams[tag] });
});

app.post('/api/player/set-frame', (req, res) => {
  const player = findPlayerForRequest(req);
  if (!player) return res.status(400).json({ success: false });
  const allowedFrames = new Set(['', 'neon', 'gold', 'flame']);
  if (!allowedFrames.has(String(req.body.frame || ''))) return res.status(400).json({ success: false, message: 'Cadre invalide.' });
  player.frame = String(req.body.frame || '');
  saveDB();
  return res.json({ success: true });
});

app.post('/api/telemetry/session', (req, res) => {
  const ip = getIP(req);
  const { gameId, action, durationSeconds } = req.body;
  const game = db.games.find(g => g.id === gameId);
  if (!game) return res.status(404).json({ success: false });

  if (action === 'start') {
    game.plays = (game.plays || 0) + 1;
    const player = findPlayerForRequest(req);
    if (player) player.lastPlayedGame = { id: game.id, title: game.title, url: game.url, icon: game.icon };
  } else if (action === 'end' && durationSeconds) {
    game.totalPlaytimeSeconds = (game.totalPlaytimeSeconds || 0) + durationSeconds;
  }
  saveDB();
  res.json({ success: true });
});

app.post('/api/progress/save', async (req, res) => {
  const { gameId, progressData } = req.body;
  if (typeof gameId !== 'string' || !gameId || gameId.length > 160 || !progressData || typeof progressData !== 'object' || Array.isArray(progressData)) {
    return res.status(400).json({ success: false, message: 'Progression invalide.' });
  }
  const player = findPlayerForRequest(req);
  if (!player) return res.status(404).json({ success: false, message: 'Enregistre un pseudo avant de sauvegarder.' });

  // Snapshot pour restaurer l'état en mémoire si le stockage distant échoue.
  const oldGames = JSON.parse(JSON.stringify(player.games || {}));
  const oldBadges = Array.isArray(player.badges) ? player.badges.slice() : [];
  const oldXp = player.xp || 0;
  const oldLevel = player.level || 1;
  if (!player.games || typeof player.games !== 'object') player.games = {};
  player.games[gameId] = { ...(player.games[gameId] || {}), ...progressData, lastPlayed: new Date().toISOString() };

  if (db.weeklyChallenge.active && gameId === db.weeklyChallenge.gameId && Number(progressData.score) >= Number(db.weeklyChallenge.targetScore)) {
    if (!Array.isArray(player.badges)) player.badges = [];
    if (!player.badges.includes('defi_hebdo')) {
      player.badges.push('defi_hebdo');
      player.xp = (player.xp || 0) + Number(db.weeklyChallenge.rewardXp || 0);
      player.level = Math.floor(player.xp / 100) + 1;
    }
  }

  try {
    await persistDBOrThrow();
    return res.json({ success: true, progress: player.games[gameId] });
  } catch (e) {
    player.games = oldGames;
    player.badges = oldBadges;
    player.xp = oldXp;
    player.level = oldLevel;
    return res.status(503).json({ success: false, message: 'La sauvegarde distante a échoué. Réessaie dans un instant.' });
  }
});

app.get('/api/progress/load/:gameId', (req, res) => {
  const player = findPlayerForRequest(req);
  if (!player || !player.games || !player.games[req.params.gameId]) return res.json({ success: false, progress: null });
  res.json({ success: true, progress: player.games[req.params.gameId] });
});

app.get('/api/leaderboards/global', (req, res) => {
  const topPlayers = Object.values(db.players)
    .sort((a, b) => (b.level * 1000 + (b.xp || 0)) - (a.level * 1000 + (a.xp || 0)))
    .slice(0, 10)
    .map((p, idx) => ({ rank: idx + 1, username: p.username, team: p.team, level: p.level || 1, playtime: p.totalPlaytimeMinutes || 0 }));
  res.json({ topPlayers, topTeams: Object.values(db.teams).sort((a,b)=>b.score-a.score).slice(0,5) });
});

app.post('/api/games/:id/favorite', (req, res) => {
  const player = findPlayerForRequest(req);
  if (!player) return res.status(400).json({ success: false });
  if (!Array.isArray(player.favorites)) player.favorites = [];
  const gId = req.params.id;
  if (!db.games.some(g => g.id === gId)) return res.status(404).json({ success: false, message: 'Jeu introuvable.' });
  const idx = player.favorites.indexOf(gId);
  if (idx >= 0) player.favorites.splice(idx, 1);
  else player.favorites.push(gId);
  saveDB();
  return res.json({ success: true, favorites: player.favorites });
});

app.post('/api/games/:id/review', (req, res) => {
  const ip = getIP(req);
  const { rating, comment, username } = req.body;
  const game = db.games.find(g => g.id === req.params.id);
  if (!game) return res.status(404).json({ success: false });

  db.reviews.unshift({
    id: 'rev_' + Date.now(),
    gameId: game.id,
    gameTitle: game.title,
    username: username || 'Anonyme',
    ip,
    rating: Math.max(1, Math.min(5, Number(rating) || 5)),
    comment: String(comment || '').trim().substring(0, 300),
    timestamp: new Date().toISOString()
  });
  saveDB();
  res.json({ success: true });
});

app.post('/api/bugs/report', (req, res) => {
  const ip = getIP(req);
  const { gameTitle, description, username } = req.body;
  db.bugs.unshift({
    id: 'bug_' + Date.now(),
    gameTitle: gameTitle || 'Portail',
    username: username || 'Visiteur',
    ip,
    description: (description || '').trim().substring(0, 500),
    timestamp: new Date().toISOString(),
    status: 'open'
  });
  saveDB();
  res.json({ success: true });
});

const errorReportWindow = new Map();
app.post('/api/errors/report', (req, res) => {
  const ip = getIP(req);
  const now = Date.now();
  const windowStart = errorReportWindow.get(ip) || { startedAt: now, count: 0 };
  if (now - windowStart.startedAt > 60_000) { windowStart.startedAt = now; windowStart.count = 0; }
  if (windowStart.count >= 10) return res.status(429).json({ success: false, message: 'Trop de rapports en peu de temps.' });
  windowStart.count++;
  errorReportWindow.set(ip, windowStart);
  const message = String(req.body.message || 'Erreur inconnue').slice(0, 1000);
  const stack = String(req.body.stack || '').slice(0, 4000);
  db.bugs.unshift({ id: 'err_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex'), type: 'client_error', gameTitle: 'Erreur JavaScript', username: 'Client', ip, description: message, stack, timestamp: new Date().toISOString(), status: 'open' });
  if (db.bugs.length > 200) db.bugs.length = 200;
  saveDB();
  res.status(202).json({ success: true });
});

app.post('/api/games/:id/vote', (req, res) => {
  const game = db.games.find(g => g.id === req.params.id);
  if (game) {
    game.votes = (game.votes || 0) + 1;
    saveDB();
    io.emit('games:updated', db.games);
    return res.json({ success: true, votes: game.votes });
  }
  res.status(404).json({ success: false });
});

app.post('/api/games/:id/like', (req, res) => {
  const game = db.games.find(g => g.id === req.params.id);
  if (game) {
    game.likes = (game.likes || 0) + 1;
    saveDB();
    io.emit('games:updated', db.games);
    return res.json({ success: true, likes: game.likes });
  }
  res.status(404).json({ success: false });
});

app.post('/api/friends/add', (req, res) => {
  const friendName = String(req.body.friendName || '').trim();
  const me = findPlayerForRequest(req);
  if (!me) return res.status(400).json({ success: false, message: "Enregistrez d'abord un pseudo." });
  if (!db.players[friendName]) return res.status(404).json({ success: false, message: "Joueur introuvable." });

  if (!me.friends) me.friends = [];
  if (!me.friends.includes(friendName)) { me.friends.push(friendName); saveDB(); }
  res.json({ success: true, friends: me.friends });
});

// Sockets temps réel
io.on('connection', (socket) => {
  const clientIP = String(socket.handshake.headers['x-forwarded-for'] || socket.handshake.address || '127.0.0.1').split(',')[0].trim();

  if (db.bans.includes(clientIP)) {
    socket.emit('banned', { reason: "Votre IP est bannie." });
    socket.disconnect(true);
    return;
  }

  socket.on('player:online', (username) => {
    socket.username = username;
    io.emit('online:count', io.sockets.sockets.size);
  });

  socket.on('chat:private', (data) => {
    const { to, message } = data;
    if (!socket.username || !to || !message) return;
    const packet = { from: socket.username, to, message: message.substring(0, 150), timestamp: new Date().toLocaleTimeString() };
    for (const [id, s] of io.sockets.sockets) {
      if (s.username === to) s.emit('chat:receive', packet);
    }
    socket.emit('chat:receive', packet);
    io.emit('admin:chat_spy', packet);
  });

  socket.on('admin:bind_token', (token) => {
    if (activeAdminTokens.has(token)) {
      socket.isAdmin = true;
      socket.adminToken = token;
    }
  });

  socket.on('admin:toggle_game_pause', async (id) => {
    if (!socket.isAdmin) return;
    const g = db.games.find(x => x.id === id);
    if (!g) return;
    const oldStatus = g.status;
    g.status = (g.status === 'paused') ? 'playable' : 'paused';
    try { await persistDBOrThrow(); }
    catch (_) { g.status = oldStatus; socket.emit('admin:alert', 'Impossible d’enregistrer le statut du jeu. Réessaie.'); return; }
    io.emit('games:updated', db.games);
    io.emit('game:status_changed', { id: g.id, status: g.status });
    socket.emit('admin:game_saved', db.games);
  });

  socket.on('admin:delete_game', async (id) => {
    if (!socket.isAdmin) return;
    const game = db.games.find(x => x.id === id);
    if (!game) { socket.emit('admin:alert', 'Jeu introuvable.'); return; }
    const oldGames = db.games.slice();
    db.games = db.games.filter(x => x.id !== id);
    try {
      await persistDBOrThrow();
    } catch (_) {
      db.games = oldGames;
      socket.emit('admin:alert', 'La suppression n’a pas pu être sauvegardée. Réessaie.');
      return;
    }
    if (supabase && typeof game.url === 'string') {
      const match = /^\/games\/([a-z0-9-]+)\/?$/i.exec(game.url);
      const stillUsed = db.games.some(other => other.url === game.url);
      if (match && !stillUsed) {
        const { error } = await supabase.storage.from(ASSETS_BUCKET).remove([`games/${match[1].toLowerCase()}/index.html`]);
        if (error) console.error('Suppression du fichier jeu impossible:', error.message);
      }
    }
    io.emit('games:updated', db.games);
    socket.emit('admin:game_saved', db.games);
  });

  socket.on('admin:resolve_bug', async (bugId) => {
    if (!socket.isAdmin) return;
    const b = db.bugs.find(x => x.id === bugId);
    if (!b) return;
    const oldStatus = b.status;
    b.status = 'resolved';
    try { await persistDBOrThrow(); socket.emit('admin:alert', 'Bug résolu !'); }
    catch (_) { b.status = oldStatus; socket.emit('admin:alert', 'Impossible de sauvegarder la résolution du bug.'); }
  });

  socket.on('admin:set_maintenance', async (mConfig) => {
    if (!socket.isAdmin || !mConfig || typeof mConfig !== 'object') return;
    const oldValue = { ...db.maintenance };
    Object.assign(db.maintenance, mConfig);
    try { await persistDBOrThrow(); }
    catch (_) { db.maintenance = oldValue; socket.emit('admin:alert', 'La configuration de maintenance n’a pas pu être sauvegardée.'); return; }
    io.emit('maintenance:updated', db.maintenance);
    socket.emit('admin:alert', 'Maintenance mise à jour et sauvegardée !');
  });

  socket.on('admin:toggle_event', async (eventConfig) => {
    if (!socket.isAdmin || !eventConfig || typeof eventConfig !== 'object') return;
    const oldValue = { ...db.eventMultiplier };
    Object.assign(db.eventMultiplier, eventConfig);
    try { await persistDBOrThrow(); }
    catch (_) { db.eventMultiplier = oldValue; socket.emit('admin:alert', 'L’événement n’a pas pu être sauvegardé.'); return; }
    io.emit('event:updated', db.eventMultiplier);
    socket.emit('admin:alert', 'Événement mis à jour et sauvegardé !');
  });

  socket.on('admin:update_announcement', async (ann) => {
    if (!socket.isAdmin || !ann || typeof ann !== 'object') return;
    const oldValue = { ...db.announcement };
    Object.assign(db.announcement, ann);
    try { await persistDBOrThrow(); }
    catch (_) { db.announcement = oldValue; socket.emit('admin:alert', 'Le bandeau n’a pas pu être sauvegardé.'); return; }
    io.emit('announcement:updated', db.announcement);
    socket.emit('admin:alert', 'Bandeau mis à jour et sauvegardé !');
  });

  socket.on('admin:create_promocode', async (data) => {
    if (!socket.isAdmin || !data || typeof data.code !== 'string') return;
    const c = data.code.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 40);
    if (!c) return socket.emit('admin:alert', 'Code promo invalide.');
    const oldValue = db.promocodes[c];
    db.promocodes[c] = { rewardXp: Math.max(0, Number(data.rewardXp) || 100), uses: 0, usedBy: [] };
    try { await persistDBOrThrow(); }
    catch (_) { if (oldValue) db.promocodes[c] = oldValue; else delete db.promocodes[c]; socket.emit('admin:alert', 'Le code promo n’a pas pu être sauvegardé.'); return; }
    socket.emit('admin:alert', `Code ${c} créé et sauvegardé !`);
  });

  socket.on('admin:restore_backup', async (backupData) => {
    if (!socket.isAdmin) return;
    if (!backupData || typeof backupData !== 'object' || !backupData.players || !Array.isArray(backupData.games) || !Array.isArray(backupData.playlist)) {
      socket.emit('admin:alert', 'Backup invalide : structure non reconnue.');
      return;
    }
    const oldDatabaseSnapshot = JSON.parse(JSON.stringify(db));
    try {
      // Compatibilité avec les anciens backups qui embarquaient le HTML directement dans la base.
      if (supabase) {
        for (const game of backupData.games) {
          if (game && game.fileContent && typeof game.url === 'string') {
            const match = /^\/games\/([a-z0-9-]+)\/?$/.exec(game.url);
            if (match) await uploadStoredAsset(`games/${match[1]}/index.html`, Buffer.from(String(game.fileContent), 'utf8'), 'text/html; charset=utf-8');
            delete game.fileContent;
          }
        }
      }
      Object.assign(db, backupData);
      normalizeDB();
      await persistDBOrThrow();
      io.emit('games:updated', db.games);
      io.emit('playlist:updated', db.playlist);
      io.emit('announcement:updated', db.announcement);
      io.emit('maintenance:updated', db.maintenance);
      socket.emit('admin:alert', 'Backup restaurée et sauvegardée !');
    } catch (e) {
      db = oldDatabaseSnapshot;
      normalizeDB();
      socket.emit('admin:alert', 'Échec de restauration : la base en mémoire a été rétablie. Vérifie le stockage persistant et réessaie.');
    }
  });

  socket.on('admin:purge_inactive', async (days) => {
    if (!socket.isAdmin) return;
    const safeDays = Math.max(1, Math.min(36500, Number(days) || 30));
    const cutoff = Date.now() - (safeDays * 24 * 60 * 60 * 1000);
    const oldPlayers = { ...db.players };
    let count = 0;
    for (const name in db.players) {
      if (new Date(db.players[name].lastActive || 0).getTime() < cutoff) {
        delete db.players[name];
        count++;
      }
    }
    try { await persistDBOrThrow(); }
    catch (_) { db.players = oldPlayers; socket.emit('admin:alert', 'La purge n’a pas pu être sauvegardée. Aucun changement conservé.'); return; }
    socket.emit('admin:alert', `${count} comptes inactifs supprimés et sauvegardés.`);
  });

  socket.on('admin:ban_ip', async (ip) => {
    if (!socket.isAdmin || typeof ip !== 'string' || !ip.trim()) return;
    const cleanIP = ip.trim().slice(0, 80);
    const oldBans = db.bans.slice();
    if (!db.bans.includes(cleanIP)) db.bans.push(cleanIP);
    try { await persistDBOrThrow(); }
    catch (_) { db.bans = oldBans; socket.emit('admin:alert', 'Le bannissement n’a pas pu être sauvegardé.'); return; }
    for (const [, clientSocket] of io.sockets.sockets) {
      const socketIP = String(clientSocket.handshake.headers['x-forwarded-for'] || clientSocket.handshake.address || '127.0.0.1').split(',')[0].trim();
      if (socketIP === cleanIP) {
        clientSocket.emit('banned', { reason: 'Votre adresse IP a été bannie.' });
        clientSocket.disconnect(true);
      }
    }
    socket.emit('admin:alert', `IP ${cleanIP} bannie et sauvegardée.`);
  });

  socket.on('admin:unban', async (ip) => {
    if (!socket.isAdmin) return;
    const oldBans = db.bans.slice();
    db.bans = db.bans.filter(b => b !== ip);
    try { await persistDBOrThrow(); }
    catch (_) { db.bans = oldBans; socket.emit('admin:alert', 'Le débannissement n’a pas pu être sauvegardé.'); }
  });

  socket.on('disconnect', () => { io.emit('online:count', io.sockets.sockets.size); });
});

// Rotation jeu vedette toutes les 15 minutes
setInterval(() => {
  const playableGames = db.games.filter(game => game.status === 'playable');
  if (db.featuredRotation.active && playableGames.length > 0) {
    db.featuredRotation.currentIdx = ((Number(db.featuredRotation.currentIdx) || 0) + 1) % playableGames.length;
    saveDB();
    io.emit('featured:changed', playableGames[db.featuredRotation.currentIdx]);
  }
}, 15 * 60 * 1000);

initializePersistence()
  .then(() => {
    server.listen(PORT, () => {
      console.log("Serveur actif sur le port " + PORT);
      console.log('Mode de persistance : ' + (supabase ? 'Supabase (distant)' : 'local (non adapté à un hébergement éphémère)'));
      if (!ADMIN_PASSWORD) console.warn('ADMIN_PASSWORD absent : la connexion admin est désactivée.');
    });
  })
  .catch((e) => {
    console.error('Démarrage interrompu : la persistance n’a pas pu être initialisée.', e.message);
    process.exit(1);
  });