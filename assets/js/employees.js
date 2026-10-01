// =====================================================================
// employees.html — employee CRUD + spreadsheet import (admins), and a
// read-only "My team" view for approvers.
//
// Access:
//   - Admins (role = 1): full page, exactly as before.
//   - Approvers (1st line, 2nd line or HOD of someone — public.is_approver()):
//     same page, VIEW ONLY, listing everyone under their hierarchy
//     (public.my_team_ids() via the employees SELECT policy). Add / upload /
//     edit / end-employment controls are hidden and the details card is
//     locked. This is only a UI convenience — the database is what enforces
//     it: RLS has no INSERT/UPDATE/DELETE policy for non-admins.
//   - Everyone else: shown the access-denied message.
//
// Built directly on sidebar.js's `ess:ready` event (session + employee
// + admin check are already handled there) — this file does not depend
// on nav.js/auth.js/utils.js from the Roombook app, so it carries its
// own small toast / confirm-dialog / formatting helpers instead.
//
// Soft-delete: "removing" an employee sets `last_day` rather than
// deleting the row (an ordinary admin UPDATE, already covered by RLS).
// The row's Action column then offers "Reactivate" instead of
// "End employment" once last_day has passed. Clicking anywhere else on a
// row opens the employee details card (#employeeModal): editable for
// active employees, read-only for inactive ones.
//
// Bulk upload mirrors holidays.js: header-alias mapping, required-field
// validation, in-file dedupe, editable preview grid, and separate
// Append vs Overwrite actions that go through SECURITY DEFINER RPCs
// (admin_append_employees / admin_overwrite_employees — see
// 02_employees_page_functions.sql) so each bulk action runs as a single
// atomic transaction server-side.
// =====================================================================

let employeeModal;
let editingEmployeeId = null;
let employeeModalMode = 'add';   // 'add' (blank form) | 'view' (details card of an existing employee)
let employeeFormSnapshot = null; // JSON of the form values when the card opened — used to detect changes
let lookups = { genders: [], roles: [], positions: [], departments: [], businessUnits: [] };
let currentEmployees = [];
let currentDataset = null;
let viewerIsAdmin = false;   // false = approver (view-only "My team" mode)
let viewerAuthUserId = null; // auth.users id of the signed-in user (used to leave them out of their own team list)

// Schema definition: field -> accepted header aliases (normalized)
const SCHEMA_FIELDS = {
    employee_id:        ['employeeid', 'id', 'empid'],
    name:                ['name', 'fullname', 'employeename'],
    gender:              ['gender', 'sex'],
    position:            ['position', 'jobtitle', 'title'],
    department:          ['department', 'dept'],
    business_unit:       ['businessunit', 'bu', 'unit'],
    supervisor:          ['supervisor', 'manager', 'reportsto'],
    second_line:         ['secondline', 'secondlinemanager', 'secondmanager'],
    hired_date:          ['hireddate', 'datehired', 'startdate', 'joindate'],
    probation_end_date: ['probationenddate', 'probationend'],
    last_day:            ['lastday', 'enddate', 'terminationdate'],
    role:                ['role', 'accessrole', 'userrole'],
    email:               ['email', 'emailaddress']
};
const REQUIRED_FIELDS = ['name', 'gender', 'position', 'department', 'business_unit', 'hired_date'];
const DATE_FIELDS = ['hired_date', 'probation_end_date', 'last_day'];

// Bulk upload accepts "F"/"M" as shorthand for "female"/"male" gender
// values, alongside the full words — case-insensitive and trimmed either
// way. Anything else is left as-is so the existing female/male validation
// below still catches it as invalid.
function normalizeGenderValue(val) {
    const norm = String(val ?? '').trim().toLowerCase();
    if (norm === 'f') return 'female';
    if (norm === 'm') return 'male';
    return norm;
}

const HEADER_LABELS = {
    employee_id: 'Employee ID',
    name: 'Name',
    gender: 'Gender',
    position: 'Position',
    department: 'Department',
    business_unit: 'Business unit',
    supervisor: 'Supervisor',
    second_line: 'Second line',
    hired_date: 'Hired date',
    probation_end_date: 'Probation end date',
    last_day: 'Last day',
    role: 'Role',
    email: 'Email'
};

function normalizeHeader(h) {
    return String(h).toLowerCase().replace(/[\s_\-]/g, '');
}

// Same date-cell normalization approach as holidays.js: handles JS Date
// objects (from XLSX with cellDates:true) as well as plain strings from
// CSV.
//
// SheetJS builds cellDates Date objects using *local* time components
// (new Date(1899, 11, 30) plus the day count, entirely in local time) —
// not UTC — so reading them back out has to use the local getters
// (getFullYear/getMonth/getDate) too. Using the UTC getters here used to
// shift the date backward by a day for anyone in a timezone ahead of UTC
// (e.g. a May 1 cell read out as April 30 at UTC+7), since local midnight
// on a positive offset falls on the *previous* UTC calendar day.
function normalizeDateCell(value) {
    if (value instanceof Date && !isNaN(value)) {
        const y = value.getFullYear();
        const m = String(value.getMonth() + 1).padStart(2, '0');
        const d = String(value.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }
    const str = String(value ?? '').trim();
    if (!str) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
    const parsed = new Date(str);
    if (isNaN(parsed)) return null;
    const y = parsed.getFullYear();
    const m = String(parsed.getMonth() + 1).padStart(2, '0');
    const d = String(parsed.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function trashIconSvg() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' +
        '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>';
}
function exitIconSvg() {   // log-out icon: End employment (not a delete)
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>';
}
function editIconSvg() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>' +
        '<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
}
function undoIconSvg() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 3v6h6"/></svg>';
}

// ---------------------------------------------------------------------
// Small self-contained helpers (escapeHtml / toast / confirm / prompt)
// — no utils.js/auth.js in this app, so these live here.
// ---------------------------------------------------------------------
function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
}

function capitalize(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function parseDateOnly(dateStr) {
    if (!dateStr) return null;
    const [y, mo, da] = dateStr.split('-').map(Number);
    return new Date(y, mo - 1, da);
}

function formatDateLong(date) {
    if (!date || isNaN(date)) return '—';
    return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

// Embedded relations (supervisor_info / second_line_info) come back as an
// object or a single-item array depending on the query shape.
function embeddedName(rel) {
    if (!rel) return '';
    return (Array.isArray(rel) ? rel[0]?.name : rel.name) || '';
}
// An approver's RLS view only covers their own team, so a reporting-line
// manager who sits outside it (e.g. the 1st line of someone you are only
// 2nd line for) comes back as null even though supervisor_id is set —
// show that as "Restricted" rather than as if nobody were assigned.
function getSupervisorName(emp) {
    return embeddedName(emp.supervisor_info) || (emp.supervisor_id ? 'Restricted' : '');
}
function getSecondLineName(emp) {
    return embeddedName(emp.second_line_info) || (emp.second_line_id ? 'Restricted' : '');
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

// Small dialog to collect a single date (used for "End employment").
function promptDateDialog({ title, message, defaultValue, confirmLabel = 'Confirm' }) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal-box">
                <h3>${escapeHtml(title)}</h3>
                <p>${message}</p>
                <input type="date" class="form-control form-control-sm mb-2" id="promptDateInput" value="${defaultValue || ''}">
                <div class="modal-actions">
                    <button type="button" class="btn btn-outline-secondary btn-sm" data-action="cancel">Cancel</button>
                    <button type="button" class="btn btn-accent btn-sm" data-action="confirm">${escapeHtml(confirmLabel)}</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        const input = overlay.querySelector('#promptDateInput');
        input.focus();

        function cleanup(result) { overlay.remove(); resolve(result); }
        overlay.querySelector('[data-action="cancel"]').addEventListener('click', () => cleanup(null));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(null); });
        overlay.querySelector('[data-action="confirm"]').addEventListener('click', () => {
            if (!input.value) { alert('Please choose a date.'); return; }
            cleanup(input.value);
        });
    });
}

