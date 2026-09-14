// assets/js/password-toggle.js
// Wires up any .password-toggle-btn to show/hide its target <input>.
// Markup contract: button has data-target="<input id>" and two inner SVGs
// (.icon-eye / .icon-eye-off) toggled via the .is-visible class.
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.password-toggle-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-target');
      const input = document.getElementById(targetId);
      if (!input) return;

      const willShow = input.type === 'password';
      input.type = willShow ? 'text' : 'password';
      btn.classList.toggle('is-visible', willShow);
      btn.setAttribute('aria-pressed', String(willShow));
      btn.setAttribute('aria-label', willShow ? 'Hide password' : 'Show password');
    });
  });
});
