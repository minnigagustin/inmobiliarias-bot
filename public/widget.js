(function () {
  var script = document.currentScript;
  var host = script && script.src ? new URL(script.src).origin : "";
  if (!host) return;

  var company = (script && script.dataset.company) || "";
  var color = (script && script.dataset.color) || "";
  var bot = (script && script.dataset.bot) || "";

  // evita duplicados
  if (window.__CHAT_WIDGET_LOADED__) return;
  window.__CHAT_WIDGET_LOADED__ = true;

  // contenedor
  var wrap = document.createElement("div");
  wrap.id = "cw-embed-wrap";
  wrap.style.position = "fixed";
  wrap.style.right = "0";
  wrap.style.bottom = "0";
  wrap.style.width = "0";
  wrap.style.height = "0";
  wrap.style.zIndex = "2147483647";
  document.body.appendChild(wrap);

  // iframe flotante
  var iframe = document.createElement("iframe");
  var params = new URLSearchParams();
  if (company) params.set("company", company);
  if (color) params.set("color", color);
  if (bot) params.set("bot", bot);

  iframe.src =
    host + "/widget" + (params.toString() ? "?" + params.toString() : "");
  iframe.title = "Chat Widget";
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "420px";
  iframe.style.height = "680px";
  iframe.style.border = "0";
  iframe.style.background = "transparent";
  iframe.style.borderRadius = "0";
  iframe.style.boxShadow = "none";
  iframe.allow = "clipboard-write";

  // responsive (mobile)
  function resize() {
    var w = window.innerWidth || 1024;
    if (w < 480) {
      iframe.style.width = "100vw";
      iframe.style.height = "100vh";
    } else {
      iframe.style.width = "420px";
      iframe.style.height = "680px";
    }
  }
  resize();
  window.addEventListener("resize", resize);

  wrap.appendChild(iframe);
})();
