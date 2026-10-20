#!/usr/bin/env node
/*
 * Migration ponctuelle du portail actuellement en ligne vers Supabase.
 * Lance AVANT de redéployer l'ancien serveur, tant que ses jeux et fichiers sont accessibles.
 * Les secrets sont lus depuis .env et ne doivent jamais être commités.
 */
require('dotenv').config();
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const baseUrl = String(process.env.LEGACY_PORTAL_URL || '').trim().replace(/\/+$/, '');
const legacyPassword = process.env.LEGACY_ADMIN_PASSWORD || '';
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'portal-assets';

function requireValue(value, name) {
  if (!value) throw new Error(`Variable manquante : ${name} (renseigne-la dans le fichier .env local).`);
}

async function fetchChecked(url, options = {}) {
  let response;
  try {
    response = await fetch(url, { ...options, redirect: 'follow' });
  } catch (error) {
    throw new Error(`Impossible de joindre ${url}: ${error.message}`);
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 240);
    throw new Error(`HTTP ${response.status} sur ${url}${detail ? ` — ${detail}` : ''}`);
  }
  return response;
}

async function uploadAsset(supabase, objectPath, body, contentType) {
  const { error } = await supabase.storage.from(bucket).upload(objectPath, body, {
    contentType: contentType || 'application/octet-stream',
    upsert: true,
    cacheControl: '3600'
  });
  if (error) throw new Error(`Échec upload ${objectPath}: ${error.message}`);
}

