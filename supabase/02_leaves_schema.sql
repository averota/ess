-- =====================================================================
-- Employee Leave Management System — Leave Request Schema
-- Target: Supabase (PostgreSQL), public schema
--
-- SINGLE SOURCE OF TRUTH for everything leave-related, including every
-- per-leave-type rule (previously split out into leave_type_policies in
-- 03_policies_schemas.sql — that table is now retired, see below).
--
-- Depends on 01_employee_info_schema.sql having already run (it now
-- includes what used to be the separate 01a migration):
--   public.employees (incl. supervisor_id = "first line" manager,
--   second_line_id = "second line" manager), public.departments (incl.
--   hod_id = head of department), public.is_admin(),
--   public.current_employee_uuid(), public.track_audit_columns() — all
--   reused here, not redefined.
--
-- Fresh setup:  run 01, then this file, then 03 (and 05, which creates public.holidays
--   used by calculate_leave_request_total_days() when a request is saved).
-- Existing DB:  re-run this file. It upgrades leave_types in place,
--   migrates away from leave_type_policies (dropped — see below),
--   creates/backfills the sequential approval-step machinery, and
--   replaces the routing functions. Fully idempotent.
--
-- =====================================================================
-- WHAT CHANGED FROM THE OLD leave_type_policies TABLE
-- =====================================================================
-- Every per-leave-type rule (entitlement, proration, service bonus,
-- negative balance, carry forward, approval, prior notice, back-date)
-- now lives directly on public.leave_types instead of a separate
-- leave_type_policies table. That table is DROPPED by this script
-- (`drop table if exists public.leave_type_policies cascade`) — safe,
-- since by this point it should only hold leave_type_id. If you have
-- NOT already stripped/retired that table, its remaining columns are
-- lost when this script runs — back them up first if needed.
--
-- Approval routing is table-driven: leave_type_approval_rules holds one
-- or more rules PER leave type, each scoped to a specific employee,
-- position, department, or "everyone" (the fallback), with a
-- >-this-many-days threshold and which role(s) are required to review
-- (first line / second line / head of department). The most specific
-- matching scope wins (employee > position > department > everyone);
-- within that scope, the highest threshold met wins. See
-- get_leave_approval_requirement() below.
--
-- Those require_first_line / require_second_line / require_hod flags
-- mean these steps must ALL happen, in this fixed order: first line ->
-- second line -> head of department (NOT "any one may approve" — a
-- rule with only require_first_line = true is still just one step, but
-- flagging more than one role makes them sequential gates, not
-- alternatives). public.leave_request_approvals holds one row per
-- required step for a given request, generated automatically right
-- after the request is inserted (or after certain edits to a still-
-- pending request — see generate_leave_request_approval_steps() below).
-- leave_requests.status remains the overall state (0 pending /
-- 1 approved / 2 rejected / 3 cancelled); the step rows track progress
-- through it. The "current step" is always the lowest step_no still at
-- status = 0 (pending) — that's the only step anyone (other than an
-- admin) may act on.
--
-- leave_types.requires_approval is still the master switch: false means
-- the leave type is auto-approved on submission, gets ZERO approval
-- steps, and leave_type_approval_rules is never consulted for it at
-- all.
--
-- Back-date and prior-notice are ENFORCED: set_leave_request_defaults()
-- rejects a self-service insert/date-edit that violates
-- leave_types.allow_backdate / backdate_days / require_prior_notice /
-- prior_notice_days. Admins bypass both, same "admin override" pattern
-- used elsewhere here.
--
-- STILL NOT IMPLEMENTED (same "stored now, engine reads it later"
-- status the old file already had for balance-related columns):
-- computing the actual prorated entitlement number, applying carry
-- forward, and blocking a request that would breach max_negative_days.
-- All the inputs those need are stored on leave_types below; there is
-- no running balance ledger table yet for an engine to write to.
-- =====================================================================
--
-- Approval model:
--   - A regular employee can insert a request for themselves, or for an
--     eligible colleague (anyone in the same department, their own
--     supervisor included — see can_request_leave_for() /
--     list_my_leave_delegates() below).
--   - An admin inserting a request on behalf of a DIFFERENT employee is
--     auto-approved on creation.
--   - An admin inserting a request for THEMSELVES is treated like a
--     normal self-request (still needs someone else to review).
--   - Approving/rejecting a *pending* request is done via
--     review_leave_request(), which resolves and acts on the CURRENT
--     step (lowest step_no still pending) — callable by that step's
--     required approver role, or any admin:
--       * 'approved' on a non-final step: that step is marked approved,
--         overall status stays 0 (pending) — the next step becomes
--         current.
--       * 'approved' on the FINAL step: that step is marked approved
--         AND the whole request flips to status = 1 (approved).
--       * 'rejected' at ANY step: that step is marked rejected AND the
--         whole request immediately flips to status = 2 (rejected).
--         Any steps after it are left at status = 0, as history of
--         "never reached" — not retroactively cancelled.
--     Cancelling is done via cancel_leave_request() (the employee the
--     request is for, or an admin): a PENDING request any time, an
--     APPROVED one only while it hasn't started yet (start_date >
--     current_date; an admin may cancel an approved one regardless).
--     Sets status = 3 and cancels (status = 3) any still-pending steps;
--     steps already approved stay as history.
--   - A leave type can skip review entirely (requires_approval = false):
--     auto-approved on submission, no approver of record, zero steps.
--   - Approval comment: set_leave_review_comment() sets the comment on
--     the step the caller most recently approved on this request.
--     leave_requests.review_comment is no longer written to by
--     anything — left in place so nothing breaks if it's still read
--     elsewhere, but public.leave_request_approvals.comment is the
--     source of truth now.
--   - Editing the *details* of your own still-pending request is a
--     plain table update (leave_requests_self_update), still gated by
--     the back-date / prior-notice rules above.
--
-- Half-day model / working-day total_days calculation: see the inline
-- comments on calculate_leave_request_total_days() further down.
-- =====================================================================


-- ---------------------------------------------------------------------
-- Helper: is (month, day) a real calendar date that exists every year?
-- Used by carry-forward-expiry CHECK constraints below (both here and
-- in 03_policies_schemas.sql, which reuses this without redefining it).
-- Pure lookup, no table access. Lives here (not in 03) because
-- leave_types' carry-forward-expiry check needs it, and 02 runs before
-- 03.
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
-- Lookup tables
-- ---------------------------------------------------------------------

-- Leave types: admin-managed. Now also holds every per-type policy rule
-- (see the big comment block up top for what changed and why).
create table if not exists public.leave_types (
    leave_type_id       serial primary key,
    leave_type          text not null unique,
    is_active           boolean not null default true,
    modified_by         uuid references public.employees (id),
    last_modified       timestamptz not null default now()
);

