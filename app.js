// ============================================================
// PROVISIO — app.js  |  Full-Stack PWA Logic
// ============================================================

// ─── CONFIG ─────────────────────────────────────────────────
// Reemplaza estos valores con los de tu proyecto Supabase:
//   Dashboard → Settings → API → Project URL & anon key
const SUPABASE_URL      = 'https://rokgqtgcurxalulunuvm.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJva2dxdGdjdXJ4YWx1bHVudXZtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3MDMwOTAsImV4cCI6MjA5NDI3OTA5MH0.QKQDQ1C9b5KZ4sUBktTxq9TiBkDG1SwgyPaYo8S6Sjo';

// Inicializado en initApp() para evitar error si el CDN aún no cargó
let supabase = null;

// ─── ESTADO GLOBAL ──────────────────────────────────────────
let currentUser    = null;
let currentProfile = null;
let currentHogar   = null;
let currentTab     = 'inventario';
let activeCategory = null;
let ocrWorker      = null;
let cameraStream   = null;
let espaciosCache  = [];
let pendingOCRItems = [];
let duplicateResolve = null;
const stockDebounceTimers = {};

// ─── UTILIDADES ─────────────────────────────────────────────

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

function generateCode(length = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function formatPrice(n) {
  if (!n && n !== 0) return '—';
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(n);
}

function formatMonth(mes, anio) {
  const months = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                  'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  return `${months[mes - 1]} ${anio}`;
}

function showToast(msg, type = 'info') {
  const el = document.getElementById('toast');
  const colors = {
    info:    'bg-slate-700 text-white',
    success: 'bg-green-600 text-white',
    error:   'bg-red-600 text-white',
    warn:    'bg-amber-600 text-white',
  };
  el.className = `fixed left-4 right-4 z-[100] px-4 py-3 rounded-2xl text-sm font-medium text-center shadow-lg ${colors[type] || colors.info}`;
  el.style.top = 'calc(env(safe-area-inset-top, 0px) + 12px)';
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add('hidden'), 3000);
}

function showModal(id) {
  document.getElementById(id).classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function hideModal(id) {
  document.getElementById(id).classList.add('hidden');
  document.body.style.overflow = '';
}

function setScreen(name) {
  ['loading', 'auth', 'app'].forEach(s => {
    document.getElementById(`screen-${s}`).classList.toggle('hidden', s !== name);
  });
  if (name === 'auth') {
    document.getElementById(`screen-${name}`).classList.remove('hidden');
    document.getElementById(`screen-${name}`).classList.add('flex');
  }
}

function showAuthError(formId, msg) {
  const el = document.getElementById(`${formId}-error`);
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

function setButtonLoading(btnId, loading, label = '') {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.disabled = loading;
  btn.textContent = loading ? 'Cargando...' : label || btn.dataset.label || btn.textContent;
}

// ─── INIT ────────────────────────────────────────────────────

async function initApp() {
  registerServiceWorker();

  // Inicializar cliente Supabase (CDN debe estar cargado para este punto)
  try {
    if (!window.supabase) throw new Error('Supabase CDN no cargado');
    supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'provisio_auth' },
    });
  } catch (e) {
    console.error('[initApp] Supabase no disponible:', e);
    setScreen('auth');
    showToast('Error de conexión — revisa tu red', 'error');
    return;
  }

  try {
    const { data, error } = await supabase.auth.getSession();

    if (error) throw error;

    const session = data?.session;

    if (session) {
      currentUser = session.user;
      await loadProfile();
      if (currentProfile?.hogar_id) {
        await loadHogar();
        silentPurge(); // fire-and-forget, no bloquea la UI
        setScreen('app');
        navigate('inventario');
      } else {
        // Perfil creado por trigger pero sin hogar aún
        setScreen('auth');
        switchAuthMode('register');
      }
    } else {
      setScreen('auth');
    }
  } catch (err) {
    console.error('[initApp] Error:', err);
    // Fallback seguro: mostrar login siempre
    setScreen('auth');
  }

  supabase.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_OUT') {
      currentUser = currentProfile = currentHogar = null;
      setScreen('auth');
    }
  });
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

async function initOCRWorker() {
  if (ocrWorker) return ocrWorker;
  try {
    ocrWorker = await Tesseract.createWorker('spa', 1, {
      logger: () => {},
    });
    return ocrWorker;
  } catch (e) {
    console.warn('[OCR] Worker init failed:', e);
    ocrWorker = null;
    return null;
  }
}

// ─── AUTH ────────────────────────────────────────────────────

function switchAuthMode(mode) {
  const isLogin = mode === 'login';
  const fLogin    = document.getElementById('form-login');
  const fRegister = document.getElementById('form-register');

  // Quitar 'hidden' primero (tiene !important y gana sobre style.display)
  fLogin.classList.remove('hidden');
  fRegister.classList.remove('hidden');

  fLogin.style.display          = isLogin ? 'flex' : 'none';
  fLogin.style.flexDirection    = 'column';
  fLogin.style.gap              = '1rem';
  fRegister.style.display       = isLogin ? 'none' : 'flex';
  fRegister.style.flexDirection = 'column';
  fRegister.style.gap           = '1rem';

  document.getElementById('tab-login').className =
    `auth-tab flex-1 py-2 rounded-lg text-sm font-medium transition-all ${isLogin ? 'bg-slate-700 text-white' : 'text-slate-400'}`;
  document.getElementById('tab-register').className =
    `auth-tab flex-1 py-2 rounded-lg text-sm font-medium transition-all ${!isLogin ? 'bg-slate-700 text-white' : 'text-slate-400'}`;
}

