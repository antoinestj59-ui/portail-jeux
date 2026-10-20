# Guide complet : corriger les pertes de jeux après 15 minutes

La rotation du jeu mis en avant toutes les 15 minutes ne supprime pas les jeux. Le vrai problème est que l'ancienne version écrit les jeux importés dans `public/games/`, la musique dans `public/music/`, et les fiches dans `database.json` sur le disque du serveur. Sur un hébergeur à disque éphémère (par exemple un service gratuit qui s'endort), ces fichiers locaux ne sont pas une sauvegarde durable.

Cette version place la base dans Supabase Postgres et les fichiers importés dans Supabase Storage. Les visiteurs peuvent ouvrir les jeux même quand personne ne s'est connecté depuis plusieurs heures, après le réveil du serveur.

## A. Créer le stockage (une seule fois)

1. Crée un projet sur https://supabase.com/.
2. Dans **SQL Editor**, exécute :

```sql
create table if not exists public.portal_state (
  id integer primary key check (id = 1),
  state jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.portal_state enable row level security;
revoke all on public.portal_state from anon, authenticated;
grant all on public.portal_state to service_role;
```

3. Dans **Storage**, crée un bucket `portal-assets`. Laisse-le **privé**. Le serveur utilisera sa clé côté serveur pour lire les fichiers; ne rends jamais le bucket public pour contourner une erreur.

## B. Migrer les jeux déjà importés AVANT de remplacer l'ancien serveur

Cette étape protège les données encore présentes dans ton portail en ligne. Ne la saute pas si les jeux actuels ne sont pas inclus dans le dépôt GitHub.

1. Dans Codespaces, ouvre le terminal du projet et exécute `cp .env.example .env` si tu n'as pas encore de fichier `.env`.
2. Édite `.env` localement pour ajouter :

```env
LEGACY_PORTAL_URL=https://TON-SITE-ACTUEL.onrender.com
LEGACY_ADMIN_PASSWORD=LE_MOT_DE_PASSE_ACTUEL_DE_L_ADMIN
SUPABASE_URL=https://TON-PROJET.supabase.co
SUPABASE_SECRET_KEY=TA_CLE_SECRETE_SUPABASE
SUPABASE_STORAGE_BUCKET=portal-assets
```

`LEGACY_ADMIN_PASSWORD` correspond au mot de passe de l'ancien serveur, avant son remplacement. La nouvelle valeur `ADMIN_PASSWORD` sera configurée ensuite sur l'hébergeur. Ne colle jamais ces clés dans un message et ne commit pas `.env`.

3. Si les dépendances ne sont pas installées, lance `npm install`.
4. Lance la migration pendant que l'ancien site est encore accessible :

```bash
node scripts/migrate-from-live.js
```

Le script se connecte à l'ancienne administration, télécharge le backup, récupère les HTML associés aux URL `/games/...` et les fichiers de musique `/music/...`, puis enregistre la base et les fichiers dans Supabase. Il vérifie le nombre de fiches de jeux à la fin. **En cas d'erreur, il s'arrête et tu ne dois pas déployer le nouveau serveur avant d'avoir résolu l'erreur.**

Si Supabase contient déjà une sauvegarde, la migration refuse de l'écraser. Ne définis `ALLOW_OVERWRITE=1` que si tu as vérifié le contenu et veux réellement remplacer cette sauvegarde.

Les URL externes ne sont pas importées. Les jeux fournis avec le projet, comme un jeu de démonstration, restent servis par les fichiers inclus dans `public/`. Les jeux importés par l'administration doivent être accessibles sur l'ancien site au moment de la migration.

## C. Configurer le nouveau service hébergé

Dans **Environment Variables** de l'hébergeur, configure :

