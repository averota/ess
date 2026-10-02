-- =====================================================================
-- Employee Leave Management System — Employee Information Schema
-- Target: Supabase (PostgreSQL), public schema
--
-- Re-running this script: fully idempotent. Table/function/trigger/policy
-- DDL uses IF NOT EXISTS / CREATE OR REPLACE / DROP...IF EXISTS + CREATE.
-- Seed data: only the fixed reference rows the CHECK constraints rely on
-- (roles: user/admin, genders: female/male) plus the leave policy defaults in
-- 02/03. No sample employees and no sample positions / departments / business
-- units are created: add them from the Employees page, or let a bulk upload
-- create the lookup values it needs. Re-running never overwrites existing rows.
--
-- Auth linking model (no service_role key required):
--   - employees.email is optional and unique. Set it whenever an
--     employee should get portal access.
--   - Create that person's login yourself, as normal, from the
--     Supabase Dashboard (Authentication > Users), using the same
--     email.
--   - Whichever happens second, linking is automatic:
--       * Employee gets an email and a matching auth user already
--         exists -> trg_employees_link_auth_user links it.
--       * Auth user is created and a matching employee row (with no
--         auth_user_id yet) already exists -> trg_link_new_auth_user
--         links it.
--   - Matching is case/whitespace-tolerant (lower(trim(email))) on both
--     sides.
--   - If both rows already existed before the other one showed up (e.g.
--     bulk import, restored backup, or rows that pre-date this script),
--     neither trigger ever fires for them since there's no insert/update
--     event to catch. A reconciliation UPDATE right after the trigger
--     definitions below re-links any such already-matching, still-
--     unlinked pairs every time this script runs — safe to re-run, since
--     it only touches rows that are still unlinked.
--
-- Table-level GRANTs (see the GRANTS section near the end): RLS policies
-- only filter rows once a role is already allowed to query a table at
-- all — Postgres does not grant that base privilege to anon/authenticated
-- automatically. Without it you'll see "permission denied for table ..."
-- (error 42501) even though RLS looks correct.
--
-- employees.supervisor_id: nullable, self-referencing FK to employees.id.
-- Referred to as the employee's "first line" manager throughout the leave
-- approval model. Null means no first-line manager assigned (e.g. top of
-- the org chart).
--
-- employees.second_line_id: nullable, self-referencing FK to employees.id.
-- The employee's "second line" manager, used as an escalation/approver
-- role in the leave approval model. Independent of supervisor_id — not
-- required to be that manager's own supervisor.
--
-- departments.hod_id: nullable FK to employees.id. Head of department,
-- used as an approver role in the leave approval model (see
-- leave_type_approval_rules / is_second_line_of / is_hod_of in
-- 02_leaves_schema.sql, which are `language sql` and reference
-- second_line_id / hod_id directly). Not every department needs one set
-- right away.
--
-- employees.probation_end_date: required, but defaults to
-- hired_date + 3 months via trg_employees_default_probation (fires only
-- on INSERT, only when not explicitly supplied). Freely editable
-- afterward — the trigger never overwrites an existing value, and never
-- recalculates if hired_date changes later.
--
-- Adding these two columns to a database that already ran an earlier
-- version of this script? Use 02_add_supervisor_and_probation.sql
-- instead of re-running this file — CREATE TABLE IF NOT EXISTS is a
-- no-op once the table exists, so this file alone won't add columns to
-- an existing table.
--
-- This file also includes the Employees-page functions (stat cards +
-- spreadsheet Append/Overwrite) originally shipped separately as
-- 02_employees_page_functions.sql — see the "EMPLOYEES PAGE FUNCTIONS"
-- section near the end. If your database already ran the old
-- 01_employee_info_schema.sql (without that section) plus
-- 02_employees_page_functions.sql on its own, you don't need to do
-- anything further; this merged file is just for setting up a brand
-- new database in one pass. Everything here is idempotent either way.
--
-- This file also absorbs the former 01a_add_second_line_and_hod.sql
-- (second_line_id on employees, hod_id on departments) — it's no longer
-- a separate migration. A database that already ran 01a on its own needs
-- nothing further; re-running this file is a no-op for those columns.
--
-- This file also absorbs the former 05_approver_access.sql (is_approver())
-- and extends it — see the "APPROVER / TEAM VISIBILITY" section below.
-- 05 no longer needs to be run separately; re-running this file replaces
-- is_approver() in place.
--   - my_team_ids(): everyone under the signed-in user's hierarchy
--     (direct reports as 1st or 2nd line, everyone in departments they are
--     HOD of, plus those people's own reports, recursively — but never
--     through an admin: an admin's own reports aren't inherited).
--   - employees RLS: non-admins can now SELECT their own row plus their
--     team (read-only). INSERT / UPDATE / DELETE stay admin-only.
--   - get_employee_stats(): stat cards for the Employees page, scoped to
--     all employees for admins or to the team for approvers.
-- =====================================================================

create extension if not exists pgcrypto; -- provides gen_random_uuid()


-- ---------------------------------------------------------------------
-- Lookup tables
-- ---------------------------------------------------------------------
create table if not exists public.roles (
    role_id             smallint primary key,
    role_name           text not null unique,
    constraint roles_role_id_check check (role_id in (0, 1)) -- 0 = user, 1 = admin
);

insert into public.roles (role_id, role_name) values
    (0, 'user'),
    (1, 'admin')
on conflict (role_id) do nothing;

create table if not exists public.genders (
    gender_id           smallint primary key,
    gender_name         text not null unique,
    constraint genders_gender_id_check check (gender_id in (0, 1)) -- 0 = female, 1 = male
);

insert into public.genders (gender_id, gender_name) values
    (0, 'female'),
    (1, 'male')
