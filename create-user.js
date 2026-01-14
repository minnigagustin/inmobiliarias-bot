// create-user.js
const DB = require("./database");

const args = process.argv.slice(2);
const [username, password, ...nameParts] = args;
const fullName = nameParts.join(" ");

if (!username || !password || !fullName) {
  console.log(
    '❌ Uso: node create-user.js <usuario> <contraseña> <"Nombre Completo">'
  );
  console.log('Ejemplo: node create-user.js juan 1234 "Juan Perez"');
  process.exit(1);
}

(async () => {
  try {
    const id = await DB.createAgent(username, password, fullName);
    console.log(`✅ Agente creado exitosamente!`);
    console.log(`🆔 ID: ${id}`);
    console.log(`👤 Usuario: ${username}`);
    console.log(`📛 Nombre: ${fullName}`);
  } catch (e) {
    if (e.message.includes("UNIQUE constraint failed")) {
      console.error("❌ Error: Ese nombre de usuario ya existe.");
    } else {
      console.error("❌ Error creando agente:", e.message);
    }
  }
})();
