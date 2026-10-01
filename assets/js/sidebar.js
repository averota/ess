// assets/js/sidebar.js
//
// Reusable sidebar, shared by every page under /pages/.
// Handles the session guard, role-based page access, injecting the sidebar
// partial (filtered to the pages the user may open), the expand/collapse
// toggle (the logo + "Employee Self Service" row inside the sidebar),
// active-link highlighting, the user/sign-out footer, and lets other page
// scripts react via an event instead of re-fetching the same data.
//
// The sidebar is always visible: collapsed it is an icon rail (logo, page
// icons, user avatar); expanded it also shows the text labels.
//
// Anti-flicker (this is a multi-page site, so every click is a full page
// load): the last-known sidebar (partial HTML, allowed pages, user name /
// position) is cached in sessionStorage and painted synchronously, before
// any network call, and the expanded/collapsed state is remembered in
// localStorage. The real checks then run in parallel in the background and
// only touch the DOM if something actually changed. The page-to-page
// cross-fade itself is CSS (@view-transition in styles.css).
//
// Access rules (edit ACCESS below to change them):
//   - Admin (employees.role = 1): every page.
//   - admin (a login with no employees row, see 06_super_admin.sql):
//     treated as an admin, so every page too.
//   - Normal user: dashboard, leaves, calendar; plus employees when they
//     are a 1st-line, 2nd-line, or HOD approver (public.is_approver(),
//     see 05_approver_access.sql).
//   - Anything else redirects to dashboard.html.
//   - Inactive employees (last_day is before today) are signed out and sent
//     back to the sign-in page (index.html?inactive=1), which shows the
//     "account is inactive, contact your admin" message, whatever their role.
//     This is a front-end guard only; see the note on the check below.
//
// ---------------------------------------------------------------------
// Contract for any page that wants this sidebar (copy the skeleton from
// pages/dashboard.html):
//
//   <body data-page="dashboard">   <!-- matches a sidebar-link's data-page -->
//   (No toggle button in the topbar any more — it lives in the sidebar
//    partial. A leftover legacy topbar button is removed automatically.)
//     <div class="app-shell" id="appShell">
//       <div class="app-main">
//         <header class="page-topbar">
//           <h1 class="page-title">Dashboard</h1>
//         </header>
//         <main class="page-content">
//           ... page-specific content ...
//         </main>
//       </div>
//       <aside class="app-sidebar" id="sidebarRoot"></aside>
//     </div>
//
//     <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//     <script src="../assets/js/supabaseClient.js"></script>
//     <script src="../assets/js/sidebar.js"></script>
//     <script>
//       window.addEventListener('ess:ready', (e) => {
//         const { session, employee, isAdmin, isApprover } = e.detail;
//         // ... page-specific rendering ...
//       });
//     </script>
//   </body>
//
// Assumes this page lives under /pages/ (so '../assets/...' and
// '../index.html' resolve correctly) — same depth as dashboard.html.
// ---------------------------------------------------------------------

