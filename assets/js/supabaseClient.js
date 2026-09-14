// assets/js/supabaseClient.js
//
// Fill these in from your Supabase project: Settings → API.
//   SUPABASE_URL      -> "Project URL"
//   SUPABASE_ANON_KEY -> "anon public" key
//
// The anon key is designed to be public (it ships to every browser) and is
// safe to commit to this public repo — access control is enforced by the
// Row Level Security policies in supabase/01_employee_info_schema.sql, not
// by keeping this key secret. Never put the service_role key in this file
// or anywhere in the frontend.
const SUPABASE_URL = 'https://nagpvmtqtgusxypyhwrf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5hZ3B2bXRxdGd1c3h5cHlod3JmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkzNDI5NjUsImV4cCI6MjEwNDkxODk2NX0.XiXHcbcsObN7-t73H2eySvXGMHErf0zWd-g4--V29ik';

const SUPABASE_CONFIGURED = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

// Custom storage adapter: writes the session to localStorage when the user
// checked "Remember me" (persists across browser restarts), otherwise to
// sessionStorage (cleared when the tab/browser closes). The login page sets
// the 'ess_remember_session' flag right before calling signInWithPassword(),
// so this adapter reads it at the moment Supabase actually persists the
// session token.
const rememberAwareStorage = {
  getItem(key) {
    return localStorage.getItem(key) ?? sessionStorage.getItem(key);
  },
  setItem(key, value) {
    const remember = localStorage.getItem('ess_remember_session') !== '0';
    if (remember) {
      sessionStorage.removeItem(key);
      localStorage.setItem(key, value);
    } else {
      localStorage.removeItem(key);
      sessionStorage.setItem(key, value);
    }
  },
  removeItem(key) {
    localStorage.removeItem(key);
    sessionStorage.removeItem(key);
  }
};

// `sb` is the shared client every page uses. If the project hasn't been
// configured yet, fall back to a harmless stub so pages can still load and
// show a clear "not connected" message instead of throwing.
const sb = SUPABASE_CONFIGURED
  ? supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        storage: rememberAwareStorage,
        persistSession: true,
        autoRefreshToken: true
      }
    })
  : {
      auth: {
        async getSession() { return { data: { session: null } }; },
        async signInWithPassword() {
          return { data: null, error: { message: 'Supabase is not configured yet.' } };
        },
        async signOut() {},
        onAuthStateChange() {
          return { data: { subscription: { unsubscribe() {} } } };
        }
      }
    };
