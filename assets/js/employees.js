// =====================================================================
// employees.html — admin-only employee CRUD + spreadsheet import
//
// Built directly on sidebar.js's `ess:ready` event (session + employee
// + admin check are already handled there) — this file does not depend
// on nav.js/auth.js/utils.js from the Roombook app, so it carries its
// own small toast / confirm-dialog / formatting helpers instead.
//
// Soft-delete: "removing" an employee sets `last_day` rather than
// deleting the row (an ordinary admin UPDATE, already covered by RLS).
// The row's Action column then offers "Reactivate" instead of "Edit"/
// "End employment" once last_day has passed.
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
let lookups = { genders: [], roles: [], positions: [], departments: [], businessUnits: [] };
let currentEmployees = [];
let currentDataset = null;

// Schema definition: field -> accepted header aliases (normalized)
const SCHEMA_FIELDS = {
    employee_id:        ['employeeid', 'id', 'empid'],
    name:                ['name', 'fullname', 'employeename'],
    gender:              ['gender', 'sex'],
    position:            ['position', 'jobtitle', 'title'],
    department:          ['department', 'dept'],
    business_unit:       ['businessunit', 'bu', 'unit'],
    supervisor:          ['supervisor', 'manager', 'reportsto'],
    hired_date:          ['hireddate', 'datehired', 'startdate', 'joindate'],
    probation_end_date: ['probationenddate', 'probationend'],
    last_day:            ['lastday', 'enddate', 'terminationdate'],
    role:                ['role', 'accessrole', 'userrole'],
    email:               ['email', 'emailaddress']
};
const REQUIRED_FIELDS = ['name', 'gender', 'position', 'department', 'business_unit', 'hired_date'];
const DATE_FIELDS = ['hired_date', 'probation_end_date', 'last_day'];

