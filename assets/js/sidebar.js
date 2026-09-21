// assets/js/sidebar.js
//
// Reusable admin sidebar + topbar toggle, shared by every page under
// /pages/. Handles the session guard, the admin check, injecting the
// sidebar partial, the show/hide toggle, active-link highlighting, the
// user/sign-out footer, and lets other page scripts react via an event
// instead of re-fetching the same session/employee data.
//
// ---------------------------------------------------------------------
// Contract for any page that wants this sidebar (copy the skeleton from
// pages/dashboard.html):
//
//   <body data-page="dashboard">   <!-- matches a sidebar-link's data-page -->
//     <div class="app-shell" id="appShell">
//       <div class="app-main">
//         <header class="page-topbar">
//           <button type="button" class="sidebar-toggle-btn" id="sidebarToggle"
//                   aria-expanded="false" aria-label="Toggle menu">☰-icon</button>
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
//         const { session, employee } = e.detail;
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
  const SIDEBAR_PARTIAL_PATH = '../assets/partials/sidebar.html';

  const toggleBtn = document.getElementById('sidebarToggle');
  const appShell = document.getElementById('appShell');
  const sidebarRoot = document.getElementById('sidebarRoot');

  function notifyReady(session, employee, employeeError) {
    window.dispatchEvent(new CustomEvent('ess:ready', { detail: { session, employee, employeeError } }));
  }

  if (typeof SUPABASE_CONFIGURED === 'undefined' || !SUPABASE_CONFIGURED) {
    // No working client — hide the toggle (nothing to show) and let the
    // page's own script decide how to message "not configured".
    if (toggleBtn) toggleBtn.style.display = 'none';
    notifyReady(null, null, null);
    return;
  }

  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    window.location.href = LOGIN_PATH;
    return;
  }

  const { data: employee, error: employeeError } = await sb
    .from('employees')
    .select('name, employee_id, role')
    .eq('auth_user_id', session.user.id)
    .maybeSingle();

  if (employeeError) {
    // Surface the real reason instead of silently treating this the same
    // as "not linked yet" — e.g. an RLS denial or expired token look
    // identical to "no row found" unless you log this.
    console.error('sidebar: employees lookup failed:', employeeError);
  }

  const isAdmin = employee?.role === 1;

  // Non-admins only have access to the leaves page — every other /pages/
  // screen (dashboard, employees, ...) is admin-only. Bounce them there
  // instead of letting them land on (or stay on) a page they can't use.
  const activePageForGate = document.body.dataset.page;
  if (!isAdmin && activePageForGate !== 'leaves') {
    window.location.href = 'leaves.html';
    return;
  }

  if (isAdmin && toggleBtn && appShell && sidebarRoot) {
    try {
      const res = await fetch(SIDEBAR_PARTIAL_PATH);
      sidebarRoot.innerHTML = await res.text();
    } catch (err) {
      console.error('sidebar: failed to load sidebar partial:', err);
    }

    // Highlight the active nav link.
    const activePage = document.body.dataset.page;
    sidebarRoot.querySelectorAll('.sidebar-link').forEach((link) => {
      link.classList.toggle('is-active', link.dataset.page === activePage);
    });

    // Footer: name + role.
    const nameEl = document.getElementById('sidebarUserName');
    const roleEl = document.getElementById('sidebarUserRole');
    if (nameEl) nameEl.textContent = employee.name;
    if (roleEl) roleEl.textContent = 'Admin';

    const signOutBtn = document.getElementById('sidebarSignOutBtn');
    if (signOutBtn) {
      signOutBtn.addEventListener('click', async () => {
        await sb.auth.signOut();
        window.location.href = LOGIN_PATH;
      });
    }

    // Show/hide toggle. Starts closed on every page load — including
    // right after navigating via a nav link, since that's a full page
    // load in this multi-page (non-SPA) site, so there's no state to
    // carry over unless we deliberately persist it (we don't).
    function setOpen(open) {
      appShell.classList.toggle('sidebar-open', open);
      toggleBtn.setAttribute('aria-expanded', String(open));
    }
    setOpen(false);
    toggleBtn.addEventListener('click', () => {
      setOpen(!appShell.classList.contains('sidebar-open'));
    });
  } else {
    // Not an admin (or no linked employee profile yet): no sidebar for
    // this role yet, so there's nothing to toggle...
    if (toggleBtn) toggleBtn.style.display = 'none';

    // ...but they still need a way to sign out, since the sidebar's
    // footer sign-out button never gets rendered for them. Add a plain
    // logout button to the top-right of the topbar instead.
    const topbar = document.querySelector('.page-topbar');
    if (topbar) {
      const logoutBtn = document.createElement('button');
      logoutBtn.type = 'button';
      logoutBtn.id = 'topbarSignOutBtn';
      logoutBtn.className = 'btn btn-ghost btn-sm btn-icon';
      logoutBtn.style.marginLeft = 'auto';
      logoutBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>
        Log out
      `;
      logoutBtn.addEventListener('click', async () => {
        await sb.auth.signOut();
        window.location.href = LOGIN_PATH;
      });
      topbar.appendChild(logoutBtn);
    }
  }

  notifyReady(session, employee, employeeError);
})();