-- Upgrade path: add every policy column via IF NOT EXISTS, same
-- convention as the rest of this codebase, so re-running never
-- disturbs an admin's existing edits.
alter table public.leave_types
    add column if not exists leave_code                   text,                          -- e.g. AL, SL, UL — immutable once set (see trigger below)
    add column if not exists eligibility_type              text not null default 'hired_date',  -- 'hired_date' | 'after_probation' | 'after_service'
    add column if not exists eligibility_service_months    smallint,                      -- required iff eligibility_type = 'after_service'; store years as months*12
    add column if not exists entitlement_type              text not null default 'annual',      -- 'annual' (days/year) | 'monthly' (days/month, accrued)
    add column if not exists entitlement_days              numeric(5,2) not null default 0,     -- days/year if annual, days/month if monthly
    add column if not exists use_partial_month             boolean not null default false,      -- credit a partial hire/leave month at all?
    add column if not exists partial_month_method          text not null default 'daily_prorate', -- 'daily_prorate' | 'tiered' (see leave_type_proration_tiers)
    add column if not exists prorate_rounding               text not null default 'exact',       -- 'exact' (2dp) | 'round_down_half' | 'round_down_whole'
    add column if not exists service_bonus_enabled          boolean not null default false,
    add column if not exists service_bonus_interval_months  smallint,                      -- required iff enabled; store years as months*12
    add column if not exists service_bonus_days             numeric(4,1) not null default 0, -- uncapped, added per interval, required >0 iff enabled
    add column if not exists allow_negative_balance         boolean not null default false,
    add column if not exists max_negative_days              numeric(5,1) not null default 0, -- most negative the balance may go; required >0 iff allowed
    add column if not exists requires_approval              boolean not null default true,   -- master switch; see leave_type_approval_rules for WHO
    add column if not exists max_carry_forward              numeric(5,1) not null default 0,
    add column if not exists carry_forward_expiry_month     smallint,
    add column if not exists carry_forward_expiry_day       smallint,
    add column if not exists require_prior_notice           boolean not null default false,
    add column if not exists prior_notice_days              smallint,                      -- required >0 iff require_prior_notice
    add column if not exists allow_backdate                 boolean not null default false,
    add column if not exists backdate_days                  smallint not null default 0,    -- required >0 iff allow_backdate
    add column if not exists count_calendar_days            boolean not null default false,  -- true = total_days counts every calendar day (ignores the weekly working pattern)
    add column if not exists fixed_duration_days            smallint,                        -- NULL = free end date; N = the request form fills the end date as start + N calendar days (start and end included)
    add column if not exists allowed_gender_id              smallint references public.genders (gender_id);  -- NULL = any employee; otherwise ONLY that gender may take this type (0 = female, 1 = male). Hard rule: admins cannot override it.

-- Seed data (fresh install): includes leave_code directly.
insert into public.leave_types (leave_type, leave_code) values
    ('Annual Leave',    'AL'),
    ('Sick Leave',      'SL'),
    ('Unpaid Leave',    'UL'),
    ('Maternity Leave', 'ML')
on conflict (leave_type) do nothing;

-- Backfill leave_code for rows that predate that column (upgrade path).
-- If you've added custom leave types beyond these four and they still
-- have no code, set one manually before the NOT NULL below, e.g.:
--   update public.leave_types set leave_code = 'XX' where leave_type = 'Your Type';
update public.leave_types set leave_code = v.code
from (values
    ('Annual Leave',    'AL'),
    ('Sick Leave',      'SL'),
    ('Unpaid Leave',    'UL'),
    ('Maternity Leave', 'ML')
) as v(leave_type, code)
where public.leave_types.leave_type = v.leave_type
  and public.leave_types.leave_code is null;

alter table public.leave_types alter column leave_code set not null;

-- Maternity Leave: 90 CALENDAR days, start and end date included.
update public.leave_types
set count_calendar_days = true,
    fixed_duration_days = 90
where leave_code = 'ML'
  and fixed_duration_days is null;

alter table public.leave_types drop constraint if exists leave_types_fixed_duration_check;
alter table public.leave_types add constraint leave_types_fixed_duration_check check (
    fixed_duration_days is null or fixed_duration_days > 0
);

-- Maternity Leave is female-only (genders.gender_id 0 = female). Re-running
-- restores it if the column was cleared.
update public.leave_types
set allowed_gender_id = 0
where leave_code = 'ML'
  and allowed_gender_id is null;

alter table public.leave_types drop constraint if exists leave_types_leave_code_key;
alter table public.leave_types add constraint leave_types_leave_code_key unique (leave_code);

-- Normalize leave_code to upper case and make it immutable once set —
-- "Code: not editable after setup".
create or replace function public.normalize_and_lock_leave_code()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    new.leave_code := upper(trim(new.leave_code));
    if new.leave_code is null or new.leave_code = '' then
        raise exception 'leave_code is required';
    end if;
    if tg_op = 'UPDATE' and old.leave_code is distinct from new.leave_code then
        raise exception 'leave_code cannot be changed after it is set (was "%", tried "%")',
            old.leave_code, new.leave_code;
    end if;
    return new;
end;
$$;

drop trigger if exists trg_leave_types_lock_code on public.leave_types;
create trigger trg_leave_types_lock_code
    before insert or update of leave_code on public.leave_types
    for each row
    execute function public.normalize_and_lock_leave_code();

-- Policy CHECK constraints (drop/add pattern so re-running never fails
-- on "constraint already exists").
alter table public.leave_types drop constraint if exists leave_types_eligibility_type_check;
alter table public.leave_types add constraint leave_types_eligibility_type_check check (
    eligibility_type in ('hired_date', 'after_probation', 'after_service')
);

alter table public.leave_types drop constraint if exists leave_types_eligibility_service_months_check;
alter table public.leave_types add constraint leave_types_eligibility_service_months_check check (
    (eligibility_type = 'after_service') = (eligibility_service_months is not null)
    and (eligibility_service_months is null or eligibility_service_months > 0)
);

alter table public.leave_types drop constraint if exists leave_types_entitlement_type_check;
alter table public.leave_types add constraint leave_types_entitlement_type_check check (
    entitlement_type in ('annual', 'monthly')
);

alter table public.leave_types drop constraint if exists leave_types_entitlement_days_check;
alter table public.leave_types add constraint leave_types_entitlement_days_check check (entitlement_days >= 0);

alter table public.leave_types drop constraint if exists leave_types_partial_month_method_check;
alter table public.leave_types add constraint leave_types_partial_month_method_check check (
    partial_month_method in ('daily_prorate', 'tiered')
);

alter table public.leave_types drop constraint if exists leave_types_prorate_rounding_check;
alter table public.leave_types add constraint leave_types_prorate_rounding_check check (
    prorate_rounding in ('exact', 'round_down_half', 'round_down_whole')
);

alter table public.leave_types drop constraint if exists leave_types_service_bonus_check;
alter table public.leave_types add constraint leave_types_service_bonus_check check (
    (not service_bonus_enabled and service_bonus_interval_months is null and service_bonus_days = 0)
    or (service_bonus_enabled and service_bonus_interval_months > 0 and service_bonus_days > 0)
);

alter table public.leave_types drop constraint if exists leave_types_negative_balance_check;
alter table public.leave_types add constraint leave_types_negative_balance_check check (
    (not allow_negative_balance and max_negative_days = 0)
    or (allow_negative_balance and max_negative_days > 0)
);

alter table public.leave_types drop constraint if exists leave_types_max_carry_forward_check;
alter table public.leave_types add constraint leave_types_max_carry_forward_check check (max_carry_forward >= 0);

alter table public.leave_types drop constraint if exists leave_types_carry_forward_expiry_pair_check;
alter table public.leave_types add constraint leave_types_carry_forward_expiry_pair_check check (
    (carry_forward_expiry_month is null) = (carry_forward_expiry_day is null)
);

alter table public.leave_types drop constraint if exists leave_types_carry_forward_expiry_valid_check;
alter table public.leave_types add constraint leave_types_carry_forward_expiry_valid_check check (
    carry_forward_expiry_month is null
    or public.policy_month_day_is_valid(carry_forward_expiry_month, carry_forward_expiry_day)
);

alter table public.leave_types drop constraint if exists leave_types_prior_notice_check;
alter table public.leave_types add constraint leave_types_prior_notice_check check (
    (not require_prior_notice and prior_notice_days is null)
    or (require_prior_notice and prior_notice_days > 0)
);

alter table public.leave_types drop constraint if exists leave_types_backdate_check;
alter table public.leave_types add constraint leave_types_backdate_check check (
    (not allow_backdate and backdate_days = 0)
    or (allow_backdate and backdate_days > 0)
);

create index if not exists idx_leave_types_modified_by on public.leave_types (modified_by);
create index if not exists idx_leave_types_is_active   on public.leave_types (is_active);


