-- =====================================================================
-- Employee Leave Management System — Portal access (link / delink)
-- Target: Supabase (PostgreSQL), public schema. Run after 01_employee_info_schema.sql.
-- Fully idempotent (CREATE OR REPLACE) — safe to re-run.
--
-- Used by the "Portal access" dialog in the employee details card
-- (employees.html / employees.js). No service_role key is needed in the
-- browser: both functions are SECURITY DEFINER and admin-only.
--
--   admin_link_employee_portal(employee uuid, password text, email text default null)
--     - If the employee has no email yet, p_email is required: it is
--       validated, checked for uniqueness and stored on the employee first.
--       If the employee already has an email, p_email is ignored.
--     - Creates a confirmed Supabase Auth user (email = employees.email,
--       password = the one supplied) + its email identity, then links it
--       via employees.auth_user_id.
--     - If an auth user with that email already exists (and isn't linked
--       to another employee) it is linked as-is; its password is NOT changed.
--
--   admin_delink_employee_portal(employee uuid)
--     - Deletes the employee's auth user (sessions/identities cascade) and
--       clears employees.auth_user_id (FK is ON DELETE SET NULL). The
--       employee row and all leave data are untouched. An admin cannot
--       delink their own account.
--
--   Email lock: while an employee is linked (auth_user_id is not null),
--   employees.email cannot be changed (trigger below, enforced in the
--   database as well as the UI). Delink first to change it.
-- =====================================================================

create extension if not exists pgcrypto;

-- search_path includes "extensions" because pgcrypto's crypt()/gen_salt()
-- live there on Supabase (or in public on some projects). Every table
-- reference below is schema-qualified.
-- The earlier two-argument version is dropped first: keeping it next to this
-- defaulted one would make calls ambiguous.
drop function if exists public.admin_link_employee_portal(uuid, text);

create or replace function public.admin_link_employee_portal(
    p_employee_uuid uuid,
    p_password      text,
    p_email         text default null
)
returns json
language plpgsql
security definer
set search_path = extensions, public, pg_temp
as $$
declare
    v_emp     public.employees%rowtype;
    v_email   text;
    v_new     text;
    v_user_id uuid;
begin
    if not public.is_admin() then
        raise exception 'Only admins can link portal access';
    end if;

    select * into v_emp from public.employees where id = p_employee_uuid;
    if not found then
        raise exception 'Employee not found';
    end if;
    if v_emp.auth_user_id is not null then
        raise exception 'This employee is already linked to a portal account';
    end if;
    if v_emp.last_day is not null and v_emp.last_day < current_date then
        raise exception 'This employee is inactive — reactivate them before linking portal access';
    end if;

    -- No email on file: take it from p_email and store it on the employee.
    if v_emp.email is null or trim(v_emp.email) = '' then
        v_new := lower(trim(coalesce(p_email, '')));
        if v_new = '' then
            raise exception 'Email is required to link portal access';
        end if;
        if v_new !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
            raise exception 'Invalid email address';
        end if;
        if exists (select 1 from public.employees e
                   where e.id <> p_employee_uuid and lower(trim(e.email)) = v_new) then
            raise exception 'This email is already used by another employee';
        end if;

        update public.employees set email = v_new where id = p_employee_uuid;
        v_emp.email := v_new;
    end if;

    v_email := lower(trim(v_emp.email));

    -- Existing auth user with this email: just link it.
    select u.id into v_user_id
    from auth.users u
    where lower(trim(u.email)) = v_email
    limit 1;

    if v_user_id is not null then
        if exists (select 1 from public.employees e
                   where e.auth_user_id = v_user_id and e.id <> p_employee_uuid) then
            raise exception 'A portal account with this email is already linked to another employee';
        end if;

        update public.employees set auth_user_id = v_user_id where id = p_employee_uuid;
        return json_build_object('status', 'linked_existing', 'email', v_email);
    end if;

    if p_password is null or length(p_password) < 8 then
        raise exception 'Password must be at least 8 characters';
    end if;

    v_user_id := gen_random_uuid();

    insert into auth.users (
        instance_id, id, aud, role, email, encrypted_password,
        email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
        created_at, updated_at,
        confirmation_token, recovery_token, email_change_token_new, email_change
    ) values (
        '00000000-0000-0000-0000-000000000000', v_user_id, 'authenticated', 'authenticated',
        v_email, crypt(p_password, gen_salt('bf')),
        now(), jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email')), '{}'::jsonb,
        now(), now(),
        '', '', '', ''
    );

    insert into auth.identities (
        id, user_id, provider_id, provider, identity_data,
        last_sign_in_at, created_at, updated_at
    ) values (
        gen_random_uuid(), v_user_id, v_user_id::text, 'email',
        jsonb_build_object('sub', v_user_id::text, 'email', v_email,
                           'email_verified', true, 'phone_verified', false),
        now(), now(), now()
    );

    -- trg_link_new_auth_user normally links the row on the insert above;
    -- this makes it explicit (no-op if already linked).
    update public.employees
    set auth_user_id = v_user_id
    where id = p_employee_uuid and auth_user_id is null;

    return json_build_object('status', 'created', 'email', v_email);
end;
$$;

create or replace function public.admin_delink_employee_portal(p_employee_uuid uuid)
returns void
language plpgsql
security definer
set search_path = extensions, public, pg_temp
as $$
declare
    v_user_id uuid;
begin
    if not public.is_admin() then
        raise exception 'Only admins can delink portal access';
    end if;

    select e.auth_user_id into v_user_id from public.employees e where e.id = p_employee_uuid;
    if not found then
        raise exception 'Employee not found';
    end if;
    if v_user_id is null then
        raise exception 'This employee is not linked to a portal account';
    end if;
    if v_user_id = auth.uid() then
        raise exception 'You cannot delink your own account';
    end if;

    delete from auth.users where id = v_user_id;   -- employees.auth_user_id -> null (ON DELETE SET NULL)

    update public.employees set auth_user_id = null where id = p_employee_uuid;
end;
$$;

revoke all on function public.admin_link_employee_portal(uuid, text, text) from public, anon;
revoke all on function public.admin_delink_employee_portal(uuid)     from public, anon;
grant execute on function public.admin_link_employee_portal(uuid, text, text) to authenticated, service_role;
grant execute on function public.admin_delink_employee_portal(uuid)     to authenticated, service_role;


-- ---------------------------------------------------------------------
-- Email lock while linked. Fires only when the email column is in the
-- UPDATE. A no-op "change" (same address, different case/whitespace) is
-- reverted to the stored value instead of raising.
-- ---------------------------------------------------------------------
create or replace function public.prevent_linked_email_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if old.auth_user_id is not null
       and new.auth_user_id is not null
       and new.email is distinct from old.email then
        if lower(trim(coalesce(new.email, ''))) = lower(trim(coalesce(old.email, ''))) then
            new.email := old.email;
        else
            raise exception 'Email is locked while the employee is linked to a portal account — delink portal access first';
        end if;
    end if;
    return new;
end;
$$;

drop trigger if exists trg_employees_lock_linked_email on public.employees;
create trigger trg_employees_lock_linked_email
    before update of email on public.employees
    for each row
    execute function public.prevent_linked_email_change();
