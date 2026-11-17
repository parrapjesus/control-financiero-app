/**
 * ==============================================================================
 * CONTROL FINANCIERO PRO - SINCRONIZADOR BIDIRECCIONAL GOOGLE SHEETS <-> SUPABASE
 * ==============================================================================
 * Mejoras incluidas:
 * 1. UPSERT REAL (POST si es nuevo o su UUID no existe en Supabase; PATCH si se editó).
 *    Ya NO ignora filas con UUID si fueron modificadas o si faltan en Supabase.
 * 2. SOPORTE COMPLETO PARA TODAS LAS HOJAS:
 *    - Gastos_Diarios (con ajuste delta de cuenta bancaria sin duplicar descuentos)
 *    - Ingresos / INGRESOS
 *    - Gastos_Fijos (incluye cambio de Pendiente <-> Pagado con ajuste de saldo)
 *    - Tarjetas y Prestamos (incluye Mercado Crédito)
 *    - Inversiones (opcional)
 * 3. SINCRONIZACIÓN AUTOMÁTICA EN TIEMPO REAL:
 *    - Trigger instalable alEditarHoja(e) al editar cualquier celda del Sheet
 *    - Trigger horario + diario 22:00 (sube cambios + descarga estado actualizado)
 *    - LockService para evitar duplicados por ediciones rápidas concurrentes
 * ==============================================================================
 */

var SUPABASE_URL = "https://kqoofxosufvhlsotxwdh.supabase.co";
var SUPABASE_KEY = "sb_publishable_p0w_8FgEhUGP95ZosgAs0w_TK34GghL";

/**
 * Menú superior en Google Sheets
 */
function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('🔄 Control Financiero')
    .addItem('🔄 Sincronizar Todo Ahora (Subir + Bajar)', 'sincronizarConSupabase')
    .addItem('⬆️ Solo Subir Cambios del Sheet a Supabase', 'subirCambiosManual')
    .addItem('📥 Solo Descargar Datos desde Supabase', 'descargarDatosDesdeSupabase')
    .addSeparator()
    .addItem('⚡ Activar Auto-Sync (Al Editar + Cada 1h + 22:00)', 'crearTriggerAutomatico')
    .addItem('🛑 Desactivar Sincronizaciones Automáticas', 'eliminarTriggers')
    .addToUi();
}

// ==============================================================================
// UTILIDADES HTTP SUPABASE
// ==============================================================================

function fetchSupabase(table, params) {
  var url = SUPABASE_URL + "/rest/v1/" + table + (params ? params : "?select=*");
  var options = {
    method: "get",
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": "Bearer " + SUPABASE_KEY,
      "Content-Type": "application/json"
    },
    muteHttpExceptions: true
  };
  var response = UrlFetchApp.fetch(url, options);
  if (response.getResponseCode() >= 200 && response.getResponseCode() < 300) {
    return JSON.parse(response.getContentText());
  }
  throw new Error("Error GET Supabase (" + response.getResponseCode() + "): " + response.getContentText());
}

function postSupabase(table, data) {
  var url = SUPABASE_URL + "/rest/v1/" + table;
  var options = {
    method: "post",
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": "Bearer " + SUPABASE_KEY,
      "Content-Type": "application/json",
      "Prefer": "return=representation"
    },
    payload: JSON.stringify(data),
    muteHttpExceptions: true
  };
  var response = UrlFetchApp.fetch(url, options);
  if (response.getResponseCode() >= 200 && response.getResponseCode() < 300) {
    return JSON.parse(response.getContentText());
  }
  throw new Error("Error POST Supabase (" + response.getResponseCode() + "): " + response.getContentText());
}

function patchSupabase(tableAndParams, data) {
  var url = SUPABASE_URL + "/rest/v1/" + tableAndParams;
  var options = {
    method: "patch",
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": "Bearer " + SUPABASE_KEY,
      "Content-Type": "application/json",
      "Prefer": "return=representation"
    },
    payload: JSON.stringify(data),
    muteHttpExceptions: true
  };
  var response = UrlFetchApp.fetch(url, options);
  if (response.getResponseCode() >= 200 && response.getResponseCode() < 300) {
    return JSON.parse(response.getContentText());
  }
  throw new Error("Error PATCH Supabase (" + response.getResponseCode() + "): " + response.getContentText());
}

// ==============================================================================
// NORMALIZACIÓN Y HELPERS
// ==============================================================================

function esUUIDValido(str) {
  if (!str) return false;
  var uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(String(str).trim());
}

function construirMapaPorId(lista) {
  var mapa = {};
  if (!lista) return mapa;
  for (var i = 0; i < lista.length; i++) {
    if (lista[i] && lista[i].id) {
      mapa[String(lista[i].id).trim().toLowerCase()] = lista[i];
    }
  }
  return mapa;
}

function redondear2(num) {
  return Math.round((parseFloat(num) || 0) * 100) / 100;
}

function esMercadoCredito(item) {
  if (!item) return false;
  var tipo = String(item.tipo || "").toLowerCase().trim();
  var metodo = String(item.metodo || "").toLowerCase().trim();
  return tipo === "mercado_credito" || metodo.indexOf("mercado cr") > -1;
}

function ajustarCuentaSupabase(metodo, delta) {
  var valDelta = redondear2(delta);
  if (!metodo || valDelta === 0) return false;
  try {
    var cuentas = fetchSupabase("ingresos", "?select=id,monto,metodo");
    var met = String(metodo).trim().toLowerCase();
    var candidata = null;
    for (var i = 0; i < cuentas.length; i++) {
      if (String(cuentas[i].metodo || "").trim().toLowerCase() === met) {
        if (!candidata || parseFloat(cuentas[i].monto) > parseFloat(candidata.monto)) {
          candidata = cuentas[i];
        }
      }
    }
    if (!candidata) return false;
    var nuevo = Math.max(0, redondear2(parseFloat(candidata.monto || 0) + valDelta));
    patchSupabase("ingresos?id=eq." + candidata.id, { monto: nuevo });
    return true;
  } catch (e) {
    Logger.log("Error ajustando saldo de cuenta " + metodo + ": " + e.toString());
    return false;
  }
}

