-- =====================================================================
-- Employee Leave Management System — Employee Information Schema
-- Target: Supabase (PostgreSQL), public schema
--
-- Re-running this script: fully idempotent. Table/function/trigger/policy
-- DDL uses IF NOT EXISTS / CREATE OR REPLACE / DROP...IF EXISTS + CREATE.
-- All seed data (lookup tables and sample employees) uses
-- ON CONFLICT DO NOTHING, so re-running never overwrites or deletes
-- existing rows — including edits made to previously-seeded data, or any
-- real employees added since.
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
-- Null means no supervisor assigned (e.g. top of the org chart).
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

insert into public.positions (position) values
    ('Software Engineer'),
    ('HR Executive'),
    ('Accountant'),
    ('Sales Manager'),
    ('Operations Supervisor')
on conflict (position) do nothing;

create table if not exists public.departments (
    dept_id             serial primary key,
    department          text not null unique,
    is_active           boolean not null default true,
    modified_by         uuid,
    last_modified       timestamptz not null default now()
);
alter table public.departments add column if not exists is_active boolean not null default true;

insert into public.departments (department) values
    ('Information Technology'),
    ('Human Resources'),
    ('Finance'),
    ('Sales'),
    ('Operations')
on conflict (department) do nothing;

create table if not exists public.business_units (
    bu_id               serial primary key,
    business_unit       text not null unique,
    is_active           boolean not null default true,
    modified_by         uuid,
    last_modified       timestamptz not null default now()
);
alter table public.business_units add column if not exists is_active boolean not null default true;

insert into public.business_units (business_unit) values
    ('Headquarters'),
    ('Regional Branch - North'),
    ('Regional Branch - South')
on conflict (business_unit) do nothing;


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
    supervisor_id       uuid references public.employees (id), -- nullable: top of the org chart, or not yet assigned
    hired_date          date not null,
    probation_end_date  date not null, -- defaults to hired_date + 3 months (see trigger below); freely editable after that
    last_day            date,
    role                smallint not null references public.roles (role_id),
    email               text unique, -- optional; grants portal access when set (see auth linking model above)
    modified_by         uuid references public.employees (id),
    last_modified       timestamptz not null default now(),
    constraint employees_last_day_check check (last_day is null or last_day >= hired_date),
    constraint employees_probation_end_date_check check (probation_end_date >= hired_date),
    constraint employees_supervisor_not_self check (supervisor_id is null or supervisor_id <> id)
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


-- Sample employees. Idempotent via ON CONFLICT (email) DO NOTHING below —
-- rows are inserted once and never touched again on subsequent runs, so
-- re-running this script never overwrites or deletes real employee data
-- (including edits made to these same sample rows after the first run).
insert into public.employees
    (name, gender, post_id, dept_id, bu_id, hired_date, last_day, role, email)
select v.name, v.gender, p.post_id, d.dept_id, b.bu_id, v.hired_date::date, v.last_day::date, v.role, v.email
from (
    values
        ('Rotha Mek',       0, 'HR Executive',           'Human Resources',           'Headquarters',             '2021-09-01', null,         1, 'mek.rotha@gmail.com'),
        ('Sokha Chan',      0, 'HR Executive',            'Human Resources',           'Headquarters',             '2021-03-15', null,         0, 'sokha.chan@company.com'),
        ('Dara Pich',       1, 'Software Engineer',       'Information Technology',    'Headquarters',             '2022-06-01', null,         0, 'dara.pich@company.com'),
        ('Sreymom Kim',     0, 'Accountant',              'Finance',                   'Headquarters',             '2020-01-10', null,         0, 'sreymom.kim@company.com'),
        ('Vichet Ly',       1, 'Sales Manager',           'Sales',                     'Regional Branch - North',  '2019-09-01', null,         0, 'vichet.ly@company.com'),
        ('Bopha Sok',       0, 'Operations Supervisor',   'Operations',                'Regional Branch - South',  '2023-02-20', null,         0, 'bopha.sok@company.com'),
        ('Rithy Vong',      1, 'Software Engineer',       'Information Technology',    'Headquarters',             '2018-11-05', '2024-12-31', 0, 'rithy.vong@company.com')
) as v(name, gender, position, department, business_unit, hired_date, last_day, role, email)
join public.positions p on p.position = v.position
join public.departments d on d.department = v.department
join public.business_units b on b.business_unit = v.business_unit
on conflict (email) do nothing;

-- Optional demo data: give the other sample employees a supervisor
-- (Rotha Mek). Gated on supervisor_id is null so this only ever fills in
-- a still-blank value — never overwrites a manual reassignment made
-- after the first run.
update public.employees emp
set supervisor_id = sup.id
from public.employees sup
where sup.email = 'mek.rotha@gmail.com'
  and emp.email in (
      'sokha.chan@company.com', 'dara.pich@company.com', 'sreymom.kim@company.com',
      'vichet.ly@company.com', 'bopha.sok@company.com', 'rithy.vong@company.com'
  )
  and emp.supervisor_id is null;


-- =====================================================================
-- ROW LEVEL SECURITY
-- =====================================================================
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
    where e.auth_user_id = auth.uid();
$$;

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

-- Employees: self can read own row; admins can read/write everyone.
drop policy if exists "employees_select_self_or_admin" on public.employees;
create policy "employees_select_self_or_admin" on public.employees
    for select to authenticated
    using (auth_user_id = auth.uid() or public.is_admin());

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

-- =====================================================================
-- EMPLOYEES PAGE FUNCTIONS
-- (stat cards + spreadsheet Append/Overwrite for the Employees page —
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

create or replace function public.admin_resolve_supervisor(p_supervisor text)
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

    select count(*), min(e.id) into v_match_count, v_id
        from public.employees e where lower(e.name) = lower(v_supervisor);

    if v_match_count = 0 then
        raise exception 'Supervisor "%" not found (by Employee ID or exact name)', p_supervisor;
    elsif v_match_count > 1 then
        raise exception 'Supervisor name "%" matches more than one employee — use their Employee ID instead', p_supervisor;
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
        if coalesce(trim(r->>'supervisor'), '') <> '' and coalesce(trim(r->>'employee_id'), '') <> '' then
            update public.employees
            set supervisor_id = public.admin_resolve_supervisor(r->>'supervisor')
            where employee_id = trim(r->>'employee_id');
        end if;
    end loop;

    return v_count;
end;
$$;

create or replace function public.admin_overwrite_employees(p_rows jsonb)
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

    update public.positions      set modified_by = null;
    update public.departments    set modified_by = null;
    update public.business_units set modified_by = null;

    delete from public.employees;

    for r in select * from jsonb_array_elements(p_rows)
    loop
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
    end loop;

    for r in select * from jsonb_array_elements(p_rows)
    loop
        if coalesce(trim(r->>'supervisor'), '') <> '' and coalesce(trim(r->>'employee_id'), '') <> '' then
            update public.employees
            set supervisor_id = public.admin_resolve_supervisor(r->>'supervisor')
            where employee_id = trim(r->>'employee_id');
        end if;
    end loop;

    return v_count;
end;
$$;
