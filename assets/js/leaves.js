// =====================================================================
// leaves.html — submit/track leave requests, review team requests
// (first line / second line / head of department, or admin), and manage
// the leave-types lookup (admin).
//
// Built on sidebar.js's `ess:ready` event, same as employees.js — this
// file carries its own small toast/confirm/prompt helpers rather than
// depending on a shared utils.js (there isn't one in this app).
//
// Data model (see supabase/02_leaves_schema.sql):
//   - leave_requests.status: 0 pending, 1 approved, 2 rejected, 3 cancelled.
//   - Row-visibility is entirely handled by RLS: a plain select on
//     leave_requests returns your own requests, plus (if you're
//     someone's first line / second line / head of department, or an
//     admin) theirs too. So one fetch covers "my requests" and "team
//     requests to review" — this file just splits the same result set
//     client-side (see isTeamRequest(): by employee_id, plus whether I'm
//     an admin or one of the employee's approvers).
//   - Approval is a sequential chain (first line -> second line -> head of
//     department), one leave_request_approvals row per required step.
//     list_leave_approval_steps() supplies every visible request's steps;
//     the CURRENT step is the lowest step still pending, and only its
//     approver (or an admin) sees Approve / Reject and is shown as
//     "Awaiting <name>" (see currentStep()). Someone holding several
//     roles for the same request approves once — review_leave_request()
//     completes every pending step they hold.
//   - Approve/reject always go through review_leave_request() (pending
//     only). A rejection needs a reason (rejection_reason) and ends the
//     request at any step. An approval may carry an optional comment,
//     stored on that approval step by a follow-up call to
//     set_leave_review_comment().
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
//   - total_days is normally computed server-side from working days
//     (see calculate_leave_request_total_days() in the schema) and the
//     client's preview (updateDaysPreview()) just mirrors that formula.
//     Admins get an extra "Manually set total days" checkbox on the New/
//     Edit modal (manualDaysField) that sends total_days + total_days_manual
//     = true instead, bypassing the calculation entirely; the same
//     is_admin() check the trigger already uses for everything else is
//     what actually enforces this isn't usable by a non-admin, not RLS.
// =====================================================================

let leaveDetailModal;

let myEmployeeId = null;   // employees.id (uuid) — not the human-readable employee_id
let myEmployeeName = '';
let isAdmin = false;
let isSuperAdmin = false;   // admin login with no employees row (06_super_admin.sql): no own leave, files / approves for others
let initialized = false;    // guards against ess:ready firing more than once (would double-wire every listener)

let leaveTypes = [];        // all rows (active + inactive), for the admin manage-types list and the Leave type filter
let allowedTypeIds = null;  // Set of leave_type_id I may use (gender restriction); null = unknown, nothing hidden
let selectableEmployees = []; // used to resolve a teammate's name when RLS hides their row (requestEmployee()/requesterOf()) — admin: everyone; everyone else: everyone in the same department, their own supervisor included (see list_my_leave_delegates())
let myReportIds = new Set(); // employees.id of everyone I approve for: first-line reports, second-line reports and my department if I'm its head (non-admin only; admins already have authority over everyone)
let stepsByRequest = new Map();  // leave_requests.id -> approval steps ordered by step_no, from list_leave_approval_steps() (names resolved server-side, so RLS on employees doesn't matter)
let stepsRpcSupported = true;   // flipped off if list_leave_approval_steps() isn't installed (see loadApprovalSteps)
let requesterByRequest = new Map(); // leave_requests.id -> who filed it {id, name, employee_id}, for leave someone else filed for me, from list_leave_requesters() — same RLS workaround as stepsByRequest
let requesterRpcSupported = true;   // flipped off if list_leave_requesters() isn't installed (see loadRequesterDirectory)
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

