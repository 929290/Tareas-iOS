// Cuentas y sincronización con Supabase (solo REST, sin librerías).
// La app (app.js) le pasa unas funciones ("hooks") con Sync.init(...).
(() => {
  'use strict';

  const cfg = window.PENDIENTES_CONFIG || {};
  const URL_BASE = String(cfg.supabaseUrl || '').replace(/\/+$/, '');
  const KEY = String(cfg.supabaseKey || '');
  const enabled = /^https?:\/\//.test(URL_BASE) && KEY.length > 20 && !/PEGA_AQUI/.test(URL_BASE + KEY);
  const POLL_MS = cfg.pollMs || 20000;
  const EPOCH = '1970-01-01T00:00:00+00:00';

  const SESSION_KEY = 'pendientes.session.v1';
  const META_KEY = 'pendientes.syncmeta.v1'; // { lastUid, pull: { [uid]: "synced_at más reciente visto" } }

  let hooks = null;
  let session = readJSON(SESSION_KEY);
  let status = 'off';
  let statusDetail = '';
  let running = false;
  let again = false;
  let pollTimer = null;
  let debounceTimer = null;
  let gen = 0; // sube cada vez que se entra o se sale: una sincronización de una sesión anterior se descarta

  function readJSON(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  }
  function writeJSON(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }
  const loadMeta = () => readJSON(META_KEY) || { lastUid: null, pull: {} };
  const saveMeta = m => writeJSON(META_KEY, m);

  function setStatus(s, detail = '') {
    status = s;
    statusDetail = detail;
    if (hooks && hooks.onStatus) hooks.onStatus(s, detail);
  }

  // ---------- Red ----------
  async function request(path, { method = 'GET', body, token, headers = {} } = {}) {
    const h = { apikey: KEY, 'Content-Type': 'application/json', ...headers };
    if (token) h.Authorization = 'Bearer ' + token;
    let res;
    try {
      res = await fetch(URL_BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      const e = new Error('offline');
      e.offline = true;
      throw e;
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok) {
      const e = new Error((json && (json.msg || json.message || json.error_description || json.error)) || res.statusText || 'Error');
      e.status = res.status;
      e.code = json && (json.error_code || json.code);
      throw e;
    }
    return json;
  }

  // ---------- Sesión ----------
  function sessionFrom(j) {
    return {
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000,
      user: { id: j.user.id, email: j.user.email }
    };
  }

  function setSession(s) {
    session = s;
    writeJSON(SESSION_KEY, s);
  }

  async function refreshSession() {
    try {
      const j = await request('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: session.refresh_token } });
      setSession(sessionFrom(j));
    } catch (e) {
      if (!e.offline && e.status >= 400 && e.status < 500) {
        // La sesión ya no vale (revocada o caducada): hay que volver a entrar. Los datos locales se conservan.
        gen++;
        setSession(null);
        stopPolling();
        setStatus('off');
        if (hooks && hooks.onExpired) hooks.onExpired();
      }
      throw e;
    }
  }

  async function accessToken() {
    if (!session) throw new Error('Sin sesión');
    if (Date.now() > session.expires_at - 60000) await refreshSession();
    return session.access_token;
  }

  async function finishLogin(j) {
    const s = sessionFrom(j);
    const meta = loadMeta();
    // Si en este dispositivo había datos de OTRA cuenta, se limpian para no mezclarlos
    if (meta.lastUid && meta.lastUid !== s.user.id && hooks) hooks.clearLocal();
    meta.lastUid = s.user.id;
    saveMeta(meta);
    gen++;
    setSession(s);
    if (hooks) hooks.onLogin();
    startPolling();
    await syncNow();
    return { ok: true };
  }

  async function signUp(email, password) {
    const j = await request('/auth/v1/signup', { method: 'POST', body: { email, password } });
    if (j && j.access_token) return finishLogin(j);
    return { needsConfirm: true };
  }

  async function signIn(email, password) {
    const j = await request('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
    return finishLogin(j);
  }

  async function signOut() {
    const tk = session && session.access_token;
    gen++;
    stopPolling();
    clearTimeout(debounceTimer);
    setSession(null);
    const meta = loadMeta();
    meta.lastUid = null;
    saveMeta(meta);
    if (tk) { try { await request('/auth/v1/logout', { method: 'POST', token: tk }); } catch {} }
    setStatus('off');
    if (hooks) hooks.clearLocal();
  }

  // ---------- Sincronizar ----------
  function overlap(iso) {
    // Se retrocede unos segundos para no perder cambios que se confirmaron "a la vez"; repetirlos no hace daño.
    if (iso === EPOCH) return iso;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? new Date(t - 5000).toISOString() : EPOCH;
  }

  async function syncNow() {
    if (!enabled || !session || !hooks) return;
    if (running) { again = true; return; }
    running = true;
    const myGen = gen;
    setStatus('syncing');
    try {
      const tk = await accessToken();
      const uid = session.user.id;
      const meta = loadMeta();
      meta.pull = meta.pull || {};
      const last = meta.pull[uid] || EPOCH;

      // 1) Bajar lo nuevo
      const PAGE = 500;
      let rows = [];
      for (let offset = 0; ; offset += PAGE) {
        const page = await request(
          `/rest/v1/tasks?select=id,data,updated_at,deleted,synced_at&synced_at=gte.${encodeURIComponent(overlap(last))}` +
          `&order=synced_at.asc,id.asc&limit=${PAGE}&offset=${offset}`, { token: tk });
        rows = rows.concat(page || []);
        if (!page || page.length < PAGE) break;
      }
      const settingsRows = await request('/rest/v1/user_settings?select=categories,updated_at&limit=1', { token: tk });
      if (myGen !== gen) return; // mientras tanto se cerró o cambió la sesión
      hooks.apply(rows, (settingsRows && settingsRows[0]) || null);

      // 2) Subir lo que cambió aquí
      if (myGen !== gen) return;
      const { rows: out, settings } = hooks.collect(uid);
      for (let i = 0; i < out.length; i += 200) {
        await request('/rest/v1/tasks?on_conflict=user_id,id', {
          method: 'POST', token: tk,
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: out.slice(i, i + 200)
        });
      }
      if (settings) {
        await request('/rest/v1/user_settings?on_conflict=user_id', {
          method: 'POST', token: tk,
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: [settings]
        });
      }
      if (myGen !== gen) return;
      hooks.markPushed(out, settings);
      if (out.length || settings) again = true; // una vuelta más para confirmar lo subido y traer lo que haya ganado en el servidor

      let newest = last;
      rows.forEach(r => { if (r.synced_at > newest) newest = r.synced_at; });
      meta.pull[uid] = newest;
      saveMeta(meta);
      setStatus('ok');
    } catch (e) {
      if (e.offline) {
        setStatus('offline');
      } else if (e.status === 401 && session) {
        // El servidor rechazó el token: se pide uno nuevo y se reintenta
        try { await refreshSession(); again = true; } catch (e2) { if (e2.offline) setStatus('offline'); }
      } else if (session) {
        setStatus('error', e.message);
      }
    } finally {
      running = false;
      if (again) { again = false; setTimeout(syncNow, 300); }
    }
  }

  // Pide una sincronización en breve (se llama después de cada cambio local)
  function schedule() {
    if (!enabled || !session) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(syncNow, 1200);
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => { if (!document.hidden) syncNow(); }, POLL_MS);
  }
  function stopPolling() { clearInterval(pollTimer); pollTimer = null; }

  function init(h) {
    hooks = h;
    if (!enabled) return;
    window.addEventListener('focus', syncNow);
    window.addEventListener('online', syncNow);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) syncNow(); });
    if (session) {
      setStatus('syncing');
      startPolling();
      syncNow();
    }
  }

  function friendlyError(e) {
    if (e.offline) return 'No hay conexión a internet.';
    const m = String(e.message || '').toLowerCase();
    if (e.status === 429 || m.includes('rate limit')) return 'Demasiados intentos. Espera unos minutos y vuelve a probar.';
    if (m.includes('invalid login')) return 'Correo o contraseña incorrectos.';
    if (m.includes('already registered') || m.includes('already been registered')) return 'Ya existe una cuenta con ese correo. Prueba a entrar.';
    if (m.includes('not confirmed')) return 'Primero confirma tu correo (te llegó un mensaje).';
    if (m.includes('password')) return 'La contraseña es muy débil o muy corta (mínimo 6 caracteres).';
    if (m.includes('email')) return 'Ese correo no parece válido.';
    return 'No se pudo completar: ' + (e.message || 'error desconocido');
  }

  window.Sync = {
    enabled,
    init, signUp, signIn, signOut, syncNow, schedule, friendlyError,
    user: () => (session ? session.user : null),
    status: () => ({ status, detail: statusDetail })
  };
})();