async function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById('login-email').value.trim();
  const pwd   = document.getElementById('login-pwd').value;
  setButtonLoading('btn-login', true);

  const { error } = await supabase.auth.signInWithPassword({ email, password: pwd });
  setButtonLoading('btn-login', false, 'Iniciar sesión');

  if (error) {
    showAuthError('login', 'Email o contraseña incorrectos');
    return;
  }

  const { data: { session } } = await supabase.auth.getSession();
  currentUser = session.user;
  await loadProfile();
  await loadHogar();
  await silentPurge();
  setScreen('app');
  navigate('inventario');
}

async function handleRegister(e) {
  e.preventDefault();
  const nombre = document.getElementById('reg-nombre').value.trim();
  const email  = document.getElementById('reg-email').value.trim();
  const pwd    = document.getElementById('reg-pwd').value;
  const codigo = document.getElementById('reg-codigo').value.trim().toUpperCase();

  setButtonLoading('btn-register', true);

  const { data, error } = await supabase.auth.signUp({
    email,
    password: pwd,
    options: { data: { full_name: nombre } },
  });

  if (error) {
    setButtonLoading('btn-register', false, 'Crear cuenta');
    showAuthError('register', error.message);
    return;
  }

  currentUser = data.user;

  // Esperar a que el trigger cree el perfil (debería ser inmediato)
  await new Promise(r => setTimeout(r, 800));

  if (codigo) {
    const ok = await joinHogar(codigo);
    if (!ok) {
      setButtonLoading('btn-register', false, 'Crear cuenta');
      showAuthError('register', 'Código de invitación no válido');
      return;
    }
  } else {
    await createHogar(nombre + "'s Home");
  }

  await loadProfile();
  await loadHogar();
  setScreen('app');
  navigate('inventario');
  setButtonLoading('btn-register', false, 'Crear cuenta');
}

async function handleSignOut() {
  await supabase.auth.signOut();
  currentUser = currentProfile = currentHogar = null;
  espaciosCache = [];
  activeCategory = null;
  setScreen('auth');
}

// ─── HOGAR ───────────────────────────────────────────────────

async function createHogar(nombre) {
  const codigo = generateCode(6);
  const { data: hogar, error } = await supabase
    .from('hogares')
    .insert({ nombre, codigo_invitacion: codigo })
    .select()
    .single();

  if (error) { showToast('Error creando hogar', 'error'); return false; }

  await supabase
    .from('perfiles')
    .update({ hogar_id: hogar.id, rol: 'admin' })
    .eq('id', currentUser.id);

  // Crear espacios por defecto
  await supabase.rpc('crear_espacios_default', { p_hogar_id: hogar.id });

  currentHogar = hogar;
  return true;
}

async function joinHogar(codigo) {
  const { data: hogar } = await supabase
    .from('hogares')
    .select('*')
    .eq('codigo_invitacion', codigo)
    .single();

  if (!hogar) return false;

  await supabase
    .from('perfiles')
    .update({ hogar_id: hogar.id, rol: 'miembro' })
    .eq('id', currentUser.id);

  currentHogar = hogar;
  return true;
}

async function loadProfile() {
  const { data } = await supabase
    .from('perfiles')
    .select('*')
    .eq('id', currentUser.id)
    .single();
  currentProfile = data;
}

async function loadHogar() {
  if (!currentProfile?.hogar_id) return;
  const { data } = await supabase
    .from('hogares')
    .select('*')
    .eq('id', currentProfile.hogar_id)
    .single();
  currentHogar = data;
}

async function loadEspacios() {
  if (!currentProfile?.hogar_id) return [];
  const { data } = await supabase
    .from('espacios')
    .select('*')
    .eq('hogar_id', currentProfile.hogar_id)
    .order('nombre');
  espaciosCache = data || [];
  return espaciosCache;
}

// ─── MOTOR DE PURGA SILENCIOSA ───────────────────────────────

async function silentPurge() {
  if (!currentProfile?.hogar_id) return;
  const KEY = 'provisio_last_purge';
  const today = new Date().toISOString().split('T')[0];
  if (localStorage.getItem(KEY) === today) return;

  try {
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

    const { data: items } = await supabase
      .from('inventario')
      .select('id, precio_total, nombre, creado_at')
      .eq('hogar_id', currentProfile.hogar_id)
      .eq('stock_actual', 0)
      .lt('creado_at', cutoff);

    if (!items || items.length === 0) {
      localStorage.setItem(KEY, today);
      return;
    }

    // UPSERT en resumen_mensual por cada item
    for (const item of items) {
      const d = new Date(item.creado_at);
      await supabase.rpc('upsert_resumen', {
        p_mes:    d.getMonth() + 1,
        p_anio:   d.getFullYear(),
        p_gasto:  item.precio_total || 0,
        p_nombre: item.nombre,
      });
    }

    // Eliminar items archivados
    const ids = items.map(i => i.id);
    await supabase.from('inventario').delete().in('id', ids);

    localStorage.setItem(KEY, today);
  } catch (err) {
    console.warn('[Purge] Error silenciosa:', err);
  }
}

// ─── NAVEGACIÓN ──────────────────────────────────────────────

async function renderApp() {
  await loadEspacios();
  navigate(currentTab || 'inventario');
}