function formatDateTime(iso) {
    const d = iso ? new Date(iso) : null;
    if (!d || isNaN(d)) return '';
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
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

// The employee a request is for, with a name whenever we can find one.
// The nested `employee` embed comes back empty when RLS doesn't let me read
// that person's row — exactly the case for leave I filed for a teammate I
// don't supervise. list_my_leave_delegates() (selectableEmployees) already
// gives me their name and ID, so fall back to it. Returns null if neither
// source knows them.
function requestEmployee(r) {
    const emp = embeddedRow(r.employee);
    if (emp?.name) return emp;
    const known = selectableEmployees.find(e => e.id === r.employee_id);
    return known ? { ...(emp || {}), name: known.name, employee_id: known.employee_id } : emp;
}

// Who filed a request, when that isn't the employee themselves — a
// teammate or admin filing on their behalf. Returns:
//   null                       self-filed (or requested_by not set)
//   { id, name, employee_id }  someone else; `name` is '' if we can't
//                              resolve it (see below)
// Names come from list_leave_requesters() (covers leave someone filed for
// ME even when RLS hides their row, e.g. my own supervisor or an admin in
// another department), then the teammate list I already load. The
// requested_by id alone is always known.
function requesterOf(r) {
    // Filed by a super admin (no employees row): name comes from list_super_admin_names().
    if (r.requested_by_admin) return { id: `admin:${r.requested_by_admin}`, name: LeaveDetail.adminName(r.requested_by_admin), employee_id: 'Admin' };
    if (!r.requested_by || r.requested_by === r.employee_id) return null;
    if (r.requested_by === myEmployeeId) return { id: myEmployeeId, name: myEmployeeName, employee_id: '' };
    const known = requesterByRequest.get(r.id) || selectableEmployees.find(e => e.id === r.requested_by);
    return known
        ? { id: r.requested_by, name: known.name, employee_id: known.employee_id }
        : { id: r.requested_by, name: '', employee_id: '' };
}

// Where a request sits from my point of view (My leave tab):
//   'own'       I filed it, for me
//   'byOthers'  it's my leave, but someone else filed it for me
//   'forOthers' I filed it for a teammate
function requestScope(r) {
    if (r.employee_id !== myEmployeeId) return 'forOthers';
    return requesterOf(r) ? 'byOthers' : 'own';
}

const APPROVER_ROLE_LABEL = { first_line: 'First line', second_line: 'Second line', hod: 'Head of department' };

// The step a PENDING request is waiting on: the lowest step_no still
// pending. Null when the request isn't pending or its steps aren't loaded.
function currentStep(r) {
    if (r.status !== 0) return null;
    return (stepsByRequest.get(r.id) || []).find(s => s.status === 0) || null;
}

// Who is being waited on: the current step's approver (first line /
// second line / head of department of THIS employee). An unassigned role
// resolves to "admin" (only an admin can act on it). Returns '' rather
// than guessing when the steps weren't loaded. The table row uses the name
// alone to stay compact; the details view passes withId = true for
// "Name (ID)".
function pendingApproverName(r, withId = false) {
    const step = currentStep(r);
    if (!step) return '';
    if (!step.expected.id) return 'admin';
    if (step.expected.id === myEmployeeId) return 'you';
    return withId ? formatEmployeeName(step.expected) : (step.expected.name || formatEmployeeName(step.expected));
}

// Can I approve / reject this request right now? Only the current step's
// approver, or an admin. review_leave_request() enforces the same rule
// server-side; if the steps RPC isn't installed we can't tell, so the
// buttons stay and the server decides.
function canReviewNow(r) {
    if (r.status !== 0) return false;
    if (isAdmin || !stepsRpcSupported) return true;
    return currentStep(r)?.expected.id === myEmployeeId;
}

// Who finished a reviewed request: whoever acted last (approved the final
// step, or rejected). Falls back to the request's own approved_by name.
function reviewerName(r) {
    const acted = (stepsByRequest.get(r.id) || []).filter(s => (s.status === 1 || s.status === 2) && s.actor.name);
    const last = acted.reduce((a, b) => (!a || (b.acted_at || '') >= (a.acted_at || '')) ? b : a, null);
    return last ? last.actor.name : (embedded(r.approver, 'name') || LeaveDetail.adminName(r.approved_by_admin));
}

// Approval comments across the steps, for the Excel export.
function approvalComments(r) {
    return (stepsByRequest.get(r.id) || [])
        .filter(s => s.status === 1 && s.comment)
        .map(s => `${APPROVER_ROLE_LABEL[s.role] || s.role}: ${s.comment}`)
        .join(' | ');
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
        const name = reviewerName(r);
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

function moreIconSvg() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>';
}

// ---------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------
const leavesContent = document.getElementById('leavesContent');
const leaveBalanceSection = document.getElementById('leaveBalanceSection');
const leaveBalanceYear = document.getElementById('leaveBalanceYear');
const leaveBalanceCards = document.getElementById('leaveBalanceCards');
const leaveBalanceStrip = document.getElementById('leaveBalanceStrip');
const leaveBalanceStripBody = document.getElementById('leaveBalanceStripBody');
const viewCardsBtn = document.getElementById('viewCardsBtn');
const viewStripBtn = document.getElementById('viewStripBtn');
const refreshListBtn = document.getElementById('refreshListBtn');
const refreshListBtnLabel = document.getElementById('refreshListBtnLabel');
const newRequestBtn = document.getElementById('newRequestBtn');
const exportExcelBtn = document.getElementById('exportExcelBtn');

const myLeaveTab = document.getElementById('myLeaveTab');
const myLeaveTabItem = document.getElementById('myLeaveTabItem');
const otherLeaveTab = document.getElementById('otherLeaveTab');
const otherLeaveTabItem = document.getElementById('otherLeaveTabItem');
const myRequestsPendingPill = document.getElementById('myRequestsPendingPill');
const teamRequestsPendingPill = document.getElementById('teamRequestsPendingPill');

const myRequestsBody = document.getElementById('myRequestsBody');
const teamRequestsBody = document.getElementById('teamRequestsBody');

// Client-side pagination: applyFilters() narrows allRequests to
// filteredRequests, and each tab then renders only its current slice.
// Page size options are shared in spirit but tracked per tab. Export
// Excel ignores all of this and always uses every filtered row.
const PAGE_SIZES = [10, 25, 50, 100];
const pagers = {
    my: {
        page: 1, size: PAGE_SIZES[0],
        container: document.getElementById('myRequestsPagination'),
        sizeSelect: document.getElementById('myPageSizeSelect'),
        info: document.getElementById('myPaginationInfo'),
        nav: document.getElementById('myPaginationNav'),
        render: () => renderMyRequests()
    },
    team: {
        page: 1, size: PAGE_SIZES[0],
        container: document.getElementById('teamRequestsPagination'),
        sizeSelect: document.getElementById('teamPageSizeSelect'),
        info: document.getElementById('teamPaginationInfo'),
        nav: document.getElementById('teamPaginationNav'),
        render: () => renderTeamRequests()
    }
};

// New/edit leave request modal (#leaveRequestModal) is owned end-to-end
// by the shared assets/js/leaveRequestModal.js — see LeaveRequestModal
// below, wired in init().

const leaveDetailModalEl = document.getElementById('leaveDetailModal');
const leaveDetailStatus = document.getElementById('leaveDetailStatus');
const leaveDetailBody = document.getElementById('leaveDetailBody');
const leaveDetailActions = document.getElementById('leaveDetailActions');
const leaveDetailCloseBtn = document.getElementById('leaveDetailCloseBtn');

// Filter bar (Leave type / Year / Status) — same collapsible design as
// the employee directory's filter bar in employees.js.
const filterLeaveTypeBtn = document.getElementById('filterLeaveTypeBtn');
const filterLeaveTypeList = document.getElementById('filterLeaveTypeList');
const filterYearInput = document.getElementById('filterYearInput');
const filterStatusInput = document.getElementById('filterStatusInput');
const filterEmployeeInput = document.getElementById('filterEmployeeInput'); // Team requests tab only
const filterScopeInput = document.getElementById('filterScopeInput');       // My leave tab only: own leave vs leave I filed for others
const clearAllFiltersBtn = document.getElementById('clearAllFiltersBtn');
const activeFilterCount = document.getElementById('activeFilterCount');
const leaveTypeCountBadge = document.getElementById('leaveTypeCountBadge');
const activeTagsStrip = document.getElementById('activeTagsStrip');
const activeTagsContainer = document.getElementById('activeTagsContainer');

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
    isSuperAdmin = !!employee?.isSuperAdmin;
    myEmployeeName = employee?.name || '';

    // The Action column (both tabs) is admin-only; everyone else acts from
    // the leave details modal's footer. The cells are skipped in
    // renderActionsCell(); this hides the matching header cells.
    document.querySelectorAll('#myRequestsTable th.actions-col, #teamRequestsTable th.actions-col')
        .forEach(th => th.classList.toggle('hidden', !isAdmin));

    // A super admin has no employee record: myEmployeeId stays null and the
    // page works in admin-only mode (no own leave / balances).
    if (!isSuperAdmin) {
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
    }

    if (isSuperAdmin) showTeamTabOnly();

    leavesContent.style.display = 'block';
    await init();
}

// A super admin has no leave of its own: drop the "My leave" tab and make
// "Team requests" the only (always visible, active) tab.
function showTeamTabOnly() {
    myLeaveTabItem.classList.add('hidden');
    myLeaveTab.classList.remove('active');
    myLeaveTab.setAttribute('aria-selected', 'false');
    document.getElementById('myLeavePane').classList.remove('show', 'active');

    otherLeaveTabItem.classList.remove('hidden');
    otherLeaveTab.classList.add('active');
    otherLeaveTab.setAttribute('aria-selected', 'true');
    otherLeaveTab.removeAttribute('tabindex');
    document.getElementById('otherLeavePane').classList.add('show', 'active');
}

async function init() {
    leaveDetailModal = new bootstrap.Modal(leaveDetailModalEl);
    await LeaveDetail.loadAdminNames(sb);   // names for "Filed by" / approver when a super admin acted

    wireEvents();
    populateYearFilter();

    // The New/edit request modal is a shared component (also used by
    // calendar.html) — it loads its own copy of leave types / delegates
    // and owns all of its own submit/validation logic; see
    // assets/js/leaveRequestModal.js. onSubmitted just refreshes this
    // page's own list.
    await LeaveRequestModal.init({
        sb,
        isAdmin,
        myEmployeeId,
        myEmployeeName,
        showToast,
        onSubmitted: () => loadRequests()
    });

    // Request rows carry their own embedded leave_type / employee names,
    // so the lookups and the requests load together — except that
    // splitting rows into "My leave" vs "Team requests" needs my direct
    // reports, so the requests fetch waits on that one (skipped for admins).
    await Promise.all([
        loadLeaveTypes(),
        loadSelectableEmployees(),
        loadMyReports().then(loadRequests)
    ]);
    populateLeaveTypeFilter();
    refreshLeaveBalances();

    // Requests can arrive before the teammate list does, and teammate names
    // (requestEmployee()) and the Requested-for filter both depend on it —
    // so re-render now that everything is loaded.
    syncEmployeeFilterVisibility();
    applyFilters();

    // Live updates: requests, approval steps, ledger adjustments or the people behind them.
    RealtimeSync.watch({
        name: 'leaves',
        tables: ['leave_requests', 'leave_request_approvals', 'leave_balance_adjustments', 'employees'],
        onChange: reloadRequests
    });
}