function normalizarFechaParaSupabase(fechaVal) {
  if (!fechaVal) {
    var hoy = new Date();
    return hoy.getFullYear() + "-" + ("0" + (hoy.getMonth() + 1)).slice(-2) + "-" + ("0" + hoy.getDate()).slice(-2);
  }
  if (fechaVal instanceof Date) {
    return fechaVal.getFullYear() + "-" + ("0" + (fechaVal.getMonth() + 1)).slice(-2) + "-" + ("0" + fechaVal.getDate()).slice(-2);
  }
  var str = String(fechaVal).trim().split("T")[0].split(" ")[0];
  if (str.indexOf("/") > -1) {
    var parts = str.split("/");
    if (parts.length === 3) {
      if (parts[0].length === 4) {
        return parts[0] + "-" + ("0" + parseInt(parts[1], 10)).slice(-2) + "-" + ("0" + parseInt(parts[2], 10)).slice(-2);
      }
      var d = ("0" + parseInt(parts[0], 10)).slice(-2);
      var m = ("0" + parseInt(parts[1], 10)).slice(-2);
      var y = parts[2].length === 4 ? parts[2] : ("20" + parts[2]);
      return y + "-" + m + "-" + d;
    }
  }
  if (str.indexOf("-") > -1) {
    var partsDash = str.split("-");
    if (partsDash.length === 3 && partsDash[0].length === 4) {
      return str;
    }
    if (partsDash.length === 3 && partsDash[2].length === 4) {
      return partsDash[2] + "-" + ("0" + parseInt(partsDash[1], 10)).slice(-2) + "-" + ("0" + parseInt(partsDash[0], 10)).slice(-2);
    }
  }
  var parsed = new Date(fechaVal);
  if (!isNaN(parsed.getTime()) && parsed.getFullYear() > 2000) {
    return parsed.getFullYear() + "-" + ("0" + (parsed.getMonth() + 1)).slice(-2) + "-" + ("0" + parsed.getDate()).slice(-2);
  }
  return str;
}

function formatearFecha(fechaStr) {
  if (!fechaStr) return "";
  var parts = String(fechaStr).split("T")[0].split("-");
  if (parts.length === 3) {
    return parts[2] + "/" + parts[1] + "/" + parts[0];
  }
  return String(fechaStr);
}

function limpiarMonto(montoVal) {
  if (typeof montoVal === "number") return Math.abs(redondear2(montoVal));
  if (!montoVal) return 0;
  var str = String(montoVal).replace(/[^0-9.,-]/g, "").trim();
  if (str.indexOf(",") > -1 && str.indexOf(".") > -1) {
    if (str.lastIndexOf(",") > str.lastIndexOf(".")) {
      str = str.replace(/\./g, "").replace(",", ".");
    } else {
      str = str.replace(/,/g, "");
    }
  } else if (str.indexOf(",") > -1) {
    var afterComma = str.split(",").pop();
    str = afterComma.length === 3 && str.indexOf(".") === -1 ? str.replace(/,/g, "") : str.replace(",", ".");
  } else if (str.indexOf(".") > -1) {
    var dotParts = str.split(".");
    if (dotParts.length > 2 || (dotParts.length === 2 && dotParts[1].length === 3)) {
      str = str.replace(/\./g, "");
    }
  }
  var num = parseFloat(str);
  return isNaN(num) ? 0 : Math.abs(redondear2(num));
}

function normalizarMetodoPago(metodoStr) {
  if (!metodoStr) return "General";
  var m = String(metodoStr).toLowerCase().trim();
  if (m.indexOf("arq") > -1) return "ARQ";
  if (m.indexOf("santander") > -1) return "Santander";
  if (m.indexOf("bhd") > -1) return "BHD";
  if (m.indexOf("brubank") > -1) return "brubank";
  if (m.indexOf("mercado pago") > -1 || m === "mp") return "Mercado Pago";
  if (m.indexOf("mercado cr") > -1) return "Mercado Crédito";
  if (m.indexOf("efectivo") > -1) return "Efectivo";
  if (m.indexOf("transfer") > -1) return "Transferencia";
  if (m === "tdc" || m.indexOf("tarjeta") > -1) return "TDC";
  return String(metodoStr).trim();
}

function buscarServicioFijo(descripcion, listaFijos) {
  if (!descripcion || !listaFijos || listaFijos.length === 0) return null;
  var d = descripcion.toLowerCase().trim();
  for (var i = 0; i < listaFijos.length; i++) {
    var s = listaFijos[i];
    if (s.estado === "Pagado") continue;
    var nom = (s.servicio || "").toLowerCase().trim();
    if (!nom) continue;
    if (d.indexOf(nom) > -1 || nom.indexOf(d) > -1) return s;
    if (nom.indexOf("youtube") > -1 && d.indexOf("youtube") > -1) return s;
    if (nom.indexOf("adobe") > -1 && d.indexOf("adobe") > -1) return s;
    if (nom.indexOf("google") > -1 && (d.indexOf("google") > -1 || d.indexOf("gsuite") > -1 || d.indexOf("one") > -1)) return s;
    if ((nom.indexOf("internet") > -1 || nom.indexOf("tlf") > -1) &&
        (d.indexOf("internet") > -1 || d.indexOf("fibertel") > -1 || d.indexOf("telecom") > -1 || d.indexOf("flow") > -1 || d.indexOf("telecentro") > -1 || d.indexOf("claro") > -1)) {
      return s;
    }
    if ((nom.indexOf("edenor") > -1 || nom.indexOf("luz") > -1) && (d.indexOf("edenor") > -1 || d.indexOf("edesur") > -1 || d.indexOf("luz") > -1)) return s;
    if (nom.indexOf("sancor") > -1 && (d.indexOf("sancor") > -1 || d.indexOf("salud") > -1)) return s;
    if (nom.indexOf("expensas") > -1 && d.indexOf("expensas") > -1) return s;
    if (nom.indexOf("municip") > -1 && d.indexOf("municip") > -1) return s;
  }
  return null;
}

function obtenerHojaPorNombres(ss, nombres) {
  for (var i = 0; i < nombres.length; i++) {
    var h = ss.getSheetByName(nombres[i]);
    if (h) return h;
  }
  return null;
}

function obtenerOCrearHoja(ss, nombre, encabezados) {
  var hoja = ss.getSheetByName(nombre);
  if (!hoja) {
    hoja = ss.insertSheet(nombre);
  }
  if (encabezados && encabezados.length > 0) {
    hoja.getRange(1, 1, 1, encabezados.length).setValues([encabezados]);
    hoja.getRange(1, 1, 1, encabezados.length).setFontWeight("bold").setBackground("#1E293B").setFontColor("#FFFFFF");
  }
  return hoja;
}

function limpiarDatosHoja(hoja) {
  var lastRow = hoja.getLastRow();
  var lastCol = hoja.getLastColumn();
  if (lastRow > 1 && lastCol > 0) {
    hoja.getRange(2, 1, lastRow - 1, lastCol).clearContent();
  }
}

// ==============================================================================
// 1. UPSERT GASTOS DIARIOS (Sheets -> Supabase)
// ==============================================================================

