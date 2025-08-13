const socket = io();

const messagesEl = document.getElementById("messages");
const form = document.getElementById("input-form");
const input = document.getElementById("input");
const attachBtn = document.getElementById("attach-btn");
const fileInput = document.getElementById("file-input");

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

function addButtons(buttons) {
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
      // Al elegir, enviamos como si el usuario escribiera
      const value = btn.getAttribute("data-value") || btn.textContent;
      // feedback visual: deshabilitar/remover botones
      [...group.querySelectorAll("button")].forEach((x) => (x.disabled = true));
      group.classList.add("used");

      addMessage(btn.textContent, "user");
      startTypingTimer();
      socket.emit("user_message", { text: value });

      // opcional: retirar completamente el grupo
      wrap.remove();
    });
    group.appendChild(btn);
  });

  bubble.appendChild(group);
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  scrollToBottom();
}

/* ---------- Typing indicator ---------- */
let typingTimer = null;
function showTyping() {
  if (document.querySelector(".msg.typing")) return;
  const wrap = document.createElement("div");
  wrap.className = "msg typing";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = `<span class="dots"><i></i><i></i><i></i></span> <span class="small">BR-Group está escribiendo…</span>`;
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

/* ---------- Sockets ---------- */
socket.on("bot_message", (msg) => {
  stopTyping();
  if (msg.text) addMessage(msg.text, "bot");
  if (msg.buttons && Array.isArray(msg.buttons) && msg.buttons.length) {
    addButtons(msg.buttons);
  }
});

socket.on("system_message", (msg) => {
  stopTyping();
  addMessage(msg.text, "system");
});

/* ---------- Envío de texto ---------- */
form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  addMessage(text, "user");
  startTypingTimer();
  socket.emit("user_message", { text });
  input.value = "";
  input.focus();
});

/* ---------- Adjuntar foto ---------- */
attachBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result; // base64 data URL
    addImage(dataUrl, "user"); // preview inmediato
    startTypingTimer();
    socket.emit("user_image", {
      name: file.name,
      type: file.type,
      data: dataUrl,
    });
    fileInput.value = "";
  };
  reader.readAsDataURL(file);
});