function wireEvents() {
    refreshListBtn.addEventListener('click', onRefreshClick);
    newRequestBtn.addEventListener('click', () => LeaveRequestModal.openNew());
    exportExcelBtn.addEventListener('click', onExportExcelClick);
    viewCardsBtn.addEventListener('click', () => setBalanceView('cards'));
    viewStripBtn.addEventListener('click', () => setBalanceView('strip'));

    filterYearInput.addEventListener('change', applyFilters);
    filterStatusInput.addEventListener('change', applyFilters);
    filterEmployeeInput.addEventListener('change', applyFilters);
    filterScopeInput.addEventListener('change', applyFilters);
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

    // Pagination footer controls, wired the same way as employees.js's
    // pageSizeSelect/paginationNav listeners — one page-size select and
    // one page-button nav per tab.
    Object.values(pagers).forEach(pg => {
        pg.sizeSelect.addEventListener('change', () => {
            pg.size = Number(pg.sizeSelect.value) || PAGE_SIZES[0];
            pg.page = 1;
            pg.render();
        });
        pg.nav.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-page]');
            if (!btn || btn.disabled) return;
            pg.page = Number(btn.dataset.page);
            pg.render();
        });
    });

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

// ---------------------------------------------------------------------
// Export Excel — the rows of whichever tab is open (My leave or Team
// requests), after the current Leave type / Year / Status / Requested-for /
// Employee filters, in the order the table shows them. Same SheetJS
// json_to_sheet + writeFile approach as the employee directory export.
// Both tabs share one column set, so a file from either tab reads the same.
// ---------------------------------------------------------------------
function onExportExcelClick() {
    if (typeof XLSX === 'undefined') {
        showToast('Excel export is unavailable — the spreadsheet library did not load.', 'danger');
        return;
    }

    const teamTab = isTeamTabActive();
    const rows = filteredRequests.filter(r => teamTab ? !isMineRequest(r) : isMineRequest(r));
    if (rows.length === 0) {
        showToast('No leave requests to export.', 'danger');
        return;
    }

    const data = rows.map(r => {
        const emp = requestEmployee(r);
        const reviewed = r.status === 1 || r.status === 2;

        // Same wording as the table's status line: "Awaiting <name>" while
        // pending, the approver's name once approved / rejected.
        let approver = '';
        if (r.status === 0) {
            const who = pendingApproverName(r);
            approver = who ? `Awaiting ${who}` : '';
        } else if (reviewed) {
            approver = reviewerName(r);
        }

        return {
            'Employee ID': embedded(emp, 'employee_id'),
            'Employee': embedded(emp, 'name'),
            'Filed by': (() => {
                const by = requesterOf(r);
                return by ? (by.name || 'Another user') : '';   // blank = the employee filed it themselves
            })(),
            'Leave type': embedded(r.leave_type, 'leave_type'),
            'Start date': r.start_date || '',
            'Start': HALF_DAY_LABEL[r.start_half_day] || 'Full day',
            'End date': r.end_date || '',
            'End': HALF_DAY_LABEL[r.end_half_day] || 'Full day',
            'Days': Number(r.total_days),
            'Status': STATUS_LABEL[r.status],
            'Approver': approver,
            'Reviewed on': reviewed ? formatDateTime(r.approved_at) : '',
            'Approver comment': r.status === 1 ? approvalComments(r) : '',
            'Rejection reason': r.status === 2 ? (r.rejection_reason || '') : '',
            'Reason': r.reason || '',
            'Submitted': formatDateTime(r.created_at)
        };
    });

    const worksheet = XLSX.utils.json_to_sheet(data);
    // Size each column to its longest value (capped) so the file opens readable.
    worksheet['!cols'] = Object.keys(data[0]).map(header => ({
        wch: Math.min(40, data.reduce((max, row) => Math.max(max, String(row[header] ?? '').length), header.length) + 2)
    }));

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, teamTab ? 'Team requests' : 'My leave');
    XLSX.writeFile(workbook, `leave_requests_${teamTab ? 'team' : 'my-leave'}_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

// Reports first (they decide My leave vs Team requests), then the requests.
// loadRequests() also re-reads the balance cards. Used by Refresh and live updates.
async function reloadRequests() {
    await loadMyReports();
    await loadRequests();
}

async function onRefreshClick() {
    if (refreshListBtn.disabled) return;
    refreshListBtn.disabled = true;
    refreshListBtn.classList.add('is-refreshing');
    refreshListBtnLabel.textContent = 'Refreshing…';
    try {
        await reloadRequests();
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
        .select('leave_type_id, leave_type, is_active, entitlement_days, entitlement_type')
        .order('leave_type');
    if (error) {
        console.error('leaves: could not load leave types:', error);
        showToast('Could not load leave types: ' + error.message, 'danger');
        return;
    }
    leaveTypes = data || [];

    // Leave types I may not use at all (e.g. Maternity Leave for a male
    // employee) are hidden completely, including from the Leave type filter.
    if (!myEmployeeId) { allowedTypeIds = null; return; }   // super admin: no own profile, nothing to restrict
    const { data: allowed, error: allowedErr } = await sb.rpc('list_allowed_leave_type_ids', { p_employee_id: myEmployeeId });
    if (allowedErr) {
        console.warn('leaves: could not load allowed leave types:', allowedErr);
        allowedTypeIds = null;
    } else {
        allowedTypeIds = new Set((allowed || []).map(r => Number(r.out_leave_type_id ?? r)));
    }
}

// Everyone I approve leave for: my first-line reports, my second-line
// reports, and (if I head a department) everyone in it. Needed to tell
// "I filed this for someone I approve for" (actionable, goes in Team
// requests) from "I filed this for a teammate" (read-only, stays in My
// leave). Admins don't need it — they have authority over everyone. Which
// step of the chain is mine is decided per request by canReviewNow().
// On failure the previous set is kept, so behavior degrades to the old split.
async function loadMyReports() {
    if (isAdmin) return;
    const { data: depts, error: deptError } = await sb
        .from('departments')
        .select('dept_id')
        .eq('hod_id', myEmployeeId);
    if (deptError) {
        console.error('leaves: could not load my departments:', deptError);
        return;
    }
    const filters = [`supervisor_id.eq.${myEmployeeId}`, `second_line_id.eq.${myEmployeeId}`];
    if (depts?.length) filters.push(`dept_id.in.(${depts.map(d => d.dept_id).join(',')})`);

    const { data, error } = await sb
        .from('employees')
        .select('id')
        .or(filters.join(','));
    if (error) {
        console.error('leaves: could not load direct reports:', error);
        return;
    }
    myReportIds = new Set((data || []).map(e => e.id));
}

// Admins can file for anyone (existing full-directory read they already
// have elsewhere). Everyone else goes through list_my_leave_delegates(),
// a SECURITY DEFINER RPC scoped server-side to "same department" (my own
// supervisor included) — the exact set leave_requests_insert's RLS check
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

// ---------------------------------------------------------------------
// Request filters (Leave type / Year / Status)
// ---------------------------------------------------------------------

// Leave type filter intentionally lists disabled types too (same as the
// Department/Business unit filters on the employee directory), so past
// requests filed under a since-disabled type can still be found.
function populateLeaveTypeFilter() {
    const visibleTypes = allowedTypeIds ? leaveTypes.filter(t => allowedTypeIds.has(Number(t.leave_type_id))) : leaveTypes;
    renderMultiSelectList(filterLeaveTypeList, visibleTypes, 'leave_type_id', 'leave_type', 'lt', filterSelection.leaveTypes);
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
    // Chip keeps its icon + label; only the count badge and state class change.
    leaveTypeCountBadge.textContent = String(selectedSet.size);
    leaveTypeCountBadge.classList.toggle('d-none', selectedSet.size === 0);
    btn.classList.toggle('has-selected', selectedSet.size > 0);
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
    filterScopeInput.value = '';
    applyFilters();
}

// Filters allRequests down into filteredRequests, then re-renders both
// tabs from it (the Employees filter only narrows Team requests rows, and the Requested-for filter only narrows My leave rows).
// Filter changes jump back to page 1; a data refresh (keepPage) stays put.
function applyFilters({ keepPage = false } = {}) {
    if (!keepPage) Object.values(pagers).forEach(pg => { pg.page = 1; });
    const typeFilter = filterSelection.leaveTypes; // Set of leave_type_id strings, empty = all
    const yearFilter = filterYearInput.value;       // e.g. '2026'
    const statusFilter = filterStatusInput.value;   // '', '0'..'3'
    const employeeFilter = filterEmployeeInput.value; // '' or an employees.id — applies to Team requests rows only
    const scopeFilter = filterScopeInput.value;       // '', 'own', 'byOthers' or 'forOthers' — applies to My leave rows only

    filteredRequests = allRequests.filter(r => {
        if (employeeFilter && !isMineRequest(r) && r.employee_id !== employeeFilter) return false;
        if (scopeFilter && isMineRequest(r) && requestScope(r) !== scopeFilter) return false;
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

    // The "Filed by" filter is the My leave counterpart: it only means
    // something once I can file for others, or someone has filed leave for
    // me (or I already have), so it stays hidden until then. If it's hidden its value is reset, so a stale pick
    // can never keep filtering rows behind the user's back.
    const canFileForOthers = isAdmin || selectableEmployees.some(emp => emp.id !== myEmployeeId) ||
        allRequests.some(r => isMineRequest(r) && requestScope(r) !== 'own');
    const showScope = !isTeamTabActive() && canFileForOthers;
    filterScopeInput.classList.toggle('hidden', !showScope);
    if (!canFileForOthers && filterScopeInput.value) {
        filterScopeInput.value = '';
        applyFilters();
    }
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
            employees.set(r.employee_id, formatEmployeeName(requestEmployee(r)));
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
    if (!isTeamTabActive() && filterScopeInput.value) count++;   // hidden (and not applicable) on Team requests
    activeFilterCount.textContent = String(count);
    activeFilterCount.classList.toggle('d-none', count === 0);
    clearAllFiltersBtn.disabled = count === 0;
    renderActiveFilterTags();
}

// Ribbon of removable pills under the filter bar. Mirrors the rules in
// updateActiveFilterBadge(): Year only when it differs from the current
// year, Employee only on Team requests, "Filed by" only on My leave.
function renderActiveFilterTags() {
    const tags = [];
    filterSelection.leaveTypes.forEach(value => {
        const cb = Array.from(filterLeaveTypeList.querySelectorAll('input[type="checkbox"]')).find(c => c.value === value);
        tags.push({ text: `Type: ${cb?.nextElementSibling?.textContent.trim() || value}`, type: 'leaveType', value });
    });
    const selectText = (el) => el.options[el.selectedIndex]?.text || el.value;
    if (filterYearInput.value && filterYearInput.value !== String(new Date().getFullYear())) {
        tags.push({ text: `Year: ${filterYearInput.value}`, type: 'year' });
    }
    if (filterStatusInput.value) tags.push({ text: `Status: ${selectText(filterStatusInput)}`, type: 'status' });
    if (isTeamTabActive() && filterEmployeeInput.value) tags.push({ text: `Employee: ${selectText(filterEmployeeInput)}`, type: 'employee' });
    if (!isTeamTabActive() && filterScopeInput.value) tags.push({ text: selectText(filterScopeInput), type: 'scope' });

    activeTagsStrip.classList.toggle('d-none', tags.length === 0);
    activeTagsContainer.innerHTML = tags.map((t, i) =>
        `<span class="filter-tag-pill">${escapeHtml(t.text)} <button type="button" data-tag-index="${i}" title="Remove" aria-label="Remove filter">&times;</button></span>`
    ).join('');
    activeTagsContainer.onclick = (e) => {
        const btn = e.target.closest('button[data-tag-index]');
        if (!btn) return;
        const t = tags[Number(btn.dataset.tagIndex)];
        if (t.type === 'leaveType') {
            const cb = Array.from(filterLeaveTypeList.querySelectorAll('input[type="checkbox"]')).find(c => c.value === t.value);
            if (cb) { cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true })); }
            return;
        }
        if (t.type === 'year') filterYearInput.value = String(new Date().getFullYear());
        else if (t.type === 'status') filterStatusInput.value = '';
        else if (t.type === 'employee') filterEmployeeInput.value = '';
        else if (t.type === 'scope') filterScopeInput.value = '';
        applyFilters();
    };
}

// ---------------------------------------------------------------------
// Requests: one fetch, RLS-scoped (mine +, if applicable, my team's)
// ---------------------------------------------------------------------
// Approval steps for every request I can see, with the expected approver
// of each step (first line / second line / head of department of that
// employee) and, once decided, who acted. Resolved server-side by a
// SECURITY DEFINER RPC (supabase/03_policies_schemas.sql), since RLS
// stops a regular employee reading the approvers' employee rows. If the
// function isn't installed yet, stop asking; "Awaiting" then stays blank
// and the server alone decides who may review. Any other error keeps
// whatever was loaded last time.
async function loadApprovalSteps() {
    if (!stepsRpcSupported) return;

    let data = null;
    let error = null;
    try {
        ({ data, error } = await sb.rpc('list_leave_approval_steps'));
    } catch (err) {
        error = err;
    }
    if (error) {
        console.warn('leaves: could not load approval steps:', error);
        if (error.code === '42883' || /^PGRST/.test(error.code || '')) stepsRpcSupported = false;
        return;
    }
    stepsByRequest = LeaveDetail.groupSteps(data);
}

// Names of whoever filed leave on my behalf. A regular employee usually
// can't read that person's employee row (RLS) — they may be my own
// supervisor or an admin — so this SECURITY DEFINER RPC returns just the
// requester's name for requests filed for me. If it isn't installed yet,
// stop asking; names then come only from the teammate list, and anyone
// else shows as "Filed on your behalf".
async function loadRequesterDirectory() {
    if (!requesterRpcSupported) return;

    let data = null;
    let error = null;
    try {
        ({ data, error } = await sb.rpc('list_leave_requesters'));
    } catch (err) {
        error = err;
    }
    if (error) {
        console.warn('leaves: could not load requester names:', error);
        if (error.code === '42883' || /^PGRST/.test(error.code || '')) requesterRpcSupported = false;
        return;
    }
    requesterByRequest = new Map((data || []).map(a => [a.out_request, {
        id: a.out_requester,
        name: a.out_requester_name,
        employee_id: a.out_requester_code
    }]));
}

function requestSelect() {
    return `
        id, employee_id, leave_type_id, start_date, start_half_day, end_date, end_half_day,
        total_days, total_days_manual, reason, status, rejection_reason, approved_at, created_at, requested_by,
        requested_by_admin, approved_by_admin,
        employee:employee_id(name, employee_id),
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
    const [{ data, error }] = await Promise.all([fetchRequestRows(), loadApprovalSteps(), loadRequesterDirectory()]);

    if (error) {
        console.error('leaves: could not load leave requests:', error);
        showToast('Could not load leave requests: ' + error.message, 'danger');
        return;
    }

    allRequests = data || [];
    updateTabBadges();
    populateEmployeeFilter();
    syncEmployeeFilterVisibility();
    applyFilters({ keepPage: true });
    // Submit / edit / cancel / review all end in loadRequests(), so the
    // balances (pending + approved days) are re-read here too. Skipped on the
    // very first load, when leave types aren't in yet — init() calls it then.
    if (leaveTypes.length) refreshLeaveBalances();
}

