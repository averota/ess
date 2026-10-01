-- =====================================================================
-- Employee Leave Management System — Leave Balance Ledger
-- Target: Supabase (PostgreSQL), public schema
--
-- SINGLE balance-ledger file. Replaces the earlier 04 and 05 drafts
-- (05_leave_balance_ledger.sql is retired — do NOT run it).
--
-- Fresh setup:  run 01, 02, 03, then this file.
-- Existing DB:  just re-run this file. Fully idempotent: it drops the
--   objects from earlier versions whose signatures changed, recreates
--   them, and re-applies grants. leave_balance_adjustments and its rows
--   are kept as they are.
--
-- Reused, NOT redefined here:
--   01: employees, current_employee_uuid(), is_admin(), track_audit_columns()
--   02: leave_types, leave_type_proration_tiers, leave_requests,
--       is_supervisor_of(), is_second_line_of(), is_hod_of(),
--       can_request_leave_for(), is_employee_eligible_for_leave_type()
--   03: policy_settings, policy_weekly_working_days
--
-- =====================================================================
-- HOW BALANCES WORK
-- =====================================================================
-- Nothing is snapshotted. Every balance is computed on read from
-- leave_types (02), leave_requests (02), policy_* (03) and the ledger
-- table below, so it can never go stale when the date rolls over or an
-- admin edits a policy. (The old 05 snapshot table was dropped for that
-- reason: ytd depends on today's date, so a stored row was wrong the
-- next day.)
--
-- Leave cycle = the company-wide leave year ending on
-- policy_settings.year_cutoff_month/day (03). Per employee + leave type:
--   ytd_balance       entitlement earned up to TODAY + carry-forward
--                     still valid today + adjustments - approved leave
--                     starting on/before today
--   ye_balance        the same projected to the END of the cycle (or the
--                     employee's last day if earlier), counting ALL
--                     approved leave in the cycle
--   available_balance ye_balance minus pending requests. This is what a
--                     new request is checked against.
--
-- RULES FOLLOWED FROM 02 / 03
--   Entitlement (02): entitlement_type 'annual' = days/year, granted up
--     front for the cycle (trimmed only by hire/last day), so ytd = ye.
--     EXCEPTION — fixed-duration types (fixed_duration_days set, e.g.
--     Maternity Leave = 90 days/year): a flat block, never prorated for
--     hire/last day and no service bonus; the full entitlement_days is
--     granted whenever the employee is employed in the cycle.
--     'monthly' = days/month, accrued: a fully-elapsed month is credited
--     in full; the CURRENT in-progress month (employee still covering it,
--     month not yet over) is credited proportionally via the leave
--     type's own use_partial_month / partial_month_method (same rule
--     used for a partial hire/leave month — see Partial month below), so
--     ytd still < ye mid-cycle but no longer sits at 0 for the open month.
--     Whole calculation is gated by eligibility_type at the as-of date.
--   Eligibility (02): eligibility_type / eligibility_service_months are
--     ENFORCED at request time — trg_leave_requests_enforce_balance
--     rejects a request whose start_date is before the employee is
--     eligible for that leave type (is_employee_eligible_for_leave_type
--     evaluated as of start_date, so leave can be booked ahead for a
--     date after probation / the service period ends). Admins bypass it.
--   Partial month (02): use_partial_month credits a partial HIRE or
--     LEAVE month, per partial_month_method: 'daily_prorate' = monthly
--     rate x working days covered / policy_settings
--     .standard_monthly_working_days (03), capped at 1; 'tiered' = the
--     leave_type_proration_tiers row with the highest min_working_days
--     met, none = 0. Working days follow policy_weekly_working_days (03).
--     Months are aligned to the cycle start, so a mid-month cut-off works.
--   Rounding (02): prorate_rounding applies to the prorated subtotal
--     (after division noise is rounded off at 8 dp, so a full-year 7.0
--     can't come out as 6.5).
--   Service bonus (02): tiered, but resets every cycle rather than
--     accumulating since hire. Total tenure decides the current tier
--     (0 for the first service_bonus_interval_months block, 1 for the
--     second, 2 for the third...); that tier's annual rate (tier x
--     service_bonus_days) is earned FRESH each cycle, prorated across
--     only that cycle's fully-completed months (the current
--     in-progress month is NOT bonus-prorated, unlike the base
--     entitlement — only "completed" months count). Rounded per
--     prorate_rounding on its own, THEN added on top of the (already
--     independently rounded) monthly-accrual subtotal — the two are
--     never rounded together.
--   Carry forward (02): carried in from the previous cycle's closing
--     (ye) balance, floored at 0 and capped at max_carry_forward.
--     A 'carry_forward' posting in the ledger overrides the calculated
--     amount for that cycle; an 'opening_balance' posting for a cycle
--     suppresses auto carry-forward for that cycle (migrated staff).
--   Carry-forward expiry (02): leave taken/booked on or before
--     carry_forward_expiry_month/day consumes the carried days first;
--     whatever is still UNUSED after that date is forfeited (today for
--     ytd, cycle end for ye). The expiry day itself is still usable.
--     Nothing is mutated; forfeiture is computed on read.
--   Request <= available: trigger trg_leave_requests_enforce_balance
--     rejects a new/edited request whose days exceed the available
--     balance (pending requests of the same type reserved, this request
--     included) — i.e. the balance may never go below 0. Evaluated for
--     the cycle containing the request's start_date. Applies to EVERYONE,
--     admins included (only the eligibility check below is admin-exempt).
--     leave_types.allow_negative_balance / max_negative_days are NOT
--     used by this check any more.
--     MONTHLY-entitlement types: the request must not exceed the balance
--     TO DATE — entitlement accrued up to today (entitlement_ytd) +
--     carry-forward + adjustments - ALL approved and pending leave of the
--     cycle (so pending / future-dated leave already reserves days).
--     Same as available_balance minus the not-yet-accrued part of the
--     cycle's entitlement (entitlement_ye - entitlement_ytd). For annual
--     types that part is 0, so nothing changes for them.
--   No-entitlement types (03): leave types with entitlement_days = 0 are
--     skipped by the balance check — 03's own request cap owns them.
--     (Eligibility above still applies to them.)
--   Filing for colleagues (02): the check uses the ungated internal
--     function, so any same-department colleague can file for another
--     employee. get_leave_balance() itself is readable by self, anyone
--     who can file for that employee, first/second line, HOD and admin.
--
-- KNOWN LIMITS
--   - A request spanning two cycles counts fully in the cycle of its
--     start_date (same as 03).
--   - Ledger postings are keyed by cycle_start_date; if the cut-off
--     date in 03 is changed, existing postings keep their old key.
--   - Entitlement is gated by eligibility at the cycle END (ye) and at
--     today (ytd) with no blending inside a cycle: an employee who
--     becomes eligible mid-cycle shows the cycle's full entitlement,
--     while requests are still blocked until their eligibility date.
-- =====================================================================


