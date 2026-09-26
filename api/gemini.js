// ==============================================================================
// VERCEL SERVERLESS FUNCTION: /api/gemini
// Interpreta comandos de voz y texto con Google Gemini AI
// ==============================================================================

export default async function handler(req, res) {
  // Configuración de CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido. Usa POST.' });
  }

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch (e) {}
    }
    const { prompt, financialContext, apiKey: clientApiKey } = body || {};

    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'El parámetro "prompt" es obligatorio.' });
    }

    // Usar API key de variables de entorno de Vercel o la provista por el cliente
    const apiKey = process.env.GEMINI_API_KEY || clientApiKey;

    if (!apiKey) {
      return res.status(400).json({
        error: 'No se encontró la clave de API de Gemini. Configúrala en las variables de entorno de Vercel (GEMINI_API_KEY) o en los Ajustes de la App.'
      });
    }

    const systemInstruction = `Eres el Asistente Inteligente de Control Financiero Pro.
Tu tarea es interpretar mensajes en lenguaje natural (tanto escrito como transcrito por voz) para:
1) REGISTRAR movimientos individuales (gastos diarios, ingresos, servicios, cuotas).
2) RECONCILIAR O AJUSTAR EL SALDO REAL cuando el usuario dice cuánto dinero le quedó en mano o que ya pagó sus cuentas (ejemplos clave:
   - 'ya pagué todo y me quedaron 100.000 pesos'
   - 'pagué todo excepto la luz y me quedaron 100.000'
   - 'mi saldo real es 100.000 pesos, ajusta las cuentas'
   - 'ajustame el saldo a 80.000').
3) MARCAR SERVICIOS COMO PAGADOS (ej: 'ya pagué la luz', 'marcar todos los servicios como abonados').
4) Responder consultas y análisis sobre las finanzas del usuario.

${financialContext || 'Contexto financiero no provisto.'}

REGLA OBLIGATORIA: Debes responder SIEMPRE en formato JSON puro con la siguiente estructura (NO agregues bloques markdown \`\`\`json):
{
  "tipo_accion": "REGISTRAR_DIARIO" | "REGISTRAR_INGRESO" | "REGISTRAR_SERVICIO" | "REGISTRAR_DEUDA" | "RECONCILIAR_SALDO" | "PAGAR_SERVICIOS" | "ANALISIS",
  "datos": {
     "descripcion": "descripción breve del movimiento",
     "monto": 0,
     "metodo": "banco o metodo de pago mas afín",
     "vencimiento": 10,
     "cuotas": 1,
     "tipo_deuda": "tarjeta" o "prestamo",
     "saldo_real_objetivo": 0,
     "marcar_servicios_pagados": true,
     "servicios_excluidos": ["nombres de servicios que NO pagó"],
     "servicios_a_pagar": ["nombres de servicios específicos a pagar"]
  },
  "mensaje_usuario": "explicación clara, empática y amigable confirmando exactamente qué servicios se pagaron y a cuánto se ajustó su saldo"
}

Reglas de interpretación:
- Si el usuario dice 'ya pagué todo y me quedaron 100.000' o 'pagué todo menos X y me quedaron Y': USA tipo_accion: 'RECONCILIAR_SALDO', saldo_real_objetivo con el monto que le quedó, marcar_servicios_pagados: true, y en servicios_excluidos coloca los que haya aclarado que debe.
- Si el usuario dice 'mi saldo real es X' o 'en la cuenta me quedaron X': USA tipo_accion: 'RECONCILIAR_SALDO' con saldo_real_objetivo: X y marcar_servicios_pagados: false.
- Si el usuario dice 'pagué la luz' o 'marcar servicios como pagados': USA tipo_accion: 'PAGAR_SERVICIOS'.
- Si es pregunta o análisis: USA tipo_accion: 'ANALISIS'.`;

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

    const payload = {
      contents: [{ parts: [{ text: prompt }] }],
      systemInstruction: { parts: [{ text: systemInstruction }] },
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.2
      }
    };

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({
        error: `Error en la API de Gemini (${response.status}): ${errorText}`
      });
    }

    const data = await response.json();
    let textResponse = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';

    // Limpiar posibles etiquetas markdown
    textResponse = textResponse.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();

    let parsedResult;
    try {
      parsedResult = JSON.parse(textResponse);
    } catch (parseErr) {
      parsedResult = {
        tipo_accion: 'ANALISIS',
        datos: {},
        mensaje_usuario: textResponse
      };
    }

    return res.status(200).json(parsedResult);
  } catch (error) {
    console.error('Error en serverless gemini handler:', error);
    return res.status(500).json({ error: error.message || 'Error interno del servidor' });
  }
}
