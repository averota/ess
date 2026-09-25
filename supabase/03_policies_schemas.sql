-- =====================================================================
-- Employee Leave Management System — Policies Schema
-- Target: Supabase (PostgreSQL), public schema
--
-- Backs the admin "Policies" page (policies.html). Holds the rules that
-- the leave balance / request logic will read from:
--
--   Company-wide rules (one set for the whole company):
--     * policy_settings              standard monthly working days,
--                                    yearly cut-off date
--     * policy_weekly_working_days   Mon-Sun: 0 = day off, 0.5 = half
--                                    day, 1 = full day
--
--   Per leave type rules (one row per leave type):
--     * leave_type_policies          beginning balance per yearly cycle,
--                                    maximum balance (null = unlimited),
--                                    back-date allowance, maximum carry
--                                    forward + its expiry date, whether/
--                                    how it's prorated for a new hire,
--                                    eligibility waiting period, an
--                                    uncapped per-N-years service bonus,
--                                    and approval routing
--                                    (requires_approval, approver_post_id)
--     * leave_type_proration_tiers   admin-configurable partial hire-
--                                    month credit thresholds, used only
--                                    by leave types that opt into
--                                    use_partial_month_tiers
--
-- Depends on 01_employee_info_schema.sql and 02_leaves_schema.sql having
-- already run. Reused, NOT redefined here:
--   public.employees, public.is_admin(), public.current_employee_uuid(),
--   public.track_audit_columns()                     (from 01)
--   public.positions                                 (from 01 — used by
--                                                      leave_type_policies.approver_post_id)
--   public.leave_types                               (from 02)
--
-- Used BY file 02: public.policy_weekly_working_days is read by
-- calculate_leave_request_total_days() to count only working days in
-- leave_requests.total_days, and public.leave_type_policies
-- (requires_approval, approver_post_id) is read by
-- set_leave_request_defaults() / review_leave_request() to decide
-- whether a request needs review and who may review it. So 03 must be
-- run right after 02, before any leave request is inserted, edited or
-- reviewed.
--
-- Fresh setup:  run 01, then 02, then this file.
-- Existing DB:  just run this file. It only adds new objects and never
--               touches existing data.
--
-- Re-running this script: fully idempotent, same conventions as 01/02
-- (IF NOT EXISTS / CREATE OR REPLACE / DROP...IF EXISTS + CREATE, seed
-- data via ON CONFLICT DO NOTHING). Re-running never overwrites values an
-- admin has already changed on the Policies page.
--
-- Access model:
--   - Any signed-in user can READ every policy table (the request form
--     and balance display need the rules, e.g. the back-date allowance).
--   - Only admins can WRITE.
--   - policy_settings and policy_weekly_working_days are fixed-shape
--     (one row / seven rows, seeded below): admins UPDATE them, nobody
--     inserts or deletes.
--   - leave_type_policies has exactly one row per leave type, kept in
--     sync automatically: seeded here for existing leave types, and
--     created by trigger whenever a new leave type is added. Admins
--     insert/update; nobody deletes directly (a row goes away only when
--     its leave type is deleted, via ON DELETE CASCADE).
--
-- Month/day dates (yearly cut-off, carry forward expiry):
--   Stored as separate month (1-12) + day columns rather than a date,
--   because they recur every year ("31-Dec", "30-Jun"). Feb 29 is not
--   allowed (max 28 for February) so the date exists in every year.
--
--   Yearly cut-off = the LAST day of a leave year (yearly cycle).
--     31-Dec -> cycle runs 1 Jan  to 31 Dec
--     30-Jun -> cycle runs 1 Jul  to 30 Jun
--
--   Carry forward expiry (per leave type) = the date, in the NEW cycle,
--   by which carried-forward days must be used or they lapse: the first
--   occurrence of that month/day after the cycle's cut-off. Example with
--   a 31-Dec cut-off and a 31-Mar expiry: days carried out of 2026 are
--   usable until 31 Mar 2027. NULL = carried-forward days never expire.
--
-- Days are numeric(5,1) everywhere so half days (0.5) work, matching
-- leave_requests.total_days in file 02.
--
-- Applied so far: the weekly working pattern (leave_requests.total_days
-- in file 02 counts working days per policy_weekly_working_days), AND
-- the two approval-routing columns below (requires_approval,
-- approver_post_id) — those are wired live into file 02's
-- review_leave_request() / set_leave_request_defaults(), because
-- approval is an active request-time workflow, not a balance
-- calculation.
-- NOT applied yet (follow-up work, same as before): standard monthly
-- working days, the yearly cut-off, beginning/maximum balance
-- (including the new proration/eligibility/service-bonus rules below),
-- carry forward, and enforcing the back-date limit on insert. These are
-- stored now so the Policies page can capture them; a later balance
-- engine reads them, the same way backdate_days already sits unused
-- until that engine exists.
--
-- Per leave type rules, extended:
--   * leave_type_policies now also holds:
--       - is_prorated / use_partial_month_tiers / monthly_accrual_days:
--         how a NEW HIRE's first-cycle beginning balance is derived from
--         beginning_balance (the full-year amount), instead of granting
--         the full amount from day one. Two proration methods:
--           1) Default (is_prorated = true, use_partial_month_tiers =
--              false): beginning_balance x (full calendar months left in
--              the hire year / 12).
--           2) Tiered (use_partial_month_tiers = true, e.g. Annual
--              Leave): the partial hire month is credited using
--              leave_type_proration_tiers (see below) instead of a
--              simple fraction, and every FULL remaining month credits
--              monthly_accrual_days (falls back to beginning_balance/12
--              when left null).
--         is_prorated = false (the default) means the leave type always
--         grants the full beginning_balance regardless of hire date.
--       - eligibility_type / eligibility_years: when an employee may
--         start using this leave type at all — 'immediate' (default),
--         'after_probation' (their own employees.probation_end_date,
--         whatever it is for that person), or 'after_years' (hired_date
--         + eligibility_years).
--       - service_bonus_interval_years / service_bonus_days: an
--         uncapped bonus added to the entitlement for every full
--         interval of service, e.g. +1 day every 3 years. NULL interval
--         = no bonus. Annual Leave only — a trigger
--         (enforce_annual_leave_only_service_bonus) rejects setting
--         either field on any other leave type, since this rule isn't a
--         generic per-type option like proration or approval routing.
--       - requires_approval: false lets a leave type skip the
--         supervisor/admin review step entirely (auto-approved on
--         submission, no approver of record) — see file 02.
--       - approver_post_id: when set, ONLY an employee holding that
--         exact position (public.positions), or an admin, may review a
--         request of this leave type — the employee's direct supervisor
--         is bypassed. NULL (default) keeps today's supervisor-only
--         behaviour.
--     "Leave with a maximum" vs "unlimited" needs no new column — that's
--     already max_balance being non-null vs null.
--   * leave_type_proration_tiers: admin-configurable partial-month credit
--     table used only when use_partial_month_tiers = true (see above).
--     Not hardcoded to Annual Leave — any leave type can opt in and get
--     its own thresholds.
-- =====================================================================


