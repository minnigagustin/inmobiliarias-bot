// public/app.js
/* Chat web BR-Group: soporte de handoff humano con banner y "finalizar" */

// Identidad persistente del cliente
function getChatId() {
  let id = localStorage.getItem("br_chat_id");
  if (!id) {
    id = "web-" + crypto.randomUUID();
    localStorage.setItem("br_chat_id", id);
  }
  return id;
}
const MY_CHAT_ID = getChatId();

const socket = io();
socket.on("connect", () => {
  socket.emit("register_chat", { chatId: MY_CHAT_ID });
});

const APP = window.APP_CONFIG || {};
const COMPANY_NAME = APP.companyName || "Asistente";

const messagesEl = document.getElementById("messages");
const form = document.getElementById("input-form");
const input = document.getElementById("input");
const attachBtn = document.getElementById("attach-btn");
const fileInput = document.getElementById("file-input");

// Flag de handoff (cuando hay agente humano)
let humanMode = false;

/* ------------------------- Utilidades UI ------------------------- */
function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addMessage(text, who = "bot") {
  const wrap = document.createElement("div");
  wrap.className =
    who === "user" ? "msg user" : who === "system" ? "msg system" : "msg";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  scrollToBottom();
}

function addImage(src, who = "user") {
  const wrap = document.createElement("div");
  wrap.className = who === "user" ? "msg user" : "msg";
  const bubble = document.createElement("div");
  bubble.className = "bubble image";
  const img = document.createElement("img");
  img.src = src;
  img.alt = "Imagen enviada";
  bubble.appendChild(img);
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  scrollToBottom();
}

function disableAllChoiceButtons() {
  document.querySelectorAll(".choice-btn").forEach((b) => (b.disabled = true));
  document
    .querySelectorAll(".btn-group")
    .forEach((g) => g.classList.add("used"));
}

function addButtons(buttons) {
  // En modo humano NO mostramos botones del bot
  if (humanMode) return;

  const wrap = document.createElement("div");
  wrap.className = "msg"; // mensaje del bot
  const bubble = document.createElement("div");
  bubble.className = "bubble buttons";

  const group = document.createElement("div");
  group.className = "btn-group";

  buttons.forEach((b) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "choice-btn";
    btn.textContent = b.label || b.value;
    btn.setAttribute("data-value", b.value);
    btn.addEventListener("click", () => {
      const value = btn.getAttribute("data-value") || btn.textContent;
      // feedback visual
      [...group.querySelectorAll("button")].forEach((x) => (x.disabled = true));
      group.classList.add("used");

      addMessage(btn.textContent, "user");

      // En modo humano no mostramos “escribiendo…”
      if (!humanMode) startTypingTimer();
      socket.emit("user_message", { text: value });

      wrap.remove();
    });
    group.appendChild(btn);
  });

  bubble.appendChild(group);
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  scrollToBottom();
}

function addPropertyCards(cards) {
  if (!Array.isArray(cards) || !cards.length) return;

  const wrap = document.createElement("div");
  wrap.className = "msg"; // bot

  const bubble = document.createElement("div");
  bubble.className = "bubble prop-cards";

  const grid = document.createElement("div");
  grid.className = "prop-grid";

  cards.forEach((c) => {
    const card = document.createElement("div");
    card.className = "prop-card";

    const img = document.createElement("div");
    img.className = "prop-img";
    if (c.image) {
      img.style.backgroundImage = `url("${c.image}")`;
    } else {
      img.classList.add("noimg");
      img.textContent = "Sin foto";
    }

    const body = document.createElement("div");
    body.className = "prop-body";

    const title = document.createElement("div");
    title.className = "prop-title";
    title.textContent = c.title || "Propiedad";

    const price = document.createElement("div");
    price.className = "prop-price";
    price.textContent = c.priceText || "";

    const ex = document.createElement("div");
    ex.className = "prop-excerpt";
    ex.textContent = c.excerpt || "";

    const actions = document.createElement("div");
    actions.className = "prop-actions";

    const link = document.createElement("a");
    link.className = "prop-link";
    link.href = c.link;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Ver publicación";

    actions.appendChild(link);

    body.appendChild(title);
    body.appendChild(price);
    if (c.excerpt) body.appendChild(ex);
    body.appendChild(actions);

    card.appendChild(img);
    card.appendChild(body);
    grid.appendChild(card);
  });

  bubble.appendChild(grid);
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  scrollToBottom();
}

