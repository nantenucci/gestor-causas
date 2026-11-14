// Lee el texto de un documento judicial y devuelve los datos de la causa
// para precargar "Nueva causa" en el Gestor y armar la carátula.
import Anthropic from "npm:@anthropic-ai/sdk";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const TEXTO = { type: "string" };
const CAMPOS: Record<string, unknown> = {
  rol: {
    type: "string", enum: ["Defensa", "Querella"],
    description: "Querella si el Dr. Néstor Antenucci (o el estudio) patrocina a la víctima/querellante; si no, Defensa",
  },
  cliente_querellante: { ...TEXTO, description: "Solo en Querella: víctima/querellante que patrocina el estudio, 'APELLIDO, Nombres'" },
  imputado: { ...TEXTO, description: "Imputado principal, formato 'APELLIDO, Nombres' (en Querella es la contraparte)" },
  prefijo: { type: "string", enum: ["CUIJ", "FRO", "CFP", "CCC", "CPF", "CPN", "OTRO", ""] },
  numero: { ...TEXTO, description: "Número que individualiza la causa, sin el prefijo (ej. 21-09756060-6 o 7163/2025)" },
  legajo: TEXTO,
  caratula: { ...TEXTO, description: "Carátula oficial si figura; si no, 'APELLIDO, Nombre y otros s/ Delito principal'" },
  delito: { ...TEXTO, description: "Delito principal en pocas palabras, para la grilla" },
  delito_detalle: { ...TEXTO, description: "Todos los delitos con artículos, concurso y grado de participación" },
  codigo: { type: "string", enum: ["CPPSF", "CPPF", "Ambos", "Menores", ""] },
  fiscal: TEXTO,
  juez: TEXTO,
  estado: { ...TEXTO, description: "Una de las opciones de estado provistas, o vacío" },
  privado: { type: "string", enum: ["SÍ", "NO", "Domiciliario", ""], description: "¿Está privado de la libertad?" },
  unidad: { ...TEXTO, description: "Una de las opciones de unidad provistas, o vacío" },
  modulo: { ...TEXTO, description: "Módulo de alojamiento dentro de la unidad, solo si el documento lo dice (ej. 'Módulo 2')" },
  pabellon: { ...TEXTO, description: "Pabellón de alojamiento, solo si el documento lo dice (ej. 'Pabellón 4')" },
  alojado: { ...TEXTO, description: "Dónde está alojado y situación de la medida cautelar (vencimientos)" },
  fecha_hecho: TEXTO,
  fecha_detencion: { ...TEXTO, description: "Fecha en que el imputado fue detenido/aprehendido, dd/mm/aaaa, solo si el documento la dice" },
  fecha_preventiva: { ...TEXTO, description: "Fecha en que se dictó la prisión preventiva, dd/mm/aaaa, solo si el documento dice que se dictó (no si solo se pidió)" },
  fecha_audiencia_cautelar: { ...TEXTO, description: "Fecha de la audiencia más reciente del documento en la que se resolvieron medidas cautelares (preventiva, morigeración, revisión), dd/mm/aaaa" },
  fecha_audiencia: { ...TEXTO, description: "Fecha de la audiencia imputativa o la principal del documento, dd/mm/aaaa" },
  victima: TEXTO,
  vinculados: { type: "array", items: TEXTO, description: "Coimputados u otros vinculados, con su rol entre paréntesis" },
  cliente_dni: TEXTO,
  cliente_domicilio: TEXTO,
  cliente_telefono: TEXTO,
  notas: { ...TEXTO, description: "Resumen breve útil para el abogado defensor: medidas, vencimientos, próximos pasos" },
};

const ESQUEMA = {
  type: "object",
  properties: CAMPOS,
  required: Object.keys(CAMPOS),
  additionalProperties: false,
};

// si al cargar el secret se pegó texto de más alrededor de la clave, nos quedamos solo con la clave
const secreto = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const anthropic = new Anthropic({ apiKey: secreto.match(/sk-ant-[\w-]+/)?.[0] ?? secreto.trim() });

function responder(cuerpo: unknown, status = 200) {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const { texto, estados = [], unidades = [] } = await req.json();
    if (!texto || String(texto).trim().length < 50) {
      return responder({ error: "El documento no tiene texto legible. Si es escaneado, pasalo antes por la carpeta OCR." }, 400);
    }

    const respuesta = await anthropic.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      system:
        "Sos asistente de un estudio de defensa penal en Rosario, Santa Fe. Del documento judicial que te pasan, " +
        "extraé los datos de la causa. El estudio del Dr. Néstor Antenucci puede defender al imputado o patrocinar a la víctima " +
        "como querellante: indicá cuál en 'rol'. Usá solo lo que el documento dice: " +
        "si un dato no figura, dejalo vacío; no inventes nombres de fiscales, jueces ni números. Fechas en dd/mm/aaaa.",
      messages: [{
        role: "user",
        content:
          `Opciones de estado válidas:\n${estados.join("\n")}\n\n` +
          `Opciones de unidad penitenciaria válidas:\n${unidades.join("\n")}\n\n` +
          `Documento:\n${texto}`,
      }],
      output_config: { format: { type: "json_schema", schema: ESQUEMA } },
    });

    if (respuesta.stop_reason === "refusal") {
      return responder({ error: "La IA no pudo procesar este documento." }, 422);
    }
    const bloque = respuesta.content.find((b) => b.type === "text");
    if (!bloque || bloque.type !== "text") return responder({ error: "La IA no devolvió datos." }, 502);
    return responder(JSON.parse(bloque.text));
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      return responder({ error: "Falta configurar la clave de la IA (ANTHROPIC_API_KEY) en Supabase." }, 500);
    }
    if (err instanceof Anthropic.RateLimitError) {
      return responder({ error: "La IA está saturada, probá en un minuto." }, 429);
    }
    // el detalle va al log de Supabase, nunca a la pantalla (podría incluir la clave)
    console.error(err);
    const status = err instanceof Anthropic.APIError ? ` (código ${err.status})` : "";
    return responder({ error: `No se pudo leer el documento con la IA${status}. Probá de nuevo en un rato.` }, 500);
  }
});