-- ---------------------------------------------------------------------
-- Helper: is (month, day) a real calendar date that exists every year?
-- Used by CHECK constraints below. Pure lookup, no table access.
-- ---------------------------------------------------------------------
create or replace function public.policy_month_day_is_valid(p_month smallint, p_day smallint)
returns boolean
language sql
immutable
set search_path = ''
as $$
    select case
        when p_month in (1, 3, 5, 7, 8, 10, 12) then p_day between 1 and 31
        when p_month in (4, 6, 9, 11)           then p_day between 1 and 30
        when p_month = 2                        then p_day between 1 and 28
        else false
    end;
$$;


-- ---------------------------------------------------------------------
-- Company-wide settings (single row)
-- ---------------------------------------------------------------------
create table if not exists public.policy_settings (
    id                              smallint primary key default 1,
    standard_monthly_working_days   numeric(4,1) not null default 22, -- e.g. 22, 24, 26
    year_cutoff_month               smallint not null default 12,      -- last day of the leave year: month...
    year_cutoff_day                 smallint not null default 31,      -- ...and day (default 31-Dec)
    modified_by                     uuid references public.employees (id),
    last_modified                   timestamptz not null default now(),
    constraint policy_settings_singleton_check check (id = 1),
    constraint policy_settings_monthly_days_check check (
        standard_monthly_working_days > 0 and standard_monthly_working_days <= 31
    ),
    constraint policy_settings_year_cutoff_check check (
        public.policy_month_day_is_valid(year_cutoff_month, year_cutoff_day)
    )
);

