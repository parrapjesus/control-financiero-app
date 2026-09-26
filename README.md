# 🚀 Control Financiero Pro (Vercel + Supabase + Gemini AI)

Aplicación moderna de finanzas personales, gestión de servicios, cuotas de tarjetas, reconciliación automática de saldo y asistente inteligente con IA (Gemini 2.0 Flash).

---

## ❓ ¿Por qué se necesita Supabase con Vercel?

* **Vercel** se encarga del **Hosting (Alojamiento)** y de ejecutar las **Funciones Serverless** (como la API segura para Gemini). **Vercel NO incluye una base de datos gratuita persistente por sí solo**.
* **Supabase** se encarga de la **Persistencia (Base de datos PostgreSQL real)**, de la **Seguridad Multi-usuario (RLS)** y del **Almacenamiento de Archivos (Storage)** para los comprobantes/vouchers de pago.

👉 **Conclusión:** Vercel aloja tu app y protege tu clave de Gemini; Supabase guarda tus transacciones de forma segura y permanente. ¡Ambos en sus capas gratuitas (*Free Tier*) son extremadamente potentes y sin costo!

---

## 📁 Estructura del Proyecto

```text
control-financiero-web/
├── api/
│   └── gemini.js           # Serverless Function segura en Vercel para procesar IA
├── public/
│   ├── js/
│   │   ├── app.js             # Lógica financiera, métricas, UI, gráficos y voz
│   │   └── supabase-config.js # Conexión al cliente de Supabase
│   └── index.html             # Interfaz moderna (Tailwind, Chart.js, PWA)
├── .env.example            # Plantilla de variables de entorno
├── package.json            # Dependencias y scripts
├── supabase_schema.sql     # Script SQL con tablas, RLS, triggers y Storage
├── vercel.json             # Configuración de rutas y despliegue en Vercel
└── README.md               # Guía paso a paso
```

---

## 🛠️ Guía Paso a Paso para Desplegar

### Paso 1: Configurar la Base de Datos en Supabase (Gratis)
1. Entra en [supabase.com](https://supabase.com) y crea una cuenta gratuita.
2. Crea un **Nuevo Proyecto** (ej: `control-financiero`).
3. En el menú lateral izquierdo, entra a **SQL Editor**.
4. Copia todo el contenido del archivo [`supabase_schema.sql`](./supabase_schema.sql), pégalo en el editor y haz clic en **Run**.
5. Ve a **Project Settings -> API** y copia:
   - **Project URL** (ej: `https://xyz.supabase.co`)
   - **anon / public key** (ej: `eyJhbGci...`)

---

### Paso 2: Obtener Clave de Gemini AI (Gratis)
1. Entra en [Google AI Studio](https://aistudio.google.com/).
2. Haz clic en **Get API key** y copia tu clave.

---

### Paso 3: Desplegar en Vercel
1. Sube esta carpeta `control-financiero-web` a tu repositorio de **GitHub**.
2. Entra en [vercel.com](https://vercel.com) e importa tu repositorio.
3. En la sección **Environment Variables**, añade las siguientes variables:
   * `SUPABASE_URL`: Tu Project URL de Supabase.
   * `SUPABASE_ANON_KEY`: Tu Anon Key de Supabase.
   * `GEMINI_API_KEY`: Tu clave de Google AI Studio.
4. Haz clic en **Deploy**. ¡Tu aplicación estará en línea con dominio HTTPS y velocidad ultra rápida!

---

### Paso 4: (Opcional) Probar Localmente
Si tienes Node.js instalado, puedes ejecutar en la terminal:
```bash
npx vercel dev
```
O simplemente abrir el archivo [`public/index.html`](./public/index.html) en tu navegador para probar con datos locales mientras configuras tus credenciales.