-- ---------------------------------------------------------------------
-- Clean-up for existing DBs (objects whose signatures changed).
-- ---------------------------------------------------------------------
drop trigger  if exists trg_leave_requests_enforce_balance on public.leave_requests;
drop function if exists public.enforce_leave_balance_before_submit();
drop function if exists public.list_leave_balances();
drop function if exists public.get_leave_balance(uuid, integer);
drop function if exists public.get_leave_balance(uuid, integer, date);
drop function if exists public.calculate_leave_balance_raw(uuid, integer);
drop function if exists public.calculate_leave_balance_raw(uuid, integer, date, uuid, numeric, date);
drop function if exists public.get_leave_cycle_bounds(date);
drop function if exists public.apply_prorate_rounding(numeric, text);


-- ---------------------------------------------------------------------
-- Ledger: carry-forward overrides, opening balances, manual corrections.
-- Everything else is computed, not stored.
-- ---------------------------------------------------------------------
create table if not exists public.leave_balance_adjustments (
    id                 bigserial primary key,
    employee_id        uuid not null references public.employees (id) on delete cascade,
    leave_type_id      integer not null references public.leave_types (leave_type_id) on delete cascade,
    cycle_start_date   date not null,             -- leave cycle this posting belongs to (first day of the cycle)
    adjustment_type    text not null,              -- 'carry_forward' | 'opening_balance' | 'manual'
    amount             numeric(7,2) not null,      -- signed: positive credits, negative debits
    reason             text,
    modified_by        uuid references public.employees (id),
    last_modified      timestamptz not null default now(),
    created_at         timestamptz not null default now(),
    constraint leave_balance_adjustments_type_check check (
        adjustment_type in ('carry_forward', 'opening_balance', 'manual')
    ),
    constraint leave_balance_adjustments_amount_check check (
        adjustment_type = 'manual' or amount >= 0
    )
);

-- At most one carry_forward and one opening_balance per employee/type/cycle.
create unique index if not exists idx_leave_balance_adjustments_one_per_cycle
    on public.leave_balance_adjustments (employee_id, leave_type_id, cycle_start_date, adjustment_type)
    where adjustment_type in ('carry_forward', 'opening_balance');

create index if not exists idx_leave_balance_adjustments_employee_type on public.leave_balance_adjustments (employee_id, leave_type_id);
create index if not exists idx_leave_balance_adjustments_cycle_start   on public.leave_balance_adjustments (cycle_start_date);
create index if not exists idx_leave_balance_adjustments_modified_by   on public.leave_balance_adjustments (modified_by);

-- Speeds up the per-employee/type lookups the balance functions and the
-- submit trigger run against leave_requests.
create index if not exists idx_leave_requests_balance_lookup
    on public.leave_requests (employee_id, leave_type_id, status, start_date);

-- A 'carry_forward' posting can never exceed leave_types.max_carry_forward.
create or replace function public.enforce_leave_balance_adjustment_caps()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
    v_max_carry_forward numeric;
begin
    if new.adjustment_type = 'carry_forward' then
        select lt.max_carry_forward into v_max_carry_forward
        from public.leave_types lt
        where lt.leave_type_id = new.leave_type_id;

        if v_max_carry_forward is not null and new.amount > v_max_carry_forward then
            raise exception 'Carry-forward amount (%) exceeds this leave type''s max_carry_forward (%)',
                new.amount, v_max_carry_forward;
        end if;
    end if;
    return new;
end;
$$;

drop trigger if exists trg_leave_balance_adjustments_enforce_cap on public.leave_balance_adjustments;
create trigger trg_leave_balance_adjustments_enforce_cap
    before insert or update on public.leave_balance_adjustments
    for each row
    execute function public.enforce_leave_balance_adjustment_caps();

drop trigger if exists trg_leave_balance_adjustments_audit on public.leave_balance_adjustments;
create trigger trg_leave_balance_adjustments_audit
    before insert or update on public.leave_balance_adjustments
    for each row
    execute function public.track_audit_columns();


