/* =====================================================================
   ESS — Shared "New / edit leave request" modal
   (assets/js/leaveRequestModal.js)

   Used by both leaves.html (leaves.js) and calendar.html (calendar.js) —
   the modal markup itself (#leaveRequestModal) is duplicated as static
   HTML in both pages (same IDs), but all of its behavior lives here
   once: loading its own lookups (leave types, weekly working-day
   policy, who the current user can file for), the day-count preview,
   the admin manual-days override, the on-behalf-of picker, overlap
   checking, and the insert/update submit itself.

   Deliberately self-contained rather than reusing leaves.js's page-wide
   state: it fetches its own copy of leave types / selectable employees
   in init() so it can be dropped into any page that includes the modal
   markup + this script, without depending on that page's own listing
   logic. On leaves.html this means leave types / delegates are fetched
   once more than strictly necessary (leaves.js already loads its own
   copies for its table/filters) — a small, worthwhile trade for a
   component that also works standalone on calendar.html.

   No-entitlement leave types (entitlement_days = 0) show an "X of N days
   used" line under the day count: N is the type's Maximum negative
   balance (no maximum set = unlimited, shown as "X days used"), X the
   employee's pending + approved days in the leave year of the start date (get_leave_cap_usage() in 06_no_entitlement_request_cap.sql).
   The line is created here in JS, so no page markup changes are needed.

   Look & feel: styles live in assets/css/leaveRequestModal.css (design from
   sample_design.html); this file only emits the matching markup for the
   pieces it renders (days pill, balance box, cap line, button labels).
   Pages must load bootstrap-icons for the .bi icons.
   The database enforces the cap; this line is only the preview.

   Leave types WITH an entitlement show the employee's balance right under
   the Leave type select (get_leave_balance() in 04_leave_balance_ledger.sql,
   for the leave cycle containing the start date): available to book,
   balance to date, and what is left after this request. Eligibility for the
   type on the start date (is_employee_eligible_for_leave_type()) and the
   type's back-date / prior-notice rules are shown there too. Non-admins are
   stopped before submit when they aren't eligible or the request would take
   the balance below what the type allows (new requests only — an edit is
   left to the database, which excludes the request's own days exactly);
   the over-limit cap for no-entitlement types is stopped for everyone, as
   the database does. The database triggers stay the source of truth for
   every rule (back-date / prior notice are only described here, not
   pre-checked, because they depend on the server's date). Like the cap
   line, the block is created here in JS — no page markup changes needed.

   Usage (see leaves.js / calendar.js):
     await LeaveRequestModal.init({
       sb, isAdmin, myEmployeeId, myEmployeeName, showToast,
       onSubmitted: (result) => { ... refresh whatever list is on screen ... }
     });
     LeaveRequestModal.openNew();                // blank
     LeaveRequestModal.openNew('2026-10-03');     // prefill From/To
     LeaveRequestModal.openEdit(request, label);  // edit an existing row
   ===================================================================== */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function parseDateOnly(dateStr) {
    if (!dateStr) return null;
    const [y, mo, da] = dateStr.split('-').map(Number);
    return new Date(y, mo - 1, da);
  }

  function formatDateShort(dateStr) {
    const d = parseDateOnly(dateStr);
    if (!d || isNaN(d)) return '—';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // Plain string comparison works here since dates are always 'YYYY-MM-DD'.
  function dateRangesOverlap(aStart, aEnd, bStart, bEnd) {
    return aStart <= bEnd && bStart <= aEnd;
  }

  /* ------------------------------------------------------------------ */
  /* DOM refs — resolved in init(), once the modal markup is on the page */
  /* ------------------------------------------------------------------ */
  let leaveRequestModal, leaveRequestForm, leaveRequestModalTitle,
    onBehalfOfField, onBehalfOfHint, requestEmployeeSelect,
    editingForBanner, editingForText,
    leaveTypeInput, startDateInput, startHalfDayInput, endDateInput, endHalfDayInput,
    daysPreview, manualDaysField, manualDaysToggle, manualDaysInputWrap, manualDaysInput,
    reasonInput, leaveRequestSubmitBtn, capUsageEl;

  /* ------------------------------------------------------------------ */
  /* State                                                                */
  /* ------------------------------------------------------------------ */
  let sb, isAdmin, myEmployeeId, myEmployeeName, showToast, onSubmitted;
  let leaveTypes = [];
  let activeLeaveTypes = [];
  let weeklyWorkingDays = new Map();
  let selectableEmployees = [];
  let showOnBehalfField = false;
  let editingRequest = null; // full row being edited, or null when creating
  let previewDays = 0;       // working days of the form's current dates (see updateDaysPreview)
  let capUsage = null;       // { name, cap (null = no maximum), used, yearStart, yearEnd } for a no-entitlement type, else null
  let capRequestSeq = 0;     // drops stale RPC answers when the form changes mid-request
  let balanceEl = null;      // balance / rules block under the Leave type select (created in init)
  let balanceInfo = null;    // { type, eligible, genderAllowed, balance } for the current employee / type / start date, else null (unknown)
  let balanceLoading = false;
  let balanceRequestSeq = 0; // same stale-answer guard as capRequestSeq
  let allowedTypeIds = null; // Set of leave_type_id the target employee may use (gender restriction), null = unknown / not loaded
  let allowedTypesSeq = 0;   // same stale-answer guard

  /* ------------------------------------------------------------------ */
  /* Lookups — mirror the equivalent loaders in leaves.js                */
  /* ------------------------------------------------------------------ */
  async function loadLeaveTypes() {
    const { data, error } = await sb
      .from('leave_types')
      .select(`leave_type_id, leave_type, is_active, entitlement_days,
        allow_negative_balance, max_negative_days, allowed_gender_id, entitlement_type,
        count_calendar_days, fixed_duration_days,
        allow_backdate, backdate_days, require_prior_notice, prior_notice_days`)
      .order('leave_type');
    if (error) {
      console.error('leaveRequestModal: could not load leave types:', error);
      return;
    }
    leaveTypes = data || [];
    activeLeaveTypes = leaveTypes.filter(t => t.is_active !== false);
  }

  // Lets updateDaysPreview() mirror calculate_leave_request_total_days()
  // exactly instead of just counting calendar days. Falls back to
  // treating every day as a normal full working day if this fails, so
  // the form still gives a (less precise) estimate rather than none.
  async function loadWeeklyWorkingDays() {
    const { data, error } = await sb
      .from('policy_weekly_working_days')
      .select('day_of_week, working_value');
    if (error) {
      console.error('leaveRequestModal: could not load weekly working-day policy:', error);
      weeklyWorkingDays = new Map();
      return;
    }
    weeklyWorkingDays = new Map((data || []).map(d => [d.day_of_week, Number(d.working_value)]));
  }

  // Admins can file for anyone; everyone else goes through
  // list_my_leave_delegates() (same department, their own supervisor
  // included) — the exact set leave_requests_insert's RLS check allows.
  async function loadSelectableEmployees() {
    if (isAdmin) {
      const { data, error } = await sb
        .from('employees')
        .select('id, name, employee_id')
        .is('last_day', null)
        .order('name');
      if (error) {
        console.error('leaveRequestModal: could not load employees:', error);
        return;
      }
      selectableEmployees = data || [];
      return;
    }
    const { data, error } = await sb.rpc('list_my_leave_delegates');
    if (error) {
      console.error('leaveRequestModal: could not load teammates:', error);
      return;
    }
    selectableEmployees = data || [];
  }

  // Best-effort overlap check, scoped to the target employee's own
  // pending/approved requests via a direct query (not a page-wide
  // cache), so it only ever sees what RLS lets the current user read.
  // Same limitation noted in leaves.js: it can't catch a conflict for a
  // same-department delegate the filer doesn't supervise. The real
  // backstop is the leave_requests_no_overlap exclusion constraint,
  // enforced server-side regardless of what this check can see.
  async function findOverlappingRequest(employeeId, startDate, endDate, excludeId) {
    let query = sb
      .from('leave_requests')
      .select('id, start_date, end_date, status, leave_type:leave_type_id(leave_type)')
      .eq('employee_id', employeeId)
      .in('status', [0, 1]);
    if (excludeId) query = query.neq('id', excludeId);

    const { data, error } = await query;
    if (error) {
      console.warn('leaveRequestModal: overlap check failed, continuing without it:', error);
      return null;
    }
    return (data || []).find(r => dateRangesOverlap(startDate, endDate, r.start_date, r.end_date)) || null;
  }

  function describeOverlap(req) {
    const range = req.start_date === req.end_date
      ? formatDateShort(req.start_date)
      : `${formatDateShort(req.start_date)} – ${formatDateShort(req.end_date)}`;
    const rel = req.leave_type;
    const type = (Array.isArray(rel) ? rel[0]?.leave_type : rel?.leave_type) || 'leave';
    const statusWord = req.status === 0 ? 'pending' : 'approved';
    return `${range} (${type}, ${statusWord})`;
  }

  /* ------------------------------------------------------------------ */
  /* Form fields                                                          */
  /* ------------------------------------------------------------------ */
  // `includeId`: when editing a request whose leave type has since been
  // disabled, that one type is kept in the list so the select can still
  // show (and re-submit) the request's current value.
  function populateLeaveTypeSelect(includeId = null) {
    const selectable = (includeId == null
      ? activeLeaveTypes
      : leaveTypes.filter(t => t.is_active !== false || String(t.leave_type_id) === String(includeId)))
      // Types the employee may not pick (gender restriction, or not eligible yet as of the start date)
      // are hidden completely; the type of a request being edited always stays.
      .filter(t => !allowedTypeIds || allowedTypeIds.has(Number(t.leave_type_id)) ||
        (includeId != null && String(t.leave_type_id) === String(includeId)));
    leaveTypeInput.innerHTML = selectable
      .map(t => `<option value="${t.leave_type_id}">${escapeHtml(t.leave_type)}</option>`)
      .join('');
  }

  function populateEmployeeSelect() {
    const others = selectableEmployees.filter(emp => emp.id !== myEmployeeId);
    // an admin has no employee profile (myEmployeeId null): no "Myself", a person must be picked.
    const first = myEmployeeId
      ? `<option value="${myEmployeeId}">Myself (${escapeHtml(myEmployeeName)})</option>`
      : '<option value="" disabled selected>Select an employee…</option>';
    const options = [first]
      .concat(others.map(emp => `<option value="${emp.id}">${escapeHtml(emp.name)} (${escapeHtml(emp.employee_id)})</option>`));
    requestEmployeeSelect.innerHTML = options.join('');

    // Nothing to hide behind "Myself" for a non-admin with no eligible
    // teammates (e.g. sole member of their department) — skip the field
    // entirely rather than show a picker with one option.
    showOnBehalfField = isAdmin || others.length > 0;
    onBehalfOfField.classList.toggle('hidden', !showOnBehalfField);

    onBehalfOfHint.innerHTML = '<i class="bi bi-info-circle me-1"></i>' + (isAdmin
      ? (myEmployeeId ? 'Choosing anyone other than yourself creates the request already approved.' : 'The request is created already approved, in your name as admin.')
      : 'You can also file this for anyone in your department.');
    syncEmployeeCombo();
  }

  /* ------------------------------------------------------------------ */
  /* Searchable "Requesting for" picker                                  */
  /* The native #requestEmployeeSelect stays the single source of truth  */
  /* (value / change event / options) but is hidden; this combobox reads */
  /* its options, filters them by name or employee ID, and writes back.  */
  /* ------------------------------------------------------------------ */
  let empSearchInput, empList, empActiveIdx = -1;

  const empOptions = () => [...requestEmployeeSelect.options].filter(o => !o.disabled);
  const empSelectedText = () => {
    const o = requestEmployeeSelect.selectedOptions[0];
    return o && !o.disabled ? o.textContent : '';
  };

  function renderEmployeeList(query) {
    const tokens = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    const matches = empOptions().filter(o => {
      const text = o.textContent.toLowerCase();          // "Name (EMP-ID)"
      return tokens.every(t => text.includes(t));
    });
    empList.innerHTML = matches.length
      ? matches.map(o => `<div class="emp-combo-item${o.value === requestEmployeeSelect.value ? ' is-selected' : ''}" role="option" data-value="${escapeHtml(o.value)}">${escapeHtml(o.textContent)}</div>`).join('')
      : '<div class="emp-combo-empty">No matching employee</div>';
    empActiveIdx = matches.length ? 0 : -1;
    paintActiveEmployee();
  }

  function paintActiveEmployee() {
    const items = empList.querySelectorAll('.emp-combo-item');
    items.forEach((el, i) => el.classList.toggle('is-active', i === empActiveIdx));
    items[empActiveIdx]?.scrollIntoView({ block: 'nearest' });
  }

  function openEmployeeList() {
    renderEmployeeList('');                               // show everyone until the user types
    empList.classList.remove('d-none');
    empSearchInput.setAttribute('aria-expanded', 'true');
  }

  function closeEmployeeList() {
    empList.classList.add('d-none');
    empSearchInput.setAttribute('aria-expanded', 'false');
    empSearchInput.value = empSelectedText();             // drop any half-typed search
  }

  function pickEmployee(value) {
    requestEmployeeSelect.value = value;
    requestEmployeeSelect.dispatchEvent(new Event('change', { bubbles: true }));   // -> refreshAllowedTypes
    closeEmployeeList();
  }

  // Call after the select's options or value change from code.
  function syncEmployeeCombo() {
    if (!empSearchInput) return;
    empList.classList.add('d-none');
    empSearchInput.setAttribute('aria-expanded', 'false');
    empSearchInput.value = empSelectedText();
  }

  function initEmployeeCombo() {
    if ($('requestEmployeeSearch')) return;
    if (!$('requestEmployeeCombo-style')) {
      const style = document.createElement('style');
      style.id = 'requestEmployeeCombo-style';
      style.textContent = `
        .emp-combo { position: relative; }
        .emp-combo-list { position: absolute; top: 100%; left: 0; right: 0; z-index: 1056; max-height: 180px; overflow-y: auto; margin-top: 0.2rem; border: 1px solid #e2e8f0; border-radius: 0.4rem; background: #fff; font-size: 0.78rem; box-shadow: 0 8px 20px -4px rgba(15, 23, 42, 0.18); }
        .emp-combo-item, .emp-combo-empty { padding: 0.3rem 0.55rem; }
        .emp-combo-item { cursor: pointer; transition: background-color 0.12s ease; }
        .emp-combo-item:hover, .emp-combo-item.is-active { background: #eff6ff; color: #1d4ed8; }
        .emp-combo-item.is-selected { font-weight: 600; }
        .emp-combo-empty { color: #94a3b8; font-style: italic; }`;
      document.head.appendChild(style);
    }

    const wrap = document.createElement('div');
    wrap.className = 'emp-combo';
    wrap.innerHTML = `
      <input type="text" class="form-control form-control-sm" id="requestEmployeeSearch" autocomplete="off"
             role="combobox" aria-expanded="false" aria-controls="requestEmployeeList" placeholder="Search by name or ID…">
      <div class="emp-combo-list d-none" id="requestEmployeeList" role="listbox"></div>`;
    requestEmployeeSelect.classList.add('d-none');
    requestEmployeeSelect.insertAdjacentElement('afterend', wrap);
    document.querySelector('label[for="requestEmployeeSelect"]')?.setAttribute('for', 'requestEmployeeSearch');

    empSearchInput = wrap.querySelector('input');
    empList = wrap.querySelector('.emp-combo-list');

    empSearchInput.addEventListener('focus', () => { empSearchInput.select(); openEmployeeList(); });
    empSearchInput.addEventListener('click', () => { if (empList.classList.contains('d-none')) openEmployeeList(); });
    empSearchInput.addEventListener('input', () => {
      empList.classList.remove('d-none');
      empSearchInput.setAttribute('aria-expanded', 'true');
      renderEmployeeList(empSearchInput.value);
    });
    empSearchInput.addEventListener('blur', closeEmployeeList);
    empSearchInput.addEventListener('keydown', (e) => {
      const items = empList.querySelectorAll('.emp-combo-item');
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (empList.classList.contains('d-none')) { openEmployeeList(); return; }
        if (!items.length) return;
        empActiveIdx = (empActiveIdx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        paintActiveEmployee();
      } else if (e.key === 'Enter') {
        e.preventDefault();                               // don't submit the form
        if (!empList.classList.contains('d-none') && items[empActiveIdx]) pickEmployee(items[empActiveIdx].dataset.value);
      } else if (e.key === 'Escape' && !empList.classList.contains('d-none')) {
        e.stopPropagation();                              // close the list, not the whole modal
        closeEmployeeList();
      }
    });
    // mousedown (not click) so the input's blur doesn't close the list first
    empList.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const item = e.target.closest('.emp-combo-item');
      if (item) pickEmployee(item.dataset.value);
    });
  }

  // JS Date#getDay() is 0=Sun..6=Sat; policy_weekly_working_days.day_of_week
  // is ISO (1=Mon..7=Sun), matching the server's extract(isodow from ...).
  function isoDayOfWeek(date) {
    return ((date.getDay() + 6) % 7) + 1;
  }

  // Same boundary rules as calculate_leave_request_total_days() in
  // 02_leaves_schema.sql: start_half_day/end_half_day mark WHERE in
  // their date the request begins/ends, not "which half of this one
  // day" — an interior date is always whole; the single-day case is
  // whole only if it starts from AM/full and ends through PM/full; the
  // start date of a multi-day request is whole unless start_half is
  // 'pm'; the end date is whole unless end_half is 'am'.
  function isWholeDayRequested(date, startD, endD, startHalf, endHalf) {
    const isStart = date.getTime() === startD.getTime();
    const isEnd = date.getTime() === endD.getTime();
    if (!isStart && !isEnd) return true;
    if (isStart && isEnd) return startHalf !== 'pm' && endHalf !== 'am';
    if (isStart) return startHalf !== 'pm';
    return endHalf !== 'am';
  }

  // Mirrors calculate_leave_request_total_days() exactly, so the preview
  // matches what the trigger will actually save.
  // Leave types with count_calendar_days (e.g. Maternity Leave) count every
  // calendar day as 1 instead of following the weekly working pattern.
  function isCalendarType() {
    const t = leaveTypeById(leaveTypeInput.value);
    return !!(t && t.count_calendar_days);
  }

  function computeWorkingDays(startD, endD, startHalf, endHalf) {
    const calendar = isCalendarType();
    let total = 0;
    for (let d = new Date(startD); d <= endD; d.setDate(d.getDate() + 1)) {
      const working = calendar ? 1 : (weeklyWorkingDays.size ? (weeklyWorkingDays.get(isoDayOfWeek(d)) ?? 0) : 1);
      const whole = isWholeDayRequested(d, startD, endD, startHalf, endHalf);
      total += whole ? working : Math.min(working, 0.5);
    }
    return total;
  }

  // Same-day + start = 'full' means the whole date either way — the End
  // field has nothing meaningful left to choose, so it's locked to
  // 'full' and disabled instead of asking the person to redundantly
  // confirm it.
  function syncEndHalfDayField() {
    const sameDay = !!startDateInput.value && startDateInput.value === endDateInput.value;
    const lock = sameDay && startHalfDayInput.value === 'full';
    endHalfDayInput.disabled = lock;
    if (lock) endHalfDayInput.value = 'full';
  }

  function updateDaysPreview() {
    previewDays = 0;
    renderDaysPreview();
    paintRuleInfo();
  }

  // Markup matches the "Total Requested" pill in sample_design.html; the
  // empty state must stay truly empty (CSS hides #daysPreview with :empty).
  function renderDaysPreview() {
    daysPreview.classList.remove('is-error');
    const start = startDateInput.value;
    const end = endDateInput.value;
    if (!start || !end) { daysPreview.textContent = ''; return; }
    const startD = parseDateOnly(start);
    const endD = parseDateOnly(end);
    if (endD < startD) {
      daysPreview.classList.add('is-error');
      daysPreview.innerHTML = '<span><i class="bi bi-exclamation-circle me-1"></i>End date must be on or after the start date.</span>';
      return;
    }

    const days = computeWorkingDays(startD, endD, startHalfDayInput.value, endHalfDayInput.value);
    previewDays = days;
    daysPreview.innerHTML =
      '<span><i class="bi bi-calculator me-1 text-primary"></i>Total Requested:</span>' +
      `<span class="badge bg-primary text-white">${days} ${isCalendarType() ? 'calendar' : 'working'} day${days === 1 ? '' : 's'}</span>`;

    // While the manual override is on, keep prefilling the (empty) input
    // with the calculated figure so the admin has a sane starting point.
    if (isAdmin && manualDaysToggle.checked && manualDaysInput.value === '') {
      manualDaysInput.value = days;
    }
  }

  // Leave types with fixed_duration_days (e.g. Maternity Leave = 90): the
  // end date is start + N - 1 calendar days, so start and end are both
  // included in the N days. Runs when the start date or the leave type is
  // changed by the user (not when an existing request is opened).
  function addDaysToDateStr(str, n) {
    const d = parseDateOnly(str);
    d.setDate(d.getDate() + n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function applyFixedDuration() {
    const t = leaveTypeById(leaveTypeInput.value);
    const n = t ? Number(t.fixed_duration_days) : 0;
    if (!n || !startDateInput.value) return;
    endDateInput.value = addDaysToDateStr(startDateInput.value, n - 1);
    startHalfDayInput.value = 'full';   // whole days, so the request is exactly N days
    endHalfDayInput.value = 'full';
  }

  function onDateOrHalfDayChange(e) {
    if (e && e.target === startDateInput) applyFixedDuration();
    syncEndHalfDayField();
    updateDaysPreview();
  }

  function onLeaveTypeChange() {
    applyFixedDuration();
    syncEndHalfDayField();
    updateDaysPreview();
  }

  // Admin-only: flip between the calculated preview and a free-typed
  // total. Unchecking always reverts to the calculated value —
  // total_days_manual is sent back as false, so the trigger recomputes.
  function onManualDaysToggleChange() {
    const on = manualDaysToggle.checked;
    manualDaysInputWrap.classList.toggle('hidden', !on);
    if (on && manualDaysInput.value === '') {
      const start = startDateInput.value;
      const end = endDateInput.value;
      if (start && end) {
        const startD = parseDateOnly(start);
        const endD = parseDateOnly(end);
        if (endD >= startD) {
          manualDaysInput.value = computeWorkingDays(startD, endD, startHalfDayInput.value, endHalfDayInput.value);
        }
      }
    }
    if (!on) manualDaysInput.value = '';
    paintRuleInfo();
  }

  /* ------------------------------------------------------------------ */
  /* "X of N days used" for no-entitlement leave types                    */
  /* ------------------------------------------------------------------ */
  const fmtNum = (n) => String(Number(n));
  const fmtDays = (n) => fmtNum(Number(n).toFixed(2));   // 12, 12.5, -1.5 — never float noise

  // Local calendar date as YYYY-MM-DD.
  function todayStr() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  // Who the form is for: the edited request's employee, else the picker
  // (hidden when there's only "Myself" to choose from).
  function targetEmployeeId() {
    if (editingRequest) return editingRequest.employee_id;
    return onBehalfOfField.classList.contains('hidden') ? myEmployeeId : requestEmployeeSelect.value;
  }

  function isNoEntitlementType(typeId) {
    const t = leaveTypes.find(x => String(x.leave_type_id) === String(typeId));
    return !!t && Number(t.entitlement_days) === 0;
  }

  // Days this request would add: the admin's manual total when set,
  // otherwise the calculated preview.
  function requestedDays() {
    if (isAdmin && manualDaysToggle.checked && manualDaysInput.value !== '') {
      const m = Number(manualDaysInput.value);
      if (Number.isFinite(m) && m >= 0) return m;
    }
    return previewDays;
  }

  function paintCapUsage() {
    if (!capUsageEl) return;
    if (!capUsage) {
      capUsageEl.textContent = '';
      capUsageEl.classList.add('hidden');
      return;
    }
    const { name, cap, used, yearStart, yearEnd } = capUsage;
    const requested = requestedDays();
    const after = used + requested;
    const over = cap !== null && after > cap;
    const year = `${formatDateShort(yearStart)} – ${formatDateShort(yearEnd)}`;

    // No maximum set: nothing to compare against, just show days taken.
    const of = cap === null ? '' : ` of ${fmtNum(cap)}`;
    let html = `<i class="bi ${over ? 'bi-exclamation-triangle-fill' : 'bi-info-circle'} me-1"></i><strong>${fmtNum(used)}${of}</strong> days used`;
    if (requested > 0) html += ` · with this request <strong>${fmtNum(after)}${of}</strong>`;
    if (cap === null) html += ' · no maximum';
    if (over) html += ` — over the limit by ${fmtNum(after - cap)}`;
    html += ` <span class="text-muted">(${escapeHtml(name)}, leave year ${year})</span>`;
    capUsageEl.innerHTML = html;
    capUsageEl.classList.toggle('text-danger', over);
    capUsageEl.classList.remove('hidden');
  }

  // Refetches usage for the current employee / leave type / start date.
  // Anything that doesn't change those (dates within the same year,
  // half-days, manual days) only needs paintRuleInfo().
  async function refreshCapUsage() {
    const seq = ++capRequestSeq;
    const typeId = leaveTypeInput.value;
    const employeeId = targetEmployeeId();
    if (!typeId || !employeeId || !isNoEntitlementType(typeId)) {
      capUsage = null;
      paintCapUsage();
      return;
    }

    let data = null;
    let error = null;
    try {
      ({ data, error } = await sb.rpc('get_leave_cap_usage', {
        p_employee_id: employeeId,
        p_leave_type_id: Number(typeId),
        p_start_date: startDateInput.value || todayStr(),
        p_exclude_request_id: editingRequest ? editingRequest.id : null
      }));
    } catch (err) {
      error = err;
    }
    if (seq !== capRequestSeq) return;   // the form changed while waiting

    if (error || !data || !data.length) {
      if (error) console.warn('leaveRequestModal: could not load leave usage:', error);
      capUsage = null;
    } else {
      const r = data[0];
      capUsage = {
        name: r.out_leave_type,
        cap: r.out_cap == null ? null : Number(r.out_cap),   // null = no maximum set
        used: Number(r.out_used),
        yearStart: r.out_year_start,
        yearEnd: r.out_year_end
      };
    }
    paintCapUsage();
    updateSubmitState();
  }

  /* ------------------------------------------------------------------ */
  /* Balance, eligibility and rules for leave types WITH an entitlement   */
  /* ------------------------------------------------------------------ */
  function leaveTypeById(id) {
    return leaveTypes.find(t => String(t.leave_type_id) === String(id)) || null;
  }

  // Reloads which leave types the current target employee may use and
  // rebuilds the Leave type select from it, keeping the current choice when
  // it is still available. Called when the modal opens and when the
  // "Requested for" employee changes.
  async function refreshAllowedTypes() {
    const seq = ++allowedTypesSeq;
    const employeeId = targetEmployeeId();
    let ids = null;
    if (employeeId) {
      const { data, error } = await sb.rpc('list_allowed_leave_type_ids', {
        p_employee_id: employeeId,
        p_as_of: startDateInput.value || todayStr()   // eligibility is judged at the leave start date
      });
      if (error) console.warn('leaveRequestModal: could not load allowed leave types:', error);
      else ids = new Set((data || []).map(r => Number(r.out_leave_type_id ?? r)));
    }
    if (seq !== allowedTypesSeq) return;   // the form changed while waiting
    allowedTypeIds = ids;
    const keep = leaveTypeInput.value;
    populateLeaveTypeSelect(editingRequest ? editingRequest.leave_type_id : null);
    if (keep && [...leaveTypeInput.options].some(o => o.value === keep)) leaveTypeInput.value = keep;
    refreshRuleInfo();
  }

  // genders.gender_id: 0 = female, 1 = male (01).
  function genderRestrictionMessage(type) {
    const who = Number(type.allowed_gender_id) === 0 ? 'female' : 'male';
    return `${type.leave_type} is only available to ${who} employees.`;
  }

  function hasEntitlement(type) {
    return !!type && Number(type.entitlement_days) > 0;
  }

  // Refetches eligibility (always) and the balance (entitlement types) for
  // the current employee / leave type, as of the start date so it lines up
  // with the leave cycle the database checks the request against. Employee,
  // leave type and start date changes call this; days / half-days only need
  // paintBalance().
  async function refreshBalance() {
    const seq = ++balanceRequestSeq;
    const type = leaveTypeById(leaveTypeInput.value);
    const employeeId = targetEmployeeId();
    balanceInfo = null;
    balanceLoading = !!type && !!employeeId;
    paintBalance();
    if (!balanceLoading) return;

    const asOf = startDateInput.value || todayStr();
    const args = { p_employee_id: employeeId, p_leave_type_id: type.leave_type_id, p_as_of: asOf };
    let eligible = null;
    let balance = null;
    try {
      const [elig, bal] = await Promise.all([
        sb.rpc('is_employee_eligible_for_leave_type', args),
        hasEntitlement(type) ? sb.rpc('get_leave_balance', args) : Promise.resolve({ data: null, error: null })
      ]);
      if (elig.error) console.warn('leaveRequestModal: could not check eligibility:', elig.error);
      else eligible = elig.data;   // true / false / null (unknown employee or type)
      if (bal.error) console.warn('leaveRequestModal: could not load leave balance:', bal.error);
      else balance = Array.isArray(bal.data) ? (bal.data[0] || null) : bal.data;
    } catch (err) {
      console.warn('leaveRequestModal: balance lookup failed:', err);
    }
    if (seq !== balanceRequestSeq) return;   // the form changed while waiting

    balanceLoading = false;
    // Gender restriction comes from the allowed-types list (null = unknown, never blocks).
    // A type missing from the list only counts as a gender block when the type has a gender restriction
    // (otherwise it is an eligibility hide, which the `eligible` check above reports).
    const genderAllowed = allowedTypeIds
      ? (allowedTypeIds.has(Number(type.leave_type_id)) || type.allowed_gender_id == null)
      : null;
    balanceInfo = (eligible === null && genderAllowed === null && !balance) ? null : { type, eligible, genderAllowed, balance };
    paintBalance();
  }

  // The balance figures for the form as it stands right now. When editing,
  // the request's own days are already counted in the balance (as pending or
  // approved), so they are added back — the same thing the database does by
  // excluding the request being edited. Returns null while nothing is known.
  function evaluateBalance() {
    if (!balanceInfo) return null;
    const { type, eligible, genderAllowed, balance: b } = balanceInfo;
    const ev = { type, eligible, genderAllowed, b, over: false };
    if (!b) return ev;

    const r = editingRequest;
    const addBack = (r && String(r.leave_type_id) === String(type.leave_type_id) && (r.status === 0 || r.status === 1) &&
      r.start_date >= b.cycle_start && r.start_date <= b.cycle_end) ? Number(r.total_days) : 0;

    const requested = requestedDays();
    const r2 = (x) => Math.round(x * 100) / 100;   // keep float noise out of the < floor comparison
    // Monthly accrual: only what has accrued up to today can be requested
    // (available minus the not-yet-accrued part of the cycle's entitlement) — mirrors 04.
    const notAccrued = type.entitlement_type === 'monthly'
      ? Number(b.entitlement_ye || 0) - Number(b.entitlement_ytd || 0) : 0;
    ev.toDate = type.entitlement_type === 'monthly';
    ev.available = r2(Number(b.available_balance) - notAccrued + addBack);
    ev.floor = 0;   // request must be <= available; negative balance is not used
    ev.after = r2(ev.available - requested);
    ev.over = requested > 0 && ev.after < ev.floor;
    return ev;
  }

  // Fills #leaveRuleInfo (design: sample_design.html). The box colour follows
  // what it says: green when there is a balance to show, rose when the
  // request is blocked (not eligible / below the minimum), neutral grey while
  // loading or when only the back-date / notice rules are shown.
  function paintBalance() {
    if (!balanceEl) return;
    const type = leaveTypeById(leaveTypeInput.value);
    const parts = [];
    let tone = 'muted';   // 'ok' | 'danger' | 'muted'
    const line = (icon, html, cls = '') =>
      `<div${cls ? ` class="${cls}"` : ''}><i class="bi ${icon} me-1"></i>${html}</div>`;

    if (balanceLoading) {
      parts.push(line('bi-hourglass-split', 'Checking balance…', 'text-muted'));
    } else {
      const ev = evaluateBalance();
      if (ev && ev.genderAllowed === false) {
        tone = 'danger';
        parts.push(line('bi-x-circle-fill', escapeHtml(genderRestrictionMessage(type))));
      } else if (ev && ev.eligible === false) {
        tone = 'danger';
        parts.push(line('bi-x-circle-fill', `Not eligible for ${escapeHtml(type.leave_type)} for leave starting on ${escapeHtml(formatDateShort(startDateInput.value || todayStr()))}${isAdmin ? ' (admin can override)' : ''}.`));
      } else if (ev && ev.b) {
        const requested = requestedDays();
        let html = `<strong>${fmtDays(ev.available)}</strong> days available to date`;
        if (requested > 0) html += ` · after this request <strong>${fmtDays(ev.after)}</strong>`;
        if (ev.over) html += ` — ${fmtDays(ev.floor - ev.after)} day(s) over the available balance`;
        tone = ev.over ? 'danger' : 'ok';
        parts.push(line(ev.over ? 'bi-exclamation-triangle-fill' : 'bi-check-circle-fill text-success', html));
      }
    }

    balanceEl.innerHTML = parts.join('');
    balanceEl.classList.toggle('is-danger', tone === 'danger');
    balanceEl.classList.toggle('is-muted', tone === 'muted');
    balanceEl.classList.toggle('hidden', parts.length === 0);
    updateSubmitState();
  }

  // Submit is disabled while the form breaks a rule we can already check
  // (gender restriction, not eligible, over the available days, over the
  // no-entitlement cap); the reason is shown in the rule box and as the
  // button tooltip. Unknown / still-loading state never disables it — the
  // database triggers have the final say.
  function updateSubmitState() {
    if (!leaveRequestSubmitBtn) return;
    const reason = blockingRuleMessage();
    leaveRequestSubmitBtn.disabled = !!reason;
    leaveRequestSubmitBtn.title = reason;
  }

  function paintRuleInfo() {
    paintCapUsage();
    paintBalance();
  }

  function refreshRuleInfo() {
    return Promise.all([refreshCapUsage(), refreshBalance()]);
  }

  // What stops a submit before it reaches the database. Anything still
  // unknown (lookup failed / not loaded yet) never blocks — the triggers in
  // 02 / 03 / 04 have the final say and their message is shown as-is.
  function blockingRuleMessage() {
    if (!targetEmployeeId()) return 'Choose who this request is for.';   // admin: no default employee
    const type = leaveTypeById(leaveTypeInput.value);
    const requested = requestedDays();

    // Gender restriction — a hard rule: the database applies it to admins too.
    const genderEv = evaluateBalance();
    if (genderEv && genderEv.genderAllowed === false) return genderRestrictionMessage(type);

    const ev = genderEv;
    // Eligibility is admin-overridable; the available-days limit is not.
    if (!isAdmin && ev && ev.eligible === false) {
      return `You are not eligible for ${type.leave_type} for leave starting on ${formatDateShort(startDateInput.value)}.`;
    }
    if (ev && ev.over) {
      return `Not enough ${type.leave_type} balance: this request is ${fmtDays(requested)} day(s) but only ${fmtDays(ev.available)} day(s) are available${ev.toDate ? ' to date' : ''}.`;
    }

    // No-entitlement cap — the database applies it to admins too.
    if (capUsage && capUsage.cap !== null && capUsage.used + requested > capUsage.cap) {
      return `${capUsage.name} can be requested for at most ${fmtNum(capUsage.cap)} day(s) per leave year (${fmtNum(capUsage.used)} already taken or pending, ${fmtDays(requested)} requested).`;
    }
    return '';
  }

  /* ------------------------------------------------------------------ */
  /* Open                                                                 */
  /* ------------------------------------------------------------------ */
  async function openModal(request, prefillDate, editingForLabel) {
    leaveRequestForm.reset();
    editingRequest = request || null;

    // reset() clears the checkbox/number input themselves, but not the
    // JS-controlled "hidden" class on the wrapper — always start closed,
    // then reopen it below for a request that's actually overridden.
    manualDaysToggle.checked = false;
    manualDaysInputWrap.classList.add('hidden');
    manualDaysInput.value = '';
    capUsage = null;
    balanceInfo = null;
    balanceLoading = false;
    paintRuleInfo();

    if (request) {
      populateLeaveTypeSelect(request.leave_type_id);
      leaveRequestModalTitle.textContent = 'Edit leave request';
      leaveRequestSubmitBtn.innerHTML = '<i class="bi bi-check-lg me-1"></i>Save changes';

      onBehalfOfField.classList.add('hidden');
      editingForBanner.classList.remove('hidden');
      editingForText.textContent = editingForLabel || 'Editing this request';

      leaveTypeInput.value = String(request.leave_type_id);
      startDateInput.value = request.start_date;
      startHalfDayInput.value = request.start_half_day;
      endDateInput.value = request.end_date;
      endHalfDayInput.value = request.end_half_day;
      reasonInput.value = request.reason || '';
      syncEndHalfDayField();
      updateDaysPreview();

      // Already manually overridden (admin-only field, but harmless to
      // set even if hidden for a non-admin viewer): show it pre-filled
      // with the existing total rather than the recalculated one, so
      // reopening the modal doesn't look like it silently changed.
      if (isAdmin && request.total_days_manual) {
        manualDaysToggle.checked = true;
        manualDaysInputWrap.classList.remove('hidden');
        manualDaysInput.value = Number(request.total_days);
      }
    } else {
      populateLeaveTypeSelect();
      leaveRequestModalTitle.textContent = 'New leave request';
      leaveRequestSubmitBtn.innerHTML = '<i class="bi bi-send me-1"></i>Submit request';

      editingForBanner.classList.add('hidden');
      onBehalfOfField.classList.toggle('hidden', !showOnBehalfField);
      if (showOnBehalfField) { requestEmployeeSelect.value = myEmployeeId || ''; syncEmployeeCombo(); }

      startHalfDayInput.value = 'full';
      endHalfDayInput.value = 'full';
      if (prefillDate) {
        startDateInput.value = prefillDate;
        endDateInput.value = prefillDate;
      }
      syncEndHalfDayField();
      updateDaysPreview();
    }

    // Hide leave types this employee may not use BEFORE the modal shows
    // (also refreshes the rule box and the submit state).
    await refreshAllowedTypes();
    leaveRequestModal.show();
  }

  /* ------------------------------------------------------------------ */
  /* Submit                                                               */
  /* ------------------------------------------------------------------ */
  async function onSubmit(e) {
    e.preventDefault();

    const startDate = startDateInput.value;
    const endDate = endDateInput.value;
    if (!startDate || !endDate || !leaveTypeInput.value || !targetEmployeeId()) {
      showToast('Please fill in the required fields.', 'danger');
      return;
    }
    if (endDate < startDate) {
      showToast('End date must be on or after the start date.', 'danger');
      return;
    }
    if (startDate === endDate && startHalfDayInput.value === 'pm' && endHalfDayInput.value === 'am') {
      showToast('End time must be later than the start time on the same day.', 'danger');
      return;
    }

    // Admin manual override fields. total_days_manual is always sent
    // explicitly (including "false") so that, on an edit, unchecking the
    // box actually clears a previous override instead of silently
    // leaving it in place.
    let manualDaysFields = { total_days_manual: false };
    if (isAdmin && manualDaysToggle.checked) {
      const manualDays = Number(manualDaysInput.value);
      if (manualDaysInput.value === '' || Number.isNaN(manualDays) || manualDays < 0) {
        showToast('Enter a valid number of days (0 or more) for the manual override.', 'danger');
        return;
      }
      manualDaysFields = { total_days: manualDays, total_days_manual: true };
    }

    const blocked = blockingRuleMessage();
    if (blocked) {
      showToast(blocked, 'danger');
      return;
    }

    // Editing an existing request (admin only) — straight table update,
    // no employee_id/status change involved.
    if (editingRequest) {
      const overlap = await findOverlappingRequest(editingRequest.employee_id, startDate, endDate, editingRequest.id);
      if (overlap) {
        showToast(`These dates overlap another request: ${describeOverlap(overlap)}.`, 'danger');
        return;
      }

      const payload = {
        leave_type_id: Number(leaveTypeInput.value),
        start_date: startDate,
        start_half_day: startHalfDayInput.value,
        end_date: endDate,
        end_half_day: endHalfDayInput.value,
        reason: reasonInput.value.trim() || null,
        ...manualDaysFields
      };

      leaveRequestSubmitBtn.disabled = true;
      let error;
      try {
        ({ error } = await sb.from('leave_requests').update(payload).eq('id', editingRequest.id));
      } catch (err) {
        error = err; // network-level failure: surface it through the same toast path
      } finally {
        updateSubmitState();
      }

      if (error) {
        if (error.code === '23P01') {
          showToast('These dates overlap another pending or approved request for this person.', 'danger');
        } else {
          showToast('Could not update request: ' + error.message, 'danger');
        }
        return;
      }
      showToast('Leave request updated.', 'success');
      leaveRequestModal.hide();
      if (onSubmitted) onSubmitted({ mode: 'edit', requestId: editingRequest.id, employeeId: editingRequest.employee_id });
      return;
    }

    // See targetEmployeeId(): the picker, or myself when it's hidden.
    const employeeId = targetEmployeeId();

    const overlap = await findOverlappingRequest(employeeId, startDate, endDate);
    if (overlap) {
      showToast(`These dates overlap another request: ${describeOverlap(overlap)}.`, 'danger');
      return;
    }

    const payload = {
      employee_id: employeeId,
      leave_type_id: Number(leaveTypeInput.value),
      start_date: startDate,
      start_half_day: startHalfDayInput.value,
      end_date: endDate,
      end_half_day: endHalfDayInput.value,
      reason: reasonInput.value.trim() || null,
      ...manualDaysFields
    };

    leaveRequestSubmitBtn.disabled = true;
    let error;
    try {
      ({ error } = await sb.from('leave_requests').insert(payload));
    } catch (err) {
      error = err;
    } finally {
      updateSubmitState();
    }

    if (error) {
      if (error.code === '23P01') {
        showToast('These dates overlap another pending or approved request for this person.', 'danger');
      } else if (error.code === '42501' || /row-level security/i.test(error.message || '')) {
        showToast('You can only file leave for yourself or someone in your department.', 'danger');
      } else {
        showToast('Could not submit request: ' + error.message, 'danger');
      }
      return;
    }

    let message = 'Leave request submitted.';
    if (employeeId !== myEmployeeId) {
      message = isAdmin ? 'Leave created and auto-approved.' : 'Leave request submitted — pending approval.';
    }
    showToast(message, 'success');
    leaveRequestModal.hide();
    if (onSubmitted) onSubmitted({ mode: 'new', employeeId });
  }

  /* ------------------------------------------------------------------ */
  /* Public API                                                           */
  /* ------------------------------------------------------------------ */
  async function init(opts) {
    sb = opts.sb;
    isAdmin = !!opts.isAdmin;
    myEmployeeId = opts.myEmployeeId;
    myEmployeeName = opts.myEmployeeName || '';
    showToast = opts.showToast;
    onSubmitted = opts.onSubmitted || null;

    const modalEl = $('leaveRequestModal');
    if (!modalEl) {
      console.error('leaveRequestModal: #leaveRequestModal markup not found on this page.');
      return;
    }

    leaveRequestModal = bootstrap.Modal.getOrCreateInstance(modalEl);
    leaveRequestForm = $('leaveRequestForm');
    leaveRequestModalTitle = $('leaveRequestModalTitle');
    onBehalfOfField = $('onBehalfOfField');
    onBehalfOfHint = $('onBehalfOfHint');
    requestEmployeeSelect = $('requestEmployeeSelect');
    editingForBanner = $('editingForBanner');
    editingForText = $('editingForText');
    leaveTypeInput = $('leaveTypeInput');
    startDateInput = $('startDateInput');
    startHalfDayInput = $('startHalfDayInput');
    endDateInput = $('endDateInput');
    endHalfDayInput = $('endHalfDayInput');
    daysPreview = $('daysPreview');
    manualDaysField = $('manualDaysField');
    manualDaysToggle = $('manualDaysToggle');
    manualDaysInputWrap = $('manualDaysInputWrap');
    manualDaysInput = $('manualDaysInput');
    reasonInput = $('reasonInput');
    leaveRequestSubmitBtn = $('leaveRequestSubmitBtn');
    initEmployeeCombo();

    manualDaysField.classList.toggle('hidden', !isAdmin);

    capUsageEl = $('capUsageInfo');
    if (!capUsageEl) {
      capUsageEl = document.createElement('div');
      capUsageEl.id = 'capUsageInfo';
      capUsageEl.className = 'form-text hidden';
      daysPreview.insertAdjacentElement('afterend', capUsageEl);
    }

    balanceEl = $('leaveRuleInfo');
    if (!balanceEl) {
      balanceEl = document.createElement('div');
      balanceEl.id = 'leaveRuleInfo';
      balanceEl.className = 'form-text hidden';
      leaveTypeInput.insertAdjacentElement('afterend', balanceEl);
    }

    leaveRequestForm.addEventListener('submit', onSubmit);
    [startDateInput, endDateInput, startHalfDayInput, endHalfDayInput].forEach(el =>
      el.addEventListener('change', onDateOrHalfDayChange)
    );
    manualDaysToggle.addEventListener('change', onManualDaysToggleChange);
    manualDaysInput.addEventListener('input', paintRuleInfo);
    // Employee, leave type and start date decide which leave year / who is
    // counted (and eligibility), so they refetch; everything else just repaints.
    leaveTypeInput.addEventListener('change', onLeaveTypeChange);
    leaveTypeInput.addEventListener('change', refreshRuleInfo);
    // A different "Requested for" employee, or a different start date (eligibility is judged at the
    // start date), may allow a different set of leave types; refreshAllowedTypes also refreshes the rules.
    [requestEmployeeSelect, startDateInput].forEach(el =>
      el.addEventListener('change', refreshAllowedTypes)
    );

    await Promise.all([loadLeaveTypes(), loadWeeklyWorkingDays(), loadSelectableEmployees()]);
    populateEmployeeSelect();
  }

  function openNew(prefillDate) {
    openModal(null, prefillDate || null);
  }

  function openEdit(request, editingForLabel) {
    if (!request) return;
    openModal(request, null, editingForLabel);
  }

  // Re-reads leave types / delegates — e.g. after an admin adds or
  // renames a leave type elsewhere on the page — keeping the request
  // form's dropdown in sync without a full re-init().
  async function refresh() {
    await Promise.all([loadLeaveTypes(), loadSelectableEmployees()]);
    populateEmployeeSelect();
  }

  window.LeaveRequestModal = { init, openNew, openEdit, refresh };
})();