function subirNuevosGastosASupabase() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var hoja = obtenerHojaPorNombres(ss, ["Gastos_Diarios", "Gastos Diarios", "GASTOS_DIARIOS", "gastos_diarios"]);
  if (!hoja) return { subidos: 0, actualizados: 0 };

  var lastRow = hoja.getLastRow();
  if (lastRow < 2) return { subidos: 0, actualizados: 0 };

  if (hoja.getLastColumn() < 5) {
    hoja.insertColumnsAfter(hoja.getLastColumn(), 5 - hoja.getLastColumn());
  }

  var diariosSupa = fetchSupabase("gastos_diarios", "?select=*");
  var mapaDiarios = construirMapaPorId(diariosSupa);

  var listaFijos = [];
  try {
    listaFijos = fetchSupabase("gastos_fijos", "?select=*");
  } catch (eFijos) {
    Logger.log("Aviso: no se pudo cargar lista de fijos: " + eFijos.toString());
  }

  var datos = hoja.getRange(2, 1, lastRow - 1, 5).getValues();
  var subidos = 0;
  var actualizados = 0;

  for (var i = 0; i < datos.length; i++) {
    var fila = datos[i];
    var idActual = String(fila[0] || "").trim();
    var descripcion = String(fila[1] || "").trim();
    var monto = limpiarMonto(fila[2]);
    var fechaIso = normalizarFechaParaSupabase(fila[3]);
    var metodo = normalizarMetodoPago(fila[4]);

    if (idActual.indexOf("FIJO-") === 0 || descripcion === "" || monto <= 0) continue;

    var idKey = idActual.toLowerCase();
    var existente = esUUIDValido(idActual) ? mapaDiarios[idKey] : null;

    if (!existente) {
      // Fila nueva (sin UUID o cuyo UUID no existe todavía en Supabase)
      var servicioFijo = !esUUIDValido(idActual) ? buscarServicioFijo(descripcion, listaFijos) : null;

      if (servicioFijo) {
        try {
          patchSupabase("gastos_fijos?id=eq." + servicioFijo.id, {
            estado: "Pagado",
            fecha_pago: fechaIso,
            metodo_pago: metodo,
            monto: monto
          });
          ajustarCuentaSupabase(metodo, -monto);
          try {
            var detalleHist = servicioFijo.servicio + (descripcion.toLowerCase() !== servicioFijo.servicio.toLowerCase() ? " (" + descripcion + ")" : "");
            postSupabase("historial", [{ categoria: "Servicio Pagado", descripcion: detalleHist, monto: monto, metodo: metodo }]);
          } catch (eHist) {}

          hoja.getRange(i + 2, 1).setValue("FIJO-" + servicioFijo.id);
          hoja.getRange(i + 2, 4).setValue(formatearFecha(fechaIso));
          hoja.getRange(i + 2, 5).setValue(metodo);
          servicioFijo.estado = "Pagado";
          subidos++;
        } catch (errFijo) {
          Logger.log("Error actualizando servicio fijo desde Gastos_Diarios: " + errFijo.toString());
        }
      } else {
        try {
          var payloadNuevo = {
            descripcion: descripcion,
            monto: monto,
            metodo: metodo,
            fecha: fechaIso
          };
          if (esUUIDValido(idActual)) {
            payloadNuevo.id = idActual;
          }
          var resp = postSupabase("gastos_diarios", [payloadNuevo]);
          if (resp && resp.length > 0 && resp[0].id) {
            hoja.getRange(i + 2, 1).setValue(resp[0].id);
            hoja.getRange(i + 2, 4).setValue(formatearFecha(fechaIso));
            hoja.getRange(i + 2, 5).setValue(metodo);
            mapaDiarios[String(resp[0].id).toLowerCase()] = resp[0];
            subidos++;

            ajustarCuentaSupabase(metodo, -monto);
            try {
              postSupabase("historial", [{ categoria: "Gasto Diario", descripcion: descripcion, monto: monto, metodo: metodo }]);
            } catch (eHist2) {}
          }
        } catch (err) {
          Logger.log("Error insertando gasto diario fila " + (i + 2) + ": " + err.toString());
        }
      }
    } else {
      // Fila existente en Supabase: verificar si hubo cambios para hacer PATCH + ajuste delta
      var descAnt = String(existente.descripcion || "").trim();
      var montoAnt = redondear2(existente.monto);
      var fechaAnt = normalizarFechaParaSupabase(existente.fecha);
      var metodoAnt = normalizarMetodoPago(existente.metodo);

      if (descAnt !== descripcion || montoAnt !== monto || fechaAnt !== fechaIso || metodoAnt !== metodo) {
        try {
          patchSupabase("gastos_diarios?id=eq." + existente.id, {
            descripcion: descripcion,
            monto: monto,
            fecha: fechaIso,
            metodo: metodo
          });
          if (metodoAnt.toLowerCase() === metodo.toLowerCase()) {
            var delta = redondear2(montoAnt - monto);
            if (delta !== 0) ajustarCuentaSupabase(metodo, delta);
          } else {
            ajustarCuentaSupabase(metodoAnt, montoAnt);
            ajustarCuentaSupabase(metodo, -monto);
          }
          hoja.getRange(i + 2, 4).setValue(formatearFecha(fechaIso));
          hoja.getRange(i + 2, 5).setValue(metodo);
          actualizados++;
        } catch (errPatch) {
          Logger.log("Error actualizando gasto diario fila " + (i + 2) + ": " + errPatch.toString());
        }
      }
    }
  }

  return { subidos: subidos, actualizados: actualizados };
}

// ==============================================================================
// 2. UPSERT INGRESOS (Sheets -> Supabase)
// ==============================================================================

