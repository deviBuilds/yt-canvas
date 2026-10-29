// Applies the saved (or system) colour theme before the first paint, so the page
// doesn't flash light then dark. A file rather than an inline script because the
// backend's CSP only allows script-src 'self'. Keep the key in sync with src/theme.
(function () {
  var dark = true;
  try {
    var saved = JSON.parse(window.localStorage.getItem("ytc.theme.v1") || "null");
    dark = saved === "dark" || (saved !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  } catch (e) {
    // Storage blocked: fall back to dark.
  }
  document.documentElement.classList.toggle("dark", dark);
})();