on conflict (gender_id) do nothing;

create table if not exists public.positions (
    post_id             serial primary key,
    position            text not null unique,
    is_active           boolean not null default true, -- false = hidden from the employee-form dropdown, but not from existing records or bulk upload (see manage-list-values UI in employees.js)
    modified_by         uuid,
    last_modified       timestamptz not null default now()
);
-- Adding is_active to a database that already ran an earlier version of
-- this script? CREATE TABLE IF NOT EXISTS is a no-op there — use
-- 03_add_lookup_active_flag.sql instead.
alter table public.positions add column if not exists is_active boolean not null default true;

-- (no sample positions: created from the Employees page or by bulk upload)

create table if not exists public.departments (
    dept_id             serial primary key,
    department          text not null unique,
    is_active           boolean not null default true,
    modified_by         uuid,
    last_modified       timestamptz not null default now(),
    hod_id              uuid -- head of department; FK to employees wired on below (circular dependency, see comment there)
);
alter table public.departments add column if not exists is_active boolean not null default true;
alter table public.departments add column if not exists hod_id uuid;

-- (no sample departments: created from the Employees page or by bulk upload)

create table if not exists public.business_units (
    bu_id               serial primary key,
    business_unit       text not null unique,
    is_active           boolean not null default true,
    modified_by         uuid,
    last_modified       timestamptz not null default now()
);
alter table public.business_units add column if not exists is_active boolean not null default true;

-- (no sample business units: created from the Employees page or by bulk upload)


-- ---------------------------------------------------------------------
-- Employees
-- ---------------------------------------------------------------------
create sequence if not exists public.employee_id_seq start 1;

create table if not exists public.employees (
    id                  uuid primary key default gen_random_uuid(),
    employee_id         text not null unique, -- human-facing code, e.g. EMP0001
    auth_user_id        uuid unique references auth.users (id) on delete set null,
    name                text not null,
    gender              smallint not null references public.genders (gender_id),
    post_id             integer not null references public.positions (post_id),
    dept_id             integer not null references public.departments (dept_id),
    bu_id               integer not null references public.business_units (bu_id),
    telegram_chat_id    text unique, -- optional; alert message via Telegram bot when leave request is approved/rejected
    supervisor_id       uuid references public.employees (id), -- nullable: top of the org chart, or not yet assigned (= "first line" manager)
    second_line_id      uuid references public.employees (id), -- nullable: "second line" manager, independent of supervisor_id
    hired_date          date not null,
    probation_end_date  date not null, -- defaults to hired_date + 3 months (see trigger below); freely editable after that
    last_day            date,
    role                smallint not null references public.roles (role_id),
    email               text unique, -- optional; grants portal access when set (see auth linking model above)
    modified_by         uuid references public.employees (id),
    last_modified       timestamptz not null default now(),
    constraint employees_last_day_check check (last_day is null or last_day >= hired_date),
    constraint employees_probation_end_date_check check (probation_end_date >= hired_date),
    constraint employees_supervisor_not_self check (supervisor_id is null or supervisor_id <> id),
    constraint employees_second_line_not_self check (second_line_id is null or second_line_id <> id)
);

-- positions/departments/business_units reference employees.id for
-- modified_by, but employees references those tables too — resolve the
-- circular dependency by wiring these FKs on after employees exists.
alter table public.positions      drop constraint if exists positions_modified_by_fkey;
alter table public.positions      add constraint positions_modified_by_fkey
    foreign key (modified_by) references public.employees (id);

alter table public.departments    drop constraint if exists departments_modified_by_fkey;
alter table public.departments    add constraint departments_modified_by_fkey
    foreign key (modified_by) references public.employees (id);

alter table public.departments    drop constraint if exists departments_hod_id_fkey;
alter table public.departments    add constraint departments_hod_id_fkey
    foreign key (hod_id) references public.employees (id);

alter table public.business_units drop constraint if exists business_units_modified_by_fkey;
alter table public.business_units add constraint business_units_modified_by_fkey
    foreign key (modified_by) references public.employees (id);

create index if not exists idx_employees_dept_id on public.employees (dept_id);
create index if not exists idx_employees_post_id on public.employees (post_id);
create index if not exists idx_employees_bu_id on public.employees (bu_id);
create index if not exists idx_employees_role on public.employees (role);
create index if not exists idx_employees_auth_user_id on public.employees (auth_user_id);
create index if not exists idx_employees_employee_id on public.employees (employee_id);
create index if not exists idx_employees_supervisor_id on public.employees (supervisor_id);
create index if not exists idx_employees_second_line_id on public.employees (second_line_id);
create index if not exists idx_departments_hod_id on public.departments (hod_id);
create index if not exists idx_positions_modified_by on public.positions (modified_by);
create index if not exists idx_departments_modified_by on public.departments (modified_by);
create index if not exists idx_business_units_modified_by on public.business_units (modified_by);
create index if not exists idx_positions_is_active      on public.positions (is_active);
create index if not exists idx_departments_is_active    on public.departments (is_active);
create index if not exists idx_business_units_is_active on public.business_units (is_active);
create index if not exists idx_employees_modified_by on public.employees (modified_by);

-- Auto-generate employee_id (EMP0001, EMP0002, ...) when not supplied.
create or replace function public.generate_employee_id()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if new.employee_id is null then
        new.employee_id := 'EMP' || lpad(nextval('public.employee_id_seq')::text, 4, '0');
    end if;
    return new;
end;
$$;

drop trigger if exists trg_employees_generate_id on public.employees;
create trigger trg_employees_generate_id
    before insert on public.employees
    for each row
    execute function public.generate_employee_id();

