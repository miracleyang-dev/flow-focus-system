// ===== 心流 · 个人效率系统 =====
// 服务端 JSON 文件存储 + localStorage 兜底

(function () {
  'use strict';

  // ===== STATE =====
  const STATE_KEY = 'xinliu_state';
  let state = loadStateSync(); // sync load from localStorage first, then async upgrade from server
  let saveTimer = null;

  function defaultState() {
    return {
      tasks: [],
      schedule: {}, // { 'YYYY-MM-DD': { '09:00': taskId, ... } }
      focusLog: [], // { date, taskId, minutes }
      settings: {
        provider: 'deepseek',
        baseUrl: '',
        apiKey: '',
        model: 'deepseek-chat',
        focusDuration: 25,
        breakDuration: 5,
      },
    };
  }

  function mergeState(raw) {
    return { ...defaultState(), ...raw, settings: { ...defaultState().settings, ...(raw.settings || {}) } };
  }

  // Sync load from localStorage (instant, for first paint)
  function loadStateSync() {
    try {
      const raw = localStorage.getItem(STATE_KEY);
      if (raw) return mergeState(JSON.parse(raw));
    } catch (e) { /* ignore */ }
    return defaultState();
  }

  // Async load from server, overrides localStorage if server has data
  async function loadStateFromServer() {
    try {
      const res = await fetch('/api/data');
      if (res.ok) {
        const data = await res.json();
        if (data && data.tasks) {
          state = mergeState(data);
          localStorage.setItem(STATE_KEY, JSON.stringify(state));
          // re-init UI
          loadSettingsUI();
          migrateOverdueTasks();
          renderBoard();
          updateTimerDisplay();
        }
      }
    } catch (e) {
      // server not available, localStorage is fine
    }
  }

  function saveState() {
    // Always save to localStorage immediately
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    // Debounce save to server (300ms)
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveToServer, 300);
  }

  async function saveToServer() {
    try {
      await fetch('/api/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      });
    } catch (e) {
      // server not available, data is still safe in localStorage
    }
  }

  // ===== NAVIGATION =====
  const navItems = document.querySelectorAll('.nav-item[data-view]');
  const views = document.querySelectorAll('.view');
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('overlay');
  const menuToggle = document.getElementById('menu-toggle');
  const mobileTitle = document.getElementById('mobile-title');

  const viewTitles = { dump: '倒空大脑', board: '任务看板', today: '今日计划', focus: '专注模式', settings: '设置' };

  function switchView(name) {
    navItems.forEach(n => n.classList.toggle('active', n.dataset.view === name));
    views.forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
    mobileTitle.textContent = viewTitles[name] || '';
    closeSidebar();
    if (name === 'board') renderBoard();
    if (name === 'today') renderToday();
    if (name === 'focus') renderFocus();
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
    const task = {
      id: genId(),
      name: t.name || '未命名任务',
      quadrant: t.quadrant || 'important',
      category: t.category || 'vocation',
      date: t.date || todayKey(),
      duration: t.duration || 30,
      note: t.note || '',
      recurrence: t.recurrence || 'none', // none, daily, weekly
      subtasks: t.subtasks || [],
      done: false,
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
    // also remove from schedule
    const today = todayKey();
    if (state.schedule[today]) {
      for (const k of Object.keys(state.schedule[today])) {
        if (state.schedule[today][k] === id) delete state.schedule[today][k];
      }
    }
    saveState();
  }

  function todayKey() { return new Date().toISOString().slice(0, 10); }

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

    const sysPrompt = `你是一个专业的任务分析与时间管理助手。当前日期是 ${todayStr}（${weekday}）。

用户会给你一段杂乱的文字，可能包含待办事项、想法、计划等。请你：

1. **提取并细化任务**：从杂乱文字中提取每一个可执行的任务。如果任务比较庞大或描述模糊（如"准备面试"），请帮他拆分成具体的子步骤，并将这些子步骤放入 \`subtasks\` 数组中。

2. **智能解析日期**：识别文字中的时间信息并转换为具体日期 (YYYY-MM-DD)：
   - "今天" → ${todayStr}
   - "明天" → 明天的具体日期
   - "后天" → 后天的具体日期
   - "下周一" → 计算出具体日期
   - "月底前" → 当月最后一天
   - "这周五" → 本周五的具体日期
   - 没有提到时间的任务，根据紧急程度推断合理日期

3. **分类到Being领域**（category 字段）：
   - "vocation"：工作、学习、职业发展、考试、项目、汇报等
   - "being"：日常Being、兴趣爱好、社交聚会、健身、购物、整理等
   - "romance"：约会、恋爱、家庭事务、纪念日、陪伴家人等

4. **四象限优先级排序**（quadrant 字段）：
   - "urgent-important"：有明确截止日期且重要的
   - "important"：重要但不紧急（学习、规划、自我提升等）
   - "urgent"：别人需要但对自己不太重要的
   - "neither"：可做可不做的

5. **估算时间**（分钟）

6. **给出简短的执行建议**放在 note 中（如"建议先列提纲再写"、"可以利用通勤时间"等）

7. **重复属性**（recurrence 字段）：如果是每天必须做的选 "daily"；如果是每周重复选 "weekly"；只做一次或不确定为 "none"

请严格返回 JSON 数组格式，不要有其他文字：
[{"name":"具体任务名","quadrant":"urgent-important","category":"vocation","date":"YYYY-MM-DD","duration":30,"note":"执行建议","recurrence":"none","subtasks":[{"name":"子步骤1","done":false},{"name":"子步骤2","done":false}]}]`;

    try {
      const raw = await callLLM(sysPrompt, text);
      // extract JSON from response
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
    // split by newlines and add each as a task
    const lines = text.split(/\n/).map(l => l.replace(/^[-*·•\d.、]+\s*/, '').trim()).filter(Boolean);
    lines.forEach(name => addTask({ name }));
    dumpInput.value = '';
    switchView('board');
  });

  // ===== BOARD VIEW =====
  let boardCatFilter = 'all';
  const CAT_LABELS = { vocation: 'Vocation', being: 'Being', romance: 'Romance' };

  // category filter buttons
  document.querySelectorAll('.cat-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.cat-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      boardCatFilter = btn.dataset.cat;
      renderBoard();
    });
  });

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

  function renderBoard() {
    const quadrants = ['urgent-important', 'important', 'urgent', 'neither'];
    quadrants.forEach(q => {
      const body = document.querySelector(`.q-body[data-drop="${q}"]`);
      const badge = document.querySelector(`.q-badge[data-count="${q === 'urgent-important' ? 'q1' : q === 'important' ? 'q2' : q === 'urgent' ? 'q3' : 'q4'}"]`);
      let tasks = state.tasks.filter(t => t.quadrant === q);
      if (boardCatFilter !== 'all') tasks = tasks.filter(t => t.category === boardCatFilter);
      // sort: undone first, then by date
      tasks.sort((a, b) => {
        if (a.done !== b.done) return a.done ? 1 : -1;
        return (a.date || '').localeCompare(b.date || '');
      });
      badge.textContent = tasks.filter(t => !t.done).length;
      body.innerHTML = '';
      tasks.forEach(t => {
        const card = document.createElement('div');
        card.className = 'task-card' + (t.done ? ' done' : '');
        card.dataset.id = t.id;
        const catClass = 'cat-' + (t.category || 'vocation');
        const catLabel = CAT_LABELS[t.category] || 'Vocation';
        const dateLabel = formatDateShort(t.date);
        const recIcon = t.recurrence === 'daily' ? ' 🔄' : t.recurrence === 'weekly' ? ' 🔁' : '';
        let subtaskTag = '';
        if (t.subtasks && t.subtasks.length > 0) {
          const doneCo = t.subtasks.filter(s => s.done).length;
          subtaskTag = `<span class="task-meta-tag" style="color:var(--accent);">✓ ${doneCo}/${t.subtasks.length}</span>`;
        }
        card.innerHTML = `
          <div class="task-card-top">
            <div class="task-checkbox ${t.done ? 'checked' : ''}" data-id="${t.id}"></div>
            <div class="task-card-name">${esc(t.name)}${recIcon}</div>
          </div>
          <div class="task-card-meta">
            <span class="task-cat-tag ${catClass}">${catLabel}</span>
            ${dateLabel ? '<span class="task-date-tag">' + dateLabel + '</span>' : ''}
            <span class="task-meta-tag"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>${t.duration}分钟</span>
            ${subtaskTag}
            ${t.note ? '<span class="task-meta-tag">' + esc(t.note.slice(0, 30)) + '</span>' : ''}
          </div>`;
        card.addEventListener('click', (e) => {
          if (e.target.classList.contains('task-checkbox')) {
            toggleDone(t.id);
            return;
          }
          openEditModal(t.id);
        });
        body.appendChild(card);
      });
    });
  }

  function toggleDone(id) {
    const t = state.tasks.find(x => x.id === id);
    if (t) { t.done = !t.done; saveState(); renderBoard(); }
  }

  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  // ===== EDIT MODAL =====
  const modalOverlay = document.getElementById('modal-overlay');
  const modalClose = document.getElementById('modal-close');
  const editName = document.getElementById('edit-task-name');
  const editCategory = document.getElementById('edit-task-category');
  const editQuadrant = document.getElementById('edit-task-quadrant');
  const editRecurrence = document.getElementById('edit-task-recurrence');
  const editDate = document.getElementById('edit-task-date');
  const editDuration = document.getElementById('edit-task-duration');
  const editNote = document.getElementById('edit-task-note');
  const editSubtasksList = document.getElementById('edit-subtasks-list');
  const editNewSubtask = document.getElementById('edit-new-subtask');
  const btnAddSubtask = document.getElementById('btn-add-subtask');
  const btnModalSave = document.getElementById('btn-modal-save');
  const btnModalDelete = document.getElementById('btn-modal-delete');
  let editingTaskId = null;
  let currentSubtasks = [];

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
      el.querySelector('.subtask-checkbox').addEventListener('click', () => {
        st.done = !st.done;
        renderSubtasks();
      });
      el.querySelector('.subtask-remove').addEventListener('click', () => {
        currentSubtasks.splice(idx, 1);
        renderSubtasks();
      });
      editSubtasksList.appendChild(el);
    });
  }

  function handleAddSubtask() {
    const val = editNewSubtask.value.trim();
    if (val) {
      currentSubtasks.push({ name: val, done: false });
      editNewSubtask.value = '';
      renderSubtasks();
    }
  }

  btnAddSubtask.addEventListener('click', handleAddSubtask);
  editNewSubtask.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddSubtask();
    }
  });

  function openEditModal(id) {
    const t = state.tasks.find(x => x.id === id);
    if (!t) return;
    editingTaskId = id;
    editName.value = t.name;
    editCategory.value = t.category || 'vocation';
    editQuadrant.value = t.quadrant;
    editRecurrence.value = t.recurrence || 'none';
    editDate.value = t.date || todayKey();
    editDuration.value = t.duration;
    editNote.value = t.note || '';
    currentSubtasks = JSON.parse(JSON.stringify(t.subtasks || [])); // deep copy
    renderSubtasks();
    modalOverlay.classList.remove('hidden');
  }

  modalClose.addEventListener('click', () => modalOverlay.classList.add('hidden'));
  modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) modalOverlay.classList.add('hidden'); });

  btnModalSave.addEventListener('click', () => {
    if (!editingTaskId) return;
    updateTask(editingTaskId, {
      name: editName.value.trim() || '未命名任务',
      category: editCategory.value,
      quadrant: editQuadrant.value,
      recurrence: editRecurrence.value,
      date: editDate.value || todayKey(),
      duration: parseInt(editDuration.value) || 30,
      note: editNote.value.trim(),
      subtasks: currentSubtasks
    });
    modalOverlay.classList.add('hidden');
    renderBoard();
    renderToday();
  });

  btnModalDelete.addEventListener('click', () => {
    if (!editingTaskId) return;
    if (confirm('确定删除这个任务吗？')) {
      deleteTask(editingTaskId);
      modalOverlay.classList.add('hidden');
      renderBoard();
      renderToday();
    }
  });

  // ===== TODAY VIEW =====

  // Clear completed overdue tasks & Migrate overdue undone tasks to today
  function migrateOverdueTasks() {
    const today = todayKey();
    let migrated = 0;
    let recycled = 0;
    
    // 1. 处理过去已完成的任务：循环任务往后推/重置，普通任务清理
    const initialCount = state.tasks.length;
    state.tasks = state.tasks.filter(t => {
      if (t.done && t.date && t.date < today) {
        if (t.recurrence === 'daily') {
          t.done = false;
          t.date = today;
          recycled++;
          return true; // 留下来
        } else if (t.recurrence === 'weekly') {
          let d = new Date(t.date + 'T00:00:00');
          d.setDate(d.getDate() + 7);
          let nextStr = d.toISOString().split('T')[0];
          while(nextStr < today) {
            d.setDate(d.getDate() + 7);
            nextStr = d.toISOString().split('T')[0];
          }
          t.done = false;
          t.date = nextStr;
          if (nextStr === today) recycled++;
          return true; // 留下来
        }
        return false; // 非循环的旧已完成任务，删除
      }
      return true;
    });
    const cleared = initialCount - state.tasks.length;

    // 2. 将过去未完成的任务延期到今天
    state.tasks.forEach(t => {
      if (!t.done && t.date && t.date < today) {
        t.date = today;
        migrated++;
      }
    });

    if (migrated > 0 || cleared > 0 || recycled > 0) {
      saveState();
    }

    // Show notice
    const notice = document.getElementById('migrated-notice');
    let msgs = [];
    if (migrated > 0) msgs.push(`有 ${migrated} 个遗留待办已搬到今天`);
    if (recycled > 0) msgs.push(`已自动重新生成 ${recycled} 个日常/周常循环任务`);
    if (cleared > 0) msgs.push(`已自动清理 ${cleared} 个过期的已完成记录`);

    if (msgs.length > 0) {
      notice.textContent = msgs.join('，') + '。';
      notice.classList.remove('hidden');
    } else {
      notice.classList.add('hidden');
    }
  }

  function generateTimeSlots() {
    const slots = [];
    for (let h = 7; h < 24; h++) {
      slots.push(String(h).padStart(2, '0') + ':00');
    }
    return slots;
  }

  function renderToday() {
    const timeline = document.getElementById('timeline');
    const unschedDiv = document.getElementById('unscheduled-tasks');
    const today = todayKey();

    // Update title with today's date
    const now = new Date();
    const weekdays = ['周日','周一','周二','周三','周四','周五','周六'];
    document.getElementById('today-title').textContent =
      '今日计划 · ' + (now.getMonth()+1) + '月' + now.getDate() + '日 ' + weekdays[now.getDay()];

    if (!state.schedule[today]) state.schedule[today] = {};
    const sched = state.schedule[today];

    // timeline
    const slots = generateTimeSlots();
    timeline.innerHTML = '';
    slots.forEach(time => {
      const taskId = sched[time];
      const task = taskId ? state.tasks.find(t => t.id === taskId) : null;
      const block = document.createElement('div');
      block.className = 'time-block';
      block.innerHTML = `
        <div class="time-label">${time}</div>
        <div class="time-slot ${task ? 'has-task' : ''}" data-time="${time}">
          ${task ? `<button class="slot-remove" data-time="${time}">&times;</button><div class="slot-task-name">${esc(task.name)}</div><div class="slot-task-dur">${task.duration}分钟</div>` : ''}
        </div>`;
      timeline.appendChild(block);
    });

    // click to assign
    timeline.querySelectorAll('.time-slot:not(.has-task)').forEach(slot => {
      slot.addEventListener('click', () => {
        const time = slot.dataset.time;
        showTaskPicker(time);
      });
    });

    // remove from slot
    timeline.querySelectorAll('.slot-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        delete sched[btn.dataset.time];
        saveState();
        renderToday();
      });
    });

    // unscheduled tasks for today
    const scheduledIds = new Set(Object.values(sched));
    const dateTasks = state.tasks.filter(t =>
      !t.done && !scheduledIds.has(t.id) && (t.date === today || !t.date)
    );
    const qOrder = { 'urgent-important': 0, 'important': 1, 'urgent': 2, 'neither': 3 };
    dateTasks.sort((a, b) => (qOrder[a.quadrant] || 3) - (qOrder[b.quadrant] || 3));

    unschedDiv.innerHTML = '';
    if (dateTasks.length === 0) {
      unschedDiv.innerHTML = '<div style="color:var(--text-muted);font-size:.85rem">今天的任务都已安排或完成</div>';
    }
    dateTasks.forEach(t => {
      const el = document.createElement('div');
      el.className = 'unsched-task';
      el.dataset.id = t.id;
      const recIcon = t.recurrence === 'daily' ? ' 🔄' : t.recurrence === 'weekly' ? ' 🔁' : '';
      const qLabels = { 'urgent-important': '紧急重要', 'important': '重要', 'urgent': '紧急', 'neither': '一般' };
      const catLabel = CAT_LABELS[t.category] || '';
      el.innerHTML = `<div>${esc(t.name)}${recIcon}</div><div class="ut-dur">${catLabel ? catLabel + ' · ' : ''}${qLabels[t.quadrant] || ''} · ${t.duration}分钟</div>`;
      unschedDiv.appendChild(el);
    });
  }

  function showTaskPicker(time) {
    const today = todayKey();
    const sched = state.schedule[today] || {};
    const scheduledIds = new Set(Object.values(sched));
    const available = state.tasks.filter(t => !t.done && !scheduledIds.has(t.id) && (t.date === today || !t.date));
    if (available.length === 0) { alert('没有可安排的任务。'); return; }

    const names = available.map((t, i) => `${i + 1}. ${t.name} (${t.duration}分钟)`).join('\n');
    const choice = prompt(`选择要安排到 ${time} 的任务（输入序号）：\n\n${names}`);
    if (!choice) return;
    const idx = parseInt(choice) - 1;
    if (idx >= 0 && idx < available.length) {
      if (!state.schedule[today]) state.schedule[today] = {};
      state.schedule[today][time] = available[idx].id;
      saveState();
      renderToday();
    }
  }

  // AI Schedule
  document.getElementById('btn-ai-schedule').addEventListener('click', async () => {
    const today = todayKey();
    const todayTasks = state.tasks.filter(t => !t.done && (t.date === today || !t.date));
    if (todayTasks.length === 0) { alert('今天没有待办任务。'); return; }
    const energy = document.getElementById('energy-level').value;
    const btn = document.getElementById('btn-ai-schedule');
    btn.disabled = true;
    btn.textContent = '排期中...';

    const now = new Date();
    const currentTime = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');

    const sysPrompt = `你是时间管理助手。根据用户的任务列表、当前时间和精力状态，安排今天的时间块。

规则：
- 时间块从 ${currentTime} 之后开始，以1小时为单位对齐（比如09:00, 10:00, 11:00...）
- 精力高→优先安排重要困难任务在前面；精力低→先安排简单任务热身
- 紧急重要的任务优先安排
- vocation类任务尽量安排在上午精力好的时候
- romance/being类任务可以安排在下午或傍晚
- 每工作2小时建议插入休息
- 一天最多安排8小时工作量，如果任务太多就只安排最重要的

请严格返回JSON对象，key是时间（如"09:00"），value是任务ID：
{"09:00":"taskid1","10:00":"taskid2"}

只返回JSON，不要其他文字。`;

    const taskList = todayTasks.map(t =>
      `ID:${t.id} | 名称:${t.name} | 分类:${t.quadrant} | 领域:${t.category || 'vocation'} | 时长:${t.duration}分钟`
    ).join('\n');

    const userMsg = `日期：${today}\n当前时间：${currentTime}\n精力状态：${energy === 'high' ? '充沛' : energy === 'medium' ? '一般' : '较低'}\n\n任务列表：\n${taskList}`;

    try {
      const raw = await callLLM(sysPrompt, userMsg);
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('AI 返回格式异常');
      const schedule = JSON.parse(jsonMatch[0]);
      state.schedule[today] = {};
      for (const [time, taskId] of Object.entries(schedule)) {
        if (state.tasks.find(t => t.id === taskId)) {
          state.schedule[today][time] = taskId;
        }
      }
      saveState();
      renderToday();
    } catch (e) {
      alert('AI 排期失败：' + e.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:18px;height:18px"><path d="M12 2a4 4 0 0 1 4 4c0 1.95-1.4 3.58-3.25 3.93L12 22l-.75-12.07A4.001 4.001 0 0 1 12 2z"/></svg> AI 智能排期';
    }
  });

  // ===== FOCUS VIEW =====
  let focusTimer = null;
  let focusRemaining = 0;
  let focusTotal = 0;
  let focusTaskId = null;
  let focusRunning = false;

  const timerDisplay = document.getElementById('timer-display');
  const timerProgress = document.getElementById('timer-progress');
  const btnStart = document.getElementById('btn-focus-start');
  const btnPause = document.getElementById('btn-focus-pause');
  const btnStop = document.getElementById('btn-focus-stop');
  const focusTaskName = document.getElementById('focus-task-name');
  const focusSelector = document.getElementById('focus-task-selector');
  const focusActiveArea = document.getElementById('focus-active-area');
  const focusTaskList = document.getElementById('focus-task-list');

  function updateTimerDisplay() {
    if (!focusRunning && focusRemaining === 0) {
      const dur = state.settings.focusDuration || 25;
      timerDisplay.textContent = String(dur).padStart(2, '0') + ':00';
    }
  }

  function renderFocus() {
    // update stats
    const today = todayKey();
    const todayLogs = state.focusLog.filter(l => l.date === today);
    document.getElementById('stat-today-focus').textContent = todayLogs.reduce((s, l) => s + l.minutes, 0);
    document.getElementById('stat-sessions').textContent = todayLogs.length;

    // render task list for selection
    const undone = state.tasks.filter(t => !t.done);
    focusTaskList.innerHTML = '';
    if (undone.length === 0) {
      focusTaskList.innerHTML = '<div style="color:var(--text-muted);font-size:.85rem;padding:.5rem">暂无待办任务，先去倒空大脑添加一些。</div>';
    }
    undone.forEach(t => {
      const item = document.createElement('div');
      item.className = 'focus-task-item';
      const catLabel = CAT_LABELS[t.category] || 'Vocation';
      const recIcon = t.recurrence === 'daily' ? ' 🔄' : t.recurrence === 'weekly' ? ' 🔁' : '';
      item.innerHTML = `
        <span class="task-cat-tag cat-${t.category || 'vocation'}" style="flex-shrink:0">${catLabel}</span>
        <span class="fti-name">${esc(t.name)}${recIcon}</span>
        <span class="fti-meta">${t.duration}分钟</span>`;
      item.addEventListener('click', () => startFocusWithTask(t.id, t.name));
      focusTaskList.appendChild(item);
    });

    updateTimerDisplay();

    // show selector or active area depending on state
    if (!focusRunning && focusRemaining === 0) {
      focusSelector.style.display = '';
      focusActiveArea.classList.add('hidden');
    }
  }

  function startFocusWithTask(taskId, taskName) {
    focusTaskId = taskId || null;
    focusTaskName.textContent = taskName || '自由专注';
    focusSelector.style.display = 'none';
    focusActiveArea.classList.remove('hidden');
    // auto start
    beginTimer();
  }

  document.getElementById('btn-free-focus').addEventListener('click', () => {
    startFocusWithTask(null, '自由专注');
  });

  function beginTimer() {
    focusTotal = (state.settings.focusDuration || 25) * 60;
    focusRemaining = focusTotal;
    focusRunning = true;
    btnStart.classList.add('hidden');
    btnPause.classList.remove('hidden');
    btnStop.classList.remove('hidden');
    tick();
    focusTimer = setInterval(tick, 1000);
  }

  btnStart.addEventListener('click', () => {
    if (focusRunning) return;
    beginTimer();
  });

  btnPause.addEventListener('click', () => {
    if (focusRunning) {
      focusRunning = false;
      clearInterval(focusTimer);
      btnPause.textContent = '继续';
    } else {
      focusRunning = true;
      focusTimer = setInterval(tick, 1000);
      btnPause.textContent = '暂停';
    }
  });

  btnStop.addEventListener('click', () => {
    endFocus(false);
  });

  function tick() {
    if (focusRemaining <= 0) { endFocus(true); return; }
    focusRemaining--;
    const m = Math.floor(focusRemaining / 60);
    const s = focusRemaining % 60;
    timerDisplay.textContent = String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    const circumference = 2 * Math.PI * 90; // r=90
    const offset = circumference * (focusRemaining / focusTotal);
    timerProgress.style.strokeDashoffset = circumference - offset;
  }

  function endFocus(completed) {
    clearInterval(focusTimer);
    focusRunning = false;
    const elapsed = Math.round((focusTotal - focusRemaining) / 60);
    if (elapsed > 0) {
      state.focusLog.push({ date: todayKey(), taskId: focusTaskId, minutes: elapsed });
      saveState();
    }
    if (completed) {
      alert(`专注完成！${elapsed} 分钟。休息一下吧。`);
    }
    // reset
    focusRemaining = 0;
    focusTaskId = null;
    timerProgress.style.strokeDashoffset = 0;
    btnStart.classList.remove('hidden');
    btnPause.classList.add('hidden');
    btnStop.classList.add('hidden');
    btnPause.textContent = '暂停';
    // go back to selector
    focusSelector.style.display = '';
    focusActiveArea.classList.add('hidden');
    renderFocus();
  }

  // ===== SETTINGS =====
  const providerSelect = document.getElementById('llm-provider');
  const customUrlRow = document.getElementById('custom-url-row');
  const baseUrlInput = document.getElementById('llm-base-url');
  const apiKeyInput = document.getElementById('llm-api-key');
  const modelInput = document.getElementById('llm-model');
  const btnToggleKey = document.getElementById('btn-toggle-key');
  const btnTestAi = document.getElementById('btn-test-ai');
  const testResult = document.getElementById('ai-test-result');
  const focusDurInput = document.getElementById('focus-duration');
  const breakDurInput = document.getElementById('break-duration');

  // load settings into UI
  function loadSettingsUI() {
    providerSelect.value = state.settings.provider || 'deepseek';
    baseUrlInput.value = state.settings.baseUrl || '';
    apiKeyInput.value = state.settings.apiKey || '';
    modelInput.value = state.settings.model || '';
    focusDurInput.value = state.settings.focusDuration || 25;
    breakDurInput.value = state.settings.breakDuration || 5;
    customUrlRow.style.display = providerSelect.value === 'custom' ? '' : 'none';
    if (!modelInput.value) modelInput.value = PROVIDER_MODELS[providerSelect.value] || '';
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
    state.settings.focusDuration = parseInt(focusDurInput.value) || 25;
    state.settings.breakDuration = parseInt(breakDurInput.value) || 5;
    saveState();
    // sync timer display if not running
    updateTimerDisplay();
  }

  [apiKeyInput, baseUrlInput, modelInput, focusDurInput, breakDurInput].forEach(el => {
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
        state = { ...defaultState(), ...imported, settings: { ...defaultState().settings, ...(imported.settings || {}) } };
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

  // ===== INIT =====
  loadSettingsUI();
  migrateOverdueTasks();
  renderBoard();
  updateTimerDisplay();
  // Async: load from server if available (upgrades localStorage data)
  loadStateFromServer();

})();