// ---------------------------------------------------------------------
// Leave balances (cards / table strip at the top of the page)
// ---------------------------------------------------------------------
// Always the leave cycle that contains today. Per leave type WITH an
// entitlement, get_leave_balance() supplies the available balance and the
// cycle dates; Approved / Pending are summed from my own rows in
// allRequests that start inside that cycle. Entitled is derived as
// Available + Approved + Pending, so the card always adds up (and includes
// whatever else the ledger credits, e.g. carry forward). For monthly-accrual
// types the not-yet-accrued part is taken off Available, exactly as
// leaveRequestModal.js does ("available to date").
// Leave types WITHOUT an entitlement are rolled into one "Other Taken" card.
let balanceRows = [];      // [{ type, available, cycleStart, cycleEnd }] — entitlement types I have a balance for
let balanceSeq = 0;        // drops the result of a superseded refreshLeaveBalances()

const BALANCE_STYLES = {
    annual:  { mod: 'lb--annual',  icon: 'bi-sun-fill' },
    sick:    { mod: 'lb--sick',    icon: 'bi-heart-pulse-fill' },
    special: { mod: 'lb--special', icon: 'bi-star-fill' },
    other:   { mod: 'lb--other',   icon: 'bi-calendar-check-fill' }
};

function balanceStyleOf(name) {
    const n = (name || '').toLowerCase();
    if (n.includes('annual')) return BALANCE_STYLES.annual;
    if (n.includes('sick')) return BALANCE_STYLES.sick;
    if (n.includes('special')) return BALANCE_STYLES.special;
    return BALANCE_STYLES.other;
}