-- Defaults probation_end_date to hired_date + 3 months when not supplied.
-- Only fires on INSERT: it fills in a sensible default at creation time,
-- but never overwrites an admin's later edit, and never recalculates
-- automatically if hired_date is changed afterward.
create or replace function public.set_default_probation_end_date()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if new.probation_end_date is null then
        new.probation_end_date := (new.hired_date + interval '3 months')::date;
    end if;
    return new;
end;
$$;

drop trigger if exists trg_employees_default_probation on public.employees;
create trigger trg_employees_default_probation
    before insert on public.employees
    for each row
    execute function public.set_default_probation_end_date();

-- Stamps last_modified / modified_by on insert and update.
create or replace function public.track_audit_columns()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    new.modified_by := public.current_employee_uuid();
    new.last_modified := now();
    return new;
end;
$$;

-- Direction 1: employee gets an email (on insert or when email is
-- added/changed later) — link to a matching auth user if one already
-- exists and isn't linked yet. Match is case/whitespace-tolerant since
-- emails get typed differently in different places (Dashboard vs CSV
-- import vs admin form).
create or replace function public.link_employee_to_existing_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    if new.auth_user_id is null and new.email is not null then
        select id into new.auth_user_id
        from auth.users
        where lower(trim(email)) = lower(trim(new.email))
        limit 1;
    end if;
    return new;
end;
$$;

drop trigger if exists trg_employees_link_auth_user on public.employees;
create trigger trg_employees_link_auth_user
    before insert or update of email on public.employees
    for each row
    execute function public.link_employee_to_existing_auth_user();

-- Direction 2: a new auth user is created (e.g. via the Dashboard) whose
-- email matches an employee row still waiting to be linked. Same
-- case/whitespace-tolerant match as above.
create or replace function public.link_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    update public.employees
    set auth_user_id = new.id
    where lower(trim(email)) = lower(trim(new.email))
      and auth_user_id is null;
    return new;
end;
$$;

drop trigger if exists trg_link_new_auth_user on auth.users;
create trigger trg_link_new_auth_user
    after insert on auth.users
    for each row
    execute function public.link_new_auth_user();

-- Reconciliation pass: the two triggers above only fire on an insert/
-- update *event*. If an employee row and an auth user that already match
-- were both created before the other existed (e.g. restored from backup,
-- bulk-imported, or just pre-dated this script), neither trigger ever
-- ran for them and they'd stay unlinked forever. Running this on every
-- script execution catches those cases too — safe to re-run, since it
-- only ever touches rows that are still unlinked.
update public.employees e
set auth_user_id = u.id
from auth.users u
where e.auth_user_id is null
  and e.email is not null
  and lower(trim(e.email)) = lower(trim(u.email));


-- (no sample employees: the first admin signs in via the super admin account, then adds people
-- from the Employees page or a bulk upload)


