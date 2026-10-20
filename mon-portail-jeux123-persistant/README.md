# Portail Arcade — version avec stockage persistant

## Développement

- Node.js 20 ou supérieur
- En local : copie `.env.example` vers `.env`, garde `PERSISTENCE_MODE=local`, puis lance `npm install` et `npm start`.
- Sans `PERSISTENCE_MODE=local`, le serveur choisit Supabase par défaut et refuse de démarrer si la configuration persistante manque. Il ne bascule donc pas silencieusement vers un disque local éphémère.

## Production

Configurer `PERSISTENCE_MODE=supabase`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_STORAGE_BUCKET=portal-assets` et `ADMIN_PASSWORD` dans les variables d'environnement de l'hébergeur. Créer la table `portal_state` et le bucket privé `portal-assets` selon `SUPABASE_SETUP.md`. Ne jamais committer `.env` ni les clés.

## Import des jeux et sauvegardes

Les jeux HTML importés sont placés dans le stockage persistant en mode Supabase. Le serveur injecte le SDK `/arcade-sdk.js` et appelle `Arcade.init(<id-du-jeu>)`. Dans le code du jeu, utilisez `await Arcade.save({ score, level })` quand la progression doit être enregistrée, puis `await Arcade.load()` au lancement pour la restaurer. Le SDK ne peut pas deviner les variables internes de tous les jeux, donc l'appel à `save` doit être déclenché par le jeu au bon moment.

## Migration des données déjà en ligne

Suivre `SUPABASE_SETUP.md` et exécuter `node scripts/migrate-from-live.js` avant de remplacer l'ancien serveur. Le script nécessite les secrets dans un `.env` local qui ne doit jamais être envoyé sur GitHub.

## Commandes de sauvegarde dans un jeu importé

Le serveur place automatiquement dans le début du `<head>` le SDK et `Arcade.init('ID_DU_JEU')`. Ajoutez les appels à `Arcade.save(...)` et `Arcade.load()` là où le jeu connaît son état :

```js
// Au chargement, après l'initialisation du SDK :
(async function restoreGameProgress() {
  const saved = await Arcade.load();
  if (saved) {
    score = Number(saved.score || 0);
    level = Number(saved.level || 1);
    // Actualise ici l'interface du jeu à partir de score et level.
  }
})();

// À appeler depuis un événement async lorsque le score/niveau change :
await Arcade.save({ score, level });
```

Ce code est un exemple à adapter aux noms des variables de chaque jeu. L'injection prépare la connexion de sauvegarde, mais ne peut pas deviner toutes les variables propres à un jeu.