function subirNuevosIngresosASupabase() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var hoja = obtenerHojaPorNombres(ss, ["INGRESOS", "Ingresos", "ingresos"]);
  if (!hoja) return { subidos: 0, actualizados: 0 };

  var lastRow = hoja.getLastRow();
  if (lastRow < 2) return { subidos: 0, actualizados: 0 };

  if (hoja.getLastColumn() < 5) {
    hoja.insertColumnsAfter(hoja.getLastColumn(), 5 - hoja.getLastColumn());
  }

  var ingresosSupa = fetchSupabase("ingresos", "?select=*");
  var mapaIngresos = construirMapaPorId(ingresosSupa);

  var datos = hoja.getRange(2, 1, lastRow - 1, 5).getValues();
  var subidos = 0;
  var actualizados = 0;

  for (var i = 0; i < datos.length; i++) {
    var fila = datos[i];
    var idActual = String(fila[0] || "").trim();
    var descripcion = String(fila[1] || "").trim();
    var monto = limpiarMonto(fila[2]);
    var fechaIso = normalizarFechaParaSupabase(fila[3]);
    var metodo = normalizarMetodoPago(fila[4]);

    if (descripcion === "" || monto < 0) continue;
    // Ignorar filas totalmente vacías en monto salvo actualización explícita a 0 de una cuenta existente
    var existente = esUUIDValido(idActual) ? mapaIngresos[idActual.toLowerCase()] : null;
    if (!existente && monto <= 0) continue;

    if (!existente) {
      try {
        var payload = { descripcion: descripcion, monto: monto, metodo: metodo, fecha: fechaIso };
        if (esUUIDValido(idActual)) payload.id = idActual;
        var resp = postSupabase("ingresos", [payload]);
        if (resp && resp.length > 0 && resp[0].id) {
          hoja.getRange(i + 2, 1).setValue(resp[0].id);
          hoja.getRange(i + 2, 4).setValue(formatearFecha(fechaIso));
          hoja.getRange(i + 2, 5).setValue(metodo);
          mapaIngresos[String(resp[0].id).toLowerCase()] = resp[0];
          subidos++;
          try {
            postSupabase("historial", [{ categoria: "Ingreso", descripcion: descripcion, monto: monto, metodo: metodo }]);
          } catch (eHist) {}
        }
      } catch (err) {
        Logger.log("Error insertando ingreso fila " + (i + 2) + ": " + err.toString());
      }
    } else {
      var descAnt = String(existente.descripcion || "").trim();
      var montoAnt = redondear2(existente.monto);
      var fechaAnt = normalizarFechaParaSupabase(existente.fecha);
      var metodoAnt = normalizarMetodoPago(existente.metodo);

      if (descAnt !== descripcion || montoAnt !== monto || fechaAnt !== fechaIso || metodoAnt !== metodo) {
        try {
          patchSupabase("ingresos?id=eq." + existente.id, {
            descripcion: descripcion,
            monto: monto,
            fecha: fechaIso,
            metodo: metodo
          });
          hoja.getRange(i + 2, 4).setValue(formatearFecha(fechaIso));
          hoja.getRange(i + 2, 5).setValue(metodo);
          actualizados++;
        } catch (errPatch) {
          Logger.log("Error actualizando ingreso fila " + (i + 2) + ": " + errPatch.toString());
        }
      }
    }
  }

  return { subidos: subidos, actualizados: actualizados };
}

// ==============================================================================
// 3. UPSERT GASTOS FIJOS (Sheets -> Supabase)
// ==============================================================================

function subirGastosFijosASupabase() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var hoja = obtenerHojaPorNombres(ss, ["Gastos_Fijos", "Gastos Fijos", "GASTOS_FIJOS", "gastos_fijos"]);
  if (!hoja) return { subidos: 0, actualizados: 0 };

  var lastRow = hoja.getLastRow();
  if (lastRow < 2) return { subidos: 0, actualizados: 0 };

  if (hoja.getLastColumn() < 7) {
    hoja.insertColumnsAfter(hoja.getLastColumn(), 7 - hoja.getLastColumn());
  }

  var fijosSupa = fetchSupabase("gastos_fijos", "?select=*");
  var mapaFijos = construirMapaPorId(fijosSupa);

  var datos = hoja.getRange(2, 1, lastRow - 1, 7).getValues();
  var subidos = 0;
  var actualizados = 0;

  for (var i = 0; i < datos.length; i++) {
    var fila = datos[i];
    var idActual = String(fila[0] || "").trim();
    var servicio = String(fila[1] || "").trim();
    var monto = limpiarMonto(fila[2]);
    var vencimiento = Math.max(1, Math.min(31, parseInt(fila[3], 10) || 10));
    var estadoRaw = String(fila[4] || "Pendiente").toLowerCase().trim();
    var estado = estadoRaw.indexOf("pagad") > -1 ? "Pagado" : "Pendiente";
    var fechaPago = fila[5] ? normalizarFechaParaSupabase(fila[5]) : (estado === "Pagado" ? normalizarFechaParaSupabase(new Date()) : null);
    var metodoPago = fila[6] ? normalizarMetodoPago(fila[6]) : (estado === "Pagado" ? "General" : null);

    if (servicio === "" || monto <= 0) continue;

    var existente = esUUIDValido(idActual) ? mapaFijos[idActual.toLowerCase()] : null;

    if (!existente) {
      try {
        var payload = {
          servicio: servicio,
          monto: monto,
          vencimiento: vencimiento,
          estado: estado,
          fecha_pago: estado === "Pagado" ? fechaPago : null,
          metodo_pago: estado === "Pagado" ? metodoPago : null
        };
        if (esUUIDValido(idActual)) payload.id = idActual;
        var resp = postSupabase("gastos_fijos", [payload]);
        if (resp && resp.length > 0 && resp[0].id) {
          hoja.getRange(i + 2, 1).setValue(resp[0].id);
          mapaFijos[String(resp[0].id).toLowerCase()] = resp[0];
          subidos++;
          if (estado === "Pagado" && metodoPago) {
            ajustarCuentaSupabase(metodoPago, -monto);
            try {
              postSupabase("historial", [{ categoria: "Servicio Pagado", descripcion: servicio, monto: monto, metodo: metodoPago }]);
            } catch (eHist) {}
          }
        }
      } catch (err) {
        Logger.log("Error insertando gasto fijo fila " + (i + 2) + ": " + err.toString());
      }
    } else {
      var servAnt = String(existente.servicio || "").trim();
      var montoAnt = redondear2(existente.monto);
      var vencAnt = parseInt(existente.vencimiento, 10) || 10;
      var estadoAnt = String(existente.estado || "Pendiente").trim();
      var fechaAnt = existente.fecha_pago ? normalizarFechaParaSupabase(existente.fecha_pago) : null;
      var metodoAnt = existente.metodo_pago ? normalizarMetodoPago(existente.metodo_pago) : null;

      if (servAnt !== servicio || montoAnt !== monto || vencAnt !== vencimiento || estadoAnt !== estado || fechaAnt !== fechaPago || metodoAnt !== metodoPago) {
        try {
          patchSupabase("gastos_fijos?id=eq." + existente.id, {
            servicio: servicio,
            monto: monto,
            vencimiento: vencimiento,
            estado: estado,
            fecha_pago: estado === "Pagado" ? fechaPago : null,
            metodo_pago: estado === "Pagado" ? metodoPago : null
          });

          if (estadoAnt !== "Pagado" && estado === "Pagado") {
            var bancoPago = metodoPago || "General";
            ajustarCuentaSupabase(bancoPago, -monto);
            hoja.getRange(i + 2, 6).setValue(formatearFecha(fechaPago));
            hoja.getRange(i + 2, 7).setValue(bancoPago);
            try {
              postSupabase("historial", [{ categoria: "Servicio Pagado", descripcion: servicio, monto: monto, metodo: bancoPago }]);
            } catch (eHist2) {}
          } else if (estadoAnt === "Pagado" && estado !== "Pagado") {
            if (metodoAnt) ajustarCuentaSupabase(metodoAnt, montoAnt);
            hoja.getRange(i + 2, 6).setValue("");
            hoja.getRange(i + 2, 7).setValue("");
            try {
              postSupabase("historial", [{ categoria: "Reverso Servicio", descripcion: servicio, monto: -montoAnt, metodo: metodoAnt || "General" }]);
            } catch (eHist3) {}
          }

          actualizados++;
        } catch (errPatch) {
          Logger.log("Error actualizando gasto fijo fila " + (i + 2) + ": " + errPatch.toString());
        }
      }
    }
  }

  return { subidos: subidos, actualizados: actualizados };
}