-- =====================================================================
-- ROW LEVEL SECURITY
-- =====================================================================
-- INACTIVE EMPLOYEES: an employee whose last_day has passed can still sign in
-- to Supabase Auth, but these two helpers treat them as nobody — is_admin()
-- is false and current_employee_uuid() is null — so every policy / function
-- built on them (my_team_ids, is_approver, employee_directory, the leave
-- tables' RLS, ...) refuses them. Active = last_day is null or >= today,
-- the same rule the front-end uses. The one thing an inactive user can still
-- do is read their OWN employees row (employees_select policy below), which
-- the app needs in order to show the "your account is inactive" message.
-- (An admin whose last_day passes loses admin rights too. If that ever
-- happens to the only admin, clear last_day from the Supabase SQL editor.)
-- Also kept as a standalone migration: 06_block_inactive_users.sql.
create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
    select exists (
        select 1
        from public.employees e
        where e.auth_user_id = auth.uid()
          and e.role = 1
          and (e.last_day is null or e.last_day >= current_date)
    );
$$;

create or replace function public.current_employee_uuid()
returns uuid
language sql
security definer
stable
set search_path = ''
as $$
    select e.id
    from public.employees e
    where e.auth_user_id = auth.uid()
      and (e.last_day is null or e.last_day >= current_date);
$$;

-- ---------------------------------------------------------------------
-- APPROVER / TEAM VISIBILITY
-- (merged from the former 05_approver_access.sql)
--
-- SECURITY DEFINER because RLS on public.employees only lets a non-admin
-- read their own row, so these can't be computed with the caller's rights.
-- Team members are never exposed by the functions themselves — only their
-- ids (my_team_ids) or a yes/no (is_approver); the rows are then read
-- through the ordinary employees SELECT policy below.
-- ---------------------------------------------------------------------

-- Every employee under the signed-in user's hierarchy, excluding the user.
--   seed:  people whose 1st line (supervisor_id) or 2nd line
--          (second_line_id) is me, and everyone in a department I am HOD of
--   team:  the seed, plus (recursively) whoever reports to anyone already in
--          it — so a 2nd line / HOD sees the whole chain below them.
--          The chain does NOT continue through admins: an admin who is in
--          your team is visible, but the people reporting to that admin are
--          not inherited (otherwise whoever supervises an admin would end up
--          seeing everyone the admin supervises). To see someone, you must
--          be their 1st line, 2nd line or HOD, or sit above them via a chain
--          of non-admin managers.
-- Uses UNION (not UNION ALL), so a reporting-line cycle can't loop forever.
-- Inactive employees are included so history stays visible, and so a
-- departed manager doesn't cut their reports out of the chain.
create or replace function public.my_team_ids()
returns setof uuid
language sql
security definer
stable
set search_path = ''
as $$
    with recursive
    me as (
        select public.current_employee_uuid() as id
    ),
    seed as (
        select e.id
        from public.employees e, me
        where e.supervisor_id = me.id
           or e.second_line_id = me.id
        union
        select e.id
        from public.employees e
        join public.departments d on d.dept_id = e.dept_id
        join me on d.hod_id = me.id
    ),
    team as (
        select id from seed
        union
        select e.id
        from public.employees e
        join team t on e.supervisor_id = t.id
                    or e.second_line_id = t.id
        join public.employees m on m.id = t.id
        where m.role <> 1   -- don't expand through admins
    )
    select t.id
    from team t, me
    where t.id <> me.id;
$$;

revoke all on function public.my_team_ids() from public, anon;
grant execute on function public.my_team_ids() to authenticated, service_role;

-- True when the signed-in user is an approver: HOD of any department, or
-- 1st/2nd line (directly or further down the chain) of at least one
-- still-active employee. Used by the front-end (sidebar.js / employees.js)
-- to decide whether a non-admin gets the Employees page.
create or replace function public.is_approver()
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
    select exists (
        select 1
        from public.employees r
        where r.id in (select public.my_team_ids())
          and (r.last_day is null or r.last_day >= current_date) -- active reports only
    )
    or exists (
        select 1
        from public.departments d
        where d.hod_id = public.current_employee_uuid()
    );
$$;

revoke all on function public.is_approver() from public, anon;
grant execute on function public.is_approver() to authenticated, service_role;

-- Employee directory for client use: admins get every row, everyone
-- else gets only their own. Call with: supabase.rpc('employee_directory')
create or replace function public.employee_directory()
returns table (
    id              uuid,
    employee_id     text,
    name            text,
    email           text,
    gender_name     text,
    job_title       text,
    department      text,
    business_unit   text,
    role_name       text,
    hired_date      date,
    last_day        date
)
language sql
security definer
stable
set search_path = ''
as $$
    select
        e.id,
        e.employee_id,
        e.name,
        e.email,
        g.gender_name,
        p.position,
        d.department,
        b.business_unit,
        r.role_name,
        e.hired_date,
        e.last_day
    from public.employees e
    join public.genders        g on g.gender_id = e.gender
    join public.positions      p on p.post_id   = e.post_id
    join public.departments    d on d.dept_id   = e.dept_id
    join public.business_units b on b.bu_id     = e.bu_id
    join public.roles          r on r.role_id   = e.role
    where public.is_admin() or e.id = public.current_employee_uuid();
$$;

alter table public.roles           enable row level security;
alter table public.genders         enable row level security;
alter table public.positions       enable row level security;
alter table public.departments     enable row level security;
alter table public.business_units  enable row level security;
alter table public.employees       enable row level security;

-- Lookup tables: any authenticated user can read; only admins write.
drop policy if exists "lookup_read_roles" on public.roles;
create policy "lookup_read_roles" on public.roles
    for select to authenticated using (true);
drop policy if exists "lookup_write_roles" on public.roles;
create policy "lookup_write_roles" on public.roles
    for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "lookup_read_genders" on public.genders;
create policy "lookup_read_genders" on public.genders
    for select to authenticated using (true);
drop policy if exists "lookup_write_genders" on public.genders;
create policy "lookup_write_genders" on public.genders
    for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "lookup_read_positions" on public.positions;
create policy "lookup_read_positions" on public.positions
    for select to authenticated using (true);
drop policy if exists "lookup_write_positions" on public.positions;
create policy "lookup_write_positions" on public.positions
    for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "lookup_read_departments" on public.departments;
create policy "lookup_read_departments" on public.departments
    for select to authenticated using (true);
drop policy if exists "lookup_write_departments" on public.departments;
create policy "lookup_write_departments" on public.departments
    for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "lookup_read_business_units" on public.business_units;
create policy "lookup_read_business_units" on public.business_units
    for select to authenticated using (true);
drop policy if exists "lookup_write_business_units" on public.business_units;
create policy "lookup_write_business_units" on public.business_units
    for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Employees: self can read own row; approvers (1st line, 2nd line, HOD) can
-- additionally READ everyone under their hierarchy; admins can read/write
-- everyone. There is deliberately no non-admin INSERT/UPDATE/DELETE policy
-- below, so approvers are strictly view-only at the database level too.
-- "id in (select ...)" is an uncorrelated subquery, so Postgres evaluates
-- my_team_ids() once per query rather than once per row.
drop policy if exists "employees_select_self_or_admin" on public.employees;
drop policy if exists "employees_select_self_team_or_admin" on public.employees;
create policy "employees_select_self_team_or_admin" on public.employees
    for select to authenticated
    using (
        auth_user_id = auth.uid()
        or public.is_admin()
        or id in (select public.my_team_ids())
    );

drop policy if exists "employees_admin_write" on public.employees;
create policy "employees_admin_write" on public.employees
    for insert to authenticated
    with check (public.is_admin());

drop policy if exists "employees_admin_update" on public.employees;
create policy "employees_admin_update" on public.employees
    for update to authenticated
    using (public.is_admin())
    with check (public.is_admin());

drop policy if exists "employees_admin_delete" on public.employees;
create policy "employees_admin_delete" on public.employees
    for delete to authenticated
    using (public.is_admin());


-- =====================================================================
-- GRANTS
-- =====================================================================
-- RLS policies only filter which ROWS a role can see/touch — the role
-- still needs the ordinary table-level privilege to attempt the query at
-- all, and Postgres does NOT grant that to anon/authenticated
-- automatically (unlike function EXECUTE, which Postgres DOES grant to
-- everyone by default). Missing this is what produces a
-- "permission denied for table ..." / 42501 error even when RLS would
-- otherwise have allowed the row through.
grant usage on schema public to authenticated, service_role;

grant select, insert, update, delete on
    public.roles,
    public.genders,
    public.positions,
    public.departments,
    public.business_units,
    public.employees
to authenticated, service_role;

-- generate_employee_id() calls nextval() and is not SECURITY DEFINER, so
-- it runs with the calling (authenticated) role's own privileges and
-- needs USAGE on the sequence directly.
grant usage, select on public.employee_id_seq to authenticated, service_role;

-- Same reason: the lookup manager (employees.js) now inserts into
-- positions/departments/business_units directly from the client instead
-- of only through the SECURITY DEFINER bulk-upload functions, so each
-- serial column's backing sequence needs USAGE granted explicitly too —
-- "alter default privileges" below only covers sequences created after
-- that statement runs, not these three, which already existed.
grant usage, select on
    public.positions_post_id_seq,
    public.departments_dept_id_seq,
    public.business_units_bu_id_seq
to authenticated, service_role;

-- Anything created in public from now on automatically inherits the same
-- grants, so a future ALTER/CREATE TABLE here doesn't silently end up
-- ungranted again.
alter default privileges in schema public
    grant select, insert, update, delete on tables to authenticated, service_role;
alter default privileges in schema public
    grant usage, select on sequences to authenticated, service_role;


-- =====================================================================
-- AUDIT TRIGGERS (placed last: track_audit_columns() depends on
-- current_employee_uuid() above)
-- =====================================================================
drop trigger if exists trg_positions_audit on public.positions;
create trigger trg_positions_audit
    before insert or update on public.positions
    for each row
    execute function public.track_audit_columns();

drop trigger if exists trg_departments_audit on public.departments;
create trigger trg_departments_audit
    before insert or update on public.departments
    for each row
    execute function public.track_audit_columns();

drop trigger if exists trg_business_units_audit on public.business_units;
create trigger trg_business_units_audit
    before insert or update on public.business_units
    for each row
    execute function public.track_audit_columns();

drop trigger if exists trg_employees_audit on public.employees;
create trigger trg_employees_audit
    before insert or update on public.employees
    for each row
    execute function public.track_audit_columns();

-- ---------------------------------------------------------------------
-- Employee ID comparison key. Employee IDs are compared ignoring format:
--   '123' = 123 = ' 123 ' = '123.0'   '001' = '1'   'EMP0001' = 'emp001' = 'EMP1'
-- Rule: lower-case, drop whitespace, drop a trailing ".0" (spreadsheet numbers),
-- then strip the leading zeros of the trailing digit run, keeping any text
-- prefix. A prefix is NOT ignored: '1' and 'EMP0001' are different IDs.
-- The same rule lives in employees.js (employeeCodeKey) — keep them in sync.
-- ---------------------------------------------------------------------
create or replace function public.employee_code_key(p_code text)
returns text
language sql
immutable
set search_path = ''
as $$
    select case
        when s.v = '' then null
        else regexp_replace(s.v, '^(\D*)0*(\d+)$', '\1\2')
    end
    from (
        select regexp_replace(regexp_replace(lower(coalesce(p_code, '')), '\s+', '', 'g'), '^(\d+)\.0+$', '\1') as v
    ) s;
$$;

create index if not exists idx_employees_code_key on public.employees (public.employee_code_key(employee_id));

-- =====================================================================
-- EMPLOYEES PAGE FUNCTIONS
-- (stat cards + spreadsheet Append / Update-from-file for the Employees page —
-- see 02_employees_page_functions.sql for standalone use/comments)
-- =====================================================================

create index if not exists idx_employees_last_day           on public.employees (last_day);
create index if not exists idx_employees_probation_end_date on public.employees (probation_end_date);
create index if not exists idx_employees_hired_date         on public.employees (hired_date);

create or replace function public.admin_get_employee_stats()
returns json
language plpgsql
security definer
stable
set search_path = ''
as $$
begin
    if not public.is_admin() then
        raise exception 'Only admins can view employee stats';
    end if;

    return json_build_object(
        'active_headcount', (
            select count(*) from public.employees
            where last_day is null or last_day >= current_date
        ),
        'female_headcount', (
            select count(*) from public.employees
            where gender = 0 and (last_day is null or last_day >= current_date)
        ),
        'portal_linked', (
            select count(*) from public.employees
            where auth_user_id is not null and (last_day is null or last_day >= current_date)
        ),
        'new_hires_this_month', (
            select count(*) from public.employees
            where date_trunc('month', hired_date) = date_trunc('month', current_date)
        ),
        'on_probation', (
            select count(*) from public.employees
            where probation_end_date >= current_date
              and (last_day is null or last_day >= current_date)
        )
    );
end;
$$;

-- Stat cards for the Employees page. Same numbers as
-- admin_get_employee_stats(), but scoped: admins count every employee,
-- approvers count only their own team (my_team_ids()), anyone else is
-- refused. admin_get_employee_stats() is kept as-is for any other caller.
create or replace function public.get_employee_stats()
returns json
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
    v_all boolean := public.is_admin();
begin
    if not v_all and not public.is_approver() then
        raise exception 'Only admins and approvers can view employee stats';
    end if;

    return (
        select json_build_object(
            'active_headcount',     count(*) filter (where e.last_day is null or e.last_day >= current_date),
            'female_headcount',     count(*) filter (where e.gender = 0 and (e.last_day is null or e.last_day >= current_date)),
            'portal_linked',        count(*) filter (where e.auth_user_id is not null and (e.last_day is null or e.last_day >= current_date)),
            'new_hires_this_month', count(*) filter (where date_trunc('month', e.hired_date) = date_trunc('month', current_date)),
            'on_probation',         count(*) filter (where e.probation_end_date >= current_date and (e.last_day is null or e.last_day >= current_date))
        )
        from public.employees e
        where v_all or e.id in (select public.my_team_ids())
    );
end;
$$;

revoke all on function public.get_employee_stats() from public, anon;
grant execute on function public.get_employee_stats() to authenticated, service_role;

create or replace function public.admin_resolve_core_employee_fields(
    p_row jsonb,
    out gender_id smallint,
    out post_id   integer,
    out dept_id   integer,
    out bu_id     integer,
    out role_id   smallint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_gender        text := lower(trim(p_row->>'gender'));
    v_role          text := lower(trim(coalesce(nullif(p_row->>'role',''), 'user')));
    v_position      text := trim(p_row->>'position');
    v_department    text := trim(p_row->>'department');
    v_business_unit text := trim(p_row->>'business_unit');
begin
    select g.gender_id into gender_id from public.genders g where lower(g.gender_name) = v_gender;
    if gender_id is null then
        raise exception 'Unknown gender "%" for employee "%": must be "female" or "male"', p_row->>'gender', p_row->>'name';
    end if;

    select r.role_id into role_id from public.roles r where lower(r.role_name) = v_role;
    if role_id is null then
        raise exception 'Unknown role "%" for employee "%": must be "user" or "admin"', p_row->>'role', p_row->>'name';
    end if;

    if v_position is null or v_position = '' then
        raise exception 'Missing position for employee "%"', p_row->>'name';
    end if;
    insert into public.positions (position) values (v_position) on conflict (position) do nothing;
    select p.post_id into post_id from public.positions p where p.position = v_position;

    if v_department is null or v_department = '' then
        raise exception 'Missing department for employee "%"', p_row->>'name';
    end if;
    insert into public.departments (department) values (v_department) on conflict (department) do nothing;
    select d.dept_id into dept_id from public.departments d where d.department = v_department;

    if v_business_unit is null or v_business_unit = '' then
        raise exception 'Missing business unit for employee "%"', p_row->>'name';
    end if;
    insert into public.business_units (business_unit) values (v_business_unit) on conflict (business_unit) do nothing;
    select b.bu_id into bu_id from public.business_units b where b.business_unit = v_business_unit;
end;
$$;

-- p_label only names the role in error messages ('Supervisor' / 'Second line').
-- The one-argument version is dropped first: keeping it next to this
-- defaulted one would make admin_resolve_supervisor('x') ambiguous.
drop function if exists public.admin_resolve_supervisor(text);

create or replace function public.admin_resolve_supervisor(p_supervisor text, p_label text default 'Supervisor')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_supervisor text := trim(p_supervisor);
    v_id uuid;
    v_match_count int;
begin
    if v_supervisor is null or v_supervisor = '' then
        return null;
    end if;

    select e.id into v_id from public.employees e where e.employee_id = v_supervisor;
    if v_id is not null then
        return v_id;
    end if;

    -- Employee ID ignoring format ('1' = '001'; see employee_code_key)
    select count(*), (array_agg(e.id))[1] into v_match_count, v_id
        from public.employees e
        where public.employee_code_key(e.employee_id) = public.employee_code_key(v_supervisor);
    if v_match_count = 1 then
        return v_id;
    elsif v_match_count > 1 then
        raise exception '% "%" matches more than one Employee ID — use the exact Employee ID', p_label, p_supervisor;
    end if;

    select count(*), min(e.id) into v_match_count, v_id
        from public.employees e where lower(e.name) = lower(v_supervisor);

    if v_match_count = 0 then
        raise exception '% "%" not found (by Employee ID or exact name)', p_label, p_supervisor;
    elsif v_match_count > 1 then
        raise exception '% name "%" matches more than one employee — use their Employee ID instead', p_label, p_supervisor;
    end if;

    return v_id;
end;
$$;

create or replace function public.admin_append_employees(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
    r jsonb;
    v_gender_id smallint;
    v_post_id   integer;
    v_dept_id   integer;
    v_bu_id     integer;
    v_role_id   smallint;
    v_count     integer := 0;
begin
    if not public.is_admin() then
        raise exception 'Only admins can perform this action';
    end if;

    for r in select * from jsonb_array_elements(p_rows)
    loop
        begin
            -- Employee ID already used, ignoring format ('001' = '1'): skip like a unique violation.
            if public.employee_code_key(r->>'employee_id') is not null and exists (
                select 1 from public.employees e
                where public.employee_code_key(e.employee_id) = public.employee_code_key(r->>'employee_id')
            ) then
                continue;
            end if;

            select f.gender_id, f.post_id, f.dept_id, f.bu_id, f.role_id
                into v_gender_id, v_post_id, v_dept_id, v_bu_id, v_role_id
                from public.admin_resolve_core_employee_fields(r) f;

            insert into public.employees
                (employee_id, name, gender, post_id, dept_id, bu_id,
                 hired_date, probation_end_date, last_day, role, email)
            values (
                nullif(trim(r->>'employee_id'), ''),
                trim(r->>'name'),
                v_gender_id, v_post_id, v_dept_id, v_bu_id,
                (r->>'hired_date')::date,
                nullif(r->>'probation_end_date', '')::date,
                nullif(r->>'last_day', '')::date,
                v_role_id,
                nullif(trim(r->>'email'), '')
            );

            v_count := v_count + 1;
        exception when unique_violation then
            continue;
        end;
    end loop;

    for r in select * from jsonb_array_elements(p_rows)
    loop
        if coalesce(trim(r->>'employee_id'), '') <> '' then
            if coalesce(trim(r->>'supervisor'), '') <> '' then
                update public.employees
                set supervisor_id = public.admin_resolve_supervisor(r->>'supervisor')
                where public.employee_code_key(employee_id) = public.employee_code_key(r->>'employee_id');
            end if;
            if coalesce(trim(r->>'second_line'), '') <> '' then
                update public.employees
                set second_line_id = public.admin_resolve_supervisor(r->>'second_line', 'Second line')
                where public.employee_code_key(employee_id) = public.employee_code_key(r->>'employee_id');
            end if;
        end if;
    end loop;

    return v_count;
end;
$$;

-- Bulk "Update from file": MERGE, never delete. Replaces the old
-- admin_overwrite_employees, which deleted every employee and (through ON DELETE
-- CASCADE) all leave requests, approvals, balance adjustments and employee-scoped
-- approval rules, and cleared every department head.
--
--   - Rows are matched to existing employees by Employee ID, ignoring format
--     (employee_code_key: '1' = '001' = 1.0). A row without an Employee ID is
--     matched by Email; a row with neither is rejected (it cannot be matched).
--   - Matched employee -> the file's values are applied; the row keeps its id, so
--     leave history, balances, approval rules, department-head links and portal
--     access all stay attached. Only columns present in the file (p_columns) are
--     touched; a blank cell in a present column clears an optional value (Last
--     day, Email, Supervisor, Second line). Probation end date can't be blank
--     (NOT NULL): a blank keeps the current value.
--   - Not matched -> inserted (Employee ID generated if the row has none).
--   - Employees that are not in the file are left exactly as they are.
--   - An employee linked to a portal account keeps their email (it is locked
--     while linked); the count is reported as email_kept.
--   - Two rows that resolve to the same employee ('1' and '001'), an email used
--     by someone else, or a change that would remove the caller's own admin
--     access abort the whole import (one transaction, nothing is saved).
--
-- Returns json: { inserted, updated, unchanged, untouched, email_kept }
--   updated    = matched employees whose data actually changed
--   unchanged  = matched employees already identical to the file
--   untouched  = existing employees that are not in the file
drop function if exists public.admin_overwrite_employees(jsonb);
drop function if exists public.admin_merge_employees(jsonb, text[]);

create or replace function public.admin_merge_employees(p_rows jsonb, p_columns text[] default null)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
    rec           record;
    r             jsonb;
    v_has         text[] := coalesce(p_columns, array[
                      'employee_id','name','gender','position','department','business_unit',
                      'supervisor','second_line','hired_date','probation_end_date','last_day','role','email']);
    v_gender_id   smallint;
    v_post_id     integer;
    v_dept_id     integer;
    v_bu_id       integer;
    v_role_id     smallint;
    v_code        text;
    v_key         text;
    v_email       text;
    v_hired       date;
    v_probation   date;
    v_last_day    date;
    v_emp         public.employees%rowtype;
    v_found       boolean;
    v_match_count integer;
    v_id          uuid;
    v_other       text;
    v_new_email   text;
    v_new_prob    date;
    v_new_last    date;
    v_new_role    smallint;
    v_sup         uuid;
    v_ids         uuid[] := '{}';
    v_new_ids     uuid[] := '{}';
    v_matched     uuid[] := '{}';
    v_changed     uuid[] := '{}';
    v_email_kept  integer := 0;
    v_updated     integer;
    v_matched_cnt integer;
    v_untouched   integer;
begin
    if not public.is_admin() then
        raise exception 'Only admins can perform this action';
    end if;
    if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
        raise exception 'No rows to import';
    end if;

    -- Pass 1: match / update / insert every row.
    for rec in select t.value, t.ordinality as n from jsonb_array_elements(p_rows) with ordinality as t(value, ordinality)
    loop
        r := rec.value;

        select f.gender_id, f.post_id, f.dept_id, f.bu_id, f.role_id
            into v_gender_id, v_post_id, v_dept_id, v_bu_id, v_role_id
            from public.admin_resolve_core_employee_fields(r) f;

        v_code      := nullif(regexp_replace(trim(coalesce(r->>'employee_id', '')), '^(\d+)\.0+$', '\1'), '');
        v_key       := public.employee_code_key(v_code);
        v_email     := nullif(trim(coalesce(r->>'email', '')), '');
        v_hired     := (r->>'hired_date')::date;
        v_probation := nullif(r->>'probation_end_date', '')::date;
        v_last_day  := nullif(r->>'last_day', '')::date;

        if v_key is null and v_email is null then
            raise exception 'Row "%" has no Employee ID or Email, so it cannot be matched to an existing employee — add one of them (or use Append for brand-new people)', r->>'name';
        end if;

        -- find the existing employee
        v_found := false;
        if v_key is not null then
            select count(*) into v_match_count from public.employees e
                where public.employee_code_key(e.employee_id) = v_key;
            if v_match_count > 1 then
                raise exception 'Employee ID "%" matches more than one existing employee — make their Employee IDs distinct first', v_code;
            end if;
            if v_match_count = 1 then
                select * into v_emp from public.employees e where public.employee_code_key(e.employee_id) = v_key;
                v_found := true;
            end if;
        else
            select * into v_emp from public.employees e where lower(trim(e.email)) = lower(v_email) limit 1;
            v_found := found;
        end if;

        if v_found then
            -- two file rows for the same person ('1' and '001', or the same email)
            if v_emp.id = any(v_matched) or v_emp.id = any(v_new_ids) then
                raise exception 'Two rows in the file are the same employee (%) — look for duplicate Employee IDs such as "1" and "001"', v_emp.employee_id;
            end if;
            v_matched := v_matched || v_emp.id;
            v_id := v_emp.id;

            v_new_email := v_emp.email;
            if 'email' = any(v_has) then
                if lower(coalesce(v_email, '')) = lower(coalesce(trim(v_emp.email), '')) then
                    v_new_email := v_emp.email;                       -- same address (maybe different case)
                elsif v_emp.auth_user_id is not null then
                    v_email_kept := v_email_kept + 1;                 -- locked while portal access is linked
                else
                    v_new_email := v_email;
                end if;
            end if;
            if v_new_email is not null and v_new_email is distinct from v_emp.email then
                select e.employee_id into v_other from public.employees e
                    where lower(trim(e.email)) = lower(v_new_email) and e.id <> v_emp.id limit 1;
                if v_other is not null then
                    raise exception 'Email "%" is already used by employee %', v_new_email, v_other;
                end if;
            end if;

            v_new_prob := coalesce(v_probation,
                case when v_emp.probation_end_date >= v_hired then v_emp.probation_end_date
                     else (v_hired + interval '3 months')::date end);
            v_new_last := case when 'last_day' = any(v_has) then v_last_day else v_emp.last_day end;
            v_new_role := case when 'role'     = any(v_has) then v_role_id  else v_emp.role     end;

            if (v_emp.name, v_emp.gender, v_emp.post_id, v_emp.dept_id, v_emp.bu_id, v_emp.hired_date,
                v_emp.probation_end_date, v_emp.last_day, v_emp.role, v_emp.email)
               is distinct from
               (trim(r->>'name'), v_gender_id, v_post_id, v_dept_id, v_bu_id, v_hired,
                v_new_prob, v_new_last, v_new_role, v_new_email)
            then
                update public.employees
                set name = trim(r->>'name'), gender = v_gender_id, post_id = v_post_id, dept_id = v_dept_id,
                    bu_id = v_bu_id, hired_date = v_hired, probation_end_date = v_new_prob,
                    last_day = v_new_last, role = v_new_role, email = v_new_email
                where id = v_emp.id;
                v_changed := v_changed || v_emp.id;
            end if;
        else
            if v_email is not null then
                select e.employee_id into v_other from public.employees e
                    where lower(trim(e.email)) = lower(v_email) limit 1;
                if v_other is not null then
                    raise exception 'Email "%" is already used by employee % (a different Employee ID than the file row "%")', v_email, v_other, coalesce(v_code, r->>'name');
                end if;
            end if;

            insert into public.employees
                (employee_id, name, gender, post_id, dept_id, bu_id,
                 hired_date, probation_end_date, last_day, role, email)
            values (v_code, trim(r->>'name'), v_gender_id, v_post_id, v_dept_id, v_bu_id,
                    v_hired, v_probation, v_last_day, v_role_id, v_email)
            returning id into v_id;
            v_new_ids := v_new_ids || v_id;
        end if;

        v_ids[rec.n::integer] := v_id;
    end loop;

    -- Pass 2: supervisors / second lines (every row now exists, so they can point at each other).
    for rec in select t.value, t.ordinality as n from jsonb_array_elements(p_rows) with ordinality as t(value, ordinality)
    loop
        v_id := v_ids[rec.n::integer];

        if 'supervisor' = any(v_has) then
            v_sup := public.admin_resolve_supervisor(rec.value->>'supervisor');
            if v_sup = v_id then
                raise exception 'Employee "%" cannot be their own supervisor', rec.value->>'name';
            end if;
            update public.employees set supervisor_id = v_sup
                where id = v_id and supervisor_id is distinct from v_sup;
            if found and not (v_id = any(v_new_ids)) then v_changed := v_changed || v_id; end if;
        end if;

        if 'second_line' = any(v_has) then
            v_sup := public.admin_resolve_supervisor(rec.value->>'second_line', 'Second line');
            if v_sup = v_id then
                raise exception 'Employee "%" cannot be their own second line', rec.value->>'name';
            end if;
            update public.employees set second_line_id = v_sup
                where id = v_id and second_line_id is distinct from v_sup;
            if found and not (v_id = any(v_new_ids)) then v_changed := v_changed || v_id; end if;
        end if;
    end loop;

    -- The importing admin must still be an admin afterwards.
    if not public.is_admin() then
        raise exception 'This file would remove your own admin access (your row would become a non-admin or inactive). Nothing was changed.';
    end if;

    select count(distinct x) into v_updated     from unnest(v_changed) x;
    select count(distinct x) into v_matched_cnt from unnest(v_matched) x;
    select count(*) into v_untouched from public.employees e where e.id <> all(v_ids);

    return json_build_object(
        'inserted',   coalesce(cardinality(v_new_ids), 0),
        'updated',    v_updated,
        'unchanged',  v_matched_cnt - v_updated,
        'untouched',  v_untouched,
        'email_kept', v_email_kept
    );
end;
$$;

revoke all on function public.admin_merge_employees(jsonb, text[]) from public, anon;
grant execute on function public.admin_merge_employees(jsonb, text[]) to authenticated, service_role;

-- =====================================================================
-- Realtime helper (used at the bottom of 01-05).
-- Adds tables to the supabase_realtime publication so the browser can
-- subscribe to their changes (assets/js/supabaseClient.js -> RealtimeSync).
-- Idempotent; RLS still applies, so a subscriber only receives rows its
-- select policy allows. Not callable from the API (SQL editor / migrations only).
-- =====================================================================
create or replace function public.ess_enable_realtime(p_tables text[])
returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
    t text;
begin
    if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
        raise notice 'Publication supabase_realtime not found — skipping realtime setup';
        return;
    end if;

    foreach t in array p_tables loop
        if not exists (
            select 1 from pg_publication_tables
            where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
        ) then
            execute format('alter publication supabase_realtime add table public.%I', t);
        end if;
    end loop;
end;
$$;

revoke all on function public.ess_enable_realtime(text[]) from public, anon, authenticated;

select public.ess_enable_realtime(array['employees']);
