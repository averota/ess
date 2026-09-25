/* =====================================================================
   ESS — Policies page logic (pages/policies.html)

   Reads and writes the tables from 03_policies_schemas.sql:
     policy_weekly_working_days   -> "Working week"
     policy_settings              -> "Monthly working days", "Leave year cut-off"
     leave_type_policies          -> one accordion item per leave type

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
     policy_settings       id, standard_monthly_working_days,
                           year_cutoff_month, year_cutoff_day,
                           modified_by, last_modified               (03)
     policy_weekly_working_days
                           day_of_week, day_name, working_value,
                           modified_by, last_modified               (03)
     leave_type_policies   leave_type_id, beginning_balance,
                           max_balance, backdate_days,
                           max_carry_forward, carry_forward_expiry_month,
                           carry_forward_expiry_day, modified_by,
                           last_modified                            (03)

   Note: employees is readable only by admins (or your own row), so the
   "by <name>" part of "Last changed" only appears for admins.
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

  // Column lists — exactly the columns in 03_policies_schemas.sql.
  const SETTINGS_COLS = 'id, standard_monthly_working_days, year_cutoff_month, year_cutoff_day, modified_by, last_modified';
  const WEEKLY_COLS = 'day_of_week, day_name, working_value, modified_by, last_modified';
  const LEAVE_POLICY_COLS = 'leave_type_id, beginning_balance, max_balance, backdate_days, max_carry_forward, '
    + 'carry_forward_expiry_month, carry_forward_expiry_day, modified_by, last_modified';

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
    carry_forward_expiry_month: null, carry_forward_expiry_day: null, modified_by: null,
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

  // Reflects a leave type's active state in both the header flag and the
  // status button. Same enable-disable-not-delete pattern this replaces
  // from leaves.js: a type is never deleted, since past leave requests
  // keep referencing it — disabling it only hides it from new requests
  // (see leaves.js's activeLeaveTypes filter).
  function paintLeaveTypeStatus(root, disabled) {
    const nameEl = $('.lt-name', root);
    let tag = $('.policy-flag--muted', nameEl);
    if (disabled && !tag) {
      tag = document.createElement('span');
      tag.className = 'policy-flag policy-flag--muted';
      tag.textContent = 'Disabled';
      nameEl.appendChild(tag);
    } else if (!disabled && tag) {
      tag.remove();
    }
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
    span.closest('.lt-cell').classList.toggle('is-muted', !!muted);
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

  function initLeaveTypeSection(root, lt) {
    const f = (key) => $(`[data-field="${key}"]`, root);
    const monthSel = f('carry_forward_expiry_month');
    const dayInp = f('carry_forward_expiry_day');
    const id = lt.id;

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
      },
      read: () => {
        const expMonth = monthSel.value ? Number(monthSel.value) : null;
        return {
          beginning: numOf(f('beginning_balance')),
          max: numOf(f('max_balance')),
          backdate: numOf(f('backdate_days')),
          carry: numOf(f('max_carry_forward')),
          expMonth,
          expDay: expMonth ? numOf(dayInp) : null,
        };
      },
      onEdit: (el) => { if (el === monthSel) syncDay(monthSel, dayInp, true); },
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
        return problems;
      },
      renderSummary: (v) => renderLeaveSummary(root, v),
      save: async (v) => {
        const patch = {
          beginning_balance: v.beginning,
          max_balance: v.max,
          backdate_days: v.backdate,
          max_carry_forward: v.carry,
          carry_forward_expiry_month: v.expMonth,
          carry_forward_expiry_day: v.expMonth ? v.expDay : null,
        };
        const upd = await db.from('leave_type_policies').update(patch).eq('leave_type_id', id).select(LEAVE_POLICY_COLS);
        if (upd.error) throw upd.error;
        if (upd.data && upd.data.length) return upd.data[0];
        // No row yet (normally created by trigger/seed): create it. For a
        // non-admin this is blocked by RLS, which surfaces as a permission error.
        const ins = await db.from('leave_type_policies').insert({ leave_type_id: id, ...patch }).select(LEAVE_POLICY_COLS);
        if (ins.error) throw ins.error;
        if (!ins.data || !ins.data.length) throw new NoRowsError();
        return ins.data[0];
      },
    });
  }

  // Builds one .lt-item from #ltItemTemplate, wires its accordion section
  // and its enable/disable button, and loads it with a policy row (or
  // null, for a brand-new leave type that has no policy yet). Shared by
  // the initial render and by onAddLeaveType() below.
  function buildLeaveTypeItem(lt, policyRow, openByDefault) {
    const tpl = $('#ltItemTemplate');
    const holder = document.createElement('div');
    holder.innerHTML = tpl.innerHTML.split('{{id}}').join(String(lt.id));
    const root = holder.firstElementChild;
    $('[data-lt-name]', root).textContent = lt.label;
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
    section.load(policyRow || null);
    sections.leaveTypes.push(section);
    return root;
  }

  function renderLeaveTypes(types, policies) {
    const list = $('#ltList');
    $$('.lt-item', list).forEach((el) => el.remove());
    sections.leaveTypes = [];

    types.forEach((lt, index) => {
      // First item starts open, as in the design.
      list.appendChild(buildLeaveTypeItem(lt, policies.get(lt.id), index === 0));
    });

    $('#ltLoading').classList.add('hidden');
    list.classList.toggle('hidden', types.length === 0);
    $('#leaveTypesEmpty').classList.toggle('hidden', types.length !== 0);
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
      list.appendChild(buildLeaveTypeItem(lt, null, false));
      list.classList.remove('hidden');
      $('#leaveTypesEmpty').classList.add('hidden');
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
    const [settings, weekly, types, policies] = await Promise.all([
      db.from('policy_settings').select(SETTINGS_COLS).eq('id', 1).maybeSingle(),
      db.from('policy_weekly_working_days').select(WEEKLY_COLS).order('day_of_week'),
      db.from('leave_types').select('leave_type_id, leave_type, is_active').order('leave_type'),
      db.from('leave_type_policies').select(LEAVE_POLICY_COLS),
    ]);
    const failed = [settings, weekly, types, policies].find((r) => r.error);
    if (failed) throw failed.error;

    const weeklyRows = weekly.data || [];
    if (!settings.data || weeklyRows.length !== 7) {
      throw new Error('No policy data found. Check that 03_policies_schemas.sql has been run, or sign in again if your session expired.');
    }

    const policyRows = policies.data || [];
    await ensureNames([
      settings.data.modified_by,
      ...weeklyRows.map((r) => r.modified_by),
      ...policyRows.map((r) => r.modified_by),
    ]);

    sections.weekly.load(weeklyRows);
    sections.monthly.load(settings.data);
    sections.cutoff.load(settings.data);

    const leaveTypes = (types.data || [])
      .map((row) => ({
        id: row.leave_type_id,
        label: leaveTypeLabel(row),
        disabled: leaveTypeIsDisabled(row),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
    renderLeaveTypes(leaveTypes, new Map(policyRows.map((r) => [r.leave_type_id, r])));
  }

  function applyReadOnly() {
    $('.policies-page').classList.add('is-readonly');
    $('#policiesReadOnly').classList.remove('hidden');
    $$('#policyPanes input, #policyPanes select, #policyPanes [data-toggle-active], #addLeaveTypeBtn').forEach((el) => { el.disabled = true; });
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
