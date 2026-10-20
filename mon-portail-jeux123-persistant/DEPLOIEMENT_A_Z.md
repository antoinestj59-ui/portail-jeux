# Déploiement A à Z — Portail Arcade persistant

Ce ZIP remplace les fichiers de l’application dans le dépôt. La persistance distante ne fonctionne que **quand Supabase est configuré et que la migration initiale est terminée**.

## 1. Avant toute modification

- Connecte-toi à l’administration du portail actuel et télécharge un backup JSON.
- Conserve aussi une copie des fichiers HTML/audio que tu ne pourrais pas récupérer du serveur.
- Si les jeux ont déjà disparu du serveur actuel après un redémarrage, ce ZIP ne peut pas recréer les fichiers disparus : réimporte tes fichiers originaux ou restaure une copie qui les contient.

## 2. Préparer Supabase

- Crée un projet Supabase.
- Exécute le SQL de création de `portal_state` dans `SUPABASE_SETUP.md`.
- Dans Storage, crée un bucket privé nommé `portal-assets`.
- Garde la clé secrète du serveur privée : ne la colle ni dans une page HTML ni dans GitHub.

## 3. Installer le ZIP dans Codespaces

Place `mon-portail-jeux123-persistant.zip` dans le dossier racine du Codespace, là où se trouvent actuellement `server.js` et `package.json`. Puis lance :

```bash
unzip -o mon-portail-jeux123-persistant.zip -d .
npm install
npm run check
```

L’archive a les chemins relatifs à la racine du dépôt. Elle ne contient pas `.env`, `database.json` ni `public/dropzone/`.

## 4. Migrer les jeux avant le redéploiement

L’ancien serveur doit encore répondre et afficher les jeux que tu veux conserver.

```bash
test -f .env || cp .env.example .env
```

Édite ensuite `.env` pour ajouter/remplacer ces valeurs avec tes propres informations :

```env
LEGACY_PORTAL_URL=https://TON-ANCIEN-SITE
LEGACY_ADMIN_PASSWORD=LE_MOT_DE_PASSE_ACTUEL_DE_L_ADMIN
SUPABASE_URL=https://TON-PROJET.supabase.co
SUPABASE_SECRET_KEY=TA_CLE_SECRETE_SUPABASE
SUPABASE_STORAGE_BUCKET=portal-assets
```

La migration utilise l’ancien mot de passe admin seulement pour lire le backup de l’ancien portail. Ne m’envoie jamais ce mot de passe et ne commit pas `.env`.

Lance :

```bash
node scripts/migrate-from-live.js
```

Le script télécharge les données de l’ancien portail, puis copie les HTML des jeux locaux et les fichiers musicaux vers Supabase. Il injecte également le SDK et l’identifiant de jeu dans les HTML migrés. Il vérifie ensuite le nombre de fiches enregistrées.

**Si le script échoue, s’il ne retrouve pas un jeu ou si les compteurs ne correspondent pas : arrête-toi et ne déploie pas encore le nouveau serveur.** La migration ne peut pas récupérer les fichiers qui ont déjà disparu du serveur source.

## 5. Configurer les variables de l’hébergeur

Avant de pousser la nouvelle version, dans les paramètres d’environnement du service Node.js, configure :

- `PERSISTENCE_MODE=supabase`
- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY` (ou `SUPABASE_SERVICE_ROLE_KEY` pour une ancienne clé de service)
- `SUPABASE_STORAGE_BUCKET=portal-assets`
- `ADMIN_PASSWORD` : choisis un nouveau mot de passe administrateur fort

Le nouveau serveur refuse de démarrer si la configuration Supabase manque. C’est intentionnel : il ne faut pas qu’il se rabatte silencieusement sur le disque local temporaire.

## 6. Retirer Dropzone et la base locale du suivi Git

Le ZIP retire le jeu intégré Dropzone, mais l’extraction n’efface pas forcément un ancien dossier qui existe déjà dans le Codespace. Exécute :

```bash
git rm -r public/dropzone
git rm --cached database.json
```

Si Git indique qu’un de ces chemins n’est pas suivi/existant, vérifie simplement qu’il n’est plus publié. `git rm --cached database.json` conserve normalement le fichier sur le disque mais le retire de l’index Git ; `.gitignore` évite qu’il soit ajouté à nouveau.

## 7. Envoyer les modifications

```bash
git add -A
git status --short
git commit -m "Fix persistent game storage and transfer keys"
git push
```

Relis `git status --short` avant le commit. `.env`, les clés Supabase, et les backups de joueurs ne doivent jamais être committés.

## 8. Vérifier en production

Ouvre `https://TON-SITE/api/persistence/status`. Tu dois voir `mode: "supabase"`, `persistent: true` et `healthy: true`.

Connecte-toi ensuite à l’administration avec la nouvelle variable `ADMIN_PASSWORD`. Ouvre un jeu existant, importe un petit HTML de test, puis vérifie qu’il se retrouve dans Supabase Storage et reste jouable après redémarrage. Réessaie après plus de 15 minutes sans visites. Teste enfin la clé de transfert depuis un autre navigateur/appareil : elle est valable 24 heures et à usage unique.

## Limite importante des sauvegardes de jeu

Le portail injecte automatiquement `/arcade-sdk.js` et `Arcade.init('ID_DU_JEU')` dans chaque HTML importé. Pour qu’un jeu restaure vraiment un score, un niveau ou un état spécifique, le code du jeu doit appeler `await Arcade.save({ score, level })` quand ces valeurs changent et `await Arcade.load()` au lancement. Le portail ne peut pas deviner les noms des variables internes d’un jeu arbitraire.
