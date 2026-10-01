-- =====================================================================
-- Employee Leave Management System — Company-Wide Policy Schema
-- Target: Supabase (PostgreSQL), public schema
--
-- Backs the admin "Policies" page (policies.html), COMPANY-WIDE rules
-- only:
--   * policy_settings              standard monthly working days,
--                                   yearly cut-off date
--   * policy_weekly_working_days   Mon-Sun: 0 = day off, 0.5 = half
--                                   day, 1 = full day
--   * request cap for leave types with NO entitlement (last section of
--     this file): entitlement_days = 0 types can be requested up to
--     leave_types.max_negative_days per leave year. It lives here, not
--     in 02, because it reads policy_settings (the leave-year cut-off).
--
-- It also carries the FIXES to the sequential leave approval chain
-- (first line -> second line -> head of department) defined in 02 — see
-- the last section of this file. They live here, not in 02, so 02 stays
-- untouched; because this file always runs after 02, the fixes below
-- are never lost when 02 is re-run and this file is run again.
--
-- Everything PER LEAVE TYPE (entitlement, proration, service bonus,
-- negative balance, carry forward, approval routing, prior notice,
-- back-date) now lives directly on public.leave_types in
-- 02_leaves_schema.sql — see that file's header for details. The old
-- leave_type_policies / leave_type_proration_tiers tables that used to
-- live in THIS file have been retired / moved there; nothing of that
-- kind is defined here anymore.
--
-- Depends on 01_employee_info_schema.sql and 02_leaves_schema.sql
-- having already run. Reused, NOT redefined here:
--   public.employees, public.is_admin(), public.current_employee_uuid(),
--   public.track_audit_columns()             (from 01)
--   public.leave_types, public.leave_requests, public.is_supervisor_of(),
--   public.can_request_leave_for()           (from 02 — used by the
--                                              request-cap section)
--   public.is_second_line_of(), public.is_hod_of(),
--   public.leave_request_approvals,
--   public.get_leave_approval_requirement()  (from 02 — used by the
--                                              approval-chain section)
--   public.policy_month_day_is_valid()       (from 02 — moved there
--                                              because leave_types'
--                                              carry-forward-expiry
--                                              check needs it, and 02
--                                              runs before this file)
--
-- Fresh setup:  run 01, then 02, then this file.
-- Existing DB:  just run this file. It only touches policy_settings,
--               policy_weekly_working_days, the request-cap functions
--               / trigger on leave_requests, and the approval-chain
--               section (RLS policies, review_leave_request(),
--               list_leave_approval_steps(), one-time step backfill),
--               and never overwrites values
--               an admin has already changed on the Policies page.
--
-- Re-running this script: fully idempotent (IF NOT EXISTS / CREATE OR
-- REPLACE / DROP...IF EXISTS + CREATE, seed data via
-- ON CONFLICT DO NOTHING).
--
-- Access model:
--   - Any signed-in user can READ these tables.
--   - Only admins can WRITE.
--   - Both tables are fixed-shape (one row / seven rows, seeded below):
--     admins UPDATE them, nobody inserts or deletes.
--
-- Month/day dates (yearly cut-off): stored as separate month (1-12) +
-- day columns rather than a date, because they recur every year
-- ("31-Dec", "30-Jun"). Feb 29 is not allowed (max 28 for February) so
-- the date exists in every year.
--   Yearly cut-off = the LAST day of a leave year (yearly cycle).
--     31-Dec -> cycle runs 1 Jan  to 31 Dec
--     30-Jun -> cycle runs 1 Jul  to 30 Jun
--
-- Who reads these settings: the weekly working pattern drives
-- leave_requests.total_days (02); the yearly cut-off and standard
-- monthly working days drive the balance ledger in
-- 04_leave_balance_ledger.sql (leave cycle bounds, proration divisor).
-- =====================================================================


-- ---------------------------------------------------------------------
-- Company-wide settings (single row)
-- ---------------------------------------------------------------------
create table if not exists public.policy_settings (
    id                              smallint primary key default 1,
    standard_monthly_working_days   numeric(4,1) not null default 22,
    year_cutoff_month               smallint not null default 12,
    year_cutoff_day                 smallint not null default 31,
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
    day_of_week         smallint primary key,
    day_name            text not null unique,
    working_value       numeric(2,1) not null default 0,
    modified_by         uuid references public.employees (id),
    last_modified       timestamptz not null default now(),
    constraint policy_weekly_day_of_week_check check (day_of_week between 1 and 7),
    constraint policy_weekly_working_value_check check (working_value in (0, 0.5, 1))
);

