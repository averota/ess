/* =====================================================================
   ESS — Calendar page logic (pages/calendar.html)

   Reads/writes the table from 04_holidays_schema.sql:
     holidays(id, date UNIQUE, description, remark)

   Primary view is a monthly calendar (grows with its content, the page
   scrolls); Add/Upload/Danger-zone give admins the same
   create/add/bulk-upload/clear capability as before.

   Connection (same pattern as policies.js / leaves.js):
     - supabaseClient.js provides the global `sb`.
     - sidebar.js fires `ess:ready` with { session, employee }. Nothing
       is loaded until it fires. employee.role === 1 means admin.

   Bulk upload/preview flow: header-alias mapping, required-field
   validation, in-file dedupe, editable preview grid, separate Append
   vs Overwrite actions, each going through a SECURITY DEFINER RPC
   (admin_append_holidays / admin_overwrite_holidays / admin_clear_holidays
   — see 04_holidays_schema.sql) so each bulk action runs as one atomic
   transaction server-side.
   ===================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Constants and small helpers                                         */
  /* ------------------------------------------------------------------ */
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  const SCHEMA_FIELDS = {
    date:        ['date', 'holidaydate'],
    description: ['description', 'desc', 'title', 'name', 'holiday'],
    remark:      ['remark', 'remarks', 'note', 'notes']
  };
  const REQUIRED_FIELDS = ['date', 'description'];
  const HEADER_LABELS = { date: 'Date', description: 'Description', remark: 'Remark' };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const pad2 = (n) => String(n).padStart(2, '0');

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function normalizeHeader(h) {
    return String(h).toLowerCase().replace(/[\s_-]/g, '');
  }

  // JS Date (from XLSX, cellDates:true — read via UTC getters, since
  // that's how SheetJS anchors date-only cells) or a plain string (CSV
  // has no cell types) -> a 'yyyy-mm-dd' key.
  function normalizeDateCell(value) {
    if (value instanceof Date && !isNaN(value)) {
      return `${value.getUTCFullYear()}-${pad2(value.getUTCMonth() + 1)}-${pad2(value.getUTCDate())}`;
    }
    const str = String(value ?? '').trim();
    if (!str) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
    const parsed = new Date(str);
    if (isNaN(parsed)) return null;
    return `${parsed.getFullYear()}-${pad2(parsed.getMonth() + 1)}-${pad2(parsed.getDate())}`;
  }

  /** Parses a 'yyyy-mm-dd' string as a local Date (avoids UTC off-by-one). */
  function parseDateOnly(dateStr) {
    const [y, mo, da] = dateStr.split('-').map(Number);
    return new Date(y, mo - 1, da);
  }

  function formatDateLong(dateStr) {
    return parseDateOnly(dateStr).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  }

  function trashIconSvg() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'
      + '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>';
  }
  function editIconSvg() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>'
      + '<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
  }

  /* ------------------------------------------------------------------ */
  /* State                                                                */
  /* ------------------------------------------------------------------ */
  let db = null;
  let readOnly = false;
  let leaveModalReady = false; // set once LeaveRequestModal.init() resolves — guards goToNewLeaveRequest()
  let holidayModal;
  let dayLeaveModal;
  let dayLeaveModalKey = null; // date the modal is currently showing — feeds the "New request" button
  let leaveDetailModal;
  let editingHolidayId = null;
  let currentDataset = null;      // upload preview
  const holidaysMap = new Map();  // 'yyyy-mm-dd' -> { id, date, description, remark }

  // Leave rendering (item 1-4: render leave into the calendar, filtered by
  // RLS server-side, up to 3 per cell + overflow marker, colored by type).
  //
  // Only APPROVED leave (status = 1) is drawn — pending/rejected/cancelled
  // requests aren't shown on the shared calendar. Change the `.eq('status', 1)`
  // in loadLeavesForView() below if pending requests should also render.
  //
  // Who sees what needs NO client-side role check: list_calendar_leave()
  // (02_leaves_schema.sql) scopes the result server-side to the signed-in
  // user's own department, their own leave and their team's (1st line /
  // 2nd line / HOD chain), or everyone for admins. The query below just asks
  // for the visible date range. Only approved leave is ever returned, and
  // the free-text reason comes back null unless the user is entitled to see
  // that request itself.
  const LEAVE_COLOR_PALETTE = [
    '#2563eb', '#dc2626', '#059669', '#d97706',
    '#7c3aed', '#db2777', '#0891b2', '#65a30d'
  ];
  const leaveTypeNames = new Map();  // leave_type_id -> leave_type text (active types, for the legend)
  const leaveTypeColors = new Map(); // leave_type_id -> hex color, assigned in id order so it's stable
  const leavesMap = new Map();       // 'yyyy-mm-dd' -> [{ name, typeId, typeName, fraction }], sorted by name
  let leaveRows = [];                // raw approved-leave rows for the loaded range; leavesMap is rebuilt from these
  let workingValues = null;          // Map(isodow 1=Mon..7=Sun -> working_value) from policy_weekly_working_days; null = not loaded

  function colorForLeaveType(typeId) {
    if (!leaveTypeColors.has(typeId)) {
      leaveTypeColors.set(typeId, LEAVE_COLOR_PALETTE[leaveTypeColors.size % LEAVE_COLOR_PALETTE.length]);
    }
    return leaveTypeColors.get(typeId);
  }

  const today = new Date();
  let viewYear = today.getFullYear();
  let viewMonth = today.getMonth(); // 0-11
  let viewMode = 'grid';            // 'grid' | 'list' | 'holidays'

  /* ------------------------------------------------------------------ */
  /* UI helpers: toasts, error banner, generic confirm dialog             */
  /* ------------------------------------------------------------------ */
  function toast(message, kind) {
    let stack = $('#toastStack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'toastStack';
      stack.className = 'toast-stack';
      document.body.appendChild(stack);
    }
    const el = document.createElement('div');
    el.className = 'toast-item' + (kind === 'success' ? ' is-success' : kind === 'danger' ? ' is-danger' : '');
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(() => el.remove(), kind === 'danger' ? 6000 : 3200);
  }

  function showError(message, onRetry) {
    const panel = $('#holidaysError');
    panel.textContent = '';
    if (!message) { panel.classList.add('hidden'); return; }
    panel.append(message + ' ');
    if (onRetry) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-ghost btn-sm ms-1';
      btn.textContent = 'Try again';
      btn.addEventListener('click', onRetry);
      panel.appendChild(btn);
    }
    panel.classList.remove('hidden');
  }

  function showConfirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal-box">
          <h3>${escapeHtml(title)}</h3>
          <p>${message}</p>
          <div class="modal-actions">
            <button type="button" class="btn btn-ghost btn-sm" data-action="cancel">Cancel</button>
            <button type="button" class="btn btn-sm ${danger ? 'btn-rose' : 'btn-accent'}" data-action="confirm">${escapeHtml(confirmLabel)}</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const cleanup = (result) => { overlay.remove(); resolve(result); };
      overlay.querySelector('[data-action="cancel"]').addEventListener('click', () => cleanup(false));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
      overlay.querySelector('[data-action="confirm"]').addEventListener('click', () => cleanup(true));
    });
  }

  // Small edit-form dialog for correcting an upload-preview row.
  function editRowDialog(row) {
    return new Promise((resolve) => {
      const fields = Object.keys(SCHEMA_FIELDS);
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal-box">
          <h3>Edit holiday</h3>
          <div class="edit-form"></div>
          <div class="modal-actions">
            <button type="button" class="btn btn-ghost btn-sm" data-action="cancel">Cancel</button>
            <button type="button" class="btn btn-accent btn-sm" data-action="save">Save</button>
          </div>
        </div>`;

      const form = overlay.querySelector('.edit-form');
      const inputs = {};
      fields.forEach((field) => {
        const wrap = document.createElement('div');
        wrap.className = 'mb-2';
        const label = document.createElement('label');
        label.className = 'form-label small fw-semibold mb-1';
        label.textContent = HEADER_LABELS[field] || field;
        if (REQUIRED_FIELDS.includes(field)) {
          const req = document.createElement('span');
          req.className = 'req-text';
          req.textContent = ' *';
          label.appendChild(req);
        }
        const input = document.createElement('input');
        input.type = field === 'date' ? 'date' : 'text';
        input.className = 'form-control form-control-sm';
        input.value = row[field] ?? '';
        wrap.appendChild(label);
        wrap.appendChild(input);
        form.appendChild(wrap);
        inputs[field] = input;
      });

      document.body.appendChild(overlay);
      inputs[fields[0]].focus();

      const cleanup = (result) => { overlay.remove(); resolve(result); };
      overlay.querySelector('[data-action="cancel"]').addEventListener('click', () => cleanup(null));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(null); });
      overlay.querySelector('[data-action="save"]').addEventListener('click', () => {
        const updated = {};
        fields.forEach((f) => {
          const val = inputs[f].value.trim();
          updated[f] = val === '' ? null : val;
        });
        const missing = REQUIRED_FIELDS.filter((f) => !updated[f]);
        if (missing.length > 0) {
          alert(`${missing.map((f) => HEADER_LABELS[f] || f).join(', ')} ${missing.length > 1 ? 'are' : 'is'} required.`);
          return;
        }
        cleanup(updated);
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* Supabase access (same idiom as policies.js)                         */
  /* ------------------------------------------------------------------ */
  function findClient() {
    return typeof sb !== 'undefined' && sb && typeof sb.from === 'function' ? sb : null;
  }

  async function checkAdmin(employee) {
    if (employee && employee.role !== undefined && employee.role !== null) return employee.role === 1;
    try {
      const { data, error } = await db.rpc('is_admin');
      if (error) return null;
      return data === true ? true : data === false ? false : null;
    } catch (e) {
      return null;
    }
  }

  function errorMessage(err) {
    if (!err) return 'Something went wrong. Try again.';
    if (err.code === '42501') return 'Not saved: only admins can change holidays.';
    if (err.code === '23505') return 'A holiday already exists on that date.';
    return err.message || 'Something went wrong. Try again.';
  }

  /* ------------------------------------------------------------------ */
  /* DOM refs                                                             */
  /* ------------------------------------------------------------------ */
  const calCard = $('#calendarView');
  const calGrid = $('#calGrid');
  const calLegend = $('#calLegend');
  const monthSelect = $('#monthSelect');
  const yearSelect = $('#yearSelect');
  const prevMonthBtn = $('#prevMonthBtn');
  const nextMonthBtn = $('#nextMonthBtn');
  const todayBtn = $('#todayBtn');
  const refreshBtn = $('#refreshBtn');
  const calList = $('#calList');
  const calWeekdays = $('.cal-weekdays', calCard);
  const calHolidays = $('#calHolidays');
  const viewBtns = { grid: $('#viewGridBtn'), list: $('#viewListBtn'), holidays: $('#viewHolidaysBtn') };

  const uploadPanel = $('#uploadPanel');
  const filePicker = $('#filePicker');
  const fileInput = $('#fileInput');
  const tableContainer = $('#tableContainer');
  const errorContainer = $('#errorContainer');
  const statusContainer = $('#statusContainer');
  const summaryContainer = $('#summaryContainer');
  const tableHeader = $('#tableHeader');
  const tableBody = $('#tableBody');
  const fileMeta = $('#fileMeta');
  const clearPreviewBtn = $('#clearPreviewBtn');
  const appendBtn = $('#appendBtn');
  const overwriteBtn = $('#overwriteBtn');
  const clearHolidaysBtn = $('#clearHolidaysBtn');
  const dangerZone = $('#dangerZone');
  const toggleUploadBtn = $('#toggleUploadBtn');
  const backToCalendarBtn = $('#backToCalendarBtn');

  /* ------------------------------------------------------------------ */
  /* Calendar: build, size, render                                       */
  /* ------------------------------------------------------------------ */
  function daysInMonth(year, month) { return new Date(year, month + 1, 0).getDate(); }
  function dateKey(year, month, day) { return `${year}-${pad2(month + 1)}-${pad2(day)}`; }

  // Clicking an empty day cell files a leave request instead of a holiday
  // (holiday management lives behind the "Add holiday" dropdown, admin
  // only) — opens the shared New leave request modal in place, via
  // assets/js/leaveRequestModal.js (also used by leaves.js), with "From
  // date" prefilled to the clicked day.
  function goToNewLeaveRequest(key) {
    if (!leaveModalReady) {
      toast('Leave request form is still loading — try again in a moment.', 'danger');
      return;
    }
    LeaveRequestModal.openNew(key);
  }

  function buildMonthCells(year, month) {
    const first = new Date(year, month, 1);
    const startOffset = (first.getDay() + 6) % 7; // 0 = Monday
    const total = daysInMonth(year, month);
    const cells = [];

    const prevMonth = month === 0 ? 11 : month - 1;
    const prevYear = month === 0 ? year - 1 : year;
    const prevDays = daysInMonth(prevYear, prevMonth);
    for (let i = 0; i < startOffset; i++) {
      cells.push({ year: prevYear, month: prevMonth, day: prevDays - startOffset + i + 1, otherMonth: true });
    }
    for (let d = 1; d <= total; d++) cells.push({ year, month, day: d, otherMonth: false });

    const nextMonth = month === 11 ? 0 : month + 1;
    const nextYear = month === 11 ? year + 1 : year;
    let nd = 1;
    while (cells.length % 7 !== 0) cells.push({ year: nextYear, month: nextMonth, day: nd++, otherMonth: true });
    return cells;
  }

  function ensureYearInSelect(year) {
    const values = $$('option', yearSelect).map((o) => Number(o.value));
    if (values.includes(year)) return;
    const center = year;
    yearSelect.innerHTML = '';
    for (let y = center - 6; y <= center + 6; y++) {
      const opt = document.createElement('option');
      opt.value = String(y);
      opt.textContent = String(y);
      yearSelect.appendChild(opt);
    }
  }

  function renderCalendar() {
    ensureYearInSelect(viewYear);
    monthSelect.value = String(viewMonth);
    yearSelect.value = String(viewYear);

    const cells = buildMonthCells(viewYear, viewMonth);
    calGrid.style.setProperty('--week-rows', String(cells.length / 7));

    const todayKey = dateKey(today.getFullYear(), today.getMonth(), today.getDate());
    const fragment = document.createDocumentFragment();

    cells.forEach((cell) => {
      const key = dateKey(cell.year, cell.month, cell.day);
      const div = document.createElement('div');
      div.className = 'cal-day'
        + (cell.otherMonth ? ' is-other-month' : '')
        + (key === todayKey ? ' is-today' : '');

      const num = document.createElement('span');
      num.className = 'cal-day-num';
      num.textContent = String(cell.day);
      div.appendChild(num);

      const holiday = holidaysMap.get(key);
      if (holiday) {
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'cal-holiday-pill';
        pill.textContent = holiday.description;
        pill.title = holiday.remark ? `${holiday.description} — ${holiday.remark}` : holiday.description;
        pill.disabled = readOnly;
        if (!readOnly) pill.addEventListener('click', (e) => { e.stopPropagation(); openHolidayModal(holiday); });
        div.appendChild(pill);
      }

      const leaves = leavesMap.get(key);
      if (leaves && leaves.length > 0) {
        const list = document.createElement('div');
        list.className = 'cal-leave-list';
        // Deliberately no stopPropagation here: clicking a pill (or the
        // "..." overflow marker) bubbles up to the cell's own click
        // handler and opens the full day view below.

        leaves.slice(0, 3).forEach((entry) => {
          const pill = document.createElement('span');
          pill.className = 'cal-leave-pill';
          pill.style.setProperty('--leave-color', colorForLeaveType(entry.typeId));
          pill.textContent = `${entry.name}: ${entry.fraction === 1 ? '1' : '0.5'}`;
          pill.title = `${entry.name} — ${entry.typeName} (${entry.fraction === 1 ? 'full day' : 'half day'})`;
          list.appendChild(pill);
        });

        if (leaves.length > 3) {
          const more = document.createElement('span');
          more.className = 'cal-leave-more';
          more.textContent = '...';
          more.title = leaves.slice(3)
            .map((entry) => `${entry.name}: ${entry.fraction === 1 ? '1' : '0.5'} (${entry.typeName})`)
            .join('\n');
          list.appendChild(more);
        }

        div.appendChild(list);
      }

      if (!cell.otherMonth) {
        div.classList.add('is-clickable');
        div.addEventListener('click', () => openDayLeaveModal(key));

        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'cal-day-add';
        addBtn.title = 'New leave request';
        addBtn.setAttribute('aria-label', `New leave request for ${key}`);
        addBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
          + 'stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>';
        addBtn.addEventListener('click', (e) => { e.stopPropagation(); goToNewLeaveRequest(key); });
        div.appendChild(addBtn);
      }

      fragment.appendChild(div);
    });

    calGrid.replaceChildren(fragment);
    if (viewMode === 'list') renderList();
    else if (viewMode === 'holidays') renderHolidayList();
  }

  /* ------------------------------------------------------------------ */
  /* List (agenda) view: same month, same data (holidaysMap + leavesMap)   */
  /* ------------------------------------------------------------------ */
  function setViewMode(mode) {
    viewMode = ['grid', 'list', 'holidays'].includes(mode) ? mode : 'grid';
    calGrid.classList.toggle('hidden', viewMode !== 'grid');
    calWeekdays.classList.toggle('hidden', viewMode !== 'grid');
    calList.classList.toggle('hidden', viewMode !== 'list');
    calHolidays.classList.toggle('hidden', viewMode !== 'holidays');
    // Holidays view spans the whole year: hide the month picker, arrows step by year.
    const yearly = viewMode === 'holidays';
    monthSelect.classList.toggle('hidden', yearly);
    prevMonthBtn.setAttribute('aria-label', yearly ? 'Previous year' : 'Previous month');
    nextMonthBtn.setAttribute('aria-label', yearly ? 'Next year' : 'Next month');
    todayBtn.textContent = yearly ? 'This year' : 'Today';
    Object.entries(viewBtns).forEach(([name, btn]) => {
      btn.classList.toggle('is-active', name === viewMode);
      btn.setAttribute('aria-pressed', String(name === viewMode));
    });
    if (viewMode === 'list') renderList();
    else if (viewMode === 'holidays') renderHolidayList();
  }

  function renderList() {
    const total = daysInMonth(viewYear, viewMonth);
    const todayKey = dateKey(today.getFullYear(), today.getMonth(), today.getDate());
    const fragment = document.createDocumentFragment();

    for (let day = 1; day <= total; day++) {
      const key = dateKey(viewYear, viewMonth, day);
      const holiday = holidaysMap.get(key);
      const leaves = leavesMap.get(key) || [];
      if (!holiday && leaves.length === 0) continue;

      const row = document.createElement('div');
      row.className = 'cal-list-row' + (key === todayKey ? ' is-today' : '');

      const date = document.createElement('div');
      date.className = 'cal-list-date';
      const num = document.createElement('span');
      num.className = 'cal-list-daynum';
      num.textContent = String(day);
      const dow = document.createElement('span');
      dow.className = 'cal-list-dow';
      dow.textContent = parseDateOnly(key).toLocaleDateString(undefined, { weekday: 'short' });
      date.append(num, dow);

      const items = document.createElement('div');
      items.className = 'cal-list-items';

      // Primary = what it is (holiday name / person); secondary = detail
      // (remark / leave type · duration). Color dot carries the type.
      const makeItem = (color, primary, secondary, onClick, disabled) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'cal-list-item';
        item.style.setProperty('--dot', color);
        item.disabled = !!disabled;
        if (onClick) item.addEventListener('click', onClick);
        const dot = document.createElement('span');
        dot.className = 'cal-list-dot';
        const main = document.createElement('span');
        main.className = 'cal-list-primary';
        main.textContent = primary;
        const sub = document.createElement('span');
        sub.className = 'cal-list-secondary';
        sub.textContent = secondary;
        item.append(dot, main, sub);
        return item;
      };

      if (holiday) {
        items.appendChild(makeItem(
          'var(--cal-amber-300)',
          holiday.description,
          holiday.remark || 'Public holiday',
          () => openHolidayModal(holiday),
          readOnly
        ));
      }

      leaves.forEach((entry) => {
        items.appendChild(makeItem(
          colorForLeaveType(entry.typeId),
          entry.name,
          `${entry.typeName} \u00b7 ${entry.fraction === 1 ? 'Full day' : 'Half day'}`,
          () => openLeaveDetailModal(entry)
        ));
      });

      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'cal-day-add cal-list-add';
      add.title = 'New leave request';
      add.setAttribute('aria-label', `New leave request for ${key}`);
      add.innerHTML = '<i class="bi bi-plus-lg"></i>';
      add.addEventListener('click', () => goToNewLeaveRequest(key));

      row.append(date, items, add);
      fragment.appendChild(row);
    }

    if (!fragment.childNodes.length) {
      const empty = document.createElement('div');
      empty.className = 'cal-list-empty';
      empty.textContent = `No holidays or leave in ${MONTHS[viewMonth]} ${viewYear}.`;
      fragment.appendChild(empty);
    }
    calList.replaceChildren(fragment);
  }

  // Holidays view: every holiday in viewYear, from holidaysMap (already
  // loaded in full by loadHolidays(), so no fetch on year change).
  function renderHolidayList() {
    const prefix = `${viewYear}-`;
    const todayKey = dateKey(today.getFullYear(), today.getMonth(), today.getDate());
    const rows = Array.from(holidaysMap.values())
      .filter((h) => h.date.startsWith(prefix))
      .sort((a, b) => a.date.localeCompare(b.date));

    const head = document.createElement('div');
    head.className = 'cal-hol-head';
    const title = document.createElement('h2');
    title.textContent = `Holidays in ${viewYear}`;
    const count = document.createElement('span');
    count.className = 'cal-hol-count';
    count.textContent = `${rows.length} ${rows.length === 1 ? 'holiday' : 'holidays'}`;
    head.append(title, count);

    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'cal-list-empty';
      empty.textContent = `No holidays registered for ${viewYear}.`;
      calHolidays.replaceChildren(head, empty);
      return;
    }

    const wrap = document.createElement('div');
    wrap.className = 'cal-hol-scroll';
    const table = document.createElement('table');
    table.className = 'cal-hol-table';
    table.innerHTML = '<thead><tr><th>Date</th><th>Day</th><th>Description</th><th>Remark</th>'
      + (readOnly ? '' : '<th class="text-end">Actions</th>') + '</tr></thead>';
    const tbody = document.createElement('tbody');

    rows.forEach((h) => {
      const d = parseDateOnly(h.date);
      const tr = document.createElement('tr');
      if (h.date < todayKey) tr.className = 'is-past';
      else if (h.date === todayKey) tr.className = 'is-today';

      const cells = [
        d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }),
        d.toLocaleDateString(undefined, { weekday: 'long' }),
        h.description,
        h.remark || '\u2014'
      ];
      cells.forEach((text, i) => {
        const td = document.createElement('td');
        td.textContent = text;
        if (i === 0) td.className = 'cal-hol-date';
        if (i === 2) td.className = 'cal-hol-desc';
        tr.appendChild(td);
      });

      if (!readOnly) {
        const td = document.createElement('td');
        td.className = 'text-end';
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'btn-icon-only';
        edit.title = 'Edit holiday';
        edit.setAttribute('aria-label', `Edit ${h.description}`);
        edit.innerHTML = editIconSvg();
        edit.addEventListener('click', () => openHolidayModal(h));
        td.appendChild(edit);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    wrap.appendChild(table);
    calHolidays.replaceChildren(head, wrap);
  }

  function goToMonth(year, month) {
    viewYear = year;
    viewMonth = month;
    renderCalendar(); // instant nav using cached holidays; leave pills pop in once the fetch below resolves
    loadLeavesForView().catch((err) => {
      console.error('calendar: failed to load leave data', err);
      toast('Couldn\u2019t load leave data for this month.', 'danger');
    });
  }
  function shiftMonth(delta) {
    if (viewMode === 'holidays') { goToMonth(viewYear + delta, viewMonth); return; }
    let m = viewMonth + delta, y = viewYear;
    if (m < 0) { m = 11; y--; } else if (m > 11) { m = 0; y++; }
    goToMonth(y, m);
  }

  /* ------------------------------------------------------------------ */
  /* Load                                                                 */
  /* ------------------------------------------------------------------ */
  async function loadHolidays() {
    const { data, error } = await db.from('holidays').select('id, date, description, remark').order('date', { ascending: true });
    if (error) throw error;
    holidaysMap.clear();
    (data || []).forEach((h) => holidaysMap.set(h.date, h));
    if (leaveRows.length) rebuildLeavesMap(); // holidays decide which leave days are drawn
    renderCalendar();
  }

  // Weekly working pattern (which weekdays deduct leave, and how much), so
  // days off inside a leave aren't drawn as leave. Failure is non-fatal: the
  // calendar falls back to drawing every day of a leave.
  async function loadWorkingPattern() {
    try {
      const { data, error } = await db.from('policy_weekly_working_days').select('day_of_week, working_value');
      if (error) throw error;
      workingValues = new Map((data || []).map((d) => [Number(d.day_of_week), Number(d.working_value)]));
    } catch (err) {
      console.warn('calendar: could not load weekly working days; showing every day of a leave:', err);
      workingValues = null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Leave: type legend + per-cell rendering                              */
  /* ------------------------------------------------------------------ */

  // Active leave types, once — assigns a stable palette color per
  // leave_type_id (id order) and powers the legend. A type retired later
  // (is_active = false) simply won't appear in the legend; colorForLeaveType()
  // still assigns it a fallback color on demand if old leave against it is
  // still visible on the calendar.
  async function loadLeaveTypes() {
    const { data, error } = await db
      .from('leave_types')
      .select('leave_type_id, leave_type')
      .eq('is_active', true)
      .order('leave_type_id', { ascending: true });
    if (error) throw error;

    leaveTypeNames.clear();
    (data || []).forEach((t) => {
      leaveTypeNames.set(t.leave_type_id, t.leave_type);
      colorForLeaveType(t.leave_type_id); // reserve its palette slot in id order
    });
    renderLegend();
  }

  function renderLegend() {
    if (!calLegend) return;
    calLegend.innerHTML = '';
    leaveTypeNames.forEach((name, typeId) => {
      const item = document.createElement('span');
      item.className = 'cal-legend-item';
      const swatch = document.createElement('span');
      swatch.className = 'cal-legend-swatch';
      swatch.style.background = colorForLeaveType(typeId);
      item.append(swatch, name);
      calLegend.appendChild(item);
    });
  }

  // First/last date currently on screen (includes the other-month padding
  // days buildMonthCells() adds to fill the grid), as 'yyyy-mm-dd' keys.
  function visibleRangeKeys() {
    const cells = buildMonthCells(viewYear, viewMonth);
    const first = cells[0];
    const last = cells[cells.length - 1];
    return {
      startKey: dateKey(first.year, first.month, first.day),
      endKey: dateKey(last.year, last.month, last.day)
    };
  }

  // Working value (0 / 0.5 / 1) of a date under policy_weekly_working_days —
  // the same isodow lookup calculate_leave_request_total_days() uses. If the
  // weekly pattern couldn't be loaded, every day counts as a full day (the
  // old behaviour) rather than hiding leave by mistake.
  function workingValueFor(date) {
    if (!workingValues) return 1;
    const isodow = date.getDay() === 0 ? 7 : date.getDay();
    return workingValues.has(isodow) ? workingValues.get(isodow) : 0;
  }

  // Expands one leave_requests row into the dates it should be DRAWN on,
  // with a per-date fraction. Follows the half-day model from
  // 02_leaves_schema.sql: a boundary date is 0.5 when its half-day flag cuts
  // it short, every date strictly between start/end is a whole day, and a
  // single-day request is whole only when neither flag cuts into it.
  //
  // Days that don't deduct leave aren't drawn: public holidays, and days off
  // in the weekly working pattern (working value 0, e.g. Sat/Sun). A
  // half-deduct day (working value 0.5) is drawn as a half day. Leave types
  // that count every calendar day (e.g. Maternity) draw every day, as they
  // deduct every day.
  function collectLeaveDays(row) {
    const results = [];
    const start = parseDateOnly(row.start_date);
    const end = parseDateOnly(row.end_date);
    const singleDay = row.start_date === row.end_date;
    const cursor = new Date(start);
    while (cursor <= end) {
      const key = dateKey(cursor.getFullYear(), cursor.getMonth(), cursor.getDate());
      let fraction;
      if (singleDay) {
        fraction = (row.start_half_day !== 'pm' && row.end_half_day !== 'am') ? 1 : 0.5;
      } else if (key === row.start_date) {
        fraction = row.start_half_day === 'pm' ? 0.5 : 1;
      } else if (key === row.end_date) {
        fraction = row.end_half_day === 'am' ? 0.5 : 1;
      } else {
        fraction = 1;
      }
      if (!row.count_calendar_days) {
        if (holidaysMap.has(key)) fraction = 0;
        else {
          const w = workingValueFor(cursor);
          fraction = fraction === 1 ? w : Math.min(w, 0.5);
        }
      }
      if (fraction > 0) results.push({ key, fraction });
      cursor.setDate(cursor.getDate() + 1);
    }
    return results;
  }

  // Builds leavesMap (date -> people out that day) from the loaded leave rows,
  // skipping holidays / non-deducting days (see collectLeaveDays). Re-run
  // whenever the holidays change too, since they decide which days show.
  function rebuildLeavesMap() {
    const { startKey, endKey } = visibleRangeKeys();
    leavesMap.clear();
    leaveRows.forEach((row) => {
      const name = row.employee ? row.employee.name : 'Unknown';
      const typeName = row.leave_type ? row.leave_type.leave_type : 'Leave';
      collectLeaveDays(row).forEach(({ key, fraction }) => {
        if (key < startKey || key > endKey) return; // clamp to the visible grid
        if (!leavesMap.has(key)) leavesMap.set(key, []);
        leavesMap.get(key).push({
          name,
          employeeCode: row.employee ? row.employee.employee_id : null,
          typeId: row.leave_type_id,
          typeName,
          fraction,               // this date's share (1 / 0.5) — used on the cell pill
          totalDays: Number(row.total_days), // the request's full length — used in the day/detail views
          reason: row.reason,
          requestId: row.id,
          createdAt: row.created_at,
          approvedAt: row.approved_at,
          reviewer: row.approver ? (Array.isArray(row.approver) ? row.approver[0]?.name : row.approver.name) : '',
          startDate: row.start_date,     // full request span + half-day flags — used in the detail view
          endDate: row.end_date,
          startHalfDay: row.start_half_day,
          endHalfDay: row.end_half_day
        });
      });
    });
    leavesMap.forEach((list) => list.sort((a, b) => a.name.localeCompare(b.name)));
  }

  // Approved leave overlapping the visible range, for everyone in the
  // signed-in user's department (plus their own / their team's, or
  // everyone for admins) — see list_calendar_leave() in 02_leaves_schema.sql.
  // Names and leave type come back with the rows, so nothing here depends on
  // the user being able to read those employees' rows directly.
  async function loadLeavesForView() {
    const { startKey, endKey } = visibleRangeKeys();
    calGrid.classList.add('is-loading');
    calList.classList.add('is-loading');
    calHolidays.classList.add('is-loading');
    try {
      const { data: rpcRows, error } = await db.rpc('list_calendar_leave', { p_from: startKey, p_to: endKey });
      if (error) throw error;

      // Reshape into the row layout the rendering code below expects.
      const data = (rpcRows || []).map((r) => ({
        id: r.out_id,
        created_at: r.out_created_at,
        approved_at: r.out_approved_at,
        approver: r.out_approver_name ? { name: r.out_approver_name } : null,
        employee_id: r.out_employee_id,
        start_date: r.out_start_date,
        start_half_day: r.out_start_half_day,
        end_date: r.out_end_date,
        end_half_day: r.out_end_half_day,
        leave_type_id: r.out_leave_type_id,
        total_days: r.out_total_days,
        reason: r.out_reason,
        count_calendar_days: r.out_count_calendar_days,
        leave_type: { leave_type: r.out_leave_type },
        employee: { name: r.out_employee_name, employee_id: r.out_employee_code }
      }));

      leaveRows = data;
      rebuildLeavesMap();

      renderCalendar();
    } finally {
      calGrid.classList.remove('is-loading');
      calList.classList.remove('is-loading');
      calHolidays.classList.remove('is-loading');
    }
  }

  // Compact read-only day view: everyone's leave on the clicked date.
  // Name + leave type are the primary line; days/reason are a single
  // minimal secondary line, kept short on purpose (see the design notes
  // in the CSS). Opened by clicking anywhere in a day cell.
  function openDayLeaveModal(key) {
    dayLeaveModalKey = key;
    const entries = leavesMap.get(key) || [];
    $('#dayLeaveModalTitle').textContent = formatDateLong(key);

    const body = $('#dayLeaveModalBody');
    body.innerHTML = '';

    if (entries.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'day-leave-empty';
      empty.textContent = 'No leave on this date.';
      body.appendChild(empty);
    } else {
      entries.forEach((entry, index) => {
        const item = document.createElement('div');
        item.className = 'day-leave-item';
        item.dataset.index = String(index);

        const main = document.createElement('div');
        main.className = 'day-leave-main';
        const name = document.createElement('span');
        name.className = 'day-leave-name';
        name.textContent = entry.name;
        const type = document.createElement('span');
        type.className = 'day-leave-type';
        type.textContent = entry.typeName;
        type.style.setProperty('--leave-color', colorForLeaveType(entry.typeId));
        main.append(name, type);

        const meta = document.createElement('div');
        meta.className = 'day-leave-meta';
        const daysLabel = `${entry.totalDays} day${entry.totalDays === 1 ? '' : 's'}`;
        meta.textContent = entry.reason ? `${daysLabel} · ${entry.reason}` : daysLabel;

        const chevron = document.createElement('span');
        chevron.className = 'day-leave-chevron';
        chevron.setAttribute('aria-hidden', 'true');
        chevron.textContent = '\u203a';

        item.append(main, meta, chevron);
        body.appendChild(item);
      });
    }

    dayLeaveModal.show();
  }

  // Approval steps per request id, fetched once from the same RPC leaves.js
  // uses (names resolved server-side). Empty if the RPC isn't installed.
  let stepsByRequest = null;
  async function loadApprovalSteps() {
    if (stepsByRequest) return stepsByRequest;
    try {
      const { data, error } = await db.rpc('list_leave_approval_steps');
      if (error) throw error;
      stepsByRequest = LeaveDetail.groupSteps(data);
      return stepsByRequest;
    } catch (err) {
      console.warn('calendar: could not load approval steps:', err);
      return new Map();
    }
  }

  // Full detail for one leave record, opened from a row in dayLeaveModal.
  // Same markup as leaves.html's details modal (see leaveDetail.js).
  async function openLeaveDetailModal(entry) {
    const steps = (await loadApprovalSteps()).get(entry.requestId) || [];
    const stepsLoaded = !!stepsByRequest;                       // false if the steps RPC failed
    const adminNames = await LeaveDetail.loadAdminNames(db);    // admins have no employees row
    LeaveDetail.setStatus($('#leaveDetailStatus'), 1); // calendar only lists approved leave
    $('#leaveDetailBody').innerHTML = LeaveDetail.render({
      employee: entry.employeeCode ? `${entry.name} (${entry.employeeCode})` : entry.name,
      leaveType: entry.typeName,
      startDate: entry.startDate,
      startHalf: entry.startHalfDay,
      endDate: entry.endDate,
      endHalf: entry.endHalfDay,
      days: entry.totalDays,
      reason: entry.reason,
      status: 1,
      steps,
      createdAt: entry.createdAt,
      approvedAt: entry.approvedAt,
      reviewer: entry.reviewer,
      // list_calendar_leave() doesn't return requested_by_admin / approved_by_admin, so an admin-created
      // leave is recognised as: approved, no approval steps, and approved by an admin (blank / "Admin" /
      // a known admin name) rather than an employee approver -> one "Created" step.
      adminCreated: stepsLoaded && !steps.length &&
        (!entry.reviewer || entry.reviewer === 'Admin' || [...adminNames.values()].includes(entry.reviewer))
    });
    leaveDetailModal.show();
  }

  /* ------------------------------------------------------------------ */
  /* Add / edit / delete (single record)                                  */
  /* ------------------------------------------------------------------ */
  function openHolidayModal(holiday, prefillDate) {
    editingHolidayId = holiday ? holiday.id : null;
    $('#holidayModalTitle').textContent = holiday ? 'Edit holiday' : 'Add holiday';
    $('#holidayDateInput').value = holiday ? holiday.date : (prefillDate || '');
    $('#holidayDescriptionInput').value = holiday ? holiday.description : '';
    $('#holidayRemarkInput').value = holiday ? holiday.remark || '' : '';
    $('#holidayDeleteBtn').classList.toggle('hidden', !holiday);
    holidayModal.show();
  }

  async function onSubmitHoliday(e) {
    e.preventDefault();
    const payload = {
      date: $('#holidayDateInput').value,
      description: $('#holidayDescriptionInput').value.trim(),
      remark: $('#holidayRemarkInput').value.trim() || null
    };
    if (!payload.date || !payload.description) {
      toast('Please fill in the date and description.', 'danger');
      return;
    }

    const submitBtn = $('#holidaySubmitBtn');
    submitBtn.disabled = true;
    let error;
    if (editingHolidayId) {
      ({ error } = await db.from('holidays').update(payload).eq('id', editingHolidayId));
    } else {
      ({ error } = await db.from('holidays').upsert(payload, { onConflict: 'date' }));
    }
    submitBtn.disabled = false;

    if (error) { toast(errorMessage(error), 'danger'); return; }

    toast(editingHolidayId ? 'Holiday updated.' : 'Holiday added.', 'success');
    holidayModal.hide();
    await loadHolidays();
  }

  async function onDeleteHolidayClick() {
    if (!editingHolidayId) return;
    const dateVal = $('#holidayDateInput').value;
    const descVal = $('#holidayDescriptionInput').value;
    const ok = await showConfirmDialog({
      title: 'Delete holiday',
      message: `Delete "${escapeHtml(descVal)}" on ${escapeHtml(dateVal ? formatDateLong(dateVal) : '')}?`,
      confirmLabel: 'Delete holiday',
      danger: true
    });
    if (!ok) return;

    const { error } = await db.from('holidays').delete().eq('id', editingHolidayId);
    if (error) { toast(errorMessage(error), 'danger'); return; }

    toast('Holiday deleted.', 'success');
    holidayModal.hide();
    await loadHolidays();
  }

  /* ------------------------------------------------------------------ */
  /* Upload panel: open/close                                             */
  /* ------------------------------------------------------------------ */
  function setUploadPanelOpen(open) {
    uploadPanel.classList.toggle('hidden', !open);
    calCard.classList.toggle('hidden', open);
    dangerZone.classList.toggle('hidden', open);
    if (open) resetUploadPreview();
  }

  function resetUploadPreview() {
    errorContainer.classList.add('hidden');
    statusContainer.classList.add('hidden');
    summaryContainer.classList.add('hidden');
    tableContainer.classList.add('hidden');
    tableHeader.innerHTML = '';
    tableBody.innerHTML = '';
    currentDataset = null;
    filePicker.classList.remove('compact');
    fileInput.value = '';
  }

  function showUploadError(message) {
    errorContainer.textContent = message;
    errorContainer.classList.remove('hidden');
  }
  function showUploadStatus(html) {
    statusContainer.innerHTML = html;
    statusContainer.classList.remove('hidden');
  }
  function clearUploadMessages() {
    errorContainer.classList.add('hidden');
    statusContainer.classList.add('hidden');
  }

  /* ------------------------------------------------------------------ */
  /* Upload panel: parse file -> preview                                  */
  /* ------------------------------------------------------------------ */
  function onFileSelected(e) {
    const file = e.target.files[0];
    if (!file) return;

    resetUploadPreview();
    fileMeta.textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const data = new Uint8Array(event.target.result);
        const workbook = XLSX.read(data, { type: 'array', cellDates: true });
        const worksheet = workbook.Sheets[workbook.SheetNames[0]];
        const jsonRows = XLSX.utils.sheet_to_json(worksheet, { defval: '' });
        if (jsonRows.length === 0) { showUploadError('The uploaded file contains no data.'); return; }
        processRows(jsonRows);
      } catch (err) {
        showUploadError(`Failed to parse file: ${err.message}`);
      }
    };
    reader.onerror = () => showUploadError('Error reading file from disk.');
    reader.readAsArrayBuffer(file);
  }

  function processRows(jsonRows) {
    const rawHeaders = Object.keys(jsonRows[0]);
    const headerToField = {};
    const mappedFields = [];
    rawHeaders.forEach((rawHeader) => {
      const norm = normalizeHeader(rawHeader);
      for (const [field, aliases] of Object.entries(SCHEMA_FIELDS)) {
        if (aliases.includes(norm) && !mappedFields.includes(field)) {
          headerToField[rawHeader] = field;
          mappedFields.push(field);
          break;
        }
      }
    });

    const missingRequired = REQUIRED_FIELDS.filter((f) => !mappedFields.includes(f));
    if (missingRequired.length > 0) {
      showUploadError(`The file is missing required column(s) for: ${missingRequired.map((f) => HEADER_LABELS[f] || f).join(', ')}. Required columns are Date and Description.`);
      return;
    }

    const allSchemaFields = Object.keys(SCHEMA_FIELDS);
    const mappedRows = jsonRows.map((row) => {
      const out = {};
      allSchemaFields.forEach((f) => { out[f] = null; });
      for (const [rawHeader, field] of Object.entries(headerToField)) {
        const val = row[rawHeader];
        if (val === undefined || val === null || val === '') { out[field] = null; continue; }
        out[field] = field === 'date' ? normalizeDateCell(val) : (String(val).trim() || null);
      }
      return out;
    });

    const validRowsRaw = [];
    let invalidCount = 0;
    mappedRows.forEach((row) => {
      if (REQUIRED_FIELDS.every((f) => row[f] !== null && row[f] !== '')) validRowsRaw.push(row);
      else invalidCount++;
    });

    const seen = new Set();
    const validRows = [];
    let duplicateInFileCount = 0;
    validRowsRaw.forEach((row) => {
      if (seen.has(row.date)) duplicateInFileCount++;
      else { seen.add(row.date); validRows.push(row); }
    });

    currentDataset = { validRows, invalidCount, duplicateInFileCount };
    renderSummary(currentDataset);
    renderPreviewTable();
    tableContainer.classList.remove('hidden');
    filePicker.classList.add('compact');
  }

  function renderSummary(ds) {
    summaryContainer.classList.remove('hidden');
    const total = ds.validRows.length + ds.invalidCount + ds.duplicateInFileCount;
    summaryContainer.innerHTML = `
      <span class="stat-item">Rows in file <span class="stat-value">${total}</span></span>
      <span class="stat-item">Valid <span class="stat-value num-emerald">${ds.validRows.length}</span></span>
      <span class="stat-item">Skipped (missing required fields) <span class="stat-value num-rose">${ds.invalidCount}</span></span>
      <span class="stat-item">Duplicate in file <span class="stat-value num-amber">${ds.duplicateInFileCount}</span></span>
    `;
  }

  function renderPreviewTable() {
    const fields = Object.keys(SCHEMA_FIELDS);
    const rows = currentDataset.validRows;
    const colCount = fields.length + 2; // idx + fields + actions

    let headerHtml = '<tr><th class="idx-col">#</th>';
    fields.forEach((f) => { headerHtml += `<th>${escapeHtml(HEADER_LABELS[f] || f)}</th>`; });
    headerHtml += '<th class="actions-col">Action</th></tr>';
    tableHeader.innerHTML = headerHtml;

    if (rows.length === 0) {
      tableBody.innerHTML = `<tr><td colspan="${colCount}"><div class="empty-state">No records to display.</div></td></tr>`;
      return;
    }

    const fragment = document.createDocumentFragment();
    rows.forEach((row, i) => {
      const tr = document.createElement('tr');
      const idxTd = document.createElement('td');
      idxTd.className = 'idx-col';
      idxTd.textContent = String(i + 1);
      tr.appendChild(idxTd);

      fields.forEach((field) => {
        const td = document.createElement('td');
        td.textContent = row[field] ?? '';
        tr.appendChild(td);
      });

      const actionTd = document.createElement('td');
      actionTd.className = 'actions-col';
      const wrap = document.createElement('div');
      wrap.className = 'actions-wrap';

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn-icon-only';
      editBtn.title = 'Edit this row';
      editBtn.innerHTML = editIconSvg();
      editBtn.addEventListener('click', () => handleEditPreviewRow(row, i));
      wrap.appendChild(editBtn);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn-icon-only';
      delBtn.title = 'Delete this row';
      delBtn.innerHTML = trashIconSvg();
      delBtn.addEventListener('click', () => handleDeletePreviewRow(row, i));
      wrap.appendChild(delBtn);

      actionTd.appendChild(wrap);
      tr.appendChild(actionTd);
      fragment.appendChild(tr);
    });
    tableBody.replaceChildren(fragment);
  }

  async function handleEditPreviewRow(row, index) {
    const updated = await editRowDialog(row);
    if (!updated) return;
    const isDuplicate = currentDataset.validRows.some((r, i) => i !== index && r.date === updated.date);
    if (isDuplicate) { alert(`Date "${updated.date}" is already used by another row in this preview. Please use a unique date.`); return; }
    currentDataset.validRows[index] = updated;
    renderSummary(currentDataset);
    renderPreviewTable();
  }

  async function handleDeletePreviewRow(row, index) {
    const confirmed = await showConfirmDialog({
      title: 'Delete row',
      message: `Remove "${escapeHtml(row.description || row.date)}" from this preview? It won't be uploaded. This only affects the preview — nothing has been saved yet.`,
      confirmLabel: 'Delete',
      danger: true
    });
    if (!confirmed) return;
    currentDataset.validRows.splice(index, 1);
    renderSummary(currentDataset);
    renderPreviewTable();
  }

  /* ------------------------------------------------------------------ */
  /* Upload panel: commit (Append / Overwrite / Clear)                    */
  /* ------------------------------------------------------------------ */
  async function fetchExistingHolidayDates() {
    const { data, error } = await db.from('holidays').select('date');
    if (error) throw error;
    return new Set((data || []).map((r) => r.date));
  }

  async function onAppendClick() {
    if (!currentDataset || currentDataset.validRows.length === 0) return;
    appendBtn.disabled = true;
    try {
      clearUploadMessages();
      showUploadStatus('Checking existing holidays…');
      const existingDates = await fetchExistingHolidayDates();
      const rowsToInsert = currentDataset.validRows.filter((r) => !existingDates.has(r.date));
      const alreadyExistCount = currentDataset.validRows.length - rowsToInsert.length;

      if (rowsToInsert.length === 0) {
        showUploadStatus(`<span class="num-amber">Nothing to append — all ${currentDataset.validRows.length} valid row(s) already exist.</span>`);
        return;
      }

      const confirmed = await showConfirmDialog({
        title: 'Confirm append',
        message: `This will INSERT ${rowsToInsert.length} new holiday(s). ${alreadyExistCount} record(s) already exist (by date) and will be skipped. Existing data will not be changed or removed.`,
        confirmLabel: `Append ${rowsToInsert.length} record(s)`
      });
      if (!confirmed) { showUploadStatus('Append cancelled.'); return; }

      showUploadStatus('Uploading…');
      const { data: insertedCount, error } = await db.rpc('admin_append_holidays', { p_rows: rowsToInsert });
      if (error) throw error;

      resetUploadPreview();
      setUploadPanelOpen(false);
      await loadHolidays();
      toast(`Appended ${insertedCount} record(s). Skipped ${alreadyExistCount} existing record(s).`, 'success');
    } catch (err) {
      showUploadStatus(`<span class="num-rose">Append failed: ${escapeHtml(errorMessage(err))}</span>`);
    } finally {
      appendBtn.disabled = false;
    }
  }

  async function onOverwriteClick() {
    if (!currentDataset || currentDataset.validRows.length === 0) return;
    overwriteBtn.disabled = true;
    try {
      clearUploadMessages();
      const confirmed = await showConfirmDialog({
        title: 'Confirm overwrite',
        message: `This will PERMANENTLY DELETE ALL existing holiday rows and replace them with ${currentDataset.validRows.length} record(s) from this file. This cannot be undone.`,
        confirmLabel: 'Overwrite table',
        danger: true
      });
      if (!confirmed) { showUploadStatus('Overwrite cancelled.'); return; }

      showUploadStatus('Overwriting table…');
      const { data: insertedCount, error } = await db.rpc('admin_overwrite_holidays', { p_rows: currentDataset.validRows });
      if (error) throw error;

      resetUploadPreview();
      setUploadPanelOpen(false);
      await loadHolidays();
      toast(`Table overwritten with ${insertedCount} record(s).`, 'success');
    } catch (err) {
      showUploadStatus(`<span class="num-rose">Overwrite failed: ${escapeHtml(errorMessage(err))}</span>`);
    } finally {
      overwriteBtn.disabled = false;
    }
  }

  async function onClearHolidaysClick() {
    const confirmed = await showConfirmDialog({
      title: 'Clear all holidays',
      message: 'This will PERMANENTLY DELETE every holiday record. This cannot be undone.',
      confirmLabel: 'Clear all holidays',
      danger: true
    });
    if (!confirmed) return;

    clearHolidaysBtn.disabled = true;
    try {
      const { error } = await db.rpc('admin_clear_holidays');
      if (error) throw error;
      await loadHolidays();
      toast('All holiday records cleared.', 'success');
    } catch (err) {
      toast(errorMessage(err), 'danger');
    } finally {
      clearHolidaysBtn.disabled = false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Read-only mode                                                       */
  /* ------------------------------------------------------------------ */
  function applyReadOnly() {
    $('.holidays-page').classList.add('is-readonly');
    $('#holidaysReadOnly').classList.remove('hidden');
    $('#addHolidayDropdownBtn').closest('.dropdown').classList.add('hidden');
    dangerZone.classList.add('hidden');
    renderCalendar();
  }

  /* ------------------------------------------------------------------ */
  /* Blank template download                                             */
  /* ------------------------------------------------------------------ */
  function downloadHolidayTemplate() {
    const headers = REQUIRED_FIELDS.concat(
      Object.keys(HEADER_LABELS).filter(f => !REQUIRED_FIELDS.includes(f))
    ).map(f => HEADER_LABELS[f]);

    const ws = XLSX.utils.aoa_to_sheet([headers]);
    ws['!cols'] = headers.map(() => ({ wch: 22 }));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Holidays');
    XLSX.writeFile(wb, 'holidays_template.xlsx');
  }

  /* ------------------------------------------------------------------ */
  /* Init                                                                 */
  /* ------------------------------------------------------------------ */
  let wired = false;
  function setupPage() {
    if (wired) return;
    wired = true;

    MONTHS.forEach((name, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = name;
      monthSelect.appendChild(opt);
    });

    holidayModal = new bootstrap.Modal($('#holidayModal'));
    dayLeaveModal = new bootstrap.Modal($('#dayLeaveModal'));
    leaveDetailModal = new bootstrap.Modal($('#leaveDetailModal'));

    // Hand off to the shared leave request modal, prefilled with the date
    // dayLeaveModal was showing. Waits for dayLeaveModal to fully close
    // first (hidden.bs.modal) so the two Bootstrap modals/backdrops don't
    // stack on top of each other.
    $('#dayLeaveNewRequestBtn').addEventListener('click', () => {
      const key = dayLeaveModalKey;
      $('#dayLeaveModal').addEventListener('hidden.bs.modal', () => goToNewLeaveRequest(key), { once: true });
      dayLeaveModal.hide();
    });

    // Clicking a record in the day view drills into its detail — same
    // hide-then-show handoff as the button above. Delegated on the list
    // container since rows are rebuilt on every openDayLeaveModal() call.
    $('#dayLeaveModalBody').addEventListener('click', (e) => {
      const row = e.target.closest('.day-leave-item');
      if (!row) return;
      const entries = leavesMap.get(dayLeaveModalKey) || [];
      const entry = entries[Number(row.dataset.index)];
      if (!entry) return;
      $('#dayLeaveModal').addEventListener('hidden.bs.modal', () => openLeaveDetailModal(entry), { once: true });
      dayLeaveModal.hide();
    });
    $('#holidayForm').addEventListener('submit', onSubmitHoliday);
    $('#holidayDeleteBtn').addEventListener('click', onDeleteHolidayClick);
    $('#addHolidayBtn').addEventListener('click', () => openHolidayModal(null));

    prevMonthBtn.addEventListener('click', () => shiftMonth(-1));
    nextMonthBtn.addEventListener('click', () => shiftMonth(1));
    todayBtn.addEventListener('click', () => goToMonth(today.getFullYear(), today.getMonth()));
    monthSelect.addEventListener('change', () => goToMonth(viewYear, Number(monthSelect.value)));
    yearSelect.addEventListener('change', () => goToMonth(Number(yearSelect.value), viewMonth));
    refreshBtn.addEventListener('click', () => { showError(null); run(); });
    viewBtns.grid.addEventListener('click', () => setViewMode('grid'));
    viewBtns.list.addEventListener('click', () => setViewMode('list'));
    viewBtns.holidays.addEventListener('click', () => setViewMode('holidays'));

    $('#downloadTemplateBtn').addEventListener('click', downloadHolidayTemplate);
    toggleUploadBtn.addEventListener('click', () => setUploadPanelOpen(uploadPanel.classList.contains('hidden')));
    backToCalendarBtn.addEventListener('click', () => setUploadPanelOpen(false));
    fileInput.addEventListener('change', onFileSelected);
    clearPreviewBtn.addEventListener('click', resetUploadPreview);
    appendBtn.addEventListener('click', onAppendClick);
    overwriteBtn.addEventListener('click', onOverwriteClick);
    clearHolidaysBtn.addEventListener('click', onClearHolidaysClick);
  }

  async function run() {
    showError(null);
    try {
      await loadHolidays();
      await loadWorkingPattern();
      await loadLeaveTypes();
      await loadLeavesForView();
      if (readOnly) applyReadOnly();
    } catch (err) {
      showError(`Couldn\u2019t load the calendar. ${err && err.message ? err.message : ''}`.trim(), run);
    }
  }

  const domReady = new Promise((resolve) => {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', resolve);
    else resolve();
  });

  let started = false;
  async function onEssReady(e) {
    if (started) return;
    const { session, employee } = (e && e.detail) || {};
    if (!session) return;
    started = true;

    await domReady;
    setupPage();

    db = findClient();
    if (!db) {
      showError('Couldn\u2019t find the Supabase client. Check that supabaseClient.js defines `sb` and loads before holidays.js.');
      return;
    }

    const adminCheck = await checkAdmin(employee);
    readOnly = adminCheck === false;

    // Wire the shared "New leave request" modal (assets/js/leaveRequestModal.js,
    // also used by leaves.js) so an empty day cell can file a request
    // without leaving the calendar page — see goToNewLeaveRequest().
    if (typeof LeaveRequestModal === 'undefined') {
      console.error('calendar: LeaveRequestModal not found. Check that leaveRequestModal.js loads before calendar.js.');
    } else {
      // an admin has no employee record: the form is opened with a null
      // own id and asks who the request is for.
      const isSuper = !!(employee && employee.isSuperAdmin);
      const { data: me, error: meErr } = isSuper
        ? { data: null, error: null }
        : await db
            .from('employees')
            .select('id')
            .eq('auth_user_id', session.user.id)
            .maybeSingle();
      if (!isSuper && (meErr || !me)) {
        console.error('calendar: could not resolve current employee record for the leave request modal:', meErr);
      } else {
        await LeaveRequestModal.init({
          sb: db,
          isAdmin: adminCheck === true,
          myEmployeeId: me ? me.id : null,
          myEmployeeName: employee?.name || '',
          showToast: toast
        });
        leaveModalReady = true;
      }
    }

    run();
  }

  window.addEventListener('ess:ready', onEssReady);
})();