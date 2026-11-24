// ==============================================================================
// CONTROL FINANCIERO PRO - MOTOR PRINCIPAL DE LA APLICACIÓN (app.js)
// Conectado a Supabase (PostgreSQL + Storage)
// ==============================================================================

const AppState = {
  data: {
    ingresos: [],
    diarios: [],
    servicios: [],
    tarjetas: [],
    mercadoCredito: [],
    prestamos: [],
    historial: [],
    inversiones: [],
    metodos: ['Santander', 'Efectivo', 'Mercado Pago', 'Transferencia', 'TDC', 'Mercado Crédito', 'ARQ']
  },
  currentTab: 'dashboard',
  chartInstance: null,
  flowChartInstance: null,
  investmentsChartInstance: null,
  lastSyncAt: null,
  isPullingSheets: false,
  deudasSupportsMC: null,
  hasInversionesTable: null
};

function getTodayString() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDateES(isoOrDate) {
  if (!isoOrDate) return '';
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (!isNaN(d.getTime())) {
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    return `${day}/${month}/${d.getFullYear()}`;
  }
  return String(isoOrDate);
}

// ==============================================================================
// 1. GESTIÓN DE DATOS (CRUD CON SUPABASE, GOOGLE SHEETS DIRECTO Y LOCALSTORAGE)
// ==============================================================================

