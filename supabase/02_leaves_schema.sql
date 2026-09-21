-- =====================================================================
-- Employee Leave Management System — Leave Request Schema
-- Target: Supabase (PostgreSQL), public schema
--
-- SINGLE SOURCE OF TRUTH for everything leave-related. This file now
-- includes what used to live in the separate follow-up scripts:
--   * 04_leave_review_comment.sql   (review_comment + set_leave_review_comment)
--   * 05_leave_approver_names.sql   (list_leave_approvers)
-- Those two files are fully superseded — do NOT run them separately.
--
-- Depends on 01_employee_info_schema.sql having already run:
--   public.employees, public.is_admin(), public.current_employee_uuid(),
--   public.track_audit_columns(), and the default-privileges grants are
--   all reused here, not redefined. This file only adds new objects.
--
-- Also depends on 03_policies_schemas.sql for ONE thing: total_days is
-- calculated from public.policy_weekly_working_days (see "Working-day
-- model" below). 03 in turn needs public.leave_types from this file, so
-- the order is 01, 02, 03. The trigger function below is created fine
-- before 03 exists (plpgsql doesn't check table names at create time),
-- but inserting/editing a leave request before 03 has run will fail with
-- "relation public.policy_weekly_working_days does not exist" — so run
-- 03 straight after this file.
--
-- Fresh setup:  run 01, then this file, then 03.
-- Existing DB:  just re-run this file. It upgrades in place (adds
--   leave_requests.review_comment if missing, replaces the functions).
--
-- Re-running this script: fully idempotent, same conventions as file 01
-- (IF NOT EXISTS / CREATE OR REPLACE / DROP...IF EXISTS + CREATE, seed
-- data via ON CONFLICT DO NOTHING). No destructive operations on data.
--
-- Identity note: every function here resolves "the caller" through
-- public.current_employee_uuid() and admin-ness through public.is_admin()
-- (both from file 01). The old 04/05 scripts re-derived these via
-- employees.auth_user_id / employees.role = 1; that logic is now
-- centralised so there is one definition of "me" and "admin".
--
-- Approval model:
--   - A regular employee can insert a request for themselves, or for an
--     eligible colleague (anyone in the same department, their own
--     supervisor included — see can_request_leave_for() /
--     list_my_leave_delegates() below).
--     Enforced by both RLS and a BEFORE INSERT trigger — defense in
--     depth. Either way it always starts life as 'pending': filing for
--     a teammate never skips their normal approval step.
--   - An admin inserting a request on behalf of a DIFFERENT employee is
--     auto-approved on creation (no further action needed), per the
--     "Admin can create leave for any employee without needing further
--     approval" requirement. This is handled entirely by
--     trg_leave_requests_defaults below — there is no separate "create"
--     RPC, a plain insert is enough; the trigger looks at who is running
--     it and who the request is for.
--   - An admin inserting a request for THEMSELVES is treated like a
--     normal self-request (stays pending) — an admin approving their own
--     leave would defeat the point of an approval step.
--   - Approving/rejecting a *pending* request is done via the
--     review_leave_request() RPC, callable by the employee's direct
--     supervisor OR any admin. Cancelling a still-pending request is
--     done via cancel_leave_request(), callable by the requester or an
--     admin. Both are SECURITY DEFINER functions rather than RLS update
--     policies because "only pending requests can transition" and
--     "stamp approver + timestamp together" are business rules RLS
--     can't express cleanly (RLS filters rows, not columns/transitions).
--     Status transitions always go through those RPCs — never a plain
--     update — even for the requester's own row.
--   - Approval comment: when APPROVING, the reviewer may attach an
--     optional comment (leave_requests.review_comment, max 500 chars).
--     Rejections keep using rejection_reason (required by
--     leave_requests_rejection_reason_check). The approval itself goes
--     through review_leave_request() exactly as before; the page then
--     makes a second call to set_leave_review_comment() to save the
--     comment. Only the person who approved a request can set/clear its
--     comment. review_comment is wiped on insert and on every review, so
--     it can never carry text an employee typed into their own pending
--     row (a plain self-update of a pending row could otherwise
--     pre-fill it and make it look like the approver wrote it).
--   - Editing the *details* (type/dates/reason) of your own still-
--     pending request, without touching its status, is a plain table
--     update covered by leave_requests_self_update below: the row has
--     to already be yours and pending (using), and has to still be
--     yours and pending afterwards (with check) — so it can't be used
--     to sneak in a status/employee_id change. Admin has full write
--     access via leave_requests_admin_update regardless of status.
--   - A request always belongs to (counts against) employee_id, the
--     person it's leave FOR — not requested_by, whoever filed it. Both
--     of them can see the row (leave_requests_select below), but any
--     balance/entitlement accounting done elsewhere should always group
--     by employee_id, and only once status = 1 (approved).
--   - "Awaiting <supervisor name (ID)>": regular users can't read other
--     employees' rows, so list_leave_approvers() (SECURITY DEFINER)
--     returns just the supervisor's name + employee ID, and only for
--     people whose leave the caller can already see (see the function).
--   - "Filed by <name (ID)>": same problem, same fix — the person who
--     filed leave FOR me (a teammate, my own supervisor, or an admin)
--     usually isn't readable under RLS, so list_leave_requesters()
--     (SECURITY DEFINER) returns just their name + employee ID, and only
--     for requests where the caller is the employee.
--
-- Half-day model:
--   - start_half_day / end_half_day are each 'full', 'am', or 'pm'.
--   - For a single-day request (start_date = end_date) they must match
--     each other — they describe the one day being requested.
--   - total_days is computed automatically by
--     trg_leave_requests_calc_total_days on insert/update; never set it
--     directly from the client.
--
-- Working-day model (total_days):
--   total_days counts WORKING days, not calendar days, using the weekly
--   pattern admins set on the Policies page
--   (public.policy_weekly_working_days: Mon-Sun, 0 = day off, 0.5 = half
--   day, 1 = full day). Each date in start_date..end_date contributes
--   that weekday's working value:
--     * a full-day request on a full working day (1)   counts 1
--     * a full-day request on a half working day (0.5) counts 0.5
--     * a full-day request on a day off (0)            counts 0
--     * an 'am'/'pm' half on the first or last day     counts half a
--       day, but never more than that day's working value (so a half
--       day taken on a 0.5 working day still counts 0.5, and on a day
--       off still counts 0)
--   Example with the default Mon-Fri pattern: Fri to Mon (both full
--   days) = 2 days, not 4.
--   The value is fixed when the request is inserted or its dates/half-
--   day flags are edited. Changing the weekly pattern later does NOT
--   rewrite existing requests, so approved history stays as it was.
--   A request whose dates fall entirely on days off comes out as 0.
--   Public holidays are not modelled.
-- =====================================================================


-- ---------------------------------------------------------------------
-- Lookup tables
-- ---------------------------------------------------------------------

-- Leave types: admin-managed, same shape as positions/departments/
-- business_units in file 01 (so the existing "manage list values" UI
-- pattern in employees.js can be extended to cover this table too).
create table if not exists public.leave_types (
    leave_type_id       serial primary key,
    leave_type          text not null unique,
    is_active           boolean not null default true,
    modified_by         uuid references public.employees (id),
    last_modified       timestamptz not null default now()
);

insert into public.leave_types (leave_type) values
    ('Annual Leave'),
    ('Sick Leave'),
    ('Unpaid Leave'),
    ('Maternity Leave'),
    ('Paternity Leave'),
    ('Emergency Leave')
on conflict (leave_type) do nothing;

-- Leave statuses: fixed workflow states, not admin-editable — same
-- shape as roles/genders in file 01 (small CHECK-constrained lookup,
-- no audit columns, just here for readable joins/labels).
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
-- Leave requests
-- ---------------------------------------------------------------------
create table if not exists public.leave_requests (
    id                  uuid primary key default gen_random_uuid(),
    employee_id         uuid not null references public.employees (id) on delete cascade,
    leave_type_id       integer not null references public.leave_types (leave_type_id),
    start_date          date not null,
    start_half_day      text not null default 'full',
    end_date            date not null,
    end_half_day        text not null default 'full',
    total_days          numeric(4,1) not null default 0, -- computed by trigger, do not set directly
    reason              text,
    status              smallint not null default 0 references public.leave_statuses (status_id),
    requested_by        uuid not null references public.employees (id), -- who submitted it: self, or an admin acting on someone's behalf
    approved_by         uuid references public.employees (id),
    approved_at         timestamptz,
    rejection_reason    text,
    review_comment      text, -- optional approver comment on an APPROVED request; set via set_leave_review_comment()
    modified_by         uuid references public.employees (id),
    last_modified       timestamptz not null default now(),
    created_at          timestamptz not null default now(),
    constraint leave_requests_date_check check (end_date >= start_date),
    constraint leave_requests_start_half_check check (start_half_day in ('full', 'am', 'pm')),
    constraint leave_requests_end_half_check check (end_half_day in ('full', 'am', 'pm')),
    constraint leave_requests_single_day_half_match check (
        start_date <> end_date or start_half_day = end_half_day
    ),
    constraint leave_requests_rejection_reason_check check (
        status <> 2 or rejection_reason is not null -- a rejection must say why
    )
);

-- Upgrade path for databases whose leave_requests table predates
-- review_comment (CREATE TABLE IF NOT EXISTS above won't add columns to
-- an existing table). No-ops on a fresh install.
alter table public.leave_requests
    add column if not exists review_comment text;

alter table public.leave_requests
    drop constraint if exists leave_requests_review_comment_len_check;
alter table public.leave_requests
    add constraint leave_requests_review_comment_len_check
    check (review_comment is null or char_length(review_comment) <= 500);

create index if not exists idx_leave_requests_employee_id    on public.leave_requests (employee_id);
create index if not exists idx_leave_requests_leave_type_id  on public.leave_requests (leave_type_id);
create index if not exists idx_leave_requests_status         on public.leave_requests (status);
create index if not exists idx_leave_requests_requested_by   on public.leave_requests (requested_by);
create index if not exists idx_leave_requests_approved_by    on public.leave_requests (approved_by);
create index if not exists idx_leave_requests_start_date     on public.leave_requests (start_date);
create index if not exists idx_leave_requests_end_date       on public.leave_requests (end_date);
create index if not exists idx_leave_types_modified_by       on public.leave_types (modified_by);
create index if not exists idx_leave_types_is_active         on public.leave_types (is_active);


-- ---------------------------------------------------------------------
-- Helper: is the current user the DIRECT supervisor of this employee?
-- (Matches the "single approver = employee's supervisor" decision —
-- not a transitive/org-chart check.)
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
-- Helper: can the current (non-admin) user file a leave request on
-- behalf of p_employee_id? Rule: same department, and not themselves
-- (that's just a normal self-request). Their own supervisor IS eligible:
-- the request still starts out pending and is reviewed via
-- review_leave_request() by that supervisor's own supervisor (or an
-- admin), so the filer never approves anything. Active employees only
-- (last_day is null).
--
-- Used both server-side (trigger + insert RLS, below) and by
-- list_my_leave_delegates() to build the picker leaves.js shows in
-- the "Requesting for" field — kept as the single source of truth so
-- the two can't drift apart.
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

-- ---------------------------------------------------------------------
-- RPC: list the teammates the current user is allowed to file leave
-- for (see can_request_leave_for() above for the exact rule). Admins
-- don't call this — leaves.js loads the full employee directory for
-- them instead, since an admin can file for anyone.
-- ---------------------------------------------------------------------
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
-- RPC: supervisor name + employee ID for each employee whose leave the
-- caller can already see, so leaves.html can show
-- "Awaiting <supervisor name (ID)>" on pending requests for regular
-- (non-admin) users.
--
-- Why: employees can't normally read other employees' rows (RLS), so
-- the page can't look up a supervisor's name itself and would fall back
-- to "Awaiting supervisor". This returns ONLY the supervisor's name +
-- employee ID, and only for employees whose leave the caller can see:
--   * themself
--   * their direct reports
--   * anyone they filed leave for (leave_requests.requested_by)
--   * everyone, if they're an admin
-- Admins don't strictly need it (the page skips the call for them).
--
-- Coverage matches leave_requests_select exactly, because
-- is_supervisor_of() is a DIRECT-supervisor check (not recursive): there
-- is no "indirect supervisor" case that could see a request but get no
-- name back.
--
-- Employees with no supervisor produce no row (inner join) — the page
-- treats a missing row as "no supervisor assigned".
--
-- Return type is dropped first so re-runs can't fail with "cannot
-- change return type of existing function".
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
         or e.supervisor_id = public.current_employee_uuid()
         or public.is_admin()
         or exists (
                select 1
                  from public.leave_requests lr
                 where lr.employee_id = e.id
                   and lr.requested_by = public.current_employee_uuid()
            )
       );