-- ---------------------------------------------------------------------
-- Helper: working days (per policy_weekly_working_days, 03) in
-- [p_start, p_end] inclusive.
-- ---------------------------------------------------------------------
create or replace function public.count_working_days(p_start date, p_end date)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
    select coalesce(sum(w.working_value), 0)
    from generate_series(p_start, p_end, interval '1 day') as d(leave_day)
    join public.policy_weekly_working_days w
      on w.day_of_week = extract(isodow from d.leave_day)::smallint;
$$;


-- ---------------------------------------------------------------------
-- Helper: the leave cycle containing p_as_of, per
-- policy_settings.year_cutoff_month/day (03). Same arithmetic as 03's
-- request cap (falls back to 31-Dec if the settings row is missing).
--   cut-off 31-Dec -> 1-Jan..31-Dec;  cut-off 30-Jun -> 1-Jul..30-Jun
-- ---------------------------------------------------------------------
create function public.get_leave_cycle_bounds(
    p_as_of date default current_date,
    out cycle_start date,
    out cycle_end   date
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_month smallint;
    v_day   smallint;
    v_year  integer;
begin
    select s.year_cutoff_month, s.year_cutoff_day
      into v_month, v_day
    from public.policy_settings s
    where s.id = 1;

    v_month := coalesce(v_month, 12);
    v_day   := coalesce(v_day, 31);
    v_year  := extract(year from p_as_of)::integer;

    if p_as_of > make_date(v_year, v_month, v_day) then
        v_year := v_year + 1;
    end if;

    cycle_end   := make_date(v_year, v_month, v_day);
    cycle_start := make_date(v_year - 1, v_month, v_day) + 1;
end;
$$;


-- ---------------------------------------------------------------------
-- Helper: last usable day of carry-forward posted into the cycle that
-- starts on p_cycle_start — the first occurrence of the leave type's
-- carry_forward_expiry_month/day on or after that date. NULL = the
-- leave type has no expiry (never lapses).
-- ---------------------------------------------------------------------
create or replace function public.get_carry_forward_expiry_date(
    p_cycle_start   date,
    p_leave_type_id integer
)
returns date
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_month     smallint;
    v_day       smallint;
    v_candidate date;
begin
    select lt.carry_forward_expiry_month, lt.carry_forward_expiry_day
      into v_month, v_day
    from public.leave_types lt
    where lt.leave_type_id = p_leave_type_id;

    if v_month is null then
        return null;
    end if;

    v_candidate := make_date(extract(year from p_cycle_start)::int, v_month, v_day);
    if v_candidate < p_cycle_start then
        v_candidate := make_date(extract(year from p_cycle_start)::int + 1, v_month, v_day);
    end if;

    return v_candidate;
end;
$$;


-- ---------------------------------------------------------------------
-- Helper: apply a leave_types.prorate_rounding rule to one value.
-- Strips division noise (round to 8dp) before applying the rule so a
-- true x.0/x.5 step can't be missed by float-style rounding artifacts.
-- Shared by every value calculate_leave_entitlement_earned rounds
-- (monthly-accrual subtotal, service bonus) so the rule lives in one
-- place.
-- ---------------------------------------------------------------------
create or replace function public.apply_prorate_rounding(
    p_value    numeric,
    p_rounding text
)
returns numeric
language sql
immutable
set search_path = ''
as $$
    select case p_rounding
        when 'round_down_whole' then floor(round(p_value, 8))
        when 'round_down_half'  then floor(round(p_value, 8) * 2) / 2
        else round(round(p_value, 8), 2)         -- 'exact'
    end;
$$;


-- ---------------------------------------------------------------------
-- Entitlement earned for one leave type over one cycle window.
--   p_from    first day of the window (already >= hired_date and >= cycle
--             start; the caller decides)
--   p_through accrual cut-off. A cycle-aligned month earns its full rate
--             once the employee's coverage of it has ended on/before
--             p_through (i.e. the month is complete, or they left).
--             A month still in progress as of p_through (employee
--             currently covering it, month not yet over) is credited
--             proportionally, same as a partial hire/leave month.
--             Pass the employee's cycle end for annual types (every
--             month is then either fully elapsed or not started).
-- Months are aligned to the cycle start (month k = cycle_start + k
-- months), so a mid-month cut-off still yields twelve whole months.
-- Any month only partially covered — because of hire date, last day, or
-- p_through falling inside it — is credited only if use_partial_month
-- (see header for the methods); otherwise it earns 0 for that month.
-- Service bonus resets each cycle: current tier's annual rate x this
-- cycle's fully-completed months / 12, evaluated at p_through.
-- ---------------------------------------------------------------------
create or replace function public.calculate_leave_entitlement_earned(
    p_employee_id   uuid,
    p_leave_type_id integer,
    p_from          date,
    p_through       date
)
returns numeric(7,2)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    lt           public.leave_types%rowtype;
    v_hired      date;
    v_last_day   date;
    v_cs         date;
    v_ce         date;
    v_emp_end    date;
    v_std_wd     numeric;
    v_rate       numeric;
    v_den        numeric;
    v_ms         date;
    v_me         date;
    v_cov_start  date;
    v_cov_end    date;
    v_wd         numeric;
    v_tier       numeric;
    v_subtotal   numeric := 0;
    v_bonus      numeric := 0;
    v_age        interval;
    v_months     integer;
    v_bonus_tier          integer;
    v_bonus_closed_months integer := 0;
    k            integer;
