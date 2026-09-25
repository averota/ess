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
    reasonInput, leaveRequestSubmitBtn;

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

  /* ------------------------------------------------------------------ */
  /* Lookups — mirror the equivalent loaders in leaves.js                */
  /* ------------------------------------------------------------------ */
  async function loadLeaveTypes() {
    const { data, error } = await sb
      .from('leave_types')
      .select('leave_type_id, leave_type, is_active')
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
    const selectable = includeId == null
      ? activeLeaveTypes
      : leaveTypes.filter(t => t.is_active !== false || String(t.leave_type_id) === String(includeId));
    leaveTypeInput.innerHTML = selectable
      .map(t => `<option value="${t.leave_type_id}">${escapeHtml(t.leave_type)}</option>`)
      .join('');
  }

  function populateEmployeeSelect() {
    const others = selectableEmployees.filter(emp => emp.id !== myEmployeeId);
    const options = [`<option value="${myEmployeeId}">Myself (${escapeHtml(myEmployeeName)})</option>`]
      .concat(others.map(emp => `<option value="${emp.id}">${escapeHtml(emp.name)} (${escapeHtml(emp.employee_id)})</option>`));
    requestEmployeeSelect.innerHTML = options.join('');

    // Nothing to hide behind "Myself" for a non-admin with no eligible
    // teammates (e.g. sole member of their department) — skip the field
    // entirely rather than show a picker with one option.
    showOnBehalfField = isAdmin || others.length > 0;
    onBehalfOfField.classList.toggle('hidden', !showOnBehalfField);

    onBehalfOfHint.textContent = isAdmin
      ? 'Choosing anyone other than yourself creates the request already approved.'
      : 'You can also file this for anyone in your department, including your supervisor — it stays pending, same as your own requests, and needs their supervisor\u2019s approval.';
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
  function computeWorkingDays(startD, endD, startHalf, endHalf) {
    let total = 0;
    for (let d = new Date(startD); d <= endD; d.setDate(d.getDate() + 1)) {
      const working = weeklyWorkingDays.size ? (weeklyWorkingDays.get(isoDayOfWeek(d)) ?? 0) : 1;
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
    const start = startDateInput.value;
    const end = endDateInput.value;
    if (!start || !end) { daysPreview.textContent = ''; return; }
    const startD = parseDateOnly(start);
    const endD = parseDateOnly(end);
    if (endD < startD) { daysPreview.textContent = 'End date must be on or after the start date.'; return; }

    const days = computeWorkingDays(startD, endD, startHalfDayInput.value, endHalfDayInput.value);
    daysPreview.innerHTML = `≈ <strong>${days}</strong> working day(s)`;

    // While the manual override is on, keep prefilling the (empty) input
    // with the calculated figure so the admin has a sane starting point.
    if (isAdmin && manualDaysToggle.checked && manualDaysInput.value === '') {
      manualDaysInput.value = days;
    }
  }

  function onDateOrHalfDayChange() {
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
  }

  /* ------------------------------------------------------------------ */
  /* Open                                                                 */
  /* ------------------------------------------------------------------ */
  function openModal(request, prefillDate, editingForLabel) {
    leaveRequestForm.reset();
    editingRequest = request || null;

    // reset() clears the checkbox/number input themselves, but not the
    // JS-controlled "hidden" class on the wrapper — always start closed,
    // then reopen it below for a request that's actually overridden.
    manualDaysToggle.checked = false;
    manualDaysInputWrap.classList.add('hidden');
    manualDaysInput.value = '';

    if (request) {
      populateLeaveTypeSelect(request.leave_type_id);
      leaveRequestModalTitle.textContent = 'Edit leave request';
      leaveRequestSubmitBtn.textContent = 'Save changes';

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
      leaveRequestSubmitBtn.textContent = 'Submit request';

      editingForBanner.classList.add('hidden');
      onBehalfOfField.classList.toggle('hidden', !showOnBehalfField);
      if (showOnBehalfField) requestEmployeeSelect.value = myEmployeeId;

      startHalfDayInput.value = 'full';
      endHalfDayInput.value = 'full';
      if (prefillDate) {
        startDateInput.value = prefillDate;
        endDateInput.value = prefillDate;
      }
      syncEndHalfDayField();
      updateDaysPreview();
    }

    leaveRequestModal.show();
  }

  /* ------------------------------------------------------------------ */
  /* Submit                                                               */
  /* ------------------------------------------------------------------ */
  async function onSubmit(e) {
    e.preventDefault();

    const startDate = startDateInput.value;
    const endDate = endDateInput.value;
    if (!startDate || !endDate || !leaveTypeInput.value) {
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
        leaveRequestSubmitBtn.disabled = false;
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

    // The field is only ever hidden when there's nothing but "Myself" to
    // choose from (see populateEmployeeSelect), so falling back to my own
    // id covers that case; otherwise it always reflects the picker.
    const targetEmployeeId = onBehalfOfField.classList.contains('hidden')
      ? myEmployeeId
      : requestEmployeeSelect.value;

    const overlap = await findOverlappingRequest(targetEmployeeId, startDate, endDate);
    if (overlap) {
      showToast(`These dates overlap another request: ${describeOverlap(overlap)}.`, 'danger');
      return;
    }

    const payload = {
      employee_id: targetEmployeeId,
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
      leaveRequestSubmitBtn.disabled = false;
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
    if (targetEmployeeId !== myEmployeeId) {
      message = isAdmin ? 'Leave created and auto-approved.' : 'Leave request submitted — pending their supervisor\u2019s approval.';
    }
    showToast(message, 'success');
    leaveRequestModal.hide();
    if (onSubmitted) onSubmitted({ mode: 'new', employeeId: targetEmployeeId });
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

    manualDaysField.classList.toggle('hidden', !isAdmin);

    leaveRequestForm.addEventListener('submit', onSubmit);
    [startDateInput, endDateInput, startHalfDayInput, endHalfDayInput].forEach(el =>
      el.addEventListener('change', onDateOrHalfDayChange)
    );
    manualDaysToggle.addEventListener('change', onManualDaysToggleChange);

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
