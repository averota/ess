// =====================================================================
// leave-telegram-notify — Supabase Edge Function
//
// Called by the database (pg_net, see supabase/leave_telegram_notify.sql)
// after a leave_requests / leave_request_approvals change. Resolves who
// should hear about it, builds the message, and sends it through the
// Telegram bot. Employees with no telegram_chat_id are silently skipped;
// a Telegram failure never surfaces to the caller.
//
// Request body: { event, request_id, actor_id }
// Auth:         header `x-webhook-secret` must equal LEAVE_NOTIFY_SECRET
//               (deploy with --no-verify-jwt; the shared secret is the gate).
// Secrets:      TELEGRAM_BOT_TOKEN, LEAVE_NOTIFY_SECRET
//               (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected).
// =====================================================================
import { createClient } from 'npm:@supabase/supabase-js@2';

type LeaveEvent =
  | 'submitted'      // new request, pending
  | 'auto_approved'  // new request created already approved
  | 'step_approved'  // an approval step was approved (may or may not be the last)
  | 'approved'       // request fully approved
  | 'rejected'
  | 'cancelled'
  | 'updated';       // details edited (dates / type / days)

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN');
const WEBHOOK_SECRET = Deno.env.get('LEAVE_NOTIFY_SECRET');

const sb = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
);

const ROLE_LABEL: Record<string, string> = {
  first_line: 'first-line manager',
  second_line: 'second-line manager',
  hod: 'head of department',
};

const esc = (v: unknown) =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const fmtDate = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
  });

const halfLabel = (h: string) => (h === 'am' ? ' (AM)' : h === 'pm' ? ' (PM)' : '');

async function sendTelegram(chatId: string, text: string) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) console.warn(`telegram ${res.status}: ${await res.text()}`);
  } catch (err) {
    console.warn('telegram send failed:', err);
  }
}