function todayIso() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmt1(n) {
    return (Math.round(Number(n) * 10) / 10).toFixed(1);
}

function hasEntitlement(t) {
    return Number(t.entitlement_days) > 0;
}

// Maternity Leave never gets a balance card on this page, whatever the
// employee's gender. (It is still usable for requests and filters.)
function isMaternityType(t) {
    return String(t.leave_type || '').toLowerCase().includes('maternity');
}

function usableLeaveTypes() {
    return allowedTypeIds ? leaveTypes.filter(t => allowedTypeIds.has(Number(t.leave_type_id))) : leaveTypes;
}

async function refreshLeaveBalances() {
    if (!myEmployeeId) { renderLeaveBalances(); return; }   // super admin: no own balances
    const seq = ++balanceSeq;
    const entTypes = usableLeaveTypes().filter(t => t.is_active !== false && hasEntitlement(t) && !isMaternityType(t));
    const asOf = todayIso();

    const results = await Promise.all(entTypes.map(async t => {
        try {
            const { data, error } = await sb.rpc('get_leave_balance', {
                p_employee_id: myEmployeeId,
                p_leave_type_id: t.leave_type_id,
                p_as_of: asOf
            });
            if (error) throw error;
            const b = Array.isArray(data) ? data[0] : data;
            if (!b) return null;   // not eligible / no ledger row — no card
            const notAccrued = t.entitlement_type === 'monthly'
                ? Number(b.entitlement_ye || 0) - Number(b.entitlement_ytd || 0) : 0;
            return {
                type: t,
                available: Number(b.available_balance) - notAccrued,
                cycleStart: b.cycle_start,
                cycleEnd: b.cycle_end
            };
        } catch (err) {
            console.warn('leaves: could not load balance for', t.leave_type, err);
            return null;
        }
    }));
    if (seq !== balanceSeq) return;   // a newer refresh is already running
    balanceRows = results.filter(Boolean);
    renderLeaveBalances();
}

// Days of my own pending (0) / approved (1) requests, optionally limited to
// a set of leave types and to requests starting inside [from, to].
function sumMyDays(status, typeIds, from, to) {
    let total = 0;
    for (const r of allRequests) {
        if (r.employee_id !== myEmployeeId || r.status !== status) continue;
        if (!typeIds.has(String(r.leave_type_id))) continue;
        if (r.start_date < from || r.start_date > to) continue;
        total += Number(r.total_days) || 0;
    }
    return total;
}

function buildBalanceItems() {
    const items = [];
    for (const row of balanceRows) {
        const ids = new Set([String(row.type.leave_type_id)]);
        const approved = sumMyDays(1, ids, row.cycleStart, row.cycleEnd);
        const pending = sumMyDays(0, ids, row.cycleStart, row.cycleEnd);
        items.push({
            kind: 'balance',
            name: row.type.leave_type,
            style: balanceStyleOf(row.type.leave_type),
            available: row.available,
            approved,
            pending,
            entitled: row.available + approved + pending
        });
    }

    // Everything without an entitlement, over the same cycle as the balances
    // (calendar year when there are none).
    const otherTypes = usableLeaveTypes().filter(t => !hasEntitlement(t));
    if (otherTypes.length) {
        const year = new Date().getFullYear();
        const from = balanceRows[0]?.cycleStart || `${year}-01-01`;
        const to = balanceRows[0]?.cycleEnd || `${year}-12-31`;
        const ids = new Set(otherTypes.map(t => String(t.leave_type_id)));
        items.push({
            kind: 'other',
            name: 'Other Taken',
            stripName: 'Other Leave Taken',
            style: BALANCE_STYLES.other,
            approved: sumMyDays(1, ids, from, to),
            pending: sumMyDays(0, ids, from, to)
        });
    }
    return items;
}

function pct(part, whole) {
    return whole > 0 ? Math.max(0, Math.min(100, Math.round((part / whole) * 100))) : 0;
}

function balanceStatusPill(it) {
    if (it.kind === 'other') return { cls: 'pill--taken', label: 'Approved taken', stripLabel: 'Activity' };
    return it.available > 0
        ? { cls: 'pill--available', label: 'Available', stripLabel: 'Available' }
        : { cls: 'pill--depleted', label: 'Depleted', stripLabel: 'Depleted' };
}

function renderBalanceCard(it, total) {
    const pill = balanceStatusPill(it);
    const isOther = it.kind === 'other';
    const primary = isOther ? it.approved : it.available;

    let bar;
    let title;
    let matrix;
    if (isOther) {
        const total = it.approved + it.pending;
        title = `Other leave taken (types without an entitlement) — Approved ${fmt1(it.approved)}d · In review ${fmt1(it.pending)}d`;
        bar = `<div class="seg-available" style="width:${pct(it.approved, total)}%;"></div>` +
              `<div class="seg-pending" style="width:${pct(it.pending, total)}%;"></div>`;
        matrix = `<div class="secondary-metrics-matrix two-cols">
            <div class="matrix-item"><span class="matrix-label">Taken</span><span class="matrix-val is-approved">${fmt1(it.approved)}</span></div>
            <div class="matrix-item"><span class="matrix-label">Pending</span><span class="matrix-val is-pending">${fmt1(it.pending)}</span></div>
        </div>`;
    } else {
        const avail = Math.max(0, it.available);
        title = `${it.name}: Available = Entitled (${fmt1(it.entitled)}) − Approved (${fmt1(it.approved)}) − Pending (${fmt1(it.pending)}) = ${fmt1(it.available)}`;
        bar = `<div class="seg-approved" style="width:${pct(it.approved, it.entitled)}%;"></div>` +
              `<div class="seg-pending" style="width:${pct(it.pending, it.entitled)}%;"></div>` +
              `<div class="seg-available" style="width:${pct(avail, it.entitled)}%;"></div>`;
        matrix = `<div class="secondary-metrics-matrix">
            <div class="matrix-item"><span class="matrix-label">Entitled</span><span class="matrix-val">${fmt1(it.entitled)}</span></div>
            <div class="matrix-item"><span class="matrix-label">Approved</span><span class="matrix-val is-approved">${fmt1(it.approved)}</span></div>
            <div class="matrix-item"><span class="matrix-label">Pending</span><span class="matrix-val is-pending">${fmt1(it.pending)}</span></div>
        </div>`;
    }

    // Up to 4 cards share the full row equally (3 cards = thirds, 2 = halves,
    // 1 = full width); 5+ wrap at 4 per row and the last row stretches to fit.
    const colClass = total <= 4
        ? 'col-12 col-md'
        : 'col-12 col-sm-6 col-lg-3 flex-grow-1';

    return `<div class="${colClass}">
        <div class="balance-card h-100 ${it.style.mod}" title="${escapeHtml(title)}">
            <div>
                <div class="card-header-bar">
                    <div class="card-category">
                        <span class="category-icon-box"><i class="bi ${it.style.icon}"></i></span>
                        <span class="category-name">${escapeHtml(it.name)}</span>
                    </div>
                    <span class="to-date-chip">To date</span>
                </div>
                <div class="primary-balance-wrap">
                    <div class="primary-metric-group">
                        <span class="primary-value">${fmt1(primary)}</span>
                        <span class="primary-unit">days</span>
                    </div>
                    <span class="primary-status-pill ${pill.cls}">${pill.label}</span>
                </div>
                <div class="ratio-bar">${bar}</div>
            </div>
            ${matrix}
        </div>
    </div>`;
}