- `PERSISTENCE_MODE=supabase` (obligatoire en production)
- `SUPABASE_URL` : URL Supabase
- `SUPABASE_SECRET_KEY` : clé secrète serveur (ou `SUPABASE_SERVICE_ROLE_KEY` si tu utilises l'ancien format de clé)
- `SUPABASE_STORAGE_BUCKET=portal-assets`
- `ADMIN_PASSWORD` : nouveau mot de passe administrateur fort et unique

Le serveur refuse de démarrer si le mode Supabase est choisi sans les secrets requis. Il ne doit pas fonctionner en mode local sur le service hébergé pour lequel tu veux une persistance entre réveils.

## D. Déployer et vérifier

Après la migration, remplace les fichiers du dépôt par ceux de ce ZIP et pousse les changements vers GitHub. Ton hébergeur redéploie le serveur. Dans l'administration, reconnecte-toi avec la nouvelle valeur de `ADMIN_PASSWORD`.

Ouvre ensuite `https://TON-SITE/api/persistence/status`. Résultat attendu :

```json
{
  "mode": "supabase",
  "persistent": true,
  "healthy": true
}
```

`lastSuccessfulSave` peut être nul immédiatement après un simple chargement; change un réglage de test dans l'admin, puis regarde le statut et la ligne `id=1` dans `portal_state`.

Teste aussi : (1) ouvrir un jeu existant, (2) ajouter un nouveau jeu HTML, (3) importer une musique, (4) changer l'ordre d'un jeu, (5) générer une clé de transfert sur un navigateur et l'utiliser sur un autre. Redémarre ensuite le service et vérifie à nouveau l'accès aux jeux.

## E. Fonctionnement local

Sans `PERSISTENCE_MODE=supabase`, le portail utilise `database.json` et les dossiers locaux; c'est seulement pour le développement. Sur un disque éphémère, le mode local peut perdre les jeux importés lors d'un redéploiement/sommeil.

`.env`, les clés Supabase et les backups de joueurs ne doivent jamais être envoyés sur GitHub. Le mot de passe d'administration intégré en dur dans l'ancien code doit être considéré comme compromis et remplacé.


## F. Remplacer les fichiers dans GitHub Codespaces et retirer Dropzone

1. Téléverse `mon-portail-jeux123-persistant.zip` dans le dossier racine du Codespace (le dossier où se trouvent déjà `server.js` et `package.json`), puis extrais-le **dans ce dossier**, pas dans un nouveau sous-dossier :

```bash
unzip -o mon-portail-jeux123-persistant.zip -d .
npm install
npm run check
```

2. Le ZIP ne contient volontairement ni `public/dropzone/` ni la base runtime `database.json`. L’extraction ne supprime pas les vieux fichiers absents du ZIP, donc supprime explicitement Dropzone du dépôt :

```bash
git rm -r public/dropzone
```

Si le chemin a déjà disparu, vérifie simplement que `public/dropzone/` n’existe plus. Pour empêcher la base locale de rester suivie par Git tout en gardant sa copie de travail, exécute :

```bash
git rm --cached database.json
```

Si Git indique qu’un de ces chemins n’est pas suivi, n’insiste pas sur cette commande ; vérifie le résultat avec `git status --short`.

3. Configure les variables de l’hébergeur avant de pousser le code. Puis, toujours pendant que l’ancien portail et ses jeux sont accessibles, crée `.env` localement, renseigne les cinq variables listées en section B, et lance `node scripts/migrate-from-live.js`. Le script doit afficher le nombre de jeux et de musiques récupérés. Si les jeux affichés dans l’ancien portail ne correspondent pas aux jeux migrés, **arrête-toi : ne déploie pas encore le nouveau serveur**.

4. Quand la migration est validée, pousse les changements :

```bash
git add -A
git status --short
git commit -m "Fix persistent game storage and transfer keys"
git push
```

Avant le commit, assure-toi que `.env` n’apparaît pas dans la liste. `.gitignore` l’exclut, mais vérifie quand même qu’aucune clé n’est suivie.

5. Après le déploiement, teste `/api/persistence/status`, puis ouvre un jeu depuis un autre navigateur et refais le test après plus de 15 minutes sans visites. Le résultat attendu dans le statut est `mode: supabase`, `persistent: true`, `healthy: true`.
