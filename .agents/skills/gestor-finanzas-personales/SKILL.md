---
name: gestor-finanzas-personales
description: Registra y consulta gastos diarios, pagos de servicios fijos, compras en cuotas con tarjeta, prestamos, ingresos, traspasos entre cuentas e inversiones directamente en la base de datos Supabase de Control Financiero Pro. Usar siempre que el usuario mencione haber gastado dinero, pagado un servicio o factura (Edenor, Naturgy, internet, expensas, etc.), realizado una compra en cuotas, sacado o pagado un prestamo, recibido un ingreso, movido plata entre cuentas, registrado una inversion o quiera consultar sus saldos y finanzas personales.
---

# Gestor de Finanzas Personales (Supabase Directo)

Asistente para registrar movimientos financieros y consultar saldos directamente contra la base de datos **Supabase (PostgreSQL)** usada por la aplicación web `control-financiero-web` (reemplazando la escritura manual en Google Sheets, que ahora se actualiza desde Supabase).

## Cuándo usar este skill

- Cuando el usuario reporte un gasto cotidiano en un solo pago (ej. *"pagué 2000 pesos en galleticas en efectivo"*, *"compré nafta por Santander"*).
- Cuando el usuario informe el pago de un servicio fijo mensual (ej. *"pagué Edenor, fueron 150.000"*, *"pagué el gas Naturgy"*, *"pagué expensas"*).
- Cuando el usuario registre una compra en 2 o más cuotas con tarjeta o crédito (ej. *"compré zapatillas en 3 cuotas de 25.000 con TDC"*).
- Cuando el usuario saque un préstamo nuevo o pague una cuota de un préstamo o tarjeta existente (ej. *"saqué un préstamo en Mercado Libre a 6 cuotas"*, *"pagué la cuota del préstamo"*).
- Cuando el usuario reporte un ingreso de dinero o un traspaso entre cuentas (ej. *"cobré 300.000 de sueldo en Santander"*, *"pasé 50.000 de Santander a Mercado Pago"*).
- Cuando el usuario registre o actualice una inversión, o pregunte por saldos reales, servicios pendientes, cuotas restantes o resumen de gastos.

## Configuración de conexión a Supabase

Lee la URL y la clave desde `public/js/supabase-config.js` dentro del repositorio (respaldos `getUrl()` y `getKey()`):

- **URL base REST:** `https://kqoofxosufvhlsotxwdh.supabase.co/rest/v1`
- **Headers obligatorios en todas las peticiones:**
  - `apikey: <SUPABASE_ANON_KEY>`
  - `Authorization: Bearer <SUPABASE_ANON_KEY>`
  - `Content-Type: application/json`
  - En `POST` y `PATCH`, agregar `Prefer: return=representation` para recibir el registro creado/actualizado con su `id` UUID.

Usa `curl`, `python3` o `Invoke-RestMethod` según el entorno disponible (sin instalar paquetes globales). Si el entorno remoto bloquea la salida de red hacia `supabase.co`, informa el bloqueo al usuario sin simular que se guardó el registro.

## Reglas generales de operación

1. **Validación de datos faltantes:** Antes de escribir en Supabase, verifica que tengas los datos esenciales según el movimiento (`monto`, `descripcion` o `servicio`, `metodo` de pago, y `cuotas_totales` si es compra en cuotas o préstamo). Si falta un dato clave, pregúntalo brevemente y espera confirmación.
2. **Formato de datos en Supabase:**
   - **ID:** Lo genera automáticamente Supabase (`UUID` por defecto). No envíes `id` manualmente en un `POST`.
   - **Fecha (`fecha`, `fecha_inicio`, `fecha_pago`):** Formato ISO `YYYY-MM-DD` tomando la fecha actual en zona horaria Argentina (`America/Argentina/Buenos_Aires`, UTC-3), salvo que el usuario indique otra fecha.
   - **Monto (`monto`, `monto_total`, `monto_cuota`, etc.):** Número decimal positivo (`NUMERIC(12, 2)`), sin símbolo `$` ni separadores de miles (ej. `2000`, `150000`).
   - **Método de pago:** Consulta primero `GET /metodos_pago?select=nombre` y normaliza al nombre exacto de la cuenta/método (`Efectivo`, `Transferencia`, `Mercado Pago`, `Mercado Crédito`, `Santander`, `brubank`, `TDC`, `BHD`, `ARQ`, `General`, etc.). Si el usuario dice "tarjeta" en 1 pago, usa `TDC`.
