/* =====================================================================
   ESS — Room booking recurrence helpers (assets/js/roomBookingRecurrence.js)

   Pure date logic for recurring room bookings; no DOM, no Supabase.
   Loaded before calendar.js, exposes window.BookingRecurrence.

   Everything works on local-midnight Date objects / 'yyyy-mm-dd' keys.
   Bookings are date + time-of-day (room_bookings.booking_date / start_time
   / end_time), so every occurrence of a series keeps the same times and
   only the date moves — nothing here can drift with DST.

   Flow used by calendar.js when creating a recurring booking:
     expandDates(startKey, rule, untilKey)      -> { dates, truncated }
     applyAdjustments(dates, options)           -> dates (weekend/holiday shifted)
     toKey(date)                                -> 'yyyy-mm-dd' per occurrence
   ===================================================================== */
(function (global) {
  'use strict';

  const MAX_OCCURRENCES = 366;
  const RULES = ['daily', 'weekly', 'monthly', 'yearly'];
  const LABELS = {
    daily: 'Repeats daily',
    weekly: 'Repeats weekly',
    monthly: 'Repeats monthly',
    yearly: 'Repeats yearly'
  };

  const pad2 = (n) => String(n).padStart(2, '0');
  const toKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  function parseKey(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function addDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
  }

  // Jan 31 + 1 month -> Feb 28/29 (clamped), not Mar 3. Years reuse this
  // (Feb 29 -> Feb 28 on non-leap years).
  function addMonthsClamped(date, months) {
    const d = new Date(date.getFullYear(), date.getMonth() + months, 1);
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(date.getDate(), lastDay));
    return d;
  }

  /**
   * Dates of a series: the start date plus every repeat up to `untilKey`
   * (inclusive). `rule` is null/'none' or one of RULES. Each repeat is
   * computed from the ORIGINAL start (start + N units), never from the
   * previous repeat, so a "31st of the month" series clamps to Feb 28 and
   * then correctly returns to the 31st.
   *
   * `truncated` is true when the MAX_OCCURRENCES cap cut the series short
   * before `untilKey`, so the caller can warn instead of silently under-booking.
   */
  function expandDates(startKey, rule, untilKey) {
    const start = parseKey(startKey);
    const dates = [start];
    if (!rule || rule === 'none' || !RULES.includes(rule)) return { dates, truncated: false };

    const until = parseKey(untilKey);
    let truncated = false;
    // One step past the cap on purpose: if it would still fall within
    // `until`, the series was genuinely cut off.
    for (let n = 1; n <= MAX_OCCURRENCES + 1; n++) {
      let d;
      if (rule === 'daily') d = addDays(start, n);
      else if (rule === 'weekly') d = addDays(start, n * 7);
      else if (rule === 'monthly') d = addMonthsClamped(start, n);
      else d = addMonthsClamped(start, n * 12);

      if (d > until) break;
      if (n > MAX_OCCURRENCES) { truncated = true; break; }
      dates.push(d);
    }
    return { dates, truncated };
  }

  /**
   * Moves every date that falls on an ignored day (Saturday / Sunday /
   * public holiday) to the nearest allowed day, `direction` 'backward'
   * (earlier day, default) or 'forward' (later day). Two dates landing on
   * the same day after shifting collapse into one rather than
   * double-booking. Result is sorted ascending.
   *
   * options: { ignoreSaturday, ignoreSunday, holidaySet (Set of 'yyyy-mm-dd', or null), direction }
   */
  function applyAdjustments(dates, options) {
    const { ignoreSaturday, ignoreSunday, holidaySet, direction } = options;
    if (!ignoreSaturday && !ignoreSunday && !(holidaySet && holidaySet.size)) return dates;

    const isBlocked = (d) => {
      const dow = d.getDay(); // 0 = Sun, 6 = Sat
      return (ignoreSaturday && dow === 6)
        || (ignoreSunday && dow === 0)
        || !!(holidaySet && holidaySet.has(toKey(d)));
    };
    const step = direction === 'forward' ? 1 : -1;

    const seen = new Set();
    const out = [];
    dates.forEach((date) => {
      const d = new Date(date);
      for (let guard = 0; guard < 14 && isBlocked(d); guard++) d.setDate(d.getDate() + step);
      const key = toKey(d);
      if (seen.has(key)) return;
      seen.add(key);
      out.push(d);
    });
    return out.sort((a, b) => a - b);
  }

  /** 'Alice, Bob ,, Carol' -> ['Alice', 'Bob', 'Carol'] */
  function parseInvitees(text) {
    return (text || '').split(',').map((s) => s.trim()).filter(Boolean);
  }

  const label = (rule) => LABELS[rule] || '';

  global.BookingRecurrence = {
    MAX_OCCURRENCES, expandDates, applyAdjustments, parseInvitees, label, toKey, parseKey
  };
})(window);