const HEADER_LABELS = {
    employee_id: 'Employee ID',
    name: 'Name',
    gender: 'Gender',
    position: 'Position',
    department: 'Department',
    business_unit: 'Business unit',
    supervisor: 'Supervisor',
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
// objects (XLSX with cellDates:true, read via UTC getters to avoid a
// local-timezone off-by-one) as well as plain strings from CSV.
function normalizeDateCell(value) {
    if (value instanceof Date && !isNaN(value)) {
        const y = value.getUTCFullYear();
        const m = String(value.getUTCMonth() + 1).padStart(2, '0');
        const d = String(value.getUTCDate()).padStart(2, '0');
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

function getSupervisorName(emp) {
    if (!emp.supervisor_info) return '';
    if (Array.isArray(emp.supervisor_info)) {
        return emp.supervisor_info[0]?.name || '';
    }
    return emp.supervisor_info.name || '';
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
            const genderVal = String(updated.gender || '').toLowerCase();
            if (genderVal !== 'female' && genderVal !== 'male') {
                alert('Gender must be "female" or "male".');
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
const exportExcelBtn = document.getElementById('exportExcelBtn');
const viewListContainer = document.getElementById('viewListContainer');
const viewListMeta = document.getElementById('viewListMeta');
const viewListHeader = document.getElementById('viewListHeader');
const viewListBody = document.getElementById('viewListBody');
const filterBusinessUnitInput = document.getElementById('filterBusinessUnitInput');
const filterStatusInput = document.getElementById('filterStatusInput');
const supervisorSearchInput = document.getElementById('supervisorSearchInput');
const supervisorMenu = document.getElementById('supervisorMenu');
let displayedEmployees = []; // currently rendered rows (after filters), used by Export Excel

window.addEventListener('ess:ready', onEssReady);

async function onEssReady(e) {
    const { session, employee } = e.detail;
    if (!session) return; // sidebar.js already redirected to login, or Supabase isn't configured

    const isAdmin = employee?.role === 1;
    if (!isAdmin) {
        document.getElementById('adminGate').style.display = 'block';
        return;
    }

    document.getElementById('employeesContent').style.display = 'block';
    await init();
}

async function init() {
    employeeModal = new bootstrap.Modal(document.getElementById('employeeModal'));

    await loadLookups();
    populateFixedSelects();
    wireEvents();
    wireSupervisorSearch();

    await Promise.all([loadStats(), loadEmployees()]);
}

function wireEvents() {
    document.getElementById('addEmployeeBtn').addEventListener('click', () => openEmployeeModal(null));
    document.getElementById('employeeForm').addEventListener('submit', onSubmitEmployee);

    refreshListBtn.addEventListener('click', () => { clearMessages(); loadEmployees(); loadStats(); });
    exportExcelBtn.addEventListener('click', onExportExcelClick);
    filterBusinessUnitInput.addEventListener('change', applyFilters);
    filterStatusInput.addEventListener('change', applyFilters);
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
        sb.from('positions').select('post_id, position').order('position'),
        sb.from('departments').select('dept_id, department').order('department'),
        sb.from('business_units').select('bu_id, business_unit').order('business_unit')
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

function populateFixedSelects() {
    fillSelect('genderInput', lookups.genders, 'gender_id', 'gender_name', capitalize);
    fillSelect('roleInput', lookups.roles, 'role_id', 'role_name', capitalize);
    fillSelect('positionInput', lookups.positions, 'post_id', 'position');
    fillSelect('departmentInput', lookups.departments, 'dept_id', 'department');
    fillSelect('businessUnitInput', lookups.businessUnits, 'bu_id', 'business_unit');

    const currentBuFilter = filterBusinessUnitInput.value;
    filterBusinessUnitInput.innerHTML = '<option value="">All business units</option>' +
        lookups.businessUnits.map(b => `<option value="${b.bu_id}">${escapeHtml(b.business_unit)}</option>`).join('');
    filterBusinessUnitInput.value = currentBuFilter; // keep selection if it still exists
}

// ---------------------------------------------------------------------
// Supervisor search-select — a search input + filtered dropdown list,
// standing in for a plain <select> now that the employee list can be
// too long to scan. The hidden #supervisorInput still holds the chosen
// employee's id, so onSubmitEmployee() didn't need to change.
// ---------------------------------------------------------------------
let supervisorSearchExcludeId = null;

function setSupervisorSelection(emp) {
    document.getElementById('supervisorInput').value = emp ? emp.id : '';
    supervisorSearchInput.value = emp ? `${emp.name} (${emp.employee_id})` : '';
}

function closeSupervisorMenu() {
    supervisorMenu.classList.add('d-none');
}

function renderSupervisorMenu(filterText) {
    const term = filterText.trim().toLowerCase();
    const matches = currentEmployees
        .filter(emp => String(emp.id) !== String(supervisorSearchExcludeId))
        .filter(emp => !term || emp.name.toLowerCase().includes(term) || String(emp.employee_id).toLowerCase().includes(term))
        .slice(0, 50); // cap so a large org doesn't render an enormous list

    let html = `<button type="button" class="list-group-item list-group-item-action fst-italic small py-1 px-2" data-supervisor-id="">— None —</button>`;
    if (matches.length > 0) {
        html += matches.map(emp =>
            `<button type="button" class="list-group-item list-group-item-action small py-1 px-2" data-supervisor-id="${emp.id}">${escapeHtml(emp.name)} <span class="text-muted">(${escapeHtml(emp.employee_id)})</span></button>`
        ).join('');
    } else if (term) {
        html += `<div class="list-group-item text-muted small py-1 px-2">No matches for "${escapeHtml(filterText.trim())}"</div>`;
    }
    supervisorMenu.innerHTML = html;
    supervisorMenu.classList.remove('d-none');
}

// Called once from wireEvents() to attach the listeners; initSupervisorSearch()
// (below) is what re-primes it each time the modal opens.
function wireSupervisorSearch() {
    supervisorSearchInput.addEventListener('focus', () => renderSupervisorMenu(supervisorSearchInput.value));
    supervisorSearchInput.addEventListener('input', () => renderSupervisorMenu(supervisorSearchInput.value));
    supervisorSearchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeSupervisorMenu();
    });
    supervisorMenu.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-supervisor-id]');
        if (!btn) return;
        const id = btn.getAttribute('data-supervisor-id');
        const emp = id ? currentEmployees.find(x => String(x.id) === id) : null;
        setSupervisorSelection(emp);
        closeSupervisorMenu();
    });
    // Typed text that was never picked from the list shouldn't silently
    // keep whatever supervisor was previously selected (or send free text
    // as if it were a valid id) — reconcile on blur. The short delay lets
    // a click on a menu item (which blurs the input first) register.
    supervisorSearchInput.addEventListener('blur', () => {
        setTimeout(() => {
            const hiddenId = document.getElementById('supervisorInput').value;
            const selectedEmp = hiddenId ? currentEmployees.find(x => String(x.id) === hiddenId) : null;
            const expectedText = selectedEmp ? `${selectedEmp.name} (${selectedEmp.employee_id})` : '';
            if (supervisorSearchInput.value.trim() !== expectedText) {
                setSupervisorSelection(null);
            }
            closeSupervisorMenu();
        }, 150);
    });
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#supervisorSelectWrap')) closeSupervisorMenu();
    });
}

