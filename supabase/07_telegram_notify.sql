-- =====================================================================
-- Leave module — Telegram notifications (database side)
-- Run AFTER 02_leaves_schema.sql. Idempotent.
--
-- Fires the `leave-telegram-notify` edge function (via pg_net, sent after
-- the transaction commits) whenever a leave request is created, edited,
-- progressed, approved, rejected or cancelled. Covers every code path
-- (RPCs, direct admin updates, calendar page) with no client changes.
-- Notification failures are swallowed: they can never block a leave action.
--
-- ONE-TIME SETUP (SQL editor, not committed to source control):
--   select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/leave-telegram-notify', 'leave_notify_url');
--   select vault.create_secret('<random string, same as edge secret LEAVE_NOTIFY_SECRET>',            'leave_notify_secret');
-- =====================================================================

create extension if not exists pg_net with schema extensions;

-- Telegram chat id used by the bot. No-op if the column already exists.
alter table public.employees add column if not exists telegram_chat_id text;

-- ---------------------------------------------------------------------
-- Single dispatcher used by both triggers.
-- ---------------------------------------------------------------------
create or replace function public.notify_leave_telegram(p_event text, p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_url    text;
    v_secret text;
begin
    select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'leave_notify_url';
    select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'leave_notify_secret';

    if v_url is null or v_secret is null then
        return; -- not configured: notifications off
    end if;

    perform net.http_post(
        url     := v_url,
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', v_secret),
        body    := jsonb_build_object(
                       'event',      p_event,
                       'request_id', p_request_id,
                       'actor_id',   public.current_employee_uuid()
                   ),
        timeout_milliseconds := 5000
    );
exception when others then
    raise warning 'leave telegram notify failed: %', sqlerrm;
end;
$$;

-- ---------------------------------------------------------------------
-- leave_requests: insert / status change / detail edit.
-- Named to sort after trg_leave_requests_generate_approval_steps so the
-- approval steps exist (and are current) by the time the event is sent.
-- ---------------------------------------------------------------------
create or replace function public.trg_leave_requests_telegram_fn()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    if tg_op = 'INSERT' then
        perform public.notify_leave_telegram(
            case when new.status = 0 then 'submitted' else 'auto_approved' end, new.id);

    elsif new.status is distinct from old.status then
        if new.status in (1, 2, 3) then
            perform public.notify_leave_telegram(
                case new.status when 1 then 'approved' when 2 then 'rejected' else 'cancelled' end,
                new.id);
        end if;

    elsif (old.leave_type_id, old.start_date, old.end_date, old.start_half_day, old.end_half_day, old.total_days)
          is distinct from
          (new.leave_type_id, new.start_date, new.end_date, new.start_half_day, new.end_half_day, new.total_days) then
        perform public.notify_leave_telegram('updated', new.id);
    end if;

    return null;
end;
$$;

drop trigger if exists trg_leave_requests_telegram on public.leave_requests;
create trigger trg_leave_requests_telegram
    after insert or update of status, leave_type_id, start_date, end_date, start_half_day, end_half_day, total_days
    on public.leave_requests
    for each row
    execute function public.trg_leave_requests_telegram_fn();

-- ---------------------------------------------------------------------
-- leave_request_approvals: a step was approved (covers the hand-off to
-- the next approver; the edge function ignores it when it was the last).
-- ---------------------------------------------------------------------
create or replace function public.trg_leave_request_approvals_telegram_fn()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    perform public.notify_leave_telegram('step_approved', new.leave_request_id);
    return null;
end;
$$;

drop trigger if exists trg_leave_request_approvals_telegram on public.leave_request_approvals;
create trigger trg_leave_request_approvals_telegram
    after update of status on public.leave_request_approvals
    for each row
    when (new.status = 1 and old.status is distinct from 1)
    execute function public.trg_leave_request_approvals_telegram_fn();

-- Internal only.
revoke all on function public.notify_leave_telegram(text, uuid)            from public, anon, authenticated;
revoke all on function public.trg_leave_requests_telegram_fn()             from public, anon, authenticated;
revoke all on function public.trg_leave_request_approvals_telegram_fn()    from public, anon, authenticated;