begin
    if p_from is null or p_through is null or p_through < p_from then
        return 0;
    end if;

    select * into lt from public.leave_types where leave_type_id = p_leave_type_id;
    if not found then
        return 0;
    end if;

    select e.hired_date, e.last_day into v_hired, v_last_day
    from public.employees e
    where e.id = p_employee_id;
    if v_hired is null then
        return 0;
    end if;

    -- Fixed-duration annual types (e.g. Maternity = 90 days/year): flat
    -- entitlement, no hire/last-day proration, no service bonus.
    if lt.fixed_duration_days is not null and lt.entitlement_type = 'annual' then
        return lt.entitlement_days;
    end if;

    select gc.cycle_start, gc.cycle_end into v_cs, v_ce
    from public.get_leave_cycle_bounds(p_from) gc;

    v_emp_end := least(coalesce(v_last_day, v_ce), v_ce);
    v_rate    := case when lt.entitlement_type = 'monthly'
                      then lt.entitlement_days
                      else lt.entitlement_days / 12.0
                 end;

    select s.standard_monthly_working_days into v_std_wd
    from public.policy_settings s
    where s.id = 1;

    for k in 0..11 loop
        v_ms := (v_cs + make_interval(months => k))::date;
        v_me := case when k = 11
                     then v_ce
                     else least(((v_cs + make_interval(months => k + 1))::date - 1), v_ce)
                end;

        v_cov_start := greatest(v_ms, p_from);
        v_cov_end   := least(v_me, v_emp_end);

        continue when v_cov_start > v_cov_end;   -- not employed in this month
        continue when v_cov_start > p_through;   -- nothing earned yet this month

        -- Cap coverage to what has actually elapsed as of p_through. For a
        -- fully-closed month this equals v_cov_end unchanged (no behavior
        -- change). For the CURRENT in-progress month (still employed,
        -- month not yet over), this trims v_cov_end down to p_through so
        -- the month is credited proportionally instead of being skipped
        -- with 0 until it closes.
        v_cov_end := least(v_cov_end, p_through);

        if v_cov_start = v_ms and v_cov_end = v_me then
            v_subtotal := v_subtotal + v_rate;   -- whole month, fully elapsed
            v_bonus_closed_months := v_bonus_closed_months + 1;
        elsif lt.use_partial_month then
            v_wd := public.count_working_days(v_cov_start, v_cov_end);

            if lt.partial_month_method = 'tiered' then
                select t.credit_days into v_tier
                from public.leave_type_proration_tiers t
                where t.leave_type_id = lt.leave_type_id
                  and t.min_working_days <= v_wd
                order by t.min_working_days desc
                limit 1;
                v_subtotal := v_subtotal + coalesce(v_tier, 0);
            else -- 'daily_prorate'
                v_den := coalesce(nullif(v_std_wd, 0), public.count_working_days(v_ms, v_me));
                if v_den > 0 then
                    v_subtotal := v_subtotal + v_rate * least(1, v_wd / v_den);
                end if;
            end if;
        end if;
        -- else: partial coverage and use_partial_month = false -> earns 0
    end loop;

    -- Monthly credits are divisions (entitlement_days / 12, rate x working
    -- days / standard days) that are not exact for most values, so noise
    -- gets stripped inside apply_prorate_rounding before the policy runs.
    v_subtotal := public.apply_prorate_rounding(v_subtotal, lt.prorate_rounding);

    if lt.service_bonus_enabled then
        v_age    := age(p_through, v_hired);
        v_months := extract(year from v_age)::int * 12 + extract(month from v_age)::int;

        -- Tiered, PER-CYCLE bonus: the employee's total tenure decides
        -- which tier they're currently in (v_bonus_tier = number of
        -- FULLY completed service_bonus_interval_months blocks — 0 for
        -- the first block, 1 for the second, 2 for the third, ...), and
        -- that tier's annual rate (v_bonus_tier x service_bonus_days) is
        -- earned fresh EVERY cycle, monthly-prorated across only THIS
        -- cycle's fully-completed months (v_bonus_closed_months, counted
        -- in the loop above) — same "for every completed month" wording
        -- as the spec, and it never carries a balance across cycles.
        -- Example (service_bonus_days=1, service_bonus_interval_months=36):
        --   tenure months 1-36  (tier 0): 0 bonus, every cycle
        --   tenure months 37-72 (tier 1): 1 day/year, i.e. closed_months/12
        --                                 per cycle (= 1.0 for a full year)
        --   tenure months 73-108 (tier 2): 2 days/year, closed_months x 2/12
        -- The current in-progress month is deliberately NOT prorated into
        -- the bonus (unlike the base entitlement) — only fully completed
        -- cycle months count, per the "completed month" wording.
        v_bonus_tier := v_months / lt.service_bonus_interval_months;   -- integer division
        v_bonus := v_bonus_closed_months::numeric * v_bonus_tier * lt.service_bonus_days / 12;

        -- Bonus is rounded per policy on its OWN, before it's added to
        -- the (already-rounded) monthly entitlement subtotal — not
        -- rounded together with it.
        v_bonus := public.apply_prorate_rounding(v_bonus, lt.prorate_rounding);
    end if;

    return v_subtotal + v_bonus;
end;
$$;