(async function () {
  const LOGIN_PATH = '../index.html';
  const HOME_PATH = 'dashboard.html';
  const INACTIVE_PATH = LOGIN_PATH + '?inactive=1'; // index.html shows the "account is inactive" message
  const SIDEBAR_PARTIAL_PATH = '../assets/partials/sidebar.html';

  const CACHE_KEY = 'ess.sidebar.v1';   // sessionStorage: last-known sidebar for this tab
  const OPEN_KEY = 'ess.sidebar.open';  // localStorage: '1' when the sidebar is expanded

  // Single source of truth for page access. Admins bypass this list.
  const ACCESS = {
    user: ['dashboard', 'leaves', 'calendar'],
    approverExtra: ['employees']
  };

  const appShell = document.getElementById('appShell');
  const sidebarRoot = document.getElementById('sidebarRoot');
  const activePage = document.body.dataset.page;

  function notifyReady(detail) {
    window.dispatchEvent(new CustomEvent('ess:ready', { detail }));
  }

  // Older pages still have the toggle button in their topbar. It now lives
  // in the sidebar (logo row), so drop the legacy one to avoid a duplicate
  // #sidebarToggle id. Safe to delete that markup from the pages later.
  document.querySelectorAll('.page-topbar .sidebar-toggle-btn').forEach((el) => el.remove());

  if (typeof SUPABASE_CONFIGURED === 'undefined' || !SUPABASE_CONFIGURED) {
    // No working client — nothing to show (the sidebar is never loaded);
    // let the page's own script decide how to message "not configured".
    document.documentElement.classList.remove('sidebar-open-init');
    notifyReady({ session: null, employee: null, employeeError: null, isAdmin: false, isApprover: false });
    return;
  }

  // -------------------------------------------------------------------
  // Storage helpers (private mode / blocked storage must never break the page)
  // -------------------------------------------------------------------
  function readCache() {
    try {
      const v = JSON.parse(sessionStorage.getItem(CACHE_KEY));
      return v && typeof v.partial === 'string' ? v : null;
    } catch (_) { return null; }
  }
  function writeCache(value) {
    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(value)); } catch (_) { /* ignore */ }
  }
  function clearCache() {
    try { sessionStorage.removeItem(CACHE_KEY); } catch (_) { /* ignore */ }
  }
  function readOpen() {
    try { return localStorage.getItem(OPEN_KEY) === '1'; } catch (_) { return false; }
  }
  function saveOpen(open) {
    try { localStorage.setItem(OPEN_KEY, open ? '1' : '0'); } catch (_) { /* ignore */ }
  }

  // -------------------------------------------------------------------
  // Sidebar state + rendering. Everything below is idempotent, so it can be
  // run first from the cache and again with the verified data.
  // -------------------------------------------------------------------
  let currentPartial = null;
  let currentAccess = null; // array of allowed page keys, or null = unrestricted
  let currentUser = { displayName: '', initials: '?', roleText: '' };

  // Account menu shown when the avatar is clicked on the collapsed rail.
  // Lives on <body> with position: fixed, because .app-sidebar has
  // overflow: hidden and would clip anything that pokes out of it.
  const userMenu = document.createElement('div');
  userMenu.className = 'sidebar-user-menu';
  userMenu.setAttribute('role', 'menu');
  userMenu.hidden = true;
  userMenu.innerHTML = `
    <div class="sidebar-user-menu-info">
      <p class="sidebar-user-menu-name"></p>
      <p class="sidebar-user-menu-role"></p>
    </div>
    <button type="button" class="sidebar-user-menu-signout" role="menuitem">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="m16 17 5-5-5-5"></path>
        <path d="M21 12H9"></path>
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
      </svg>
      Sign out
    </button>`;
  document.body.appendChild(userMenu);
  const userMenuName = userMenu.querySelector('.sidebar-user-menu-name');
  const userMenuRole = userMenu.querySelector('.sidebar-user-menu-role');

  function isOpen() {
    return appShell.classList.contains('sidebar-open');
  }

  function closeUserMenu() {
    userMenu.hidden = true;
    const btn = document.getElementById('sidebarAvatarBtn');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  function openUserMenu() {
    const btn = document.getElementById('sidebarAvatarBtn');
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    userMenu.style.left = `${Math.round(r.right + 12)}px`;
    userMenu.style.bottom = `${Math.round(window.innerHeight - r.bottom)}px`;
    userMenu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  }

  function setOpen(open, persist = true) {
    appShell.classList.toggle('sidebar-open', open);
    const toggleBtn = document.getElementById('sidebarToggle');
    if (toggleBtn) toggleBtn.setAttribute('aria-expanded', String(open));
    closeUserMenu();
    if (persist) saveOpen(open);
  }

  // Show only the links the user may open; highlight the active one.
  // (Hidden rather than removed, so this can safely be re-run.)
  function applyAccess() {
    sidebarRoot.querySelectorAll('.sidebar-link').forEach((link) => {
      const allowed = !currentAccess || currentAccess.includes(link.dataset.page);
      link.classList.toggle('hidden', !allowed);
      link.classList.toggle('is-active', allowed && link.dataset.page === activePage);
    });
  }

  // Footer: initials avatar, bold name, "Position (Admin)" / "Position".
  function applyUser() {
    const { displayName, initials, roleText } = currentUser;
    const avatarEl = document.getElementById('sidebarUserAvatar');
    const nameEl = document.getElementById('sidebarUserName');
    const roleEl = document.getElementById('sidebarUserRole');
    if (avatarEl) avatarEl.textContent = initials;
    if (nameEl) { nameEl.textContent = displayName; nameEl.title = displayName; }
    if (roleEl) { roleEl.textContent = roleText; roleEl.title = roleText; }
    userMenuName.textContent = displayName;
    userMenuRole.textContent = roleText;
    userMenuRole.hidden = !roleText;
  }

  function mount(partialHtml) {
    sidebarRoot.innerHTML = partialHtml;
    currentPartial = partialHtml;
    applyAccess();
    applyUser();
    const toggleBtn = document.getElementById('sidebarToggle');
    if (toggleBtn) toggleBtn.setAttribute('aria-expanded', String(isOpen()));
  }

  async function signOut() {
    clearCache();
    await sb.auth.signOut();
    window.location.href = LOGIN_PATH;
  }

  // Wired once, by delegation, so it keeps working if the partial is re-mounted.
  if (appShell && sidebarRoot) {
    sidebarRoot.addEventListener('click', (e) => {
      if (e.target.closest('#sidebarToggle')) {
        setOpen(!isOpen());
      } else if (e.target.closest('#sidebarSignOutBtn')) {
        signOut();
      } else if (e.target.closest('#sidebarAvatarBtn')) {
        if (isOpen()) return; // expanded: name + sign-out are already visible
        if (userMenu.hidden) openUserMenu(); else closeUserMenu();
      }
    });
    userMenu.querySelector('.sidebar-user-menu-signout').addEventListener('click', signOut);
    document.addEventListener('click', (e) => {
      if (userMenu.hidden) return;
      if (userMenu.contains(e.target) || e.target.closest('#sidebarAvatarBtn')) return;
      closeUserMenu();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !userMenu.hidden) {
        closeUserMenu();
        document.getElementById('sidebarAvatarBtn')?.focus();
      }
    });
    window.addEventListener('resize', closeUserMenu);

    // ---- Instant paint from the last-known state (no network) ----
    // Transitions are switched off for this first paint so an expanded
    // sidebar doesn't animate open on every page load.
    appShell.classList.add('sidebar-no-anim');
    const cached = readCache();
    if (cached) {
      currentAccess = Array.isArray(cached.allowedPages) ? cached.allowedPages : null;
      if (cached.user) currentUser = cached.user;
      mount(cached.partial);
    }
    setOpen(readOpen(), false);
    // Hand over from the early <head> snippet (which only pre-sized the
    // sidebar for first paint) to the real .sidebar-open class.
    document.documentElement.classList.remove('sidebar-open-init');
    requestAnimationFrame(() => requestAnimationFrame(() => appShell.classList.remove('sidebar-no-anim')));
  }

  // -------------------------------------------------------------------
  // Verified state. The partial is fetched while the auth checks run, and
  // the three lookups run in parallel instead of one after another.
  // -------------------------------------------------------------------
  const partialPromise = (appShell && sidebarRoot)
    ? fetch(SIDEBAR_PARTIAL_PATH)
        .then((res) => res.text())
        .catch((err) => { console.error('sidebar: failed to load sidebar partial:', err); return null; })
    : Promise.resolve(null);

  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    clearCache();
    window.location.href = LOGIN_PATH;
    return;
  }

  const settle = (query) => Promise.resolve(query).then((r) => r, (error) => ({ data: null, error }));
  const [employeeRes, positionRes, approverRes] = await Promise.all([
    settle(sb
      .from('employees')
      .select('id, name, employee_id, role, last_day')
      .eq('auth_user_id', session.user.id)
      .maybeSingle()),
    // Position is best-effort: a failure here never affects the session /
    // role checks.
    settle(sb
      .from('employees')
      .select('pos:post_id(position)')
      .eq('auth_user_id', session.user.id)
      .maybeSingle()),
    // Only used for non-admins; running it in parallel saves a round trip.
    settle(sb.rpc('is_approver'))
  ]);

  let employee = employeeRes.data;
  const employeeError = employeeRes.error;
  if (employeeError) {
    // Surface the real reason instead of silently treating this the same
    // as "not linked yet" — e.g. an RLS denial or expired token look
    // identical to "no row found" unless you log this.
    console.error('sidebar: employees lookup failed:', employeeError);
  }

  // Inactive employee: their last day has passed. Sign them out and send them
  // to the sign-in page, which shows the "you're inactive, contact your
  // admin" message, instead of any app page.
  // Same rule as isEmployeeActive() in employees.js (active through the last
  // day itself), using the local calendar date. NOTE: this only stops the UI;
  // the database (RLS / an auth hook) must also refuse inactive users to be a
  // real access control.
  if (employee?.last_day) {
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (employee.last_day < today) {
      clearCache();
      try { await sb.auth.signOut(); } catch (err) { console.warn('sidebar: sign-out failed:', err); }
      window.location.replace(INACTIVE_PATH);
      return;
    }
  }

  // admin: no employees row, but listed in public.super_admins. Only
  // checked when there is no employee row (so normal users pay no extra call).
  // Handed to the pages as an admin (role 1) so their existing checks work.
  let isSuperAdmin = false;
  if (!employee && !employeeError) {
    const { data: superFlag, error: superError } = await sb.rpc('is_super_admin');
    if (superError) console.error('sidebar: is_super_admin check failed:', superError);
    else isSuperAdmin = superFlag === true;
    if (isSuperAdmin) {
      // Display name (best effort): the same name is used in every audit trail.
      let superName = 'admin';
      const { data: names, error: namesError } = await sb.rpc('list_super_admin_names');
      if (namesError) console.warn('sidebar: list_super_admin_names failed:', namesError);
      else superName = (names || []).find((n) => n.auth_user_id === session.user.id)?.name || superName;
      employee = { id: null, name: superName, employee_id: null, role: 1, last_day: null, isSuperAdmin: true };
    }
  }

  const isAdmin = employee?.role === 1;

  // Approver status only matters for non-admins (admins already see everything).
  let isApprover = false;
  if (!isAdmin && employee) {
    if (approverRes.error) console.error('sidebar: is_approver check failed:', approverRes.error);
    else isApprover = approverRes.data === true;
  }

  // an admin has role 1 above, so like any admin it is unrestricted.
  const allowedPages = isAdmin
    ? null // null = unrestricted
    : [...ACCESS.user, ...(isApprover ? ACCESS.approverExtra : [])];

  if (allowedPages && !allowedPages.includes(activePage)) {
    window.location.href = HOME_PATH;
    return;
  }

  if (appShell && sidebarRoot) {
    let positionName = '';
    if (positionRes.error) console.warn('sidebar: position lookup failed:', positionRes.error);
    else positionName = positionRes.data?.pos?.position || '';

    const displayName = employee?.name || session.user.email || '';

    // "Rotha Mek" -> "RM"; a single name -> its first two letters.
    const nameParts = displayName.trim().split(/\s+/).filter(Boolean);
    const initials = (nameParts.length > 1
      ? nameParts[0][0] + nameParts[nameParts.length - 1][0]
      : (nameParts[0] || '?').slice(0, 2)).toUpperCase();

    const roleText = isSuperAdmin
      ? 'Super Admin'
      : isAdmin
      ? (positionName ? `${positionName} (Admin)` : 'Admin')
      : positionName;

    currentAccess = allowedPages;
    currentUser = { displayName, initials, roleText };

    // Re-render only what actually changed.
    const freshPartial = await partialPromise;
    if (freshPartial && freshPartial !== currentPartial) {
      mount(freshPartial);
    } else if (currentPartial) {
      applyAccess();
      applyUser();
    }

    if (currentPartial) {
      writeCache({ partial: currentPartial, allowedPages, user: currentUser, uid: session.user.id });
    }
  }

  notifyReady({ session, employee, employeeError, isAdmin, isApprover, isSuperAdmin });
})();
