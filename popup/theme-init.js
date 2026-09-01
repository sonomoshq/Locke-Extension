// Copyright © 2026 Sonomos, Inc. All rights reserved.
(function () {
  try {
    var cached = localStorage.getItem('sonomosPopupTheme');
    if (cached === 'dark' || cached === 'light') {
      document.documentElement.classList.add('theme-' + cached);
      return;
    }
  } catch (_) {}
  var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.classList.add(prefersDark ? 'theme-dark' : 'theme-light');
})();