// ==============================================================================
// 4. UPSERT DEUDAS: TARJETAS, MERCADO CRÉDITO Y PRÉSTAMOS (Sheets -> Supabase)
// ==============================================================================

function subirHojaDeudasASupabase(hoja, tipoPorDefecto, mapaDeudas) {
  if (!hoja) return { subidos: 0, actualizados: 0 };
  var lastRow = hoja.getLastRow();
  if (lastRow < 2) return { subidos: 0, actualizados: 0 };

  var numCols = Math.max(hoja.getLastColumn(), 8);
  var datos = hoja.getRange(2, 1, lastRow - 1, numCols).getValues();
  var subidos = 0;
  var actualizados = 0;

  // Detectar si la columna 8 quedó vacía en el encabezado ("") y Metodo está en col 9
  var headers = hoja.getRange(1, 1, 1, numCols).getValues()[0];
  var colMetodoIdx = 7;
  for (var c = 0; c < headers.length; c++) {
    if (String(headers[c] || "").toLowerCase().trim() === "metodo") {
      colMetodoIdx = c;
      break;
    }
  }

  for (var i = 0; i < datos.length; i++) {
    var fila = datos[i];
    var idActual = String(fila[0] || "").trim();
    var nombre = String(fila[1] || "").trim();
    var montoTotal = limpiarMonto(fila[2]);
    var cuotasTotales = Math.max(1, parseInt(fila[3], 10) || 1);
    var cuotasPagadas = Math.max(0, parseInt(fila[4], 10) || 0);
    var montoCuota = limpiarMonto(fila[5]) || redondear2(montoTotal / cuotasTotales);
    var fechaInicio = normalizarFechaParaSupabase(fila[6]);
    var metodoRaw = fila[colMetodoIdx] || fila[7] || fila[8] || (tipoPorDefecto === "tarjeta" ? "TDC" : "General");
    var metodo = normalizarMetodoPago(metodoRaw);

    if (nombre === "" || (montoTotal <= 0 && montoCuota <= 0)) continue;
    if (montoTotal <= 0 && montoCuota > 0) montoTotal = redondear2(montoCuota * cuotasTotales);

    var tipoCalculado = tipoPorDefecto;
    if (metodo.toLowerCase().indexOf("mercado cr") > -1) {
      tipoCalculado = "mercado_credito";
    }

    var existente = esUUIDValido(idActual) ? mapaDeudas[idActual.toLowerCase()] : null;

    if (!existente) {
      var payload = {
        tipo: tipoCalculado,
        nombre: nombre,
        monto_total: montoTotal,
        cuotas_totales: cuotasTotales,
        cuotas_pagadas: cuotasPagadas,
        monto_cuota: montoCuota,
        fecha_inicio: fechaInicio,
        metodo: metodo
      };
      if (esUUIDValido(idActual)) payload.id = idActual;

      try {
        var resp;
        try {
          resp = postSupabase("deudas", [payload]);
        } catch (errCheck) {
          if (tipoCalculado === "mercado_credito") {
            payload.tipo = "prestamo";
            resp = postSupabase("deudas", [payload]);
          } else {
            throw errCheck;
          }
        }
        if (resp && resp.length > 0 && resp[0].id) {
          hoja.getRange(i + 2, 1).setValue(resp[0].id);
          hoja.getRange(i + 2, 7).setValue(formatearFecha(fechaInicio));
          mapaDeudas[String(resp[0].id).toLowerCase()] = resp[0];
          subidos++;
        }
      } catch (err) {
        Logger.log("Error insertando deuda fila " + (i + 2) + ": " + err.toString());
      }
    } else {
      var nombreAnt = String(existente.nombre || "").trim();
      var totalAnt = redondear2(existente.monto_total);
      var totCuotasAnt = parseInt(existente.cuotas_totales, 10) || 1;
      var pagCuotasAnt = parseInt(existente.cuotas_pagadas, 10) || 0;
      var cuotaAnt = redondear2(existente.monto_cuota);
      var fechaAnt = normalizarFechaParaSupabase(existente.fecha_inicio);
      var metodoAnt = normalizarMetodoPago(existente.metodo);

      if (
        nombreAnt !== nombre ||
        totalAnt !== montoTotal ||
        totCuotasAnt !== cuotasTotales ||
        pagCuotasAnt !== cuotasPagadas ||
        cuotaAnt !== montoCuota ||
        fechaAnt !== fechaInicio ||
        metodoAnt !== metodo
      ) {
        try {
          var patchData = {
            nombre: nombre,
            monto_total: montoTotal,
            cuotas_totales: cuotasTotales,
            cuotas_pagadas: cuotasPagadas,
            monto_cuota: montoCuota,
            fecha_inicio: fechaInicio,
            metodo: metodo
          };
          patchSupabase("deudas?id=eq." + existente.id, patchData);
          actualizados++;
        } catch (errPatch) {
          Logger.log("Error actualizando deuda fila " + (i + 2) + ": " + errPatch.toString());
        }
      }
    }
  }

  return { subidos: subidos, actualizados: actualizados };
}

