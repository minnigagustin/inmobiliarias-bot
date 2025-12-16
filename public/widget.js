(function () {
  // Evitar doble-inyección
  if (window.__BR_WIDGET_LOADED__) return;
  window.__BR_WIDGET_LOADED__ = true;

  const SCRIPT_TAG = document.currentScript;
  const SRC = SCRIPT_TAG && SCRIPT_TAG.src ? new URL(SCRIPT_TAG.src) : null;
  const BASE = SRC ? SRC.origin : "";
  const WIDGET_URL = BASE + "/widget";

  const companyName =
    (SCRIPT_TAG && SCRIPT_TAG.dataset && SCRIPT_TAG.dataset.company) ||
    "Asistente";
  const primary =
    (SCRIPT_TAG && SCRIPT_TAG.dataset && SCRIPT_TAG.dataset.color) || "#2563eb"; // azul

  // ----- estilos
  const style = document.createElement("style");
  style.textContent = `
    #brw-btn{
      position:fixed; right:18px; bottom:18px; z-index:2147483000;
      width:56px; height:56px; border-radius:999px;
      border:none; cursor:pointer;
      background:${primary}; color:#fff;
      box-shadow:0 16px 40px rgba(0,0,0,.25);
      display:flex; align-items:center; justify-content:center;
      font-size:22px;
    }
    #brw-panel{
      position:fixed; right:18px; bottom:86px; z-index:2147483000;
      width:min(380px, calc(100vw - 24px));
      height:min(560px, calc(100vh - 120px));
      border-radius:16px;
      overflow:hidden;
      box-shadow:0 24px 70px rgba(0,0,0,.35);
      border:1px solid rgba(0,0,0,.10);
      background:#fff;
      transform:translateY(10px);
      opacity:0;
      pointer-events:none;
      transition:opacity .18s ease, transform .18s ease;
    }
    #brw-panel.open{
      opacity:1;
      transform:translateY(0);
      pointer-events:auto;
    }
    #brw-iframe{ width:100%; height:100%; border:0; display:block; }
    #brw-badge{
      position:absolute; top:-6px; right:-6px;
      min-width:18px; height:18px; padding:0 5px;
      border-radius:999px; background:#ef4444; color:#fff;
      font:600 12px/18px system-ui, -apple-system, Segoe UI, Roboto, Arial;
      display:none;
    }
  `;
  document.head.appendChild(style);

  // ----- panel (iframe)
  const panel = document.createElement("div");
  panel.id = "brw-panel";
  const iframe = document.createElement("iframe");
  iframe.id = "brw-iframe";
  iframe.src = WIDGET_URL;
  iframe.title = companyName + " – Chat";
  panel.appendChild(iframe);
  document.body.appendChild(panel);

  // ----- botón
  const btn = document.createElement("button");
  btn.id = "brw-btn";
  btn.setAttribute("aria-label", "Abrir chat");
  btn.innerHTML = "💬";

  const badge = document.createElement("span");
  badge.id = "brw-badge";
  badge.textContent = "1";
  btn.style.position = "fixed";
  btn.appendChild(badge);

  document.body.appendChild(btn);

  function open() {
    panel.classList.add("open");
    badge.style.display = "none";
  }
  function close() {
    panel.classList.remove("open");
  }
  function toggle() {
    panel.classList.contains("open") ? close() : open();
  }

  btn.addEventListener("click", toggle);

  // cerrar con Escape
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });

  // cerrar si clickeás fuera (opcional)
  document.addEventListener("click", (e) => {
    if (!panel.classList.contains("open")) return;
    if (panel.contains(e.target) || btn.contains(e.target)) return;
    close();
  });
})();
