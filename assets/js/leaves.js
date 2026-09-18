// =====================================================================
// leaves.html — submit/track leave requests, review team requests
// (supervisor or admin), and manage the leave-types lookup (admin).
//
// Built on sidebar.js's `ess:ready` event, same as employees.js — this
// file carries its own small toast/confirm/prompt helpers rather than
// depending on a shared utils.js (there isn't one in this app).
//
// Data model (see supabase/02_leaves_schema.sql):
//   - leave_requests.status: 0 pending, 1 approved, 2 rejected, 3 cancelled.
//   - Row-visibility is entirely handled by RLS: a plain select on
//     leave_requests returns your own requests, plus (if you're
//     someone's direct supervisor or an admin) theirs too. So one
//     fetch covers "my requests" and "team requests to review" — this
//     file just splits the same result set by employee_id client-side.
//   - Approve/reject go through review_leave_request(); cancel goes
//     through cancel_leave_request() — both SECURITY DEFINER RPCs, not
//     direct updates, because only pending requests can transition and
//     approver/timestamp must be stamped together.
//   - Inserting a new request never sets employee_id/requested_by/status
//     directly for a non-admin — trg_leave_requests_defaults overwrites
//     those server-side regardless of what the client sends. For an
//     admin creating on behalf of someone else, that same trigger
//     auto-approves it (no separate "approve" step needed here).
// =====================================================================

let leaveRequestModal;
let manageTypesModal;

let myEmployeeId = null;   // employees.id (uuid) — not the human-readable employee_id
let myEmployeeName = '';
let isAdmin = false;
let isSupervisor = false;

let leaveTypes = [];        // all rows (active + inactive), for the admin manage-types list
let activeLeaveTypes = [];  // active-only, for the request form's select
let selectableEmployees = []; // who I can file a request for, besides myself — admin: everyone; everyone else: same-department teammates minus their own supervisor (see list_my_leave_delegates())
let allRequests = [];       // everything RLS lets me see: mine + (if supervisor/admin) my team's

const STATUS_LABEL = { 0: 'Pending', 1: 'Approved', 2: 'Rejected', 3: 'Cancelled' };
const STATUS_CLASS = { 0: 'is-pending', 1: 'is-approved', 2: 'is-rejected', 3: 'is-cancelled' };
const HALF_DAY_LABEL = { full: 'Full day', am: 'AM', pm: 'PM' };

// ---------------------------------------------------------------------
// Small self-contained helpers (same pattern as employees.js)
// ---------------------------------------------------------------------
function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
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

// Embedded relations (e.g. `employee:employee_id(name)`) can come back
// as either an object or a single-item array depending on the query
// shape — same quirk employees.js works around for supervisor_info.
function embedded(rel, key = 'name') {
    if (!rel) return '';
    if (Array.isArray(rel)) return rel[0]?.[key] || '';
    return rel[key] || '';
}

function ensureToastStack() {
    let stack = document.querySelector('.toast-stack');
    if (!stack) {
        stack = document.createElement('div');
        stack.className = 'toast-stack';
        document.body.appendChild(stack);
    }
    return stack;
}

function showToast(message, type = 'success') {
    const stack = ensureToastStack();
    const item = document.createElement('div');
    item.className = `toast-item is-${type}`;
    item.textContent = message;
    stack.appendChild(item);
    setTimeout(() => item.remove(), 3500);
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
                    <button type="button" class="btn btn-outline-secondary btn-sm" data-action="cancel">Cancel</button>
                    <button type="button" class="btn ${danger ? 'btn-rose' : 'btn-accent'} btn-sm" data-action="confirm">${escapeHtml(confirmLabel)}</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        function cleanup(result) { overlay.remove(); resolve(result); }
        overlay.querySelector('[data-action="cancel"]').addEventListener('click', () => cleanup(false));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
        overlay.querySelector('[data-action="confirm"]').addEventListener('click', () => cleanup(true));
    });
}