// Assure aussi les jeux récupérés depuis l'ancien serveur : ils n'avaient pas
// forcément reçu le SDK quand ils ont été importés. Une seule initialisation
// Arcade est injectée avant le code propre au jeu.
function prepareMigratedGameHtml(sourceHtml, gameId) {
  let html = String(sourceHtml || '');
  if (!/<html\b|<!doctype\s+html/i.test(html)) {
    throw new Error('Un jeu migré ne semble pas être un document HTML complet.');
  }
  const idLiteral = JSON.stringify(String(gameId));
  html = html.replace(/<!-- ARCADE_PORTAL_SDK_START -->[\s\S]*?<!-- ARCADE_PORTAL_SDK_END -->\s*/gi, '');
  html = html.replace(/<script\b(?=[^>]*\bsrc\s*=\s*(['"])[^'"]*arcade-sdk\.js(?:\?[^'"]*)?\1)[^>]*>\s*<\/script\s*>/gi, '');
  html = html.replace(/(?:window\s*\.\s*)?Arcade\s*\.\s*init\s*\(\s*(['"`])[^)]*?\1\s*\)\s*;?/gi, '');
  const block = `<!-- ARCADE_PORTAL_SDK_START -->\n<script src="/arcade-sdk.js"></script>\n<script>window.Arcade && window.Arcade.init(${idLiteral});</script>\n<!-- ARCADE_PORTAL_SDK_END -->`;
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, match => `${match}\n${block}`);
  if (/<!doctype\s+html[^>]*>/i.test(html)) return html.replace(/<!doctype\s+html[^>]*>/i, match => `${match}\n${block}`);
  return `${block}\n${html}`;
}

async function main() {
  requireValue(baseUrl, 'LEGACY_PORTAL_URL');
  requireValue(legacyPassword, 'LEGACY_ADMIN_PASSWORD');
  requireValue(supabaseUrl, 'SUPABASE_URL');
  requireValue(supabaseKey, 'SUPABASE_SECRET_KEY');

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const { data: existingState, error: checkError } = await supabase
    .from('portal_state').select('id, state').eq('id', 1).maybeSingle();
  if (checkError) throw new Error(`Impossible de vérifier portal_state : ${checkError.message}`);
  if (existingState && process.env.ALLOW_OVERWRITE !== '1') {
    throw new Error('Une sauvegarde existe déjà dans Supabase. Par sécurité, migration interrompue. Si tu es certain de vouloir la remplacer, définis ALLOW_OVERWRITE=1 dans .env.');
  }

  console.log('Connexion au portail actuel…');
  const loginResponse = await fetchChecked(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pass: legacyPassword })
  });
  const login = await loginResponse.json();
  if (!login.success || !login.token) throw new Error(login.message || 'Connexion administrateur impossible. Vérifie LEGACY_ADMIN_PASSWORD.');

  console.log('Téléchargement de la base actuelle…');
  const backupResponse = await fetchChecked(`${baseUrl}/api/admin/backup?token=${encodeURIComponent(login.token)}`);
  const db = await backupResponse.json();
  if (!db || typeof db !== 'object' || !db.players || !Array.isArray(db.games) || !Array.isArray(db.playlist)) {
    throw new Error('Le backup reçu ne ressemble pas à la base du portail (players, games, playlist manquants).');
  }

  let migratedGames = 0;
  let migratedMusic = 0;
  let skipped = 0;
  let removedDropzone = 0;
  db.games = db.games.filter(game => {
    const urlPath = String(game && game.url || '').split(/[?#]/, 1)[0].toLowerCase();
    const title = String(game && game.title || '').trim().toLowerCase();
    const bundledDropzone = /^\/dropzone(?:\/|$)/.test(urlPath) || (title === 'dropzone' && !/^\/games\//.test(urlPath));
    if (bundledDropzone) removedDropzone++;
    return !bundledDropzone;
  });

  for (const game of db.games) {
    if (!game || typeof game.url !== 'string') continue;
    const resolvedGameUrl = new URL(game.url, baseUrl);
    if (resolvedGameUrl.origin !== new URL(baseUrl).origin) { skipped++; continue; }
    const local = /^\/games\/([a-z0-9-]+)\/?$/i.exec(resolvedGameUrl.pathname);
    if (!local) { skipped++; continue; }
    const slug = local[1].toLowerCase();
    let bytes;
    if (typeof game.fileContent === 'string' && game.fileContent.length) {
      bytes = Buffer.from(game.fileContent, 'utf8');
    } else {
      const response = await fetchChecked(new URL(`/games/${slug}/`, baseUrl).toString());
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.toLowerCase().includes('html')) {
        throw new Error(`Le fichier du jeu « ${game.title || slug} » ne semble pas être du HTML (${contentType}). Aucun état n'a encore été écrit dans Supabase.`);
      }
      bytes = Buffer.from(await response.arrayBuffer());
    }
    const gameId = String(game.id || `game_migrated_${slug}`);
    game.id = gameId;
    bytes = Buffer.from(prepareMigratedGameHtml(bytes.toString('utf8'), gameId), 'utf8');
    await uploadAsset(supabase, `games/${slug}/index.html`, bytes, 'text/html; charset=utf-8');
    game.url = `/games/${slug}/`;
    delete game.fileContent;
    migratedGames++;
    console.log(`  Jeu sauvegardé : ${game.title || slug}`);
  }

  for (const track of db.playlist) {
    if (!track || typeof track.url !== 'string') continue;
    const resolvedTrackUrl = new URL(track.url, baseUrl);
    if (resolvedTrackUrl.origin !== new URL(baseUrl).origin) { skipped++; continue; }
    const pathname = resolvedTrackUrl.pathname;
    const match = /^\/music\/([a-zA-Z0-9._-]+)$/.exec(pathname);
    if (!match) { skipped++; continue; }
    const filename = path.basename(match[1]);
    const response = await fetchChecked(new URL(`/music/${filename}`, baseUrl).toString());
    const body = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') || 'audio/mpeg';
    await uploadAsset(supabase, `music/${filename}`, body, contentType);
    track.url = `/music/${filename}`;
    migratedMusic++;
    console.log(`  Musique sauvegardée : ${track.title || filename}`);
  }

  const { error: stateError } = await supabase.from('portal_state').upsert({
    id: 1,
    state: db,
    updated_at: new Date().toISOString()
  }, { onConflict: 'id' });
  if (stateError) throw new Error(`Les fichiers ont été envoyés, mais la base n'a pas été importée : ${stateError.message}`);

  const verification = await supabase.from('portal_state').select('state, updated_at').eq('id', 1).single();
  if (verification.error) throw new Error(`Impossible de vérifier la migration : ${verification.error.message}`);
  if (!verification.data.state || verification.data.state.games.length !== db.games.length) {
    throw new Error('Vérification échouée : le nombre de jeux enregistré ne correspond pas au backup.');
  }

  console.log('\nMIGRATION TERMINÉE');
  console.log(`Joueurs : ${Object.keys(db.players).length}`);
  console.log(`Jeux : ${db.games.length} fiches conservées, ${migratedGames} fichiers locaux migrés; ${removedDropzone} entrée(s) Dropzone intégrée(s) retirée(s)`);
  console.log(`Musiques : ${db.playlist.length} pistes, ${migratedMusic} fichiers locaux migrés`);
  console.log(`Ressources externes ou chemins non locaux laissés tels quels : ${skipped}`);
  console.log('Les données et fichiers sont désormais copiés dans Supabase. Tu peux ensuite déployer le nouveau server.js.');
}

main().catch(error => {
  console.error('\nMIGRATION INTERROMPUE :', error.message);
  console.error('Ne déploie pas encore le nouveau serveur. Corrige le problème, puis relance la migration.');
  process.exitCode = 1;
});
