// Light / dark theme. Follows the system setting unless the user picks one.
// Loaded as a plain (blocking) script in <head> so the saved theme applies
// before first paint, with no flash of the wrong colours.
(function () {
  var KEY = 'litesign-theme';
  var MODES = ['system', 'light', 'dark'];
  var LABELS = { system: 'System', light: 'Light', dark: 'Dark' };
  var ICONS = {
    system: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
    light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>'
  };

  function load() {
    try { var m = localStorage.getItem(KEY); return MODES.indexOf(m) >= 0 ? m : 'system'; } catch (e) { return 'system'; }
  }
  function save(mode) {
    try { if (mode === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, mode); } catch (e) { /* private mode */ }
  }
  function apply(mode) {
    if (mode === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', mode);
  }

  var mode = load();
  apply(mode);

  function render(btn) {
    var next = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
    btn.innerHTML = ICONS[mode] + '<span class="theme-label">' + LABELS[mode] + '</span>';
    btn.title = 'Theme: ' + LABELS[mode] + ' (click for ' + LABELS[next] + ')';
    btn.setAttribute('aria-label', btn.title);
  }

  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-toggle';
    render(btn);
    btn.addEventListener('click', function () {
      mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
      save(mode);
      apply(mode);
      render(btn);
    });
    // Put it in the top bar, before any other buttons there; otherwise float it.
    var bar = document.querySelector('.topbar');
    if (bar) {
      var before = bar.querySelector('.btn');
      if (before) bar.insertBefore(btn, before); else bar.appendChild(btn);
    } else {
      btn.classList.add('floating');
      document.body.appendChild(btn);
    }
  });

  // Keep other open tabs in sync.
  window.addEventListener('storage', function (e) {
    if (e.key !== KEY) return;
    mode = load();
    apply(mode);
    var btn = document.querySelector('.theme-toggle');
    if (btn) render(btn);
  });
})();