function navigate(tab) {
  currentTab = tab;

  // Actualizar tab bar
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.remove('text-brand-400');
    btn.classList.add('text-slate-500');
  });
  const activeBtn = document.getElementById(`tab-btn-${tab}`);
  if (activeBtn) {
    activeBtn.classList.remove('text-slate-500');
    activeBtn.classList.add('text-brand-400');
  }

  // Chips de categoría: solo en inventario
  document.getElementById('category-chips-bar').classList.toggle('hidden', tab !== 'inventario');

  // Botón de añadir en header
  const actionsEl = document.getElementById('header-actions');

  const views = {
    inventario: () => {
      document.getElementById('header-title').textContent = 'Inventario';
      document.getElementById('header-subtitle').textContent = currentHogar?.nombre || '';
      actionsEl.innerHTML = `
        <button onclick="openAddItemModal()" class="w-9 h-9 bg-brand-600 rounded-xl flex items-center justify-center">
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/>
          </svg>
        </button>`;
      renderInventory();
    },
    compra: () => {
      document.getElementById('header-title').textContent = 'Lista de compra';
      document.getElementById('header-subtitle').textContent = 'Productos bajo mínimo';
      actionsEl.innerHTML = '';
      renderCompra();
    },
    stats: () => {
      document.getElementById('header-title').textContent = 'Estadísticas';
      document.getElementById('header-subtitle').textContent = 'Gasto mensual archivado';
      actionsEl.innerHTML = '';
      renderStats();
    },
    ajustes: () => {
      document.getElementById('header-title').textContent = 'Ajustes';
      document.getElementById('header-subtitle').textContent = '';
      actionsEl.innerHTML = '';
      renderAjustes();
    },
  };

  (views[tab] || views.inventario)();
}

// ─── RENDER: INVENTARIO ──────────────────────────────────────

async function renderInventory() {
  const container = document.getElementById('view-container');
  container.innerHTML = '<div class="flex justify-center py-12"><div class="spinner"></div></div>';

  const { data: items } = await supabase
    .from('inventario')
    .select('*, espacios(nombre)')
    .eq('hogar_id', currentProfile.hogar_id)
    .order('nombre');

  if (!items || items.length === 0) {
    container.innerHTML = renderEmptyState(
      '📦',
      'Sin productos',
      'Añade tu primer producto con el botón + o escaneando un ticket'
    );
    updateCategoryChips([]);
    return;
  }

  // Obtener categorías únicas
  const categorias = [...new Set(items.map(i => i.categoria).filter(Boolean))];
  updateCategoryChips(categorias);

  // Filtrar por categoría activa
  const filtered = activeCategory
    ? items.filter(i => i.categoria === activeCategory)
    : items;

  // Agrupar por espacio
  const groups = {};
  filtered.forEach(item => {
    const key = item.espacio_id || '__sin_espacio__';
    const label = item.espacios?.nombre || 'Sin espacio';
    if (!groups[key]) groups[key] = { label, items: [] };
    groups[key].items.push(item);
  });

  // Ordenar grupos: primero los que tienen alertas
  const sortedGroups = Object.values(groups).sort((a, b) => {
    const aAlerts = a.items.filter(i => i.stock_actual <= i.stock_minimo).length;
    const bAlerts = b.items.filter(i => i.stock_actual <= i.stock_minimo).length;
    return bAlerts - aAlerts;
  });

  const alertCount = items.filter(i => i.stock_actual <= i.stock_minimo).length;

  container.innerHTML = `
    ${alertCount > 0 ? `
    <div class="flex items-center gap-2 mb-3 bg-red-500/10 border border-red-500/20 rounded-xl px-3 py-2.5">
      <span class="text-red-400 text-sm">⚠️</span>
      <span class="text-red-400 text-sm font-medium">${alertCount} producto${alertCount > 1 ? 's' : ''} bajo mínimo</span>
    </div>` : ''}
    ${sortedGroups.map(group => `
    <div class="mb-5">
      <h3 class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2 px-1">${group.label}</h3>
      <div class="flex flex-col gap-2">
        ${group.items.map(item => renderItemCard(item)).join('')}
      </div>
    </div>`).join('')}
    <div class="h-4"></div>
  `;

  container.classList.add('view-enter');
  setTimeout(() => container.classList.remove('view-enter'), 300);
}

function renderItemCard(item) {
  const isAlert = item.stock_actual <= item.stock_minimo;
  const stockPct = item.stock_minimo > 0
    ? Math.min(100, (item.stock_actual / item.stock_minimo) * 100)
    : 100;
  const barColor = isAlert ? 'bg-red-500' : stockPct > 60 ? 'bg-green-500' : 'bg-amber-500';

  return `
  <div class="bg-slate-800 rounded-2xl p-4 ${isAlert ? 'stock-alert border border-red-500/30' : ''}"
    onclick="openEditItemModal('${item.id}')">
    <div class="flex items-start justify-between gap-3">
      <div class="flex items-start gap-3 min-w-0">
        <span class="text-2xl flex-shrink-0 mt-0.5">${item.categoria_emoji || '📦'}</span>
        <div class="min-w-0">
          <p class="font-medium text-sm truncate">${escHtml(item.nombre)}</p>
          ${item.categoria ? `<p class="text-xs text-slate-500 mt-0.5">${escHtml(item.categoria)}</p>` : ''}
        </div>
      </div>
      <div class="flex items-center gap-2 flex-shrink-0" onclick="event.stopPropagation()">
        <button onclick="adjustStock('${item.id}', -1)"
          class="w-8 h-8 bg-slate-700 rounded-xl flex items-center justify-center text-slate-300 font-bold active:scale-90 transition-transform">
          −
        </button>
        <span id="stock-label-${item.id}"
          class="text-sm font-semibold min-w-[2rem] text-center ${isAlert ? 'text-red-400' : 'text-white'}">
          ${formatStock(item)}
        </span>
        <button onclick="adjustStock('${item.id}', 1)"
          class="w-8 h-8 bg-slate-700 rounded-xl flex items-center justify-center text-slate-300 font-bold active:scale-90 transition-transform">
          +
        </button>
      </div>
    </div>
    <!-- Barra de stock -->
    <div class="mt-3 bg-slate-700 rounded-full h-1.5">
      <div class="${barColor} h-1.5 rounded-full transition-all" style="width:${stockPct}%"></div>
    </div>
    <div class="flex justify-between mt-1.5">
      <span class="text-xs text-slate-500">Mín: ${item.stock_minimo}${item.fraccionado ? ' u.' : ''}</span>
      ${item.precio_total ? `<span class="text-xs text-slate-500">${formatPrice(item.precio_total)}</span>` : ''}
    </div>
  </div>`;
}

