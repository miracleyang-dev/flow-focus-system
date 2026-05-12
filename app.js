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

  const viewTitles = { dashboard: '仪表盘', dump: '倒空大脑', board: '任务看板', gantt: '甘特图', summary: '近期总结', habits: '长期习惯', shop: '消费商城', settings: '设置' };

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
    if (this !== navDragSrc) {
      const items = Array.from(navList.querySelectorAll('.nav-item[data-view]'));
      const srcIdx = items.indexOf(navDragSrc);
      const targetIdx = items.indexOf(this);
      this.style.borderTop = '';
      this.style.borderBottom = '';
      if (srcIdx < targetIdx) {
        this.style.borderBottom = '2px solid var(--accent)';
      } else {
        this.style.borderTop = '2px solid var(--accent)';
      }
    }
  }
  function navDragLeave() { this.style.borderTop = ''; this.style.borderBottom = ''; }
  function navDrop(e) {
    e.preventDefault();
    this.style.borderTop = '';
    this.style.borderBottom = '';
    if (this === navDragSrc) return;
    // Determine drag direction to insert correctly
    const items = Array.from(navList.querySelectorAll('.nav-item[data-view]'));
    const srcIdx = items.indexOf(navDragSrc);
    const targetIdx = items.indexOf(this);
    if (srcIdx < targetIdx) {
      // Dragging downward: insert after target
      navList.insertBefore(navDragSrc, this.nextSibling);
    } else {
      // Dragging upward: insert before target
      navList.insertBefore(navDragSrc, this);
    }
    saveNavOrder();
  }
  function navDragEnd() {
    this.style.opacity = '';
    navList.querySelectorAll('.nav-item').forEach(el => { el.style.borderTop = ''; el.style.borderBottom = ''; });
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
    navList.querySelectorAll('.nav-item').forEach(el => { el.style.borderTop = ''; el.style.borderBottom = ''; });
    if (elBelow) {
      const target = elBelow.closest('.nav-item[data-view]');
      if (target && target !== navTouchSrc) {
        const items = Array.from(navList.querySelectorAll('.nav-item[data-view]'));
        const srcIdx = items.indexOf(navTouchSrc);
        const targetIdx = items.indexOf(target);
        if (srcIdx < targetIdx) {
          target.style.borderBottom = '2px solid var(--accent)';
        } else {
          target.style.borderTop = '2px solid var(--accent)';
        }
      }
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
          const items = Array.from(navList.querySelectorAll('.nav-item[data-view]'));
          const srcIdx = items.indexOf(navTouchSrc);
          const targetIdx = items.indexOf(target);
          if (srcIdx < targetIdx) {
            navList.insertBefore(navTouchSrc, target.nextSibling);
          } else {
            navList.insertBefore(navTouchSrc, target);
          }
          saveNavOrder();
        }
      }
      navTouchSrc.style.opacity = '';
      navTouchSrc.style.transform = '';
    }
    navList.querySelectorAll('.nav-item').forEach(el => { el.style.borderTop = ''; el.style.borderBottom = ''; });
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

  // ===== AUTO EMOJI GENERATION =====
  async function generateEmoji(name) {
    const cfg = getApiConfig();
    if (!cfg.key || !name) return '';
    try {
      const reply = await callLLM(
        '你是一个emoji选择器。用户给你一个名称，你返回一个最匹配的emoji。只返回一个emoji，不要返回任何其他文字。',
        name
      );
      // Extract the first emoji from reply
      const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(reply.trim())];
      if (segments.length > 0) {
        const first = segments[0].segment;
        // Verify it looks like an emoji (non-ASCII, not a regular letter/number)
        if (/\p{Emoji_Presentation}|\p{Extended_Pictographic}/u.test(first)) return first;
      }
      return '';
    } catch (e) {
      return '';
    }
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

  function getTaskLogs() {
    if (!state.taskLogs) state.taskLogs = [];
    return state.taskLogs;
  }

  function toggleDone(id) {
    const t = state.tasks.find(x => x.id === id);
    if (!t) return;
    const wasDone = t.done;
    t.done = !t.done;
    saveState();
    renderBoard();
    if (!wasDone && t.done) {
      // Record structured task completion log
      const weight = PRIORITY_WEIGHTS[t.quadrant] || 1;
      const dropAmount = Math.floor((t.duration || 30) / 60 * weight);
      getTaskLogs().push({
        id: 'tlog-' + genId(),
        taskId: t.id,
        name: t.name,
        quadrant: t.quadrant,
        duration: t.duration || 30,
        date: todayKey(),
        dropsEarned: dropAmount,
      });
      // Award drops for task completion
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

  function esc(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  // ===== EMOJI INPUT FIX =====
  // Prevent maxlength from clipping multi-codepoint emoji during IME composition
  function setupEmojiInput(input) {
    let composing = false;
    input.addEventListener('compositionstart', () => { composing = true; });
    input.addEventListener('compositionend', () => {
      composing = false;
      // Extract only the first emoji grapheme cluster after composition ends
      const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(input.value)];
      if (segments.length > 0) {
        input.value = segments[0].segment;
      }
    });
    input.addEventListener('input', () => {
      if (composing) return;
      // Ensure only one grapheme cluster (one visual emoji) is kept
      try {
        const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(input.value)];
        if (segments.length > 1) {
          input.value = segments[segments.length - 1].segment;
        }
      } catch(e) {
        // Fallback: keep value as-is if Intl.Segmenter not supported
      }
    });
  }
  // Apply to all emoji input fields
  document.querySelectorAll('#habit-edit-icon, #shop-new-icon').forEach(setupEmojiInput);

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
    // Note: summary data is sourced from taskLogs/habitLogs/shopHistory, so deletion is safe
    const beforeCount = state.tasks.length;
    state.tasks = state.tasks.filter(t => {
      if (t.done && t.date && t.date < today && (!t.recurrence || t.recurrence === 'none')) return false;
      return true;
    });
    if (state.tasks.length !== beforeCount) changed = true;

    // 3. Trim logs to last 90 days to prevent unbounded growth
    const cutoff90 = new Date();
    cutoff90.setDate(cutoff90.getDate() - 90);
    const cutoffKey = cutoff90.toISOString().slice(0, 10);
    if (state.taskLogs) state.taskLogs = state.taskLogs.filter(l => l.date >= cutoffKey);
    if (state.habitLogs) state.habitLogs = state.habitLogs.filter(l => l.date >= cutoffKey);
    if (state.shopHistory) state.shopHistory = state.shopHistory.filter(h => h.date >= cutoffKey);
    if (state.drops && state.drops.history) state.drops.history = state.drops.history.filter(h => h.date >= cutoffKey);

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

  // ===== MANUAL REFRESH BUTTON =====
  document.getElementById('btn-manual-refresh').addEventListener('click', function() {
    const btn = this;
    btn.classList.add('refreshing');
    btn.disabled = true;
    // Force daily maintenance regardless of lastDailyCheck
    state.lastDailyCheck = '';
    dailyMaintenance();
    renderActiveView();
    updateDropsDisplay();
    setTimeout(() => {
      btn.classList.remove('refreshing');
      btn.disabled = false;
    }, 800);
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

  // ===== SUMMARY VIEW (近期总结) =====
  let lastSummaryText = '';

  function buildSummaryContext(days) {
    const today = todayKey();
    const now = new Date();
    const startDate = new Date(now);
    startDate.setDate(startDate.getDate() - (days - 1));
    const startKey = startDate.toISOString().slice(0, 10);

    // === Three structured log sources (all survive daily cleanup) ===
    const taskLogs = getTaskLogs().filter(l => l.date >= startKey && l.date <= today);
    const habitLogs = getHabitLogs().filter(l => l.date >= startKey && l.date <= today);
    const shopHistory = getShopHistory().filter(h => h.date >= startKey && h.date <= today);
    const habits = getHabits();

    // Pending tasks still in state
    const pendingTasks = state.tasks.filter(t => !t.done && t.date && t.date >= startKey && t.date <= today);

    // Drops summary
    const allDropsInRange = (state.drops && state.drops.history || []).filter(h => h.date >= startKey && h.date <= today);
    const dropsEarned = allDropsInRange.filter(h => h.amount > 0).reduce((s, h) => s + h.amount, 0);
    const dropsSpent = allDropsInRange.filter(h => h.amount < 0).reduce((s, h) => s + Math.abs(h.amount), 0);

    // Build text data
    let ctx = `总结范围: ${startKey} 至 ${today} (${days} 天)\n\n`;

    // --- Task completion (from taskLogs, fallback to drops.history for older data) ---
    ctx += `【任务完成情况】\n`;
    if (taskLogs.length > 0) {
      ctx += `完成任务数: ${taskLogs.length} 个\n`;
      taskLogs.forEach(l => {
        ctx += `  - ${l.name} (${PRIORITY_LABELS[l.quadrant] || '一般'}, 预估${l.duration}分钟, +${l.dropsEarned}水滴, ${l.date})\n`;
      });
    } else {
      // Fallback: use drops.history for data before taskLogs existed
      const taskDrops = allDropsInRange.filter(h => h.amount > 0 && h.reason && h.reason.startsWith('完成任务:'));
      ctx += `完成任务数: ${taskDrops.length} 个\n`;
      taskDrops.forEach(h => {
        ctx += `  - ${h.reason.replace('完成任务: ', '')} (+${h.amount}水滴, ${h.date})\n`;
      });
    }
    ctx += `待完成: ${pendingTasks.length} 个\n`;
    if (pendingTasks.length > 0) {
      pendingTasks.forEach(t => {
        ctx += `  - ${t.name} (${PRIORITY_LABELS[t.quadrant] || '一般'}, 截止: ${t.date})\n`;
      });
    }

    // --- Habit logs ---
    ctx += `\n【习惯打卡情况】\n`;
    if (habitLogs.length === 0) {
      ctx += `该时段无打卡记录\n`;
    } else {
      const habitSummary = {};
      habitLogs.forEach(l => {
        if (!habitSummary[l.habitId]) habitSummary[l.habitId] = { count: 0, totalVal: 0, totalDrops: 0 };
        habitSummary[l.habitId].count++;
        habitSummary[l.habitId].totalVal += l.value || 0;
        habitSummary[l.habitId].totalDrops += l.dropsEarned || 0;
      });
      Object.keys(habitSummary).forEach(hid => {
        const habit = habits.find(h => h.id === hid);
        const s = habitSummary[hid];
        const unit = (habit && habit.type === 'duration') ? 'h' : '次';
        ctx += `  - ${habit ? habit.icon + ' ' + habit.name : '已删除习惯'}: 打卡 ${s.count} 次, 累计 ${s.totalVal} ${unit}, 获得 ${s.totalDrops} 水滴\n`;
      });
    }

    // --- Shop consumption ---
    ctx += `\n【消费商城情况】\n`;
    if (shopHistory.length === 0) {
      ctx += `该时段无消费记录\n`;
    } else {
      ctx += `消费次数: ${shopHistory.length} 次\n`;
      const shopSummary = {};
      shopHistory.forEach(h => {
        if (!shopSummary[h.name]) shopSummary[h.name] = { count: 0, totalSpent: 0, icon: h.icon };
        shopSummary[h.name].count++;
        shopSummary[h.name].totalSpent += h.price || 0;
      });
      Object.keys(shopSummary).forEach(name => {
        const s = shopSummary[name];
        ctx += `  - ${s.icon || '🎁'} ${name}: ${s.count} 次, 共消费 ${s.totalSpent} 水滴\n`;
      });
    }

    // --- Drops overview ---
    ctx += `\n【水滴收支】\n`;
    ctx += `期间获得水滴: ${dropsEarned} 滴\n`;
    ctx += `期间消费水滴: ${dropsSpent} 滴\n`;
    ctx += `当前水滴余额: ${(state.drops && state.drops.total) || 0} 滴\n`;

    return ctx;
  }

  function buildSummaryTemplate(days) {
    const today = todayKey();
    const now = new Date();
    const startDate = new Date(now);
    startDate.setDate(startDate.getDate() - (days - 1));
    const startKey = startDate.toISOString().slice(0, 10);

    // Three structured log sources
    const taskLogs = getTaskLogs().filter(l => l.date >= startKey && l.date <= today);
    const habitLogs = getHabitLogs().filter(l => l.date >= startKey && l.date <= today);
    const shopHist = getShopHistory().filter(h => h.date >= startKey && h.date <= today);
    const habits = getHabits();
    const pendingTasks = state.tasks.filter(t => !t.done && t.date && t.date >= startKey && t.date <= today);

    // Drops
    const allDropsInRange = (state.drops && state.drops.history || []).filter(h => h.date >= startKey && h.date <= today);
    const dropsEarned = allDropsInRange.filter(h => h.amount > 0).reduce((s, h) => s + h.amount, 0);
    const dropsSpent = allDropsInRange.filter(h => h.amount < 0).reduce((s, h) => s + Math.abs(h.amount), 0);

    // Determine task completion count (taskLogs preferred, fallback to drops)
    let taskCount = taskLogs.length;
    if (taskCount === 0) {
      taskCount = allDropsInRange.filter(h => h.amount > 0 && h.reason && h.reason.startsWith('完成任务:')).length;
    }

    let html = '';
    // Data overview
    html += `<div class="summary-section"><h4>📊 数据概览 (${startKey} ~ ${today})</h4><ul>`;
    html += `<li>完成任务: <strong>${taskCount}</strong> 个</li>`;
    html += `<li>待完成任务: <strong>${pendingTasks.length}</strong> 个</li>`;
    html += `<li>习惯打卡: <strong>${habitLogs.length}</strong> 次</li>`;
    html += `<li>消费兑换: <strong>${shopHist.length}</strong> 次</li>`;
    html += `<li>获得水滴: <strong style="color:var(--cyan)">${dropsEarned}</strong> 滴</li>`;
    html += `<li>消费水滴: <strong style="color:var(--text-muted)">${dropsSpent}</strong> 滴</li>`;
    html += `</ul></div>`;

    // Completed tasks
    if (taskLogs.length > 0) {
      html += `<div class="summary-section"><h4>✅ 已完成任务</h4><ul>`;
      taskLogs.forEach(l => {
        html += `<li>${esc(l.name)} <span style="color:var(--text-muted)">(${PRIORITY_LABELS[l.quadrant] || '一般'}, ${l.duration}分钟, +${l.dropsEarned}💧, ${l.date})</span></li>`;
      });
      html += `</ul></div>`;
    } else {
      // Fallback for older data without taskLogs
      const taskDrops = allDropsInRange.filter(h => h.amount > 0 && h.reason && h.reason.startsWith('完成任务:'));
      if (taskDrops.length > 0) {
        html += `<div class="summary-section"><h4>✅ 已完成任务</h4><ul>`;
        taskDrops.forEach(h => {
          html += `<li>${esc(h.reason.replace('完成任务: ', ''))} <span style="color:var(--text-muted)">(+${h.amount}💧, ${h.date})</span></li>`;
        });
        html += `</ul></div>`;
      }
    }

    // Pending tasks
    if (pendingTasks.length > 0) {
      html += `<div class="summary-section"><h4>📋 待完成任务</h4><ul>`;
      pendingTasks.forEach(t => {
        html += `<li>${esc(t.name)} <span style="color:var(--text-muted)">(${PRIORITY_LABELS[t.quadrant] || '一般'}, 截止: ${t.date})</span></li>`;
      });
      html += `</ul></div>`;
    }

    // Habit summary
    if (habitLogs.length > 0) {
      html += `<div class="summary-section"><h4>🔄 习惯打卡</h4><ul>`;
      const habitMap = {};
      habitLogs.forEach(l => {
        if (!habitMap[l.habitId]) habitMap[l.habitId] = { count: 0, totalVal: 0 };
        habitMap[l.habitId].count++;
        habitMap[l.habitId].totalVal += l.value || 0;
      });
      Object.keys(habitMap).forEach(hid => {
        const habit = habits.find(h => h.id === hid);
        const s = habitMap[hid];
        const unit = (habit && habit.type === 'duration') ? 'h' : '次';
        html += `<li>${habit ? habit.icon + ' ' + habit.name : '已删除'}: 打卡 ${s.count} 次, 累计 ${s.totalVal} ${unit}</li>`;
      });
      html += `</ul></div>`;
    }

    // Shop consumption
    if (shopHist.length > 0) {
      html += `<div class="summary-section"><h4>🛒 消费兑换</h4><ul>`;
      const shopMap = {};
      shopHist.forEach(h => {
        if (!shopMap[h.name]) shopMap[h.name] = { count: 0, total: 0, icon: h.icon };
        shopMap[h.name].count++;
        shopMap[h.name].total += h.price || 0;
      });
      Object.keys(shopMap).forEach(name => {
        const s = shopMap[name];
        html += `<li>${s.icon || '🎁'} ${esc(name)}: ${s.count} 次, 共 ${s.total} 💧</li>`;
      });
      html += `</ul></div>`;
    }

    return html;
  }

  // Toggle custom days input visibility
  document.getElementById('summary-range').addEventListener('change', function() {
    const customInput = document.getElementById('summary-range-custom');
    customInput.style.display = this.value === 'custom' ? '' : 'none';
  });

  function getSummaryDays() {
    const sel = document.getElementById('summary-range');
    if (sel.value === 'custom') {
      const v = parseInt(document.getElementById('summary-range-custom').value) || 7;
      return Math.max(1, Math.min(90, v));
    }
    return parseInt(sel.value) || 7;
  }

  document.getElementById('btn-generate-summary').addEventListener('click', async () => {
    const days = getSummaryDays();
    const btn = document.getElementById('btn-generate-summary');
    const loading = document.getElementById('summary-loading');
    const resultDiv = document.getElementById('summary-result');
    const contentDiv = document.getElementById('summary-content');

    // Always show the template data first
    const templateHtml = buildSummaryTemplate(days);

    btn.disabled = true;
    loading.classList.remove('hidden');
    resultDiv.style.display = 'none';

    try {
      const ctx = buildSummaryContext(days);
      const sysPrompt = `你是"心流"效率系统的总结助手。根据用户近段时间的任务和习惯数据，生成一份简洁有力的总结分析。

要求：
1. 总结完成情况，指出亮点
2. 分析存在的问题（逾期、习惯中断等）
3. 给出具体可行的改进建议（2-3条）
4. 整体鼓励，语气温暖务实
5. 总字数控制在 200 字以内
6. 不要使用 markdown 标题格式，直接使用文字段落`;

      const aiReply = await callLLM(sysPrompt, ctx);
      lastSummaryText = aiReply;
      contentDiv.innerHTML = templateHtml + `<div class="summary-ai-insight"><strong>💡 AI 洞察</strong><br><br>${esc(aiReply)}</div>`;
    } catch (e) {
      lastSummaryText = '';
      contentDiv.innerHTML = templateHtml + `<div class="summary-ai-insight" style="border-color:rgba(239,68,68,.3);background:rgba(239,68,68,.08)"><strong>AI 分析失败</strong><br>${esc(e.message)}<br><br>以上为数据统计部分，AI 洞察需要配置 API Key。</div>`;
    } finally {
      btn.disabled = false;
      loading.classList.add('hidden');
      resultDiv.style.display = '';
    }
  });

  document.getElementById('btn-download-summary').addEventListener('click', () => {
    const days = getSummaryDays();
    const today = todayKey();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - (days - 1));
    const startKey = startDate.toISOString().slice(0, 10);

    let text = `心流 · 近期总结报告\n`;
    text += `=========================\n`;
    text += `报告范围: ${startKey} ~ ${today}\n`;
    text += `生成时间: ${new Date().toLocaleString('zh-CN')}\n\n`;
    text += buildSummaryContext(days);
    if (lastSummaryText) {
      text += `\n【AI 洞察与建议】\n${lastSummaryText}\n`;
    }

    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `xinliu_summary_${today}.txt`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 200);
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
    const todayTasks = undone.filter(t => t.date === today);
    const todayDone = state.tasks.filter(t => t.done && t.date === today);

    document.getElementById('dash-undone').textContent = undone.length;
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

  }

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
      const unit = h.type === 'duration' ? 'h' : '次';
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
        const unit = (habit && habit.type === 'duration') ? 'h' : '次';
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

  document.getElementById('btn-habit-save').addEventListener('click', async () => {
    const name = document.getElementById('habit-edit-name').value.trim();
    if (!name) { alert('请输入习惯名称'); return; }
    const type = document.getElementById('habit-edit-type').value;
    let icon = document.getElementById('habit-edit-icon').value.trim();
    const dropsPerUnit = parseInt(document.getElementById('habit-edit-drops').value) || 2;
    // Auto-generate emoji if icon is empty and API is configured
    if (!icon) {
      const cfg = getApiConfig();
      if (cfg.key) {
        const btnSave = document.getElementById('btn-habit-save');
        btnSave.disabled = true;
        btnSave.textContent = '生成图标中...';
        icon = await generateEmoji(name) || '🔄';
        btnSave.disabled = false;
        btnSave.textContent = '保存';
      } else {
        icon = '🔄';
      }
    }
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

  // Habit emoji regeneration button
  document.getElementById('btn-habit-regen-emoji').addEventListener('click', async () => {
    const name = document.getElementById('habit-edit-name').value.trim();
    if (!name) { alert('请先输入习惯名称'); return; }
    const cfg = getApiConfig();
    if (!cfg.key) { alert('请先在设置中配置 API Key'); return; }
    const btn = document.getElementById('btn-habit-regen-emoji');
    btn.disabled = true;
    btn.textContent = '生成中...';
    const emoji = await generateEmoji(name) || '🔄';
    document.getElementById('habit-edit-icon').value = emoji;
    btn.disabled = false;
    btn.textContent = '重新生成';
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
    document.getElementById('habit-log-label').textContent = isDuration ? '完成时长 (小时)' : '完成次数';
    document.getElementById('habit-log-value').value = isDuration ? 1 : 1;
    updateHabitLogPreview();
    habitLogOverlay.classList.remove('hidden');
  }

  function updateHabitLogPreview() {
    const habit = getHabits().find(h => h.id === loggingHabitId);
    if (!habit) return;
    const val = parseFloat(document.getElementById('habit-log-value').value) || 0;
    let drops;
    if (habit.type === 'duration') {
      drops = Math.floor(val * habit.dropsPerUnit);
      if (drops === 0 && val > 0) drops = Math.max(1, Math.round(val * habit.dropsPerUnit));
    } else {
      drops = Math.floor(val) * habit.dropsPerUnit;
    }
    document.getElementById('habit-log-drops-preview').textContent = '预计获得 💧 ' + drops + ' 水滴';
  }

  document.getElementById('habit-log-value').addEventListener('input', updateHabitLogPreview);
  document.getElementById('habit-log-close').addEventListener('click', () => habitLogOverlay.classList.add('hidden'));
  habitLogOverlay.addEventListener('click', (e) => { if (e.target === habitLogOverlay) habitLogOverlay.classList.add('hidden'); });

  document.getElementById('btn-habit-log-save').addEventListener('click', () => {
    const habit = getHabits().find(h => h.id === loggingHabitId);
    if (!habit) return;
    const val = parseFloat(document.getElementById('habit-log-value').value) || 0;
    if (val <= 0) { alert('请输入有效数值'); return; }
    let drops;
    if (habit.type === 'duration') {
      drops = Math.floor(val * habit.dropsPerUnit);
      if (drops === 0 && val > 0) drops = Math.max(1, Math.round(val * habit.dropsPerUnit));
    } else {
      drops = Math.floor(val) * habit.dropsPerUnit;
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
  function getShopItems() {
    if (!state.shopItems) state.shopItems = [];
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
        <button class="shop-item-edit" title="编辑商品" style="position:absolute;top:8px;right:8px;background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:.85rem;padding:2px 6px;border-radius:4px;transition:color .2s">✏️</button>
        <div class="shop-item-icon">${item.icon || '🎁'}</div>
        <div class="shop-item-name">${esc(item.name)}</div>
        <div class="shop-item-price">💧 ${item.price} 水滴</div>
        <div class="shop-item-stock">${stockText}</div>
        <button class="btn-shop-buy${soldOut ? ' sold-out' : ''}" ${!canBuy ? 'disabled' : ''}>${soldOut ? '已售罄' : '兑换'}</button>
      `;
      el.querySelector('.btn-shop-buy').addEventListener('click', () => buyShopItem(item.id));
      el.querySelector('.shop-item-edit').addEventListener('click', () => openShopEditModal(item.id));
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
  document.getElementById('btn-shop-add').addEventListener('click', async () => {
    const nameInput = document.getElementById('shop-new-name');
    const priceInput = document.getElementById('shop-new-price');
    const iconInput = document.getElementById('shop-new-icon');
    const name = nameInput.value.trim();
    const price = parseInt(priceInput.value);
    let icon = iconInput.value.trim();
    if (!name) { showShopToast('请输入商品名称', 'error'); return; }
    if (!price || price <= 0) { showShopToast('请输入有效价格', 'error'); return; }
    // Auto-generate emoji if icon is empty and API is configured
    if (!icon) {
      const cfg = getApiConfig();
      if (cfg.key) {
        const btnAdd = document.getElementById('btn-shop-add');
        btnAdd.disabled = true;
        btnAdd.textContent = '生成图标...';
        icon = await generateEmoji(name) || '🎁';
        btnAdd.disabled = false;
        btnAdd.textContent = '添加商品';
      } else {
        icon = '🎁';
      }
    }
    const items = getShopItems();
    items.push({ id: 'shop-' + genId(), name, icon, price, stock: -1 });
    saveState();
    nameInput.value = '';
    priceInput.value = '';
    iconInput.value = '';
    renderShop();
    showShopToast('商品已添加！', 'success');
  });

  // ===== SHOP EDIT MODAL =====
  let editingShopItemId = null;
  const shopEditOverlay = document.getElementById('shop-edit-overlay');

  function openShopEditModal(id) {
    editingShopItemId = id;
    const item = getShopItems().find(i => i.id === id);
    if (!item) return;
    document.getElementById('shop-edit-title').textContent = '编辑商品';
    document.getElementById('shop-edit-name').value = item.name;
    document.getElementById('shop-edit-price').value = item.price;
    document.getElementById('shop-edit-icon').value = item.icon || '';
    shopEditOverlay.classList.remove('hidden');
  }

  document.getElementById('shop-edit-close').addEventListener('click', () => shopEditOverlay.classList.add('hidden'));
  shopEditOverlay.addEventListener('click', (e) => { if (e.target === shopEditOverlay) shopEditOverlay.classList.add('hidden'); });

  document.getElementById('btn-shop-edit-regen-emoji').addEventListener('click', async () => {
    const name = document.getElementById('shop-edit-name').value.trim();
    if (!name) { alert('请先输入商品名称'); return; }
    const cfg = getApiConfig();
    if (!cfg.key) { alert('请先在设置中配置 API Key'); return; }
    const btn = document.getElementById('btn-shop-edit-regen-emoji');
    btn.disabled = true;
    btn.textContent = '生成中...';
    const emoji = await generateEmoji(name) || '🎁';
    document.getElementById('shop-edit-icon').value = emoji;
    btn.disabled = false;
    btn.textContent = '重新生成';
  });

  document.getElementById('btn-shop-edit-save').addEventListener('click', async () => {
    if (!editingShopItemId) return;
    const name = document.getElementById('shop-edit-name').value.trim();
    if (!name) { showShopToast('请输入商品名称', 'error'); return; }
    const price = parseInt(document.getElementById('shop-edit-price').value);
    if (!price || price <= 0) { showShopToast('请输入有效价格', 'error'); return; }
    let icon = document.getElementById('shop-edit-icon').value.trim();
    if (!icon) {
      const cfg = getApiConfig();
      if (cfg.key) {
        const btnSave = document.getElementById('btn-shop-edit-save');
        btnSave.disabled = true;
        btnSave.textContent = '生成图标...';
        icon = await generateEmoji(name) || '🎁';
        btnSave.disabled = false;
        btnSave.textContent = '保存';
      } else {
        icon = '🎁';
      }
    }
    const items = getShopItems();
    const item = items.find(i => i.id === editingShopItemId);
    if (item) {
      item.name = name;
      item.price = price;
      item.icon = icon;
    }
    saveState();
    shopEditOverlay.classList.add('hidden');
    renderShop();
    showShopToast('商品已更新！', 'success');
  });

  document.getElementById('btn-shop-edit-delete').addEventListener('click', () => {
    if (!editingShopItemId) return;
    const item = getShopItems().find(i => i.id === editingShopItemId);
    if (item && confirm('删除商品「' + item.name + '」？')) {
      deleteShopItem(editingShopItemId);
      shopEditOverlay.classList.add('hidden');
    }
  });

  // ===== INIT =====
  // Global touch event listeners for mobile drag
  document.addEventListener('touchmove', handleTouchMove, { passive: false });
  document.addEventListener('touchend', handleTouchEnd);

  // 先用本地数据渲染（避免白屏），然后异步加载服务端数据覆盖
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