insert into public.policy_weekly_working_days (day_of_week, day_name, working_value) values
    (1, 'Monday',    1),
    (2, 'Tuesday',   1),
    (3, 'Wednesday', 1),
    (4, 'Thursday',  1),
    (5, 'Friday',    1),
    (6, 'Saturday',  0),
    (7, 'Sunday',    0)
on conflict (day_of_week) do nothing;

create index if not exists idx_policy_settings_modified_by            on public.policy_settings (modified_by);
create index if not exists idx_policy_weekly_working_days_modified_by on public.policy_weekly_working_days (modified_by);


-- ---------------------------------------------------------------------
-- Audit triggers — reuse track_audit_columns() from file 01.
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


-- =====================================================================
-- ROW LEVEL SECURITY
-- =====================================================================
alter table public.policy_settings             enable row level security;
alter table public.policy_weekly_working_days  enable row level security;

drop policy if exists "policy_settings_read" on public.policy_settings;
create policy "policy_settings_read" on public.policy_settings
    for select to authenticated using (true);
drop policy if exists "policy_settings_admin_update" on public.policy_settings;
create policy "policy_settings_admin_update" on public.policy_settings
    for update to authenticated
    using (public.is_admin())
    with check (public.is_admin());

drop policy if exists "policy_weekly_working_days_read" on public.policy_weekly_working_days;
create policy "policy_weekly_working_days_read" on public.policy_weekly_working_days
    for select to authenticated using (true);
drop policy if exists "policy_weekly_working_days_admin_update" on public.policy_weekly_working_days;
create policy "policy_weekly_working_days_admin_update" on public.policy_weekly_working_days
    for update to authenticated
    using (public.is_admin())
    with check (public.is_admin());


-- =====================================================================
-- GRANTS
-- =====================================================================
grant select, insert, update, delete on
    public.policy_settings,
    public.policy_weekly_working_days
to authenticated, service_role;

-- =====================================================================
-- REQUEST CAP FOR LEAVE TYPES WITH NO ENTITLEMENT
--
-- Rule: a leave type whose entitlement_days = 0 has no yearly allowance,
-- but can still be requested up to leave_types.max_negative_days days per
-- leave year (the "Maximum negative balance" on the Policies page).
--   * cap = max_negative_days when allow_negative_balance is on. If no
--     maximum is set (negative balance off), there is NO cap: the type
--     can be requested without limit.
--   * leave year = the cycle ending on policy_settings.year_cutoff_*
--     (falls back to 31-Dec if the settings row is missing)
--   * counted: this employee's pending (0) + approved (1) requests of
--     this type whose start_date is in the same leave year, plus the
--     request being saved. A request spanning two leave years counts
--     fully in the year it starts. Cancelled/rejected never count.
--   * applies to everyone, admins included.
--   * types with entitlement_days > 0 are untouched.
--
-- Pieces:
--   leave_cap_usage()                      internal: cap + used + year bounds
--   enforce_no_entitlement_request_cap()   trigger: rejects over-cap requests
--   get_leave_cap_usage()                  RPC for the request form's
--                                          "X of N days used" line
-- =====================================================================

-- Internal helper (not callable by clients). Returns one row for a
-- no-entitlement leave type (out_cap is NULL when no maximum is set =
-- unlimited), zero rows for anything else.
-- VOLATILE on purpose: each query inside gets a fresh snapshot, so the
-- trigger sees requests committed by a concurrent transaction while it
-- waited on the advisory lock.
create or replace function public.leave_cap_usage(
    p_employee_id         uuid,
    p_leave_type_id       integer,
    p_start_date          date,
    p_exclude_request_id  uuid default null
)
returns table (
    out_leave_type  text,
    out_cap         numeric,
    out_used        numeric,
    out_year_start  date,
    out_year_end    date
)
language plpgsql
security definer   -- must see ALL of the employee's requests, not just those RLS exposes to the caller
set search_path = ''
as $$
declare
    v_name        text;
    v_entitlement numeric;
    v_cap         numeric;
    v_allow_cap   boolean;
    v_month       smallint;
    v_day         smallint;
    v_year        integer;
    v_start       date;
    v_end         date;
    v_used        numeric;
