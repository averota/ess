/* =====================================================================
   ESS — Policies page logic (pages/policies.html)

   Reads and writes:
     policy_weekly_working_days   -> "Working week"                     (03)
     policy_settings              -> "Monthly working days",
                                     "Leave year cut-off"               (03)
     leave_types                  -> one accordion item per leave type.
                                     EVERY per-type rule is a column on
                                     this table now (entitlement, effective
                                     from, proration, service bonus,
                                     negative balance, carry forward,
                                     notice, back-date, requires approval).
                                     The old leave_type_policies table is
                                     gone.                              (02)
     leave_type_proration_tiers   -> the tier editor in a leave type's
                                     "Proration & partial month" card   (02)
     leave_type_approval_rules    -> the rule editor in a leave type's
                                     "Review & approval" card           (02)

   Also reads (read-only, for the rule editor's "Applies to" dropdown):
     positions, departments, employees                                  (01)

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

   A leave type saves as ONE unit: one UPDATE of its leave_types row, then
   its child rows (tiers, approval rules) are diff-synced. If the update
   works but a child row fails, the section stays dirty so Save can be
   retried (already-written rows are not written twice).

   Access model (see the SQL headers): everyone signed in can read; only
   admins can write. Under RLS a blocked UPDATE succeeds with zero rows, so
   every save checks that a row actually came back.

   Connection (same pattern as leaves.js):
     - supabaseClient.js provides the global `sb` (used bare, as in leaves.js).
     - sidebar.js fires `ess:ready` with { session, employee }. Nothing is
       loaded until it fires; no session means sidebar.js is already
       redirecting to login. `employee.role === 1` means admin (roles table
       in 01_employee_info_schema.sql: 0 = user, 1 = admin).

   Leave code: leave_types.leave_code is set when a type is created and can
   never be changed afterwards (a trigger in 02 rejects it), so this page
   only ever sends it on INSERT and shows it read-only everywhere else.

   Durations (length of service, service-bonus interval) are stored in
   months. The form lets you type them in months or years; years are
   converted on save, and a whole number of years is shown as years on load.

   Approval rules: min_days is "requests of at least this many days"
   (get_leave_approval_requirement() compares min_days <= total_days). The
   three role flags are SEQUENTIAL steps — 1st line, then 2nd line, then
   HOD — not alternatives (see 02 / leave_request_approvals).

   Note: employees is readable only by admins (or your own row and your
   direct reports), so the "by <name>" part of "Last changed" and the
   Employee choice in the rule editor are only fully populated for admins.
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
  const MAX_DAYS = 9999.9;        // numeric(5,1): carry-forward, negative limit, rule threshold
  const MAX_ENTITLEMENT = 999.99; // numeric(5,2): entitlement_days
  const MAX_BONUS_DAYS = 999.9;   // numeric(4,1): service_bonus_days
  const MAX_SMALLINT = 32767;     // smallint months (eligibility, service-bonus interval)
  const MAX_WINDOW_DAYS = 365;    // smallint in the DB; sensible UI ceiling for notice / back-date days

  // Column lists — exactly the columns in the SQL files.
  const SETTINGS_COLS = 'id, standard_monthly_working_days, year_cutoff_month, year_cutoff_day, modified_by, modified_by_admin, last_modified';
  const WEEKLY_COLS = 'day_of_week, day_name, working_value, modified_by, modified_by_admin, last_modified';
  const LEAVE_TYPE_COLS = 'leave_type_id, leave_type, leave_code, is_active, '
    + 'eligibility_type, eligibility_service_months, entitlement_type, entitlement_days, '
    + 'use_partial_month, partial_month_method, prorate_rounding, '
    + 'service_bonus_enabled, service_bonus_interval_months, service_bonus_days, '
    + 'allow_negative_balance, max_negative_days, requires_approval, '
    + 'max_carry_forward, carry_forward_expiry_month, carry_forward_expiry_day, '
    + 'require_prior_notice, prior_notice_days, allow_backdate, backdate_days, '
    + 'modified_by, modified_by_admin, last_modified';
  const TIER_COLS = 'id, leave_type_id, min_working_days, credit_days';
  const RULE_COLS = 'id, leave_type_id, scope_type, scope_employee_id, scope_post_id, scope_dept_id, '
    + 'min_days, require_first_line, require_second_line, require_hod';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const daysIn = (month) => DAYS_IN_MONTH[month - 1] || 31;
  const oneDecimal = (n) => Math.abs(n * 10 - Math.round(n * 10)) < 1e-9;
  const twoDecimals = (n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
  const numOf = (el) => {
    const v = el.value.trim();
    return v === '' ? null : Number(v);
  };
  const fmtNum = (n) => String(Number(n));                       // 15.0 -> "15"
  const fmtDays = (n) => `${fmtNum(n)} ${Number(n) === 1 ? 'day' : 'days'}`;

  let db = null;          // Supabase client
  let readOnly = false;   // true when the viewer is not an admin
  const nameCache = new Map();

  // Options for the approval-rule editor's "Applies to" dropdown, loaded once
  // in loadAll(): { value, label }[] per scope.
  const lookups = { department: [], position: [], employee: [] };

  const sections = { weekly: null, monthly: null, cutoff: null, leaveTypes: [] };
  const allSections = () => [sections.weekly, sections.monthly, sections.cutoff, ...sections.leaveTypes].filter(Boolean);

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
  // Who made a change: an employee (modified_by) or an admin, which has no
  // employees row and is stored in modified_by_admin (see 06_super_admin.sql).
  const actorOf = (r) => (r && (r.modified_by || r.modified_by_admin)) || null;

  let adminNamesLoaded = false;
  async function loadAdminNames() {
    if (adminNamesLoaded) return;
    adminNamesLoaded = true;
    try {
      const { data, error } = await db.rpc('list_super_admin_names');
      if (error) throw error;
      (data || []).forEach((a) => nameCache.set(a.auth_user_id, a.name || null));
    } catch (e) {
      /* names are a nicety: the label then omits "by ..." */
    }
  }

  async function ensureNames(ids) {
    await loadAdminNames();
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
    if (!actorOf(record)) return 'Default values, not edited yet';
    const when = new Date(record.last_modified).toLocaleString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    const who = nameCache.get(actorOf(record));
    return `Last changed ${when}${who ? ` by ${who}` : ''}`;
  }

  // Most recently edited row of a set (used for the 7 weekday rows)
  function latestEdited(rows) {
    const edited = rows.filter((r) => actorOf(r));
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
        await ensureNames([actorOf(audited)]);
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
  /* Leave types  (leave_types + tiers + approval rules)                 */
  /* ------------------------------------------------------------------ */

  // leave_types (02_leaves_schema.sql): leave_type = display name,
  // leave_code = immutable short code, is_active = false means an admin
  // disabled it.
  function leaveTypeLabel(row) {
    return typeof row.leave_type === 'string' && row.leave_type.trim()
      ? row.leave_type.trim()
      : `Leave type ${row.leave_type_id}`;
  }

  function leaveTypeIsDisabled(row) {
    return row.is_active === false;
  }

  function toLeaveTypeMeta(row) {
    return {
      id: row.leave_type_id,
      label: leaveTypeLabel(row),
      code: row.leave_code || '—',
      disabled: leaveTypeIsDisabled(row),
    };
  }

  // ---- Durations: stored in months, typed in months or years -----------
  function splitMonths(months) {
    if (months == null) return { value: null, unit: 'years' };
    const m = Number(months);
    return m % 12 === 0 ? { value: m / 12, unit: 'years' } : { value: m, unit: 'months' };
  }
  const toMonths = (value, unit) => (value == null ? null : value * (unit === 'years' ? 12 : 1));
  function fmtDuration(months) {
    const { value, unit } = splitMonths(months);
    const noun = unit === 'years' ? 'year' : 'month';
    return `${fmtNum(value)} ${noun}${value === 1 ? '' : 's'}`;
  }

  // Reflects a leave type's active state in the header's status badge,
  // the item's own background (.is-disabled-type) and the status button.
  // A type is never deleted, since past leave requests keep referencing it —
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

  async function onToggleLeaveTypeActive(root, lt, onSaved) {
    const btn = $('[data-toggle-active]', root);
    if (readOnly || btn.disabled) return;
    const nextActive = lt.disabled;   // disabled -> enable; enabled -> disable
    btn.disabled = true;
    try {
      const { data, error } = await db.from('leave_types')
        .update({ is_active: nextActive })
        .eq('leave_type_id', lt.id)
        .select('leave_type_id, is_active, modified_by, modified_by_admin, last_modified');
      if (error) throw error;
      if (!data || !data.length) throw new NoRowsError();
      lt.disabled = !nextActive;
      paintLeaveTypeStatus(root, lt.disabled);
      refreshLeaveTypeListUI();
      toast(`${lt.label} ${lt.disabled ? 'disabled' : 'enabled'}.`, 'success');
      // The toggle is an edit of the same row, so its "last changed" moves too.
      if (onSaved) ensureNames([actorOf(data[0])]).then(() => onSaved(data[0]));
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

  const ELIG_SHORT = { hired_date: 'Hired date', after_probation: 'After probation' };

  function summarizeApproval(v) {
    if (!v.requiresApproval) return 'Automatic';
    const steps = (r) => [r.first && '1st', r.second && '2nd', r.hod && 'HOD'].filter(Boolean).join(' \u2192 ');
    if (!v.rules.length) return '1st';                 // the database falls back to first line
    if (v.rules.length === 1) return steps(v.rules[0]);
    return `${v.rules.length} rules`;
  }

  function renderLeaveSummary(root, v) {
    setCell(root, 'entitlement',
      v.entDays == null ? '—' : `${fmtNum(v.entDays)} ${v.entType === 'monthly' ? 'days/mo' : 'days/yr'}`, false);
    setCell(root, 'eligibility',
      v.eligType === 'after_service'
        ? (v.eligMonths ? `After ${fmtDuration(v.eligMonths)}` : '—')
        : ELIG_SHORT[v.eligType] || '—', false);
    const carry = !v.carry
      ? 'None'
      : v.expMonth
        ? `${fmtDays(v.carry)} until ${v.expDay} ${MONTHS[v.expMonth - 1]}`
        : `${fmtDays(v.carry)}, no expiry`;
    setCell(root, 'carry_forward', carry, !v.carry);
    setCell(root, 'negative', v.negOn ? `Up to ${fmtDays(v.negMax)}` : 'Not allowed', !v.negOn);
    setCell(root, 'approval', summarizeApproval(v), !v.requiresApproval);
  }

  // ---- Field validators (mirror the CHECK constraints in 02) -----------
  function positiveDaysProblem(label, value, max) {
    if (value == null || !Number.isFinite(value) || value <= 0) return `${label}: enter more than 0 days.`;
    if (value > max) return `${label} can\u2019t be more than ${max.toLocaleString('en-GB')} days.`;
    if (!oneDecimal(value)) return `${label} can have at most one decimal place.`;
    return null;
  }

  function wholeDaysProblem(label, value) {
    if (value == null || !Number.isInteger(value) || value < 1 || value > MAX_WINDOW_DAYS) {
      return `${label}: enter a whole number of days from 1 to ${MAX_WINDOW_DAYS}.`;
    }
    return null;
  }

  function durationProblem(label, months) {
    if (months == null || !Number.isInteger(months) || months < 1 || months > MAX_SMALLINT) {
      return `${label}: enter a whole number of months or years (1 or more).`;
    }
    return null;
  }

  // ---- Child-row diff sync (proration tiers, approval rules) -----------
  // Compares `next` against what was last loaded/saved (`prev`). Deletes
  // first, so a removed row can't collide with a new one on a unique
  // constraint; then updates changed rows; then inserts new ones. Server ids
  // for new rows are written back onto `next` and their DOM rows, so the
  // next read() agrees with `saved` (createSection's save() reuses this same
  // object by reference).
  async function syncChildRows({ table, leaveTypeId, prev, next, toDb, domRows, stampId }) {
    const prevById = new Map(prev.filter((r) => r.id != null).map((r) => [r.id, r]));
    const keepIds = new Set(next.filter((r) => r.id != null).map((r) => r.id));
    const toDelete = [...prevById.keys()].filter((rid) => !keepIds.has(rid));
    if (toDelete.length) {
      const { error } = await db.from(table).delete().in('id', toDelete);
      if (error) throw error;
    }
    for (let i = 0; i < next.length; i++) {
      const r = next[i];
      if (r.id != null) {
        const before = prevById.get(r.id);
        if (before && JSON.stringify(toDb(before)) !== JSON.stringify(toDb(r))) {
          const { error } = await db.from(table).update(toDb(r)).eq('id', r.id);
          if (error) throw error;
        }
      } else {
        const { data, error } = await db.from(table)
          .insert({ leave_type_id: leaveTypeId, ...toDb(r) })
          .select('id');
        if (error) throw error;
        if (!data || !data.length) throw new NoRowsError();
        r.id = data[0].id;
        if (domRows[i]) stampId(domRows[i], r.id);
      }
    }
  }

  // ---- Proration-tier row helpers (leave_type_proration_tiers) --------
  // Each row is { id, minDays, credit }; id is null for a row not yet
  // saved. Order in the DOM is the order read() returns them in, which
  // matters for the dirty-check.
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

  // ---- Approval-rule row helpers (leave_type_approval_rules) -----------
  // Each row is { id, scope, target, minDays, first, second, hod }.
  //   scope   'everyone' | 'department' | 'position' | 'employee'
  //   target  dept_id / post_id (number), employees.id (uuid), or null for 'everyone'
  const SCOPE_ORDER = { everyone: 0, department: 1, position: 2, employee: 3 };

  function fillRuleTargets(row, scope, selected) {
    const sel = $('[data-rule-field="scope_target"]', row);
    sel.textContent = '';
    if (scope === 'everyone') {
      sel.add(new Option('All employees', ''));
      sel.disabled = true;
      return;
    }
    sel.disabled = readOnly;
    sel.add(new Option(`Choose a ${scope}\u2026`, ''));
    const options = lookups[scope] || [];
    options.forEach((o) => sel.add(new Option(o.label, String(o.value))));
    // A saved rule can point at something that's now inactive, or (for a
    // non-admin) an employee this viewer isn't allowed to list.
    if (selected != null && !options.some((o) => String(o.value) === String(selected))) {
      sel.add(new Option('Not available', String(selected)));
    }
    sel.value = selected == null ? '' : String(selected);
  }

  function buildRuleRow(r) {
    const tpl = $('#ltRuleRowTemplate');
    const holder = document.createElement('div');
    holder.innerHTML = tpl.innerHTML;
    const row = holder.firstElementChild;
    if (r.id != null) row.dataset.ruleId = String(r.id);
    $('[data-rule-field="scope_type"]', row).value = r.scope;
    fillRuleTargets(row, r.scope, r.target);
    $('[data-rule-field="min_days"]', row).value = r.minDays == null ? '' : String(r.minDays);
    $('[data-rule-field="require_first_line"]', row).checked = !!r.first;
    $('[data-rule-field="require_second_line"]', row).checked = !!r.second;
    $('[data-rule-field="require_hod"]', row).checked = !!r.hod;
    $('[data-remove-rule]', row).disabled = readOnly;
    return row;
  }

  function readRuleRows(listEl) {
    return $$('.lt-rule-row', listEl).map((row) => {
      const scope = $('[data-rule-field="scope_type"]', row).value;
      const raw = $('[data-rule-field="scope_target"]', row).value;
      let target = null;
      if (scope !== 'everyone' && raw) target = scope === 'employee' ? raw : Number(raw);
      return {
        id: row.dataset.ruleId ? Number(row.dataset.ruleId) : null,
        scope,
        target,
        minDays: numOf($('[data-rule-field="min_days"]', row)),
        first: $('[data-rule-field="require_first_line"]', row).checked,
        second: $('[data-rule-field="require_second_line"]', row).checked,
        hod: $('[data-rule-field="require_hod"]', row).checked,
      };
    });
  }

  const ruleToDb = (r) => ({
    scope_type: r.scope,
    scope_employee_id: r.scope === 'employee' ? r.target : null,
    scope_post_id: r.scope === 'position' ? r.target : null,
    scope_dept_id: r.scope === 'department' ? r.target : null,
    min_days: r.minDays,
    require_first_line: r.first,
    require_second_line: r.second,
    require_hod: r.hod,
  });

  const tierToDb = (t) => ({ min_working_days: t.minDays, credit_days: t.credit });

  function ruleFromDb(x) {
    return {
      id: x.id,
      scope: x.scope_type,
      target: x.scope_type === 'employee' ? x.scope_employee_id
        : x.scope_type === 'position' ? x.scope_post_id
          : x.scope_type === 'department' ? x.scope_dept_id : null,
      minDays: Number(x.min_days),
      first: !!x.require_first_line,
      second: !!x.require_second_line,
      hod: !!x.require_hod,
    };
  }

  function initLeaveTypeSection(root, lt) {
    const f = (key) => $(`[data-field="${key}"]`, root);
    const id = lt.id;

    // Effective from
    const eligTypeSel = f('eligibility_type');
    const eligValueInp = f('eligibility_value');
    const eligUnitSel = f('eligibility_unit');
    const eligServiceField = $('[data-elig-service-field]', root);

    // Entitlement
    const entTypeSel = f('entitlement_type');
    const entDaysInp = f('entitlement_days');
    const entUnitEl = $('[data-entitlement-unit]', root);

    // Proration & partial month
    const roundingSel = f('prorate_rounding');
    const partialChk = f('use_partial_month');
    const methodSel = f('partial_month_method');
    const partialWrap = $('[data-partial-fields]', root);
    const tiersEditorWrap = $('[data-tiers-editor]', root);
    const tiersListEl = $('[data-tiers-list]', root);
    const addTierBtn = $('[data-add-tier]', root);

    // Service bonus
    const bonusChk = f('service_bonus_enabled');
    const bonusIntervalInp = f('service_bonus_interval_value');
    const bonusUnitSel = f('service_bonus_unit');
    const bonusDaysInp = f('service_bonus_days');
    const bonusWrap = $('[data-bonus-fields]', root);
    const bonusHint = $('[data-bonus-hint]', root);

    // Negative balance
    const negChk = f('allow_negative_balance');
    const negMaxInp = f('max_negative_days');
    const negWrap = $('[data-negative-fields]', root);

    // Carry forward
    const carryInp = f('max_carry_forward');
    const monthSel = f('carry_forward_expiry_month');
    const dayInp = f('carry_forward_expiry_day');

    // Booking rules
    const noticeChk = f('require_prior_notice');
    const noticeInp = f('prior_notice_days');
    const noticeWrap = $('[data-notice-fields]', root);
    const backdateChk = f('allow_backdate');
    const backdateInp = f('backdate_days');
    const backdateWrap = $('[data-backdate-fields]', root);

    // Review & approval
    const requiresApprovalChk = f('requires_approval');
    const rulesWrap = $('[data-rules-wrap]', root);
    const rulesListEl = $('[data-rules-list]', root);
    const rulesEmptyEl = $('[data-rules-empty]', root);
    const addRuleBtn = $('[data-add-rule]', root);

    const show = (el, on) => el.classList.toggle('hidden', !on);
    const toggleEligFields = () => show(eligServiceField, eligTypeSel.value === 'after_service');
    const paintEntitlementUnit = () => {
      entUnitEl.textContent = entTypeSel.value === 'monthly' ? 'days / month' : 'days / year';
    };
    function toggleProrationFields() {
      const on = partialChk.checked;
      show(partialWrap, on);
      show(tiersEditorWrap, on && methodSel.value === 'tiered');
    }
    const toggleBonusFields = () => { show(bonusWrap, bonusChk.checked); show(bonusHint, bonusChk.checked); };
    const toggleNegativeFields = () => show(negWrap, negChk.checked);
    const toggleNoticeFields = () => show(noticeWrap, noticeChk.checked);
    const toggleBackdateFields = () => show(backdateWrap, backdateChk.checked);
    const toggleRulesWrap = () => show(rulesWrap, requiresApprovalChk.checked);
    const paintRulesEmpty = () => show(rulesEmptyEl, rulesListEl.childElementCount === 0);

    // Structural row add/remove doesn't touch an <input> the section listens
    // to, so it can't reach createSection's root 'input' listener directly —
    // bump it via an existing field instead, the same way any other edit would.
    function bumpDirty() {
      carryInp.dispatchEvent(new Event('input', { bubbles: true }));
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

    addRuleBtn.addEventListener('click', () => {
      if (readOnly) return;
      // Most new rules are exceptions to the default, so start on "Department".
      const row = buildRuleRow({ id: null, scope: 'department', target: null, minDays: 0, first: true, second: false, hod: false });
      rulesListEl.appendChild(row);
      paintRulesEmpty();
      bumpDirty();
      $('[data-rule-field="scope_target"]', row).focus();
    });
    rulesListEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-remove-rule]');
      if (!btn || readOnly) return;
      btn.closest('.lt-rule-row').remove();
      paintRulesEmpty();
      bumpDirty();
    });

    return createSection({
      root,
      label: lt.label,
      fromRecord: (r) => {
        const num = (x) => (x == null ? null : Number(x));
        return {
          eligType: r.eligibility_type,
          eligMonths: r.eligibility_type === 'after_service' ? num(r.eligibility_service_months) : null,
          entType: r.entitlement_type,
          entDays: num(r.entitlement_days),
          usePartial: !!r.use_partial_month,
          partialMethod: r.partial_month_method,
          rounding: r.prorate_rounding,
          bonusOn: !!r.service_bonus_enabled,
          bonusMonths: r.service_bonus_enabled ? num(r.service_bonus_interval_months) : null,
          bonusDays: r.service_bonus_enabled ? num(r.service_bonus_days) : 0,
          negOn: !!r.allow_negative_balance,
          negMax: r.allow_negative_balance ? num(r.max_negative_days) : 0,
          carry: num(r.max_carry_forward),
          expMonth: num(r.carry_forward_expiry_month),
          expDay: num(r.carry_forward_expiry_day),
          noticeOn: !!r.require_prior_notice,
          noticeDays: r.require_prior_notice ? num(r.prior_notice_days) : null,
          backdateOn: !!r.allow_backdate,
          backdateDays: r.allow_backdate ? num(r.backdate_days) : 0,
          requiresApproval: r.requires_approval !== false,
          tiers: (r.tiers || []).map((t) => ({
            id: t.id, minDays: Number(t.min_working_days), credit: Number(t.credit_days),
          })),
          rules: (r.rules || []).map(ruleFromDb),
        };
      },
      apply: (v) => {
        eligTypeSel.value = v.eligType;
        const elig = splitMonths(v.eligMonths);
        eligValueInp.value = elig.value == null ? '' : String(elig.value);
        eligUnitSel.value = elig.unit;
        toggleEligFields();

        entTypeSel.value = v.entType;
        entDaysInp.value = v.entDays == null ? '' : String(v.entDays);
        paintEntitlementUnit();

        roundingSel.value = v.rounding;
        partialChk.checked = v.usePartial;
        methodSel.value = v.partialMethod;
        tiersListEl.innerHTML = '';
        v.tiers.forEach((t) => tiersListEl.appendChild(buildTierRow(t)));
        toggleProrationFields();

        bonusChk.checked = v.bonusOn;
        const bonus = splitMonths(v.bonusMonths);
        bonusIntervalInp.value = bonus.value == null ? '' : String(bonus.value);
        bonusUnitSel.value = bonus.unit;
        bonusDaysInp.value = v.bonusOn && v.bonusDays != null ? String(v.bonusDays) : '';
        toggleBonusFields();

        negChk.checked = v.negOn;
        negMaxInp.value = v.negOn && v.negMax != null ? String(v.negMax) : '';
        toggleNegativeFields();

        carryInp.value = v.carry == null ? '' : String(v.carry);
        monthSel.value = v.expMonth == null ? '' : String(v.expMonth);
        dayInp.value = v.expMonth == null || v.expDay == null ? '' : String(v.expDay);
        syncDay(monthSel, dayInp, false);

        noticeChk.checked = v.noticeOn;
        noticeInp.value = v.noticeOn && v.noticeDays != null ? String(v.noticeDays) : '';
        toggleNoticeFields();
        backdateChk.checked = v.backdateOn;
        backdateInp.value = v.backdateOn && v.backdateDays != null ? String(v.backdateDays) : '';
        toggleBackdateFields();

        requiresApprovalChk.checked = v.requiresApproval;
        rulesListEl.innerHTML = '';
        v.rules.forEach((r) => rulesListEl.appendChild(buildRuleRow(r)));
        paintRulesEmpty();
        toggleRulesWrap();
      },
      read: () => {
        const eligType = eligTypeSel.value;
        const expMonth = monthSel.value ? Number(monthSel.value) : null;
        const bonusOn = bonusChk.checked;
        const negOn = negChk.checked;
        const noticeOn = noticeChk.checked;
        const backdateOn = backdateChk.checked;
        return {
          eligType,
          eligMonths: eligType === 'after_service' ? toMonths(numOf(eligValueInp), eligUnitSel.value) : null,
          entType: entTypeSel.value,
          entDays: numOf(entDaysInp),
          usePartial: partialChk.checked,
          partialMethod: methodSel.value,
          rounding: roundingSel.value,
          bonusOn,
          bonusMonths: bonusOn ? toMonths(numOf(bonusIntervalInp), bonusUnitSel.value) : null,
          bonusDays: bonusOn ? numOf(bonusDaysInp) : 0,
          negOn,
          negMax: negOn ? numOf(negMaxInp) : 0,
          carry: numOf(carryInp),
          expMonth,
          expDay: expMonth ? numOf(dayInp) : null,
          noticeOn,
          noticeDays: noticeOn ? numOf(noticeInp) : null,
          backdateOn,
          backdateDays: backdateOn ? numOf(backdateInp) : 0,
          requiresApproval: requiresApprovalChk.checked,
          tiers: readTierRows(tiersListEl),
          rules: readRuleRows(rulesListEl),
        };
      },
      onEdit: (el) => {
        if (el === monthSel) syncDay(monthSel, dayInp, true);
        else if (el === eligTypeSel) toggleEligFields();
        else if (el === entTypeSel) paintEntitlementUnit();
        else if (el === partialChk || el === methodSel) toggleProrationFields();
        else if (el === bonusChk) toggleBonusFields();
        else if (el === negChk) toggleNegativeFields();
        else if (el === noticeChk) toggleNoticeFields();
        else if (el === backdateChk) toggleBackdateFields();
        else if (el === requiresApprovalChk) toggleRulesWrap();
        else if (el.matches('[data-rule-field="scope_type"]')) {
          fillRuleTargets(el.closest('.lt-rule-row'), el.value, null);
        }
      },
      validate: (v) => {
        const problems = [];
        const add = (el, msg) => { if (msg) problems.push({ el, msg }); };

        // Effective from
        if (v.eligType === 'after_service') add(eligValueInp, durationProblem('Length of service', v.eligMonths));

        // Entitlement
        if (v.entDays == null) {
          add(entDaysInp, 'Entitlement: enter a number of days (0 if none).');
        } else if (!Number.isFinite(v.entDays) || v.entDays < 0 || v.entDays > MAX_ENTITLEMENT) {
          add(entDaysInp, `Entitlement must be between 0 and ${MAX_ENTITLEMENT} days.`);
        } else if (!twoDecimals(v.entDays)) {
          add(entDaysInp, 'Entitlement can have at most two decimal places.');
        }

        // Service bonus
        if (v.bonusOn) {
          add(bonusIntervalInp, durationProblem('Service bonus interval', v.bonusMonths));
          add(bonusDaysInp, positiveDaysProblem('Service bonus days', v.bonusDays, MAX_BONUS_DAYS));
        }

        // Negative balance
        if (v.negOn) add(negMaxInp, positiveDaysProblem('Maximum negative balance', v.negMax, MAX_DAYS));

        // Carry forward
        add(carryInp, daysProblem('Maximum carried', v.carry, true));
        if (v.expMonth) {
          const msg = monthDayProblem('Lapse date', v.expMonth, v.expDay);
          if (msg) problems.push({ el: dayInp, msg });
        }

        // Booking rules
        if (v.noticeOn) add(noticeInp, wholeDaysProblem('Advance notice', v.noticeDays));
        if (v.backdateOn) add(backdateInp, wholeDaysProblem('Back-date allowance', v.backdateDays));

        // Partial-month tiers (only checked while the editor is showing, so a
        // half-filled row can't block a save from something you can't see)
        if (v.usePartial && v.partialMethod === 'tiered' && v.tiers.length) {
          const seen = new Set();
          $$('.lt-tier-row', tiersListEl).forEach((row, i) => {
            const t = v.tiers[i];
            const minEl = $('[data-tier-field="min_working_days"]', row);
            const creditEl = $('[data-tier-field="credit_days"]', row);
            if (t.minDays == null || !Number.isInteger(t.minDays) || t.minDays < 0 || t.minDays > 31) {
              problems.push({ el: minEl, msg: 'Tier: working days left must be a whole number from 0 to 31.' });
            } else if (seen.has(t.minDays)) {
              problems.push({ el: minEl, msg: 'Tier: each threshold can only be used once.' });
            } else {
              seen.add(t.minDays);
            }
            const creditMsg = daysProblem('Tier credit', t.credit, true);
            if (creditMsg) problems.push({ el: creditEl, msg: creditMsg });
          });
        }

        // Approval rules (only while approval is required)
        if (v.requiresApproval && v.rules.length) {
          const seen = new Set();
          $$('.lt-rule-row', rulesListEl).forEach((row, i) => {
            const r = v.rules[i];
            const n = i + 1;
            const targetEl = $('[data-rule-field="scope_target"]', row);
            const minEl = $('[data-rule-field="min_days"]', row);
            if (r.scope !== 'everyone' && r.target == null) {
              problems.push({ el: targetEl, msg: `Rule ${n}: choose a ${r.scope}.` });
            }
            const minMsg = daysProblem(`Rule ${n} threshold`, r.minDays, true);
            if (minMsg) problems.push({ el: minEl, msg: minMsg });
            if (!r.first && !r.second && !r.hod) {
              problems.push({ el: $('[data-rule-field="require_first_line"]', row), msg: `Rule ${n}: pick at least one approval step.` });
            }
            const key = `${r.scope}|${r.target}|${r.minDays}`;
            if (seen.has(key)) {
              problems.push({ el: minEl, msg: `Rule ${n}: another rule already covers this scope and threshold.` });
            } else {
              seen.add(key);
            }
          });
        }

        return problems;
      },
      renderSummary: (v) => renderLeaveSummary(root, v),
      save: async (v, prev) => {
        const childControls = () => [addTierBtn, addRuleBtn, ...$$('[data-remove-tier], [data-remove-rule]', root)];
        childControls().forEach((el) => { el.disabled = true; });
        try {
          // Values that don't apply while their switch is off are sent as the
          // "off" value the CHECK constraints in 02 require (null / 0).
          const patch = {
            eligibility_type: v.eligType,
            eligibility_service_months: v.eligType === 'after_service' ? v.eligMonths : null,
            entitlement_type: v.entType,
            entitlement_days: v.entDays,
            use_partial_month: v.usePartial,
            partial_month_method: v.partialMethod,
            prorate_rounding: v.rounding,
            service_bonus_enabled: v.bonusOn,
            service_bonus_interval_months: v.bonusOn ? v.bonusMonths : null,
            service_bonus_days: v.bonusOn ? v.bonusDays : 0,
            allow_negative_balance: v.negOn,
            max_negative_days: v.negOn ? v.negMax : 0,
            requires_approval: v.requiresApproval,
            max_carry_forward: v.carry,
            carry_forward_expiry_month: v.expMonth,
            carry_forward_expiry_day: v.expMonth ? v.expDay : null,
            require_prior_notice: v.noticeOn,
            prior_notice_days: v.noticeOn ? v.noticeDays : null,
            allow_backdate: v.backdateOn,
            backdate_days: v.backdateOn ? v.backdateDays : 0,
            // leave_code is deliberately absent: it can't be changed after creation.
          };
          const record = await updateOne('leave_types', LEAVE_TYPE_COLS, { leave_type_id: id }, patch);

          await syncChildRows({
            table: 'leave_type_proration_tiers',
            leaveTypeId: id,
            prev: prev.tiers || [],
            next: v.tiers,
            toDb: tierToDb,
            domRows: $$('.lt-tier-row', tiersListEl),
            stampId: (row, rid) => { row.dataset.tierId = String(rid); },
          });
          await syncChildRows({
            table: 'leave_type_approval_rules',
            leaveTypeId: id,
            prev: prev.rules || [],
            next: v.rules,
            toDb: ruleToDb,
            domRows: $$('.lt-rule-row', rulesListEl),
            stampId: (row, rid) => { row.dataset.ruleId = String(rid); },
          });

          return record;
        } finally {
          childControls().forEach((el) => { el.disabled = readOnly; });
        }
      },
    });
  }

  // Builds one .lt-item from #ltItemTemplate, wires its accordion section
  // and its enable/disable button, and loads it with its leave_types row plus
  // its tier and approval-rule rows. Shared by the initial render and by
  // onAddLeaveType() below.
  function buildLeaveTypeItem(lt, row, tierRows, ruleRows, openByDefault) {
    const tpl = $('#ltItemTemplate');
    const holder = document.createElement('div');
    holder.innerHTML = tpl.innerHTML.split('{{id}}').join(String(lt.id));
    const root = holder.firstElementChild;
    $('[data-lt-name]', root).textContent = lt.label;
    $('[data-lt-code]', root).textContent = lt.code;
    paintLeaveTypeStatus(root, lt.disabled);

    let section = null;
    const statusBtn = $('[data-toggle-active]', root);
    statusBtn.disabled = readOnly;
    statusBtn.addEventListener('click', (e) => {
      e.stopPropagation();   // sits next to the accordion toggle; don't let a click bubble into it
      onToggleLeaveTypeActive(root, lt, (rec) => { if (section) section.setAudit(rec); });
    });
    $$('select[data-month-select]', root).forEach(fillMonths);
    if (openByDefault) {
      $('.lt-toggle', root).classList.remove('collapsed');
      $('.lt-toggle', root).setAttribute('aria-expanded', 'true');
      $('.collapse', root).classList.add('show');
    }
    section = initLeaveTypeSection(root, lt);
    section.load({ ...row, tiers: tierRows || [], rules: ruleRows || [] });
    sections.leaveTypes.push(section);
    return root;
  }

  function renderLeaveTypes(items, tiersByType, rulesByType) {
    const list = $('#ltList');
    $$('.lt-item', list).forEach((el) => el.remove());
    sections.leaveTypes = [];

    items.forEach((it, index) => {
      // First item starts open, as in the design.
      list.appendChild(buildLeaveTypeItem(it.lt, it.row, tiersByType.get(it.lt.id), rulesByType.get(it.lt.id), index === 0));
    });

    $('#ltLoading').classList.add('hidden');
    list.classList.toggle('hidden', items.length === 0);
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
  // Name AND code are required, and the code is permanent: leave_code is
  // only ever sent here, on INSERT (a trigger in 02 upper-cases it and
  // rejects any later change). The database also seeds a default
  // "everyone / first line" approval rule for every new type, so it's read
  // back here rather than assumed. Unlike the enable/disable toggle (an
  // update, silently blocked by RLS for a non-admin — see NoRowsError), an
  // insert blocked by RLS's WITH CHECK comes back as a real error, so this
  // only needs errorMessage().
  const CODE_PATTERN = /^[A-Z0-9_-]{1,10}$/;

  async function onAddLeaveType() {
    const input = $('#newLeaveTypeInput');
    const codeInput = $('#newLeaveCodeInput');
    const btn = $('#addLeaveTypeBtn');
    const name = input.value.trim();
    const code = codeInput.value.trim().toUpperCase();
    input.classList.remove('is-invalid');
    codeInput.classList.remove('is-invalid');
    if (!name) {
      input.classList.add('is-invalid');
      input.focus();
      toast('Enter a name for the new leave type.', 'danger');
      return;
    }
    if (!CODE_PATTERN.test(code)) {
      codeInput.classList.add('is-invalid');
      codeInput.focus();
      toast('Enter a code of 1\u201310 letters, numbers, dashes or underscores (e.g. AL). It can\u2019t be changed later.', 'danger');
      return;
    }
    btn.disabled = true;
    try {
      const { data, error } = await db.from('leave_types')
        .insert({ leave_type: name, leave_code: code })
        .select(LEAVE_TYPE_COLS);
      if (error) throw error;
      if (!data || !data.length) throw new NoRowsError();
      const row = data[0];

      const rules = await db.from('leave_type_approval_rules').select(RULE_COLS).eq('leave_type_id', row.leave_type_id);
      if (rules.error) throw rules.error;
      const ruleRows = (rules.data || []).sort(compareRules);

      const lt = toLeaveTypeMeta(row);
      const list = $('#ltList');
      list.appendChild(buildLeaveTypeItem(lt, row, [], ruleRows, false));
      refreshLeaveTypeListUI();
      input.value = '';
      codeInput.value = '';
      toast(`"${lt.label}" (${lt.code}) added.`, 'success');
    } catch (err) {
      if (err && err.code === '23505') {
        const onCode = /leave_code/.test(err.message || '') || /leave_code/.test(err.details || '');
        (onCode ? codeInput : input).classList.add('is-invalid');
        toast(onCode ? `The code "${code}" is already used.` : `"${name}" already exists.`, 'danger');
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

  // Most general rule first (everyone), then department, position, employee;
  // within a scope, lowest threshold first. Display order only.
  function compareRules(a, b) {
    return (SCOPE_ORDER[a.scope_type] - SCOPE_ORDER[b.scope_type]) || (Number(a.min_days) - Number(b.min_days));
  }

  function groupBy(rows, key) {
    const map = new Map();
    (rows || []).forEach((r) => {
      if (!map.has(r[key])) map.set(r[key], []);
      map.get(r[key]).push(r);
    });
    return map;
  }

  async function loadAll() {
    const [settings, weekly, types, tiers, rules, positions, departments, employees] = await Promise.all([
      db.from('policy_settings').select(SETTINGS_COLS).eq('id', 1).maybeSingle(),
      db.from('policy_weekly_working_days').select(WEEKLY_COLS).order('day_of_week'),
      db.from('leave_types').select(LEAVE_TYPE_COLS).order('leave_type'),
      db.from('leave_type_proration_tiers').select(TIER_COLS),
      db.from('leave_type_approval_rules').select(RULE_COLS),
      db.from('positions').select('post_id, position').eq('is_active', true).order('position'),
      db.from('departments').select('dept_id, department').eq('is_active', true).order('department'),
      // Only the rule editor's Employee dropdown needs this. It's limited by
      // RLS for non-admins, and a failure here shouldn't stop the page loading.
      db.from('employees').select('id, name, employee_id').is('last_day', null).order('name'),
    ]);
    const failed = [settings, weekly, types, tiers, rules, positions, departments].find((r) => r.error);
    if (failed) throw failed.error;

    const weeklyRows = weekly.data || [];
    if (!settings.data || weeklyRows.length !== 7) {
      throw new Error('No policy data found. Check that 03_policies_schemas.sql has been run, or sign in again if your session expired.');
    }

    lookups.position = (positions.data || []).map((p) => ({ value: p.post_id, label: p.position }));
    lookups.department = (departments.data || []).map((d) => ({ value: d.dept_id, label: d.department }));
    lookups.employee = (employees.error ? [] : (employees.data || []))
      .map((e) => ({ value: e.id, label: `${e.name} (${e.employee_id})` }));
    (employees.error ? [] : (employees.data || [])).forEach((e) => nameCache.set(e.id, e.name || null));

    const typeRows = types.data || [];
    await ensureNames([
      actorOf(settings.data),
      ...weeklyRows.map(actorOf),
      ...typeRows.map(actorOf),
    ]);

    sections.weekly.load(weeklyRows);
    sections.monthly.load(settings.data);
    sections.cutoff.load(settings.data);

    const tiersByType = groupBy(tiers.data, 'leave_type_id');
    // Highest threshold first, matching how the rule reads ("the highest
    // threshold met") — purely a display default, not load-bearing.
    tiersByType.forEach((rows) => rows.sort((a, b) => b.min_working_days - a.min_working_days));
    const rulesByType = groupBy(rules.data, 'leave_type_id');
    rulesByType.forEach((rows) => rows.sort(compareRules));

    const items = typeRows
      .map((row) => ({ lt: toLeaveTypeMeta(row), row }))
      .sort((a, b) => a.lt.label.localeCompare(b.lt.label));
    renderLeaveTypes(items, tiersByType, rulesByType);
  }

  function applyReadOnly() {
    $('.policies-page').classList.add('is-readonly');
    $('#policiesReadOnly').classList.remove('hidden');
    // #ltSearchInput is deliberately excluded: searching/filtering the list
    // isn't an edit, so it stays usable for a read-only viewer.
    $$('#policyPanes input:not(#ltSearchInput), #policyPanes select, #policyPanes [data-toggle-active], #policyPanes [data-add-tier], #policyPanes [data-remove-tier], #policyPanes [data-add-rule], #policyPanes [data-remove-rule], #addLeaveTypeBtn')
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
    const codeInput = $('#newLeaveCodeInput');
    codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); onAddLeaveType(); }
    });
    codeInput.addEventListener('input', () => {
      codeInput.classList.remove('is-invalid');
      codeInput.value = codeInput.value.toUpperCase();   // the database upper-cases it too
    });

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

