// create-super-user.js
const DB = require("./database");

const args = process.argv.slice(2);
// Esperamos: node create-super-user.js <usuario> <password> <Nombre Completo>
const [username, password, ...nameParts] = args;
const fullName = nameParts.join(" ");

if (!username || !password || !fullName) {
  console.log(
    '❌ Uso: node create-super-user.js <usuario> <password> <"Nombre Completo">'
  );
  process.exit(1);
}

(async () => {
  try {
    // 🔥 AQUÍ ESTÁ LA CLAVE: Pasamos 'superadmin' como 4to argumento
    const id = await DB.createAgent(username, password, fullName, "superadmin");

    console.log(`✅ SUPER ADMIN creado exitosamente!`);
    console.log(`🆔 ID: ${id}`);
    console.log(`👤 Usuario: ${username}`);
    console.log(`📛 Nombre: ${fullName}`);
    console.log(`🛡️ Rol: superadmin`);
  } catch (e) {
    if (e.message && e.message.includes("UNIQUE constraint failed")) {
      console.error("❌ Error: Ese nombre de usuario ya existe.");
    } else {
      console.error("❌ Error creando admin:", e);
    }
  }
})();