function initSupervisorSearch(excludeId, selectedEmp) {
    supervisorSearchExcludeId = excludeId;
    setSupervisorSelection(selectedEmp || null);
    closeSupervisorMenu();
}

// ---------------------------------------------------------------------
// Stat cards
// ---------------------------------------------------------------------
async function loadStats() {
    const { data, error } = await sb.rpc('admin_get_employee_stats');
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
            id, employee_id, name, hired_date, probation_end_date, last_day, email, auth_user_id,
            gender, post_id, dept_id, bu_id, role, supervisor_id,
            gender_info:genders(gender_name),
            position_info:positions!post_id(position),
            department_info:departments!dept_id(department),
            business_unit_info:business_units!bu_id(business_unit),
            role_info:roles(role_name),
            supervisor_info:supervisor_id(name)
        `)
        .order('employee_id', { ascending: true });

    if (error) {
        showError('Could not load employees: ' + error.message);
        return;
    }

    currentEmployees = data || []; // full master list — used for supervisor dropdown + filtering
    applyFilters();
}

function isEmployeeActive(emp) {
    const today = new Date().toISOString().slice(0, 10);
    return !emp.last_day || emp.last_day >= today;
}

function applyFilters() {
    const buFilter = filterBusinessUnitInput.value;
    const statusFilter = filterStatusInput.value; // '', 'active', 'inactive'

    const filtered = currentEmployees.filter(emp => {
        if (buFilter && String(emp.bu_id) !== buFilter) return false;
        if (statusFilter) {
            const isActive = isEmployeeActive(emp);
            if (statusFilter === 'active' && !isActive) return false;
            if (statusFilter === 'inactive' && isActive) return false;
        }
        return true;
    });

    renderTable(filtered, currentEmployees.length);
}

function renderTable(employees, totalCount) {
    displayedEmployees = employees;
    const total = totalCount ?? employees.length;
    viewListMeta.textContent = total === employees.length
        ? `${employees.length} record(s) in "employees"`
        : `${employees.length} of ${total} record(s) in "employees"`;

    const columns = ['Employee ID', 'Name', 'Position', 'Department', 'Business unit', 'Supervisor', 'Hired date', 'Status'];
    let headerHtml = '<tr><th class="idx-col">#</th>';
    columns.forEach(c => { headerHtml += `<th>${c}</th>`; });
    headerHtml += '<th class="actions-col">Action</th></tr>';
    viewListHeader.innerHTML = headerHtml;

    if (employees.length === 0) {
        const msg = total === 0
            ? 'No employees yet — add one, or upload a spreadsheet.'
            : 'No employees match the current filters.';
        viewListBody.innerHTML = `<tr><td colspan="${columns.length + 2}"><div class="empty-state">${msg}</div></td></tr>`;
        return;
    }

    const fragment = document.createDocumentFragment();

    employees.forEach((emp, i) => {
        const isActive = isEmployeeActive(emp);
        const supervisorName = getSupervisorName(emp);
        const tr = document.createElement('tr');

        const idxTd = document.createElement('td');
        idxTd.className = 'idx-col';
        idxTd.textContent = i + 1;
        tr.appendChild(idxTd);

        const cellValues = [
            `<strong>${escapeHtml(emp.employee_id)}</strong>`,
            escapeHtml(emp.name),
            escapeHtml(emp.position_info?.position || '—'),
            escapeHtml(emp.department_info?.department || '—'),
            escapeHtml(emp.business_unit_info?.business_unit || '—'),
            escapeHtml(supervisorName || '—'),
            escapeHtml(formatDateLong(parseDateOnly(emp.hired_date))),
            isActive
                ? '<span class="status-badge is-active">Active</span>'
                : '<span class="status-badge is-terminated">Inactive</span>'
        ];

        cellValues.forEach(html => {
            const td = document.createElement('td');
            td.innerHTML = html;
            tr.appendChild(td);
        });

        const actionTd = document.createElement('td');
        actionTd.className = 'actions-col';
        const wrap = document.createElement('div');
        wrap.className = 'actions-wrap';

        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'btn-icon-only';
        editBtn.innerHTML = editIconSvg();
        if (isActive) {
            editBtn.title = 'Edit this employee';
            editBtn.addEventListener('click', () => openEmployeeModal(emp));
        } else {
            // Not using the native `disabled` attribute here: some browsers
            // (notably Firefox) suppress the title tooltip on disabled
            // buttons. No click listener is attached in this branch, so the
            // button is already inert — this just makes it look and act
            // (cursor-wise) unclickable while the tooltip keeps working.
            editBtn.title = 'Inactive employees can\'t be edited — reactivate first';
            editBtn.setAttribute('aria-disabled', 'true');
            editBtn.classList.add('is-disabled');
            editBtn.style.opacity = '0.4';
            editBtn.style.cursor = 'not-allowed';
        }
        wrap.appendChild(editBtn);

        if (isActive) {
            const endBtn = document.createElement('button');
            endBtn.type = 'button';
            endBtn.className = 'btn-icon-only';
            endBtn.title = 'End employment (sets Last day)';
            endBtn.innerHTML = trashIconSvg();
            endBtn.addEventListener('click', () => onEndEmployment(emp));
            wrap.appendChild(endBtn);
        } else {
            const reactivateBtn = document.createElement('button');
            reactivateBtn.type = 'button';
            reactivateBtn.className = 'btn-icon-only';
            reactivateBtn.title = 'Reactivate (clears Last day)';
            reactivateBtn.innerHTML = undoIconSvg();
            reactivateBtn.addEventListener('click', () => onReactivate(emp));
            wrap.appendChild(reactivateBtn);
        }

        actionTd.appendChild(wrap);
        tr.appendChild(actionTd);

        fragment.appendChild(tr);
    });

    viewListBody.replaceChildren(fragment);
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
        'Role': capitalize(emp.role_info?.role_name || ''),
        'Hired date': emp.hired_date || '',
        'Probation end date': emp.probation_end_date || '',
        'Last day': emp.last_day || '',
        'Status': isEmployeeActive(emp) ? 'Active' : 'Inactive',
        'Email': emp.email || ''
    }));

    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Employees');
    XLSX.writeFile(workbook, `employees_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

// ---------------------------------------------------------------------
// Add / edit (single-record form)
// ---------------------------------------------------------------------
function openEmployeeModal(emp) {
    if (emp && !isEmployeeActive(emp)) return; // safety net — inactive employees are edit-locked in the UI

    editingEmployeeId = emp ? emp.id : null;
    document.getElementById('employeeModalTitle').textContent = emp ? 'Edit employee' : 'Add employee';
    document.getElementById('employeeIdInput').value = emp ? emp.employee_id : '';

    document.getElementById('nameInput').value = emp ? emp.name : '';
    document.getElementById('genderInput').value = emp ? emp.gender : (lookups.genders[0]?.gender_id ?? '');
    const defaultRole = lookups.roles.find(r => r.role_name === 'user')?.role_id ?? lookups.roles[0]?.role_id ?? '';
    document.getElementById('roleInput').value = emp ? emp.role : defaultRole;
    document.getElementById('positionInput').value = emp ? emp.post_id : (lookups.positions[0]?.post_id ?? '');
    document.getElementById('departmentInput').value = emp ? emp.dept_id : (lookups.departments[0]?.dept_id ?? '');
    document.getElementById('businessUnitInput').value = emp ? emp.bu_id : (lookups.businessUnits[0]?.bu_id ?? '');

    const currentSupervisor = (emp && emp.supervisor_id)
        ? currentEmployees.find(x => String(x.id) === String(emp.supervisor_id))
        : null;
    initSupervisorSearch(emp ? emp.id : null, currentSupervisor);

    document.getElementById('hiredDateInput').value = emp ? emp.hired_date : '';
    document.getElementById('probationEndDateInput').value = emp ? (emp.probation_end_date || '') : '';
    document.getElementById('probationHint').style.display = emp ? 'none' : 'inline';
    document.getElementById('lastDayInput').value = emp ? (emp.last_day || '') : '';
    document.getElementById('emailInput').value = emp ? (emp.email || '') : '';

    employeeModal.show();
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

    const employeeId = document.getElementById('employeeIdInput').value.trim();
    const name = document.getElementById('nameInput').value.trim();
    const hiredDate = document.getElementById('hiredDateInput').value;
    const probationEndDate = document.getElementById('probationEndDateInput').value || null;

    if (!employeeId || !name || !hiredDate) {
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

    const payload = {
        employee_id: employeeId,
        name,
        gender: Number(document.getElementById('genderInput').value),
        role: Number(document.getElementById('roleInput').value),
        post_id: Number(document.getElementById('positionInput').value),
        dept_id: Number(document.getElementById('departmentInput').value),
        bu_id: Number(document.getElementById('businessUnitInput').value),
        supervisor_id: document.getElementById('supervisorInput').value || null,
        hired_date: hiredDate,
        probation_end_date: probationEndDate,
        last_day: document.getElementById('lastDayInput').value || null,
        email: document.getElementById('emailInput').value.trim() || null
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
        } else {
            showToast('Could not save employee: ' + error.message, 'danger');
        }
        return;
    }

    showToast(editingEmployeeId ? 'Employee updated.' : 'Employee added.', 'success');
    employeeModal.hide();
    await Promise.all([loadEmployees(), loadStats()]);
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
    await Promise.all([loadEmployees(), loadStats()]);
}

async function onReactivate(emp) {
    const ok = await showConfirmDialog({
        title: 'Reactivate employee',
        message: `Clear the last day for <strong>${escapeHtml(emp.name)}</strong> and mark them active again?`,
        confirmLabel: 'Reactivate'
    });
    if (!ok) return;

    const { error } = await sb.from('employees').update({ last_day: null }).eq('id', emp.id);
    if (error) {
        showToast('Could not update: ' + error.message, 'danger');
        return;
    }
    showToast('Employee reactivated.', 'success');
    await Promise.all([loadEmployees(), loadStats()]);
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
            } else if (field === 'gender' || field === 'role') {
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
            td.textContent = row[field] !== null && row[field] !== undefined ? row[field] : '';
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
        await Promise.all([loadEmployees(), loadStats()]);

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
        await Promise.all([loadEmployees(), loadStats()]);
        showStatus(`<span class="num-emerald">Success — table overwritten with ${insertedCount} record(s).</span>`);
    } catch (err) {
        showStatus(`<span class="num-rose">Overwrite failed: ${escapeHtml(err.message || String(err))}</span>`);
    } finally {
        overwriteBtn.disabled = false;
    }
}