insert into public.policy_settings (id) values (1)
on conflict (id) do nothing;


-- ---------------------------------------------------------------------
-- Weekly working pattern (seven rows, Monday to Sunday)
-- ---------------------------------------------------------------------
create table if not exists public.policy_weekly_working_days (
    day_of_week         smallint primary key, -- ISO: 1 = Monday ... 7 = Sunday (matches extract(isodow from <date>))
    day_name            text not null unique,
    working_value       numeric(2,1) not null default 0, -- 0 = day off, 0.5 = half day, 1 = full day
    modified_by         uuid references public.employees (id),
    last_modified       timestamptz not null default now(),
    constraint policy_weekly_day_of_week_check check (day_of_week between 1 and 7),
    constraint policy_weekly_working_value_check check (working_value in (0, 0.5, 1))
);

-- Default pattern: Monday-Friday full days, weekend off. Admins change
-- it on the Policies page; re-running this never overrides their edits.
insert into public.policy_weekly_working_days (day_of_week, day_name, working_value) values
    (1, 'Monday',    1),
    (2, 'Tuesday',   1),
    (3, 'Wednesday', 1),
    (4, 'Thursday',  1),
    (5, 'Friday',    1),
    (6, 'Saturday',  0),
    (7, 'Sunday',    0)
on conflict (day_of_week) do nothing;


-- ---------------------------------------------------------------------
-- Per leave type policy (one row per leave type)
-- ---------------------------------------------------------------------
create table if not exists public.leave_type_policies (
    leave_type_id               integer primary key
                                    references public.leave_types (leave_type_id) on delete cascade,
    beginning_balance           numeric(5,1) not null default 0,  -- days granted at the start of each yearly cycle
    max_balance                 numeric(5,1),                     -- cap on the total balance (incl. carried forward); NULL = no cap
    backdate_days               smallint not null default 0,      -- how many calendar days back a request may start; 0 = no back-dating
    max_carry_forward           numeric(5,1) not null default 0,  -- most days that roll into the next cycle; 0 = nothing carries forward
    carry_forward_expiry_month  smallint,                         -- carried-forward days lapse on this month/day of the new cycle;
    carry_forward_expiry_day    smallint,                         --   both NULL = they never lapse
    modified_by                 uuid references public.employees (id),
    last_modified               timestamptz not null default now(),
    constraint leave_type_policies_beginning_balance_check check (beginning_balance >= 0),
    constraint leave_type_policies_max_balance_check check (
        max_balance is null or max_balance >= beginning_balance
    ),
    constraint leave_type_policies_backdate_days_check check (backdate_days >= 0),
    constraint leave_type_policies_max_carry_forward_check check (max_carry_forward >= 0),
    constraint leave_type_policies_expiry_pair_check check (
        (carry_forward_expiry_month is null) = (carry_forward_expiry_day is null)
    ),
    constraint leave_type_policies_expiry_valid_check check (
        carry_forward_expiry_month is null
        or public.policy_month_day_is_valid(carry_forward_expiry_month, carry_forward_expiry_day)
    )
);

-- Upgrade path for a database that already ran an earlier version of
-- this file (CREATE TABLE IF NOT EXISTS above is a no-op once the table
-- exists). No-ops on a fresh install, where the CREATE TABLE already
-- included every column.
alter table public.leave_type_policies
    add column if not exists is_prorated                  boolean not null default false,
    add column if not exists use_partial_month_tiers       boolean not null default false,
    add column if not exists monthly_accrual_days          numeric(4,2), -- null = derive as beginning_balance / 12
    add column if not exists eligibility_type              text not null default 'immediate',
    add column if not exists eligibility_years              smallint,     -- only used when eligibility_type = 'after_years'
    add column if not exists service_bonus_interval_years   smallint,     -- e.g. 3 = every 3 years; null = no service bonus
    add column if not exists service_bonus_days             numeric(4,1) not null default 0, -- uncapped, added per interval
    add column if not exists requires_approval              boolean not null default true,
    add column if not exists approver_post_id               integer references public.positions (post_id);

alter table public.leave_type_policies
    drop constraint if exists leave_type_policies_eligibility_type_check;
