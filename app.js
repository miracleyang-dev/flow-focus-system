// ===== 心流 · 个人效率系统 =====
// 服务端 JSON 文件存储 + localStorage 兜底

(function () {
  'use strict';

  // ===== STATE =====
  const STATE_KEY = 'xinliu_state';
  let state = loadStateSync();
  // Bootstrap lastModified for legacy local data
  if (!state.lastModified && (state.tasks || []).length > 0) {
    state.lastModified = Date.now();
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  }
  let saveTimer = null;
  let serverLoaded = false; // 防止服务端数据加载前覆盖 Redis

  function defaultState() {
    return {
      tasks: [],
      schedule: {},
      settings: {
        provider: 'deepseek',
        baseUrl: '',
        apiKey: '',
        model: 'deepseek-chat',
      },
      tags: [],
      links: [],
      quotes: [],
      userInfo: { name: '' },
      drops: { total: 0, history: [] },
      savedChats: [],
      lastDailyCheck: '',
      lastModified: 0,
    };
  }

  function mergeState(raw) {
    const def = defaultState();
    const merged = { ...def, ...raw, settings: { ...def.settings, ...(raw.settings || {}) } };
    // Ensure new top-level arrays/objects exist
    if (!Array.isArray(merged.tags)) merged.tags = def.tags;
    if (!Array.isArray(merged.links)) merged.links = def.links;
    if (!Array.isArray(merged.quotes)) merged.quotes = def.quotes;
    if (!merged.userInfo) merged.userInfo = def.userInfo;
    if (!merged.drops) merged.drops = def.drops;
    if (!Array.isArray(merged.savedChats)) merged.savedChats = def.savedChats;
    if (!merged.lastDailyCheck) merged.lastDailyCheck = '';
    if (!Array.isArray(merged.shopItems)) merged.shopItems = null; // will be initialized with defaults on first access
    if (!Array.isArray(merged.shopHistory)) merged.shopHistory = [];
    // Migrate tasks: category -> tags
    migrateTasks(merged);
    return merged;
  }

  function migrateTasks(s) {
    const CATEGORY_TAG_MAP = { vocation: 'tag-vocation', being: 'tag-being', romance: 'tag-romance' };
    (s.tasks || []).forEach(t => {
      if (t.category && !t.tags) {
        const tagId = CATEGORY_TAG_MAP[t.category];
        t.tags = tagId ? [tagId] : [];
      }
      if (t.category) delete t.category;
      if (!Array.isArray(t.tags)) t.tags = [];
    });
  }

  function loadStateSync() {
    try {
      const raw = localStorage.getItem(STATE_KEY);
      if (raw) return mergeState(JSON.parse(raw));
    } catch (e) { /* ignore */ }
    return defaultState();
  }

  async function loadStateFromServer() {
    try {
      const res = await fetch('/api/data');
      if (res.ok) {
        const data = await res.json();
        if (data && (data.tasks || data.settings)) {
          const localTaskCount = (state.tasks || []).length;
          const serverTaskCount = (data.tasks || []).length;
          const serverTime = data.lastModified || 0;
          const localTime = state.lastModified || 0;

          // Decide whether to use server data:
          // 1. Server has more/equal tasks OR local is empty → take server
          // 2. Server has fewer tasks but is newer (lastModified) → take server
          // 3. Server is empty but local has data → keep local, push to server later
          let useServer = false;
          if (localTaskCount === 0) {
            useServer = true;
          } else if (serverTaskCount === 0 && localTaskCount > 0) {
            useServer = false; // Never overwrite local data with empty server
          } else if (serverTime > localTime) {
            useServer = true; // Server is newer
          } else if (serverTaskCount >= localTaskCount) {
            useServer = true; // Server has more data
          }

          if (useServer) {
            state = mergeState(data);
            // Bootstrap lastModified if server data has none (legacy data)
            if (!state.lastModified) state.lastModified = Date.now();
            localStorage.setItem(STATE_KEY, JSON.stringify(state));
            console.log('[心流] 从服务端加载数据成功，任务数:', (state.tasks || []).length);
          } else {
            console.log('[心流] 本地数据更丰富或更新，保留本地数据，任务数:', localTaskCount);
          }

          loadSettingsUI();
          renderDashboard();
          renderBoard();
          renderGantt();
          updateDropsDisplay();
        }
      }
    } catch (e) {
      console.warn('[心流] 服务端不可用，使用本地数据:', e.message);
    }
    // 标记服务端加载完成，此后允许写入服务端
    serverLoaded = true;
    // 服务端加载完成后，再执行每日维护
    dailyMaintenance();
    checkServerHealth();
    // 启动跨设备同步轮询
    startSyncPolling();
  }

  async function checkServerHealth() {
    try {
      const res = await fetch('/api/health');
      if (res.ok) {
        const h = await res.json();
        if (!h.redis) {
          console.warn('[心流] Redis 不可用:', h.redisError || '未知原因');
          console.warn('[心流] 环境变量:', JSON.stringify(h.env));
        } else {
          console.log('[心流] Redis 连接正常');
        }
      }
    } catch (e) { /* ignore */ }
  }

  // ===== CROSS-DEVICE SYNC POLLING =====
  let syncPollInterval = null;
  let isSaving = false; // Flag to prevent poll during active save

  function computeStateHash() {
    // Fast fingerprint: task count + tag count + link count + drops total + stringify length
    const tasks = state.tasks || [];
    const tags = state.tags || [];
    const links = state.links || [];
    const dropsTotal = (state.drops || {}).total || 0;
    const taskSig = tasks.map(t => t.id + (t.done ? '1' : '0') + (t.sortOrder || 0) + (t.name || '') + (t.date || '') + (t.quadrant || '') + (t.note || '') + (t.tags || []).join(',')).join('|');
    const tagSig = tags.map(t => t.id + t.name + t.color).join('|');
    const linkSig = links.map(l => l.id + l.name + l.url).join('|');
    return taskSig + '##' + tagSig + '##' + linkSig + '##' + dropsTotal;
  }

  // Cheap check: compare counts/totals before expensive full hash
  function quickStateFingerprint(data) {
    return (data.tasks || []).length + ':' + (data.tags || []).length + ':' + (data.links || []).length + ':' + ((data.drops || {}).total || 0);
  }

  function getActiveViewName() {
    const activeNav = document.querySelector('.nav-item.active');
    return activeNav ? activeNav.dataset.view : 'board';
  }

  function renderActiveView() {
    const v = getActiveViewName();
    if (v === 'dashboard') renderDashboard();
    else if (v === 'board') renderBoard();
    else if (v === 'gantt') renderGantt();
    else if (v === 'habits') renderHabits();
    else if (v === 'shop') renderShop();
    else if (v === 'settings') { loadSettingsUI(); renderSettingsLists(); }
  }

  async function pollServerSync() {
    if (!serverLoaded) return;
    // Don't poll while a save is in progress or pending
    if (saveTimer || isSaving) return;
    // Don't poll when modal is open (user is editing)
    if (!modalOverlay.classList.contains('hidden')) return;
    try {
      const res = await fetch('/api/data');
      if (!res.ok) return;
      const data = await res.json();
      if (!data || typeof data !== 'object') return;

      const serverTaskCount = (data.tasks || []).length;
      const localTaskCount = (state.tasks || []).length;
      const serverTime = data.lastModified || 0;
      const localTime = state.lastModified || 0;

      // ===== DATA LOSS PROTECTION =====
      // If server is empty but local has data:
      // - If server's lastModified is NEWER (explicit clear from another device), accept it
      // - Otherwise, push local data to server (server lost data somehow)
      if (localTaskCount > 0 && serverTaskCount === 0) {
        if (serverTime > localTime) {
          // Another device intentionally cleared data — accept the clear
          console.log('[心流] 另一设备已清除数据，同步清除...');
          state = mergeState(data);
          localStorage.setItem(STATE_KEY, JSON.stringify(state));
          renderActiveView();
          updateDropsDisplay();
        } else {
          // Server lost data, push local data back
          console.log('[心流] 服务端数据为空但本地有数据，推送本地数据');
          saveToServer();
        }
        return;
      }

      // Quick fingerprint check — skip expensive sig building if counts unchanged and timestamps equal
      const serverFP = quickStateFingerprint(data);
      const localFP = quickStateFingerprint(state);
      if (serverFP === localFP && serverTime === localTime && serverTime > 0) {
        return; // Counts and timestamps identical — very likely no change
      }

      // Build signatures to detect any change
      const serverSig = (data.tasks || []).map(t => t.id + (t.done ? '1' : '0') + (t.sortOrder || 0) + (t.name || '') + (t.date || '') + (t.quadrant || '') + (t.note || '') + (t.tags || []).join(',')).join('|')
        + '##' + (data.tags || []).map(t => t.id + t.name + t.color).join('|')
        + '##' + (data.links || []).map(l => l.id + l.name + l.url).join('|')
        + '##' + ((data.drops || {}).total || 0);
      const localSig = computeStateHash();

      // No change detected
      if (serverSig === localSig) {
        // Signatures match but sync lastModified if server is newer (bootstrap)
        if (serverTime > localTime) {
          state.lastModified = serverTime;
          localStorage.setItem(STATE_KEY, JSON.stringify(state));
        }
        return;
      }

      // Both timestamps are 0 or missing (legacy data) — use signature comparison
      // to decide; since sigs differ, accept server data to bootstrap sync
      if (serverTime === 0 && localTime === 0) {
        console.log('[心流] 首次同步（无时间戳），使用签名比较同步...');
        // Fall through to accept server data below
      } else if (serverTime <= localTime) {
        // Server is older or same — don't overwrite local
        return;
      }

      console.log('[心流] 检测到服务端数据更新 (server:', new Date(serverTime).toLocaleTimeString(), ', local:', new Date(localTime).toLocaleTimeString(), ')，同步中...');
      state = mergeState(data);
      localStorage.setItem(STATE_KEY, JSON.stringify(state));
      // Smart re-render: only update the currently active view to avoid mobile lag
      renderActiveView();
      updateDropsDisplay();
    } catch (e) {
      // Silently fail - will retry next interval
    }
  }

  function startSyncPolling() {
    // Poll every 5 seconds for cross-device sync (less aggressive than 3s)
    syncPollInterval = setInterval(pollServerSync, 5000);
    // Also sync on visibility change (when user switches back to tab/app)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        pollServerSync();
      }
    });
  }

  function saveState() {
    // Stamp the modification time for conflict resolution
    state.lastModified = Date.now();
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    // 只有服务端数据加载完成后，才允许写回服务端
    if (!serverLoaded) {
      console.log('[心流] 服务端未就绪，仅保存到 localStorage');
      return;
    }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveToServer, 300);
  }

  async function saveToServer() {
    isSaving = true;
    try {
      const res = await fetch('/api/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      });
      if (res.ok) {
        const result = await res.json();
        if (!result.ok) {
          console.error('[心流] 保存失败:', result.msg);
        }
      }
    } catch (e) {
      console.warn('[心流] 保存到服务端失败:', e.message);
    } finally {
      isSaving = false;
      saveTimer = null;
    }
  }

  // ===== TAG HELPERS =====
  function getTag(id) { return (state.tags || []).find(t => t.id === id); }
  function getTaskTagNames(task) {
    return (task.tags || []).map(id => { const t = getTag(id); return t ? t.name : ''; }).filter(Boolean);
  }
  function renderTagChips(tagIds) {
    return (tagIds || []).map(id => {
      const tag = getTag(id);
      if (!tag) return '';
      return `<span class="task-tag-chip" style="background:${tag.color}22;color:${tag.color}">${esc(tag.name)}</span>`;
    }).join('');
  }

  // ===== NAVIGATION =====
  const navItems = document.querySelectorAll('.nav-item[data-view]');
  const views = document.querySelectorAll('.view');
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('overlay');
  const menuToggle = document.getElementById('menu-toggle');
  const mobileTitle = document.getElementById('mobile-title');

  const viewTitles = { dashboard: '仪表盘', dump: '倒空大脑', board: '任务看板', gantt: '甘特图', chat: 'AI 陪伴', habits: '长期习惯', shop: '消费商城', settings: '设置' };

  function switchView(name) {
    navItems.forEach(n => n.classList.toggle('active', n.dataset.view === name));
    views.forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
    mobileTitle.textContent = viewTitles[name] || '';
    closeSidebar();
    if (name === 'dashboard') renderDashboard();
    if (name === 'board') renderBoard();
    if (name === 'gantt') renderGantt();
    if (name === 'habits') renderHabits();
    if (name === 'shop') renderShop();
    if (name === 'settings') renderSettingsLists();
  }

  navItems.forEach(n => n.addEventListener('click', () => switchView(n.dataset.view)));
  menuToggle.addEventListener('click', () => { sidebar.classList.add('open'); overlay.classList.add('active'); });
  function closeSidebar() { sidebar.classList.remove('open'); overlay.classList.remove('active'); }

  // ===== SIDEBAR NAV DRAG REORDER =====
  const navList = document.querySelector('.nav-list');
  let navDragSrc = null;

  function initNavDrag() {
    // Restore saved order
    const savedOrder = localStorage.getItem('xinliu_nav_order');
    if (savedOrder) {
      try {
        const order = JSON.parse(savedOrder);
        const items = Array.from(navList.querySelectorAll('.nav-item[data-view]'));
        const itemMap = {};
        items.forEach(el => { itemMap[el.dataset.view] = el; });
        order.forEach(viewName => {
          const el = itemMap[viewName];
          if (el) navList.appendChild(el);
        });
      } catch(e) { /* ignore */ }
    }
    // Make nav items draggable
    navList.querySelectorAll('.nav-item[data-view]').forEach(item => {
      item.draggable = true;
      item.addEventListener('dragstart', navDragStart);
      item.addEventListener('dragover', navDragOver);
      item.addEventListener('dragleave', navDragLeave);
      item.addEventListener('drop', navDrop);
      item.addEventListener('dragend', navDragEnd);
    });
  }

  function navDragStart(e) {
    navDragSrc = this;
    this.style.opacity = '0.4';
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', this.dataset.view);
  }
  function navDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (this !== navDragSrc) this.style.borderTop = '2px solid var(--accent)';
  }
  function navDragLeave() { this.style.borderTop = ''; }
  function navDrop(e) {
    e.preventDefault();
    this.style.borderTop = '';
    if (this === navDragSrc) return;
    // Insert dragged item before the drop target
    navList.insertBefore(navDragSrc, this);
    saveNavOrder();
  }
  function navDragEnd() {
    this.style.opacity = '';
    navList.querySelectorAll('.nav-item').forEach(el => { el.style.borderTop = ''; });
    navDragSrc = null;
  }
  function saveNavOrder() {
    const order = Array.from(navList.querySelectorAll('.nav-item[data-view]')).map(el => el.dataset.view);
    localStorage.setItem('xinliu_nav_order', JSON.stringify(order));
  }

  // Mobile touch reorder for nav
  let navTouchSrc = null;
  let navTouchDragging = false;
  let navTouchStartY = 0;

  navList.addEventListener('touchstart', (e) => {
    const item = e.target.closest('.nav-item[data-view]');
    if (!item) return;
    // Long-press to initiate drag (300ms)
    navTouchStartY = e.touches[0].clientY;
    navTouchSrc = item;
    navTouchDragging = false;
    item._longPressTimer = setTimeout(() => {
      navTouchDragging = true;
      item.style.opacity = '0.5';
      item.style.transform = 'scale(0.95)';
    }, 300);
  }, { passive: true });

  navList.addEventListener('touchmove', (e) => {
    if (!navTouchSrc) return;
    const dy = Math.abs(e.touches[0].clientY - navTouchStartY);
    if (!navTouchDragging && dy > 5) { clearTimeout(navTouchSrc._longPressTimer); }
    if (!navTouchDragging) return;
    e.preventDefault();
    const touch = e.touches[0];
    const elBelow = document.elementFromPoint(touch.clientX, touch.clientY);
    navList.querySelectorAll('.nav-item').forEach(el => { el.style.borderTop = ''; });
    if (elBelow) {
      const target = elBelow.closest('.nav-item[data-view]');
      if (target && target !== navTouchSrc) target.style.borderTop = '2px solid var(--accent)';
    }
  }, { passive: false });

  navList.addEventListener('touchend', (e) => {
    if (!navTouchSrc) return;
    clearTimeout(navTouchSrc._longPressTimer);
    if (navTouchDragging) {
      const touch = e.changedTouches[0];
      const elBelow = document.elementFromPoint(touch.clientX, touch.clientY);
      if (elBelow) {
        const target = elBelow.closest('.nav-item[data-view]');
        if (target && target !== navTouchSrc) {
          navList.insertBefore(navTouchSrc, target);
          saveNavOrder();
        }
      }
      navTouchSrc.style.opacity = '';
      navTouchSrc.style.transform = '';
    }
    navList.querySelectorAll('.nav-item').forEach(el => { el.style.borderTop = ''; });
    navTouchSrc = null;
    navTouchDragging = false;
  });

  initNavDrag();
  overlay.addEventListener('click', closeSidebar);

  // ===== LLM HELPER =====
  const PROVIDER_URLS = {
    openai: 'https://api.openai.com/v1',
    deepseek: 'https://api.deepseek.com/v1',
    qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  };
  const PROVIDER_MODELS = {
    openai: 'gpt-4o',
    deepseek: 'deepseek-chat',
    qwen: 'qwen-turbo',
  };

  function getApiConfig() {
    const s = state.settings;
    const base = s.provider === 'custom' ? s.baseUrl : (PROVIDER_URLS[s.provider] || '');
    const model = s.model || PROVIDER_MODELS[s.provider] || 'gpt-4o';
    return { base, key: s.apiKey, model };
  }

  async function callLLM(systemPrompt, userPrompt) {
    const cfg = getApiConfig();
    if (!cfg.key) throw new Error('请先在设置中配置 API Key');
    const res = await fetch(cfg.base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error('API 错误 (' + res.status + '): ' + err.slice(0, 200));
    }
    const data = await res.json();
    return data.choices[0].message.content;
  }

  // ===== TASK HELPERS =====
  function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  function addTask(t) {
    const maxOrder = state.tasks.reduce((m, x) => Math.max(m, x.sortOrder || 0), -1);
    // Handle backward compat: category -> tags
    let tags = t.tags || [];
    if (t.category && tags.length === 0) {
      const CATEGORY_TAG_MAP = { vocation: 'tag-vocation', being: 'tag-being', romance: 'tag-romance' };
      const tagId = CATEGORY_TAG_MAP[t.category];
      if (tagId) tags = [tagId];
    }
    const task = {
      id: genId(),
      name: t.name || '未命名任务',
      quadrant: t.quadrant || 'important',
      tags: tags,
      date: t.date || todayKey(),
      time: t.time || '',
      duration: t.duration || 30,
      note: t.note || '',
      recurrence: t.recurrence || 'none',
      subtasks: t.subtasks || [],
      done: false,
      sortOrder: maxOrder + 1,
      createdAt: new Date().toISOString(),
    };
    state.tasks.push(task);
    saveState();
    return task;
  }

  function updateTask(id, updates) {
    const t = state.tasks.find(x => x.id === id);
    if (t) { Object.assign(t, updates); saveState(); }
  }

  function deleteTask(id) {
    state.tasks = state.tasks.filter(x => x.id !== id);
    const today = todayKey();
    if (state.schedule[today]) {
      for (const k of Object.keys(state.schedule[today])) {
        if (state.schedule[today][k] === id) delete state.schedule[today][k];
      }
    }
    saveState();
  }

  function todayKey() { return new Date().toISOString().slice(0, 10); }

  // ===== DROPS SYSTEM =====
  const PRIORITY_WEIGHTS = { 'urgent-important': 4, 'important': 3, 'urgent': 2, 'neither': 1 };

  function awardDrops(amount, reason) {
    if (amount <= 0) return;
    if (!state.drops) state.drops = { total: 0, history: [] };
    const prevHundreds = Math.floor(state.drops.total / 100);
    state.drops.total += amount;
    state.drops.history.push({ date: todayKey(), amount, reason });
    saveState();
    updateDropsDisplay();
    const newHundreds = Math.floor(state.drops.total / 100);
    if (newHundreds > prevHundreds) {
      showWaterCelebration(state.drops.total);
    }
  }

  function updateDropsDisplay() {
    const total = (state.drops && state.drops.total) || 0;
    const sidebarNum = document.getElementById('sidebar-drops-num');
    const dashDrops = document.getElementById('dash-drops');
    const rulesTotal = document.getElementById('drops-rules-total');
    const shopDrops = document.getElementById('shop-drops-num');
    if (sidebarNum) sidebarNum.textContent = total;
    if (dashDrops) dashDrops.textContent = '\uD83D\uDCA7 ' + total;
    if (rulesTotal) rulesTotal.textContent = '\uD83D\uDCA7 ' + total;
    if (shopDrops) shopDrops.textContent = total;
  }

  // Drops rules modal
  const dropsRulesOverlay = document.getElementById('drops-rules-overlay');
  document.getElementById('sidebar-drops').addEventListener('click', () => {
    updateDropsDisplay();
    dropsRulesOverlay.classList.remove('hidden');
  });
  document.getElementById('drops-rules-close').addEventListener('click', () => {
    dropsRulesOverlay.classList.add('hidden');
  });
  dropsRulesOverlay.addEventListener('click', (e) => {
    if (e.target === dropsRulesOverlay) dropsRulesOverlay.classList.add('hidden');
  });

  // Drops history toggle
  const dropsHistoryList = document.getElementById('drops-history-list');
  const btnToggleDropsHistory = document.getElementById('btn-toggle-drops-history');
  btnToggleDropsHistory.addEventListener('click', () => {
    const isHidden = dropsHistoryList.style.display === 'none';
    dropsHistoryList.style.display = isHidden ? '' : 'none';
    btnToggleDropsHistory.textContent = isHidden ? '收起记录' : '展开记录';
    if (isHidden) renderDropsHistory();
  });

  function renderDropsHistory() {
    const history = (state.drops && state.drops.history) || [];
    dropsHistoryList.innerHTML = '';
    if (history.length === 0) {
      dropsHistoryList.innerHTML = '<div class="drops-history-empty">暂无水滴记录，完成任务即可获得水滴。</div>';
      return;
    }
    // Show newest first
    [...history].reverse().forEach(h => {
      const el = document.createElement('div');
      el.className = 'drops-history-item';
      const amountStr = h.amount < 0 ? h.amount : '+' + h.amount;
      el.innerHTML = `<span class="dhi-date">${h.date || '-'}</span><span class="dhi-amount${h.amount < 0 ? ' negative' : ''}">${amountStr}</span><span class="dhi-reason">${esc(h.reason || '')}</span>`;
      dropsHistoryList.appendChild(el);
    });
  }

  function showWaterCelebration(total) {
    const overlay = document.getElementById('celebrate-overlay');
    const msgEl = document.getElementById('celebrate-msg');
    const canvas = document.getElementById('confetti-canvas');
    msgEl.innerHTML = '\uD83D\uDCA7 ' + total + ' 滴水滴！<br><span style="font-size:.8rem;font-weight:400">每一滴都是你专注的印记</span>';
    msgEl.className = 'celebrate-msg water-theme';
    overlay.classList.remove('hidden');
    fireConfetti(canvas, true);
    setTimeout(() => { overlay.classList.add('hidden'); msgEl.className = 'celebrate-msg'; }, 2800);
  }

  // ===== DUMP VIEW =====
  const dumpInput = document.getElementById('dump-input');
  const btnAnalyze = document.getElementById('btn-analyze');
  const btnAddManual = document.getElementById('btn-add-manual');
  const aiLoading = document.getElementById('ai-loading');

  btnAnalyze.addEventListener('click', async () => {
    const text = dumpInput.value.trim();
    if (!text) return;
    btnAnalyze.disabled = true;
    aiLoading.classList.remove('hidden');

    const now = new Date();
    const todayStr = todayKey();
    const weekday = ['周日','周一','周二','周三','周四','周五','周六'][now.getDay()];

    // Build available tags list for prompt
    const tagsList = (state.tags || []).map(t => `"${t.id}" (${t.name})`).join(', ');

    const sysPrompt = `你是一个专业的任务分析与时间管理助手。当前日期是 ${todayStr}（${weekday}）。

用户会给你一段杂乱的文字，可能包含待办事项、想法、计划等。请你：

1. **提取并细化任务**：从杂乱文字中提取每一个可执行的任务。如果任务比较庞大或描述模糊，请帮他拆分成具体的子步骤，放入 \`subtasks\` 数组。

2. **智能解析日期**：识别文字中的时间信息并转换为具体日期 (YYYY-MM-DD)。

3. **解析具体时间**（time 字段，HH:MM 格式，可选）。

4. **标签分类**（tags 字段，字符串数组）：
   可用标签ID: ${tagsList}
   根据任务内容选择合适的标签ID放入 tags 数组。

5. **优先级排序**（quadrant 字段）：
   - "urgent-important"：有明确截止日期且重要的
   - "important"：重要但不紧急
   - "urgent"：别人需要但对自己不太重要的
   - "neither"：可做可不做的

6. **估算时间**（duration，分钟）

7. **给出简短的执行建议**放在 note 中

8. **重复属性**（recurrence 字段）：每天做的选 "daily"；每周重复选 "weekly"；只做一次为 "none"

请严格返回 JSON 数组格式，不要有其他文字：
[{"name":"具体任务名","quadrant":"urgent-important","tags":["tag-vocation"],"date":"YYYY-MM-DD","time":"HH:MM或空","duration":30,"note":"执行建议","recurrence":"none","subtasks":[{"name":"子步骤1","done":false}]}]`;

    try {
      const raw = await callLLM(sysPrompt, text);
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error('AI 返回格式异常');
      const tasks = JSON.parse(jsonMatch[0]);
      tasks.forEach(t => addTask(t));
      dumpInput.value = '';
      switchView('board');
    } catch (e) {
      alert('分析失败：' + e.message);
    } finally {
      btnAnalyze.disabled = false;
      aiLoading.classList.add('hidden');
    }
  });

  btnAddManual.addEventListener('click', () => {
    const text = dumpInput.value.trim();
    if (!text) {
      openAddModal();
      return;
    }
    const lines = text.split(/\n/).map(l => l.replace(/^[-*·•\d.、]+\s*/, '').trim()).filter(Boolean);
    if (lines.length === 0) {
      dumpInput.value = '';
      openAddModal();
      return;
    }
    lines.forEach(name => addTask({ name }));
    dumpInput.value = '';
    switchView('board');
  });

  // ===== BOARD VIEW =====
  let boardTagFilter = 'all';

  function renderBoardFilters() {
    const container = document.getElementById('board-filters');
    container.innerHTML = '';
    const allBtn = document.createElement('button');
    allBtn.className = 'cat-filter' + (boardTagFilter === 'all' ? ' active' : '');
    allBtn.dataset.tag = 'all';
    allBtn.textContent = '全部';
    allBtn.addEventListener('click', () => { boardTagFilter = 'all'; renderBoardFilters(); renderBoard(); });
    container.appendChild(allBtn);
    (state.tags || []).forEach(tag => {
      const btn = document.createElement('button');
      btn.className = 'cat-filter' + (boardTagFilter === tag.id ? ' active' : '');
      btn.dataset.tag = tag.id;
      btn.innerHTML = `<span class="cat-dot" style="background:${tag.color}"></span>${esc(tag.name)}`;
      btn.addEventListener('click', () => { boardTagFilter = tag.id; renderBoardFilters(); renderBoard(); });
      container.appendChild(btn);
    });
  }

  function formatDateShort(dateStr) {
    if (!dateStr) return '';
    const today = todayKey();
    if (dateStr === today) return '今天';
    const d = new Date(dateStr + 'T00:00:00');
    const t = new Date(today + 'T00:00:00');
    const diff = Math.round((d - t) / 86400000);
    if (diff === 1) return '明天';
    if (diff === 2) return '后天';
    if (diff === -1) return '昨天';
    if (diff > 2 && diff <= 7) return diff + '天后';
    if (diff < -1 && diff >= -7) return Math.abs(diff) + '天前';
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  const PRIORITY_ORDER = { 'urgent-important': 0, 'important': 1, 'urgent': 2, 'neither': 3 };
  const PRIORITY_LABELS = { 'urgent-important': '重要紧急', 'important': '重要', 'urgent': '紧急', 'neither': '一般' };
  const PRIORITY_COLORS = { 'urgent-important': 'var(--q1)', 'important': 'var(--q2)', 'urgent': 'var(--q3)', 'neither': 'var(--q4)' };

  function deadlineStatus(dateStr) {
    if (!dateStr) return null;
    const today = new Date(todayKey() + 'T00:00:00');
    const d = new Date(dateStr + 'T00:00:00');
    const diff = Math.round((d - today) / 86400000);
    if (diff < 0) return 'overdue';
    if (diff === 0) return 'today';
    if (diff === 1) return 'tomorrow';
    if (diff <= 3) return 'soon';
    return null;
  }

  function deadlineTag(status) {
    if (!status) return '';
    const cfg = {
      overdue:  { text: '已逾期', bg: 'rgba(239,68,68,.15)', color: 'var(--red)' },
      today:    { text: '今天截止', bg: 'rgba(234,179,8,.15)', color: 'var(--yellow)' },
      tomorrow: { text: '明天截止', bg: 'rgba(249,115,22,.12)', color: 'var(--orange)' },
      soon:     { text: '即将到期', bg: 'rgba(6,182,212,.12)', color: 'var(--cyan)' },
    };
    const c = cfg[status];
    if (!c) return '';
    return `<span class="deadline-tag" style="background:${c.bg};color:${c.color}">${c.text}</span>`;
  }

  // ===== DRAG & DROP (Desktop) =====
  let dragSrcId = null;

  function handleDragStart(e) {
    dragSrcId = this.dataset.id;
    this.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragSrcId);
  }
  function handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const card = this.closest('.task-card');
    if (card && card.dataset.id !== dragSrcId) card.classList.add('drag-over');
  }
  function handleDragLeave() { this.classList.remove('drag-over'); }
  function handleDrop(e) {
    e.preventDefault();
    this.classList.remove('drag-over');
    const targetId = this.closest('.task-card')?.dataset.id;
    if (!targetId || targetId === dragSrcId) return;
    const srcIdx = state.tasks.findIndex(t => t.id === dragSrcId);
    const tgtIdx = state.tasks.findIndex(t => t.id === targetId);
    if (srcIdx === -1 || tgtIdx === -1) return;
    const [moved] = state.tasks.splice(srcIdx, 1);
    state.tasks.splice(tgtIdx, 0, moved);
    state.tasks.forEach((t, i) => t.sortOrder = i);
    saveState();
    renderBoard();
  }
  function handleDragEnd() {
    this.classList.remove('dragging');
    document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    dragSrcId = null;
  }

  // ===== TOUCH DRAG & DROP (Mobile) =====
  let touchDragCard = null;
  let touchDragId = null;
  let touchStartY = 0;
  let touchStartX = 0;
  let touchClone = null;
  let touchDragging = false;
  const TOUCH_DRAG_THRESHOLD = 10; // px before drag starts

  function handleTouchStart(e) {
    // Only start drag from the drag handle
    const handle = e.target.closest('.drag-handle');
    if (!handle) return;
    const card = handle.closest('.task-card');
    if (!card || card.classList.contains('done')) return;
    e.preventDefault();
    const touch = e.touches[0];
    touchStartY = touch.clientY;
    touchStartX = touch.clientX;
    touchDragCard = card;
    touchDragId = card.dataset.id;
    touchDragging = false;
  }

  function handleTouchMove(e) {
    if (!touchDragCard) return;
    const touch = e.touches[0];
    const dy = Math.abs(touch.clientY - touchStartY);
    const dx = Math.abs(touch.clientX - touchStartX);

    // Start dragging after threshold
    if (!touchDragging && (dy > TOUCH_DRAG_THRESHOLD || dx > TOUCH_DRAG_THRESHOLD)) {
      touchDragging = true;
      touchDragCard.classList.add('dragging');
      // Create floating clone
      touchClone = touchDragCard.cloneNode(true);
      touchClone.classList.add('touch-drag-clone');
      touchClone.style.position = 'fixed';
      touchClone.style.width = touchDragCard.offsetWidth + 'px';
      touchClone.style.zIndex = '1000';
      touchClone.style.pointerEvents = 'none';
      touchClone.style.opacity = '0.85';
      touchClone.style.boxShadow = '0 8px 25px rgba(0,0,0,0.3)';
      touchClone.style.transform = 'scale(1.02)';
      touchClone.style.transition = 'none';
      document.body.appendChild(touchClone);
    }

    if (!touchDragging) return;
    e.preventDefault();

    // Position the clone
    if (touchClone) {
      touchClone.style.left = '1rem';
      touchClone.style.right = '1rem';
      touchClone.style.top = (touch.clientY - touchDragCard.offsetHeight / 2) + 'px';
    }

    // Find drop target
    // Temporarily hide clone to get element underneath
    if (touchClone) touchClone.style.display = 'none';
    const elemBelow = document.elementFromPoint(touch.clientX, touch.clientY);
    if (touchClone) touchClone.style.display = '';

    // Clear previous drag-over
    document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));

    if (elemBelow) {
      const targetCard = elemBelow.closest('.task-card');
      if (targetCard && targetCard.dataset.id !== touchDragId && !targetCard.classList.contains('done')) {
        targetCard.classList.add('drag-over');
      }
    }
  }

  function handleTouchEnd(e) {
    if (!touchDragCard) return;

    if (touchDragging) {
      // Find the current drag-over target
      const overCard = document.querySelector('.task-card.drag-over');
      if (overCard) {
        const targetId = overCard.dataset.id;
        const srcIdx = state.tasks.findIndex(t => t.id === touchDragId);
        const tgtIdx = state.tasks.findIndex(t => t.id === targetId);
        if (srcIdx !== -1 && tgtIdx !== -1) {
          const [moved] = state.tasks.splice(srcIdx, 1);
          state.tasks.splice(tgtIdx, 0, moved);
          state.tasks.forEach((t, i) => t.sortOrder = i);
          saveState();
        }
      }
    }

    // Cleanup
    if (touchClone) { touchClone.remove(); touchClone = null; }
    if (touchDragCard) touchDragCard.classList.remove('dragging');
    document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    touchDragCard = null;
    touchDragId = null;
    touchDragging = false;

    renderBoard();
  }

  function renderBoard() {
    const boardList = document.getElementById('board-list');
    renderBoardFilters();
    let tasks = [...state.tasks];
    if (boardTagFilter !== 'all') tasks = tasks.filter(t => (t.tags || []).includes(boardTagFilter));
    tasks.sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      return (a.sortOrder ?? 999) - (b.sortOrder ?? 999);
    });

    boardList.innerHTML = '';
    if (tasks.length === 0) {
      boardList.innerHTML = '<div style="color:var(--text-muted);padding:2rem;text-align:center">暂无任务，去「倒空大脑」添加一些吧</div>';
      return;
    }
    tasks.forEach(t => {
      const card = document.createElement('div');
      const dlStatus = t.done ? null : deadlineStatus(t.date);
      card.className = 'task-card' + (t.done ? ' done' : '') + (dlStatus === 'overdue' ? ' card-overdue' : dlStatus === 'today' ? ' card-today' : '');
      card.dataset.id = t.id;
      card.draggable = !t.done;
      const tagsHtml = renderTagChips(t.tags);
      const dateLabel = formatDateShort(t.date);
      const timeLabel = t.time ? t.time : '';
      const recIcon = t.recurrence === 'daily' ? ' \uD83D\uDD04' : t.recurrence === 'weekly' ? ' \uD83D\uDD01' : '';
      const prioLabel = PRIORITY_LABELS[t.quadrant] || '一般';
      const prioColor = PRIORITY_COLORS[t.quadrant] || 'var(--q4)';
      const dlTag = deadlineTag(dlStatus);
      let subtaskTag = '';
      if (t.subtasks && t.subtasks.length > 0) {
        const doneCo = t.subtasks.filter(s => s.done).length;
        subtaskTag = `<span class="task-meta-tag" style="color:var(--accent);">\u2713 ${doneCo}/${t.subtasks.length}</span>`;
      }
      card.innerHTML = `
        <div class="task-card-top">
          <div class="drag-handle" title="拖拽排序">\u2807</div>
          <div class="task-checkbox ${t.done ? 'checked' : ''}" data-id="${t.id}"></div>
          <div class="task-card-name">${esc(t.name)}${recIcon}</div>
          ${dlTag}
          <span class="task-prio-tag" style="background:${prioColor}22;color:${prioColor};border:1px solid ${prioColor}44">${prioLabel}</span>
        </div>
        <div class="task-card-meta">
          ${tagsHtml}
          ${dateLabel ? '<span class="task-date-tag">' + dateLabel + '</span>' : ''}
          ${timeLabel ? '<span class="task-date-tag">' + timeLabel + '</span>' : ''}
          <span class="task-meta-tag"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>${t.duration}分钟</span>
          ${subtaskTag}
          ${t.note ? '<span class="task-meta-tag">' + esc(t.note.slice(0, 30)) + '</span>' : ''}
        </div>`;
      card.addEventListener('dragstart', handleDragStart);
      card.addEventListener('dragover', handleDragOver);
      card.addEventListener('dragleave', handleDragLeave);
      card.addEventListener('drop', handleDrop);
      card.addEventListener('dragend', handleDragEnd);
      // Mobile touch drag
      card.addEventListener('touchstart', handleTouchStart, { passive: false });
      card.addEventListener('click', (e) => {
        if (e.target.classList.contains('task-checkbox')) { toggleDone(t.id); return; }
        if (e.target.classList.contains('drag-handle')) return;
        openEditModal(t.id);
      });
      boardList.appendChild(card);
    });
  }

  function toggleDone(id) {
    const t = state.tasks.find(x => x.id === id);
    if (!t) return;
    const wasDone = t.done;
    t.done = !t.done;
    saveState();
    renderBoard();
    if (!wasDone && t.done) {
      // Award drops for task completion
      const weight = PRIORITY_WEIGHTS[t.quadrant] || 1;
      const dropAmount = Math.floor((t.duration || 30) / 60 * weight);
      awardDrops(dropAmount, '完成任务: ' + t.name);
      // Simple card animation on completion
      const card = document.querySelector(`.task-card[data-id="${id}"]`);
      if (card) {
        card.style.transition = 'transform .3s, opacity .3s';
        card.style.transform = 'scale(1.03)';
        setTimeout(() => { card.style.transform = ''; }, 300);
      }
    }
  }

  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  // ===== EDIT MODAL =====
  const modalOverlay = document.getElementById('modal-overlay');
  const modalClose = document.getElementById('modal-close');
  const editName = document.getElementById('edit-task-name');
  const editQuadrant = document.getElementById('edit-task-quadrant');
  const editRecurrence = document.getElementById('edit-task-recurrence');
  const editDate = document.getElementById('edit-task-date');
  const editTime = document.getElementById('edit-task-time');
  const editDuration = document.getElementById('edit-task-duration');
  const editNote = document.getElementById('edit-task-note');
  const editSubtasksList = document.getElementById('edit-subtasks-list');
  const editNewSubtask = document.getElementById('edit-new-subtask');
  const btnAddSubtask = document.getElementById('btn-add-subtask');
  const btnModalSave = document.getElementById('btn-modal-save');
  const btnModalDelete = document.getElementById('btn-modal-delete');
  const editTagsContainer = document.getElementById('edit-task-tags');
  let editingTaskId = null;
  let currentSubtasks = [];
  let selectedTags = [];

  function renderEditTags() {
    editTagsContainer.innerHTML = '';
    (state.tags || []).forEach(tag => {
      const chip = document.createElement('span');
      chip.className = 'tag-chip' + (selectedTags.includes(tag.id) ? ' selected' : '');
      chip.style.background = tag.color + '22';
      chip.style.color = tag.color;
      chip.textContent = tag.name;
      chip.addEventListener('click', () => {
        const idx = selectedTags.indexOf(tag.id);
        if (idx >= 0) selectedTags.splice(idx, 1);
        else selectedTags.push(tag.id);
        renderEditTags();
      });
      editTagsContainer.appendChild(chip);
    });
  }

  function renderSubtasks() {
    editSubtasksList.innerHTML = '';
    currentSubtasks.forEach((st, idx) => {
      const el = document.createElement('div');
      el.className = 'subtask-item' + (st.done ? ' done' : '');
      el.innerHTML = `
        <div class="subtask-checkbox ${st.done ? 'checked' : ''}"></div>
        <div class="subtask-name">${esc(st.name)}</div>
        <div class="subtask-remove">&times;</div>
      `;
      el.querySelector('.subtask-checkbox').addEventListener('click', () => { st.done = !st.done; renderSubtasks(); });
      el.querySelector('.subtask-remove').addEventListener('click', () => { currentSubtasks.splice(idx, 1); renderSubtasks(); });
      editSubtasksList.appendChild(el);
    });
  }

  function handleAddSubtask() {
    const val = editNewSubtask.value.trim();
    if (val) { currentSubtasks.push({ name: val, done: false }); editNewSubtask.value = ''; renderSubtasks(); }
  }
  btnAddSubtask.addEventListener('click', handleAddSubtask);
  editNewSubtask.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddSubtask(); } });

  function openEditModal(id) {
    const t = state.tasks.find(x => x.id === id);
    if (!t) return;
    editingTaskId = id;
    document.getElementById('modal-title').textContent = '编辑任务';
    btnModalDelete.style.display = '';
    editName.value = t.name;
    selectedTags = [...(t.tags || [])];
    renderEditTags();
    editQuadrant.value = t.quadrant;
    editRecurrence.value = t.recurrence || 'none';
    editDate.value = t.date || todayKey();
    editTime.value = t.time || '';
    editDuration.value = t.duration;
    editNote.value = t.note || '';
    currentSubtasks = JSON.parse(JSON.stringify(t.subtasks || []));
    renderSubtasks();
    modalOverlay.classList.remove('hidden');
  }

  function openAddModal() {
    editingTaskId = null;
    document.getElementById('modal-title').textContent = '添加任务';
    btnModalDelete.style.display = 'none';
    editName.value = '';
    selectedTags = [];
    renderEditTags();
    editQuadrant.value = 'important';
    editRecurrence.value = 'none';
    editDate.value = todayKey();
    editTime.value = '';
    editDuration.value = 30;
    editNote.value = '';
    currentSubtasks = [];
    renderSubtasks();
    modalOverlay.classList.remove('hidden');
    editName.focus();
  }

  modalClose.addEventListener('click', () => modalOverlay.classList.add('hidden'));
  modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) modalOverlay.classList.add('hidden'); });

  btnModalSave.addEventListener('click', () => {
    if (editingTaskId) {
      updateTask(editingTaskId, {
        name: editName.value.trim() || '未命名任务',
        tags: [...selectedTags],
        quadrant: editQuadrant.value,
        recurrence: editRecurrence.value,
        date: editDate.value || todayKey(),
        time: editTime.value || '',
        duration: parseInt(editDuration.value) || 30,
        note: editNote.value.trim(),
        subtasks: currentSubtasks
      });
    } else {
      addTask({
        name: editName.value.trim() || '未命名任务',
        tags: [...selectedTags],
        quadrant: editQuadrant.value,
        recurrence: editRecurrence.value,
        date: editDate.value || todayKey(),
        time: editTime.value || '',
        duration: parseInt(editDuration.value) || 30,
        note: editNote.value.trim(),
        subtasks: currentSubtasks
      });
    }
    modalOverlay.classList.add('hidden');
    renderBoard();
  });

  btnModalDelete.addEventListener('click', () => {
    if (!editingTaskId) return;
    if (confirm('确定删除这个任务吗？')) {
      deleteTask(editingTaskId);
      modalOverlay.classList.add('hidden');
      renderBoard();
    }
  });

  // ===== DAILY MAINTENANCE =====
  // Runs once per day on load: first handles recurring tasks, then removes completed non-recurring tasks from previous days
  function dailyMaintenance() {
    const today = todayKey();
    if (state.lastDailyCheck === today) return; // already ran today

    let changed = false;

    // 1. First: identify and advance recurring tasks to today (before any deletion)
    state.tasks.forEach(t => {
      if (t.recurrence && t.recurrence !== 'none' && t.date && t.date < today) {
        t.date = today;
        t.done = false; // reset done status for the new day
        changed = true;
      }
    });

    // 2. Then: remove completed NON-recurring tasks from previous days
    // Recurring tasks are never auto-deleted — they persist and keep generating
    const beforeCount = state.tasks.length;
    state.tasks = state.tasks.filter(t => {
      if (t.done && t.date && t.date < today && (!t.recurrence || t.recurrence === 'none')) return false;
      return true;
    });
    if (state.tasks.length !== beforeCount) changed = true;

    state.lastDailyCheck = today;
    saveState();
  }

  // ===== MIDNIGHT AUTO-REFRESH =====
  // Schedule dailyMaintenance to run at exactly 00:00 every day
  function scheduleMidnightRefresh() {
    const now = new Date();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
    const msUntilMidnight = tomorrow - now;
    setTimeout(() => {
      dailyMaintenance();
      renderActiveView();
      updateDropsDisplay();
      // After triggering at midnight, schedule the next one (every 24h as fallback)
      scheduleMidnightRefresh();
    }, msUntilMidnight);
  }
  // Also check on visibility change (covers case where device was sleeping at midnight)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      const today = todayKey();
      if (state.lastDailyCheck !== today) {
        dailyMaintenance();
        renderActiveView();
        updateDropsDisplay();
      }
    }
  });

  // ===== GANTT VIEW =====
  function renderGantt() {
    const container = document.getElementById('gantt-container');
    const today = new Date(todayKey() + 'T00:00:00');
    const isMobile = window.innerWidth <= 768;
    const dayCount = isMobile ? 5 : 14;
    const days = [];
    for (let i = 0; i < dayCount; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      days.push(d);
    }
    const weekdayNames = ['日','一','二','三','四','五','六'];
    const prioBarColors = {
      'urgent-important': '#ef4444',
      'important': '#6366f1',
      'urgent': '#f97316',
      'neither': '#64748b',
    };

    // Filter tasks that have dates within the range or before
    const endKey = days[days.length-1].toISOString().slice(0,10);
    const tasksInRange = state.tasks.filter(t => {
      if (!t.date) return false;
      return t.date <= endKey;
    }).sort((a,b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999));

    let html = '';
    // Priority legend
    html += '<div class="gantt-legend">';
    html += '<span class="gantt-legend-item"><span class="gantt-legend-dot" style="background:#ef4444"></span>重要紧急</span>';
    html += '<span class="gantt-legend-item"><span class="gantt-legend-dot" style="background:#6366f1"></span>重要</span>';
    html += '<span class="gantt-legend-item"><span class="gantt-legend-dot" style="background:#f97316"></span>紧急</span>';
    html += '<span class="gantt-legend-item"><span class="gantt-legend-dot" style="background:#64748b"></span>一般</span>';
    html += '</div>';

    if (isMobile) {
      // === MOBILE: Vertical card-based layout (no horizontal scroll needed) ===
      html += '<div class="gantt-mobile">';
      // Date tabs
      html += '<div class="gantt-m-dates">';
      days.forEach((d, i) => {
        const key = d.toISOString().slice(0,10);
        const isToday = key === todayKey();
        const isWeekend = d.getDay() === 0 || d.getDay() === 6;
        html += `<div class="gantt-m-date${isToday ? ' today' : ''}${isWeekend ? ' weekend' : ''}">
          <span class="gantt-m-day">${d.getDate()}</span>
          <span class="gantt-m-wd">周${weekdayNames[d.getDay()]}</span>
        </div>`;
      });
      html += '</div>';
      // Task bars below dates
      if (tasksInRange.length === 0) {
        html += '<div style="padding:1.5rem;color:var(--text-muted);text-align:center;font-size:.85rem">未来五天暂无任务</div>';
      }
      tasksInRange.forEach(t => {
        const durationMinutes = Number.isFinite(t.duration) ? t.duration : 30;
        const taskDate = new Date(t.date + 'T00:00:00');
        const durationDays = Math.max(1, Math.ceil(durationMinutes / 480));
        const startDiff = Math.round((taskDate - today) / 86400000);
        const barStart = Math.max(0, startDiff);
        const barEnd = Math.min(dayCount - 1, barStart + durationDays - 1);
        if (barStart > dayCount - 1) return;
        const leftPct = (barStart / dayCount * 100).toFixed(2);
        const widthPct = ((barEnd - barStart + 1) / dayCount * 100).toFixed(2);
        const barColor = prioBarColors[t.quadrant] || '#64748b';
        const prioLabel = PRIORITY_LABELS[t.quadrant] || '一般';
        html += `<div class="gantt-m-row">
          <div class="gantt-m-bar${t.done ? ' done' : ''}" style="margin-left:${leftPct}%;width:${widthPct}%;background:${barColor}">
            <span class="gantt-m-bar-name">${esc(t.name)}</span>
          </div>
          <div class="gantt-m-meta">
            <span class="gantt-m-prio" style="color:${barColor}">${prioLabel}</span>
            <span class="gantt-m-dur">${durationMinutes}分钟</span>
          </div>
        </div>`;
      });
      html += '</div>';
    } else {
      // === DESKTOP: Traditional horizontal Gantt chart ===
      html += '<div class="gantt-chart">';
      html += '<div class="gantt-header">';
      html += '<div class="gantt-label-col">任务</div>';
      days.forEach(d => {
        const key = d.toISOString().slice(0,10);
        const isToday = key === todayKey();
        const isWeekend = d.getDay() === 0 || d.getDay() === 6;
        html += `<div class="gantt-day-col${isToday ? ' today' : ''}${isWeekend ? ' weekend' : ''}">${d.getMonth()+1}/${d.getDate()}<br>周${weekdayNames[d.getDay()]}</div>`;
      });
      html += '</div>';

      if (tasksInRange.length === 0) {
        html += '<div style="padding:2rem;color:var(--text-muted);text-align:center">未来两周暂无任务</div>';
      }
      tasksInRange.forEach(t => {
        html += '<div class="gantt-row">';
        html += `<div class="gantt-row-label" title="${esc(t.name)}">${esc(t.name)}</div>`;
        html += '<div class="gantt-row-cells">';
        days.forEach(d => {
          const key = d.toISOString().slice(0,10);
          const isToday = key === todayKey();
          html += `<div class="gantt-cell${isToday ? ' today' : ''}"></div>`;
        });
        const taskDate = new Date(t.date + 'T00:00:00');
        const durationDays = Math.max(1, Math.ceil((t.duration || 30) / 480));
        const startDiff = Math.round((taskDate - today) / 86400000);
        const barStart = Math.max(0, startDiff);
        const barEnd = Math.min(dayCount - 1, barStart + durationDays - 1);
        if (barStart <= dayCount - 1) {
          const leftPct = (barStart / dayCount * 100).toFixed(2);
          const widthPct = ((barEnd - barStart + 1) / dayCount * 100).toFixed(2);
          const barColor = prioBarColors[t.quadrant] || '#64748b';
          html += `<div class="gantt-bar${t.done ? ' done' : ''}" style="left:${leftPct}%;width:${widthPct}%;background:${barColor}">${esc(t.name)}</div>`;
        }
        html += '</div></div>';
      });
      html += '</div>';
    }
    container.innerHTML = html;
  }

  // ===== AI CHAT VIEW =====
  const chatMessages = document.getElementById('chat-messages');
  const chatInput = document.getElementById('chat-input');
  const btnChatSend = document.getElementById('btn-chat-send');
  let chatHistory = [];

  function buildTaskContext() {
    const today = todayKey();
    const now = new Date();
    const weekday = ['周日','周一','周二','周三','周四','周五','周六'][now.getDay()];
    const undone = state.tasks.filter(t => !t.done);
    const done = state.tasks.filter(t => t.done);
    const overdue = undone.filter(t => t.date && t.date < today);
    const todayTasks = undone.filter(t => t.date === today);

    let ctx = `当前日期: ${today}（${weekday}），当前时间: ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}\n`;
    ctx += `任务概况: 共 ${state.tasks.length} 个任务，未完成 ${undone.length} 个，已完成 ${done.length} 个\n`;
    ctx += `专注水滴: ${(state.drops && state.drops.total) || 0} 滴\n`;
    if (overdue.length > 0) ctx += `逾期任务 (${overdue.length}个): ${overdue.map(t => t.name).join('、')}\n`;
    if (todayTasks.length > 0) ctx += `今日待办 (${todayTasks.length}个): ${todayTasks.map(t => `${t.name}${t.time ? '('+t.time+')' : ''} [${PRIORITY_LABELS[t.quadrant]||'一般'}]`).join('、')}\n`;
    ctx += '\n完整任务列表:\n';
    undone.forEach(t => {
      const dl = deadlineStatus(t.date);
      const dlLabel = dl === 'overdue' ? '[已逾期!]' : dl === 'today' ? '[今天截止]' : dl === 'tomorrow' ? '[明天截止]' : '';
      const tagNames = getTaskTagNames(t).join(',') || '无标签';
      const sub = (t.subtasks && t.subtasks.length > 0) ? ` (子任务: ${t.subtasks.filter(s=>s.done).length}/${t.subtasks.length} 完成)` : '';
      const rec = t.recurrence && t.recurrence !== 'none' ? ` [${t.recurrence === 'daily' ? '每天' : '每周'}循环]` : '';
      ctx += `- ${t.name} | ${PRIORITY_LABELS[t.quadrant]||'一般'} | ${tagNames} | 截止:${t.date||'无'}${t.time?' '+t.time:''} | ${t.duration}分钟${sub}${rec} ${dlLabel}\n`;
    });
    return ctx;
  }

  function getChatSystemPrompt() {
    const taskCtx = buildTaskContext();
    const userName = (state.userInfo && state.userInfo.name) || '朋友';
    return `你是"心流"效率系统的 AI 陪伴助手。你温暖、真诚、有同理心，同时也务实。
用户的名字是"${userName}"。

你的角色：
1. **情绪支持**：当用户说"不想干活"、"好累"、"焦虑"时，先共情，再温和地帮他找到一个最小的启动步骤
2. **任务分析**：你可以看到用户的所有任务数据，帮他分析优先级、发现问题
3. **行动规划**：帮用户制定当下可执行的具体计划
4. **拖延克服**：用2分钟法则等技巧帮用户启动
5. **适时鼓励**：看到已完成的任务或专注记录时，给予具体的肯定
6. **人文关怀**：关注用户的身心状态，适时提醒休息、喝水、活动身体；当感受到用户压力大或情绪低落时，给予温暖的陪伴和理解，不急于给出建议；偶尔分享一些生活智慧或温暖的话语，让用户感受到被关心

说话风格：
- 像一个理解你的好朋友，不说教
- 简短有力，不啰嗦（每次回复控制在 150 字以内）
- 可以偶尔用一些轻松的语气
- 如果用户明确在发泄情绪，先倾听，不急于给方案
- 适时表达关心，比如提醒注意身体、注意休息

以下是用户当前的任务数据：
${taskCtx}`;
  }

  const INITIAL_AI_MSG = '嗨，我已经看过你的任务列表了。有什么想聊的吗？不管是工作压力、拖延症，还是不知道该先做什么，都可以跟我说。';
  let chatSelectMode = false;
  let chatMsgIndex = 0;

  function appendChatMsg(role, text) {
    const div = document.createElement('div');
    const idx = chatMsgIndex++;
    div.className = 'chat-msg ' + (role === 'ai' ? 'ai' : 'user');
    div.dataset.idx = idx;
    div.dataset.role = role;
    div.dataset.text = text;
    const avatar = role === 'ai' ? 'AI' : '我';
    div.innerHTML = `<div class="chat-msg-select" data-idx="${idx}"></div><div class="chat-avatar">${avatar}</div><div class="chat-bubble">${esc(text)}</div>`;
    // checkbox click
    div.querySelector('.chat-msg-select').addEventListener('click', (e) => {
      e.stopPropagation();
      e.currentTarget.classList.toggle('checked');
    });
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function appendTypingIndicator() {
    const div = document.createElement('div');
    div.className = 'chat-msg ai';
    div.id = 'chat-typing';
    div.innerHTML = `<div class="chat-avatar">AI</div><div class="chat-bubble typing-bubble"><span class="typing-dots"><span>.</span><span>.</span><span>.</span></span></div>`;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function removeTypingIndicator() {
    const el = document.getElementById('chat-typing');
    if (el) el.remove();
  }

  async function sendChatMessage(text) {
    if (!text.trim()) return;
    appendChatMsg('user', text);
    chatInput.value = '';
    chatInput.style.height = 'auto';
    btnChatSend.disabled = true;
    chatHistory.push({ role: 'user', content: text });
    appendTypingIndicator();
    try {
      const cfg = getApiConfig();
      if (!cfg.key) throw new Error('请先在设置中配置 API Key');
      const messages = [
        { role: 'system', content: getChatSystemPrompt() },
        ...chatHistory.slice(-10)
      ];
      const res = await fetch(cfg.base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key },
        body: JSON.stringify({ model: cfg.model, messages, temperature: 0.7 }),
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error('API 错误 (' + res.status + '): ' + err.slice(0, 200));
      }
      const data = await res.json();
      const reply = data.choices[0].message.content;
      chatHistory.push({ role: 'assistant', content: reply });
      removeTypingIndicator();
      appendChatMsg('ai', reply);
    } catch (e) {
      removeTypingIndicator();
      appendChatMsg('ai', '连接失败: ' + e.message + '\n请检查设置中的 API Key 配置。');
    } finally {
      btnChatSend.disabled = false;
      chatInput.focus();
    }
  }

  btnChatSend.addEventListener('click', () => sendChatMessage(chatInput.value));
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(chatInput.value); }
  });
  chatInput.addEventListener('input', () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
  });
  document.querySelectorAll('.chat-quick-btn').forEach(btn => {
    btn.addEventListener('click', () => sendChatMessage(btn.dataset.prompt));
  });

  // ===== CHAT: CLEAR =====
  function resetChat() {
    chatHistory = [];
    chatMsgIndex = 0;
    chatMessages.innerHTML = '';
    appendChatMsg('ai', INITIAL_AI_MSG);
    exitSelectMode();
  }

  document.getElementById('btn-chat-clear').addEventListener('click', () => {
    if (chatHistory.length === 0) return;
    if (confirm('确定清空当前对话？未收藏的内容将丢失。')) resetChat();
  });

  // ===== CHAT: SELECT MODE =====
  const chatSelectBar = document.getElementById('chat-select-bar');
  const btnChatSelect = document.getElementById('btn-chat-select');

  function enterSelectMode() {
    chatSelectMode = true;
    chatMessages.classList.add('selecting-mode');
    chatSelectBar.classList.remove('hidden');
    btnChatSelect.classList.add('active');
  }

  function exitSelectMode() {
    chatSelectMode = false;
    chatMessages.classList.remove('selecting-mode');
    chatSelectBar.classList.add('hidden');
    btnChatSelect.classList.remove('active');
    // Uncheck all
    chatMessages.querySelectorAll('.chat-msg-select.checked').forEach(el => el.classList.remove('checked'));
  }

  btnChatSelect.addEventListener('click', () => {
    if (chatSelectMode) exitSelectMode();
    else enterSelectMode();
  });

  document.getElementById('btn-chat-cancel-select').addEventListener('click', exitSelectMode);

  document.getElementById('btn-chat-save-selected').addEventListener('click', () => {
    const checked = chatMessages.querySelectorAll('.chat-msg-select.checked');
    if (checked.length === 0) { alert('请先勾选要收藏的对话。'); return; }
    const msgs = [];
    checked.forEach(el => {
      const msgDiv = el.closest('.chat-msg');
      if (msgDiv) {
        msgs.push({ role: msgDiv.dataset.role || 'ai', text: msgDiv.dataset.text || '' });
      }
    });
    if (msgs.length === 0) return;
    if (!Array.isArray(state.savedChats)) state.savedChats = [];
    state.savedChats.push({
      id: 'sc-' + genId(),
      date: new Date().toISOString(),
      messages: msgs,
    });
    saveState();
    exitSelectMode();
    alert('已收藏 ' + msgs.length + ' 条对话！');
  });

  // ===== CHAT: VIEW SAVED =====
  const savedChatsOverlay = document.getElementById('saved-chats-overlay');
  const savedChatsList = document.getElementById('saved-chats-list');

  function renderSavedChats() {
    const chats = state.savedChats || [];
    savedChatsList.innerHTML = '';
    if (chats.length === 0) {
      savedChatsList.innerHTML = '<div class="saved-chats-empty">暂无收藏的对话。<br>在聊天界面点击「收藏对话」可以选择并保存。</div>';
      return;
    }
    // Show newest first
    [...chats].reverse().forEach((group, reverseIdx) => {
      const realIdx = chats.length - 1 - reverseIdx;
      const div = document.createElement('div');
      div.className = 'saved-chat-group';
      const d = new Date(group.date);
      const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
      let html = `<div class="saved-chat-header"><span class="saved-chat-date">${dateStr}  (${group.messages.length} 条)</span><button class="saved-chat-delete" data-idx="${realIdx}" title="删除">&times;</button></div>`;
      group.messages.forEach(m => {
        const roleLabel = m.role === 'user' ? '我' : 'AI';
        const cls = m.role === 'user' ? 'user' : 'ai';
        html += `<div class="saved-chat-msg ${cls}"><div class="saved-chat-msg-role">${roleLabel}</div>${esc(m.text)}</div>`;
      });
      div.innerHTML = html;
      div.querySelector('.saved-chat-delete').addEventListener('click', () => {
        if (confirm('删除这条收藏？')) {
          state.savedChats.splice(realIdx, 1);
          saveState();
          renderSavedChats();
        }
      });
      savedChatsList.appendChild(div);
    });
  }

  document.getElementById('btn-chat-saved').addEventListener('click', () => {
    renderSavedChats();
    savedChatsOverlay.classList.remove('hidden');
  });
  document.getElementById('saved-chats-close').addEventListener('click', () => {
    savedChatsOverlay.classList.add('hidden');
  });
  savedChatsOverlay.addEventListener('click', (e) => {
    if (e.target === savedChatsOverlay) savedChatsOverlay.classList.add('hidden');
  });

  // ===== SETTINGS =====
  const providerSelect = document.getElementById('llm-provider');
  const customUrlRow = document.getElementById('custom-url-row');
  const baseUrlInput = document.getElementById('llm-base-url');
  const apiKeyInput = document.getElementById('llm-api-key');
  const modelInput = document.getElementById('llm-model');
  const btnToggleKey = document.getElementById('btn-toggle-key');
  const btnTestAi = document.getElementById('btn-test-ai');
  const testResult = document.getElementById('ai-test-result');
  const userNameInput = document.getElementById('setting-user-name');

  function loadSettingsUI() {
    providerSelect.value = state.settings.provider || 'deepseek';
    baseUrlInput.value = state.settings.baseUrl || '';
    apiKeyInput.value = state.settings.apiKey || '';
    modelInput.value = state.settings.model || '';
    customUrlRow.style.display = providerSelect.value === 'custom' ? '' : 'none';
    if (!modelInput.value) modelInput.value = PROVIDER_MODELS[providerSelect.value] || '';
    userNameInput.value = (state.userInfo && state.userInfo.name) || '';
  }

  providerSelect.addEventListener('change', () => {
    customUrlRow.style.display = providerSelect.value === 'custom' ? '' : 'none';
    modelInput.value = PROVIDER_MODELS[providerSelect.value] || modelInput.value;
    saveSettings();
  });

  let settingsSaveTimer = null;
  function saveSettings() {
    state.settings.provider = providerSelect.value;
    state.settings.baseUrl = baseUrlInput.value.trim().replace(/\/+$/, '');
    state.settings.apiKey = apiKeyInput.value.trim();
    state.settings.model = modelInput.value.trim();
    if (!state.userInfo) state.userInfo = {};
    state.userInfo.name = userNameInput.value.trim();
    // Debounce: only persist after 600ms of inactivity (avoid per-keystroke saves)
    clearTimeout(settingsSaveTimer);
    settingsSaveTimer = setTimeout(() => saveState(), 600);
  }

  [apiKeyInput, baseUrlInput, modelInput, userNameInput].forEach(el => {
    el.addEventListener('change', saveSettings);
    el.addEventListener('input', saveSettings);
  });

  btnToggleKey.addEventListener('click', () => {
    apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
  });

  btnTestAi.addEventListener('click', async () => {
    saveSettings();
    testResult.textContent = '测试中...';
    testResult.className = 'test-result';
    try {
      const reply = await callLLM('你是一个助手。', '请回复"连接成功"四个字。');
      testResult.textContent = '连接成功: ' + reply.slice(0, 50);
      testResult.className = 'test-result success';
    } catch (e) {
      testResult.textContent = '连接失败: ' + e.message;
      testResult.className = 'test-result error';
    }
  });

  // ===== SETTINGS: Render dynamic lists (tags, links) =====
  function renderSettingsLists() {
    renderTagSettings();
    renderLinksSettings();
  }

  // -- Tags --
  function renderTagSettings() {
    const container = document.getElementById('tag-manager-list');
    container.innerHTML = '';
    (state.tags || []).forEach((tag, idx) => {
      const el = document.createElement('div');
      el.className = 'setting-list-item';
      el.innerHTML = `<input type="color" class="sli-color-picker" value="${tag.color}" title="点击修改颜色"><span class="sli-label">${esc(tag.name)}</span><span class="sli-remove">&times;</span>`;
      el.querySelector('.sli-color-picker').addEventListener('input', (e) => {
        tag.color = e.target.value;
        saveState();
      });
      el.querySelector('.sli-color-picker').addEventListener('change', (e) => {
        tag.color = e.target.value;
        saveState();
        renderBoard();
      });
      el.querySelector('.sli-remove').addEventListener('click', () => {
        if (!confirm('删除标签 "' + tag.name + '"？任务中的此标签也会被移除。')) return;
        const tagId = tag.id;
        state.tags.splice(idx, 1);
        state.tasks.forEach(t => { if (t.tags) t.tags = t.tags.filter(id => id !== tagId); });
        saveState();
        renderTagSettings();
      });
      container.appendChild(el);
    });
  }
  document.getElementById('btn-add-tag').addEventListener('click', () => {
    const nameInput = document.getElementById('tag-new-name');
    const colorInput = document.getElementById('tag-new-color');
    const name = nameInput.value.trim();
    if (!name) return;
    state.tags.push({ id: 'tag-' + genId(), name, color: colorInput.value });
    saveState();
    nameInput.value = '';
    renderTagSettings();
  });

  // -- Links --
  function renderLinksSettings() {
    const container = document.getElementById('links-manager-list');
    container.innerHTML = '';
    (state.links || []).forEach((link, idx) => {
      const el = document.createElement('div');
      el.className = 'setting-list-item';
      el.innerHTML = `<span class="sli-label"><a href="${esc(link.url)}" target="_blank">${esc(link.name)}</a></span><span class="sli-remove">&times;</span>`;
      el.querySelector('.sli-remove').addEventListener('click', () => {
        state.links.splice(idx, 1);
        saveState();
        renderLinksSettings();
      });
      container.appendChild(el);
    });
  }
  document.getElementById('btn-add-link').addEventListener('click', () => {
    const nameInput = document.getElementById('link-new-name');
    const urlInput = document.getElementById('link-new-url');
    const name = nameInput.value.trim();
    const url = urlInput.value.trim();
    if (!name || !url) return;
    if (!state.links) state.links = [];
    state.links.push({ id: 'link-' + genId(), name, url });
    saveState();
    nameInput.value = '';
    urlInput.value = '';
    renderLinksSettings();
  });

  // Data management
  document.getElementById('btn-export').addEventListener('click', () => {
    try {
      const json = JSON.stringify(state, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'xinliu_backup_' + todayKey() + '.json';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      // Cleanup after a short delay (Safari needs time)
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 200);
    } catch (err) {
      alert('导出失败：' + err.message);
    }
  });

  const importFileInput = document.getElementById('import-file');
  const importModeOverlay = document.getElementById('import-mode-overlay');
  let pendingImportData = null;

  document.getElementById('btn-import').addEventListener('click', () => {
    importFileInput.value = '';
    importFileInput.click();
  });

  importFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const imported = JSON.parse(ev.target.result);
        if (!imported || typeof imported !== 'object') throw new Error('无效数据');
        pendingImportData = imported;
        importModeOverlay.classList.remove('hidden');
      } catch (err) {
        alert('导入失败：' + (err.message || '无效的 JSON 文件'));
      }
    };
    reader.onerror = () => { alert('导入失败：文件读取出错'); };
    reader.readAsText(file);
  });

  document.getElementById('import-mode-close').addEventListener('click', () => {
    importModeOverlay.classList.add('hidden');
    pendingImportData = null;
  });
  importModeOverlay.addEventListener('click', (e) => {
    if (e.target === importModeOverlay) { importModeOverlay.classList.add('hidden'); pendingImportData = null; }
  });

  // Overwrite mode: replace all data
  document.getElementById('import-mode-overwrite').addEventListener('click', () => {
    if (!pendingImportData) return;
    importModeOverlay.classList.add('hidden');
    state = mergeState(pendingImportData);
    pendingImportData = null;
    saveState();
    loadSettingsUI();
    renderDashboard();
    renderBoard();
    renderGantt();
    updateDropsDisplay();
    alert('覆盖导入成功！共 ' + (state.tasks ? state.tasks.length : 0) + ' 个任务。');
    switchView('board');
  });

  // Merge mode: combine with existing data
  document.getElementById('import-mode-merge').addEventListener('click', () => {
    if (!pendingImportData) return;
    importModeOverlay.classList.add('hidden');
    const imported = mergeState(pendingImportData);
    pendingImportData = null;
    // Merge tasks: add imported tasks that don't exist locally (by id)
    const existingIds = new Set((state.tasks || []).map(t => t.id));
    (imported.tasks || []).forEach(t => {
      if (!existingIds.has(t.id)) { state.tasks.push(t); }
    });
    // Merge tags: add imported tags that don't exist locally (by id)
    const existingTagIds = new Set((state.tags || []).map(t => t.id));
    (imported.tags || []).forEach(t => {
      if (!existingTagIds.has(t.id)) { state.tags.push(t); }
    });
    // Merge links: add imported links that don't exist locally (by id)
    const existingLinkIds = new Set((state.links || []).map(l => l.id));
    (imported.links || []).forEach(l => {
      if (!existingLinkIds.has(l.id)) { state.links.push(l); }
    });
    // Merge quotes: add new ones
    const existingQuotes = new Set(state.quotes || []);
    (imported.quotes || []).forEach(q => {
      if (!existingQuotes.has(q)) { state.quotes.push(q); }
    });
    // Merge savedChats: add new ones by id
    const existingChatIds = new Set((state.savedChats || []).map(c => c.id));
    (imported.savedChats || []).forEach(c => {
      if (!existingChatIds.has(c.id)) { state.savedChats.push(c); }
    });
    // Merge drops: take the higher total and combine history
    if (imported.drops) {
      if (!state.drops) state.drops = { total: 0, history: [] };
      state.drops.total = Math.max(state.drops.total, imported.drops.total || 0);
      const existingHistoryKeys = new Set((state.drops.history || []).map(h => h.date + h.reason + h.amount));
      (imported.drops.history || []).forEach(h => {
        const key = h.date + h.reason + h.amount;
        if (!existingHistoryKeys.has(key)) { state.drops.history.push(h); }
      });
    }
    saveState();
    loadSettingsUI();
    renderDashboard();
    renderBoard();
    renderGantt();
    updateDropsDisplay();
    alert('合并导入成功！当前共 ' + (state.tasks ? state.tasks.length : 0) + ' 个任务。');
    switchView('board');
  });

  document.getElementById('btn-clear-data').addEventListener('click', () => {
    if (confirm('确定要清除所有数据吗？此操作不可恢复。\n\n注意：这将同时清除所有设备上的数据。')) {
      state = defaultState();
      state.lastModified = Date.now();
      localStorage.setItem(STATE_KEY, JSON.stringify(state));
      // Force push empty state to server (user explicitly chose to clear)
      if (serverLoaded) {
        fetch('/api/data', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(state),
        }).catch(() => {});
      }
      loadSettingsUI();
      alert('数据已清除。');
      switchView('dump');
    }
  });

  // ===== THEME TOGGLE =====
  function getTheme() { return localStorage.getItem('xinliu_theme') || 'dark'; }
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('xinliu_theme', theme);
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) metaTheme.content = theme === 'light' ? '#f8fafc' : '#0f172a';
    document.getElementById('theme-icon-dark').style.display = theme === 'dark' ? '' : 'none';
    document.getElementById('theme-icon-light').style.display = theme === 'light' ? '' : 'none';
    document.getElementById('theme-toggle-text').textContent = theme === 'dark' ? '浅色模式' : '深色模式';
  }
  applyTheme(getTheme());
  document.getElementById('theme-toggle-btn').addEventListener('click', () => {
    applyTheme(getTheme() === 'dark' ? 'light' : 'dark');
  });

  // ===== DASHBOARD VIEW =====
  const DEFAULT_QUOTES = [
    '把大事拆成小事，小事拆成现在就能做的事。',
    '完成比完美更重要。',
    '专注是最好的时间管理。',
    '你不需要看到整条路，只需迈出下一步。',
    '休息不是偷懒，是为了走更远的路。',
    '别想太多，先做5分钟再说。',
    '今天完成的每一件小事，都在为未来的你铺路。',
    '心流状态：忘记时间，沉浸其中。',
    '不要等到准备好才开始，开始了才会准备好。',
    '照顾好自己，才能更好地面对一切。',
    '累了就歇一歇，世界不会因此停转。',
  ];

  function getQuotes() {
    const q = state.quotes && state.quotes.length > 0 ? state.quotes : DEFAULT_QUOTES;
    return q;
  }

  function renderDashboard() {
    const now = new Date();
    const h = now.getHours();
    const greeting = h < 6 ? '夜深了' : h < 11 ? '早上好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好';
    const userName = (state.userInfo && state.userInfo.name) ? state.userInfo.name : '';
    document.getElementById('dash-greeting-text').textContent = userName ? greeting + '，' + userName : greeting;
    const weekdays = ['周日','周一','周二','周三','周四','周五','周六'];
    document.getElementById('dash-date').textContent =
      `${now.getFullYear()}年${now.getMonth()+1}月${now.getDate()}日 ${weekdays[now.getDay()]}`;

    const quotes = getQuotes();
    const dayIdx = Math.floor(now.getTime() / 86400000) % quotes.length;
    document.getElementById('dash-quote').textContent = quotes[dayIdx];

    const today = todayKey();
    const undone = state.tasks.filter(t => !t.done);
    const overdue = undone.filter(t => t.date && t.date < today);
    const todayTasks = undone.filter(t => t.date === today);
    const todayDone = state.tasks.filter(t => t.done && t.date === today);

    document.getElementById('dash-undone').textContent = undone.length;
    document.getElementById('dash-overdue').textContent = overdue.length;
    document.getElementById('dash-today-count').textContent = todayTasks.length;
    document.getElementById('dash-focus-min').textContent = todayDone.length;
    updateDropsDisplay();

    // Quick Links
    const linksDiv = document.getElementById('dash-links');
    const linksSection = document.getElementById('dash-links-section');
    if ((state.links || []).length > 0) {
      linksSection.style.display = '';
      linksDiv.innerHTML = '';
      state.links.forEach(link => {
        const a = document.createElement('a');
        a.className = 'dash-link-item';
        a.href = link.url;
        a.target = '_blank';
        // Extract domain for display
        let domain = '';
        try { domain = new URL(link.url).hostname; } catch(e) { domain = link.url; }
        a.innerHTML = `<svg class="dli-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg><span class="dli-name">${esc(link.name)}</span><span class="dli-url">${esc(domain)}</span><span class="dli-arrow">›</span>`;
        linksDiv.appendChild(a);
      });
    } else {
      linksSection.style.display = 'none';
    }

    // Today tasks list
    const todayDiv = document.getElementById('dash-today-tasks');
    todayDiv.innerHTML = '';
    if (todayTasks.length === 0) {
      todayDiv.innerHTML = '<div style="color:var(--text-muted);font-size:.85rem;padding:.3rem 0">今天没有待办任务，好好休息或者去倒空大脑添加一些。</div>';
    }
    const prioColors = { 'urgent-important': 'var(--q1)', 'important': 'var(--q2)', 'urgent': 'var(--q3)', 'neither': 'var(--q4)' };
    todayTasks.sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999));
    todayTasks.forEach(t => {
      const el = document.createElement('div');
      el.className = 'dash-task-item';
      el.innerHTML = `<div class="dti-prio" style="background:${prioColors[t.quadrant]||'var(--q4)'}"></div><div class="dti-name">${esc(t.name)}</div>${t.time ? '<div class="dti-time">'+t.time+'</div>' : ''}`;
      el.addEventListener('click', () => { switchView('board'); openEditModal(t.id); });
      todayDiv.appendChild(el);
    });

    // Overdue section
    const overdueSection = document.getElementById('dash-overdue-section');
    const overdueDiv = document.getElementById('dash-overdue-tasks');
    if (overdue.length > 0) {
      overdueSection.style.display = '';
      overdueDiv.innerHTML = '';
      overdue.forEach(t => {
        const el = document.createElement('div');
        el.className = 'dash-task-item';
        const days = Math.round((new Date(today+'T00:00:00') - new Date(t.date+'T00:00:00')) / 86400000);
        el.innerHTML = `<div class="dti-prio" style="background:var(--red)"></div><div class="dti-name">${esc(t.name)}</div><div class="dti-dl" style="background:rgba(239,68,68,.15);color:var(--red)">逾期${days}天</div>`;
        el.addEventListener('click', () => { switchView('board'); openEditModal(t.id); });
        overdueDiv.appendChild(el);
      });
    } else {
      overdueSection.style.display = 'none';
    }
  }

  // ===== DASHBOARD QUICK ACTIONS =====
  // Migrate all overdue tasks to today
  document.getElementById('btn-migrate-overdue').addEventListener('click', () => {
    const today = todayKey();
    const overdue = state.tasks.filter(t => !t.done && t.date && t.date < today);
    if (overdue.length === 0) return;
    overdue.forEach(t => { t.date = today; });
    saveState();
    renderDashboard();
    renderBoard();
    alert('已将 ' + overdue.length + ' 个逾期任务迁移至今日。');
  });

  // ===== CELEBRATION EFFECT =====
  // Only 100-drop milestones trigger celebration (handled in awardDrops / showWaterCelebration)
  // No per-task-count milestone celebrations

  function fireConfetti(canvas, waterTheme) {
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const particles = [];
    const colors = waterTheme
      ? ['#06b6d4','#0ea5e9','#38bdf8','#7dd3fc','#a5f3fc','#67e8f9','#22d3ee']
      : ['#6366f1','#22c55e','#f97316','#06b6d4','#eab308','#ef4444','#f472b6'];
    for (let i = 0; i < 80; i++) {
      particles.push({
        x: canvas.width / 2 + (Math.random() - .5) * 200,
        y: canvas.height / 2,
        vx: (Math.random() - .5) * 12,
        vy: -Math.random() * 14 - 4,
        size: Math.random() * 6 + 3,
        color: colors[Math.floor(Math.random() * colors.length)],
        rotation: Math.random() * 360,
        rotSpeed: (Math.random() - .5) * 10,
        life: 1,
      });
    }
    let frame = 0;
    function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      let alive = false;
      particles.forEach(p => {
        if (p.life <= 0) return;
        alive = true;
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.35;
        p.rotation += p.rotSpeed;
        p.life -= 0.015;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation * Math.PI / 180);
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.fillStyle = p.color;
        if (waterTheme) {
          // Draw water drop shape
          ctx.beginPath();
          ctx.arc(0, p.size * 0.3, p.size * 0.5, 0, Math.PI * 2);
          ctx.moveTo(0, -p.size * 0.6);
          ctx.lineTo(p.size * 0.5, p.size * 0.3);
          ctx.lineTo(-p.size * 0.5, p.size * 0.3);
          ctx.closePath();
          ctx.fill();
        } else {
          ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        }
        ctx.restore();
      });
      frame++;
      if (alive && frame < 120) requestAnimationFrame(draw);
      else ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    draw();
  }

  // ===== HABITS (长期习惯) =====
  function getHabits() {
    if (!state.habits) state.habits = [];
    return state.habits;
  }
  function getHabitLogs() {
    if (!state.habitLogs) state.habitLogs = [];
    return state.habitLogs;
  }

  let editingHabitId = null;
  let loggingHabitId = null;

  const habitModalOverlay = document.getElementById('habit-modal-overlay');
  const habitLogOverlay = document.getElementById('habit-log-overlay');

  function renderHabits() {
    const list = document.getElementById('habits-list');
    const logSection = document.getElementById('habits-log-section');
    const logDiv = document.getElementById('habits-log');
    if (!list) return;

    const habits = getHabits();
    list.innerHTML = '';
    if (habits.length === 0) {
      list.innerHTML = '<div class="habits-empty">暂无长期习惯，点击上方按钮添加。<br>长期习惯可反复完成，每次记录时长或次数。</div>';
    }
    habits.forEach(h => {
      const logs = getHabitLogs().filter(l => l.habitId === h.id);
      const totalVal = logs.reduce((s, l) => s + (l.value || 0), 0);
      const totalDrops = logs.reduce((s, l) => s + (l.dropsEarned || 0), 0);
      const todayLogs = logs.filter(l => l.date === todayKey());
      const todayVal = todayLogs.reduce((s, l) => s + (l.value || 0), 0);
      const unit = h.type === 'duration' ? '分钟' : '次';
      const el = document.createElement('div');
      el.className = 'habit-card';
      el.innerHTML = `
        <div class="habit-icon">${h.icon || '🔄'}</div>
        <div class="habit-info">
          <div class="habit-name">${esc(h.name)}</div>
          <div class="habit-stats">
            <span class="habit-stat">今日: <span class="habit-stat-val">${todayVal} ${unit}</span></span>
            <span class="habit-stat">累计: <span class="habit-stat-val">${totalVal} ${unit}</span></span>
            <span class="habit-stat">共 <span class="habit-stat-val">${logs.length}</span> 次</span>
          </div>
          <div class="habit-drops-info">💧 累计获得 ${totalDrops} 水滴 · 每${h.type === 'duration' ? '小时' : '次'} +${h.dropsPerUnit} 滴</div>
        </div>
        <div class="habit-actions">
          <button class="habit-btn-log">打卡</button>
          <button class="habit-btn-edit">编辑</button>
        </div>
      `;
      el.querySelector('.habit-btn-log').addEventListener('click', () => openHabitLogModal(h.id));
      el.querySelector('.habit-btn-edit').addEventListener('click', () => openHabitEditModal(h.id));
      list.appendChild(el);
    });

    // Render logs
    const allLogs = getHabitLogs();
    if (allLogs.length > 0) {
      logSection.style.display = '';
      logDiv.innerHTML = '';
      [...allLogs].reverse().slice(0, 30).forEach(l => {
        const habit = habits.find(h => h.id === l.habitId);
        const unit = (habit && habit.type === 'duration') ? '分钟' : '次';
        const el = document.createElement('div');
        el.className = 'habit-log-item';
        el.innerHTML = `<span class="hli-date">${l.date}</span><span class="hli-icon">${(habit && habit.icon) || '🔄'}</span><span class="hli-name">${esc((habit && habit.name) || '已删除')}</span><span class="hli-val">${l.value} ${unit}</span><span class="hli-drops">+💧${l.dropsEarned}</span>`;
        logDiv.appendChild(el);
      });
    } else {
      logSection.style.display = 'none';
    }
  }

  // Add habit button
  document.getElementById('btn-add-habit').addEventListener('click', () => openHabitEditModal(null));

  function openHabitEditModal(id) {
    editingHabitId = id;
    const habit = id ? getHabits().find(h => h.id === id) : null;
    document.getElementById('habit-modal-title').textContent = habit ? '编辑习惯' : '添加习惯';
    document.getElementById('btn-habit-delete').style.display = habit ? '' : 'none';
    document.getElementById('habit-edit-name').value = habit ? habit.name : '';
    document.getElementById('habit-edit-type').value = habit ? habit.type : 'duration';
    document.getElementById('habit-edit-icon').value = habit ? habit.icon : '';
    document.getElementById('habit-edit-drops').value = habit ? habit.dropsPerUnit : 2;
    habitModalOverlay.classList.remove('hidden');
  }

  document.getElementById('habit-modal-close').addEventListener('click', () => habitModalOverlay.classList.add('hidden'));
  habitModalOverlay.addEventListener('click', (e) => { if (e.target === habitModalOverlay) habitModalOverlay.classList.add('hidden'); });

  document.getElementById('btn-habit-save').addEventListener('click', () => {
    const name = document.getElementById('habit-edit-name').value.trim();
    if (!name) { alert('请输入习惯名称'); return; }
    const type = document.getElementById('habit-edit-type').value;
    const icon = document.getElementById('habit-edit-icon').value.trim() || '🔄';
    const dropsPerUnit = parseInt(document.getElementById('habit-edit-drops').value) || 2;
    const habits = getHabits();
    if (editingHabitId) {
      const h = habits.find(x => x.id === editingHabitId);
      if (h) { h.name = name; h.type = type; h.icon = icon; h.dropsPerUnit = dropsPerUnit; }
    } else {
      habits.push({ id: 'habit-' + genId(), name, type, icon, dropsPerUnit, createdAt: new Date().toISOString() });
    }
    saveState();
    habitModalOverlay.classList.add('hidden');
    renderHabits();
  });

  document.getElementById('btn-habit-delete').addEventListener('click', () => {
    if (!editingHabitId) return;
    if (confirm('删除此习惯？相关记录将保留。')) {
      const habits = getHabits();
      const idx = habits.findIndex(h => h.id === editingHabitId);
      if (idx >= 0) habits.splice(idx, 1);
      saveState();
      habitModalOverlay.classList.add('hidden');
      renderHabits();
    }
  });

  // Habit log (record completion)
  function openHabitLogModal(id) {
    loggingHabitId = id;
    const habit = getHabits().find(h => h.id === id);
    if (!habit) return;
    document.getElementById('habit-log-title').textContent = habit.icon + ' ' + habit.name;
    const isDuration = habit.type === 'duration';
    document.getElementById('habit-log-label').textContent = isDuration ? '完成时长 (分钟)' : '完成次数';
    document.getElementById('habit-log-value').value = isDuration ? 30 : 1;
    updateHabitLogPreview();
    habitLogOverlay.classList.remove('hidden');
  }

  function updateHabitLogPreview() {
    const habit = getHabits().find(h => h.id === loggingHabitId);
    if (!habit) return;
    const val = parseInt(document.getElementById('habit-log-value').value) || 0;
    let drops;
    if (habit.type === 'duration') {
      drops = Math.floor(val / 60 * habit.dropsPerUnit);
      if (drops === 0 && val > 0) drops = Math.max(1, Math.round(val / 60 * habit.dropsPerUnit));
    } else {
      drops = val * habit.dropsPerUnit;
    }
    document.getElementById('habit-log-drops-preview').textContent = '预计获得 💧 ' + drops + ' 水滴';
  }

  document.getElementById('habit-log-value').addEventListener('input', updateHabitLogPreview);
  document.getElementById('habit-log-close').addEventListener('click', () => habitLogOverlay.classList.add('hidden'));
  habitLogOverlay.addEventListener('click', (e) => { if (e.target === habitLogOverlay) habitLogOverlay.classList.add('hidden'); });

  document.getElementById('btn-habit-log-save').addEventListener('click', () => {
    const habit = getHabits().find(h => h.id === loggingHabitId);
    if (!habit) return;
    const val = parseInt(document.getElementById('habit-log-value').value) || 0;
    if (val <= 0) { alert('请输入有效数值'); return; }
    let drops;
    if (habit.type === 'duration') {
      drops = Math.floor(val / 60 * habit.dropsPerUnit);
      if (drops === 0 && val > 0) drops = Math.max(1, Math.round(val / 60 * habit.dropsPerUnit));
    } else {
      drops = val * habit.dropsPerUnit;
    }
    // Record log
    getHabitLogs().push({
      id: 'hlog-' + genId(),
      habitId: habit.id,
      date: todayKey(),
      value: val,
      dropsEarned: drops,
    });
    // Award drops
    if (drops > 0) {
      awardDrops(drops, '习惯打卡: ' + habit.name);
    }
    saveState();
    habitLogOverlay.classList.add('hidden');
    renderHabits();
    showShopToast(habit.icon + ' 完成！获得 💧' + drops + ' 水滴', 'success');
  });

  // ===== SHOP (消费商城) =====
  const DEFAULT_SHOP_ITEMS = [
    { id: 'shop-1', name: '娱乐型放松/h', icon: '🎮', price: 20, stock: -1 },
    { id: 'shop-2', name: '成长型放松/h', icon: '📚', price: 10, stock: -1 },
    { id: 'shop-3', name: '聊天水群/h', icon: '💬', price: 5, stock: -1 },
    { id: 'shop-4', name: '约会/次', icon: '💕', price: 30, stock: -1 },
  ];

  function getShopItems() {
    if (!state.shopItems) state.shopItems = JSON.parse(JSON.stringify(DEFAULT_SHOP_ITEMS));
    return state.shopItems;
  }

  function getShopHistory() {
    if (!state.shopHistory) state.shopHistory = [];
    return state.shopHistory;
  }

  function showShopToast(msg, type) {
    const existing = document.querySelector('.shop-toast');
    if (existing) existing.remove();
    const el = document.createElement('div');
    el.className = 'shop-toast ' + type;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2500);
  }

  function buyShopItem(itemId) {
    const items = getShopItems();
    const item = items.find(i => i.id === itemId);
    if (!item) return;
    const drops = (state.drops && state.drops.total) || 0;
    if (drops < item.price) {
      showShopToast('水滴不足！需要 ' + item.price + ' 滴，当前 ' + drops + ' 滴', 'error');
      return;
    }
    if (item.stock === 0) {
      showShopToast('商品已售罄！', 'error');
      return;
    }
    // Deduct drops
    state.drops.total -= item.price;
    state.drops.history.push({ date: todayKey(), amount: -item.price, reason: '兑换: ' + item.name });
    // Decrease stock if limited
    if (item.stock > 0) item.stock--;
    // Record purchase
    getShopHistory().push({ date: todayKey(), name: item.name, icon: item.icon, price: item.price });
    saveState();
    updateDropsDisplay();
    renderShop();
    showShopToast('兑换成功！' + item.icon + ' ' + item.name, 'success');
  }

  function deleteShopItem(itemId) {
    const items = getShopItems();
    const idx = items.findIndex(i => i.id === itemId);
    if (idx >= 0) {
      items.splice(idx, 1);
      saveState();
      renderShop();
    }
  }

  function renderShop() {
    const grid = document.getElementById('shop-grid');
    const historyDiv = document.getElementById('shop-history');
    const dropsNum = document.getElementById('shop-drops-num');
    if (!grid) return;
    const drops = (state.drops && state.drops.total) || 0;
    dropsNum.textContent = drops;

    const items = getShopItems();
    grid.innerHTML = '';
    items.forEach(item => {
      const canBuy = drops >= item.price && item.stock !== 0;
      const soldOut = item.stock === 0;
      const stockText = item.stock < 0 ? '无限库存' : (soldOut ? '已售罄' : '剩余 ' + item.stock + ' 件');
      const el = document.createElement('div');
      el.className = 'shop-item';
      el.innerHTML = `
        <button class="shop-item-delete" title="删除商品">&times;</button>
        <div class="shop-item-icon">${item.icon || '🎁'}</div>
        <div class="shop-item-name">${esc(item.name)}</div>
        <div class="shop-item-price">💧 ${item.price} 水滴</div>
        <div class="shop-item-stock">${stockText}</div>
        <button class="btn-shop-buy${soldOut ? ' sold-out' : ''}" ${!canBuy ? 'disabled' : ''}>${soldOut ? '已售罄' : '兑换'}</button>
      `;
      el.querySelector('.btn-shop-buy').addEventListener('click', () => buyShopItem(item.id));
      el.querySelector('.shop-item-delete').addEventListener('click', () => {
        if (confirm('删除商品「' + item.name + '」？')) deleteShopItem(item.id);
      });
      grid.appendChild(el);
    });

    // Purchase history
    const history = getShopHistory();
    historyDiv.innerHTML = '';
    if (history.length === 0) {
      historyDiv.innerHTML = '<div class="shop-history-empty">暂无购买记录，用水滴兑换奖励犒劳自己吧！</div>';
    } else {
      [...history].reverse().forEach(h => {
        const el = document.createElement('div');
        el.className = 'shop-history-item';
        el.innerHTML = `<span class="shi-date">${h.date}</span><span class="shi-name">${h.icon || '🎁'} ${esc(h.name)}</span><span class="shi-price">-💧${h.price}</span>`;
        historyDiv.appendChild(el);
      });
    }
  }

  // Add custom shop item
  document.getElementById('btn-shop-add').addEventListener('click', () => {
    const nameInput = document.getElementById('shop-new-name');
    const priceInput = document.getElementById('shop-new-price');
    const iconInput = document.getElementById('shop-new-icon');
    const name = nameInput.value.trim();
    const price = parseInt(priceInput.value);
    const icon = iconInput.value.trim() || '🎁';
    if (!name) { showShopToast('请输入商品名称', 'error'); return; }
    if (!price || price <= 0) { showShopToast('请输入有效价格', 'error'); return; }
    const items = getShopItems();
    items.push({ id: 'shop-' + genId(), name, icon, price, stock: -1 });
    saveState();
    nameInput.value = '';
    priceInput.value = '';
    iconInput.value = '';
    renderShop();
    showShopToast('商品已添加！', 'success');
  });

  // ===== INIT =====
  // Global touch event listeners for mobile drag
  document.addEventListener('touchmove', handleTouchMove, { passive: false });
  document.addEventListener('touchend', handleTouchEnd);

  // ===== DEMO DATA INJECTION =====
  // Inject demo data if state is empty (for demonstration purposes)
  function injectDemoData() {
    if (localStorage.getItem('xinliu_demo_injected') === '1') return;
    if (state.tasks.length > 0 || (state.habits && state.habits.length > 0)) return; // already has data
    const today = todayKey();
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowKey = tomorrow.toISOString().slice(0, 10);
    const day3 = new Date(); day3.setDate(day3.getDate() + 2);
    const day3Key = day3.toISOString().slice(0, 10);
    const day4 = new Date(); day4.setDate(day4.getDate() + 3);
    const day4Key = day4.toISOString().slice(0, 10);

    // Demo tasks for board & gantt
    state.tasks = [
      { id: 'demo-1', name: '完成项目方案PPT', quadrant: 'urgent-important', tags: [], date: today, time: '09:00', duration: 120, note: '客户下午要看', recurrence: 'none', subtasks: [{name:'整理数据',done:true},{name:'制作图表',done:false}], done: false, sortOrder: 0, createdAt: new Date().toISOString() },
      { id: 'demo-2', name: '回复重要邮件', quadrant: 'urgent-important', tags: [], date: today, time: '10:30', duration: 30, note: '', recurrence: 'none', subtasks: [], done: false, sortOrder: 1, createdAt: new Date().toISOString() },
      { id: 'demo-3', name: '阅读《深度工作》第5章', quadrant: 'important', tags: [], date: today, time: '', duration: 45, note: '每天坚持一点', recurrence: 'none', subtasks: [], done: false, sortOrder: 2, createdAt: new Date().toISOString() },
      { id: 'demo-4', name: '整理本周工作总结', quadrant: 'important', tags: [], date: tomorrowKey, time: '', duration: 60, note: '', recurrence: 'none', subtasks: [], done: false, sortOrder: 3, createdAt: new Date().toISOString() },
      { id: 'demo-5', name: '约牙医检查', quadrant: 'urgent', tags: [], date: day3Key, time: '14:00', duration: 60, note: '记得带医保卡', recurrence: 'none', subtasks: [], done: false, sortOrder: 4, createdAt: new Date().toISOString() },
      { id: 'demo-6', name: '学习TypeScript泛型', quadrant: 'important', tags: [], date: day4Key, time: '', duration: 90, note: '', recurrence: 'none', subtasks: [{name:'看文档',done:false},{name:'写练习',done:false}], done: false, sortOrder: 5, createdAt: new Date().toISOString() },
      { id: 'demo-7', name: '整理房间', quadrant: 'neither', tags: [], date: tomorrowKey, time: '', duration: 40, note: '', recurrence: 'weekly', subtasks: [], done: false, sortOrder: 6, createdAt: new Date().toISOString() },
      { id: 'demo-8', name: '晨间冥想', quadrant: 'important', tags: [], date: today, time: '07:00', duration: 15, note: '', recurrence: 'daily', subtasks: [], done: true, sortOrder: 7, createdAt: new Date().toISOString() },
    ];

    // Demo drops
    state.drops = { total: 68, history: [
      { date: today, amount: 8, reason: '完成任务: 完成项目方案PPT' },
      { date: today, amount: 2, reason: '完成任务: 晨间冥想' },
      { date: today, amount: 4, reason: '习惯打卡: 阅读' },
      { date: today, amount: 6, reason: '习惯打卡: 运动' },
      { date: today, amount: 3, reason: '习惯打卡: 冥想' },
    ]};

    // Demo habits
    state.habits = [
      { id: 'habit-demo-1', name: '阅读', type: 'duration', icon: '📖', dropsPerUnit: 4, createdAt: new Date().toISOString() },
      { id: 'habit-demo-2', name: '运动健身', type: 'duration', icon: '🏃', dropsPerUnit: 6, createdAt: new Date().toISOString() },
      { id: 'habit-demo-3', name: '冥想', type: 'duration', icon: '🧘', dropsPerUnit: 3, createdAt: new Date().toISOString() },
      { id: 'habit-demo-4', name: '背单词', type: 'count', icon: '🇬🇧', dropsPerUnit: 1, createdAt: new Date().toISOString() },
      { id: 'habit-demo-5', name: '写日记', type: 'count', icon: '✍️', dropsPerUnit: 3, createdAt: new Date().toISOString() },
    ];

    // Demo habit logs
    state.habitLogs = [
      { id: 'hlog-d1', habitId: 'habit-demo-1', date: today, value: 60, dropsEarned: 4 },
      { id: 'hlog-d2', habitId: 'habit-demo-2', date: today, value: 45, dropsEarned: 6 },  // rounded up
      { id: 'hlog-d3', habitId: 'habit-demo-3', date: today, value: 20, dropsEarned: 3 },
    ];

    // Demo shop history
    state.shopHistory = [
      { date: today, name: '聊天水群/h', icon: '💬', price: 5 },
    ];

    saveState();
    localStorage.setItem('xinliu_demo_injected', '1');
  }

  // 先用本地数据渲染（避免白屏），然后异步加载服务端数据覆盖
  injectDemoData();
  loadSettingsUI();
  renderDashboard();
  renderBoard();
  renderGantt();
  updateDropsDisplay();
  // 异步加载服务端数据（加载完成后才允许写入服务端、才执行 dailyMaintenance）
  loadStateFromServer();
  // 启动午夜自动刷新定时器
  scheduleMidnightRefresh();

})();
