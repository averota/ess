# ESS — Employee Self-Service

Employee leave management app. Admin module first: employee directory, with
leave requests/approvals to follow. Static front end (no build step) backed
by Supabase (Postgres + Auth), hostable on GitHub Pages.

## Project structure

```
.
├── .github/workflows/deploy.yml   # Deploys to GitHub Pages; generates assets/config.js from secrets
├── .gitignore                     # Ignores assets/config.js (real Supabase values)
├── index.html                     # Login page
├── pages/
│   ├── dashboard.html             # Post-login landing page
│   ├── employees.html
│   ├── leaves.html
│   ├── calendar.html
│   ├── policies.html
│   └── users.html
├── assets/
│   ├── config_example.js          # Committed template -> copy to config.js
│   ├── config.js                  # NOT committed: real Supabase URL/anon key (local only)
│   ├── css/                       # styles.css + one stylesheet per page/modal
│   ├── partials/
│   │   └── sidebar.html           # Sidebar markup, injected by sidebar.js
│   └── js/
│       ├── supabaseClient.js      # Shared Supabase client (reads window.__SUPABASE_CONFIG__)
│       ├── password-toggle.js
│       ├── sidebar.js             # Shared admin sidebar/topbar + auth guard
│       └── ...                    # Page scripts: calendar, dashboard, employees, leaves, policies, etc.
└── supabase/                      # SQL files, run in numbered order in the Supabase SQL Editor
    ├── 01_employee_info_schema.sql
    ├── 01_super_admin.sql
    ├── 02_leaves_schema.sql
    ├── 03_policies_schemas.sql
    ├── 04_leave_balance_ledger.sql
    ├── 05_calendar_schemas.sql
    └── 06_portal_access.sql
```

## 1. Create the Supabase project

Create a free project at [supabase.com](https://supabase.com). Free tier is
one active project at a time — pause/delete any other project first if
you're at the limit.

## 2. Run the schema

Open **SQL Editor** in your Supabase project, paste in
`supabase/01_employee_info_schema.sql`, and run it. It's safe to re-run for
everything except the sample employee rows, which are replaced (deleted and
reinserted) on every run — see the comment at the top of the file.

This creates `roles`, `genders`, `positions`, `departments`,
`business_units`, and `employees`, all with Row Level Security enabled.

## 3. Connect the front end

In your Supabase project: **Settings → API**. Copy the **Project URL** and
**anon public** key.

The real values are kept out of git. `assets/js/supabaseClient.js` reads
them from `window.__SUPABASE_CONFIG__`, which is defined in
`assets/config.js` (gitignored, loaded before `supabaseClient.js` on every
page).

**Local preview:** copy the template and fill it in:

```bash
cp assets/config_example.js assets/config.js
```

```js
window.__SUPABASE_CONFIG__ = {
  url: "https://xxxxxxxx.supabase.co",
  anonKey: "eyJ..."
};
```

**Production (GitHub Pages):** `assets/config.js` is generated at deploy
time from GitHub Secrets by `.github/workflows/deploy.yml` (see
"Deploying to GitHub Pages" below).

Note: this is a static site, so the deployed `config.js` is still readable
in the browser. Secrets keep the values out of the repo, not out of the
live site. The anon key is designed to be public; RLS (not key secrecy)
controls what each signed-in user can see or change. Never put your
**service_role** key anywhere in this project.

## 4. Create your first login (admin)

Employee records link to Supabase Auth logins automatically by matching
**email** — whichever is created second triggers the link, no manual UUID
copying needed. Two ways to do it:

**Option A — employee row already exists:**
1. In **Table Editor → employees**, set that row's `email` (and make sure
   `role = 1` for admin).
2. In **Authentication → Users → Add user**, create a login with the same
   email. It links automatically.

**Option B — auth user already exists:**
1. Create the login first in **Authentication → Users → Add user**.
2. Then set that employee's `email` to match in **Table Editor**. It links
   automatically on save.

Either way, if you don't want to deal with email confirmation for internal
accounts, either set the password directly when adding the user in the
Dashboard (no confirmation needed), or under **Authentication → Providers →
Email**, turn off "Confirm email."

