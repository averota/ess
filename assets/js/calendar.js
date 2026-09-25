/* =====================================================================
   ESS — Calendar page logic (pages/calendar.html)

   Reads/writes the table from 04_holidays_schema.sql:
     holidays(id, date UNIQUE, description, remark)

   Primary view is a monthly calendar (fits the whole month on screen —
   see fitCalendarHeight()); Add/Upload/Danger-zone give admins the same
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
  let editingHolidayId = null;
  let currentDataset = null;      // upload preview
  const holidaysMap = new Map();  // 'yyyy-mm-dd' -> { id, date, description, remark }

  const today = new Date();
  let viewYear = today.getFullYear();
  let viewMonth = today.getMonth(); // 0-11

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
            <button type="button" class="btn btn-ghost" data-action="cancel">Cancel</button>
            <button type="button" class="btn ${danger ? 'btn-rose' : 'btn-accent'}" data-action="confirm">${escapeHtml(confirmLabel)}</button>
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
            <button type="button" class="btn btn-ghost" data-action="cancel">Cancel</button>
            <button type="button" class="btn btn-accent" data-action="save">Save</button>
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
  const monthSelect = $('#monthSelect');
  const yearSelect = $('#yearSelect');
  const prevMonthBtn = $('#prevMonthBtn');
  const nextMonthBtn = $('#nextMonthBtn');
  const todayBtn = $('#todayBtn');
  const refreshBtn = $('#refreshBtn');

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

  function fitCalendarHeight() {
    if (!calCard) return;
    const top = calCard.getBoundingClientRect().top;
    const available = window.innerHeight - top - 24;
    calCard.style.height = Math.max(available, 420) + 'px';
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

      if (!cell.otherMonth) {
        div.classList.add('is-clickable');
        div.addEventListener('click', () => { if (!holiday) goToNewLeaveRequest(key); });
      }

      fragment.appendChild(div);
    });

    calGrid.replaceChildren(fragment);
    fitCalendarHeight();
  }

  function goToMonth(year, month) { viewYear = year; viewMonth = month; renderCalendar(); }
  function shiftMonth(delta) {
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
    renderCalendar();
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
    else fitCalendarHeight();
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
    $('#holidayForm').addEventListener('submit', onSubmitHoliday);
    $('#holidayDeleteBtn').addEventListener('click', onDeleteHolidayClick);
    $('#addHolidayBtn').addEventListener('click', () => openHolidayModal(null));

    prevMonthBtn.addEventListener('click', () => shiftMonth(-1));
    nextMonthBtn.addEventListener('click', () => shiftMonth(1));
    todayBtn.addEventListener('click', () => goToMonth(today.getFullYear(), today.getMonth()));
    monthSelect.addEventListener('change', () => goToMonth(viewYear, Number(monthSelect.value)));
    yearSelect.addEventListener('change', () => goToMonth(Number(yearSelect.value), viewMonth));
    refreshBtn.addEventListener('click', () => { showError(null); run(); });

    $('#downloadTemplateBtn').addEventListener('click', downloadHolidayTemplate);
    toggleUploadBtn.addEventListener('click', () => setUploadPanelOpen(uploadPanel.classList.contains('hidden')));
    backToCalendarBtn.addEventListener('click', () => setUploadPanelOpen(false));
    fileInput.addEventListener('change', onFileSelected);
    clearPreviewBtn.addEventListener('click', resetUploadPreview);
    appendBtn.addEventListener('click', onAppendClick);
    overwriteBtn.addEventListener('click', onOverwriteClick);
    clearHolidaysBtn.addEventListener('click', onClearHolidaysClick);

    window.addEventListener('resize', fitCalendarHeight);
  }

  async function run() {
    showError(null);
    try {
      await loadHolidays();
      if (readOnly) applyReadOnly();
    } catch (err) {
      showError(`Couldn\u2019t load holidays. ${err && err.message ? err.message : ''}`.trim(), run);
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
      const { data: me, error: meErr } = await db
        .from('employees')
        .select('id')
        .eq('auth_user_id', session.user.id)
        .maybeSingle();
      if (meErr || !me) {
        console.error('calendar: could not resolve current employee record for the leave request modal:', meErr);
      } else {
        await LeaveRequestModal.init({
          sb: db,
          isAdmin: adminCheck === true,
          myEmployeeId: me.id,
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