/* --------------------- Indicador de escritura -------------------- */
let typingTimer = null;
function showTyping() {
  if (document.querySelector(".msg.typing")) return;
  const wrap = document.createElement("div");
  wrap.className = "msg typing";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = `<span class="dots"><i></i><i></i><i></i></span> <span class="small">${COMPANY_NAME} está escribiendo…</span>`;
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  scrollToBottom();
}
function hideTyping() {
  const t = document.querySelector(".msg.typing");
  if (t) t.remove();
}
function startTypingTimer() {
  clearTimeout(typingTimer);
  typingTimer = setTimeout(showTyping, 250); // se muestra si tarda >250ms
}
function stopTyping() {
  clearTimeout(typingTimer);
  hideTyping();
}

/* --------------------- Banner modo agente (UI) ------------------- */
let humanBanner = null;
function ensureBanner() {
  if (humanBanner) return humanBanner;

  humanBanner = document.createElement("div");
  humanBanner.id = "human-banner";
  humanBanner.style.padding = "10px 14px";
  humanBanner.style.background = "rgba(34,211,238,.12)";
  humanBanner.style.borderBottom = "1px solid rgba(34,211,238,.35)";
  humanBanner.style.fontWeight = "600";
  humanBanner.style.display = "none";
  humanBanner.style.display = "none";

  // Botón “Finalizar conversación”
  const endBtn = document.createElement("button");
  endBtn.id = "end-conv";
  endBtn.textContent = "Finalizar conversación";
  endBtn.style.marginLeft = "10px";
  endBtn.style.padding = "6px 10px";
  endBtn.style.border = "none";
  endBtn.style.borderRadius = "8px";
  endBtn.style.background = "var(--accent)";
  endBtn.style.color = "#001219";
  endBtn.style.fontWeight = "800";
  endBtn.style.cursor = "pointer";
  endBtn.addEventListener("click", () => {
    endBtn.disabled = true; // evita dobles clicks
    socket.emit("user_finish");
  });

  humanBanner.appendChild(
    document.createTextNode("👤 Estás chateando con un agente.")
  );
  humanBanner.appendChild(endBtn);

  // Insertar el banner arriba de la lista de mensajes
  const container = document.querySelector(".chat-container") || document.body;
  container.insertBefore(
    humanBanner,
    container.firstChild.nextSibling || messagesEl
  );

  return humanBanner;
}
function showHumanBanner(agentName) {
  const banner = ensureBanner();
  banner.firstChild.textContent = `👤 Estás chateando con ${
    agentName || "un agente"
  }. `;
  banner.style.display = "block";
}
function hideHumanBanner() {
  if (!humanBanner) return;
  // Habilitar de nuevo el botón finalizar por si lo deshabilitamos
  const endBtn = humanBanner.querySelector("#end-conv");
  if (endBtn) endBtn.disabled = false;
  humanBanner.style.display = "none";
}

/* --------------------------- Sockets ----------------------------- */
socket.on("bot_message", (msg) => {
  stopTyping();

  // ✅ Cards
  if (msg.type === "property_cards" && Array.isArray(msg.cards)) {
    addPropertyCards(msg.cards);
    return;
  }

  // Texto normal
  if (msg.text) addMessage(msg.text, "bot");

  // Botones
  if (Array.isArray(msg.buttons) && msg.buttons.length) addButtons(msg.buttons);
});

socket.on("system_message", (msg) => {
  stopTyping();
  addMessage(msg.text, "system");
});

// Cuando el agente envía un mensaje
socket.on("agent_message", (msg) => {
  stopTyping();
  if (msg.type === "image" && msg.url) {
    addImage(msg.url, "bot");
    if (msg.text) addMessage(msg.text, "bot");
    return;
  }
  if (msg.text) addMessage(msg.text, "bot");
});