// Edit-form dialog for correcting an upload-preview row before it's
// committed. Same pattern as holidays.js's editRowDialog.
function editRowDialog(row) {
    return new Promise((resolve) => {
        const fields = Object.keys(SCHEMA_FIELDS);
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal-box" style="max-width: 480px;">
                <h3>Edit employee row</h3>
                <div class="edit-form" style="max-height: 60vh; overflow-y: auto;"></div>
                <div class="modal-actions">
                    <button type="button" class="btn btn-ghost btn-sm" data-action="cancel">Cancel</button>
                    <button type="button" class="btn btn-accent btn-sm" data-action="save">Save</button>
                </div>
            </div>`;

        const form = overlay.querySelector('.edit-form');
        const inputs = {};
        fields.forEach(field => {
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
            input.type = DATE_FIELDS.includes(field) ? 'date' : 'text';
            input.className = 'form-control form-control-sm';
            input.value = row[field] ?? '';

            wrap.appendChild(label);
            wrap.appendChild(input);
            form.appendChild(wrap);
            inputs[field] = input;
        });

        document.body.appendChild(overlay);
        inputs[fields[0]].focus();

        function cleanup(result) { overlay.remove(); resolve(result); }
        overlay.querySelector('[data-action="cancel"]').addEventListener('click', () => cleanup(null));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(null); });

        overlay.querySelector('[data-action="save"]').addEventListener('click', () => {
            const updated = {};
            fields.forEach(f => {
                const val = inputs[f].value.trim();
                updated[f] = val === '' ? null : val;
            });
            const missing = REQUIRED_FIELDS.filter(f => !updated[f]);
            if (missing.length > 0) {
                alert(`${missing.map(f => HEADER_LABELS[f] || f).join(', ')} ${missing.length > 1 ? 'are' : 'is'} required.`);
                return;
            }
            const genderVal = normalizeGenderValue(updated.gender);
            if (genderVal !== 'female' && genderVal !== 'male') {
                alert('Gender must be "female"/"F" or "male"/"M".');
                return;
            }
            updated.gender = genderVal;
            if (updated.role) {
                const roleVal = String(updated.role).toLowerCase();
                if (roleVal !== 'user' && roleVal !== 'admin') {
                    alert('Role must be "user" or "admin".');
                    return;
                }
                updated.role = roleVal;
            }
            cleanup(updated);
        });
    });
}

// DOM refs
const toggleUploadBtn = document.getElementById('toggleUploadBtn');
const backToListBtn = document.getElementById('backToListBtn');
const uploadPanel = document.getElementById('uploadPanel');
const statsGrid = document.getElementById('statsGrid');
const metaBar = document.getElementById('metaBar');
const filePicker = document.getElementById('filePicker');
const fileInput = document.getElementById('fileInput');
const tableContainer = document.getElementById('tableContainer');
const errorContainer = document.getElementById('errorContainer');
const statusContainer = document.getElementById('statusContainer');
const summaryContainer = document.getElementById('summaryContainer');
const tableHeader = document.getElementById('tableHeader');
const tableBody = document.getElementById('tableBody');
const fileMeta = document.getElementById('fileMeta');
const clearBtn = document.getElementById('clearBtn');
const appendBtn = document.getElementById('appendBtn');
const overwriteBtn = document.getElementById('overwriteBtn');

const refreshListBtn = document.getElementById('refreshListBtn');
const refreshListBtnLabel = document.getElementById('refreshListBtnLabel');
const exportExcelBtn = document.getElementById('exportExcelBtn');
const viewListContainer = document.getElementById('viewListContainer');
const viewListMeta = document.getElementById('viewListMeta');
const viewListTableWrap = document.getElementById('viewListTableWrap');
const viewCardGrid = document.getElementById('viewCardGrid');
const viewModeListBtn = document.getElementById('viewModeListBtn');
const viewModeCardBtn = document.getElementById('viewModeCardBtn');
const viewListPagination = document.getElementById('viewListPagination');
const pageSizeSelect = document.getElementById('pageSizeSelect');
const paginationInfo = document.getElementById('paginationInfo');
const paginationNav = document.getElementById('paginationNav');
const viewListBody = document.getElementById('viewListBody');
const filterDepartmentBtn = document.getElementById('filterDepartmentBtn');
const filterDepartmentList = document.getElementById('filterDepartmentList');
const filterBusinessUnitBtn = document.getElementById('filterBusinessUnitBtn');
const filterBusinessUnitList = document.getElementById('filterBusinessUnitList');
const filterStatusInput = document.getElementById('filterStatusInput');
const filterPortalLinkedInput = document.getElementById('filterPortalLinkedInput');
const clearAllFiltersBtn = document.getElementById('clearAllFiltersBtn');
const searchEmployeeInput = document.getElementById('searchEmployeeInput');
const activeFilterCount = document.getElementById('activeFilterCount');
let displayedEmployees = []; // all rows matching the filters (not just the current page), used by Export Excel
// View state for the employee list: 'list' | 'cards', 1-based page, rows per page.
const listState = { mode: 'list', page: 1, pageSize: Number(pageSizeSelect.value) || 10 };

// Selected values (as strings, matching dept_id/bu_id) for the two
// checkbox multi-select filters. Empty set == "all" (no filtering on it).
const filterSelection = {
    departments: new Set(),
    businessUnits: new Set()
};

window.addEventListener('ess:ready', onEssReady);

async function onEssReady(e) {
    const { session, employee } = e.detail;
    if (!session) return; // sidebar.js already redirected to login, or Supabase isn't configured

    viewerIsAdmin = employee?.role === 1;
    viewerAuthUserId = session.user?.id ?? null;

    // Non-admins get in only if they approve for someone (1st line, 2nd
    // line or HOD) — see public.is_approver() in 01_employee_info_schema.sql.
    let allowed = viewerIsAdmin;
    if (!allowed) {
        const { data, error } = await sb.rpc('is_approver');
        if (error) console.error('Could not check approver access:', error);
        allowed = data === true;
    }
    if (!allowed) {
        document.getElementById('adminGate').style.display = 'block';
        return;
    }

    document.getElementById('employeesContent').style.display = 'block';
    if (!viewerIsAdmin) applyViewOnlyMode();
    await init();
}

// Approver mode: strip every control that creates/changes data. (The
// details card is locked separately in populateEmployeeModal(), and the
// list's Action column is skipped in buildListRow()/buildEmployeeCard().)
function applyViewOnlyMode() {
    const title = document.querySelector('.page-title');
    if (title) title.textContent = 'My team';
    document.getElementById('addEmployeeDropdownBtn').closest('.dropdown').classList.add('d-none'); // Create new / Upload / Template
    document.querySelectorAll('.label-action-btn').forEach(btn => btn.classList.add('d-none'));       // lookup-manager pencil icons
    const actionTh = document.querySelector('#viewListHeader th.actions-col');
    if (actionTh) actionTh.classList.add('d-none');
}

async function init() {
    employeeModal = new bootstrap.Modal(document.getElementById('employeeModal'));
    initLookupManager();

    await loadLookups();
    populateFixedSelects();
    wireEvents();
    Object.keys(APPROVER_SELECTS).forEach(wireApproverSearch);
    wireLookupSearchSelects();

    await reloadEmployees();

    // Live updates: any change to employees re-reads the list + stats.
    RealtimeSync.watch({ name: 'employees', tables: ['employees'], onChange: reloadEmployees });
}

function wireEvents() {
    document.getElementById('addEmployeeBtn').addEventListener('click', () => openEmployeeModal(null));
    document.getElementById('employeeForm').addEventListener('submit', onSubmitEmployee);
    // Any edit inside the details card re-checks whether the Save button should show.
    // (The search-selects set hidden inputs from code, so they call
    // refreshEmployeeSaveButton() themselves — see setLookupSelection/setApproverSelection.)
    document.getElementById('employeeReactivateBtn').addEventListener('click', onReactivateFromCard);
    document.getElementById('employeePortalBtn').addEventListener('click', () => { if (editingEmployeeId) openPortalAccessDialog(editingEmployeeId); });
    // Portal badge (list row, card, details-card header) -> Portal access dialog. Capture phase so the
    // row/card's own "open details" click never fires for a badge click.
    document.addEventListener('click', (e) => {
        const badge = e.target.closest('[data-portal-badge]');
        if (!badge || !viewerIsAdmin) return;
        e.stopPropagation();
        e.preventDefault();
        openPortalAccessDialog(badge.dataset.empId);
    }, true);
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const badge = e.target.closest?.('[data-portal-badge]');
        if (!badge || !viewerIsAdmin) return;
        e.stopPropagation();
        e.preventDefault();
        openPortalAccessDialog(badge.dataset.empId);
    }, true);
    document.getElementById('employeeForm').addEventListener('input', refreshEmployeeSaveButton);
    document.getElementById('employeeForm').addEventListener('change', refreshEmployeeSaveButton);

    refreshListBtn.addEventListener('click', onRefreshClick);
    exportExcelBtn.addEventListener('click', onExportExcelClick);
    filterStatusInput.addEventListener('change', applyFilters);
    filterPortalLinkedInput.addEventListener('change', applyFilters);
    searchEmployeeInput.addEventListener('input', applyFilters);
    viewModeListBtn.addEventListener('click', () => setViewMode('list'));
    viewModeCardBtn.addEventListener('click', () => setViewMode('cards'));
    pageSizeSelect.addEventListener('change', () => {
        listState.pageSize = Number(pageSizeSelect.value) || 10;
        listState.page = 1;
        rerenderList();
    });
    paginationNav.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-page]');
        if (!btn || btn.disabled) return;
        listState.page = Number(btn.dataset.page);
        rerenderList();
    });
    wireMultiSelectFilter(filterDepartmentList, filterSelection.departments);
    wireMultiSelectFilter(filterBusinessUnitList, filterSelection.businessUnits);
    document.querySelectorAll('.btn-link-clear[data-clear-target]').forEach(btn => {
        btn.addEventListener('click', () => onClearMultiSelectFilter(btn.dataset.clearTarget));
    });
    clearAllFiltersBtn.addEventListener('click', clearAllFilters);
    initFilterDropdowns();
    toggleUploadBtn.addEventListener('click', () => setUploadPanelOpen(uploadPanel.classList.contains('hidden')));
    document.getElementById('downloadTemplateBtn').addEventListener('click', onDownloadTemplateClick);
    backToListBtn.addEventListener('click', () => setUploadPanelOpen(false));
    fileInput.addEventListener('change', onFileSelected);
    clearBtn.addEventListener('click', resetUploadPreview);
    appendBtn.addEventListener('click', onAppendClick);
    overwriteBtn.addEventListener('click', onOverwriteClick);
}

function setUploadPanelOpen(open) {
    uploadPanel.classList.toggle('hidden', !open);
    viewListContainer.classList.toggle('hidden', open);
    statsGrid.classList.toggle('hidden', open);
    metaBar.classList.toggle('hidden', open);
    statusContainer.classList.add('hidden');
    if (open) {
        resetUploadPreview();
    }
}

// ---------------------------------------------------------------------
// Lookups (genders/roles are fixed; positions/departments/business
// units are open-ended and re-fetched on every load in case an upload
// created new ones)
// ---------------------------------------------------------------------
async function loadLookups() {
    const [{ data: genders }, { data: roles }, { data: positions }, { data: departments }, { data: businessUnits }] = await Promise.all([
        sb.from('genders').select('gender_id, gender_name').order('gender_id'),
        sb.from('roles').select('role_id, role_name').order('role_id'),
        sb.from('positions').select('post_id, position, is_active').order('position'),
        sb.from('departments').select('dept_id, department, is_active').order('department'),
        sb.from('business_units').select('bu_id, business_unit, is_active').order('business_unit')
    ]);
    lookups.genders = genders || [];
    lookups.roles = roles || [];
    lookups.positions = positions || [];
    lookups.departments = departments || [];
    lookups.businessUnits = businessUnits || [];
}

function fillSelect(id, rows, valueKey, labelKey, labelFn) {
    const el = document.getElementById(id);
    el.innerHTML = rows.map(r =>
        `<option value="${r[valueKey]}">${escapeHtml(labelFn ? labelFn(r[labelKey]) : r[labelKey])}</option>`
    ).join('');
}

// Positions/departments/business units can be disabled from the lookup
// manager (see the "Lookup manager" section below) — disabled rows are
// kept (existing employees and bulk upload still reference them fine)
// but shouldn't be offered when assigning a value to a record, so every
// selection UI filters through this first.
function activeLookupRows(rows) {
    return rows.filter(r => r.is_active !== false);
}

function populateFixedSelects() {
    fillSelect('genderInput', lookups.genders, 'gender_id', 'gender_name', capitalize);
    fillSelect('roleInput', lookups.roles, 'role_id', 'role_name', capitalize);
    // Position/Department/Business unit are search-selects now (see the
    // "Position / Department / Business unit search-selects" section below)
    // — they read straight from `lookups` each time their menu renders, so
    // there's no option list here to refresh.

    // Department/Business unit filters intentionally still list disabled
    // values too, so admins can keep filtering the employee list down to
    // people already assigned to one after it's disabled.
    renderMultiSelectList(filterDepartmentList, lookups.departments, 'dept_id', 'department', 'dept', filterSelection.departments);
    renderMultiSelectList(filterBusinessUnitList, lookups.businessUnits, 'bu_id', 'business_unit', 'bu', filterSelection.businessUnits);
    updateMultiSelectButtonLabel(filterDepartmentBtn, 'Department', filterSelection.departments);
    updateMultiSelectButtonLabel(filterBusinessUnitBtn, 'Business unit', filterSelection.businessUnits);
}

// ---------------------------------------------------------------------
// Checkbox multi-select filter dropdowns (Department / Business unit)
// ---------------------------------------------------------------------

// Builds the checkbox list inside a filter dropdown menu, keeping any
// selections that are still valid (e.g. after loadLookups() re-fetches
// because an upload created a new department/business unit).
function renderMultiSelectList(listEl, rows, valueKey, labelKey, idPrefix, selectedSet) {
    // Drop selections that no longer exist among the fetched rows.
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

        const btn = listEl.closest('.dropdown').querySelector('.dropdown-toggle');
        const label = btn === filterDepartmentBtn ? 'Department' : 'Business unit';
        updateMultiSelectButtonLabel(btn, label, selectedSet);
        applyFilters();
    });
}

function onClearMultiSelectFilter(target) {
    const map = {
        department: { set: filterSelection.departments, list: filterDepartmentList, btn: filterDepartmentBtn, label: 'Department' },
        businessUnit: { set: filterSelection.businessUnits, list: filterBusinessUnitList, btn: filterBusinessUnitBtn, label: 'Business unit' }
    };
    const entry = map[target];
    if (!entry) return;
    entry.set.clear();
    entry.list.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = false; });
    updateMultiSelectButtonLabel(entry.btn, entry.label, entry.set);
    applyFilters();
}

function updateMultiSelectButtonLabel(btn, label, selectedSet) {
    // Chip button keeps its icon + label; only the count badge and state class change.
    const badge = btn.querySelector('.filter-count-badge');
    if (badge) {
        badge.textContent = String(selectedSet.size);
        badge.classList.toggle('d-none', selectedSet.size === 0);
    }
    btn.classList.toggle('has-selected', selectedSet.size > 0);
}

// The Department / Business unit menus live inside #viewListContainer,
// a .room-manage-card with `overflow: hidden` (so the table's rounded
// corners and scroll area stay clean). Bootstrap's default Popper
// strategy ("absolute") positions the menu relative to that card, so
// once the table gets short — e.g. after filtering down to a couple of
// rows — the card shrinks to fit it and clips the open menu.
// Switching Popper to strategy "fixed" positions the menu relative to
// the viewport instead, so it floats above the card and is never
// clipped by the table's height. Instances are created once, up front,
// so Bootstrap's own click handling for data-bs-toggle="dropdown" reuses
// these (already-configured) instances rather than creating default ones.
function initFilterDropdowns() {
    const fixedPopperConfig = (defaultConfig) => ({ ...defaultConfig, strategy: 'fixed' });
    new bootstrap.Dropdown(filterDepartmentBtn, { popperConfig: fixedPopperConfig });
    new bootstrap.Dropdown(filterBusinessUnitBtn, { popperConfig: fixedPopperConfig });
}

// Resets every filter control (department, business unit, status,
// portal-linked) in one go. Search keeps its own box and isn't touched.
function clearAllFilters() {
    filterSelection.departments.clear();
    filterSelection.businessUnits.clear();
    filterDepartmentList.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = false; });
    filterBusinessUnitList.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = false; });
    updateMultiSelectButtonLabel(filterDepartmentBtn, 'Department', filterSelection.departments);
    updateMultiSelectButtonLabel(filterBusinessUnitBtn, 'Business unit', filterSelection.businessUnits);
    filterStatusInput.value = '';
    filterPortalLinkedInput.checked = false;
    applyFilters();
}

// ---------------------------------------------------------------------
// Lookup manager (#lookupModal): add, rename, and enable/disable the
// three open-ended lists (Position / Department / Business unit) from
// the small icon buttons next to those fields in #employeeModal.
//
// Renaming and disabling both go straight through Supabase from the
// client (RLS on positions/departments/business_units already restricts
// writes to admins — see "lookup_write_*" policies in
// 01_employee_info_schema.sql), the same way genders/roles are read
// today; no extra RPC layer needed.
//
// Disabling only sets is_active = false — it never deletes a row, so it
// can't affect employees already assigned to it, and it doesn't touch
// bulk upload either: admin_resolve_core_employee_fields() (used by both
// Append and Overwrite) matches/creates these rows directly and ignores
// is_active entirely.
// ---------------------------------------------------------------------
let lookupModal;
// dataKey points at the matching array on `lookups` (populated by
// loadLookups()); idPrefix matches the *SearchInput/*Input/*Menu/*SelectWrap
// element ids in #employeeModal for the search-select widgets below.
const LOOKUP_KINDS = {
    position:      { table: 'positions',      idKey: 'post_id', nameKey: 'position',      label: 'position',      dataKey: 'positions',     idPrefix: 'position' },
    // hod_id (head of department) is the third step of the leave approval
    // chain; it's edited here next to the department name, not on the employee.
    department:    { table: 'departments',    idKey: 'dept_id', nameKey: 'department',    label: 'department',    dataKey: 'departments',   idPrefix: 'department',
                     extraSelect: 'hod_id, hod:employees!departments_hod_id_fkey(name, employee_id)' },
    business_unit: { table: 'business_units', idKey: 'bu_id',   nameKey: 'business_unit',  label: 'business unit', dataKey: 'businessUnits', idPrefix: 'businessUnit' }
};
// Full (active + disabled) rows per kind, (re)loaded whenever a tab is shown.
const lookupManageRows = { position: [], department: [], business_unit: [] };

function initLookupManager() {
    lookupModal = new bootstrap.Modal(document.getElementById('lookupModal'));

    document.querySelectorAll('.label-action-btn[data-lookup-kind]').forEach(btn => {
        btn.addEventListener('click', () => openLookupManager(btn.dataset.lookupKind));
    });

    Object.keys(LOOKUP_KINDS).forEach(kind => {
        const form = document.querySelector(`.lookup-manage-form[data-lookup-kind="${kind}"]`);
        form.addEventListener('submit', (e) => onSubmitLookupItem(e, kind));
        form.querySelector('[data-role="cancel-btn"]').addEventListener('click', () => resetLookupForm(kind));
        document.getElementById(`lookupTab-${kind}`).addEventListener('shown.bs.tab', () => refreshLookupManageList(kind));
    });

    // Clear any in-progress edit so reopening the modal later starts fresh.
    document.getElementById('lookupModal').addEventListener('hidden.bs.modal', () => {
        Object.keys(LOOKUP_KINDS).forEach(resetLookupForm);
    });
}

// Opens the modal already switched to the tab the click came from —
// e.g. clicking the icon next to "Department" opens straight to Departments.
function openLookupManager(kind) {
    bootstrap.Tab.getOrCreateInstance(document.getElementById(`lookupTab-${kind}`)).show();
    lookupModal.show();
    refreshLookupManageList(kind);
}

async function refreshLookupManageList(kind) {
    const { table, idKey, nameKey, extraSelect } = LOOKUP_KINDS[kind];
    const listEl = document.getElementById(`lookupList-${kind}`);
    listEl.innerHTML = '<div class="lookup-manage-empty">Loading…</div>';

    const { data, error } = await sb.from(table).select(`${idKey}, ${nameKey}, is_active${extraSelect ? ', ' + extraSelect : ''}`).order(nameKey);
    if (error) {
        listEl.innerHTML = `<div class="lookup-manage-empty">Could not load: ${escapeHtml(error.message)}</div>`;
        return;
    }

    lookupManageRows[kind] = data || [];
    renderLookupManageList(kind);
}

function renderLookupManageList(kind) {
    const { idKey, nameKey } = LOOKUP_KINDS[kind];
    const listEl = document.getElementById(`lookupList-${kind}`);
    const rows = lookupManageRows[kind];

    if (rows.length === 0) {
        listEl.innerHTML = '<div class="lookup-manage-empty">None yet</div>';
        return;
    }

    listEl.innerHTML = rows.map(r => `
        <div class="lookup-manage-row${r.is_active ? '' : ' is-disabled'}" data-id="${r[idKey]}">
            <span class="lookup-manage-name">${escapeHtml(r[nameKey])}${kind === 'department' ? lookupHodHtml(r) : ''}</span>
            <span class="status-badge ${r.is_active ? 'is-active' : 'is-terminated'}">${r.is_active ? 'Active' : 'Disabled'}</span>
            <div class="lookup-manage-row-actions">
                <button type="button" class="btn-icon-only" data-action="edit" title="Edit">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
                </button>
                <button type="button" class="btn-icon-only" data-action="toggle" title="${r.is_active ? 'Disable' : 'Enable'}">
                    ${r.is_active
                        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/></svg>'
                        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4 12 14.01l-3-3"/></svg>'}
                </button>
            </div>
        </div>
    `).join('');

    listEl.querySelectorAll('[data-action="edit"]').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = btn.closest('.lookup-manage-row').dataset.id;
            const item = rows.find(r => String(r[idKey]) === String(id));
            if (item) startEditLookupItem(kind, item);
        });
    });
    listEl.querySelectorAll('[data-action="toggle"]').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = btn.closest('.lookup-manage-row').dataset.id;
            const item = rows.find(r => String(r[idKey]) === String(id));
            if (item) onToggleLookupItem(kind, item);
        });
    });
}

// "HOD: Name" line under a department's name in the manager list.
function lookupHodHtml(row) {
    const hod = Array.isArray(row.hod) ? row.hod[0] : row.hod;
    return hod?.name ? ` <span class="text-muted small">· HOD: ${escapeHtml(hod.name)}</span>` : '';
}

function startEditLookupItem(kind, item) {
    const { idKey, nameKey } = LOOKUP_KINDS[kind];
    const form = document.querySelector(`.lookup-manage-form[data-lookup-kind="${kind}"]`);
    form.querySelector('[data-role="editing-id"]').value = item[idKey];
    form.querySelector('[data-role="value-input"]').value = item[nameKey];
    form.querySelector('[data-role="submit-btn"]').textContent = 'Save';
    form.querySelector('[data-role="cancel-btn"]').classList.remove('d-none');
    if (kind === 'department') {
        setApproverSelection('hod', item.hod_id ? currentEmployees.find(x => String(x.id) === String(item.hod_id)) : null);
    }
    form.querySelector('[data-role="value-input"]').focus();
}

function resetLookupForm(kind) {
    const form = document.querySelector(`.lookup-manage-form[data-lookup-kind="${kind}"]`);
    form.reset();
    form.querySelector('[data-role="editing-id"]').value = '';
    form.querySelector('[data-role="submit-btn"]').textContent = 'Add';
    form.querySelector('[data-role="cancel-btn"]').classList.add('d-none');
    if (kind === 'department') {
        setApproverSelection('hod', null);   // form.reset() doesn't clear a hidden input that was set from code
        closeApproverMenu('hod');
    }
}

async function onSubmitLookupItem(e, kind) {
    e.preventDefault();
    const { table, idKey, nameKey, label } = LOOKUP_KINDS[kind];
    const form = e.target;
    const editingId = form.querySelector('[data-role="editing-id"]').value || null;
    const valueInput = form.querySelector('[data-role="value-input"]');
    const value = valueInput.value.trim();

    if (!value) {
        showToast(`Please enter a ${label} name.`, 'danger');
        return;
    }

    // Trimmed, case-insensitive duplicate check against every row of this
    // kind, active or disabled — the underlying column is unique either way.
    const dupe = lookupManageRows[kind].some(r =>
        String(r[idKey]) !== String(editingId) &&
        r[nameKey].trim().toLowerCase() === value.toLowerCase()
    );
    if (dupe) {
        showToast(`A ${label} named "${value}" already exists.`, 'danger');
        return;
    }

    const submitBtn = form.querySelector('[data-role="submit-btn"]');
    submitBtn.disabled = true;

    const payload = { [nameKey]: value };
    if (kind === 'department') payload.hod_id = document.getElementById('hodInput').value || null;

    let error;
    if (editingId) {
        ({ error } = await sb.from(table).update(payload).eq(idKey, editingId));
    } else {
        ({ error } = await sb.from(table).insert(payload));
    }

    submitBtn.disabled = false;

    if (error) {
        if (error.code === '23505') {
            showToast(`A ${label} named "${value}" already exists.`, 'danger');
        } else {
            showToast(`Could not save ${label}: ` + error.message, 'danger');
        }
        return;
    }

    showToast(editingId ? `${capitalize(label)} updated.` : `${capitalize(label)} added.`, 'success');
    resetLookupForm(kind);
    await refreshLookupManageList(kind);
    await loadLookups();
    populateFixedSelects();
}

async function onToggleLookupItem(kind, item) {
    const { table, idKey, nameKey, label } = LOOKUP_KINDS[kind];
    const nextActive = !item.is_active;

    if (!nextActive) {
        const ok = await showConfirmDialog({
            title: `Disable this ${label}?`,
            message: `<strong>${escapeHtml(item[nameKey])}</strong> will no longer be offered when adding or editing employees. Employees already using it, and bulk uploads, are not affected.`,
            confirmLabel: 'Disable',
            danger: true
        });
        if (!ok) return;
    }

    const { error } = await sb.from(table).update({ is_active: nextActive }).eq(idKey, item[idKey]);
    if (error) {
        showToast(`Could not update ${label}: ` + error.message, 'danger');
        return;
    }

    showToast(nextActive ? `${capitalize(label)} enabled.` : `${capitalize(label)} disabled.`, 'success');
    await refreshLookupManageList(kind);
    await loadLookups();
    populateFixedSelects();
}

// ---------------------------------------------------------------------
// Approver search-selects — a search input + filtered dropdown list,
// standing in for a plain <select> now that the employee list can be too
// long to scan. One implementation for all three leave-approval roles:
//   supervisor  (Report to, first line)   #employeeModal
//   secondLine  (Second line manager)     #employeeModal
//   hod         (Head of department)      Departments tab of #lookupModal
// Element ids follow the kind: <kind>SearchInput / <kind>Input (hidden,
// holds the chosen employee's id) / <kind>Menu / <kind>SelectWrap. Only
// active employees are offered; whoever is already selected stays shown
// even if they have since left.
// ---------------------------------------------------------------------
const APPROVER_SELECTS = {
    supervisor: { excludeId: null, onChange: () => refreshEmployeeSaveButton() },
    secondLine: { excludeId: null, onChange: () => refreshEmployeeSaveButton() },
    hod:        { excludeId: null, onChange: null }
};

function approverEls(kind) {
    return {
        search: document.getElementById(`${kind}SearchInput`),
        hidden: document.getElementById(`${kind}Input`),
        menu: document.getElementById(`${kind}Menu`)
    };
}

function approverLabel(emp) {
    return `${emp.name} (${emp.employee_id})`;
}

function setApproverSelection(kind, emp) {
    const { search, hidden } = approverEls(kind);
    hidden.value = emp ? emp.id : '';
    search.value = emp ? approverLabel(emp) : '';
    APPROVER_SELECTS[kind].onChange?.();
}

function closeApproverMenu(kind) {
    approverEls(kind).menu.classList.add('d-none');
}

function renderApproverMenu(kind) {
    const { search, menu } = approverEls(kind);
    const term = search.value.trim().toLowerCase();
    const matches = currentEmployees
        .filter(emp => isEmployeeActive(emp) && String(emp.id) !== String(APPROVER_SELECTS[kind].excludeId))
        .filter(emp => !term || emp.name.toLowerCase().includes(term) || String(emp.employee_id).toLowerCase().includes(term))
        .slice(0, 50); // cap so a large org doesn't render an enormous list

    let html = `<button type="button" class="list-group-item list-group-item-action fst-italic small py-1 px-2" data-approver-id="">— None —</button>`;
    if (matches.length > 0) {
        html += matches.map(emp =>
            `<button type="button" class="list-group-item list-group-item-action small py-1 px-2" data-approver-id="${emp.id}">${escapeHtml(emp.name)} <span class="text-muted">(${escapeHtml(emp.employee_id)})</span></button>`
        ).join('');
    } else if (term) {
        html += `<div class="list-group-item text-muted small py-1 px-2">No matches for "${escapeHtml(search.value.trim())}"</div>`;
    }
    menu.innerHTML = html;
    menu.classList.remove('d-none');
}

// Called once per kind from init() to attach the listeners;
// initApproverSearch() (below) is what re-primes it each time the modal opens.
function wireApproverSearch(kind) {
    const { search, hidden, menu } = approverEls(kind);
    search.addEventListener('focus', () => renderApproverMenu(kind));
    search.addEventListener('input', () => renderApproverMenu(kind));
    search.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeApproverMenu(kind);
    });
    menu.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-approver-id]');
        if (!btn) return;
        const id = btn.getAttribute('data-approver-id');
        setApproverSelection(kind, id ? currentEmployees.find(x => String(x.id) === id) : null);
        closeApproverMenu(kind);
    });
    // Typed text that was never picked from the list shouldn't silently
    // keep whoever was previously selected (or send free text as if it
    // were a valid id) — reconcile on blur. The short delay lets a click
    // on a menu item (which blurs the input first) register.
    search.addEventListener('blur', () => {
        setTimeout(() => {
            const selectedEmp = hidden.value ? currentEmployees.find(x => String(x.id) === hidden.value) : null;
            if (search.value.trim() !== (selectedEmp ? approverLabel(selectedEmp) : '')) {
                setApproverSelection(kind, null);
            }
            closeApproverMenu(kind);
        }, 150);
    });
    document.addEventListener('click', (e) => {
        if (!e.target.closest(`#${kind}SelectWrap`)) closeApproverMenu(kind);
    });
}

function initApproverSearch(kind, excludeId, selectedEmp) {
    APPROVER_SELECTS[kind].excludeId = excludeId;
    setApproverSelection(kind, selectedEmp || null);
    closeApproverMenu(kind);
}

// ---------------------------------------------------------------------
// Position / Department / Business unit search-selects — same pattern as
// the approver search-selects above (a search input + filtered dropdown
// list, with a hidden input holding the chosen row's id), generalized
// over LOOKUP_KINDS so it drives all three #employeeModal fields plus
// whatever kind is added to LOOKUP_KINDS in future. Options are read live
// from `lookups` on every render, so there's no separate option cache to
// keep in sync when a position/department/business unit is added, edited,
// or disabled via the lookup manager.
// ---------------------------------------------------------------------
const lookupSelectEls = {}; // kind -> {searchInput, hiddenInput, menu, wrap} (cached on first use)
// kind -> the currently-assigned row when it's a *disabled* one, kept
// selectable (with a "(disabled)" suffix) exactly like the old plain
// <select> did via setLookupSelectValue(), so opening an existing record
// never forces the admin to pick a replacement value.
const lookupSelectExtraOption = {};

function getLookupSelectEls(kind) {
    if (!lookupSelectEls[kind]) {
        const { idPrefix } = LOOKUP_KINDS[kind];
        lookupSelectEls[kind] = {
            searchInput: document.getElementById(`${idPrefix}SearchInput`),
            hiddenInput: document.getElementById(`${idPrefix}Input`),
            menu: document.getElementById(`${idPrefix}Menu`),
            wrap: document.getElementById(`${idPrefix}SelectWrap`)
        };
    }
    return lookupSelectEls[kind];
}

function lookupRowLabel(kind, row) {
    const { nameKey } = LOOKUP_KINDS[kind];
    return row ? `${row[nameKey]}${row.is_active === false ? ' (disabled)' : ''}` : '';
}

function setLookupSelection(kind, row) {
    const { idKey } = LOOKUP_KINDS[kind];
    const { searchInput, hiddenInput } = getLookupSelectEls(kind);
    hiddenInput.value = row ? row[idKey] : '';
    searchInput.value = lookupRowLabel(kind, row);
    refreshEmployeeSaveButton();
}

function closeLookupSelectMenu(kind) {
    getLookupSelectEls(kind).menu.classList.add('d-none');
}

function renderLookupSelectMenu(kind, filterText) {
    const { idKey, nameKey, dataKey } = LOOKUP_KINDS[kind];
    const { menu } = getLookupSelectEls(kind);
    const term = filterText.trim().toLowerCase();

    let rows = activeLookupRows(lookups[dataKey]);
    const extra = lookupSelectExtraOption[kind];
    if (extra && !rows.some(r => String(r[idKey]) === String(extra[idKey]))) {
        rows = [...rows, extra];
    }
    const matches = rows
        .filter(r => !term || r[nameKey].toLowerCase().includes(term))
        .slice(0, 50); // cap so a long list doesn't render an enormous menu

    let html;
    if (matches.length > 0) {
        html = matches.map(r =>
            `<button type="button" class="list-group-item list-group-item-action small py-1 px-2" data-lookup-id="${r[idKey]}">${escapeHtml(lookupRowLabel(kind, r))}</button>`
        ).join('');
    } else {
        html = `<div class="list-group-item text-muted small py-1 px-2">No matches${term ? ` for "${escapeHtml(filterText.trim())}"` : ''}</div>`;
    }
    menu.innerHTML = html;
    menu.classList.remove('d-none');
}

// Called once from wireEvents() for each kind to attach the listeners;
// initLookupSearchSelect() (below) re-primes it each time the modal opens.
function wireLookupSearchSelect(kind) {
    const { idKey, dataKey } = LOOKUP_KINDS[kind];
    const { searchInput, menu, wrap } = getLookupSelectEls(kind);

    searchInput.addEventListener('focus', () => renderLookupSelectMenu(kind, searchInput.value));
    searchInput.addEventListener('input', () => renderLookupSelectMenu(kind, searchInput.value));
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeLookupSelectMenu(kind);
    });
    menu.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-lookup-id]');
        if (!btn) return;
        const id = btn.getAttribute('data-lookup-id');
        const extra = lookupSelectExtraOption[kind];
        const row = (extra && String(extra[idKey]) === id)
            ? extra
            : lookups[dataKey].find(r => String(r[idKey]) === id);
        setLookupSelection(kind, row || null);
        closeLookupSelectMenu(kind);
    });
    // Typed text that was never picked from the list shouldn't silently
    // keep whatever value was previously selected — reconcile on blur.
    // The short delay lets a click on a menu item (which blurs the input
    // first) register.
    searchInput.addEventListener('blur', () => {
        setTimeout(() => {
            const { hiddenInput } = getLookupSelectEls(kind);
            const hiddenId = hiddenInput.value;
            const extra = lookupSelectExtraOption[kind];
            const selectedRow = hiddenId
                ? ((extra && String(extra[idKey]) === String(hiddenId)) ? extra : lookups[dataKey].find(r => String(r[idKey]) === String(hiddenId)))
                : null;
            if (searchInput.value.trim() !== lookupRowLabel(kind, selectedRow)) {
                setLookupSelection(kind, selectedRow || null);
            }
            closeLookupSelectMenu(kind);
        }, 150);
    });
    document.addEventListener('click', (e) => {
        if (!e.target.closest(`#${wrap.id}`)) closeLookupSelectMenu(kind);
    });
}

