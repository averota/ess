/* =====================================================================
   ESS — Policies page logic (pages/policies.html)

   Reads and writes the tables from 03_policies_schemas.sql:
     policy_weekly_working_days   -> "Working week"
     policy_settings              -> "Monthly working days", "Leave year cut-off"
     leave_type_policies          -> one accordion item per leave type,
                                     including its eligibility, proration
                                     and approval-routing rules
     leave_type_proration_tiers   -> the "Use tiered credits for hire
                                     month" editor inside a leave type's
                                     "New Hire Proration & Accrual" card

   Also reads (read-only, for the "Reviewed by" dropdown):
     positions                    -> 01_employee_info_schema.sql

   Structure
     createSection(cfg)   shared behaviour for ONE policy section: dirty
                          tracking, Discard, Save state, validation, toasts,
                          "last changed" text. A section is just a config:
                              root          element that holds header + body + footer
                              label         name used in messages
                              fromRecord    DB row(s) -> plain values
                              apply         plain values -> form controls
                              read          form controls -> plain values
                              validate      values -> [{ el, msg }]
                              renderSummary values -> header summary text
                              save          values -> Promise<saved DB row(s)>
                              (optional) onEdit, auditOf, afterSave, recover
     To add a policy: add its markup, then add one createSection() below.

   Leave-type list UI (quick-stats bar, search box, status-filter pills
   above #ltList) is separate from createSection()/dirty-tracking — it
   only affects which rows are visible and the three stat counts, never
   what's saved. See refreshLeaveTypeListUI() and initLeaveTypeListControls().

   Access model (see the SQL header): everyone signed in can read; only
   admins can write. Under RLS a blocked UPDATE succeeds with zero rows, so
   every save checks that a row actually came back.

   Connection (same pattern as leaves.js):
     - supabaseClient.js provides the global `sb` (used bare, as in leaves.js).
     - sidebar.js fires `ess:ready` with { session, employee }. Nothing is
       loaded until it fires; no session means sidebar.js is already
       redirecting to login. `employee.role === 1` means admin (roles table
       in 01_employee_info_schema.sql: 0 = user, 1 = admin).

   Columns used (from the .sql files):
     leave_types           leave_type_id, leave_type, is_active     (02)
     employees             id, name                                 (01)
     positions              post_id, position, is_active             (01)
     policy_settings       id, standard_monthly_working_days,
                           year_cutoff_month, year_cutoff_day,
                           modified_by, last_modified               (03)
     policy_weekly_working_days
                           day_of_week, day_name, working_value,
                           modified_by, last_modified               (03)
     leave_type_policies   leave_type_id, beginning_balance,
                           max_balance, backdate_days,
                           max_carry_forward, carry_forward_expiry_month,
                           carry_forward_expiry_day, is_prorated,
                           use_partial_month_tiers, monthly_accrual_days,
                           eligibility_type, eligibility_years,
                           service_bonus_interval_years, service_bonus_days,
                           requires_approval, approver_post_id,
                           modified_by, last_modified                (03)
     leave_type_proration_tiers
                           id, leave_type_id, min_working_days,
                           credit_days                               (03)

   Note: employees is readable only by admins (or your own row), so the
   "by <name>" part of "Last changed" only appears for admins.

   "Annual Leave" is special-cased server-side: 03_policies_schemas.sql's
   enforce_annual_leave_only_service_bonus trigger rejects a service-length
   bonus on any OTHER leave type, and the proration-tier seed matches it by
   exact name. This page has no leave-type rename control at all (renaming
   still isn't possible from any UI — see LOOKUP_KINDS in employees.js,
   which doesn't include leave types), so there's nothing to actively guard
   here; isAnnualLeave() below only gates which fields render, and a
   "Name locked" flag is shown next to it as a heads-up for whoever adds a
   rename control later.
   ===================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Constants and small helpers                                         */
  /* ------------------------------------------------------------------ */
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // February is capped at 28 so a month/day exists every year — same rule as
  // policy_month_day_is_valid() in the database.
  const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const DAY_ABBR = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const MAX_DAYS = 9999.9;      // numeric(5,1)
  const MAX_BACKDATE = 365;     // smallint in the DB; 365 is a sensible UI ceiling
  const MAX_YEARS = 99;         // smallint in the DB; sensible UI ceiling for eligibility/service-bonus years
  const MAX_ACCRUAL = 99.99;    // numeric(4,2)

  // Column lists — exactly the columns in 03_policies_schemas.sql.
  const SETTINGS_COLS = 'id, standard_monthly_working_days, year_cutoff_month, year_cutoff_day, modified_by, last_modified';
  const WEEKLY_COLS = 'day_of_week, day_name, working_value, modified_by, last_modified';
  const LEAVE_POLICY_COLS = 'leave_type_id, beginning_balance, max_balance, backdate_days, max_carry_forward, '
    + 'carry_forward_expiry_month, carry_forward_expiry_day, is_prorated, use_partial_month_tiers, '
    + 'monthly_accrual_days, eligibility_type, eligibility_years, service_bonus_interval_years, '
    + 'service_bonus_days, requires_approval, approver_post_id, modified_by, last_modified';
  const TIER_COLS = 'id, leave_type_id, min_working_days, credit_days';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const daysIn = (month) => DAYS_IN_MONTH[month - 1] || 31;
  const oneDecimal = (n) => Math.abs(n * 10 - Math.round(n * 10)) < 1e-9;
  const numOf = (el) => {
    const v = el.value.trim();
    return v === '' ? null : Number(v);
  };
  const fmtNum = (n) => String(Number(n));                       // 15.0 -> "15"
  const fmtDays = (n) => `${fmtNum(n)} ${Number(n) === 1 ? 'day' : 'days'}`;

  let db = null;          // Supabase client
  let readOnly = false;   // true when the viewer is not an admin
  const nameCache = new Map();
  let positionsList = []; // { post_id, position }[] — for the "Reviewed by" dropdown, loaded once in loadAll()

  const sections = { weekly: null, monthly: null, cutoff: null, leaveTypes: [] };
  const allSections = () => [sections.weekly, sections.monthly, sections.cutoff, ...sections.leaveTypes].filter(Boolean);

  // Mirrors the server-side rule in 03_policies_schemas.sql exactly (case-
  // sensitive match on the trimmed name): the service-length bonus fields
  // and the proration-tier seed are both tied to this exact leave type.
  // See the header comment above re: there being no rename control to guard.
  function isAnnualLeave(lt) {
    return lt.label === 'Annual Leave';
  }

  /* ------------------------------------------------------------------ */
  /* UI helpers: toasts, error banner                                    */
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
    const panel = $('#policiesError');
    panel.textContent = '';
    if (!message) {
      panel.classList.add('hidden');
      return;
    }
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

  function clearInvalid(root) {
    $$('.is-invalid', root).forEach((el) => el.classList.remove('is-invalid'));
  }

  class NoRowsError extends Error {
    constructor() {
      super('No rows were changed.');
      this.code = 'NO_ROWS';
    }
  }

  function errorMessage(err) {
    if (!err) return 'Something went wrong. Try again.';
    if (err.code === 'NO_ROWS' || err.code === '42501') return 'Not saved: only admins can change policies.';
    if (err.code === '23514') return `Not saved: a value is outside the allowed range. ${err.message || ''}`.trim();
    return err.message || 'Something went wrong. Try again.';
  }

  /* ------------------------------------------------------------------ */
  /* Supabase access                                                     */
  /* ------------------------------------------------------------------ */
  function findClient() {
    // leaves.js uses the bare global `sb` from supabaseClient.js. `typeof`
    // is used because a top-level const/let in another classic script is
    // visible by name but is NOT a property of `window`.
    return typeof sb !== 'undefined' && sb && typeof sb.from === 'function' ? sb : null;
  }

  // Admin = employees.role === 1, as delivered by sidebar.js in ess:ready
  // (same check as leaves.js). If the event carried no employee record,
  // ask the database (public.is_admin() from 01). null = unknown: leave
  // editing on, RLS still protects the data.
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

  // UPDATE one row and return it. Under RLS a non-admin's UPDATE "succeeds"
  // with zero rows, so an empty result is treated as a permission failure.
  async function updateOne(table, cols, match, patch) {
    const { data, error } = await db.from(table).update(patch).match(match).select(cols);
    if (error) throw error;
    if (!data || data.length === 0) throw new NoRowsError();
    return data[0];
  }

  /* ---- "Last changed" text ---- */
  // employees.name (01_employee_info_schema.sql), keyed by employees.id
  // (uuid), which is what modified_by references. Names are a nicety:
  // under RLS non-admins can only read their own row, so for them the text
  // may omit "by …". Any failure is ignored for the same reason.
  async function ensureNames(ids) {
    const missing = [...new Set(ids.filter(Boolean))].filter((id) => !nameCache.has(id));
    if (!missing.length) return;
    try {
      const { data, error } = await db.from('employees').select('id, name').in('id', missing);
      if (error) throw error;
      (data || []).forEach((r) => nameCache.set(r.id, r.name || null));
    } catch (e) {
      /* ignore: see above */
    }
    missing.forEach((id) => { if (!nameCache.has(id)) nameCache.set(id, null); });
  }

  function auditLabel(record) {
    // modified_by is only set when someone edits through the app, so null
    // means the row still holds its seeded default.
    if (!record || !record.modified_by) return 'Default values, not edited yet';
    const when = new Date(record.last_modified).toLocaleString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    const who = nameCache.get(record.modified_by);
    return `Last changed ${when}${who ? ` by ${who}` : ''}`;
  }

  // Most recently edited row of a set (used for the 7 weekday rows)
  function latestEdited(rows) {
    const edited = rows.filter((r) => r && r.modified_by);
    if (!edited.length) return null;
    return edited.reduce((a, b) => (new Date(b.last_modified) > new Date(a.last_modified) ? b : a));
  }

  /* ------------------------------------------------------------------ */
  /* Month / day inputs                                                  */
  /* ------------------------------------------------------------------ */
  function fillMonths(select) {
    if (!select || select.querySelector('option[value="1"]')) return;
    MONTHS.forEach((name, i) => {
      const opt = document.createElement('option');
      opt.value = String(i + 1);
      opt.textContent = name;
      select.appendChild(opt);
    });
  }

  // Populates a "Reviewed by" <select> with the active positions loaded in
  // loadAll(). The first option ("Employee's direct supervisor", value="")
  // is already in the markup; this only ever appends, so it's safe to call
  // once per leave-type item at build time.
  function fillApprovers(select) {
    if (!select || select.childElementCount > 1) return;
    positionsList.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = String(p.post_id);
      opt.textContent = p.position;
      select.appendChild(opt);
    });
  }

  // Keep the day input consistent with the chosen month: capped for the
  // month, disabled and empty when the month is "Never".
  function syncDay(monthSelect, dayInput, prefill) {
    const month = Number(monthSelect.value);
    if (!month) {
      dayInput.value = '';
      dayInput.disabled = true;
      return;
    }
    dayInput.disabled = readOnly;
    const max = daysIn(month);
    dayInput.max = String(max);
    if (dayInput.value === '' && prefill) dayInput.value = String(max);   // 31 Mar, 30 Jun … the usual choice
    else if (Number(dayInput.value) > max) dayInput.value = String(max);
  }

  /* ------------------------------------------------------------------ */
  /* Section controller                                                  */
  /* ------------------------------------------------------------------ */
  function createSection(cfg) {
    const root = cfg.root;
    const saveBtn = $('[data-save]', root);
    const discardBtn = $('[data-discard]', root);
    const auditEl = $('[data-audit]', root);
    let saved = null;       // last loaded/saved values (plain)
    let dirty = false;
    let saving = false;
    let auditText = '';

    function paintFooter() {
      saveBtn.disabled = readOnly || saving || !dirty;
      saveBtn.textContent = saving ? 'Saving…' : 'Save changes';
      discardBtn.classList.toggle('hidden', !dirty || saving);
      auditEl.classList.toggle('is-dirty', dirty);
      auditEl.textContent = dirty ? 'Unsaved changes' : auditText;
      root.classList.toggle('is-dirty', dirty);
    }

    function check() {
      dirty = JSON.stringify(cfg.read()) !== JSON.stringify(saved);
      paintFooter();
    }

    function setAudit(record) {
      auditText = auditLabel(record);
      paintFooter();
    }

    function load(record) {
      cfg.apply(cfg.fromRecord(record));
      clearInvalid(root);
      saved = cfg.read();
      cfg.renderSummary(saved);
      dirty = false;
      setAudit(cfg.auditOf ? cfg.auditOf(record) : record);
    }

    function discard() {
      cfg.apply(saved);
      clearInvalid(root);
      check();
    }

    async function save() {
      if (saving || readOnly) return;
      const values = cfg.read();
      clearInvalid(root);
      const problems = cfg.validate(values);
      if (problems.length) {
        problems.forEach((p) => p.el && p.el.classList.add('is-invalid'));
        const first = problems.find((p) => p.el);
        if (first) first.el.focus();
        toast(problems[0].msg, 'danger');
        return;
      }
      saving = true;
      paintFooter();
      try {
        const record = await cfg.save(values, saved);
        saved = values;
        cfg.renderSummary(saved);
        const audited = cfg.auditOf ? cfg.auditOf(record) : record;
        await ensureNames([audited && audited.modified_by]);
        setAudit(audited);
        if (cfg.afterSave) cfg.afterSave(record, audited);
        toast(`${cfg.label} saved.`, 'success');
      } catch (err) {
        toast(errorMessage(err), 'danger');
        // Some rows were written before the failure: show what is really stored.
        if (err && err.partial && cfg.recover) {
          try { await cfg.recover(); } catch (e) { /* ignore */ }
        }
      } finally {
        saving = false;
        check();
      }
    }

    function onEdit(e) {
      const t = e.target;
      if (!t.matches('input, select')) return;
      t.classList.remove('is-invalid');
      if (cfg.onEdit) cfg.onEdit(t);
      check();
    }

    root.addEventListener('input', onEdit);
    root.addEventListener('change', onEdit);
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.matches('input[type="number"]')) {
        e.preventDefault();
        if (!saveBtn.disabled) save();
      }
    });
    saveBtn.addEventListener('click', save);
    discardBtn.addEventListener('click', discard);

    return { load, setAudit, isDirty: () => dirty, repaint: paintFooter };
  }

  /* ------------------------------------------------------------------ */
  /* Validation helpers (mirror the CHECK constraints in the SQL file)   */
  /* ------------------------------------------------------------------ */
  function daysProblem(label, value, required) {
    if (value == null) return required ? `${label}: enter a number of days (0 if none).` : null;
    if (!Number.isFinite(value) || value < 0 || value > MAX_DAYS) return `${label} must be between 0 and 9,999.9 days.`;
    if (!oneDecimal(value)) return `${label} can have at most one decimal place.`;
    return null;
  }

  function monthDayProblem(label, month, day) {
    const max = daysIn(month);
    if (day == null || !Number.isInteger(day) || day < 1 || day > max) {
      return `${label}: enter a day from 1 to ${max} for ${MONTHS[month - 1]}.`;
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* Section: Working week  (policy_weekly_working_days)                 */
  /* ------------------------------------------------------------------ */
  function summarizeWeek(vals) {
    const total = vals.reduce((a, b) => a + b, 0);
    if (total === 0) return 'No working days';
    const parts = [];
    let i = 0;
    while (i < 7) {
      const v = vals[i];
      if (v === 0) { i++; continue; }
      let j = i;
      while (j + 1 < 7 && vals[j + 1] === v) j++;
      const range = i === j ? DAY_ABBR[i] : `${DAY_ABBR[i]}–${DAY_ABBR[j]}`;
      parts.push(v === 1 ? range : `${range} half`);
      i = j + 1;
    }
    return `${fmtDays(total)} a week, ${parts.join(', ')}`;
  }

  async function fetchWeekly() {
    const { data, error } = await db.from('policy_weekly_working_days').select(WEEKLY_COLS).order('day_of_week');
    if (error) throw error;
    return data || [];
  }

  function initWeekly() {
    const root = $('#sec-weekly');
    sections.weekly = createSection({
      root,
      label: 'Working week',
      fromRecord: (rows) => {
        const vals = Array(7).fill(0);
        rows.forEach((r) => { vals[r.day_of_week - 1] = Number(r.working_value); });
        return vals;
      },
      apply: (vals) => vals.forEach((v, i) => {
        const radio = $(`input[name="dow-${i + 1}"][value="${v}"]`, root);
        if (radio) radio.checked = true;
      }),
      read: () => [1, 2, 3, 4, 5, 6, 7].map((d) => {
        const checked = $(`input[name="dow-${d}"]:checked`, root);
        return checked ? Number(checked.value) : 0;
      }),
      validate: () => [],
      renderSummary: (vals) => setSummary('weekly', summarizeWeek(vals)),
      auditOf: (rows) => latestEdited(Array.isArray(rows) ? rows : [rows]),
      // Only changed days are written. They are separate rows, so this is
      // not atomic; if one fails, recover() shows what is actually stored.
      save: async (vals, prev) => {
        const changed = vals.map((v, i) => [i + 1, v]).filter(([d, v]) => v !== prev[d - 1]);
        const settled = await Promise.allSettled(
          changed.map(([d, v]) => updateOne('policy_weekly_working_days', WEEKLY_COLS, { day_of_week: d }, { working_value: v }))
        );
        const rows = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
        const failed = settled.find((s) => s.status === 'rejected');
        if (failed) {
          const err = failed.reason || new Error('Save failed.');
          err.partial = rows.length > 0;
          throw err;
        }
        return rows;
      },
      recover: async () => sections.weekly.load(await fetchWeekly()),
    });
  }

  /* ------------------------------------------------------------------ */
  /* Section: Monthly working days  (policy_settings)                    */
  /* ------------------------------------------------------------------ */
  function initMonthly() {
    const root = $('#sec-monthly');
    const input = $('[data-field="standard_monthly_working_days"]', root);
    sections.monthly = createSection({
      root,
      label: 'Monthly working days',
      fromRecord: (r) => ({ days: Number(r.standard_monthly_working_days) }),
      apply: (v) => { input.value = v.days == null ? '' : String(v.days); },
      read: () => ({ days: numOf(input) }),
      validate: (v) => {
        if (v.days == null) return [{ el: input, msg: 'Enter the standard working days per month.' }];
        if (!Number.isFinite(v.days) || v.days <= 0 || v.days > 31) {
          return [{ el: input, msg: 'Working days per month must be more than 0 and at most 31.' }];
        }
        if (!oneDecimal(v.days)) return [{ el: input, msg: 'Working days per month can have at most one decimal place.' }];
        return [];
      },
      renderSummary: (v) => setSummary('monthly', v.days == null ? '—' : fmtDays(v.days)),
      save: (v) => updateOne('policy_settings', SETTINGS_COLS, { id: 1 }, { standard_monthly_working_days: v.days }),
      // Both settings sections share one row, so its "last changed" is shared too.
      afterSave: (record) => sections.cutoff && sections.cutoff.setAudit(record),
    });
  }

  /* ------------------------------------------------------------------ */
  /* Section: Leave year cut-off  (policy_settings)                      */
  /* ------------------------------------------------------------------ */
  function initCutoff() {
    const root = $('#sec-cutoff');
    const monthSel = $('[data-field="year_cutoff_month"]', root);
    const dayInp = $('[data-field="year_cutoff_day"]', root);
    const hint = $('[data-cycle-hint]', root);

    // "1 Jan – 31 Dec": the leave year starts the day after the cut-off.
    function paintCycleHint() {
      const m = Number(monthSel.value);
      const d = Number(dayInp.value);
      if (!m || !Number.isInteger(d) || d < 1 || d > daysIn(m)) {
        hint.textContent = '—';
        return;
      }
      const start = new Date(2001, m - 1, d + 1);   // 2001: not a leap year
      hint.textContent = `${start.getDate()} ${MONTHS[start.getMonth()]} – ${d} ${MONTHS[m - 1]}`;
    }

    sections.cutoff = createSection({
      root,
      label: 'Leave year cut-off',
      fromRecord: (r) => ({ month: Number(r.year_cutoff_month), day: Number(r.year_cutoff_day) }),
      apply: (v) => {
        monthSel.value = String(v.month);
        dayInp.value = v.day == null ? '' : String(v.day);
        syncDay(monthSel, dayInp, false);
        paintCycleHint();
      },
      read: () => ({ month: Number(monthSel.value), day: numOf(dayInp) }),
      onEdit: (el) => {
        if (el === monthSel) syncDay(monthSel, dayInp, true);
        paintCycleHint();
      },
      validate: (v) => {
        const msg = monthDayProblem('Cut-off date', v.month, v.day);
        return msg ? [{ el: dayInp, msg }] : [];
      },
      renderSummary: (v) => setSummary('cutoff', `Ends ${v.day} ${MONTHS[v.month - 1]}`),
      save: (v) => updateOne('policy_settings', SETTINGS_COLS, { id: 1 }, { year_cutoff_month: v.month, year_cutoff_day: v.day }),
      afterSave: (record) => sections.monthly && sections.monthly.setAudit(record),
    });
  }

  /* ------------------------------------------------------------------ */
  /* Leave types  (leave_types + leave_type_policies)                    */
  /* ------------------------------------------------------------------ */
  const DEFAULT_POLICY = {
    beginning_balance: 0, max_balance: null, backdate_days: 0, max_carry_forward: 0,
    carry_forward_expiry_month: null, carry_forward_expiry_day: null,
    is_prorated: false, use_partial_month_tiers: false, monthly_accrual_days: null,
    eligibility_type: 'immediate', eligibility_years: null,
    service_bonus_interval_years: null, service_bonus_days: 0,
    requires_approval: true, approver_post_id: null,
    modified_by: null,
  };

  // leave_types (02_leaves_schema.sql): leave_type = display name,
  // is_active = false means an admin disabled it in "Manage leave types".
  function leaveTypeLabel(row) {
    return typeof row.leave_type === 'string' && row.leave_type.trim()
      ? row.leave_type.trim()
      : `Leave type ${row.leave_type_id}`;
  }

  function leaveTypeIsDisabled(row) {
    return row.is_active === false;
  }

  // Reflects a leave type's active state in the header's status badge,
  // the item's own background (.is-disabled-type) and the status button.
  // Same enable-disable-not-delete pattern this replaces from leaves.js: a
  // type is never deleted, since past leave requests keep referencing it —
  // disabling it only hides it from new requests (see leaves.js's
  // activeLeaveTypes filter).
  function paintLeaveTypeStatus(root, disabled) {
    root.classList.toggle('is-disabled-type', disabled);
    const badge = $('[data-lt-status-badge]', root);
    badge.textContent = disabled ? 'Disabled' : 'Active';
    badge.className = `lt-state-badge lt-state-badge--${disabled ? 'disabled' : 'active'}`;
    const btn = $('[data-toggle-active]', root);
    btn.textContent = disabled ? 'Enable' : 'Disable';
    btn.classList.toggle('btn-ghost', !disabled);
    btn.classList.toggle('btn-outline-accent', disabled);
  }

  async function onToggleLeaveTypeActive(root, lt) {
    const btn = $('[data-toggle-active]', root);
    if (readOnly || btn.disabled) return;
    const nextActive = lt.disabled;   // disabled -> enable; enabled -> disable
    btn.disabled = true;
    try {
      const { data, error } = await db.from('leave_types')
        .update({ is_active: nextActive })
        .eq('leave_type_id', lt.id)
        .select('leave_type_id, is_active');
      if (error) throw error;
      if (!data || !data.length) throw new NoRowsError();
      lt.disabled = !nextActive;
      paintLeaveTypeStatus(root, lt.disabled);
      refreshLeaveTypeListUI();
      toast(`${lt.label} ${lt.disabled ? 'disabled' : 'enabled'}.`, 'success');
    } catch (err) {
      toast(errorMessage(err), 'danger');
    } finally {
      btn.disabled = readOnly;
    }
  }

  function setCell(root, key, text, muted) {
    const span = $(`[data-summary="${key}"]`, root);
    span.textContent = text;
    span.closest('.lt-metric-chip').classList.toggle('is-muted', !!muted);
  }

  function renderLeaveSummary(root, v) {
    setCell(root, 'beginning_balance', v.beginning == null ? '—' : fmtDays(v.beginning), false);
    setCell(root, 'max_balance', v.max == null ? 'No cap' : fmtDays(v.max), v.max == null);
    setCell(root, 'backdate_days', v.backdate ? fmtDays(v.backdate) : 'Not allowed', !v.backdate);
    const carry = !v.carry
      ? 'None'
      : v.expMonth
        ? `${fmtDays(v.carry)} until ${v.expDay} ${MONTHS[v.expMonth - 1]}`
        : `${fmtDays(v.carry)}, no expiry`;
    setCell(root, 'carry_forward', carry, !v.carry);
  }

  // ---- Proration-tier row helpers (leave_type_proration_tiers) --------
  // Each row is { id, minDays, credit }; id is null for a row not yet
  // saved. Order in the DOM is the order read() returns them in, which
  // matters for the dirty-check (see initLeaveTypeSection's fromRecord).
  function buildTierRow(t) {
    const tpl = $('#ltTierRowTemplate');
    const holder = document.createElement('div');
    holder.innerHTML = tpl.innerHTML;
    const row = holder.firstElementChild;
    if (t.id != null) row.dataset.tierId = String(t.id);
    $('[data-tier-field="min_working_days"]', row).value = t.minDays == null ? '' : String(t.minDays);
    $('[data-tier-field="credit_days"]', row).value = t.credit == null ? '' : String(t.credit);
    $('[data-remove-tier]', row).disabled = readOnly;
    return row;
  }

  function readTierRows(listEl) {
    return $$('.lt-tier-row', listEl).map((row) => ({
      id: row.dataset.tierId ? Number(row.dataset.tierId) : null,
      minDays: numOf($('[data-tier-field="min_working_days"]', row)),
      credit: numOf($('[data-tier-field="credit_days"]', row)),
    }));
  }

  function initLeaveTypeSection(root, lt) {
    const f = (key) => $(`[data-field="${key}"]`, root);
    const monthSel = f('carry_forward_expiry_month');
    const dayInp = f('carry_forward_expiry_day');
    const id = lt.id;
    const isAnnual = isAnnualLeave(lt);

    // Eligibility
    const eligTypeSel = f('eligibility_type');
    const eligYearsInp = f('eligibility_years');
    const eligYearsField = $('[data-elig-years-field]', root);

    // Proration
    const proratedChk = f('is_prorated');
    const accrualInp = f('monthly_accrual_days');
    const tiersOnChk = f('use_partial_month_tiers');
    const prorateFieldsWrap = $('[data-prorate-fields]', root);
    const tiersEditorWrap = $('[data-tiers-editor]', root);
    const tiersListEl = $('[data-tiers-list]', root);
    const addTierBtn = $('[data-add-tier]', root);

    // Service-length bonus — Annual Leave only (see isAnnualLeave() above
    // and the DB trigger it mirrors). For every other leave type the
    // fieldset is hidden and its inputs disabled so there's no way to set
    // a value the save would then have to strip back out.
    const bonusFieldset = $('[data-service-bonus-field]', root);
    const bonusIntervalInp = f('service_bonus_interval_years');
    const bonusDaysInp = f('service_bonus_days');
    if (!isAnnual) {
      bonusFieldset.classList.add('hidden');
      bonusIntervalInp.disabled = true;
      bonusDaysInp.disabled = true;
    }

    // Approval routing
    const requiresApprovalChk = f('requires_approval');
    const approverField = $('[data-approver-field]', root);
    const approverSel = f('approver_post_id');
    fillApprovers(approverSel);

    function toggleEligYearsField() {
      eligYearsField.classList.toggle('hidden', eligTypeSel.value !== 'after_years');
    }
    function toggleProrationFields() {
      const on = proratedChk.checked;
      prorateFieldsWrap.classList.toggle('hidden', !on);
      tiersEditorWrap.classList.toggle('hidden', !(on && tiersOnChk.checked));
    }
    function toggleApproverField() {
      approverField.classList.toggle('hidden', !requiresApprovalChk.checked);
    }
    // Structural tier add/remove doesn't touch an <input>, so it can't
    // reach createSection's root 'input' listener directly — bump it via
    // an existing field instead, the same way any other edit would.
    function bumpDirty() {
      accrualInp.dispatchEvent(new Event('input', { bubbles: true }));
    }

    addTierBtn.addEventListener('click', () => {
      if (readOnly) return;
      const row = buildTierRow({ id: null, minDays: null, credit: null });
      tiersListEl.appendChild(row);
      bumpDirty();
      $('[data-tier-field="min_working_days"]', row).focus();
    });
    tiersListEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-remove-tier]');
      if (!btn || readOnly) return;
      btn.closest('.lt-tier-row').remove();
      bumpDirty();
    });

    return createSection({
      root,
      label: lt.label,
      fromRecord: (r) => {
        const p = r || DEFAULT_POLICY;
        return {
          beginning: p.beginning_balance == null ? null : Number(p.beginning_balance),
          max: p.max_balance == null ? null : Number(p.max_balance),
          backdate: p.backdate_days == null ? null : Number(p.backdate_days),
          carry: p.max_carry_forward == null ? null : Number(p.max_carry_forward),
          expMonth: p.carry_forward_expiry_month == null ? null : Number(p.carry_forward_expiry_month),
          expDay: p.carry_forward_expiry_day == null ? null : Number(p.carry_forward_expiry_day),
          eligType: p.eligibility_type || 'immediate',
          eligYears: p.eligibility_years == null ? null : Number(p.eligibility_years),
          isProrated: !!p.is_prorated,
          useTiers: !!p.use_partial_month_tiers,
          accrual: p.monthly_accrual_days == null ? null : Number(p.monthly_accrual_days),
          bonusInterval: isAnnual && p.service_bonus_interval_years != null ? Number(p.service_bonus_interval_years) : null,
          bonusDays: isAnnual && p.service_bonus_days != null ? Number(p.service_bonus_days) : 0,
          requiresApproval: p.requires_approval !== false,
          approverPostId: p.approver_post_id == null ? null : Number(p.approver_post_id),
          tiers: (p.tiers || []).map((t) => ({
            id: t.id, minDays: Number(t.min_working_days), credit: Number(t.credit_days),
          })),
        };
      },
      apply: (v) => {
        f('beginning_balance').value = v.beginning == null ? '' : String(v.beginning);
        f('max_balance').value = v.max == null ? '' : String(v.max);
        f('backdate_days').value = v.backdate == null ? '' : String(v.backdate);
        f('max_carry_forward').value = v.carry == null ? '' : String(v.carry);
        monthSel.value = v.expMonth == null ? '' : String(v.expMonth);
        dayInp.value = v.expMonth == null || v.expDay == null ? '' : String(v.expDay);
        syncDay(monthSel, dayInp, false);

        eligTypeSel.value = v.eligType;
        eligYearsInp.value = v.eligYears == null ? '' : String(v.eligYears);
        toggleEligYearsField();

        proratedChk.checked = v.isProrated;
        accrualInp.value = v.accrual == null ? '' : String(v.accrual);
        tiersOnChk.checked = v.useTiers;
        tiersListEl.innerHTML = '';
        v.tiers.forEach((t) => tiersListEl.appendChild(buildTierRow(t)));
        toggleProrationFields();

        if (isAnnual) {
          bonusIntervalInp.value = v.bonusInterval == null ? '' : String(v.bonusInterval);
          bonusDaysInp.value = String(v.bonusDays);
        }

        requiresApprovalChk.checked = v.requiresApproval;
        approverSel.value = v.approverPostId == null ? '' : String(v.approverPostId);
        toggleApproverField();
      },
      read: () => {
        const expMonth = monthSel.value ? Number(monthSel.value) : null;
        const eligType = eligTypeSel.value;
        const isProrated = proratedChk.checked;
        const requiresApproval = requiresApprovalChk.checked;
        return {
          beginning: numOf(f('beginning_balance')),
          max: numOf(f('max_balance')),
          backdate: numOf(f('backdate_days')),
          carry: numOf(f('max_carry_forward')),
          expMonth,
          expDay: expMonth ? numOf(dayInp) : null,
          eligType,
          eligYears: eligType === 'after_years' ? numOf(eligYearsInp) : null,
          isProrated,
          useTiers: isProrated ? tiersOnChk.checked : false,
          accrual: numOf(accrualInp),
          bonusInterval: isAnnual ? numOf(bonusIntervalInp) : null,
          bonusDays: isAnnual ? (numOf(bonusDaysInp) ?? 0) : 0,
          requiresApproval,
          approverPostId: requiresApproval && approverSel.value ? Number(approverSel.value) : null,
          tiers: readTierRows(tiersListEl),
        };
      },
      onEdit: (el) => {
        if (el === monthSel) syncDay(monthSel, dayInp, true);
        else if (el === eligTypeSel) toggleEligYearsField();
        else if (el === proratedChk || el === tiersOnChk) toggleProrationFields();
        else if (el === requiresApprovalChk) toggleApproverField();
      },
      validate: (v) => {
        const problems = [];
        const add = (key, msg) => msg && problems.push({ el: f(key), msg });
        add('beginning_balance', daysProblem('Beginning balance', v.beginning, true));
        add('max_balance', daysProblem('Maximum balance', v.max, false));
        if (v.max != null && v.beginning != null && v.max < v.beginning && !problems.length) {
          add('max_balance', 'Maximum balance can\u2019t be lower than the beginning balance.');
        }
        if (v.backdate == null || !Number.isInteger(v.backdate) || v.backdate < 0 || v.backdate > MAX_BACKDATE) {
          add('backdate_days', `Back-date: enter a whole number of days from 0 to ${MAX_BACKDATE} (0 for no back-dating).`);
        }
        add('max_carry_forward', daysProblem('Maximum carried', v.carry, true));
        if (v.expMonth) {
          const msg = monthDayProblem('Lapse date', v.expMonth, v.expDay);
          if (msg) problems.push({ el: dayInp, msg });
        }

        if (v.eligType === 'after_years'
          && (v.eligYears == null || !Number.isInteger(v.eligYears) || v.eligYears < 1 || v.eligYears > MAX_YEARS)) {
          add('eligibility_years', `Years of service: enter a whole number from 1 to ${MAX_YEARS}.`);
        }

        if (v.accrual != null && (!Number.isFinite(v.accrual) || v.accrual < 0 || v.accrual > MAX_ACCRUAL)) {
          add('monthly_accrual_days', `Full-month credit must be between 0 and ${MAX_ACCRUAL} days.`);
        }

        if (v.tiers.length) {
          const seen = new Set();
          $$('.lt-tier-row', tiersListEl).forEach((row, i) => {
            const t = v.tiers[i];
            const minEl = $('[data-tier-field="min_working_days"]', row);
            const creditEl = $('[data-tier-field="credit_days"]', row);
            if (t.minDays == null || !Number.isInteger(t.minDays) || t.minDays < 0 || t.minDays > 31) {
              problems.push({ el: minEl, msg: 'Tier: working days remaining must be a whole number from 0 to 31.' });
            } else if (seen.has(t.minDays)) {
              problems.push({ el: minEl, msg: 'Tier: each threshold can only be used once.' });
            } else {
              seen.add(t.minDays);
            }
            const creditMsg = daysProblem('Tier credit', t.credit, true);
            if (creditMsg) problems.push({ el: creditEl, msg: creditMsg });
          });
        }

        if (isAnnual) {
          if (v.bonusInterval != null
            && (!Number.isInteger(v.bonusInterval) || v.bonusInterval < 1 || v.bonusInterval > MAX_YEARS)) {
            add('service_bonus_interval_years', `Service bonus: "every" must be a whole number of years from 1 to ${MAX_YEARS} (leave blank for no bonus).`);
          }
          const bonusDaysMsg = daysProblem('Service bonus days', v.bonusDays, true);
          if (bonusDaysMsg) add('service_bonus_days', bonusDaysMsg);
        }

        return problems;
      },
      renderSummary: (v) => renderLeaveSummary(root, v),
      save: async (v, prev) => {
        addTierBtn.disabled = true;
        $$('[data-remove-tier]', tiersListEl).forEach((btn) => { btn.disabled = true; });
        try {
          const patch = {
            beginning_balance: v.beginning,
            max_balance: v.max,
            backdate_days: v.backdate,
            max_carry_forward: v.carry,
            carry_forward_expiry_month: v.expMonth,
            carry_forward_expiry_day: v.expMonth ? v.expDay : null,
            eligibility_type: v.eligType,
            eligibility_years: v.eligYears,
            is_prorated: v.isProrated,
            use_partial_month_tiers: v.useTiers,
            monthly_accrual_days: v.accrual,
            service_bonus_interval_years: v.bonusInterval,
            service_bonus_days: v.bonusDays,
            requires_approval: v.requiresApproval,
            approver_post_id: v.approverPostId,
          };
          const upd = await db.from('leave_type_policies').update(patch).eq('leave_type_id', id).select(LEAVE_POLICY_COLS);
          if (upd.error) throw upd.error;
          let record;
          if (upd.data && upd.data.length) {
            record = upd.data[0];
          } else {
            // No row yet (normally created by trigger/seed): create it. For a
            // non-admin this is blocked by RLS, which surfaces as a permission error.
            const ins = await db.from('leave_type_policies').insert({ leave_type_id: id, ...patch }).select(LEAVE_POLICY_COLS);
            if (ins.error) throw ins.error;
            if (!ins.data || !ins.data.length) throw new NoRowsError();
            record = ins.data[0];
          }

          // Proration tiers live in their own table, diffed against what was
          // last loaded/saved. v.tiers is mutated in place with server-
          // assigned ids for new rows, and the matching DOM row is stamped
          // too, so the next read() agrees with `saved` (see createSection's
          // save(): `saved = values` reuses this same object by reference).
          const prevById = new Map((prev.tiers || []).filter((t) => t.id != null).map((t) => [t.id, t]));
          const keepIds = new Set();
          const rows = $$('.lt-tier-row', tiersListEl);
          for (let i = 0; i < v.tiers.length; i++) {
            const t = v.tiers[i];
            if (t.id != null) {
              keepIds.add(t.id);
              const before = prevById.get(t.id);
              if (before && (before.minDays !== t.minDays || before.credit !== t.credit)) {
                const { error } = await db.from('leave_type_proration_tiers')
                  .update({ min_working_days: t.minDays, credit_days: t.credit })
                  .eq('id', t.id);
                if (error) throw error;
              }
            } else {
              const { data, error } = await db.from('leave_type_proration_tiers')
                .insert({ leave_type_id: id, min_working_days: t.minDays, credit_days: t.credit })
                .select('id');
              if (error) throw error;
              t.id = data[0].id;
              if (rows[i]) rows[i].dataset.tierId = String(t.id);
            }
          }
          const toDelete = [...prevById.keys()].filter((tid) => !keepIds.has(tid));
          if (toDelete.length) {
            const { error } = await db.from('leave_type_proration_tiers').delete().in('id', toDelete);
            if (error) throw error;
          }

          return record;
        } finally {
          addTierBtn.disabled = readOnly;
          $$('[data-remove-tier]', tiersListEl).forEach((btn) => { btn.disabled = readOnly; });
        }
      },
    });
  }

  // Builds one .lt-item from #ltItemTemplate, wires its accordion section
  // and its enable/disable button, and loads it with a policy row (or
  // null, for a brand-new leave type that has no policy yet). Shared by
  // the initial render and by onAddLeaveType() below.
  function buildLeaveTypeItem(lt, policyRow, tierRows, openByDefault) {
    const tpl = $('#ltItemTemplate');
    const holder = document.createElement('div');
    holder.innerHTML = tpl.innerHTML.split('{{id}}').join(String(lt.id));
    const root = holder.firstElementChild;
    $('[data-lt-name]', root).textContent = lt.label;
    if (isAnnualLeave(lt)) {
      const lock = document.createElement('span');
      lock.className = 'policy-flag policy-flag--muted';
      lock.title = 'This name is relied on by the proration seed and the '
        + 'service-bonus rule in 03_policies_schemas.sql. There\u2019s no '
        + 'rename control for leave types anywhere in this app today, but '
        + 'if one is ever added, "Annual Leave" must stay excluded from it.';
      lock.textContent = 'Name locked';
      $('.lt-name', root).appendChild(lock);
    }
    paintLeaveTypeStatus(root, lt.disabled);
    const statusBtn = $('[data-toggle-active]', root);
    statusBtn.disabled = readOnly;
    statusBtn.addEventListener('click', (e) => {
      e.stopPropagation();   // sits next to the accordion toggle; don't let a click bubble into it
      onToggleLeaveTypeActive(root, lt);
    });
    $$('select[data-month-select]', root).forEach(fillMonths);
    if (openByDefault) {
      $('.lt-toggle', root).classList.remove('collapsed');
      $('.lt-toggle', root).setAttribute('aria-expanded', 'true');
      $('.collapse', root).classList.add('show');
    }
    const section = initLeaveTypeSection(root, lt);
    const record = policyRow ? { ...policyRow, tiers: tierRows || [] } : (tierRows && tierRows.length ? { ...DEFAULT_POLICY, tiers: tierRows } : null);
    section.load(record);
    sections.leaveTypes.push(section);
    return root;
  }

  function renderLeaveTypes(types, policies, tiersByType) {
    const list = $('#ltList');
    $$('.lt-item', list).forEach((el) => el.remove());
    sections.leaveTypes = [];

    types.forEach((lt, index) => {
      // First item starts open, as in the design.
      list.appendChild(buildLeaveTypeItem(lt, policies.get(lt.id), tiersByType.get(lt.id), index === 0));
    });

    $('#ltLoading').classList.add('hidden');
    list.classList.toggle('hidden', types.length === 0);
    refreshLeaveTypeListUI();
  }

  /* ---- Leave-type list UI: quick stats, search, status filter -------- */
  // State for the search box and status-filter pills above #ltList. Kept
  // in module scope (not per-item) since one search/filter applies to the
  // whole list.
  let ltSearch = '';              // lower-cased text from #ltSearchInput
  let ltStatusFilter = 'all';     // 'all' | 'active' | 'disabled', from [data-lt-filter]

  // Recomputes which items match the current search/filter, updates the
  // Total/Active/Disabled stat chips, and shows the empty state when
  // nothing matches. Driven entirely off the DOM (.is-disabled-type, set
  // by paintLeaveTypeStatus) rather than a parallel data structure, so it
  // can be called after any mutation — render, add, or toggle — without
  // needing to know what changed.
  function refreshLeaveTypeListUI() {
    const list = $('#ltList');
    const items = $$('.lt-item', list);
    let activeCount = 0;

    items.forEach((item) => {
      const disabled = item.classList.contains('is-disabled-type');
      if (!disabled) activeCount++;

      const name = ($('[data-lt-name]', item) || {}).textContent || '';
      const matchesSearch = !ltSearch || name.toLowerCase().includes(ltSearch);
      const matchesFilter = ltStatusFilter === 'all'
        || (ltStatusFilter === 'active' && !disabled)
        || (ltStatusFilter === 'disabled' && disabled);
      item.classList.toggle('is-hidden-by-filter', !(matchesSearch && matchesFilter));
    });

    const total = items.length;
    const totalEl = $('#ltTotalCount');
    if (totalEl) totalEl.textContent = String(total);
    const activeEl = $('#ltActiveCount');
    if (activeEl) activeEl.textContent = String(activeCount);
    const disabledEl = $('#ltDisabledCount');
    if (disabledEl) disabledEl.textContent = String(total - activeCount);

    const hasVisible = items.some((item) => !item.classList.contains('is-hidden-by-filter'));
    const empty = $('#leaveTypesEmpty');
    list.classList.toggle('hidden', total === 0);
    empty.classList.toggle('hidden', total === 0 || hasVisible);
    empty.textContent = total === 0
      ? 'No leave types yet. Add one above and it will appear here with its own policy to set.'
      : 'No leave types match your search or filter.';
  }

  function initLeaveTypeListControls() {
    const searchInput = $('#ltSearchInput');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        ltSearch = searchInput.value.trim().toLowerCase();
        refreshLeaveTypeListUI();
      });
    }
    $$('[data-lt-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('[data-lt-filter]').forEach((b) => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        ltStatusFilter = btn.dataset.ltFilter;
        refreshLeaveTypeListUI();
      });
    });
  }

  // ---- Add leave type -------------------------------------------------
  // Unlike the enable/disable toggle (an update, silently blocked by RLS
  // for a non-admin — see NoRowsError), an insert blocked by RLS's WITH
  // CHECK comes back as a real error, so this only needs errorMessage().
  async function onAddLeaveType() {
    const input = $('#newLeaveTypeInput');
    const btn = $('#addLeaveTypeBtn');
    const name = input.value.trim();
    if (!name) {
      input.classList.add('is-invalid');
      input.focus();
      toast('Enter a name for the new leave type.', 'danger');
      return;
    }
    input.classList.remove('is-invalid');
    btn.disabled = true;
    try {
      const { data, error } = await db.from('leave_types')
        .insert({ leave_type: name })
        .select('leave_type_id, leave_type, is_active');
      if (error) throw error;
      if (!data || !data.length) throw new NoRowsError();
      const row = data[0];
      const lt = { id: row.leave_type_id, label: leaveTypeLabel(row), disabled: leaveTypeIsDisabled(row) };
      const list = $('#ltList');
      list.appendChild(buildLeaveTypeItem(lt, null, null, false));
      refreshLeaveTypeListUI();
      input.value = '';
      toast(`"${lt.label}" added.`, 'success');
    } catch (err) {
      if (err && err.code === '23505') {
        input.classList.add('is-invalid');
        toast(`"${name}" already exists.`, 'danger');
      } else {
        toast(errorMessage(err), 'danger');
      }
    } finally {
      btn.disabled = readOnly;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Loading                                                             */
  /* ------------------------------------------------------------------ */
  function setSummary(key, text) {
    const el = $(`[data-summary="${key}"]`);
    if (el) el.textContent = text;
  }

  async function loadAll() {
    const [settings, weekly, types, policies, tiers, positions] = await Promise.all([
      db.from('policy_settings').select(SETTINGS_COLS).eq('id', 1).maybeSingle(),
      db.from('policy_weekly_working_days').select(WEEKLY_COLS).order('day_of_week'),
      db.from('leave_types').select('leave_type_id, leave_type, is_active').order('leave_type'),
      db.from('leave_type_policies').select(LEAVE_POLICY_COLS),
      db.from('leave_type_proration_tiers').select(TIER_COLS),
      db.from('positions').select('post_id, position').eq('is_active', true).order('position'),
    ]);
    const failed = [settings, weekly, types, policies, tiers, positions].find((r) => r.error);
    if (failed) throw failed.error;

    const weeklyRows = weekly.data || [];
    if (!settings.data || weeklyRows.length !== 7) {
      throw new Error('No policy data found. Check that 03_policies_schemas.sql has been run, or sign in again if your session expired.');
    }

    positionsList = positions.data || [];

    const policyRows = policies.data || [];
    await ensureNames([
      settings.data.modified_by,
      ...weeklyRows.map((r) => r.modified_by),
      ...policyRows.map((r) => r.modified_by),
    ]);

    sections.weekly.load(weeklyRows);
    sections.monthly.load(settings.data);
    sections.cutoff.load(settings.data);

    const tiersByType = new Map();
    (tiers.data || []).forEach((t) => {
      if (!tiersByType.has(t.leave_type_id)) tiersByType.set(t.leave_type_id, []);
      tiersByType.get(t.leave_type_id).push(t);
    });
    // Highest threshold first, matching how the rule reads ("the highest
    // threshold met") — purely a display default, not load-bearing.
    tiersByType.forEach((rows) => rows.sort((a, b) => b.min_working_days - a.min_working_days));

    const leaveTypes = (types.data || [])
      .map((row) => ({
        id: row.leave_type_id,
        label: leaveTypeLabel(row),
        disabled: leaveTypeIsDisabled(row),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
    renderLeaveTypes(leaveTypes, new Map(policyRows.map((r) => [r.leave_type_id, r])), tiersByType);
  }

  function applyReadOnly() {
    $('.policies-page').classList.add('is-readonly');
    $('#policiesReadOnly').classList.remove('hidden');
    // #ltSearchInput is deliberately excluded: searching/filtering the list
    // isn't an edit, so it stays usable for a read-only viewer.
    $$('#policyPanes input:not(#ltSearchInput), #policyPanes select, #policyPanes [data-toggle-active], #policyPanes [data-add-tier], #policyPanes [data-remove-tier], #addLeaveTypeBtn')
      .forEach((el) => { el.disabled = true; });
    allSections().forEach((s) => s.repaint());
  }

  async function run() {
    showError(null);
    try {
      await loadAll();
      if (readOnly) applyReadOnly();
    } catch (err) {
      ['weekly', 'monthly', 'cutoff'].forEach((k) => setSummary(k, 'Unavailable'));
      $('#ltLoading').classList.add('hidden');
      showError(`Couldn\u2019t load policies. ${err && err.message ? err.message : ''}`.trim(), run);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Tabs: remember the open tab in the URL hash                         */
  /* ------------------------------------------------------------------ */
  function initTabs() {
    const tabs = $$('#policyTabs [data-bs-toggle="tab"]');
    const wanted = tabs.find((t) => t.dataset.bsTarget === location.hash);
    if (wanted && window.bootstrap) window.bootstrap.Tab.getOrCreateInstance(wanted).show();
    tabs.forEach((t) => t.addEventListener('shown.bs.tab', () => {
      history.replaceState(null, '', t.dataset.bsTarget);
    }));
  }

  /* ------------------------------------------------------------------ */
  /* Init                                                                */
  /* ------------------------------------------------------------------ */
  // Wire the page once (tabs, section controllers, unsaved-changes guard).
  // No data access here; that waits for ess:ready.
  let wired = false;
  function setupPage() {
    if (wired) return;
    wired = true;
    $$('select[data-month-select]').forEach(fillMonths);
    initTabs();
    initWeekly();
    initMonthly();
    initCutoff();
    initLeaveTypeListControls();

    const addBtn = $('#addLeaveTypeBtn');
    const addInput = $('#newLeaveTypeInput');
    addBtn.addEventListener('click', onAddLeaveType);
    addInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); onAddLeaveType(); }
    });
    addInput.addEventListener('input', () => addInput.classList.remove('is-invalid'));

    window.addEventListener('beforeunload', (e) => {
      if (allSections().some((s) => s.isDirty())) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  const domReady = new Promise((resolve) => {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', resolve);
    else resolve();
  });

  let started = false;   // ess:ready can fire more than once; wire and load only once (same guard as leaves.js)

  async function onEssReady(e) {
    if (started) return;
    const { session, employee } = (e && e.detail) || {};
    if (!session) return;   // sidebar.js is redirecting to login (or Supabase isn't configured)
    started = true;

    await domReady;
    setupPage();

    db = findClient();
    if (!db) {
      ['weekly', 'monthly', 'cutoff'].forEach((k) => setSummary(k, 'Unavailable'));
      $('#ltLoading').classList.add('hidden');
      showError('Couldn\u2019t find the Supabase client. Check that supabaseClient.js defines `sb` and loads before policies.js.');
      return;
    }

    readOnly = (await checkAdmin(employee)) === false;
    run();
  }

  window.addEventListener('ess:ready', onEssReady);
})();