-- ---------------------------------------------------------------------
-- Carry-forward days coming INTO the cycle starting p_cycle_start.
--   1. a 'carry_forward' ledger posting for that cycle wins;
--   2. else 0 if max_carry_forward = 0 or the cycle has an
--      'opening_balance' posting;
--   3. else the previous cycle's closing (ye) balance, floored at 0 and
--      capped at max_carry_forward. Recursion stops at the cycle that
--      contains the hire date.
-- ---------------------------------------------------------------------
create or replace function public.calculate_carry_forward_in(
    p_employee_id   uuid,
    p_leave_type_id integer,
    p_cycle_start   date
)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_posted      numeric;
    v_has_opening boolean;
    v_max         numeric;
    v_hired       date;
    v_prev_end    date;
    v_prev        numeric;
begin
    select sum(a.amount) filter (where a.adjustment_type = 'carry_forward'),
           coalesce(bool_or(a.adjustment_type = 'opening_balance'), false)
      into v_posted, v_has_opening
    from public.leave_balance_adjustments a
    where a.employee_id      = p_employee_id
      and a.leave_type_id    = p_leave_type_id
      and a.cycle_start_date = p_cycle_start
      and a.adjustment_type in ('carry_forward', 'opening_balance');

    if v_posted is not null then
        return v_posted;
    end if;

    select lt.max_carry_forward into v_max
    from public.leave_types lt
    where lt.leave_type_id = p_leave_type_id;

    if coalesce(v_max, 0) <= 0 or v_has_opening then
        return 0;
    end if;

    select e.hired_date into v_hired
    from public.employees e
    where e.id = p_employee_id;

    v_prev_end := p_cycle_start - 1;
    if v_hired is null or v_prev_end < v_hired then
        return 0;
    end if;

    select b.ye_balance into v_prev
    from public.calculate_leave_balance_raw(p_employee_id, p_leave_type_id, v_prev_end) b;

    return least(v_max, greatest(coalesce(v_prev, 0), 0));
end;
$$;


