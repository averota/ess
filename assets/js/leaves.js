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
//     file just splits the same result set client-side (see
//     isTeamRequest(): by employee_id, plus whether I'm an admin or the
//     employee's direct supervisor).
//   - Approve/reject always go through review_leave_request() (pending
//     only, supervisor/admin). A rejection needs a reason (rejection_reason).
//     An approval may carry an optional comment, stored in
//     leave_requests.review_comment by a follow-up call to
//     set_leave_review_comment() — see supabase/04_leave_review_comment.sql.
//   - Edit/Cancel on a still-PENDING request are available to whoever
//     can see it, regardless of role — own pending in "My leave", or a
//     team member's pending row in the "Team requests" tab if you're
//     an admin. Cancel goes through
//     cancel_leave_request(); that RPC's own internal check needs to
//     permit a supervisor/admin to cancel someone else's pending
//     request too, not just the requester themselves — confirm that on
//     the DB side if team-tab cancel comes back 42501. Edit is a plain
//     table update (pending rows only, so nothing else can be racing
//     against it).
//   - Edit/Cancel on a request that is APPROVED or REJECTED are
//     admin-only, regardless of whose request it is — a regular user
//     (employee or supervisor) can't touch it once it's out of pending.
//     Admin edit is a direct table update; admin cancel force-sets
//     status = 3 directly rather than going through
//     cancel_leave_request(), since that RPC only transitions
//     still-pending requests. Both assume RLS already grants admins
//     UPDATE on leave_requests (as it does for leave_types) — if that
//     grant isn't in place yet, these will fail with a 42501 until the
//     corresponding policy is added.
//   - Inserting a new request never sets employee_id/requested_by/status
//     directly for a non-admin — trg_leave_requests_defaults overwrites
//     those server-side regardless of what the client sends. For an
//     admin creating on behalf of someone else, that same trigger
//     auto-approves it (no separate "approve" step needed here).
// =====================================================================

let leaveRequestModal;
let manageTypesModal;
let leaveDetailModal;

let myEmployeeId = null;   // employees.id (uuid) — not the human-readable employee_id
let myEmployeeName = '';
let isAdmin = false;
let initialized = false;    // guards against ess:ready firing more than once (would double-wire every listener)

let leaveTypes = [];        // all rows (active + inactive), for the admin manage-types list
let activeLeaveTypes = [];  // active-only, for the request form's select
let selectableEmployees = []; // who I can file a request for, besides myself — admin: everyone; everyone else: same-department teammates minus their own supervisor (see list_my_leave_delegates())
let myReportIds = new Set(); // employees.id of my direct reports (non-admin only; admins already have authority over everyone)
let reviewCommentSupported = true;    // flipped off if leave_requests.review_comment doesn't exist yet (see loadRequests)
let supervisorEmbedSupported = true; // flipped off if PostgREST can't resolve the nested supervisor lookup (see loadRequests)
let approverByEmployee = new Map(); // employees.id -> that employee's supervisor {id, name, employee_id}, from list_leave_approvers() — fills in names the nested embed can't read under RLS (non-admins)
let approverRpcSupported = true;    // flipped off if list_leave_approvers() isn't installed (see loadApproverDirectory)
let allRequests = [];       // everything RLS lets me see: mine + (if supervisor/admin) my team's

let showOnBehalfField = false; // set by populateEmployeeSelect() — whether the "Requesting for" picker has anything besides "Myself" to offer
let editingRequestId = null;   // set while the modal is editing an existing request instead of creating a new one

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