function renderBalanceStripRow(it) {
    const pill = balanceStatusPill(it);
    const isOther = it.kind === 'other';
    const chips = isOther
        ? `<span class="mini-chip">Approved: <strong>${fmt1(it.approved)}</strong></span>
           <span class="mini-chip is-warning">Pending: <strong>${fmt1(it.pending)}</strong></span>`
        : `<span class="mini-chip">Entitled: <strong>${fmt1(it.entitled)}</strong></span>
           <span class="mini-chip">Approved: <strong>${fmt1(it.approved)}</strong></span>
           <span class="mini-chip is-warning">Pending: <strong>${fmt1(it.pending)}</strong></span>`;

    return `<tr class="${it.style.mod}">
        <td>
            <div class="strip-category-cell">
                <span class="category-icon-box"><i class="bi ${it.style.icon}"></i></span>
                <span>${escapeHtml(it.stripName || it.name)}</span>
            </div>
        </td>
        <td><div class="strip-hero-val">${fmt1(isOther ? it.approved : it.available)} <span>${isOther ? 'days used' : 'days left'}</span></div></td>
        <td><div class="mini-breakdown-inline">${chips}</div></td>
        <td class="text-end"><span class="primary-status-pill ${pill.cls}">${pill.stripLabel}</span></td>
    </tr>`;
}

function renderLeaveBalances() {
    if (!myEmployeeId) { leaveBalanceSection.classList.add('d-none'); return; }
    const items = buildBalanceItems();
    leaveBalanceSection.classList.toggle('d-none', items.length === 0);
    if (!items.length) return;

    leaveBalanceYear.textContent = `${new Date().getFullYear()} · To date`;
    leaveBalanceCards.innerHTML = items.map(it => renderBalanceCard(it, items.length)).join('');
    leaveBalanceStripBody.innerHTML = items.map(renderBalanceStripRow).join('');
}

function setBalanceView(mode) {
    const cards = mode === 'cards';
    viewCardsBtn.classList.toggle('is-active', cards);
    viewStripBtn.classList.toggle('is-active', !cards);
    leaveBalanceCards.classList.toggle('d-none', !cards);
    leaveBalanceStrip.classList.toggle('d-none', cards);
}

// ---------------------------------------------------------------------
// Leave type name for a request
// ---------------------------------------------------------------------
// The embedded join first, then the already-loaded leave_types list as a
// fallback if the embed came back empty.
function leaveTypeNameOf(r) {
    return (
        embedded(r.leave_type, 'leave_type') ||
        leaveTypes.find(t => String(t.leave_type_id) === String(r.leave_type_id))?.leave_type ||
        ''
    ).trim();
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
    // A super admin only has the Team requests tab (see showTeamTabOnly), so it stays visible.
    if (!isSuperAdmin) otherLeaveTabItem.classList.toggle('hidden', teamTotal === 0);
    if (!isSuperAdmin && teamTotal === 0 && otherLeaveTab.classList.contains('active')) {
        // Don't leave the user on a pane whose tab just disappeared.
        bootstrap.Tab.getOrCreateInstance(myLeaveTab).show();
    }
}

// ---------------------------------------------------------------------
// Row helpers shared by both tables
// ---------------------------------------------------------------------

// Every row in allRequests belongs to exactly one tab:
//  - Team requests: someone else's leave that I have authority over —
//    anyone's if I'm an admin, otherwise that of the employees I'm first
//    line / second line / head of department for (myReportIds) —
//    including leave I filed on their behalf (an admin creating leave
//    for an employee must still be able to find, edit and cancel it).
//    Rows RLS lets through for any other reason also land here, as before.
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

// Row actions. Clicking a row opens its details (see onRowActionClick());
// whatever the current user may do (approve / reject / edit / cancel) is
// grouped in a "More actions" dropdown, and repeated in the details
// modal's footer.
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
//    is read-only here). Pending: edit / cancel. Approved: cancel too for
//    my own leave that hasn't started yet (canCancelOwnApproved(); admins
//    already have force-cancel).
//    Otherwise approved / rejected / cancelled: admin-only edit, plus
//    admin force-cancel unless it's already cancelled.
//  - "Team requests" rows: pending gets approve / reject only for the
//    CURRENT step's approver or an admin (canReviewNow()), and edit /
//    cancel for admins only. Once out of pending, the
//    same admin-only edit / force-cancel applies.
// My own approved leave can still be cancelled until its start date — the
// same rule cancel_leave_request() enforces server-side (start_date >
// current_date). Compared as yyyy-mm-dd strings in local time.
function canCancelOwnApproved(r) {
    if (r.status !== 1 || r.employee_id !== myEmployeeId) return false;
    const t = new Date();
    const today = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    return r.start_date > today;
}

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
        else if (!isAdmin && canCancelOwnApproved(r)) actions.push('cancel');   // admins already get force-cancel below
        else adminPostReview();
    } else if (r.status === 0) {
        if (canReviewNow(r)) actions.push('approve', 'reject');
        if (isAdmin) actions.push('edit', 'cancel');
    } else {
        adminPostReview();
    }
    return actions;
}

// One item of a "More actions" dropdown (table rows and the details footer).
function actionMenuItem(k, id) {
    const d = ACTION_DEFS[k];
    return `<li><button type="button" class="dropdown-item${d.tone ? ' is-' + d.tone : ''}" ${d.attr}="${id}">${d.icon()}<span>${d.label}</span></button></li>`;
}

// "Review" actions first, then a divider, then the rest — same grouping in
// both places the menu appears.
function actionMenuItems(keys, id) {
    const review = keys.filter(k => REVIEW_ACTIONS.includes(k));
    const other = keys.filter(k => !REVIEW_ACTIONS.includes(k));
    return review.map(k => actionMenuItem(k, id)).join('') +
        (review.length && other.length ? '<li><hr class="dropdown-divider"></li>' : '') +
        other.map(k => actionMenuItem(k, id)).join('');
}

