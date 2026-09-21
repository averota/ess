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
--                                    maximum balance, back-date allowance,
--                                    maximum carry forward + its expiry date
--
-- Depends on 01_employee_info_schema.sql and 02_leaves_schema.sql having
-- already run. Reused, NOT redefined here:
--   public.employees, public.is_admin(), public.current_employee_uuid(),
--   public.track_audit_columns()                     (from 01)
--   public.leave_types                               (from 02)
--
-- Used BY file 02: public.policy_weekly_working_days is read by
-- calculate_leave_request_total_days() to count only working days in
-- leave_requests.total_days. So 03 must be run right after 02, before
-- any leave request is inserted or edited.
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
-- in file 02 counts working days per policy_weekly_working_days).
-- NOT applied yet (follow-up work): standard monthly working days, the
-- yearly cut-off, beginning/maximum balance, carry forward, and
-- enforcing the back-date limit on insert.
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

create index if not exists idx_policy_settings_modified_by           on public.policy_settings (modified_by);
create index if not exists idx_policy_weekly_working_days_modified_by on public.policy_weekly_working_days (modified_by);
create index if not exists idx_leave_type_policies_modified_by       on public.leave_type_policies (modified_by);

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
    public.leave_type_policies
to authenticated, service_role;

-- Callable helper: signed-in users (and service_role) only. Postgres
-- grants EXECUTE to PUBLIC by default and Supabase also grants it to
-- anon, so revoke both first, then grant explicitly. (Trigger functions
-- need no EXECUTE grant.)
revoke all on function public.policy_month_day_is_valid(smallint, smallint) from public, anon;
grant execute on function public.policy_month_day_is_valid(smallint, smallint) to authenticated, service_role;