alter table public.leave_type_policies
    add constraint leave_type_policies_eligibility_type_check check (
        eligibility_type in ('immediate', 'after_probation', 'after_years')
    );

alter table public.leave_type_policies
    drop constraint if exists leave_type_policies_eligibility_years_check;
alter table public.leave_type_policies
    add constraint leave_type_policies_eligibility_years_check check (
        (eligibility_type = 'after_years') = (eligibility_years is not null)
        and (eligibility_years is null or eligibility_years > 0)
    );

alter table public.leave_type_policies
    drop constraint if exists leave_type_policies_service_bonus_check;
alter table public.leave_type_policies
    add constraint leave_type_policies_service_bonus_check check (
        service_bonus_days >= 0
        and (service_bonus_interval_years is null or service_bonus_interval_years > 0)
    );

alter table public.leave_type_policies
    drop constraint if exists leave_type_policies_monthly_accrual_check;
alter table public.leave_type_policies
    add constraint leave_type_policies_monthly_accrual_check check (
        monthly_accrual_days is null or monthly_accrual_days >= 0
    );

-- The tiered hire-month rule only makes sense on a leave type that's
-- prorated at all.
alter table public.leave_type_policies
    drop constraint if exists leave_type_policies_tiers_need_prorate_check;
alter table public.leave_type_policies
    add constraint leave_type_policies_tiers_need_prorate_check check (
        not use_partial_month_tiers or is_prorated
    );

-- The service-length bonus (service_bonus_interval_years/
-- service_bonus_days) is specific to Annual Leave only — unlike
-- proration or approval routing above, it's not a feature every leave
-- type can opt into. A CHECK constraint can't look up another table's
-- row, so this is enforced with a trigger: setting a non-default bonus
-- on any leave type other than "Annual Leave" is rejected outright. If
-- Annual Leave is ever renamed, this trigger's literal match must be
-- updated too — it isn't self-adjusting the way
-- leave_type_proration_tiers is.
create or replace function public.enforce_annual_leave_only_service_bonus()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_leave_type text;
begin
    if new.service_bonus_interval_years is null and new.service_bonus_days = 0 then
        return new; -- nothing set, always fine
    end if;

    select lt.leave_type into v_leave_type
    from public.leave_types lt
    where lt.leave_type_id = new.leave_type_id;

    if v_leave_type is distinct from 'Annual Leave' then
        raise exception 'The service-length bonus can only be set on Annual Leave, not "%"',
            coalesce(v_leave_type, '(unknown leave type)');
    end if;

    return new;
end;
$$;

drop trigger if exists trg_leave_type_policies_service_bonus_scope on public.leave_type_policies;
create trigger trg_leave_type_policies_service_bonus_scope
    before insert or update of service_bonus_interval_years, service_bonus_days
    on public.leave_type_policies
    for each row
    execute function public.enforce_annual_leave_only_service_bonus();

create index if not exists idx_policy_settings_modified_by           on public.policy_settings (modified_by);
create index if not exists idx_policy_weekly_working_days_modified_by on public.policy_weekly_working_days (modified_by);
create index if not exists idx_leave_type_policies_modified_by       on public.leave_type_policies (modified_by);
create index if not exists idx_leave_type_policies_approver_post_id  on public.leave_type_policies (approver_post_id);

-- Seed one row (all defaults: zero balance, no cap, no back-dating, no
-- carry forward) for every leave type that already exists. The admin
-- sets real values on the Policies page.
insert into public.leave_type_policies (leave_type_id)
select lt.leave_type_id
from public.leave_types lt
on conflict (leave_type_id) do nothing;

-- Keep it one-to-one going forward: a leave type added later (via the
-- manage-list-values UI) automatically gets its default policy row, so
-- the Policies page never has a leave type with nothing to edit.
create or replace function public.create_default_leave_type_policy()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    insert into public.leave_type_policies (leave_type_id)
    values (new.leave_type_id)
    on conflict (leave_type_id) do nothing;
    return new;
end;
$$;

drop trigger if exists trg_leave_types_create_policy on public.leave_types;
create trigger trg_leave_types_create_policy
    after insert on public.leave_types
    for each row
    execute function public.create_default_leave_type_policy();


