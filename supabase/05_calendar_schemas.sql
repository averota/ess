-- =====================================================================
-- ESS — Calendar schema (05_calendar_schemas.sql): holidays + room booking
-- Independent of 02_leaves_schema.sql / 03_policies_schemas.sql.
-- External dependencies: public.is_admin()  (from 01_employee_info_schema.sql)
--                        auth.users / auth.uid()  (Supabase Auth)
--
-- Tables
--   holidays(id, date UNIQUE, description, remark, created_at)
--   rooms(id, name UNIQUE, location, capacity, is_active, created_at)
--   room_bookings(id, room_id, booking_date, start_time, end_time, title,
--                 notes, invitees, recurrence_group_id, recurrence_rule,
--                 booked_by, booker_name, created_at, updated_at)
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


-- =====================================================================
-- ROOM BOOKING
--
-- Access model
--   rooms:          select = any authenticated user; write = admin only.
--   room_bookings:  select = any authenticated user (shared schedule);
--                   insert = signed-in user, only as themselves
--                            (booked_by = auth.uid()) and only into an
--                            active room;
--                   update/delete = the booking's owner OR an admin.
--
-- Rules enforced in the database (not just the UI)
--   - one booking = one room on one day, end_time > start_time
--   - no two bookings in the same room may overlap (back-to-back is fine:
--     the time range is half-open [start, end)) -> SQLSTATE 23P01
--   - booked_by / booker_name are frozen on update, so an admin editing
--     someone's booking can't change who owns it, and an owner can't
--     hand it to someone else
--   - recurring meetings are stored as one row per occurrence, all sharing
--     a recurrence_group_id (+ recurrence_rule). Editing a row changes that
--     occurrence only; the series link is frozen on update. Deleting one
--     occurrence, "this and following" or the whole series is a plain
--     DELETE filtered on id / recurrence_group_id (+ booking_date), so the
--     same owner-or-admin policy covers all three. A bulk INSERT of a whole
--     series is a single statement, so it succeeds or fails as one unit
--     (an overlap on any date rejects the lot).
--   - invitees is informational free text (comma-separated names).
--
-- booked_by is the auth user id (admins have no employees row, so it can't
-- point at employees). booker_name is a display-name snapshot sent by the
-- client (employee.name from ess:ready); ownership checks never rely on it.
-- =====================================================================

-- Needed for the "same room + overlapping time" exclusion constraint.
create extension if not exists btree_gist with schema extensions;

create table if not exists public.rooms (
  id         bigint generated always as identity primary key,
  name       text not null unique,
  location   text,
  capacity   integer check (capacity is null or capacity > 0),
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.rooms enable row level security;

drop policy if exists rooms_select_all   on public.rooms;
drop policy if exists rooms_insert_admin on public.rooms;
drop policy if exists rooms_update_admin on public.rooms;
drop policy if exists rooms_delete_admin on public.rooms;

create policy rooms_select_all
  on public.rooms for select
  to authenticated
  using (true);

create policy rooms_insert_admin
  on public.rooms for insert
  to authenticated
  with check (public.is_admin());

create policy rooms_update_admin
  on public.rooms for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy rooms_delete_admin
  on public.rooms for delete
  to authenticated
  using (public.is_admin());

create table if not exists public.room_bookings (
  id           bigint generated always as identity primary key,
  room_id      bigint not null references public.rooms (id) on delete cascade,
  booking_date date   not null,
  start_time   time   not null,
  end_time     time   not null,
  title        text   not null,
  notes        text,
  invitees     text,
  recurrence_group_id uuid,
  recurrence_rule     text,
  booked_by    uuid   not null default auth.uid() references auth.users (id) on delete cascade,
  booker_name  text   not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint room_bookings_time_order check (end_time > start_time),
  constraint room_bookings_no_overlap exclude using gist (
    room_id with =,
    tsrange(booking_date + start_time, booking_date + end_time, '[)') with &&
  )
);

-- Upgrade path for databases that already have room_bookings from the first
-- version of this file (create table if not exists skips existing tables).
alter table public.room_bookings add column if not exists invitees            text;
alter table public.room_bookings add column if not exists recurrence_group_id uuid;
alter table public.room_bookings add column if not exists recurrence_rule     text;

alter table public.room_bookings drop constraint if exists room_bookings_recurrence_valid;
alter table public.room_bookings add constraint room_bookings_recurrence_valid check (
  (recurrence_group_id is null and recurrence_rule is null)
  or (recurrence_group_id is not null and recurrence_rule in ('daily', 'weekly', 'monthly', 'yearly'))
);

alter table public.room_bookings drop constraint if exists room_bookings_invitees_len;
alter table public.room_bookings add constraint room_bookings_invitees_len check (
  invitees is null or char_length(invitees) <= 500
);

create index if not exists room_bookings_date_idx  on public.room_bookings (booking_date);
create index if not exists room_bookings_group_idx on public.room_bookings (recurrence_group_id, booking_date)
  where recurrence_group_id is not null;
create index if not exists room_bookings_owner_idx on public.room_bookings (booked_by);

-- Freeze ownership + series link, and stamp updated_at, on every update.
create or replace function public.room_bookings_before_update()
returns trigger
language plpgsql
as $$
begin
  new.booked_by   := old.booked_by;
  new.booker_name := old.booker_name;
  new.recurrence_group_id := old.recurrence_group_id;
  new.recurrence_rule     := old.recurrence_rule;
  new.created_at  := old.created_at;
  new.updated_at  := now();
  return new;
end;
$$;

drop trigger if exists room_bookings_before_update on public.room_bookings;
create trigger room_bookings_before_update
  before update on public.room_bookings
  for each row execute function public.room_bookings_before_update();

alter table public.room_bookings enable row level security;

drop policy if exists room_bookings_select_all on public.room_bookings;
drop policy if exists room_bookings_insert_own on public.room_bookings;
drop policy if exists room_bookings_update_own on public.room_bookings;
drop policy if exists room_bookings_delete_own on public.room_bookings;

create policy room_bookings_select_all
  on public.room_bookings for select
  to authenticated
  using (true);

create policy room_bookings_insert_own
  on public.room_bookings for insert
  to authenticated
  with check (
    booked_by = auth.uid()
    and exists (select 1 from public.rooms r where r.id = room_id and r.is_active)
  );

create policy room_bookings_update_own
  on public.room_bookings for update
  to authenticated
  using      (booked_by = auth.uid() or public.is_admin())
  with check (booked_by = auth.uid() or public.is_admin());

create policy room_bookings_delete_own
  on public.room_bookings for delete
  to authenticated
  using (booked_by = auth.uid() or public.is_admin());