function wireLookupSearchSelects() {
    Object.keys(LOOKUP_KINDS).forEach(wireLookupSearchSelect);
}

// Called from openEmployeeModal() for each of the three fields. Mirrors
// the old setLookupSelectValue(): defaults to the first active row when
// there's no current value (new employee), and if `currentId` belongs to
// a disabled row, keeps it selectable via lookupSelectExtraOption instead
// of silently clearing the field.
function initLookupSearchSelect(kind, currentId) {
    const { idKey, dataKey } = LOOKUP_KINDS[kind];
    const rows = lookups[dataKey];
    lookupSelectExtraOption[kind] = null;

    if (currentId == null) {
        setLookupSelection(kind, activeLookupRows(rows)[0] || null);
        closeLookupSelectMenu(kind);
        return;
    }

    let row = activeLookupRows(rows).find(r => String(r[idKey]) === String(currentId));
    if (!row) {
        row = rows.find(r => String(r[idKey]) === String(currentId));
        if (row) lookupSelectExtraOption[kind] = row;
    }
    setLookupSelection(kind, row || null);
    closeLookupSelectMenu(kind);
}

// ---------------------------------------------------------------------
// Stat cards
// ---------------------------------------------------------------------

// Spins the Refresh button's icon and disables it for the duration of
// the reload, so it's clear something is happening even though
// loadEmployees()/loadStats() usually resolve quickly.
async function onRefreshClick() {
    if (refreshListBtn.disabled) return; // already refreshing
    clearMessages();
    refreshListBtn.disabled = true;
    refreshListBtn.classList.add('is-refreshing');
    refreshListBtnLabel.textContent = 'Refreshing…';
    try {
        await reloadEmployees();
    } finally {
        refreshListBtn.classList.remove('is-refreshing');
        refreshListBtnLabel.textContent = 'Refresh';
        refreshListBtn.disabled = false;
    }
}