begin
    select lt.leave_type, lt.entitlement_days, lt.allow_negative_balance, lt.max_negative_days
      into v_name, v_entitlement, v_allow_cap, v_cap
    from public.leave_types lt
    where lt.leave_type_id = p_leave_type_id;

    if v_entitlement is null or v_entitlement > 0 then
        return;   -- has an entitlement (or unknown type): not this rule's concern
    end if;

    if not v_allow_cap then
        v_cap := null;   -- no maximum set: unlimited
    end if;

    -- Leave year containing the start date.
    select s.year_cutoff_month, s.year_cutoff_day
      into v_month, v_day
    from public.policy_settings s
    where s.id = 1;

    v_month := coalesce(v_month, 12);
    v_day   := coalesce(v_day, 31);
    v_year  := extract(year from p_start_date)::integer;
    if p_start_date > make_date(v_year, v_month, v_day) then
        v_year := v_year + 1;
    end if;
    v_end   := make_date(v_year, v_month, v_day);
    v_start := make_date(v_year - 1, v_month, v_day) + 1;

    select coalesce(sum(lr.total_days), 0)
      into v_used
    from public.leave_requests lr
    where lr.employee_id   = p_employee_id
      and lr.leave_type_id = p_leave_type_id
      and lr.status in (0, 1)
      and lr.start_date between v_start and v_end
      and (p_exclude_request_id is null or lr.id <> p_exclude_request_id);

    return query select v_name, v_cap, v_used, v_start, v_end;
end;
$$;

revoke all on function public.leave_cap_usage(uuid, integer, date, uuid) from public, anon, authenticated;


-- Trigger: reject a request that would push usage over the cap.
create or replace function public.enforce_no_entitlement_request_cap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_name  text;
    v_cap   numeric;
    v_used  numeric;
begin
    if new.status not in (0, 1) then
        return new;   -- rejected / cancelled rows never count against the cap
    end if;

    -- Serialise concurrent requests for the same employee + type so two
    -- simultaneous submits can't both pass the check.
    perform pg_advisory_xact_lock(hashtextextended(new.employee_id::text || ':' || new.leave_type_id::text, 0));

    select u.out_leave_type, u.out_cap, u.out_used
      into v_name, v_cap, v_used
    from public.leave_cap_usage(new.employee_id, new.leave_type_id, new.start_date, new.id) u;

    if not found then
        return new;   -- leave type has an entitlement
    end if;
    -- v_cap null = no maximum set: unlimited, nothing to enforce.

    if v_cap is not null and v_used + new.total_days > v_cap then
        raise exception '% has no entitlement and can be requested for at most % day(s) per leave year (% already taken or pending, % requested)',
            v_name, v_cap, v_used, new.total_days;
    end if;

    return new;
end;
$$;

-- Trigger name sorts after trg_leave_requests_calc_total_days, so
-- total_days is already computed when this runs (BEFORE triggers fire
-- alphabetically). status is deliberately not in the column list: a
-- status change (approve / reject / cancel) never re-checks the cap.
drop trigger if exists trg_leave_requests_no_entitlement_cap on public.leave_requests;
create trigger trg_leave_requests_no_entitlement_cap
    before insert or update of
        employee_id, leave_type_id,
        start_date, end_date, start_half_day, end_half_day,
        total_days, total_days_manual
    on public.leave_requests
    for each row
    execute function public.enforce_no_entitlement_request_cap();


-- RPC for the request form. Same visibility rule as filing/reading the
-- request: yourself, someone you can file for, a direct report, or admin.
-- Zero rows = the leave type has an entitlement (nothing to show).
create or replace function public.get_leave_cap_usage(
    p_employee_id         uuid,
    p_leave_type_id       integer,
    p_start_date          date,
    p_exclude_request_id  uuid default null
)
returns table (
    out_leave_type  text,
    out_cap         numeric,
    out_used        numeric,
    out_year_start  date,
    out_year_end    date
)
language plpgsql
security definer
set search_path = ''
as $$
begin
    -- coalesce: a signed-in user with no linked employee row makes
    -- current_employee_uuid() NULL, which turned this whole condition
    -- (and its NOT) into NULL, so the guard silently passed. NULL now
    -- means "not allowed".
    if not coalesce(
        public.is_admin()
        or p_employee_id = public.current_employee_uuid()
        or public.can_request_leave_for(p_employee_id)
        or public.is_supervisor_of(p_employee_id),
        false
    ) then
        raise exception 'Not allowed' using errcode = '42501';
    end if;

    return query
        select * from public.leave_cap_usage(p_employee_id, p_leave_type_id, p_start_date, p_exclude_request_id);