const DataService = {
  // Convierte cualquier monto (ej. 12200, "12.200", "$324.930,96", "12200,50") en número válido
  parseMonto(raw, allowNegative = false) {
    if (typeof raw === 'number') {
      if (isNaN(raw)) return 0;
      const rounded = Math.round(raw * 100) / 100;
      return allowNegative ? rounded : Math.abs(rounded);
    }
    if (raw === null || raw === undefined) return 0;
    const cleaned = String(raw).replace(/[^0-9.,-]/g, '').trim();
    if (!cleaned) return 0;

    const isNeg = cleaned.startsWith('-');
    let u = cleaned.replace(/-/g, '');
    if (!u) return 0;

    if (u.includes(',') && u.includes('.')) {
      if (u.lastIndexOf(',') > u.lastIndexOf('.')) {
        u = u.replace(/\./g, '').replace(',', '.');
      } else {
        u = u.replace(/,/g, '');
      }
    } else if (u.includes(',')) {
      if (/^[1-9]\d{0,2}(,\d{3})+$/.test(u)) {
        u = u.replace(/,/g, '');
      } else {
        u = u.replace(',', '.');
      }
    } else if (u.includes('.')) {
      // En formato argentino "9.000", "12.200", "1.200.000" son miles
      if (/^[1-9]\d{0,2}(\.\d{3})+$/.test(u)) {
        u = u.replace(/\./g, '');
      }
    }

    const num = parseFloat(u);
    if (isNaN(num)) return 0;
    const rounded = Math.round(num * 100) / 100;
    return allowNegative && isNeg ? -rounded : rounded;
  },

  isValidUUID(str) {
    if (!str) return false;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(str).trim());
  },

  deterministicUUID(seed) {
    const str = String(seed || '');
    let h1 = 0x811c9dc5, h2 = 0x811c9dc5, h3 = 0x811c9dc5, h4 = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ ((c + i * 17) & 0xff), 0x01000193) >>> 0;
      h3 = Math.imul(h3 ^ ((c ^ (i * 31)) & 0xff), 0x01000193) >>> 0;
      h4 = Math.imul(h4 ^ ((c + i * 53) & 0xff), 0x01000193) >>> 0;
    }
    const hex = (n) => n.toString(16).padStart(8, '0');
    const p1 = hex(h1);
    const p2 = hex(h2);
    const p3 = hex(h3);
    const p4 = hex(h4);
    return `${p1}-${p2.slice(0, 4)}-4${p2.slice(5, 8)}-a${p3.slice(1, 4)}-${p3.slice(4, 8)}${p4}`;
  },

  normalizeDateISO(raw) {
    if (!raw) return getTodayString();
    const parsed = Calculations.parseDateParts(raw);
    if (parsed && parsed.year >= 2000 && parsed.month >= 1 && parsed.month <= 12 && parsed.day >= 1 && parsed.day <= 31) {
      return `${parsed.year}-${String(parsed.month).padStart(2, '0')}-${String(parsed.day).padStart(2, '0')}`;
    }
    return getTodayString();
  },

  normalizeMetodo(raw) {
    if (!raw) return 'Santander';
    const m = String(raw).trim();
    const low = m.toLowerCase();
    if (low.includes('santander')) return 'Santander';
    if (low.includes('arq')) return 'ARQ';
    if (low.includes('bhd')) return 'BHD';
    if (low.includes('brubank')) return 'brubank';
    if (low.includes('mercado pago') || low === 'mp') return 'Mercado Pago';
    if (low.includes('mercado cr')) return 'Mercado Crédito';
    if (low.includes('efectivo')) return 'Efectivo';
    if (low.includes('transfer')) return 'Transferencia';
    if (low === 'tdc' || low.includes('tarjeta')) return 'TDC';
    return m;
  },

  parseCSV(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    const src = String(text || '');
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (inQuotes) {
        if (ch === '"') {
          if (src[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(field);
        field = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && src[i + 1] === '\n') i++;
        row.push(field);
        field = '';
        if (row.some(cell => cell.trim() !== '')) rows.push(row);
        row = [];
      } else {
        field += ch;
      }
    }
    if (field !== '' || row.length > 0) {
      row.push(field);
      if (row.some(cell => cell.trim() !== '')) rows.push(row);
    }
    return rows;
  },

  getDeletedIds() {
    try {
      const raw = localStorage.getItem('CFP_DELETED_IDS');
      return new Set(raw ? JSON.parse(raw) : []);
    } catch (e) {
      return new Set();
    }
  },

  markDeletedId(id) {
    if (!id) return;
    try {
      const set = DataService.getDeletedIds();
      set.add(String(id).toLowerCase());
      localStorage.setItem('CFP_DELETED_IDS', JSON.stringify(Array.from(set).slice(-300)));
    } catch (e) {}
  },

  getImportedSheetKeys() {
    try {
      const raw = localStorage.getItem('CFP_IMPORTED_SHEET_KEYS');
      return new Set(raw ? JSON.parse(raw) : []);
    } catch (e) {
      return new Set();
    }
  },

  markImportedSheetKey(key) {
    if (!key) return;
    try {
      const set = DataService.getImportedSheetKeys();
      set.add(String(key).toLowerCase());
      localStorage.setItem('CFP_IMPORTED_SHEET_KEYS', JSON.stringify(Array.from(set).slice(-500)));
    } catch (e) {}
  },

  async ensureClient() {
    let client = SupabaseConfig.client;
    if (!client && SupabaseConfig.isConfigured()) {
      client = SupabaseConfig.init();
    }
    if (!client && typeof window !== 'undefined' && !window.supabase) {
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 100));
        if (window.supabase) {
          client = SupabaseConfig.init();
          break;
        }
      }
    }
    return client;
  },

  // Carga inicial de datos desde Supabase + auto-importación de novedades en Google Sheets
  async loadAllData(silent = false, skipSheetPull = false) {
    const client = await DataService.ensureClient();

    if (client && SupabaseConfig.isConfigured()) {
      try {
        console.log('🔄 Sincronizando con Supabase...');
        const [
          resIngresos,
          resDiarios,
          resServicios,
          resDeudas,
          resHistorial,
          resMetodos
        ] = await Promise.all([
          client.from('ingresos').select('*').order('fecha', { ascending: false }),
          client.from('gastos_diarios').select('*').order('fecha', { ascending: false }),
          client.from('gastos_fijos').select('*').order('vencimiento', { ascending: true }),
          client.from('deudas').select('*').order('created_at', { ascending: false }),
          client.from('historial').select('*').order('fecha', { ascending: false }).limit(150),
          client.from('metodos_pago').select('*')
        ]);

        const firstErr = resIngresos.error || resDiarios.error || resServicios.error || resDeudas.error || resHistorial.error;
        if (firstErr) {
          throw new Error(firstErr.message || 'Error consultando tablas de Supabase');
        }

        AppState.data.ingresos = (resIngresos.data || []).map(i => ({ ...i, monto: DataService.parseMonto(i.monto) }));
        AppState.data.diarios = (resDiarios.data || []).map(d => ({ ...d, monto: DataService.parseMonto(d.monto) }));
        AppState.data.servicios = (resServicios.data || []).map(s => ({ ...s, monto: DataService.parseMonto(s.monto) }));

        const rawDeudas = resDeudas.data || [];
        const isMercadoCredito = (d) =>
          d.tipo === 'mercado_credito' ||
          (d.metodo || '').toLowerCase().includes('mercado cr');

        const mapDeuda = (d) => ({
          id: d.id,
          compra: d.nombre,
          prestamo: d.nombre,
          monto_total: DataService.parseMonto(d.monto_total),
          cuotas_totales: parseInt(d.cuotas_totales, 10) || 1,
          cuotas_pagadas: parseInt(d.cuotas_pagadas, 10) || 0,
          monto_cuota: DataService.parseMonto(d.monto_cuota),
          fecha_inicio: d.fecha_inicio,
          metodo: d.metodo
        });

        AppState.data.tarjetas = rawDeudas.filter(d => !isMercadoCredito(d) && d.tipo === 'tarjeta').map(mapDeuda);
        AppState.data.mercadoCredito = rawDeudas.filter(d => isMercadoCredito(d)).map(mapDeuda);
        AppState.data.prestamos = rawDeudas.filter(d => !isMercadoCredito(d) && d.tipo === 'prestamo').map(mapDeuda);

        AppState.data.historial = (resHistorial.data || []).map(h => ({
          ...h,
          monto: DataService.parseMonto(h.monto, true),
          fecha_iso: h.fecha,
          fecha: formatDateES(h.fecha)
        }));

        if (resMetodos.data && resMetodos.data.length > 0) {
          const nombres = resMetodos.data.map(m => m.nombre).filter(Boolean);
          // Priorizar Santander primero si existe para evitar cargar por accidente en Efectivo
          AppState.data.metodos = nombres.includes('Santander')
            ? ['Santander', ...nombres.filter(n => n !== 'Santander')]
            : nombres;
        }

        // Cargar inversiones sin spamear 404 si la tabla opcional no existe
        AppState.data.inversiones = DataService.loadLocalInversiones();
        if (AppState.hasInversionesTable !== false) {
          try {
            const { data: inv, error: invError } = await client.from('inversiones').select('*').order('created_at', { ascending: false });
            if (invError) {
              if (invError.code === 'PGRST205' || String(invError.message || '').includes('inversiones')) {
                AppState.hasInversionesTable = false;
              }
            } else if (Array.isArray(inv)) {
              AppState.hasInversionesTable = true;
              AppState.data.inversiones = inv.map(item => ({
                ...item,
                monto_invertido: DataService.parseMonto(item.monto_invertido),
                valor_actual: DataService.parseMonto(item.valor_actual),
                rendimiento_pct: DataService.parseMonto(item.rendimiento_pct, true)
              }));
            }
          } catch (invErr) {
            AppState.hasInversionesTable = false;
          }
        }

        DataService.saveToLocalStorage();
        AppState.lastSyncAt = new Date();
        UI.updateSyncTimestamp();

        if (!silent) UI.showNotification('Datos sincronizados correctamente', 'success');
      } catch (error) {
        console.error('Error al cargar datos desde Supabase:', error);
        UI.showNotification('Error al conectar con Supabase: ' + (error.message || 'usando respaldo local'), 'error');
        DataService.loadFromLocalStorage();
      }
    } else {
      DataService.loadFromLocalStorage();
    }

    UI.renderAll();

    // Auto-importar filas nuevas desde Google Sheets en segundo plano al abrir/volver a la app
    if (!skipSheetPull && client && SupabaseConfig.isConfigured()) {
      DataService.pullNewFromGoogleSheet().then(pullRes => {
        if (pullRes && pullRes.imported > 0) {
          UI.renderAll();
          UI.showNotification(`Google Sheets sincronizado (+${pullRes.imported} nuevo${pullRes.imported > 1 ? 's' : ''})`, 'success');
        }
      }).catch(err => console.warn('Aviso lectura directa de Google Sheets:', err));
    }
  },

  // Lee directamente el Google Sheet (gviz CSV) e importa gastos/ingresos nuevos sin requerir Apps Script
  async pullNewFromGoogleSheet() {
    if (AppState.isPullingSheets) return { ok: true, imported: 0 };
    const client = await DataService.ensureClient();
    if (!client || !SupabaseConfig.isConfigured()) return { ok: false, imported: 0 };

    const sheetId = typeof SupabaseConfig.getGoogleSheetId === 'function' ? SupabaseConfig.getGoogleSheetId() : '';
    if (!sheetId) return { ok: false, imported: 0 };

    AppState.isPullingSheets = true;
    let importedGastos = 0;
    let importedIngresos = 0;

    const fetchSheetRows = async (tabName) => {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), 12000) : null;
      try {
        const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tabName)}&_t=${Date.now()}`;
        const resp = await fetch(url, {
          method: 'GET',
          signal: controller ? controller.signal : undefined
        });
        if (!resp.ok) return null;
        const txt = await resp.text();
        if (!txt || txt.trim().startsWith('<!DOCTYPE') || txt.trim().startsWith('<html')) return null;
        const rows = DataService.parseCSV(txt);
        if (rows.length < 2) return [];
        const headerStr = rows[0].join('|').toLowerCase();
        if (!headerStr.includes('id') && !headerStr.includes('monto') && !headerStr.includes('descrip')) return null;
        return rows.slice(1);
      } catch (e) {
        return null;
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    try {
      const deletedIds = DataService.getDeletedIds();
      const importedKeys = DataService.getImportedSheetKeys();

      // 1. Procesar Gastos_Diarios nuevos del Sheet
      const rowsGastos = await fetchSheetRows('Gastos_Diarios');
      if (Array.isArray(rowsGastos) && rowsGastos.length > 0) {
        const existingIds = new Set((AppState.data.diarios || []).map(d => String(d.id || '').toLowerCase()));
        const existingSigs = new Set((AppState.data.diarios || []).map(d =>
          `${(d.descripcion || '').trim().toLowerCase()}|${Math.round(DataService.parseMonto(d.monto))}|${d.fecha}`
        ));
        const deletedGastoSigs = new Set(
          (AppState.data.historial || [])
            .filter(h => (h.categoria || '').toLowerCase().includes('eliminación gasto'))
            .map(h => `${(h.descripcion || '').trim().toLowerCase()}|${Math.round(Math.abs(DataService.parseMonto(h.monto, true)))}`)
        );

        for (let idx = 0; idx < rowsGastos.length; idx++) {
          const r = rowsGastos[idx];
          const colId = String(r[0] || '').trim();
          const descripcion = String(r[1] || '').trim();
          const monto = DataService.parseMonto(r[2]);
          const fechaIso = DataService.normalizeDateISO(r[3]);
          const metodo = DataService.normalizeMetodo(r[4]);

          if (!descripcion || monto <= 0 || colId.toUpperCase().startsWith('FIJO-')) continue;

          const rowUuid = DataService.isValidUUID(colId)
            ? colId.toLowerCase()
            : DataService.deterministicUUID(`gd|${descripcion.toLowerCase()}|${Math.round(monto * 100)}|${fechaIso}|${metodo.toLowerCase()}|r${idx + 2}`);
          const sig = `${descripcion.toLowerCase()}|${Math.round(monto)}|${fechaIso}`;
          const delSig = `${descripcion.toLowerCase()}|${Math.round(monto)}`;

          if (
            existingIds.has(rowUuid) ||
            existingSigs.has(sig) ||
            deletedIds.has(rowUuid) ||
            deletedGastoSigs.has(delSig) ||
            importedKeys.has(rowUuid)
          ) {
            continue;
          }

          const { data, error } = await client
            .from('gastos_diarios')
            .upsert([{ id: rowUuid, descripcion, monto, metodo, fecha: fechaIso }], { onConflict: 'id', ignoreDuplicates: true })
            .select();

          if (!error && data && data[0]) {
            existingIds.add(rowUuid);
            existingSigs.add(sig);
            DataService.markImportedSheetKey(rowUuid);
            AppState.data.diarios.unshift({ ...data[0], monto: DataService.parseMonto(data[0].monto) });
            await DataService.ajustarCuenta(metodo, -monto);
            await DataService.logHistorial('Gasto Diario', descripcion, monto, metodo);
            importedGastos++;
          }
        }
      }

      // 2. Procesar INGRESOS nuevos del Sheet
      const rowsIngresos = await fetchSheetRows('INGRESOS');
      if (Array.isArray(rowsIngresos) && rowsIngresos.length > 0) {
        const existingIngIds = new Set((AppState.data.ingresos || []).map(i => String(i.id || '').toLowerCase()));
        const knownHistIngSigs = new Set(
          (AppState.data.historial || [])
            .filter(h => {
              const cat = (h.categoria || '').toLowerCase();
              return cat === 'ingreso' || cat.includes('eliminación ingreso');
            })
            .map(h => `${(h.descripcion || '').trim().toLowerCase()}|${Math.round(Math.abs(DataService.parseMonto(h.monto, true)))}`)
        );

        for (let idx = 0; idx < rowsIngresos.length; idx++) {
          const r = rowsIngresos[idx];
          const colId = String(r[0] || '').trim();
          const descripcion = String(r[1] || '').trim();
          const monto = DataService.parseMonto(r[2]);
          const fechaIso = DataService.normalizeDateISO(r[3]);
          const metodo = DataService.normalizeMetodo(r[4]);

          if (!descripcion || monto <= 0) continue;

          const rowUuid = DataService.isValidUUID(colId)
            ? colId.toLowerCase()
            : DataService.deterministicUUID(`ing|${descripcion.toLowerCase()}|${Math.round(monto * 100)}|${fechaIso}|${metodo.toLowerCase()}|r${idx + 2}`);
          const histSig = `${descripcion.toLowerCase()}|${Math.round(monto)}`;

          if (
            existingIngIds.has(rowUuid) ||
            knownHistIngSigs.has(histSig) ||
            deletedIds.has(rowUuid) ||
            importedKeys.has(rowUuid)
          ) {
            continue;
          }

          const okIng = await DataService.creditarCuentaOInsertarIngreso(descripcion, monto, metodo, fechaIso, rowUuid);
          if (okIng) {
            existingIngIds.add(rowUuid);
            knownHistIngSigs.add(histSig);
            DataService.markImportedSheetKey(rowUuid);
            await DataService.logHistorial('Ingreso', descripcion, monto, metodo);
            importedIngresos++;
          }
        }
      }

      if (importedGastos + importedIngresos > 0) {
        DataService.saveToLocalStorage();
      }

      return {
        ok: true,
        imported: importedGastos + importedIngresos,
        importedGastos,
        importedIngresos
      };
    } finally {
      AppState.isPullingSheets = false;
    }
  },

  async syncGoogleSheets() {
    let subidosTotal = 0;
    let actualizadosTotal = 0;
    let appsScriptError = null;

    // 1. Si hay un endpoint Web App de Apps Script válido (/macros/s/.../exec), invocarlo primero
    const syncUrl = typeof SupabaseConfig.getAppsScriptWebAppUrl === 'function'
      ? SupabaseConfig.getAppsScriptWebAppUrl()
      : '';

    if (syncUrl) {
      const sep = syncUrl.includes('?') ? '&' : '?';
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timeoutId = controller ? setTimeout(() => controller.abort(), 15000) : null;
      try {
        const resp = await fetch(`${syncUrl}${sep}action=sync&_t=${Date.now()}`, {
          method: 'GET',
          redirect: 'follow',
          signal: controller ? controller.signal : undefined
        });
        if (resp.ok) {
          const payload = JSON.parse(await resp.text());
          if (payload && payload.ok !== false) {
            subidosTotal += payload.subidosTotal !== undefined
              ? (Number(payload.subidosTotal) || 0)
              : (Number(payload.subidosGastos) || 0) + (Number(payload.subidosIngresos) || 0) + (Number(payload.subidosFijos) || 0) + (Number(payload.subidosDeudas) || 0) + (Number(payload.subidosInversiones) || 0);
            actualizadosTotal += Number(payload.actualizadosTotal) || 0;
          } else if (payload && payload.error) {
            appsScriptError = payload.error;
          }
        }
      } catch (err) {
        appsScriptError = err.name === 'AbortError' ? 'Tiempo agotado en Apps Script' : err.message;
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    }

    // 2. Recargar estado base de Supabase y ejecutar lectura directa de Google Sheets (sin Apps Script)
    await DataService.loadAllData(true, true);
    const directRes = await DataService.pullNewFromGoogleSheet();
    if (directRes && directRes.imported > 0) {
      subidosTotal += directRes.imported;
      await DataService.loadAllData(true, true);
    }

    return {
      configured: true,
      ok: true,
      subidosTotal,
      actualizadosTotal,
      appsScriptError
    };
  },

  async refreshAll(btn) {
    const icon = btn ? btn.querySelector('i') : null;
    if (icon) icon.classList.add('fa-spin');
    try {
      const sheetsRes = await DataService.syncGoogleSheets();
      UI.renderAll();
      const partes = [];
      if (sheetsRes.subidosTotal > 0) partes.push(`+${sheetsRes.subidosTotal} nuevos`);
      if (sheetsRes.actualizadosTotal > 0) partes.push(`${sheetsRes.actualizadosTotal} editados`);
      const msg = partes.length > 0
        ? `Google Sheets sincronizado (${partes.join(', ')}) y tablero actualizado`
        : 'Google Sheets y Supabase actualizados';
      UI.showNotification(msg, 'success');
    } catch (err) {
      console.error('Error al actualizar:', err);
      UI.showNotification('Error al actualizar datos: ' + (err.message || 'revisa tu conexión'), 'error');
    } finally {
      if (icon) setTimeout(() => icon.classList.remove('fa-spin'), 400);
    }
  },

  loadLocalInversiones() {
    try {
      const raw = localStorage.getItem('CFP_LOCAL_INVERSIONES');
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  },

  saveLocalInversiones(list) {
    try {
      localStorage.setItem('CFP_LOCAL_INVERSIONES', JSON.stringify(list || []));
    } catch (e) {}
  },

  loadFromLocalStorage() {
    const saved = localStorage.getItem('CFP_LOCAL_DATA');
    if (saved) {
      try {
        AppState.data = JSON.parse(saved);
        if (!Array.isArray(AppState.data.inversiones)) {
          AppState.data.inversiones = DataService.loadLocalInversiones();
        }
        if (!Array.isArray(AppState.data.mercadoCredito)) {
          AppState.data.mercadoCredito = [];
        }
        if (!Array.isArray(AppState.data.metodos) || AppState.data.metodos.length === 0) {
          AppState.data.metodos = ['Santander', 'Efectivo', 'Mercado Pago', 'Transferencia', 'TDC', 'Mercado Crédito', 'ARQ'];
        }
      } catch (e) {
        console.error('Error parseando datos locales', e);
      }
    }
  },

  saveToLocalStorage() {
    try {
      localStorage.setItem('CFP_LOCAL_DATA', JSON.stringify(AppState.data));
    } catch (e) {}
  },

  // Registrar movimiento en Historial
  async logHistorial(categoria, descripcion, monto, metodo) {
    const hoy = new Date();
    const valMonto = DataService.parseMonto(monto, true);
    const item = {
      id: Date.now().toString(),
      fecha_iso: hoy.toISOString(),
      fecha: formatDateES(hoy),
      categoria,
      descripcion,
      monto: valMonto,
      metodo: metodo || 'General'
    };

    AppState.data.historial.unshift(item);

    const client = await DataService.ensureClient();
    if (client && SupabaseConfig.isConfigured()) {
      try {
        const { data, error } = await client.from('historial').insert([{
          categoria,
          descripcion,
          monto: valMonto,
          metodo: metodo || 'General'
        }]).select();
        if (!error && data && data[0]) {
          item.id = data[0].id;
        }
      } catch (err) {
        console.error('Error guardando en historial Supabase:', err);
      }
    }
    DataService.saveToLocalStorage();
  },

  // Acredita dinero en la cuenta existente de ese banco/billetera o crea la cuenta si no existe
  async creditarCuentaOInsertarIngreso(descripcion, valMonto, metodo, fechaVal, preferredId = null) {
    const metodoClean = DataService.normalizeMetodo(metodo);
    const metLow = metodoClean.toLowerCase();
    const client = await DataService.ensureClient();
    const isSupa = Boolean(client && SupabaseConfig.isConfigured());

    const existente = (AppState.data.ingresos || []).find(i => (i.metodo || '').trim().toLowerCase() === metLow);

    if (existente) {
      let base = DataService.parseMonto(existente.monto);
      if (isSupa) {
        try {
          const { data: fresh } = await client.from('ingresos').select('monto').eq('id', existente.id).single();
          if (fresh && fresh.monto !== undefined && fresh.monto !== null) {
            base = DataService.parseMonto(fresh.monto);
          }
        } catch (e) {}
      }
      const nuevoMonto = Math.round((base + valMonto) * 100) / 100;
      if (isSupa) {
        const { error } = await client.from('ingresos').update({
          monto: nuevoMonto,
          fecha: fechaVal
        }).eq('id', existente.id);
        if (error) {
          console.error('Error acreditando ingreso en cuenta existente:', error);
          UI.showNotification('No se pudo actualizar el saldo en Supabase: ' + error.message, 'error');
          return false;
        }
      }
      existente.monto = nuevoMonto;
      existente.fecha = fechaVal;
      return true;
    }

    const payload = {
      descripcion: descripcion || `Plata en ${metodoClean}`,
      monto: valMonto,
      metodo: metodoClean,
      fecha: fechaVal
    };
    if (preferredId && DataService.isValidUUID(preferredId)) {
      payload.id = preferredId;
    }

    if (isSupa) {
      const { data, error } = await client.from('ingresos').insert([payload]).select();
      if (error || !data || !data[0]) {
        console.error('Error insertando nuevo ingreso:', error);
        UI.showNotification('No se pudo guardar el ingreso: ' + (error?.message || 'revisa tu conexión'), 'error');
        return false;
      }
      AppState.data.ingresos.unshift({ ...data[0], monto: DataService.parseMonto(data[0].monto) });
      return true;
    }

    AppState.data.ingresos.unshift({ id: Date.now().toString(), ...payload });
    return true;
  },

  // -------------------------------------------------------------
  // INGRESOS
  // -------------------------------------------------------------
  async addIngreso(descripcion, monto, metodo, fecha) {
    const descClean = String(descripcion || '').trim();
    const valMonto = DataService.parseMonto(monto);
    const fechaVal = fecha || getTodayString();
    const metodoClean = DataService.normalizeMetodo(metodo || 'Santander');

    if (!descClean || valMonto <= 0) {
      UI.showNotification('Ingresa una descripción y un monto mayor a 0', 'warning');
      return false;
    }

    const ok = await DataService.creditarCuentaOInsertarIngreso(descClean, valMonto, metodoClean, fechaVal);
    if (!ok) return false;

    await DataService.logHistorial('Ingreso', descClean, valMonto, metodoClean);
    DataService.saveToLocalStorage();
    UI.renderAll();
    UI.showNotification(`Ingreso de ${UI.formatCurrency(valMonto)} acreditado en ${metodoClean}`, 'success');
    return true;
  },

  async deleteIngreso(id) {
    const item = AppState.data.ingresos.find(i => i.id === id);
    const client = await DataService.ensureClient();

    if (client && SupabaseConfig.isConfigured()) {
      const { error } = await client.from('ingresos').delete().eq('id', id);
      if (error) {
        UI.showNotification('No se pudo eliminar la cuenta: ' + error.message, 'error');
        return false;
      }
    }

    DataService.markDeletedId(id);
    AppState.data.ingresos = AppState.data.ingresos.filter(i => i.id !== id);
    DataService.saveToLocalStorage();

    if (item) {
      await DataService.logHistorial('Eliminación Ingreso', item.descripcion, -item.monto, item.metodo);
    }
    UI.renderAll();
    UI.showNotification('Cuenta / ingreso eliminado', 'info');
    return true;
  },

  // -------------------------------------------------------------
  // TRASPASO ENTRE CUENTAS / BANCOS / EFECTIVO
  // -------------------------------------------------------------
  async transferirDinero(origen, destino, monto, nota) {
    const valMonto = DataService.parseMonto(monto);
    if (!valMonto || valMonto <= 0) {
      UI.showNotification('Ingresa un monto válido para transferir', 'warning');
      return false;
    }
    if (!origen || !destino) {
      UI.showNotification('Selecciona cuenta de origen y destino', 'warning');
      return false;
    }
    if (origen.trim().toLowerCase() === destino.trim().toLowerCase()) {
      UI.showNotification('El origen y destino no pueden ser iguales', 'warning');
      return false;
    }

    await DataService.ajustarCuenta(origen, -valMonto);
    const okDest = await DataService.creditarCuentaOInsertarIngreso(`Plata en ${destino}`, valMonto, destino, getTodayString());
    if (!okDest) return false;

    const detalleTraspaso = `Traspaso: ${origen} ➔ ${destino}${nota ? ' • ' + nota.trim() : ''}`;
    await DataService.logHistorial('Traspaso', detalleTraspaso, valMonto, `${origen} ➔ ${destino}`);

    DataService.saveToLocalStorage();
    UI.renderAll();
    UI.showNotification(`🔄 Traspaso de ${UI.formatCurrency(valMonto)} (${origen} ➔ ${destino}) completado`, 'success');
    return true;
  },

  // -------------------------------------------------------------
  // SALDO DE CUENTAS (núcleo del modelo "billetera")
  // Respeta siempre CHECK (monto >= 0) en Supabase y reparte descuentos
  // si hubiera múltiples filas del mismo banco.
  // -------------------------------------------------------------
  async ajustarCuenta(metodo, delta) {
    const valDelta = DataService.parseMonto(delta, true);
    if (!metodo || valDelta === 0) return { found: false, descontado: 0, faltante: 0 };
    const met = String(metodo).trim().toLowerCase();

    // Métodos de crédito puro no descuentan dinero líquido al comprar
    if (met === 'tdc' || met.includes('tarjeta de cr') || met.includes('mercado cr')) {
      return { found: false, isCredito: true, descontado: 0, faltante: 0 };
    }

    const client = await DataService.ensureClient();
    const isSupa = Boolean(client && SupabaseConfig.isConfigured());

    // Sincronizar saldos frescos de ingresos desde Supabase antes de ajustar
    if (isSupa) {
      try {
        const { data: freshRows, error: freshErr } = await client.from('ingresos').select('*').order('fecha', { ascending: false });
        if (!freshErr && Array.isArray(freshRows)) {
          AppState.data.ingresos = freshRows.map(i => ({ ...i, monto: DataService.parseMonto(i.monto) }));
        }
      } catch (e) {
        console.warn('No se pudo refrescar ingresos antes de ajustar cuenta:', e);
      }
    }

    const candidatas = (AppState.data.ingresos || [])
      .filter(i => (i.metodo || '').trim().toLowerCase() === met)
      .sort((a, b) => DataService.parseMonto(b.monto) - DataService.parseMonto(a.monto));

    if (candidatas.length === 0) {
      return { found: false, descontado: 0, faltante: Math.abs(valDelta) };
    }

    if (valDelta > 0) {
      const principal = candidatas[0];
      const nuevoMonto = Math.round((DataService.parseMonto(principal.monto) + valDelta) * 100) / 100;
      principal.monto = nuevoMonto;
      if (isSupa) {
        const { error } = await client.from('ingresos').update({ monto: nuevoMonto }).eq('id', principal.id);
        if (error) console.error('Error sumando saldo a cuenta:', error);
      }
      DataService.saveToLocalStorage();
      return { found: true, descontado: valDelta, faltante: 0 };
    }

    // Salida de dinero (valDelta < 0): descontar sin bajar nunca de 0 (evita error CHECK monto >= 0)
    let porDescontar = Math.abs(valDelta);
    let totalDescontado = 0;

    for (const cuenta of candidatas) {
      if (porDescontar <= 0) break;
      const disponible = Math.max(0, DataService.parseMonto(cuenta.monto));
      if (disponible <= 0) continue;

      const quitar = Math.min(disponible, porDescontar);
      const nuevoMonto = Math.max(0, Math.round((disponible - quitar) * 100) / 100);
      cuenta.monto = nuevoMonto;
      porDescontar = Math.round((porDescontar - quitar) * 100) / 100;
      totalDescontado = Math.round((totalDescontado + quitar) * 100) / 100;

      if (isSupa) {
        const { error } = await client.from('ingresos').update({ monto: nuevoMonto }).eq('id', cuenta.id);
        if (error) {
          console.error('Error actualizando saldo de cuenta en Supabase:', error);
        }
      }
    }

    DataService.saveToLocalStorage();
    return { found: true, descontado: totalDescontado, faltante: porDescontar };
  },

  // -------------------------------------------------------------
  // GASTOS DIARIOS
  // -------------------------------------------------------------
  async addGastoDiario(descripcion, monto, metodo, fecha) {
    const descClean = String(descripcion || '').trim();
    const fechaVal = fecha || getTodayString();
    const valMonto = DataService.parseMonto(monto);
    const metodoClean = DataService.normalizeMetodo(metodo || 'Santander');

    if (!descClean || valMonto <= 0) {
      UI.showNotification('Ingresa una descripción y un monto válido mayor a 0', 'warning');
      return false;
    }

    const client = await DataService.ensureClient();

    if (client && SupabaseConfig.isConfigured()) {
      const { data, error } = await client.from('gastos_diarios').insert([{
        descripcion: descClean,
        monto: valMonto,
        metodo: metodoClean,
        fecha: fechaVal
      }]).select();

      if (error || !data || !data[0]) {
        console.error('Error guardando gasto:', error);
        UI.showNotification('No se pudo guardar el gasto: ' + (error?.message || 'revisa tu conexión'), 'error');
        return false;
      }
      AppState.data.diarios.unshift({ ...data[0], monto: DataService.parseMonto(data[0].monto) });
    } else {
      const nuevo = { id: Date.now().toString(), descripcion: descClean, monto: valMonto, metodo: metodoClean, fecha: fechaVal };
      AppState.data.diarios.unshift(nuevo);
    }

    const ajuste = await DataService.ajustarCuenta(metodoClean, -valMonto);
    await DataService.logHistorial('Gasto Diario', descClean, valMonto, metodoClean);
    DataService.saveToLocalStorage();
    UI.renderAll();

    if (ajuste.found && ajuste.faltante <= 0) {
      UI.showNotification(`Gasto de ${UI.formatCurrency(valMonto)} registrado y descontado de ${metodoClean}`, 'success');
    } else if (ajuste.found && ajuste.faltante > 0) {
      UI.showNotification(`Gasto guardado. ${metodoClean} quedó en $0 (faltaron ${UI.formatCurrency(ajuste.faltante)} de saldo cargado)`, 'warning');
    } else if (ajuste.isCredito) {
      UI.showNotification(`Gasto registrado con ${metodoClean}`, 'success');
    } else {
      UI.showNotification(`Gasto guardado. "${metodoClean}" no tiene saldo cargado en Cuentas`, 'info');
    }
    return true;
  },

  async deleteGastoDiario(id) {
    const item = AppState.data.diarios.find(d => d.id === id);
    const client = await DataService.ensureClient();

    if (client && SupabaseConfig.isConfigured()) {
      const { error } = await client.from('gastos_diarios').delete().eq('id', id);
      if (error) {
        UI.showNotification('No se pudo eliminar el gasto: ' + error.message, 'error');
        return false;
      }
    }

    DataService.markDeletedId(id);
    AppState.data.diarios = AppState.data.diarios.filter(d => d.id !== id);
    DataService.saveToLocalStorage();

    if (item) {
      await DataService.ajustarCuenta(item.metodo, DataService.parseMonto(item.monto));
      await DataService.logHistorial('Eliminación Gasto', item.descripcion, -DataService.parseMonto(item.monto), item.metodo);
    }
    UI.renderAll();
    UI.showNotification('Gasto eliminado y plata devuelta a la cuenta', 'info');
    return true;
  },

  // -------------------------------------------------------------
  // SERVICIOS / GASTOS FIJOS
  // -------------------------------------------------------------
  async addServicio(servicio, monto, vencimiento) {
    const servClean = String(servicio || '').trim();
    const valMonto = DataService.parseMonto(monto);
    const venc = Math.max(1, Math.min(31, parseInt(vencimiento, 10) || 10));

    if (!servClean || valMonto <= 0) {
      UI.showNotification('Ingresa el nombre del servicio y un monto válido', 'warning');
      return false;
    }

    const client = await DataService.ensureClient();

    if (client && SupabaseConfig.isConfigured()) {
      const { data, error } = await client.from('gastos_fijos').insert([{
        servicio: servClean,
        monto: valMonto,
        vencimiento: venc,
        estado: 'Pendiente'
      }]).select();

      if (error || !data || !data[0]) {
        console.error('Error guardando servicio fijo:', error);
        UI.showNotification('No se pudo guardar el servicio: ' + (error?.message || 'revisa tu conexión'), 'error');
        return false;
      }
      AppState.data.servicios.push({ ...data[0], monto: DataService.parseMonto(data[0].monto) });
    } else {
      const nuevo = {
        id: Date.now().toString(),
        servicio: servClean,
        monto: valMonto,
        vencimiento: venc,
        estado: 'Pendiente'
      };
      AppState.data.servicios.push(nuevo);
      DataService.saveToLocalStorage();
    }

    AppState.data.servicios.sort((a, b) => a.vencimiento - b.vencimiento);
    UI.renderAll();
    UI.showNotification('Servicio fijo programado', 'success');
    return true;
  },

  async toggleServicio(id, metodo) {
    const serv = AppState.data.servicios.find(s => s.id === id);
    if (!serv) return false;

    const estadoPrevio = serv.estado;
    const metodoPrevio = serv.metodo_pago;
    const fechaPrevia = serv.fecha_pago;

    const nuevoEstado = serv.estado === 'Pagado' ? 'Pendiente' : 'Pagado';
    const monto = DataService.parseMonto(serv.monto);

    let metodoPago = metodo && metodo !== 'General' ? metodo : null;
    if (nuevoEstado === 'Pagado' && !metodoPago) {
      const principal = AppState.data.ingresos.find(i => (i.metodo || '').toLowerCase() === 'santander')
        || [...AppState.data.ingresos].sort((a, b) => DataService.parseMonto(b.monto) - DataService.parseMonto(a.monto))[0];
      metodoPago = principal ? principal.metodo : 'Santander';
    }

    serv.estado = nuevoEstado;
    serv.metodo_pago = nuevoEstado === 'Pagado' ? metodoPago : null;
    serv.fecha_pago = nuevoEstado === 'Pagado' ? getTodayString() : null;

    const client = await DataService.ensureClient();
    if (client && SupabaseConfig.isConfigured()) {
      const { error } = await client.from('gastos_fijos').update({
        estado: nuevoEstado,
        fecha_pago: serv.fecha_pago,
        metodo_pago: serv.metodo_pago
      }).eq('id', id);

      if (error) {
        serv.estado = estadoPrevio;
        serv.metodo_pago = metodoPrevio;
        serv.fecha_pago = fechaPrevia;
        UI.showNotification('Error actualizando servicio: ' + error.message, 'error');
        return false;
      }
    }
    DataService.saveToLocalStorage();

    if (nuevoEstado === 'Pagado') {
      const ajuste = await DataService.ajustarCuenta(metodoPago, -monto);
      await DataService.logHistorial('Servicio Pagado', serv.servicio, monto, metodoPago);
      UI.showNotification(
        ajuste.found ? `"${serv.servicio}" pagado y descontado de ${metodoPago}` : `"${serv.servicio}" marcado como Pagado`,
        'success'
      );
    } else {
      const ajuste = await DataService.ajustarCuenta(metodoPrevio, monto);
      if (ajuste.found) {
        await DataService.logHistorial('Reverso Servicio', serv.servicio, -monto, metodoPrevio);
      }
      UI.showNotification(`"${serv.servicio}" marcado como Pendiente${ajuste.found ? ` (se devolvió a ${metodoPrevio})` : ''}`, 'info');
    }

    UI.renderAll();
    return true;
  },

  async deleteServicio(id) {
    const client = await DataService.ensureClient();
    if (client && SupabaseConfig.isConfigured()) {
      const { error } = await client.from('gastos_fijos').delete().eq('id', id);
      if (error) {
        UI.showNotification('No se pudo eliminar el servicio: ' + error.message, 'error');
        return false;
      }
    }
    DataService.markDeletedId(id);
    AppState.data.servicios = AppState.data.servicios.filter(s => s.id !== id);
    DataService.saveToLocalStorage();
    UI.renderAll();
    UI.showNotification('Servicio eliminado', 'info');
    return true;
  },

  async updateServicio(id, { servicio, monto, vencimiento }) {
    const servClean = String(servicio || '').trim();
    const m = DataService.parseMonto(monto);
    const v = Math.max(1, Math.min(31, parseInt(vencimiento, 10) || 1));

    if (!servClean || m <= 0) {
      UI.showNotification('Ingresa un nombre y monto válido', 'warning');
      return false;
    }

    const client = await DataService.ensureClient();
    if (client && SupabaseConfig.isConfigured()) {
      const { error } = await client.from('gastos_fijos').update({
        servicio: servClean,
        monto: m,
        vencimiento: v
      }).eq('id', id);
      if (error) {
        UI.showNotification('Error actualizando servicio: ' + error.message, 'error');
        return false;
      }
    }

    const serv = AppState.data.servicios.find(s => s.id === id);
    if (serv) {
      serv.servicio = servClean;
      serv.monto = m;
      serv.vencimiento = v;
    }

    AppState.data.servicios.sort((a, b) => a.vencimiento - b.vencimiento);
    DataService.saveToLocalStorage();
    UI.renderAll();
    UI.showNotification(`Servicio "${servClean}" actualizado`, 'success');
    return true;
  },

  // Subir comprobante a Supabase Storage
  async uploadVoucher(servicioId, file) {
    if (!file) return;
    const client = await DataService.ensureClient();
    if (!client || !SupabaseConfig.isConfigured()) {
      UI.showNotification('Conecta Supabase para almacenar comprobantes en la nube.', 'warning');
      return;
    }

    try {
      UI.showNotification('Subiendo comprobante...', 'info');
      const fileExt = file.name.split('.').pop();
      const fileName = `${servicioId}_${Date.now()}.${fileExt}`;
      const filePath = `vouchers/${fileName}`;

      const { error: uploadError } = await client.storage
        .from('vouchers')
        .upload(filePath, file);

      if (uploadError) throw uploadError;

      const { data: publicUrlData } = client.storage
        .from('vouchers')
        .getPublicUrl(filePath);

      const publicUrl = publicUrlData.publicUrl;

      await client.from('gastos_fijos').update({
        comprobante_url: publicUrl
      }).eq('id', servicioId);

      const serv = AppState.data.servicios.find(s => s.id === servicioId);
      if (serv) serv.comprobante_url = publicUrl;

      UI.renderAll();
      UI.showNotification('Comprobante guardado con éxito', 'success');
    } catch (err) {
      console.error('Error al subir voucher:', err);
      const msg = String(err.message || '').includes('Bucket not found')
        ? 'Falta crear el bucket público "vouchers" en Supabase Storage'
        : ('Error al subir el comprobante: ' + err.message);
      UI.showNotification(msg, 'error');
    }
  },

  // -------------------------------------------------------------
  // DEUDAS (TARJETAS, MERCADO CRÉDITO Y PRÉSTAMOS)
  // -------------------------------------------------------------
  getDeudaList(tipo) {
    if (tipo === 'tarjeta') return AppState.data.tarjetas;
    if (tipo === 'mercado_credito') return AppState.data.mercadoCredito;
    return AppState.data.prestamos;
  },

  getDeudaTipoLabel(tipo) {
    if (tipo === 'tarjeta') return 'Tarjeta de Crédito';
    if (tipo === 'mercado_credito') return 'Mercado Crédito';
    return 'Préstamo';
  },

  async addDeuda(tipo, nombre, montoTotal, cuotasTotales, metodo, cuotasPagadas) {
    const nombreClean = String(nombre || '').trim();
    const total = DataService.parseMonto(montoTotal);
    const cuotas = Math.max(1, parseInt(cuotasTotales, 10) || 1);
    const pagadas = Math.max(0, Math.min(cuotas, parseInt(cuotasPagadas, 10) || 0));
    const montoCuota = Math.round((total / cuotas) * 100) / 100;

    if (!nombreClean || total <= 0) {
      UI.showNotification('Ingresa una descripción y un monto total mayor a 0', 'warning');
      return false;
    }

    let metodoFinal = metodo || (tipo === 'mercado_credito' ? 'Mercado Crédito' : (tipo === 'tarjeta' ? 'TDC' : 'Santander'));
    if (tipo === 'mercado_credito') metodoFinal = 'Mercado Crédito';

    const client = await DataService.ensureClient();

    if (client && SupabaseConfig.isConfigured()) {
      const dbTipoInicial = (tipo === 'mercado_credito' && AppState.deudasSupportsMC === false) ? 'prestamo' : tipo;
      let { data, error } = await client.from('deudas').insert([{
        tipo: dbTipoInicial,
        nombre: nombreClean,
        monto_total: total,
        cuotas_totales: cuotas,
        cuotas_pagadas: pagadas,
        monto_cuota: montoCuota,
        metodo: metodoFinal,
        fecha_inicio: getTodayString()
      }]).select();

      // Respaldo automático si Supabase aún tiene CHECK (tipo IN ('tarjeta', 'prestamo'))
      if (error && tipo === 'mercado_credito' && dbTipoInicial === 'mercado_credito') {
        AppState.deudasSupportsMC = false;
        const retry = await client.from('deudas').insert([{
          tipo: 'prestamo',
          nombre: nombreClean,
          monto_total: total,
          cuotas_totales: cuotas,
          cuotas_pagadas: pagadas,
          monto_cuota: montoCuota,
          metodo: 'Mercado Crédito',
          fecha_inicio: getTodayString()
        }]).select();
        data = retry.data;
        error = retry.error;
      }

      if (error || !data || !data[0]) {
        console.error('Error al guardar deuda en Supabase:', error);
        UI.showNotification('Error al guardar deuda: ' + (error?.message || 'revisa tu conexión'), 'error');
        return false;
      }

      const itemFormateado = {
        id: data[0].id,
        compra: data[0].nombre,
        prestamo: data[0].nombre,
        monto_total: total,
        cuotas_totales: cuotas,
        cuotas_pagadas: pagadas,
        monto_cuota: montoCuota,
        fecha_inicio: data[0].fecha_inicio,
        metodo: data[0].metodo
      };
      DataService.getDeudaList(tipo).unshift(itemFormateado);
    } else {
      const nuevo = {
        id: Date.now().toString(),
        compra: nombreClean,
        prestamo: nombreClean,
        monto_total: total,
        cuotas_totales: cuotas,
        cuotas_pagadas: pagadas,
        monto_cuota: montoCuota,
        fecha_inicio: getTodayString(),
        metodo: metodoFinal
      };
      DataService.getDeudaList(tipo).unshift(nuevo);
    }

    DataService.saveToLocalStorage();
    UI.renderAll();
    UI.showNotification(`${DataService.getDeudaTipoLabel(tipo)} registrado correctamente`, 'success');
    return true;
  },

  async updateDeuda(id, tipoOriginal, { tipo, nombre, monto_total, cuotas_totales, cuotas_pagadas, monto_cuota, metodo }) {
    const nuevoTipo = tipo || tipoOriginal;
    const nombreClean = String(nombre || '').trim();
    const total = DataService.parseMonto(monto_total);
    const cuotasTot = Math.max(1, parseInt(cuotas_totales, 10) || 1);
    const cuotasPag = Math.max(0, Math.min(cuotasTot, parseInt(cuotas_pagadas, 10) || 0));
    const parsedCuota = DataService.parseMonto(monto_cuota);
    const valorCuota = parsedCuota > 0 ? parsedCuota : Math.round((total / cuotasTot) * 100) / 100;
    let metodoFinal = metodo || (nuevoTipo === 'mercado_credito' ? 'Mercado Crédito' : (nuevoTipo === 'tarjeta' ? 'TDC' : 'Santander'));
    if (nuevoTipo === 'mercado_credito') metodoFinal = 'Mercado Crédito';

    if (!nombreClean || total <= 0) {
      UI.showNotification('Ingresa un nombre y monto válido', 'warning');
      return false;
    }

    const client = await DataService.ensureClient();
    if (client && SupabaseConfig.isConfigured()) {
      const dbTipoInicial = (nuevoTipo === 'mercado_credito' && AppState.deudasSupportsMC === false) ? 'prestamo' : nuevoTipo;
      let { error } = await client.from('deudas').update({
        tipo: dbTipoInicial,
        nombre: nombreClean,
        monto_total: total,
        cuotas_totales: cuotasTot,
        cuotas_pagadas: cuotasPag,
        monto_cuota: valorCuota,
        metodo: metodoFinal
      }).eq('id', id);

      if (error && nuevoTipo === 'mercado_credito' && dbTipoInicial === 'mercado_credito') {
        AppState.deudasSupportsMC = false;
        const retry = await client.from('deudas').update({
          tipo: 'prestamo',
          nombre: nombreClean,
          monto_total: total,
          cuotas_totales: cuotasTot,
          cuotas_pagadas: cuotasPag,
          monto_cuota: valorCuota,
          metodo: 'Mercado Crédito'
        }).eq('id', id);
        error = retry.error;
      }

      if (error) {
        console.error('Error al actualizar deuda en Supabase:', error);
        UI.showNotification('Error al actualizar deuda: ' + error.message, 'error');
        return false;
      }
    }

    const listaOriginal = DataService.getDeudaList(tipoOriginal);
    const idx = listaOriginal.findIndex(d => d.id === id);
    if (idx !== -1) {
      const item = listaOriginal[idx];
      item.compra = nombreClean;
      item.prestamo = nombreClean;
      item.monto_total = total;
      item.cuotas_totales = cuotasTot;
      item.cuotas_pagadas = cuotasPag;
      item.monto_cuota = valorCuota;
      item.metodo = metodoFinal;

      if (nuevoTipo !== tipoOriginal) {
        listaOriginal.splice(idx, 1);
        DataService.getDeudaList(nuevoTipo).unshift(item);
      }
    }

    DataService.saveToLocalStorage();
    await DataService.logHistorial('Actualización Deuda', `Actualizado ${nombreClean} (${cuotasPag}/${cuotasTot} cuotas)`, total, metodoFinal);
    UI.renderAll();
    UI.showNotification('Deuda actualizada correctamente', 'success');
    return true;
  },

  async pagarCuotaDeuda(id, tipo, montoAbonado, metodoDebitado) {
    const lista = DataService.getDeudaList(tipo);
    const item = lista.find(d => d.id === id);
    if (!item || item.cuotas_pagadas >= item.cuotas_totales) return false;

    const parsedAbono = DataService.parseMonto(montoAbonado);
    const valMonto = parsedAbono > 0 ? parsedAbono : DataService.parseMonto(item.monto_cuota);
    const bancoDebito = DataService.normalizeMetodo(metodoDebitado || item.metodo || 'Santander');
    const nuevasPagadas = (parseInt(item.cuotas_pagadas, 10) || 0) + 1;

    const client = await DataService.ensureClient();
    if (client && SupabaseConfig.isConfigured()) {
      const { error } = await client.from('deudas').update({
        cuotas_pagadas: nuevasPagadas
      }).eq('id', id);
      if (error) {
        console.error('Error actualizando cuotas en deudas:', error);
        UI.showNotification('No se pudo registrar el pago de cuota: ' + error.message, 'error');
        return false;
      }
    }

    item.cuotas_pagadas = nuevasPagadas;

    if (valMonto > 0 && bancoDebito) {
      await DataService.ajustarCuenta(bancoDebito, -valMonto);
    }

    DataService.saveToLocalStorage();

    const nombre = item.compra || item.prestamo;
    const tipoCategoria = tipo === 'mercado_credito' ? 'Mercado Crédito' : tipo;
    await DataService.logHistorial(
      `Cuota ${tipoCategoria}`,
      `Pago cuota ${item.cuotas_pagadas}/${item.cuotas_totales} de ${nombre}`,
      valMonto,
      bancoDebito
    );

    UI.renderAll();
    UI.showNotification(`Cuota ${item.cuotas_pagadas}/${item.cuotas_totales} abonada (${UI.formatCurrency(valMonto)} de ${bancoDebito})`, 'success');
    return true;
  },

  async deleteDeuda(id, tipo) {
    const lista = DataService.getDeudaList(tipo);
    const item = lista.find(d => d.id === id);
    const client = await DataService.ensureClient();

    if (client && SupabaseConfig.isConfigured()) {
      const { error } = await client.from('deudas').delete().eq('id', id);
      if (error) {
        UI.showNotification('No se pudo eliminar la deuda: ' + error.message, 'error');
        return false;
      }
    }

    DataService.markDeletedId(id);
    if (tipo === 'tarjeta') {
      AppState.data.tarjetas = AppState.data.tarjetas.filter(d => d.id !== id);
    } else if (tipo === 'mercado_credito') {
      AppState.data.mercadoCredito = AppState.data.mercadoCredito.filter(d => d.id !== id);
    } else {
      AppState.data.prestamos = AppState.data.prestamos.filter(d => d.id !== id);
    }
    DataService.saveToLocalStorage();
    if (item) {
      await DataService.logHistorial('Eliminación Deuda', item.compra || item.prestamo, -DataService.parseMonto(item.monto_total), item.metodo);
    }
    UI.renderAll();
    UI.showNotification('Deuda eliminada', 'info');
    return true;
  },

  // -------------------------------------------------------------
  // MÉTODOS DE PAGO
  // -------------------------------------------------------------
  async addMetodo(nombre) {
    const clean = String(nombre || '').trim();
    if (!clean || AppState.data.metodos.includes(clean)) return false;

    const client = await DataService.ensureClient();
    if (client && SupabaseConfig.isConfigured()) {
      const { error } = await client.from('metodos_pago').insert([{ nombre: clean }]);
      if (error) {
        UI.showNotification('No se pudo guardar el método: ' + error.message, 'error');
        return false;
      }
    }
    AppState.data.metodos.push(clean);
    DataService.saveToLocalStorage();
    UI.renderAll();
    UI.showNotification(`Método "${clean}" añadido`, 'success');
    return true;
  },

  async deleteMetodo(nombre) {
    const client = await DataService.ensureClient();
    if (client && SupabaseConfig.isConfigured()) {
      const { error } = await client.from('metodos_pago').delete().eq('nombre', nombre);
      if (error) {
        UI.showNotification('No se pudo eliminar el método: ' + error.message, 'error');
        return false;
      }
    }
    AppState.data.metodos = AppState.data.metodos.filter(m => m !== nombre);
    DataService.saveToLocalStorage();
    UI.renderAll();
    UI.showNotification(`Método "${nombre}" eliminado`, 'info');
    return true;
  },

  // -------------------------------------------------------------
  // RECONCILIACIÓN INTELIGENTE DE SALDO / AJUSTE DE CAPITAL
  // -------------------------------------------------------------
  async reconciliarSaldo(saldoObjetivo, marcarServicios, listaExcluidos, metodo, motivo) {
    const objetivo = DataService.parseMonto(saldoObjetivo);
    if (isNaN(objetivo) || objetivo < 0) return false;
    const metodoFinal = DataService.normalizeMetodo(metodo || 'Santander');
    const motivoFinal = motivo || 'Ajuste de Capital (Reconciliación)';

    if (marcarServicios) {
      const excluidosNorm = (listaExcluidos || []).map(e => String(e).toLowerCase().trim());
      for (const serv of AppState.data.servicios) {
        const nombreServ = (serv.servicio || '').toLowerCase().trim();
        const estaExcluido = excluidosNorm.some(exc => nombreServ.includes(exc) || exc.includes(nombreServ));
        if (!estaExcluido && serv.estado !== 'Pagado') {
          await DataService.toggleServicio(serv.id, metodoFinal);
        }
      }
    }

    const metrics = Calculations.getMetrics();
    const diferencia = Math.round((objetivo - metrics.saldoReal) * 100) / 100;

    if (Math.abs(diferencia) >= 0.01) {
      const cuenta = AppState.data.ingresos.find(i => (i.metodo || '').toLowerCase() === metodoFinal.toLowerCase())
        || AppState.data.ingresos.find(i => (i.metodo || '').toLowerCase().includes('santander'))
        || AppState.data.ingresos[0];

      if (cuenta) {
        const nuevoMonto = Math.max(0, Math.round((DataService.parseMonto(cuenta.monto) + diferencia) * 100) / 100);
        const client = await DataService.ensureClient();
        if (client && SupabaseConfig.isConfigured()) {
          const { error } = await client.from('ingresos').update({ monto: nuevoMonto }).eq('id', cuenta.id);
          if (error) {
            UI.showNotification('Error al ajustar saldo en Supabase: ' + error.message, 'error');
            return false;
          }
        }
        cuenta.monto = nuevoMonto;
        await DataService.logHistorial('Ajuste Capital', motivoFinal, diferencia, cuenta.metodo || metodoFinal);
      } else {
        await DataService.addIngreso(motivoFinal, Math.max(0, objetivo), metodoFinal);
      }
    }

    DataService.saveToLocalStorage();
    UI.showNotification(`Capital actualizado a ${UI.formatCurrency(objetivo)}`, 'success');
    UI.renderAll();
    return true;
  },

  // -------------------------------------------------------------
  // INVERSIONES (Supabase opcional + respaldo localStorage)
  // -------------------------------------------------------------
  async addInversion({ nombre, tipo, plataforma, monto_invertido, valor_actual, moneda, notas }) {
    const invertido = DataService.parseMonto(monto_invertido);
    const actualRaw = DataService.parseMonto(valor_actual);
    const actual = actualRaw > 0 ? actualRaw : invertido;
    if (!nombre || invertido <= 0) {
      UI.showNotification('Ingresa un nombre y monto válido para la inversión', 'warning');
      return false;
    }

    const rendimientoPct = invertido > 0 ? Math.round(((actual - invertido) / invertido) * 1000) / 10 : 0;
    const payload = {
      nombre: String(nombre).trim(),
      tipo: tipo || 'Renta Fija',
      plataforma: plataforma ? String(plataforma).trim() : 'General',
      monto_invertido: invertido,
      valor_actual: actual,
      moneda: moneda || 'ARS',
      rendimiento_pct: rendimientoPct,
      fecha: getTodayString(),
      notas: notas ? String(notas).trim() : ''
    };

    let inserted = { id: 'inv-' + Date.now(), ...payload };
    const client = await DataService.ensureClient();

    if (client && SupabaseConfig.isConfigured() && AppState.hasInversionesTable !== false) {
      try {
        const { data, error } = await client.from('inversiones').insert([payload]).select();
        if (error) {
          if (error.code === 'PGRST205' || String(error.message || '').includes('inversiones')) {
            AppState.hasInversionesTable = false;
          }
        } else if (data && data[0]) {
          inserted = {
            ...data[0],
            monto_invertido: DataService.parseMonto(data[0].monto_invertido),
            valor_actual: DataService.parseMonto(data[0].valor_actual),
            rendimiento_pct: DataService.parseMonto(data[0].rendimiento_pct, true)
          };
        }
      } catch (e) {
        AppState.hasInversionesTable = false;
      }
    }

    if (!Array.isArray(AppState.data.inversiones)) AppState.data.inversiones = [];
    AppState.data.inversiones.unshift(inserted);
    DataService.saveLocalInversiones(AppState.data.inversiones);
    DataService.saveToLocalStorage();

    await DataService.logHistorial('Inversión', `${payload.nombre} (${payload.tipo})`, invertido, payload.plataforma);
    UI.renderAll();
    UI.showNotification(`Inversión "${payload.nombre}" registrada`, 'success');
    return true;
  },

  async deleteInversion(id) {
    const client = await DataService.ensureClient();
    if (client && SupabaseConfig.isConfigured() && AppState.hasInversionesTable !== false) {
      try {
        await client.from('inversiones').delete().eq('id', id);
      } catch (e) {}
    }

    AppState.data.inversiones = (AppState.data.inversiones || []).filter(i => String(i.id) !== String(id));
    DataService.saveLocalInversiones(AppState.data.inversiones);
    DataService.saveToLocalStorage();
    UI.renderAll();
    UI.showNotification('Inversión eliminada', 'info');
    return true;
  }
};

// ==============================================================================
// 2. CÁLCULOS Y MÉTRICAS FINANCIERAS
// ==============================================================================

const Calculations = {
  parseDateParts(dateString) {
    if (!dateString) return null;
    if (dateString instanceof Date && !isNaN(dateString.getTime())) {
      return { year: dateString.getFullYear(), month: dateString.getMonth() + 1, day: dateString.getDate() };
    }
    const cleanStr = String(dateString).trim().split('T')[0].split(' ')[0];

    if (cleanStr.includes('-')) {
      const parts = cleanStr.split('-');
      if (parts.length === 3) {
        if (parts[0].length === 4) {
          return { year: parseInt(parts[0], 10), month: parseInt(parts[1], 10), day: parseInt(parts[2], 10) };
        }
        if (parts[2].length === 4) {
          return { year: parseInt(parts[2], 10), month: parseInt(parts[1], 10), day: parseInt(parts[0], 10) };
        }
      } else if (parts.length === 2) {
        return { year: parseInt(parts[0], 10), month: parseInt(parts[1], 10), day: 1 };
      }
    }

    if (cleanStr.includes('/')) {
      const parts = cleanStr.split('/');
      if (parts.length === 3) {
        if (parts[2].length === 4) {
          return { year: parseInt(parts[2], 10), month: parseInt(parts[1], 10), day: parseInt(parts[0], 10) };
        }
        if (parts[0].length === 4) {
          return { year: parseInt(parts[0], 10), month: parseInt(parts[1], 10), day: parseInt(parts[2], 10) };
        }
      } else if (parts.length === 2) {
        const now = new Date();
        return { year: now.getFullYear(), month: parseInt(parts[1], 10), day: parseInt(parts[0], 10) || 1 };
      }
    }

    const d = new Date(dateString);
    if (!isNaN(d.getTime())) {
      return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
    }
    return null;
  },

  isCurrentMonth(dateString) {
    if (!dateString) return true;
    const now = new Date();
    const curYear = now.getFullYear();
    const curMonth = now.getMonth() + 1;
    const parsed = Calculations.parseDateParts(dateString);
    if (parsed) {
      return parsed.year === curYear && parsed.month === curMonth;
    }
    return false;
  },

  getMetrics() {
    const now = new Date();
    const curYear = now.getFullYear();
    const curMonth = now.getMonth() + 1;
    const todayDay = now.getDate();
    const lastDayOfMonth = new Date(curYear, curMonth, 0).getDate();
    const diasRestantesMes = Math.max(1, (lastDayOfMonth - todayDay) + 1);

    // Total fondos registrados en cuentas y bancos del usuario
    const totalIngresos = (AppState.data.ingresos || [])
      .reduce((sum, i) => sum + (parseFloat(i.monto) || 0), 0);

    // Desglose por cuenta / billetera
    const walletMap = {};
    (AppState.data.ingresos || []).forEach(i => {
      const key = (i.metodo || i.descripcion || 'General').trim();
      walletMap[key] = (walletMap[key] || 0) + (parseFloat(i.monto) || 0);
    });
    const cuentasDesglose = Object.entries(walletMap)
      .map(([metodo, monto]) => ({
        metodo,
        monto,
        pct: totalIngresos > 0 ? Math.round((monto / totalIngresos) * 100) : 0
      }))
      .sort((a, b) => b.monto - a.monto);

    // Gastos diarios del mes actual
    const diariosMes = (AppState.data.diarios || []).filter(d => Calculations.isCurrentMonth(d.fecha));
    const totalGastosDiarios = diariosMes.reduce((sum, d) => sum + (parseFloat(d.monto) || 0), 0);

    let totalServiciosPagados = 0;
    let totalServiciosPendientes = 0;
    let totalServicios = 0;
    const compromisosPendientes = [];

    (AppState.data.servicios || []).forEach(s => {
      const monto = parseFloat(s.monto) || 0;
      totalServicios += monto;
      if (s.estado === 'Pagado') {
        totalServiciosPagados += monto;
      } else {
        totalServiciosPendientes += monto;
        const venc = parseInt(s.vencimiento, 10) || 1;
        compromisosPendientes.push({
          id: s.id,
          tipo: 'servicio',
          nombre: s.servicio,
          detalle: `Servicio fijo • Vence día ${venc}`,
          monto,
          vencimiento: venc,
          diasRestantes: venc - todayDay,
          metodo: s.metodo_pago || 'Pendiente'
        });
      }
    });

    const isCuotaPagadaEsteMes = (item) => {
      const pagadas = parseInt(item.cuotas_pagadas, 10) || 0;
      const totales = parseInt(item.cuotas_totales, 10) || 1;
      if (pagadas <= 0) return false;

      const nombre = (item.compra || item.prestamo || '').toLowerCase().trim();
      if (!nombre) return false;
      const fraseExacta = `pago cuota ${pagadas}/${totales} de ${nombre}`;
      const cuotaItem = Math.round(DataService.parseMonto(item.monto_cuota));

      return (AppState.data.historial || []).some(h => {
        if (!(h.categoria || '').toLowerCase().includes('cuota')) return false;
        if (!Calculations.isCurrentMonth(h.fecha_iso || h.fecha)) return false;
        const desc = (h.descripcion || '').toLowerCase().trim();
        if (desc === fraseExacta || desc.startsWith(fraseExacta)) {
          const montoHist = Math.round(Math.abs(DataService.parseMonto(h.monto, true)));
          return cuotaItem === 0 || Math.abs(montoHist - cuotaItem) <= Math.max(500, cuotaItem * 0.2);
        }
        return false;
      });
    };

    let cuotasTarjetas = 0;
    (AppState.data.tarjetas || []).forEach(t => {
      if ((t.cuotas_pagadas || 0) >= t.cuotas_totales) return;
      if (isCuotaPagadaEsteMes(t)) return;
      const cuota = parseFloat(t.monto_cuota) || 0;
      cuotasTarjetas += cuota;
      compromisosPendientes.push({
        id: t.id,
        tipo: 'tarjeta',
        nombre: t.compra,
        detalle: `Tarjeta • Cuota ${(t.cuotas_pagadas || 0) + 1}/${t.cuotas_totales}`,
        monto: cuota,
        vencimiento: 99,
        diasRestantes: 99,
        metodo: t.metodo || 'Tarjeta de Crédito'
      });
    });

    let cuotasMercadoCredito = 0;
    (AppState.data.mercadoCredito || []).forEach(mc => {
      if ((mc.cuotas_pagadas || 0) >= mc.cuotas_totales) return;
      if (isCuotaPagadaEsteMes(mc)) return;
      const cuota = parseFloat(mc.monto_cuota) || 0;
      cuotasMercadoCredito += cuota;
      compromisosPendientes.push({
        id: mc.id,
        tipo: 'mercado_credito',
        nombre: mc.compra || mc.prestamo,
        detalle: `Mercado Crédito • Cuota ${(mc.cuotas_pagadas || 0) + 1}/${mc.cuotas_totales}`,
        monto: cuota,
        vencimiento: 99,
        diasRestantes: 99,
        metodo: mc.metodo || 'Mercado Crédito'
      });
    });

    let cuotasPrestamos = 0;
    (AppState.data.prestamos || []).forEach(p => {
      if ((p.cuotas_pagadas || 0) >= p.cuotas_totales) return;
      if (isCuotaPagadaEsteMes(p)) return;
      const cuota = parseFloat(p.monto_cuota) || 0;
      cuotasPrestamos += cuota;
      compromisosPendientes.push({
        id: p.id,
        tipo: 'prestamo',
        nombre: p.prestamo,
        detalle: `Préstamo • Cuota ${(p.cuotas_pagadas || 0) + 1}/${p.cuotas_totales}`,
        monto: cuota,
        vencimiento: 99,
        diasRestantes: 99,
        metodo: p.metodo || 'General'
      });
    });

    compromisosPendientes.sort((a, b) => a.diasRestantes - b.diasRestantes);

    const cuotasPagadasMes = (AppState.data.historial || [])
      .filter(h => (h.categoria || '').toLowerCase().includes('cuota') && Calculations.isCurrentMonth(h.fecha))
      .reduce((sum, h) => sum + Math.abs(parseFloat(h.monto) || 0), 0);

    const totalCuotasPendientes = cuotasTarjetas + cuotasMercadoCredito + cuotasPrestamos;
    const totalPorPagar = totalServiciosPendientes + totalCuotasPendientes;
    const totalGastosMes = totalGastosDiarios + totalServiciosPagados + cuotasPagadasMes;

    // Saldo real disponible = Dinero real actual en todas las cuentas y bancos registrados
    const saldoReal = totalIngresos;

    // Saldo proyectado al final del mes = Dinero en mano menos obligaciones pendientes
    const saldoProyectado = saldoReal - totalPorPagar;
    const llegaBien = saldoProyectado >= 0;

    // Cobertura / Margen libre para el gauge radial
    let coberturaPct = 100;
    if (llegaBien) {
      coberturaPct = saldoReal > 0 ? Math.max(0, Math.min(100, Math.round((saldoProyectado / saldoReal) * 100))) : (totalPorPagar === 0 ? 100 : 0);
    } else {
      coberturaPct = totalPorPagar > 0 ? Math.max(0, Math.min(99, Math.round((saldoReal / totalPorPagar) * 100))) : 0;
    }

    const presupuestoDiarioSeguro = saldoProyectado > 0 ? saldoProyectado / diasRestantesMes : 0;

    // Flujo Semanal del Mes (Sem 1..Sem 4) usando historial + diarios + ingresos del mes
    const semanaIngresos = [0, 0, 0, 0];
    const semanaGastos = [0, 0, 0, 0];
    const weekIdxForDay = (day) => (day <= 7 ? 0 : day <= 14 ? 1 : day <= 21 ? 2 : 3);

    diariosMes.forEach(d => {
      const p = Calculations.parseDateParts(d.fecha);
      const idx = weekIdxForDay(p ? p.day : todayDay);
      semanaGastos[idx] += parseFloat(d.monto) || 0;
    });

    (AppState.data.servicios || []).forEach(s => {
      if (s.estado === 'Pagado') {
        const p = Calculations.parseDateParts(s.fecha_pago);
        if (!s.fecha_pago || (p && p.year === curYear && p.month === curMonth)) {
          const idx = weekIdxForDay(p ? p.day : (parseInt(s.vencimiento, 10) || todayDay));
          semanaGastos[idx] += parseFloat(s.monto) || 0;
        }
      }
    });

    const historialIngresosMes = (AppState.data.historial || []).filter(h =>
      (h.categoria || '').toLowerCase() === 'ingreso' && Calculations.isCurrentMonth(h.fecha)
    );
    if (historialIngresosMes.length > 0) {
      historialIngresosMes.forEach(h => {
        const p = Calculations.parseDateParts(h.fecha);
        const idx = weekIdxForDay(p ? p.day : todayDay);
        semanaIngresos[idx] += parseFloat(h.monto) || 0;
      });
    } else {
      (AppState.data.ingresos || []).forEach(i => {
        const p = Calculations.parseDateParts(i.fecha);
        const idx = (p && p.year === curYear && p.month === curMonth) ? weekIdxForDay(p.day) : 0;
        semanaIngresos[idx] += parseFloat(i.monto) || 0;
      });
    }

    // Gastos por Método / Cuenta (mes actual)
    const gastoMetodoMap = {};
    diariosMes.forEach(d => {
      const m = (d.metodo || 'General').trim();
      gastoMetodoMap[m] = (gastoMetodoMap[m] || 0) + (parseFloat(d.monto) || 0);
    });
    (AppState.data.servicios || []).forEach(s => {
      if (s.estado === 'Pagado') {
        const m = (s.metodo_pago || 'General').trim();
        gastoMetodoMap[m] = (gastoMetodoMap[m] || 0) + (parseFloat(s.monto) || 0);
      }
    });
    const totalGastosPorMetodo = Object.values(gastoMetodoMap).reduce((a, b) => a + b, 0);
    const gastosPorMetodo = Object.entries(gastoMetodoMap)
      .map(([metodo, monto]) => ({
        metodo,
        monto,
        pct: totalGastosPorMetodo > 0 ? Math.round((monto / totalGastosPorMetodo) * 100) : 0
      }))
      .sort((a, b) => b.monto - a.monto)
      .slice(0, 5);

    // Inversiones & Patrimonio Neto
    const inversiones = AppState.data.inversiones || [];
    const inversionesCapital = inversiones.reduce((sum, inv) => sum + (parseFloat(inv.monto_invertido) || 0), 0);
    const inversionesValorActual = inversiones.reduce((sum, inv) => sum + (parseFloat(inv.valor_actual) || parseFloat(inv.monto_invertido) || 0), 0);
    const inversionesGanancia = inversionesValorActual - inversionesCapital;
    const inversionesRendimientoPct = inversionesCapital > 0
      ? Math.round((inversionesGanancia / inversionesCapital) * 1000) / 10
      : 0;
    const patrimonioTotalNeto = saldoReal + inversionesValorActual;

    return {
      totalIngresos,
      totalGastosDiarios,
      totalServicios,
      totalServiciosPagados,
      totalServiciosPendientes,
      cuotasTarjetas,
      cuotasMercadoCredito,
      cuotasPrestamos,
      totalCuotasPendientes,
      totalPorPagar,
      totalGastosMes,
      cuotasPagadasMes,
      saldoReal,
      saldoProyectado,
      llegaBien,
      coberturaPct,
      diasRestantesMes,
      presupuestoDiarioSeguro,
      cuentasDesglose,
      flujoSemanal: {
        labels: ['Sem 1', 'Sem 2', 'Sem 3', 'Sem 4'],
        ingresos: semanaIngresos,
        gastos: semanaGastos
      },
      gastosPorMetodo,
      totalGastosPorMetodo,
      compromisosPendientes,
      inversionesCapital,
      inversionesValorActual,
      inversionesGanancia,
      inversionesRendimientoPct,
      patrimonioTotalNeto
    };
  }
};

// ==============================================================================
// 3. INTERFAZ DE USUARIO Y RENDERIZADO (UI)
// ==============================================================================

const UI = {
  formatCurrency(val) {
    const num = parseFloat(val) || 0;
    const abs = Math.round(Math.abs(num)).toLocaleString('es-AR');
    return num < 0 ? '-$' + abs : '$' + abs;
  },

  updateSyncTimestamp() {
    const el = document.getElementById('sync-last-update');
    if (!el || !AppState.lastSyncAt) return;
    const hh = String(AppState.lastSyncAt.getHours()).padStart(2, '0');
    const mm = String(AppState.lastSyncAt.getMinutes()).padStart(2, '0');
    el.textContent = `Actualizado ${hh}:${mm}`;
  },

  updateSheetsSyncBadge() {
    const badge = document.getElementById('sheets-sync-badge');
    if (!badge) return;
    const sheetId = typeof SupabaseConfig.getGoogleSheetId === 'function' ? SupabaseConfig.getGoogleSheetId() : '';
    if (sheetId) {
      badge.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20';
      badge.innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span> Sheets + Supabase Activo';
    } else {
      badge.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-amber-500/10 text-amber-300 border border-amber-500/20';
      badge.innerHTML = '<span class="w-2 h-2 rounded-full bg-amber-400"></span> Solo Supabase';
    }
  },

  updateMonthLabel() {
    const el = document.getElementById('header-current-month');
    if (!el) return;
    const meses = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
    const now = new Date();
    el.textContent = `${meses[now.getMonth()]} ${now.getFullYear()}`;
  },

  renderAll() {
    const m = Calculations.getMetrics();
    UI.updateMonthLabel();
    UI.renderDashboard(m);
    UI.renderDiarios();
    UI.renderServicios();
    UI.renderDeudas();
    UI.renderInversiones(m);
    UI.renderHistorial();
    UI.renderMetodosSelects();
    UI.renderMetodosList();
  },

  renderDashboard(metricsArg) {
    const m = metricsArg || Calculations.getMetrics();

    const elSaldoReal = document.getElementById('metric-saldo-real');
    const elIngresos = document.getElementById('metric-ingresos');
    const elGastosMes = document.getElementById('metric-gastos-mes');
    const elGastosDiarios = document.getElementById('metric-gastos-diarios');
    const elServiciosFijos = document.getElementById('metric-servicios-fijos');
    const elServiciosPendientes = document.getElementById('metric-servicios-pendientes');
    const elTotalPorPagar = document.getElementById('metric-total-por-pagar');
    const elSaldoProyectado = document.getElementById('metric-saldo-proyectado');

    if (elSaldoReal) elSaldoReal.textContent = UI.formatCurrency(m.saldoReal);
    if (elIngresos) elIngresos.textContent = UI.formatCurrency(m.totalIngresos);
    if (elGastosMes) elGastosMes.textContent = UI.formatCurrency(m.totalGastosMes);
    if (elGastosDiarios) elGastosDiarios.textContent = UI.formatCurrency(m.totalGastosDiarios);
    if (elServiciosFijos) elServiciosFijos.textContent = UI.formatCurrency(m.totalServicios);
    if (elServiciosPendientes) elServiciosPendientes.textContent = UI.formatCurrency(m.totalServiciosPendientes);
    if (elTotalPorPagar) elTotalPorPagar.textContent = UI.formatCurrency(m.totalPorPagar);
    if (elSaldoProyectado) {
      elSaldoProyectado.textContent = (m.saldoProyectado > 0 ? '+' : '') + UI.formatCurrency(m.saldoProyectado);
    }

    UI.renderWalletsBreakdown(m);
    UI.renderFinDeMesCard(m);
    UI.renderChart(m);
    UI.renderFlowChart(m);
    UI.renderGastosPorMetodo(m);
    UI.renderPendingCompromisos(m);
    UI.renderDashboardInversiones(m);
    UI.renderDashboardIngresos();
  },

  renderWalletsBreakdown(m) {
    const container = document.getElementById('dashboard-wallets-grid');
    if (!container) return;

    const cuentas = m.cuentasDesglose || [];
    if (cuentas.length === 0) {
      container.innerHTML = `
        <div class="col-span-3 p-3.5 rounded-xl glass-subcard text-xs text-slate-400 flex items-center gap-2">
          <i class="fa-solid fa-wallet text-sky-400"></i>
          <span>Aún no hay cuentas o billeteras con saldo registradas en Google Sheets.</span>
        </div>`;
      return;
    }

    const barColors = ['bg-cyan-400', 'bg-blue-500', 'bg-sky-400', 'bg-emerald-400', 'bg-indigo-400'];
    container.innerHTML = cuentas.slice(0, 6).map((c, idx) => {
      const color = barColors[idx % barColors.length];
      return `
        <div class="p-3.5 rounded-xl glass-subcard flex flex-col justify-between">
          <div class="flex items-center justify-between gap-2 mb-1.5">
            <span class="text-[11px] font-medium text-slate-300 flex items-center gap-1.5 truncate">
              <span class="w-2 h-2 rounded-full ${color} shrink-0"></span>
              <span class="truncate">${c.metodo}</span>
            </span>
            <span class="text-[10px] font-semibold text-slate-400 shrink-0">${c.pct}%</span>
          </div>
          <div class="text-sm sm:text-base font-bold text-white">${UI.formatCurrency(c.monto)}</div>
          <div class="w-full bg-slate-800/90 h-1.5 rounded-full mt-2 overflow-hidden">
            <div class="${color} h-full rounded-full transition-all duration-500" style="width: ${Math.max(4, c.pct)}%"></div>
          </div>
        </div>`;
    }).join('');
  },

  renderFinDeMesCard(m) {
    const badge = document.getElementById('status-fin-mes-badge');
    const arc = document.getElementById('gauge-circle-arc');
    const pctLabel = document.getElementById('gauge-pct-label');
    const subLabel = document.getElementById('gauge-sub-label');
    const dispEl = document.getElementById('metric-disponible-comp');
    const pendEl = document.getElementById('metric-pendiente-comp');
    const cuotasEl = document.getElementById('metric-cuotas-pendientes');
    const resBox = document.getElementById('fin-mes-result-box');
    const resLabel = document.getElementById('fin-mes-result-label');
    const resVal = document.getElementById('metric-saldo-proyectado');
    const presDiarioEl = document.getElementById('metric-presupuesto-diario');
    const diasRestEl = document.getElementById('metric-dias-restantes');

    if (dispEl) dispEl.textContent = UI.formatCurrency(m.saldoReal);
    if (pendEl) pendEl.textContent = '-' + UI.formatCurrency(m.totalPorPagar);
    if (cuotasEl) cuotasEl.textContent = UI.formatCurrency(m.totalCuotasPendientes);
    if (diasRestEl) diasRestEl.textContent = m.diasRestantesMes;
    if (presDiarioEl) presDiarioEl.textContent = UI.formatCurrency(m.presupuestoDiarioSeguro);

    const circumference = 301.6;
    const pct = Math.max(0, Math.min(100, m.coberturaPct));
    if (arc) {
      arc.setAttribute('stroke-dashoffset', String(circumference - (circumference * pct) / 100));
    }
    if (pctLabel) pctLabel.textContent = `${pct}%`;

    if (m.llegaBien) {
      const holgado = m.coberturaPct >= 25 || m.totalPorPagar === 0;
      if (subLabel) subLabel.textContent = 'Libre post-pagos';
      if (badge) {
        badge.className = holgado
          ? 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/15 border border-emerald-400/30 text-emerald-300 text-[11px] font-semibold shrink-0'
          : 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-sky-500/15 border border-sky-400/30 text-sky-300 text-[11px] font-semibold shrink-0';
        badge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full ${holgado ? 'bg-emerald-400' : 'bg-sky-400'}"></span> ${holgado ? 'Llegás holgado' : 'Llegás justo'}`;
      }
      if (resBox) resBox.className = 'p-2.5 rounded-xl bg-blue-600/15 border border-cyan-400/30 flex items-center justify-between';
      if (resLabel) {
        resLabel.className = 'text-xs font-semibold text-cyan-300';
        resLabel.textContent = 'Te sobra al cierre';
      }
      if (resVal) resVal.className = 'text-base font-extrabold text-emerald-400';
    } else {
      if (subLabel) subLabel.textContent = 'Cubierto hoy';
      if (badge) {
        badge.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-rose-500/15 border border-rose-400/35 text-rose-300 text-[11px] font-semibold shrink-0';
        badge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-rose-400"></span> Falta para el mes`;
      }
      if (resBox) resBox.className = 'p-2.5 rounded-xl bg-rose-500/15 border border-rose-400/35 flex items-center justify-between';
      if (resLabel) {
        resLabel.className = 'text-xs font-semibold text-rose-300';
        resLabel.textContent = 'Te falta cubrir';
      }
      if (resVal) resVal.className = 'text-base font-extrabold text-rose-400';
    }
  },

  renderDashboardIngresos() {
    const container = document.getElementById('dashboard-recent-ingresos');
    if (!container) return;

    if (!AppState.data.ingresos || AppState.data.ingresos.length === 0) {
      container.innerHTML = `
        <div class="text-center py-6 text-slate-400 glass-subcard rounded-2xl">
          <i class="fa-solid fa-wallet text-2xl mb-1.5 text-sky-400/60"></i>
          <p class="text-xs">No hay fondos o ingresos registrados todavía.</p>
        </div>`;
      return;
    }

    container.innerHTML = AppState.data.ingresos.map(i => `
      <div class="flex items-center justify-between p-3.5 glass-subcard rounded-xl hover:border-sky-400/30 transition">
        <div class="flex items-center gap-3">
          <div class="w-8 h-8 rounded-lg bg-cyan-500/10 border border-cyan-400/20 text-cyan-300 flex items-center justify-center font-bold text-xs">
            <i class="fa-solid fa-building-columns"></i>
          </div>
          <div>
            <h4 class="text-sm font-semibold text-white">${i.descripcion}</h4>
            <span class="text-xs text-slate-400">${i.metodo || 'General'} • ${i.fecha || ''}</span>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-sm font-bold text-emerald-400">${UI.formatCurrency(i.monto)}</span>
          <button onclick="DataService.deleteIngreso('${i.id}')" class="text-slate-500 hover:text-rose-400 p-1.5 transition" title="Eliminar registro">
            <i class="fa-regular fa-trash-can text-xs"></i>
          </button>
        </div>
      </div>
    `).join('');
  },

  renderChart(m) {
    const ctx = document.getElementById('financeChart');
    if (!ctx) return;

    if (AppState.chartInstance) {
      AppState.chartInstance.destroy();
    }

    const values = [
      Math.max(0, m.totalGastosDiarios),
      Math.max(0, m.totalServiciosPagados),
      Math.max(0, m.totalServiciosPendientes),
      Math.max(0, m.cuotasTarjetas + (m.cuotasMercadoCredito || 0) + m.cuotasPrestamos),
      Math.max(0, m.saldoProyectado)
    ];

    AppState.chartInstance = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['Gastos Diarios', 'Fijos Pagados', 'Fijos por Pagar', 'Cuotas Deudas', 'Libre Proyectado'],
        datasets: [{
          data: values.some(v => v > 0) ? values : [1],
          backgroundColor: values.some(v => v > 0)
            ? ['#2563EB', '#38BDF8', '#0284C7', '#818CF8', '#10B981']
            : ['#1E3A5F'],
          borderWidth: 0,
          hoverOffset: 6
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: { color: '#94A3B8', boxWidth: 10, padding: 12, font: { family: 'Plus Jakarta Sans', size: 11 } }
          }
        },
        cutout: '70%'
      }
    });
  },

  renderFlowChart(m) {
    const ctx = document.getElementById('flowChart');
    if (!ctx) return;

    if (AppState.flowChartInstance) {
      AppState.flowChartInstance.destroy();
    }

    const flujo = m.flujoSemanal || { labels: ['Sem 1', 'Sem 2', 'Sem 3', 'Sem 4'], ingresos: [0, 0, 0, 0], gastos: [0, 0, 0, 0] };

    AppState.flowChartInstance = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: flujo.labels,
        datasets: [
          {
            label: 'Ingresos / Fondos',
            data: flujo.ingresos,
            backgroundColor: '#38BDF8',
            borderRadius: 6,
            barPercentage: 0.65
          },
          {
            label: 'Gastos',
            data: flujo.gastos,
            backgroundColor: '#2563EB',
            borderRadius: 6,
            barPercentage: 0.65
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: { color: '#94A3B8', boxWidth: 10, font: { family: 'Plus Jakarta Sans', size: 11 } }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: '#94A3B8', font: { size: 11 } }
          },
          y: {
            grid: { color: 'rgba(56, 189, 248, 0.08)' },
            ticks: {
              color: '#64748B',
              font: { size: 10 },
              callback: (v) => '$' + Math.round(v / 1000) + 'k'
            }
          }
        }
      }
    });
  },

  renderGastosPorMetodo(m) {
    const container = document.getElementById('dashboard-gastos-metodo');
    const totalEl = document.getElementById('metric-total-ejecutado');
    if (totalEl) totalEl.textContent = UI.formatCurrency(m.totalGastosPorMetodo || 0);
    if (!container) return;

    const list = m.gastosPorMetodo || [];
    if (list.length === 0) {
      container.innerHTML = `<div class="py-8 text-center text-xs text-slate-400">Sin gastos ejecutados en el mes actual.</div>`;
      return;
    }

    const barClasses = ['bg-cyan-400', 'bg-blue-500', 'bg-sky-400', 'bg-indigo-400', 'bg-emerald-400'];
    container.innerHTML = list.map((item, idx) => `
      <div>
        <div class="flex justify-between text-xs mb-1">
          <span class="text-slate-300 truncate pr-2">${item.metodo}</span>
          <span class="font-semibold text-white shrink-0">${UI.formatCurrency(item.monto)} <span class="text-slate-400 font-normal">(${item.pct}%)</span></span>
        </div>
        <div class="h-2 w-full bg-slate-800/80 rounded-full overflow-hidden">
          <div class="h-full ${barClasses[idx % barClasses.length]} rounded-full transition-all duration-500" style="width: ${Math.max(4, item.pct)}%"></div>
        </div>
      </div>
    `).join('');
  },

  renderPendingCompromisos(m) {
    const container = document.getElementById('dashboard-pending-list');
    const countEl = document.getElementById('pending-count-badge');
    const sumEl = document.getElementById('pending-sum-badge');
    const items = m.compromisosPendientes || [];

    if (countEl) countEl.textContent = `${items.length} ${items.length === 1 ? 'pendiente' : 'pendientes'}`;
    if (sumEl) sumEl.textContent = `Suma: ${UI.formatCurrency(m.totalPorPagar)}`;
    if (!container) return;

    if (items.length === 0) {
      container.innerHTML = `
        <div class="py-6 text-center text-xs text-emerald-300 flex items-center justify-center gap-2">
          <i class="fa-solid fa-circle-check text-emerald-400 text-base"></i>
          <span>¡Al día! No tienes servicios ni cuotas pendientes por cubrir este mes.</span>
        </div>`;
      return;
    }

    container.innerHTML = items.map(item => {
      let badgeHtml = `<span class="px-2.5 py-0.5 rounded-full bg-sky-500/15 border border-sky-400/30 text-sky-300 text-[11px] font-semibold">Pendiente</span>`;
      if (item.tipo === 'servicio') {
        if (item.diasRestantes < 0) {
          badgeHtml = `<span class="px-2.5 py-0.5 rounded-full bg-rose-500/15 border border-rose-400/30 text-rose-300 text-[11px] font-semibold">Vencido (Día ${item.vencimiento})</span>`;
        } else if (item.diasRestantes <= 5) {
          badgeHtml = `<span class="px-2.5 py-0.5 rounded-full bg-amber-500/15 border border-amber-400/30 text-amber-300 text-[11px] font-semibold">${item.diasRestantes === 0 ? 'Vence hoy' : `Vence en ${item.diasRestantes} días`}</span>`;
        } else {
          badgeHtml = `<span class="px-2.5 py-0.5 rounded-full bg-sky-500/15 border border-sky-400/30 text-sky-300 text-[11px] font-semibold">Vence en ${item.diasRestantes} días</span>`;
        }
      }

      const iconClass = item.tipo === 'tarjeta' ? 'fa-credit-card text-sky-300 bg-blue-500/15 border-sky-400/25'
        : item.tipo === 'mercado_credito' ? 'fa-bolt text-amber-300 bg-amber-500/15 border-amber-400/25'
        : item.tipo === 'prestamo' ? 'fa-hand-holding-dollar text-cyan-300 bg-cyan-500/15 border-cyan-400/25'
        : 'fa-file-invoice text-amber-300 bg-amber-500/10 border-amber-400/25';

      return `
        <div class="py-3 flex items-center justify-between gap-3">
          <div class="flex items-center gap-3 min-w-0">
            <div class="w-9 h-9 rounded-xl border ${iconClass} flex items-center justify-center shrink-0">
              <i class="fa-solid ${iconClass.split(' ')[0]} text-sm"></i>
            </div>
            <div class="min-w-0">
              <h4 class="text-sm font-semibold text-white truncate">${item.nombre}</h4>
              <span class="text-[11px] text-slate-400 block truncate">${item.detalle} • ${item.metodo}</span>
            </div>
          </div>
          <div class="flex items-center gap-3 shrink-0">
            <div class="text-right">
              <div class="text-sm font-bold text-white">${UI.formatCurrency(item.monto)}</div>
              <div class="mt-0.5 hidden sm:block">${badgeHtml}</div>
            </div>
          </div>
        </div>`;
    }).join('');
  },

  renderDashboardInversiones(m) {
    const capEl = document.getElementById('dash-inv-capital');
    const rendEl = document.getElementById('dash-inv-rendimiento');
    const netEl = document.getElementById('dash-patrimonio-neto');
    const grid = document.getElementById('dashboard-inversiones-grid');
    const statusText = document.getElementById('dash-inv-status-text');

    if (capEl) capEl.textContent = UI.formatCurrency(m.inversionesCapital);
    if (rendEl) {
      const sign = m.inversionesRendimientoPct >= 0 ? '+' : '';
      rendEl.textContent = `${sign}${m.inversionesRendimientoPct}%`;
      rendEl.className = `text-lg sm:text-xl font-bold ${m.inversionesRendimientoPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`;
    }
    if (netEl) netEl.textContent = UI.formatCurrency(m.patrimonioTotalNeto);
    if (!grid) return;

    const list = AppState.data.inversiones || [];
    if (list.length === 0) {
      if (statusText) statusText.textContent = 'Sección lista para tus próximas inversiones: cuando empieces a invertir, verás cada activo aquí';
      const slots = [
        { cat: 'Renta Fija', badge: 'Disponible', title: 'Plazo Fijo / Letras', desc: 'Tasa fija, UVA o cauciones' },
        { cat: 'Renta Variable', badge: 'Disponible', title: 'CEDEARs & Acciones', desc: 'S&P 500, ETFs y empresas' },
        { cat: 'Money Market', badge: 'T+0', title: 'Fondos Comunes (FCI)', desc: 'Liquidez diaria remunerada' },
        { cat: 'Divisas / Digital', badge: 'Futuro', title: 'Dólares & Criptoactivos', desc: 'Reserva de valor a largo plazo' }
      ];
      grid.innerHTML = slots.map(s => `
        <div onclick="UI.switchTab('inversiones')" class="cursor-pointer p-4 rounded-xl glass-subcard hover:border-cyan-400/40 transition-all group">
          <div class="flex items-center justify-between mb-2">
            <span class="text-[11px] font-medium text-slate-400">${s.cat}</span>
            <span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-sky-500/15 text-sky-300 border border-sky-400/20">${s.badge}</span>
          </div>
          <div class="text-sm font-bold text-white group-hover:text-cyan-300 transition">${s.title}</div>
          <div class="text-xl font-extrabold text-slate-500 my-1.5">$0</div>
          <div class="text-[11px] text-slate-400 truncate">${s.desc}</div>
        </div>
      `).join('');
      return;
    }

    if (statusText) statusText.textContent = `${list.length} ${list.length === 1 ? 'activo monitoreado' : 'activos monitoreados'} en tu portafolio`;
    grid.innerHTML = list.slice(0, 4).map(inv => {
      const actual = parseFloat(inv.valor_actual) || parseFloat(inv.monto_invertido) || 0;
      const gan = actual - (parseFloat(inv.monto_invertido) || 0);
      const pct = inv.monto_invertido > 0 ? Math.round((gan / inv.monto_invertido) * 1000) / 10 : 0;
      const pos = gan >= 0;
      return `
        <div class="p-4 rounded-xl glass-subcard hover:border-cyan-400/40 transition">
          <div class="flex items-center justify-between mb-2">
            <span class="text-[11px] text-slate-400 truncate">${inv.tipo || 'Inversión'}</span>
            <span class="px-2 py-0.5 rounded text-[10px] font-semibold ${pos ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300'}">${pos ? '+' : ''}${pct}%</span>
          </div>
          <div class="text-sm font-bold text-white truncate">${inv.nombre}</div>
          <div class="text-xl font-extrabold text-cyan-300 my-1">${UI.formatCurrency(actual)}</div>
          <div class="text-[11px] text-slate-400 truncate">${inv.plataforma || 'General'} • ${inv.moneda || 'ARS'}</div>
        </div>
      `;
    }).join('');
  },

  renderInversiones(metricsArg) {
    const m = metricsArg || Calculations.getMetrics();
    const capEl = document.getElementById('inv-total-capital');
    const actEl = document.getElementById('inv-total-actual');
    const ganEl = document.getElementById('inv-total-ganancia');
    const listEl = document.getElementById('list-inversiones');

    if (capEl) capEl.textContent = UI.formatCurrency(m.inversionesCapital);
    if (actEl) actEl.textContent = UI.formatCurrency(m.inversionesValorActual);
    if (ganEl) {
      ganEl.textContent = (m.inversionesGanancia >= 0 ? '+' : '') + UI.formatCurrency(m.inversionesGanancia);
      ganEl.className = `text-xl sm:text-2xl font-black mt-1 ${m.inversionesGanancia >= 0 ? 'text-emerald-400' : 'text-rose-400'}`;
    }

    const inversiones = AppState.data.inversiones || [];
    if (listEl) {
      if (inversiones.length === 0) {
        listEl.innerHTML = `
          <div class="text-center py-8 text-slate-400 glass-subcard rounded-2xl">
            <i class="fa-solid fa-seedling text-3xl mb-2 text-cyan-400/70"></i>
            <p class="text-sm font-semibold text-white">Todavía no registraste inversiones</p>
            <p class="text-xs text-slate-400 mt-1">Usa el botón "Agregar Inversión" o la hoja Inversiones de Google Sheets cuando comiences.</p>
          </div>`;
      } else {
        listEl.innerHTML = inversiones.map(inv => {
          const invertido = parseFloat(inv.monto_invertido) || 0;
          const actual = parseFloat(inv.valor_actual) || invertido;
          const gan = actual - invertido;
          const pct = invertido > 0 ? Math.round((gan / invertido) * 1000) / 10 : 0;
          return `
            <div class="flex items-center justify-between p-3.5 glass-subcard rounded-xl hover:border-cyan-400/35 transition">
              <div class="flex items-center gap-3 min-w-0">
                <div class="w-10 h-10 rounded-xl bg-blue-500/15 border border-sky-400/25 text-cyan-300 flex items-center justify-center shrink-0">
                  <i class="fa-solid fa-chart-line"></i>
                </div>
                <div class="min-w-0">
                  <h4 class="text-sm font-bold text-white truncate">${inv.nombre}</h4>
                  <span class="text-xs text-slate-400 block truncate">${inv.tipo} • ${inv.plataforma || 'General'} ${inv.notas ? '• ' + inv.notas : ''}</span>
                </div>
              </div>
              <div class="flex items-center gap-3 shrink-0">
                <div class="text-right">
                  <div class="text-sm font-bold text-cyan-300">${UI.formatCurrency(actual)}</div>
                  <div class="text-[11px] ${gan >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${gan >= 0 ? '+' : ''}${pct}%</div>
                </div>
                <button onclick="DataService.deleteInversion('${inv.id}')" class="text-slate-500 hover:text-rose-400 p-1.5 transition" title="Eliminar inversión">
                  <i class="fa-regular fa-trash-can"></i>
                </button>
              </div>
            </div>`;
        }).join('');
      }
    }

    const ctx = document.getElementById('investmentsChart');
    if (ctx) {
      if (AppState.investmentsChartInstance) {
        AppState.investmentsChartInstance.destroy();
      }
      const grouped = {};
      inversiones.forEach(inv => {
        const key = inv.tipo || 'Otros';
        grouped[key] = (grouped[key] || 0) + (parseFloat(inv.valor_actual) || parseFloat(inv.monto_invertido) || 0);
      });
      const labels = Object.keys(grouped);
      const data = Object.values(grouped);

      AppState.investmentsChartInstance = new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels: labels.length > 0 ? labels : ['Sin activos aún'],
          datasets: [{
            data: data.length > 0 ? data : [1],
            backgroundColor: labels.length > 0 ? ['#2563EB', '#06B6D4', '#38BDF8', '#10B981'] : ['#1E3A5F'],
            borderWidth: 0
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              position: 'bottom',
              labels: { color: '#94A3B8', boxWidth: 10, font: { family: 'Plus Jakarta Sans', size: 11 } }
            }
          },
          cutout: '68%'
        }
      });
    }
  },

  renderDiarios() {
    const container = document.getElementById('list-diarios');
    if (!container) return;

    if (AppState.data.diarios.length === 0) {
      container.innerHTML = `<div class="text-center py-8 text-slate-400"><i class="fa-solid fa-receipt text-3xl mb-2 text-sky-400/60"></i><p>No hay gastos diarios registrados este mes.</p></div>`;
      return;
    }

    container.innerHTML = AppState.data.diarios.map(d => `
      <div class="flex items-center justify-between p-3.5 glass-subcard rounded-xl hover:border-sky-400/30 transition">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-lg bg-blue-500/15 border border-sky-400/20 text-sky-300 flex items-center justify-center font-bold">
            <i class="fa-solid fa-cart-shopping"></i>
          </div>
          <div>
            <h4 class="text-sm font-semibold text-white">${d.descripcion}</h4>
            <span class="text-xs text-slate-400">${d.metodo || 'Efectivo'} • ${d.fecha || ''}</span>
          </div>
        </div>
        <div class="flex items-center gap-3">
          <span class="text-sm font-bold text-rose-400">-${UI.formatCurrency(d.monto)}</span>
          <button onclick="DataService.deleteGastoDiario('${d.id}')" class="text-slate-500 hover:text-rose-400 p-1.5 transition">
            <i class="fa-regular fa-trash-can"></i>
          </button>
        </div>
      </div>
    `).join('');
  },

  renderServicios() {
    const container = document.getElementById('list-servicios');
    if (!container) return;

    if (AppState.data.servicios.length === 0) {
      container.innerHTML = `<div class="text-center py-8 text-slate-400"><i class="fa-solid fa-calendar-check text-3xl mb-2 text-sky-400/60"></i><p>No hay servicios fijos configurados.</p></div>`;
      return;
    }

    const hoy = new Date().getDate();

    container.innerHTML = AppState.data.servicios.map(s => {
      const isPaid = s.estado === 'Pagado';
      const isOverdue = !isPaid && s.vencimiento < hoy;
      const statusBadge = isPaid
        ? `<span class="px-2.5 py-1 text-xs font-semibold rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">Pagado</span>`
        : isOverdue
        ? `<span class="px-2.5 py-1 text-xs font-semibold rounded-full bg-rose-500/10 text-rose-400 border border-rose-500/20">Vencido (Día ${s.vencimiento})</span>`
        : `<span class="px-2.5 py-1 text-xs font-semibold rounded-full bg-sky-500/10 text-sky-300 border border-sky-400/25">Vence día ${s.vencimiento}</span>`;

      return `
        <div class="flex flex-col md:flex-row md:items-center justify-between p-4 glass-subcard rounded-xl gap-3 hover:border-sky-400/30 transition">
          <div class="flex items-center gap-3">
            <button onclick="DataService.toggleServicio('${s.id}')" class="w-8 h-8 rounded-lg flex items-center justify-center transition ${isPaid ? 'bg-emerald-500 text-white' : 'bg-slate-800 border border-sky-400/20 text-slate-400 hover:bg-blue-600/30 hover:text-white'}">
              <i class="fa-solid fa-check text-sm"></i>
            </button>
            <div>
              <h4 class="text-sm font-semibold ${isPaid ? 'text-slate-400 line-through' : 'text-white'}">${s.servicio}</h4>
              <div class="flex items-center gap-2 mt-1">
                ${statusBadge}
                ${s.comprobante_url ? `<a href="${s.comprobante_url}" target="_blank" class="text-xs text-cyan-300 hover:underline"><i class="fa-solid fa-paperclip"></i> Voucher</a>` : ''}
              </div>
            </div>
          </div>
          <div class="flex items-center justify-between md:justify-end gap-3">
            <span class="text-base font-bold ${isPaid ? 'text-slate-400' : 'text-white'}">${UI.formatCurrency(s.monto)}</span>
            <div class="flex items-center gap-1.5">
              <button onclick="abrirModalEditarServicio('${s.id}')" class="text-slate-400 hover:text-cyan-300 p-2 rounded-lg hover:bg-slate-800 transition" title="Editar servicio">
                <i class="fa-solid fa-pen-to-square"></i>
              </button>
              <label class="cursor-pointer text-slate-400 hover:text-cyan-300 p-2 rounded-lg hover:bg-slate-800 transition" title="Subir comprobante">
                <i class="fa-solid fa-cloud-arrow-up"></i>
                <input type="file" accept="image/*,.pdf" class="hidden" onchange="DataService.uploadVoucher('${s.id}', this.files[0])">
              </label>
              <button onclick="DataService.deleteServicio('${s.id}')" class="text-slate-500 hover:text-rose-400 p-2 rounded-lg hover:bg-slate-800 transition" title="Eliminar">
                <i class="fa-regular fa-trash-can"></i>
              </button>
            </div>
          </div>
        </div>
      `;
    }).join('');
  },

  renderDeudas() {
    const containerTarjetas = document.getElementById('list-tarjetas');
    const containerMercadoCredito = document.getElementById('list-mercado-credito');
    const containerPrestamos = document.getElementById('list-prestamos');

    let totalDeudaRestante = 0;
    let cuotasMesTotal = 0;
    let activasCount = 0;

    const sumarDeudas = (lista) => {
      (lista || []).forEach(item => {
        const restCuotas = Math.max(0, (item.cuotas_totales || 1) - (item.cuotas_pagadas || 0));
        if (restCuotas > 0) {
          activasCount++;
          cuotasMesTotal += (parseFloat(item.monto_cuota) || 0);
          totalDeudaRestante += restCuotas * (parseFloat(item.monto_cuota) || 0);
        }
      });
    };

    sumarDeudas(AppState.data.tarjetas);
    sumarDeudas(AppState.data.mercadoCredito);
    sumarDeudas(AppState.data.prestamos);

    const elTotalDeuda = document.getElementById('metric-total-deuda');
    const elCuotasMes = document.getElementById('metric-cuotas-mes-deuda');
    const elActivas = document.getElementById('metric-deudas-activas');
    if (elTotalDeuda) elTotalDeuda.textContent = UI.formatCurrency(totalDeudaRestante);
    if (elCuotasMes) elCuotasMes.textContent = UI.formatCurrency(cuotasMesTotal);
    if (elActivas) elActivas.textContent = activasCount;

    const renderDeudaCards = (lista, tipo, opts) => {
      return lista.map(item => {
        const nombre = item.compra || item.prestamo;
        const restCuotas = Math.max(0, (item.cuotas_totales || 1) - (item.cuotas_pagadas || 0));
        const restMonto = restCuotas * (parseFloat(item.monto_cuota) || 0);
        const pct = Math.min(100, Math.round(((item.cuotas_pagadas || 0) / (item.cuotas_totales || 1)) * 100));
        const metodoBadge = item.metodo || opts.defaultMetodo;
        return `
          <div class="p-4 glass-subcard rounded-2xl space-y-3">
            <div class="flex justify-between items-start gap-2">
              <div class="min-w-0">
                <div class="flex items-center flex-wrap gap-1.5">
                  <h4 class="font-bold text-white text-sm truncate">${nombre}</h4>
                  <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold border ${opts.badgeClass}">${metodoBadge}</span>
                </div>
                <span class="text-xs text-slate-400">${item.cuotas_pagadas || 0}/${item.cuotas_totales} cuotas ${opts.cuotaLabel} (${pct}%)</span>
              </div>
              <div class="text-right shrink-0">
                <span class="text-sm font-extrabold ${opts.amountClass} block">${UI.formatCurrency(item.monto_cuota)} / mes</span>
                <span class="text-[11px] text-slate-400">Resta: ${UI.formatCurrency(restMonto)}</span>
              </div>
            </div>
            <div class="w-full bg-slate-800 h-2 rounded-full overflow-hidden">
              <div class="${opts.barClass} h-full rounded-full transition-all duration-500" style="width: ${pct}%"></div>
            </div>
            <div class="flex justify-between items-center pt-1">
              <span class="text-xs text-slate-400">Total: ${UI.formatCurrency(item.monto_total)}</span>
              <div class="flex items-center gap-1.5">
                ${(item.cuotas_pagadas || 0) < item.cuotas_totales ? `
                  <button onclick="abrirModalPagarCuota('${item.id}', '${tipo}')" class="px-2.5 py-1 ${opts.btnClass} text-xs font-semibold rounded-lg text-white transition active:scale-95">
                    Pagar Cuota
                  </button>
                ` : `<span class="text-xs text-emerald-400 font-semibold px-2">${opts.doneLabel}</span>`}
                <button onclick="abrirModalEditarDeuda('${item.id}', '${tipo}')" class="text-slate-400 hover:text-cyan-300 p-1.5 rounded-lg hover:bg-slate-800 transition" title="Editar deuda">
                  <i class="fa-solid fa-pen-to-square"></i>
                </button>
                <button onclick="DataService.deleteDeuda('${item.id}', '${tipo}')" class="text-slate-500 hover:text-rose-400 p-1.5 rounded-lg hover:bg-slate-800 transition" title="Eliminar">
                  <i class="fa-regular fa-trash-can"></i>
                </button>
              </div>
            </div>
          </div>
        `;
      }).join('');
    };

    if (containerTarjetas) {
      if (AppState.data.tarjetas.length === 0) {
        containerTarjetas.innerHTML = `<p class="text-sm text-slate-400 py-4 text-center col-span-2">No hay compras en tarjeta de crédito activas.</p>`;
      } else {
        containerTarjetas.innerHTML = renderDeudaCards(AppState.data.tarjetas, 'tarjeta', {
          defaultMetodo: 'Tarjeta de Crédito',
          badgeClass: 'bg-blue-500/15 text-sky-300 border-sky-400/25',
          cuotaLabel: 'pagadas',
          amountClass: 'text-sky-300',
          barClass: 'bg-blue-500',
          btnClass: 'bg-blue-600 hover:bg-blue-500',
          doneLabel: 'Completado'
        });
      }
    }

    if (containerMercadoCredito) {
      const listaMC = AppState.data.mercadoCredito || [];
      if (listaMC.length === 0) {
        containerMercadoCredito.innerHTML = `<p class="text-sm text-slate-400 py-4 text-center col-span-2">No hay compras con Mercado Crédito activas.</p>`;
      } else {
        containerMercadoCredito.innerHTML = renderDeudaCards(listaMC, 'mercado_credito', {
          defaultMetodo: 'Mercado Crédito',
          badgeClass: 'bg-amber-500/15 text-amber-300 border-amber-400/30',
          cuotaLabel: 'pagadas',
          amountClass: 'text-amber-300',
          barClass: 'bg-amber-400',
          btnClass: 'bg-amber-600 hover:bg-amber-500',
          doneLabel: 'Completado'
        });
      }
    }

    if (containerPrestamos) {
      if (AppState.data.prestamos.length === 0) {
        containerPrestamos.innerHTML = `<p class="text-sm text-slate-400 py-4 text-center col-span-2">No hay préstamos activos.</p>`;
      } else {
        containerPrestamos.innerHTML = renderDeudaCards(AppState.data.prestamos, 'prestamo', {
          defaultMetodo: 'Préstamo',
          badgeClass: 'bg-cyan-500/15 text-cyan-300 border-cyan-400/25',
          cuotaLabel: 'abonadas',
          amountClass: 'text-cyan-300',
          barClass: 'bg-cyan-400',
          btnClass: 'bg-cyan-600 hover:bg-cyan-500',
          doneLabel: 'Cancelado'
        });
      }
    }
  },

  renderHistorial() {
    const container = document.getElementById('list-historial');
    if (!container) return;

    if (AppState.data.historial.length === 0) {
      container.innerHTML = `<div class="text-center py-8 text-slate-400"><i class="fa-solid fa-clock-rotate-left text-3xl mb-2 text-sky-400/60"></i><p>Sin movimientos recientes.</p></div>`;
      return;
    }

    container.innerHTML = AppState.data.historial.slice(0, 50).map(h => {
      const isTransfer = h.categoria && h.categoria.toLowerCase().includes('traspaso');
      const isPositive = !isTransfer && (h.categoria.toLowerCase().includes('ingreso') || h.monto > 0);
      
      let icon = isPositive ? 'fa-arrow-down' : 'fa-arrow-up';
      let iconColor = isPositive ? 'bg-emerald-500/10 text-emerald-400' : 'bg-blue-500/15 text-sky-300';
      if (isTransfer) {
        icon = 'fa-right-left';
        iconColor = 'bg-cyan-500/10 text-cyan-300';
      }

      return `
        <div class="flex items-center justify-between p-3.5 glass-subcard rounded-xl text-sm">
          <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-lg ${iconColor} flex items-center justify-center font-bold text-xs">
              <i class="fa-solid ${icon}"></i>
            </div>
            <div>
              <p class="font-medium text-white">${h.descripcion}</p>
              <span class="text-xs text-slate-400">${h.categoria} • ${h.metodo} • ${h.fecha}</span>
            </div>
          </div>
          <span class="font-bold ${isTransfer ? 'text-cyan-300' : (isPositive ? 'text-emerald-400' : 'text-slate-300')}">
            ${isPositive ? '+' : (isTransfer ? '🔄 ' : '')}${UI.formatCurrency(h.monto)}
          </span>
        </div>
      `;
    }).join('');
  },

  renderMetodosSelects() {
    const selects = document.querySelectorAll('.select-metodos-pago');
    selects.forEach(sel => {
      const current = sel.value;
      sel.innerHTML = AppState.data.metodos.map(m => `<option value="${m}">${m}</option>`).join('');
      if (current && AppState.data.metodos.includes(current)) sel.value = current;
    });

    const selOrigen = document.getElementById('in-traspaso-origen');
    const selDestino = document.getElementById('in-traspaso-destino');
    if (selOrigen && !selOrigen.value && AppState.data.metodos.includes('Santander')) {
      selOrigen.value = 'Santander';
    }
    if (selDestino && (!selDestino.value || selDestino.value === selOrigen?.value)) {
      if (AppState.data.metodos.includes('ARQ')) selDestino.value = 'ARQ';
      else if (AppState.data.metodos.includes('Mercado Pago')) selDestino.value = 'Mercado Pago';
    }
  },

  renderMetodosList() {
    const container = document.getElementById('list-metodos-gestion');
    if (!container) return;

    container.innerHTML = AppState.data.metodos.map(m => `
      <div class="flex items-center justify-between p-2.5 glass-subcard rounded-lg text-sm">
        <span class="text-slate-200"><i class="fa-solid fa-wallet text-sky-400 mr-2"></i>${m}</span>
        <button onclick="DataService.deleteMetodo('${m}')" class="text-slate-500 hover:text-rose-400 p-1">
          <i class="fa-regular fa-trash-can"></i>
        </button>
      </div>
    `).join('');
  },

  switchTab(tabId) {
    AppState.currentTab = tabId;
    document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
    const activeSection = document.getElementById(`tab-${tabId}`);
    if (activeSection) activeSection.classList.remove('hidden');

    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.classList.toggle('active-nav', btn.dataset.tab === tabId);
    });

    window.scrollTo({ top: 0, behavior: 'smooth' });
  },

  showNotification(message, type = 'info') {
    const banner = document.getElementById('toast-notification');
    if (!banner) return;

    banner.textContent = message;
    banner.className = `fixed bottom-20 left-1/2 -translate-x-1/2 px-5 py-2.5 rounded-full text-xs font-semibold text-white shadow-xl transition-all duration-300 z-50 ${
      type === 'success' ? 'bg-emerald-600' : type === 'error' ? 'bg-rose-600' : type === 'warning' ? 'bg-amber-600' : 'bg-blue-600'
    }`;
    banner.style.opacity = '1';
    banner.style.transform = 'translate(-50%, 0)';

    setTimeout(() => {
      banner.style.opacity = '0';
      banner.style.transform = 'translate(-50%, 10px)';
    }, 3500);
  }
};

