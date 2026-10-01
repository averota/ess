// =====================================================================
// leaveDetail.js — shared renderer for the "Leave details" modal
// (#leaveDetailModal) used by leaves.html and calendar.html, so both
// pages produce identical markup. Styling: assets/css/leaveDetailModal.css.
//
// Load BEFORE leaves.js / calendar.js. Exposes window.LeaveDetail:
//   groupSteps(rows)        list_leave_approval_steps() rows -> Map(request id -> steps[])
//   setStatus(el, status)   fills the header status badge (0 pending … 3 cancelled)
//   render(r)               returns the modal-body HTML (details list + approval tracker)
//   loadAdminNames(sb)      once per page: admin names (list_super_admin_names()) for adminName()
//   adminName(id)           name of an admin (requested_by_admin / approved_by_admin ...), 'Admin' if unknown
//
// render(r) input:
//   employee, employeeCode (optional), leaveType, startDate, startHalf, endDate, endHalf ('full'|'am'|'pm'),
//   days, reason, status (0-3), steps (from groupSteps, may be empty),
//   createdAt, approvedAt, reviewer, awaiting, rejectionReason, filedBy,
//   cancelledBy, cancelledAt (optional — only used when a cancelled request has no step rows),
//   adminCreated (optional bool — admin created it approved, no approval flow: tracker shows one "Created" step)
// =====================================================================
(function (global) {
    'use strict';

    const STATUS = {
        0: { label: 'Pending',   cls: 'is-pending' },
        1: { label: 'Approved',  cls: 'is-approved' },
        2: { label: 'Rejected',  cls: 'is-rejected' },
        3: { label: 'Cancelled', cls: 'is-cancelled' }
    };
    const HALF = { full: 'Full day', am: 'AM', pm: 'PM' };
    const ROLE = { first_line: '1st Line', second_line: '2nd Line', hod: 'Dept Head' };
    const ROLE_LONG = { first_line: 'First Line', second_line: 'Second Line', hod: 'Dept Head' };

    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);

    function dateLong(str) {
        if (!str) return '—';
        const [y, m, d] = str.split('-').map(Number);
        return new Date(y, m - 1, d)
            .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    }

    function dateTimeShort(iso) {
        const d = iso ? new Date(iso) : null;
        if (!d || isNaN(d)) return '';
        return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    }

    // "Soun Sambath" -> "S. Sambath" (keeps the tracker labels short)
    function shortName(name) {
        const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
        return parts.length > 1 ? `${parts[0][0]}. ${parts.slice(1).join(' ')}` : (parts[0] || '');
    }

    // "Soy Chansreypov (EMP0001)" -> { name: "Soy Chansreypov", code: "EMP0001" }
    function splitEmployee(str) {
        const m = String(str || '').trim().match(/^(.*?)\s*\(([^)]*)\)\s*$/);
        return m ? { name: m[1], code: m[2] } : { name: String(str || '').trim(), code: '' };
    }

    // "Rotha Mek" -> "RM" (ignores any "(EMP0001)" suffix)
    function initials(name) {
        const p = splitEmployee(name).name.split(/\s+/).filter(Boolean);
        if (!p.length) return '?';
        return (p[0][0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
    }

    const row = (label, html) => html ? `<div class="detail-row"><dt>${label}</dt><dd>${html}</dd></div>` : '';
    const dateNode = (label, date, half, right) => `
                <div class="date-node${right ? ' date-node--right' : ''}">
                    <span class="date-node-label">${label}</span>
                    <span class="date-node-val">${esc(dateLong(date))}</span>
                    <span class="date-session-tag">${HALF[half] || HALF.full}</span>
                </div>`;

    function groupSteps(rows) {
        const map = new Map();
        for (const a of rows || []) {
            if (!map.has(a.out_request)) map.set(a.out_request, []);
            map.get(a.out_request).push({
                step_no: a.out_step_no,
                role: a.out_role,
                status: a.out_status,
                expected: { id: a.out_expected_id, name: a.out_expected_name, employee_id: a.out_expected_code },
                actor: { name: a.out_actor_name, employee_id: a.out_actor_code },
                acted_at: a.out_acted_at,
                comment: a.out_comment
            });
        }
        map.forEach(list => list.sort((x, y) => x.step_no - y.step_no));
        return map;
    }

    function setStatus(el, status) {
        const s = STATUS[status] || STATUS[0];
        el.className = `status-badge ${s.cls}`;
        el.textContent = s.label;
    }

    // ---- approval tracker ------------------------------------------------
    // A leave an admin created is approved from the start, with no approval flow: approved,
    // no approval steps, and either flagged adminCreated by the page (requested_by_admin or
    // approved_by_admin is set) or filed by somebody other than the employee.
    function isDirectCreate(r) {
        if (r.status !== 1 || (r.steps || []).length) return false;
        return !!r.adminCreated
            || (!!r.filedBy && r.filedBy !== r.employee && r.filedBy !== splitEmployee(r.employee).name);
    }

    // Node: { state: 'done'|'current'|'rejected'|'cancelled'|'idle', icon, name, detail }
    function buildNodes(r) {
        const steps = r.steps || [];
        if (isDirectCreate(r)) {
            return [{ state: 'done', icon: 'check-lg', name: 'Created',
                      detail: [r.filedBy || r.reviewer || 'Admin', dateTimeShort(r.createdAt)].filter(Boolean).join(' · ') }];
        }
        const nodes = [{ state: 'done', icon: 'check-lg', name: 'Submitted', detail: dateTimeShort(r.createdAt) }];
        const who = (s) => s.expected && s.expected.id ? shortName(s.expected.name) : 'admin';
        const actedDetail = (name, at) => [shortName(name), dateTimeShort(at)].filter(Boolean).join(' · ');

        if (steps.length) {
            const cur = r.status === 0 ? steps.find(s => s.status === 0) : null;
            for (const s of steps) {
                const role = ROLE[s.role] || s.role;
                if (s.status === 1)      nodes.push({ state: 'done',      icon: 'check-lg', name: `${role} approved`, detail: actedDetail(s.actor.name, s.acted_at) });
                else if (s.status === 2) nodes.push({ state: 'rejected',  icon: 'x-lg',     name: `${role} rejected`, detail: actedDetail(s.actor.name, s.acted_at) });
                else if (s.status === 3) {
                    // The first cancelled step is where the request stopped: show who
                    // cancelled it (like an approver); later ones were never reached.
                    if (!nodes.some(x => x.state === 'cancelled')) {
                        nodes.push({ state: 'cancelled', icon: 'slash-circle', name: 'Cancelled', detail: actedDetail(s.actor.name, s.acted_at) });
                    } else {
                        nodes.push({ state: 'idle', icon: 'circle', name: role, detail: 'Not reached' });
                    }
                }
                else if (cur && cur.step_no === s.step_no)
                                         nodes.push({ state: 'current',   icon: 'hourglass-split', name: role, detail: who(s) });
                else                     nodes.push({ state: 'idle',      icon: 'circle',   name: role, detail: r.status === 0 ? who(s) : 'Not reached' });
            }
        } else if (r.status === 0) {
            nodes.push({ state: 'current', icon: 'hourglass-split', name: 'Approval', detail: `Awaiting ${r.awaiting || 'approver'}` });
        } else if (r.status === 1) {
            nodes.push({ state: 'done', icon: 'check-lg', name: 'Approved', detail: actedDetail(r.reviewer, r.approvedAt) });
        } else if (r.status === 2) {
            nodes.push({ state: 'rejected', icon: 'x-lg', name: 'Rejected', detail: actedDetail(r.reviewer, r.approvedAt) });
        } else {
            nodes.push({ state: 'cancelled', icon: 'slash-circle', name: 'Cancelled', detail: actedDetail(r.cancelledBy, r.cancelledAt) });
        }
        return nodes;
    }

    function tracker(r) {
        const nodes = buildNodes(r);
        const n = nodes.length;
        let lastDone = 0;
        nodes.forEach((x, i) => { if (x.state === 'done') lastDone = i; });
        // Pending: dashed amber line runs from the last completed node to the end.
        const gap = r.status === 0 ? Math.max(0, n - 1 - lastDone) : 0;

        const steps = r.steps || [];
        const cur = r.status === 0 ? steps.find(s => s.status === 0) : null;
        const badge = cur ? `Awaiting ${ROLE_LONG[cur.role] || cur.role}` : STATUS[r.status].label;

        return `
        <div class="approval-tracker-card" id="leaveApprovalTracker">
            <div class="approval-tracker-header">
                <span class="tracker-title"><i class="bi bi-diagram-3 me-1"></i>Approval Progress</span>
                <span class="tracker-badge ${STATUS[r.status].cls}">${esc(badge)}</span>
            </div>
            <div class="tracking-line-container" data-nodes="${n}" style="--n:${n};--done:${lastDone};--gap:${gap}">
                <div class="line-segment-completed"></div>
                ${gap ? '<div class="line-segment-pending"></div>' : ''}
                ${nodes.map(x => `
                <div class="tracking-step is-${x.state}">
                    <div class="step-circle"><i class="bi bi-${x.icon}"></i></div>
                    <div class="step-name">${esc(x.name)}</div>
                    <div class="step-detail">${esc(x.detail)}</div>
                </div>`).join('')}
            </div>
        </div>`;
    }

    // ---- modal body --------------------------------------------------------
    function render(r) {
        const days = Number(r.days);
        const steps = r.steps || [];
        const sameDay = r.startDate === r.endDate;
        const emp = splitEmployee(r.employee);
        const empCode = r.employeeCode || emp.code;

        const hero = `
        <div class="detail-hero-card">
            <div class="detail-emp-profile">
                <div class="detail-emp-avatar">${esc(initials(emp.name))}</div>
                <div class="detail-emp-meta">
                    <span class="detail-emp-name">${esc(emp.name || '—')}</span>
                    ${empCode ? `<span class="detail-emp-code">${esc(empCode)}</span>` : ''}
                </div>
            </div>
            <span class="leave-category-pill">${esc(r.leaveType || '—')}</span>
        </div>`;

        const schedule = `
        <div class="detail-schedule-card">
            <div class="schedule-header">
                <span class="schedule-title"><i class="bi bi-calendar-event"></i> Leave Period</span>
                <span class="schedule-duration-badge"><i class="bi bi-hourglass-split"></i> ${days} working ${days <= 1 ? 'day' : 'days'}</span>
            </div>
            <div class="schedule-dates-row">
                ${sameDay
                    ? dateNode('Date', r.startDate, r.startHalf, false)
                    : dateNode('Start Date', r.startDate, r.startHalf, false)
                      + '<i class="bi bi-arrow-right date-arrow-separator"></i>'
                      + dateNode('End Date', r.endDate, r.endHalf, true)}
            </div>
        </div>`;

        const reason = `
        <div class="detail-reason-box">
            <i class="bi bi-chat-square-text"></i>
            <div class="detail-reason-content">
                <div class="detail-reason-label">Reason / Notes</div>
                <div class="detail-reason-text${r.reason ? '' : ' is-empty'}">${r.reason ? esc(r.reason) : 'No reason provided'}</div>
            </div>
        </div>`;

        // Extra info the sample has no slot for: only rendered when present.
        const extra = [];
        for (const s of steps) {
            if (s.status === 1 && s.comment) {
                extra.push(row(`Comment · ${ROLE[s.role] || s.role}`, `<div class="detail-text detail-note is-approved">${esc(s.comment)}</div>`));
            }
        }
        if (r.status === 2 && r.rejectionReason) {
            extra.push(row('Rejection reason', `<div class="detail-text detail-note is-rejected">${esc(r.rejectionReason)}</div>`));
        }
        if (r.filedBy && r.filedBy !== r.employee && r.filedBy !== emp.name) extra.push(row('Filed by', esc(r.filedBy)));
        const extraHtml = extra.length ? `<dl class="detail-list">${extra.join('')}</dl>` : '';

        return hero + schedule + reason + extraHtml + tracker(r);
    }

    // admins have no employees row, so their actions are stored in
    // *_admin columns and their names come from this RPC (cached per page).
    let adminNames = null; // Map: auth user id -> name
    async function loadAdminNames(sb) {
        if (adminNames) return adminNames;
        try {
            const { data, error } = await sb.rpc('list_super_admin_names');
            if (error) throw error;
            adminNames = new Map((data || []).map((a) => [a.auth_user_id, a.name]));
        } catch (err) {
            console.warn('LeaveDetail: could not load admin names:', err);
            adminNames = new Map();
        }
        return adminNames;
    }
    const adminName = (id) => (id ? ((adminNames && adminNames.get(id)) || 'Admin') : '');

    global.LeaveDetail = { groupSteps, setStatus, render, loadAdminNames, adminName };
})(window);