// Small dialog to collect a single required line of text (used for the
// rejection reason — the DB itself won't accept a rejection without one,
// see leave_requests_rejection_reason_check).
function promptTextDialog({ title, message, confirmLabel = 'Confirm', placeholder = '' }) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal-box">
                <h3>${escapeHtml(title)}</h3>
                <p>${message}</p>
                <textarea class="form-control form-control-sm mb-2" id="promptTextInput" rows="3" placeholder="${escapeHtml(placeholder)}"></textarea>
                <div class="modal-actions">
                    <button type="button" class="btn btn-outline-secondary btn-sm" data-action="cancel">Cancel</button>
                    <button type="button" class="btn btn-rose btn-sm" data-action="confirm">${escapeHtml(confirmLabel)}</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        const input = overlay.querySelector('#promptTextInput');
        input.focus();

        function cleanup(result) { overlay.remove(); resolve(result); }
        overlay.querySelector('[data-action="cancel"]').addEventListener('click', () => cleanup(null));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(null); });
        overlay.querySelector('[data-action="confirm"]').addEventListener('click', () => {
            const val = input.value.trim();
            if (!val) { alert('Please enter a reason.'); return; }
            cleanup(val);
        });
    });
}

function checkIconSvg() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M20 6L9 17l-5-5"/></svg>';
}
function xIconSvg() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>';
}
function banIconSvg() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<circle cx="12" cy="12" r="10"/><path d="M4.9 4.9l14.2 14.2"/></svg>';
}

// ---------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------
const leavesContent = document.getElementById('leavesContent');
const statsGrid = document.getElementById('statsGrid');
const refreshListBtn = document.getElementById('refreshListBtn');
const refreshListBtnLabel = document.getElementById('refreshListBtnLabel');
const manageTypesBtn = document.getElementById('manageTypesBtn');
const newRequestBtn = document.getElementById('newRequestBtn');

const myRequestsBody = document.getElementById('myRequestsBody');
const teamRequestsCard = document.getElementById('teamRequestsCard');
const teamRequestsTitle = document.getElementById('teamRequestsTitle');
const teamRequestsPendingPill = document.getElementById('teamRequestsPendingPill');
const teamRequestsBody = document.getElementById('teamRequestsBody');

const leaveRequestForm = document.getElementById('leaveRequestForm');
const onBehalfOfField = document.getElementById('onBehalfOfField');
const onBehalfOfHint = document.getElementById('onBehalfOfHint');
const requestEmployeeSelect = document.getElementById('requestEmployeeSelect');
const leaveTypeInput = document.getElementById('leaveTypeInput');
const startDateInput = document.getElementById('startDateInput');
const startHalfDayInput = document.getElementById('startHalfDayInput');
const endDateInput = document.getElementById('endDateInput');
const endHalfDayInput = document.getElementById('endHalfDayInput');
const reasonInput = document.getElementById('reasonInput');
const daysPreview = document.getElementById('daysPreview');
const leaveRequestSubmitBtn = document.getElementById('leaveRequestSubmitBtn');

const newLeaveTypeInput = document.getElementById('newLeaveTypeInput');
const addLeaveTypeBtn = document.getElementById('addLeaveTypeBtn');
const leaveTypesManageList = document.getElementById('leaveTypesManageList');

window.addEventListener('ess:ready', onEssReady);

async function onEssReady(e) {
    const { session, employee } = e.detail;
    if (!session) return; // sidebar.js already redirected to login, or Supabase isn't configured

    isAdmin = employee?.role === 1;
    myEmployeeName = employee?.name || '';

    const { data: me, error } = await sb
        .from('employees')
        .select('id')
        .eq('auth_user_id', session.user.id)
        .maybeSingle();
    if (error || !me) {
        console.error('leaves: could not resolve current employee record:', error);
        showToast('Could not load your employee profile.', 'danger');
        return;
    }
    myEmployeeId = me.id;

    leavesContent.style.display = 'block';
    await init();
}

async function init() {
    leaveRequestModal = new bootstrap.Modal(document.getElementById('leaveRequestModal'));
    manageTypesModal = new bootstrap.Modal(document.getElementById('manageTypesModal'));

    await checkSupervisorStatus();
    applyRoleVisibility();
    wireEvents();

    await Promise.all([loadLeaveTypes(), loadSelectableEmployees()]);
    populateLeaveTypeSelect();
    populateEmployeeSelect();

    await loadRequests();
}

function applyRoleVisibility() {
    manageTypesBtn.classList.toggle('hidden', !isAdmin);
}