-- ---------------------------------------------------------------------
-- Partial-month proration tiers — only consulted when a leave type's
-- leave_types.partial_month_method = 'tiered'. For the boundary month,
-- the highest min_working_days threshold that the remaining working
-- days in that month meet or exceed gives credit_days; no matching row
-- credits 0. Admin-configurable per leave type.
-- (Previously lived in 03_policies_schemas.sql; moved here since its
-- parent config now lives in leave_types.)
-- ---------------------------------------------------------------------
create table if not exists public.leave_type_proration_tiers (
    id                   bigserial primary key,
    leave_type_id        integer not null references public.leave_types (leave_type_id) on delete cascade,
    min_working_days     smallint not null,
    credit_days          numeric(4,1) not null,
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

-- Seed the confirmed Annual Leave rule (guarded so it never overwrites
-- an admin's later edit, and is a no-op if "Annual Leave" doesn't exist
-- under that exact name).
insert into public.leave_type_proration_tiers (leave_type_id, min_working_days, credit_days)
select lt.leave_type_id, v.min_working_days, v.credit_days
from public.leave_types lt
join (values (21, 1.5), (15, 1.0)) as v(min_working_days, credit_days) on true
where lt.leave_type = 'Annual Leave'
on conflict (leave_type_id, min_working_days) do nothing;

update public.leave_types
set use_partial_month = true,
    partial_month_method = 'tiered'
where leave_type = 'Annual Leave'
  and use_partial_month = false;


-- ---------------------------------------------------------------------
-- Approval routing rules — one or more rows per leave type. Replaces
-- the old single approver_post_id column. See the big comment block up
-- top for how a request resolves to a rule (most specific scope wins,
-- then highest threshold met) — implemented in
-- get_leave_approval_requirement() below. The require_first_line /
-- require_second_line / require_hod flags are sequential steps (first
-- line -> second line -> hod), not alternatives — see
-- public.leave_request_approvals further down for how a request
-- actually progresses through them.
-- ---------------------------------------------------------------------
create table if not exists public.leave_type_approval_rules (
    id                    bigserial primary key,
    leave_type_id         integer not null references public.leave_types (leave_type_id) on delete cascade,
    scope_type            text not null default 'everyone',            -- 'employee' | 'position' | 'department' | 'everyone'
    scope_employee_id     uuid references public.employees (id) on delete cascade,
    scope_post_id         integer references public.positions (post_id) on delete cascade,
    scope_dept_id         integer references public.departments (dept_id) on delete cascade,
    min_days              numeric(5,1) not null default 0,             -- rule applies when the request's total_days > this
    require_first_line    boolean not null default true,
    require_second_line   boolean not null default false,
    require_hod           boolean not null default false,
    modified_by           uuid references public.employees (id),
    last_modified         timestamptz not null default now(),
    constraint leave_type_approval_rules_scope_type_check check (
        scope_type in ('employee', 'position', 'department', 'everyone')
    ),
    constraint leave_type_approval_rules_scope_match_check check (
        (scope_type = 'employee'   and scope_employee_id is not null and scope_post_id is null and scope_dept_id is null) or
        (scope_type = 'position'   and scope_post_id is not null and scope_employee_id is null and scope_dept_id is null) or
        (scope_type = 'department' and scope_dept_id is not null and scope_employee_id is null and scope_post_id is null) or
        (scope_type = 'everyone'   and scope_employee_id is null and scope_post_id is null and scope_dept_id is null)
    ),
    constraint leave_type_approval_rules_min_days_check check (min_days >= 0),
    constraint leave_type_approval_rules_needs_approver_check check (
        require_first_line or require_second_line or require_hod
    ),
    constraint leave_type_approval_rules_unique unique (
        leave_type_id, scope_type, scope_employee_id, scope_post_id, scope_dept_id, min_days
    )
);

create index if not exists idx_leave_type_approval_rules_leave_type_id     on public.leave_type_approval_rules (leave_type_id);
create index if not exists idx_leave_type_approval_rules_scope_employee_id on public.leave_type_approval_rules (scope_employee_id);
create index if not exists idx_leave_type_approval_rules_scope_post_id     on public.leave_type_approval_rules (scope_post_id);
create index if not exists idx_leave_type_approval_rules_scope_dept_id     on public.leave_type_approval_rules (scope_dept_id);
create index if not exists idx_leave_type_approval_rules_modified_by       on public.leave_type_approval_rules (modified_by);

drop trigger if exists trg_leave_type_approval_rules_audit on public.leave_type_approval_rules;
create trigger trg_leave_type_approval_rules_audit
    before insert or update on public.leave_type_approval_rules
    for each row
    execute function public.track_audit_columns();

-- Seed one default 'everyone' rule (first-line approval, no threshold)
-- for any leave type that doesn't have a rule yet, so requires_approval
-- leave types always have somewhere to route to out of the box.
insert into public.leave_type_approval_rules (leave_type_id, scope_type, min_days, require_first_line)
select lt.leave_type_id, 'everyone', 0, true
from public.leave_types lt
where not exists (
    select 1 from public.leave_type_approval_rules r where r.leave_type_id = lt.leave_type_id
);

-- Keep it one-rule-minimum going forward: a leave type added later
-- automatically gets a default 'everyone' rule too.
create or replace function public.create_default_leave_type_approval_rule()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    insert into public.leave_type_approval_rules (leave_type_id, scope_type, min_days, require_first_line)
    values (new.leave_type_id, 'everyone', 0, true);
    return new;
end;
$$;

drop trigger if exists trg_leave_types_create_approval_rule on public.leave_types;
create trigger trg_leave_types_create_approval_rule
    after insert on public.leave_types
    for each row
    execute function public.create_default_leave_type_approval_rule();


-- ---------------------------------------------------------------------
-- Retire the old leave_type_policies table and the objects that only
-- existed to serve it. This is destructive to whatever remains in that
-- table (should just be leave_type_id by this point — see the migration
-- note up top). CASCADE also drops its own triggers/indexes/RLS
-- policies, so nothing further to clean up there.
-- ---------------------------------------------------------------------
drop trigger if exists trg_leave_types_create_policy on public.leave_types;
drop function if exists public.create_default_leave_type_policy();
drop function if exists public.enforce_annual_leave_only_service_bonus();
drop table if exists public.leave_type_policies cascade;


-- ---------------------------------------------------------------------
-- Leave statuses: fixed workflow states, unchanged.
-- ---------------------------------------------------------------------
create table if not exists public.leave_statuses (
    status_id           smallint primary key,
    status_name         text not null unique,
    constraint leave_statuses_status_id_check check (status_id in (0, 1, 2, 3))
    -- 0 = pending, 1 = approved, 2 = rejected, 3 = cancelled
);

insert into public.leave_statuses (status_id, status_name) values
    (0, 'pending'),
    (1, 'approved'),
    (2, 'rejected'),
    (3, 'cancelled')
on conflict (status_id) do nothing;


-- ---------------------------------------------------------------------
-- Leave requests — UNCHANGED structurally from before.
-- ---------------------------------------------------------------------
create table if not exists public.leave_requests (
    id                  uuid primary key default gen_random_uuid(),
    employee_id         uuid not null references public.employees (id) on delete cascade,
    leave_type_id       integer not null references public.leave_types (leave_type_id),
    start_date          date not null,
    start_half_day      text not null default 'full',
    end_date            date not null,
    end_half_day        text not null default 'full',
    total_days          numeric(4,1) not null default 0,
    total_days_manual   boolean not null default false,
    reason              text,
    status              smallint not null default 0 references public.leave_statuses (status_id),
    requested_by        uuid not null references public.employees (id),
    approved_by         uuid references public.employees (id),
    approved_at         timestamptz,
    rejection_reason    text,
    review_comment      text,
    modified_by         uuid references public.employees (id),
    last_modified       timestamptz not null default now(),
    created_at          timestamptz not null default now(),
    constraint leave_requests_date_check check (end_date >= start_date),
    constraint leave_requests_start_half_check check (start_half_day in ('full', 'am', 'pm')),
    constraint leave_requests_end_half_check check (end_half_day in ('full', 'am', 'pm')),
    constraint leave_requests_single_day_half_match check (
        start_date <> end_date or not (start_half_day = 'pm' and end_half_day = 'am')
    ),
    constraint leave_requests_rejection_reason_check check (
        status <> 2 or rejection_reason is not null
    )
);

alter table public.leave_requests add column if not exists review_comment text;

-- Who cancelled the request and when — shown in the Approval Progress
-- tracker, like an approver. Set by cancel_leave_request().
alter table public.leave_requests
    add column if not exists cancelled_by uuid references public.employees (id),
    add column if not exists cancelled_at timestamptz;

create index if not exists idx_leave_requests_cancelled_by on public.leave_requests (cancelled_by);

-- One-off backfill for requests cancelled before these columns existed:
-- the audit trigger stamps modified_by / last_modified on every update, so
-- for a cancelled request they identify the canceller unless an admin
-- edited the row afterwards. Only fills rows that are still empty.
update public.leave_requests
set cancelled_by = modified_by,
    cancelled_at = last_modified
where status = 3
  and cancelled_by is null
  and modified_by is not null;

alter table public.leave_requests drop constraint if exists leave_requests_review_comment_len_check;
alter table public.leave_requests add constraint leave_requests_review_comment_len_check
    check (review_comment is null or char_length(review_comment) <= 500);

alter table public.leave_requests add column if not exists total_days_manual boolean not null default false;

alter table public.leave_requests drop constraint if exists leave_requests_single_day_half_match;
alter table public.leave_requests add constraint leave_requests_single_day_half_match check (
    start_date <> end_date or not (start_half_day = 'pm' and end_half_day = 'am')
);

alter table public.leave_requests drop constraint if exists leave_requests_total_days_check;
alter table public.leave_requests add constraint leave_requests_total_days_check
    check (total_days >= 0 and total_days <= 366);

create index if not exists idx_leave_requests_employee_id    on public.leave_requests (employee_id);
create index if not exists idx_leave_requests_leave_type_id  on public.leave_requests (leave_type_id);
create index if not exists idx_leave_requests_status         on public.leave_requests (status);
create index if not exists idx_leave_requests_requested_by   on public.leave_requests (requested_by);
create index if not exists idx_leave_requests_approved_by    on public.leave_requests (approved_by);
create index if not exists idx_leave_requests_start_date     on public.leave_requests (start_date);
create index if not exists idx_leave_requests_end_date       on public.leave_requests (end_date);


-- ---------------------------------------------------------------------
-- Helper: is the current user the DIRECT (first-line) supervisor of
-- this employee?
-- ---------------------------------------------------------------------
create or replace function public.is_supervisor_of(p_employee_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
    select exists (
        select 1
        from public.employees e
        where e.id = p_employee_id
          and e.supervisor_id = public.current_employee_uuid()
    );
$$;

-- ---------------------------------------------------------------------
-- Helper: is the current user the SECOND-LINE manager of this employee?
-- ---------------------------------------------------------------------
create or replace function public.is_second_line_of(p_employee_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
    select exists (
        select 1
        from public.employees e
        where e.id = p_employee_id
          and e.second_line_id = public.current_employee_uuid()
    );
$$;

-- ---------------------------------------------------------------------
-- Helper: is the current user the HEAD OF DEPARTMENT for this
-- employee's department?
-- ---------------------------------------------------------------------
create or replace function public.is_hod_of(p_employee_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
    select exists (
        select 1
        from public.employees e
        join public.departments d on d.dept_id = e.dept_id
        where e.id = p_employee_id
          and d.hod_id = public.current_employee_uuid()
    );
$$;

-- ---------------------------------------------------------------------
-- Helper: can the current (non-admin) user file a leave request on
-- behalf of p_employee_id? Unchanged rule: same department, not
-- themselves, active employees only.
-- ---------------------------------------------------------------------
create or replace function public.can_request_leave_for(p_employee_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
    select exists (
        select 1
        from public.employees me
        join public.employees them on them.id = p_employee_id
        where me.id = public.current_employee_uuid()
          and them.id <> me.id
          and them.dept_id = me.dept_id
          and them.last_day is null
    );
$$;

create or replace function public.list_my_leave_delegates()
returns table (id uuid, name text, employee_id text)
language sql
security definer
stable
set search_path = ''
as $$
    select them.id, them.name, them.employee_id
    from public.employees me
    join public.employees them
      on them.dept_id = me.dept_id
     and them.id <> me.id
     and them.last_day is null
    where me.id = public.current_employee_uuid()
    order by them.name;
$$;

-- ---------------------------------------------------------------------
-- Resolve which approver role(s) are required to review a given
-- request: most specific matching scope wins (employee > position >
-- department > everyone); within that scope, the rule with the highest
-- min_days threshold that the request's total_days still satisfies
-- wins. The returned true roles are sequential steps (first line ->
-- second line -> hod), consumed by generate_leave_request_approval_steps()
-- below to build the actual per-request step rows. Returns no row if
-- the leave type has no matching rule at all (should not happen given
-- the seeded/auto-created 'everyone' default, but callers should treat
-- "no row" as "nobody but an admin can approve").
-- ---------------------------------------------------------------------
create or replace function public.get_leave_approval_requirement(
    p_employee_id   uuid,
    p_leave_type_id integer,
    p_total_days    numeric
)
returns table (
    require_first_line  boolean,
    require_second_line boolean,
    require_hod         boolean
)
language sql
stable
security definer
set search_path = ''
as $$
    select r.require_first_line, r.require_second_line, r.require_hod
    from public.leave_type_approval_rules r
    join public.employees e on e.id = p_employee_id
    where r.leave_type_id = p_leave_type_id
      and r.min_days <= p_total_days
      and (
            (r.scope_type = 'employee'   and r.scope_employee_id = p_employee_id) or
            (r.scope_type = 'position'   and r.scope_post_id = e.post_id) or
            (r.scope_type = 'department' and r.scope_dept_id = e.dept_id) or
            (r.scope_type = 'everyone')
          )
    order by
        case r.scope_type
            when 'employee'   then 1
            when 'position'   then 2
            when 'department' then 3
            else 4
        end,
        r.min_days desc
    limit 1;
$$;

-- ---------------------------------------------------------------------
-- Is this employee currently eligible to USE this leave type at all,
-- per its eligibility_type/eligibility_service_months? Read-only — not
-- wired into any insert/RLS yet, available for the request form to
-- grey out a type the employee can't use yet. (Moved here from
-- 03_policies_schemas.sql now that its config lives on leave_types;
-- 'after_years' renamed to 'after_service', measured in months.)
-- ---------------------------------------------------------------------
create or replace function public.is_employee_eligible_for_leave_type(
    p_employee_id   uuid,
    p_leave_type_id integer,
    p_as_of         date default current_date
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select case lt.eligibility_type
        when 'hired_date'      then true
        when 'after_probation' then p_as_of >= e.probation_end_date
        when 'after_service'   then p_as_of >= e.hired_date + make_interval(months => lt.eligibility_service_months)
        else false
    end
    from public.employees e
    join public.leave_types lt on lt.leave_type_id = p_leave_type_id
    where e.id = p_employee_id;
$$;

-- ---------------------------------------------------------------------
-- list_leave_approvers() / list_leave_requesters() — UNCHANGED.
-- ---------------------------------------------------------------------
drop function if exists public.list_leave_approvers();

create function public.list_leave_approvers()
returns table (
    out_employee        uuid,
    out_supervisor      uuid,
    out_supervisor_name text,
    out_supervisor_code text
)
language sql
stable
security definer
set search_path = ''
as $$
    select e.id, s.id, s.name, s.employee_id
      from public.employees e
      join public.employees s on s.id = e.supervisor_id
     where public.current_employee_uuid() is not null
       and (
            e.id = public.current_employee_uuid()
         or public.is_admin()
         or e.id in (select public.my_team_ids())
         or exists (
                select 1
                  from public.leave_requests lr
                 where lr.employee_id = e.id
                   and lr.requested_by = public.current_employee_uuid()
            )
       );
$$;

drop function if exists public.list_leave_requesters();

create function public.list_leave_requesters()
returns table (
    out_request         uuid,
    out_requester       uuid,
    out_requester_name  text,
    out_requester_code  text
)
language sql
stable
security definer
set search_path = ''
as $$
    select lr.id, req.id, req.name, req.employee_id
      from public.leave_requests lr
      join public.employees req on req.id = lr.requested_by
     where public.current_employee_uuid() is not null
       and lr.employee_id = public.current_employee_uuid()
       and lr.requested_by <> lr.employee_id;
$$;


-- ---------------------------------------------------------------------
-- Employees RLS: let a supervisor read their direct reports' row.
-- UNCHANGED.
-- ---------------------------------------------------------------------
drop policy if exists "leaves_employees_select_direct_reports" on public.employees;
create policy "leaves_employees_select_direct_reports" on public.employees
    for select to authenticated
    using (public.is_supervisor_of(id));


-- ---------------------------------------------------------------------
-- Trigger: enforce who a request is for / who submitted it, handle
-- admin-creates-for-someone-else auto-approval, AND (new) enforce
-- back-date / prior-notice limits from leave_types. Fires on INSERT
-- (full defaulting) and on UPDATE of start_date/leave_type_id (so an
-- edit to a still-pending request can't sneak past the same date
-- gates) — the routing/requested_by/status defaulting below only
-- applies to inserts.
-- ---------------------------------------------------------------------
create or replace function public.set_leave_request_defaults()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_requires_approval boolean;
    v_allow_backdate    boolean;
    v_backdate_days     smallint;
    v_require_prior     boolean;
    v_prior_days        smallint;
begin
    select coalesce(lt.requires_approval, true),
           coalesce(lt.allow_backdate, false),
           coalesce(lt.backdate_days, 0),
           coalesce(lt.require_prior_notice, false),
           lt.prior_notice_days
      into v_requires_approval, v_allow_backdate, v_backdate_days, v_require_prior, v_prior_days
    from public.leave_types lt
    where lt.leave_type_id = new.leave_type_id;

    -- Back-date / prior-notice limits only gate self-service
    -- submissions and edits — an admin bypasses both, same pattern used
    -- for the admin-manual-total_days override elsewhere in this file.
    if not public.is_admin() then
        if not v_allow_backdate and new.start_date < current_date then
            raise exception 'This leave type does not allow back-dated requests';
        elsif v_allow_backdate and new.start_date < current_date - v_backdate_days then
            raise exception 'This leave type allows back-dating at most % day(s)', v_backdate_days;
        end if;

        if v_require_prior and new.start_date < current_date + v_prior_days then
            raise exception 'This leave type requires at least % day(s) advance notice', v_prior_days;
        end if;
    end if;

    if tg_op = 'UPDATE' then
        -- A plain edit of a still-pending row: only the date gate above
        -- applies here — routing/status fields are untouched.
        return new;
    end if;

    new.requested_by := public.current_employee_uuid();
    new.review_comment := null;

    if not public.is_admin() then
        if new.employee_id is null or new.employee_id = public.current_employee_uuid() then
            new.employee_id := public.current_employee_uuid();
        elsif not public.can_request_leave_for(new.employee_id) then
            raise exception 'You can only file leave for yourself or someone in your department';
        end if;

        if v_requires_approval then
            new.status       := 0;
            new.approved_by  := null;
            new.approved_at  := null;
        else
            new.status       := 1;
            new.approved_by  := null;
            new.approved_at  := now();
        end if;
    else
        if new.employee_id <> public.current_employee_uuid() then
            new.status      := 1;
            new.approved_by := public.current_employee_uuid();
            new.approved_at := now();
        elsif v_requires_approval then
            new.status      := 0;
            new.approved_by := null;
            new.approved_at := null;
        else
            new.status      := 1;
            new.approved_by := null;
            new.approved_at := now();
        end if;
    end if;
    return new;
end;
$$;

drop trigger if exists trg_leave_requests_defaults on public.leave_requests;
create trigger trg_leave_requests_defaults
    before insert or update of start_date, leave_type_id on public.leave_requests
    for each row
    execute function public.set_leave_request_defaults();


-- ---------------------------------------------------------------------
-- Gender restriction (leave_types.allowed_gender_id, e.g. Maternity Leave
-- = female only). HARD rule: applies to everyone, admins included, and to
-- requests filed on someone's behalf — it checks the employee the leave
-- is FOR (new.employee_id), not the person filing it.
-- ---------------------------------------------------------------------
create or replace function public.is_leave_type_allowed_for_employee(
    p_employee_id   uuid,
    p_leave_type_id integer
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select lt.allowed_gender_id is null or lt.allowed_gender_id = e.gender
    from public.employees e
    join public.leave_types lt on lt.leave_type_id = p_leave_type_id
    where e.id = p_employee_id;
$$;

-- RPC for the UI: ids of the leave types this employee may pick. Types not
-- in the list are hidden completely. A type is listed when
--   - the gender restriction allows it (hard rule, everyone), AND
--   - the employee is eligible for it as of p_as_of (eligibility_type /
--     eligibility_service_months) — admins are exempt, as they may
--     override eligibility when filing.
-- p_as_of = the request's start date, so leave can still be booked ahead
-- for a date after probation / the service period ends (matches the
-- submit trigger). An unknown eligibility (NULL) never hides a type.
-- Same visibility rule as get_leave_cap_usage(): yourself, someone you can
-- file for, anyone in your team (1st/2nd line, HOD, and below), or admin.
drop function if exists public.list_allowed_leave_type_ids(uuid);
create or replace function public.list_allowed_leave_type_ids(
    p_employee_id uuid,
    p_as_of       date default current_date
)
returns table (out_leave_type_id integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    if not coalesce(
        public.is_admin()
        or p_employee_id = public.current_employee_uuid()
        or public.can_request_leave_for(p_employee_id)
        or p_employee_id in (select public.my_team_ids()),
        false
    ) then
        raise exception 'Not allowed' using errcode = '42501';
    end if;

    return query
        select lt.leave_type_id
        from public.leave_types lt
        where public.is_leave_type_allowed_for_employee(p_employee_id, lt.leave_type_id)
          and (public.is_admin()
               or public.is_employee_eligible_for_leave_type(p_employee_id, lt.leave_type_id, p_as_of) is not false);
end;
$$;

create or replace function public.enforce_leave_type_gender()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_type   text;
    v_gender text;
begin
    if public.is_leave_type_allowed_for_employee(new.employee_id, new.leave_type_id) is not false then
        return new;
    end if;

    select lt.leave_type, g.gender_name
      into v_type, v_gender
    from public.leave_types lt
    join public.genders g on g.gender_id = lt.allowed_gender_id
    where lt.leave_type_id = new.leave_type_id;

    raise exception '% is only available to % employees', v_type, v_gender;
end;
$$;

-- Name sorts after trg_leave_requests_defaults, so employee_id is already
-- defaulted when this runs.
drop trigger if exists trg_leave_requests_gender_restriction on public.leave_requests;
create trigger trg_leave_requests_gender_restriction
    before insert or update of employee_id, leave_type_id on public.leave_requests
    for each row
    execute function public.enforce_leave_type_gender();


-- ---------------------------------------------------------------------
-- Trigger: compute total_days.
-- Public holidays (public.holidays, created in 05_calendar_schemas.sql) count
-- as 0 days, except for count_calendar_days types (Maternity Leave).
-- ---------------------------------------------------------------------
create or replace function public.calculate_leave_request_total_days()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_calendar boolean;
begin
    if new.total_days_manual and public.is_admin() then
        return new;
    end if;

    new.total_days_manual := false;

    -- Leave types with count_calendar_days (e.g. Maternity Leave) count
    -- every calendar day as a whole day instead of following the weekly
    -- working pattern, holidays included; half-day boundaries work the same
    -- way. All other types count a public holiday as 0.
    select coalesce(lt.count_calendar_days, false) into v_calendar
    from public.leave_types lt
    where lt.leave_type_id = new.leave_type_id;

    select coalesce(sum(
               case
                   when d.leave_day <> new.start_date and d.leave_day <> new.end_date
                     then w.working_value

                   when d.leave_day = new.start_date and d.leave_day = new.end_date
                     then case when new.start_half_day <> 'pm' and new.end_half_day <> 'am'
                               then w.working_value
                               else least(w.working_value, 0.5)
                          end

                   when d.leave_day = new.start_date
                     then case when new.start_half_day <> 'pm'
                               then w.working_value
                               else least(w.working_value, 0.5)
                          end

                   else
                     case when new.end_half_day <> 'am'
                          then w.working_value
                          else least(w.working_value, 0.5)
                     end
               end
           ), 0)
      into new.total_days
      from (
            select new.start_date + g.i as leave_day
              from generate_series(0, new.end_date - new.start_date) as g(i)
           ) d
      join lateral (
            select case when coalesce(v_calendar, false) then 1::numeric
                        when exists (select 1 from public.holidays h where h.date = d.leave_day) then 0::numeric
                        else pw.working_value
                   end as working_value
            from public.policy_weekly_working_days pw
            where pw.day_of_week = extract(isodow from d.leave_day)::smallint
           ) w on true;

    return new;
end;
$$;

drop trigger if exists trg_leave_requests_calc_total_days on public.leave_requests;
create trigger trg_leave_requests_calc_total_days
    before insert or update of
        leave_type_id,
        start_date, end_date, start_half_day, end_half_day,
        total_days, total_days_manual
    on public.leave_requests
    for each row
    execute function public.calculate_leave_request_total_days();


-- ---------------------------------------------------------------------
-- Audit triggers.
-- ---------------------------------------------------------------------
drop trigger if exists trg_leave_types_audit on public.leave_types;
create trigger trg_leave_types_audit
    before insert or update on public.leave_types
    for each row
    execute function public.track_audit_columns();

drop trigger if exists trg_leave_requests_audit on public.leave_requests;
create trigger trg_leave_requests_audit
    before insert or update on public.leave_requests
    for each row
    execute function public.track_audit_columns();


-- ---------------------------------------------------------------------
-- Per-request approval steps. One row per required step, generated
-- automatically right after the request is inserted (or after certain
-- edits to a still-pending request — see the trigger below). The
-- "current step" is always the lowest step_no still at status = 0
-- (pending) — that's the only step anyone (other than an admin) may
-- act on. Reuses public.leave_statuses for the status codes (0 pending
-- / 1 approved / 2 rejected / 3 cancelled).
-- ---------------------------------------------------------------------
create table if not exists public.leave_request_approvals (
    id                 bigserial primary key,
    leave_request_id   uuid not null references public.leave_requests (id) on delete cascade,
    step_no            smallint not null,             -- 1, 2, 3 ... fixed order: first_line -> second_line -> hod
    approver_role      text not null,                 -- 'first_line' | 'second_line' | 'hod'
    status             smallint not null default 0 references public.leave_statuses (status_id),
                                                       -- 0 pending (current if lowest step_no), 1 approved, 2 rejected, 3 cancelled
    approved_by        uuid references public.employees (id),
    approved_at        timestamptz,
    rejection_reason   text,
    comment            text,
    created_at         timestamptz not null default now(),
    constraint leave_request_approvals_role_check check (
        approver_role in ('first_line', 'second_line', 'hod')
    ),
    constraint leave_request_approvals_comment_len_check check (
        comment is null or char_length(comment) <= 500
    ),
    constraint leave_request_approvals_unique unique (leave_request_id, step_no)
);

create index if not exists idx_leave_request_approvals_request_id     on public.leave_request_approvals (leave_request_id);
create index if not exists idx_leave_request_approvals_request_status on public.leave_request_approvals (leave_request_id, status);
create index if not exists idx_leave_request_approvals_approved_by    on public.leave_request_approvals (approved_by);

-- (Re)generate the approval steps for a request. Fires after insert,
-- and after an edit to a still-pending request that could change which
-- rule applies (employee, leave type, dates/half-days, or the computed
-- total_days). Never touches a request that's already been decided
-- (status <> 0), and never rebuilds steps once any step already has a
-- recorded decision — so an unrelated later edit can't wipe out
-- approval history mid-flight.
create or replace function public.generate_leave_request_approval_steps()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_requires_approval    boolean;
    v_require_first_line   boolean;
    v_require_second_line  boolean;
    v_require_hod          boolean;
    v_has_progress         boolean;
    v_step                 smallint := 0;
begin
    if new.status <> 0 then
        return new; -- already decided (or auto-approved on insert) — nothing to generate
    end if;

    select exists (
        select 1 from public.leave_request_approvals
        where leave_request_id = new.id and status <> 0
    ) into v_has_progress;

    if v_has_progress then
        return new; -- don't disturb a workflow already in progress
    end if;

    delete from public.leave_request_approvals where leave_request_id = new.id;

    select requires_approval into v_requires_approval
    from public.leave_types
    where leave_type_id = new.leave_type_id;

    if not coalesce(v_requires_approval, true) then
        return new; -- this leave type skips review entirely: zero steps
    end if;

    select require_first_line, require_second_line, require_hod
      into v_require_first_line, v_require_second_line, v_require_hod
    from public.get_leave_approval_requirement(new.employee_id, new.leave_type_id, new.total_days);

    if v_require_first_line is null then
        -- No leave_type_approval_rules row matched at all (e.g. an
        -- admin deleted every rule for this type) — fall back to
        -- first-line-only so the request never becomes permanently
        -- unapprovable by anyone but an admin.
        v_require_first_line  := true;
        v_require_second_line := false;
        v_require_hod         := false;
    end if;

    if v_require_first_line then
        v_step := v_step + 1;
        insert into public.leave_request_approvals (leave_request_id, step_no, approver_role)
        values (new.id, v_step, 'first_line');
    end if;
    if v_require_second_line then
        v_step := v_step + 1;
        insert into public.leave_request_approvals (leave_request_id, step_no, approver_role)
        values (new.id, v_step, 'second_line');
    end if;
    if v_require_hod then
        v_step := v_step + 1;
        insert into public.leave_request_approvals (leave_request_id, step_no, approver_role)
        values (new.id, v_step, 'hod');
    end if;

    return new;
end;
$$;

drop trigger if exists trg_leave_requests_generate_approval_steps on public.leave_requests;
create trigger trg_leave_requests_generate_approval_steps
    after insert or update of
        employee_id, leave_type_id,
        start_date, end_date, start_half_day, end_half_day, total_days
    on public.leave_requests
    for each row
    execute function public.generate_leave_request_approval_steps();


-- =====================================================================
-- REVIEW / CANCEL / COMMENT (SECURITY DEFINER) — resolve and act on the
-- CURRENT step (lowest step_no still pending) rather than the request
-- directly.
-- =====================================================================
create or replace function public.review_leave_request(
    p_request_id       uuid,
    p_decision         text,
    p_rejection_reason text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_employee_id uuid;
    v_status      smallint;
    v_step        record;
    v_can_review  boolean;
    v_remaining   integer;
begin
    select employee_id, status into v_employee_id, v_status
    from public.leave_requests
    where id = p_request_id;

    if v_employee_id is null then
        raise exception 'Leave request not found';
    end if;

    if v_status <> 0 then
        raise exception 'Only pending requests can be reviewed';
    end if;

    select * into v_step
    from public.leave_request_approvals
    where leave_request_id = p_request_id and status = 0
    order by step_no
    limit 1;

    if v_step.id is null then
        raise exception 'This request has no pending approval step';
    end if;

    v_can_review := case v_step.approver_role
        when 'first_line'  then public.is_supervisor_of(v_employee_id)
        when 'second_line' then public.is_second_line_of(v_employee_id)
        when 'hod'         then public.is_hod_of(v_employee_id)
        else false
    end;

    if not (public.is_admin() or v_can_review) then
        raise exception 'Only the designated % approver or an admin can review this request', v_step.approver_role;
    end if;

    if p_decision = 'approved' then
        update public.leave_request_approvals
        set status      = 1,
            approved_by = public.current_employee_uuid(),
            approved_at = now()
        where id = v_step.id;

        select count(*) into v_remaining
        from public.leave_request_approvals
        where leave_request_id = p_request_id and status = 0;

        if v_remaining = 0 then
            update public.leave_requests
            set status      = 1,
                approved_by = public.current_employee_uuid(),
                approved_at = now()
            where id = p_request_id;
        end if;
        -- else: overall status stays 0 (pending) — next step is now current.

    elsif p_decision = 'rejected' then
        if p_rejection_reason is null or trim(p_rejection_reason) = '' then
            raise exception 'A rejection reason is required';
        end if;

        update public.leave_request_approvals
        set status           = 2,
            approved_by      = public.current_employee_uuid(),
            approved_at      = now(),
            rejection_reason = p_rejection_reason
        where id = v_step.id;

        update public.leave_requests
        set status           = 2,
            approved_by      = public.current_employee_uuid(),
            approved_at      = now(),
            rejection_reason = p_rejection_reason
        where id = p_request_id;
    else
        raise exception 'Decision must be "approved" or "rejected", got "%"', p_decision;
    end if;
end;
$$;

create or replace function public.cancel_leave_request(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_employee_id uuid;
    v_status      smallint;
    v_start_date  date;
begin
    select employee_id, status, start_date into v_employee_id, v_status, v_start_date
    from public.leave_requests
    where id = p_request_id;

    if v_employee_id is null then
        raise exception 'Leave request not found';
    end if;

    if not (v_employee_id = public.current_employee_uuid() or public.is_admin()) then
        raise exception 'Only the requester or an admin can cancel this request';
    end if;

    -- Pending: always cancellable. Approved: only while not yet started
    -- (an admin bypasses the date check). Rejected / cancelled: never.
    if v_status = 1 then
        if v_start_date <= current_date and not public.is_admin() then
            raise exception 'Approved leave can only be cancelled before its start date';
        end if;
    elsif v_status <> 0 then
        raise exception 'Only pending or approved requests can be cancelled';
    end if;

    update public.leave_request_approvals
    set status = 3
    where leave_request_id = p_request_id and status = 0;

    update public.leave_requests
    set status       = 3,
        cancelled_by = public.current_employee_uuid(),
        cancelled_at = now()
    where id = p_request_id;
end;
$$;

create or replace function public.set_leave_review_comment(
    p_request_id uuid,
    p_comment    text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_me uuid := public.current_employee_uuid();
    v_id bigint;
begin
    select id into v_id
    from public.leave_request_approvals
    where leave_request_id = p_request_id
      and status = 1
      and approved_by is not distinct from v_me
      and v_me is not null
    order by step_no desc
    limit 1;

    if v_id is null then
        raise exception 'Only an approver of this request can comment on it'
            using errcode = '42501';
    end if;

    update public.leave_request_approvals
    set comment = nullif(btrim(p_comment), '')
    where id = v_id;
end;
$$;


-- ---------------------------------------------------------------------
-- RPC: for each pending request the caller can see, who is the CURRENT
-- step's approver (resolved by name/employee ID from their role) —
-- supersedes list_leave_approvers()'s "supervisor only" assumption for
-- display purposes ("Awaiting <name> (<role>)"). list_leave_approvers()
-- itself is left in place, unchanged, in case anything still calls it.
-- ---------------------------------------------------------------------
drop function if exists public.list_leave_current_approvers();

create function public.list_leave_current_approvers()
returns table (
    out_request        uuid,
    out_step_role      text,
    out_approver_id    uuid,
    out_approver_name  text,
    out_approver_code  text
)
language sql
stable
security definer
set search_path = ''
as $$
    select
        lr.id,
        cur.approver_role,
        coalesce(sup.id, sec.id, hod.id),
        coalesce(sup.name, sec.name, hod.name),
        coalesce(sup.employee_id, sec.employee_id, hod.employee_id)
    from public.leave_requests lr
    join public.employees emp on emp.id = lr.employee_id
    join public.departments dep on dep.dept_id = emp.dept_id
    join lateral (
        select a.approver_role
        from public.leave_request_approvals a
        where a.leave_request_id = lr.id and a.status = 0
        order by a.step_no
        limit 1
    ) cur on true
    left join public.employees sup on cur.approver_role = 'first_line'  and sup.id = emp.supervisor_id
    left join public.employees sec on cur.approver_role = 'second_line' and sec.id = emp.second_line_id
    left join public.employees hod on cur.approver_role = 'hod'         and hod.id = dep.hod_id
    where public.current_employee_uuid() is not null
      and lr.status = 0
      and (
            lr.employee_id = public.current_employee_uuid()
         or lr.requested_by = public.current_employee_uuid()
         or public.is_admin()
         or lr.employee_id in (select public.my_team_ids())
      );
$$;


-- ---------------------------------------------------------------------
-- RPC: approved leave for the shared Calendar page.
-- Everyone can see the APPROVED leave of everyone in their own department
-- (a shared team calendar), plus their own and their team's (see
-- my_team_ids()); admins see everyone. This is deliberately an RPC and
-- not a wider leave_requests SELECT policy: it exposes only what the
-- calendar draws, only for approved leave, so colleagues never get to
-- read each other's pending / rejected / cancelled requests. The free-text
-- reason is included only when the caller is otherwise entitled to see the
-- request (own, filed by them, their team, or admin) — otherwise it is null.
-- out_count_calendar_days tells the calendar whether the leave type counts
-- every calendar day (e.g. Maternity) — the calendar uses it to decide
-- whether holidays / non-working days inside the leave are drawn.
-- ---------------------------------------------------------------------
drop function if exists public.list_calendar_leave(date, date);

create function public.list_calendar_leave(p_from date, p_to date)
returns table (
    out_id               uuid,
    out_created_at       timestamptz,
    out_approved_at      timestamptz,
    out_approver_name    text,
    out_employee_id      uuid,
    out_employee_name    text,
    out_employee_code    text,
    out_start_date       date,
    out_start_half_day   text,
    out_end_date         date,
    out_end_half_day     text,
    out_leave_type_id    integer,
    out_leave_type       text,
    out_total_days       numeric,
    out_reason           text,
    out_count_calendar_days boolean
)
language sql
stable
security definer
set search_path = ''
as $$
    with me as (
        select e.id, e.dept_id
        from public.employees e
        where e.id = public.current_employee_uuid()
    ),
    team as (
        select t as id from public.my_team_ids() t
    )
    select
        lr.id,
        lr.created_at,
        lr.approved_at,
        ap.name,
        lr.employee_id,
        emp.name,
        emp.employee_id,
        lr.start_date,
        lr.start_half_day,
        lr.end_date,
        lr.end_half_day,
        lr.leave_type_id,
        lt.leave_type,
        lr.total_days,
        case
            when public.is_admin()
              or lr.employee_id  = (select id from me)
              or lr.requested_by = (select id from me)
              or lr.employee_id in (select id from team)
            then lr.reason
        end,
        coalesce(lt.count_calendar_days, false)
    from public.leave_requests lr
    join public.employees   emp on emp.id = lr.employee_id
    join public.leave_types lt  on lt.leave_type_id = lr.leave_type_id
    left join public.employees ap on ap.id = lr.approved_by
    where lr.status = 1
      and lr.start_date <= p_to
      and lr.end_date   >= p_from
      and exists (select 1 from me)
      and (
            public.is_admin()
         or lr.employee_id = (select id from me)
         or emp.dept_id    = (select dept_id from me)
         or lr.employee_id in (select id from team)
      );
$$;

revoke all on function public.list_calendar_leave(date, date) from public, anon;
grant execute on function public.list_calendar_leave(date, date) to authenticated, service_role;


-- =====================================================================
-- ROW LEVEL SECURITY
-- =====================================================================
alter table public.leave_types                 enable row level security;
alter table public.leave_type_proration_tiers   enable row level security;
alter table public.leave_type_approval_rules    enable row level security;
alter table public.leave_statuses               enable row level security;
alter table public.leave_requests               enable row level security;
alter table public.leave_request_approvals      enable row level security;

drop policy if exists "lookup_read_leave_types" on public.leave_types;
create policy "lookup_read_leave_types" on public.leave_types
    for select to authenticated using (true);
drop policy if exists "lookup_write_leave_types" on public.leave_types;
create policy "lookup_write_leave_types" on public.leave_types
    for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "leave_type_proration_tiers_read" on public.leave_type_proration_tiers;
create policy "leave_type_proration_tiers_read" on public.leave_type_proration_tiers
    for select to authenticated using (true);
drop policy if exists "leave_type_proration_tiers_admin_write" on public.leave_type_proration_tiers;
create policy "leave_type_proration_tiers_admin_write" on public.leave_type_proration_tiers
    for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "leave_type_approval_rules_read" on public.leave_type_approval_rules;
create policy "leave_type_approval_rules_read" on public.leave_type_approval_rules
    for select to authenticated using (true);
drop policy if exists "leave_type_approval_rules_admin_write" on public.leave_type_approval_rules;
create policy "leave_type_approval_rules_admin_write" on public.leave_type_approval_rules
    for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "lookup_read_leave_statuses" on public.leave_statuses;
create policy "lookup_read_leave_statuses" on public.leave_statuses
    for select to authenticated using (true);

drop policy if exists "leave_requests_select" on public.leave_requests;
create policy "leave_requests_select" on public.leave_requests
    for select to authenticated
    using (
        employee_id = public.current_employee_uuid()
        or requested_by = public.current_employee_uuid()
        or public.is_admin()
        -- Read-only visibility for approvers: everyone in my hierarchy —
        -- 1st line, 2nd line, HOD of the department, and the people below
        -- them (see public.my_team_ids() in 01_employee_info_schema.sql).
        -- Approving/rejecting is NOT widened by this; it stays with the
        -- approval-chain checks in review_leave_request().
        or employee_id in (select public.my_team_ids())
    );

drop policy if exists "leave_requests_insert" on public.leave_requests;
create policy "leave_requests_insert" on public.leave_requests
    for insert to authenticated
    with check (
        employee_id = public.current_employee_uuid()
        or public.can_request_leave_for(employee_id)
        or public.is_admin()
    );

drop policy if exists "leave_requests_self_update" on public.leave_requests;
create policy "leave_requests_self_update" on public.leave_requests
    for update to authenticated
    using (
        employee_id = public.current_employee_uuid()
        and status = 0
    )
    with check (
        employee_id = public.current_employee_uuid()
        and status = 0
    );

drop policy if exists "leave_requests_admin_update" on public.leave_requests;
create policy "leave_requests_admin_update" on public.leave_requests
    for update to authenticated
    using (public.is_admin())
    with check (public.is_admin());

drop policy if exists "leave_requests_admin_delete" on public.leave_requests;
create policy "leave_requests_admin_delete" on public.leave_requests
    for delete to authenticated
    using (public.is_admin());

-- leave_request_approvals: read follows the same visibility as the
-- parent request (self, requester, first line, second line, HOD, or
-- admin) — no separate insert/update/delete policy for regular users,
-- since all writes go through the SECURITY DEFINER functions above and
-- the step-generating trigger.
drop policy if exists "leave_request_approvals_select" on public.leave_request_approvals;
create policy "leave_request_approvals_select" on public.leave_request_approvals
    for select to authenticated
    using (
        exists (
            select 1 from public.leave_requests lr
            where lr.id = leave_request_approvals.leave_request_id
              and (
                    lr.employee_id = public.current_employee_uuid()
                 or lr.requested_by = public.current_employee_uuid()
                 or public.is_admin()
                 or lr.employee_id in (select public.my_team_ids())
              )
        )
    );

drop policy if exists "leave_request_approvals_admin_write" on public.leave_request_approvals;
create policy "leave_request_approvals_admin_write" on public.leave_request_approvals
    for all to authenticated
    using (public.is_admin())
    with check (public.is_admin());


-- =====================================================================
-- GRANTS
-- =====================================================================
grant select, insert, update, delete on
    public.leave_types,
    public.leave_type_proration_tiers,
    public.leave_type_approval_rules,
    public.leave_statuses,
    public.leave_requests,
    public.leave_request_approvals
to authenticated, service_role;

grant usage, select on
    public.leave_types_leave_type_id_seq,
    public.leave_type_proration_tiers_id_seq,
    public.leave_type_approval_rules_id_seq,
    public.leave_request_approvals_id_seq
to authenticated, service_role;

revoke all on function public.policy_month_day_is_valid(smallint, smallint)          from public, anon;
revoke all on function public.is_supervisor_of(uuid)                                 from public, anon;
revoke all on function public.is_second_line_of(uuid)                                from public, anon;
revoke all on function public.is_hod_of(uuid)                                        from public, anon;
revoke all on function public.can_request_leave_for(uuid)                            from public, anon;
revoke all on function public.list_my_leave_delegates()                              from public, anon;
revoke all on function public.get_leave_approval_requirement(uuid, integer, numeric)  from public, anon;
revoke all on function public.is_employee_eligible_for_leave_type(uuid, integer, date) from public, anon;
revoke all on function public.is_leave_type_allowed_for_employee(uuid, integer)             from public, anon, authenticated;   -- internal: used by the gender trigger only
revoke all on function public.list_allowed_leave_type_ids(uuid, date)                        from public, anon;
revoke all on function public.list_leave_approvers()                                 from public, anon;
revoke all on function public.list_leave_requesters()                                from public, anon;
revoke all on function public.list_leave_current_approvers()                         from public, anon;
revoke all on function public.review_leave_request(uuid, text, text)                 from public, anon;
revoke all on function public.cancel_leave_request(uuid)                             from public, anon;
revoke all on function public.set_leave_review_comment(uuid, text)                   from public, anon;

grant execute on function public.policy_month_day_is_valid(smallint, smallint)          to authenticated, service_role;
grant execute on function public.is_supervisor_of(uuid)                                 to authenticated, service_role;
grant execute on function public.is_second_line_of(uuid)                                to authenticated, service_role;
grant execute on function public.is_hod_of(uuid)                                        to authenticated, service_role;
grant execute on function public.can_request_leave_for(uuid)                            to authenticated, service_role;
grant execute on function public.list_my_leave_delegates()                              to authenticated, service_role;
grant execute on function public.get_leave_approval_requirement(uuid, integer, numeric)  to authenticated, service_role;
grant execute on function public.is_employee_eligible_for_leave_type(uuid, integer, date) to authenticated, service_role;
grant execute on function public.list_allowed_leave_type_ids(uuid, date)                        to authenticated, service_role;
grant execute on function public.list_leave_approvers()                                 to authenticated, service_role;
grant execute on function public.list_leave_requesters()                                to authenticated, service_role;
grant execute on function public.list_leave_current_approvers()                         to authenticated, service_role;
grant execute on function public.review_leave_request(uuid, text, text)                 to authenticated, service_role;
grant execute on function public.cancel_leave_request(uuid)                             to authenticated, service_role;
grant execute on function public.set_leave_review_comment(uuid, text)                   to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Realtime: publish this file's tables (see ess_enable_realtime in 01)
-- ---------------------------------------------------------------------
select public.ess_enable_realtime(array['leave_types', 'leave_requests', 'leave_request_approvals']);
