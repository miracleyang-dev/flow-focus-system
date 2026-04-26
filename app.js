// ===== 心流 · 个人效率系统 =====
// 服务端 JSON 文件存储 + localStorage 兜底

(function () {
  'use strict';

  // ===== STATE =====
  const STATE_KEY = 'xinliu_state';
  let state = loadStateSync();
  let saveTimer = null;

  function defaultState() {
    return {
      tasks: [],
      schedule: {},
      focusLog: [],
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
        if (data && data.tasks) {
          state = mergeState(data);
          localStorage.setItem(STATE_KEY, JSON.stringify(state));
          loadSettingsUI();
          renderDashboard();
          renderBoard();
          renderGantt();
          updateTimerDisplay();
          updateDropsDisplay();
        }
      }
    } catch (e) { /* server not available */ }
  }

  function saveState() {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveToServer, 100);
  }

  async function saveToServer() {
    try {
      await fetch('/api/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      });
    } catch (e) { /* ignore */ }
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

  const viewTitles = { dashboard: '仪表盘', dump: '倒空大脑', board: '任务看板', gantt: '甘特图', chat: 'AI 陪伴', settings: '设置' };

  function switchView(name) {
    navItems.forEach(n => n.classList.toggle('active', n.dataset.view === name));
    views.forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
    mobileTitle.textContent = viewTitles[name] || '';
    closeSidebar();
    if (name === 'dashboard') renderDashboard();
    if (name === 'board') renderBoard();
    if (name === 'gantt') renderGantt();
    if (name === 'settings') renderSettingsLists();
  }

  navItems.forEach(n => n.addEventListener('click', () => switchView(n.dataset.view)));
  menuToggle.addEventListener('click', () => { sidebar.classList.add('open'); overlay.classList.add('active'); });
  function closeSidebar() { sidebar.classList.remove('open'); overlay.classList.remove('active'); }
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
    if (sidebarNum) sidebarNum.textContent = total;
    if (dashDrops) dashDrops.textContent = '\uD83D\uDCA7 ' + total;
    if (rulesTotal) rulesTotal.textContent = '\uD83D\uDCA7 ' + total;
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
    if (!text) return;
    const lines = text.split(/\n/).map(l => l.replace(/^[-*·•\d.、]+\s*/, '').trim()).filter(Boolean);
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
  const PRIORITY_LABELS = { 'urgent-important': '紧急重要', 'important': '重要', 'urgent': '紧急', 'neither': '一般' };
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

  // ===== DRAG & DROP =====
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
      // Milestone celebration
      const completed = countCompleted();
      const milestone = MILESTONES.find(m => m === completed);
      if (milestone) {
        showCelebration(MILESTONE_MSGS[milestone]);
      } else {
        const card = document.querySelector(`.task-card[data-id="${id}"]`);
        if (card) {
          card.style.transition = 'transform .3s, opacity .3s';
          card.style.transform = 'scale(1.03)';
          setTimeout(() => { card.style.transform = ''; }, 300);
        }
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

  modalClose.addEventListener('click', () => modalOverlay.classList.add('hidden'));
  modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) modalOverlay.classList.add('hidden'); });

  btnModalSave.addEventListener('click', () => {
    if (!editingTaskId) return;
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
  // Runs once per day on load: removes completed tasks from previous days, moves recurring tasks to today
  function dailyMaintenance() {
    const today = todayKey();
    if (state.lastDailyCheck === today) return; // already ran today

    let changed = false;

    // 1. Remove completed tasks from previous days
    const beforeCount = state.tasks.length;
    state.tasks = state.tasks.filter(t => {
      if (t.done && t.date && t.date < today) return false; // remove old completed
      return true;
    });
    if (state.tasks.length !== beforeCount) changed = true;

    // 2. Move recurring tasks to today if their date is in the past
    state.tasks.forEach(t => {
      if (t.recurrence && t.recurrence !== 'none' && t.date && t.date < today) {
        t.date = today;
        t.done = false; // reset done status for the new day
        changed = true;
      }
    });

    state.lastDailyCheck = today;
    if (changed) saveState();
    else {
      // Still save the lastDailyCheck marker
      localStorage.setItem(STATE_KEY, JSON.stringify(state));
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveToServer, 300);
    }
  }

  // ===== GANTT VIEW =====
  function renderGantt() {
    const container = document.getElementById('gantt-container');
    const today = new Date(todayKey() + 'T00:00:00');
    const days = [];
    for (let i = 0; i < 14; i++) {
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

    // Filter tasks that have dates within the 14-day range or before
    const startKey = days[0].toISOString().slice(0,10);
    const endKey = days[days.length-1].toISOString().slice(0,10);
    const tasksInRange = state.tasks.filter(t => {
      if (!t.date) return false;
      return t.date <= endKey;
    }).sort((a,b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999));

    let html = '<div class="gantt-chart">';
    // Header
    html += '<div class="gantt-header">';
    html += '<div class="gantt-label-col">任务</div>';
    days.forEach(d => {
      const key = d.toISOString().slice(0,10);
      const isToday = key === todayKey();
      const isWeekend = d.getDay() === 0 || d.getDay() === 6;
      html += `<div class="gantt-day-col${isToday ? ' today' : ''}${isWeekend ? ' weekend' : ''}">${d.getMonth()+1}/${d.getDate()}<br>周${weekdayNames[d.getDay()]}</div>`;
    });
    html += '</div>';

    // Rows
    if (tasksInRange.length === 0) {
      html += '<div style="padding:2rem;color:var(--text-muted);text-align:center">未来两周暂无任务</div>';
    }
    tasksInRange.forEach(t => {
      html += '<div class="gantt-row">';
      html += `<div class="gantt-row-label" title="${esc(t.name)}">${esc(t.name)}</div>`;
      html += '<div class="gantt-row-cells">';
      // Background cells
      days.forEach(d => {
        const key = d.toISOString().slice(0,10);
        const isToday = key === todayKey();
        html += `<div class="gantt-cell${isToday ? ' today' : ''}"></div>`;
      });
      // Bar overlay
      const taskDate = new Date(t.date + 'T00:00:00');
      const durationDays = Math.max(1, Math.ceil((t.duration || 30) / 480)); // ~8h workday
      const startDiff = Math.round((taskDate - today) / 86400000);
      const barStart = Math.max(0, startDiff);
      const barEnd = Math.min(13, barStart + durationDays - 1);
      if (barStart <= 13) {
        const leftPct = (barStart / 14 * 100).toFixed(2);
        const widthPct = ((barEnd - barStart + 1) / 14 * 100).toFixed(2);
        const barColor = prioBarColors[t.quadrant] || '#64748b';
        html += `<div class="gantt-bar${t.done ? ' done' : ''}" style="left:${leftPct}%;width:${widthPct}%;background:${barColor}">${esc(t.name)}</div>`;
      }
      html += '</div></div>';
    });
    html += '</div>';
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
4. **拖延克服**：用2分钟法则、番茄工作法等技巧帮用户启动
5. **适时鼓励**：看到已完成的任务或专注记录时，给予具体的肯定

说话风格：
- 像一个理解你的好朋友，不说教
- 简短有力，不啰嗦（每次回复控制在 150 字以内）
- 可以偶尔用一些轻松的语气
- 如果用户明确在发泄情绪，先倾听

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

  function saveSettings() {
    state.settings.provider = providerSelect.value;
    state.settings.baseUrl = baseUrlInput.value.trim().replace(/\/+$/, '');
    state.settings.apiKey = apiKeyInput.value.trim();
    state.settings.model = modelInput.value.trim();
    if (!state.userInfo) state.userInfo = {};
    state.userInfo.name = userNameInput.value.trim();
    saveState();
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
      el.innerHTML = `<span class="sli-dot" style="background:${tag.color}"></span><span class="sli-label">${esc(tag.name)}</span><span class="sli-remove">&times;</span>`;
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
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'xinliu_backup_' + todayKey() + '.json';
    a.click();
  });

  document.getElementById('btn-import').addEventListener('click', () => {
    document.getElementById('import-file').click();
  });

  document.getElementById('import-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const imported = JSON.parse(ev.target.result);
        state = mergeState(imported);
        saveState();
        loadSettingsUI();
        alert('导入成功！');
        switchView('board');
      } catch (err) {
        alert('导入失败：无效的 JSON 文件');
      }
    };
    reader.readAsText(file);
  });

  document.getElementById('btn-clear-data').addEventListener('click', () => {
    if (confirm('确定要清除所有数据吗？此操作不可恢复。')) {
      state = defaultState();
      saveState();
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
    '每一个番茄钟，都是你认真生活的证据。',
    '别想太多，先做5分钟再说。',
    '今天完成的每一件小事，都在为未来的你铺路。',
    '心流状态：忘记时间，沉浸其中。',
    '不要等到准备好才开始，开始了才会准备好。',
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
  document.getElementById('qa-ai-chat').addEventListener('click', () => switchView('chat'));

  const qaInline = document.getElementById('dash-quick-add-inline');
  const qaTaskInput = document.getElementById('qa-task-input');

  document.getElementById('qa-quick-add').addEventListener('click', () => {
    qaInline.classList.remove('hidden');
    qaTaskInput.focus();
  });
  document.getElementById('qa-task-cancel').addEventListener('click', () => {
    qaInline.classList.add('hidden');
    qaTaskInput.value = '';
  });
  function qaSubmitTask() {
    const name = qaTaskInput.value.trim();
    if (!name) return;
    addTask({ name });
    qaTaskInput.value = '';
    qaInline.classList.add('hidden');
    renderDashboard();
  }
  document.getElementById('qa-task-submit').addEventListener('click', qaSubmitTask);
  qaTaskInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); qaSubmitTask(); }
  });

  // ===== CELEBRATION EFFECT =====
  let totalCompleted = 0;
  const MILESTONES = [3, 5, 10, 20, 50];
  const MILESTONE_MSGS = {
    3: '完成3个任务了，不错的开始！',
    5: '5个任务搞定，节奏很好！',
    10: '10个任务！你今天效率爆表！',
    20: '20个任务，你是效率机器！',
    50: '50个任务！传奇级别的一天！',
  };

  function countCompleted() { return state.tasks.filter(t => t.done).length; }

  function showCelebration(msg) {
    const overlay = document.getElementById('celebrate-overlay');
    const msgEl = document.getElementById('celebrate-msg');
    const canvas = document.getElementById('confetti-canvas');
    msgEl.textContent = msg;
    msgEl.className = 'celebrate-msg';
    overlay.classList.remove('hidden');
    fireConfetti(canvas, false);
    setTimeout(() => overlay.classList.add('hidden'), 2200);
  }

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

  // ===== INIT =====
  loadStateFromServer();
  loadSettingsUI();
  totalCompleted = countCompleted();
  dailyMaintenance();
  renderDashboard();
  renderBoard();
  renderGantt();
  updateDropsDisplay();

})();