function wireEvents() {
    refreshListBtn.addEventListener('click', onRefreshClick);
    newRequestBtn.addEventListener('click', () => openLeaveRequestModal());
    leaveRequestForm.addEventListener('submit', onSubmitLeaveRequest);
    [startDateInput, endDateInput, startHalfDayInput, endHalfDayInput].forEach(el =>
        el.addEventListener('change', updateDaysPreview)
    );

    manageTypesBtn.addEventListener('click', openManageTypesModal);
    addLeaveTypeBtn.addEventListener('click', onAddLeaveType);
}

async function onRefreshClick() {
    if (refreshListBtn.disabled) return;
    refreshListBtn.disabled = true;
    refreshListBtn.classList.add('is-refreshing');
    refreshListBtnLabel.textContent = 'Refreshing…';
    try {
        await loadRequests();
    } finally {
        refreshListBtn.classList.remove('is-refreshing');
        refreshListBtnLabel.textContent = 'Refresh';
        refreshListBtn.disabled = false;
    }
}

// ---------------------------------------------------------------------
// Supervisor detection (is anyone's supervisor_id == me?) — used only to
// decide whether to show the "team requests" card title as such; RLS
// already governs what rows actually come back regardless.
// ---------------------------------------------------------------------
async function checkSupervisorStatus() {
    const { count, error } = await sb
        .from('employees')
        .select('id', { count: 'exact', head: true })
        .eq('supervisor_id', myEmployeeId);
    if (error) {
        console.error('leaves: could not check supervisor status:', error);
        return;
    }
    isSupervisor = (count ?? 0) > 0;
}

// ---------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------
async function loadLeaveTypes() {
    const { data, error } = await sb
        .from('leave_types')
        .select('leave_type_id, leave_type, is_active')
        .order('leave_type');
    if (error) {
        console.error('leaves: could not load leave types:', error);
        showToast('Could not load leave types: ' + error.message, 'danger');
        return;
    }
    leaveTypes = data || [];
    activeLeaveTypes = leaveTypes.filter(t => t.is_active !== false);
}

// Admins can file for anyone (existing full-directory read they already
// have elsewhere). Everyone else goes through list_my_leave_delegates(),
// a SECURITY DEFINER RPC scoped server-side to "same department, not my
// own supervisor" — the exact set leave_requests_insert's RLS check
// will actually allow, kept in sync with can_request_leave_for().
async function loadSelectableEmployees() {
    if (isAdmin) {
        const { data, error } = await sb
            .from('employees')
            .select('id, name, employee_id')
            .is('last_day', null)
            .order('name');
        if (error) {
            console.error('leaves: could not load employees:', error);
            return;
        }
        selectableEmployees = data || [];
        return;
    }

    const { data, error } = await sb.rpc('list_my_leave_delegates');
    if (error) {
        console.error('leaves: could not load teammates:', error);
        return;
    }
    selectableEmployees = data || [];
}

function populateLeaveTypeSelect() {
    leaveTypeInput.innerHTML = activeLeaveTypes
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
    onBehalfOfField.classList.toggle('hidden', !isAdmin && others.length === 0);

    onBehalfOfHint.textContent = isAdmin
        ? 'Choosing anyone other than yourself creates the request already approved.'
        : 'You can also file this for a teammate in your department (not your supervisor) — it stays pending, same as your own requests, and needs their supervisor\u2019s approval.';
}

// ---------------------------------------------------------------------
// Requests: one fetch, RLS-scoped (mine +, if applicable, my team's)
// ---------------------------------------------------------------------
async function loadRequests() {
    const { data, error } = await sb
        .from('leave_requests')
        .select(`
            id, employee_id, leave_type_id, start_date, start_half_day, end_date, end_half_day,
            total_days, reason, status, rejection_reason, approved_at, created_at,
            employee:employee_id(name, employee_id),
            leave_type:leave_type_id(leave_type),
            approver:approved_by(name)
        `)
        .order('created_at', { ascending: false });

    if (error) {
        console.error('leaves: could not load leave requests:', error);
        showToast('Could not load leave requests: ' + error.message, 'danger');
        return;
    }

    allRequests = data || [];
    renderStats();
    renderMyRequests();
    renderTeamRequests();
}