function formatStock(item) {
  if (item.fraccionado && item.unidades_fraccion > 1) {
    const full = Math.floor(item.stock_actual);
    const parts = Math.round((item.stock_actual - full) * item.unidades_fraccion);
    return parts > 0 ? `${full}+${parts}u` : `${full}`;
  }
  return Number.isInteger(item.stock_actual) ? `${item.stock_actual}` : `${item.stock_actual.toFixed(1)}`;
}

function updateCategoryChips(categorias) {
  const bar = document.getElementById('category-chips-bar');
  if (!categorias.length) {
    bar.innerHTML = '';
    return;
  }

  bar.innerHTML = `
    <button onclick="filterCategory(null)"
      class="flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${!activeCategory ? 'chip-active' : 'chip-inactive'}">
      Todos
    </button>
    ${categorias.map(cat => `
    <button onclick="filterCategory('${escAttr(cat)}')"
      class="flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${activeCategory === cat ? 'chip-active' : 'chip-inactive'}">
      ${escHtml(cat)}
    </button>`).join('')}
  `;
}

function filterCategory(cat) {
  activeCategory = cat;
  renderInventory();
}

// ─── RENDER: COMPRA ──────────────────────────────────────────

async function renderCompra() {
  const container = document.getElementById('view-container');
  container.innerHTML = '<div class="flex justify-center py-12"><div class="spinner"></div></div>';

  const { data: items } = await supabase
    .from('inventario')
    .select('*, espacios(nombre)')
    .eq('hogar_id', currentProfile.hogar_id)
    .order('nombre');

  const bajo = (items || []).filter(i => i.stock_actual <= i.stock_minimo);

  if (bajo.length === 0) {
    container.innerHTML = renderEmptyState('✅', 'Todo en orden', 'No hay productos bajo el stock mínimo');
    return;
  }

  container.innerHTML = `
    <p class="text-xs text-slate-500 mb-3 px-1">${bajo.length} producto${bajo.length > 1 ? 's' : ''} para reponer</p>
    <div class="flex flex-col gap-2">
      ${bajo.map(item => `
      <div class="bg-slate-800 rounded-2xl px-4 py-3.5 flex items-center gap-3">
        <span class="text-xl">${item.categoria_emoji || '📦'}</span>
        <div class="flex-1 min-w-0">
          <p class="font-medium text-sm truncate">${escHtml(item.nombre)}</p>
          <p class="text-xs text-slate-500 mt-0.5">
            ${item.espacios?.nombre || 'Sin espacio'} · Stock: <span class="text-red-400">${formatStock(item)}</span> / mín ${item.stock_minimo}
          </p>
        </div>
        <div class="flex-shrink-0 w-5 h-5 rounded-full border-2 border-slate-600 cursor-pointer hover:border-brand-500 transition-colors"></div>
      </div>`).join('')}
    </div>
    <div class="h-4"></div>
  `;
}

// ─── RENDER: STATS ───────────────────────────────────────────

async function renderStats() {
  const container = document.getElementById('view-container');
  container.innerHTML = '<div class="flex justify-center py-12"><div class="spinner"></div></div>';

  const { data: resumenes } = await supabase
    .from('resumen_mensual')
    .select('*')
    .eq('hogar_id', currentProfile.hogar_id)
    .order('anio', { ascending: false })
    .order('mes', { ascending: false });

  if (!resumenes || resumenes.length === 0) {
    container.innerHTML = renderEmptyState(
      '📊',
      'Sin datos aún',
      'Los gastos archivados aparecerán aquí cuando los productos con stock cero superen los 90 días'
    );
    return;
  }

  const totalGlobal = resumenes.reduce((acc, r) => acc + (r.gasto_total || 0), 0);

  container.innerHTML = `
    <div class="bg-slate-800 rounded-2xl px-5 py-4 mb-4 text-center">
      <p class="text-xs text-slate-500 mb-1">Gasto total archivado</p>
      <p class="text-3xl font-bold">${formatPrice(totalGlobal)}</p>
    </div>
    <div class="flex flex-col gap-3">
      ${resumenes.map(r => `
      <div class="bg-slate-800 rounded-2xl px-4 py-4">
        <div class="flex justify-between items-center mb-2">
          <p class="font-semibold text-sm">${formatMonth(r.mes, r.anio)}</p>
          <p class="font-bold text-brand-400">${formatPrice(r.gasto_total)}</p>
        </div>
        ${r.listado_productos_texto ? `
        <p class="text-xs text-slate-500 leading-relaxed">${escHtml(r.listado_productos_texto)}</p>` : ''}
      </div>`).join('')}
    </div>
    <div class="h-4"></div>
  `;
}

// ─── RENDER: AJUSTES ─────────────────────────────────────────