// ==============================================================================
// 4. EVENT LISTENERS E INICIALIZACIÓN
// ==============================================================================

window.addEventListener('DOMContentLoaded', () => {
  UI.updateMonthLabel();
  DataService.loadAllData();

  // Al volver a la app (desde otra app o pestaña), refrescar datos del servidor
  // para no trabajar con saldos viejos si Spark / Google Sheets cargó algo mientras tanto.
  let ultimaRecarga = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - ultimaRecarga > 30000) {
      ultimaRecarga = Date.now();
      DataService.loadAllData(true);
    }
  });

  // Navegación
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => UI.switchTab(btn.dataset.tab));
  });

  // Cargar Ajustes guardados
  const inputSupabaseUrl = document.getElementById('setting-supabase-url');
  const inputSupabaseKey = document.getElementById('setting-supabase-key');
  const inputSheetsUrl = document.getElementById('setting-sheets-sync-url');

  if (inputSupabaseUrl) inputSupabaseUrl.value = SupabaseConfig.getUrl();
  if (inputSupabaseKey) inputSupabaseKey.value = SupabaseConfig.getKey();
  if (inputSheetsUrl && typeof SupabaseConfig.getSheetsSyncUrl === 'function') {
    inputSheetsUrl.value = SupabaseConfig.getSheetsSyncUrl();
  }
  UI.updateSheetsSyncBadge();
});