// ---------------------------------------------------------------------
// Stats strip
// ---------------------------------------------------------------------
function renderStats() {
    const thisYear = new Date().getFullYear();
    const mine = allRequests.filter(r => r.employee_id === myEmployeeId);

    const myPending = mine.filter(r => r.status === 0).length;
    const myDaysTakenThisYear = mine
        .filter(r => r.status === 1 && parseDateOnly(r.start_date).getFullYear() === thisYear)
        .reduce((sum, r) => sum + Number(r.total_days), 0);
    const teamPending = allRequests.filter(r => r.employee_id !== myEmployeeId && r.status === 0).length;
    const myUpcoming = mine.filter(r => r.status === 1 && parseDateOnly(r.end_date) >= new Date(new Date().toDateString())).length;

    const cards = [
        { key: 'myPending', label: 'My pending requests', value: myPending, variant: 'warning' },
        { key: 'myDays', label: `Days taken (${thisYear})`, value: myDaysTakenThisYear, variant: 'accent' },
        { key: 'myUpcoming', label: 'My upcoming approved leave', value: myUpcoming, variant: 'success' }
    ];
    if (isSupervisor || isAdmin) {
        cards.push({ key: 'teamPending', label: 'Team requests pending', value: teamPending, variant: 'info' });
    }

    statsGrid.innerHTML = cards.map(c => `
        <div class="stat-card stat-card--${c.variant}">
            <div class="stat-card-top">
                <span class="stat-card-label">${escapeHtml(c.label)}</span>
            </div>
            <span class="stat-card-value">${c.value}</span>
        </div>
    `).join('');
}

// ---------------------------------------------------------------------
// My requests table
// ---------------------------------------------------------------------
function renderMyRequests() {
    const mine = allRequests.filter(r => r.employee_id === myEmployeeId);

    if (mine.length === 0) {
        myRequestsBody.innerHTML = `<tr><td colspan="6"><div class="empty-state">No leave requests yet — click "New request" to submit one.</div></td></tr>`;
        return;
    }

    myRequestsBody.innerHTML = mine.map(r => `
        <tr>
            <td>${escapeHtml(embedded(r.leave_type, 'leave_type'))}</td>
            <td>${renderDateRange(r)}</td>
            <td>${r.total_days}</td>
            <td>
                <span class="status-badge ${STATUS_CLASS[r.status]}">${STATUS_LABEL[r.status]}</span>
                ${r.status === 2 && r.rejection_reason ? `<span class="rejection-note">${escapeHtml(r.rejection_reason)}</span>` : ''}
            </td>
            <td class="reason-col">${escapeHtml(r.reason || '—')}</td>
            <td class="actions-col">
                ${r.status === 0 ? `<button type="button" class="btn btn-outline-secondary btn-sm" data-cancel="${r.id}">Cancel</button>` : ''}
            </td>
        </tr>
    `).join('');

    myRequestsBody.querySelectorAll('[data-cancel]').forEach(btn => {
        btn.addEventListener('click', () => onCancelRequest(btn.dataset.cancel));
    });
}

// ---------------------------------------------------------------------
// Team requests table (only rows RLS lets me see beyond my own — i.e.
// I'm the requester's direct supervisor, or I'm an admin)
// ---------------------------------------------------------------------
function renderTeamRequests() {
    const team = allRequests.filter(r => r.employee_id !== myEmployeeId);

    if (team.length === 0) {
        teamRequestsCard.classList.add('hidden');
        return;
    }
    teamRequestsCard.classList.remove('hidden');
    teamRequestsTitle.textContent = isAdmin ? 'All other requests' : 'Requests to review';

    const pendingCount = team.filter(r => r.status === 0).length;
    if (pendingCount > 0) {
        teamRequestsPendingPill.textContent = pendingCount;
        teamRequestsPendingPill.classList.remove('hidden');
    } else {
        teamRequestsPendingPill.classList.add('hidden');
    }

    teamRequestsBody.innerHTML = team.map(r => `
        <tr>
            <td class="employee-col">${escapeHtml(embedded(r.employee, 'name'))}</td>
            <td>${escapeHtml(embedded(r.leave_type, 'leave_type'))}</td>
            <td>${renderDateRange(r)}</td>
            <td>${r.total_days}</td>
            <td>
                <span class="status-badge ${STATUS_CLASS[r.status]}">${STATUS_LABEL[r.status]}</span>
                ${r.status !== 0 && embedded(r.approver, 'name') ? `<div class="half-day-tag">by ${escapeHtml(embedded(r.approver, 'name'))}</div>` : ''}
            </td>
            <td class="reason-col">${escapeHtml(r.reason || '—')}</td>
            <td class="actions-col">
                ${r.status === 0 ? `
                    <button type="button" class="btn-icon-only" title="Approve" data-approve="${r.id}">${checkIconSvg()}</button>
                    <button type="button" class="btn-icon-only" title="Reject" data-reject="${r.id}">${xIconSvg()}</button>
                ` : ''}
            </td>
        </tr>
    `).join('');

    teamRequestsBody.querySelectorAll('[data-approve]').forEach(btn => {
        btn.addEventListener('click', () => onReviewRequest(btn.dataset.approve, 'approved'));
    });
    teamRequestsBody.querySelectorAll('[data-reject]').forEach(btn => {
        btn.addEventListener('click', () => onReviewRequest(btn.dataset.reject, 'rejected'));
    });
}