async function renderAjustes() {
  const container = document.getElementById('view-container');

  const codigo = currentHogar?.codigo_invitacion || '------';
  const nombre = currentHogar?.nombre || '';

  container.innerHTML = `
    <!-- Perfil -->
    <div class="bg-slate-800 rounded-2xl px-5 py-4 mb-3 flex items-center gap-4">
      <div class="w-12 h-12 rounded-full bg-brand-600 flex items-center justify-center text-xl font-bold">
        ${(currentProfile?.nombre_completo || 'U')[0].toUpperCase()}
      </div>
      <div>
        <p class="font-semibold">${escHtml(currentProfile?.nombre_completo || '')}</p>
        <p class="text-xs text-slate-500">${currentUser?.email || ''}</p>
      </div>
    </div>

    <!-- Hogar -->
    <div class="bg-slate-800 rounded-2xl px-5 py-4 mb-3">
      <p class="text-xs text-slate-500 font-medium mb-3 uppercase tracking-wider">Hogar</p>
      <div class="flex items-center justify-between mb-3">
        <span class="text-sm text-slate-400">Nombre</span>
        <span class="text-sm font-medium">${escHtml(nombre)}</span>
      </div>
      <div class="flex items-center justify-between">
        <div>
          <span class="text-sm text-slate-400">Código de invitación</span>
          <p class="text-lg font-bold tracking-widest mt-0.5">${codigo}</p>
        </div>
        <button onclick="copyInviteCode('${codigo}')"
          class="bg-brand-600/20 text-brand-400 text-xs font-medium px-3 py-2 rounded-xl">
          Copiar
        </button>
      </div>
      <p class="text-xs text-slate-600 mt-2">Comparte este código con tu pareja o familia</p>
    </div>

    <!-- Espacios -->
    <div class="bg-slate-800 rounded-2xl px-5 py-4 mb-3">
      <div class="flex items-center justify-between mb-3">
        <p class="text-xs text-slate-500 font-medium uppercase tracking-wider">Espacios</p>
        <button onclick="openAddSpaceModal()" class="text-brand-400 text-xs font-medium">+ Nuevo</button>
      </div>
      <div class="flex flex-col gap-2" id="spaces-list">
        ${espaciosCache.map(e => `
        <div class="flex items-center justify-between py-1.5">
          <span class="text-sm">${escHtml(e.nombre)}</span>
          <button onclick="deleteSpace('${e.id}')" class="text-slate-600 text-xs">✕</button>
        </div>`).join('')}
      </div>
    </div>

    <!-- App info -->
    <div class="bg-slate-800 rounded-2xl px-5 py-4 mb-3">
      <p class="text-xs text-slate-500 font-medium mb-3 uppercase tracking-wider">App</p>
      <div class="flex items-center justify-between py-1.5">
        <span class="text-sm text-slate-400">Versión</span>
        <span class="text-sm">1.0.0</span>
      </div>
      <div class="flex items-center justify-between py-1.5">
        <span class="text-sm text-slate-400">Estado</span>
        <span class="text-sm text-green-400">● Conectado</span>
      </div>
    </div>

    <!-- Cerrar sesión -->
    <button onclick="handleSignOut()"
      class="w-full bg-red-500/10 text-red-400 font-semibold py-4 rounded-2xl text-sm mb-4">
      Cerrar sesión
    </button>
    <div class="h-4"></div>
  `;
}

async function copyInviteCode(codigo) {
  try {
    await navigator.clipboard.writeText(codigo);
    showToast('Código copiado al portapapeles', 'success');
  } catch {
    showToast(`Código: ${codigo}`, 'info');
  }
}

// ─── GESTIÓN DE ITEMS ────────────────────────────────────────

async function openAddItemModal() {
  await loadEspacios();
  const select = document.getElementById('item-espacio');
  select.innerHTML = espaciosCache.map(e =>
    `<option value="${e.id}">${escHtml(e.nombre)}</option>`
  ).join('');

  // Cargar categorías existentes para el datalist
  const { data: items } = await supabase
    .from('inventario').select('categoria').eq('hogar_id', currentProfile.hogar_id);
  const cats = [...new Set((items || []).map(i => i.categoria).filter(Boolean))];
  document.getElementById('categorias-list').innerHTML =
    cats.map(c => `<option value="${escHtml(c)}">`).join('');

  document.getElementById('item-id').value = '';
  document.getElementById('item-modal-title').textContent = 'Nuevo producto';
  document.getElementById('form-item').reset();
  document.getElementById('item-emoji').value = '📦';
  document.getElementById('item-stock').value = '1';
  document.getElementById('item-stock-min').value = '1';
  document.getElementById('fraccion-row').classList.add('hidden');
  document.getElementById('btn-delete-item').classList.add('hidden');
  showModal('modal-item');
}

async function openEditItemModal(itemId) {
  await loadEspacios();
  const { data: item } = await supabase
    .from('inventario').select('*').eq('id', itemId).single();
  if (!item) return;

  const select = document.getElementById('item-espacio');
  select.innerHTML = espaciosCache.map(e =>
    `<option value="${e.id}" ${e.id === item.espacio_id ? 'selected' : ''}>${escHtml(e.nombre)}</option>`
  ).join('');

  document.getElementById('item-id').value = item.id;
  document.getElementById('item-modal-title').textContent = 'Editar producto';
  document.getElementById('item-emoji').value = item.categoria_emoji || '📦';
  document.getElementById('item-nombre').value = item.nombre;
  document.getElementById('item-categoria').value = item.categoria || '';
  document.getElementById('item-precio').value = item.precio_total || '';
  document.getElementById('item-stock').value = item.stock_actual;
  document.getElementById('item-stock-min').value = item.stock_minimo;
  document.getElementById('item-fraccionado').checked = item.fraccionado;
  document.getElementById('item-unidades-fraccion').value = item.unidades_fraccion || 1;
  document.getElementById('fraccion-row').classList.toggle('hidden', !item.fraccionado);
  document.getElementById('btn-delete-item').classList.remove('hidden');
  showModal('modal-item');
}