function renderActionsCell(r) {
    if (!isAdmin) return '';   // non-admins act from the details modal's footer instead
    const keys = getRowActions(r);
    // Nothing to do on this row (e.g. someone else's, or already reviewed
    // and I'm not an admin): leave the cell empty. It stays part of the
    // clickable row, so clicking it still opens the details.
    if (!keys.length) return '<td class="actions-col"></td>';

    const menu = `
        <div class="dropdown row-more">
            <button type="button" class="btn-icon-only" data-bs-toggle="dropdown" aria-expanded="false" title="More actions" aria-label="More actions">${moreIconSvg()}</button>
            <ul class="dropdown-menu dropdown-menu-end shadow-sm">
                ${actionMenuItems(keys, r.id)}
            </ul>
        </div>`;
    return `<td class="actions-col"><div class="actions-wrap">${menu}</div></td>`;
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

function openEditRequestModal(id) {
    const req = allRequests.find(r => r.id === id);
    if (!req) return;
    LeaveRequestModal.openEdit(req, `Editing request for ${formatEmployeeName(requestEmployee(req))}`);
}

const ROW_ACTIONS = {
    edit: (id) => openEditRequestModal(id),
    cancel: (id) => onCancelRequest(id),
    adminCancel: (id) => onAdminCancelRequest(id),
    approve: (id) => onReviewRequest(id, 'approved'),
    reject: (id) => onReviewRequest(id, 'rejected')
};
const ROW_ACTION_SELECTOR = '[data-edit], [data-cancel], [data-admin-cancel], [data-approve], [data-reject]';

function dispatchRowAction(btn) {
    for (const [key, handler] of Object.entries(ROW_ACTIONS)) {
        if (key in btn.dataset) {
            handler(btn.dataset[key]);
            return;
        }
    }
}

// Delegated click handler for both tables: action buttons / dropdown items,
// or a click anywhere else on a request row to open its details. Only the
// Action cell's own controls (the "More actions" button and its menu) are
// excluded, so an empty Action cell still opens the details.
function onRowActionClick(e) {
    const btn = e.target.closest(ROW_ACTION_SELECTOR);
    if (btn && e.currentTarget.contains(btn)) {
        dispatchRowAction(btn);
        return;
    }
    if (e.target.closest('.actions-col button, .actions-col .dropdown-menu')) return;
    const row = e.target.closest('tr[data-request-id]');
    if (row && e.currentTarget.contains(row)) openLeaveDetail(row.dataset.requestId);
}

// ---------------------------------------------------------------------
// Compact cells shared by both tables
// ---------------------------------------------------------------------
const WORKFLOW_ICON = {
    0: '<i class="bi bi-hourglass-split text-warning"></i>',
    1: '<i class="bi bi-check2-circle text-success"></i>',
    2: '<i class="bi bi-x-circle text-danger"></i>'
};

function renderStatusCell(r) {
    const sub = statusSubText(r);
    return `<td class="status-cell">
        <span class="status-badge ${STATUS_CLASS[r.status]}">${STATUS_LABEL[r.status]}</span>
        ${sub ? `<span class="workflow-queue" title="${escapeHtml(sub)}">${WORKFLOW_ICON[r.status] || ''}${escapeHtml(sub)}</span>` : ''}
    </td>`;
}

// One-line, ellipsis-truncated chip; the full text is in the tooltip and
// the details view.
function renderReasonCell(r) {
    return r.reason
        ? `<td class="reason-col" title="${escapeHtml(r.reason)}"><span class="reason-chip">${escapeHtml(r.reason)}</span></td>`
        : `<td class="reason-col"><span class="text-faint">—</span></td>`;
}

// Dot colour per leave type, matched on the type's name.
function leaveTypeClass(name) {
    const n = (name || '').toLowerCase();
    if (n.includes('annual')) return 'type-annual';
    if (n.includes('unpaid')) return 'type-unpaid';
    if (n.includes('sick')) return 'type-sick';
    if (n.includes('lieu')) return 'type-lieu';
    if (n.includes('special')) return 'type-special';
    if (n.includes('maternity')) return 'type-maternity';
    return 'type-other';
}

function renderLeaveTag(r) {
    const name = leaveTypeNameOf(r);
    return `<span class="leave-tag"><span class="leave-type-indicator ${leaveTypeClass(name)}"></span>${escapeHtml(name)}</span>`;
}

// "1.5" -> "1.5d", "4" -> "4d"; half-days get the amber badge.
function renderDaysBadge(r) {
    const days = Number(r.total_days);
    return `<span class="days-badge${days % 1 !== 0 ? ' is-half' : ''}">${days}d</span>`;
}

function renderPeriodCell(r) {
    return `<td><div class="date-duration-group">${renderDateRange(r)}${renderDaysBadge(r)}</div></td>`;
}

const AVATAR_CLASSES = ['avatar-blue', 'avatar-violet', 'avatar-emerald', 'avatar-amber'];

// Avatar (initials) + name + employee ID.
function renderEmployeeCell(rel) {
    const name = embedded(rel, 'name');
    const empId = embedded(rel, 'employee_id');
    if (!name) return escapeHtml(empId || '—');
    const initials = name.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('');
    let hash = 0;
    for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return `<div class="employee-profile-cell">
        <div class="emp-avatar ${AVATAR_CLASSES[hash % AVATAR_CLASSES.length]}">${escapeHtml(initials)}</div>
        <div class="emp-info">
            <span class="emp-name">${escapeHtml(name)}</span>
            ${empId ? `<span class="emp-code-badge">${escapeHtml(empId)}</span>` : ''}
        </div>
    </div>`;
}

// ---------------------------------------------------------------------
// Pagination helpers (client side) — ported from employees.js's
// getPageItems()/renderPagination() so both pages share the same
// footer markup, page-window logic and "Showing x–y of n" wording.
// ---------------------------------------------------------------------
const CHEVRON_LEFT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>';
const CHEVRON_RIGHT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';

// Page numbers to show: always first/last, current ±1, "…" for gaps.
function getPageItems(current, totalPages) {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
    const items = [1];
    const start = Math.max(2, current - 1);
    const end = Math.min(totalPages - 1, current + 1);
    if (start > 2) items.push('…');
    for (let p = start; p <= end; p++) items.push(p);
    if (end < totalPages - 1) items.push('…');
    items.push(totalPages);
    return items;
}

function renderPagination(pg, totalRows, totalPages, startIdx, endIdx) {
    pg.info.textContent = `Showing ${startIdx + 1}–${endIdx} of ${totalRows}`;

    const page = pg.page;
    const pageBtn = (label, target, { active = false, disabled = false, aria = '' } = {}) =>
        `<li><button type="button" class="pagination-btn${active ? ' is-active' : ''}" data-page="${target}"` +
        `${disabled ? ' disabled' : ''}${active ? ' aria-current="page"' : ''}${aria ? ` aria-label="${aria}"` : ''}>${label}</button></li>`;

    let html = pageBtn(CHEVRON_LEFT_SVG, page - 1, { disabled: page === 1, aria: 'Previous page' });
    getPageItems(page, totalPages).forEach(item => {
        html += item === '…'
            ? '<li><span class="pagination-ellipsis">…</span></li>'
            : pageBtn(item, item, { active: item === page });
    });
    html += pageBtn(CHEVRON_RIGHT_SVG, page + 1, { disabled: page === totalPages, aria: 'Next page' });
    pg.nav.innerHTML = html;
}

// Clamps pg.page into range and slices `rows` to the current page —
// same startIdx/endIdx arithmetic as employees.js's renderTable().
function paginate(rows, pg) {
    const totalPages = Math.max(1, Math.ceil(rows.length / pg.size));
    pg.page = Math.min(Math.max(1, pg.page), totalPages);
    const startIdx = (pg.page - 1) * pg.size;
    const endIdx = Math.min(startIdx + pg.size, rows.length);
    return { pageRows: rows.slice(startIdx, endIdx), startIdx, endIdx, totalPages };
}

// ---------------------------------------------------------------------
// My requests tab
// ---------------------------------------------------------------------
function renderMyRequests() {
    disposeRowDropdowns(myRequestsBody);
    const mine = filteredRequests.filter(isMineRequest);
    const pg = pagers.my;

    if (mine.length === 0) {
        const msg = allRequests.some(isMineRequest)
            ? 'No requests match the current filters.'
            : 'No leave requests yet — click "New request" to submit one.';
        myRequestsBody.innerHTML = `<tr><td colspan="${isAdmin ? 5 : 4}"><div class="empty-state">${msg}</div></td></tr>`;
        pg.container.classList.add('d-none');
        return;
    }

    const { pageRows, startIdx, endIdx, totalPages } = paginate(mine, pg);

    myRequestsBody.innerHTML = pageRows.map(r => {
        // Origin line: self-filed, filed by me for a teammate (read-only —
        // see getRowActions()), or filed for me by someone else.
        const scope = requestScope(r);
        let note = 'Self requested';
        let noteIcon = 'bi-person';
        if (scope === 'forOthers') {
            note = `For ${embedded(requestEmployee(r), 'name') || 'a teammate'}`;
            noteIcon = 'bi-people';
        } else if (scope === 'byOthers') {
            const by = requesterOf(r);
            note = by?.name ? `Filed by ${by.name}` : 'Filed on your behalf';
            noteIcon = 'bi-person-fill-gear';
        }
        return `
        <tr data-request-id="${r.id}" class="is-clickable">
            <td>
                <div class="leave-primary-cell">
                    ${renderLeaveTag(r)}
                    <span class="row-sub" title="${escapeHtml(note)}"><i class="bi ${noteIcon}"></i><span>${escapeHtml(note)}</span></span>
                </div>
            </td>
            ${renderPeriodCell(r)}
            ${renderStatusCell(r)}
            ${renderReasonCell(r)}
            ${renderActionsCell(r)}
        </tr>
        `;
    }).join('');
    initRowDropdowns(myRequestsBody);

    pg.container.classList.remove('d-none');
    renderPagination(pg, mine.length, totalPages, startIdx, endIdx);
}

// ---------------------------------------------------------------------
// "Team requests" tab — requests of people I approve for as first line,
// second line, head of department, or as an admin (see isTeamRequest()
// for the exact split). Rows I only see because I filed them for a
// teammate I have no authority over (requested_by = me) show read-only in
// "My leave" instead. Since leave_requests_select only lets someone
// else's employee_id through via those approver checks or is_admin()
// (aside from requested_by = me), this set can only be nonzero for an
// approver or an admin — which is why the tab's visibility
// (updateTabBadges()) can safely hinge on it being non-empty.
// Which actions each row offers is decided in getRowActions().
// ---------------------------------------------------------------------
function renderTeamRequests() {
    disposeRowDropdowns(teamRequestsBody);
    const team = filteredRequests.filter(r => !isMineRequest(r));
    const pg = pagers.team;

    if (team.length === 0) {
        teamRequestsBody.innerHTML = `<tr><td colspan="${isAdmin ? 6 : 5}"><div class="empty-state">No requests match the current filters.</div></td></tr>`;
        pg.container.classList.add('d-none');
        return;
    }

    const { pageRows, startIdx, endIdx, totalPages } = paginate(team, pg);

    teamRequestsBody.innerHTML = pageRows.map(r => `
        <tr data-request-id="${r.id}" class="is-clickable">
            <td class="employee-col">${renderEmployeeCell(requestEmployee(r))}</td>
            <td>${renderLeaveTag(r)}</td>
            ${renderPeriodCell(r)}
            ${renderStatusCell(r)}
            ${renderReasonCell(r)}
            ${renderActionsCell(r)}
        </tr>
    `).join('');
    initRowDropdowns(teamRequestsBody);

    pg.container.classList.remove('d-none');
    renderPagination(pg, team.length, totalPages, startIdx, endIdx);
}

// Compact range for the table: "Oct 3, 2026", "Oct 3 – 7, 2026" (same
// month), "Oct 30 – Nov 2, 2026" (same year), or both dates in full when
// the year changes. A half-day start/end gets a small AM/PM chip.
function renderDateRange(r) {
    const s = parseDateOnly(r.start_date);
    const e = parseDateOnly(r.end_date);
    if (!s || !e || isNaN(s) || isNaN(e)) return '<span class="date-main">—</span>';

    const half = (v) => v !== 'full' ? ` <span class="half-day-tag">${HALF_DAY_LABEL[v]}</span>` : '';
    const md  = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const mdy = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    let text;
    if (r.start_date === r.end_date) {
        text = `${mdy(s)}${half(r.start_half_day)}`;
    } else if (s.getFullYear() !== e.getFullYear()) {
        text = `${mdy(s)}${half(r.start_half_day)} – ${mdy(e)}${half(r.end_half_day)}`;
    } else {
        const sameMonth = s.getMonth() === e.getMonth();
        const endPart = sameMonth ? `${e.getDate()}, ${e.getFullYear()}` : mdy(e);
        text = `${md(s)}${half(r.start_half_day)} – ${endPart}${half(r.end_half_day)}`;
    }
    return `<span class="date-main">${text}</span>`;
}

// ---------------------------------------------------------------------
// Leave details modal — everything the compact row leaves out: the full
// reason, exact dates, who reviewed it and when, and the approver's
// comment / rejection reason. Its footer repeats whatever actions the
// current user has on this request (see getRowActions()).
// ---------------------------------------------------------------------
// "Filed by" line for the details view; empty when the employee filed it
// themselves. Shows Name (ID) when known.
function filedByText(r) {
    const by = requesterOf(r);
    if (!by) return '';
    if (by.id === myEmployeeId) return 'You, on their behalf';
    return by.name ? formatEmployeeName(by) : 'Another user, on their behalf';
}

function openLeaveDetail(requestId) {
    const r = allRequests.find(x => x.id === requestId);
    if (!r) return;

    LeaveDetail.setStatus(leaveDetailStatus, r.status);
    const emp = requestEmployee(r);
    leaveDetailBody.innerHTML = LeaveDetail.render({
        employee: embedded(emp, 'name') ? formatEmployeeName(emp) : 'A teammate',
        leaveType: embedded(r.leave_type, 'leave_type'),
        startDate: r.start_date,
        startHalf: r.start_half_day,
        endDate: r.end_date,
        endHalf: r.end_half_day,
        days: r.total_days,
        reason: r.reason,
        status: r.status,
        steps: stepsByRequest.get(r.id) || [],
        createdAt: r.created_at,
        approvedAt: r.approved_at,
        reviewer: r.status === 1 || r.status === 2 ? reviewerName(r) : '',
        awaiting: pendingApproverName(r, true),
        rejectionReason: r.rejection_reason,
        filedBy: filedByText(r),
        adminCreated: !!(r.requested_by_admin || r.approved_by_admin)
    });

    renderDetailActions(r);
    leaveDetailModal.show();
}

// Details footer. Kept to as few buttons as the situation needs:
//  - a request I can review (approve / reject): those two stay visible
//    (Reject outlined, Approve solid, Approve last), everything else
//    (edit / cancel) goes into a "More" menu on the left;
//  - otherwise: Edit stays visible and whatever else is left (Cancel
//    request) is offered after it;
//  - a "More" menu is only used when it would hold two or more actions —
//    a menu with a single item is shown as a plain button instead;
//  - nothing to do: no actions at all, so a plain Close button shows
//    instead. The header X / Esc / clicking outside close it either way.
// Same actions and the same click handling as a row's dropdown.
function renderDetailActions(r) {
    disposeRowDropdowns(leaveDetailActions);

    const keys = getRowActions(r);
    const hasReview = keys.some(k => REVIEW_ACTIONS.includes(k));
    let primary = hasReview
        ? ['reject', 'approve'].filter(k => keys.includes(k))
        : keys.slice(0, 1);
    let more = keys.filter(k => !primary.includes(k));
    if (more.length === 1) {   // don't hide a lone action behind a menu
        primary = primary.concat(more);
        more = [];
    }

    const btnClass = (k) => k === 'reject' ? 'btn-outline-rose' : ACTION_DEFS[k].btn;
    const primaryBtns = primary.map(k => {
        const d = ACTION_DEFS[k];
        return `<button type="button" class="btn btn-sm ${btnClass(k)}" ${d.attr}="${r.id}">${d.icon()}<span>${d.label}</span></button>`;
    }).join('');

    const moreMenu = more.length ? `
        <div class="dropdown dropup detail-more">
            <button type="button" class="btn btn-ghost btn-sm" data-bs-toggle="dropdown" aria-expanded="false">${moreIconSvg()}<span>More</span></button>
            <ul class="dropdown-menu row-actions-menu">
                ${actionMenuItems(more, r.id)}
            </ul>
        </div>` : '';

    leaveDetailActions.innerHTML = keys.length
        ? `${moreMenu}<div class="detail-primary">${primaryBtns}</div>`
        : '';
    initRowDropdowns(leaveDetailActions);
    leaveDetailCloseBtn.classList.toggle('hidden', keys.length > 0);
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
            message: 'Your approval will be recorded. If further approvers are still required, the request moves on to the next one; otherwise the employee is notified. You can add an optional comment.',
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
    // second, separate call (set_leave_review_comment()), so
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

// Leave types are now managed (enable/disable) from the Policies page,
// Leave Types tab — see policies.js. This file only reads leave_types
// (loadLeaveTypes) to populate the request form and filters.