$$;

-- ---------------------------------------------------------------------
-- RPC: who filed each leave request that was filed FOR the caller by
-- someone else, so leaves.html can show "Filed by <name (ID)>" on the
-- caller's own leave (My leave tab, its details view, and the Filed by
-- filter / Excel column).
--
-- Why: the person who filed it (a same-department teammate, the
-- caller's own supervisor, or an admin in another department) is usually
-- not readable under employees' RLS, so the page can't look up their
-- name itself. This returns ONLY the requester's name + employee ID,
-- and ONLY for requests where the caller is the employee — not for
-- requests the caller filed for others (the page already knows those
-- names from list_my_leave_delegates()), and not for anyone else's leave.
--
-- Self-filed requests (requested_by = employee_id) produce no row; the
-- page treats a missing row as "no separate requester". requested_by is
-- NOT NULL, so the inner join can't drop a real requester.
--
-- Return type is dropped first so re-runs can't fail with "cannot
-- change return type of existing function".
-- ---------------------------------------------------------------------
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
--
-- Why this lives here instead of 01_employee_info_schema.sql: it only
-- exists to support the leaves feature — specifically, PostgREST's
-- embedded employee:employee_id(name, employee_id) join in leaves.js's
-- loadRequests(). That embed is resolved against employees' own RLS,
-- separately from leave_requests_select below: a supervisor could
-- already see a subordinate's leave_requests row (is_supervisor_of()),
-- but without this, employees' existing policies (self/admin only)
-- silently blank out the embedded name/employee_id for anyone else —
-- PostgREST doesn't error on a denied embed, it just omits it, which
-- is why "Team requests" was showing blank employee names instead of
-- a permission error.
--
-- This is purely additive (a second permissive SELECT policy, OR'd
-- with whatever 01 already defines) and uses a name namespaced to this
-- file, so it can't collide with or replace anything already there —
-- safe to run regardless of what 01's existing policies look like.
-- ---------------------------------------------------------------------
drop policy if exists "leaves_employees_select_direct_reports" on public.employees;
create policy "leaves_employees_select_direct_reports" on public.employees
    for select to authenticated
    using (public.is_supervisor_of(id));


-- ---------------------------------------------------------------------
-- Trigger: enforce who a request is for / who submitted it, and handle
-- the admin-creates-for-someone-else auto-approval rule. Runs before
-- generate/calc triggers but order doesn't actually matter between them
-- since they touch disjoint columns.
-- ---------------------------------------------------------------------
create or replace function public.set_leave_request_defaults()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    new.requested_by := public.current_employee_uuid();

    -- An approval comment can only ever come from the approver, after
    -- the fact (set_leave_review_comment()), never from the insert.
    new.review_comment := null;

    if not public.is_admin() then
        -- Self-service, whether it's for themselves or an eligible
        -- teammate (see can_request_leave_for()): always pending,
        -- never auto-approved, regardless of who it's for.
        if new.employee_id is null or new.employee_id = public.current_employee_uuid() then
            new.employee_id := public.current_employee_uuid();
        elsif not public.can_request_leave_for(new.employee_id) then
            raise exception 'You can only file leave for yourself or someone in your department';
        end if;
        new.status       := 0;
        new.approved_by  := null;
        new.approved_at  := null;
    else
        if new.employee_id <> public.current_employee_uuid() then
            -- Admin creating on behalf of someone else: auto-approved,
            -- no further review needed.
            new.status      := 1;
            new.approved_by := public.current_employee_uuid();
            new.approved_at := now();
        else
            -- Admin creating a request for themselves: behaves like a
            -- normal self-request (still needs someone else to review).
            new.status      := 0;
            new.approved_by := null;
            new.approved_at := null;
        end if;
    end if;
    return new;
end;
$$;

drop trigger if exists trg_leave_requests_defaults on public.leave_requests;
create trigger trg_leave_requests_defaults
    before insert on public.leave_requests
    for each row
    execute function public.set_leave_request_defaults();


-- ---------------------------------------------------------------------
-- Trigger: compute total_days from the date range + half-day flags,
-- counting only working days per public.policy_weekly_working_days
-- (file 03). See "Working-day model" in the header for the rules.
--
-- SECURITY DEFINER so the calculation never depends on the caller's
-- read access to the policy table.
-- ---------------------------------------------------------------------
create or replace function public.calculate_leave_request_total_days()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    select coalesce(sum(
               case
                   -- 'am'/'pm' on the first or last day: half a day at
                   -- most, and never more than that weekday's value
                   when (d.leave_day = new.start_date and new.start_half_day <> 'full')
                     or (d.leave_day = new.end_date   and new.end_half_day   <> 'full')
                   then least(w.working_value, 0.5)
                   else w.working_value
               end
           ), 0)
      into new.total_days
      from (
            select new.start_date + g.i as leave_day
              from generate_series(0, new.end_date - new.start_date) as g(i)
           ) d
      join public.policy_weekly_working_days w
        on w.day_of_week = extract(isodow from d.leave_day)::smallint;

    return new;
end;
$$;

drop trigger if exists trg_leave_requests_calc_total_days on public.leave_requests;
create trigger trg_leave_requests_calc_total_days
    before insert or update of start_date, end_date, start_half_day, end_half_day
    on public.leave_requests
    for each row
    execute function public.calculate_leave_request_total_days();


-- ---------------------------------------------------------------------
-- Audit triggers — reuse track_audit_columns() from file 01, don't
-- redefine it.
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


-- =====================================================================
-- REVIEW / CANCEL / COMMENT (SECURITY DEFINER — see approval model
-- note up top)
-- =====================================================================
create or replace function public.review_leave_request(
    p_request_id uuid,
    p_decision text,               -- 'approved' or 'rejected'
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
    v_new_status  smallint;
begin
    select employee_id, status into v_employee_id, v_status
    from public.leave_requests
    where id = p_request_id;

    if v_employee_id is null then
        raise exception 'Leave request not found';
    end if;

    if not (public.is_admin() or public.is_supervisor_of(v_employee_id)) then
        raise exception 'Only the employee''s supervisor or an admin can review this request';
    end if;

    if v_status <> 0 then
        raise exception 'Only pending requests can be reviewed';
    end if;

    if p_decision = 'approved' then
        v_new_status := 1;
    elsif p_decision = 'rejected' then
        if p_rejection_reason is null or trim(p_rejection_reason) = '' then
            raise exception 'A rejection reason is required';
        end if;
        v_new_status := 2;
    else
        raise exception 'Decision must be "approved" or "rejected", got "%"', p_decision;
    end if;

    update public.leave_requests
    set status            = v_new_status,
        approved_by       = public.current_employee_uuid(),
        approved_at       = now(),
        rejection_reason  = case when v_new_status = 2 then p_rejection_reason else null end,
        review_comment    = null -- start clean; the approver's comment (if any) is saved by set_leave_review_comment() right after
    where id = p_request_id;
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
begin
    select employee_id, status into v_employee_id, v_status
    from public.leave_requests
    where id = p_request_id;

    if v_employee_id is null then
        raise exception 'Leave request not found';
    end if;

    if not (v_employee_id = public.current_employee_uuid() or public.is_admin()) then
        raise exception 'Only the requester or an admin can cancel this request';
    end if;

    if v_status <> 0 then
        raise exception 'Only pending requests can be cancelled';
    end if;

    update public.leave_requests
    set status = 3 -- cancelled
    where id = p_request_id;
end;
$$;

-- Set (or clear) the optional comment on an APPROVED request. Only the
-- person who approved it may do so. A blank comment clears it. Called by
-- leaves.js right after review_leave_request(); kept separate so the
-- approval itself is unchanged and the page still works (comments simply
-- hidden) if this ever isn't deployed.
--
-- Note: for an admin-filed-for-someone-else request the admin is the
-- approver (auto-approved on insert), so they can comment on it too.
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
begin
    update public.leave_requests lr
       set review_comment = nullif(btrim(p_comment), '')
     where lr.id = p_request_id
       and lr.status = 1
       and lr.approved_by is not distinct from v_me
       and v_me is not null;

    if not found then
        raise exception 'Only the approver of an approved request can comment on it'
            using errcode = '42501';
    end if;
end;
$$;


-- =====================================================================
-- ROW LEVEL SECURITY
-- =====================================================================
alter table public.leave_types    enable row level security;
alter table public.leave_statuses enable row level security;
alter table public.leave_requests enable row level security;

-- Leave types: any authenticated user can read; only admins write.
drop policy if exists "lookup_read_leave_types" on public.leave_types;
create policy "lookup_read_leave_types" on public.leave_types
    for select to authenticated using (true);
drop policy if exists "lookup_write_leave_types" on public.leave_types;
create policy "lookup_write_leave_types" on public.leave_types
    for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Leave statuses: read-only reference data for everyone, no write policy
-- at all (fixed set, changed only by editing this script).
drop policy if exists "lookup_read_leave_statuses" on public.leave_statuses;
create policy "lookup_read_leave_statuses" on public.leave_statuses
    for select to authenticated using (true);

-- Leave requests: self, an eligible teammate's requester, direct
-- supervisor, or admin can read (so a request shows up for both the
-- person it's for AND whoever filed it). Self, a same-department
-- teammate (per can_request_leave_for()), or admin can insert (trigger
-- above enforces the rest, and always leaves it pending unless an
-- admin filed for someone else). Admin has full write access via RLS;
-- supervisor approval/self-cancel go through the RPCs above instead of
-- RLS update policies.
drop policy if exists "leave_requests_select" on public.leave_requests;
create policy "leave_requests_select" on public.leave_requests
    for select to authenticated
    using (
        employee_id = public.current_employee_uuid()
        or requested_by = public.current_employee_uuid()
        or public.is_supervisor_of(employee_id)
        or public.is_admin()
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


-- =====================================================================
-- GRANTS
-- =====================================================================
-- File 01 already ran `alter default privileges ... grant ... to
-- authenticated, service_role` for future tables/sequences in this
-- schema, so these three new tables and two new serial sequences should
-- already inherit the right grants automatically. These explicit grants
-- are kept anyway, belt-and-suspenders, in case this script is ever run
-- under a different role than the one that set those defaults — cheap
-- insurance against another "permission denied for table" (42501)
-- surprise.
grant select, insert, update, delete on
    public.leave_types,
    public.leave_statuses,
    public.leave_requests
to authenticated, service_role;

grant usage, select on
    public.leave_types_leave_type_id_seq
to authenticated, service_role;

-- Callable functions: signed-in users (and service_role) only. Postgres
-- grants EXECUTE to PUBLIC by default and Supabase's default privileges
-- also grant it to anon, so revoke both first, then grant explicitly.
-- (Trigger functions are not listed: they need no EXECUTE grant.)
revoke all on function public.is_supervisor_of(uuid)                  from public, anon;
revoke all on function public.can_request_leave_for(uuid)             from public, anon;
revoke all on function public.list_my_leave_delegates()               from public, anon;
revoke all on function public.list_leave_approvers()                  from public, anon;
revoke all on function public.list_leave_requesters()                 from public, anon;
revoke all on function public.review_leave_request(uuid, text, text)  from public, anon;
revoke all on function public.cancel_leave_request(uuid)              from public, anon;
revoke all on function public.set_leave_review_comment(uuid, text)    from public, anon;

grant execute on function public.is_supervisor_of(uuid)                  to authenticated, service_role;
grant execute on function public.can_request_leave_for(uuid)             to authenticated, service_role;
grant execute on function public.list_my_leave_delegates()               to authenticated, service_role;
grant execute on function public.list_leave_approvers()                  to authenticated, service_role;
grant execute on function public.list_leave_requesters()                 to authenticated, service_role;
grant execute on function public.review_leave_request(uuid, text, text) to authenticated, service_role;
grant execute on function public.cancel_leave_request(uuid)              to authenticated, service_role;
grant execute on function public.set_leave_review_comment(uuid, text)    to authenticated, service_role;