// List + stats together: used by init, Refresh, every save/delete/import and live updates.
function reloadEmployees() {
    return Promise.all([loadEmployees(), loadStats()]);
}

async function loadStats() {
    // Scoped server-side: everyone for admins, own team for approvers.
    const { data, error } = await sb.rpc('get_employee_stats');
    if (error) {
        console.error('Could not load employee stats:', error);
        return;
    }
    Object.entries(data).forEach(([key, val]) => {
        const el = statsGrid.querySelector(`[data-stat="${key}"]`);
        if (el) {
            el.textContent = val;
            el.classList.remove('is-loading');
        }
    });
}

// ---------------------------------------------------------------------
// Main employee list
// ---------------------------------------------------------------------
async function loadEmployees() {
    const { data, error } = await sb
        .from('employees')
        .select(`
            id, employee_id, name, hired_date, probation_end_date, last_day, email, telegram_chat_id, auth_user_id,
            gender, post_id, dept_id, bu_id, role, supervisor_id, second_line_id,
            gender_info:genders(gender_name),
            position_info:positions!post_id(position),
            department_info:departments!dept_id(department),
            business_unit_info:business_units!bu_id(business_unit),
            role_info:roles(role_name),
            supervisor_info:supervisor_id(name),
            second_line_info:second_line_id(name)
        `)
        .order('employee_id', { ascending: true });

    if (error) {
        showError('Could not load employees: ' + error.message);
        return;
    }

    // Full master list — used for the approver dropdowns + filtering. For an
    // approver, RLS already limits it to their team plus their own row;
    // drop their own row so "My team" lists only the people under them.
    currentEmployees = (data || []).filter(emp => viewerIsAdmin || emp.auth_user_id !== viewerAuthUserId);
    applyFilters({ keepPage: true }); // reloads (save/refresh) stay on the current page
}

function isEmployeeActive(emp) {
    const today = new Date().toISOString().slice(0, 10);
    return !emp.last_day || emp.last_day >= today;
}

// Any filter/search change goes back to page 1; reloads pass { keepPage: true }.
// (Filter listeners pass an Event as the first argument — it has no keepPage, so it resets.)
function applyFilters(opts) {
    if (!opts?.keepPage) listState.page = 1;
    const deptFilter = filterSelection.departments; // Set of dept_id strings, empty = all
    const buFilter = filterSelection.businessUnits; // Set of bu_id strings, empty = all
    const statusFilter = filterStatusInput.value; // '', 'active', 'inactive'
    const portalLinkedOnly = filterPortalLinkedInput.checked;
    const searchTerm = searchEmployeeInput.value.trim().toLowerCase();

    const filtered = currentEmployees.filter(emp => {
        if (deptFilter.size > 0 && !deptFilter.has(String(emp.dept_id))) return false;
        if (buFilter.size > 0 && !buFilter.has(String(emp.bu_id))) return false;
        if (statusFilter) {
            const isActive = isEmployeeActive(emp);
            if (statusFilter === 'active' && !isActive) return false;
            if (statusFilter === 'inactive' && isActive) return false;
        }
        if (portalLinkedOnly && !emp.auth_user_id) return false;
        if (searchTerm) {
            const haystack = [emp.name, emp.employee_id, emp.position_info?.position]
                .filter(Boolean)
                .join(' ')
                .toLowerCase();
            if (!haystack.includes(searchTerm)) return false;
        }
        return true;
    });

    updateActiveFilterBadge();
    renderTable(filtered, currentEmployees.length);
}

// Reflects how many of the *collapsed* filters (department, business unit,
// status, portal-linked) are currently active, so it's still obvious
// something's filtering the list even while that panel is tucked away.
// Search has its own always-visible box, so it isn't counted here.
function updateActiveFilterBadge() {
    let count = 0;
    if (filterSelection.departments.size > 0) count++;
    if (filterSelection.businessUnits.size > 0) count++;
    if (filterStatusInput.value) count++;
    if (filterPortalLinkedInput.checked) count++;
    activeFilterCount.textContent = String(count);
    activeFilterCount.classList.toggle('d-none', count === 0);
    clearAllFiltersBtn.disabled = count === 0;
    renderActiveFilterTags();
}

// Ribbon of removable pills under the filter bar (one per selected option).
const activeTagsStrip = document.getElementById('activeTagsStrip');
const activeTagsContainer = document.getElementById('activeTagsContainer');