The bundled sample data includes an admin row (`Rotha Mek`,
`mek.rotha@gmail.com`) — usable as-is if you want a quick admin login, or
edit its email to one you control.

## 5. Run it locally

No build step. Make sure `assets/config.js` exists (step 3), then open
`index.html` in a browser or serve the folder with any static server
(e.g. `npx serve .`). Sign in with the email and password you set up in
step 4; you should land on the dashboard and see your name once linked.

## Building a new admin page (using the shared sidebar)

Every protected page under `pages/` follows the same skeleton — copy it
from `pages/dashboard.html`:

```html
<body data-page="employees">  <!-- must match a data-page on a sidebar link -->
<div class="app-shell" id="appShell">
  <div class="app-main">
    <header class="page-topbar">
      <button type="button" class="sidebar-toggle-btn" id="sidebarToggle"
              aria-expanded="false" aria-label="Toggle menu">☰-icon</button>
      <h1 class="page-title">Employees</h1>
    </header>
    <main class="page-content">
      <!-- page content -->
    </main>
  </div>
  <aside class="app-sidebar" id="sidebarRoot"></aside>
</div>

<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<script src="../assets/config.js"></script>          <!-- must load before supabaseClient.js -->
<script src="../assets/js/supabaseClient.js"></script>
<script src="../assets/js/sidebar.js"></script>
</body>
```

`sidebar.js` handles everything from there: it requires a session
(redirecting to login if there isn't one), checks whether the linked
employee is an admin, injects `assets/partials/sidebar.html` into
`#sidebarRoot` only if so (non-admins get no sidebar — the toggle button
hides itself), wires the show/hide toggle (persisted across page loads),
highlights the current page's nav link, and fills in the name/sign-out
footer.

If your page needs the session/employee data too, listen for the event
it dispatches once everything's ready, instead of re-fetching:

```js
window.addEventListener('ess:ready', (e) => {
  const { session, employee, employeeError } = e.detail;
  // ... page-specific rendering ...
});
```

This assumes the page lives directly under `pages/` (same depth as
`dashboard.html`), since `sidebar.js` uses `../assets/...` and
`../index.html` as relative paths.

## Deploying to GitHub Pages

Deployment uses GitHub Actions (`.github/workflows/deploy.yml`), which
writes `assets/config.js` from repository secrets on every push to `main`.

1. Create a **public** GitHub repository and push this project to `main`.
   Confirm `assets/config.js` is not tracked (`git status` should not list it).
2. **Settings → Secrets and variables → Actions → New repository secret**.
   Add (values only, no quotes):
   - `SUPABASE_URL`: your Project URL
   - `SUPABASE_ANON_KEY`: your `anon public` key
3. **Settings → Pages → Build and deployment → Source**: `GitHub Actions`.
4. In Supabase: **Authentication → URL Configuration**. Set **Site URL** to
   your Pages URL (`https://<username>.github.io/<repo>/`) and add it to
   **Redirect URLs**.
5. Push to `main`. The workflow fails with a clear error if either secret
   is missing. To redeploy without a code change, re-run the workflow from
   the **Actions** tab.

All paths in this project are relative, so it works from a repo root or a
Pages subpath.

## Notes on what's implemented so far

- **Login**: email + password via Supabase Auth, with a "remember me" toggle
  (persists the session in `localStorage` when checked, `sessionStorage`
  — cleared on browser close — when not).
- **Sidebar/navigation**: admin-only, collapsible, right-hand side, and
  pushes the page content rather than overlaying it (see "Building a new
  admin page" above). Shows the signed-in employee's name and a sign-out
  button in its footer. Non-admin logins get no sidebar for now.
- **Dashboard**: confirms a successful login and shows the linked employee's
  name if their account has been linked (step 4); otherwise prompts them to
  ask their admin to link it.
- **Employees / Leaves pages**: placeholders using the same shared shell,
  proving the sidebar works across pages — real functionality still to
  come.
- **RLS**: every table restricts writes to admins (`role = 1`); employees
  can read their own row, admins can read/write everyone's. See the SQL
  file's `is_admin()` / `current_employee_uuid()` helpers and the policies
  at the bottom of the file.

Not built yet: signup/password-reset flows, and the real employee
directory and leave request/approval functionality — next modules.
