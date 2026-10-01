// =====================================================================
// dashboard.js — dashboard page (pages/dashboard.html)
//
// Built on sidebar.js's `ess:ready` event. Load AFTER: supabaseClient.js,
// sidebar.js, leaveDetail.js and leaveRequestModal.js (and Bootstrap's JS
// bundle). Uses the shared `sb` client and the LeaveDetail /
// LeaveRequestModal globals. Renders the hero, stats, balances, pending
// requests, team absence, policies and holidays, and wires the Leave
// details modal (approve / reject / edit / cancel, gated like leaves.js)
// and the "Request Leave" button.
// =====================================================================
(function () {
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  // Same columns leaves.js loads (requestSelect()), so a row can be handed straight to
  // LeaveRequestModal.openEdit() and to the Leave details modal.
  const REQUEST_COLS = 'id, employee_id, leave_type_id, start_date, start_half_day, end_date, end_half_day, ' +
    'total_days, total_days_manual, reason, status, rejection_reason, approved_at, created_at, requested_by, requested_by_admin, approved_by_admin, ' +
    'employee:employee_id(name, employee_id), leave_type:leave_type_id(leave_type), approver:approved_by(name)';
  const $ = (id) => document.getElementById(id);

  // ---- helpers -------------------------------------------------------
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; // local date, not UTC
  const num = (n) => Number(n ?? 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const fmtDate = (s) => {                       // 'yyyy-mm-dd' -> '12 Oct' (no timezone shift)
    if (!s) return '';
    const [, m, d] = s.split('-').map(Number);
    return `${d} ${MONTHS[m - 1]}`;
  };
  const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const fmtRange = (a, b) => (a === b ? fmtDate(a) : `${fmtDate(a)} – ${fmtDate(b)}`);
  const empty = (msg) => `<div class="empty-state">${esc(msg)}</div>`;
  const fmtEmp = (name, code) => (name ? (code ? `${name} (${code})` : name) : (code || '—'));

  function setStat(id, value) {
    const el = $(id);
    el.classList.remove('is-loading');
    el.textContent = value;
  }
  function failStat(id) {
    const el = $(id);
    el.classList.add('is-loading');
    el.textContent = 'Unavailable';
  }
  function showError(msg) {
    const el = $('dashError');
    el.textContent = msg;
    el.classList.remove('hidden');
  }
  const unwrap = (res, label) => {                // throw with a useful label on Supabase errors
    if (res.error) { console.error(`dashboard: ${label} failed:`, res.error); throw res.error; }
    return res;
  };

  // ---- toast / confirm / prompt (same helpers as leaves.js) -----------
  function showToast(message, type = 'success') {
    let stack = document.querySelector('.toast-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.className = 'toast-stack';
      document.body.appendChild(stack);
    }
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
          <h3>${esc(title)}</h3>
          <p>${message}</p>
          <div class="modal-actions">
            <button type="button" class="btn btn-outline-secondary btn-sm" data-action="cancel">Cancel</button>
            <button type="button" class="btn ${danger ? 'btn-rose' : 'btn-accent'} btn-sm" data-action="confirm">${esc(confirmLabel)}</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const done = (v) => { overlay.remove(); resolve(v); };
      overlay.querySelector('[data-action="cancel"]').addEventListener('click', () => done(false));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
      overlay.querySelector('[data-action="confirm"]').addEventListener('click', () => done(true));
    });
  }

  // Resolves to the trimmed text ('' if blank and not required), or null if cancelled.
  function promptTextDialog({ title, message, confirmLabel = 'Confirm', placeholder = '', required = true, danger = true, maxLength = 0 }) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal-box">
          <h3>${esc(title)}</h3>
          <p>${message}</p>
          <textarea class="form-control form-control-sm mb-2" id="promptTextInput" rows="3" placeholder="${esc(placeholder)}"${maxLength ? ` maxlength="${maxLength}"` : ''}></textarea>
          <div class="modal-actions">
            <button type="button" class="btn btn-outline-secondary btn-sm" data-action="cancel">Cancel</button>
            <button type="button" class="btn ${danger ? 'btn-rose' : 'btn-accent'} btn-sm" data-action="confirm">${esc(confirmLabel)}</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const input = overlay.querySelector('#promptTextInput');
      input.focus();
      const done = (v) => { overlay.remove(); resolve(v); };
      overlay.querySelector('[data-action="cancel"]').addEventListener('click', () => done(null));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
      overlay.querySelector('[data-action="confirm"]').addEventListener('click', () => {
        const val = input.value.trim();
        if (!val && required) { alert('Please enter a reason.'); return; }
        done(val);
      });
    });
  }

  const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const checkIconSvg  = () => svg('<path d="M20 6L9 17l-5-5"/>');
  const xIconSvg      = () => svg('<path d="M18 6L6 18"/><path d="M6 6l12 12"/>');
  const banIconSvg    = () => svg('<circle cx="12" cy="12" r="10"/><path d="M4.9 4.9l14.2 14.2"/>');
  const pencilIconSvg = () => svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>');
  const moreIconSvg   = () => svg('<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>');

  // ---- summary cards (moved from leaves.js) -----------------------------
  // Inline icons (Lucide-style), sized by #dashBalanceGrid .stat-card-icon svg.
  const STAT_ICONS = {
    annual:   '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    sick:     '<path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"/>',
    special:  '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    upcoming: '<path d="M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h5"/><path d="M17.5 17.5 16 16.3V14"/><circle cx="16" cy="16" r="6"/>'
  };
  // Each card is matched to an ACTIVE leave type by leave_code or name (case-insensitive);
  // a card whose type doesn't exist is simply not shown.
  const BALANCE_CARDS = [
    { label: 'Annual leave',  codes: ['AL'], names: ['annual leave'],  variant: 'accent',  icon: 'annual' },
    { label: 'Sick leave',    codes: ['SL'], names: ['sick leave'],    variant: 'violet',  icon: 'sick' },
    { label: 'Special leave', codes: ['SP'], names: ['special leave'], variant: 'warning', icon: 'special' }
  ];

  // Days a NEW request can use: available_balance minus the part of this cycle's entitlement
  // that has not accrued yet (same figure the request form shows and the database enforces).
  const availableToDate = (b) =>
    Number(b.available_balance) - (Number(b.entitlement_ye || 0) - Number(b.entitlement_ytd || 0));

  // Approved days from `from` (midnight, local) onward: the whole request if it starts on/after
  // `from`, otherwise just the slice still ahead (calendar days, minus 0.5 for a half-day end).
  function daysFrom(r, from) {
    if (parseYmd(r.start_date) >= from) return Number(r.total_days);
    const days = Math.round((parseYmd(r.end_date) - from) / 86400000) + 1;
    return days - (r.end_half_day !== 'full' ? 0.5 : 0);
  }

  const summaryCardHtml = ({ variant, label, icon, value, unit, subHtml, title = '' }) => `
    <div class="stat-card stat-card--${variant}"${title ? ` title="${esc(title)}"` : ''}>
      <div class="stat-card-top">
        <span class="stat-card-label">${esc(label)}</span>
        <span class="stat-card-icon">${svg(icon)}</span>
      </div>
      <div class="stat-card-body">
        <span class="stat-card-value">${value}</span>
        <span class="stat-card-unit">${unit}</span>
      </div>
      <div class="stat-card-sub">${subHtml}</div>
    </div>`;

  // ---- shared state (refreshed by loadAll) -----------------------------
  let me = null;                       // { id, name, employee_id }
  let isAdmin = false;
  let isSuperAdmin = false;            // admin login with no employees row: no own leave, acts for others
  let dirById = new Map();             // employee_directory() rows by uuid
  let typeById = new Map();            // leave_types rows by id
  let stepsByRequest = new Map();      // request id -> approval steps
  let stepsRpcSupported = true;
  const requestsById = new Map();      // rows currently shown in the two widgets
  let loading = false;
  let requestModalReady = false;       // true once LeaveRequestModal.init() has finished

  const nameOf = (id) => dirById.get(id)?.name || 'Employee';
  // employee_directory() only returns the signed-in user's own row for non-admins, so
  // nameOf() can't resolve a subordinate. Every request row already carries the embedded
  // `employee:employee_id(name, employee_id)` (see REQUEST_COLS), which the employees RLS
  // policy now lets approvers read for their team — prefer that, fall back to the directory.
  const embeddedEmp = (r) => {
    const e = Array.isArray(r?.employee) ? r.employee[0] : r?.employee;
    return e?.name ? e : null;
  };
  const requestNameOf = (r) => embeddedEmp(r)?.name || nameOf(r.employee_id);
  const typeOf = (id) => typeById.get(id)?.leave_type || 'Leave';
  const codeOf = (id) => typeById.get(id)?.leave_code || 'LV';

  // get_leave_balance() per card, for the signed-in employee (computed on read). A card whose
  // call fails is skipped.
  async function loadBalances() {
    if (!me) return [];
    const activeTypes = [...typeById.values()].filter((t) => t.is_active !== false);
    const wanted = BALANCE_CARDS.map((def) => ({
      def,
      type: activeTypes.find((t) =>
        def.codes.includes(String(t.leave_code || '').toUpperCase()) ||
        def.names.includes(String(t.leave_type || '').trim().toLowerCase()))
    })).filter((x) => x.type);

    const results = await Promise.all(wanted.map(async ({ def, type }) => {
      try {
        const { data, error } = await sb.rpc('get_leave_balance', {
          p_employee_id: me.id, p_leave_type_id: type.leave_type_id
        });
        if (error) throw error;
        const balance = Array.isArray(data) ? data[0] : data;
        return balance ? { def, type, balance } : null;
      } catch (err) {
        console.warn(`dashboard: could not load the ${def.label} balance:`, err);
        return null;
      }
    }));
    return results.filter(Boolean);
  }

  // ---- permissions (mirrors leaves.js: currentStep / canReviewNow / getRowActions) ----
  function currentStep(r) {
    if (r.status !== 0) return null;
    return (stepsByRequest.get(r.id) || []).find((s) => s.status === 0) || null;
  }
  function canReviewNow(r) {
    if (r.status !== 0) return false;
    if (isAdmin || !stepsRpcSupported) return true;       // server decides if steps are unavailable
    return currentStep(r)?.expected.id === me?.id;
  }
  const ACTION_DEFS = {
    approve:     { label: 'Approve',        attr: 'data-approve',      icon: checkIconSvg,  tone: 'success', btn: 'btn-emerald' },
    reject:      { label: 'Reject',         attr: 'data-reject',       icon: xIconSvg,      tone: 'danger',  btn: 'btn-rose' },
    edit:        { label: 'Edit',           attr: 'data-edit',         icon: pencilIconSvg, tone: '',        btn: 'btn-outline-secondary' },
    cancel:      { label: 'Cancel request', attr: 'data-cancel',       icon: banIconSvg,    tone: 'danger',  btn: 'btn-outline-rose' },
    adminCancel: { label: 'Cancel request', attr: 'data-admin-cancel', icon: banIconSvg,    tone: 'danger',  btn: 'btn-outline-rose' }
  };
  const REVIEW_ACTIONS = ['approve', 'reject'];
  const ROW_ACTION_SELECTOR = '[data-edit], [data-cancel], [data-admin-cancel], [data-approve], [data-reject]';

  // My own approved leave can be cancelled until its start date (same rule as
  // cancel_leave_request() in 02_leaves_schema.sql).
  const canCancelOwnApproved = (r) =>
    r.status === 1 && r.employee_id === me?.id && r.start_date > ymd(new Date());

  function getRowActions(r) {
    const actions = [];
    const adminPostReview = () => {
      if (!isAdmin) return;
      actions.push('edit');
      if (r.status !== 3) actions.push('adminCancel');
    };
    if (r.employee_id === me?.id) {                        // my own leave
      if (r.status === 0) actions.push('edit', 'cancel');
      else if (!isAdmin && canCancelOwnApproved(r)) actions.push('cancel');
      else adminPostReview();
    } else if (r.status === 0) {                           // someone else's, pending
      if (canReviewNow(r)) actions.push('approve', 'reject');
      if (isAdmin) actions.push('edit', 'cancel');
    } else {
      adminPostReview();
    }
    return actions;
  }

  // ---- Leave details modal ----------------------------------------------
  function buildDetail(r) {
    const steps = stepsByRequest.get(r.id) || [];
    const done = r.status === 1 || r.status === 2;

    const cur = currentStep(r);
    let awaiting = '';
    if (cur) {
      awaiting = !cur.expected.id ? 'admin'
        : (me && cur.expected.id === me.id) ? 'you'
        : fmtEmp(cur.expected.name, cur.expected.employee_id);
    }

    let reviewer = '';
    if (done) {
      const acted = steps.filter((s) => (s.status === 1 || s.status === 2) && s.actor.name);
      const last = acted.reduce((a, b) => (!a || (b.acted_at || '') >= (a.acted_at || '')) ? b : a, null);
      const emb = Array.isArray(r.approver) ? r.approver[0] : r.approver;
      reviewer = last ? last.actor.name : (emb?.name || LeaveDetail.adminName(r.approved_by_admin));
    }

    let filedBy = '';
    if (r.requested_by_admin) {
      filedBy = `${LeaveDetail.adminName(r.requested_by_admin)} (Admin)`;   // filed by a super admin
    } else if (r.requested_by && r.requested_by !== r.employee_id) {
      if (me && r.requested_by === me.id) filedBy = 'You, on their behalf';
      else {
        const d = dirById.get(r.requested_by);
        filedBy = d ? fmtEmp(d.name, d.employee_id) : 'Another user, on their behalf';
      }
    }

    const emp = embeddedEmp(r) || dirById.get(r.employee_id);
    return {
      employee: emp ? fmtEmp(emp.name, emp.employee_id) : 'A teammate',
      leaveType: typeOf(r.leave_type_id),
      startDate: r.start_date, startHalf: r.start_half_day,
      endDate: r.end_date, endHalf: r.end_half_day,
      days: r.total_days, reason: r.reason, status: r.status,
      steps, createdAt: r.created_at, approvedAt: r.approved_at,
      reviewer, awaiting, rejectionReason: r.rejection_reason, filedBy,
      adminCreated: !!(r.requested_by_admin || r.approved_by_admin)
    };
  }

  const detailEl = () => $('leaveDetailModal');
  const detailModal = () => bootstrap.Modal.getOrCreateInstance(detailEl());

  function disposeDropdowns(container) {
    container.querySelectorAll('[data-bs-toggle="dropdown"]').forEach((el) => {
      bootstrap.Dropdown.getInstance(el)?.dispose();
    });
  }
  function initDropdowns(container) {
    container.querySelectorAll('[data-bs-toggle="dropdown"]').forEach((el) => {
      bootstrap.Dropdown.getOrCreateInstance(el, {
        popperConfig: (defaults) => ({ ...defaults, strategy: 'fixed' })
      });
    });
  }
  function actionMenuItem(k, id) {
    const d = ACTION_DEFS[k];
    return `<li><button type="button" class="dropdown-item${d.tone ? ' is-' + d.tone : ''}" ${d.attr}="${esc(id)}">${d.icon()}<span>${d.label}</span></button></li>`;
  }
  function actionMenuItems(keys, id) {
    const review = keys.filter((k) => REVIEW_ACTIONS.includes(k));
    const other = keys.filter((k) => !REVIEW_ACTIONS.includes(k));
    return review.map((k) => actionMenuItem(k, id)).join('') +
      (review.length && other.length ? '<li><hr class="dropdown-divider"></li>' : '') +
      other.map((k) => actionMenuItem(k, id)).join('');
  }

  // Footer buttons: same layout rules as renderDetailActions() in leaves.js.
  function renderDetailActions(r) {
    const box = $('leaveDetailActions');
    disposeDropdowns(box);

    const keys = getRowActions(r);
    const hasReview = keys.some((k) => REVIEW_ACTIONS.includes(k));
    let primary = hasReview ? ['reject', 'approve'].filter((k) => keys.includes(k)) : keys.slice(0, 1);
    let more = keys.filter((k) => !primary.includes(k));
    if (more.length === 1) { primary = primary.concat(more); more = []; }   // no lone item behind a menu

    const btnClass = (k) => (k === 'reject' ? 'btn-outline-rose' : ACTION_DEFS[k].btn);
    const primaryBtns = primary.map((k) => {
      const d = ACTION_DEFS[k];
      return `<button type="button" class="btn btn-sm ${btnClass(k)}" ${d.attr}="${esc(r.id)}">${d.icon()}<span>${d.label}</span></button>`;
    }).join('');
    const moreMenu = more.length ? `
      <div class="dropdown dropup detail-more">
        <button type="button" class="btn btn-ghost btn-sm" data-bs-toggle="dropdown" aria-expanded="false">${moreIconSvg()}<span>More</span></button>
        <ul class="dropdown-menu row-actions-menu">${actionMenuItems(more, r.id)}</ul>
      </div>` : '';

    box.innerHTML = keys.length ? `${moreMenu}<div class="detail-primary">${primaryBtns}</div>` : '';
    initDropdowns(box);
    $('leaveDetailCloseBtn').classList.toggle('hidden', keys.length > 0);
  }

  function openDetail(id) {
    const r = requestsById.get(id);
    if (!r || !window.LeaveDetail || !window.bootstrap) return;
    LeaveDetail.setStatus($('leaveDetailStatus'), r.status);
    $('leaveDetailBody').innerHTML = LeaveDetail.render(buildDetail(r));
    renderDetailActions(r);
    detailModal().show();
  }

  // ---- actions (same RPCs / updates as leaves.js) ------------------------
  async function onCancelRequest(id) {
    const ok = await showConfirmDialog({
      title: 'Cancel this request?',
      message: 'This leave request will be marked as cancelled. This cannot be undone.',
      confirmLabel: 'Cancel request', danger: true
    });
    if (!ok) return;
    const { error } = await sb.rpc('cancel_leave_request', { p_request_id: id });
    if (error) { showToast('Could not cancel request: ' + error.message, 'danger'); return; }
    showToast('Request cancelled.', 'success');
    await loadAll();
  }

  async function onAdminCancelRequest(id) {
    const ok = await showConfirmDialog({
      title: 'Cancel this request?',
      message: 'This leave request will be marked as cancelled, regardless of its current status. This cannot be undone.',
      confirmLabel: 'Cancel request', danger: true
    });
    if (!ok) return;
    const { error } = await sb.from('leave_requests').update({ status: 3 }).eq('id', id);
    if (error) { showToast('Could not cancel request: ' + error.message, 'danger'); return; }
    showToast('Request cancelled.', 'success');
    await loadAll();
  }

  async function onReviewRequest(id, decision) {
    let rejectionReason = null;
    let approvalComment = null;

    if (decision === 'rejected') {
      rejectionReason = await promptTextDialog({
        title: 'Reject this request?',
        message: 'Please provide a reason — this will be shown to the employee.',
        confirmLabel: 'Reject request',
        placeholder: 'e.g. Team is short-staffed that week'
      });
      if (rejectionReason === null) return;
    } else {
      const comment = await promptTextDialog({
        title: 'Approve this request?',
        message: 'Your approval will be recorded. If further approvers are still required, the request moves on to the next one; otherwise the employee is notified. You can add an optional comment.',
        confirmLabel: 'Approve',
        placeholder: 'Optional comment, e.g. Enjoy your trip',
        required: false, danger: false, maxLength: 500
      });
      if (comment === null) return;
      approvalComment = comment || null;
    }

    const { error } = await sb.rpc('review_leave_request', {
      p_request_id: id, p_decision: decision, p_rejection_reason: rejectionReason
    });
    if (error) { showToast('Could not review request: ' + error.message, 'danger'); return; }
    showToast(decision === 'approved' ? 'Request approved.' : 'Request rejected.', 'success');

    // The comment is a separate call, so a failure never undoes the approval.
    if (approvalComment) {
      let commentError = null;
      try {
        ({ error: commentError } = await sb.rpc('set_leave_review_comment', {
          p_request_id: id, p_comment: approvalComment
        }));
      } catch (err) { commentError = err; }
      if (commentError) {
        console.error('dashboard: could not save approval comment:', commentError);
        showToast('The request was approved, but the comment could not be saved: ' + commentError.message, 'danger');
      }
    }
    await loadAll();
  }

  function openEditRequestModal(id) {
    const req = requestsById.get(id);
    if (!req) return;
    if (!requestModalReady) { showToast('The edit form is not available yet. Please try again in a moment.', 'danger'); return; }
    const emb = Array.isArray(req.employee) ? req.employee[0] : req.employee;
    const who = emb?.name ? fmtEmp(emb.name, emb.employee_id) : (dirById.get(req.employee_id)?.name || '—');
    LeaveRequestModal.openEdit(req, `Editing request for ${who}`);
  }

  const ROW_ACTIONS = {
    edit: openEditRequestModal,
    cancel: onCancelRequest,
    adminCancel: onAdminCancelRequest,
    approve: (id) => onReviewRequest(id, 'approved'),
    reject: (id) => onReviewRequest(id, 'rejected')
  };
  function dispatchRowAction(btn) {
    for (const [key, handler] of Object.entries(ROW_ACTIONS)) {
      if (key in btn.dataset) { handler(btn.dataset[key]); return; }
    }
  }

  // ---- data + rendering (safe to call repeatedly) ------------------------
  async function loadAll() {
    if (loading) return;
    loading = true;
    try {
      const todayStr = ymd(new Date());
      const in30 = new Date(); in30.setDate(in30.getDate() + 30);
      const in30Str = ymd(in30);
      const tomorrow = new Date(); tomorrow.setHours(0, 0, 0, 0); tomorrow.setDate(tomorrow.getDate() + 1);
      $('dashTodayChip').textContent = todayStr;

      const [dirR, cycleR, typesR, pendR, awayCntR, absR, holR, holCntR, polR, weekR, stepsR, upcomingR] =
        await Promise.allSettled([
          sb.rpc('employee_directory'),
          sb.rpc('get_leave_cycle_bounds'),
          sb.from('leave_types').select('leave_type_id, leave_type, leave_code, is_active'),
          sb.from('leave_requests')
            .select(REQUEST_COLS, { count: 'exact' })
            .eq('status', 0).order('created_at', { ascending: false }).limit(5),
          sb.from('leave_requests').select('id', { count: 'exact', head: true })
            .eq('status', 1).lte('start_date', todayStr).gte('end_date', todayStr),
          sb.from('leave_requests')
            .select(REQUEST_COLS)
            .eq('status', 1).gte('end_date', todayStr)
            .order('start_date', { ascending: true }).limit(6),
          sb.from('holidays').select('date, description, remark')
            .gte('date', todayStr).order('date', { ascending: true }).limit(3),
          sb.from('holidays').select('id', { count: 'exact', head: true })
            .gte('date', todayStr).lte('date', in30Str),
          sb.from('policy_settings').select('standard_monthly_working_days, year_cutoff_month, year_cutoff_day')
            .eq('id', 1).maybeSingle(),
          sb.from('policy_weekly_working_days').select('day_of_week, day_name, working_value')
            .order('day_of_week', { ascending: true }),
          sb.rpc('list_leave_approval_steps'),
          // My approved leave from tomorrow onward (any year, all types)
          me
            ? sb.from('leave_requests')
                .select('start_date, end_date, start_half_day, end_half_day, total_days')
                .eq('employee_id', me.id).eq('status', 1).gte('end_date', ymd(tomorrow))
                .order('start_date', { ascending: true })
            : Promise.resolve({ data: [] })
        ]);

      const ok = (p, label) => {
        if (p.status === 'rejected') { console.error(`dashboard: ${label} failed:`, p.reason); return null; }
        if (p.value.error) { console.error(`dashboard: ${label} failed:`, p.value.error); return null; }
        return p.value;
      };

      // Lookups (assigned to the shared state used by permissions + the modal)
      const dir = ok(dirR, 'employee_directory')?.data || [];
      dirById = new Map(dir.map((d) => [d.id, d]));
      typeById = new Map((ok(typesR, 'leave_types')?.data || []).map((t) => [t.leave_type_id, t]));
      const stepsRes = ok(stepsR, 'list_leave_approval_steps');
      stepsRpcSupported = !!stepsRes;
      stepsByRequest = (stepsRes && window.LeaveDetail) ? LeaveDetail.groupSteps(stepsRes.data) : new Map();
      requestsById.clear();
      const balancesP = isSuperAdmin ? Promise.resolve([]) : loadBalances();   // needs typeById; rendered at the end so the other widgets don't wait

      // Hero subtext
      const meDir = me ? dirById.get(me.id) : null;
      $('dashSubtext').textContent = meDir
        ? `${meDir.job_title} • ${meDir.department} • ${meDir.business_unit}`
        : (isAdmin || isSuperAdmin ? 'Administrator' : 'No employee profile is linked to this login yet.');

      const cycleRes = ok(cycleR, 'get_leave_cycle_bounds');
      const cycle = Array.isArray(cycleRes?.data) ? cycleRes.data[0] : cycleRes?.data;

      // ---- Stats ---------------------------------------------------------
      if (dirR.status === 'fulfilled' && !dirR.value.error) {
        setStat('statHeadcount', dir.filter((d) => !d.last_day || d.last_day >= todayStr).length);
      } else failStat('statHeadcount');

      const pend = ok(pendR, 'pending requests');
      if (pend) setStat('statPending', pend.count ?? (pend.data || []).length); else failStat('statPending');

      const awayCnt = ok(awayCntR, 'away today');
      if (awayCnt) setStat('statAway', awayCnt.count ?? 0); else failStat('statAway');

      const holCnt = ok(holCntR, 'holiday count');
      if (holCnt) setStat('statHolidays', holCnt.count ?? 0); else failStat('statHolidays');

      // ---- Pending requests ---------------------------------------------
      const pendList = $('dashPendingList');
      if (!pend) {
        pendList.innerHTML = empty("Couldn't load pending requests.");
        $('dashPendingCount').textContent = '–';
      } else {
        $('dashPendingCount').textContent = pend.count ?? (pend.data || []).length;
        pendList.innerHTML = (pend.data || []).length
          ? pend.data.map((r) => { requestsById.set(r.id, r); return `
            <div class="dash-list-item is-clickable" role="button" tabindex="0" data-request-id="${esc(r.id)}" title="View leave details">
              <div class="dash-list-main">
                <p class="dash-list-name">${esc(requestNameOf(r))}</p>
                <p class="dash-list-sub">${esc(codeOf(r.leave_type_id))} • ${num(r.total_days)} day(s)</p>
              </div>
              <div class="dash-list-meta">${esc(fmtRange(r.start_date, r.end_date))}</div>
            </div>`; }).join('')
          : empty('No pending requests. All caught up.');
      }

      // ---- Team absence --------------------------------------------------
      const absList = $('dashAbsenceList');
      const abs = ok(absR, 'team absence');
      if (!abs) {
        absList.innerHTML = empty("Couldn't load team absence.");
      } else {
        absList.innerHTML = (abs.data || []).length
          ? abs.data.map((r) => {
              const now = r.start_date <= todayStr && r.end_date >= todayStr;
              requestsById.set(r.id, r);
              return `
              <div class="dash-list-item is-clickable" role="button" tabindex="0" data-request-id="${esc(r.id)}" title="View leave details">
                <div class="dash-list-main">
                  <p class="dash-list-name">${esc(requestNameOf(r))}</p>
                  <p class="dash-list-sub dash-list-sub--accent">${esc(typeOf(r.leave_type_id))} • ${num(r.total_days)} day(s)</p>
                </div>
                <div class="dash-list-meta">
                  ${esc(fmtRange(r.start_date, r.end_date))}<br>
                  <span class="status-badge ${now ? 'dash-badge-now' : 'dash-badge-soon'}">${now ? 'Away now' : 'Upcoming'}</span>
                </div>
              </div>`;
            }).join('')
          : empty('Everyone is in. No approved leave coming up.');
      }

      // ---- Policies ------------------------------------------------------
      const pol = ok(polR, 'policy_settings')?.data;
      if (pol) {
        $('dashStdDays').textContent = `${num(pol.standard_monthly_working_days)} days/month`;
        $('dashCutoff').textContent = `${pol.year_cutoff_day} ${MONTHS[pol.year_cutoff_month - 1]} (yearly)`;
      }
      const week = ok(weekR, 'policy_weekly_working_days')?.data || [];
      $('dashWeek').innerHTML = week.map((d) => {
        const v = Number(d.working_value);
        const cls = v === 1 ? 'is-working' : v > 0 ? 'is-half' : '';
        return `<div class="${cls}">${esc(d.day_name.slice(0, 2))}<b>${v}</b></div>`;
      }).join('');

      // ---- Holidays ------------------------------------------------------
      const hols = ok(holR, 'holidays');
      $('dashHolidayList').innerHTML = !hols
        ? empty("Couldn't load holidays.")
        : (hols.data || []).length
          ? hols.data.map((h) => `
            <div class="dash-holiday">
              <div>
                <p class="dash-holiday-name">${esc(h.description)}</p>
                <p class="dash-holiday-remark">${esc(h.remark || 'Company holiday')}</p>
              </div>
              <span class="dash-holiday-date">${esc(fmtDate(h.date))}</span>
            </div>`).join('')
          : empty('No upcoming holidays scheduled.');

      // ---- My leave summary cards (balances + upcoming approved) -----------
      const grid = $('dashBalanceGrid');
      const balances = await balancesP;
      if (isSuperAdmin) {
        // Section is hidden for super admins (see ess:ready); nothing to render.
      } else if (!me) {
        grid.innerHTML = empty('No employee profile is linked to this login yet.');
      } else {
        const cards = balances.map(({ def, type, balance: b }) => {
          const tip = [
            `${type.leave_type} — leave year ${b.cycle_start} to ${b.cycle_end}`,
            `Entitlement (to date / year-end): ${num(b.entitlement_ytd)} / ${num(b.entitlement_ye)}`,
            `Carried forward: ${num(b.carry_forward_in)}` +
              (Number(b.carry_forward_forfeited_ye) > 0 ? ` (${num(b.carry_forward_forfeited_ye)} lapses)` : ''),
            `Adjustments: ${num(b.adjustments)}`,
            `Taken (to date / year-end): ${num(b.used_ytd)} / ${num(b.used_ye)}`,
            `Pending: ${num(b.pending_days)}`,
            `Available to date (what a new request can use): ${num(availableToDate(b))}`,
            `Year-end balance: ${num(b.ye_balance)}`
          ].join('\n');
          const hasPending = Number(b.pending_days) > 0;
          return summaryCardHtml({
            variant: def.variant,
            label: `${def.label} balance`,
            icon: STAT_ICONS[def.icon],
            value: num(b.ytd_balance),
            unit: 'days left',
            title: tip,
            subHtml: `
              <span><i class="bi bi-check-circle-fill text-success me-1"></i>Available <strong>${num(availableToDate(b))}</strong></span>
              <span class="text-muted">·</span>
              <span><i class="bi ${hasPending ? 'bi-hourglass-split text-warning' : 'bi-hourglass text-muted'} me-1"></i>Pending <strong>${num(b.pending_days)}</strong></span>`
          });
        });

        const upcoming = ok(upcomingR, 'my upcoming approved')?.data;
        if (upcoming) {
          cards.push(summaryCardHtml({
            variant: 'success',
            label: 'My upcoming approved',
            icon: STAT_ICONS.upcoming,
            value: num(upcoming.reduce((sum, r) => sum + daysFrom(r, tomorrow), 0)),
            unit: 'days scheduled',
            subHtml: upcoming.length
              ? `<span class="text-success fw-semibold"><i class="bi bi-calendar-check me-1"></i>Next: ${esc(fmtRange(upcoming[0].start_date, upcoming[0].end_date))}</span>`
              : '<span class="text-muted">No upcoming approved leave</span>'
          }));
        }
        grid.innerHTML = cards.length ? cards.join('') : empty("Couldn't load leave balances.");
      }
      if (cycle?.cycle_start) {
        $('dashCycleBadge').textContent = `Cycle: ${cycle.cycle_start} to ${cycle.cycle_end}`;
      } else if (balances[0]) {
        $('dashCycleBadge').textContent = `Cycle: ${balances[0].balance.cycle_start} to ${balances[0].balance.cycle_end}`;
      }
    } finally {
      loading = false;
    }
  }

  // ---- one-time wiring ---------------------------------------------------
  function wireOnce() {
    // Open the details modal from either widget (mouse + keyboard).
    const onRowActivate = (ev) => {
      const row = ev.target.closest('[data-request-id]');
      if (!row) return;
      if (ev.type === 'keydown') {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        ev.preventDefault();
      }
      openDetail(row.dataset.requestId);
    };
    ['dashPendingList', 'dashAbsenceList'].forEach((id) => {
      $(id).addEventListener('click', onRowActivate);
      $(id).addEventListener('keydown', onRowActivate);
    });

    // Hero "Request Leave" -> shared New leave request modal (same one leaves.html uses).
    $('dashRequestLeaveBtn').addEventListener('click', () => {
      if (!requestModalReady) { showToast('The request form is still loading. Please try again.', 'danger'); return; }
      LeaveRequestModal.openNew();
    });

    // Footer action buttons: close the details modal first — the confirm/prompt
    // dialogs and the edit modal can't take focus while it is trapping it.
    $('leaveDetailActions').addEventListener('click', (e) => {
      const btn = e.target.closest(ROW_ACTION_SELECTOR);
      if (!btn) return;
      detailEl().addEventListener('hidden.bs.modal', () => dispatchRowAction(btn), { once: true });
      detailModal().hide();
    });
  }

  // ---- main ----------------------------------------------------------
  let started = false;
  window.addEventListener('ess:ready', async (e) => {
    if (started) return;
    const { session, employee, employeeError } = e.detail;

    if (!session) {
      $('dashGreeting').textContent = 'Welcome';
      $('dashSubtext').textContent = 'Sign in to view your dashboard.';
      showError("Supabase isn't configured yet — fill in the URL and anon key in assets/js/supabaseClient.js.");
      return;
    }
    started = true;
    if (employeeError) {
      showError(`Couldn't load your employee profile (${employeeError.message}). Check the browser console for details.`);
    }

    isAdmin = employee?.role === 1;
    isSuperAdmin = !!employee?.isSuperAdmin;
    // Working Policies "Settings" link is admin-only (hidden in the HTML by default).
    $('dashPolicySettingsLink')?.classList.toggle('d-none', !isAdmin);
    // "My Leave Balances" is personal: a super admin is not an employee, so hide the whole section.
    ['dashBalanceHead', 'dashBalanceGrid'].forEach((id) => $(id)?.classList.toggle('d-none', isSuperAdmin));
    $('dashGreeting').textContent = employee ? `Welcome back, ${employee.name}` : `Welcome, ${session.user.email}`;

    // Own row (need the uuid; sidebar.js only selects name/code/role).
    try {
      const r = unwrap(await sb.from('employees').select('id, name, employee_id')
        .eq('auth_user_id', session.user.id).maybeSingle(), 'own employee row');
      me = r.data;
    } catch (_) { /* handled via empty balances */ }

    wireOnce();

    // Shared New/Edit request modal (same component leaves.html uses). Not awaited,
    // so a slow or failing init never blocks the dashboard itself.
    if (window.LeaveDetail) await LeaveDetail.loadAdminNames(sb);   // names when a super admin filed / approved

    if (window.LeaveRequestModal && (me || isSuperAdmin)) {
      LeaveRequestModal.init({
        sb,
        isAdmin,
        myEmployeeId: me ? me.id : null,   // null for a super admin: the form then asks who the request is for
        myEmployeeName: employee?.name || me?.name || '',
        showToast,
        onSubmitted: () => loadAll()
      }).then(() => {
        requestModalReady = true;
        const btn = $('dashRequestLeaveBtn');
        btn.disabled = false;
        btn.removeAttribute('title');
      }).catch((err) => {
        console.error('dashboard: LeaveRequestModal.init failed:', err);
        $('dashRequestLeaveBtn').title = 'The request form failed to load';
      });
    } else {
      $('dashRequestLeaveBtn').title = 'No employee profile is linked to this login yet';
    }

    await loadAll();
  });
})();
