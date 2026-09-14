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
    modified_by         uuid,
    last_modified       timestamptz not null default now()
);

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
    modified_by         uuid,
    last_modified       timestamptz not null default now()
);

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
    modified_by         uuid,
    last_modified       timestamptz not null default now()
);

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
    hired_date          date not null,
    last_day            date,
    role                smallint not null references public.roles (role_id),
    email               text unique, -- optional; grants portal access when set (see auth linking model above)
    modified_by         uuid references public.employees (id),
    last_modified       timestamptz not null default now(),
    constraint employees_last_day_check check (last_day is null or last_day >= hired_date)
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
create index if not exists idx_positions_modified_by on public.positions (modified_by);
create index if not exists idx_departments_modified_by on public.departments (modified_by);
create index if not exists idx_business_units_modified_by on public.business_units (modified_by);
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
-- exists and isn't linked yet.
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
        where email = new.email
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
-- email matches an employee row still waiting to be linked.
create or replace function public.link_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    update public.employees
    set auth_user_id = new.id
    where email = new.email
      and auth_user_id is null;
    return new;
end;
$$;

drop trigger if exists trg_link_new_auth_user on auth.users;
create trigger trg_link_new_auth_user
    after insert on auth.users
    for each row
    execute function public.link_new_auth_user();


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