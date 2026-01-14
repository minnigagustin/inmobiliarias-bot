// database.js
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcryptjs");
const path = require("path");

const db = new sqlite3.Database(path.join(__dirname, "chat.db"), (err) => {
  if (err) console.error(err.message);
  else console.log("📁 Base de datos conectada.");
});

db.serialize(() => {
  // Agentes (Agregamos columna role si no existe, SQLite no soporta ADD COLUMN IF NOT EXISTS fácil,
  // así que asumiremos creación o alteración manual si ya tienes datos,
  // pero para este ejemplo simple recreamos si no existe)
  db.run(`CREATE TABLE IF NOT EXISTS agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    name TEXT,
    role TEXT DEFAULT 'agent' -- 'agent' o 'superadmin'
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT,
    who TEXT,
    text TEXT,
    url TEXT,
    type TEXT,
    timestamp INTEGER
  )`);

  // 🔥 NUEVA TABLA: TICKETS (Historial de atención)
  db.run(`CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER,
    chat_id TEXT,
    start_ts INTEGER,
    end_ts INTEGER,
    topic TEXT, 
    status TEXT
  )`);

  // 🔥 MIGRACIÓN AUTOMÁTICA: Agregar columna rating si no existe
  db.run("ALTER TABLE tickets ADD COLUMN rating INTEGER", (err) => {
    // Si da error es porque ya existe, lo ignoramos.
  });
});

// Crear admin por defecto como superadmin
setTimeout(async () => {
  db.get("SELECT count(*) as count FROM agents", async (err, row) => {
    if (row.count === 0) {
      const hash = await bcrypt.hash("123456", 10);
      db.run(
        "INSERT INTO agents (username, password, name, role) VALUES (?, ?, ?, ?)",
        ["admin", hash, "Super Admin", "superadmin"]
      );
      console.log("⚠️ Usuario creado: admin / 123456 (SuperAdmin)");
    }
  });
}, 1000);