function subirDeudasASupabase() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var deudasSupa = fetchSupabase("deudas", "?select=*");
  var mapaDeudas = construirMapaPorId(deudasSupa);

  var rTarj = subirHojaDeudasASupabase(
    obtenerHojaPorNombres(ss, ["Tarjetas", "TARJETAS", "tarjetas"]),
    "tarjeta",
    mapaDeudas
  );
  var rPrest = subirHojaDeudasASupabase(
    obtenerHojaPorNombres(ss, ["Prestamos", "Préstamos", "PRESTAMOS", "prestamos"]),
    "prestamo",
    mapaDeudas
  );
  var rMC = subirHojaDeudasASupabase(
    obtenerHojaPorNombres(ss, ["Mercado_Credito", "Mercado Credito", "Mercado Crédito"]),
    "mercado_credito",
    mapaDeudas
  );

  return {
    subidos: rTarj.subidos + rPrest.subidos + rMC.subidos,
    actualizados: rTarj.actualizados + rPrest.actualizados + rMC.actualizados
  };
}

// ==============================================================================
// 5. UPSERT INVERSIONES (Opcional: Sheets -> Supabase)
// ==============================================================================

function subirNuevasInversionesASupabase() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var hoja = obtenerHojaPorNombres(ss, ["Inversiones", "INVERSIONES", "inversiones"]);
  if (!hoja) return { subidos: 0, actualizados: 0 };

  var lastRow = hoja.getLastRow();
  if (lastRow < 2) return { subidos: 0, actualizados: 0 };

  var invSupa = [];
  try {
    invSupa = fetchSupabase("inversiones", "?select=*");
  } catch (e) {
    return { subidos: 0, actualizados: 0 };
  }
  var mapaInv = construirMapaPorId(invSupa);

  var datos = hoja.getRange(2, 1, lastRow - 1, Math.max(hoja.getLastColumn(), 9)).getValues();
  var subidos = 0;
  var actualizados = 0;

  for (var i = 0; i < datos.length; i++) {
    var id = String(datos[i][0] || "").trim();
    var nombre = String(datos[i][1] || "").trim();
    var tipo = String(datos[i][2] || "Renta Fija").trim();
    var plataforma = String(datos[i][3] || "General").trim();
    var invertido = limpiarMonto(datos[i][4]);
    var actual = limpiarMonto(datos[i][5]) || invertido;
    var moneda = String(datos[i][6] || "ARS").trim();
    var fechaStr = normalizarFechaParaSupabase(datos[i][7]);
    var notas = String(datos[i][8] || "").trim();

    if (nombre === "" || invertido <= 0) continue;

    var rend = invertido > 0 ? Math.round(((actual - invertido) / invertido) * 1000) / 10 : 0;
    var existente = esUUIDValido(id) ? mapaInv[id.toLowerCase()] : null;

    if (!existente) {
      try {
        var payload = {
          nombre: nombre,
          tipo: tipo,
          plataforma: plataforma,
          monto_invertido: invertido,
          valor_actual: actual,
          moneda: moneda,
          rendimiento_pct: rend,
          fecha: fechaStr,
          notas: notas
        };
        if (esUUIDValido(id)) payload.id = id;
        var res = postSupabase("inversiones", [payload]);
        if (res && res.length > 0 && res[0].id) {
          hoja.getRange(i + 2, 1).setValue(res[0].id);
          subidos++;
        }
      } catch (ePost) {}
    } else {
      if (
        String(existente.nombre || "").trim() !== nombre ||
        String(existente.tipo || "Renta Fija").trim() !== tipo ||
        String(existente.plataforma || "General").trim() !== plataforma ||
        redondear2(existente.monto_invertido) !== invertido ||
        redondear2(existente.valor_actual) !== actual ||
        String(existente.moneda || "ARS").trim() !== moneda ||
        normalizarFechaParaSupabase(existente.fecha) !== fechaStr ||
        String(existente.notas || "").trim() !== notas
      ) {
        try {
          patchSupabase("inversiones?id=eq." + existente.id, {
            nombre: nombre,
            tipo: tipo,
            plataforma: plataforma,
            monto_invertido: invertido,
            valor_actual: actual,
            moneda: moneda,
            rendimiento_pct: rend,
            fecha: fechaStr,
            notas: notas
          });
          actualizados++;
        } catch (ePatch) {}
      }
    }
  }

  return { subidos: subidos, actualizados: actualizados };
}

// ==============================================================================
// 6. DESCARGAR DATOS DESDE SUPABASE (Supabase -> Sheets)
// ==============================================================================

