(() => {
  'use strict';

  const STORAGE_KEY = 'pendientes.v1';

  // Categorías por defecto (luego se editan desde la app con el icono junto a "Categorías")
  const CATS_KEY = 'pendientes.cats.v1';
  const DEFAULT_CATEGORIES = [
    { id: 'personal', name: 'Personal', color: '#a78bfa' },
    { id: 'trabajo',  name: 'Trabajo',  color: '#60a5fa' },
    { id: 'urgente',  name: 'Urgente',  color: '#fb7185' },
    { id: 'estudio',  name: 'Estudio',  color: '#34d399' }
  ];
  const PALETTE = ['#a78bfa', '#60a5fa', '#fb7185', '#34d399', '#fbbf24', '#f472b6', '#22d3ee', '#fb923c'];

  function loadCats() {
    try {
      const c = JSON.parse(localStorage.getItem(CATS_KEY));
      if (Array.isArray(c) && c.length) return c;
    } catch {}
    return DEFAULT_CATEGORIES.map(c => ({ ...c }));
  }
  function persistCats() {
    try { localStorage.setItem(CATS_KEY, JSON.stringify(categories)); } catch {}
  }
  function saveCats() {
    syncState.catsAt = Date.now();
    syncState.catsDirty = true;
    saveSyncState();
    persistCats();
    if (window.Sync) Sync.schedule();
  }

  let categories = loadCats();
  const catById = id => categories.find(c => c.id === id) || categories[0];

  // ---------- Estado ----------
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function seed() {
    return [{
      id: 'seed-welcome',
      title: 'Bienvenido 👋',
      desc: 'Crea tu primera tarea con el botón "Nueva tarea". Pasa el cursor sobre una tarjeta para editarla o eliminarla, y haz clic en el círculo para completarla.',
      category: 'personal',
      due: '',
      done: false,
      createdAt: Date.now()
    }];
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : seed();
    } catch {
      return seed();
    }
  }

  function save() {
    trackChanges();
    persist();
    if (window.Sync) Sync.schedule();
  }

  // Completa los campos que no tenían las tareas guardadas con versiones anteriores.
  // completions: momentos (ms) en que se completó la tarea → historial y resumen.
  // archived: tarea eliminada que se conserva oculta solo para no perder su historial.
  function normalize(t) {
    if (!Array.isArray(t.subtasks)) t.subtasks = [];
    if (t.repeat === undefined) { t.repeat = null; t.doneOn = ''; t.reopenOn = ''; }
    if (!Array.isArray(t.completions)) t.completions = t.done ? [t.updatedAt || t.createdAt || Date.now()] : [];
    return t;
  }

  let tasks = load();
  tasks.forEach(normalize);
  const live = () => tasks.filter(t => !t.archived); // las que se ven en la app
  const expanded = new Set(); // tarjetas con las subtareas desplegadas (solo mientras la app está abierta)
  let view = { category: 'all', status: 'all', query: '' };
  let editingId = null;
  let selectedCat = categories[0].id;
  let repType = 'none';   // none | daily | weekly | monthly
  let repDays = [];       // días de la semana elegidos (0 = domingo)
  let repMonthDay = 1;    // día del mes
  let reorderTimer = null;
  let toastTimer = null;
  let toastKind = null;   // qué está mostrando el aviso inferior ('delete' = tareas borradas)
  let undoBatch = [];     // tareas borradas mientras el aviso sigue visible (se deshacen todas juntas)

  // ---------- Sincronización: seguimiento de cambios ----------
  const SYNC_STATE_KEY = 'pendientes.sync.v1';
  const SEED_ID = 'seed-welcome';
  const SEED_TITLE = 'Bienvenido 👋';

  function loadSyncState() {
    try {
      const st = JSON.parse(localStorage.getItem(SYNC_STATE_KEY));
      if (st) return { dirty: st.dirty || {}, tombs: st.tombs || {}, catsDirty: !!st.catsDirty, catsAt: st.catsAt || 0 };
    } catch {}
    return { dirty: {}, tombs: {}, catsDirty: false, catsAt: 0 };
  }
  // dirty: tareas con cambios por subir · tombs: tareas borradas (id -> momento) · catsAt/catsDirty: lo mismo para las categorías
  let syncState = loadSyncState();
  function saveSyncState() {
    try { localStorage.setItem(SYNC_STATE_KEY, JSON.stringify(syncState)); } catch {}
  }

  const strip = t => { const { updatedAt, ...rest } = t; return JSON.stringify(rest); };
  const snap = new Map(); // id -> contenido de la tarea la última vez que se anotó
  tasks.forEach(t => { if (!t.updatedAt) t.updatedAt = t.createdAt || 1; snap.set(t.id, strip(t)); });

  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks)); } catch {}
  }

  // Compara con lo anterior para saber qué tareas cambiaron o se borraron
  function trackChanges() {
    const now = Date.now();
    const seen = new Set();
    tasks.forEach(t => {
      seen.add(t.id);
      const j = strip(t);
      if (snap.get(t.id) !== j) {
        t.updatedAt = now;
        snap.set(t.id, j);
        syncState.dirty[t.id] = true;
        delete syncState.tombs[t.id];
      }
    });
    snap.forEach((_, id) => {
      if (!seen.has(id)) {
        snap.delete(id);
        syncState.tombs[id] = now;
        syncState.dirty[id] = true;
      }
    });
    saveSyncState();
  }

  function pendingCount() {
    return Object.keys(syncState.dirty).length + (syncState.catsDirty ? 1 : 0);
  }

  // Lo que hay que subir al servidor
  function collectPush(uid) {
    const rows = [];
    Object.keys(syncState.dirty).forEach(id => {
      const t = tasks.find(x => x.id === id);
      if (t) {
        const { updatedAt, ...data } = t;
        rows.push({ user_id: uid, id, data, updated_at: updatedAt, deleted: false });
      } else if (syncState.tombs[id]) {
        rows.push({ user_id: uid, id, data: {}, updated_at: syncState.tombs[id], deleted: true });
      } else {
        delete syncState.dirty[id];
      }
    });
    const settings = syncState.catsDirty ? { user_id: uid, categories, updated_at: syncState.catsAt } : null;
    return { rows, settings };
  }

  // Lo subido deja de estar pendiente (salvo que haya vuelto a cambiar mientras tanto)
  function markPushed(rows, settings) {
    rows.forEach(r => {
      const t = tasks.find(x => x.id === r.id);
      const same = t ? t.updatedAt === r.updated_at : syncState.tombs[r.id] === r.updated_at;
      if (same) {
        delete syncState.dirty[r.id];
        if (r.deleted) delete syncState.tombs[r.id];
      }
    });
    if (settings && syncState.catsAt === settings.updated_at) syncState.catsDirty = false;
    saveSyncState();
  }

  // Mezcla lo que llegó del servidor: para cada tarea gana la versión más reciente
  function applyRemote(rows, settingsRow) {
    let changed = false;
    for (const r of rows) {
      const i = tasks.findIndex(t => t.id === r.id);
      const local = i >= 0 ? tasks[i] : null;
      const localTs = local ? (local.updatedAt || 0) : (syncState.tombs[r.id] || 0);
      if (localTs > r.updated_at) continue; // lo de este dispositivo es más nuevo: se queda y se sube
      if (local && !r.deleted && localTs === r.updated_at) { delete syncState.dirty[r.id]; continue; } // ya es igual
      if (r.deleted) {
        if (local) { tasks.splice(i, 1); snap.delete(r.id); changed = true; }
        delete syncState.tombs[r.id];
        delete syncState.dirty[r.id];
      } else {
        const t = normalize({ ...r.data, id: r.id, updatedAt: r.updated_at });
        if (local) tasks[i] = t; else tasks.push(t);
        snap.set(t.id, strip(t));
        delete syncState.dirty[t.id];
        delete syncState.tombs[t.id];
        changed = true;
      }
    }
    if (settingsRow && Array.isArray(settingsRow.categories) && settingsRow.categories.length) {
      if (settingsRow.updated_at > syncState.catsAt) {
        categories = settingsRow.categories;
        syncState.catsAt = settingsRow.updated_at;
        syncState.catsDirty = false;
        persistCats();
        changed = true;
      } else if (settingsRow.updated_at === syncState.catsAt) {
        syncState.catsDirty = false;
      }
    }
    if (changed) {
      if (view.category !== 'all' && !categories.some(c => c.id === view.category)) view.category = 'all';
      if (refreshRecurring()) save();
      persist();
      saveSyncState();
      render();
      if (!$('#catModal').classList.contains('hidden')) renderCatList();
    } else {
      saveSyncState();
    }
    return changed;
  }

  // Al iniciar sesión: todo lo que hay en este dispositivo se ofrece a la cuenta
  // (el servidor se queda siempre con la versión más reciente de cada tarea)
  function markAllDirty() {
    tasks.forEach(t => { syncState.dirty[t.id] = true; });
    Object.keys(syncState.tombs).forEach(id => { syncState.dirty[id] = true; });
    if (syncState.catsAt > 0) syncState.catsDirty = true;
    saveSyncState();
  }

  // La tarea de bienvenida sin tocar no se sube (así no aparece repetida en cada dispositivo)
  function dropPristineSeed() {
    const i = tasks.findIndex(t => t.id === SEED_ID && !t.done && !t.subtasks.length && t.title === SEED_TITLE);
    if (i >= 0) { snap.delete(SEED_ID); tasks.splice(i, 1); }
  }

  // Al cerrar sesión: se vacía este dispositivo (los datos siguen en la cuenta)
  function clearLocal() {
    tasks = [];
    snap.clear();
    syncState = { dirty: {}, tombs: {}, catsDirty: false, catsAt: 0 };
    categories = DEFAULT_CATEGORIES.map(c => ({ ...c }));
    expanded.clear();
    view = { category: 'all', status: 'all', query: '' };
    document.querySelectorAll('#statusTabs .tab').forEach(t => t.classList.toggle('active', t.dataset.status === 'all'));
    $('#searchInput').value = '';
    persist();
    persistCats();
    saveSyncState();
    render();
  }

  // ---------- Utilidades ----------
  const $ = sel => document.querySelector(sel);
  const grid = $('#grid');
  const nav = $('#categoryNav');
  const modal = $('#modal');

  const esc = s => String(s).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
  // Los colores van dentro de atributos "style": solo se aceptan colores #hex
  const safeColor = c => (/^#[0-9a-f]{3,8}$/i.test(String(c)) ? c : '#8b90a0');

  function parseDate(str) {
    const [y, m, d] = str.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function startOfToday() {
    const t = new Date();
    return new Date(t.getFullYear(), t.getMonth(), t.getDate());
  }

  // ---------- Fechas y repetición ----------
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayStr = () => ymd(new Date());
  const addDays = (str, n) => { const d = parseDate(str); d.setDate(d.getDate() + n); return ymd(d); };
  const lastDayOf = (y, m) => new Date(y, m + 1, 0).getDate();
  const DAY_SHORT = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

  // Primera fecha ESTRICTAMENTE posterior a "from" en la que le toca volver a la tarea
  function nextOccurrence(rep, from) {
    if (rep.type === 'weekly' && rep.days && rep.days.length) {
      for (let i = 1; i <= 7; i++) {
        const cand = addDays(from, i);
        if (rep.days.includes(parseDate(cand).getDay())) return cand;
      }
    }
    if (rep.type === 'monthly') {
      const f = parseDate(from);
      const y = f.getFullYear(), m = f.getMonth();
      const thisMonth = ymd(new Date(y, m, Math.min(rep.day, lastDayOf(y, m))));
      if (thisMonth > from) return thisMonth;
      const ny = m === 11 ? y + 1 : y, nm = (m + 1) % 12;
      return ymd(new Date(ny, nm, Math.min(rep.day, lastDayOf(ny, nm))));
    }
    return addDays(from, 1); // diaria (y respaldo)
  }

  function repeatLabel(r) {
    if (r.type === 'daily') return 'Cada día';
    if (r.type === 'monthly') return `Día ${r.day} de cada mes`;
    const d = [...r.days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)); // lunes primero
    if (d.length === 7) return 'Cada día';
    if (d.length === 5 && !d.includes(0) && !d.includes(6)) return 'Lun a Vie';
    return d.map(x => DAY_SHORT[x]).join(' · ');
  }

  // Marca una tarea como hecha / pendiente y, si es recurrente, calcula cuándo vuelve
  function applyDone(t, done) {
    // Historial: se anota al completarla; si se desmarca, se quita la última anotación
    if (done && !t.done) t.completions.push(Date.now());
    if (!done && t.done) t.completions.pop();
    t.done = done;
    if (t.repeat && done) {
      t.doneOn = todayStr();
      t.reopenOn = nextOccurrence(t.repeat, t.doneOn);
    } else {
      t.doneOn = '';
      t.reopenOn = '';
    }
  }

  // Reabre las recurrentes cuya próxima fecha ya llegó. Devuelve true si cambió algo.
  function refreshRecurring() {
    const today = todayStr();
    let changed = false;
    tasks.forEach(t => {
      if (!t.archived && t.repeat && t.done && t.reopenOn && t.reopenOn <= today) {
        t.done = false;
        t.doneOn = '';
        t.reopenOn = '';
        t.subtasks.forEach(s => { s.done = false; });
        changed = true;
      }
    });
    return changed;
  }

  // ---------- Racha de las tareas que se repiten ----------
  // Cada vez que a la tarea "le toca" empieza un turno, que dura hasta la siguiente vez.
  // El turno cuenta si se completó dentro de él. La racha = turnos seguidos cumplidos.
  // El turno actual, si aún no está hecho, no rompe la racha: todavía hay tiempo.
  function isOccurrence(rep, day) {
    const d = parseDate(day);
    if (rep.type === 'weekly' && rep.days && rep.days.length) return rep.days.includes(d.getDay());
    if (rep.type === 'monthly') return d.getDate() === Math.min(rep.day, lastDayOf(d.getFullYear(), d.getMonth()));
    return true;
  }

  // Última fecha ESTRICTAMENTE anterior a "from" en la que le tocaba la tarea
  function prevOccurrence(rep, from) {
    if (rep.type === 'weekly' && rep.days && rep.days.length) {
      for (let i = 1; i <= 7; i++) {
        const cand = addDays(from, -i);
        if (rep.days.includes(parseDate(cand).getDay())) return cand;
      }
    }
    if (rep.type === 'monthly') {
      const f = parseDate(from);
      const y = f.getFullYear(), m = f.getMonth();
      const thisMonth = ymd(new Date(y, m, Math.min(rep.day, lastDayOf(y, m))));
      if (thisMonth < from) return thisMonth;
      const py = m === 0 ? y - 1 : y, pm = (m + 11) % 12;
      return ymd(new Date(py, pm, Math.min(rep.day, lastDayOf(py, pm))));
    }
    return addDays(from, -1);
  }

  function taskStreak(t) {
    const none = { current: 0, best: 0, todayDone: false };
    if (!t.repeat || !t.completions || !t.completions.length) return none;
    const days = [...new Set(t.completions.map(ts => ymd(new Date(ts))))].sort();
    const today = todayStr();
    let start = isOccurrence(t.repeat, today) ? today : prevOccurrence(t.repeat, today);
    let end = nextOccurrence(t.repeat, start);
    let j = days.length - 1;
    while (j >= 0 && days[j] >= end) j--; // completadas "en el futuro" (relojes desajustados)
    let run = 0, best = 0, current = null, todayDone = false;
    for (let n = 0; n < 4000 && j >= 0; n++) {
      const hit = days[j] >= start;
      while (j >= 0 && days[j] >= start) j--;
      if (n === 0) todayDone = hit;
      if (hit) run++;
      else if (n > 0) {
        if (current === null) current = run;
        best = Math.max(best, run);
        run = 0;
      }
      end = start;
      start = prevOccurrence(t.repeat, start);
    }
    if (current === null) current = run;
    best = Math.max(best, run);
    return { current, best, todayDone };
  }

  function streakUnit(rep, n) {
    if (rep.type === 'daily' || (rep.type === 'weekly' && rep.days && rep.days.length === 7)) return n === 1 ? 'día' : 'días';
    if (rep.type === 'monthly') return n === 1 ? 'mes' : 'meses';
    return n === 1 ? 'vez' : 'veces';
  }

  const ICON_FLAME = '<svg viewBox="0 0 24 24"><path d="M12 22c4 0 7-2.7 7-6.6 0-3.1-1.9-5.6-3.6-7.4-.4 1.7-1.3 2.9-2.4 3.4C13.4 7.6 11.6 4.4 8.6 2c.3 3.3-1.3 5.4-2.6 7.2C4.9 10.8 5 12.2 5 15.4 5 19.3 8 22 12 22z"/></svg>';

  function streakHTML(t) {
    const s = taskStreak(t);
    if (!s.current) return '';
    const unit = streakUnit(t.repeat, s.current);
    const tip = [`Racha: ${s.current} ${unit} seguid${unit === 'vez' || unit === 'veces' ? 'as' : 'os'}`];
    if (s.best > s.current) tip.push(`Mejor racha: ${s.best}`);
    if (!s.todayDone) tip.push('Complétala para sumar una más');
    return `<span class="streak ${s.todayDone ? '' : 'waiting'}" title="${esc(tip.join(' · '))}">${ICON_FLAME}${s.current} ${unit}</span>`;
  }
  const ICON_REP = '<svg viewBox="0 0 24 24"><path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 014-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 01-4 4H3"/></svg>';
  const ICON_CAL = '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>';
  const ICON_EDIT = '<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg>';
  const ICON_TRASH = '<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/></svg>';
  const ICON_CHECK = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  const ICON_X = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  // ---------- Subtareas ----------
  const subsDone = t => t.subtasks.filter(s => s.done).length;
  const subsPct = t => (t.subtasks.length ? Math.round((subsDone(t) / t.subtasks.length) * 100) : 0);

  function subLabel(t, open) {
    if (open) return 'Ver menos';
    return t.subtasks.length ? `Ver más · ${subsDone(t)}/${t.subtasks.length}` : '+ Subtareas';
  }

  function subsInner(t) {
    const rows = t.subtasks.map(s => `<div class="sub ${s.done ? 'done' : ''}" data-sid="${s.id}">
        <button class="sub-check" data-act="sub-toggle" aria-label="Completar subtarea">${ICON_CHECK}</button>
        <span class="sub-text">${esc(s.text)}</span>
        <button class="sub-del" data-act="sub-del" title="Quitar" aria-label="Quitar subtarea">${ICON_X}</button>
      </div>`).join('');
    return `<div class="sub-list">${rows}</div>
      <div class="sub-add">
        <input class="sub-input" type="text" maxlength="120" placeholder="Añadir subtarea y pulsar Enter" autocomplete="off" />
      </div>`;
  }

  // Actualiza la tarjeta sin volver a dibujarla (así se conservan las animaciones)
  function refreshSubUI(card, t) {
    card.classList.toggle('done', t.done);
    card.querySelectorAll('.sub').forEach(el => {
      const s = t.subtasks.find(x => x.id === el.dataset.sid);
      if (s) el.classList.toggle('done', s.done);
    });
    const bar = card.querySelector('.sub-progress');
    bar.classList.toggle('hidden', !t.subtasks.length);
    bar.firstElementChild.style.width = subsPct(t) + '%';
    card.querySelector('.sub-toggle').textContent = subLabel(t, card.classList.contains('expanded'));
  }

  function afterChange() {
    save();
    renderNav();
    renderProgress();
    renderHeader();
  }

  // Reordena (completadas al final) cuando termina la animación; espera si estás escribiendo una subtarea
  function scheduleReorder() {
    clearTimeout(reorderTimer);
    const run = () => {
      const a = document.activeElement;
      if (a && a.classList && a.classList.contains('sub-input')) { reorderTimer = setTimeout(run, 1200); return; }
      render();
    };
    reorderTimer = setTimeout(run, 750);
  }

  // ---------- Render ----------
  function visibleTasks() {
    const q = view.query.trim().toLowerCase();
    return live()
      .filter(t => view.category === 'all' || t.category === view.category)
      .filter(t => view.status === 'all' || (view.status === 'pending' ? !t.done : t.done))
      .filter(t => !q || (t.title + ' ' + t.desc + ' ' + t.subtasks.map(s => s.text).join(' ')).toLowerCase().includes(q))
      .sort((a, b) => (a.done - b.done) || (b.createdAt - a.createdAt));
  }

  function renderNav() {
    const items = [{ id: 'all', name: 'Todas', color: '#8b90a0' }, ...categories];
    nav.innerHTML = items.map(c => {
      const n = live().filter(t => !t.done && (c.id === 'all' || t.category === c.id)).length;
      return `<button class="nav-item ${view.category === c.id ? 'active' : ''}" data-cat="${esc(c.id)}">
        <span class="dot" style="background:${safeColor(c.color)}"></span>
        <span>${esc(c.name)}</span>
        <span class="count">${n}</span>
      </button>`;
    }).join('');
  }

  function renderProgress() {
    const shown = live();
    const total = shown.length;
    const done = shown.filter(t => t.done).length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    $('#progressPct').textContent = pct + '%';
    $('#progressBar').style.width = pct + '%';
    $('#progressText').textContent = total
      ? `${done} de ${total} completadas`
      : 'Aún no hay tareas';
  }

  function renderHeader() {
    const cat = view.category === 'all' ? null : catById(view.category);
    $('#viewTitle').textContent = cat ? cat.name : 'Todas las tareas';
    const pending = live().filter(t => !t.done && (!cat || t.category === cat.id)).length;
    const today = new Date().toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' });
    $('#viewSub').innerHTML = `${today} · <span>${pending} pendiente${pending === 1 ? '' : 's'}</span>`;
  }

  function cardHTML(t, i, animate) {
    const cat = catById(t.category);
    let due = '';
    if (t.due) {
      const d = parseDate(t.due);
      const late = !t.done && d < startOfToday();
      const label = d.toLocaleDateString('es', { day: 'numeric', month: 'short' });
      due = `<span class="due ${late ? 'late' : ''}">${ICON_CAL}${label}</span>`;
    }
    let rep = '';
    if (t.repeat) {
      rep = `<span class="rep">${ICON_REP}${repeatLabel(t.repeat)}</span>`;
      rep += streakHTML(t);
      if (t.done && t.reopenOn) {
        const back = t.reopenOn === addDays(todayStr(), 1)
          ? 'mañana'
          : parseDate(t.reopenOn).toLocaleDateString('es', { weekday: 'short', day: 'numeric', month: 'short' });
        due = `<span class="due">${ICON_CAL}Vuelve ${back}</span>`;
      }
    }
    const open = expanded.has(t.id);
    return `<article class="card ${t.done ? 'done' : ''} ${open ? 'expanded' : ''} ${animate ? 'enter' : ''}" data-id="${esc(t.id)}" style="--c:${safeColor(cat.color)};--d:${Math.min(i, 12) * 35}ms">
      <div class="card-top">
        <button class="check" data-act="toggle" aria-label="Marcar como completada">${ICON_CHECK}</button>
        <h3 class="title"><span>${esc(t.title)}</span></h3>
        <div class="card-actions">
          <button data-act="edit" title="Editar">${ICON_EDIT}</button>
          <button data-act="delete" title="Eliminar">${ICON_TRASH}</button>
        </div>
      </div>
      ${t.desc ? `<p class="desc">${esc(t.desc)}</p>` : ''}
      <div class="sub-progress ${t.subtasks.length ? '' : 'hidden'}"><i style="width:${subsPct(t)}%"></i></div>
      <div class="card-foot">
        <span class="tag"><i></i>${esc(cat.name)}</span>
        ${due}
        ${rep}
        <button class="sub-toggle" data-act="subs">${subLabel(t, open)}</button>
      </div>
      <div class="subs"><div class="subs-inner">${subsInner(t)}</div></div>
    </article>`;
  }

  function render(animate = false) {
    const list = visibleTasks();
    grid.innerHTML = list.map((t, i) => cardHTML(t, i, animate)).join('');
    $('#empty').classList.toggle('hidden', list.length > 0);
    renderNav();
    renderProgress();
    renderHeader();
  }

  // ---------- Modal ----------
  function renderChips() {
    $('#fCats').innerHTML = categories.map(c =>
      `<button type="button" class="chip ${c.id === selectedCat ? 'active' : ''}" data-cat="${esc(c.id)}" style="--c:${safeColor(c.color)}"><i></i>${esc(c.name)}</button>`
    ).join('');
  }

  function renderRepeat() {
    document.querySelectorAll('#fRepeat .chip').forEach(c => c.classList.toggle('active', c.dataset.rep === repType));
    document.querySelectorAll('#fDays .chip').forEach(c => c.classList.toggle('active', repDays.includes(Number(c.dataset.day))));
    $('#fDays').classList.toggle('hidden', repType !== 'weekly');
    $('#fMonthRow').classList.toggle('hidden', repType !== 'monthly');
    $('#fDueWrap').classList.toggle('hidden', repType !== 'none'); // las recurrentes no usan fecha límite
    $('#fMonthDay').value = repMonthDay;
  }

  function openModal(id = null) {
    editingId = id;
    const t = id ? tasks.find(x => x.id === id) : null;
    $('#modalTitle').textContent = t ? 'Editar tarea' : 'Nueva tarea';
    $('#fTitle').value = t ? t.title : '';
    $('#fDesc').value = t ? t.desc : '';
    $('#fDue').value = t ? t.due : '';
    selectedCat = t ? t.category : (view.category !== 'all' ? view.category : categories[0].id);
    renderChips();
    const r = t && t.repeat;
    const now = new Date();
    repType = r ? r.type : 'none';
    repDays = r && r.type === 'weekly' ? [...r.days] : [now.getDay()];
    repMonthDay = r && r.type === 'monthly' ? r.day : now.getDate();
    renderRepeat();
    modal.classList.remove('hidden');
    setTimeout(() => $('#fTitle').focus(), 30);
  }

  function closeModal() {
    modal.classList.add('hidden');
    editingId = null;
  }

  // ---------- Toast ----------
  function showToast(msg, onUndo, label = 'Deshacer', kind = null) {
    $('#toastMsg').textContent = msg;
    const btn = $('#toastBtn');
    btn.textContent = label;
    btn.classList.toggle('hidden', !onUndo);
    btn.onclick = onUndo ? () => { onUndo(); hideToast(); } : null;
    toastKind = kind;
    $('#toast').classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 5000);
  }
  function hideToast() {
    $('#toast').classList.add('hidden');
    toastKind = null;
    undoBatch = [];
  }

  // Borrar una tarea. Si alguna vez se completó, se guarda oculta para que su historial siga en el resumen.
  function deleteTask(task) {
    if (task.completions.length) task.archived = true;
    else tasks = tasks.filter(t => t.id !== task.id);
    expanded.delete(task.id);
    if (toastKind !== 'delete') undoBatch = [];
    undoBatch.push(task);
    save();
    render();
    const n = undoBatch.length;
    showToast(n === 1 ? 'Tarea eliminada' : `${n} tareas eliminadas`, () => {
      undoBatch.forEach(t => {
        const cur = tasks.find(x => x.id === t.id);
        if (cur) delete cur.archived;               // estaba oculta: vuelve a verse
        else { delete t.archived; tasks.push(t); }  // se había quitado: se recupera
      });
      save();
      render(true);
    }, 'Deshacer', 'delete');
  }

  // ---------- Eventos ----------
  $('#addBtn').addEventListener('click', () => openModal());
  $('#cancelBtn').addEventListener('click', closeModal);
  modal.addEventListener('mousedown', e => { if (e.target === modal) closeModal(); });

  $('#fCats').addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    selectedCat = chip.dataset.cat;
    renderChips();
  });

  $('#fRepeat').addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    repType = chip.dataset.rep;
    renderRepeat();
  });

  $('#fDays').addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const d = Number(chip.dataset.day);
    repDays = repDays.includes(d) ? repDays.filter(x => x !== d) : [...repDays, d];
    renderRepeat();
  });

  $('#fMonthDay').addEventListener('input', e => {
    repMonthDay = Math.min(31, Math.max(1, parseInt(e.target.value, 10) || 1));
  });

  $('#taskForm').addEventListener('submit', e => {
    e.preventDefault();
    const title = $('#fTitle').value.trim();
    if (!title) return;
    let repeat = null;
    if (repType === 'daily') repeat = { type: 'daily' };
    if (repType === 'weekly') {
      const days = repDays.length ? repDays : [new Date().getDay()];
      repeat = { type: 'weekly', days: [...days].sort((a, b) => a - b) };
    }
    if (repType === 'monthly') repeat = { type: 'monthly', day: repMonthDay };

    const data = {
      title,
      desc: $('#fDesc').value.trim(),
      category: selectedCat,
      due: repeat ? '' : $('#fDue').value,
      repeat
    };
    let task;
    if (editingId && tasks.some(t => t.id === editingId)) {
      task = tasks.find(t => t.id === editingId);
      Object.assign(task, data);
    } else {
      task = { id: uid(), done: false, createdAt: Date.now(), subtasks: [], completions: [], doneOn: '', reopenOn: '', ...data };
      tasks.push(task);
    }
    // Si cambió la regla de una tarea ya completada, se recalcula cuándo vuelve
    if (!task.repeat || !task.done) {
      task.doneOn = '';
      task.reopenOn = '';
    } else {
      task.doneOn = task.doneOn || todayStr();
      task.reopenOn = nextOccurrence(task.repeat, task.doneOn);
    }
    save();
    closeModal();
    render(true);
  });

  nav.addEventListener('click', e => {
    const btn = e.target.closest('.nav-item');
    if (!btn) return;
    view.category = btn.dataset.cat;
    render(true);
  });

  $('#statusTabs').addEventListener('click', e => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    view.status = tab.dataset.status;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
    render(true);
  });

  $('#searchInput').addEventListener('input', e => {
    view.query = e.target.value;
    render();
  });

  grid.addEventListener('click', e => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const card = btn.closest('.card');
    const id = card.dataset.id;
    const task = tasks.find(t => t.id === id);

    if (btn.dataset.act === 'toggle') {
      applyDone(task, !task.done);
      task.subtasks.forEach(s => { s.done = task.done; }); // la tarea principal arrastra a sus subtareas
      refreshSubUI(card, task);
      afterChange();
      scheduleReorder();
    }

    if (btn.dataset.act === 'subs') {
      const open = card.classList.toggle('expanded');
      if (open) expanded.add(id); else expanded.delete(id);
      btn.textContent = subLabel(task, open);
      if (open && !task.subtasks.length) card.querySelector('.sub-input').focus();
    }

    if (btn.dataset.act === 'sub-toggle') {
      const s = task.subtasks.find(x => x.id === btn.closest('.sub').dataset.sid);
      const was = task.done;
      s.done = !s.done;
      applyDone(task, task.subtasks.every(x => x.done)); // al completar la última, se completa la tarea
      refreshSubUI(card, task);
      afterChange();
      if (was !== task.done) scheduleReorder();
    }

    if (btn.dataset.act === 'sub-del') {
      const was = task.done;
      task.subtasks = task.subtasks.filter(x => x.id !== btn.closest('.sub').dataset.sid);
      if (task.subtasks.length) applyDone(task, task.subtasks.every(x => x.done));
      card.querySelector('.subs-inner').innerHTML = subsInner(task);
      refreshSubUI(card, task);
      afterChange();
      if (was !== task.done) scheduleReorder();
    }

    if (btn.dataset.act === 'edit') openModal(id);

    if (btn.dataset.act === 'delete') {
      card.classList.add('removing');
      setTimeout(() => deleteTask(task), 220);
    }
  });

  // Añadir subtarea con Enter
  grid.addEventListener('keydown', e => {
    if (!e.target.classList.contains('sub-input')) return;
    if (e.key === 'Escape') { e.target.blur(); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const text = e.target.value.trim();
    if (!text) return;
    const card = e.target.closest('.card');
    const task = tasks.find(t => t.id === card.dataset.id);
    const was = task.done;
    task.subtasks.push({ id: uid(), text, done: false });
    applyDone(task, false); // una subtarea nueva reabre la tarea si estaba completada
    card.querySelector('.subs-inner').innerHTML = subsInner(task);
    refreshSubUI(card, task);
    afterChange();
    if (was) scheduleReorder();
    card.querySelector('.sub-input').focus();
  });

  // ---------- Gestionar categorías ----------
  const catModal = $('#catModal');
  const catList = $('#catList');

  function renderCatList() {
    catList.innerHTML = categories.map(c => {
      const n = live().filter(t => t.category === c.id).length;
      return `<div class="cat-row" data-id="${esc(c.id)}">
        <input type="color" class="cat-color" value="${safeColor(c.color)}" aria-label="Color" />
        <input type="text" class="cat-name" value="${esc(c.name)}" maxlength="24" aria-label="Nombre" />
        <span class="cat-n" title="Tareas en esta categoría">${n}</span>
        <button type="button" class="cat-del" data-act="del" title="Eliminar" ${categories.length === 1 ? 'disabled' : ''}>${ICON_TRASH}</button>
      </div>`;
    }).join('');
  }

  function openCatModal() {
    renderCatList();
    catModal.classList.remove('hidden');
  }

  function closeCatModal() {
    categories.forEach(c => { c.name = c.name.trim() || 'Sin nombre'; });
    saveCats();
    catModal.classList.add('hidden');
    render();
  }

  $('#manageCats').addEventListener('click', openCatModal);
  $('#catDoneBtn').addEventListener('click', closeCatModal);
  catModal.addEventListener('mousedown', e => { if (e.target === catModal) closeCatModal(); });

  catList.addEventListener('input', e => {
    const row = e.target.closest('.cat-row');
    if (!row) return;
    const cat = categories.find(c => c.id === row.dataset.id);
    if (e.target.classList.contains('cat-name')) cat.name = e.target.value;
    if (e.target.classList.contains('cat-color')) cat.color = e.target.value;
    saveCats();
    render();
  });

  catList.addEventListener('click', e => {
    const btn = e.target.closest('[data-act="del"]');
    if (!btn || categories.length < 2) return;
    const id = btn.closest('.cat-row').dataset.id;
    const gone = catById(id);
    const fallback = categories.find(c => c.id !== id);
    const prevCats = categories.map(c => ({ ...c }));
    const prevView = view.category;
    const movedIds = new Set(tasks.filter(t => t.category === id).map(t => t.id));
    const moved = live().filter(t => movedIds.has(t.id)).length;

    tasks.forEach(t => { if (movedIds.has(t.id)) t.category = fallback.id; });
    categories = categories.filter(c => c.id !== id);
    if (view.category === id) view.category = 'all';
    save();
    saveCats();
    renderCatList();
    render();

    showToast(
      moved ? `"${gone.name}" eliminada · ${moved} tarea${moved === 1 ? '' : 's'} a ${fallback.name}` : `"${gone.name}" eliminada`,
      () => {
        // Solo se deshace lo que hizo el borrado: el resto de cambios hechos mientras tanto se conservan
        categories = prevCats;
        tasks.forEach(t => { if (movedIds.has(t.id) && t.category === fallback.id) t.category = id; });
        view.category = prevView;
        save();
        saveCats();
        renderCatList();
        render();
      }
    );
  });

  $('#addCatBtn').addEventListener('click', () => {
    categories.push({
      id: 'c' + uid(),
      name: 'Nueva categoría',
      color: PALETTE[categories.length % PALETTE.length]
    });
    saveCats();
    renderCatList();
    render();
    const inputs = catList.querySelectorAll('.cat-name');
    const last = inputs[inputs.length - 1];
    last.focus();
    last.select();
    catList.scrollTop = catList.scrollHeight;
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('#statsModal').classList.contains('hidden')) { $('#statsModal').classList.add('hidden'); return; }
    if (e.key === 'Escape' && !$('#settingsModal').classList.contains('hidden')) { $('#settingsModal').classList.add('hidden'); return; }
    if (e.key === 'Escape' && !$('#accountModal').classList.contains('hidden')) { closeAccount(); return; }
    if (e.key === 'Escape' && !catModal.classList.contains('hidden')) { closeCatModal(); return; }
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeModal();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); openModal(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !modal.classList.contains('hidden')) {
      $('#taskForm').requestSubmit();
    }
  });

  // ---------- Cuenta ----------
  const accModal = $('#accountModal');
  let authMode = 'in';        // in = entrar · up = crear cuenta
  let confirmingLogout = false;

  function statusText() {
    const { status, detail } = Sync.status();
    const n = pendingCount();
    if (status === 'syncing') return 'Sincronizando…';
    if (status === 'offline') return n ? `Sin conexión · ${n} cambio${n === 1 ? '' : 's'} por subir` : 'Sin conexión. Todo está guardado en este dispositivo.';
    if (status === 'error') return 'No se pudo sincronizar' + (detail ? ': ' + detail : '');
    return n ? 'Subiendo cambios…' : 'Todo sincronizado';
  }

  function showAuthMsg(text, kind) {
    const el = $('#authMsg');
    el.textContent = text;
    el.className = 'auth-msg' + (kind === 'ok' ? ' ok' : '') + (text ? '' : ' hidden');
  }

  function showLogoutWarn(text) {
    const el = $('#logoutWarn');
    el.textContent = text;
    el.classList.toggle('hidden', !text);
  }

  function renderAccount() {
    const user = Sync.user();
    $('#authForm').classList.toggle('hidden', !!user);
    $('#accountView').classList.toggle('hidden', !user);
    $('#accTitle').textContent = user ? 'Tu cuenta' : (authMode === 'in' ? 'Iniciar sesión' : 'Crear cuenta');
    $('#authSubmit').textContent = authMode === 'in' ? 'Entrar' : 'Crear cuenta';
    $('#authPass').setAttribute('autocomplete', authMode === 'in' ? 'current-password' : 'new-password');
    document.querySelectorAll('#authTabs .tab').forEach(t => t.classList.toggle('active', t.dataset.mode === authMode));
    if (user) {
      $('#accEmail').textContent = user.email;
      $('#accStatus').textContent = statusText();
      $('#accLogout').textContent = confirmingLogout ? 'Sí, cerrar sesión' : 'Cerrar sesión';
      $('#accClose').textContent = confirmingLogout ? 'Cancelar' : 'Cerrar';
      if (!confirmingLogout) showLogoutWarn('');
    }
  }

  function openAccount(message) {
    confirmingLogout = false;
    showAuthMsg(message || '');
    renderAccount();
    accModal.classList.remove('hidden');
    if (!Sync.user()) setTimeout(() => $('#authEmail').focus(), 30);
  }

  function closeAccount() {
    accModal.classList.add('hidden');
    confirmingLogout = false;
  }

  function onSyncStatus(status) {
    const dot = $('#syncDot');
    if (dot) dot.className = 'sync-dot ' + (Sync.user() ? status : 'off');
    if (!accModal.classList.contains('hidden') && Sync.user()) $('#accStatus').textContent = statusText();
  }

  $('#accountBtn').addEventListener('click', () => openAccount());
  $('#authCancel').addEventListener('click', closeAccount);
  accModal.addEventListener('mousedown', e => { if (e.target === accModal) closeAccount(); });

  $('#authTabs').addEventListener('click', e => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    authMode = tab.dataset.mode;
    showAuthMsg('');
    renderAccount();
  });

  $('#authForm').addEventListener('submit', async e => {
    e.preventDefault();
    const email = $('#authEmail').value.trim();
    const pass = $('#authPass').value;
    const btn = $('#authSubmit');
    btn.disabled = true;
    showAuthMsg('');
    try {
      const r = authMode === 'in' ? await Sync.signIn(email, pass) : await Sync.signUp(email, pass);
      if (r.needsConfirm) {
        showAuthMsg('Te enviamos un correo para confirmar la cuenta. Confírmalo y luego entra.', 'ok');
      } else {
        $('#authPass').value = '';
        renderAccount();
      }
    } catch (err) {
      showAuthMsg(Sync.friendlyError(err));
    } finally {
      btn.disabled = false;
    }
  });

  $('#accSync').addEventListener('click', () => Sync.syncNow());

  $('#accClose').addEventListener('click', () => {
    if (confirmingLogout) { confirmingLogout = false; renderAccount(); } else closeAccount();
  });

  $('#accLogout').addEventListener('click', async () => {
    const btn = $('#accLogout');
    if (!confirmingLogout) {
      btn.disabled = true;
      btn.textContent = 'Comprobando…';
      await Sync.syncNow();          // último intento de subir todo antes de salir
      await new Promise(r => setTimeout(r, 400));
      btn.disabled = false;
      confirmingLogout = true;
      const n = pendingCount();
      showLogoutWarn(n
        ? `Hay ${n} cambio${n === 1 ? '' : 's'} que aún no se han subido (¿sin conexión?). Si cierras sesión ahora, se perderán.`
        : 'Se cerrará la sesión y se quitarán las tareas de este dispositivo. Siguen guardadas en tu cuenta.');
      renderAccount();
      return;
    }
    btn.disabled = true;
    await Sync.signOut();
    btn.disabled = false;
    confirmingLogout = false;
    renderAccount();
  });

  // ---------- Tareas recurrentes: reabrir cuando toca ----------
  function checkRecurring() {
    if (refreshRecurring()) { save(); render(); }
  }

  function scheduleMidnightCheck() {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 2);
    setTimeout(() => {
      if (refreshRecurring()) save();
      render(); // también actualiza textos como "Vuelve mañana"
      scheduleMidnightCheck();
    }, next - now);
  }

  window.addEventListener('focus', checkRecurring);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkRecurring(); });
  scheduleMidnightCheck();

  // ---------- Resumen e historial ----------
  const statsModal = $('#statsModal');
  let statsRange = 7;
  let chartData = null; // lo que necesita el tooltip de la gráfica
  const dayKey = ts => ymd(new Date(ts));
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

  function dayLabel(key) {
    const today = todayStr();
    if (key === today) return 'Hoy';
    if (key === addDays(today, -1)) return 'Ayer';
    return cap(parseDate(key).toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' }));
  }

  // Todas las veces que se completó algo (incluidas tareas recurrentes y tareas ya eliminadas)
  function completionLog() {
    const out = [];
    tasks.forEach(t => t.completions.forEach(ts => out.push({ ts, t })));
    return out.sort((a, b) => b.ts - a.ts);
  }

  function streaks(daySet) {
    let cur = 0;
    let d = todayStr();
    if (!daySet.has(d)) d = addDays(d, -1); // si hoy aún no completaste nada, la racha de ayer sigue viva
    while (daySet.has(d)) { cur++; d = addDays(d, -1); }
    let best = 0, run = 0, prev = null;
    [...daySet].sort().forEach(x => {
      run = prev && addDays(prev, 1) === x ? run + 1 : 1;
      best = Math.max(best, run);
      prev = x;
    });
    return { cur, best };
  }

  function renderStats() {
    document.querySelectorAll('#statsTabs .tab').forEach(t => t.classList.toggle('active', Number(t.dataset.range) === statsRange));
    const log = completionLog();
    const today = todayStr();
    const days = [];
    for (let i = statsRange - 1; i >= 0; i--) days.push(addDays(today, -i));
    const counts = new Map(days.map(d => [d, 0]));
    const inRange = log.filter(e => counts.has(dayKey(e.ts)));
    inRange.forEach(e => { const k = dayKey(e.ts); counts.set(k, counts.get(k) + 1); });
    const { cur, best } = streaks(new Set(log.map(e => dayKey(e.ts))));
    const avg = inRange.length / statsRange;

    const streakNote = !cur ? 'Completa una tarea hoy para empezar'
      : counts.get(today) ? '¡Hoy ya sumaste!' : 'Completa una hoy para no perderla';
    $('#statTiles').innerHTML = [
      ['Completadas', inRange.length, `en los últimos ${statsRange} días`],
      ['Racha actual', plural(cur, 'día', 'días'), streakNote],
      ['Mejor racha', plural(best, 'día', 'días'), 'días seguidos completando algo'],
      ['Promedio', avg.toLocaleString('es', { maximumFractionDigits: 1 }), 'tareas completadas por día']
    ].map(([k, v, s]) => `<div class="tile"><span class="tile-k">${k}</span><b>${v}</b><span class="tile-s">${s}</span></div>`).join('');

    renderChart(days, counts);
    renderCatBreakdown(inRange);
    renderHistory(inRange, counts);
  }

  // Gráfica de barras: una barra por día, con aviso al pasar el ratón
  function renderChart(days, counts) {
    const box = $('#statsChart');
    const W = Math.max(320, box.clientWidth || 640);
    const H = 190;
    const m = { l: 28, r: 4, t: 14, b: 24 };
    const pw = W - m.l - m.r, ph = H - m.t - m.b;
    const base = m.t + ph;
    const vals = days.map(d => counts.get(d));
    const step = Math.max(1, Math.ceil(Math.max(...vals) / 3));
    const yMax = step * 3;
    const y = v => base - (v / yMax) * ph;
    const band = pw / days.length;
    const bw = Math.max(4, Math.min(34, band - 6));
    const today = todayStr();
    let g = '';
    for (let i = 0; i <= 3; i++) {
      const yy = y(i * step);
      g += `<line class="grid-line${i === 0 ? ' base' : ''}" x1="${m.l}" x2="${W - m.r}" y1="${yy}" y2="${yy}"/>`;
      g += `<text class="ax" x="${m.l - 8}" y="${yy + 4}" text-anchor="end">${i * step}</text>`;
    }
    days.forEach((d, i) => {
      const cx = m.l + band * i + band / 2;
      const v = vals[i];
      if (v) {
        const top = y(v), x = cx - bw / 2, r = Math.min(4, bw / 2, base - top);
        g += `<path class="bar" data-i="${i}" d="M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${base}Z"/>`;
      }
      const short = days.length <= 7;
      if (short || (days.length - 1 - i) % 5 === 0) {
        const lbl = d === today ? 'Hoy' : short ? DAY_SHORT[parseDate(d).getDay()] : String(parseDate(d).getDate());
        g += `<text class="ax${d === today ? ' today' : ''}" x="${cx}" y="${H - 6}" text-anchor="middle">${lbl}</text>`;
      }
      g += `<rect class="hit" data-i="${i}" x="${m.l + band * i}" y="${m.t}" width="${band}" height="${ph}"/>`;
    });
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:${W}px;height:${H}px" role="img" aria-label="Tareas completadas por día">${g}</svg><div class="chart-tip hidden"></div>`;
    chartData = { days, vals, band, m, y };
  }

  function hideChartTip() {
    const tip = $('#statsChart .chart-tip');
    if (tip) tip.classList.add('hidden');
    document.querySelectorAll('#statsChart .bar').forEach(b => b.classList.remove('dim'));
  }

  $('#statsChart').addEventListener('mousemove', e => {
    const hit = e.target.closest && e.target.closest('.hit');
    if (!hit || !chartData) { hideChartTip(); return; }
    const i = Number(hit.dataset.i);
    const { days, vals, band, m, y } = chartData;
    const tip = $('#statsChart .chart-tip');
    tip.innerHTML = `${esc(dayLabel(days[i]))} · <b>${plural(vals[i], 'completada', 'completadas')}</b>`;
    tip.style.left = Math.min(Math.max(m.l + band * i + band / 2, 90), $('#statsChart').clientWidth - 90) + 'px';
    tip.style.top = (y(vals[i]) - 8) + 'px';
    tip.classList.remove('hidden');
    document.querySelectorAll('#statsChart .bar').forEach(b => b.classList.toggle('dim', b.dataset.i !== String(i)));
  });
  $('#statsChart').addEventListener('mouseleave', hideChartTip);

  function renderCatBreakdown(entries) {
    const map = new Map();
    entries.forEach(e => { const c = catById(e.t.category); map.set(c.id, { c, n: ((map.get(c.id) || {}).n || 0) + 1 }); });
    const rows = [...map.values()].sort((a, b) => b.n - a.n);
    const max = Math.max(1, ...rows.map(r => r.n));
    $('#statsCats').innerHTML = rows.length
      ? rows.map(r => `<div class="cat-stat" style="--c:${safeColor(r.c.color)}">
          <span class="cs-name"><i></i>${esc(r.c.name)}</span>
          <span class="cs-bar"><i style="width:${(r.n / max) * 100}%"></i></span>
          <span class="cs-n">${r.n}</span>
        </div>`).join('')
      : '<p class="muted-note">Nada completado en este periodo.</p>';
  }

  function renderHistory(entries, counts) {
    if (!entries.length) {
      $('#statsHistory').innerHTML = '<p class="muted-note">Cuando completes tareas aparecerán aquí, agrupadas por día.</p>';
      return;
    }
    let html = '', lastDay = null;
    entries.slice(0, 400).forEach(({ ts, t }) => {
      const k = dayKey(ts);
      if (k !== lastDay) {
        html += `<h4 class="hist-day">${esc(dayLabel(k))}<span>${plural(counts.get(k), 'completada', 'completadas')}</span></h4>`;
        lastDay = k;
      }
      const c = catById(t.category);
      const time = new Date(ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
      html += `<div class="hist-row" style="--c:${safeColor(c.color)}">
        <span class="hist-time">${time}</span><i></i>
        <span class="hist-title">${esc(t.title)}</span>
        ${t.repeat ? `<span class="rep" title="${esc(repeatLabel(t.repeat))}">${ICON_REP}</span>` : ''}
        ${t.archived ? '<span class="hist-tag">eliminada</span>' : ''}
      </div>`;
    });
    $('#statsHistory').innerHTML = html;
  }

  function openStats() {
    statsModal.classList.remove('hidden');
    renderStats(); // después de mostrarlo, para medir el ancho de la gráfica
  }

  $('#statsBtn').addEventListener('click', openStats);
  $('#statsDone').addEventListener('click', () => statsModal.classList.add('hidden'));
  statsModal.addEventListener('mousedown', e => { if (e.target === statsModal) statsModal.classList.add('hidden'); });
  $('#statsTabs').addEventListener('click', e => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    statsRange = Number(tab.dataset.range);
    renderStats();
  });
  window.addEventListener('resize', () => { if (!statsModal.classList.contains('hidden')) renderStats(); });

  // ---------- Ajustes: tema y vista ----------
  const settingsModal = $('#settingsModal');
  const ICON_LIST = '<svg viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/></svg>';
  const ICON_CARDS = '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/></svg>';

  function renderPrefs() {
    const p = Prefs.get();
    document.querySelectorAll('#themeChips .chip').forEach(c => c.classList.toggle('active', c.dataset.v === p.theme));
    document.querySelectorAll('#layoutChips .chip').forEach(c => c.classList.toggle('active', c.dataset.v === p.layout));
    const list = p.layout === 'list';
    const lb = $('#layoutBtn');
    lb.innerHTML = list ? ICON_CARDS : ICON_LIST;
    lb.title = list ? 'Ver como tarjetas' : 'Ver como lista';
  }

  $('#settingsBtn').addEventListener('click', () => { renderPrefs(); settingsModal.classList.remove('hidden'); });
  $('#settingsDone').addEventListener('click', () => settingsModal.classList.add('hidden'));
  settingsModal.addEventListener('mousedown', e => { if (e.target === settingsModal) settingsModal.classList.add('hidden'); });
  $('#themeChips').addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (chip) { Prefs.set({ theme: chip.dataset.v }); renderPrefs(); }
  });
  $('#layoutChips').addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (chip) { Prefs.set({ layout: chip.dataset.v }); renderPrefs(); }
  });
  $('#layoutBtn').addEventListener('click', () => {
    Prefs.set({ layout: Prefs.get().layout === 'list' ? 'cards' : 'list' });
    renderPrefs();
    render(true);
  });
  window.addEventListener('storage', e => { if (e.key === 'pendientes.prefs.v1') renderPrefs(); });

  // ---------- Copia de seguridad ----------
  const isDay = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const str = (s, max) => (typeof s === 'string' ? s.slice(0, max) : '');

  function exportBackup() {
    const data = { app: 'pendientes', version: 1, exportedAt: new Date().toISOString(), categories, tasks };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `pendientes-copia-${todayStr()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    showToast(`Copia exportada · ${plural(live().length, 'tarea', 'tareas')}`);
  }

  // Revisa cada tarea del archivo: solo entra lo que tiene la forma correcta
  function cleanTask(r, catIds) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id || typeof r.title !== 'string' || !r.title.trim()) return null;
    let repeat = null;
    const rp = r.repeat;
    if (rp && rp.type === 'daily') repeat = { type: 'daily' };
    if (rp && rp.type === 'weekly' && Array.isArray(rp.days)) {
      const days = [...new Set(rp.days.filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
      if (days.length) repeat = { type: 'weekly', days };
    }
    if (rp && rp.type === 'monthly' && Number.isInteger(rp.day) && rp.day >= 1 && rp.day <= 31) repeat = { type: 'monthly', day: rp.day };
    const num = v => (Number.isFinite(v) && v > 0 ? v : 0);
    const t = {
      id: r.id.slice(0, 60),
      title: r.title.trim().slice(0, 120),
      desc: str(r.desc, 5000),
      category: catIds.includes(r.category) ? r.category : categories[0].id,
      due: !repeat && isDay(r.due) ? r.due : '',
      done: r.done === true,
      createdAt: num(r.createdAt) || Date.now(),
      subtasks: Array.isArray(r.subtasks)
        ? r.subtasks.filter(s => s && typeof s.text === 'string').slice(0, 200)
          .map(s => ({ id: typeof s.id === 'string' ? s.id.slice(0, 60) : uid(), text: s.text.slice(0, 120), done: s.done === true }))
        : [],
      repeat,
      doneOn: repeat && isDay(r.doneOn) ? r.doneOn : '',
      reopenOn: repeat && isDay(r.reopenOn) ? r.reopenOn : '',
      completions: Array.isArray(r.completions) ? r.completions.filter(v => num(v)).slice(-5000) : [],
      updatedAt: num(r.updatedAt)
    };
    if (r.archived === true && t.completions.length) t.archived = true;
    return t;
  }

  function importBackup(text) {
    let d;
    try { d = JSON.parse(text); } catch { d = null; }
    if (!d || !Array.isArray(d.tasks)) { showToast('Ese archivo no es una copia de Pendientes.'); return; }

    const before = { cats: JSON.stringify(categories), tasks: JSON.stringify(tasks) };
    let catsChanged = false;
    if (Array.isArray(d.categories)) {
      d.categories.forEach(c => {
        if (!c || typeof c.id !== 'string' || !c.id || categories.some(x => x.id === c.id)) return;
        categories.push({ id: c.id.slice(0, 60), name: str(c.name, 24).trim() || 'Sin nombre', color: safeColor(c.color) });
        catsChanged = true;
      });
    }
    const catIds = categories.map(c => c.id);
    let added = 0, updated = 0;
    d.tasks.forEach(raw => {
      const t = cleanTask(raw, catIds);
      if (!t) return;
      const i = tasks.findIndex(x => x.id === t.id);
      if (i < 0) { tasks.push(t); added++; }
      else if (t.updatedAt > (tasks[i].updatedAt || 0)) { tasks[i] = t; updated++; }
    });
    if (!added && !updated && !catsChanged) { showToast('No había nada nuevo en esa copia.'); return; }

    refreshRecurring();
    if (catsChanged) saveCats();
    save();
    render(true);
    const parts = [];
    if (added) parts.push(`${plural(added, 'nueva', 'nuevas')}`);
    if (updated) parts.push(`${plural(updated, 'actualizada', 'actualizadas')}`);
    showToast(`Copia importada · ${parts.join(', ') || 'categorías añadidas'}`, () => {
      categories = JSON.parse(before.cats);
      tasks = JSON.parse(before.tasks);
      if (catsChanged) saveCats();
      save();
      render(true);
    });
  }

  $('#exportBtn').addEventListener('click', exportBackup);
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) { showToast('El archivo es demasiado grande.'); return; }
    const reader = new FileReader();
    reader.onload = () => { settingsModal.classList.add('hidden'); importBackup(String(reader.result)); };
    reader.onerror = () => showToast('No se pudo leer el archivo.');
    reader.readAsText(file);
  });

  // ---------- Captura rápida (solo en la app de escritorio) ----------
  if (window.desktop) {
    window.desktop.quickShortcut().then(label => {
      if (!label) return;
      $('#quickKeys').textContent = label;
      $('#quickInfo').classList.remove('hidden');
    }).catch(() => {});

    window.desktop.onQuickAdd(d => {
      const title = d && typeof d.title === 'string' ? d.title.trim().slice(0, 120) : '';
      if (!title) return;
      const category = categories.some(c => c.id === d.category) ? d.category : categories[0].id;
      const task = {
        id: uid(), title, desc: '', category, due: '', done: false, createdAt: Date.now(),
        subtasks: [], completions: [], repeat: null, doneOn: '', reopenOn: ''
      };
      tasks.push(task);
      save();
      render(true);
      showToast(`Añadida: ${title}`, () => {
        tasks = tasks.filter(t => t.id !== task.id);
        save();
        render();
      });
    });
  }

  // ---------- Inicio ----------
  renderPrefs();
  if (refreshRecurring()) save();
  render(true);

  if (window.Sync) {
    $('#accountBtn').classList.toggle('hidden', !Sync.enabled);
    Sync.init({
      collect: collectPush,
      markPushed,
      apply: applyRemote,
      onLogin() { dropPristineSeed(); markAllDirty(); persist(); render(); },
      clearLocal,
      onStatus: onSyncStatus,
      onExpired() {
        onSyncStatus('off');
        showToast('Tu sesión caducó. Entra de nuevo para seguir sincronizando.', () => openAccount('Tu sesión caducó. Vuelve a entrar para seguir sincronizando.'), 'Entrar');
      }
    });
  }
})();