-- ---------------------------------------------------------------------
-- Raw balance computation — NO authorization check, internal only
-- (never granted to `authenticated`, see GRANTS). Wrapped by
-- get_leave_balance() (viewing rights) and called directly by the
-- submit trigger and list_leave_balances().
--
-- VOLATILE on purpose (like 03's leave_cap_usage): every query gets a
-- fresh snapshot, so the trigger sees requests committed by a
-- concurrent transaction while it waited on the advisory lock.
--
--   p_as_of               picks the cycle (defaults to today's)
--   p_exclude_request_id  ignore this request when counting pending
--                         (editing a still-pending request)
--   p_extra_days /
--   p_extra_start         a hypothetical request counted as pending —
--                         how the trigger checks a request that isn't
--                         in the table yet
--
-- carry_forward_forfeited_*: unused carried days lost because the
-- expiry date has passed as of today (ytd) / cycle end (ye).
-- available_balance also counts pending leave dated on/before expiry as
-- consuming the carry-forward, so a request isn't refused for days that
-- pending leave will use before they lapse.
-- ---------------------------------------------------------------------
create function public.calculate_leave_balance_raw(
    p_employee_id        uuid,
    p_leave_type_id      integer,
    p_as_of              date    default current_date,
    p_exclude_request_id uuid    default null,
    p_extra_days         numeric default 0,
    p_extra_start        date    default null,
    out cycle_start                  date,
    out cycle_end                    date,
    out effective_from               date,
    out entitlement_ytd              numeric(7,2),
    out entitlement_ye               numeric(7,2),
    out carry_forward_in             numeric(7,2),
    out carry_forward_forfeited_ytd  numeric(7,2),
    out carry_forward_forfeited_ye   numeric(7,2),
    out adjustments                  numeric(7,2),
    out used_ytd                     numeric(7,2),
    out used_ye                      numeric(7,2),
    out pending_days                 numeric(7,2),
    out ytd_balance                  numeric(7,2),
    out ye_balance                   numeric(7,2),
    out available_balance            numeric(7,2)
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_emp           public.employees%rowtype;
    v_lt            public.leave_types%rowtype;
    v_cs            date;
    v_ce            date;
    v_emp_start     date;
    v_emp_end       date;
    v_ytd_through   date;
    v_ent_ytd       numeric := 0;
    v_ent_ye        numeric := 0;
    v_carry         numeric := 0;
    v_expiry        date;
    v_cf_end        date;
    v_used_exp      numeric := 0;
    v_pend_exp      numeric := 0;
    v_extra_exp     numeric := 0;
    v_forfeit_ytd   numeric := 0;
    v_forfeit_ye    numeric := 0;
    v_forfeit_avail numeric := 0;
    v_adj           numeric := 0;
    v_used_ytd      numeric := 0;
    v_used_ye       numeric := 0;
    v_pending       numeric := 0;
begin
    select * into v_emp from public.employees where id = p_employee_id;
    if not found then
        raise exception 'Employee not found';
    end if;

    select * into v_lt from public.leave_types where leave_type_id = p_leave_type_id;
    if not found then
        raise exception 'Leave type not found';
    end if;

    select gc.cycle_start, gc.cycle_end into v_cs, v_ce
    from public.get_leave_cycle_bounds(coalesce(p_as_of, current_date)) gc;

    v_emp_start   := greatest(v_emp.hired_date, v_cs);
    v_emp_end     := least(coalesce(v_emp.last_day, v_ce), v_ce);
    v_ytd_through := least(current_date, v_emp_end);

    -- Entitlement -----------------------------------------------------
    if v_emp_start <= v_emp_end then
        if coalesce(public.is_employee_eligible_for_leave_type(p_employee_id, p_leave_type_id, v_emp_end), false) then
            v_ent_ye := public.calculate_leave_entitlement_earned(p_employee_id, p_leave_type_id, v_emp_start, v_emp_end);
        end if;

        if v_ytd_through >= v_emp_start
           and coalesce(public.is_employee_eligible_for_leave_type(p_employee_id, p_leave_type_id, v_ytd_through), false)
        then
            if v_lt.entitlement_type = 'monthly' then
                v_ent_ytd := public.calculate_leave_entitlement_earned(p_employee_id, p_leave_type_id, v_emp_start, v_ytd_through);
            else
                v_ent_ytd := v_ent_ye;   -- annual: granted up front for the cycle
            end if;
        end if;
    end if;

    -- Carry-forward in, and forfeiture of the unused part after expiry --
    v_carry  := public.calculate_carry_forward_in(p_employee_id, p_leave_type_id, v_cs);
    v_expiry := public.get_carry_forward_expiry_date(v_cs, p_leave_type_id);

    if v_carry > 0 and v_expiry is not null then
        v_cf_end := least(v_expiry, v_ce);

        select coalesce(sum(lr.total_days) filter (where lr.status = 1), 0),
               coalesce(sum(lr.total_days) filter (where lr.status = 0), 0)
          into v_used_exp, v_pend_exp
        from public.leave_requests lr
        where lr.employee_id   = p_employee_id
          and lr.leave_type_id = p_leave_type_id
          and lr.status in (0, 1)
          and lr.start_date between v_cs and v_cf_end
          and (p_exclude_request_id is null or lr.id <> p_exclude_request_id);

        if coalesce(p_extra_days, 0) > 0 and p_extra_start between v_cs and v_cf_end then
            v_extra_exp := p_extra_days;
        end if;

        if v_ytd_through > v_expiry then
            v_forfeit_ytd := v_carry - least(v_carry, v_used_exp);
        end if;
        if v_emp_end > v_expiry then
            v_forfeit_ye    := v_carry - least(v_carry, v_used_exp);
            v_forfeit_avail := v_carry - least(v_carry, v_used_exp + v_pend_exp + v_extra_exp);
        end if;
    end if;

    -- Opening balance + manual corrections (never lapse) ----------------
    select coalesce(sum(a.amount) filter (where a.adjustment_type in ('opening_balance', 'manual')), 0)
      into v_adj
    from public.leave_balance_adjustments a
    where a.employee_id      = p_employee_id
      and a.leave_type_id    = p_leave_type_id
      and a.cycle_start_date = v_cs;

    -- Leave taken (approved) and reserved (pending) in this cycle -------
    select coalesce(sum(lr.total_days) filter (where lr.status = 1 and lr.start_date <= current_date), 0),
           coalesce(sum(lr.total_days) filter (where lr.status = 1), 0),
           coalesce(sum(lr.total_days) filter (where lr.status = 0), 0)
      into v_used_ytd, v_used_ye, v_pending
    from public.leave_requests lr
    where lr.employee_id   = p_employee_id
      and lr.leave_type_id = p_leave_type_id
      and lr.status in (0, 1)
      and lr.start_date between v_cs and v_ce
      and (p_exclude_request_id is null or lr.id <> p_exclude_request_id);

    v_pending := v_pending + greatest(coalesce(p_extra_days, 0), 0);

    cycle_start                 := v_cs;
    cycle_end                   := v_ce;
    effective_from              := v_emp_start;
    entitlement_ytd             := v_ent_ytd;
    entitlement_ye              := v_ent_ye;
    carry_forward_in            := v_carry;
    carry_forward_forfeited_ytd := v_forfeit_ytd;
    carry_forward_forfeited_ye  := v_forfeit_ye;
    adjustments                 := v_adj;
    used_ytd                    := v_used_ytd;
    used_ye                     := v_used_ye;
    pending_days                := v_pending;
    ytd_balance       := v_ent_ytd + v_carry - v_forfeit_ytd   + v_adj - v_used_ytd;
    ye_balance        := v_ent_ye  + v_carry - v_forfeit_ye    + v_adj - v_used_ye;
    available_balance := v_ent_ye  + v_carry - v_forfeit_avail + v_adj - v_used_ye - v_pending;
end;
$$;


-- ---------------------------------------------------------------------
-- Public, permission-checked view of calculate_leave_balance_raw().
-- Allowed: the employee, anyone who can file leave for them (same
-- department, 02), their first line, second line, HOD, or an admin.
-- The comparison is wrapped in coalesce() so a signed-in user with no
-- linked employee row (current_employee_uuid() = NULL) is rejected
-- instead of slipping through a NULL condition.
-- ---------------------------------------------------------------------
create function public.get_leave_balance(
    p_employee_id   uuid,
    p_leave_type_id integer,
    p_as_of         date default current_date,
    out cycle_start                  date,
    out cycle_end                    date,
    out effective_from               date,
    out entitlement_ytd              numeric(7,2),
    out entitlement_ye               numeric(7,2),
    out carry_forward_in             numeric(7,2),
    out carry_forward_forfeited_ytd  numeric(7,2),
    out carry_forward_forfeited_ye   numeric(7,2),
    out adjustments                  numeric(7,2),
    out used_ytd                     numeric(7,2),
    out used_ye                      numeric(7,2),
    out pending_days                 numeric(7,2),
    out ytd_balance                  numeric(7,2),
    out ye_balance                   numeric(7,2),
    out available_balance            numeric(7,2)
)
language plpgsql
security definer
set search_path = ''
as $$
begin
    if not coalesce(
        p_employee_id = public.current_employee_uuid()
        or public.can_request_leave_for(p_employee_id)
        or public.is_supervisor_of(p_employee_id)
        or public.is_second_line_of(p_employee_id)
        or public.is_hod_of(p_employee_id)
        or public.is_admin(),
        false
    ) then
        raise exception 'Not allowed' using errcode = '42501';
    end if;

    select r.cycle_start, r.cycle_end, r.effective_from,
           r.entitlement_ytd, r.entitlement_ye,
           r.carry_forward_in, r.carry_forward_forfeited_ytd, r.carry_forward_forfeited_ye,
           r.adjustments, r.used_ytd, r.used_ye, r.pending_days,
           r.ytd_balance, r.ye_balance, r.available_balance
      into cycle_start, cycle_end, effective_from,
           entitlement_ytd, entitlement_ye,
           carry_forward_in, carry_forward_forfeited_ytd, carry_forward_forfeited_ye,
           adjustments, used_ytd, used_ye, pending_days,
           ytd_balance, ye_balance, available_balance
    from public.calculate_leave_balance_raw(p_employee_id, p_leave_type_id, p_as_of) r;
end;
$$;


-- ---------------------------------------------------------------------
-- RPC: every (employee, active leave type) balance the caller may see —
-- self, direct reports (first line), second-line reports, HOD's
-- department, or everyone for an admin. Leave types the employee is not
-- eligible for today (or that their gender excludes) are left out, so no
-- balance card is shown for them. The visibility filter runs
-- first (materialized), so balances are only computed for visible rows.
-- ---------------------------------------------------------------------
create function public.list_leave_balances()
returns table (
    out_employee_id        uuid,
    out_employee_name      text,
    out_employee_code      text,
    out_leave_type_id      integer,
    out_leave_type         text,
    out_leave_code         text,
    out_cycle_start        date,
    out_cycle_end          date,
    out_ytd_balance        numeric,
    out_ye_balance         numeric,
    out_pending_days       numeric,
    out_available_balance  numeric
)
language sql
security definer
set search_path = ''
as $$
    with visible as materialized (
        select e.id, e.name, e.employee_id, e.last_day
        from public.employees e
        where e.id = public.current_employee_uuid()
           or public.is_supervisor_of(e.id)
           or public.is_second_line_of(e.id)
           or public.is_hod_of(e.id)
           or public.is_admin()
    )
    select
        v.id, v.name, v.employee_id,
        lt.leave_type_id, lt.leave_type, lt.leave_code,
        b.cycle_start, b.cycle_end,
        b.ytd_balance, b.ye_balance, b.pending_days, b.available_balance
    from visible v
    cross join public.leave_types lt
    cross join lateral public.calculate_leave_balance_raw(v.id, lt.leave_type_id) b
    where lt.is_active
      and (v.last_day is null or v.last_day >= b.cycle_start)
      -- ineligible / gender-restricted types get no balance card
      and public.is_leave_type_allowed_for_employee(v.id, lt.leave_type_id) is not false
      and public.is_employee_eligible_for_leave_type(v.id, lt.leave_type_id) is not false
    order by v.name, lt.leave_type;
$$;


-- ---------------------------------------------------------------------
-- Trigger: reject a new or edited leave request that the employee is
-- not eligible for, or that would take the balance below what the
-- leave type allows.
--   - Eligibility is skipped for admins (override, as in 02); the balance
--     check below applies to admins too.
--   - Only pending (0) / approved (1) rows are checked.
--   - Eligibility (02): is_employee_eligible_for_leave_type() as of the
--     request's start_date — applies to every leave type, including
--     no-entitlement ones.
--   - Balance: skipped for entitlement_days = 0 types (03's request cap
--     owns them). Otherwise checks available_balance for the cycle
--     containing start_date with THIS request counted as pending (and,
--     when editing, its old row excluded), against -max_negative_days
--     0: the request must be <= available (negative balance not used).
--   - Runs after ..._calc_total_days and ..._defaults (BEFORE triggers
--     fire alphabetically), so total_days / employee_id / status are
--     final. Uses the ungated raw function, so any same-department
--     colleague can file for someone else (can_request_leave_for, 02).
--   - Takes the same advisory lock as 03's cap trigger so two
--     simultaneous submits can't both pass.
-- ---------------------------------------------------------------------
create function public.enforce_leave_balance_before_submit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_name           text;
    v_entitlement    numeric;
    v_allow_negative boolean;
    v_max_negative   numeric;
    v_elig_type      text;
    v_elig_months    smallint;
    v_eligible_from  date;
    v_floor          numeric;
    v_available      numeric;
    v_ent_type       text;
    v_ent_ye         numeric;
    v_ent_ytd        numeric;
    v_not_accrued    numeric := 0;
begin
    if new.status not in (0, 1) then
        return new;
    end if;

    select lt.leave_type, lt.entitlement_days, lt.allow_negative_balance, lt.max_negative_days,
           lt.eligibility_type, lt.eligibility_service_months, lt.entitlement_type
      into v_name, v_entitlement, v_allow_negative, v_max_negative,
           v_elig_type, v_elig_months, v_ent_type
    from public.leave_types lt
    where lt.leave_type_id = new.leave_type_id;

    -- Eligibility (02): judged on the day the leave starts, so leave can
    -- be booked ahead for a date after probation / the service period.
    if not public.is_admin() and not coalesce(
        public.is_employee_eligible_for_leave_type(new.employee_id, new.leave_type_id, new.start_date),
        false
    ) then
        select case v_elig_type
                   when 'after_probation' then e.probation_end_date
                   when 'after_service'   then (e.hired_date + make_interval(months => v_elig_months))::date
                   else e.hired_date
               end
          into v_eligible_from
        from public.employees e
        where e.id = new.employee_id;

        raise exception '% is not available for leave starting on %; eligible from %',
            v_name, new.start_date, v_eligible_from;
    end if;

    if coalesce(new.total_days, 0) <= 0 then
        return new;
    end if;

    if v_entitlement is null or v_entitlement <= 0 then
        return new;   -- no-entitlement type: governed by 03's request cap
    end if;

    perform pg_advisory_xact_lock(hashtextextended(new.employee_id::text || ':' || new.leave_type_id::text, 0));

    select b.available_balance, b.entitlement_ye, b.entitlement_ytd
      into v_available, v_ent_ye, v_ent_ytd
    from public.calculate_leave_balance_raw(
             new.employee_id, new.leave_type_id, new.start_date,
             new.id, new.total_days, new.start_date
         ) b;

    v_floor := 0;   -- request must be <= available; allow_negative_balance is not used

    -- Monthly accrual: only what has been accrued up to today may be requested.
    if v_ent_type = 'monthly' then
        v_not_accrued := coalesce(v_ent_ye, 0) - coalesce(v_ent_ytd, 0);
        v_available   := v_available - v_not_accrued;
    end if;

    if v_available < v_floor then
        raise exception
            'Not enough % balance: this request is % day(s) but only % day(s) are available%',
            v_name, new.total_days, round(new.total_days + v_available, 1),
            case when v_ent_type = 'monthly' then ' to date' else '' end;
    end if;

    return new;
end;
$$;

-- Name sorts after ..._calc_total_days / ..._defaults (02) and before
-- ..._no_entitlement_cap (03). status is deliberately not in the column
-- list: approve / reject / cancel never re-checks eligibility or balance.
create trigger trg_leave_requests_enforce_balance
    before insert or update of
        employee_id, leave_type_id,
        start_date, end_date, start_half_day, end_half_day,
        total_days, total_days_manual
    on public.leave_requests
    for each row
    execute function public.enforce_leave_balance_before_submit();


-- =====================================================================
-- ROW LEVEL SECURITY
-- =====================================================================
alter table public.leave_balance_adjustments enable row level security;

drop policy if exists "leave_balance_adjustments_select" on public.leave_balance_adjustments;
create policy "leave_balance_adjustments_select" on public.leave_balance_adjustments
    for select to authenticated
    using (
        employee_id = public.current_employee_uuid()
        or public.is_supervisor_of(employee_id)
        or public.is_second_line_of(employee_id)
        or public.is_hod_of(employee_id)
        or public.is_admin()
    );

drop policy if exists "leave_balance_adjustments_admin_write" on public.leave_balance_adjustments;
create policy "leave_balance_adjustments_admin_write" on public.leave_balance_adjustments
    for all to authenticated
    using (public.is_admin())
    with check (public.is_admin());


-- =====================================================================
-- GRANTS
-- =====================================================================
grant select, insert, update, delete on
    public.leave_balance_adjustments
to authenticated, service_role;

grant usage, select on
    public.leave_balance_adjustments_id_seq
to authenticated, service_role;

-- Harmless lookups + the two permission-checked RPCs: signed-in users.
revoke all on function public.count_working_days(date, date)                    from public, anon;
revoke all on function public.get_leave_cycle_bounds(date)                       from public, anon;
revoke all on function public.get_carry_forward_expiry_date(date, integer)       from public, anon;
revoke all on function public.get_leave_balance(uuid, integer, date)             from public, anon;
revoke all on function public.list_leave_balances()                              from public, anon;

grant execute on function public.count_working_days(date, date)                  to authenticated, service_role;
grant execute on function public.get_leave_cycle_bounds(date)                     to authenticated, service_role;
grant execute on function public.get_carry_forward_expiry_date(date, integer)     to authenticated, service_role;
grant execute on function public.get_leave_balance(uuid, integer, date)           to authenticated, service_role;
grant execute on function public.list_leave_balances()                            to authenticated, service_role;

-- Internal, NO permission check inside: never callable by clients. They
-- still run when reached through the functions/trigger above (those run
-- as their owner).
revoke all on function public.calculate_leave_entitlement_earned(uuid, integer, date, date)                      from public, anon, authenticated;
revoke all on function public.calculate_carry_forward_in(uuid, integer, date)                                    from public, anon, authenticated;
revoke all on function public.calculate_leave_balance_raw(uuid, integer, date, uuid, numeric, date)              from public, anon, authenticated;
revoke all on function public.apply_prorate_rounding(numeric, text)                                              from public, anon, authenticated;

grant execute on function public.calculate_leave_entitlement_earned(uuid, integer, date, date)                   to service_role;
grant execute on function public.calculate_carry_forward_in(uuid, integer, date)                                 to service_role;
grant execute on function public.calculate_leave_balance_raw(uuid, integer, date, uuid, numeric, date)           to service_role;
grant execute on function public.apply_prorate_rounding(numeric, text)                                           to service_role;
