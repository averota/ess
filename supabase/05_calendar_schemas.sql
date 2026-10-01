-- =====================================================================
-- ESS — Holidays schema (04_calendar_schema.sql)
-- Independent of 02_leaves_schema.sql / 03_policies_schemas.sql.
-- Only external dependency: public.is_admin()  (from 01_employee_info_schema.sql)
--
-- Table
--   holidays(id, date UNIQUE, description, remark, created_at)
--
-- Access model (same pattern as 03: everyone signed in can read, only
-- admins can write):
--   - select: any authenticated user
--   - insert/update/delete: public.is_admin() only (single-record
--     add/edit/delete flow from the modal, via direct sb.from() calls)
--
-- Bulk import RPCs (SECURITY DEFINER, so each runs as one atomic
-- transaction rather than separate client-side calls that could fail
-- halfway through). Contract matches assets/js/holidays.js exactly:
--   admin_append_holidays(p_rows jsonb)    -> integer inserted count
--   admin_overwrite_holidays(p_rows jsonb) -> integer inserted count
--   admin_clear_holidays()                 -> void
-- p_rows shape: [{ "date": "yyyy-mm-dd", "description": "...", "remark": "..." }, ...]
-- Every RPC re-checks public.is_admin() itself since SECURITY DEFINER
-- bypasses RLS.
-- =====================================================================

create table if not exists public.holidays (
  id          bigint generated always as identity primary key,
  date        date not null unique,
  description text not null,
  remark      text,
  created_at  timestamptz not null default now()
);

create index if not exists holidays_date_idx on public.holidays (date);

alter table public.holidays enable row level security;

drop policy if exists holidays_select_all   on public.holidays;
drop policy if exists holidays_insert_admin on public.holidays;
drop policy if exists holidays_update_admin on public.holidays;
drop policy if exists holidays_delete_admin on public.holidays;

create policy holidays_select_all
  on public.holidays for select
  to authenticated
  using (true);

create policy holidays_insert_admin
  on public.holidays for insert
  to authenticated
  with check (public.is_admin());

create policy holidays_update_admin
  on public.holidays for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy holidays_delete_admin
  on public.holidays for delete
  to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------
-- Bulk import RPCs
-- ---------------------------------------------------------------------

create or replace function public.admin_append_holidays(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if not public.is_admin() then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  insert into public.holidays (date, description, remark)
  select (r->>'date')::date, r->>'description', nullif(r->>'remark', '')
  from jsonb_array_elements(p_rows) as r
  on conflict (date) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.admin_overwrite_holidays(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if not public.is_admin() then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  delete from public.holidays;

  insert into public.holidays (date, description, remark)
  select (r->>'date')::date, r->>'description', nullif(r->>'remark', '')
  from jsonb_array_elements(p_rows) as r;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.admin_clear_holidays()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  delete from public.holidays;
end;
$$;

grant execute on function public.admin_append_holidays(jsonb)    to authenticated;
grant execute on function public.admin_overwrite_holidays(jsonb) to authenticated;
grant execute on function public.admin_clear_holidays()          to authenticated;