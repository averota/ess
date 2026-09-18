-- =====================================================================
-- Employee Leave Management System — Leave Request Schema
-- Target: Supabase (PostgreSQL), public schema
--
-- Depends on 01_employee_info_schema.sql having already run:
--   public.employees, public.is_admin(), public.current_employee_uuid(),
--   public.track_audit_columns(), and the default-privileges grants are
--   all reused here, not redefined. This file only adds new objects.
--
-- Re-running this script: fully idempotent, same conventions as file 01
-- (IF NOT EXISTS / CREATE OR REPLACE / DROP...IF EXISTS + CREATE, seed
-- data via ON CONFLICT DO NOTHING).
--
-- Approval model:
--   - A regular employee can only ever insert a request for themselves
--     (enforced by both RLS and a BEFORE INSERT trigger — defense in
--     depth). It always starts life as 'pending'.
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
--     Plain RLS still covers full admin read/write access below.
--
-- Half-day model:
--   - start_half_day / end_half_day are each 'full', 'am', or 'pm'.
--   - For a single-day request (start_date = end_date) they must match
--     each other — they describe the one day being requested.
--   - total_days is computed automatically by
--     trg_leave_requests_calc_total_days on insert/update; never set it
--     directly from the client.
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
    if not public.is_admin() then
        -- Self-service: always for yourself, always starts pending,
        -- regardless of what the client tried to send.
        new.employee_id  := public.current_employee_uuid();
        new.requested_by := public.current_employee_uuid();
        new.status       := 0;
        new.approved_by  := null;
        new.approved_at  := null;
    else
        new.requested_by := coalesce(new.requested_by, public.current_employee_uuid());

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
-- Trigger: compute total_days from the date range + half-day flags.
-- ---------------------------------------------------------------------
create or replace function public.calculate_leave_request_total_days()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if new.start_date = new.end_date then
        new.total_days := case when new.start_half_day = 'full' then 1 else 0.5 end;
    else
        new.total_days := (new.end_date - new.start_date + 1)
            - case when new.start_half_day <> 'full' then 0.5 else 0 end
            - case when new.end_half_day   <> 'full' then 0.5 else 0 end;
    end if;
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
-- REVIEW / CANCEL (SECURITY DEFINER — see approval model note up top)
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
        rejection_reason  = case when v_new_status = 2 then p_rejection_reason else null end
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

-- Leave requests: self, direct supervisor, or admin can read. Self or
-- admin can insert (trigger above enforces the rest). Admin has full
-- write access via RLS; supervisor approval/self-cancel go through the
-- RPCs above instead of RLS update policies.
drop policy if exists "leave_requests_select" on public.leave_requests;
create policy "leave_requests_select" on public.leave_requests
    for select to authenticated
    using (
        employee_id = public.current_employee_uuid()
        or public.is_supervisor_of(employee_id)
        or public.is_admin()
    );

drop policy if exists "leave_requests_insert" on public.leave_requests;
create policy "leave_requests_insert" on public.leave_requests
    for insert to authenticated
    with check (
        employee_id = public.current_employee_uuid()
        or public.is_admin()
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