function renderDateRange(r) {
    const start = formatDateShort(r.start_date);
    const startHalf = r.start_half_day !== 'full' ? ` <span class="half-day-tag">(${HALF_DAY_LABEL[r.start_half_day]})</span>` : '';
    if (r.start_date === r.end_date) {
        return `${start}${startHalf}`;
    }
    const end = formatDateShort(r.end_date);
    const endHalf = r.end_half_day !== 'full' ? ` <span class="half-day-tag">(${HALF_DAY_LABEL[r.end_half_day]})</span>` : '';
    return `${start}${startHalf} – ${end}${endHalf}`;
}

// ---------------------------------------------------------------------
// New request modal
// ---------------------------------------------------------------------
function openLeaveRequestModal() {
    leaveRequestForm.reset();
    if (!onBehalfOfField.classList.contains('hidden')) requestEmployeeSelect.value = myEmployeeId;
    startHalfDayInput.value = 'full';
    endHalfDayInput.value = 'full';
    daysPreview.textContent = '';
    leaveRequestModal.show();
}

// Client-side preview only — total_days is always authoritative from
// calculate_leave_request_total_days() server-side; this just mirrors
// that formula so the person sees an estimate before submitting.
function updateDaysPreview() {
    const start = startDateInput.value;
    const end = endDateInput.value;
    if (!start || !end) { daysPreview.textContent = ''; return; }
    const startD = parseDateOnly(start);
    const endD = parseDateOnly(end);
    if (endD < startD) { daysPreview.textContent = 'End date must be on or after the start date.'; return; }

    let days;
    if (start === end) {
        days = startHalfDayInput.value === 'full' ? 1 : 0.5;
    } else {
        const dayCount = Math.round((endD - startD) / 86400000) + 1;
        days = dayCount
            - (startHalfDayInput.value !== 'full' ? 0.5 : 0)
            - (endHalfDayInput.value !== 'full' ? 0.5 : 0);
    }
    daysPreview.innerHTML = `≈ <strong>${days}</strong> day(s)`;
}