3. **Ajuste de saldo de cuentas (modelo billetera, igual que `DataService.ajustarCuenta` en `public/js/app.js`):**
   - Toda salida de dinero (`gasto diario`, `servicio pagado`, `cuota de deuda`) debe descontarse de la cuenta correspondiente en la tabla `ingresos`, **excepto** métodos de crédito (`TDC`, `Mercado Crédito`) o métodos que no tengan fila en `ingresos`.
   - Procedimiento para `ajustarCuenta(metodo, delta)`:
     1. `GET /ingresos?select=id,monto,metodo`
     2. Busca filas donde `metodo` coincida exactamente ignorando mayúsculas/minúsculas. Si no hay ninguna, no hagas nada (es crédito o método sin cuenta).
     3. Si hay más de una fila para el mismo banco/billetera, toma la de mayor `monto`.
     4. Calcula `nuevo_monto = round(monto_actual + delta, 2)` (`delta` negativo si sale dinero, positivo si entra).
     5. Ejecuta `PATCH /ingresos?id=eq.<id>` con `{ "monto": nuevo_monto }`.
4. **Registro obligatorio en `historial`:** Cada alta o pago debe insertar una fila en `POST /historial` con:
   ```json
   {
     "categoria": "...",
     "descripcion": "...",
     "monto": 2000,
     "metodo": "..."
   }
   ```
   (La columna `fecha` en `historial` se completa automáticamente en Supabase con `now()`).

## Flujo por tipo de movimiento

### 1. Gastos Diarios (`gastos_diarios`)
- **Aplica a:** Compras cotidianas en 1 solo pago (efectivo, transferencia, débito, billeteras o tarjeta en 1 cuota).
- **Pasos:**
  1. `POST /gastos_diarios` con `{ "descripcion": "...", "monto": <num>, "metodo": "...", "fecha": "YYYY-MM-DD" }`.
  2. Ejecutar `ajustarCuenta(metodo, -monto)`.
  3. `POST /historial` con `categoria: "Gasto Diario"`.

### 2. Gastos Fijos / Servicios (`gastos_fijos`)
- **Aplica a:** Servicios recurrentes (`Sancor Salud`, `Internet, casa y tlf.`, `Adobe`, `Youtube`, `Edenor Luz`, `Google one`, `Municipalidad`, `Expensas`, `Naturgy`, etc.).
- **Pasos:**
  1. `GET /gastos_fijos?select=*&order=vencimiento.asc` y busca coincidencia flexible por `servicio` (ej. `"luz"` / `"edenor"` → `Edenor Luz`; `"gas"` → `Naturgy`).
  2. Si el servicio existe: `PATCH /gastos_fijos?id=eq.<id>` con `{ "estado": "Pagado", "fecha_pago": "YYYY-MM-DD", "metodo_pago": "<metodo>", "monto": <num> }`.
     - Si el usuario ya lo tenía pagado este ciclo y pide revertirlo a `Pendiente`, actualiza `estado: "Pendiente"`, `fecha_pago: null`, `metodo_pago: null` y devuelve el monto con `ajustarCuenta(metodo_anterior, +monto)`.
  3. Si no existe: `POST /gastos_fijos` con `{ "servicio": "...", "monto": <num>, "vencimiento": <dia_1_a_31>, "estado": "Pagado", "fecha_pago": "YYYY-MM-DD", "metodo_pago": "<metodo>" }`.
  4. Ejecutar `ajustarCuenta(metodo, -monto)`.
  5. `POST /historial` con `categoria: "Servicio Pagado"`.