function renderActiveFilterTags() {
    const tags = [];
    const addSetTags = (set, list, prefix) => {
        set.forEach(value => {
            const cb = Array.from(list.querySelectorAll('input[type="checkbox"]')).find(c => c.value === value);
            const label = cb?.nextElementSibling?.textContent.trim() || value;
            tags.push({ text: `${prefix}: ${label}`, type: 'set', list, value });
        });
    };
    addSetTags(filterSelection.departments, filterDepartmentList, 'Dept');
    addSetTags(filterSelection.businessUnits, filterBusinessUnitList, 'BU');
    if (filterStatusInput.value) {
        tags.push({ text: `Status: ${filterStatusInput.options[filterStatusInput.selectedIndex].text}`, type: 'status' });
    }
    if (filterPortalLinkedInput.checked) tags.push({ text: 'Portal linked', type: 'portal' });

    activeTagsStrip.classList.toggle('d-none', tags.length === 0);
    activeTagsContainer.innerHTML = tags.map((t, i) =>
        `<span class="filter-tag-pill">${escapeHtml(t.text)} <button type="button" data-tag-index="${i}" title="Remove" aria-label="Remove filter">&times;</button></span>`
    ).join('');
    activeTagsContainer.onclick = (e) => {
        const btn = e.target.closest('button[data-tag-index]');
        if (!btn) return;
        const t = tags[Number(btn.dataset.tagIndex)];
        if (t.type === 'set') {
            const cb = Array.from(t.list.querySelectorAll('input[type="checkbox"]')).find(c => c.value === t.value);
            if (cb) { cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true })); }
        } else if (t.type === 'status') {
            filterStatusInput.value = '';
            applyFilters();
        } else {
            filterPortalLinkedInput.checked = false;
            applyFilters();
        }
    };
}

const AVATAR_COLORS = ['avatar-blue', 'avatar-violet', 'avatar-emerald', 'avatar-amber', 'avatar-rose', 'avatar-cyan'];
const BUILDING_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
    '<path d="M3 21h18M9 8h1M9 12h1M9 16h1M14 8h1M14 12h1M14 16h1M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16"/></svg>';
const CHEVRON_LEFT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>';
const CHEVRON_RIGHT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';

function getInitials(name) {
    const parts = String(name || '').split(/\s+/).filter(Boolean);
    if (parts.length === 0) return 'EM';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Stable colour per employee (same colour on every page / view).
function getAvatarClass(emp) {
    const key = String(emp.employee_id || emp.name || '');
    let sum = 0;
    for (let i = 0; i < key.length; i++) sum += key.charCodeAt(i);
    return AVATAR_COLORS[sum % AVATAR_COLORS.length];
}

// "Is this employee linked to a portal user account?" (employees.auth_user_id)
// For admins the badge is clickable and opens the Portal access dialog (see the
// capture-phase listener in wireEvents()); approvers get a plain, non-clickable badge.
function portalBadgeHtml(emp) {
    const linked = !!emp.auth_user_id;
    const click = viewerIsAdmin
        ? ` data-portal-badge data-emp-id="${escapeHtml(emp.id)}" role="button" tabindex="0" style="cursor:pointer"`
        : '';
    const hint = viewerIsAdmin ? ' — click to manage portal access' : '';
    return linked
        ? `<span class="status-badge portal-badge is-linked"${click} title="Linked to a user account${hint}"><i class="bi bi-person-check-fill" aria-hidden="true"></i>Linked</span>`
        : `<span class="status-badge portal-badge is-unlinked"${click} title="Not linked to a user account${hint}"><i class="bi bi-person-dash" aria-hidden="true"></i>Not linked</span>`;
}

function statusBadgeHtml(isActive) {
    return isActive
        ? '<span class="status-badge is-active">Active</span>'
        : '<span class="status-badge is-terminated">Inactive</span>';
}

// Whole row / card opens the details card. Focusable + Enter/Space so it also
// works from the keyboard; the action buttons stop propagation so they
// don't trigger it.
function makeOpenable(el, emp) {
    el.classList.add('is-clickable');
    el.tabIndex = 0;
    el.addEventListener('click', () => openEmployeeModal(emp));
    el.addEventListener('keydown', (e) => {
        if (e.target !== el) return;
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openEmployeeModal(emp);
        }
    });
}

// End employment (active) / Reactivate (inactive) — shared by list rows and cards.
function buildActionButton(emp, isActive) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-icon-only ' + (isActive ? 'text-danger' : 'text-primary');
    btn.title = isActive ? 'End employment (sets Last day)' : 'Reactivate (clears Last day)';
    btn.innerHTML = isActive ? exitIconSvg() : undoIconSvg();
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isActive) onEndEmployment(emp);
        else onReactivate(emp);
    });
    return btn;
}

function buildListRow(emp, displayIndex) {
    const isActive = isEmployeeActive(emp);
    const supervisor = getSupervisorName(emp);
    const secondLine = getSecondLineName(emp);

    const tr = document.createElement('tr');
    makeOpenable(tr, emp);
    tr.innerHTML = `
        <td class="idx-col">${displayIndex}</td>
        <td>
            <div class="emp-profile-cell">
                <div class="emp-avatar ${getAvatarClass(emp)}">${escapeHtml(getInitials(emp.name))}</div>
                <div class="emp-profile-info">
                    <div class="emp-name-line">
                        <span class="emp-name">${escapeHtml(emp.name)}</span>
                        <span class="emp-code-badge">${escapeHtml(emp.employee_id)}</span>
                    </div>
                    <span class="emp-position-main${isActive ? '' : ' text-muted'}">${escapeHtml(emp.position_info?.position || '—')}</span>
                </div>
            </div>
        </td>
        <td>
            <div class="sec-group">
                <span class="sec-primary">${escapeHtml(emp.department_info?.department || '—')}</span>
                <span class="sec-secondary">${BUILDING_ICON_SVG}<span class="sec-text">${escapeHtml(emp.business_unit_info?.business_unit || '—')}</span></span>
            </div>
        </td>
        <td>
            <div class="sec-group">
                <span class="sec-primary${supervisor ? '' : ' text-muted'}">${escapeHtml(supervisor || '—')}</span>
                ${secondLine ? `<span class="sec-secondary"><span class="sec-text">2nd: ${escapeHtml(secondLine)}</span></span>` : ''}
            </div>
        </td>
        <td><span class="sec-primary">${escapeHtml(formatDateLong(parseDateOnly(emp.hired_date)))}</span></td>
        <td>${statusBadgeHtml(isActive)}</td>
        <td>${portalBadgeHtml(emp)}</td>
        ${viewerIsAdmin ? '<td class="actions-col"></td>' : ''}`;

    if (viewerIsAdmin) {
        const wrap = document.createElement('div');
        wrap.className = 'actions-wrap';
        wrap.appendChild(buildActionButton(emp, isActive));
        tr.lastElementChild.appendChild(wrap);
    }
    return tr;
}

function buildEmployeeCard(emp) {
    const isActive = isEmployeeActive(emp);
    const metaRows = [
        ['Department', emp.department_info?.department],
        ['Business unit', emp.business_unit_info?.business_unit],
        ['Supervisor', getSupervisorName(emp)],
        ['Hired date', formatDateLong(parseDateOnly(emp.hired_date))]
    ].map(([label, value]) => `
        <div class="card-meta-item">
            <span class="card-meta-label">${label}</span>
            <span class="card-meta-val">${escapeHtml(value || '—')}</span>
        </div>`).join('');

    const card = document.createElement('div');
    card.className = 'employee-profile-card';
    makeOpenable(card, emp);
    card.innerHTML = `
        <div class="card-top-row">
            <div class="card-avatar ${getAvatarClass(emp)}">${escapeHtml(getInitials(emp.name))}</div>
            <div class="emp-profile-info">
                <div class="emp-name-line">
                    <span class="emp-name">${escapeHtml(emp.name)}</span>
                    <span class="emp-code-badge">${escapeHtml(emp.employee_id)}</span>
                </div>
                <span class="emp-position-main${isActive ? '' : ' text-muted'}">${escapeHtml(emp.position_info?.position || '—')}</span>
            </div>
        </div>
        <div class="card-meta-list">${metaRows}</div>
        <div class="card-footer-row"><div class="card-badges">${statusBadgeHtml(isActive)}${portalBadgeHtml(emp)}</div></div>`;

    if (viewerIsAdmin) card.querySelector('.card-footer-row').appendChild(buildActionButton(emp, isActive));
    return card;
}

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

function renderPagination(totalRows, totalPages, startIdx, endIdx) {
    paginationInfo.textContent = `Showing ${startIdx + 1}–${endIdx} of ${totalRows}`;

    const page = listState.page;
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
    paginationNav.innerHTML = html;
}

function setViewMode(mode) {
    if (listState.mode === mode) return;
    listState.mode = mode;
    rerenderList();
}

// Re-draws the current filtered set (view switch / page / page size changes).
function rerenderList() {
    renderTable(displayedEmployees, currentEmployees.length);
}

function renderTable(employees, totalCount) {
    displayedEmployees = employees;
    const total = totalCount ?? employees.length;
    viewListMeta.textContent = total === employees.length
        ? `${employees.length} employees`
        : `${employees.length} of ${total} employees`;

    const isCards = listState.mode === 'cards';
    viewModeListBtn.classList.toggle('is-active', !isCards);
    viewModeCardBtn.classList.toggle('is-active', isCards);
    viewListTableWrap.classList.toggle('d-none', isCards);
    viewCardGrid.classList.toggle('d-none', !isCards);

    if (employees.length === 0) {
        const msg = total === 0
            ? (viewerIsAdmin ? 'No employees yet — add one, or upload a spreadsheet.' : 'No team members to show yet.')
            : 'No employees match the current filters.';
        viewListBody.innerHTML = `<tr><td colspan="${viewerIsAdmin ? 8 : 7}"><div class="empty-state">${msg}</div></td></tr>`;
        viewCardGrid.innerHTML = `<div class="empty-state">${msg}</div>`;
        viewListPagination.classList.add('d-none');
        return;
    }

    const totalPages = Math.max(1, Math.ceil(employees.length / listState.pageSize));
    listState.page = Math.min(Math.max(1, listState.page), totalPages);
    const startIdx = (listState.page - 1) * listState.pageSize;
    const endIdx = Math.min(startIdx + listState.pageSize, employees.length);
    const pageRows = employees.slice(startIdx, endIdx);

    const fragment = document.createDocumentFragment();
    pageRows.forEach((emp, i) => {
        fragment.appendChild(isCards ? buildEmployeeCard(emp) : buildListRow(emp, startIdx + i + 1));
    });
    (isCards ? viewCardGrid : viewListBody).replaceChildren(fragment);

    viewListPagination.classList.remove('d-none');
    renderPagination(employees.length, totalPages, startIdx, endIdx);
}

