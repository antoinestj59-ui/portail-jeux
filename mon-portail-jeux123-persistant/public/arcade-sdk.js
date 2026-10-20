window.Arcade = {
  gameId: null,
  sessionStart: Date.now(),
  isFrozen: false,
  _initialized: false,
  _beforeUnloadBound: false,
  _messageBound: false,
  _freezeCheckStarted: false,

  init: function(gameId) {
    const normalizedGameId = String(gameId || '').trim();
    if (!normalizedGameId) return;
    // Certains jeux embarquent déjà l'ancien SDK : l'injection du portail ne doit
    // pas compter deux sessions ni installer plusieurs gestionnaires unload.
    if (this._initialized && this.gameId === normalizedGameId) return;
    this.gameId = normalizedGameId;
    this.sessionStart = Date.now();
    this._initialized = true;

    // Signale le début de la session de jeu
    fetch('/api/telemetry/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameId, action: 'start' })
    }).catch(() => {});

    // Un seul gestionnaire : il lit l'identifiant et le début de session actifs.
    if (!this._beforeUnloadBound) {
      this._beforeUnloadBound = true;
      window.addEventListener('beforeunload', () => {
        if (!this.gameId) return;
        const durationSeconds = Math.max(0, Math.round((Date.now() - this.sessionStart) / 1000));
        const payload = JSON.stringify({ gameId: this.gameId, action: 'end', durationSeconds });
        // sendBeacon peut envoyer du text/plain ; un Blob JSON garde le bon Content-Type.
        const blob = new Blob([payload], { type: 'application/json' });
        const queued = navigator.sendBeacon('/api/telemetry/session', blob);
        if (!queued) {
          fetch('/api/telemetry/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
            keepalive: true
          }).catch(() => {});
        }
      });
    }

    // Bind une fois les listeners globaux du SDK, même si un vieux jeu appelle init deux fois.
    if (!this._freezeCheckStarted) {
      this._freezeCheckStarted = true;
      fetch('/api/player/me').then(r => r.json()).then(data => {
        if (data && data.isFrozen) this.applyFreezeUI(true);
      }).catch(() => {});
    }
    if (!this._messageBound) {
      this._messageBound = true;
      window.addEventListener('message', (e) => {
        if (e.source !== window.parent) return;
        if (e.data && e.data.type === 'ARCADE_FREEZE') this.applyFreezeUI(e.data.frozen);
      });
    }
  },

  // Applique l'écran de givre et bloque toutes les commandes
  applyFreezeUI: function(frozen) {
    this.isFrozen = frozen;
    let overlay = document.getElementById('arcade-freeze-screen');

    if (frozen) {
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'arcade-freeze-screen';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(8,24,48,0.94);backdrop-filter:blur(10px);z-index:999999;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#5ffff6;font-family:sans-serif;text-align:center;padding:20px;';
        overlay.innerHTML = '<div style="font-size:52px">❄️</div><h2 style="margin:10px 0;letter-spacing:1px">SESSION SUSPENDUE</h2><p style="color:#d0eaff;font-size:14px;max-width:320px">Votre partie a été temporairement gelée par l\'administrateur.</p>';
        (document.body || document.documentElement).appendChild(overlay);
      }
      overlay.style.display = 'flex';

      if (!this._blockAllHandler) {
        this._blockAllHandler = (e) => {
          if (!this.isFrozen) return;
          e.stopImmediatePropagation();
          e.preventDefault();
        };
        ['keydown', 'keyup', 'mousedown', 'mouseup', 'click', 'touchstart', 'touchend'].forEach(evt => {
          window.addEventListener(evt, this._blockAllHandler, true);
        });
      }
    } else {
      if (overlay) overlay.style.display = 'none';
      if (this._blockAllHandler) {
        ['keydown', 'keyup', 'mousedown', 'mouseup', 'click', 'touchstart', 'touchend'].forEach(evt => {
          window.removeEventListener(evt, this._blockAllHandler, true);
        });
        this._blockAllHandler = null;
      }
    }
  },

  // Sauvegarder un score numérique (vérifie aussi le défi hebdo)
  saveScore: async function(score) {
    return this.save({ score: Number(score) });
  },

  // Sauvegarder un niveau
  saveLevel: async function(level) {
    return this.save({ level: Number(level) });
  },

  // Sauvegarde personnalisée de données d'un jeu
  save: async function(customData) {
    if (!this.gameId || this.isFrozen) return { success: false };
    try {
      const res = await fetch('/api/progress/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameId: this.gameId, progressData: customData })
      });
      return await res.json();
    } catch (e) {
      return { success: false };
    }
  },

  // Charger la sauvegarde de ce jeu
  load: async function() {
    if (!this.gameId) return null;
    try {
      const res = await fetch('/api/progress/load/' + encodeURIComponent(this.gameId));
      const data = await res.json();
      return data.success ? data.progress : null;
    } catch (e) {
      return null;
    }
  },

  // Déclencher une montée de niveau avec confettis sur le portail
  triggerLevelUp: function(newLevel) {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'ARCADE_LEVEL_UP', level: newLevel }, '*');
    }
  },

  // Remonter automatiquement les erreurs vers l'admin pour débogage
  reportError: function(err) {
    fetch('/api/errors/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: err.message || String(err),
        stack: err.stack || ""
      })
    }).catch(() => {});
  }
};

window.addEventListener('error', (e) => {
  if (window.Arcade) window.Arcade.reportError(e.error || e.message);
});