function descargarDatosDesdeSupabase() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1. Ingresos
  var ingresos = fetchSupabase("ingresos", "?select=*&order=fecha.desc");
  var hojaIngresos = obtenerOCrearHoja(ss, "INGRESOS", ["ID", "Descripción", "Monto", "Fecha", "Metodo"]);
  limpiarDatosHoja(hojaIngresos);
  if (ingresos && ingresos.length > 0) {
    var filasIngresos = ingresos.map(function(item) {
      return [item.id || "", item.descripcion || "", parseFloat(item.monto) || 0, formatearFecha(item.fecha), item.metodo || "General"];
    });
    hojaIngresos.getRange(2, 1, filasIngresos.length, 5).setValues(filasIngresos);
    hojaIngresos.getRange(2, 3, filasIngresos.length, 1).setNumberFormat("$#,##0");
  }

  // 2. Gastos Diarios
  var diarios = fetchSupabase("gastos_diarios", "?select=*&order=fecha.desc");
  var hojaDiarios = obtenerOCrearHoja(ss, "Gastos_Diarios", ["ID", "Descripción", "Monto", "Fecha", "Metodo"]);
  limpiarDatosHoja(hojaDiarios);
  if (diarios && diarios.length > 0) {
    var filasDiarios = diarios.map(function(item) {
      return [item.id || "", item.descripcion || "", parseFloat(item.monto) || 0, formatearFecha(item.fecha), item.metodo || "General"];
    });
    hojaDiarios.getRange(2, 1, filasDiarios.length, 5).setValues(filasDiarios);
    hojaDiarios.getRange(2, 3, filasDiarios.length, 1).setNumberFormat("$#,##0");
  }

  // 3. Gastos Fijos
  var fijos = fetchSupabase("gastos_fijos", "?select=*&order=vencimiento.asc");
  var hojaFijos = obtenerOCrearHoja(ss, "Gastos_Fijos", ["ID", "Servicio", "Monto", "Vencimiento", "Estado", "Fecha_Pago", "Metodo"]);
  limpiarDatosHoja(hojaFijos);
  if (fijos && fijos.length > 0) {
    var filasFijos = fijos.map(function(item) {
      return [
        item.id || "",
        item.servicio || "",
        parseFloat(item.monto) || 0,
        parseInt(item.vencimiento, 10) || 10,
        item.estado || "Pendiente",
        formatearFecha(item.fecha_pago),
        item.metodo_pago || ""
      ];
    });
    hojaFijos.getRange(2, 1, filasFijos.length, 7).setValues(filasFijos);
    hojaFijos.getRange(2, 3, filasFijos.length, 1).setNumberFormat("$#,##0");
  }

  // 4. Deudas (Tarjetas, Mercado Crédito y Préstamos)
  var deudas = fetchSupabase("deudas", "?select=*&order=created_at.desc");
  var tarjetas = (deudas || []).filter(function(d) { return d.tipo === "tarjeta" && !esMercadoCredito(d); });
  var prestamos = (deudas || []).filter(function(d) { return d.tipo !== "tarjeta" || esMercadoCredito(d); });

  var hojaTarjetas = obtenerOCrearHoja(ss, "Tarjetas", ["ID", "Compra", "Monto_Total", "Cuotas_Totales", "Cuotas_Pagadas", "Monto_Cuota", "Fecha_Inicio", "Metodo"]);
  limpiarDatosHoja(hojaTarjetas);
  if (tarjetas.length > 0) {
    var filasTarjetas = tarjetas.map(function(item) {
      return [item.id || "", item.nombre || "", parseFloat(item.monto_total) || 0, item.cuotas_totales || 1, item.cuotas_pagadas || 0, parseFloat(item.monto_cuota) || 0, formatearFecha(item.fecha_inicio), item.metodo || "TDC"];
    });
    hojaTarjetas.getRange(2, 1, filasTarjetas.length, 8).setValues(filasTarjetas);
    hojaTarjetas.getRange(2, 3, filasTarjetas.length, 1).setNumberFormat("$#,##0");
    hojaTarjetas.getRange(2, 6, filasTarjetas.length, 1).setNumberFormat("$#,##0");
  }

  var hojaPrestamos = obtenerOCrearHoja(ss, "Prestamos", ["ID", "Prestamo", "Monto_Total", "Cuotas_Totales", "Cuotas_Pagadas", "Monto_Cuota", "Fecha_Inicio", "Metodo"]);
  limpiarDatosHoja(hojaPrestamos);
  if (hojaPrestamos.getLastColumn() > 8) {
    hojaPrestamos.getRange(1, 9, Math.max(1, hojaPrestamos.getLastRow()), hojaPrestamos.getLastColumn() - 8).clearContent();
  }
  if (prestamos.length > 0) {
    var filasPrestamos = prestamos.map(function(item) {
      return [item.id || "", item.nombre || "", parseFloat(item.monto_total) || 0, item.cuotas_totales || 1, item.cuotas_pagadas || 0, parseFloat(item.monto_cuota) || 0, formatearFecha(item.fecha_inicio), item.metodo || "General"];
    });
    hojaPrestamos.getRange(2, 1, filasPrestamos.length, 8).setValues(filasPrestamos);
    hojaPrestamos.getRange(2, 3, filasPrestamos.length, 1).setNumberFormat("$#,##0");
    hojaPrestamos.getRange(2, 6, filasPrestamos.length, 1).setNumberFormat("$#,##0");
  }

  // 5. Historial
  var historial = fetchSupabase("historial", "?select=*&order=fecha.desc&limit=300");
  var hojaHistorial = obtenerOCrearHoja(ss, "Historial", ["ID", "Fecha", "Categoria", "Descripcion", "Monto", "Metodo"]);
  limpiarDatosHoja(hojaHistorial);
  if (historial && historial.length > 0) {
    var filasHistorial = historial.map(function(item) {
      return [item.id || "", formatearFecha(item.fecha), item.categoria || "", item.descripcion || "", parseFloat(item.monto) || 0, item.metodo || "General"];
    });
    hojaHistorial.getRange(2, 1, filasHistorial.length, 6).setValues(filasHistorial);
    hojaHistorial.getRange(2, 5, filasHistorial.length, 1).setNumberFormat("$#,##0");
  }

  // 6. Métodos de Pago
  var metodos = fetchSupabase("metodos_pago", "?select=*");
  var hojaMetodos = obtenerOCrearHoja(ss, "Metodos_Pago", ["ID", "Metodo"]);
  limpiarDatosHoja(hojaMetodos);
  if (metodos && metodos.length > 0) {
    var filasMetodos = metodos.map(function(item) { return [item.id || "", item.nombre || ""]; });
    hojaMetodos.getRange(2, 1, filasMetodos.length, 2).setValues(filasMetodos);
  }

  // 7. Inversiones (Opcional)
  var inversionesCount = 0;
  try {
    var inversiones = fetchSupabase("inversiones", "?select=*&order=created_at.desc");
    var hojaInv = obtenerOCrearHoja(ss, "Inversiones", ["ID", "Nombre", "Tipo", "Plataforma", "Monto_Invertido", "Valor_Actual", "Moneda", "Fecha", "Notas"]);
    limpiarDatosHoja(hojaInv);
    if (inversiones && inversiones.length > 0) {
      inversionesCount = inversiones.length;
      var filasInv = inversiones.map(function(item) {
        return [item.id || "", item.nombre || "", item.tipo || "Renta Fija", item.plataforma || "General", parseFloat(item.monto_invertido) || 0, parseFloat(item.valor_actual) || 0, item.moneda || "ARS", formatearFecha(item.fecha), item.notas || ""];
      });
      hojaInv.getRange(2, 1, filasInv.length, 9).setValues(filasInv);
      hojaInv.getRange(2, 5, filasInv.length, 2).setNumberFormat("$#,##0");
    }
  } catch (eInv) {}

  return {
    ingresos: ingresos ? ingresos.length : 0,
    gastosDiarios: diarios ? diarios.length : 0,
    gastosFijos: fijos ? fijos.length : 0,
    tarjetas: tarjetas.length,
    prestamos: prestamos.length,
    historial: historial ? historial.length : 0,
    metodos: metodos ? metodos.length : 0,
    inversiones: inversionesCount
  };
}

// ==============================================================================
// 7. ORQUESTACIÓN BIDIRECCIONAL, TRIGGERS Y WEB APP
// ==============================================================================

