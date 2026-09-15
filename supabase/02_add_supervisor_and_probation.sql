-- =====================================================================
-- Migration: add employees.supervisor_id and employees.probation_end_date
-- Run this once against an existing database (one that already ran
-- 01_employee_info_schema.sql before these columns existed).
-- Safe to re-run: every statement is additive/idempotent and never
-- touches unrelated columns or rows.
-- =====================================================================

alter table public.employees add column if not exists supervisor_id uuid;
alter table public.employees add column if not exists probation_end_date date;

-- Backfill probation_end_date for existing rows before enforcing NOT NULL.
update public.employees
set probation_end_date = (hired_date + interval '3 months')::date
where probation_end_date is null;

alter table public.employees alter column probation_end_date set not null;

alter table public.employees drop constraint if exists employees_probation_end_date_check;
alter table public.employees add constraint employees_probation_end_date_check
    check (probation_end_date >= hired_date);

alter table public.employees drop constraint if exists employees_supervisor_id_fkey;
alter table public.employees add constraint employees_supervisor_id_fkey
    foreign key (supervisor_id) references public.employees (id);

alter table public.employees drop constraint if exists employees_supervisor_not_self;
alter table public.employees add constraint employees_supervisor_not_self
    check (supervisor_id is null or supervisor_id <> id);

create index if not exists idx_employees_supervisor_id on public.employees (supervisor_id);

-- Optional demo data: give the sample employees a supervisor (Rotha Mek).
-- Gated on supervisor_id is null, so this only fills in a still-blank
-- value — never overwrites a manual reassignment. Remove this block if
-- you don't want it.
update public.employees emp
set supervisor_id = sup.id
from public.employees sup
where sup.email = 'mek.rotha@gmail.com'
  and emp.email in (
      'sokha.chan@company.com', 'dara.pich@company.com', 'sreymom.kim@company.com',
      'vichet.ly@company.com', 'bopha.sok@company.com', 'rithy.vong@company.com'
  )
  and emp.supervisor_id is null;
