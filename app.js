// ===== 心流 · 个人效率系统 (重构版) =====
// 4+1 视图：今日 / 任务 / 项目 / 回顾 / 设置

(function () {
  'use strict';

  // ===== STATE =====
  const STATE_KEY = 'xinliu_state';
  let state = loadStateSync();
  if (!state.lastModified && (state.tasks || []).length > 0) {
    state.lastModified = Date.now();
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  }

  function defaultState() {
    return {
      tasks: [], projects: [], trash: [], schedule: {},
      settings: { provider: 'deepseek', baseUrl: '', apiKey: '', model: 'deepseek-chat' },
      links: [], quotes: [], userInfo: { name: '' },
      timeBlocks: [], habits: [], habitLogs: [], taskLogs: [],
      wakeSleep: {},
      lastDailyCheck: '', lastModified: 0,
    };
  }

  function mergeState(raw) {
    const def = defaultState();
    const merged = { ...def, ...raw, settings: { ...def.settings, ...(raw.settings || {}) } };
    ['projects','trash','links','quotes','timeBlocks','habits','habitLogs','taskLogs'].forEach(k => {
      if (!Array.isArray(merged[k])) merged[k] = def[k] || [];
    });
    if (!merged.userInfo) merged.userInfo = def.userInfo;
    if (!merged.lastDailyCheck) merged.lastDailyCheck = '';
    if (!merged.wakeSleep) merged.wakeSleep = {};
    merged.timeBlocks.forEach(b => {
      if (b.taskId && !b.bindType) { b.bindType = 'task'; b.bindId = b.taskId; }
    });
    migrateTasks(merged);
    return merged;
  }

  function migrateTasks(s) {
    (s.tasks || []).forEach(t => {
      t.projectId = t.projectId || '';
      t.pinned = Boolean(t.pinned);
      delete t.tags;
      if (t.category) delete t.category;
    });
    s.projects = (s.projects || []).map(p => ({ id: p.id || genId(), name: p.name || '未命名项目', note: p.note || '', status: p.status || 'active', createdAt: p.createdAt || new Date().toISOString() }));
    s.trash = (s.trash || []).filter(t => t && t.id).map(t => ({ ...t, deletedAt: t.deletedAt || new Date().toISOString() }));
  }

  function loadStateSync() {
    try { const raw = localStorage.getItem(STATE_KEY); if (raw) return mergeState(JSON.parse(raw)); } catch(e) {}
    return defaultState();
  }

  // 本地先响应，Railway Redis 负责持久化与跨设备恢复。
  let serverLoaded = false;
  let saveTimer = null;
  let isSaving = false;

  function setSyncStatus(status) {
    const dot = document.querySelector('.sync-dot');
    if (dot) dot.className = 'sync-dot sync-' + status;
    renderBackupReminder();
  }

  function saveState() {
    state.lastModified = Date.now();
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    if (!serverLoaded) return;
    setSyncStatus('saving');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveToServer, 400);
  }

  async function saveToServer() {
    if (isSaving) return;
    isSaving = true;
    try {
      const res = await fetch('/api/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      });
      setSyncStatus(res.ok ? 'ok' : 'offline');
    } catch (e) {
      setSyncStatus('offline');
    } finally {
      isSaving = false;
      saveTimer = null;
    }
  }

  async function loadStateFromServer() {
    try {
      const res = await fetch('/api/data');
      if (!res.ok) throw new Error('云端数据不可用');
      const data = await res.json();
      if (data && typeof data === 'object' && (data.lastModified || data.tasks || data.settings)) {
        const localTime = state.lastModified || 0;
        const remoteTime = data.lastModified || 0;
        const localHasData = (state.tasks || []).length > 0
          || (state.projects || []).length > 0
          || (state.habits || []).length > 0
          || (state.timeBlocks || []).length > 0
          || (state.userInfo && state.userInfo.name);
        if (!localHasData || remoteTime >= localTime || localTime === 0) {
          state = mergeState(data);
          localStorage.setItem(STATE_KEY, JSON.stringify(state));
          loadSettingsUI();
          renderActiveView();
        }
      }
      setSyncStatus('ok');
    } catch (e) {
      setSyncStatus('offline');
    } finally {
      serverLoaded = true;
      if (state.lastModified > 0 && !saveTimer) saveToServer();
      startSyncPolling();
    }
  }

  async function pollServerSync() {
    if (!serverLoaded || saveTimer || isSaving) return;
    try {
      const res = await fetch('/api/data');
      if (!res.ok) return;
      const data = await res.json();
      if (!data || (data.lastModified || 0) <= (state.lastModified || 0)) return;
      state = mergeState(data);
      localStorage.setItem(STATE_KEY, JSON.stringify(state));
      loadSettingsUI();
      renderActiveView();
      setSyncStatus('ok');
    } catch (e) {
      setSyncStatus('offline');
    }
  }

  function startSyncPolling() {
    setInterval(pollServerSync, 10000);
  }

  // ===== HELPERS =====
  function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function esc(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function todayKey() { return localDateKey(new Date()); }
  function localDateKey(d) { return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
  function getProject(id) { return (state.projects || []).find(project => project.id === id); }
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
      projectId: t.projectId || '', pinned: Boolean(t.pinned), date: t.date || todayKey(), time: t.time || '',
      duration: t.duration || 30, note: t.note || '', recurrence: t.recurrence || 'none',
      subtasks: t.subtasks || [], done: false, sortOrder: maxOrder + 1, createdAt: new Date().toISOString(),
    };
    state.tasks.push(task); saveState(); return task;
  }
  function updateTask(id, u) { const t = state.tasks.find(x => x.id === id); if (t) { Object.assign(t, u); saveState(); } }
  function deleteTask(id) {
    const task = state.tasks.find(x => x.id === id);
    if (!task) return;
    state.tasks = state.tasks.filter(x => x.id !== id);
    state.trash.push({ ...task, deletedAt: new Date().toISOString() });
    saveState();
  }

  const PRIORITY_LABELS = { 'urgent-important': '重要紧急', 'important': '重要', 'urgent': '紧急', 'neither': '一般' };
  const PRIORITY_COLORS = { 'urgent-important': 'var(--q1)', 'important': 'var(--q2)', 'urgent': 'var(--q3)', 'neither': 'var(--q4)' };

  function toggleDone(id) {
    const t = state.tasks.find(x => x.id === id); if (!t) return;
    const wasDone = t.done; t.done = !t.done; saveState();
    if (!wasDone && t.done) {
      if (!state.taskLogs) state.taskLogs = [];
      state.taskLogs.push({ id:'tlog-'+genId(), taskId:t.id, name:t.name, quadrant:t.quadrant, duration:t.duration||30, date:todayKey() });
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
  const viewTitles = { today:'今日', tasks:'任务', projects:'项目', review:'回顾', settings:'设置' };

  const VIEW_RENDERERS = {
    today: renderToday, tasks: renderTasks, projects: renderProjects, review: renderReview,
    settings: () => { loadSettingsUI(); renderSettingsLists(); renderBackupReminder(); },
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
    ['taskLogs','habitLogs'].forEach(k => { if (state[k]) state[k] = state[k].filter(l => l.date >= ck); });
    state.lastDailyCheck = today; saveState();
  }
  function scheduleMidnightRefresh() {
    const now = new Date(), tmr = new Date(now.getFullYear(),now.getMonth(),now.getDate()+1,0,0,0);
    setTimeout(() => { dailyMaintenance(); renderActiveView(); scheduleMidnightRefresh(); }, tmr - now);
  }

  // ===== RENDER: TODAY VIEW =====
  /* placeholder - filled next */
  function renderToday() { renderTodayImpl(); }

  // ===== RENDER: TASKS VIEW =====
  /* placeholder - filled next */
  function renderTasks() { renderProjectFilter(); renderBoard(); }

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

  // ===== TODAY VIEW IMPL =====
  function renderTodayImpl() {
    const now = new Date(), h = now.getHours();
    const greeting = h<6?'夜深了':h<11?'早上好':h<14?'中午好':h<18?'下午好':'晚上好';
    const userName = state.userInfo&&state.userInfo.name?state.userInfo.name:'';
    document.getElementById('today-greeting').textContent = userName ? greeting+'，'+userName : greeting;
    const wd = ['周日','周一','周二','周三','周四','周五','周六'];
    document.getElementById('today-date').textContent = now.getFullYear()+'年'+(now.getMonth()+1)+'月'+now.getDate()+'日 '+wd[now.getDay()];

    const today = todayKey();
    const todayTasks = state.tasks.filter(t => t.date === today);
    const done = todayTasks.filter(t => t.done).length;
    const total = todayTasks.length;
    const pending = total - done;

    document.getElementById('progress-done').textContent = done;
    document.getElementById('stat-pending').textContent = pending;
    document.getElementById('stat-total').textContent = total;

    const focusMinutes = todayTasks.filter(t => t.done).reduce((sum, task) => sum + (task.duration || 0), 0);
    document.getElementById('stat-focus-time').textContent = focusMinutes;

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
      el.innerHTML = `<div class="tti-checkbox ${t.done?'checked':''}" data-id="${t.id}"></div><div class="tti-prio" style="background:${PRIORITY_COLORS[t.quadrant]||'var(--q4)'}"></div><div class="tti-name">${t.pinned?'★ ':''}${esc(t.name)}</div>${t.time?'<span class="tti-time">'+t.time+'</span>':''}${dlS==='overdue'?'<span class="tti-deadline overdue">逾期</span>':''}`;
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
  let projectFilter = 'all';
  const taskSearch = document.getElementById('task-search');
  const projectFilterSelect = document.getElementById('task-project-filter');
  function renderProjectFilter() {
    projectFilterSelect.innerHTML = '<option value="all">全部项目</option><option value="none">未归档项目</option>';
    (state.projects || []).forEach(project => {
      projectFilterSelect.insertAdjacentHTML('beforeend', `<option value="${project.id}">${esc(project.name)}</option>`);
    });
    projectFilterSelect.value = projectFilter;
  }
  taskSearch.addEventListener('input', renderBoard);
  projectFilterSelect.addEventListener('change', () => { projectFilter = projectFilterSelect.value; renderBoard(); });

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
    const query = taskSearch.value.trim().toLowerCase();
    let tasks = [...state.tasks].filter(task => {
      const matchesText = !query || (task.name + ' ' + (task.note || '')).toLowerCase().includes(query);
      const matchesProject = projectFilter === 'all' || (projectFilter === 'none' ? !task.projectId : task.projectId === projectFilter);
      return matchesText && matchesProject;
    });
    tasks.sort((a,b) => { if(a.done!==b.done) return a.done?1:-1; if(Boolean(a.pinned)!==Boolean(b.pinned)) return a.pinned?-1:1; return (a.sortOrder??999)-(b.sortOrder??999); });
    list.innerHTML = '';
    if (tasks.length === 0) { list.innerHTML = '<div style="color:var(--text-muted);padding:1.5rem;text-align:center;font-size:.85rem">暂无任务</div>'; return; }
    tasks.forEach(t => {
      const card = document.createElement('div');
      const dlS = t.done ? null : deadlineStatus(t.date);
      card.className = 'task-card'+(t.done?' done':'')+(dlS==='overdue'?' card-overdue':dlS==='today'?' card-today':'');
      card.dataset.id = t.id; card.draggable = !t.done;
      const project = getProject(t.projectId), dateL = formatDateShort(t.date), timeL = t.time||'';
      const recIcon = t.recurrence==='daily'?' 🔄':t.recurrence==='weekly'?' 🔁':'';
      const prioL = PRIORITY_LABELS[t.quadrant]||'一般', prioC = PRIORITY_COLORS[t.quadrant]||'var(--q4)';
      let subTag = '';
      if (t.subtasks&&t.subtasks.length>0) { const dc=t.subtasks.filter(s=>s.done).length; subTag=`<span class="task-meta-tag" style="color:var(--accent)">✓ ${dc}/${t.subtasks.length}</span>`; }
      card.innerHTML = `<div class="task-card-top"><div class="drag-handle" title="拖拽排序">⁞</div><div class="task-checkbox ${t.done?'checked':''}" data-id="${t.id}"></div><div class="task-card-name">${t.pinned?'★ ':''}${esc(t.name)}${recIcon}</div>${deadlineTag(dlS)}<span class="task-prio-tag" style="background:${prioC}22;color:${prioC};border:1px solid ${prioC}44">${prioL}</span></div><div class="task-card-meta">${project?'<span class="task-project-tag">'+esc(project.name)+'</span>':''}${dateL?'<span class="task-date-tag">'+dateL+'</span>':''}${timeL?'<span class="task-date-tag">'+timeL+'</span>':''}<span class="task-meta-tag"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>${t.duration}分</span>${subTag}</div>`;
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
    const sys = `你是任务分析助手。当前日期 ${todayKey()}。从用户文字中提取任务。返回JSON数组：[ {"name":"","quadrant":"important","date":"YYYY-MM-DD","time":"","duration":30,"note":"","recurrence":"none","subtasks":[{"name":"","done":false}]} ]`;
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
    editNewSubtask=document.getElementById('edit-new-subtask'), editProject=document.getElementById('edit-task-project'), editPinned=document.getElementById('edit-task-pinned');
  let editingTaskId=null, currentSubtasks=[];

  function renderTaskProjects(selected) {
    editProject.innerHTML = '<option value="">不归档项目</option>';
    (state.projects || []).forEach(project => editProject.insertAdjacentHTML('beforeend', `<option value="${project.id}">${esc(project.name)}</option>`));
    editProject.value = selected || '';
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
    editName.value=t.name; renderTaskProjects(t.projectId); editPinned.checked=Boolean(t.pinned);
    editQuadrant.value=t.quadrant; editRecurrence.value=t.recurrence||'none';
    editDate.value=t.date||todayKey(); editTime.value=t.time||'';
    editDuration.value=t.duration; editNote.value=t.note||'';
    currentSubtasks=JSON.parse(JSON.stringify(t.subtasks||[])); renderSubtasks();
    modalOverlay.classList.remove('hidden');
  }
  function openAddModal() {
    editingTaskId=null; document.getElementById('modal-title').textContent='添加任务';
    document.getElementById('btn-modal-delete').style.display='none';
    editName.value=''; renderTaskProjects(''); editPinned.checked=false;
    editQuadrant.value='important'; editRecurrence.value='none';
    editDate.value=todayKey(); editTime.value=''; editDuration.value=30; editNote.value='';
    currentSubtasks=[]; renderSubtasks();
    modalOverlay.classList.remove('hidden'); editName.focus();
  }
  setupModalClose(modalOverlay, document.getElementById('modal-close'));
  document.getElementById('btn-modal-save').addEventListener('click', () => {
    const data = { name:editName.value.trim()||'未命名任务', projectId:editProject.value, pinned:editPinned.checked, quadrant:editQuadrant.value, recurrence:editRecurrence.value, date:editDate.value||todayKey(), time:editTime.value||'', duration:parseInt(editDuration.value)||30, note:editNote.value.trim(), subtasks:currentSubtasks };
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
    habitModalOverlay.classList.remove('hidden');
  }
  setupModalClose(habitModalOverlay, document.getElementById('habit-modal-close'));
  document.getElementById('btn-habit-save').addEventListener('click', () => {
    const name=document.getElementById('habit-edit-name').value.trim(); if(!name){alert('请输入名称');return;}
    const type=document.getElementById('habit-edit-type').value;
    const icon=document.getElementById('habit-edit-icon').value.trim()||'🔄';
    if(!state.habits) state.habits=[];
    if(editingHabitId){const h=(state.habits).find(x=>x.id===editingHabitId);if(h){h.name=name;h.type=type;h.icon=icon;}}
    else state.habits.push({id:'habit-'+genId(),name,type,icon,createdAt:new Date().toISOString()});
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
  }
  document.getElementById('habit-log-value').addEventListener('input', updateHabitLogPreview);
  setupModalClose(habitLogOverlay, document.getElementById('habit-log-close'));
  document.getElementById('btn-habit-log-save').addEventListener('click', () => {
    const h=(state.habits||[]).find(x=>x.id===loggingHabitId); if(!h) return;
    const v=parseFloat(document.getElementById('habit-log-value').value)||0; if(v<=0){alert('请输入有效数值');return;}
    if(!state.habitLogs) state.habitLogs=[];
    state.habitLogs.push({id:'hlog-'+genId(),habitId:h.id,date:todayKey(),value:v});
    saveState(); habitLogOverlay.classList.add('hidden'); renderActiveView();
    showToast(h.icon+' 已记录', 'success');
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
    const statsDiv = document.getElementById('review-stats');
    statsDiv.innerHTML = `<div class="review-stat-card"><div class="review-stat-num">${tl.length}</div><div class="review-stat-label">完成任务</div></div><div class="review-stat-card"><div class="review-stat-num">${hl.length}</div><div class="review-stat-label">习惯打卡</div></div><div class="review-stat-card review-stat-accent"><div class="review-stat-num">${tl.reduce((sum, log) => sum + (log.duration || 0), 0)}</div><div class="review-stat-label">专注分钟</div></div>`;

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
        const c = t.pinned ? 'var(--accent)' : '#64748b';
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
    tl.forEach(l=>{ctx+=`  - ${l.name} (${PRIORITY_LABELS[l.quadrant]||'一般'},${l.duration}分)\n`;});
    ctx += `待完成: ${pending.length}\n`;
    pending.forEach(t=>{ctx+=`  - ${t.name} (截止:${t.date})\n`;});
    ctx += `习惯打卡: ${hl.length}次\n`;
    return ctx;
  }
  function buildSummaryTemplate(days) {
    const today = todayKey(); const start = new Date(); start.setDate(start.getDate()-(days-1)); const sk = localDateKey(start);
    const tl = (state.taskLogs||[]).filter(l=>l.date>=sk&&l.date<=today);
    const hl = (state.habitLogs||[]).filter(l=>l.date>=sk&&l.date<=today);
    let html = `<div class="summary-section"><h4>📊 概览 (${sk} ~ ${today})</h4><ul>`;
    html += `<li>完成: <strong>${tl.length}</strong> 个任务</li><li>打卡: <strong>${hl.length}</strong> 次</li><li>专注: <strong>${tl.reduce((sum, log) => sum + (log.duration || 0), 0)}</strong> 分钟</li></ul></div>`;
    if(tl.length>0){html+='<div class="summary-section"><h4>✅ 已完成</h4><ul>';tl.forEach(l=>{html+=`<li>${esc(l.name)} <span style="color:var(--text-muted)">(${l.duration}分)</span></li>`;});html+='</ul></div>';}
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

  function renderSettingsLists() {}

  // ===== PROJECTS =====
  let editingProjectId = null;
  const projectModalOverlay = document.getElementById('project-modal-overlay');
  const projectNameInput = document.getElementById('project-edit-name');
  const projectNoteInput = document.getElementById('project-edit-note');
  const projectStatusInput = document.getElementById('project-edit-status');
  setupModalClose(projectModalOverlay, document.getElementById('project-modal-close'));

  function openProjectModal(id) {
    const project = id ? getProject(id) : null;
    editingProjectId = id;
    document.getElementById('project-modal-title').textContent = project ? '编辑项目' : '新建项目';
    document.getElementById('project-modal-delete').style.display = project ? '' : 'none';
    projectNameInput.value = project ? project.name : '';
    projectNoteInput.value = project ? project.note : '';
    projectStatusInput.value = project ? project.status : 'active';
    projectModalOverlay.classList.remove('hidden');
    projectNameInput.focus();
  }

  function renderProjects() {
    const list = document.getElementById('project-list');
    list.innerHTML = '';
    if (!(state.projects || []).length) {
      list.innerHTML = '<div class="empty-state">还没有项目，先建立一个清晰的目标吧。</div>';
      return;
    }
    state.projects.forEach(project => {
      const tasks = state.tasks.filter(task => task.projectId === project.id);
      const done = tasks.filter(task => task.done).length;
      const percent = tasks.length ? Math.round(done / tasks.length * 100) : 0;
      const card = document.createElement('article');
      card.className = 'project-card';
      card.innerHTML = `<div class="project-card-head"><div><h2>${esc(project.name)}</h2><span class="project-status status-${project.status}">${({active:'进行中',planned:'未开始',paused:'已暂停',done:'已完成'})[project.status] || '进行中'}</span></div><button class="btn-icon project-edit" aria-label="编辑项目" title="编辑项目">✎</button></div><p class="project-note">${esc(project.note) || '暂无备注'}</p><div class="project-progress"><div class="project-progress-bar"><span style="width:${percent}%"></span></div><strong>${percent}%</strong></div><div class="project-meta">${done} / ${tasks.length} 个任务完成</div><button class="btn-secondary btn-sm project-open-tasks">查看项目任务</button>`;
      card.querySelector('.project-edit').addEventListener('click', () => openProjectModal(project.id));
      card.querySelector('.project-open-tasks').addEventListener('click', () => { projectFilter = project.id; switchView('tasks'); });
      list.appendChild(card);
    });
  }

  document.getElementById('btn-add-project').addEventListener('click', () => openProjectModal(null));
  document.getElementById('project-modal-save').addEventListener('click', () => {
    const name = projectNameInput.value.trim();
    if (!name) { alert('请输入项目名称'); return; }
    if (editingProjectId) {
      const project = getProject(editingProjectId);
      Object.assign(project, { name, note: projectNoteInput.value.trim(), status: projectStatusInput.value });
    } else {
      state.projects.push({ id: 'project-' + genId(), name, note: projectNoteInput.value.trim(), status: projectStatusInput.value, createdAt: new Date().toISOString() });
    }
    saveState(); projectModalOverlay.classList.add('hidden'); renderProjects(); renderTaskProjects(); renderProjectFilter();
  });
  document.getElementById('project-modal-delete').addEventListener('click', () => {
    if (!editingProjectId || !confirm('删除项目后，项目内任务会变为未归档。继续吗？')) return;
    state.projects = state.projects.filter(project => project.id !== editingProjectId);
    state.tasks.forEach(task => { if (task.projectId === editingProjectId) task.projectId = ''; });
    saveState(); projectModalOverlay.classList.add('hidden'); renderProjects(); renderTaskProjects(); renderProjectFilter();
  });

  // ===== TRASH =====
  const trashModalOverlay = document.getElementById('trash-modal-overlay');
  setupModalClose(trashModalOverlay, document.getElementById('trash-modal-close'));
  function renderTrash() {
    const list = document.getElementById('trash-list');
    list.innerHTML = '';
    if (!state.trash.length) { list.innerHTML = '<div class="empty-state">回收站为空</div>'; return; }
    state.trash.forEach(task => {
      const item = document.createElement('div'); item.className = 'trash-item';
      item.innerHTML = `<span>${esc(task.name)}</span><button class="btn-secondary btn-xs">恢复</button><button class="btn-danger btn-xs">永久删除</button>`;
      item.querySelectorAll('button')[0].addEventListener('click', () => { state.tasks.push(task); state.trash = state.trash.filter(item => item.id !== task.id); saveState(); renderTrash(); renderBoard(); });
      item.querySelectorAll('button')[1].addEventListener('click', () => { if (confirm('永久删除后不可恢复，继续吗？')) { state.trash = state.trash.filter(item => item.id !== task.id); saveState(); renderTrash(); } });
      list.appendChild(item);
    });
  }
  document.getElementById('btn-show-trash').addEventListener('click', () => { renderTrash(); trashModalOverlay.classList.remove('hidden'); });

  // ===== BACKUP REMINDER & SHORTCUTS =====
  function renderBackupReminder() {
    const reminder = document.getElementById('backup-reminder');
    if (!reminder) return;
    const offline = document.querySelector('.sync-dot')?.classList.contains('sync-offline');
    reminder.className = 'backup-reminder ' + (offline ? 'warning' : 'ready');
    reminder.textContent = offline ? '云端暂未连接，数据只保存在本地缓存。' : '云端备份已启用，修改会自动保存。';
  }
  const shortcutOverlay = document.getElementById('shortcut-modal-overlay');
  setupModalClose(shortcutOverlay, document.getElementById('shortcut-modal-close'));
  document.getElementById('btn-show-shortcuts').addEventListener('click', () => shortcutOverlay.classList.remove('hidden'));
  document.addEventListener('keydown', event => {
    if (event.target.matches('input, textarea, select')) {
      if (event.key === 'Escape') event.target.blur();
      return;
    }
    if (event.key === 'Escape') document.querySelectorAll('.modal-overlay:not(.hidden)').forEach(overlay => overlay.classList.add('hidden'));
    if (event.key === '?') shortcutOverlay.classList.remove('hidden');
    if (event.key.toLowerCase() === 'n') { switchView('tasks'); openAddModal(); }
    if (event.key === '/') { event.preventDefault(); switchView('tasks'); taskSearch.focus(); }
    if (event.key.toLowerCase() === 'g') switchView('projects');
  });

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
  document.getElementById('import-mode-overwrite').addEventListener('click',()=>{if(!pendingImportData)return;importModeOverlay.classList.add('hidden');state=mergeState(pendingImportData);pendingImportData=null;saveState();loadSettingsUI();renderActiveView();alert('导入成功！');});
  document.getElementById('import-mode-merge').addEventListener('click',()=>{
    if(!pendingImportData)return;importModeOverlay.classList.add('hidden');const imp=mergeState(pendingImportData);pendingImportData=null;
    const eids=new Set((state.tasks||[]).map(t=>t.id));(imp.tasks||[]).forEach(t=>{if(!eids.has(t.id))state.tasks.push(t);});
    const epids=new Set((state.projects||[]).map(project=>project.id));(imp.projects||[]).forEach(project=>{if(!epids.has(project.id))state.projects.push(project);});
    saveState();loadSettingsUI();renderActiveView();alert('合并成功！');
  });
  document.getElementById('btn-clear-data').addEventListener('click',()=>{
    if(confirm('清除所有数据？不可恢复。')){
      state=defaultState();state.lastModified=Date.now();localStorage.setItem(STATE_KEY,JSON.stringify(state));
      loadSettingsUI();alert('已清除');switchView('today');
    }
  });

  // ===== MANUAL REFRESH =====
  document.getElementById('btn-manual-refresh').addEventListener('click',function(){
    this.classList.add('refreshing');this.disabled=true;
    state.lastDailyCheck='';dailyMaintenance();renderActiveView();
    setTimeout(()=>{this.classList.remove('refreshing');this.disabled=false;},800);
  });

  // ===== INIT =====
  loadSettingsUI(); renderToday();
  dailyMaintenance();
  loadStateFromServer();
  scheduleMidnightRefresh();

})();