function ejecutarSincronizacionCompleta(opciones) {
  var opts = opciones || {};
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    return { ok: false, error: "Otra sincronización está en curso. Intenta en unos segundos." };
  }

  try {
    var hojaSolo = opts.hojaSolo ? String(opts.hojaSolo).toLowerCase() : null;
    var rG = { subidos: 0, actualizados: 0 };
    var rI = { subidos: 0, actualizados: 0 };
    var rF = { subidos: 0, actualizados: 0 };
    var rD = { subidos: 0, actualizados: 0 };
    var rInv = { subidos: 0, actualizados: 0 };

    if (!hojaSolo || hojaSolo.indexOf("diario") > -1) {
      rG = subirNuevosGastosASupabase();
    }
    if (!hojaSolo || hojaSolo.indexOf("ingreso") > -1) {
      rI = subirNuevosIngresosASupabase();
    }
    if (!hojaSolo || hojaSolo.indexOf("fijo") > -1) {
      rF = subirGastosFijosASupabase();
    }
    if (!hojaSolo || hojaSolo.indexOf("tarjeta") > -1 || hojaSolo.indexOf("prestam") > -1 || hojaSolo.indexOf("mercado") > -1) {
      rD = subirDeudasASupabase();
    }
    if (!hojaSolo || hojaSolo.indexOf("invers") > -1) {
      try { rInv = subirNuevasInversionesASupabase(); } catch (eInv) {}
    }

    var descargado = null;
    if (opts.descargarAlFinal !== false) {
      descargado = descargarDatosDesdeSupabase();
    }

    var subidosTotal = rG.subidos + rI.subidos + rF.subidos + rD.subidos + rInv.subidos;
    var actualizadosTotal = rG.actualizados + rI.actualizados + rF.actualizados + rD.actualizados + rInv.actualizados;

    return {
      ok: true,
      modo: "bidireccional_upsert",
      subidosTotal: subidosTotal,
      actualizadosTotal: actualizadosTotal,
      subidosGastos: rG.subidos,
      actualizadosGastos: rG.actualizados,
      subidosIngresos: rI.subidos,
      actualizadosIngresos: rI.actualizados,
      subidosFijos: rF.subidos,
      actualizadosFijos: rF.actualizados,
      subidosDeudas: rD.subidos,
      actualizadosDeudas: rD.actualizados,
      subidosInversiones: rInv.subidos,
      actualizadosInversiones: rInv.actualizados,
      descargado: descargado,
      timestamp: new Date().toISOString()
    };
  } finally {
    lock.releaseLock();
  }
}

function subirCambiosManual() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = null;
  try { ui = SpreadsheetApp.getUi(); } catch (e) {}
  if (ui) ss.toast("Subiendo cambios (nuevos y editados) a Supabase...", "Control Financiero", 5);

  try {
    var res = ejecutarSincronizacionCompleta({ descargarAlFinal: false });
    var msg = "✅ Subida completada: " + res.subidosTotal + " nuevos, " + res.actualizadosTotal + " actualizados en Supabase.";
    if (ui) ss.toast(msg, "Control Financiero", 6);
    Logger.log(msg);
  } catch (error) {
    Logger.log("Error en subida manual: " + error.toString());
    if (ui) ui.alert("Error de Sincronización", error.message, ui.ButtonSet.OK);
  }
}

function sincronizarConSupabase() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = null;
  try { ui = SpreadsheetApp.getUi(); } catch (e) {}

  if (ui) ss.toast("Sincronizando Sheets <-> Supabase...", "Control Financiero", 5);

  try {
    var res = ejecutarSincronizacionCompleta({ descargarAlFinal: true });
    if (!res.ok) {
      if (ui) ss.toast(res.error, "Control Financiero", 5);
      return;
    }
    var msg = "✅ Sincronización bidireccional lista: +" + res.subidosTotal + " nuevos, " + res.actualizadosTotal + " editados y planilla actualizada.";
    if (ui) ss.toast(msg, "Control Financiero", 6);
    Logger.log(msg);
  } catch (error) {
    Logger.log("Error en sincronización: " + error.toString());
    if (ui) {
      ui.alert("Error de Sincronización", "Ocurrió un error al conectar con Supabase: " + error.message, ui.ButtonSet.OK);
    }
  }
}

/**
 * Trigger instalable al editar cualquier celda del Sheet:
 * Sube inmediatamente la fila nueva o modificada sin esperar a la hora.
 */
function alEditarHoja(e) {
  if (!e || !e.range) return;
  var hoja = e.range.getSheet();
  var nombre = hoja.getName();
  var norm = nombre.toLowerCase();

  // Ignorar fila de encabezados y hojas de solo lectura
  if (e.range.getRow() < 2) return;
  if (norm.indexOf("historial") > -1 || norm.indexOf("metodo") > -1) return;

  try {
    var res = ejecutarSincronizacionCompleta({ hojaSolo: nombre, descargarAlFinal: false });
    if (res && res.ok && (res.subidosTotal > 0 || res.actualizadosTotal > 0)) {
      SpreadsheetApp.getActiveSpreadsheet().toast(
        "⚡ Auto-sync: " + res.subidosTotal + " nuevo(s), " + res.actualizadosTotal + " actualizado(s) en la App.",
        "Control Financiero",
        3
      );
    }
  } catch (err) {
    Logger.log("Error en alEditarHoja: " + err.toString());
  }
}

/**
 * WEB APP ENDPOINT (para el botón "Actualizar" de la App Web)
 */
function doGet(e) {
  try {
    var resumen = ejecutarSincronizacionCompleta({ descargarAlFinal: true });
    return ContentService
      .createTextOutput(JSON.stringify(resumen))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: error.message || error.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doPost(e) {
  return doGet(e);
}

/**
 * Configura los 3 triggers automáticos:
 * 1. Al editar el Sheet (alEditarHoja) -> inmediato
 * 2. Cada 1 hora (sincronizarConSupabase)
 * 3. Todos los días a las 22:00 (sincronizarConSupabase)
 */
function crearTriggerAutomatico() {
  eliminarTriggers();

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ScriptApp.newTrigger('alEditarHoja')
    .forSpreadsheet(ss)
    .onEdit()
    .create();

  ScriptApp.newTrigger('sincronizarConSupabase')
    .timeBased()
    .everyHours(1)
    .create();

  ScriptApp.newTrigger('sincronizarConSupabase')
    .timeBased()
    .atHour(22)
    .nearMinute(0)
    .everyDays(1)
    .create();

  var ui = SpreadsheetApp.getUi();
  ui.alert(
    "Sincronización Automática Activada",
    "✅ Tu Google Sheets ahora sincroniza en ambos sentidos:\n" +
    "- ⚡ Al instante cada vez que agregas o editas una fila en el Sheet.\n" +
    "- 🔄 Cada 1 hora y todos los días a las 22:00 (sube + descarga de la App).",
    ui.ButtonSet.OK
  );
}

function eliminarTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    var fn = triggers[i].getHandlerFunction();
    if (fn === 'sincronizarConSupabase' || fn === 'subirNuevosGastosASupabase' || fn === 'alEditarHoja') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  var ui = null;
  try { ui = SpreadsheetApp.getUi(); } catch (e) {}
  if (ui) {
    SpreadsheetApp.getActiveSpreadsheet().toast("Sincronizaciones automáticas desactivadas.", "Control Financiero", 4);
  }
}
