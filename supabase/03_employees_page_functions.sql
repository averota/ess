-- =====================================================================
-- Employees page — additions to 01_employee_info_schema.sql
-- Target: Supabase (PostgreSQL), public schema
--
-- Run this AFTER 01_employee_info_schema.sql has already been run once.
-- Idempotent (CREATE OR REPLACE FUNCTION) — safe to re-run any time you
-- update these functions later.
--
-- Adds:
--   - admin_get_employee_stats()        stat cards on the Employees page
--   - admin_resolve_core_employee_fields(jsonb)   internal helper
--   - admin_resolve_supervisor(text)              internal helper
--   - admin_append_employees(jsonb)     bulk upload: append new rows
--   - admin_overwrite_employees(jsonb)  bulk upload: replace entire table
--   - two extra indexes used by the stat cards
--
-- All four "admin_*" entry points check public.is_admin() themselves,
-- since they're SECURITY DEFINER and therefore bypass RLS — the RLS
-- policies on public.employees are not consulted while they run.
--
-- Soft-delete note: this app does NOT hard-delete employees from the
-- UI. "Removing" an employee sets employees.last_day instead (an
-- ordinary UPDATE, already covered by the existing
-- "employees_admin_update" RLS policy — no new function needed for
-- that). These bulk functions exist only for the spreadsheet
-- Append/Overwrite actions.
-- =====================================================================

create index if not exists idx_employees_last_day           on public.employees (last_day);
create index if not exists idx_employees_probation_end_date on public.employees (probation_end_date);
create index if not exists idx_employees_hired_date         on public.employees (hired_date);


-- ---------------------------------------------------------------------
-- Stat cards: active headcount, female headcount, portal-linked users,
-- new hires this month, on probation. "Active" = no last_day, or
-- last_day today-or-later.
-- ---------------------------------------------------------------------
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


-- ---------------------------------------------------------------------
-- Shared resolution helpers for bulk upload (both Append and Overwrite)
-- ---------------------------------------------------------------------

-- Resolves gender/role (strict match against fixed lookup values) and
-- position/department/business_unit (auto-created if the text doesn't
-- match an existing entry yet — these are open-ended lookup tables).
-- p_row keys expected: gender, role, position, department, business_unit, name.
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

-- Resolves a supervisor reference by Employee ID first (unambiguous),
-- falling back to an exact case-insensitive name match if exactly one
-- employee has that name. Returns null for a blank/empty input.
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


-- ---------------------------------------------------------------------
-- admin_append_employees — inserts new rows, skips rows that collide
-- with an existing Employee ID or email (unique_violation). Runs as one
-- transaction: a bad gender/role/position/department/business_unit
-- value aborts the whole call and nothing is inserted.
--
-- p_rows: jsonb array of objects with keys
--   employee_id (optional — blank = auto-generated), name, gender,
--   position, department, business_unit, supervisor (optional — see
--   note above about pairing with employee_id), hired_date,
--   probation_end_date (optional), last_day (optional), role (optional,
--   defaults to "user"), email (optional)
--
-- Returns the number of rows actually inserted.
-- ---------------------------------------------------------------------
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

    -- Pass 1: insert every row. Supervisor is intentionally left unset
    -- here — a supervisor named in this same file might not exist yet.
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
            -- Employee ID or email already exists in the table — skip,
            -- matching "Append" semantics of only adding what's new.
            continue;
        end;
    end loop;

    -- Pass 2: now every row from this file exists, so supervisor names
    -- (including ones later in the same file) can be resolved. Only
    -- rows that supplied their own Employee ID can be matched here.
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


-- ---------------------------------------------------------------------
-- admin_overwrite_employees — PERMANENTLY deletes every employee row,
-- then inserts the given rows. Single atomic transaction. Also clears
-- modified_by on positions/departments/business_units first, since
-- those columns reference employees(id) and would otherwise block the
-- delete with a foreign-key error.
--
-- Same p_rows shape as admin_append_employees. Returns the number of
-- rows inserted.
-- ---------------------------------------------------------------------
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