// Blank bulk-upload template: just the header row the parser in
// processRows() expects (see SCHEMA_FIELDS / HEADER_LABELS above), so
// admins have a starting point that matches what "Upload Excel/CSV" and
// admin_append_employees / admin_overwrite_employees actually require.
function onDownloadTemplateClick() {
    const headers = Object.keys(SCHEMA_FIELDS).map(f => HEADER_LABELS[f] || f);
    const worksheet = XLSX.utils.aoa_to_sheet([headers]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Employees');
    XLSX.writeFile(workbook, 'employees_upload_template.xlsx');
}

function onExportExcelClick() {
    if (displayedEmployees.length === 0) {
        showToast('No employees to export.', 'danger');
        return;
    }

    const rows = displayedEmployees.map(emp => ({
        'Employee ID': emp.employee_id,
        'Name': emp.name,
        'Gender': capitalize(emp.gender_info?.gender_name || ''),
        'Position': emp.position_info?.position || '',
        'Department': emp.department_info?.department || '',
        'Business unit': emp.business_unit_info?.business_unit || '',
        'Supervisor': getSupervisorName(emp),
        'Second line': getSecondLineName(emp),
        'Role': capitalize(emp.role_info?.role_name || ''),
        'Hired date': emp.hired_date || '',
        'Probation end date': emp.probation_end_date || '',
        'Last day': emp.last_day || '',
        'Status': isEmployeeActive(emp) ? 'Active' : 'Inactive',
        'Email': emp.email || '',
        'Telegram chat ID': emp.telegram_chat_id || ''
    }));

    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Employees');
    XLSX.writeFile(workbook, `employees_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

// ---------------------------------------------------------------------
// Add / edit (single-record form)
// ---------------------------------------------------------------------
// ---------------------------------------------------------------------
// Employee details card (#employeeModal)
//
// Clicking a row opens this card in "view" mode: every field is shown and
// editable, but the Save button stays hidden until something actually
// differs from what was loaded. Inactive employees open read-only (the whole
// form is inside a disabled <fieldset>) — same rule as the old Edit button:
// reactivate first. "Add employee" opens the same modal in "add" mode, where
// Save is always visible.
// ---------------------------------------------------------------------
function readEmployeeFormValues() {
    const val = (id) => document.getElementById(id).value.trim();
    return {
        employee_id: val('employeeIdInput'),
        name: val('nameInput'),
        gender: val('genderInput'),
        role: val('roleInput'),
        post_id: val('positionInput'),
        dept_id: val('departmentInput'),
        bu_id: val('businessUnitInput'),
        supervisor_id: val('supervisorInput'),
        second_line_id: val('secondLineInput'),
        hired_date: val('hiredDateInput'),
        probation_end_date: val('probationEndDateInput'),
        last_day: val('lastDayInput'),
        email: val('emailInput'),
        telegram_chat_id: val('telegramChatIdInput')
    };
}

function isEmployeeFormDirty() {
    return employeeFormSnapshot !== null &&
        JSON.stringify(readEmployeeFormValues()) !== employeeFormSnapshot;
}

// Shows Save only when there's something to save. Called on every input/
// change in the form and whenever a search-select sets its hidden value.
function refreshEmployeeSaveButton() {
    const saveBtn = document.getElementById('employeeSubmitBtn');
    const cancelBtn = document.getElementById('employeeCancelBtn');
    if (!saveBtn || !cancelBtn) return;

    if (!viewerIsAdmin) { // approvers are view-only: never offer Save
        saveBtn.classList.add('d-none');
        cancelBtn.textContent = 'Close';
        return;
    }

    if (employeeModalMode === 'add') {
        saveBtn.classList.remove('d-none');
        cancelBtn.textContent = 'Cancel';
        return;
    }
    const dirty = isEmployeeFormDirty();
    saveBtn.classList.toggle('d-none', !dirty);
    cancelBtn.textContent = dirty ? 'Cancel' : 'Close';
}

// Front-end uniqueness check for telegram_chat_id, mirroring the database's
// unique constraint on that column. Excludes the record being edited.
function isTelegramChatIdTaken(chatId, excludeId) {
    return currentEmployees.some(emp =>
        emp.telegram_chat_id && emp.telegram_chat_id === chatId && String(emp.id) !== String(excludeId)
    );
}

// Opens the card for `emp` (or a blank "Add employee" form when null).
function openEmployeeModal(emp) {
    populateEmployeeModal(emp);
    employeeModal.show();
}

// Fills the card's fields from `emp` without (re)opening it. Also used to
// refresh the card in place after a save or a reactivation, so it stays open
// and reflects the saved data (e.g. flips to read-only if Last day was set).
function populateEmployeeModal(emp) {
    const isView = !!emp;
    const readOnly = !viewerIsAdmin || (isView && !isEmployeeActive(emp));

    employeeModalMode = isView ? 'view' : 'add';
    employeeFormSnapshot = null; // no change detection while the form is being filled in

    editingEmployeeId = emp ? emp.id : null;
    document.getElementById('employeeModalTitle').textContent = emp ? 'Employee details' : 'Add employee';
    const badgesEl = document.getElementById('employeeModalBadges');
    badgesEl.innerHTML = emp ? statusBadgeHtml(isEmployeeActive(emp)) + portalBadgeHtml(emp) : '';
    badgesEl.classList.toggle('d-none', !emp);
    document.getElementById('employeeSubmitBtn').textContent = emp ? 'Save changes' : 'Save employee';
    document.getElementById('employeeFieldset').disabled = readOnly;
    document.getElementById('employeeReadonlyNotice').classList.toggle('d-none', !readOnly);
    document.getElementById('employeeReadonlyText').textContent = viewerIsAdmin
        ? 'This employee is inactive, so their details are read-only. Reactivate them to make changes.'
        : 'View only — you can see the details of people in your team, but not change them.';
    document.getElementById('employeeReactivateBtn').classList.toggle('d-none', !(readOnly && viewerIsAdmin));
    document.getElementById('employeePortalBtn').classList.toggle('d-none', !(emp && viewerIsAdmin && isEmployeeActive(emp))); // admins only, existing + active employees only
    document.getElementById('employeeIdInput').value = emp ? emp.employee_id : '';

    document.getElementById('nameInput').value = emp ? emp.name : '';
    document.getElementById('genderInput').value = emp ? emp.gender : (lookups.genders[0]?.gender_id ?? '');
    const defaultRole = lookups.roles.find(r => r.role_name === 'user')?.role_id ?? lookups.roles[0]?.role_id ?? '';
    document.getElementById('roleInput').value = emp ? emp.role : defaultRole;
    initLookupSearchSelect('position', emp ? emp.post_id : null);
    initLookupSearchSelect('department', emp ? emp.dept_id : null);
    initLookupSearchSelect('business_unit', emp ? emp.bu_id : null);

    const findEmployee = (id) => id ? currentEmployees.find(x => String(x.id) === String(id)) : null;
    initApproverSearch('supervisor', emp ? emp.id : null, findEmployee(emp?.supervisor_id));
    initApproverSearch('secondLine', emp ? emp.id : null, findEmployee(emp?.second_line_id));
    if (!viewerIsAdmin && emp) {
        // A manager outside the approver's own team isn't readable to them (RLS) — say so instead of showing an empty field.
        if (emp.supervisor_id && !findEmployee(emp.supervisor_id)) approverEls('supervisor').search.value = 'Restricted';
        if (emp.second_line_id && !findEmployee(emp.second_line_id)) approverEls('secondLine').search.value = 'Restricted';
    }

    document.getElementById('hiredDateInput').value = emp ? emp.hired_date : '';
    document.getElementById('probationEndDateInput').value = emp ? (emp.probation_end_date || '') : '';
    document.getElementById('probationHint').style.display = emp ? 'none' : 'inline';
    document.getElementById('lastDayInput').value = emp ? (emp.last_day || '') : '';
    document.getElementById('emailInput').value = emp ? (emp.email || '') : '';
    setEmailLock(emp);
    document.getElementById('telegramChatIdInput').value = emp ? (emp.telegram_chat_id || '') : '';

    // Baseline for change detection — taken after every field is populated.
    employeeFormSnapshot = JSON.stringify(readEmployeeFormValues());
    refreshEmployeeSaveButton();
}

// "Reactivate" button in the card footer (inactive employees only).
async function onReactivateFromCard() {
    const emp = currentEmployees.find(x => String(x.id) === String(editingEmployeeId));
    if (!emp) return;
    const ok = await onReactivate(emp);
    if (!ok) return;
    // List was reloaded by onReactivate() — refresh the open card, which is
    // now active and therefore editable again.
    const fresh = currentEmployees.find(x => String(x.id) === String(editingEmployeeId));
    if (fresh) populateEmployeeModal(fresh);
}

// Front-end uniqueness check against the in-memory employee list, mirroring
// the database's `employees_employee_id_key` unique constraint (exact,
// case-sensitive match). Excludes the record being edited so saving an
// employee without changing their own ID doesn't flag itself as a dupe.
function isEmployeeIdTaken(employeeId, excludeId) {
    return currentEmployees.some(emp =>
        emp.employee_id === employeeId && String(emp.id) !== String(excludeId)
    );
}

async function onSubmitEmployee(e) {
    e.preventDefault();
    if (!viewerIsAdmin) return; // view-only for approvers (and RLS would reject the write anyway)

    // Pressing Enter in a field submits the form even while Save is hidden —
    // ignore it when nothing has changed.
    if (employeeModalMode === 'view' && !isEmployeeFormDirty()) return;

    const employeeId = document.getElementById('employeeIdInput').value.trim();
    const name = document.getElementById('nameInput').value.trim();
    const postId = document.getElementById('positionInput').value;
    const deptId = document.getElementById('departmentInput').value;
    const buId = document.getElementById('businessUnitInput').value;
    const hiredDate = document.getElementById('hiredDateInput').value;
    const probationEndDate = document.getElementById('probationEndDateInput').value || null;

    // Position/Department/Business unit are search-selects (hidden input +
    // visible search text) rather than plain <select required>, so their
    // "required" check has to happen here instead of via native validation.
    if (!employeeId || !name || !postId || !deptId || !buId || !hiredDate) {
        showToast('Please fill in the required fields.', 'danger');
        return;
    }
    if (isEmployeeIdTaken(employeeId, editingEmployeeId)) {
        showToast(`Employee ID "${employeeId}" is already in use — please choose a different one.`, 'danger');
        return;
    }
    if (editingEmployeeId && !probationEndDate) {
        showToast('Probation end date is required.', 'danger');
        return;
    }

    // Blank -> null (not ''), otherwise the unique constraint would treat
    // every employee without a Telegram ID as a duplicate of the others.
    const telegramChatId = document.getElementById('telegramChatIdInput').value.trim() || null;
    if (telegramChatId && !/^-?\d+$/.test(telegramChatId)) {
        showToast('Telegram chat ID must be a number, e.g. 123456789.', 'danger');
        return;
    }
    if (telegramChatId && isTelegramChatIdTaken(telegramChatId, editingEmployeeId)) {
        showToast(`Telegram chat ID "${telegramChatId}" is already linked to another employee.`, 'danger');
        return;
    }

    const payload = {
        employee_id: employeeId,
        name,
        gender: Number(document.getElementById('genderInput').value),
        role: Number(document.getElementById('roleInput').value),
        post_id: Number(postId),
        dept_id: Number(deptId),
        bu_id: Number(buId),
        supervisor_id: document.getElementById('supervisorInput').value || null,
        second_line_id: document.getElementById('secondLineInput').value || null,
        hired_date: hiredDate,
        probation_end_date: probationEndDate,
        last_day: document.getElementById('lastDayInput').value || null,
        email: document.getElementById('emailInput').value.trim() || null,
        telegram_chat_id: telegramChatId
    };

    const submitBtn = document.getElementById('employeeSubmitBtn');
    submitBtn.disabled = true;

    let error;
    if (editingEmployeeId) {
        ({ error } = await sb.from('employees').update(payload).eq('id', editingEmployeeId));
    } else {
        ({ error } = await sb.from('employees').insert(payload));
    }

    submitBtn.disabled = false;

    if (error) {
        if (error.code === '23505' && /employee_id/.test(error.message)) {
            showToast(`Employee ID "${employeeId}" is already in use — please choose a different one.`, 'danger');
        } else if (error.code === '23505' && /telegram_chat_id/.test(error.message)) {
            showToast(`Telegram chat ID "${telegramChatId}" is already linked to another employee.`, 'danger');
        } else {
            showToast('Could not save employee: ' + error.message, 'danger');
        }
        return;
    }

    const savedId = editingEmployeeId;
    showToast(savedId ? 'Employee updated.' : 'Employee added.', 'success');
    await reloadEmployees();

    if (savedId) {
        // Editing: keep the card open (it's only closed manually). Reload it
        // from the saved data so the Save button hides again.
        const fresh = currentEmployees.find(x => String(x.id) === String(savedId));
        if (fresh) populateEmployeeModal(fresh);
    } else {
        employeeModal.hide(); // a newly added employee has no card to keep open
    }
}

// ---------------------------------------------------------------------
// Portal access (link / delink) — "Portal access" button in the details
// card footer (admins only). Backed by admin_link_employee_portal() /
// admin_delink_employee_portal() in 07_employee_portal_access.sql.
// The dialog is appended inside #employeeModal (not <body>) so Bootstrap's
// focus trap keeps working for its inputs/buttons.
// ---------------------------------------------------------------------
function randomInt(max) {
    const limit = Math.floor(0x100000000 / max) * max; // rejection sampling: no modulo bias
    const buf = new Uint32Array(1);
    do { crypto.getRandomValues(buf); } while (buf[0] >= limit);
    return buf[0] % max;
}

// 12 chars, at least one upper/lower/digit/symbol, no look-alike characters (0/O, 1/l/I).
function generateRandomPassword(length = 12) {
    const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%&*?'];
    const all = sets.join('');
    const chars = sets.map(s => s[randomInt(s.length)]);
    while (chars.length < length) chars.push(all[randomInt(all.length)]);
    for (let i = chars.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join('');
}

// Email is locked while the employee is linked to a portal account (also enforced by
// trg_employees_lock_linked_email in 07_employee_portal_access.sql). Delink to edit it.
function setEmailLock(emp) {
    const input = document.getElementById('emailInput');
    const locked = !!(emp && emp.auth_user_id);
    input.disabled = locked;   // .value stays readable, so the form snapshot / save payload are unaffected
    input.title = locked ? 'Locked while linked to a portal account. Delink portal access to change it.' : '';
}

// True while the details card is open on this employee.
function isCardOpenFor(empId) {
    return document.getElementById('employeeModal').classList.contains('show')
        && employeeModalMode === 'view'
        && String(editingEmployeeId) === String(empId);
}

// After a portal link/delink: refreshes the open card's header badges, email lock and — if the
// email was just stored by the link — the Email field, without disturbing other unsaved edits.
function refreshCardBadges(emp) {
    if (!emp || !isCardOpenFor(emp.id)) return;
    document.getElementById('employeeModalBadges').innerHTML = statusBadgeHtml(isEmployeeActive(emp)) + portalBadgeHtml(emp);
    const emailInput = document.getElementById('emailInput');
    const saved = emp.email || '';
    if (emailInput.value.trim() !== saved) {
        emailInput.value = saved;
        try { // the saved value is the new baseline for this field, so it doesn't count as an unsaved change
            const snap = JSON.parse(employeeFormSnapshot);
            snap.email = saved;
            employeeFormSnapshot = JSON.stringify(snap);
        } catch { /* no snapshot yet */ }
    }
    setEmailLock(emp);
    refreshEmployeeSaveButton();
}

// ---------------------------------------------------------------------
// Portal access (link / delink) — opened from the "Portal access" button in the details card
// footer or by clicking any portal badge (admins only). Backed by admin_link_employee_portal() /
// admin_delink_employee_portal() in 07_employee_portal_access.sql. The button offered follows the
// employee's actual portal status; with no email on file, an email is entered here and stored on
// the employee together with the link.
// ---------------------------------------------------------------------
function getInitials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

function openPortalAccessDialog(empId) {
    const getEmp = () => currentEmployees.find(x => String(x.id) === String(empId));
    let emp = getEmp();
    if (!emp || !viewerIsAdmin) return;

    let password = generateRandomPassword();
    let emailDraft = isCardOpenFor(empId) ? document.getElementById('emailInput').value.trim() : ''; // no saved email: prefill from the card
    let created = null;   // { email, password, existing } — credentials are shown once, right after linking
    let busy = false;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.tabIndex = -1;
    // Inside the details card when it's open (keeps Bootstrap's focus trap happy); otherwise on <body>.
    (document.getElementById('employeeModal').classList.contains('show')
        ? document.getElementById('employeeModal')
        : document.body).appendChild(overlay);

    const close = () => { if (!busy) overlay.remove(); };

    function render() {
        emp = getEmp() || emp;
        const linked = !!emp.auth_user_id;
        const isSelf = linked && emp.auth_user_id === viewerAuthUserId;
        const savedEmail = emp.email || '';
        const active = isEmployeeActive(emp);
        const cardEmailDirty = savedEmail && isCardOpenFor(empId) && document.getElementById('emailInput').value.trim() !== savedEmail;
        let body, canLink = false, canDelink = false;
        const badge = (linked || created)
            ? '<span class="status-badge portal-badge is-linked" id="portalStatusBadge"><i class="bi bi-person-check-fill"></i><span>Linked</span></span>'
            : '<span class="status-badge portal-badge is-unlinked" id="portalStatusBadge"><i class="bi bi-person-dash"></i><span>Not linked</span></span>';
        const emailField = (label, value) => `
            <div>
                <label class="form-label"><i class="bi bi-envelope-at text-secondary"></i>${label}</label>
                <input type="text" class="form-control form-control-sm" value="${escapeHtml(value)}" readonly>
            </div>`;
        const passwordField = (value, withActions) => `
            <div>
                <label class="form-label"><i class="bi bi-key text-secondary"></i>${withActions ? 'Random password' : 'Password'}</label>
                <div class="input-group input-group-sm position-relative">
                    <input type="text" class="form-control font-monospace" value="${escapeHtml(value)}" readonly>
                    ${withActions ? `
                    <button type="button" class="btn credential-action-btn" data-action="regen" title="Generate another password" aria-label="Generate another password"><i class="bi bi-arrow-repeat"></i></button>
                    <button type="button" class="btn credential-action-btn" data-action="copy" title="Copy email and password" aria-label="Copy email and password"><i class="bi bi-clipboard"></i></button>
                    <span class="copy-success-tooltip" id="copyTooltip">Copied!</span>` : ''}
                </div>
            </div>`;

        if (created) {
            body = `
                <div class="alert alert-success py-2 px-2 small mb-2">
                    ${created.existing
                        ? 'An account with this email already existed, so it was linked as-is. Its password was <strong>not</strong> changed.'
                        : 'Portal account created and linked. Share these credentials with the employee — <strong>the password is shown only once</strong>.'}
                </div>
                <div class="credential-card">
                    ${emailField('Email', created.email)}
                    ${created.existing ? '' : passwordField(created.password, false)}
                </div>`;
        } else if (linked) {
            canDelink = !isSelf;
            body = `
                <div class="credential-card">${emailField('Portal login email', savedEmail)}</div>
                <p class="portal-note mb-0">${isSelf
                    ? 'This is your own account — you cannot delink yourself.'
                    : 'Delinking deletes this employee’s portal login and unlocks their email. Their employee record and leave data are kept. You can link them again later with a new password.'}</p>`;
        } else if (!active) {
            body = '<div class="alert alert-secondary py-2 px-2 small mb-0">This employee is inactive. Reactivate them before linking portal access.</div>';
        } else if (cardEmailDirty) {
            body = '<div class="alert alert-warning py-2 px-2 small mb-0">The email field has unsaved changes. Save the employee first so the portal account uses the saved email.</div>';
        } else {
            canLink = true;
            const emailBlock = savedEmail
                ? emailField('Login email', savedEmail)
                : `<div>
                       <label class="form-label" for="portalEmailInput"><i class="bi bi-envelope-at text-secondary"></i>Login email <span class="text-danger">*</span></label>
                       <input type="email" class="form-control form-control-sm" id="portalEmailInput" value="${escapeHtml(emailDraft)}" placeholder="name@company.com" autocomplete="off">
                       <p class="portal-note mt-1 mb-0">No email on file — it will be saved to the employee’s record when you link.</p>
                   </div>`;
            body = `
                <div class="credential-card">
                    ${emailBlock}
                    ${passwordField(password, true)}
                </div>
                <div class="security-notice-callout">
                    <i class="bi bi-exclamation-triangle-fill"></i>
                    <p>The account is created immediately and confirmed. <strong>Copy the password before linking</strong> — it can't be viewed afterwards.</p>
                </div>`;
        }

        overlay.innerHTML = `
            <div class="modal-box portal-modal">
                <div class="modal-box-header">
                    <div>
                        <h3><i class="bi bi-shield-lock-fill"></i>Portal access</h3>
                        <div class="employee-profile-strip">
                            <span class="emp-avatar-badge">${escapeHtml(getInitials(emp.name))}</span>
                            <span class="employee-name-meta">
                                <span>${escapeHtml(emp.name)}</span>
                                <span class="employee-id-tag">${escapeHtml(emp.employee_id)}</span>
                            </span>
                        </div>
                    </div>
                    <div>${badge}</div>
                </div>
                <div class="modal-box-body">${body}</div>
                <div class="modal-actions">
                    ${created ? `<button type="button" class="btn btn-outline-secondary btn-sm" data-action="copy">Copy credentials</button>` : ''}
                    <button type="button" class="btn btn-outline-secondary btn-sm" data-action="close">${created ? 'Done' : 'Close'}</button>
                    ${canLink ? '<button type="button" class="btn btn-accent btn-sm" data-action="link"><i class="bi bi-link-45deg me-1"></i>Create &amp; link</button>' : ''}
                    ${canDelink ? '<button type="button" class="btn btn-rose btn-sm" data-action="delink"><i class="bi bi-link-45deg me-1"></i>Delink</button>' : ''}
                </div>
            </div>`;
        if (busy) overlay.querySelectorAll('button').forEach(b => { b.disabled = true; });
    }

    async function afterChange() {
        await reloadEmployees();
        refreshCardBadges(getEmp());
    }

    // Keep what's typed in the email box across re-renders (e.g. after "regenerate").
    overlay.addEventListener('input', (e) => {
        if (e.target.id === 'portalEmailInput') emailDraft = e.target.value;
    });

    overlay.addEventListener('click', async (e) => {
        if (e.target === overlay) { close(); return; }
        const btn = e.target.closest('button[data-action]');
        if (!btn || busy) return;
        const action = btn.dataset.action;

        if (action === 'close') { close(); return; }

        if (action === 'regen') { password = generateRandomPassword(); render(); return; }

        if (action === 'copy') {
            const mail = created ? created.email : (emp.email || emailDraft.trim());
            const text = created
                ? `Email: ${mail}${created.existing ? '' : `\nPassword: ${created.password}`}`
                : `Email: ${mail}\nPassword: ${password}`;
            try {
                await navigator.clipboard.writeText(text);
                const tip = overlay.querySelector('#copyTooltip');
                if (tip) { tip.classList.add('show'); setTimeout(() => tip.classList.remove('show'), 1800); }
                else showToast('Copied to clipboard.', 'success');
            }
            catch { showToast('Could not copy — select the text and copy it manually.', 'danger'); }
            return;
        }

        if (action === 'link') {
            const savedEmail = emp.email || '';
            const email = savedEmail || emailDraft.trim().toLowerCase();
            if (!savedEmail) {
                if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                    showToast('Please enter a valid email address.', 'danger');
                    return;
                }
                if (currentEmployees.some(x => String(x.id) !== String(emp.id) && (x.email || '').trim().toLowerCase() === email)) {
                    showToast(`Email "${email}" is already used by another employee.`, 'danger');
                    return;
                }
            }
            busy = true; render();
            const { data, error } = await sb.rpc('admin_link_employee_portal', {
                p_employee_uuid: emp.id,
                p_password: password,
                p_email: savedEmail ? null : email
            });
            busy = false;
            if (error) { showToast('Could not link portal access: ' + error.message, 'danger'); render(); return; }
            created = { email: data?.email || email, password, existing: data?.status === 'linked_existing' };
            showToast('Portal access linked.', 'success');
            await afterChange();
            render();
            return;
        }

        if (action === 'delink') {
            const ok = await showConfirmDialog({
                title: 'Delink portal access',
                message: `Delete the portal login of <strong>${escapeHtml(emp.name)}</strong>? They will no longer be able to sign in. Their employee record and leave data are kept.`,
                confirmLabel: 'Delink',
                danger: true
            });
            if (!ok) return;
            busy = true; render();
            const { error } = await sb.rpc('admin_delink_employee_portal', { p_employee_uuid: emp.id });
            busy = false;
            if (error) { showToast('Could not delink portal access: ' + error.message, 'danger'); render(); return; }
            showToast('Portal access delinked.', 'success');
            overlay.remove(); // done — close the dialog
            await afterChange();
        }
    });

    // Esc closes just this dialog, not the employee card underneath.
    overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); close(); }
    });

    render();
    overlay.focus();
}

async function onEndEmployment(emp) {
    const today = new Date().toISOString().slice(0, 10);
    const value = await promptDateDialog({
        title: 'End employment',
        message: `Set a last day for <strong>${escapeHtml(emp.name)}</strong>. This marks them inactive but keeps their record — nothing is deleted.`,
        defaultValue: today,
        confirmLabel: 'Set last day'
    });
    if (!value) return;

    const { error } = await sb.from('employees').update({ last_day: value }).eq('id', emp.id);
    if (error) {
        showToast('Could not update: ' + error.message, 'danger');
        return;
    }
    showToast('Last day set.', 'success');
    await reloadEmployees();
}

async function onReactivate(emp) {
    const ok = await showConfirmDialog({
        title: 'Reactivate employee',
        message: `Clear the last day for <strong>${escapeHtml(emp.name)}</strong> and mark them active again?`,
        confirmLabel: 'Reactivate'
    });
    if (!ok) return false;

    const { error } = await sb.from('employees').update({ last_day: null }).eq('id', emp.id);
    if (error) {
        showToast('Could not update: ' + error.message, 'danger');
        return false;
    }
    showToast('Employee reactivated.', 'success');
    await reloadEmployees();
    return true; // lets the details card refresh itself
}

// ---------------------------------------------------------------------
// CSV / Excel bulk upload + preview
// ---------------------------------------------------------------------
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

            const firstSheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[firstSheetName];
            const jsonRows = XLSX.utils.sheet_to_json(worksheet, { defval: '' });

            if (jsonRows.length === 0) {
                showError('The uploaded file contains no data.');
                return;
            }

            processRows(jsonRows);
        } catch (err) {
            showError(`Failed to parse file: ${err.message}`);
        }
    };

    reader.onerror = () => showError('Error reading file from disk.');
    reader.readAsArrayBuffer(file);
}

function processRows(jsonRows) {
    const rawHeaders = Object.keys(jsonRows[0]);

    const headerToField = {};
    const mappedFields = [];
    rawHeaders.forEach(rawHeader => {
        const norm = normalizeHeader(rawHeader);
        for (const [field, aliases] of Object.entries(SCHEMA_FIELDS)) {
            if (aliases.includes(norm) && !mappedFields.includes(field)) {
                headerToField[rawHeader] = field;
                mappedFields.push(field);
                break;
            }
        }
    });

    const missingRequired = REQUIRED_FIELDS.filter(f => !mappedFields.includes(f));
    if (missingRequired.length > 0) {
        showError(`The file is missing required column(s) for: ${missingRequired.map(f => HEADER_LABELS[f] || f).join(', ')}.`);
        return;
    }

    const allSchemaFields = Object.keys(SCHEMA_FIELDS);
    const mappedRows = jsonRows.map(row => {
        const out = {};
        allSchemaFields.forEach(f => { out[f] = null; });
        for (const [rawHeader, field] of Object.entries(headerToField)) {
            const val = row[rawHeader];
            if (val === undefined || val === null || val === '') { out[field] = null; continue; }
            if (DATE_FIELDS.includes(field)) {
                out[field] = normalizeDateCell(val);
            } else if (field === 'gender') {
                out[field] = normalizeGenderValue(val);
            } else if (field === 'role') {
                out[field] = String(val).trim().toLowerCase();
            } else {
                const str = String(val).trim();
                out[field] = str === '' ? null : str;
            }
        }
        return out;
    });

    const validRowsRaw = [];
    let invalidCount = 0;
    mappedRows.forEach(row => {
        const hasRequired = REQUIRED_FIELDS.every(f => row[f] !== null && row[f] !== '');
        const genderOk = row.gender === 'female' || row.gender === 'male';
        const roleOk = !row.role || row.role === 'user' || row.role === 'admin';
        if (hasRequired && genderOk && roleOk) validRowsRaw.push(row);
        else invalidCount++;
    });

    const seenEmployeeIds = new Set();
    const seenEmails = new Set();
    const validRows = [];
    let duplicateInFileCount = 0;
    validRowsRaw.forEach(row => {
        const empIdKey = row.employee_id ? row.employee_id.toLowerCase() : null;
        const emailKey = row.email ? row.email.toLowerCase() : null;
        const isDupInFile = (empIdKey && seenEmployeeIds.has(empIdKey)) || (emailKey && seenEmails.has(emailKey));
        if (isDupInFile) {
            duplicateInFileCount++;
        } else {
            if (empIdKey) seenEmployeeIds.add(empIdKey);
            if (emailKey) seenEmails.add(emailKey);
            validRows.push(row);
        }
    });

    const existingIds = new Set();
    const existingEmails = new Set();
    currentEmployees.forEach(emp => {
        if (emp.employee_id) existingIds.add(String(emp.employee_id).toLowerCase());
        if (emp.email) existingEmails.add(String(emp.email).toLowerCase());
    });
    let existingCount = 0;
    validRows.forEach(row => {
        const empIdKey = row.employee_id ? row.employee_id.toLowerCase() : null;
        const emailKey = row.email ? row.email.toLowerCase() : null;
        if ((empIdKey && existingIds.has(empIdKey)) || (emailKey && existingEmails.has(emailKey))) {
            existingCount++;
        }
    });

    currentDataset = { validRows, invalidCount, duplicateInFileCount, existingCount, mappedFields, rawHeaders };

    renderSummary(currentDataset);
    renderPreviewTable();
    tableContainer.classList.remove('hidden');
    filePicker.classList.add('compact');
}

function renderPreviewTable() {
    renderPreviewRows(
        tableHeader, tableBody, Object.keys(SCHEMA_FIELDS), currentDataset.validRows,
        1000, true,
        { onEdit: handleEditPreviewRow, onDelete: handleDeletePreviewRow }
    );
}

async function handleEditPreviewRow(row, index) {
    const updated = await editRowDialog(row);
    if (!updated) return;

    const empIdKey = updated.employee_id ? updated.employee_id.toLowerCase() : null;
    const emailKey = updated.email ? updated.email.toLowerCase() : null;
    const isDuplicate = currentDataset.validRows.some((r, i) => {
        if (i === index) return false;
        const rEmpId = r.employee_id ? r.employee_id.toLowerCase() : null;
        const rEmail = r.email ? r.email.toLowerCase() : null;
        return (empIdKey && rEmpId === empIdKey) || (emailKey && rEmail === emailKey);
    });
    if (isDuplicate) {
        alert('This Employee ID or Email is already used by another row in this preview. Please use a unique value.');
        return;
    }

    currentDataset.validRows[index] = updated;
    renderSummary(currentDataset);
    renderPreviewTable();
}

async function handleDeletePreviewRow(row, index) {
    const confirmed = await showConfirmDialog({
        title: 'Delete row',
        message: `Remove "${escapeHtml(row.name)}" from this preview? It won't be uploaded. This only affects the preview — nothing has been saved yet.`,
        confirmLabel: 'Delete',
        danger: true
    });
    if (!confirmed) return;

    currentDataset.validRows.splice(index, 1);
    renderSummary(currentDataset);
    renderPreviewTable();
}