-- ---------------------------------------------------------------------
-- Partial-month proration tiers — only consulted when a leave type's
-- leave_type_policies.use_partial_month_tiers = true. For the hire
-- month, the highest min_working_days threshold that the employee's
-- remaining working days in that month meets or exceeds gives the
-- credit_days for that partial month; no matching row credits 0.
-- Admin-configurable per leave type — not hardcoded to Annual Leave.
-- ---------------------------------------------------------------------
create table if not exists public.leave_type_proration_tiers (
    id                   bigserial primary key,
    leave_type_id        integer not null references public.leave_types (leave_type_id) on delete cascade,
    min_working_days     smallint not null,      -- working days remaining in the hire month, threshold (>=)
    credit_days          numeric(4,1) not null,  -- equivalent days credited when that threshold is met
    modified_by          uuid references public.employees (id),
    last_modified        timestamptz not null default now(),
    constraint leave_type_proration_tiers_min_days_check check (min_working_days between 0 and 31),
    constraint leave_type_proration_tiers_credit_check check (credit_days >= 0),
    constraint leave_type_proration_tiers_unique unique (leave_type_id, min_working_days)
);

create index if not exists idx_leave_type_proration_tiers_leave_type_id on public.leave_type_proration_tiers (leave_type_id);
create index if not exists idx_leave_type_proration_tiers_modified_by   on public.leave_type_proration_tiers (modified_by);

drop trigger if exists trg_leave_type_proration_tiers_audit on public.leave_type_proration_tiers;
create trigger trg_leave_type_proration_tiers_audit
    before insert or update on public.leave_type_proration_tiers
    for each row
    execute function public.track_audit_columns();

-- Seed the confirmed Annual Leave rule: hire-month working days
-- remaining >=21 credits 1.5, >=15 credits 1, otherwise 0 (falls
-- through to the "no matching row" case, so no row is needed for it).
-- Guarded so re-running this script never overwrites an admin's later
-- edit to these flags/tiers, and is a no-op if "Annual Leave" doesn't
-- exist under that exact name.
insert into public.leave_type_proration_tiers (leave_type_id, min_working_days, credit_days)
select lt.leave_type_id, v.min_working_days, v.credit_days
from public.leave_types lt
join (values (21, 1.5), (15, 1.0)) as v(min_working_days, credit_days) on true
where lt.leave_type = 'Annual Leave'
on conflict (leave_type_id, min_working_days) do nothing;

update public.leave_type_policies ltp
set is_prorated = true,
    use_partial_month_tiers = true
from public.leave_types lt
where lt.leave_type_id = ltp.leave_type_id
  and lt.leave_type = 'Annual Leave'
  and ltp.is_prorated = false
  and ltp.use_partial_month_tiers = false;


