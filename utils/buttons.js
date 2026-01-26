// utils/buttons.js - Contextual Buttons Builder

/**
 * Build button options for a given conversation step
 * @param {Object} session - User session with step and data
 * @returns {Array|null} - Array of button objects or null
 */
function buildButtonsForStep(session) {
  const step = session?.step;
  if (!step) return null;

  switch (step) {
    case "main":
      return [
        { label: "1. Administración de alquileres", value: "1" },
        { label: "2. Consulta de propiedades", value: "2" },
        { label: "3. Consultas generales", value: "3" },
      ];

    case "alquileres_menu":
      return [
        { label: "1. Reportar un problema", value: "1" },
        { label: "2. Actualizar por índice", value: "2" },
        { label: "3. Info inquilinos", value: "3" },
        { label: "4. Info propietarios", value: "4" },
        { label: "5. Hablar con un operador", value: "5" },
      ];

    case "rep_categoria":
      return [
        { label: "1. Plomería", value: "1" },
        { label: "2. Gas", value: "2" },
        { label: "3. Electricidad", value: "3" },
        { label: "4. Artefacto roto", value: "4" },
        { label: "5. Otro", value: "5" },
      ];

    case "indices_menu":
      return [
        { label: "ICL", value: "ICL" },
        { label: "CAC", value: "CAC" },
        { label: "UVA", value: "UVA" },
        { label: "UVI", value: "UVI" },
        { label: "CER", value: "CER" },
        { label: "Casa Propia", value: "Casa Propia" },
        { label: "IPC INDEC 1 mes", value: "IPC INDEC 1" },
        { label: "IPC INDEC 2 meses", value: "IPC INDEC 2" },
        { label: "IPC CREEBBA 1 mes", value: "IPC CREEBBA 1" },
        { label: "IPC CREEBBA 2 meses", value: "IPC CREEBBA 2" },
      ];

    case "rep_derivar":
    case "ind_derivar":
    case "prop_buscar_derivar":
    case "prop_cochera":
    case "prop_vender_derivar":
    case "rep_fotos_preg":
      return [
        { label: "Sí", value: "sí" },
        { label: "No", value: "no" },
      ];

    case "prop_menu":
      return [
        { label: "1. Alquilar", value: "1" },
        { label: "2. Comprar", value: "2" },
        { label: "3. Temporario", value: "3" },
        { label: "4. Vender", value: "4" },
      ];

    case "prop_tipo_menu":
      return [
        { label: "1. Casa", value: "1" },
        { label: "2. Depto", value: "2" },
        { label: "3. PH", value: "3" },
        { label: "4. Otro", value: "4" },
      ];

    case "ind_moneda":
    case "prop_moneda":
      return [
        { label: "1. Pesos (ARS)", value: "1" },
        { label: "2. Dólares (USD)", value: "2" },
      ];

    case "prop_ciudad": {
      const opts = session?.data?.cityOptions || [];
      const top = opts.slice(0, 10);
      return top.map((c, i) => ({
        label: `${i + 1}. ${c.name}`,
        value: String(i + 1),
      }));
    }

    default:
      return null;
  }
}

module.exports = { buildButtonsForStep };
