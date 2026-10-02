/* =====================================================================
   ESS — Calendar page logic (pages/calendar.html)

   Reads/writes the tables from 05_calendar_schemas.sql:
     holidays(id, date UNIQUE, description, remark)
     rooms(id, name, location, capacity, is_active)
     room_bookings(id, room_id, booking_date, start_time, end_time, title,
                   notes, invitees, recurrence_group_id, recurrence_rule,
                   booked_by, booker_name)

   Primary view is a monthly calendar (grows with its content, the page
   scrolls) with two modes — Leave (default) and Rooms — plus, in Rooms
   mode, a daily Gantt (one row per room, 30-minute slots; clicking a free
   slot opens the booking form prefilled with room/date/time) and, in Leave
   mode, a yearly Holidays table (read-only for non-admins). In Rooms mode every cell shows that day's room bookings;
   "+" / "New booking" opens the booking form; owners (and admins) can
   edit/delete a booking, everyone else sees it read-only; admins also get
   "Manage rooms". A booking can carry free-text invitees and can repeat
   (daily/weekly/monthly/yearly — see "Room booking: recurrence" below): a
   series is one row per date sharing a recurrence_group_id. A booking is
   entered as From / To dates: From..To is the same time every day (a daily
   series), and "Repeats" repeats that whole block — only the options that
   fit the block are offered (see ruleFitsRange()). Days off
   (policy_weekly_working_days = 0) and public holidays can be skipped;
   on half days (= 0.5, morning only) an occurrence is trimmed to end at
   12:00. Edit = that date only; delete = that
   date, this + following, or the whole series. Add/Upload/Danger-zone give admins the same
   create/add/bulk-upload/clear capability as before.

   Connection (same pattern as policies.js / leaves.js):
     - supabaseClient.js provides the global `sb`.
     - sidebar.js fires `ess:ready` with { session, employee }. Nothing
       is loaded until it fires. employee.role === 1 means admin.

   Bulk upload/preview flow: header-alias mapping, required-field
   validation, in-file dedupe, editable preview grid, separate Append
   vs Overwrite actions, each going through a SECURITY DEFINER RPC
   (admin_append_holidays / admin_overwrite_holidays / admin_clear_holidays
   — see 05_calendar_schemas.sql) so each bulk action runs as one atomic
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

  // One stable palette colour per id, handed out in first-seen order.
  const makeColorFor = (map) => (id) => {
    if (!map.has(id)) map.set(id, LEAVE_COLOR_PALETTE[map.size % LEAVE_COLOR_PALETTE.length]);
    return map.get(id);
  };
  const colorForLeaveType = makeColorFor(leaveTypeColors);

  // Room booking state (Rooms mode). Bookings are single-day, so
  // bookingsMap is simply 'yyyy-mm-dd' -> [entry], sorted by start time.
  const roomColors = new Map();       // room_id -> hex color
  const colorForRoom = makeColorFor(roomColors);
  const roomsMap = new Map();         // room_id -> { id, name, location, capacity, is_active }
  const bookingsMap = new Map();      // 'yyyy-mm-dd' -> [{ id, roomId, roomName, date, start, end, title, notes, bookedBy, bookerName }]
  let bookingRows = [];               // raw rows for the loaded range; bookingsMap is rebuilt from these
  let roomFilter = '';                // '' = all rooms, otherwise a room_id string
  let isAdmin = false;                // strictly adminCheck === true (readOnly is also true while the check is unknown-false)
  let myUserId = null;                // auth user id — compared to room_bookings.booked_by
  let myName = '';                    // display-name snapshot written to room_bookings.booker_name
  let bookingModal;
  let roomsModal;
  let editingBooking = null;          // bookingsMap entry being edited, null = new
  let editingRoomId = null;

  const today = new Date();
  let viewYear = today.getFullYear();
  let viewMonth = today.getMonth(); // 0-11
  let viewMode = 'grid';            // 'grid' | 'holidays' (Leave mode only) | 'gantt' (Rooms mode only)
  let ganttKey = null;              // 'yyyy-mm-dd' shown in the Gantt view
  let mode = 'leave';               // 'leave' | 'room' — what the grid cells show

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

  // `detailsHtml` (trusted/escaped by the caller) renders under the message.
  // With `choices` ([{ value, label, hint }]) the dialog also shows a radio
  // list and resolves to the selected value (first one preselected);
  // otherwise it resolves true. Dismissing resolves false either way.
  function showConfirmDialog({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, choices = null, detailsHtml = '' }) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      const choicesHtml = choices ? `<div class="confirm-choice-group">${choices.map((c, i) => `
          <label class="confirm-choice">
            <input type="radio" name="confirmChoice" value="${escapeHtml(c.value)}"${i === 0 ? ' checked' : ''}>
            <span>
              <span class="confirm-choice-title">${escapeHtml(c.label)}</span>
              ${c.hint ? `<span class="confirm-choice-hint">${escapeHtml(c.hint)}</span>` : ''}
            </span>
          </label>`).join('')}</div>` : '';
      overlay.innerHTML = `
        <div class="modal-box">
          <h3>${escapeHtml(title)}</h3>
          <p>${message}</p>
          ${detailsHtml}
          ${choicesHtml}
          <div class="modal-actions">
            <button type="button" class="btn btn-ghost btn-sm" data-action="cancel">${escapeHtml(cancelLabel)}</button>
            <button type="button" class="btn btn-sm ${danger ? 'btn-rose' : 'btn-accent'}" data-action="confirm">${escapeHtml(confirmLabel)}</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const cleanup = (result) => { overlay.remove(); resolve(result); };
      overlay.querySelector('[data-action="cancel"]').addEventListener('click', () => cleanup(false));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
      overlay.querySelector('[data-action="confirm"]').addEventListener('click', () => {
        const checked = choices && overlay.querySelector('input[name="confirmChoice"]:checked');
        cleanup(choices ? (checked ? checked.value : choices[0].value) : true);
      });
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

  const ERROR_TEXT = {
    holiday: { '42501': 'Not saved: only admins can change holidays.', '23505': 'A holiday already exists on that date.' },
    room: { '42501': 'Not saved: only admins can manage rooms.', '23505': 'A room with that name already exists.' },
    booking: {
      '42501': 'Not saved: you can only change your own bookings, in an active room.',
      '23P01': 'That room is already booked during an overlapping time.',
      '23514': 'End time must be after the start time.'
    }
  };

  function errorMessage(err, ctx = 'holiday') {
    if (!err) return 'Something went wrong. Try again.';
    return (ERROR_TEXT[ctx] && ERROR_TEXT[ctx][err.code]) || err.message || 'Something went wrong. Try again.';
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
  const calWeekdays = $('.cal-weekdays', calCard);
  const calHolidays = $('#calHolidays');
  const calGantt = $('#calGantt');
  const ganttHours = $('#ganttHours');
  const ganttRows = $('#ganttRows');
  const dayPickerWrap = $('#dayPickerWrap');
  const dayInput = $('#dayInput');
  const viewBtns = { grid: $('#viewGridBtn'), gantt: $('#viewGanttBtn'), holidays: $('#viewHolidaysBtn') };
  const modeBtns = { leave: $('#modeLeaveBtn'), room: $('#modeRoomBtn') };
  const roomFilterWrap = $('#roomFilterWrap');
  const roomFilterSelect = $('#roomFilterSelect');
  const manageRoomsBtn = $('#manageRoomsBtn');

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

      // Leave mode draws leavesMap, Rooms mode draws bookingsMap — same pill
      // list (up to 3 + "..." overflow). Deliberately no stopPropagation:
      // clicking a pill bubbles up to the cell's click handler (day view).
      const entries = (mode === 'room' ? bookingsMap : leavesMap).get(key);
      if (entries && entries.length > 0) {
        div.appendChild(buildPillList(entries, mode === 'room' ? bookingPill : leavePill));
      }

      if (!cell.otherMonth) {
        div.classList.add('is-clickable');
        // Rooms: the day opens as the Gantt timeline; Leave: the day list.
        div.addEventListener('click', () => (mode === 'room' ? showGanttFor(key) : openDayModal(key)));

        const addLabel = mode === 'room' ? 'New booking' : 'New leave request';
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'cal-day-add';
        addBtn.title = addLabel;
        addBtn.setAttribute('aria-label', `${addLabel} for ${key}`);
        addBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
          + 'stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>';
        addBtn.addEventListener('click', (e) => { e.stopPropagation(); addForDate(key); });
        div.appendChild(addBtn);
      }

      fragment.appendChild(div);
    });

    calGrid.replaceChildren(fragment);
    if (viewMode === 'holidays') renderHolidayList();
    else if (viewMode === 'gantt') renderGantt();
  }

  // One pill descriptor per entry: { color, text, title, more }.
  // `more` is the tooltip line when the entry is folded into the "..." marker.
  function leavePill(entry) {
    const f = entry.fraction === 1 ? '1' : '0.5';
    return {
      color: colorForLeaveType(entry.typeId),
      text: `${entry.name}: ${f}`,
      title: `${entry.name} \u2014 ${entry.typeName} (${entry.fraction === 1 ? 'full day' : 'half day'})`,
      more: `${entry.name}: ${f} (${entry.typeName})`
    };
  }

  // Own bookings read "You" instead of the stored display name.
  const isMine = (b) => !!myUserId && b.bookedBy === myUserId;
  const bookerLabel = (b) => (isMine(b) ? 'You' : b.bookerName);

  function bookingPill(b) {
    const title = `${b.start}\u2013${b.end} \u00b7 ${b.roomName} \u2014 ${b.title} (${bookerLabel(b)})`
      + (b.recurrenceGroupId ? `\n${recurrenceLabel(b.recurrenceRule)}` : '')
      + (b.invitees ? `\nInvitees: ${b.invitees}` : '');
    return {
      color: colorForRoom(b.roomId),
      text: `${b.recurrenceGroupId ? '\u21bb ' : ''}${b.start}\u2013${b.end} ${b.title}`,
      title,
      more: title.split('\n')[0]
    };
  }

  function buildPillList(entries, toPill) {
    const list = document.createElement('div');
    list.className = 'cal-leave-list';
    entries.slice(0, 3).forEach((entry) => {
      const d = toPill(entry);
      const pill = document.createElement('span');
      pill.className = 'cal-leave-pill';
      pill.style.setProperty('--leave-color', d.color);
      pill.textContent = d.text;
      pill.title = d.title;
      list.appendChild(pill);
    });
    if (entries.length > 3) {
      const more = document.createElement('span');
      more.className = 'cal-leave-more';
      more.textContent = '...';
      more.title = entries.slice(3).map((entry) => toPill(entry).more).join('\n');
      list.appendChild(more);
    }
    return list;
  }

  /* ------------------------------------------------------------------ */
  /* View + mode switching                                                */
  /* ------------------------------------------------------------------ */
  function setViewMode(nextView) {
    // Leave mode offers Grid | Holidays, Rooms mode Grid | Gantt (see setMode()).
    viewMode = nextView === 'holidays' && mode === 'leave' ? 'holidays'
      : nextView === 'gantt' && mode === 'room' ? 'gantt' : 'grid';
    const gantt = viewMode === 'gantt';
    const yearly = viewMode === 'holidays'; // spans the whole year: arrows step by year
    calGrid.classList.toggle('hidden', viewMode !== 'grid');
    calWeekdays.classList.toggle('hidden', viewMode !== 'grid');
    calHolidays.classList.toggle('hidden', !yearly);
    calGantt.classList.toggle('hidden', !gantt);
    // Gantt shows a single day: swap the month/year pickers for a day picker.
    dayPickerWrap.classList.toggle('hidden', !gantt);
    monthSelect.classList.toggle('hidden', yearly || gantt);
    yearSelect.classList.toggle('hidden', gantt);
    const unit = yearly ? 'year' : gantt ? 'day' : 'month';
    prevMonthBtn.setAttribute('aria-label', `Previous ${unit}`);
    nextMonthBtn.setAttribute('aria-label', `Next ${unit}`);
    todayBtn.textContent = yearly ? 'This year' : 'Today';
    Object.entries(viewBtns).forEach(([name, btn]) => {
      btn.classList.toggle('is-active', name === viewMode);
      btn.setAttribute('aria-pressed', String(name === viewMode));
    });
    if (yearly) renderHolidayList();
    if (gantt) {
      const inView = !!ganttKey && ganttKey.startsWith(`${viewYear}-${pad2(viewMonth + 1)}`);
      setGanttDate(inView ? ganttKey : defaultGanttKey());
    }
  }

  // Leave | Rooms. Only the grid is mode-aware, so switching mode from the
  // yearly Holidays table returns to the grid.
  function setMode(next) {
    mode = next === 'room' ? 'room' : 'leave';
    Object.entries(modeBtns).forEach(([name, btn]) => {
      btn.classList.toggle('is-active', name === mode);
      btn.setAttribute('aria-pressed', String(name === mode));
    });
    roomFilterWrap.classList.toggle('hidden', mode !== 'room');
    viewBtns.gantt.classList.toggle('hidden', mode !== 'room');
    viewBtns.holidays.classList.toggle('hidden', mode === 'room');
    manageRoomsBtn.classList.toggle('hidden', mode !== 'room' || !isAdmin);
    renderLegend();
    if (viewMode !== 'grid') setViewMode('grid');
    renderCalendar();
    loadDataForView().catch(reportLoadError);
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
    renderCalendar(); // instant nav using cached holidays; leave/booking pills pop in once the fetch below resolves
    loadDataForView().catch(reportLoadError);
  }

  // Loads whatever the current mode draws on the grid.
  function loadDataForView() {
    return mode === 'room' ? loadBookingsForView() : loadLeavesForView();
  }
  function reportLoadError(err) {
    console.error('calendar: failed to load data', err);
    toast(`Couldn\u2019t load ${mode === 'room' ? 'room booking' : 'leave'} data for this month.`, 'danger');
  }
  function shiftMonth(delta) {
    if (viewMode === 'gantt') { setGanttDate(toDateKey(addDays(parseDateOnly(ganttKey), delta))); return; }
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

  // Leave mode: leave types. Rooms mode: bookable (active) rooms.
  function renderLegend() {
    if (!calLegend) return;
    calLegend.innerHTML = '';
    calLegend.setAttribute('aria-label', mode === 'room' ? 'Room legend' : 'Leave type legend');
    const items = mode === 'room'
      ? Array.from(roomsMap.values()).filter((r) => r.is_active).map((r) => [colorForRoom(r.id), r.name])
      : Array.from(leaveTypeNames).map(([typeId, name]) => [colorForLeaveType(typeId), name]);
    items.forEach(([color, name]) => {
      const item = document.createElement('span');
      item.className = 'cal-legend-item';
      const swatch = document.createElement('span');
      swatch.className = 'cal-legend-swatch';
      swatch.style.background = color;
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
      calHolidays.classList.remove('is-loading');
    }
  }

  // Compact read-only day view, shared by both modes: name + a coloured tag
  // are the primary line; a single minimal secondary line sits beside them
  // (see the design notes in the CSS). Opened by clicking anywhere in a day
  // cell. `describe(entry)` -> { name, tag, color, meta }.
  function showDayModal(key, entries, describe, emptyText, newLabel) {
    dayLeaveModalKey = key;
    $('#dayLeaveModalTitle').textContent = formatDateLong(key);
    $('#dayNewBtnLabel').textContent = newLabel;

    const body = $('#dayLeaveModalBody');
    body.innerHTML = '';

    if (entries.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'day-leave-empty';
      empty.textContent = emptyText;
      body.appendChild(empty);
    } else {
      entries.forEach((entry, index) => {
        const d = describe(entry);
        const item = document.createElement('div');
        item.className = 'day-leave-item';
        item.dataset.index = String(index);

        const main = document.createElement('div');
        main.className = 'day-leave-main';
        const name = document.createElement('span');
        name.className = 'day-leave-name';
        name.textContent = d.name;
        const type = document.createElement('span');
        type.className = 'day-leave-type';
        type.textContent = d.tag;
        type.style.setProperty('--leave-color', d.color);
        main.append(name, type);

        const meta = document.createElement('div');
        meta.className = 'day-leave-meta';
        meta.textContent = d.meta;

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

  function openDayLeaveModal(key) {
    showDayModal(key, leavesMap.get(key) || [], (entry) => {
      const daysLabel = `${entry.totalDays} day${entry.totalDays === 1 ? '' : 's'}`;
      return {
        name: entry.name,
        tag: entry.typeName,
        color: colorForLeaveType(entry.typeId),
        meta: entry.reason ? `${daysLabel} \u00b7 ${entry.reason}` : daysLabel
      };
    }, 'No leave on this date.', 'New request');
  }

  function openDayBookingsModal(key) {
    showDayModal(key, bookingsMap.get(key) || [], (b) => ({
      name: (b.recurrenceGroupId ? '\u21bb ' : '') + b.title,
      tag: b.roomName,
      color: colorForRoom(b.roomId),
      meta: `${b.start}\u2013${b.end} \u00b7 ${bookerLabel(b)}`
    }), roomsMap.size ? 'No bookings on this date.' : 'No rooms have been set up yet.', 'New booking');
  }

  function openDayModal(key) {
    if (mode === 'room') openDayBookingsModal(key);
    else openDayLeaveModal(key);
  }

  // The "+" in a cell / "New ..." in the day view: new leave request or new booking.
  // Back-dating is admin-only: true when a booking starting at `startMin`
  // minutes into `key` is in the past (same 5-minute grace as the form check).
  const isBackDated = (key, startMin = 0) =>
    !isAdmin && parseDateOnly(key).getTime() + startMin * 60000 < Date.now() - 5 * 60 * 1000;

  function addForDate(key) {
    if (mode === 'room' && isBackDated(key, 24 * 60 - 1)) {
      toast('Only admins can book a past date.', 'danger');
      return;
    }
    if (mode === 'room') openBookingModal(null, key);
    else goToNewLeaveRequest(key);
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
  /* Room booking: load                                                   */
  /* ------------------------------------------------------------------ */

  // Non-fatal: if the rooms table isn't installed yet, the Leave view keeps
  // working and Rooms mode simply has no rooms.
  async function loadRooms() {
    try {
      const { data, error } = await db.from('rooms')
        .select('id, name, location, capacity, is_active')
        .order('name', { ascending: true });
      if (error) throw error;
      roomsMap.clear();
      (data || []).forEach((r) => roomsMap.set(r.id, r));
      // reserve palette slots in id order so a room keeps its colour when others are added/renamed
      (data || []).slice().sort((x, y) => x.id - y.id).forEach((r) => colorForRoom(r.id));
    } catch (err) {
      console.warn('calendar: could not load rooms:', err);
      roomsMap.clear();
    }
    renderRoomFilter();
    renderLegend();
  }

  function renderRoomFilter() {
    const keep = roomFilter;
    roomFilterSelect.innerHTML = '';
    const all = document.createElement('option');
    all.value = '';
    all.textContent = 'All rooms';
    roomFilterSelect.appendChild(all);
    roomsMap.forEach((r) => {
      if (!r.is_active) return;
      const opt = document.createElement('option');
      opt.value = String(r.id);
      opt.textContent = r.name;
      roomFilterSelect.appendChild(opt);
    });
    roomFilter = $$('option', roomFilterSelect).some((o) => o.value === keep) ? keep : '';
    roomFilterSelect.value = roomFilter;
  }

  const hhmm = (t) => String(t).slice(0, 5); // 'HH:MM:SS' -> 'HH:MM'
  const toMinutes = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const minToTime = (m) => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;

  function rebuildBookingsMap() {
    bookingsMap.clear();
    bookingRows.forEach((r) => {
      if (roomFilter && String(r.room_id) !== roomFilter) return;
      const room = roomsMap.get(r.room_id);
      if (!bookingsMap.has(r.booking_date)) bookingsMap.set(r.booking_date, []);
      bookingsMap.get(r.booking_date).push({
        id: r.id,
        roomId: r.room_id,
        roomName: room ? room.name : 'Unknown room',
        date: r.booking_date,
        start: hhmm(r.start_time),
        end: hhmm(r.end_time),
        title: r.title,
        notes: r.notes,
        invitees: r.invitees,
        recurrenceGroupId: r.recurrence_group_id,
        recurrenceRule: r.recurrence_rule,
        bookedBy: r.booked_by,
        bookerName: r.booker_name
      });
    });
    bookingsMap.forEach((list) => list.sort((a, b) => a.start.localeCompare(b.start) || a.roomName.localeCompare(b.roomName)));
  }

  // Everyone signed in sees the whole schedule (RLS select = true).
  async function loadBookingsForView() {
    const { startKey, endKey } = visibleRangeKeys();
    calGrid.classList.add('is-loading');
    try {
      const { data, error } = await db.from('room_bookings')
        .select('id, room_id, booking_date, start_time, end_time, title, notes, invitees, recurrence_group_id, recurrence_rule, booked_by, booker_name')
        .gte('booking_date', startKey)
        .lte('booking_date', endKey)
        .order('start_time', { ascending: true });
      if (error) throw error;
      bookingRows = data || [];
      rebuildBookingsMap();
      renderCalendar();
    } finally {
      calGrid.classList.remove('is-loading');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Gantt day view (Rooms mode): one row per active room, 30-min slots   */
  /*                                                                      */
  /* Draws bookingsMap for ganttKey (already filtered by the room filter  */
  /* and loaded for the month containing ganttKey). A free slot opens the */
  /* booking form prefilled with room + date + start/end; a booking bar   */
  /* opens it like any other booking (editable for owner/admin, read-only */
  /* otherwise). Bookings outside the window below are clipped to it.     */
  /* ------------------------------------------------------------------ */
  const GANTT_START_HOUR = 7;
  const GANTT_END_HOUR = 18;
  const SLOT_MINUTES = 30;
  const GANTT_START_MIN = GANTT_START_HOUR * 60;
  const GANTT_TOTAL_MIN = (GANTT_END_HOUR - GANTT_START_HOUR) * 60;
  const GANTT_SLOTS = GANTT_TOTAL_MIN / SLOT_MINUTES;
  const ganttPct = (min) => ((min - GANTT_START_MIN) / GANTT_TOTAL_MIN) * 100;

  function div(className, text, tag = 'div') {
    const el = document.createElement(tag);
    el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  const biIcon = (name) => div(`bi ${name}`, undefined, 'i'); // Bootstrap Icons glyph

  // Open the Gantt on `key` (grid cell click, or today for the toggle button).
  function showGanttFor(key) {
    setViewMode('gantt');
    setGanttDate(key); // also moves the month (and reloads its bookings) if needed
  }

  // Today when it falls in the month being viewed, otherwise the 1st.
  function defaultGanttKey() {
    const t = new Date();
    const inView = t.getFullYear() === viewYear && t.getMonth() === viewMonth;
    return dateKey(viewYear, viewMonth, inView ? t.getDate() : 1);
  }

  // Bookings are fetched per month, so only reload when the day crosses one.
  function setGanttDate(key) {
    ganttKey = key;
    const [y, m] = key.split('-').map(Number);
    const monthChanged = y !== viewYear || m - 1 !== viewMonth;
    viewYear = y;
    viewMonth = m - 1;
    renderGantt();
    if (monthChanged) loadDataForView().catch(reportLoadError);
  }

  function renderGantt() {
    if (viewMode !== 'gantt' || !ganttKey) return;
    dayInput.value = ganttKey;
    calGantt.style.setProperty('--gantt-hours', String(GANTT_END_HOUR - GANTT_START_HOUR));
    calGantt.style.setProperty('--gantt-slots', String(GANTT_SLOTS));

    const hourCells = [];
    for (let h = GANTT_START_HOUR; h < GANTT_END_HOUR; h++) {
      const cell = div('gantt-hour-cell', `${pad2(h)}:00`);
      cell.appendChild(div('hour-sub', h < 12 ? 'AM' : 'PM'));
      hourCells.push(cell);
    }
    ganttHours.replaceChildren(...hourCells);

    const visibleRooms = Array.from(roomsMap.values())
      .filter((r) => r.is_active && (!roomFilter || String(r.id) === roomFilter));
    if (!visibleRooms.length) {
      ganttRows.replaceChildren(div('gantt-empty', roomsMap.size ? 'No rooms match the filter.' : 'No rooms have been set up yet.'));
      return;
    }

    const dayBookings = bookingsMap.get(ganttKey) || [];
    const holiday = holidaysMap.get(ganttKey);
    const now = new Date();
    const nowMin = ganttKey === toDateKey(now) ? now.getHours() * 60 + now.getMinutes() : null;
    const rows = visibleRooms.map((room) =>
      buildGanttRow(room, dayBookings.filter((b) => b.roomId === room.id), nowMin, !!holiday));
    // One watermark across every room (not one per row).
    if (holiday) {
      const mark = div('gantt-holiday-watermark');
      mark.appendChild(document.createElement('span')).textContent = holiday.description;
      rows.push(mark);
    }
    ganttRows.replaceChildren(...rows);
  }

  function buildGanttRow(room, bookings, nowMin, isHoliday) {
    const row = div('gantt-row');
    const color = colorForRoom(room.id);

    const side = div('gantt-room-sidebar');
    const name = div('gantt-room-name');
    const dot = document.createElement('span');
    dot.className = 'gantt-room-dot';
    dot.style.background = color;
    const label = document.createElement('span');
    label.textContent = room.name;
    name.append(dot, label);
    side.append(name, div('gantt-room-meta',
      [room.capacity ? `${room.capacity} seats` : '', room.location].filter(Boolean).join(' \u00b7 ')));

    const track = div('gantt-timeline-track' + (isHoliday ? ' is-holiday' : ''));
    const ranges = bookings.map((b) => [toMinutes(b.start), toMinutes(b.end)]);
    for (let i = 0; i < GANTT_SLOTS; i++) {
      const start = GANTT_START_MIN + i * SLOT_MINUTES;
      const end = start + SLOT_MINUTES;
      const slot = div('gantt-slot');
      slot.dataset.idx = String(i);
      if (ranges.some(([a, b]) => a < end && start < b)) {
        slot.classList.add('is-booked');
      } else if (isBackDated(ganttKey, start)) {
        slot.classList.add('is-past'); // not bookable (admins excepted)
      } else {
        slot.dataset.roomId = room.id;
        slot.dataset.start = minToTime(start);
        slot.title = `Book ${room.name}, ${minToTime(start)}\u2013${minToTime(end)}`;
      }
      track.appendChild(slot);
    }

    bookings.forEach((b) => {
      const from = Math.max(toMinutes(b.start), GANTT_START_MIN);
      const to = Math.min(toMinutes(b.end), GANTT_START_MIN + GANTT_TOTAL_MIN);
      if (to <= from) return; // entirely outside the window
      // Soft tinted block: --tone (the room colour) drives fill, border, accent stripe and text (see CSS).
      const block = div('gantt-booking-block');
      block.style.left = `${ganttPct(from)}%`;
      block.style.width = `${ganttPct(to) - ganttPct(from)}%`;
      block.style.setProperty('--tone', color);
      block.dataset.bookingId = b.id;
      block.title = bookingPill(b).title;

      const title = div('gantt-block-title');
      title.append(biIcon(b.recurrenceGroupId ? 'bi-arrow-repeat' : 'bi-calendar-event-fill'), div('gantt-block-text', b.title, 'span'));

      const sub = div('gantt-block-subtitle');
      sub.append(biIcon('bi-clock'), div('gantt-block-text', `${b.start}\u2013${b.end}`, 'span'));
      sub.append(isMine(b) ? div('gantt-you-badge', 'You', 'span') : div('gantt-block-text', b.bookerName, 'span'));

      block.append(title, sub);
      track.appendChild(block);
    });

    if (nowMin !== null && nowMin >= GANTT_START_MIN && nowMin <= GANTT_START_MIN + GANTT_TOTAL_MIN) {
      const marker = div('current-time-marker');
      marker.style.left = `${ganttPct(nowMin)}%`;
      track.appendChild(marker);
    }

    row.append(side, track);
    return row;
  }

  // Booking bars open their booking (delegated click; rows are rebuilt on each render).
  function onGanttClick(e) {
    const block = e.target.closest('.gantt-booking-block');
    if (!block) return;
    const entry = (bookingsMap.get(ganttKey) || []).find((b) => String(b.id) === block.dataset.bookingId);
    if (entry) openBookingModal(entry);
  }

  // Free slots: press, drag sideways, release. One slot (a plain click) books
  // 30 min; a drag books from the first to the last slot covered. The drag
  // can't pass over a booking — it stops at the last free slot before it —
  // so a selection is always one free, overlap-free range in one room.
  let ganttDrag = null; // { track, roomId, anchor, lo, hi }

  const slotAt = (track, clientX) => {
    const r = track.getBoundingClientRect();
    const i = Math.floor(((clientX - r.left) / r.width) * GANTT_SLOTS);
    return Math.min(Math.max(i, 0), GANTT_SLOTS - 1);
  };
  const slotFree = (track, i) => !track.children[i].matches('.is-booked, .is-past');

  function paintGanttSelection() {
    const { track, lo, hi } = ganttDrag;
    for (let i = 0; i < GANTT_SLOTS; i++) track.children[i].classList.toggle('is-selecting', i >= lo && i <= hi);
  }

  function onGanttPointerDown(e) {
    const slot = e.target.closest('.gantt-slot');
    if (!slot || !slot.dataset.start || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const anchor = Number(slot.dataset.idx);
    ganttDrag = { track: slot.parentElement, roomId: slot.dataset.roomId, anchor, lo: anchor, hi: anchor };
    paintGanttSelection();
    document.addEventListener('pointermove', onGanttPointerMove);
    document.addEventListener('pointerup', onGanttPointerUp);
    document.addEventListener('pointercancel', endGanttDrag);
  }

  function onGanttPointerMove(e) {
    if (!ganttDrag) return;
    const { track, anchor } = ganttDrag;
    const target = slotAt(track, e.clientX);
    let lo = anchor;
    let hi = anchor;
    // grow toward the pointer, one free slot at a time
    for (let i = anchor + 1; i <= target && slotFree(track, i); i++) hi = i;
    for (let i = anchor - 1; i >= target && slotFree(track, i); i--) lo = i;
    if (lo !== ganttDrag.lo || hi !== ganttDrag.hi) {
      ganttDrag.lo = lo;
      ganttDrag.hi = hi;
      paintGanttSelection();
    }
  }

  function endGanttDrag() {
    if (ganttDrag) {
      const { track } = ganttDrag;
      for (let i = 0; i < GANTT_SLOTS; i++) track.children[i].classList.remove('is-selecting');
    }
    ganttDrag = null;
    document.removeEventListener('pointermove', onGanttPointerMove);
    document.removeEventListener('pointerup', onGanttPointerUp);
    document.removeEventListener('pointercancel', endGanttDrag);
  }

  function onGanttPointerUp() {
    const sel = ganttDrag;
    endGanttDrag();
    if (!sel) return;
    openBookingModal(null, ganttKey, {
      roomId: sel.roomId,
      start: minToTime(GANTT_START_MIN + sel.lo * SLOT_MINUTES),
      end: minToTime(GANTT_START_MIN + (sel.hi + 1) * SLOT_MINUTES)
    });
  }

  /* ------------------------------------------------------------------ */
  /* Room booking: recurrence (pure date logic, no DOM / Supabase)        */
  /*                                                                      */
  /* Works on local-midnight Date objects and 'yyyy-mm-dd' keys. A booking*/
  /* is date + time-of-day, so every occurrence keeps its times and only  */
  /* the date moves — nothing here can drift with DST.                    */
  /*                                                                      */
  /* A booking is a BLOCK: From..To (one day when they are equal), same   */
  /* time every day. "Repeats" repeats the whole block.                   */
  /*                                                                      */
  /* Flow in submitBookingCreate():                                       */
  /*   expandBlocks()      the block + its repeats up to the end date     */
  /*   applyAdjustments()  days off / holidays shifted, half days trimmed */
  /* ------------------------------------------------------------------ */
  const MAX_OCCURRENCES = 366;
  const RECURRENCE_RULES = ['daily', 'weekly', 'monthly', 'yearly'];
  const RECURRENCE_LABELS = {
    daily: 'Repeats daily',
    weekly: 'Repeats weekly',
    monthly: 'Repeats monthly',
    yearly: 'Repeats yearly'
  };
  // A half working day (policy_weekly_working_days.working_value = 0.5) is
  // morning-only: nothing may run past this time.
  const HALF_DAY_END = '12:00';
  // Same as the seed in 03_policies_schemas.sql — only used if the weekly
  // pattern couldn't be loaded.
  const DEFAULT_WORKING_VALUES = new Map([[1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [6, 0], [7, 0]]);

  const recurrenceLabel = (rule) => RECURRENCE_LABELS[rule] || '';
  const toDateKey = (d) => dateKey(d.getFullYear(), d.getMonth(), d.getDate());

  /** 'Alice, Bob ,, Carol' -> ['Alice', 'Bob', 'Carol'] */
  function parseInvitees(text) {
    return (text || '').split(',').map((s) => s.trim()).filter(Boolean);
  }

  function addDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
  }

  // Whole days from a to b (both local-midnight), safe across DST changes.
  const daysBetween = (a, b) => Math.round((b - a) / 86400000);

  // Jan 31 + 1 month -> Feb 28/29 (clamped), not Mar 3. Years reuse this
  // (Feb 29 -> Feb 28 on non-leap years).
  function addMonthsClamped(date, months) {
    const d = new Date(date.getFullYear(), date.getMonth() + months, 1);
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(date.getDate(), lastDay));
    return d;
  }

  // Start date of the n-th repeat of a block starting on `from`. Always
  // computed from the ORIGINAL start (never from the previous repeat), so a
  // "31st of the month" series clamps to Feb 28 and then returns to the 31st.
  function repeatStart(from, rule, n) {
    if (rule === 'daily') return addDays(from, n);
    if (rule === 'weekly') return addDays(from, n * 7);
    if (rule === 'monthly') return addMonthsClamped(from, n);
    return addMonthsClamped(from, n * 12);
  }

  /**
   * Whether a From..To block can repeat by `rule` without the next repeat
   * overlapping it: the block must end before the next repeat starts.
   *   one day            -> daily, weekly, monthly, yearly
   *   2-7 days           -> weekly (Mon..Wed every week), monthly, yearly
   *   over a week        -> monthly (12th..18th every month), yearly
   *   about a month+     -> yearly
   */
  function ruleFitsRange(rule, fromKey, toKey) {
    const from = parseDateOnly(fromKey);
    return parseDateOnly(toKey) < repeatStart(from, rule, 1);
  }

  /**
   * The blocks of a booking: From..To itself plus each repeat up to
   * `untilKey` (a repeat is included whole when it STARTS on or before that
   * date). `rule` is 'none' or one of RECURRENCE_RULES.
   *
   * `truncated` is true when the MAX_OCCURRENCES cap (total days) cut the
   * booking short, so the caller can warn instead of silently under-booking.
   */
  function expandBlocks(fromKey, toKey, rule, untilKey) {
    const from = parseDateOnly(fromKey);
    const span = daysBetween(from, parseDateOnly(toKey)) + 1;
    const repeating = RECURRENCE_RULES.includes(rule);
    const until = repeating ? parseDateOnly(untilKey) : null;

    const blocks = [];
    let total = 0;
    let truncated = false;
    for (let n = 0; n <= MAX_OCCURRENCES; n++) {
      const start = n === 0 ? from : repeatStart(from, rule, n);
      if (n > 0 && start > until) break;
      let len = span;
      if (total + len > MAX_OCCURRENCES) { len = MAX_OCCURRENCES - total; truncated = true; }
      if (len > 0) blocks.push({ from: start, to: addDays(start, len - 1) });
      total += len;
      if (truncated || !repeating) break;
    }
    return { blocks, truncated };
  }

  // Working value (0 day off / 0.5 half day / 1 full day) of a date, from
  // policy_weekly_working_days (isodow 1 = Mon .. 7 = Sun). Falls back to the
  // seeded Mon-Fri pattern if the table couldn't be loaded.
  function bookingWorkingValue(date) {
    const pattern = workingValues || DEFAULT_WORKING_VALUES;
    const isodow = date.getDay() === 0 ? 7 : date.getDay();
    return pattern.has(isodow) ? pattern.get(isodow) : 0;
  }

  /**
   * Applies the "ignore" rules to every day of every block and returns
   * [{ date, start, end, trimmed }] sorted by date.
   *
   *   public holiday            -> blocked
   *   day off      (value 0)    -> blocked            (ignoreDaysOff)
   *   half day     (value 0.5)  -> morning only: `end` is cut back to 12:00;
   *                                if `start` is already 12:00 or later there
   *                                is no morning left, so the day is blocked
   *
   * A blocked day moves to the nearest allowed day — `direction` 'backward'
   * (earlier, default) or 'forward' (later). Inside a multi-day block it can
   * only move within that block (a Saturday in a Mon-Sun range is skipped, it
   * never becomes a booking before the From date); a single-day block may move
   * up to two weeks. With no allowed day the occurrence is dropped rather than
   * booked on a day off. Two days landing on the same date collapse into one
   * instead of double-booking. `trimmed` is true when `end` was cut to 12:00.
   *
   * options: { ignoreDaysOff, holidaySet (Set of 'yyyy-mm-dd' or null), direction }
   */
  function applyAdjustments(blocks, start, end, options) {
    const { ignoreDaysOff, holidaySet, direction } = options;
    const step = direction === 'forward' ? 1 : -1;

    const isBlocked = (d) => {
      if (holidaySet && holidaySet.has(toDateKey(d))) return true;
      if (!ignoreDaysOff) return false;
      const w = bookingWorkingValue(d);
      return w <= 0 || (w < 1 && start >= HALF_DAY_END);
    };

    const seen = new Set();
    const out = [];
    blocks.forEach((block) => {
      const bounded = block.to > block.from;
      for (let day = new Date(block.from); day <= block.to; day = addDays(day, 1)) {
        let d = new Date(day);
        let ok = true;
        for (let guard = 0; guard < 14 && isBlocked(d); guard++) {
          d = addDays(d, step);
          if (bounded && (d < block.from || d > block.to)) { ok = false; break; }
        }
        if (!ok || isBlocked(d)) continue;

        const key = toDateKey(d);
        if (seen.has(key)) continue;
        seen.add(key);

        let occEnd = end;
        let trimmed = false;
        if (ignoreDaysOff) {
          const w = bookingWorkingValue(d);
          if (w > 0 && w < 1 && end > HALF_DAY_END) { occEnd = HALF_DAY_END; trimmed = true; }
        }
        out.push({ date: d, start, end: occEnd, trimmed });
      }
    });
    return out.sort((x, y) => x.date - y.date);
  }

  /* ------------------------------------------------------------------ */
  /* Room booking: create / edit / view / delete                          */
  /* ------------------------------------------------------------------ */
  const BOOKING_FIELDS = ['#bookingRoomInput', '#bookingDateInput', '#bookingDateToInput', '#bookingStartInput',
    '#bookingEndInput', '#bookingTitleInput', '#bookingInviteesToggle', '#bookingInviteesInput', '#bookingNotesInput'];

  // Comma-separated invitee text -> chips (built with textContent, so names stay inert).
  function renderInviteeChips(text) {
    const wrap = $('#bookingInviteePreview');
    wrap.replaceChildren(...parseInvitees(text).map((name) => {
      const chip = document.createElement('span');
      chip.className = 'invitee-tag-chip';
      const icon = document.createElement('i');
      icon.className = 'bi bi-person';
      chip.append(icon, name);
      return chip;
    }));
  }

  // Invitees are optional: the input (and chip preview) only shows while the switch is on.
  function setInviteesEnabled(on) {
    $('#bookingInviteesToggle').checked = on;
    $('#bookingInviteesBody').classList.toggle('hidden', !on);
  }

  // "1h 30m" chip next to the End field; flags an end that isn't after the start.
  function updateBookingDuration() {
    const chip = $('#bookingDurationChip');
    const start = $('#bookingStartInput').value;
    const end = $('#bookingEndInput').value;
    chip.classList.remove('is-invalid');
    if (!start || !end) { chip.classList.add('hidden'); return; }
    const diff = toMinutes(end) - toMinutes(start);
    chip.classList.remove('hidden');
    if (diff > 0) {
      const h = Math.floor(diff / 60);
      const m = diff % 60;
      chip.innerHTML = `<i class="bi bi-hourglass-split"></i>${h > 0 ? `${h}h ${m > 0 ? m + 'm' : '00m'}` : `${m}m`}`;
    } else {
      chip.classList.add('is-invalid');
      chip.innerHTML = '<i class="bi bi-exclamation-circle"></i>Invalid end';
    }
  }

  /* ---- From / To  ->  which "Repeats" options make sense ---- */
  const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const monthShort = (m) => MONTHS[m].slice(0, 3);
  function ordinal(n) {
    const v = n % 100;
    if (v >= 11 && v <= 13) return `${n}th`;
    return `${n}${['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
  }
  const formatBookingDay = (d) =>
    d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

  // Option text. A single day keeps plain names; a range says what repeats:
  // "Weekly (Mon \u2192 Wed)", "Monthly (12th \u2192 18th)", "Yearly (Oct 12 \u2192 Oct 18)".
  function repeatOptionLabel(rule, from, to) {
    if (!from || !to || to <= from) return { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' }[rule];
    if (rule === 'weekly') return `Weekly (${WEEKDAY_SHORT[from.getDay()]} \u2192 ${WEEKDAY_SHORT[to.getDay()]})`;
    if (rule === 'monthly') return `Monthly (${ordinal(from.getDate())} \u2192 ${ordinal(to.getDate())})`;
    if (rule === 'yearly') {
      return `Yearly (${monthShort(from.getMonth())} ${from.getDate()} \u2192 ${monthShort(to.getMonth())} ${to.getDate()})`;
    }
    return 'Daily';
  }

  // Rebuilds the "Repeats" list for the current From/To: only rules whose
  // period is longer than the block are offered. Keeps the current choice if
  // it is still valid, otherwise falls back to "Does not repeat".
  function refreshRepeatOptions(reset) {
    const sel = $('#bookingRepeatSelect');
    const fromKey = $('#bookingDateInput').value;
    const toKey = $('#bookingDateToInput').value || fromKey;
    const previous = reset ? 'none' : sel.value;
    const valid = !!fromKey && toKey >= fromKey;
    const from = valid ? parseDateOnly(fromKey) : null;
    const to = valid ? parseDateOnly(toKey) : null;

    const rules = valid ? RECURRENCE_RULES.filter((r) => ruleFitsRange(r, fromKey, toKey)) : RECURRENCE_RULES;
    sel.replaceChildren(...[['none', 'Does not repeat'], ...rules.map((r) => [r, repeatOptionLabel(r, from, to)])]
      .map(([value, text]) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = text;
        return opt;
      }));
    sel.value = $$('option', sel).some((o) => o.value === previous) ? previous : 'none';
    updateRepeatUI();
  }

  // Shows what the current From/To + Repeats choice will do: the range hint,
  // the "Repeat until" field (only when repeating) and the ignore rules (when
  // there is a range or a repeat — anything that produces more than one day).
  function updateRepeatUI() {
    const fromKey = $('#bookingDateInput').value;
    const toKey = $('#bookingDateToInput').value || fromKey;
    const ranged = !!fromKey && toKey > fromKey;
    const rule = $('#bookingRepeatSelect').value;
    const repeating = rule !== 'none';

    $('#bookingRepeatFields').classList.toggle('hidden', !ranged && !repeating);
    // Repeat until is always visible but only usable once a repeat is chosen.
    const untilInput = $('#bookingRepeatUntil');
    untilInput.disabled = !repeating;
    if (!repeating) untilInput.value = '';

    const hint = $('#bookingRangeHint');
    hint.classList.toggle('hidden', !ranged);
    if (ranged) {
      const from = parseDateOnly(fromKey);
      const to = parseDateOnly(toKey);
      const days = daysBetween(from, to) + 1;
      hint.textContent = `${formatBookingDay(from)} \u2192 ${formatBookingDay(to)}: ${days} days, one booking per day at the same time.`
        + (repeating ? ' Each repeat books the same block again.' : '');
    }
  }

  // From/To changed. To never goes before From, and while To equals From it
  // keeps following From, so moving a one-day booking doesn't turn it into a range.
  let dateToFollowsFrom = true;
  function onBookingDatesChanged(source) {
    const from = $('#bookingDateInput');
    const to = $('#bookingDateToInput');
    if (source === 'from') {
      if (dateToFollowsFrom || !to.value || to.value < from.value) to.value = from.value;
    } else {
      if (to.value && to.value < from.value) to.value = from.value;
      dateToFollowsFrom = to.value === from.value;
    }
    to.min = from.value;
    const until = $('#bookingRepeatUntil');
    until.min = to.value || from.value;
    if (until.value && until.value < until.min) until.value = until.min;
    refreshRepeatOptions(false);
  }

  // Next full hour when booking today, otherwise 8:00 — one hour long.
  function suggestedTimes(key) {
    const now = new Date();
    const isToday = key === dateKey(now.getFullYear(), now.getMonth(), now.getDate());
    const h = Math.min(Math.max(isToday ? now.getHours() + 1 : 8, 0), 22);
    return { start: `${pad2(h)}:00`, end: `${pad2(h + 1)}:00` };
  }

  // "Thursday, 1 Oct 2026, 09:00\u201310:00 \u2014 clashes with \u201cTitle\u201d (09:30\u201311:00)" (escaped HTML)
  const conflictLine = (c) =>
    `${escapeHtml(formatDateLong(c.occ.date))}, ${c.occ.start}\u2013${c.occ.end} \u2014 clashes with \u201c${escapeHtml(c.existing.title)}\u201d (${hhmm(c.existing.start_time)}\u2013${hhmm(c.existing.end_time)})`;

  function showBookingConflicts(conflicts) {
    const box = $('#bookingConflictAlert');
    const items = conflicts.slice(0, 8).map((c) => `<li>${conflictLine(c)}</li>`);
    if (conflicts.length > 8) items.push(`<li>\u2026and ${conflicts.length - 8} more</li>`);
    $('#bookingConflictBody').innerHTML = `<strong>This room is already booked at that time.</strong><ul>${items.join('')}</ul>`;
    box.classList.remove('hidden');
    box.scrollIntoView({ block: 'nearest' });
  }
  const hideBookingConflicts = () => $('#bookingConflictAlert').classList.add('hidden');

  // occs = [{ date, start, end }]. Returns the ones that overlap an existing
  // booking in that room (half-open ranges, so back-to-back is fine).
  // This is the friendly pre-check; the room_bookings exclusion constraint
  // remains the actual guard against races.
  async function findBookingConflicts(roomId, occs, excludeId) {
    const dates = occs.map((o) => o.date).sort();
    const { data, error } = await db.from('room_bookings')
      .select('id, title, booking_date, start_time, end_time')
      .eq('room_id', roomId)
      .gte('booking_date', dates[0])
      .lte('booking_date', dates[dates.length - 1]);
    if (error) throw error;
    const existing = (data || []).filter((b) => b.id !== excludeId);
    const out = [];
    occs.forEach((occ) => {
      const hit = existing.find((b) => b.booking_date === occ.date
        && hhmm(b.start_time) < occ.end && occ.start < hhmm(b.end_time));
      if (hit) out.push({ occ, existing: hit });
    });
    return out;
  }

  // Admins can change any booking; everyone else only their own (RLS enforces the same).
  function canManageBooking(b) {
    return isAdmin || (!!myUserId && b.bookedBy === myUserId);
  }

  // entry = existing bookingsMap entry (edit / read-only view) or null (new,
  // prefilled with prefillDate). prefill = optional { roomId, start, end }
  // for a new booking (the Gantt view's clicked slot).
  function openBookingModal(entry, prefillDate, prefill) {
    const rooms = Array.from(roomsMap.values())
      .filter((r) => r.is_active || (entry && r.id === entry.roomId));
    if (!rooms.length) {
      toast(isAdmin ? 'No rooms yet \u2014 add one with \u201cManage rooms\u201d.' : 'No rooms are available yet. Ask an admin to add one.', 'danger');
      return;
    }

    editingBooking = entry || null;
    const editable = !entry || canManageBooking(entry);
    const [titleIcon, titleText] = !entry ? ['bi-calendar2-plus-fill', 'New booking']
      : editable ? ['bi-pencil-square', 'Edit booking'] : ['bi-eye', 'Booking details'];
    $('#bookingModalTitle').innerHTML = `<i class="bi ${titleIcon}"></i>${titleText}`;

    const sel = $('#bookingRoomInput');
    sel.innerHTML = '';
    rooms.forEach((r) => {
      const opt = document.createElement('option');
      opt.value = String(r.id);
      const label = r.capacity ? `${r.name} (Capacity: ${r.capacity})` : r.name;
      opt.textContent = r.is_active ? label : `${label} (inactive)`;
      sel.appendChild(opt);
    });
    const wantedRoom = entry ? String(entry.roomId) : String(prefill?.roomId ?? roomFilter);
    sel.value = $$('option', sel).some((o) => o.value === wantedRoom) ? wantedRoom : sel.options[0].value;

    const suggested = prefill?.start ? prefill : suggestedTimes(prefillDate || '');
    $('#bookingDateInput').value = entry ? entry.date : (prefillDate || '');
    $('#bookingDateToInput').value = $('#bookingDateInput').value;
    $('#bookingDateInput').min = !entry && !isAdmin ? toDateKey(new Date()) : ''; // no back-dating for non-admins
    $('#bookingDateToInput').min = $('#bookingDateInput').value;
    dateToFollowsFrom = true;
    // Editing changes one occurrence: a single "Date", no To.
    $('#bookingDateToWrap').classList.toggle('hidden', !!entry);
    $('#bookingDateLabelText').textContent = entry ? 'Date' : 'From';
    $('#bookingStartInput').value = entry ? entry.start : suggested.start;
    $('#bookingEndInput').value = entry ? entry.end : suggested.end;
    $('#bookingTitleInput').value = entry ? entry.title : '';
    $('#bookingInviteesInput').value = entry ? entry.invitees || '' : '';
    $('#bookingNotesInput').value = entry ? entry.notes || '' : '';
    renderInviteeChips(entry ? entry.invitees : '');
    setInviteesEnabled(!!(entry && entry.invitees));
    updateBookingDuration();
    hideBookingConflicts();

    // Recurrence setup is for new bookings only; an existing occurrence just gets a note.
    $('#bookingRecurrenceGroup').classList.toggle('hidden', !!entry);
    $('#bookingRepeatUntil').value = '';
    $('#bookingRepeatUntil').min = $('#bookingDateInput').value;
    $('#bookingIgnoreDayOff').checked = true;
    $('#bookingIgnoreHoliday').checked = true;
    $('#bookingDirBackward').checked = true;
    refreshRepeatOptions(true);
    const note = $('#bookingRecurrenceNote');
    const inSeries = !!(entry && entry.recurrenceGroupId);
    note.classList.toggle('hidden', !inSeries);
    if (inSeries) {
      $('#bookingRecurrenceNoteText').textContent = `Part of a recurring series (${recurrenceLabel(entry.recurrenceRule).toLowerCase()}).`
        + (editable ? ' Editing only changes this date.' : '');
    }

    const owner = $('#bookingOwnerLine');
    owner.classList.toggle('hidden', !entry);
    if (entry) $('#bookingOwnerText').textContent = `Booked by ${bookerLabel(entry).replace(/^You$/, 'you')}`;

    BOOKING_FIELDS.forEach((f) => { $(f).disabled = !editable; });
    $('#bookingSubmitBtn').classList.toggle('hidden', !editable);
    $('#bookingDeleteBtn').classList.toggle('hidden', !entry || !editable);
    bookingModal.show();
  }

  // update/delete blocked by RLS affect 0 rows without raising an error,
  // so callers pass `.select('id')` and we treat an empty result as a failure.
  const noRowsError = () => ({ message: 'Nothing was changed \u2014 you may not have permission, or the booking no longer exists.' });

  async function onSubmitBooking(e) {
    e.preventDefault();
    hideBookingConflicts();
    const base = {
      room_id: Number($('#bookingRoomInput').value),
      booking_date: $('#bookingDateInput').value,
      start_time: $('#bookingStartInput').value,
      end_time: $('#bookingEndInput').value,
      title: $('#bookingTitleInput').value.trim(),
      notes: $('#bookingNotesInput').value.trim() || null,
      // switch off = no invitees (the typed text is kept in the field in case it is switched back on)
      invitees: $('#bookingInviteesToggle').checked
        ? parseInvitees($('#bookingInviteesInput').value).join(', ') || null
        : null
    };
    if (!base.room_id || !base.booking_date || !base.start_time || !base.end_time || !base.title) {
      toast('Please fill in the room, date, time and title.', 'danger');
      return;
    }
    if (base.end_time <= base.start_time) {
      toast(ERROR_TEXT.booking['23514'], 'danger');
      return;
    }
    // To date (new bookings only; an edit is always one date).
    const dateTo = editingBooking ? base.booking_date : ($('#bookingDateToInput').value || base.booking_date);
    if (dateTo < base.booking_date) {
      toast('The \u201cTo\u201d date can\u2019t be before the \u201cFrom\u201d date.', 'danger');
      return;
    }
    // No booking into the past (5 min grace) except for admins. When editing, only if the date/time was actually moved.
    const moved = !editingBooking
      || base.booking_date !== editingBooking.date || base.start_time !== editingBooking.start;
    if (moved && isBackDated(base.booking_date, toMinutes(base.start_time))) {
      toast('Only admins can book a time in the past.', 'danger');
      return;
    }

    const submitBtn = $('#bookingSubmitBtn');
    submitBtn.disabled = true;
    try {
      if (editingBooking) await submitBookingEdit(base);
      else await submitBookingCreate(base, dateTo);
    } catch (err) {
      toast(errorMessage(err, 'booking'), 'danger');
    } finally {
      submitBtn.disabled = false;
    }
  }

  async function afterBookingSaved(message) {
    toast(message, 'success');
    bookingModal.hide();
    try { await loadBookingsForView(); } catch (err) { reportLoadError(err); }
  }

  // Edit = this one date/row only (the series link is frozen in the DB too).
  async function submitBookingEdit(base) {
    const conflicts = await findBookingConflicts(
      base.room_id, [{ date: base.booking_date, start: base.start_time, end: base.end_time }], editingBooking.id);
    if (conflicts.length) { showBookingConflicts(conflicts); return; }

    const { data, error } = await db.from('room_bookings').update(base).eq('id', editingBooking.id).select('id');
    if (!error && (!data || !data.length)) throw noRowsError();
    if (error) throw error;
    await afterBookingSaved('Booking updated.');
  }

  async function submitBookingCreate(base, dateTo) {
    const rule = $('#bookingRepeatSelect').value;
    const ranged = dateTo > base.booking_date;
    let occs;                 // [{ date, start, end, trimmed }] — times can differ per date (half days)
    let truncated = false;

    if (!ranged && rule === 'none') {
      // One plain booking: taken exactly as entered, no ignore rules.
      occs = [{ date: base.booking_date, start: base.start_time, end: base.end_time, trimmed: false }];
    } else {
      // A From..To range is a daily series; "Repeats" repeats that block.
      let until = null;
      if (rule !== 'none') {
        until = $('#bookingRepeatUntil').value;
        if (!until) { toast('Please choose an end date for the repeat.', 'danger'); return; }
        if (until < dateTo) { toast('The repeat end date can\u2019t be before the booking\u2019s \u201cTo\u201d date.', 'danger'); return; }
      }

      // Days off / half days come from the Policies page weekly pattern.
      if (!workingValues) await loadWorkingPattern();

      let blocks;
      ({ blocks, truncated } = expandBlocks(base.booking_date, dateTo, rule, until));
      // holidaysMap holds every holiday (loadHolidays() fetches the whole table), so no extra query.
      occs = applyAdjustments(blocks, base.start_time, base.end_time, {
        ignoreDaysOff: $('#bookingIgnoreDayOff').checked,
        holidaySet: $('#bookingIgnoreHoliday').checked ? new Set(holidaysMap.keys()) : null,
        direction: ($('input[name="bookingRepeatDirection"]:checked') || {}).value || 'backward'
      }).map((o) => ({ date: toDateKey(o.date), start: o.start, end: o.end, trimmed: o.trimmed }));

      if (!occs.length) {
        toast('No bookable dates in that range \u2014 every date falls on a day off or public holiday.', 'danger');
        return;
      }
    }

    let conflicts = await findBookingConflicts(base.room_id, occs, null);
    let skipped = 0;
    if (conflicts.length && occs.length > 1 && conflicts.length < occs.length) {
      // A series with some clashing dates: offer to skip just those and book the rest.
      const room = roomsMap.get(base.room_id);
      const keep = occs.length - conflicts.length;
      const skip = await showConfirmDialog({
        title: 'Some dates overlap',
        message: `${conflicts.length} of ${occs.length} dates ${conflicts.length === 1 ? 'is' : 'are'} already booked in ${escapeHtml(room ? room.name : 'this room')}. Skip ${conflicts.length === 1 ? 'that date' : 'those dates'} and book the other ${keep}?`,
        detailsHtml: `<ul class="confirm-conflict-list">${conflicts.map((c) => `<li>${conflictLine(c)}</li>`).join('')}</ul>`,
        confirmLabel: 'Yes, skip & book rest',
        cancelLabel: 'No'
      });
      if (!skip) { showBookingConflicts(conflicts); return; }
      const clash = new Set(conflicts.map((c) => c.occ.date));
      occs = occs.filter((o) => !clash.has(o.date));
      skipped = conflicts.length;
      conflicts = [];
    }
    if (conflicts.length) { showBookingConflicts(conflicts); return; }

    const groupId = occs.length > 1 ? crypto.randomUUID() : null;
    const rows = occs.map((occ) => ({
      ...base,
      booking_date: occ.date,
      start_time: occ.start,
      end_time: occ.end,
      booker_name: myName || (isAdmin ? 'Admin' : 'Unknown'), // booked_by defaults to auth.uid() in the table
      recurrence_group_id: groupId,
      // a From..To range with no repeat is a daily series
      recurrence_rule: groupId ? (rule === 'none' ? 'daily' : rule) : null
    }));

    // One bulk INSERT = one statement: the whole series is saved, or none of it.
    const { error } = await db.from('room_bookings').insert(rows);
    if (error) throw error;

    if (truncated) {
      toast(`The repeat was capped at ${MAX_OCCURRENCES} occurrences. Use an earlier end date to cover a shorter range.`);
    }
    const trimmedCount = occs.filter((o) => o.trimmed).length;
    let message = rows.length > 1 ? `Booked ${rows.length} occurrences.` : 'Room booked.';
    if (skipped) message += ` Skipped ${skipped} overlapping ${skipped === 1 ? 'date' : 'dates'}.`;
    if (trimmedCount) {
      message += ` ${trimmedCount} on half ${trimmedCount === 1 ? 'day was' : 'days were'} shortened to end at ${HALF_DAY_END}.`;
    }
    await afterBookingSaved(message);
  }

  // Single booking: plain confirm. Part of a series: choose this date, this
  // + all following, or the whole series. All three are one filtered DELETE,
  // covered by the same owner-or-admin RLS policy.
  async function onDeleteBookingClick() {
    if (!editingBooking) return;
    const b = editingBooking;
    let scope = 'one';

    if (b.recurrenceGroupId) {
      scope = await showConfirmDialog({
        title: 'Delete booking',
        message: `\u201c${escapeHtml(b.title)}\u201d is part of a recurring series (${escapeHtml(recurrenceLabel(b.recurrenceRule).toLowerCase())}). What would you like to delete?`,
        confirmLabel: 'Delete',
        danger: true,
        choices: [
          { value: 'one', label: 'Just this occurrence', hint: formatDateLong(b.date) },
          { value: 'following', label: 'This and all following', hint: `From ${formatDateLong(b.date)} onward` },
          { value: 'series', label: 'The entire series', hint: 'Removes every date in this recurring booking' }
        ]
      });
      if (!scope) return;
    } else {
      const ok = await showConfirmDialog({
        title: 'Delete booking',
        message: `Delete \u201c${escapeHtml(b.title)}\u201d in ${escapeHtml(b.roomName)} on ${escapeHtml(formatDateLong(b.date))} (${b.start}\u2013${b.end})?`,
        confirmLabel: 'Delete booking',
        danger: true
      });
      if (!ok) return;
    }

    let q = db.from('room_bookings').delete();
    if (scope === 'one') q = q.eq('id', b.id);
    else if (scope === 'following') q = q.eq('recurrence_group_id', b.recurrenceGroupId).gte('booking_date', b.date);
    else q = q.eq('recurrence_group_id', b.recurrenceGroupId);

    const { data, error } = await q.select('id');
    if (error || !data || !data.length) { toast(errorMessage(error || noRowsError(), 'booking'), 'danger'); return; }

    await afterBookingSaved(scope === 'one' ? 'Booking deleted.' : `Deleted ${data.length} bookings.`);
  }

  /* ------------------------------------------------------------------ */
  /* Rooms manager (admin only)                                           */
  /* ------------------------------------------------------------------ */
  function resetRoomForm() {
    editingRoomId = null;
    $('#roomForm').reset();
    $('#roomActiveInput').checked = true;
    $('#roomFormTitle').textContent = 'Add room';
    $('#roomSubmitBtn').textContent = 'Add room';
    $('#roomFormCancelBtn').classList.add('hidden');
  }

  function editRoom(room) {
    editingRoomId = room.id;
    $('#roomNameInput').value = room.name;
    $('#roomLocationInput').value = room.location || '';
    $('#roomCapacityInput').value = room.capacity ?? '';
    $('#roomActiveInput').checked = !!room.is_active;
    $('#roomFormTitle').textContent = `Edit ${room.name}`;
    $('#roomSubmitBtn').textContent = 'Save room';
    $('#roomFormCancelBtn').classList.remove('hidden');
    $('#roomNameInput').focus();
  }

  function renderRoomsList() {
    const list = $('#roomsList');
    const fragment = document.createDocumentFragment();
    roomsMap.forEach((room) => {
      const row = document.createElement('div');
      row.className = 'rooms-row' + (room.is_active ? '' : ' is-inactive');

      const swatch = document.createElement('span');
      swatch.className = 'rooms-swatch';
      swatch.style.background = colorForRoom(room.id);

      const info = document.createElement('div');
      info.className = 'rooms-info';
      const name = document.createElement('span');
      name.className = 'rooms-name';
      name.textContent = room.name;
      const meta = document.createElement('span');
      meta.className = 'rooms-meta';
      meta.textContent = [
        room.location || 'No location',
        room.capacity ? `${room.capacity} seats` : 'Capacity not set',
        room.is_active ? null : 'Inactive'
      ].filter(Boolean).join(' \u00b7 ');
      info.append(name, meta);

      const actions = document.createElement('div');
      actions.className = 'rooms-actions';
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'btn-icon-only';
      edit.title = 'Edit room';
      edit.setAttribute('aria-label', `Edit ${room.name}`);
      edit.innerHTML = editIconSvg();
      edit.addEventListener('click', () => editRoom(room));
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn-icon-only';
      del.title = 'Delete room';
      del.setAttribute('aria-label', `Delete ${room.name}`);
      del.innerHTML = trashIconSvg();
      del.addEventListener('click', () => onDeleteRoomClick(room));
      actions.append(edit, del);

      row.append(swatch, info, actions);
      fragment.appendChild(row);
    });
    list.replaceChildren(fragment);
  }

  function openRoomsModal() {
    resetRoomForm();
    renderRoomsList();
    roomsModal.show();
  }

  // Reload rooms (filter, legend, modal list) and the visible bookings after any room change.
  async function afterRoomsChanged() {
    await loadRooms();
    renderRoomsList();
    try { await loadBookingsForView(); } catch (err) { reportLoadError(err); }
  }

  async function onSubmitRoom(e) {
    e.preventDefault();
    const capacity = $('#roomCapacityInput').value.trim();
    const payload = {
      name: $('#roomNameInput').value.trim(),
      location: $('#roomLocationInput').value.trim() || null,
      capacity: capacity === '' ? null : Number(capacity),
      is_active: $('#roomActiveInput').checked
    };
    if (!payload.name) { toast('Please enter a room name.', 'danger'); return; }

    const submitBtn = $('#roomSubmitBtn');
    submitBtn.disabled = true;
    let error;
    const wasEditing = !!editingRoomId;
    if (wasEditing) {
      let data;
      ({ data, error } = await db.from('rooms').update(payload).eq('id', editingRoomId).select('id'));
      if (!error && (!data || !data.length)) error = noRowsError();
    } else {
      ({ error } = await db.from('rooms').insert(payload));
    }
    submitBtn.disabled = false;

    if (error) { toast(errorMessage(error, 'room'), 'danger'); return; }
    toast(wasEditing ? 'Room updated.' : 'Room added.', 'success');
    resetRoomForm();
    await afterRoomsChanged();
  }

  async function onDeleteRoomClick(room) {
    const ok = await showConfirmDialog({
      title: 'Delete room',
      message: `Delete \u201c${escapeHtml(room.name)}\u201d? <strong>All bookings for this room will be deleted too.</strong> To keep the history, untick \u201cActive\u201d instead.`,
      confirmLabel: 'Delete room',
      danger: true
    });
    if (!ok) return;

    let { data, error } = await db.from('rooms').delete().eq('id', room.id).select('id');
    if (!error && (!data || !data.length)) error = noRowsError();
    if (error) { toast(errorMessage(error, 'room'), 'danger'); return; }

    toast('Room deleted.', 'success');
    if (editingRoomId === room.id) resetRoomForm();
    await afterRoomsChanged();
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
    bookingModal = new bootstrap.Modal($('#roomBookingModal'));
    roomsModal = new bootstrap.Modal($('#roomsModal'));

    // Hand off to the new-request / new-booking form (by mode), prefilled
    // with the date the day view was showing. Waits for the day modal to
    // fully close first (hidden.bs.modal) so the two Bootstrap
    // modals/backdrops don't stack on top of each other.
    $('#dayLeaveNewRequestBtn').addEventListener('click', () => {
      const key = dayLeaveModalKey;
      $('#dayLeaveModal').addEventListener('hidden.bs.modal', () => addForDate(key), { once: true });
      dayLeaveModal.hide();
    });

    // Clicking a record in the day view drills into its detail (leave detail,
    // or the booking form — editable for owner/admin, read-only otherwise) —
    // same hide-then-show handoff as the button above. Delegated on the list
    // container since rows are rebuilt on every day-view open.
    $('#dayLeaveModalBody').addEventListener('click', (e) => {
      const row = e.target.closest('.day-leave-item');
      if (!row) return;
      const entries = (mode === 'room' ? bookingsMap : leavesMap).get(dayLeaveModalKey) || [];
      const entry = entries[Number(row.dataset.index)];
      if (!entry) return;
      const open = mode === 'room' ? () => openBookingModal(entry) : () => openLeaveDetailModal(entry);
      $('#dayLeaveModal').addEventListener('hidden.bs.modal', open, { once: true });
      dayLeaveModal.hide();
    });

    $('#roomBookingForm').addEventListener('submit', onSubmitBooking);
    $('#bookingDeleteBtn').addEventListener('click', onDeleteBookingClick);
    $('#bookingInviteesInput').addEventListener('input', (e) => renderInviteeChips(e.target.value));
    $('#bookingInviteesToggle').addEventListener('change', (e) => {
      setInviteesEnabled(e.target.checked);
      if (e.target.checked) $('#bookingInviteesInput').focus();
    });
    ['#bookingStartInput', '#bookingEndInput'].forEach((sel) => {
      $(sel).addEventListener('input', updateBookingDuration);
      $(sel).addEventListener('change', updateBookingDuration);
    });
    $('#bookingRepeatSelect').addEventListener('change', updateRepeatUI);
    $('#bookingDateInput').addEventListener('change', () => onBookingDatesChanged('from'));
    $('#bookingDateToInput').addEventListener('change', () => onBookingDatesChanged('to'));
    $('#roomForm').addEventListener('submit', onSubmitRoom);
    $('#roomFormCancelBtn').addEventListener('click', resetRoomForm);
    manageRoomsBtn.addEventListener('click', openRoomsModal);
    roomFilterSelect.addEventListener('change', () => {
      roomFilter = roomFilterSelect.value;
      rebuildBookingsMap();
      renderCalendar();
    });
    modeBtns.leave.addEventListener('click', () => setMode('leave'));
    modeBtns.room.addEventListener('click', () => setMode('room'));

    $('#holidayForm').addEventListener('submit', onSubmitHoliday);
    $('#holidayDeleteBtn').addEventListener('click', onDeleteHolidayClick);
    $('#addHolidayBtn').addEventListener('click', () => openHolidayModal(null));

    prevMonthBtn.addEventListener('click', () => shiftMonth(-1));
    nextMonthBtn.addEventListener('click', () => shiftMonth(1));
    todayBtn.addEventListener('click', () => (viewMode === 'gantt'
      ? setGanttDate(toDateKey(new Date()))
      : goToMonth(today.getFullYear(), today.getMonth())));
    monthSelect.addEventListener('change', () => goToMonth(viewYear, Number(monthSelect.value)));
    yearSelect.addEventListener('change', () => goToMonth(Number(yearSelect.value), viewMonth));
    refreshBtn.addEventListener('click', () => { showError(null); run(); });
    viewBtns.grid.addEventListener('click', () => setViewMode('grid'));
    viewBtns.gantt.addEventListener('click', () => showGanttFor(toDateKey(new Date())));
    dayInput.addEventListener('change', () => { if (dayInput.value) setGanttDate(dayInput.value); });
    ganttRows.addEventListener('click', onGanttClick);
    ganttRows.addEventListener('pointerdown', onGanttPointerDown);
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
      await loadRooms();
      await loadDataForView();
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
    isAdmin = adminCheck === true;
    myUserId = session.user.id;
    myName = (employee && employee.name) || '';

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

    // Live updates: reload only what changed; the visible month is always re-read.
    RealtimeSync.watch({
      name: 'calendar',
      tables: ['holidays', 'rooms', 'room_bookings', 'leave_requests', 'leave_request_approvals',
               'leave_types', 'policy_weekly_working_days'],
      onChange: async (changed) => {
        const t = new Set(changed);
        const all = t.has('*reconnect') || t.has('*visibility');
        if (all || t.has('policy_weekly_working_days') || t.has('leave_types')) {
          await loadWorkingPattern();
          await loadLeaveTypes();
        }
        if (all || t.has('holidays')) await loadHolidays();
        if (all || t.has('rooms')) await loadRooms();
        await loadDataForView();
      }
    });
  }

  window.addEventListener('ess:ready', onEssReady);
})();