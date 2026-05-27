// ===== 心流 · 个人效率系统 (重构版) =====
// 3+1 视图：今日 / 任务 / 回顾 / 设置

(function () {
  'use strict';

  // ===== STATE =====
  const STATE_KEY = 'xinliu_state';
  let state = loadStateSync();
  if (!state.lastModified && (state.tasks || []).length > 0) {
    state.lastModified = Date.now();
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  }
  let saveTimer = null;
  let serverLoaded = false;

  function defaultState() {
    return {
      tasks: [], schedule: {},
      settings: { provider: 'deepseek', baseUrl: '', apiKey: '', model: 'deepseek-chat' },
      tags: [], links: [], quotes: [], userInfo: { name: '' },
      drops: { total: 0, history: [] },
      timeBlocks: [], habits: [], habitLogs: [], taskLogs: [],
      shopItems: [], shopHistory: [],
      wakeSleep: {},
      lastDailyCheck: '', lastModified: 0,
    };
  }

  function mergeState(raw) {
    const def = defaultState();
    const merged = { ...def, ...raw, settings: { ...def.settings, ...(raw.settings || {}) } };
    ['tags','links','quotes','timeBlocks','habits','habitLogs','taskLogs','shopItems','shopHistory'].forEach(k => {
      if (!Array.isArray(merged[k])) merged[k] = def[k] || [];
    });
    if (!merged.userInfo) merged.userInfo = def.userInfo;
    if (!merged.drops) merged.drops = def.drops;
    if (!merged.lastDailyCheck) merged.lastDailyCheck = '';
    if (!merged.wakeSleep) merged.wakeSleep = {};
    merged.timeBlocks.forEach(b => {
      if (b.taskId && !b.bindType) { b.bindType = 'task'; b.bindId = b.taskId; }
    });
    migrateTasks(merged);
    return merged;
  }

  function migrateTasks(s) {
    const MAP = { vocation: 'tag-vocation', being: 'tag-being', romance: 'tag-romance' };
    (s.tasks || []).forEach(t => {
      if (t.category && !t.tags) { t.tags = MAP[t.category] ? [MAP[t.category]] : []; }
      if (t.category) delete t.category;
      if (!Array.isArray(t.tags)) t.tags = [];
    });
  }

  function loadStateSync() {
    try { const raw = localStorage.getItem(STATE_KEY); if (raw) return mergeState(JSON.parse(raw)); } catch(e) {}
    return defaultState();
  }

  // ===== SYNC =====
  let syncPollInterval = null;
  let isSaving = false;

  function setSyncStatus(status) {
    const dot = document.querySelector('.sync-dot');
    if (!dot) return;
    dot.className = 'sync-dot sync-' + status;
  }

  async function loadStateFromServer() {
    try {
      const res = await fetch('/api/data');
      if (res.ok) {
        const data = await res.json();
        if (data && (data.tasks || data.settings)) {
          const lc = (state.tasks||[]).length, sc = (data.tasks||[]).length;
          const st = data.lastModified||0, lt = state.lastModified||0;
          let useServer = lc === 0 || (sc > 0 && st > lt) || (sc >= lc && sc > 0);
          if (sc === 0 && lc > 0) useServer = false;
          if (useServer) {
            state = mergeState(data);
            if (!state.lastModified) state.lastModified = Date.now();
            localStorage.setItem(STATE_KEY, JSON.stringify(state));
          }
          loadSettingsUI(); renderActiveView(); updateDropsDisplay();
        }
      }
    } catch(e) {}
    serverLoaded = true;
    dailyMaintenance();
    startSyncPolling();
  }

  function computeStateHash() {
    const t = state.tasks||[], tg = state.tags||[], d = (state.drops||{}).total||0;
    return t.map(x=>x.id+(x.done?'1':'0')+(x.sortOrder||0)+x.name+(x.date||'')+x.quadrant+(x.note||'')+(x.tags||[]).join(',')).join('|')+'##'+tg.map(x=>x.id+x.name+x.color).join('|')+'##'+d;
  }

  async function pollServerSync() {
    if (!serverLoaded || saveTimer || isSaving) return;
    if (!document.querySelector('.modal-overlay.hidden') === false) return;
    try {
      const res = await fetch('/api/data');
      if (!res.ok) return;
      const data = await res.json();
      if (!data || typeof data !== 'object') return;
      const sc = (data.tasks||[]).length, lc = (state.tasks||[]).length;
      const st = data.lastModified||0, lt = state.lastModified||0;
      if (lc > 0 && sc === 0) {
        if (st > lt) { state = mergeState(data); localStorage.setItem(STATE_KEY, JSON.stringify(state)); renderActiveView(); updateDropsDisplay(); }
        else saveToServer();
        return;
      }
      if (st <= lt && st > 0) return;
      const serverSig = (data.tasks||[]).map(x=>x.id+(x.done?'1':'0')+(x.sortOrder||0)+(x.name||'')+(x.date||'')+(x.quadrant||'')+(x.note||'')+(x.tags||[]).join(',')).join('|')+'##'+(data.tags||[]).map(x=>x.id+x.name+x.color).join('|')+'##'+((data.drops||{}).total||0);
      if (serverSig === computeStateHash()) return;
      state = mergeState(data); localStorage.setItem(STATE_KEY, JSON.stringify(state));
      renderActiveView(); updateDropsDisplay();
    } catch(e) {}
  }

  function startSyncPolling() {
    syncPollInterval = setInterval(pollServerSync, 5000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        pollServerSync();
        if (state.lastDailyCheck !== todayKey()) { dailyMaintenance(); renderActiveView(); updateDropsDisplay(); }
      }
    });
  }

  function saveState() {
    state.lastModified = Date.now();
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    if (!serverLoaded) return;
    setSyncStatus('saving');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveToServer, 300);
  }

  async function saveToServer() {
    isSaving = true;
    try {
      const res = await fetch('/api/data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state) });
      setSyncStatus(res.ok ? 'ok' : 'offline');
    } catch(e) { setSyncStatus('offline'); }
    finally { isSaving = false; saveTimer = null; }
  }

  // ===== HELPERS =====
  function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function esc(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function todayKey() { return localDateKey(new Date()); }
  function localDateKey(d) { return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
  function getTag(id) { return (state.tags||[]).find(t => t.id === id); }
  function renderTagChips(tagIds) { return (tagIds||[]).map(id => { const t = getTag(id); return t ? `<span class="task-tag-chip" style="background:${t.color}22;color:${t.color}">${esc(t.name)}</span>` : ''; }).join(''); }
  function timeToMinutes(t) { const [h,m] = t.split(':').map(Number); return h*60+(m||0); }
  function formatDuration(mins) { const h = Math.floor(mins/60), m = mins%60; return (h>0?h+'h':'')+(m>0?m+'m':'')||'0m'; }
  function setupModalClose(ov, btn) {
    if (btn) btn.addEventListener('click', () => ov.classList.add('hidden'));
    ov.addEventListener('click', e => { if (e.target === ov) ov.classList.add('hidden'); });
  }
  function showToast(msg, type) {
    const c = document.getElementById('toast-container');
    const el = document.createElement('div'); el.className = 'toast ' + type; el.textContent = msg;
    c.appendChild(el); setTimeout(() => el.remove(), 2500);
  }

  // ===== TASK HELPERS =====
  function addTask(t) {
    const maxOrder = state.tasks.reduce((m, x) => Math.max(m, x.sortOrder || 0), -1);
    const task = {
      id: genId(), name: t.name || '未命名任务', quadrant: t.quadrant || 'important',
      tags: t.tags || [], date: t.date || todayKey(), time: t.time || '',
      duration: t.duration || 30, note: t.note || '', recurrence: t.recurrence || 'none',
      subtasks: t.subtasks || [], done: false, sortOrder: maxOrder + 1, createdAt: new Date().toISOString(),
    };
    state.tasks.push(task); saveState(); return task;
  }
  function updateTask(id, u) { const t = state.tasks.find(x => x.id === id); if (t) { Object.assign(t, u); saveState(); } }
  function deleteTask(id) { state.tasks = state.tasks.filter(x => x.id !== id); saveState(); }

  const PRIORITY_WEIGHTS = { 'urgent-important': 4, 'important': 3, 'urgent': 2, 'neither': 1 };
  const PRIORITY_LABELS = { 'urgent-important': '重要紧急', 'important': '重要', 'urgent': '紧急', 'neither': '一般' };
  const PRIORITY_COLORS = { 'urgent-important': 'var(--q1)', 'important': 'var(--q2)', 'urgent': 'var(--q3)', 'neither': 'var(--q4)' };

  function awardDrops(amount, reason) {
    if (amount <= 0) return;
    if (!state.drops) state.drops = { total: 0, history: [] };
    state.drops.total += amount;
    state.drops.history.push({ date: todayKey(), amount, reason });
    saveState(); updateDropsDisplay();
    showToast('+' + amount + ' 💧', 'success');
  }
  function updateDropsDisplay() {
    const total = (state.drops&&state.drops.total)||0;
    const els = { 'sidebar-drops-num': total, 'today-drops-num': total, 'drops-rules-total': '💧 '+total, 'shop-drops-num': total };
    Object.entries(els).forEach(([id, v]) => { const el = document.getElementById(id); if (el) el.textContent = v; });
  }

  function toggleDone(id) {
    const t = state.tasks.find(x => x.id === id); if (!t) return;
    const wasDone = t.done; t.done = !t.done; saveState();
    if (!wasDone && t.done) {
      const w = PRIORITY_WEIGHTS[t.quadrant]||1;
      const drops = Math.floor((t.duration||30)/60*w);
      if (!state.taskLogs) state.taskLogs = [];
      state.taskLogs.push({ id:'tlog-'+genId(), taskId:t.id, name:t.name, quadrant:t.quadrant, duration:t.duration||30, date:todayKey(), dropsEarned:drops });
      awardDrops(drops, '完成: '+t.name);
    }
    renderActiveView();
  }

  function formatDateShort(dateStr) {
    if (!dateStr) return '';
    const today = todayKey();
    if (dateStr === today) return '今天';
    const d = new Date(dateStr+'T00:00:00'), t2 = new Date(today+'T00:00:00');
    const diff = Math.round((d-t2)/86400000);
    if (diff===1) return '明天'; if (diff===-1) return '昨天';
    if (diff>1&&diff<=7) return diff+'天后'; if (diff<-1&&diff>=-7) return Math.abs(diff)+'天前';
    return (d.getMonth()+1)+'/'+d.getDate();
  }
  function deadlineStatus(dateStr) {
    if (!dateStr) return null;
    const diff = Math.round((new Date(dateStr+'T00:00:00')-new Date(todayKey()+'T00:00:00'))/86400000);
    if (diff<0) return 'overdue'; if (diff===0) return 'today'; if (diff===1) return 'tomorrow'; if (diff<=3) return 'soon'; return null;
  }
  function deadlineTag(status) {
    if (!status) return '';
    const c = { overdue:{text:'已逾期',bg:'rgba(239,68,68,.12)',color:'var(--red)'}, today:{text:'今天',bg:'rgba(234,179,8,.12)',color:'var(--yellow)'}, tomorrow:{text:'明天',bg:'rgba(249,115,22,.1)',color:'var(--orange)'}, soon:{text:'即将',bg:'rgba(6,182,212,.1)',color:'var(--cyan)'} }[status];
    return c ? `<span class="deadline-tag" style="background:${c.bg};color:${c.color}">${c.text}</span>` : '';
  }

  // ===== NAVIGATION =====
  const navItems = document.querySelectorAll('.nav-item[data-view]');
  const views = document.querySelectorAll('.view');
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('overlay');
  const menuToggle = document.getElementById('menu-toggle');
  const mobileTitle = document.getElementById('mobile-title');
  const bottomTabs = document.querySelectorAll('.tab-item[data-view]');
  const viewTitles = { today:'今日', tasks:'任务', review:'回顾', settings:'设置' };

  const VIEW_RENDERERS = {
    today: renderToday, tasks: renderTasks, review: renderReview,
    settings: () => { loadSettingsUI(); renderSettingsLists(); renderShop(); },
  };

  function getActiveViewName() {
    const n = document.querySelector('.nav-item.active'); return n ? n.dataset.view : 'today';
  }
  function renderActiveView() { const fn = VIEW_RENDERERS[getActiveViewName()]; if (fn) fn(); }

  function switchView(name) {
    navItems.forEach(n => n.classList.toggle('active', n.dataset.view === name));
    bottomTabs.forEach(n => n.classList.toggle('active', n.dataset.view === name));
    views.forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
    mobileTitle.textContent = viewTitles[name] || '';
    closeSidebar();
    const fn = VIEW_RENDERERS[name]; if (fn) fn();
  }

  navItems.forEach(n => n.addEventListener('click', () => switchView(n.dataset.view)));
  bottomTabs.forEach(n => n.addEventListener('click', () => switchView(n.dataset.view)));
  menuToggle.addEventListener('click', () => { sidebar.classList.add('open'); overlay.classList.add('active'); });
  function closeSidebar() { sidebar.classList.remove('open'); overlay.classList.remove('active'); }
  overlay.addEventListener('click', closeSidebar);

  // ===== LLM =====
  const PROVIDER_URLS = { openai:'https://api.openai.com/v1', deepseek:'https://api.deepseek.com/v1', qwen:'https://dashscope.aliyuncs.com/compatible-mode/v1' };
  const PROVIDER_MODELS = { openai:'gpt-4o', deepseek:'deepseek-chat', qwen:'qwen-turbo' };
  function getApiConfig() {
    const s = state.settings;
    return { base: s.provider==='custom'?s.baseUrl:(PROVIDER_URLS[s.provider]||''), key:s.apiKey, model:s.model||PROVIDER_MODELS[s.provider]||'gpt-4o' };
  }
  async function callLLM(sys, user) {
    const c = getApiConfig(); if (!c.key) throw new Error('请先配置 API Key');
    const res = await fetch(c.base+'/chat/completions', { method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+c.key}, body:JSON.stringify({model:c.model,messages:[{role:'system',content:sys},{role:'user',content:user}],temperature:0.3}) });
    if (!res.ok) throw new Error('API 错误 ('+res.status+')');
    return (await res.json()).choices[0].message.content;
  }

  // ===== DAILY MAINTENANCE =====
  function dailyMaintenance() {
    const today = todayKey(); if (state.lastDailyCheck === today) return;
    state.tasks.forEach(t => { if (t.recurrence && t.recurrence !== 'none' && t.date && t.date < today) { t.date = today; t.done = false; } });
    state.tasks = state.tasks.filter(t => !(t.done && t.date && t.date < today && (!t.recurrence || t.recurrence === 'none')));
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate()-90); const ck = localDateKey(cutoff);
    ['taskLogs','habitLogs','shopHistory'].forEach(k => { if (state[k]) state[k] = state[k].filter(l => l.date >= ck); });
    if (state.drops&&state.drops.history) state.drops.history = state.drops.history.filter(h => h.date >= ck);
    state.lastDailyCheck = today; saveState();
  }
  function scheduleMidnightRefresh() {
    const now = new Date(), tmr = new Date(now.getFullYear(),now.getMonth(),now.getDate()+1,0,0,0);
    setTimeout(() => { dailyMaintenance(); renderActiveView(); updateDropsDisplay(); scheduleMidnightRefresh(); }, tmr - now);
  }

  // ===== RENDER: TODAY VIEW =====
  /* placeholder - filled next */
  function renderToday() { renderTodayImpl(); }

  // ===== RENDER: TASKS VIEW =====
  /* placeholder - filled next */
  function renderTasks() { renderBoardFilters(); renderBoard(); }

  // ===== RENDER: REVIEW VIEW =====
  /* placeholder - filled next */
  function renderReview() { renderReviewImpl(); }

  // ===== THEME =====
  function getTheme() { return localStorage.getItem('xinliu_theme')||'dark'; }
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme); localStorage.setItem('xinliu_theme', theme);
    const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.content = theme==='light'?'#f8fafc':'#0f172a';
    document.getElementById('theme-icon-dark').style.display = theme==='dark'?'':'none';
    document.getElementById('theme-icon-light').style.display = theme==='light'?'':'none';
    document.getElementById('theme-toggle-text').textContent = theme==='dark'?'浅色模式':'深色模式';
  }
  applyTheme(getTheme());
  document.getElementById('theme-toggle-btn').addEventListener('click', () => applyTheme(getTheme()==='dark'?'light':'dark'));

  // ===== DROPS MODAL =====
  const dropsRulesOverlay = document.getElementById('drops-rules-overlay');
  document.getElementById('sidebar-drops').addEventListener('click', () => { updateDropsDisplay(); dropsRulesOverlay.classList.remove('hidden'); });
  document.getElementById('today-drops-badge').addEventListener('click', () => { updateDropsDisplay(); dropsRulesOverlay.classList.remove('hidden'); });
  setupModalClose(dropsRulesOverlay, document.getElementById('drops-rules-close'));
  const dropsHistoryList = document.getElementById('drops-history-list');
  const btnToggleDropsHistory = document.getElementById('btn-toggle-drops-history');
  btnToggleDropsHistory.addEventListener('click', () => {
    const h = dropsHistoryList.style.display === 'none';
    dropsHistoryList.style.display = h ? '' : 'none';
    btnToggleDropsHistory.textContent = h ? '收起' : '展开';
    if (h) renderDropsHistory();
  });
  function renderDropsHistory() {
    const hist = (state.drops&&state.drops.history)||[];
    dropsHistoryList.innerHTML = hist.length===0 ? '<div style="color:var(--text-muted);font-size:.8rem;padding:.5rem">暂无记录</div>' : '';
    [...hist].reverse().forEach(h => {
      const el = document.createElement('div'); el.className = 'drops-history-item';
      el.innerHTML = `<span class="dhi-date">${h.date||'-'}</span><span class="dhi-amount${h.amount<0?' negative':''}">${h.amount>0?'+':''}${h.amount}</span><span class="dhi-reason">${esc(h.reason||'')}</span>`;
      dropsHistoryList.appendChild(el);
    });
  }

  // ===== TODAY VIEW IMPL =====
  function renderTodayImpl() {
    const now = new Date(), h = now.getHours();
    const greeting = h<6?'夜深了':h<11?'早上好':h<14?'中午好':h<18?'下午好':'晚上好';
    const userName = state.userInfo&&state.userInfo.name?state.userInfo.name:'';
    document.getElementById('today-greeting').textContent = userName ? greeting+'，'+userName : greeting;
    const wd = ['周日','周一','周二','周三','周四','周五','周六'];
    document.getElementById('today-date').textContent = now.getFullYear()+'年'+(now.getMonth()+1)+'月'+now.getDate()+'日 '+wd[now.getDay()];
    updateDropsDisplay();

    const today = todayKey();
    const todayTasks = state.tasks.filter(t => t.date === today);
    const done = todayTasks.filter(t => t.done).length;
    const total = todayTasks.length;
    const pending = total - done;

    document.getElementById('progress-done').textContent = done;
    document.getElementById('stat-pending').textContent = pending;
    document.getElementById('stat-total').textContent = total;

    // Today drops earned
    const todayDrops = ((state.drops&&state.drops.history)||[]).filter(h => h.date===today&&h.amount>0).reduce((s,h)=>s+h.amount,0);
    document.getElementById('stat-drops-today').textContent = todayDrops;

    // Progress ring
    const pct = total > 0 ? done / total : 0;
    const circ = 2 * Math.PI * 52; // r=52
    document.getElementById('progress-ring-fill').style.strokeDashoffset = circ * (1 - pct);

    // Tasks
    const taskList = document.getElementById('today-task-list');
    const undone = todayTasks.filter(t => !t.done).sort((a,b)=>(a.sortOrder??999)-(b.sortOrder??999));
    const doneList = todayTasks.filter(t => t.done);
    const allSorted = [...undone, ...doneList];
    taskList.innerHTML = '';
    if (allSorted.length === 0) {
      taskList.innerHTML = '<div class="today-empty">今天没有任务。去「任务」页添加一些吧。</div>';
    }
    allSorted.forEach(t => {
      const el = document.createElement('div');
      const dlS = t.done ? null : deadlineStatus(t.date);
      el.className = 'today-task-item' + (t.done ? ' done' : '');
      el.innerHTML = `<div class="tti-checkbox ${t.done?'checked':''}" data-id="${t.id}"></div><div class="tti-prio" style="background:${PRIORITY_COLORS[t.quadrant]||'var(--q4)'}"></div><div class="tti-name">${esc(t.name)}</div><div class="tti-tags">${renderTagChips(t.tags)}</div>${t.time?'<span class="tti-time">'+t.time+'</span>':''}${dlS==='overdue'?'<span class="tti-deadline overdue">逾期</span>':''}`;
      el.querySelector('.tti-checkbox').addEventListener('click', e => { e.stopPropagation(); toggleDone(t.id); });
      el.addEventListener('click', () => openEditModal(t.id));
      taskList.appendChild(el);
    });

    // Timeblocks
    const tbList = document.getElementById('today-timeblocks');
    const blocks = (state.timeBlocks||[]).filter(b => b.date === today).sort((a,b) => a.start.localeCompare(b.start));
    tbList.innerHTML = '';
    if (blocks.length === 0) {
      tbList.innerHTML = '<div class="today-empty">暂无时间安排</div>';
    }
    blocks.forEach(b => {
      const el = document.createElement('div'); el.className = 'today-tb-item';
      const style = resolveBlockStyle(b);
      const name = resolveBlockName(b);
      el.innerHTML = `<div class="today-tb-color" style="background:${style.color}"></div><span class="today-tb-time">${b.start} - ${b.end}</span><span class="today-tb-name">${esc(name)}</span>`;
      el.addEventListener('click', () => openTimeBlockModal(b.id));
      tbList.appendChild(el);
    });

    // Habits
    const habitsGrid = document.getElementById('today-habits');
    const habits = state.habits || [];
    habitsGrid.innerHTML = '';
    if (habits.length === 0) {
      habitsGrid.innerHTML = '<div class="today-empty">暂无习惯</div>';
    }
    habits.forEach(h => {
      const logs = (state.habitLogs||[]).filter(l => l.habitId===h.id && l.date===today);
      const todayVal = logs.reduce((s,l)=>s+(l.value||0),0);
      const unit = h.type==='duration'?'h':'次';
      const el = document.createElement('div'); el.className = 'today-habit-card';
      el.innerHTML = `<div class="thc-icon">${h.icon||'🔄'}</div><div class="thc-info"><div class="thc-name">${esc(h.name)}</div><div class="thc-stat">今日 ${todayVal} ${unit}</div></div><button class="thc-btn">打卡</button>`;
      el.querySelector('.thc-btn').addEventListener('click', e => { e.stopPropagation(); openHabitLogModal(h.id); });
      el.addEventListener('click', () => openHabitEditModal(h.id));
      habitsGrid.appendChild(el);
    });
  }

  // Time block helpers
  const TB_CATEGORIES = { daily:{label:'日常',color:'#7c9a6e'}, fun:{label:'娱乐',color:'#e07a5f'}, untracked:{label:'未记录',color:'#8899a6'} };
  const TB_BIND_TYPES = { none:{label:'不关联',icon:'⊘'}, task:{label:'任务',icon:'📋'}, habit:{label:'打卡',icon:'✅'} };

  function resolveBlockStyle(block) {
    if (block.bindType === 'task' && block.bindId) {
      const t = state.tasks.find(x => x.id === block.bindId);
      if (t && t.tags && t.tags.length > 0) { const tag = getTag(t.tags[0]); if (tag) return { color: tag.color, tagLabel: tag.name }; }
    }
    if (block.bindType === 'habit' && block.bindId) {
      const h = (state.habits||[]).find(x => x.id === block.bindId);
      if (h && h.tags && h.tags.length > 0) { const tag = getTag(h.tags[0]); if (tag) return { color: tag.color, tagLabel: tag.name }; }
    }
    const cat = TB_CATEGORIES[block.category] || TB_CATEGORIES.daily;
    return { color: cat.color, tagLabel: cat.label };
  }
  function resolveBlockName(block) {
    if (block.bindType==='task'&&block.bindId) { const t = state.tasks.find(x=>x.id===block.bindId); if (t) return t.name; }
    if (block.bindType==='habit'&&block.bindId) { const h = (state.habits||[]).find(x=>x.id===block.bindId); if (h) return h.name; }
    if (block.taskId) { const t = state.tasks.find(x=>x.id===block.taskId); if (t) return t.name; }
    return block.name;
  }

  // ===== TASK BOARD =====
  let boardTagFilter = 'all';

  function renderBoardFilters() {
    const c = document.getElementById('board-filters'); c.innerHTML = '';
    const allBtn = document.createElement('button');
    allBtn.className = 'cat-filter'+(boardTagFilter==='all'?' active':'');
    allBtn.textContent = '全部';
    allBtn.addEventListener('click', () => { boardTagFilter='all'; renderBoardFilters(); renderBoard(); });
    c.appendChild(allBtn);
    (state.tags||[]).forEach(tag => {
      const btn = document.createElement('button');
      btn.className = 'cat-filter'+(boardTagFilter===tag.id?' active':'');
      btn.innerHTML = `<span class="cat-dot" style="background:${tag.color}"></span>${esc(tag.name)}`;
      btn.addEventListener('click', () => { boardTagFilter=tag.id; renderBoardFilters(); renderBoard(); });
      c.appendChild(btn);
    });
  }

  // Drag state
  let dragSrcId = null;
  function handleDragStart(e) { dragSrcId=this.dataset.id; this.classList.add('dragging'); e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain',dragSrcId); }
  function handleDragOver(e) { e.preventDefault(); e.dataTransfer.dropEffect='move'; const c=this.closest('.task-card'); if(c&&c.dataset.id!==dragSrcId)c.classList.add('drag-over'); }
  function handleDragLeave() { this.classList.remove('drag-over'); }
  function handleDrop(e) {
    e.preventDefault(); this.classList.remove('drag-over');
    const tid=this.closest('.task-card')?.dataset.id; if(!tid||tid===dragSrcId) return;
    const si=state.tasks.findIndex(t=>t.id===dragSrcId), ti=state.tasks.findIndex(t=>t.id===tid);
    if(si===-1||ti===-1) return;
    const [m]=state.tasks.splice(si,1); state.tasks.splice(ti,0,m);
    state.tasks.forEach((t,i)=>t.sortOrder=i); saveState(); renderBoard();
  }
  function handleDragEnd() { this.classList.remove('dragging'); document.querySelectorAll('.drag-over').forEach(el=>el.classList.remove('drag-over')); dragSrcId=null; }

  // Touch drag
  let touchDragCard=null,touchDragId=null,touchStartY=0,touchStartX=0,touchClone=null,touchDragging=false;
  function handleTouchStart(e) {
    const handle=e.target.closest('.drag-handle'); if(!handle) return;
    const card=handle.closest('.task-card'); if(!card||card.classList.contains('done')) return;
    e.preventDefault(); touchStartY=e.touches[0].clientY; touchStartX=e.touches[0].clientX; touchDragCard=card; touchDragId=card.dataset.id; touchDragging=false;
  }
  function handleTouchMove(e) {
    if(!touchDragCard) return; const t=e.touches[0], dy=Math.abs(t.clientY-touchStartY), dx=Math.abs(t.clientX-touchStartX);
    if(!touchDragging&&(dy>10||dx>10)){touchDragging=true;touchDragCard.classList.add('dragging');touchClone=touchDragCard.cloneNode(true);touchClone.classList.add('touch-drag-clone');touchClone.style.cssText='position:fixed;width:'+touchDragCard.offsetWidth+'px;z-index:1000;pointer-events:none;opacity:.85;box-shadow:0 8px 25px rgba(0,0,0,.3);transform:scale(1.02)';document.body.appendChild(touchClone);}
    if(!touchDragging) return; e.preventDefault();
    if(touchClone){touchClone.style.left='1rem';touchClone.style.right='1rem';touchClone.style.top=(t.clientY-touchDragCard.offsetHeight/2)+'px';}
    if(touchClone)touchClone.style.display='none';const below=document.elementFromPoint(t.clientX,t.clientY);if(touchClone)touchClone.style.display='';
    document.querySelectorAll('.drag-over').forEach(el=>el.classList.remove('drag-over'));
    if(below){const tc=below.closest('.task-card');if(tc&&tc.dataset.id!==touchDragId&&!tc.classList.contains('done'))tc.classList.add('drag-over');}
  }
  function handleTouchEnd() {
    if(!touchDragCard) return;
    if(touchDragging){const oc=document.querySelector('.task-card.drag-over');if(oc){const ti=oc.dataset.id,si=state.tasks.findIndex(t=>t.id===touchDragId),tii=state.tasks.findIndex(t=>t.id===ti);if(si!==-1&&tii!==-1){const[m]=state.tasks.splice(si,1);state.tasks.splice(tii,0,m);state.tasks.forEach((t,i)=>t.sortOrder=i);saveState();}}}
    if(touchClone){touchClone.remove();touchClone=null;}if(touchDragCard)touchDragCard.classList.remove('dragging');document.querySelectorAll('.drag-over').forEach(el=>el.classList.remove('drag-over'));touchDragCard=null;touchDragId=null;touchDragging=false;renderBoard();
  }
  document.addEventListener('touchmove', handleTouchMove, {passive:false});
  document.addEventListener('touchend', handleTouchEnd);

  function renderBoard() {
    const list = document.getElementById('board-list');
    let tasks = [...state.tasks];
    if (boardTagFilter !== 'all') tasks = tasks.filter(t => (t.tags||[]).includes(boardTagFilter));
    tasks.sort((a,b) => { if(a.done!==b.done) return a.done?1:-1; return (a.sortOrder??999)-(b.sortOrder??999); });
    list.innerHTML = '';
    if (tasks.length === 0) { list.innerHTML = '<div style="color:var(--text-muted);padding:1.5rem;text-align:center;font-size:.85rem">暂无任务</div>'; return; }
    tasks.forEach(t => {
      const card = document.createElement('div');
      const dlS = t.done ? null : deadlineStatus(t.date);
      card.className = 'task-card'+(t.done?' done':'')+(dlS==='overdue'?' card-overdue':dlS==='today'?' card-today':'');
      card.dataset.id = t.id; card.draggable = !t.done;
      const tags = renderTagChips(t.tags), dateL = formatDateShort(t.date), timeL = t.time||'';
      const recIcon = t.recurrence==='daily'?' 🔄':t.recurrence==='weekly'?' 🔁':'';
      const prioL = PRIORITY_LABELS[t.quadrant]||'一般', prioC = PRIORITY_COLORS[t.quadrant]||'var(--q4)';
      let subTag = '';
      if (t.subtasks&&t.subtasks.length>0) { const dc=t.subtasks.filter(s=>s.done).length; subTag=`<span class="task-meta-tag" style="color:var(--accent)">✓ ${dc}/${t.subtasks.length}</span>`; }
      card.innerHTML = `<div class="task-card-top"><div class="drag-handle" title="拖拽排序">⁞</div><div class="task-checkbox ${t.done?'checked':''}" data-id="${t.id}"></div><div class="task-card-name">${esc(t.name)}${recIcon}</div>${deadlineTag(dlS)}<span class="task-prio-tag" style="background:${prioC}22;color:${prioC};border:1px solid ${prioC}44">${prioL}</span></div><div class="task-card-meta">${tags}${dateL?'<span class="task-date-tag">'+dateL+'</span>':''}${timeL?'<span class="task-date-tag">'+timeL+'</span>':''}<span class="task-meta-tag"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>${t.duration}分</span>${subTag}</div>`;
      card.addEventListener('dragstart', handleDragStart);
      card.addEventListener('dragover', handleDragOver);
      card.addEventListener('dragleave', handleDragLeave);
      card.addEventListener('drop', handleDrop);
      card.addEventListener('dragend', handleDragEnd);
      card.addEventListener('touchstart', handleTouchStart, {passive:false});
      card.addEventListener('click', e => { if(e.target.classList.contains('task-checkbox')){toggleDone(t.id);return;} if(e.target.classList.contains('drag-handle'))return; openEditModal(t.id); });
      list.appendChild(card);
    });
  }

  // ===== QUICK ADD =====
  const quickAddInput = document.getElementById('quick-add-input');
  document.getElementById('btn-quick-add').addEventListener('click', () => {
    const v = quickAddInput.value.trim(); if (!v) return;
    addTask({name:v}); quickAddInput.value = ''; renderTasks();
  });
  quickAddInput.addEventListener('keydown', e => { if(e.key==='Enter'){e.preventDefault(); document.getElementById('btn-quick-add').click();} });

  // ===== DUMP =====
  const dumpPanel = document.getElementById('dump-panel');
  const dumpBody = document.getElementById('dump-body');
  document.getElementById('dump-toggle').addEventListener('click', () => {
    const open = dumpBody.style.display !== 'none';
    dumpBody.style.display = open ? 'none' : '';
    dumpPanel.classList.toggle('open', !open);
  });
  document.getElementById('btn-analyze').addEventListener('click', async () => {
    const text = document.getElementById('dump-input').value.trim(); if (!text) return;
    const btn = document.getElementById('btn-analyze'); btn.disabled = true;
    document.getElementById('ai-loading').classList.remove('hidden');
    const tagsList = (state.tags||[]).map(t => `"${t.id}" (${t.name})`).join(', ');
    const sys = `你是任务分析助手。当前日期 ${todayKey()}。从用户文字中提取任务。可用标签ID: ${tagsList}。返回JSON数组：[{"name":"","quadrant":"important","tags":[],"date":"YYYY-MM-DD","time":"","duration":30,"note":"","recurrence":"none","subtasks":[{"name":"","done":false}]}]`;
    try {
      const raw = await callLLM(sys, text);
      const m = raw.match(/\[[\s\S]*\]/); if (!m) throw new Error('格式异常');
      JSON.parse(m[0]).forEach(t => addTask(t));
      document.getElementById('dump-input').value = '';
      dumpBody.style.display = 'none'; dumpPanel.classList.remove('open');
      renderBoard();
    } catch(e) { alert('分析失败：'+e.message); }
    finally { btn.disabled = false; document.getElementById('ai-loading').classList.add('hidden'); }
  });
  document.getElementById('btn-add-manual').addEventListener('click', () => {
    const text = document.getElementById('dump-input').value.trim();
    if (!text) { openAddModal(); return; }
    text.split(/\n/).map(l=>l.replace(/^[-*·•\d.、]+\s*/,'').trim()).filter(Boolean).forEach(name => addTask({name}));
    document.getElementById('dump-input').value = ''; renderBoard();
  });

  // ===== EDIT MODAL =====
  const modalOverlay = document.getElementById('modal-overlay');
  const editName=document.getElementById('edit-task-name'), editQuadrant=document.getElementById('edit-task-quadrant'),
    editRecurrence=document.getElementById('edit-task-recurrence'), editDate=document.getElementById('edit-task-date'),
    editTime=document.getElementById('edit-task-time'), editDuration=document.getElementById('edit-task-duration'),
    editNote=document.getElementById('edit-task-note'), editSubtasksList=document.getElementById('edit-subtasks-list'),
    editNewSubtask=document.getElementById('edit-new-subtask'), editTagsContainer=document.getElementById('edit-task-tags');
  let editingTaskId=null, currentSubtasks=[], selectedTags=[];

  function renderEditTags() {
    editTagsContainer.innerHTML = '';
    (state.tags||[]).forEach(tag => {
      const chip = document.createElement('span');
      chip.className = 'tag-chip'+(selectedTags.includes(tag.id)?' selected':'');
      chip.style.cssText = 'background:'+tag.color+'22;color:'+tag.color;
      chip.textContent = tag.name;
      chip.addEventListener('click', () => { const i=selectedTags.indexOf(tag.id); if(i>=0)selectedTags.splice(i,1);else selectedTags.push(tag.id); renderEditTags(); });
      editTagsContainer.appendChild(chip);
    });
  }
  function renderSubtasks() {
    editSubtasksList.innerHTML = '';
    currentSubtasks.forEach((st,idx) => {
      const el = document.createElement('div'); el.className = 'subtask-item'+(st.done?' done':'');
      el.innerHTML = `<div class="subtask-checkbox ${st.done?'checked':''}"></div><div class="subtask-name">${esc(st.name)}</div><div class="subtask-remove">&times;</div>`;
      el.querySelector('.subtask-checkbox').addEventListener('click', ()=>{st.done=!st.done;renderSubtasks();});
      el.querySelector('.subtask-remove').addEventListener('click', ()=>{currentSubtasks.splice(idx,1);renderSubtasks();});
      editSubtasksList.appendChild(el);
    });
  }
  function handleAddSubtask() { const v=editNewSubtask.value.trim(); if(v){currentSubtasks.push({name:v,done:false});editNewSubtask.value='';renderSubtasks();} }
  document.getElementById('btn-add-subtask').addEventListener('click', handleAddSubtask);
  editNewSubtask.addEventListener('keydown', e=>{if(e.key==='Enter'){e.preventDefault();handleAddSubtask();}});

  function openEditModal(id) {
    const t = state.tasks.find(x=>x.id===id); if(!t) return;
    editingTaskId=id; document.getElementById('modal-title').textContent='编辑任务';
    document.getElementById('btn-modal-delete').style.display='';
    editName.value=t.name; selectedTags=[...(t.tags||[])]; renderEditTags();
    editQuadrant.value=t.quadrant; editRecurrence.value=t.recurrence||'none';
    editDate.value=t.date||todayKey(); editTime.value=t.time||'';
    editDuration.value=t.duration; editNote.value=t.note||'';
    currentSubtasks=JSON.parse(JSON.stringify(t.subtasks||[])); renderSubtasks();
    modalOverlay.classList.remove('hidden');
  }
  function openAddModal() {
    editingTaskId=null; document.getElementById('modal-title').textContent='添加任务';
    document.getElementById('btn-modal-delete').style.display='none';
    editName.value=''; selectedTags=[]; renderEditTags();
    editQuadrant.value='important'; editRecurrence.value='none';
    editDate.value=todayKey(); editTime.value=''; editDuration.value=30; editNote.value='';
    currentSubtasks=[]; renderSubtasks();
    modalOverlay.classList.remove('hidden'); editName.focus();
  }
  setupModalClose(modalOverlay, document.getElementById('modal-close'));
  document.getElementById('btn-modal-save').addEventListener('click', () => {
    const data = { name:editName.value.trim()||'未命名任务', tags:[...selectedTags], quadrant:editQuadrant.value, recurrence:editRecurrence.value, date:editDate.value||todayKey(), time:editTime.value||'', duration:parseInt(editDuration.value)||30, note:editNote.value.trim(), subtasks:currentSubtasks };
    if(editingTaskId) updateTask(editingTaskId, data); else addTask(data);
    modalOverlay.classList.add('hidden'); renderActiveView();
  });
  document.getElementById('btn-modal-delete').addEventListener('click', () => {
    if(!editingTaskId) return;
    if(confirm('确定删除？')){deleteTask(editingTaskId);modalOverlay.classList.add('hidden');renderActiveView();}
  });

  // ===== HABITS =====
  let editingHabitId=null, loggingHabitId=null;
  const habitModalOverlay=document.getElementById('habit-modal-overlay'), habitLogOverlay=document.getElementById('habit-log-overlay');

  function openHabitEditModal(id) {
    editingHabitId=id; const h=id?(state.habits||[]).find(x=>x.id===id):null;
    document.getElementById('habit-modal-title').textContent=h?'编辑习惯':'添加习惯';
    document.getElementById('btn-habit-delete').style.display=h?'':'none';
    document.getElementById('habit-edit-name').value=h?h.name:'';
    document.getElementById('habit-edit-type').value=h?h.type:'duration';
    document.getElementById('habit-edit-icon').value=h?h.icon:'';
    document.getElementById('habit-edit-drops').value=h?h.dropsPerUnit:2;
    const sel=document.getElementById('habit-tag-selector'); sel.innerHTML='';
    const sTags=h?(h.tags||[]):[];
    (state.tags||[]).forEach(tag=>{const c=document.createElement('span');c.className='tag-chip'+(sTags.includes(tag.id)?' selected':'');c.style.cssText='background:'+tag.color+'22;color:'+tag.color;c.textContent=tag.name;c.dataset.tagId=tag.id;c.addEventListener('click',()=>c.classList.toggle('selected'));sel.appendChild(c);});
    habitModalOverlay.classList.remove('hidden');
  }
  setupModalClose(habitModalOverlay, document.getElementById('habit-modal-close'));
  document.getElementById('btn-habit-save').addEventListener('click', () => {
    const name=document.getElementById('habit-edit-name').value.trim(); if(!name){alert('请输入名称');return;}
    const type=document.getElementById('habit-edit-type').value;
    const icon=document.getElementById('habit-edit-icon').value.trim()||'🔄';
    const dropsPerUnit=parseInt(document.getElementById('habit-edit-drops').value)||2;
    const tags=Array.from(document.querySelectorAll('#habit-tag-selector .tag-chip.selected')).map(el=>el.dataset.tagId);
    if(!state.habits) state.habits=[];
    if(editingHabitId){const h=(state.habits).find(x=>x.id===editingHabitId);if(h){h.name=name;h.type=type;h.icon=icon;h.dropsPerUnit=dropsPerUnit;h.tags=tags;}}
    else state.habits.push({id:'habit-'+genId(),name,type,icon,dropsPerUnit,tags,createdAt:new Date().toISOString()});
    saveState(); habitModalOverlay.classList.add('hidden'); renderActiveView();
  });
  document.getElementById('btn-habit-delete').addEventListener('click', () => {
    if(!editingHabitId) return;
    if(confirm('删除此习惯？')){state.habits=(state.habits||[]).filter(h=>h.id!==editingHabitId);saveState();habitModalOverlay.classList.add('hidden');renderActiveView();}
  });
  document.getElementById('btn-add-habit-today').addEventListener('click', () => openHabitEditModal(null));

  function openHabitLogModal(id) {
    loggingHabitId=id; const h=(state.habits||[]).find(x=>x.id===id); if(!h) return;
    document.getElementById('habit-log-title').textContent=h.icon+' '+h.name;
    document.getElementById('habit-log-label').textContent=h.type==='duration'?'时长 (h)':'次数';
    document.getElementById('habit-log-value').value=1; updateHabitLogPreview();
    habitLogOverlay.classList.remove('hidden');
  }
  function updateHabitLogPreview() {
    const h=(state.habits||[]).find(x=>x.id===loggingHabitId); if(!h) return;
    const v=parseFloat(document.getElementById('habit-log-value').value)||0;
    const drops=h.type==='duration'?Math.max(v>0?1:0,Math.floor(v*h.dropsPerUnit)):Math.floor(v)*h.dropsPerUnit;
    document.getElementById('habit-log-drops-preview').textContent='预计 💧 '+drops;
  }
  document.getElementById('habit-log-value').addEventListener('input', updateHabitLogPreview);
  setupModalClose(habitLogOverlay, document.getElementById('habit-log-close'));
  document.getElementById('btn-habit-log-save').addEventListener('click', () => {
    const h=(state.habits||[]).find(x=>x.id===loggingHabitId); if(!h) return;
    const v=parseFloat(document.getElementById('habit-log-value').value)||0; if(v<=0){alert('请输入有效数值');return;}
    const drops=h.type==='duration'?Math.max(v>0?1:0,Math.floor(v*h.dropsPerUnit)):Math.floor(v)*h.dropsPerUnit;
    if(!state.habitLogs) state.habitLogs=[];
    state.habitLogs.push({id:'hlog-'+genId(),habitId:h.id,date:todayKey(),value:v,dropsEarned:drops});
    if(drops>0) awardDrops(drops, '习惯: '+h.name);
    saveState(); habitLogOverlay.classList.add('hidden'); renderActiveView();
    showToast(h.icon+' +'+drops+' 💧', 'success');
  });

  // ===== TIME BLOCK MODAL =====
  const tbModalOverlay = document.getElementById('tb-modal-overlay');
  let tbEditingId = null;
  let tbFormBind = { category:'daily', bindType:'none', bindId:null };
  setupModalClose(tbModalOverlay, document.getElementById('tb-modal-close'));

  document.getElementById('btn-add-timeblock-today').addEventListener('click', () => openTimeBlockModal(null));

  function openTimeBlockModal(blockId, preStart, preEnd) {
    if(blockId){
      const b=(state.timeBlocks||[]).find(x=>x.id===blockId); if(!b) return;
      tbEditingId=blockId; document.getElementById('tb-modal-title').textContent='编辑时间块';
      document.getElementById('tb-edit-name').value=b.name;
      document.getElementById('tb-edit-start').value=b.start;
      document.getElementById('tb-edit-end').value=b.end;
      document.getElementById('tb-modal-delete').style.display='';
      tbFormBind={category:b.category||'daily',bindType:b.bindType||'none',bindId:b.bindId||null};
    } else {
      tbEditingId=null; document.getElementById('tb-modal-title').textContent='添加时间块';
      document.getElementById('tb-edit-name').value='';
      document.getElementById('tb-edit-start').value=preStart||'09:00';
      document.getElementById('tb-edit-end').value=preEnd||'10:00';
      document.getElementById('tb-modal-delete').style.display='none';
      tbFormBind={category:'daily',bindType:'none',bindId:null};
    }
    renderTbBindChips(); renderTbCatChips(); renderTbBindTargets(); updateTbVis();
    tbModalOverlay.classList.remove('hidden');
  }

  function renderTbCatChips(){const c=document.getElementById('tb-cat-chips');c.innerHTML='';['daily','fun'].forEach(k=>{const cat=TB_CATEGORIES[k];const ch=document.createElement('span');ch.className='tb-chip'+(tbFormBind.category===k?' selected':'');ch.innerHTML=`<span class="tb-chip-dot" style="background:${cat.color}"></span>${cat.label}`;ch.addEventListener('click',()=>{tbFormBind.category=k;renderTbCatChips();});c.appendChild(ch);});}
  function renderTbBindChips(){const c=document.getElementById('tb-bind-chips');c.innerHTML='';Object.entries(TB_BIND_TYPES).forEach(([k,bt])=>{const ch=document.createElement('span');ch.className='tb-chip'+(tbFormBind.bindType===k?' selected':'');ch.textContent=bt.icon+' '+bt.label;ch.addEventListener('click',()=>{tbFormBind.bindType=k;tbFormBind.bindId=null;renderTbBindChips();renderTbBindTargets();updateTbVis();});c.appendChild(ch);});}
  function renderTbBindTargets(){
    const list=document.getElementById('tb-bind-target-list'); list.innerHTML='';
    if(tbFormBind.bindType==='none') return;
    const isTask=tbFormBind.bindType==='task';
    document.getElementById('tb-bind-target-label').textContent=isTask?'选择任务':'选择习惯';
    const items=isTask?state.tasks.filter(t=>!t.done):(state.habits||[]);
    if(items.length===0){list.innerHTML='<div style="color:var(--text-muted);font-size:.8rem;padding:.4rem">无可选项</div>';return;}
    items.forEach(item=>{const el=document.createElement('div');el.className='tb-bind-target-item'+(tbFormBind.bindId===item.id?' selected':'');el.innerHTML=`<span class="tbti-icon">${isTask?'📋':(item.icon||'🔄')}</span><span class="tbti-name">${esc(item.name)}</span>`;el.addEventListener('click',()=>{tbFormBind.bindId=item.id;renderTbBindTargets();});list.appendChild(el);});
  }
  function updateTbVis(){const bound=tbFormBind.bindType!=='none';document.getElementById('tb-cat-row').style.display=bound?'none':'';document.getElementById('tb-name-row').style.display=bound?'none':'';document.getElementById('tb-bind-target-row').style.display=bound?'':'none';}

  document.getElementById('tb-modal-save').addEventListener('click', () => {
    let name=document.getElementById('tb-edit-name').value.trim();
    const start=document.getElementById('tb-edit-start').value, end=document.getElementById('tb-edit-end').value;
    const {category,bindType,bindId}=tbFormBind;
    if(bindType==='task'&&bindId){const t=state.tasks.find(x=>x.id===bindId);if(t)name=t.name;}
    else if(bindType==='habit'&&bindId){const h=(state.habits||[]).find(x=>x.id===bindId);if(h)name=h.name;}
    if(!name){alert('请输入名称或关联目标');return;} if(!start||!end){alert('请填写时间');return;}
    if(timeToMinutes(end)<=timeToMinutes(start)){alert('结束时间须晚于开始');return;}
    const fbt=bindType!=='none'&&!bindId?'none':bindType, fbi=fbt==='none'?null:bindId;
    if(tbEditingId){const b=(state.timeBlocks||[]).find(x=>x.id===tbEditingId);if(b)Object.assign(b,{name,category:category||'daily',bindType:fbt,bindId:fbi,start,end});}
    else{if(!state.timeBlocks)state.timeBlocks=[];state.timeBlocks.push({id:genId(),date:todayKey(),name,category:category||'daily',bindType:fbt,bindId:fbi,start,end});}
    saveState(); tbModalOverlay.classList.add('hidden'); renderActiveView();
  });
  document.getElementById('tb-modal-delete').addEventListener('click', () => {
    if(!tbEditingId) return; if(confirm('删除？')){state.timeBlocks=(state.timeBlocks||[]).filter(b=>b.id!==tbEditingId);saveState();tbModalOverlay.classList.add('hidden');renderActiveView();}
  });

  // ===== REVIEW VIEW =====
  function renderReviewImpl() {
    // Stats
    const today = todayKey(), days = 7;
    const start = new Date(); start.setDate(start.getDate()-(days-1)); const startKey = localDateKey(start);
    const tl = (state.taskLogs||[]).filter(l=>l.date>=startKey&&l.date<=today);
    const hl = (state.habitLogs||[]).filter(l=>l.date>=startKey&&l.date<=today);
    const de = ((state.drops&&state.drops.history)||[]).filter(h=>h.date>=startKey&&h.date<=today&&h.amount>0).reduce((s,h)=>s+h.amount,0);
    const statsDiv = document.getElementById('review-stats');
    statsDiv.innerHTML = `<div class="review-stat-card"><div class="review-stat-num">${tl.length}</div><div class="review-stat-label">完成任务</div></div><div class="review-stat-card"><div class="review-stat-num">${hl.length}</div><div class="review-stat-label">习惯打卡</div></div><div class="review-stat-card review-stat-accent"><div class="review-stat-num">${de}</div><div class="review-stat-label">获得水滴</div></div>`;

    // Week grid
    const weekGrid = document.getElementById('review-week-grid');
    const todayDate = new Date(today+'T00:00:00');
    const dayOfWeek = todayDate.getDay();
    const weekStart = new Date(todayDate); weekStart.setDate(weekStart.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
    const weekNames = ['日','一','二','三','四','五','六'];
    let whtml = '';
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart); d.setDate(d.getDate()+i);
      const key = localDateKey(d), isToday = key===today, isWe = d.getDay()===0||d.getDay()===6;
      const dayTasks = state.tasks.filter(t => t.date===key);
      whtml += `<div class="week-col${isToday?' today':''}${isWe?' weekend':''}">`;
      whtml += `<div class="week-hd"><span class="week-wd">周${weekNames[d.getDay()]}</span><span class="week-dd">${d.getDate()}</span></div>`;
      whtml += '<div class="week-chips">';
      if(dayTasks.length===0) whtml += '<div style="flex:1"></div>';
      dayTasks.forEach(t=>{
        const tag = (t.tags||[]).length>0?getTag(t.tags[0]):null;
        const c = tag?tag.color:'#64748b';
        const sn = t.name.length>4?t.name.slice(0,4)+'..':t.name;
        whtml += `<div class="week-chip${t.done?' done':''}" style="background:${c}" title="${esc(t.name)}">${esc(sn)}</div>`;
      });
      whtml += '</div></div>';
    }
    weekGrid.innerHTML = whtml;
  }

  // Summary
  document.getElementById('summary-range').addEventListener('change', function(){
    document.getElementById('summary-range-custom').style.display = this.value==='custom'?'':'none';
  });
  function getSummaryDays(){ const s=document.getElementById('summary-range'); return s.value==='custom'?Math.max(1,Math.min(90,parseInt(document.getElementById('summary-range-custom').value)||7)):parseInt(s.value)||7; }

  function buildSummaryContext(days) {
    const today = todayKey(); const start = new Date(); start.setDate(start.getDate()-(days-1)); const sk = localDateKey(start);
    const tl = (state.taskLogs||[]).filter(l=>l.date>=sk&&l.date<=today);
    const hl = (state.habitLogs||[]).filter(l=>l.date>=sk&&l.date<=today);
    const pending = state.tasks.filter(t=>!t.done&&t.date&&t.date>=sk&&t.date<=today);
    let ctx = `范围: ${sk} ~ ${today}\n完成任务: ${tl.length}\n`;
    tl.forEach(l=>{ctx+=`  - ${l.name} (${PRIORITY_LABELS[l.quadrant]||'一般'},${l.duration}分,+${l.dropsEarned}💧)\n`;});
    ctx += `待完成: ${pending.length}\n`;
    pending.forEach(t=>{ctx+=`  - ${t.name} (截止:${t.date})\n`;});
    ctx += `习惯打卡: ${hl.length}次\n`;
    ctx += `水滴余额: ${(state.drops&&state.drops.total)||0}\n`;
    return ctx;
  }
  function buildSummaryTemplate(days) {
    const today = todayKey(); const start = new Date(); start.setDate(start.getDate()-(days-1)); const sk = localDateKey(start);
    const tl = (state.taskLogs||[]).filter(l=>l.date>=sk&&l.date<=today);
    const hl = (state.habitLogs||[]).filter(l=>l.date>=sk&&l.date<=today);
    const de = ((state.drops&&state.drops.history)||[]).filter(h=>h.date>=sk&&h.date<=today&&h.amount>0).reduce((s,h)=>s+h.amount,0);
    let html = `<div class="summary-section"><h4>📊 概览 (${sk} ~ ${today})</h4><ul>`;
    html += `<li>完成: <strong>${tl.length}</strong> 个任务</li><li>打卡: <strong>${hl.length}</strong> 次</li><li>水滴: <strong style="color:var(--cyan)">${de}</strong></li></ul></div>`;
    if(tl.length>0){html+='<div class="summary-section"><h4>✅ 已完成</h4><ul>';tl.forEach(l=>{html+=`<li>${esc(l.name)} <span style="color:var(--text-muted)">(${l.duration}分,+${l.dropsEarned}💧)</span></li>`;});html+='</ul></div>';}
    return html;
  }

  let lastSummaryText = '';
  document.getElementById('btn-generate-summary').addEventListener('click', async () => {
    const days = getSummaryDays();
    const btn = document.getElementById('btn-generate-summary'); btn.disabled = true;
    document.getElementById('summary-loading').classList.remove('hidden');
    document.getElementById('summary-result').style.display = 'none';
    const tmpl = buildSummaryTemplate(days);
    try {
      const ctx = buildSummaryContext(days);
      const sys = '你是效率系统总结助手。根据数据生成简洁总结。包含：1.亮点 2.问题 3.建议(2-3条)。250字以内，不用markdown标题。';
      const ai = await callLLM(sys, ctx); lastSummaryText = ai;
      document.getElementById('summary-content').innerHTML = tmpl + `<div class="summary-ai-insight"><strong>💡 AI 洞察</strong><br><br>${esc(ai)}</div>`;
    } catch(e) {
      lastSummaryText = '';
      document.getElementById('summary-content').innerHTML = tmpl + `<div class="summary-ai-insight" style="border-color:rgba(239,68,68,.2);background:rgba(239,68,68,.06)"><strong>AI 失败</strong><br>${esc(e.message)}</div>`;
    } finally { btn.disabled=false; document.getElementById('summary-loading').classList.add('hidden'); document.getElementById('summary-result').style.display=''; }
  });
  document.getElementById('btn-download-summary').addEventListener('click', () => {
    const days = getSummaryDays(), today = todayKey();
    let text = '心流 · 总结报告\n'+buildSummaryContext(days);
    if(lastSummaryText) text += '\nAI 洞察:\n'+lastSummaryText;
    const blob = new Blob([text],{type:'text/plain;charset=utf-8'}), url=URL.createObjectURL(blob);
    const a=document.createElement('a'); a.href=url; a.download='xinliu_'+today+'.txt'; a.click();
    setTimeout(()=>URL.revokeObjectURL(url),200);
  });

  // ===== SETTINGS =====
  const providerSelect=document.getElementById('llm-provider'), customUrlRow=document.getElementById('custom-url-row'),
    baseUrlInput=document.getElementById('llm-base-url'), apiKeyInput=document.getElementById('llm-api-key'),
    modelInput=document.getElementById('llm-model'), userNameInput=document.getElementById('setting-user-name');

  function loadSettingsUI(){
    providerSelect.value=state.settings.provider||'deepseek';
    baseUrlInput.value=state.settings.baseUrl||''; apiKeyInput.value=state.settings.apiKey||'';
    modelInput.value=state.settings.model||''; customUrlRow.style.display=providerSelect.value==='custom'?'':'none';
    if(!modelInput.value) modelInput.value=PROVIDER_MODELS[providerSelect.value]||'';
    userNameInput.value=(state.userInfo&&state.userInfo.name)||'';
  }
  providerSelect.addEventListener('change', ()=>{customUrlRow.style.display=providerSelect.value==='custom'?'':'none';modelInput.value=PROVIDER_MODELS[providerSelect.value]||modelInput.value;saveSettings();});
  let settingsSaveTimer=null;
  function saveSettings(){
    state.settings.provider=providerSelect.value;state.settings.baseUrl=baseUrlInput.value.trim().replace(/\/+$/,'');
    state.settings.apiKey=apiKeyInput.value.trim();state.settings.model=modelInput.value.trim();
    if(!state.userInfo)state.userInfo={};state.userInfo.name=userNameInput.value.trim();
    clearTimeout(settingsSaveTimer);settingsSaveTimer=setTimeout(()=>saveState(),600);
  }
  [apiKeyInput,baseUrlInput,modelInput,userNameInput].forEach(el=>{el.addEventListener('change',saveSettings);el.addEventListener('input',saveSettings);});
  document.getElementById('btn-toggle-key').addEventListener('click',()=>{apiKeyInput.type=apiKeyInput.type==='password'?'text':'password';});
  document.getElementById('btn-test-ai').addEventListener('click', async()=>{
    saveSettings();const r=document.getElementById('ai-test-result');r.textContent='测试中...';r.className='test-result';
    try{const reply=await callLLM('你是助手。','回复"连接成功"。');r.textContent='✓ '+reply.slice(0,50);r.className='test-result success';}
    catch(e){r.textContent='✗ '+e.message;r.className='test-result error';}
  });

  function renderSettingsLists(){ renderTagSettings(); }
  function renderTagSettings(){
    const c=document.getElementById('tag-manager-list');c.innerHTML='';
    (state.tags||[]).forEach((tag,idx)=>{
      const el=document.createElement('div');el.className='setting-list-item';
      el.innerHTML=`<input type="color" class="sli-color-picker" value="${tag.color}" title="颜色"><span class="sli-label">${esc(tag.name)}</span><span class="sli-remove">&times;</span>`;
      el.querySelector('.sli-color-picker').addEventListener('change',e=>{tag.color=e.target.value;saveState();renderActiveView();});
      el.querySelector('.sli-remove').addEventListener('click',()=>{if(!confirm('删除标签 "'+tag.name+'"？'))return;const tid=tag.id;state.tags.splice(idx,1);state.tasks.forEach(t=>{if(t.tags)t.tags=t.tags.filter(id=>id!==tid);});saveState();renderTagSettings();});
      c.appendChild(el);
    });
  }
  document.getElementById('btn-add-tag').addEventListener('click',()=>{
    const ni=document.getElementById('tag-new-name'),ci=document.getElementById('tag-new-color');
    const name=ni.value.trim();if(!name)return;
    state.tags.push({id:'tag-'+genId(),name,color:ci.value});saveState();ni.value='';renderTagSettings();
  });

  // ===== SHOP =====
  function renderShop(){
    const grid=document.getElementById('shop-grid'),hist=document.getElementById('shop-history');
    if(!grid) return;
    const drops=(state.drops&&state.drops.total)||0;
    document.getElementById('shop-drops-num').textContent=drops;
    const items=state.shopItems||[];
    grid.innerHTML='';
    items.forEach(item=>{
      const canBuy=drops>=item.price&&item.stock!==0, soldOut=item.stock===0;
      const el=document.createElement('div');el.className='shop-item-compact';
      el.innerHTML=`<button class="shop-item-edit-btn" title="编辑">✏️</button><div class="shop-item-icon">${item.icon||'🎁'}</div><div class="shop-item-name">${esc(item.name)}</div><div class="shop-item-price">💧 ${item.price}</div><button class="btn-shop-buy" ${!canBuy?'disabled':''}>${soldOut?'售罄':'兑换'}</button>`;
      el.querySelector('.btn-shop-buy').addEventListener('click',()=>buyShopItem(item.id));
      el.querySelector('.shop-item-edit-btn').addEventListener('click',()=>openShopEditModal(item.id));
      grid.appendChild(el);
    });
    hist.innerHTML='';
    const history=state.shopHistory||[];
    if(history.length===0){hist.innerHTML='<div style="color:var(--text-muted);font-size:.75rem;padding:.4rem">暂无记录</div>';}
    else [...history].reverse().forEach(h=>{const el=document.createElement('div');el.className='shop-history-item';el.innerHTML=`<span class="shi-date">${h.date}</span><span class="shi-name">${h.icon||'🎁'} ${esc(h.name)}</span><span class="shi-price">-💧${h.price}</span>`;hist.appendChild(el);});
  }
  function buyShopItem(id){
    const items=state.shopItems||[];const item=items.find(i=>i.id===id);if(!item)return;
    const drops=(state.drops&&state.drops.total)||0;
    if(drops<item.price){showToast('水滴不足','error');return;}
    if(item.stock===0){showToast('已售罄','error');return;}
    state.drops.total-=item.price;state.drops.history.push({date:todayKey(),amount:-item.price,reason:'兑换: '+item.name});
    if(item.stock>0)item.stock--;
    if(!state.shopHistory)state.shopHistory=[];
    state.shopHistory.push({date:todayKey(),name:item.name,icon:item.icon,price:item.price});
    saveState();updateDropsDisplay();renderShop();showToast('兑换成功！'+item.icon,'success');
  }
  document.getElementById('btn-shop-add').addEventListener('click',()=>{
    const ni=document.getElementById('shop-new-name'),pi=document.getElementById('shop-new-price'),ii=document.getElementById('shop-new-icon');
    const name=ni.value.trim(),price=parseInt(pi.value),icon=ii.value.trim()||'🎁';
    if(!name){showToast('请输入名称','error');return;}if(!price||price<=0){showToast('请输入价格','error');return;}
    if(!state.shopItems)state.shopItems=[];
    state.shopItems.push({id:'shop-'+genId(),name,icon,price,stock:-1});saveState();ni.value='';pi.value='';ii.value='';renderShop();
  });
  let editingShopItemId=null;
  const shopEditOverlay=document.getElementById('shop-edit-overlay');
  setupModalClose(shopEditOverlay,document.getElementById('shop-edit-close'));
  function openShopEditModal(id){editingShopItemId=id;const item=(state.shopItems||[]).find(i=>i.id===id);if(!item)return;document.getElementById('shop-edit-name').value=item.name;document.getElementById('shop-edit-price').value=item.price;document.getElementById('shop-edit-icon').value=item.icon||'';shopEditOverlay.classList.remove('hidden');}
  document.getElementById('btn-shop-edit-save').addEventListener('click',()=>{if(!editingShopItemId)return;const name=document.getElementById('shop-edit-name').value.trim();if(!name)return;const price=parseInt(document.getElementById('shop-edit-price').value);if(!price||price<=0)return;const icon=document.getElementById('shop-edit-icon').value.trim()||'🎁';const item=(state.shopItems||[]).find(i=>i.id===editingShopItemId);if(item){item.name=name;item.price=price;item.icon=icon;}saveState();shopEditOverlay.classList.add('hidden');renderShop();});
  document.getElementById('btn-shop-edit-delete').addEventListener('click',()=>{if(!editingShopItemId)return;if(confirm('删除？')){state.shopItems=(state.shopItems||[]).filter(i=>i.id!==editingShopItemId);saveState();shopEditOverlay.classList.add('hidden');renderShop();}});

  // ===== DATA IMPORT/EXPORT =====
  document.getElementById('btn-export').addEventListener('click',()=>{
    const blob=new Blob([JSON.stringify(state,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=url;a.download='xinliu_'+todayKey()+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),200);
  });
  const importFile=document.getElementById('import-file'),importModeOverlay=document.getElementById('import-mode-overlay');
  let pendingImportData=null;
  document.getElementById('btn-import').addEventListener('click',()=>{importFile.value='';importFile.click();});
  importFile.addEventListener('change',e=>{const f=e.target.files[0];if(!f)return;const r=new FileReader();r.onload=ev=>{try{pendingImportData=JSON.parse(ev.target.result);importModeOverlay.classList.remove('hidden');}catch(err){alert('无效文件');}};r.readAsText(f);});
  setupModalClose(importModeOverlay,document.getElementById('import-mode-close'));
  document.getElementById('import-mode-overwrite').addEventListener('click',()=>{if(!pendingImportData)return;importModeOverlay.classList.add('hidden');state=mergeState(pendingImportData);pendingImportData=null;saveState();loadSettingsUI();renderActiveView();updateDropsDisplay();alert('导入成功！');});
  document.getElementById('import-mode-merge').addEventListener('click',()=>{
    if(!pendingImportData)return;importModeOverlay.classList.add('hidden');const imp=mergeState(pendingImportData);pendingImportData=null;
    const eids=new Set((state.tasks||[]).map(t=>t.id));(imp.tasks||[]).forEach(t=>{if(!eids.has(t.id))state.tasks.push(t);});
    const etids=new Set((state.tags||[]).map(t=>t.id));(imp.tags||[]).forEach(t=>{if(!etids.has(t.id))state.tags.push(t);});
    if(imp.drops){if(!state.drops)state.drops={total:0,history:[]};state.drops.total=Math.max(state.drops.total,imp.drops.total||0);}
    saveState();loadSettingsUI();renderActiveView();updateDropsDisplay();alert('合并成功！');
  });
  document.getElementById('btn-clear-data').addEventListener('click',()=>{
    if(confirm('清除所有数据？不可恢复。')){
      state=defaultState();state.lastModified=Date.now();localStorage.setItem(STATE_KEY,JSON.stringify(state));
      if(serverLoaded)fetch('/api/data',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(state)}).catch(()=>{});
      loadSettingsUI();alert('已清除');switchView('today');
    }
  });

  // ===== MANUAL REFRESH =====
  document.getElementById('btn-manual-refresh').addEventListener('click',function(){
    this.classList.add('refreshing');this.disabled=true;
    state.lastDailyCheck='';dailyMaintenance();renderActiveView();updateDropsDisplay();
    setTimeout(()=>{this.classList.remove('refreshing');this.disabled=false;},800);
  });

  // ===== INIT =====
  loadSettingsUI(); renderToday(); updateDropsDisplay();
  loadStateFromServer();
  scheduleMidnightRefresh();

})();
