# ESS — Employee Self-Service

Employee leave management app. Admin module first: employee directory, with
leave requests/approvals to follow. Static front end (no build step) backed
by Supabase (Postgres + Auth), hostable on GitHub Pages.

## Project structure

```
.
├── index.html              # Login page
├── pages/
│   └── dashboard.html      # Post-login landing page
├── assets/
│   ├── css/styles.css
│   └── js/
│       ├── supabaseClient.js   # Shared Supabase client — fill in your keys here
│       └── password-toggle.js
└── supabase/
    └── 01_employee_info_schema.sql   # Run this in the Supabase SQL Editor
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
**anon public** key into `assets/js/supabaseClient.js`:

```js
const SUPABASE_URL = 'https://xxxxxxxx.supabase.co';
const SUPABASE_ANON_KEY = 'eyJ...';
```

The anon key is meant to be public — it's safe to commit, since RLS (not
key secrecy) controls what each signed-in user can see or change. Never put
your **service_role** key anywhere in this repo.

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

No build step — open `index.html` directly in a browser, or serve the
folder with any static server (e.g. `npx serve .`). Sign in with the email
and password you set up in step 4; you should land on the dashboard and see
your name once linked.

## Deploying to GitHub Pages

1. Push this repo to a **public** GitHub repository.
2. **Settings → Pages** → Source: `Deploy from a branch` → Branch: `main`,
   folder `/ (root)` → Save.
3. GitHub gives you a URL a minute or two later. All paths in this project
   are relative, so it works unchanged from a repo root or a Pages subpath.

## Notes on what's implemented so far

- **Login**: email + password via Supabase Auth, with a "remember me" toggle
  (persists the session in `localStorage` when checked, `sessionStorage`
  — cleared on browser close — when not).
- **Dashboard**: confirms a successful login and shows the linked employee's
  name if their account has been linked (step 4); otherwise prompts them to
  ask their admin to link it.
- **RLS**: every table restricts writes to admins (`role = 1`); employees
  can read their own row, admins can read/write everyone's. See the SQL
  file's `is_admin()` / `current_employee_uuid()` helpers and the policies
  at the bottom of the file.

Not built yet: signup/password-reset flows, the employee directory UI, and
leave requests/approvals — next modules.