// Handoff: el server nos avisa que un agente tomó el caso
socket.on("agent_assigned", ({ agent }) => {
  humanMode = true;
  stopTyping();
  disableAllChoiceButtons();
  showHumanBanner(agent);
});

// Restaurar estado tras recarga de página
socket.on("restore_state", ({ transcript, humanMode: hm, agentName }) => {
  stopTyping();
  messagesEl.innerHTML = ""; // limpiar si había algo
  if (Array.isArray(transcript)) {
    transcript.forEach((msg) => {
      if (msg.type === "image" && msg.url) {
        addImage(msg.url, msg.who === "user" ? "user" : "bot");
      } else if (msg.text) {
        const who = msg.who === "user" ? "user" : msg.who === "system" ? "system" : "bot";
        addMessage(msg.text, who);
      }
    });
  }
  if (hm) {
    humanMode = true;
    disableAllChoiceButtons();
    showHumanBanner(agentName);
  }
  scrollToBottom();
});

// Handoff: el server avisa que terminó el chat con agente
socket.on("agent_finished", () => {
  humanMode = false;
  hideHumanBanner();
  stopTyping();
});

/* -------------------- Envío de texto del user -------------------- */
form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  addMessage(text, "user");
  if (!humanMode) startTypingTimer(); // en modo humano no mostramos “escribiendo…”
  socket.emit("user_message", { text });
  input.value = "";
  input.focus();
});

/* ----------------------- Adjuntar foto --------------------------- */
attachBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", () => {
  const files = Array.from(fileInput.files || []);
  if (!files.length) return;

  files.forEach((file) => {
    console.log("Archivo seleccionado:", file);
    console.log("Tipo de archivo:", file.type);
    if (file.type.startsWith("image/")) {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        console.log("Imagen cargada correctamente:", dataUrl);
        addImage(dataUrl, "user");
        if (!humanMode) startTypingTimer();
        console.log("por emitir user image");
        console.log({
          name: file.name,
          type: file.type,
          data: dataUrl,
        });
        socket.emit("user_image", {
          name: file.name,
          type: file.type,
          data: dataUrl,
        });
        console.log("user image emitido");
      };
      reader.readAsDataURL(file);
    } else {
      console.error("El archivo seleccionado no es una imagen válida.");
    }
  });
  fileInput.value = "";
});

/* ---------- ⭐ Calificación ---------- */
function renderRatingPrompt(agentName) {
  const wrap = document.createElement("div");
  wrap.className = "msg"; // burbuja del bot

  const bubble = document.createElement("div");
  bubble.className = "bubble buttons";

  const title = document.createElement("div");
  title.style.marginBottom = "6px";
  title.textContent = `¿Cómo fue la atención con ${agentName || "el agente"}?`;
  bubble.appendChild(title);

  const group = document.createElement("div");
  group.className = "btn-group";

  // 5 botones: 1..5
  for (let i = 1; i <= 5; i++) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "choice-btn";
    b.textContent = "★".repeat(i) + "☆".repeat(5 - i); // ej: ★★★☆☆
    b.setAttribute("data-stars", i);
    b.addEventListener("click", () => {
      // feedback en el chat del usuario
      addMessage(b.textContent, "user");
      [...group.querySelectorAll("button")].forEach((x) => (x.disabled = true));
      group.classList.add("used");
      wrap.remove();
      socket.emit("rate_submit", { stars: i, skipped: false });
    });
    group.appendChild(b);
  }

  // Omitir
  const skip = document.createElement("button");
  skip.type = "button";
  skip.className = "choice-btn";
  skip.textContent = "Omitir";
  skip.addEventListener("click", () => {
    addMessage("Omitir", "user");
    [...group.querySelectorAll("button")].forEach((x) => (x.disabled = true));
    group.classList.add("used");
    wrap.remove();
    socket.emit("rate_submit", { skipped: true });
  });
  group.appendChild(skip);

  bubble.appendChild(group);
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  scrollToBottom();
}

// Pedir calificación al finalizar el chat humano
socket.on("rate_request", ({ agent }) => {
  // ya estamos fuera de humanMode por agent_finished
  renderRatingPrompt(agent);
});