async function handle(event: LeaveEvent, requestId: string, actorId: string | null) {
  const { data: req } = await sb
    .from('leave_requests')
    .select('id, employee_id, leave_type_id, status, start_date, start_half_day, end_date, end_half_day, total_days, reason, rejection_reason')
    .eq('id', requestId)
    .maybeSingle();
  if (!req) return;

  const [{ data: type }, { data: steps }, { data: emp }] = await Promise.all([
    sb.from('leave_types').select('leave_type').eq('leave_type_id', req.leave_type_id).maybeSingle(),
    sb.from('leave_request_approvals')
      .select('step_no, approver_role, status, approved_by')
      .eq('leave_request_id', requestId)
      .order('step_no'),
    sb.from('employees')
      .select('id, name, employee_id, supervisor_id, second_line_id, dept_id')
      .eq('id', req.employee_id)
      .single(),
  ]);
  if (!emp) return;

  const { data: dept } = emp.dept_id != null
    ? await sb.from('departments').select('hod_id').eq('dept_id', emp.dept_id).maybeSingle()
    : { data: null };

  const holderOf = (role: string): string | null =>
    role === 'first_line' ? emp.supervisor_id
      : role === 'second_line' ? emp.second_line_id
      : role === 'hod' ? dept?.hod_id ?? null
      : null;

  const stepList = steps ?? [];
  const pending = stepList.find((s) => s.status === 0);
  const pendingHolder = pending ? holderOf(pending.approver_role) : null;

  // One lookup for every person who might be named or messaged.
  const ids = [...new Set([
    req.employee_id, actorId, pendingHolder,
    ...stepList.map((s) => s.approved_by),
    ...stepList.map((s) => holderOf(s.approver_role)),
  ].filter(Boolean))] as string[];
  const { data: peopleRows } = await sb
    .from('employees').select('id, name, telegram_chat_id').in('id', ids);
  const people = new Map((peopleRows ?? []).map((p) => [p.id, p]));
  const who = (id: string | null) => esc(people.get(id ?? '')?.name ?? 'Someone');
  // Actor with no employee record (e.g. super admin) shows as "Admin".
  const actor = esc(people.get(actorId ?? '')?.name ?? 'Admin');

  // ---- message building ----------------------------------------------
  const n = Number(req.total_days);

  // 1. Icon & Dates
  const icon = type?.icon || (type?.leave_type?.toLowerCase().includes('sick') ? '🤒' : '🌴');
  const startFmt = `${fmtDate(req.start_date)}${halfLabel(req.start_half_day)}`;
  const endFmt = `${fmtDate(req.end_date)}${halfLabel(req.end_half_day)}`;
  const isSameDay = startFmt === endFmt;
  const dateRange = isSameDay ? `<code>${startFmt}</code>` : `<code>${startFmt}</code> ➔ <code>${endFmt}</code>`;

  // 2. Beautiful 3-line Detail Card
  const detail =
    `👤 <b>${esc(emp.name)}</b> (<code>${esc(emp.employee_id)}</code>)\n` +
    `${icon} <b>${esc(type?.leave_type ?? 'Leave')}</b> · <b>${n} day${n === 1 ? '' : 's'}</b>\n` +
    `📅 ${dateRange}` +
    (req.reason?.trim() ? `\n<blockquote>💬 <b>Reason:</b> ${esc(req.reason.trim())}</blockquote>` : '');

  // 3. Subtle Workflow Footers
  const awaiting = pending
    ? `⏳ <i>Awaiting ${who(pendingHolder)} (${ROLE_LABEL[pending.approver_role] || pending.approver_role})</i>`
    : '⏳ <i>Awaiting approval</i>';
  const byActor = actorId && actorId !== req.employee_id;

  // Order matters: when one person gets several messages, the first wins,
  // so "action needed" messages to approvers are pushed before employee ones.
  const msgs: Array<[string | null, string]> = [];
  const toEmp = (t: string) => msgs.push([req.employee_id, t]);
  const toApprover = (id: string | null, t: string) => msgs.push([id, t]);

  switch (event) {
    case 'submitted':
      toApprover(
        pendingHolder,
        `🔔 <b>Leave approval needed</b>\n\n${detail}\n\n👤 <i>Submitted by ${actor}</i>`
      );
      toEmp(
        `📝 <b>Leave request submitted</b>\n\n${detail}\n\n${awaiting}` +
        (byActor ? `\n✍️️ <i>Filed on your behalf by ${actor}</i>` : '')
      );
      break;

    case 'auto_approved':
      toEmp(
        `✅ <b>Leave approved</b>\n\n${detail}\n\n⚡ <i>Created and approved on your behalf by ${actor}</i>`
      );
      break;

    case 'step_approved': {
      if (req.status !== 0 || !pending) return;
      toApprover(
        pendingHolder,
        `🔔 <b>Leave approval needed</b>\n\n${detail}\n\n👍 <i>Previous approval by ${actor}</i>`
      );
      toEmp(
        `⏳ <b>Leave request progressed</b>\n\n${detail}\n\n👍 <i>Approved by ${actor}</i> · ${awaiting}`
      );
      break;
    }

    case 'approved':
      toEmp(`✅ <b>Leave approved</b>\n\n${detail}\n\n🎉 <i>Approved by ${actor}</i>`);
      break;

    case 'rejected': {
      const rejectReason = req.rejection_reason?.trim()
        ? `\n<blockquote>🛑 <b>Rejection note:</b> ${esc(req.rejection_reason.trim())}</blockquote>`
        : '';
      toEmp(
        `❌ <b>Leave rejected</b>\n\n${detail}${rejectReason}\n\n🚫 <i>Rejected by ${actor}</i>`
      );
      break;
    }

    case 'cancelled': {
      const cancelledStep = stepList.find((s) => s.status === 3);
      const involved = [
        ...stepList.filter((s) => s.status === 1).map((s) => s.approved_by),
        cancelledStep ? holderOf(cancelledStep.approver_role) : null,
      ];
      for (const id of involved) {
        toApprover(
          id,
          `🚫 <b>Leave request cancelled</b>\n\n${detail}\n\nℹ️ <i>Cancelled by ${actor}</i>`
        );
      }
      toEmp(`🚫 <b>Leave cancelled</b>\n\n${detail}\n\nℹ️ <i>Cancelled by ${actor}</i>`);
      break;
    }

    case 'updated':
      if (req.status === 0) {
        toApprover(
          pendingHolder,
          `✏️ <b>Pending leave request changed</b>\n\n${detail}\n\n📝 <i>Edited by ${actor}</i>`
        );
      }
      toEmp(`✏️ <b>Leave request updated</b>\n\n${detail}\n\n📝 <i>Edited by ${actor}</i>`);
      break;
  }

  // ---- dispatch: skip actor, dedupe, silently skip unsubscribed -------
  const seen = new Set<string>();
  const jobs: Promise<void>[] = [];
  for (const [id, text] of msgs) {
    if (!id || id === actorId || seen.has(id)) continue;
    seen.add(id);
    const chatId = String(people.get(id)?.telegram_chat_id ?? '').trim();
    if (chatId) jobs.push(sendTelegram(chatId, text));
  }
  await Promise.allSettled(jobs);
}

Deno.serve(async (r) => {
  if (r.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!WEBHOOK_SECRET || r.headers.get('x-webhook-secret') !== WEBHOOK_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }
  if (!BOT_TOKEN) {
    console.error('TELEGRAM_BOT_TOKEN secret is not set');
    return new Response(JSON.stringify({ ok: false }), { status: 200 });
  }
  try {
    const { event, request_id, actor_id } = await r.json();
    if (event && request_id) await handle(event as LeaveEvent, request_id, actor_id ?? null);
  } catch (err) {
    console.error('leave-telegram-notify failed:', err);
  }
  // Always 200: notifications are best-effort and must never be retried into duplicates.
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
});