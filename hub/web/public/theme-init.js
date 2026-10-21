// Pre-paint theme (loaded synchronously in <head>; CSP forbids inline scripts).
// Mirrors src/lib/theme.ts: localStorage["agentbus.theme"] = light | dark | system.
(function () {
  var pref = "system";
  try {
    var v = localStorage.getItem("agentbus.theme");
    if (v === "light" || v === "dark") pref = v;
  } catch (e) {}
  var dark = pref === "dark" || (pref === "system" && !!window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  var el = document.documentElement;
  el.setAttribute("data-theme", dark ? "dark" : "light");
  el.style.colorScheme = dark ? "dark" : "light";
  // Installed-app title bar / mobile browser chrome follows the resolved theme.
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", dark ? "#0b110e" : "#f7fbf9");
})();