### 3. Compras en Cuotas y Préstamos (`deudas`)
- **Aplica a:** Compras con tarjeta en **2 o más cuotas** (`tipo: "tarjeta"`) o préstamos (`tipo: "prestamo"`). Si es tarjeta en 1 pago, va a `gastos_diarios` con método `TDC`.
- **Alta nueva:**
  1. Calcula `monto_total = cuotas_totales * monto_cuota` (o `monto_cuota = monto_total / cuotas_totales` si dio el total).
  2. `POST /deudas` con `{ "tipo": "tarjeta" | "prestamo", "nombre": "...", "monto_total": <num>, "cuotas_totales": <int>, "cuotas_pagadas": <int_default_0>, "monto_cuota": <num>, "fecha_inicio": "YYYY-MM-DD", "metodo": "..." }`.
  3. Si es préstamo nuevo o ya pagó una cuota inicial según indique el usuario, registra en `historial` (`"Nuevo Prestamo"` o `"Compra Tarjeta"`).
- **Pago de cuota existente:**
  1. `GET /deudas?select=*` y localiza el registro por `nombre` (y `tipo`).
  2. Verifica que `cuotas_pagadas < cuotas_totales` y actualiza `PATCH /deudas?id=eq.<id>` con `{ "cuotas_pagadas": cuotas_pagadas + 1 }`.
  3. Descuenta el importe abonado del banco con que se pagó usando `ajustarCuenta(banco_debito, -monto_abonado)`.
  4. `POST /historial` con `categoria: "Cuota tarjeta"` o `"Cuota prestamo"` y `descripcion: "Pago cuota X/Y de <nombre>"`.

### 4. Ingresos y Traspasos (`ingresos`)
- **Ingreso nuevo:**
  1. `POST /ingresos` con `{ "descripcion": "...", "monto": <num>, "metodo": "...", "fecha": "YYYY-MM-DD" }`.
  2. `POST /historial` con `categoria: "Ingreso"`.
- **Traspaso entre cuentas:**
  1. Resta `monto` en la cuenta origen (`ajustarCuenta(origen, -monto)` o piso en `0`).
  2. Suma `monto` en la cuenta destino (`ajustarCuenta(destino, +monto)`, o crea fila en `ingresos` si no existía).
  3. `POST /historial` con `categoria: "Traspaso"`, `descripcion: "Traspaso: <origen> ➔ <destino>"`, `metodo: "<origen> ➔ <destino>"`.

### 5. Inversiones (`inversiones`)
- **Alta:** `POST /inversiones` con `{ "nombre": "...", "tipo": "Renta Fija|...", "plataforma": "...", "monto_invertido": <num>, "valor_actual": <num>, "moneda": "ARS|USD", "rendimiento_pct": <num>, "fecha": "YYYY-MM-DD", "notas": "..." }`.

### 6. Consultas de estado y saldos
- Cuando el usuario pida consultar saldos, servicios pendientes, cuotas restantes o gastos recientes, realiza únicamente peticiones `GET` a `ingresos`, `gastos_diarios`, `gastos_fijos`, `deudas`, `inversiones` y `historial`, y presenta un resumen claro sin modificar datos.

## Relación con Google Sheets y Confirmación

- **No escribas en Google Sheets** desde este skill: Supabase es la fuente principal y la planilla `finanzas_personales` se sincroniza desde Supabase mediante `Sincronizador_Supabase.js`.
- Tras completar una operación exitosa en Supabase, confirma de forma breve y precisa: **tabla modificada**, **concepto**, **monto**, **método de pago**, **fecha** y si se actualizó el saldo de alguna cuenta.