-- ---------------------------------------------------------------------
-- Helper: is this employee currently eligible to USE this leave type at
-- all, per its eligibility_type/eligibility_years? Read-only — not
-- wired into any insert/RLS yet (eligibility gating on leave requests
-- is the same "follow-up work" as balance enforcement, see header note),
-- but available now for the request form to grey out a type the
-- employee can't use yet.
-- ---------------------------------------------------------------------
create or replace function public.is_employee_eligible_for_leave_type(
    p_employee_id uuid,
    p_leave_type_id integer,
    p_as_of date default current_date
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select case ltp.eligibility_type
        when 'immediate'       then true
        when 'after_probation' then p_as_of >= e.probation_end_date
        when 'after_years'     then p_as_of >= e.hired_date + make_interval(years => ltp.eligibility_years)
        else false
    end
    from public.employees e
    join public.leave_type_policies ltp on ltp.leave_type_id = p_leave_type_id
    where e.id = p_employee_id;
$$;


-- ---------------------------------------------------------------------
-- Audit triggers — reuse track_audit_columns() from file 01, don't
-- redefine it.
-- ---------------------------------------------------------------------
drop trigger if exists trg_policy_settings_audit on public.policy_settings;
create trigger trg_policy_settings_audit
    before insert or update on public.policy_settings
    for each row
    execute function public.track_audit_columns();

drop trigger if exists trg_policy_weekly_working_days_audit on public.policy_weekly_working_days;
create trigger trg_policy_weekly_working_days_audit
    before insert or update on public.policy_weekly_working_days
    for each row
    execute function public.track_audit_columns();

drop trigger if exists trg_leave_type_policies_audit on public.leave_type_policies;
create trigger trg_leave_type_policies_audit
    before insert or update on public.leave_type_policies
    for each row
    execute function public.track_audit_columns();


-- =====================================================================
-- ROW LEVEL SECURITY
-- =====================================================================
alter table public.policy_settings             enable row level security;
alter table public.policy_weekly_working_days  enable row level security;
alter table public.leave_type_policies         enable row level security;
alter table public.leave_type_proration_tiers  enable row level security;

-- Company settings: everyone signed in can read; admins can update.
-- No insert/delete policy on purpose — the single row is seeded above.
drop policy if exists "policy_settings_read" on public.policy_settings;
create policy "policy_settings_read" on public.policy_settings
    for select to authenticated using (true);
drop policy if exists "policy_settings_admin_update" on public.policy_settings;
create policy "policy_settings_admin_update" on public.policy_settings
    for update to authenticated
    using (public.is_admin())
    with check (public.is_admin());

-- Weekly working days: same — the seven rows are seeded above.
drop policy if exists "policy_weekly_working_days_read" on public.policy_weekly_working_days;
create policy "policy_weekly_working_days_read" on public.policy_weekly_working_days
    for select to authenticated using (true);
drop policy if exists "policy_weekly_working_days_admin_update" on public.policy_weekly_working_days;
create policy "policy_weekly_working_days_admin_update" on public.policy_weekly_working_days
    for update to authenticated
    using (public.is_admin())
    with check (public.is_admin());

-- Leave type policies: everyone signed in can read; admins can insert
-- (so a client-side upsert works) and update. No delete policy — rows
-- are removed only by the ON DELETE CASCADE from leave_types.
drop policy if exists "leave_type_policies_read" on public.leave_type_policies;
create policy "leave_type_policies_read" on public.leave_type_policies
    for select to authenticated using (true);
drop policy if exists "leave_type_policies_admin_insert" on public.leave_type_policies;
create policy "leave_type_policies_admin_insert" on public.leave_type_policies
    for insert to authenticated
    with check (public.is_admin());
drop policy if exists "leave_type_policies_admin_update" on public.leave_type_policies;
create policy "leave_type_policies_admin_update" on public.leave_type_policies
    for update to authenticated
    using (public.is_admin())
    with check (public.is_admin());

-- Proration tiers: everyone signed in can read (the request form may
-- eventually need them); only admins write. No delete-cascade concerns
-- here since ON DELETE CASCADE from leave_types already handles a
-- removed leave type.
drop policy if exists "leave_type_proration_tiers_read" on public.leave_type_proration_tiers;
create policy "leave_type_proration_tiers_read" on public.leave_type_proration_tiers
    for select to authenticated using (true);
drop policy if exists "leave_type_proration_tiers_admin_write" on public.leave_type_proration_tiers;
create policy "leave_type_proration_tiers_admin_write" on public.leave_type_proration_tiers
    for all to authenticated
    using (public.is_admin())
    with check (public.is_admin());


-- =====================================================================
-- GRANTS
-- =====================================================================
-- File 01's `alter default privileges` should already cover these new
-- tables; the explicit grants are kept as belt-and-suspenders (same
-- reasoning as file 02) against "permission denied for table ..."
-- (42501). Row-level access is what RLS above actually enforces.
grant select, insert, update, delete on
    public.policy_settings,
    public.policy_weekly_working_days,
    public.leave_type_policies,
    public.leave_type_proration_tiers
to authenticated, service_role;

grant usage, select on
    public.leave_type_proration_tiers_id_seq
to authenticated, service_role;

-- Callable helpers: signed-in users (and service_role) only. Postgres
-- grants EXECUTE to PUBLIC by default and Supabase also grants it to
-- anon, so revoke both first, then grant explicitly. (Trigger functions
-- need no EXECUTE grant.)
revoke all on function public.policy_month_day_is_valid(smallint, smallint) from public, anon;
revoke all on function public.is_employee_eligible_for_leave_type(uuid, integer, date) from public, anon;
grant execute on function public.policy_month_day_is_valid(smallint, smallint) to authenticated, service_role;
grant execute on function public.is_employee_eligible_for_leave_type(uuid, integer, date) to authenticated, service_role;