async function onSubmitLeaveRequest(e) {
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
    if (startDate === endDate && startHalfDayInput.value !== endHalfDayInput.value) {
        showToast('For a single-day request, the start and end half-day must match.', 'danger');
        return;
    }

    // The field is only ever hidden when there's nothing but "Myself" to
    // choose from (see populateEmployeeSelect), so falling back to my own
    // id covers that case; otherwise it always reflects the picker.
    const targetEmployeeId = onBehalfOfField.classList.contains('hidden')
        ? myEmployeeId
        : requestEmployeeSelect.value;

    const payload = {
        employee_id: targetEmployeeId,
        leave_type_id: Number(leaveTypeInput.value),
        start_date: startDate,
        start_half_day: startHalfDayInput.value,
        end_date: endDate,
        end_half_day: endHalfDayInput.value,
        reason: reasonInput.value.trim() || null
    };

    leaveRequestSubmitBtn.disabled = true;
    const { error } = await sb.from('leave_requests').insert(payload);
    leaveRequestSubmitBtn.disabled = false;

    if (error) {
        if (error.code === '42501' || /row-level security/i.test(error.message || '')) {
            showToast('You can only file leave for yourself or a same-department teammate (not your supervisor).', 'danger');
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
    await loadRequests();
}

// ---------------------------------------------------------------------
// Cancel / approve / reject
// ---------------------------------------------------------------------
async function onCancelRequest(requestId) {
    const confirmed = await showConfirmDialog({
        title: 'Cancel this request?',
        message: 'This leave request will be marked as cancelled. This cannot be undone.',
        confirmLabel: 'Cancel request',
        danger: true
    });
    if (!confirmed) return;

    const { error } = await sb.rpc('cancel_leave_request', { p_request_id: requestId });
    if (error) {
        showToast('Could not cancel request: ' + error.message, 'danger');
        return;
    }
    showToast('Request cancelled.', 'success');
    await loadRequests();
}

async function onReviewRequest(requestId, decision) {
    let rejectionReason = null;

    if (decision === 'rejected') {
        rejectionReason = await promptTextDialog({
            title: 'Reject this request?',
            message: 'Please provide a reason — this will be shown to the employee.',
            confirmLabel: 'Reject request',
            placeholder: 'e.g. Team is short-staffed that week'
        });
        if (rejectionReason === null) return; // cancelled
    } else {
        const confirmed = await showConfirmDialog({
            title: 'Approve this request?',
            message: 'The employee will be notified that their leave is approved.',
            confirmLabel: 'Approve'
        });
        if (!confirmed) return;
    }

    const { error } = await sb.rpc('review_leave_request', {
        p_request_id: requestId,
        p_decision: decision,
        p_rejection_reason: rejectionReason
    });
    if (error) {
        showToast('Could not review request: ' + error.message, 'danger');
        return;
    }
    showToast(decision === 'approved' ? 'Request approved.' : 'Request rejected.', 'success');
    await loadRequests();
}

// ---------------------------------------------------------------------
// Manage leave types (admin) — add new / enable / disable. Same
// enable-disable-not-delete pattern as positions/departments/business
// units in employees.js's lookup manager, since existing requests keep
// referencing a type even after it's retired from new use.
// ---------------------------------------------------------------------
function openManageTypesModal() {
    newLeaveTypeInput.value = '';
    renderManageTypesList();
    manageTypesModal.show();
}

function renderManageTypesList() {
    if (leaveTypes.length === 0) {
        leaveTypesManageList.innerHTML = '<div class="lookup-manage-empty">No leave types yet.</div>';
        return;
    }
    leaveTypesManageList.innerHTML = leaveTypes.map(t => `
        <div class="lookup-manage-row ${t.is_active === false ? 'is-disabled' : ''}">
            <span class="lookup-manage-name">${escapeHtml(t.leave_type)}</span>
            <div class="lookup-manage-row-actions">
                <button type="button" class="btn btn-sm ${t.is_active === false ? 'btn-outline-accent' : 'btn-ghost'}" data-toggle-type="${t.leave_type_id}" data-next="${t.is_active === false}">
                    ${t.is_active === false ? 'Enable' : 'Disable'}
                </button>
            </div>
        </div>
    `).join('');

    leaveTypesManageList.querySelectorAll('[data-toggle-type]').forEach(btn => {
        btn.addEventListener('click', () => onToggleLeaveType(btn.dataset.toggleType, btn.dataset.next === 'true'));
    });
}

async function onAddLeaveType() {
    const name = newLeaveTypeInput.value.trim();
    if (!name) { showToast('Enter a name for the new leave type.', 'danger'); return; }

    addLeaveTypeBtn.disabled = true;
    const { error } = await sb.from('leave_types').insert({ leave_type: name });
    addLeaveTypeBtn.disabled = false;

    if (error) {
        if (error.code === '23505') {
            showToast(`"${name}" already exists.`, 'danger');
        } else {
            showToast('Could not add leave type: ' + error.message, 'danger');
        }
        return;
    }

    newLeaveTypeInput.value = '';
    await loadLeaveTypes();
    populateLeaveTypeSelect();
    renderManageTypesList();
    showToast('Leave type added.', 'success');
}

async function onToggleLeaveType(leaveTypeId, nextActive) {
    const { error } = await sb.from('leave_types')
        .update({ is_active: nextActive })
        .eq('leave_type_id', leaveTypeId);
    if (error) {
        showToast('Could not update leave type: ' + error.message, 'danger');
        return;
    }
    await loadLeaveTypes();
    populateLeaveTypeSelect();
    renderManageTypesList();
    showToast(nextActive ? 'Leave type enabled.' : 'Leave type disabled.', 'success');
}