end;
$$;

revoke all on function public.get_leave_cap_usage(uuid, integer, date, uuid) from public, anon;
grant execute on function public.get_leave_cap_usage(uuid, integer, date, uuid) to authenticated, service_role;

-- =====================================================================
-- LEAVE APPROVAL CHAIN FIXES (first line -> second line -> head of
-- department; one public.leave_request_approvals row per required step,
-- current step = lowest step_no still pending — all defined in 02).
--
--   1. RLS: second line and head of department could not see the
--      requests (or the employee rows) they are supposed to approve —
--      only the first line could.
--   2. review_leave_request(): one person holding several roles for the
--      same request approves ONCE — every pending step they hold is
--      completed by that single approval. Also locks the request row
--      so two simultaneous reviews can't act on the same step.
--   3. list_leave_approval_steps(): every visible request's steps with
--      the expected approver of each step (resolved live from the role)
--      and who acted — feeds "Awaiting <name>" on the Leaves page.
--   4. Backfill: pending requests that have no step rows yet (created
--      before the step machinery existed) get their steps generated,
--      otherwise nobody but an admin could ever act on them.
--
-- Overrides (CREATE OR REPLACE / DROP...CREATE) of objects first defined
-- in 02: leave_requests_select, review_leave_request(). Idempotent.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. RLS — second line and head of department can see what they approve
-- ---------------------------------------------------------------------
drop policy if exists "leave_requests_select" on public.leave_requests;
create policy "leave_requests_select" on public.leave_requests
    for select to authenticated
    using (
        employee_id = public.current_employee_uuid()
        or requested_by = public.current_employee_uuid()
        or public.is_supervisor_of(employee_id)
        or public.is_second_line_of(employee_id)
        or public.is_hod_of(employee_id)
        or public.is_admin()
    );

drop policy if exists "leaves_employees_select_second_line_hod" on public.employees;
create policy "leaves_employees_select_second_line_hod" on public.employees
    for select to authenticated
    using (public.is_second_line_of(id) or public.is_hod_of(id));


-- ---------------------------------------------------------------------
-- 2. review_leave_request() — approve once per person
-- ---------------------------------------------------------------------
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
    v_me          uuid := public.current_employee_uuid();
    v_employee_id uuid;
    v_status      smallint;
    v_step        record;
    v_is_first    boolean;
    v_is_second   boolean;
    v_is_hod      boolean;
    v_can_review  boolean;
    v_remaining   integer;
begin
    -- Lock the request so concurrent reviews are serialised.
    select employee_id, status into v_employee_id, v_status
    from public.leave_requests
    where id = p_request_id
    for update;

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

    -- Every role the caller holds for THIS employee.
    v_is_first  := public.is_supervisor_of(v_employee_id);
    v_is_second := public.is_second_line_of(v_employee_id);
    v_is_hod    := public.is_hod_of(v_employee_id);

    v_can_review := case v_step.approver_role
        when 'first_line'  then v_is_first
        when 'second_line' then v_is_second
        when 'hod'         then v_is_hod
        else false
    end;

    if not (public.is_admin() or v_can_review) then
        raise exception 'Only the designated % approver or an admin can review this request', v_step.approver_role;
    end if;

    if p_decision = 'approved' then
        -- The current step, plus any other pending step whose role the
        -- caller also holds: one person, one approval.
        update public.leave_request_approvals
        set status      = 1,
            approved_by = v_me,
            approved_at = now()
        where leave_request_id = p_request_id
          and status = 0
          and (
                id = v_step.id
             or (approver_role = 'first_line'  and v_is_first)
             or (approver_role = 'second_line' and v_is_second)
             or (approver_role = 'hod'         and v_is_hod)
          );

        select count(*) into v_remaining
        from public.leave_request_approvals
        where leave_request_id = p_request_id and status = 0;

        if v_remaining = 0 then
            update public.leave_requests
            set status      = 1,
                approved_by = v_me,
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
            approved_by      = v_me,
            approved_at      = now(),
            rejection_reason = p_rejection_reason
        where id = v_step.id;

        update public.leave_requests
        set status           = 2,
            approved_by      = v_me,
            approved_at      = now(),
            rejection_reason = p_rejection_reason
        where id = p_request_id;
    else
        raise exception 'Decision must be "approved" or "rejected", got "%"', p_decision;
    end if;