function renderSummary(ds) {
    summaryContainer.classList.remove('hidden');
    const total = ds.validRows.length + ds.invalidCount + ds.duplicateInFileCount;
    summaryContainer.innerHTML = `
        <span class="stat-item">Rows in file <span class="stat-value">${total}</span></span>
        <span class="stat-item">Valid <span class="stat-value num-emerald">${ds.validRows.length}</span></span>
        <span class="stat-item">Skipped (missing/invalid fields) <span class="stat-value num-rose">${ds.invalidCount}</span></span>
        <span class="stat-item">Duplicate in file <span class="stat-value num-amber">${ds.duplicateInFileCount}</span></span>
        ${ds.existingCount > 0 ? `<span class="stat-item">Already in database <span class="stat-value num-amber">${ds.existingCount}</span></span>` : ''}
    `;
}

function renderPreviewRows(headerEl, bodyEl, fields, rows, cap = 1000, capNote = true, actions = null) {
    const hasActions = !!(actions && (actions.onEdit || actions.onDelete));
    const colCount = fields.length + 1 + (hasActions ? 1 : 0);

    let headerHtml = '<tr><th class="idx-col">#</th>';
    fields.forEach(field => { headerHtml += `<th>${escapeHtml(HEADER_LABELS[field] || field)}</th>`; });
    if (hasActions) {
        headerHtml += `<th class="actions-col">Action</th>`;
    }
    headerHtml += '</tr>';
    headerEl.innerHTML = headerHtml;

    if (rows.length === 0) {
        bodyEl.innerHTML = `<tr><td colspan="${colCount}"><div class="empty-state">No records to display.</div></td></tr>`;
        return;
    }

    const fragment = document.createDocumentFragment();
    rows.slice(0, cap).forEach((row, i) => {
        const tr = document.createElement('tr');

        const idxTd = document.createElement('td');
        idxTd.className = 'idx-col';
        idxTd.textContent = i + 1;
        tr.appendChild(idxTd);

        fields.forEach(field => {
            const td = document.createElement('td');
            let displayVal = row[field] !== null && row[field] !== undefined ? row[field] : '';
            // Underlying value stays the lowercase full word ("female"/
            // "male") the RPCs expect — only the preview display is
            // capitalized, regardless of whether the source file had
            // "F", "m", "FEMALE", etc.
            if (field === 'gender' && displayVal) displayVal = capitalize(displayVal);
            td.textContent = displayVal;
            tr.appendChild(td);
        });

        if (hasActions) {
            const actionTd = document.createElement('td');
            actionTd.className = 'actions-col';
            const wrap = document.createElement('div');
            wrap.className = 'actions-wrap';

            if (actions.onEdit) {
                const editBtn = document.createElement('button');
                editBtn.type = 'button';
                editBtn.className = 'btn-icon-only';
                editBtn.title = 'Edit this row';
                editBtn.innerHTML = editIconSvg();
                editBtn.addEventListener('click', () => actions.onEdit(row, i));
                wrap.appendChild(editBtn);
            }

            if (actions.onDelete) {
                const delBtn = document.createElement('button');
                delBtn.type = 'button';
                delBtn.className = 'btn-icon-only';
                delBtn.title = 'Delete this row';
                delBtn.innerHTML = trashIconSvg();
                delBtn.addEventListener('click', () => actions.onDelete(row, i));
                wrap.appendChild(delBtn);
            }

            actionTd.appendChild(wrap);
            tr.appendChild(actionTd);
        }

        fragment.appendChild(tr);
    });

    if (capNote && rows.length > cap) {
        const noteTr = document.createElement('tr');
        const noteTd = document.createElement('td');
        noteTd.colSpan = colCount;
        noteTd.style.fontStyle = 'italic';
        noteTd.style.color = 'var(--ink-faint)';
        noteTd.textContent = `Preview capped at first ${cap} rows — all rows are still included in the upload.`;
        noteTr.appendChild(noteTd);
        fragment.appendChild(noteTr);
    }

    bodyEl.replaceChildren(fragment);
}