function toggleFraccionado() {
  const checked = document.getElementById('item-fraccionado').checked;
  document.getElementById('fraccion-row').classList.toggle('hidden', !checked);
}

async function saveItem(e) {
  e.preventDefault();
  const id          = document.getElementById('item-id').value;
  const nombre      = document.getElementById('item-nombre').value.trim();
  const categoria   = document.getElementById('item-categoria').value.trim();
  const emoji       = document.getElementById('item-emoji').value.trim() || '📦';
  const espacio_id  = document.getElementById('item-espacio').value;
  const precio      = parseFloat(document.getElementById('item-precio').value) || 0;
  const stock       = parseFloat(document.getElementById('item-stock').value) || 0;
  const stockMin    = parseFloat(document.getElementById('item-stock-min').value) || 1;
  const fraccionado = document.getElementById('item-fraccionado').checked;
  const uFraccion   = parseInt(document.getElementById('item-unidades-fraccion').value) || 1;

  const payload = {
    nombre,
    categoria:        categoria || null,
    categoria_emoji:  emoji,
    espacio_id:       espacio_id || null,
    precio_total:     precio,
    stock_actual:     stock,
    stock_minimo:     stockMin,
    fraccionado,
    unidades_fraccion: fraccionado ? uFraccion : 1,
    hogar_id:         currentProfile.hogar_id,
    actualizado_at:   new Date().toISOString(),
  };

  if (id) {
    await supabase.from('inventario').update(payload).eq('id', id);
  } else {
    await supabase.from('inventario').insert(payload);
  }

  hideModal('modal-item');
  showToast(id ? 'Producto actualizado' : 'Producto añadido', 'success');
  renderInventory();
}

async function deleteCurrentItem() {
  const id = document.getElementById('item-id').value;
  if (!id) return;
  await supabase.from('inventario').delete().eq('id', id);
  hideModal('modal-item');
  showToast('Producto eliminado', 'warn');
  renderInventory();
}

// ─── GESTIÓN DE STOCK (con debounce + vibración) ─────────────

function adjustStock(itemId, delta) {
  if (navigator.vibrate) navigator.vibrate(10);

  clearTimeout(stockDebounceTimers[itemId]);
  stockDebounceTimers[itemId] = setTimeout(async () => {
    const { data: item } = await supabase
      .from('inventario')
      .select('stock_actual, stock_minimo, fraccionado, unidades_fraccion')
      .eq('id', itemId)
      .single();

    if (!item) return;

    const unit = item.fraccionado && item.unidades_fraccion > 1
      ? 1 / item.unidades_fraccion
      : 1;
    const newStock = Math.max(0, parseFloat((item.stock_actual + delta * unit).toFixed(3)));

    await supabase
      .from('inventario')
      .update({ stock_actual: newStock, actualizado_at: new Date().toISOString() })
      .eq('id', itemId);

    // Re-render ligero: solo actualizar el label y el color sin re-fetch completo
    const label = document.getElementById(`stock-label-${itemId}`);
    if (label) {
      const fakeItem = { ...item, stock_actual: newStock };
      label.textContent = formatStock(fakeItem);
      const isAlert = newStock <= item.stock_minimo;
      label.classList.toggle('text-red-400', isAlert);
      label.classList.toggle('text-white', !isAlert);
    } else {
      renderInventory();
    }
  }, 280);
}

// ─── GESTIÓN DE ESPACIOS ─────────────────────────────────────

async function openAddSpaceModal() {
  const nombre = prompt('Nombre del nuevo espacio (ej: Bodega):');
  if (!nombre || !nombre.trim()) return;
  await supabase.from('espacios').insert({
    hogar_id: currentProfile.hogar_id,
    nombre: nombre.trim(),
  });
  await loadEspacios();
  showToast('Espacio creado', 'success');
  renderAjustes();
}

async function deleteSpace(spaceId) {
  if (!confirm('¿Eliminar este espacio? Los productos del espacio quedarán sin asignar.')) return;
  await supabase.from('espacios').delete().eq('id', spaceId);
  await loadEspacios();
  showToast('Espacio eliminado', 'warn');
  renderAjustes();
}

// ─── OCR / SCAN ───────────────────────────────────────────────

function openScanModal() {
  showModal('modal-scan');
  showScanPhase('camera');
  startCamera();

  // Cargar espacios en el select del scan
  loadEspacios().then(() => {
    const sel = document.getElementById('scan-espacio-select');
    sel.innerHTML = espaciosCache.map(e =>
      `<option value="${e.id}">${escHtml(e.nombre)}</option>`
    ).join('');
  });
}

function closeScanModal() {
  stopCamera();
  pendingOCRItems = [];
  hideModal('modal-scan');
}

function showScanPhase(phase) {
  ['camera', 'processing', 'results'].forEach(p => {
    const el = document.getElementById(`scan-phase-${p}`);
    el.classList.toggle('hidden', p !== phase);
    el.classList.toggle('flex', p === phase);
  });
}

async function startCamera() {
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    const video = document.getElementById('scan-video');
    video.srcObject = cameraStream;
  } catch (err) {
    // Sin cámara — solo mostrar la opción de subir archivo
    document.getElementById('btn-capture').style.display = 'none';
    console.warn('[Camera] No disponible:', err.message);
  }
}

function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  const video = document.getElementById('scan-video');
  if (video) video.srcObject = null;
}

function captureFrame() {
  const video = document.getElementById('scan-video');
  if (!video.readyState || video.readyState < 2) {
    showToast('Cámara no lista, espera un momento', 'warn');
    return;
  }
  const canvas = preprocessImageFromVideo(video);
  processOCR(canvas);
}

function handleFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  const img = new Image();
  const url = URL.createObjectURL(file);
  img.onload = () => {
    const canvas = preprocessImageFromImg(img);
    URL.revokeObjectURL(url);
    processOCR(canvas);
  };
  img.src = url;
}

function preprocessImageFromVideo(videoEl) {
  const maxW = 1200;
  const ratio = videoEl.videoHeight / videoEl.videoWidth || 1.5;
  const w = Math.min(videoEl.videoWidth || 800, maxW);
  const h = Math.round(w * ratio);
  return applyImageProcessing(videoEl, w, h);
}

function preprocessImageFromImg(imgEl) {
  const maxW = 1200;
  const ratio = imgEl.naturalHeight / imgEl.naturalWidth || 1.5;
  const w = Math.min(imgEl.naturalWidth || 800, maxW);
  const h = Math.round(w * ratio);
  return applyImageProcessing(imgEl, w, h);
}

function applyImageProcessing(source, w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0, w, h);

  // Escala de grises + contraste alto para mejorar lectura en tickets oscuros
  const imageData = ctx.getImageData(0, 0, w, h);
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const c = gray > 128
      ? Math.min(255, Math.round(gray * 1.45))
      : Math.max(0, Math.round(gray * 0.55));
    d[i] = d[i + 1] = d[i + 2] = c;
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

async function processOCR(canvas) {
  stopCamera();
  showScanPhase('processing');
  updateOCRProgress(0, 'Iniciando motor OCR...');

  try {
    const worker = await getOCRWorker();
    updateOCRProgress(15, 'Analizando imagen...');

    const { data: { text } } = await worker.recognize(canvas, {
      logger: (m) => {
        if (m.status === 'recognizing text') {
          updateOCRProgress(15 + Math.round(m.progress * 75), 'Reconociendo texto...');
        }
      },
    });

    updateOCRProgress(92, 'Cruzando con diccionario...');
    let items = parseTicketLines(text);
    items = await applyOCRDictionary(items);
    updateOCRProgress(100, 'Listo');

    pendingOCRItems = items;
    document.getElementById('ocr-count').textContent = items.length;
    renderOCRResults(items);
    showScanPhase('results');
  } catch (err) {
    showToast('Error en el OCR: ' + err.message, 'error');
    showScanPhase('camera');
    startCamera();
  }
}

async function getOCRWorker() {
  if (!ocrWorker) {
    updateOCRProgress(5, 'Cargando motor OCR (primera vez)...');
    await initOCRWorker();
  }
  if (!ocrWorker) throw new Error('No se pudo inicializar Tesseract');
  return ocrWorker;
}

function updateOCRProgress(pct, label) {
  const bar = document.getElementById('ocr-progress-bar');
  const lbl = document.getElementById('ocr-progress-label');
  if (bar) bar.style.width = `${pct}%`;
  if (lbl) lbl.textContent = label;
}

function parseTicketLines(rawText) {
  const lines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 2);
  const items = [];

  // Patrón: texto seguido de precio al final de línea
  const pricePattern = /(\d{1,4}[.,]\d{2})\s*[€E]?\s*$/;
  // Líneas a ignorar (cabeceras de ticket)
  const skipPatterns = /^(total|subtotal|iva|fecha|hora|ticket|cif|nif|www|tel|direc)/i;

  for (const line of lines) {
    if (skipPatterns.test(line)) continue;
    const match = line.match(pricePattern);
    if (match) {
      const priceStr = match[1].replace(',', '.');
      const price = parseFloat(priceStr);
      if (price <= 0 || price >= 500) continue; // precios anómalos

      let nombre = line.slice(0, line.lastIndexOf(match[0])).trim();
      // Limpiar cantidad inicial: "2x", "3 x", etc.
      nombre = nombre.replace(/^\d+\s*[xX×]\s*/, '').trim();
      // Limpiar caracteres OCR artefactos
      nombre = nombre.replace(/[|\\<>{}]/g, '').trim();

      if (nombre.length < 2 || nombre.length > 60) continue;

      items.push({ nombre, precio: price, cantidad: 1, rawNombre: nombre });
    }
  }

  return items;
}

async function applyOCRDictionary(items) {
  if (!items.length || !currentProfile?.hogar_id) return items;

  const { data: dict } = await supabase
    .from('ocr_learning_diccionario')
    .select('texto_sucio, nombre_corregido')
    .eq('hogar_id', currentProfile.hogar_id);

  if (!dict || !dict.length) return items;

  return items.map(item => {
    const rawLower = item.nombre.toLowerCase();
    let bestMatch = null;
    let bestSim = 0;

    for (const entry of dict) {
      const entryLower = entry.texto_sucio.toLowerCase();
      const maxLen = Math.max(rawLower.length, entryLower.length);
      if (maxLen === 0) continue;
      const dist = levenshtein(rawLower, entryLower);
      const sim = 1 - dist / maxLen;
      if (sim > 0.75 && sim > bestSim) {
        bestSim = sim;
        bestMatch = entry;
      }
    }

    if (bestMatch) {
      return { ...item, nombre: bestMatch.nombre_corregido, rawNombre: item.nombre };
    }
    return item;
  });
}

