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
    metodos: ['Efectivo', 'Mercado Pago', 'Transferencia', 'Tarjeta de Crédito', 'Mercado Crédito']
  },
  currentTab: 'dashboard',
  chartInstance: null,
  flowChartInstance: null,
  investmentsChartInstance: null,
  lastSyncAt: null
};

function getTodayString() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ==============================================================================
// 1. GESTIÓN DE DATOS (CRUD CON SUPABASE Y FALLBACK LOCALSTORAGE)
// ==============================================================================

const DataService = {
  // Carga inicial de datos
  async loadAllData(silent = false) {
    let client = SupabaseConfig.client;
    if (!client && SupabaseConfig.isConfigured()) {
      client = SupabaseConfig.init();
    }
    // Si Supabase CDN aún está descargando en el teléfono, esperar hasta 1.5s
    if (!client && typeof window !== 'undefined' && !window.supabase) {
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 100));
        if (window.supabase) {
          client = SupabaseConfig.init();
          break;
        }
      }
    }

    if (client && SupabaseConfig.isConfigured()) {
      try {
        console.log('🔄 Sincronizando con Supabase...');
        const [
          { data: ingresos },
          { data: diarios },
          { data: servicios },
          { data: deudas },
          { data: historial },
          { data: metodos }
        ] = await Promise.all([
          client.from('ingresos').select('*').order('fecha', { ascending: false }),
          client.from('gastos_diarios').select('*').order('fecha', { ascending: false }),
          client.from('gastos_fijos').select('*').order('vencimiento', { ascending: true }),
          client.from('deudas').select('*').order('created_at', { ascending: false }),
          client.from('historial').select('*').order('fecha', { ascending: false }).limit(100),
          client.from('metodos_pago').select('*')
        ]);

        AppState.data.ingresos = (ingresos || []).map(i => ({ ...i, monto: parseFloat(i.monto) }));
        AppState.data.diarios = (diarios || []).map(d => ({ ...d, monto: parseFloat(d.monto) }));
        AppState.data.servicios = (servicios || []).map(s => ({ ...s, monto: parseFloat(s.monto) }));
        
        const rawDeudas = deudas || [];
        const isMercadoCredito = (d) =>
          d.tipo === 'mercado_credito' ||
          (d.metodo || '').toLowerCase().includes('mercado cr');

        const mapDeuda = (d) => ({
          id: d.id,
          compra: d.nombre,
          prestamo: d.nombre,
          monto_total: parseFloat(d.monto_total),
          cuotas_totales: d.cuotas_totales,
          cuotas_pagadas: d.cuotas_pagadas,
          monto_cuota: parseFloat(d.monto_cuota),
          fecha_inicio: d.fecha_inicio,
          metodo: d.metodo
        });

        AppState.data.tarjetas = rawDeudas.filter(d => !isMercadoCredito(d) && d.tipo === 'tarjeta').map(mapDeuda);
        AppState.data.mercadoCredito = rawDeudas.filter(d => isMercadoCredito(d)).map(mapDeuda);
        AppState.data.prestamos = rawDeudas.filter(d => !isMercadoCredito(d) && d.tipo === 'prestamo').map(mapDeuda);

        AppState.data.historial = (historial || []).map(h => ({
          ...h,
          monto: parseFloat(h.monto),
          fecha: new Date(h.fecha).toLocaleDateString('es-AR')
        }));

        if (metodos && metodos.length > 0) {
          AppState.data.metodos = metodos.map(m => m.nombre);
        }

        // Cargar inversiones de forma segura (por si la tabla aún no fue creada en Supabase)
        AppState.data.inversiones = DataService.loadLocalInversiones();
        try {
          const { data: inv, error: invError } = await client.from('inversiones').select('*').order('created_at', { ascending: false });
          if (!invError && Array.isArray(inv)) {
            AppState.data.inversiones = inv.map(item => ({
              ...item,
              monto_invertido: parseFloat(item.monto_invertido) || 0,
              valor_actual: parseFloat(item.valor_actual) || 0,
              rendimiento_pct: parseFloat(item.rendimiento_pct) || 0
            }));
          }
        } catch (invErr) {
          console.info('Tabla inversiones opcional no disponible aún en Supabase; usando respaldo local.');
        }

        AppState.lastSyncAt = new Date();
        UI.updateSyncTimestamp();

        if (!silent) UI.showNotification('Datos sincronizados con Supabase', 'success');
      } catch (error) {
        console.error('Error al cargar datos desde Supabase:', error);
        UI.showNotification('Error al conectar con Supabase. Usando datos locales.', 'error');
        DataService.loadFromLocalStorage();
      }
    } else {
      DataService.loadFromLocalStorage();
    }

    UI.renderAll();
  },

  async syncGoogleSheets() {
    const syncUrl = typeof SupabaseConfig.getSheetsSyncUrl === 'function' ? SupabaseConfig.getSheetsSyncUrl() : '';
    if (!syncUrl) return { configured: false, ok: false };

    const sep = syncUrl.includes('?') ? '&' : '?';
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), 18000) : null;

    try {
      const resp = await fetch(`${syncUrl}${sep}action=sync&_t=${Date.now()}`, {
        method: 'GET',
        redirect: 'follow',
        signal: controller ? controller.signal : undefined
      });
      if (!resp.ok) {
        return { configured: true, ok: false, error: `HTTP ${resp.status}` };
      }
      const rawText = await resp.text();
      let payload = {};
      try {
        payload = JSON.parse(rawText);
      } catch (parseErr) {
        return { configured: true, ok: false, error: 'Respuesta inválida del Web App de Sheets' };
      }
      if (payload && payload.ok === false) {
        return { configured: true, ok: false, error: payload.error || 'Error en Apps Script' };
      }
      const subidosTotal = payload.subidosTotal !== undefined
        ? (Number(payload.subidosTotal) || 0)
        : (Number(payload.subidosGastos) || 0) + (Number(payload.subidosIngresos) || 0) + (Number(payload.subidosFijos) || 0) + (Number(payload.subidosDeudas) || 0) + (Number(payload.subidosInversiones) || 0);
      const actualizadosTotal = Number(payload.actualizadosTotal) || 0;
      return { configured: true, ok: true, subidosTotal, actualizadosTotal, payload };
    } catch (err) {
      return { configured: true, ok: false, error: err.name === 'AbortError' ? 'Tiempo de espera agotado' : err.message };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  },

  async refreshAll(btn) {
    const icon = btn ? btn.querySelector('i') : null;
    if (icon) icon.classList.add('fa-spin');
    try {
      const sheetsRes = await DataService.syncGoogleSheets();
      if (sheetsRes.configured && sheetsRes.ok) {
        await DataService.loadAllData(true);
        const partes = [];
        if (sheetsRes.subidosTotal > 0) partes.push(`+${sheetsRes.subidosTotal} nuevos`);
        if (sheetsRes.actualizadosTotal > 0) partes.push(`${sheetsRes.actualizadosTotal} editados`);
        const msg = partes.length > 0
          ? `Google Sheets sincronizado (${partes.join(', ')}) y tablero actualizado`
          : 'Google Sheets y Supabase actualizados';
        UI.showNotification(msg, 'success');
      } else if (sheetsRes.configured && !sheetsRes.ok) {
        await DataService.loadAllData(true);
        UI.showNotification(`Supabase actualizado (Sheets: ${sheetsRes.error})`, 'warning');
      } else {
        await DataService.loadAllData(false);
      }
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
      } catch (e) {
        console.error('Error parseando datos locales', e);
      }
    } else {
      // Datos semilla iniciales para demo
      AppState.data = {
        ingresos: [
          { id: '1', descripcion: 'Sueldo Principal', monto: 850000, fecha: new Date().toISOString().split('T')[0], metodo: 'Transferencia' }
        ],
        diarios: [
          { id: '1', descripcion: 'Supermercado', monto: 24500, fecha: new Date().toISOString().split('T')[0], metodo: 'Mercado Pago' },
          { id: '2', descripcion: 'Combustible', monto: 18000, fecha: new Date().toISOString().split('T')[0], metodo: 'Efectivo' }
        ],
        servicios: [
          { id: '1', servicio: 'Internet Fibra', monto: 18500, vencimiento: 10, estado: 'Pendiente' },
          { id: '2', servicio: 'Electricidad', monto: 22000, vencimiento: 15, estado: 'Pendiente' },
          { id: '3', servicio: 'Alquiler', monto: 250000, vencimiento: 5, estado: 'Pagado' }
        ],
        tarjetas: [
          { id: '1', compra: 'Notebook', monto_total: 600000, cuotas_totales: 12, cuotas_pagadas: 4, monto_cuota: 50000, fecha_inicio: '2025-10-01', metodo: 'Tarjeta de Crédito' }
        ],
        mercadoCredito: [],
        prestamos: [],
        historial: [
          { id: '1', fecha: new Date().toLocaleDateString('es-AR'), categoria: 'Ingreso', descripcion: 'Sueldo Principal', monto: 850000, metodo: 'Transferencia' },
          { id: '2', fecha: new Date().toLocaleDateString('es-AR'), categoria: 'Servicio Pagado', descripcion: 'Alquiler', monto: 250000, metodo: 'Transferencia' }
        ],
        inversiones: [],
        metodos: ['Efectivo', 'Mercado Pago', 'Transferencia', 'Tarjeta de Crédito', 'Mercado Crédito']
      };
      DataService.saveToLocalStorage();
    }
  },

  saveToLocalStorage() {
    localStorage.setItem('CFP_LOCAL_DATA', JSON.stringify(AppState.data));
  },

  // Registrar movimiento en Historial
  async logHistorial(categoria, descripcion, monto, metodo) {
    const hoy = new Date();
    const item = {
      id: Date.now().toString(),
      fecha: hoy.toLocaleDateString('es-AR'),
      categoria,
      descripcion,
      monto: parseFloat(monto),
      metodo: metodo || 'General'
    };

    AppState.data.historial.unshift(item);

    const client = SupabaseConfig.client;
    if (client && SupabaseConfig.isConfigured()) {
      try {
        await client.from('historial').insert([{
          categoria,
          descripcion,
          monto: parseFloat(monto),
          metodo: metodo || 'General'
        }]);
      } catch (err) {
        console.error('Error guardando en historial Supabase:', err);
      }
    } else {
      DataService.saveToLocalStorage();
    }
  },

  // -------------------------------------------------------------
  // INGRESOS
  // -------------------------------------------------------------
  async addIngreso(descripcion, monto, metodo, fecha) {
    const fechaVal = fecha || getTodayString();
    const client = SupabaseConfig.client;

    if (client && SupabaseConfig.isConfigured()) {
      const { data, error } = await client.from('ingresos').insert([{
        descripcion,
        monto: parseFloat(monto),
        metodo,
        fecha: fechaVal
      }]).select();

      if (!error && data && data[0]) {
        AppState.data.ingresos.unshift({ ...data[0], monto: parseFloat(data[0].monto) });
      }
    } else {
      const nuevo = { id: Date.now().toString(), descripcion, monto: parseFloat(monto), metodo, fecha: fechaVal };
      AppState.data.ingresos.unshift(nuevo);
      DataService.saveToLocalStorage();
    }

    await DataService.logHistorial('Ingreso', descripcion, monto, metodo);
    UI.renderAll();
    UI.showNotification('Ingreso agregado exitosamente', 'success');
  },

  async deleteIngreso(id) {
    const item = AppState.data.ingresos.find(i => i.id === id);
    const client = SupabaseConfig.client;

    if (client && SupabaseConfig.isConfigured()) {
      await client.from('ingresos').delete().eq('id', id);
    }

    AppState.data.ingresos = AppState.data.ingresos.filter(i => i.id !== id);
    DataService.saveToLocalStorage();

    if (item) {
      await DataService.logHistorial('Eliminación Ingreso', item.descripcion, -item.monto, item.metodo);
    }
    UI.renderAll();
    UI.showNotification('Ingreso eliminado', 'info');
  },

  // -------------------------------------------------------------
  // TRASPASO ENTRE CUENTAS / BANCOS / EFECTIVO
  // -------------------------------------------------------------
  async transferirDinero(origen, destino, monto, nota) {
    const valMonto = parseFloat(monto);
    if (!valMonto || isNaN(valMonto) || valMonto <= 0) {
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

    const client = SupabaseConfig.client;
    const isSupa = client && SupabaseConfig.isConfigured();

    // 1. Descontar o ajustar cuenta Origen en AppState.data.ingresos
    const cuentaOrigen = AppState.data.ingresos.find(i => (i.metodo || '').toLowerCase() === origen.toLowerCase());
    if (cuentaOrigen) {
      const nuevoMontoOrigen = Math.max(0, parseFloat(cuentaOrigen.monto) - valMonto);
      cuentaOrigen.monto = nuevoMontoOrigen;
      if (isSupa) {
        try {
          await client.from('ingresos').update({ monto: nuevoMontoOrigen }).eq('id', cuentaOrigen.id);
        } catch (e) {
          console.error('Error actualizando cuenta origen:', e);
        }
      }
    } else {
      const nuevoOrigen = {
        descripcion: `Fondo en ${origen}`,
        monto: 0,
        metodo: origen,
        fecha: getTodayString()
      };
      if (isSupa) {
        try {
          const { data } = await client.from('ingresos').insert([nuevoOrigen]).select();
          if (data && data[0]) nuevoOrigen.id = data[0].id;
        } catch (e) {}
      } else {
        nuevoOrigen.id = Date.now().toString();
      }
      AppState.data.ingresos.unshift(nuevoOrigen);
    }

    // 2. Incrementar o crear cuenta Destino en AppState.data.ingresos
    const cuentaDestino = AppState.data.ingresos.find(i => (i.metodo || '').toLowerCase() === destino.toLowerCase());
    if (cuentaDestino) {
      const nuevoMontoDestino = parseFloat(cuentaDestino.monto) + valMonto;
      cuentaDestino.monto = nuevoMontoDestino;
      if (isSupa) {
        try {
          await client.from('ingresos').update({ monto: nuevoMontoDestino }).eq('id', cuentaDestino.id);
        } catch (e) {
          console.error('Error actualizando cuenta destino:', e);
        }
      }
    } else {
      const nuevoDestino = {
        descripcion: `Plata en ${destino}`,
        monto: valMonto,
        metodo: destino,
        fecha: getTodayString()
      };
      if (isSupa) {
        try {
          const { data } = await client.from('ingresos').insert([nuevoDestino]).select();
          if (data && data[0]) nuevoDestino.id = data[0].id;
        } catch (e) {}
      } else {
        nuevoDestino.id = (Date.now() + 1).toString();
      }
      AppState.data.ingresos.unshift(nuevoDestino);
    }

    // 3. Registrar en Historial
    const detalleTraspaso = `Traspaso: ${origen} ➔ ${destino}${nota ? ' • ' + nota.trim() : ''}`;
    await DataService.logHistorial('Traspaso', detalleTraspaso, valMonto, `${origen} ➔ ${destino}`);

    DataService.saveToLocalStorage();
    UI.renderAll();
    UI.showNotification(`🔄 Traspaso de ${UI.formatCurrency(valMonto)} (${origen} ➔ ${destino}) completado`, 'success');
    return true;
  },

  // -------------------------------------------------------------
  // SALDO DE CUENTAS (núcleo del modelo "billetera")
  // Toda salida o entrada de plata ajusta la cuenta/banco correspondiente.
  // delta negativo = sale plata, delta positivo = entra plata.
  // Devuelve true si encontró una cuenta con ese método; false si no
  // (ej: TDC / Mercado Crédito, que son crédito y no restan de tus bancos).
  // -------------------------------------------------------------
  async ajustarCuenta(metodo, delta) {
    const valDelta = parseFloat(delta);
    if (!metodo || isNaN(valDelta) || valDelta === 0) return false;
    const met = String(metodo).trim().toLowerCase();

    const candidatas = AppState.data.ingresos.filter(i => (i.metodo || '').trim().toLowerCase() === met);
    if (candidatas.length === 0) return false;

    // Si hay varias filas del mismo banco, usar la de mayor saldo
    const cuenta = candidatas.reduce((a, b) => (parseFloat(b.monto) || 0) > (parseFloat(a.monto) || 0) ? b : a);

    const client = SupabaseConfig.client;
    const isSupa = client && SupabaseConfig.isConfigured();
    let base = parseFloat(cuenta.monto) || 0;

    if (isSupa) {
      // Leer el valor fresco del servidor para no pisar cambios hechos desde Google Sheets
      try {
        const { data } = await client.from('ingresos').select('monto').eq('id', cuenta.id).single();
        if (data && data.monto !== undefined && data.monto !== null) base = parseFloat(data.monto) || 0;
      } catch (e) {
        console.warn('No se pudo leer saldo fresco, usando el local:', e);
      }
    }

    const nuevoMonto = Math.round((base + valDelta) * 100) / 100;
    cuenta.monto = nuevoMonto;

    if (isSupa) {
      try {
        await client.from('ingresos').update({ monto: nuevoMonto }).eq('id', cuenta.id);
      } catch (e) {
        console.error('Error actualizando saldo de cuenta:', e);
      }
    }
    DataService.saveToLocalStorage();
    return true;
  },

  // -------------------------------------------------------------
  // GASTOS DIARIOS
  // -------------------------------------------------------------
  async addGastoDiario(descripcion, monto, metodo, fecha) {
    const fechaVal = fecha || getTodayString();
    const valMonto = parseFloat(monto);
    if (!descripcion || isNaN(valMonto) || valMonto <= 0) {
      UI.showNotification('Ingresa una descripción y un monto válido', 'warning');
      return false;
    }
    const client = SupabaseConfig.client;

    if (client && SupabaseConfig.isConfigured()) {
      const { data, error } = await client.from('gastos_diarios').insert([{
        descripcion,
        monto: valMonto,
        metodo,
        fecha: fechaVal
      }]).select();

      if (error || !data || !data[0]) {
        console.error('Error guardando gasto:', error);
        UI.showNotification('No se pudo guardar el gasto. Revisa tu conexión.', 'error');
        return false;
      }
      AppState.data.diarios.unshift({ ...data[0], monto: parseFloat(data[0].monto) });
    } else {
      const nuevo = { id: Date.now().toString(), descripcion, monto: valMonto, metodo, fecha: fechaVal };
      AppState.data.diarios.unshift(nuevo);
      DataService.saveToLocalStorage();
    }

    // Descontar la plata de la cuenta/banco con que se pagó
    const descontado = await DataService.ajustarCuenta(metodo, -valMonto);

    await DataService.logHistorial('Gasto Diario', descripcion, valMonto, metodo);
    UI.renderAll();
    if (descontado) {
      UI.showNotification(`Gasto registrado y descontado de ${metodo}`, 'success');
    } else {
      UI.showNotification(`Gasto registrado. "${metodo}" no tiene saldo cargado, no se restó de tus cuentas`, 'info');
    }
    return true;
  },

  async deleteGastoDiario(id) {
    const item = AppState.data.diarios.find(d => d.id === id);
    const client = SupabaseConfig.client;

    if (client && SupabaseConfig.isConfigured()) {
      await client.from('gastos_diarios').delete().eq('id', id);
    }

    AppState.data.diarios = AppState.data.diarios.filter(d => d.id !== id);
    DataService.saveToLocalStorage();

    if (item) {
      // Devolver la plata a la cuenta de donde había salido
      await DataService.ajustarCuenta(item.metodo, parseFloat(item.monto) || 0);
      await DataService.logHistorial('Eliminación Gasto', item.descripcion, -item.monto, item.metodo);
    }
    UI.renderAll();
    UI.showNotification('Gasto eliminado y plata devuelta a la cuenta', 'info');
  },

  // -------------------------------------------------------------
  // SERVICIOS / GASTOS FIJOS
  // -------------------------------------------------------------
  async addServicio(servicio, monto, vencimiento) {
    const client = SupabaseConfig.client;

    if (client && SupabaseConfig.isConfigured()) {
      const { data, error } = await client.from('gastos_fijos').insert([{
        servicio,
        monto: parseFloat(monto),
        vencimiento: parseInt(vencimiento, 10),
        estado: 'Pendiente'
      }]).select();

      if (!error && data && data[0]) {
        AppState.data.servicios.push({ ...data[0], monto: parseFloat(data[0].monto) });
      }
    } else {
      const nuevo = {
        id: Date.now().toString(),
        servicio,
        monto: parseFloat(monto),
        vencimiento: parseInt(vencimiento, 10),
        estado: 'Pendiente'
      };
      AppState.data.servicios.push(nuevo);
      DataService.saveToLocalStorage();
    }

    AppState.data.servicios.sort((a, b) => a.vencimiento - b.vencimiento);
    UI.renderAll();
    UI.showNotification('Servicio fijo programado', 'success');
  },

  async toggleServicio(id, metodo) {
    const serv = AppState.data.servicios.find(s => s.id === id);
    if (!serv) return;

    const nuevoEstado = serv.estado === 'Pagado' ? 'Pendiente' : 'Pagado';
    const monto = parseFloat(serv.monto) || 0;

    // Banco con que se paga: el indicado, o tu cuenta principal (Santander o la de mayor saldo)
    let metodoPago = metodo && metodo !== 'General' ? metodo : null;
    if (nuevoEstado === 'Pagado' && !metodoPago) {
      const principal = AppState.data.ingresos.find(i => (i.metodo || '').toLowerCase() === 'santander')
        || [...AppState.data.ingresos].sort((a, b) => (parseFloat(b.monto) || 0) - (parseFloat(a.monto) || 0))[0];
      metodoPago = principal ? principal.metodo : 'General';
    }
    const metodoAnterior = serv.metodo_pago;

    serv.estado = nuevoEstado;
    serv.metodo_pago = nuevoEstado === 'Pagado' ? metodoPago : null;
    serv.fecha_pago = nuevoEstado === 'Pagado' ? getTodayString() : null;

    const client = SupabaseConfig.client;
    if (client && SupabaseConfig.isConfigured()) {
      await client.from('gastos_fijos').update({
        estado: nuevoEstado,
        fecha_pago: serv.fecha_pago,
        metodo_pago: serv.metodo_pago
      }).eq('id', id);
    }
    DataService.saveToLocalStorage();

    if (nuevoEstado === 'Pagado') {
      const descontado = await DataService.ajustarCuenta(metodoPago, -monto);
      await DataService.logHistorial('Servicio Pagado', serv.servicio, monto, metodoPago);
      UI.showNotification(
        descontado ? `"${serv.servicio}" pagado y descontado de ${metodoPago}` : `"${serv.servicio}" marcado como Pagado`,
        'success'
      );
    } else {
      // Revertir: devolver la plata a la cuenta de donde salió (si era una cuenta con saldo)
      const devuelto = await DataService.ajustarCuenta(metodoAnterior, monto);
      if (devuelto) {
        await DataService.logHistorial('Reverso Servicio', serv.servicio, -monto, metodoAnterior);
      }
      UI.showNotification(`"${serv.servicio}" marcado como Pendiente${devuelto ? ` (se devolvió a ${metodoAnterior})` : ''}`, 'info');
    }

    UI.renderAll();
  },

  async deleteServicio(id) {
    const client = SupabaseConfig.client;
    if (client && SupabaseConfig.isConfigured()) {
      await client.from('gastos_fijos').delete().eq('id', id);
    }
    AppState.data.servicios = AppState.data.servicios.filter(s => s.id !== id);
    DataService.saveToLocalStorage();
    UI.renderAll();
    UI.showNotification('Servicio eliminado', 'info');
  },

  async updateServicio(id, { servicio, monto, vencimiento }) {
    const client = SupabaseConfig.client;
    const m = parseFloat(monto) || 0;
    const v = parseInt(vencimiento, 10) || 1;

    if (client && SupabaseConfig.isConfigured()) {
      await client.from('gastos_fijos').update({
        servicio,
        monto: m,
        vencimiento: v
      }).eq('id', id);
    }

    const serv = AppState.data.servicios.find(s => s.id === id);
    if (serv) {
      serv.servicio = servicio;
      serv.monto = m;
      serv.vencimiento = v;
    }

    AppState.data.servicios.sort((a, b) => a.vencimiento - b.vencimiento);
    DataService.saveToLocalStorage();
    UI.renderAll();
    UI.showNotification(`Servicio "${servicio}" actualizado`, 'success');
  },

  // Subir comprobante a Supabase Storage
  async uploadVoucher(servicioId, file) {
    const client = SupabaseConfig.client;
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

      // Actualizar en la base de datos
      await client.from('gastos_fijos').update({
        comprobante_url: publicUrl
      }).eq('id', servicioId);

      const serv = AppState.data.servicios.find(s => s.id === servicioId);
      if (serv) serv.comprobante_url = publicUrl;

      UI.renderAll();
      UI.showNotification('Comprobante guardado con éxito', 'success');
    } catch (err) {
      console.error('Error al subir voucher:', err);
      UI.showNotification('Error al subir el comprobante: ' + err.message, 'error');
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
    const total = parseFloat(montoTotal) || 0;
    const cuotas = parseInt(cuotasTotales, 10) || 1;
    const pagadas = parseInt(cuotasPagadas, 10) || 0;
    const montoCuota = total / cuotas;
    let metodoFinal = metodo || (tipo === 'mercado_credito' ? 'Mercado Crédito' : (tipo === 'tarjeta' ? 'Tarjeta de Crédito' : 'General'));
    const client = SupabaseConfig.client;

    if (client && SupabaseConfig.isConfigured()) {
      let { data, error } = await client.from('deudas').insert([{
        tipo,
        nombre,
        monto_total: total,
        cuotas_totales: cuotas,
        cuotas_pagadas: pagadas,
        monto_cuota: montoCuota,
        metodo: metodoFinal,
        fecha_inicio: getTodayString()
      }]).select();

      // Respaldo automático si Supabase aún tiene CHECK (tipo IN ('tarjeta', 'prestamo'))
      if (error && tipo === 'mercado_credito') {
        console.warn('Reintentando inserción de Mercado Crédito con respaldo tipo=prestamo:', error.message);
        metodoFinal = 'Mercado Crédito';
        const retry = await client.from('deudas').insert([{
          tipo: 'prestamo',
          nombre,
          monto_total: total,
          cuotas_totales: cuotas,
          cuotas_pagadas: pagadas,
          monto_cuota: montoCuota,
          metodo: metodoFinal,
          fecha_inicio: getTodayString()
        }]).select();
        data = retry.data;
        error = retry.error;
      }

      if (error) {
        console.error('Error al guardar deuda en Supabase:', error);
        UI.showNotification('Error al guardar deuda: ' + error.message, 'error');
        return false;
      }

      if (data && data[0]) {
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
        DataService.getDeudaList(tipo).push(itemFormateado);
      }
    } else {
      const nuevo = {
        id: Date.now().toString(),
        compra: nombre,
        prestamo: nombre,
        monto_total: total,
        cuotas_totales: cuotas,
        cuotas_pagadas: pagadas,
        monto_cuota: montoCuota,
        fecha_inicio: getTodayString(),
        metodo: metodoFinal
      };
      DataService.getDeudaList(tipo).push(nuevo);
    }

    DataService.saveToLocalStorage();
    UI.renderAll();
    UI.showNotification(`${DataService.getDeudaTipoLabel(tipo)} agregado`, 'success');
    return true;
  },

  async updateDeuda(id, tipoOriginal, { tipo, nombre, monto_total, cuotas_totales, cuotas_pagadas, monto_cuota, metodo }) {
    const nuevoTipo = tipo || tipoOriginal;
    const total = parseFloat(monto_total) || 0;
    const cuotasTot = parseInt(cuotas_totales, 10) || 1;
    const cuotasPag = parseInt(cuotas_pagadas, 10) || 0;
    const valorCuota = monto_cuota ? parseFloat(monto_cuota) : (total / cuotasTot);
    let metodoFinal = metodo || (nuevoTipo === 'mercado_credito' ? 'Mercado Crédito' : (nuevoTipo === 'tarjeta' ? 'Tarjeta de Crédito' : 'General'));

    const client = SupabaseConfig.client;
    if (client && SupabaseConfig.isConfigured()) {
      let { error } = await client.from('deudas').update({
        tipo: nuevoTipo,
        nombre,
        monto_total: total,
        cuotas_totales: cuotasTot,
        cuotas_pagadas: cuotasPag,
        monto_cuota: valorCuota,
        metodo: metodoFinal
      }).eq('id', id);

      if (error && nuevoTipo === 'mercado_credito') {
        console.warn('Reintentando actualización de Mercado Crédito con respaldo tipo=prestamo:', error.message);
        metodoFinal = 'Mercado Crédito';
        const retry = await client.from('deudas').update({
          tipo: 'prestamo',
          nombre,
          monto_total: total,
          cuotas_totales: cuotasTot,
          cuotas_pagadas: cuotasPag,
          monto_cuota: valorCuota,
          metodo: metodoFinal
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
      item.compra = nombre;
      item.prestamo = nombre;
      item.monto_total = total;
      item.cuotas_totales = cuotasTot;
      item.cuotas_pagadas = cuotasPag;
      item.monto_cuota = valorCuota;
      item.metodo = metodoFinal;

      if (nuevoTipo !== tipoOriginal) {
        listaOriginal.splice(idx, 1);
        DataService.getDeudaList(nuevoTipo).push(item);
      }
    }

    DataService.saveToLocalStorage();
    await DataService.logHistorial('Actualización Deuda', `Actualizado ${nombre} (${cuotasPag}/${cuotasTot} cuotas)`, total, metodoFinal);
    UI.renderAll();
    UI.showNotification('Deuda actualizada correctamente', 'success');
    return true;
  },

  async pagarCuotaDeuda(id, tipo, montoAbonado, metodoDebitado) {
    const lista = DataService.getDeudaList(tipo);
    const item = lista.find(d => d.id === id);
    if (!item) return false;

    if (item.cuotas_pagadas < item.cuotas_totales) {
      const valMonto = (montoAbonado !== undefined && montoAbonado !== null && !isNaN(parseFloat(montoAbonado)))
        ? parseFloat(montoAbonado)
        : parseFloat(item.monto_cuota || 0);

      const bancoDebito = metodoDebitado || item.metodo || 'Santander';

      item.cuotas_pagadas += 1;

      const client = SupabaseConfig.client;
      const isSupa = client && SupabaseConfig.isConfigured();

      if (isSupa) {
        try {
          await client.from('deudas').update({
            cuotas_pagadas: item.cuotas_pagadas
          }).eq('id', id);
        } catch (e) {
          console.error('Error actualizando cuotas en deudas:', e);
        }
      }

      // 1. Descontar la cuota de la cuenta/banco con que se pagó
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
    }
    return false;
  },

  async deleteDeuda(id, tipo) {
    const client = SupabaseConfig.client;
    if (client && SupabaseConfig.isConfigured()) {
      await client.from('deudas').delete().eq('id', id);
    }
    if (tipo === 'tarjeta') {
      AppState.data.tarjetas = AppState.data.tarjetas.filter(d => d.id !== id);
    } else if (tipo === 'mercado_credito') {
      AppState.data.mercadoCredito = AppState.data.mercadoCredito.filter(d => d.id !== id);
    } else {
      AppState.data.prestamos = AppState.data.prestamos.filter(d => d.id !== id);
    }
    DataService.saveToLocalStorage();
    UI.renderAll();
    UI.showNotification('Registro eliminado', 'info');
  },

  // -------------------------------------------------------------
  // MÉTODOS DE PAGO
  // -------------------------------------------------------------
  async addMetodo(nombre) {
    if (!nombre || AppState.data.metodos.includes(nombre)) return;
    AppState.data.metodos.push(nombre);

    const client = SupabaseConfig.client;
    if (client && SupabaseConfig.isConfigured()) {
      await client.from('metodos_pago').insert([{ nombre }]);
    } else {
      DataService.saveToLocalStorage();
    }
    UI.renderAll();
    UI.showNotification(`Método "${nombre}" añadido`, 'success');
  },

  async deleteMetodo(nombre) {
    AppState.data.metodos = AppState.data.metodos.filter(m => m !== nombre);
    const client = SupabaseConfig.client;
    if (client && SupabaseConfig.isConfigured()) {
      await client.from('metodos_pago').delete().eq('nombre', nombre);
    } else {
      DataService.saveToLocalStorage();
    }
    UI.renderAll();
    UI.showNotification(`Método "${nombre}" eliminado`, 'info');
  },

  // -------------------------------------------------------------
  // RECONCILIACIÓN INTELIGENTE DE SALDO / AJUSTE DE CAPITAL
  // -------------------------------------------------------------
  async reconciliarSaldo(saldoObjetivo, marcarServicios, listaExcluidos, metodo, motivo) {
    const objetivo = parseFloat(saldoObjetivo);
    if (isNaN(objetivo)) return;
    const metodoFinal = metodo || 'General';
    const motivoFinal = motivo || 'Ajuste de Capital (Reconciliación)';

    // 1. Marcar servicios como pagados si se solicitó
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

    // 2. Calcular diferencia de saldo actual vs objetivo y ajustar la cuenta bancaria correspondiente
    const metrics = Calculations.getMetrics();
    const diferencia = objetivo - metrics.saldoReal;

    if (Math.abs(diferencia) >= 0.01) {
      const cuenta = AppState.data.ingresos.find(i => (i.metodo || '').toLowerCase() === metodoFinal.toLowerCase())
        || AppState.data.ingresos.find(i => (i.metodo || '').toLowerCase().includes('santander'))
        || AppState.data.ingresos[0];

      if (cuenta) {
        cuenta.monto = Math.max(0, parseFloat(cuenta.monto || 0) + diferencia);
        const client = SupabaseConfig.client;
        if (client && SupabaseConfig.isConfigured()) {
          try {
            await client.from('ingresos').update({ monto: cuenta.monto }).eq('id', cuenta.id);
          } catch (e) {
            console.error('Error actualizando cuenta en reconciliación:', e);
          }
        }
      } else {
        await DataService.addIngreso(motivoFinal, Math.max(0, objetivo), metodoFinal);
      }
    }

    UI.showNotification(`Capital actualizado a $${Math.round(objetivo).toLocaleString('es-AR')}`, 'success');
    UI.renderAll();
  },

  // -------------------------------------------------------------
  // INVERSIONES (Supabase opcional + respaldo localStorage)
  // -------------------------------------------------------------
  async addInversion({ nombre, tipo, plataforma, monto_invertido, valor_actual, moneda, notas }) {
    const invertido = parseFloat(monto_invertido) || 0;
    const actual = parseFloat(valor_actual) || invertido;
    if (!nombre || invertido < 0) {
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
    const client = SupabaseConfig.client;

    if (client && SupabaseConfig.isConfigured()) {
      try {
        const { data, error } = await client.from('inversiones').insert([payload]).select();
        if (!error && data && data[0]) {
          inserted = {
            ...data[0],
            monto_invertido: parseFloat(data[0].monto_invertido) || 0,
            valor_actual: parseFloat(data[0].valor_actual) || 0,
            rendimiento_pct: parseFloat(data[0].rendimiento_pct) || 0
          };
        }
      } catch (e) {
        console.info('Guardando inversión en almacenamiento local hasta crear tabla en Supabase.');
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
    const client = SupabaseConfig.client;
    if (client && SupabaseConfig.isConfigured()) {
      try {
        await client.from('inversiones').delete().eq('id', id);
      } catch (e) {}
    }

    AppState.data.inversiones = (AppState.data.inversiones || []).filter(i => String(i.id) !== String(id));
    DataService.saveLocalInversiones(AppState.data.inversiones);
    DataService.saveToLocalStorage();
    UI.renderAll();
    UI.showNotification('Inversión eliminada', 'info');
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

    const isCuotaPagadaEsteMes = (nombreItem) => {
      const nombre = (nombreItem || '').toLowerCase().trim();
      return (AppState.data.historial || []).some(h =>
        (h.categoria || '').toLowerCase().includes('cuota') &&
        Calculations.isCurrentMonth(h.fecha) &&
        (h.descripcion || '').toLowerCase().includes(nombre)
      );
    };

    let cuotasTarjetas = 0;
    (AppState.data.tarjetas || []).forEach(t => {
      if ((t.cuotas_pagadas || 0) >= t.cuotas_totales) return;
      if (isCuotaPagadaEsteMes(t.compra)) return;
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
      if (isCuotaPagadaEsteMes(mc.compra || mc.prestamo)) return;
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
      if (isCuotaPagadaEsteMes(p.prestamo)) return;
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
    const syncUrl = typeof SupabaseConfig.getSheetsSyncUrl === 'function' ? SupabaseConfig.getSheetsSyncUrl() : '';
    if (syncUrl) {
      badge.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20';
      badge.innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span> Sheets + Supabase';
    } else {
      badge.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-amber-500/10 text-amber-300 border border-amber-500/20';
      badge.innerHTML = '<span class="w-2 h-2 rounded-full bg-amber-400"></span> Falta URL de Sheets';
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