function showError(message) {
    errorContainer.textContent = message;
    errorContainer.classList.remove('hidden');
}

function showStatus(html) {
    statusContainer.innerHTML = html;
    statusContainer.classList.remove('hidden');
}

function clearMessages() {
    errorContainer.classList.add('hidden');
    statusContainer.classList.add('hidden');
}

function resetUploadPreview() {
    errorContainer.classList.add('hidden');
    summaryContainer.classList.add('hidden');
    tableContainer.classList.add('hidden');
    tableHeader.innerHTML = '';
    tableBody.innerHTML = '';
    currentDataset = null;
    filePicker.classList.remove('compact');
    fileInput.value = '';
}

async function onAppendClick() {
    if (!currentDataset || currentDataset.validRows.length === 0) return;

    appendBtn.disabled = true;
    try {
        const attempted = currentDataset.validRows.length;
        const confirmed = await showConfirmDialog({
            title: 'Confirm append',
            message: `This will insert up to ${attempted} new employee(s) into "employees". Rows whose Employee ID or Email already exists are skipped automatically. Existing data will not be changed or removed.`,
            confirmLabel: `Append ${attempted} record(s)`
        });
        if (!confirmed) { appendBtn.disabled = false; showStatus('Append cancelled.'); return; }

        showStatus('Uploading…');
        const { data: insertedCount, error } = await sb.rpc('admin_append_employees', { p_rows: currentDataset.validRows });
        if (error) throw error;

        resetUploadPreview();
        setUploadPanelOpen(false);
        await loadLookups(); // new positions/departments/business units may have been created
        populateFixedSelects();
        await reloadEmployees();

        const skipped = attempted - insertedCount;
        showStatus(`<span class="num-emerald">Success — added ${insertedCount} employee(s).</span>${skipped > 0 ? ` Skipped ${skipped} row(s) that already existed.` : ''}`);
    } catch (err) {
        showStatus(`<span class="num-rose">Append failed: ${escapeHtml(err.message || String(err))}</span>`);
    } finally {
        appendBtn.disabled = false;
    }
}

async function onOverwriteClick() {
    if (!currentDataset || currentDataset.validRows.length === 0) return;

    overwriteBtn.disabled = true;
    try {
        const confirmed = await showConfirmDialog({
            title: 'Confirm overwrite',
            message: `This will PERMANENTLY DELETE ALL existing rows in "employees" and replace them with ${currentDataset.validRows.length} record(s) from this file. This cannot be undone.`,
            confirmLabel: 'Overwrite table',
            danger: true
        });
        if (!confirmed) { overwriteBtn.disabled = false; showStatus('Overwrite cancelled.'); return; }

        showStatus('Overwriting table…');
        const { data: insertedCount, error } = await sb.rpc('admin_overwrite_employees', { p_rows: currentDataset.validRows });
        if (error) throw error;

        resetUploadPreview();
        setUploadPanelOpen(false);
        await loadLookups();
        populateFixedSelects();
        await reloadEmployees();
        showStatus(`<span class="num-emerald">Success — table overwritten with ${insertedCount} record(s).</span>`);
    } catch (err) {
        showStatus(`<span class="num-rose">Overwrite failed: ${escapeHtml(err.message || String(err))}</span>`);
    } finally {
        overwriteBtn.disabled = false;
    }
}