function renderOCRResults(items) {
  const container = document.getElementById('ocr-results-table');

  if (!items.length) {
    container.innerHTML = `
      <div class="text-center py-8 text-slate-500 text-sm">
        No se detectaron productos.<br>Puedes añadirlos manualmente.
      </div>`;
    return;
  }

  container.innerHTML = items.map((item, idx) => `
    <div class="bg-slate-800 rounded-xl p-3 flex items-center gap-3" id="ocr-row-${idx}">
      <div class="flex-1 flex flex-col gap-1.5">
        <input type="text" value="${escAttr(item.nombre)}"
          onchange="updateOCRItem(${idx}, 'nombre', this.value)"
          class="bg-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 w-full" />
        <div class="flex gap-2">
          <input type="number" step="0.01" value="${item.precio}"
            onchange="updateOCRItem(${idx}, 'precio', parseFloat(this.value))"
            placeholder="Precio €"
            class="bg-slate-700 rounded-lg px-3 py-1.5 text-sm focus:outline-none w-24" />
          <input type="number" min="1" value="${item.cantidad}"
            onchange="updateOCRItem(${idx}, 'cantidad', parseInt(this.value))"
            placeholder="Cant."
            class="bg-slate-700 rounded-lg px-3 py-1.5 text-sm focus:outline-none w-16" />
        </div>
      </div>
      <button onclick="removeOCRRow(${idx})" class="text-slate-600 flex-shrink-0 p-1">
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
        </svg>
      </button>
    </div>
  `).join('');
}

function updateOCRItem(idx, field, value) {
  if (pendingOCRItems[idx]) {
    pendingOCRItems[idx][field] = value;
  }
}

function addOCRRow() {
  pendingOCRItems.push({ nombre: '', precio: 0, cantidad: 1, rawNombre: '' });
  renderOCRResults(pendingOCRItems);
  document.getElementById('ocr-count').textContent = pendingOCRItems.length;
}

function removeOCRRow(idx) {
  pendingOCRItems.splice(idx, 1);
  renderOCRResults(pendingOCRItems);
  document.getElementById('ocr-count').textContent = pendingOCRItems.length;
}

function resetScan() {
  pendingOCRItems = [];
  showScanPhase('camera');
  startCamera();
}

async function confirmPurchase() {
  const espacioId = document.getElementById('scan-espacio-select').value;
  const validItems = pendingOCRItems.filter(i => i.nombre && i.nombre.trim().length > 0);

  if (!validItems.length) {
    showToast('No hay productos que confirmar', 'warn');
    return;
  }

  const btn = document.getElementById('btn-confirm-purchase');
  btn.disabled = true;
  btn.textContent = 'Guardando...';

  try {
    for (const item of validItems) {
      const nombre = item.nombre.trim();

      // Guardar aprendizaje OCR si el nombre fue corregido
      if (item.rawNombre && item.rawNombre !== nombre) {
        await saveOCRLearning(item.rawNombre, nombre);
      }

      // Detectar duplicado
      const { data: existing } = await supabase
        .from('inventario')
        .select('id, stock_actual, precio_total')
        .eq('hogar_id', currentProfile.hogar_id)
        .eq('nombre', nombre)
        .eq('espacio_id', espacioId)
        .maybeSingle();

      if (existing) {
        const action = await showDuplicateModal(nombre);
        if (action === 'sumar') {
          await supabase.from('inventario').update({
            stock_actual:  existing.stock_actual + (item.cantidad || 1),
            precio_total:  (existing.precio_total || 0) + (item.precio || 0),
            actualizado_at: new Date().toISOString(),
          }).eq('id', existing.id);
        } else {
          await supabase.from('inventario').update({
            stock_actual:  item.cantidad || 1,
            precio_total:  item.precio || 0,
            actualizado_at: new Date().toISOString(),
          }).eq('id', existing.id);
        }
      } else {
        await supabase.from('inventario').insert({
          hogar_id:       currentProfile.hogar_id,
          espacio_id:     espacioId || null,
          nombre,
          precio_total:   item.precio || 0,
          stock_actual:   item.cantidad || 1,
          stock_minimo:   1,
          fraccionado:    false,
          unidades_fraccion: 1,
          categoria_emoji: '📦',
        });
      }
    }

    showToast(`${validItems.length} producto${validItems.length > 1 ? 's' : ''} guardado${validItems.length > 1 ? 's' : ''}`, 'success');
    closeScanModal();
    navigate('inventario');
  } catch (err) {
    showToast('Error guardando productos', 'error');
    console.error(err);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Confirmar compra';
  }
}

async function saveOCRLearning(rawText, correctedName) {
  try {
    await supabase.from('ocr_learning_diccionario').upsert(
      {
        hogar_id:        currentProfile.hogar_id,
        texto_sucio:     rawText.toLowerCase().trim(),
        nombre_corregido: correctedName.trim(),
      },
      { onConflict: 'hogar_id,texto_sucio' }
    );
  } catch (e) {
    console.warn('[OCR] Learning save failed:', e);
  }
}

function showDuplicateModal(productName) {
  return new Promise(resolve => {
    duplicateResolve = resolve;
    document.getElementById('dup-product-name').textContent = productName;
    showModal('modal-duplicate');
  });
}

function resolveDuplicate(action) {
  hideModal('modal-duplicate');
  if (duplicateResolve) {
    duplicateResolve(action);
    duplicateResolve = null;
  }
}

// ─── HELPERS DE SEGURIDAD (XSS) ──────────────────────────────

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escAttr(str) {
  if (!str) return '';
  return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// ─── EMPTY STATE ─────────────────────────────────────────────

function renderEmptyState(icon, title, desc) {
  return `
    <div class="flex flex-col items-center justify-center py-20 px-8 text-center">
      <div class="text-5xl mb-4">${icon}</div>
      <h3 class="font-semibold text-lg mb-2">${title}</h3>
      <p class="text-slate-500 text-sm leading-relaxed">${desc}</p>
    </div>`;
}

// ─── BOOTSTRAP ───────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', initApp);