end;
$$;


-- ---------------------------------------------------------------------
-- 3. list_leave_approval_steps() — steps + expected approver per step
--    Same visibility as leave_requests_select. The expected approver is
--    resolved live from the role (employee.supervisor_id /
--    second_line_id / department.hod_id), so it stays correct if the
--    assignment changes. out_expected_id is NULL when nobody holds the
--    role (only an admin can act on that step).
-- ---------------------------------------------------------------------
drop function if exists public.list_leave_approval_steps();

create function public.list_leave_approval_steps()
returns table (
    out_request        uuid,
    out_step_no        smallint,
    out_role           text,
    out_status         smallint,
    out_expected_id    uuid,
    out_expected_name  text,
    out_expected_code  text,
    out_actor_name     text,
    out_actor_code     text,
    out_acted_at       timestamptz,
    out_comment        text
)
language sql
stable
security definer
set search_path = ''
as $$
    select
        a.leave_request_id,
        a.step_no,
        a.approver_role,
        a.status,
        x.id,
        x.name,
        x.employee_id,
        act.name,
        act.employee_id,
        coalesce(a.approved_at, case when a.status = 3 then lr.cancelled_at end),
        a.comment
    from public.leave_request_approvals a
    join public.leave_requests lr  on lr.id  = a.leave_request_id
    join public.employees emp      on emp.id = lr.employee_id
    left join public.departments dep on dep.dept_id = emp.dept_id
    left join public.employees x
           on x.id = case a.approver_role
                         when 'first_line'  then emp.supervisor_id
                         when 'second_line' then emp.second_line_id
                         when 'hod'         then dep.hod_id
                     end
    -- For a cancelled step the "actor" is whoever cancelled the request.
    left join public.employees act
           on act.id = coalesce(a.approved_by, case when a.status = 3 then lr.cancelled_by end)
    where public.current_employee_uuid() is not null
      and (
            lr.employee_id = public.current_employee_uuid()
         or lr.requested_by = public.current_employee_uuid()
         or public.is_supervisor_of(lr.employee_id)
         or public.is_second_line_of(lr.employee_id)
         or public.is_hod_of(lr.employee_id)
         or public.is_admin()
      )
    order by a.leave_request_id, a.step_no;
$$;

revoke all on function public.list_leave_approval_steps() from public, anon;
grant execute on function public.list_leave_approval_steps() to authenticated, service_role;


-- ---------------------------------------------------------------------
-- 4. Backfill steps for pending requests that have none (idempotent:
--    only touches requests with zero step rows).
-- ---------------------------------------------------------------------
do $$
declare
    r          record;
    v_first    boolean;
    v_second   boolean;
    v_hod      boolean;
    v_step     smallint;
begin
    for r in
        select lr.id, lr.employee_id, lr.leave_type_id, lr.total_days
        from public.leave_requests lr
        join public.leave_types lt on lt.leave_type_id = lr.leave_type_id
        where lr.status = 0
          and lt.requires_approval
          and not exists (
                select 1 from public.leave_request_approvals a
                where a.leave_request_id = lr.id
          )
    loop
        v_first := null; v_second := null; v_hod := null;

        select q.require_first_line, q.require_second_line, q.require_hod
          into v_first, v_second, v_hod
        from public.get_leave_approval_requirement(r.employee_id, r.leave_type_id, r.total_days) q;

        if v_first is null then   -- no rule matched: same fallback as generate_leave_request_approval_steps()
            v_first := true; v_second := false; v_hod := false;
        end if;

        v_step := 0;
        if v_first then
            v_step := v_step + 1;
            insert into public.leave_request_approvals (leave_request_id, step_no, approver_role)
            values (r.id, v_step, 'first_line');
        end if;
        if v_second then
            v_step := v_step + 1;
            insert into public.leave_request_approvals (leave_request_id, step_no, approver_role)
            values (r.id, v_step, 'second_line');
        end if;
        if v_hod then
            v_step := v_step + 1;
            insert into public.leave_request_approvals (leave_request_id, step_no, approver_role)
            values (r.id, v_step, 'hod');
        end if;
    end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- Realtime: publish this file's tables (see ess_enable_realtime in 01)
-- ---------------------------------------------------------------------
select public.ess_enable_realtime(array['policy_settings', 'policy_weekly_working_days']);
