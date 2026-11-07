// Preferencias de este dispositivo: tema (sistema / claro / oscuro) y vista (tarjetas / lista).
// Se carga en el <head> para aplicar el tema antes de pintar la página (sin parpadeo).
(() => {
  'use strict';

  const KEY = 'pendientes.prefs.v1';
  const DEFAULTS = { theme: 'dark', layout: 'cards' };
  const THEMES = ['system', 'light', 'dark'];
  const LAYOUTS = ['cards', 'list'];
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  let prefs = { ...DEFAULTS };

  function read() {
    prefs = { ...DEFAULTS };
    try {
      const p = JSON.parse(localStorage.getItem(KEY)) || {};
      if (THEMES.includes(p.theme)) prefs.theme = p.theme;
      if (LAYOUTS.includes(p.layout)) prefs.layout = p.layout;
    } catch {}
  }

  function apply() {
    const root = document.documentElement;
    const theme = prefs.theme === 'system' ? (mq.matches ? 'light' : 'dark') : prefs.theme;
    root.dataset.theme = theme;
    root.dataset.layout = prefs.layout;
    statusBar(theme);
  }

  // En el teléfono, la barra de estado (hora, batería) cambia de color con el tema
  function statusBar(theme) {
    try {
      const C = window.Capacitor;
      if (!C || !C.isNativePlatform || !C.isNativePlatform()) return;
      const bg = theme === 'light' ? '#f4f5f8' : '#0e1014';
      const call = (method, opts) => {
        const p = C.Plugins && C.Plugins.StatusBar;
        if (p && typeof p[method] === 'function') return p[method](opts);
        if (typeof C.nativePromise === 'function') return C.nativePromise('StatusBar', method, opts);
      };
      // 'LIGHT' = letras oscuras (para fondo claro); 'DARK' = letras claras
      Promise.resolve(call('setStyle', { style: theme === 'light' ? 'LIGHT' : 'DARK' })).catch(() => {});
      if (C.getPlatform && C.getPlatform() === 'android') Promise.resolve(call('setBackgroundColor', { color: bg })).catch(() => {});
    } catch {}
  }

  read();
  apply();
  mq.addEventListener('change', () => { if (prefs.theme === 'system') apply(); });
  // Si otra ventana (por ejemplo la captura rápida) cambia las preferencias, se aplican aquí también
  window.addEventListener('storage', e => { if (e.key === KEY) { read(); apply(); } });

  window.Prefs = {
    get: () => ({ ...prefs }),
    set(p) {
      if (THEMES.includes(p.theme)) prefs.theme = p.theme;
      if (LAYOUTS.includes(p.layout)) prefs.layout = p.layout;
      try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch {}
      apply();
    },
    reload() { read(); apply(); }
  };
})();
