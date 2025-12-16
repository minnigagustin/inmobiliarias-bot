(() => {
  const cfg = window.CHAT_WIDGET_CONFIG || {};
  const companyName = cfg.companyName || "Tu Empresa";
  const botName = cfg.botName || "Asistente";
  const primaryColor = cfg.primaryColor || "#4f8cff";

  // aplica color
  document.documentElement.style.setProperty("--cw-primary", primaryColor);

  // socket
  const socket = io();

  // --------- DOM (se crea todo desde JS) ----------
  const launcher = document.createElement("div");
  launcher.className = "cw-launcher";
  launcher.innerHTML = `<div class="cw-icon">💬</div><div class="cw-badge" title="Online"></div>`;
  document.body.appendChild(launcher);

  const panel = document.createElement("div");
  panel.className = "cw-panel";
  panel.innerHTML = `
    <div class="cw-header">
      <div class="cw-brand">
        <div class="cw-avatar">🤖</div>
        <div class="cw-title">
          <strong>${companyName}</strong>
          <span>${botName} • Online</span>
        </div>
      </div>
      <div class="cw-actions">
        <button class="cw-btn" type="button" data-act="min" title="Minimizar">—</button>
        <button class="cw-btn" type="button" data-act="close" title="Cerrar">✕</button>
      </div>
    </div>

    <div class="cw-messages" id="cw-messages"></div>

    <form class="cw-inputbar" id="cw-form">
      <input type="file" id="cw-file" accept="image/*" multiple hidden />
      <button class="cw-attach" type="button" id="cw-attach" title="Enviar foto">📷</button>
      <input class="cw-input" id="cw-input" autocomplete="off" placeholder="Escribí tu mensaje…" />
      <button class="cw-send" type="submit">Enviar</button>
    </form>
  `;
  document.body.appendChild(panel);

  const messagesEl = panel.querySelector("#cw-messages");
  const form = panel.querySelector("#cw-form");
  const input = panel.querySelector("#cw-input");
  const attachBtn = panel.querySelector("#cw-attach");
  const fileInput = panel.querySelector("#cw-file");

  let isOpen = false;
  let typingTimer = null;

  function open() {
    isOpen = true;
    panel.classList.add("is-open");
    document.body.style.overflow = "hidden"; // 🔒 mobile UX
    input.focus();
  }
  function close() {
    isOpen = false;
    panel.classList.remove("is-open");
    document.body.style.overflow = ""; // 🔓
  }

  launcher.addEventListener("click", () => (isOpen ? close() : open()));
  panel.querySelector('[data-act="close"]').addEventListener("click", close);
  panel.querySelector('[data-act="min"]').addEventListener("click", close);

  // persist open state
  if (localStorage.getItem("cw_open") === "1") open();

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addMessage(text, who = "bot") {
    const wrap = document.createElement("div");
    wrap.className = `cw-msg ${who}`;
    const bubble = document.createElement("div");
    bubble.className = "cw-bubble";
    bubble.textContent = text;
    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
    scrollToBottom();
  }

  function showTyping() {
    if (messagesEl.querySelector(".cw-msg.typing")) return;
    const wrap = document.createElement("div");
    wrap.className = "cw-msg bot typing";
    const bubble = document.createElement("div");
    bubble.className = "cw-bubble";
    bubble.innerHTML = `
      <div class="cw-typing">
        <span class="cw-dots"><i></i><i></i><i></i></span>
        <span>${companyName} está escribiendo…</span>
      </div>
    `;
    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
    scrollToBottom();
  }

  function hideTyping() {
    const t = messagesEl.querySelector(".cw-msg.typing");
    if (t) t.remove();
  }

  function startTypingTimer() {
    clearTimeout(typingTimer);
    typingTimer = setTimeout(showTyping, 250);
  }
  function stopTyping() {
    clearTimeout(typingTimer);
    hideTyping();
  }

  // --------- sockets ----------
  socket.on("bot_message", (msg) => {
    stopTyping();
    if (msg?.text) addMessage(msg.text, "bot");

    // Si querés, acá podés mapear botones a UI linda (por ahora solo texto)
    if (Array.isArray(msg?.buttons) && msg.buttons.length) {
      const lines = msg.buttons
        .map((b) => `• ${b.label || b.value}`)
        .join("\n");
      addMessage(lines, "bot");
    }
  });

  socket.on("system_message", (msg) => {
    stopTyping();
    if (msg?.text) addMessage(msg.text, "system");
  });

  socket.on("agent_message", (msg) => {
    stopTyping();
    if (msg?.text) addMessage(msg.text, "bot");
  });

  // --------- enviar texto ----------
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = String(input.value || "").trim();
    if (!text) return;

    addMessage(text, "user");
    startTypingTimer();
    socket.emit("user_message", { text });

    input.value = "";
    input.focus();
  });

  // --------- fotos ----------
  attachBtn.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", () => {
    const files = Array.from(fileInput.files || []);
    if (!files.length) return;

    files.forEach((file) => {
      if (!file.type.startsWith("image/")) return;

      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;

        addMessage("📷 Imagen enviada", "user");
        startTypingTimer();

        socket.emit("user_image", {
          name: file.name,
          type: file.type,
          data: dataUrl,
        });
      };
      reader.readAsDataURL(file);
    });

    fileInput.value = "";
  });

  // UX: cerrar con ESC
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen) close();
  });
})();