function formatDateLong(dateStr) {
    const d = parseDateOnly(dateStr);
    if (!d || isNaN(d)) return '—';
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateTime(iso) {
    const d = iso ? new Date(iso) : null;
    if (!d || isNaN(d)) return '';
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// Plain string comparison works here since dates are always 'YYYY-MM-DD'
// (lexicographic order == chronological order for that format).
function dateRangesOverlap(aStart, aEnd, bStart, bEnd) {
    return aStart <= bEnd && bStart <= aEnd;
}

// Client-side heads-up only — checks whole-day overlap (not AM/PM) for
// the given employee against requests already in `allRequests` that are
// still pending or approved (status 0/1; cancelled/rejected don't
// block), across every leave type, excluding `excludeId` so editing a
// request doesn't flag itself.
//
// IMPORTANT: this can only warn about overlaps the current user's RLS
// visibility actually includes — mine, or (if I'm their supervisor or
// an admin) a team member's. A non-admin filing on behalf of a same-
// department teammate they don't supervise (list_my_leave_delegates())
// won't have that teammate's existing requests in `allRequests`, so
// this check can't catch a conflict there. The real backstop is the
// leave_requests_no_overlap exclusion constraint in
// 03_leave_requests_no_overlap.sql, which always applies server-side
// regardless of what the client can see.
function findOverlappingRequest(employeeId, startDate, endDate, excludeId = null) {
    return allRequests.find(r =>
        r.employee_id === employeeId &&
        r.id !== excludeId &&
        (r.status === 0 || r.status === 1) &&
        dateRangesOverlap(startDate, endDate, r.start_date, r.end_date)
    ) || null;
}

function describeOverlap(req) {
    const range = req.start_date === req.end_date
        ? formatDateShort(req.start_date)
        : `${formatDateShort(req.start_date)} – ${formatDateShort(req.end_date)}`;
    const type = embedded(req.leave_type, 'leave_type') || 'leave';
    const statusWord = req.status === 0 ? 'pending' : 'approved';
    return `${range} (${type}, ${statusWord})`;
}

// Embedded relations (e.g. `employee:employee_id(name)`) can come back
// as either an object or a single-item array depending on the query
// shape — same quirk employees.js works around for supervisor_info.
function embedded(rel, key = 'name') {
    if (!rel) return '';
    if (Array.isArray(rel)) return rel[0]?.[key] || '';
    return rel[key] || '';
}

// "Name (ID)" wherever an employee is shown — falls back gracefully if
// either piece is missing (e.g. the embedded join came back empty).
function formatEmployeeName(rel) {
    const name = embedded(rel, 'name');
    const empId = embedded(rel, 'employee_id');
    if (!name) return empId || '—';
    return empId ? `${name} (${empId})` : name;
}

// The single employee row embedded in a request (object or one-item array).
function embeddedRow(rel) {
    return Array.isArray(rel) ? (rel[0] || null) : (rel || null);
}

// Who can approve a PENDING request: the employee's current direct
// supervisor (approval permission follows the current supervisor, so this
// stays accurate if it changes). Admins can approve any request too, which
// is why an employee with no supervisor assigned resolves to "admin".
// Returns '' rather than guessing when the supervisor info wasn't loaded.
// The table row uses the name alone to stay compact; the details view
// passes withId = true for "Name (ID)".
function pendingApproverName(r, withId = false) {
    if (r.status !== 0) return '';
    const emp = embeddedRow(r.employee);

    // Name from the nested embed when RLS allowed it, else from the RPC
    // (which also covers a teammate's row whose employee embed came back
    // empty).
    const sup = embeddedRow(emp?.supervisor) || approverByEmployee.get(r.employee_id) || null;
    if (sup) {
        if (sup.id === myEmployeeId) return 'you';
        return withId ? formatEmployeeName(sup) : (sup.name || formatEmployeeName(sup));
    }
    if (!emp) return '';                           // couldn't resolve the employee at all — say nothing rather than guess
    if (emp.supervisor_id) return 'supervisor';    // one is assigned, but neither route could read their name
    if (emp.supervisor_id === null) return 'admin'; // nobody assigned
    return '';                                     // supervisor info not loaded
}

// Second line under the status badge: "Awaiting <approver>" while pending,
// "by <approver>" once approved/rejected. Comments (approval note /
// rejection reason) live in the details view, not in the row.
function statusSubText(r) {
    if (r.status === 0) {
        const who = pendingApproverName(r);
        return who ? `Awaiting ${who}` : '';
    }
    if (r.status === 1 || r.status === 2) {
        const name = embedded(r.approver, 'name');
        return name ? `by ${name}` : '';
    }
    return '';
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

// Small dialog to collect a line of text. Resolves to the trimmed text
// ('' if left blank when `required` is false), or null if cancelled.
//  - Rejection reason: required (default) — the DB itself won't accept a
//    rejection without one, see leave_requests_rejection_reason_check.
//  - Approval comment: `required: false, danger: false`.
function promptTextDialog({ title, message, confirmLabel = 'Confirm', placeholder = '', required = true, danger = true, maxLength = 0 }) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal-box">
                <h3>${escapeHtml(title)}</h3>
                <p>${message}</p>
                <textarea class="form-control form-control-sm mb-2" id="promptTextInput" rows="3" placeholder="${escapeHtml(placeholder)}"${maxLength ? ` maxlength="${maxLength}"` : ''}></textarea>
                <div class="modal-actions">
                    <button type="button" class="btn btn-outline-secondary btn-sm" data-action="cancel">Cancel</button>
                    <button type="button" class="btn ${danger ? 'btn-rose' : 'btn-accent'} btn-sm" data-action="confirm">${escapeHtml(confirmLabel)}</button>
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
            if (!val && required) { alert('Please enter a reason.'); return; }
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
// Same pencil path used for the "Manage leave types" button in
// leaves.html, kept consistent for any other "edit this" affordance.
function pencilIconSvg() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';
}

function eyeIconSvg() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
}
function moreIconSvg() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>';
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

const myLeaveTab = document.getElementById('myLeaveTab');
const otherLeaveTab = document.getElementById('otherLeaveTab');
const otherLeaveTabItem = document.getElementById('otherLeaveTabItem');
const myRequestsPendingPill = document.getElementById('myRequestsPendingPill');
const teamRequestsPendingPill = document.getElementById('teamRequestsPendingPill');

const myRequestsBody = document.getElementById('myRequestsBody');
const teamRequestsBody = document.getElementById('teamRequestsBody');

const leaveRequestForm = document.getElementById('leaveRequestForm');
const leaveRequestModalTitle = document.getElementById('leaveRequestModalTitle');
const onBehalfOfField = document.getElementById('onBehalfOfField');
const onBehalfOfHint = document.getElementById('onBehalfOfHint');
const requestEmployeeSelect = document.getElementById('requestEmployeeSelect');
const editingForBanner = document.getElementById('editingForBanner');
const editingForText = document.getElementById('editingForText');
const leaveTypeInput = document.getElementById('leaveTypeInput');
const startDateInput = document.getElementById('startDateInput');
const startHalfDayInput = document.getElementById('startHalfDayInput');
const endDateInput = document.getElementById('endDateInput');
const endHalfDayInput = document.getElementById('endHalfDayInput');
const reasonInput = document.getElementById('reasonInput');
const daysPreview = document.getElementById('daysPreview');
const leaveRequestSubmitBtn = document.getElementById('leaveRequestSubmitBtn');

const leaveDetailModalEl = document.getElementById('leaveDetailModal');
const leaveDetailStatus = document.getElementById('leaveDetailStatus');
const leaveDetailBody = document.getElementById('leaveDetailBody');
const leaveDetailActions = document.getElementById('leaveDetailActions');

const newLeaveTypeInput = document.getElementById('newLeaveTypeInput');
const addLeaveTypeBtn = document.getElementById('addLeaveTypeBtn');
const leaveTypesManageList = document.getElementById('leaveTypesManageList');

// Filter bar (Leave type / Year / Status) — same collapsible design as
// the employee directory's filter bar in employees.js.
const filterLeaveTypeBtn = document.getElementById('filterLeaveTypeBtn');
const filterLeaveTypeList = document.getElementById('filterLeaveTypeList');
const filterYearInput = document.getElementById('filterYearInput');
const filterStatusInput = document.getElementById('filterStatusInput');
const filterEmployeeInput = document.getElementById('filterEmployeeInput'); // Team requests tab only
const clearAllFiltersBtn = document.getElementById('clearAllFiltersBtn');
const activeFilterCount = document.getElementById('activeFilterCount');

// Selected leave_type_id values (as strings) for the Leave type checkbox
// multi-select filter. Empty set == "all" (no filtering on it).
const filterSelection = {
    leaveTypes: new Set()
};
let filteredRequests = []; // allRequests after Leave type / Year / Status filters are applied

window.addEventListener('ess:ready', onEssReady);

async function onEssReady(e) {
    if (initialized) return;
    const { session, employee } = e.detail;
    if (!session) return; // sidebar.js already redirected to login, or Supabase isn't configured
    initialized = true;   // claimed synchronously so a second ess:ready can't slip in during the await below

    isAdmin = employee?.role === 1;
    myEmployeeName = employee?.name || '';

    const { data: me, error } = await sb
        .from('employees')
        .select('id')
        .eq('auth_user_id', session.user.id)
        .maybeSingle();
    if (error || !me) {
        initialized = false;
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
    leaveDetailModal = new bootstrap.Modal(leaveDetailModalEl);

    applyRoleVisibility();
    wireEvents();
    populateYearFilter();

    // Request rows carry their own embedded leave_type / employee names,
    // so the lookups and the requests load together — except that
    // splitting rows into "My leave" vs "Team requests" needs my direct
    // reports, so the requests fetch waits on that one (skipped for admins).
    await Promise.all([
        loadLeaveTypes(),
        loadSelectableEmployees(),
        loadMyReports().then(loadRequests)
    ]);
    populateLeaveTypeSelect();
    populateEmployeeSelect();
    populateLeaveTypeFilter();
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

    filterYearInput.addEventListener('change', applyFilters);
    filterStatusInput.addEventListener('change', applyFilters);
    filterEmployeeInput.addEventListener('change', applyFilters);
    // The Employees filter only exists on the Team requests tab, so its
    // visibility (and its share of the active-filter badge) follows the
    // active tab. 'shown.bs.tab' also fires for programmatic Tab.show().
    myLeaveTab.addEventListener('shown.bs.tab', onLeavesTabChanged);
    otherLeaveTab.addEventListener('shown.bs.tab', onLeavesTabChanged);
    wireMultiSelectFilter(filterLeaveTypeList, filterSelection.leaveTypes);
    document.querySelectorAll('.btn-link-clear[data-clear-target]').forEach(btn => {
        btn.addEventListener('click', () => onClearMultiSelectFilter(btn.dataset.clearTarget));
    });
    clearAllFiltersBtn.addEventListener('click', clearAllFilters);
    initFilterDropdowns();

    // One delegated listener per table instead of re-binding every
    // button on every render.
    myRequestsBody.addEventListener('click', onRowActionClick);
    teamRequestsBody.addEventListener('click', onRowActionClick);

    // Action buttons inside the details modal's footer (same actions as the
    // row's dropdown). The modal closes first: the confirm/prompt dialogs
    // and the edit modal can't take focus while this modal is trapping it.
    leaveDetailActions.addEventListener('click', (e) => {
        const btn = e.target.closest(ROW_ACTION_SELECTOR);
        if (!btn) return;
        leaveDetailModalEl.addEventListener('hidden.bs.modal', () => dispatchRowAction(btn), { once: true });
        leaveDetailModal.hide();
    });
}

async function onRefreshClick() {
    if (refreshListBtn.disabled) return;
    refreshListBtn.disabled = true;
    refreshListBtn.classList.add('is-refreshing');
    refreshListBtnLabel.textContent = 'Refreshing…';
    try {
        await loadMyReports();
        await loadRequests();
    } finally {
        refreshListBtn.classList.remove('is-refreshing');
        refreshListBtnLabel.textContent = 'Refresh';
        refreshListBtn.disabled = false;
    }
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

// Direct reports: the employees I can review leave for as their supervisor.
// Needed to tell "I filed this for someone I supervise" (actionable, goes
// in Team requests) from "I filed this for a teammate" (read-only, stays
// in My leave). Admins don't need it — they have authority over everyone.
// On failure the previous set is kept, so behavior degrades to the old split.
async function loadMyReports() {
    if (isAdmin) return;
    const { data, error } = await sb
        .from('employees')
        .select('id')
        .eq('supervisor_id', myEmployeeId);
    if (error) {
        console.error('leaves: could not load direct reports:', error);
        return;
    }
    myReportIds = new Set((data || []).map(e => e.id));
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

// ---------------------------------------------------------------------
// Request filters (Leave type / Year / Status)
// ---------------------------------------------------------------------

// Leave type filter intentionally lists disabled types too (same as the
// Department/Business unit filters on the employee directory), so past
// requests filed under a since-disabled type can still be found.
function populateLeaveTypeFilter() {
    renderMultiSelectList(filterLeaveTypeList, leaveTypes, 'leave_type_id', 'leave_type', 'lt', filterSelection.leaveTypes);
    updateMultiSelectButtonLabel(filterLeaveTypeBtn, 'Leave type', filterSelection.leaveTypes);
}

// Years 2025 → current year (by the request's start date), defaulting
// to the current year.
function populateYearFilter() {
    const currentYear = new Date().getFullYear();
    const startYear = 2025;
    let options = '';
    for (let y = startYear; y <= currentYear; y++) {
        options += `<option value="${y}">${y}</option>`;
    }
    filterYearInput.innerHTML = options || `<option value="${currentYear}">${currentYear}</option>`;
    filterYearInput.value = String(currentYear);
}

// Builds the checkbox list inside the Leave type filter dropdown,
// keeping any selection that's still valid (e.g. after loadLeaveTypes()
// re-fetches because a new type was just added). Generic over
// value/label keys, same helper shape as the employee directory's.
function renderMultiSelectList(listEl, rows, valueKey, labelKey, idPrefix, selectedSet) {
    const validValues = new Set(rows.map(r => String(r[valueKey])));
    Array.from(selectedSet).forEach(v => { if (!validValues.has(v)) selectedSet.delete(v); });

    if (rows.length === 0) {
        listEl.innerHTML = '<div class="filter-multiselect-empty">None yet</div>';
        return;
    }

    listEl.innerHTML = rows.map(r => {
        const value = String(r[valueKey]);
        const id = `filterOpt_${idPrefix}_${value}`;
        const checked = selectedSet.has(value) ? 'checked' : '';
        return `
            <div class="form-check">
                <input class="form-check-input" type="checkbox" value="${escapeHtml(value)}" id="${id}" ${checked}>
                <label class="form-check-label" for="${id}">${escapeHtml(r[labelKey])}</label>
            </div>`;
    }).join('');
}

// Delegated listener: any checkbox toggled inside the list updates the
// backing Set and re-applies filters immediately (menu stays open thanks
// to data-bs-auto-close="outside" on the dropdown toggle button).
function wireMultiSelectFilter(listEl, selectedSet) {
    listEl.addEventListener('change', (e) => {
        const cb = e.target;
        if (cb.type !== 'checkbox') return;
        if (cb.checked) selectedSet.add(cb.value);
        else selectedSet.delete(cb.value);

        updateMultiSelectButtonLabel(filterLeaveTypeBtn, 'Leave type', selectedSet);
        applyFilters();
    });
}

function resetLeaveTypeFilter() {
    filterSelection.leaveTypes.clear();
    filterLeaveTypeList.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = false; });
    updateMultiSelectButtonLabel(filterLeaveTypeBtn, 'Leave type', filterSelection.leaveTypes);
}

function onClearMultiSelectFilter(target) {
    if (target !== 'leaveType') return;
    resetLeaveTypeFilter();
    applyFilters();
}

function updateMultiSelectButtonLabel(btn, label, selectedSet) {
    btn.textContent = selectedSet.size > 0 ? `${label} (${selectedSet.size})` : label;
    btn.classList.toggle('active-filter', selectedSet.size > 0);
}

// The Leave type menu lives inside #leavesTabsCard, a .room-manage-card
// with `overflow: hidden` — same clipping concern as the employee
// directory's filter dropdowns. A "fixed" Popper strategy positions the
// menu relative to the viewport instead, so it's never clipped.
function initFilterDropdowns() {
    const fixedPopperConfig = (defaultConfig) => ({ ...defaultConfig, strategy: 'fixed' });
    new bootstrap.Dropdown(filterLeaveTypeBtn, { popperConfig: fixedPopperConfig });
}

// Resets every filter control (leave type, year, status) in one go.
function clearAllFilters() {
    resetLeaveTypeFilter();
    filterYearInput.value = String(new Date().getFullYear());
    filterStatusInput.value = '';
    filterEmployeeInput.value = '';
    applyFilters();
}

// Filters allRequests down into filteredRequests, then re-renders both
// tabs from it (the Employees filter only narrows Team requests rows). Stats (renderStats()) intentionally stay based on the
// full, unfiltered allRequests — the stat cards are a page-level
// summary, not scoped to whatever's currently filtered in the tables.
function applyFilters() {
    const typeFilter = filterSelection.leaveTypes; // Set of leave_type_id strings, empty = all
    const yearFilter = filterYearInput.value;       // e.g. '2026'
    const statusFilter = filterStatusInput.value;   // '', '0'..'3'
    const employeeFilter = filterEmployeeInput.value; // '' or an employees.id — applies to Team requests rows only

    filteredRequests = allRequests.filter(r => {
        if (employeeFilter && !isMineRequest(r) && r.employee_id !== employeeFilter) return false;
        if (typeFilter.size > 0 && !typeFilter.has(String(r.leave_type_id))) return false;
        if (yearFilter) {
            const start = parseDateOnly(r.start_date);
            if (!start || String(start.getFullYear()) !== yearFilter) return false;
        }
        if (statusFilter !== '' && String(r.status) !== statusFilter) return false;
        return true;
    });

    updateActiveFilterBadge();
    renderMyRequests();
    renderTeamRequests();
}

function isTeamTabActive() {
    return otherLeaveTab.classList.contains('active');
}

// Employees filter: single-select like Status, but only shown while the
// Team requests tab is open — My leave is just me (plus leave I filed for
// a teammate), so there's nothing to pick between there.
function syncEmployeeFilterVisibility() {
    filterEmployeeInput.classList.toggle('hidden', !isTeamTabActive());
}

function onLeavesTabChanged() {
    syncEmployeeFilterVisibility();
    updateActiveFilterBadge();
}

// Lists everyone who has at least one request in the (unfiltered) team
// set, so it never offers someone with nothing to show. Keeps the current
// pick across refreshes as long as that employee is still in the list.
function populateEmployeeFilter() {
    const current = filterEmployeeInput.value;
    const employees = new Map(); // employees.id -> "Name (ID)"
    for (const r of allRequests) {
        if (isTeamRequest(r) && !employees.has(r.employee_id)) {
            employees.set(r.employee_id, formatEmployeeName(r.employee));
        }
    }
    const sorted = Array.from(employees).sort((a, b) => a[1].localeCompare(b[1]));
    filterEmployeeInput.innerHTML = '<option value="">All employees</option>' +
        sorted.map(([id, label]) => `<option value="${escapeHtml(id)}">${escapeHtml(label)}</option>`).join('');
    filterEmployeeInput.value = employees.has(current) ? current : '';
}

// Year defaults to the current year (not an "all years" state), so it
// only counts toward the badge when the user has picked a different one.
function updateActiveFilterBadge() {
    let count = 0;
    if (filterSelection.leaveTypes.size > 0) count++;
    if (filterYearInput.value && filterYearInput.value !== String(new Date().getFullYear())) count++;
    if (filterStatusInput.value) count++;
    if (isTeamTabActive() && filterEmployeeInput.value) count++; // hidden (and not applicable) on My leave
    activeFilterCount.textContent = String(count);
    activeFilterCount.classList.toggle('d-none', count === 0);
    clearAllFiltersBtn.disabled = count === 0;
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
        : 'You can also file this for a teammate in your department (not your supervisor) — it stays pending, same as your own requests, and needs their supervisor\u2019s approval.';
}

// ---------------------------------------------------------------------
// Requests: one fetch, RLS-scoped (mine +, if applicable, my team's)
// ---------------------------------------------------------------------
// Supervisor names for the people whose requests I can see. A regular
// employee usually can't read other employees' rows (RLS), so the nested
// supervisor embed below comes back empty for them; this SECURITY DEFINER
// RPC (supabase/05_leave_approver_names.sql) supplies the names instead.
// Admins can read everyone, so they skip it. If the function isn't
// installed yet, stop asking and fall back to "Awaiting supervisor";
// any other error just keeps whatever was loaded last time.
async function loadApproverDirectory() {
    if (isAdmin || !approverRpcSupported) return;

    let data = null;
    let error = null;
    try {
        ({ data, error } = await sb.rpc('list_leave_approvers'));
    } catch (err) {
        error = err;
    }
    if (error) {
        console.warn('leaves: could not load approver names:', error);
        if (error.code === '42883' || /^PGRST/.test(error.code || '')) approverRpcSupported = false;
        return;
    }
    approverByEmployee = new Map((data || []).map(a => [a.out_employee, {
        id: a.out_supervisor,
        name: a.out_supervisor_name,
        employee_id: a.out_supervisor_code
    }]));
}

// Each request's employee comes with their supervisor (the person who can
// approve it while pending) so the tables can show "Awaiting <name>". That
// nested lookup is optional: `supervisor_id` tells us whether one is
// assigned at all, and the embed adds the name when RLS lets us read it.
function requestSelect() {
    const employeeCols = supervisorEmbedSupported
        ? 'name, employee_id, supervisor_id, supervisor:supervisor_id(id, name, employee_id)'
        : 'name, employee_id';
    return `
        id, employee_id, leave_type_id, start_date, start_half_day, end_date, end_half_day,
        total_days, reason, status, rejection_reason, approved_at, created_at, requested_by,${reviewCommentSupported ? ' review_comment,' : ''}
        employee:employee_id(${employeeCols}),
        leave_type:leave_type_id(leave_type),
        approver:approved_by(name)
    `;
}

function fetchRequestRows() {
    return sb
        .from('leave_requests')
        .select(requestSelect())
        .order('created_at', { ascending: false });
}

async function loadRequests() {
    const [rows] = await Promise.all([fetchRequestRows(), loadApproverDirectory()]);
    let { data, error } = rows;

    // Two optional extras ride along on this query — the approval comment
    // column and the nested supervisor lookup. If the database can't
    // resolve one of them (column not migrated yet: 42703; relationship
    // problems: PGRST…), drop just that one and retry, so the list still
    // loads. Network-level errors carry neither code and are not retried.
    for (let attempt = 0; error && attempt < 2; attempt++) {
        if (reviewCommentSupported && error.code === '42703' && /review_comment/.test(error.message || '')) {
            console.warn('leaves: review_comment column not found, loading without approval comments:', error);
            reviewCommentSupported = false;
        } else if (supervisorEmbedSupported && /^PGRST/.test(error.code || '')) {
            console.warn('leaves: approver lookup unavailable, loading requests without it:', error);
            supervisorEmbedSupported = false;
        } else {
            break;
        }
        ({ data, error } = await fetchRequestRows());
    }

    if (error) {
        console.error('leaves: could not load leave requests:', error);
        showToast('Could not load leave requests: ' + error.message, 'danger');
        return;
    }

    allRequests = data || [];
    renderStats();
    updateTabBadges();
    populateEmployeeFilter();
    applyFilters();
}

// ---------------------------------------------------------------------
// Stats strip
// ---------------------------------------------------------------------
// Days of an approved request that fall inside [rangeStart, rangeEnd]
// (inclusive; pass null for an open-ended side). Used to split approved
// leave around today: "taken" is Jan 1 → today, "upcoming" is tomorrow → ∞,
// so an in-progress request contributes to both and the two add up to its
// total_days.
//  - Request entirely inside the range: the server's total_days, as-is.
//  - Request crossing a range boundary: counted client-side over just the
//    slice inside the range, with the same formula updateDaysPreview()
//    mirrors from the server (calendar days, minus 0.5 for a half-day
//    start/end that's actually inside the slice).
//  - Request entirely outside the range: 0.
function daysWithinRange(r, rangeStart, rangeEnd) {
    const start = parseDateOnly(r.start_date);
    const end = parseDateOnly(r.end_date);

    const from = rangeStart && rangeStart > start ? rangeStart : start;
    const to = rangeEnd && rangeEnd < end ? rangeEnd : end;
    if (to < from) return 0;

    const startsInSlice = from.getTime() === start.getTime();
    const endsInSlice = to.getTime() === end.getTime();
    if (startsInSlice && endsInSlice) return Number(r.total_days);

    let days = Math.round((to - from) / 86400000) + 1;
    if (startsInSlice && r.start_half_day !== 'full') days -= 0.5;
    if (endsInSlice && r.end_half_day !== 'full') days -= 0.5;
    return days;
}

function renderStats() {
    const thisYear = new Date().getFullYear();
    const today = new Date(new Date().toDateString());
    const mine = allRequests.filter(r => r.employee_id === myEmployeeId);

    const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    const yearStart = new Date(thisYear, 0, 1);

    const approved = mine.filter(r => r.status === 1);
    const sumDays = (from, to) => approved.reduce((sum, r) => sum + daysWithinRange(r, from, to), 0);

    const myDaysTakenThisYear = sumDays(yearStart, today);  // Jan 1 → today
    const myUpcomingDays = sumDays(tomorrow, null);         // tomorrow → any future date, any year

    const cards = [
        { label: `Days taken (${thisYear})`, value: myDaysTakenThisYear, variant: 'accent' },
        { label: 'My upcoming approved leave', value: myUpcomingDays, variant: 'success' }
    ];

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
// Tab badges — pending counts on the "My leave" and "Team requests"
// tab titles, plus whether the Team tab is shown at all. Computed once
// per fetch from the *unfiltered* set: someone's real pending count
// shouldn't disappear just because the leave type/year/status filters
// currently hide it.
// ---------------------------------------------------------------------
function setPendingPill(pill, count) {
    pill.textContent = count;
    pill.classList.toggle('hidden', count === 0);
}

function updateTabBadges() {
    let myPending = 0;
    let teamTotal = 0;
    let teamPending = 0;
    for (const r of allRequests) {
        if (isMineRequest(r)) {
            if (r.status === 0) myPending++;
        } else {
            teamTotal++;
            if (r.status === 0) teamPending++;
        }
    }

    setPendingPill(myRequestsPendingPill, myPending);
    setPendingPill(teamRequestsPendingPill, teamPending);

    // teamTotal can only be nonzero for a supervisor or an admin (see the
    // note above renderTeamRequests), so it doubles as the tab's gate.
    otherLeaveTabItem.classList.toggle('hidden', teamTotal === 0);
    if (teamTotal === 0 && otherLeaveTab.classList.contains('active')) {
        // Don't leave the user on a pane whose tab just disappeared.
        bootstrap.Tab.getOrCreateInstance(myLeaveTab).show();
    }
}

// ---------------------------------------------------------------------
// Row helpers shared by both tables
// ---------------------------------------------------------------------

// Every row in allRequests belongs to exactly one tab:
//  - Team requests: someone else's leave that I have authority over —
//    anyone's if I'm an admin, my direct reports' if I'm their supervisor
//    — including leave I filed on their behalf (an admin creating leave
//    for an employee must still be able to find, edit and cancel it).
//    Rows RLS lets through for any other reason (e.g. an indirect
//    supervisor relationship) also land here, as before.
//  - My leave: everything else — my own leave, plus leave I filed for a
//    teammate I have no authority over (shown read-only; the filer should
//    still see what they submitted, even though it counts against the
//    teammate, not them).
function isTeamRequest(r) {
    if (r.employee_id === myEmployeeId) return false;
    if (isAdmin || myReportIds.has(r.employee_id)) return true;
    return r.requested_by !== myEmployeeId;
}
function isMineRequest(r) {
    return !isTeamRequest(r);
}

// Row actions. Every row shows a View button; whatever else the current
// user may do (approve / reject / edit / cancel) is grouped in a "More
// actions" dropdown, and repeated in the details modal's footer.
const ACTION_DEFS = {
    approve:     { label: 'Approve',        attr: 'data-approve',      icon: checkIconSvg,  tone: 'success', btn: 'btn-emerald' },
    reject:      { label: 'Reject',         attr: 'data-reject',       icon: xIconSvg,      tone: 'danger',  btn: 'btn-rose' },
    edit:        { label: 'Edit',           attr: 'data-edit',         icon: pencilIconSvg, tone: '',        btn: 'btn-outline-secondary' },
    cancel:      { label: 'Cancel request', attr: 'data-cancel',       icon: banIconSvg,    tone: 'danger',  btn: 'btn-outline-rose' },
    adminCancel: { label: 'Cancel request', attr: 'data-admin-cancel', icon: banIconSvg,    tone: 'danger',  btn: 'btn-outline-rose' }
};
const REVIEW_ACTIONS = ['approve', 'reject'];

// Which actions the current user gets on a request, in display order.
//  - "My leave" rows: only my own leave (a request I filed for a teammate
//    is read-only here). Pending: edit / cancel. Approved / rejected /
//    cancelled: admin-only edit, plus admin force-cancel unless it's
//    already cancelled.
//  - "Team requests" rows: pending gets approve / reject (supervisor or
//    admin), and edit / cancel for admins only. Once out of pending, the
//    same admin-only edit / force-cancel applies.
function getRowActions(r) {
    const actions = [];
    const adminPostReview = () => {
        if (!isAdmin) return;
        actions.push('edit');
        if (r.status !== 3) actions.push('adminCancel');
    };

    if (isMineRequest(r)) {
        if (r.employee_id !== myEmployeeId) return actions;
        if (r.status === 0) actions.push('edit', 'cancel');
        else adminPostReview();
    } else if (r.status === 0) {
        actions.push('approve', 'reject');
        if (isAdmin) actions.push('edit', 'cancel');
    } else {
        adminPostReview();
    }
    return actions;
}

function renderActionsCell(r) {
    const keys = getRowActions(r);
    const viewBtn = `<button type="button" class="btn-icon-only" title="View details" aria-label="View details" data-view="${r.id}">${eyeIconSvg()}</button>`;

    let menu = '';
    if (keys.length) {
        const item = (k) => {
            const d = ACTION_DEFS[k];
            return `<li><button type="button" class="dropdown-item${d.tone ? ' is-' + d.tone : ''}" ${d.attr}="${r.id}">${d.icon()}<span>${d.label}</span></button></li>`;
        };
        const review = keys.filter(k => REVIEW_ACTIONS.includes(k));
        const other = keys.filter(k => !REVIEW_ACTIONS.includes(k));
        menu = `
            <div class="dropdown row-more">
                <button type="button" class="btn-icon-only" data-bs-toggle="dropdown" aria-expanded="false" title="More actions" aria-label="More actions">${moreIconSvg()}</button>
                <ul class="dropdown-menu dropdown-menu-end row-actions-menu">
                    ${review.map(item).join('')}
                    ${review.length && other.length ? '<li><hr class="dropdown-divider"></li>' : ''}
                    ${other.map(item).join('')}
                </ul>
            </div>`;
    }
    return `<td class="actions-col"><div class="actions-wrap">${viewBtn}${menu}</div></td>`;
}

// The tables sit inside .table-scroll (overflow-x: auto), which would clip
// an absolutely-positioned menu on the last rows — so each row's dropdown
// is created with Popper's "fixed" strategy, which escapes that clipping.
// Instances are disposed before a re-render so replaced rows don't leak.
function disposeRowDropdowns(container) {
    container.querySelectorAll('[data-bs-toggle="dropdown"]').forEach(el => {
        bootstrap.Dropdown.getInstance(el)?.dispose();
    });
}
function initRowDropdowns(container) {
    container.querySelectorAll('[data-bs-toggle="dropdown"]').forEach(el => {
        bootstrap.Dropdown.getOrCreateInstance(el, {
            popperConfig: (defaults) => ({ ...defaults, strategy: 'fixed' })
        });
    });
}

const ROW_ACTIONS = {
    view: (id) => openLeaveDetail(id),
    edit: (id) => openLeaveRequestModal(id),
    cancel: (id) => onCancelRequest(id),
    adminCancel: (id) => onAdminCancelRequest(id),
    approve: (id) => onReviewRequest(id, 'approved'),
    reject: (id) => onReviewRequest(id, 'rejected')
};
const ROW_ACTION_SELECTOR = '[data-view], [data-edit], [data-cancel], [data-admin-cancel], [data-approve], [data-reject]';

function dispatchRowAction(btn) {
    for (const [key, handler] of Object.entries(ROW_ACTIONS)) {
        if (key in btn.dataset) {
            handler(btn.dataset[key]);
            return;
        }
    }
}

// Delegated click handler for both tables: action buttons / dropdown items,
// or a click anywhere else on a request row (outside the Action cell) to
// open its details.
function onRowActionClick(e) {
    const btn = e.target.closest(ROW_ACTION_SELECTOR);
    if (btn && e.currentTarget.contains(btn)) {
        dispatchRowAction(btn);
        return;
    }
    if (e.target.closest('.actions-col')) return;
    const row = e.target.closest('tr[data-request-id]');
    if (row && e.currentTarget.contains(row)) openLeaveDetail(row.dataset.requestId);
}

// ---------------------------------------------------------------------
// Compact cells shared by both tables
// ---------------------------------------------------------------------
function renderStatusCell(r) {
    const sub = statusSubText(r);
    return `<td class="status-cell">
        <span class="status-badge ${STATUS_CLASS[r.status]}">${STATUS_LABEL[r.status]}</span>
        ${sub ? `<span class="row-sub" title="${escapeHtml(sub)}">${escapeHtml(sub)}</span>` : ''}
    </td>`;
}

// One-line, ellipsis-truncated; the full text is in the tooltip and the
// details view.
function renderReasonCell(r) {
    return r.reason
        ? `<td class="reason-col" title="${escapeHtml(r.reason)}">${escapeHtml(r.reason)}</td>`
        : `<td class="reason-col"><span class="text-faint">—</span></td>`;
}

// Name on the first line, employee ID underneath.
function renderEmployeeCell(rel) {
    const name = embedded(rel, 'name');
    const empId = embedded(rel, 'employee_id');
    if (!name) return escapeHtml(empId || '—');
    return `${escapeHtml(name)}${empId ? `<span class="row-sub">${escapeHtml(empId)}</span>` : ''}`;
}

// ---------------------------------------------------------------------
// My requests tab
// ---------------------------------------------------------------------
function renderMyRequests() {
    disposeRowDropdowns(myRequestsBody);
    const mine = filteredRequests.filter(isMineRequest);

    if (mine.length === 0) {
        const msg = allRequests.some(isMineRequest)
            ? 'No requests match the current filters.'
            : 'No leave requests yet — click "New request" to submit one.';
        myRequestsBody.innerHTML = `<tr><td colspan="6"><div class="empty-state">${msg}</div></td></tr>`;
        return;
    }

    myRequestsBody.innerHTML = mine.map(r => {
        // Filed by me, but for a teammate: read-only here (it's not my
        // leave to edit/cancel) — see getRowActions().
        const filedForSomeoneElse = r.employee_id !== myEmployeeId;
        const forName = embedded(r.employee, 'name') || formatEmployeeName(r.employee);
        return `
        <tr data-request-id="${r.id}">
            <td>
                ${escapeHtml(embedded(r.leave_type, 'leave_type'))}
                ${filedForSomeoneElse ? `<span class="row-sub">For ${escapeHtml(forName)}</span>` : ''}
            </td>
            <td>${renderDateRange(r)}</td>
            <td class="days-col">${r.total_days}</td>
            ${renderStatusCell(r)}
            ${renderReasonCell(r)}
            ${renderActionsCell(r)}
        </tr>
        `;
    }).join('');
    initRowDropdowns(myRequestsBody);
}

// ---------------------------------------------------------------------
// "Team requests" tab — requests I can actually act on as a
// supervisor or admin (see isTeamRequest() for the exact split). Rows I
// only see because I filed them for a teammate I have no authority over
// (requested_by = me) show read-only in "My leave" instead. Since
// leave_requests_select only lets someone else's employee_id through
// via is_supervisor_of() or is_admin() (aside from requested_by = me),
// this set can only be nonzero for a supervisor or an admin — which is
// why the tab's visibility (updateTabBadges()) can safely hinge on it
// being non-empty.
// Which actions each row offers is decided in getRowActions().
// ---------------------------------------------------------------------
function renderTeamRequests() {
    disposeRowDropdowns(teamRequestsBody);
    const team = filteredRequests.filter(r => !isMineRequest(r));
    if (team.length === 0) {
        teamRequestsBody.innerHTML = `<tr><td colspan="7"><div class="empty-state">No requests match the current filters.</div></td></tr>`;
        return;
    }

    teamRequestsBody.innerHTML = team.map(r => `
        <tr data-request-id="${r.id}">
            <td class="employee-col">${renderEmployeeCell(r.employee)}</td>
            <td>${escapeHtml(embedded(r.leave_type, 'leave_type'))}</td>
            <td>${renderDateRange(r)}</td>
            <td class="days-col">${r.total_days}</td>
            ${renderStatusCell(r)}
            ${renderReasonCell(r)}
            ${renderActionsCell(r)}
        </tr>
    `).join('');
    initRowDropdowns(teamRequestsBody);
}

// Compact range for the table: "Oct 3, 2026", "Oct 3 – 7, 2026" (same
// month), "Oct 30 – Nov 2, 2026" (same year), or both dates in full when
// the year changes. A half-day start/end gets a small (AM)/(PM) tag.
function renderDateRange(r) {
    const s = parseDateOnly(r.start_date);
    const e = parseDateOnly(r.end_date);
    if (!s || !e || isNaN(s) || isNaN(e)) return '—';

    const half = (v) => v !== 'full' ? ` <span class="half-day-tag">(${HALF_DAY_LABEL[v]})</span>` : '';
    const md  = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const mdy = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    if (r.start_date === r.end_date) return `${mdy(s)}${half(r.start_half_day)}`;

    if (s.getFullYear() !== e.getFullYear()) {
        return `${mdy(s)}${half(r.start_half_day)} – ${mdy(e)}${half(r.end_half_day)}`;
    }
    const sameMonth = s.getMonth() === e.getMonth();
    const endPart = sameMonth ? `${e.getDate()}, ${e.getFullYear()}` : mdy(e);
    return `${md(s)}${half(r.start_half_day)} – ${endPart}${half(r.end_half_day)}`;
}

// ---------------------------------------------------------------------
// Leave details modal — everything the compact row leaves out: the full
// reason, exact dates, who reviewed it and when, and the approver's
// comment / rejection reason. Its footer repeats whatever actions the
// current user has on this request (see getRowActions()).
// ---------------------------------------------------------------------
function detailRow(label, valueHtml) {
    if (!valueHtml) return '';
    return `<div class="detail-row"><dt>${label}</dt><dd>${valueHtml}</dd></div>`;
}

function openLeaveDetail(requestId) {
    const r = allRequests.find(x => x.id === requestId);
    if (!r) return;

    leaveDetailStatus.className = `status-badge ${STATUS_CLASS[r.status]}`;
    leaveDetailStatus.textContent = STATUS_LABEL[r.status];

    const dateLine = (date, half) =>
        `${escapeHtml(formatDateLong(date))} <span class="half-day-tag">· ${HALF_DAY_LABEL[half] || 'Full day'}</span>`;
    const days = Number(r.total_days);

    // Group 1 — the request itself
    const requestRows = [
        detailRow('Employee', escapeHtml(formatEmployeeName(r.employee))),
        detailRow('Leave type', escapeHtml(embedded(r.leave_type, 'leave_type') || '—')),
        r.start_date === r.end_date
            ? detailRow('Date', dateLine(r.start_date, r.start_half_day))
            : detailRow('From', dateLine(r.start_date, r.start_half_day)) + detailRow('To', dateLine(r.end_date, r.end_half_day)),
        detailRow('Total', `<strong>${days}</strong> ${days <= 1 ? 'day' : 'days'}`),
        detailRow('Reason', r.reason
            ? `<div class="detail-text">${escapeHtml(r.reason)}</div>`
            : '<span class="text-faint">No reason provided</span>')
    ];

    // Group 2 — the review outcome
    const reviewRows = [];
    if (r.status === 0) {
        reviewRows.push(detailRow('Awaiting', escapeHtml(pendingApproverName(r, true))));
    } else if (r.status === 1 || r.status === 2) {
        const word = r.status === 1 ? 'Approved' : 'Rejected';
        reviewRows.push(detailRow(`${word} by`, escapeHtml(embedded(r.approver, 'name'))));
        reviewRows.push(detailRow(`${word} on`, escapeHtml(formatDateTime(r.approved_at))));
        if (r.status === 1 && r.review_comment) {
            reviewRows.push(detailRow('Comment', `<div class="detail-text detail-note is-approved">${escapeHtml(r.review_comment)}</div>`));
        }
        if (r.status === 2 && r.rejection_reason) {
            reviewRows.push(detailRow('Rejection reason', `<div class="detail-text detail-note is-rejected">${escapeHtml(r.rejection_reason)}</div>`));
        }
    }

    // Group 3 — bookkeeping
    const metaRows = [
        detailRow('Submitted', escapeHtml(formatDateTime(r.created_at))),
        detailRow('Filed by', r.requested_by === myEmployeeId && r.employee_id !== myEmployeeId ? 'You, on their behalf' : '')
    ];

    leaveDetailBody.innerHTML = [requestRows, reviewRows, metaRows]
        .map(rows => rows.join(''))
        .filter(html => html.trim())
        .map(html => `<dl class="detail-list">${html}</dl>`)
        .join('');

    leaveDetailActions.innerHTML = getRowActions(r).map(k => {
        const d = ACTION_DEFS[k];
        return `<button type="button" class="btn btn-sm ${d.btn}" ${d.attr}="${r.id}">${d.icon()}<span>${d.label}</span></button>`;
    }).join('');

    leaveDetailModal.show();
}

// ---------------------------------------------------------------------
// New / edit request modal
// ---------------------------------------------------------------------
// Pass a request id (from a row's Edit button) to open in edit mode
// instead of creating a new request.
function openLeaveRequestModal(requestId = null) {
    leaveRequestForm.reset();
    editingRequestId = requestId;

    if (requestId) {
        const req = allRequests.find(r => r.id === requestId);
        if (!req) return;

        populateLeaveTypeSelect(req.leave_type_id);
        leaveRequestModalTitle.textContent = 'Edit leave request';
        leaveRequestSubmitBtn.textContent = 'Save changes';

        onBehalfOfField.classList.add('hidden');
        editingForBanner.classList.remove('hidden');
        editingForText.textContent = `Editing request for ${formatEmployeeName(req.employee)}`;

        leaveTypeInput.value = String(req.leave_type_id);
        startDateInput.value = req.start_date;
        startHalfDayInput.value = req.start_half_day;
        endDateInput.value = req.end_date;
        endHalfDayInput.value = req.end_half_day;
        reasonInput.value = req.reason || '';
        updateDaysPreview();
    } else {
        populateLeaveTypeSelect();
        leaveRequestModalTitle.textContent = 'New leave request';
        leaveRequestSubmitBtn.textContent = 'Submit request';

        editingForBanner.classList.add('hidden');
        onBehalfOfField.classList.toggle('hidden', !showOnBehalfField);
        if (showOnBehalfField) requestEmployeeSelect.value = myEmployeeId;

        startHalfDayInput.value = 'full';
        endHalfDayInput.value = 'full';
        daysPreview.textContent = '';
    }

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

    // Editing an existing request (admin only) — straight table update,
    // no employee_id/status change involved. total_days is assumed to
    // be recalculated server-side the same way it is on insert; if that
    // trigger turns out to be insert-only, it'll need to be extended to
    // fire BEFORE UPDATE too.
    if (editingRequestId) {
        const existing = allRequests.find(r => r.id === editingRequestId);
        if (existing) {
            const overlap = findOverlappingRequest(existing.employee_id, startDate, endDate, editingRequestId);
            if (overlap) {
                showToast(`These dates overlap another request: ${describeOverlap(overlap)}.`, 'danger');
                return;
            }
        }

        const payload = {
            leave_type_id: Number(leaveTypeInput.value),
            start_date: startDate,
            start_half_day: startHalfDayInput.value,
            end_date: endDate,
            end_half_day: endHalfDayInput.value,
            reason: reasonInput.value.trim() || null
        };

        leaveRequestSubmitBtn.disabled = true;
        let error;
        try {
            ({ error } = await sb.from('leave_requests').update(payload).eq('id', editingRequestId));
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
        await loadRequests();
        return;
    }

    // The field is only ever hidden when there's nothing but "Myself" to
    // choose from (see populateEmployeeSelect), so falling back to my own
    // id covers that case; otherwise it always reflects the picker.
    const targetEmployeeId = onBehalfOfField.classList.contains('hidden')
        ? myEmployeeId
        : requestEmployeeSelect.value;

    const overlap = findOverlappingRequest(targetEmployeeId, startDate, endDate);
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
        reason: reasonInput.value.trim() || null
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

// Admin-only counterpart to onCancelRequest(), used for a request that's
// already approved or rejected (pending requests use onCancelRequest()
// and the RPC instead, same as anyone else). cancel_leave_request() only
// transitions a still-pending request, so this goes straight through a
// table update instead — see the note at the top of the file about the
// RLS grant this depends on.
async function onAdminCancelRequest(requestId) {
    const confirmed = await showConfirmDialog({
        title: 'Cancel this request?',
        message: 'This leave request will be marked as cancelled, regardless of its current status. This cannot be undone.',
        confirmLabel: 'Cancel request',
        danger: true
    });
    if (!confirmed) return;

    const { error } = await sb.from('leave_requests').update({ status: 3 }).eq('id', requestId);
    if (error) {
        showToast('Could not cancel request: ' + error.message, 'danger');
        return;
    }
    showToast('Request cancelled.', 'success');
    await loadRequests();
}

// Approve: optional comment for the employee (saved separately, see below).
// Reject: a reason is required — it's the rejection comment the employee sees.
async function onReviewRequest(requestId, decision) {
    let rejectionReason = null;
    let approvalComment = null;

    if (decision === 'rejected') {
        rejectionReason = await promptTextDialog({
            title: 'Reject this request?',
            message: 'Please provide a reason — this will be shown to the employee.',
            confirmLabel: 'Reject request',
            placeholder: 'e.g. Team is short-staffed that week'
        });
        if (rejectionReason === null) return; // cancelled
    } else {
        const comment = await promptTextDialog({
            title: 'Approve this request?',
            message: 'The employee will be notified that their leave is approved. You can add an optional comment for them.',
            confirmLabel: 'Approve',
            placeholder: 'Optional comment, e.g. Enjoy your trip',
            required: false,
            danger: false,
            maxLength: 500
        });
        if (comment === null) return; // cancelled
        approvalComment = comment || null;
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

    // The review itself is already done and unchanged; the comment is a
    // second, separate call (see supabase/04_leave_review_comment.sql), so
    // a failure here never undoes or blocks the approval.
    if (approvalComment) {
        let commentError = null;
        try {
            ({ error: commentError } = await sb.rpc('set_leave_review_comment', {
                p_request_id: requestId,
                p_comment: approvalComment
            }));
        } catch (err) {
            commentError = err;
        }
        if (commentError) {
            console.error('leaves: could not save approval comment:', commentError);
            showToast('The request was approved, but the comment could not be saved: ' + commentError.message, 'danger');
        }
    }
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
    let error;
    try {
        ({ error } = await sb.from('leave_types').insert({ leave_type: name }));
    } catch (err) {
        error = err;
    } finally {
        addLeaveTypeBtn.disabled = false;
    }

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
    populateLeaveTypeFilter();
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
    populateLeaveTypeFilter();
    renderManageTypesList();
    showToast(nextActive ? 'Leave type enabled.' : 'Leave type disabled.', 'success');
}