module.exports = {
  db,

  // ... (Tus funciones existentes getAgent, createAgent, saveMessage, getHistory se mantienen IGUAL) ...
  getAgent: (username) => {
    return new Promise((resolve, reject) => {
      db.get(
        "SELECT * FROM agents WHERE username = ?",
        [username],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
  },
  // 🔥 NUEVO: Estadísticas para Dashboard
  // 🔥 ACTUALIZADO: Estadísticas con Tendencia Real
  getStats: () => {
    return new Promise(async (resolve, reject) => {
      try {
        const now = new Date();
        const startOfDay = new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate()
        ).getTime();
        const startOfMonth = new Date(
          now.getFullYear(),
          now.getMonth(),
          1
        ).getTime();

        // 1. Contadores Básicos
        const ticketsToday = await new Promise((r) =>
          db.get(
            "SELECT count(*) as c FROM tickets WHERE start_ts >= ?",
            [startOfDay],
            (_, x) => r(x.c)
          )
        );
        const ticketsMonth = await new Promise((r) =>
          db.get(
            "SELECT count(*) as c FROM tickets WHERE start_ts >= ?",
            [startOfMonth],
            (_, x) => r(x.c)
          )
        );
        const totalMsgs = await new Promise((r) =>
          db.get(
            "SELECT count(*) as c FROM messages WHERE who = 'user'",
            [],
            (_, x) => r(x.c)
          )
        );
        const agentsCount = await new Promise((r) =>
          db.get("SELECT count(*) as c FROM agents", [], (_, x) => r(x.c))
        );

        // 2. Desglose por categorías (Top 5)
        const categories = await new Promise((r) =>
          db.all(
            "SELECT topic, count(*) as count FROM tickets GROUP BY topic ORDER BY count DESC LIMIT 5",
            [],
            (_, rows) => r(rows)
          )
        );

        // 3. 📊 Tendencia Semanal (Últimos 7 días)
        const trendLabels = []; // Ej: ["Lun", "Mar", ...]
        const trendData = []; // Ej: [5, 0, 12, ...]

        // Vamos desde hace 6 días hasta hoy (total 7 días)
        for (let i = 6; i >= 0; i--) {
          const d = new Date();
          d.setDate(d.getDate() - i);

          // Definir inicio y fin de ESE día específico para la consulta
          const dayStart = new Date(
            d.getFullYear(),
            d.getMonth(),
            d.getDate()
          ).getTime();
          const dayEnd = dayStart + 86400000; // +24hs

          // Consulta síncrona dentro del loop (SQLite es rápido, esto está bien para admin)
          const count = await new Promise((r) =>
            db.get(
              "SELECT count(*) as c FROM tickets WHERE start_ts >= ? AND start_ts < ?",
              [dayStart, dayEnd],
              (_, x) => r(x.c)
            )
          );

          // Formatear etiqueta (Ej: "mié")
          const label = d.toLocaleDateString("es-ES", { weekday: "short" });
          trendLabels.push(label.charAt(0).toUpperCase() + label.slice(1)); // Capitalizar
          trendData.push(count);
        }

        resolve({
          ticketsToday,
          ticketsMonth,
          totalMsgs,
          agentsCount,
          categories,
          trend: { labels: trendLabels, data: trendData }, // 👈 Enviamos la data del gráfico
        });
      } catch (e) {
        reject(e);
      }
    });
  },

  // 🔥 NUEVO: Editar Agente
  updateAgent: async (id, username, name, role, password) => {
    return new Promise(async (resolve, reject) => {
      try {
        if (password) {
          // Si mandan password, la hasheamos y actualizamos todo
          const hash = await bcrypt.hash(password, 10);
          db.run(
            "UPDATE agents SET username=?, name=?, role=?, password=? WHERE id=?",
            [username, name, role, hash, id],
            (err) => (err ? reject(err) : resolve(true))
          );
        } else {
          // Si no mandan password, actualizamos solo datos
          db.run(
            "UPDATE agents SET username=?, name=?, role=? WHERE id=?",
            [username, name, role, id],
            (err) => (err ? reject(err) : resolve(true))
          );
        }
      } catch (e) {
        reject(e);
      }
    });
  },

  // 🔥 NUEVO: Borrar Agente
  deleteAgent: (id) => {
    return new Promise((resolve, reject) => {
      db.run("DELETE FROM agents WHERE id = ?", [id], (err) => {
        if (err) reject(err);
        else resolve(true);
      });
    });
  },
  createAgent: async (username, password, name, role = "agent") => {
    const hash = await bcrypt.hash(password, 10);
    return new Promise((resolve, reject) => {
      db.run(
        "INSERT INTO agents (username, password, name, role) VALUES (?, ?, ?, ?)",
        [username, hash, name, role],
        function (err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });
  },
  saveMessage: (chatId, msg) => {
    db.run(
      "INSERT INTO messages (chat_id, who, text, url, type, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
      [
        chatId,
        msg.who,
        msg.text || "",
        msg.url || null,
        msg.type || "text",
        msg.ts || Date.now(),
      ]
    );
  },
  getHistory: (chatId) => {
    return new Promise((resolve, reject) => {
      db.all(
        "SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp ASC",
        [chatId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  },

  // 🔥 NUEVAS FUNCIONES PARA SUPER ADMIN

  // 1. Crear Ticket (Al tomar chat)
  // 🔥 ACTUALIZADO: Crear Ticket con 'topic'
  createTicket: (agentId, chatId, topic) => {
    return new Promise((resolve, reject) => {
      const now = Date.now();
      db.run(
        "INSERT INTO tickets (agent_id, chat_id, start_ts, status, topic) VALUES (?, ?, ?, ?, ?)",
        [agentId, chatId, now, "open", topic || "General"],
        function (err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });
  },

  // 2. Cerrar Ticket (Al finalizar chat)
  closeTicket: (chatId, agentId) => {
    return new Promise((resolve, reject) => {
      const now = Date.now();
      // Cerramos el ticket abierto más reciente para este chat y agente
      db.run(
        `UPDATE tickets SET end_ts = ?, status = 'closed' 
              WHERE chat_id = ? AND agent_id = ? AND status = 'open'`,
        [now, chatId, agentId],
        (err) => {
          if (err) reject(err);
          else resolve(true);
        }
      );
    });
  },

  // 3. Obtener todos los agentes
  getAllAgents: () => {
    return new Promise((resolve, reject) => {
      db.all("SELECT id, name, username, role FROM agents", [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  },

  // 4. Obtener tickets por agente
  getTicketsByAgent: (agentId) => {
    return new Promise((resolve, reject) => {
      db.all(
        `SELECT * FROM tickets WHERE agent_id = ? ORDER BY start_ts DESC`,
        [agentId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  },

  // 🔥 NUEVO: Guardar calificación en el ticket
  saveRating: (chatId, rating) => {
    return new Promise((resolve, reject) => {
      // Actualizamos el último ticket de este usuario
      db.run(
        `UPDATE tickets SET rating = ? 
         WHERE chat_id = ? AND id = (SELECT MAX(id) FROM tickets WHERE chat_id = ?)`,
        [rating, chatId, chatId],
        (err) => (err ? reject(err) : resolve(true))
      );
    });
  },
};
