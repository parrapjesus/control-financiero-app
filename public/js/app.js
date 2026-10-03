// ==============================================================================
// CONTROL FINANCIERO PRO - MOTOR PRINCIPAL DE LA APLICACIÓN (app.js)
// Conectado a Supabase (PostgreSQL + Storage) y Vercel Serverless (Gemini AI)
// ==============================================================================

const AppState = {
  data: {
    ingresos: [],
    diarios: [],
    servicios: [],
    tarjetas: [],
    prestamos: [],
    historial: [],
    metodos: ['Efectivo', 'Mercado Pago', 'Transferencia', 'Tarjeta de Crédito', 'Mercado Crédito']
  },
  currentTab: 'dashboard',
  chartInstance: null,
  isRecording: false,
  recognition: null
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
  async loadAllData() {
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
        AppState.data.tarjetas = rawDeudas.filter(d => d.tipo === 'tarjeta').map(d => ({
          id: d.id,
          compra: d.nombre,
          monto_total: parseFloat(d.monto_total),
          cuotas_totales: d.cuotas_totales,
          cuotas_pagadas: d.cuotas_pagadas,
          monto_cuota: parseFloat(d.monto_cuota),
          fecha_inicio: d.fecha_inicio,
          metodo: d.metodo
        }));

        AppState.data.prestamos = rawDeudas.filter(d => d.tipo === 'prestamo').map(d => ({
          id: d.id,
          prestamo: d.nombre,
          monto_total: parseFloat(d.monto_total),
          cuotas_totales: d.cuotas_totales,
          cuotas_pagadas: d.cuotas_pagadas,
          monto_cuota: parseFloat(d.monto_cuota),
          fecha_inicio: d.fecha_inicio,
          metodo: d.metodo
        }));

        AppState.data.historial = (historial || []).map(h => ({
          ...h,
          monto: parseFloat(h.monto),
          fecha: new Date(h.fecha).toLocaleDateString('es-AR')
        }));

        if (metodos && metodos.length > 0) {
          AppState.data.metodos = metodos.map(m => m.nombre);
        }

        UI.showNotification('Datos sincronizados con Supabase', 'success');
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

  loadFromLocalStorage() {
    const saved = localStorage.getItem('CFP_LOCAL_DATA');
    if (saved) {
      try {
        AppState.data = JSON.parse(saved);
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
        prestamos: [],
        historial: [
          { id: '1', fecha: new Date().toLocaleDateString('es-AR'), categoria: 'Ingreso', descripcion: 'Sueldo Principal', monto: 850000, metodo: 'Transferencia' },
          { id: '2', fecha: new Date().toLocaleDateString('es-AR'), categoria: 'Servicio Pagado', descripcion: 'Alquiler', monto: 250000, metodo: 'Transferencia' }
        ],
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
  // GASTOS DIARIOS
  // -------------------------------------------------------------
  async addGastoDiario(descripcion, monto, metodo, fecha) {
    const fechaVal = fecha || getTodayString();
    const client = SupabaseConfig.client;

    if (client && SupabaseConfig.isConfigured()) {
      const { data, error } = await client.from('gastos_diarios').insert([{
        descripcion,
        monto: parseFloat(monto),
        metodo,
        fecha: fechaVal
      }]).select();

      if (!error && data && data[0]) {
        AppState.data.diarios.unshift({ ...data[0], monto: parseFloat(data[0].monto) });
      }
    } else {
      const nuevo = { id: Date.now().toString(), descripcion, monto: parseFloat(monto), metodo, fecha: fechaVal };
      AppState.data.diarios.unshift(nuevo);
      DataService.saveToLocalStorage();
    }

    await DataService.logHistorial('Gasto Diario', descripcion, monto, metodo);
    UI.renderAll();
    UI.showNotification('Gasto diario registrado', 'success');
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
      await DataService.logHistorial('Eliminación Gasto', item.descripcion, -item.monto, item.metodo);
    }
    UI.renderAll();
    UI.showNotification('Gasto eliminado', 'info');
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
    serv.estado = nuevoEstado;

    const client = SupabaseConfig.client;
    if (client && SupabaseConfig.isConfigured()) {
      await client.from('gastos_fijos').update({
        estado: nuevoEstado,
        fecha_pago: nuevoEstado === 'Pagado' ? new Date().toISOString() : null,
        metodo_pago: nuevoEstado === 'Pagado' ? (metodo || 'General') : null
      }).eq('id', id);
    } else {
      DataService.saveToLocalStorage();
    }

    if (nuevoEstado === 'Pagado') {
      await DataService.logHistorial('Servicio Pagado', serv.servicio, serv.monto, metodo || 'General');
      UI.showNotification(`"${serv.servicio}" marcado como Pagado`, 'success');
    } else {
      UI.showNotification(`"${serv.servicio}" marcado como Pendiente`, 'info');
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
  // DEUDAS (TARJETAS Y PRÉSTAMOS)
  // -------------------------------------------------------------
  async addDeuda(tipo, nombre, montoTotal, cuotasTotales, metodo, cuotasPagadas) {
    const total = parseFloat(montoTotal) || 0;
    const cuotas = parseInt(cuotasTotales, 10) || 1;
    const pagadas = parseInt(cuotasPagadas, 10) || 0;
    const montoCuota = total / cuotas;
    const client = SupabaseConfig.client;

    if (client && SupabaseConfig.isConfigured()) {
      const { data, error } = await client.from('deudas').insert([{
        tipo,
        nombre,
        monto_total: total,
        cuotas_totales: cuotas,
        cuotas_pagadas: pagadas,
        monto_cuota: montoCuota,
        metodo: metodo || (tipo === 'tarjeta' ? 'Tarjeta de Crédito' : 'General'),
        fecha_inicio: getTodayString()
      }]).select();

      if (!error && data && data[0]) {
        const itemFormateado = {
          id: data[0].id,
          compra: data[0].nombre,
          prestamo: data[0].nombre,
          monto_total: total,
          cuotas_totales: cuotas,
          cuotas_pagadas: pagadas,
          monto_cuota: montoCuota,
          metodo: data[0].metodo
        };
        if (tipo === 'tarjeta') AppState.data.tarjetas.push(itemFormateado);
        else AppState.data.prestamos.push(itemFormateado);
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
        metodo: metodo || 'General'
      };
      if (tipo === 'tarjeta') AppState.data.tarjetas.push(nuevo);
      else AppState.data.prestamos.push(nuevo);
      DataService.saveToLocalStorage();
    }

    UI.renderAll();
    UI.showNotification(`${tipo === 'tarjeta' ? 'Tarjeta' : 'Préstamo'} agregado`, 'success');
  },

  async updateDeuda(id, tipo, { nombre, monto_total, cuotas_totales, cuotas_pagadas, monto_cuota, metodo }) {
    const total = parseFloat(monto_total) || 0;
    const cuotasTot = parseInt(cuotas_totales, 10) || 1;
    const cuotasPag = parseInt(cuotas_pagadas, 10) || 0;
    const valorCuota = monto_cuota ? parseFloat(monto_cuota) : (total / cuotasTot);

    const client = SupabaseConfig.client;
    if (client && SupabaseConfig.isConfigured()) {
      await client.from('deudas').update({
        nombre,
        monto_total: total,
        cuotas_totales: cuotasTot,
        cuotas_pagadas: cuotasPag,
        monto_cuota: valorCuota,
        metodo: metodo || 'General'
      }).eq('id', id);
    }

    const lista = tipo === 'tarjeta' ? AppState.data.tarjetas : AppState.data.prestamos;
    const item = lista.find(d => d.id === id);
    if (item) {
      item.compra = nombre;
      item.prestamo = nombre;
      item.monto_total = total;
      item.cuotas_totales = cuotasTot;
      item.cuotas_pagadas = cuotasPag;
      item.monto_cuota = valorCuota;
      item.metodo = metodo || 'General';
    }

    DataService.saveToLocalStorage();
    await DataService.logHistorial('Actualización Deuda', `Actualizado ${nombre} (${cuotasPag}/${cuotasTot} cuotas)`, total, metodo || 'General');
    UI.renderAll();
    UI.showNotification('Deuda actualizada correctamente', 'success');
  },

  async pagarCuotaDeuda(id, tipo, montoAbonado, metodoDebitado) {
    const lista = tipo === 'tarjeta' ? AppState.data.tarjetas : AppState.data.prestamos;
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

      // 1. Descontar o ajustar cuenta en AppState.data.ingresos
      if (valMonto > 0 && bancoDebito) {
        const cuenta = AppState.data.ingresos.find(i => (i.metodo || '').toLowerCase() === bancoDebito.toLowerCase());
        if (cuenta) {
          const nuevoMonto = Math.max(0, parseFloat(cuenta.monto || 0) - valMonto);
          cuenta.monto = nuevoMonto;
          if (isSupa) {
            try {
              await client.from('ingresos').update({ monto: nuevoMonto }).eq('id', cuenta.id);
            } catch (e) {
              console.error('Error descontando cuota de cuenta bancaria:', e);
            }
          }
        }
      }

      DataService.saveToLocalStorage();

      const nombre = item.compra || item.prestamo;
      await DataService.logHistorial(
        `Cuota ${tipo}`,
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

    // 2. Calcular diferencia de saldo actual vs objetivo
    const metrics = Calculations.getMetrics();
    const diferencia = objetivo - metrics.saldoReal;

    if (Math.abs(diferencia) >= 0.01) {
      if (diferencia > 0) {
        // Falta dinero registrado -> Añadir como ajuste de ingreso
        await DataService.addIngreso(motivoFinal, diferencia, metodoFinal);
      } else {
        // Hay menos dinero en mano -> Añadir como gasto diario de ajuste no anotado
        await DataService.addGastoDiario(motivoFinal, Math.abs(diferencia), metodoFinal);
      }
    }

    UI.showNotification(`Capital actualizado a $${Math.round(objetivo).toLocaleString('es-AR')}`, 'success');
    UI.renderAll();
  }
};

// ==============================================================================
// 2. CÁLCULOS Y MÉTRICAS FINANCIERAS
// ==============================================================================

const Calculations = {
  isCurrentMonth(dateString) {
    if (!dateString) return true;
    if (dateString instanceof Date) {
      const now = new Date();
      return dateString.getFullYear() === now.getFullYear() && dateString.getMonth() === now.getMonth();
    }
    const now = new Date();
    const curYear = now.getFullYear();
    const curMonth = now.getMonth() + 1;

    const cleanStr = String(dateString).trim().split('T')[0].split(' ')[0];

    // Formato con guiones
    if (cleanStr.includes('-')) {
      const parts = cleanStr.split('-');
      if (parts.length === 3) {
        if (parts[0].length === 4) {
          // YYYY-MM-DD
          return parseInt(parts[0], 10) === curYear && parseInt(parts[1], 10) === curMonth;
        } else if (parts[2].length === 4) {
          // DD-MM-YYYY
          return parseInt(parts[2], 10) === curYear && parseInt(parts[1], 10) === curMonth;
        }
      } else if (parts.length === 2) {
        return parseInt(parts[0], 10) === curYear && parseInt(parts[1], 10) === curMonth;
      }
    }

    // Formato con barras DD/MM/YYYY o YYYY/MM/DD
    if (cleanStr.includes('/')) {
      const parts = cleanStr.split('/');
      if (parts.length === 3) {
        if (parts[2].length === 4) {
          // DD/MM/YYYY
          return parseInt(parts[2], 10) === curYear && parseInt(parts[1], 10) === curMonth;
        } else if (parts[0].length === 4) {
          // YYYY/MM/DD
          return parseInt(parts[0], 10) === curYear && parseInt(parts[1], 10) === curMonth;
        }
      } else if (parts.length === 2) {
        return parseInt(parts[1], 10) === curMonth;
      }
    }

    // Fallback Date object (evitando desfasaje UTC)
    const d = new Date(dateString);
    if (!isNaN(d.getTime())) {
      return (d.getUTCFullYear() === curYear && (d.getUTCMonth() + 1) === curMonth) ||
             (d.getFullYear() === curYear && (d.getMonth() + 1) === curMonth);
    }
    return false;
  },

  getMetrics() {
    const totalIngresos = AppState.data.ingresos
      .filter(i => Calculations.isCurrentMonth(i.fecha))
      .reduce((sum, i) => sum + (parseFloat(i.monto) || 0), 0);

    const totalGastosDiarios = AppState.data.diarios
      .filter(d => Calculations.isCurrentMonth(d.fecha))
      .reduce((sum, d) => sum + (parseFloat(d.monto) || 0), 0);

    let totalServiciosPagados = 0;
    let totalServiciosPendientes = 0;
    let totalServicios = 0;

    AppState.data.servicios.forEach(s => {
      const monto = parseFloat(s.monto) || 0;
      totalServicios += monto;
      if (s.estado === 'Pagado') totalServiciosPagados += monto;
      else totalServiciosPendientes += monto;
    });

    const cuotasTarjetas = AppState.data.tarjetas.reduce((sum, t) => {
      if ((t.cuotas_pagadas || 0) >= t.cuotas_totales) return sum;
      const nombre = (t.compra || '').toLowerCase().trim();
      const yaPagadaEsteMes = AppState.data.historial.some(h =>
        (h.categoria || '').toLowerCase().includes('cuota') &&
        Calculations.isCurrentMonth(h.fecha) &&
        (h.descripcion || '').toLowerCase().includes(nombre)
      );
      return yaPagadaEsteMes ? sum : sum + (parseFloat(t.monto_cuota) || 0);
    }, 0);

    const cuotasPrestamos = AppState.data.prestamos.reduce((sum, p) => {
      if ((p.cuotas_pagadas || 0) >= p.cuotas_totales) return sum;
      const nombre = (p.prestamo || '').toLowerCase().trim();
      const yaPagadaEsteMes = AppState.data.historial.some(h =>
        (h.categoria || '').toLowerCase().includes('cuota') &&
        Calculations.isCurrentMonth(h.fecha) &&
        (h.descripcion || '').toLowerCase().includes(nombre)
      );
      return yaPagadaEsteMes ? sum : sum + (parseFloat(p.monto_cuota) || 0);
    }, 0);

    // Saldo real = Ingresos del mes - (Gastos Diarios + Servicios Pagados)
    const saldoReal = totalIngresos - (totalGastosDiarios + totalServiciosPagados);

    // Saldo proyectado al final del mes (descontando pendientes y cuotas)
    const saldoProyectado = saldoReal - (totalServiciosPendientes + cuotasTarjetas + cuotasPrestamos);

    return {
      totalIngresos,
      totalGastosDiarios,
      totalServicios,
      totalServiciosPagados,
      totalServiciosPendientes,
      cuotasTarjetas,
      cuotasPrestamos,
      saldoReal,
      saldoProyectado
    };
  }
};

// ==============================================================================
// 3. ASISTENTE INTELIGENTE CON GOOGLE GEMINI AI
// ==============================================================================

const AIAssistant = {
  async processPrompt(promptText) {
    if (!promptText || !promptText.trim()) return;

    UI.appendChatMessage('user', promptText);
    UI.setAILoading(true);

    try {
      const metrics = Calculations.getMetrics();
      const context = `DATOS ACTUALES:
- Saldo Real: $${Math.round(metrics.saldoReal)}
- Ingresos Mes: $${Math.round(metrics.totalIngresos)}
- Gastos Diarios: $${Math.round(metrics.totalGastosDiarios)}
- Servicios Pendientes: ${JSON.stringify(AppState.data.servicios.filter(s => s.estado !== 'Pagado'))}
- Tarjetas: ${JSON.stringify(AppState.data.tarjetas)}
- Métodos de pago disponibles: ${AppState.data.metodos.join(', ')}`;

      let responseData;

      // 1. Intentar llamar al Serverless Function de Vercel (/api/gemini)
      try {
        const customApiKey = localStorage.getItem('CFP_GEMINI_API_KEY') || '';
        const res = await fetch('/api/gemini', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: promptText,
            financialContext: context,
            apiKey: customApiKey
          })
        });

        if (res.ok) {
          responseData = await res.json();
        } else {
          throw new Error(`Servidor Vercel respondió con estado: ${res.status}`);
        }
      } catch (serverErr) {
        console.warn('Fallo serverless /api/gemini, intentando llamada directa con clave guardada:', serverErr);
        // Fallback directo a Google Gemini API si hay API key local
        const customApiKey = localStorage.getItem('CFP_GEMINI_API_KEY');
        if (!customApiKey) throw new Error('Configura tu GEMINI_API_KEY en los Ajustes o en Vercel.');

        responseData = await AIAssistant.directGeminiCall(promptText, context, customApiKey);
      }

      // 2. Ejecutar la acción interpretada
      await AIAssistant.executeAction(responseData);

      // 3. Mostrar respuesta al usuario
      UI.appendChatMessage('assistant', responseData.mensaje_usuario || 'Entendido, he procesado tu solicitud.');
    } catch (err) {
      console.error('Error en Asistente IA:', err);
      UI.appendChatMessage('assistant', `⚠️ Ocurrió un inconveniente: ${err.message}`);
    } finally {
      UI.setAILoading(false);
    }
  },

  async directGeminiCall(promptText, context, apiKey) {
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
    const payload = {
      contents: [{ parts: [{ text: promptText }] }],
      systemInstruction: { parts: [{ text: `Eres el Asistente Financiero Pro. Interpreta el mensaje y responde en JSON puro con las llaves: tipo_accion, datos, mensaje_usuario.\n${context}` }] },
      generationConfig: { responseMimeType: "application/json" }
    };
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    return JSON.parse(text.replace(/^```json\s*/i, '').replace(/\s*```$/i, ''));
  },

  async executeAction(actionObj) {
    if (!actionObj || !actionObj.tipo_accion) return;

    const { tipo_accion, datos } = actionObj;

    switch (tipo_accion) {
      case 'REGISTRAR_DIARIO':
        if (datos.monto) {
          await DataService.addGastoDiario(datos.descripcion || 'Gasto vario', datos.monto, datos.metodo || 'Efectivo');
        }
        break;

      case 'REGISTRAR_INGRESO':
        if (datos.monto) {
          await DataService.addIngreso(datos.descripcion || 'Ingreso vario', datos.monto, datos.metodo || 'Transferencia');
        }
        break;

      case 'REGISTRAR_SERVICIO':
        if (datos.monto && datos.descripcion) {
          await DataService.addServicio(datos.descripcion, datos.monto, datos.vencimiento || 10);
        }
        break;

      case 'REGISTRAR_DEUDA':
        if (datos.monto && datos.descripcion) {
          await DataService.addDeuda(datos.tipo_deuda || 'tarjeta', datos.descripcion, datos.monto, datos.cuotas || 1, datos.metodo);
        }
        break;

      case 'PAGAR_SERVICIOS':
        if (datos.servicios_a_pagar && Array.isArray(datos.servicios_a_pagar)) {
          for (const servNom of datos.servicios_a_pagar) {
            const found = AppState.data.servicios.find(s => s.servicio.toLowerCase().includes(servNom.toLowerCase()));
            if (found && found.estado !== 'Pagado') {
              await DataService.toggleServicio(found.id, datos.metodo || 'General');
            }
          }
        }
        break;

      case 'RECONCILIAR_SALDO':
        if (datos.saldo_real_objetivo !== undefined && datos.saldo_real_objetivo !== null) {
          await DataService.reconciliarSaldo(
            datos.saldo_real_objetivo,
            datos.marcar_servicios_pagados !== false,
            datos.servicios_excluidos || [],
            datos.metodo || 'General'
          );
        }
        break;

      case 'TRANSFERIR_DINERO':
        if (datos.monto && datos.origen && datos.destino) {
          await DataService.transferirDinero(datos.origen, datos.destino, datos.monto, datos.nota || '');
        }
        break;

      case 'PAGAR_CUOTA':
        if (datos.deuda_nombre) {
          const list = [
            ...AppState.data.tarjetas.map(t => ({ ...t, _tipo: 'tarjeta' })),
            ...AppState.data.prestamos.map(p => ({ ...p, _tipo: 'prestamo' }))
          ];
          const found = list.find(d => (d.compra || d.prestamo || '').toLowerCase().includes(datos.deuda_nombre.toLowerCase()));
          if (found) {
            await DataService.pagarCuotaDeuda(found.id, found._tipo, datos.monto, datos.metodo);
          }
        }
        break;

      case 'ANALISIS':
      default:
        // No requiere mutación de base de datos
        break;
    }
  },

  // Inicializar Web Speech Recognition
  initVoice() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn('Reconocimiento de voz no soportado en este navegador.');
      return;
    }

    AppState.recognition = new SpeechRecognition();
    AppState.recognition.lang = 'es-AR';
    AppState.recognition.continuous = false;
    AppState.recognition.interimResults = false;

    AppState.recognition.onstart = () => {
      AppState.isRecording = true;
      UI.updateMicButton(true);
    };

    AppState.recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      const input = document.getElementById('ai-input-text');
      if (input) input.value = transcript;
      AIAssistant.processPrompt(transcript);
    };

    AppState.recognition.onerror = (event) => {
      console.error('Error de voz:', event.error);
      AppState.isRecording = false;
      UI.updateMicButton(false);
    };

    AppState.recognition.onend = () => {
      AppState.isRecording = false;
      UI.updateMicButton(false);
    };
  },

  toggleVoice() {
    if (!AppState.recognition) AIAssistant.initVoice();
    if (!AppState.recognition) {
      UI.showNotification('Tu navegador no soporta dictado por voz.', 'warning');
      return;
    }

    if (AppState.isRecording) {
      AppState.recognition.stop();
    } else {
      AppState.recognition.start();
    }
  }
};

// ==============================================================================
// 4. INTERFAZ DE USUARIO Y RENDERIZADO (UI)
// ==============================================================================

const UI = {
  formatCurrency(val) {
    const num = parseFloat(val) || 0;
    return '$' + Math.round(num).toLocaleString('es-AR');
  },

  renderAll() {
    UI.renderDashboard();
    UI.renderDiarios();
    UI.renderServicios();
    UI.renderDeudas();
    UI.renderHistorial();
    UI.renderMetodosSelects();
    UI.renderMetodosList();
  },

  renderDashboard() {
    const m = Calculations.getMetrics();

    const elSaldoReal = document.getElementById('metric-saldo-real');
    const elIngresos = document.getElementById('metric-ingresos');
    const elGastosDiarios = document.getElementById('metric-gastos-diarios');
    const elServiciosFijos = document.getElementById('metric-servicios-fijos');
    const elServiciosPendientes = document.getElementById('metric-servicios-pendientes');
    const elSaldoProyectado = document.getElementById('metric-saldo-proyectado');

    if (elSaldoReal) elSaldoReal.textContent = UI.formatCurrency(m.saldoReal);
    if (elIngresos) elIngresos.textContent = UI.formatCurrency(m.totalIngresos);
    if (elGastosDiarios) elGastosDiarios.textContent = UI.formatCurrency(m.totalGastosDiarios);
    if (elServiciosFijos) elServiciosFijos.textContent = UI.formatCurrency(m.totalServicios);
    if (elServiciosPendientes) elServiciosPendientes.textContent = UI.formatCurrency(m.totalServiciosPendientes);
    if (elSaldoProyectado) elSaldoProyectado.textContent = UI.formatCurrency(m.saldoProyectado);

    UI.renderDashboardIngresos();
    UI.renderChart(m);
  },

  renderDashboardIngresos() {
    const container = document.getElementById('dashboard-recent-ingresos');
    if (!container) return;

    if (!AppState.data.ingresos || AppState.data.ingresos.length === 0) {
      container.innerHTML = `
        <div class="text-center py-6 text-slate-500 bg-slate-900/40 rounded-2xl border border-slate-800">
          <i class="fa-solid fa-wallet text-2xl mb-1.5 opacity-60"></i>
          <p class="text-xs">No hay fondos o ingresos registrados todavía.</p>
        </div>`;
      return;
    }

    container.innerHTML = AppState.data.ingresos.map(i => `
      <div class="flex items-center justify-between p-3.5 bg-slate-800/60 rounded-xl border border-slate-700/50 hover:border-slate-600 transition">
        <div class="flex items-center gap-3">
          <div class="w-8 h-8 rounded-lg bg-emerald-500/10 text-emerald-400 flex items-center justify-center font-bold text-xs">
            <i class="fa-solid fa-arrow-down"></i>
          </div>
          <div>
            <h4 class="text-sm font-semibold text-white">${i.descripcion}</h4>
            <span class="text-xs text-slate-400">${i.metodo || 'General'} • ${i.fecha || ''}</span>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-sm font-bold text-emerald-400">+${UI.formatCurrency(i.monto)}</span>
          <button onclick="DataService.deleteIngreso('${i.id}')" class="text-slate-500 hover:text-rose-400 p-1.5 transition" title="Eliminar ingreso">
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

    AppState.chartInstance = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['Gastos Diarios', 'Servicios Pagados', 'Servicios Pendientes', 'Cuotas Deudas', 'Saldo Disponible'],
        datasets: [{
          data: [
            Math.max(0, m.totalGastosDiarios),
            Math.max(0, m.totalServiciosPagados),
            Math.max(0, m.totalServiciosPendientes),
            Math.max(0, m.cuotasTarjetas + m.cuotasPrestamos),
            Math.max(0, m.saldoProyectado)
          ],
          backgroundColor: ['#F43F5E', '#10B981', '#F59E0B', '#8B5CF6', '#3B82F6'],
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
            labels: { color: '#94A3B8', font: { family: 'Plus Jakarta Sans', size: 12 } }
          }
        },
        cutout: '70%'
      }
    });
  },

  renderDiarios() {
    const container = document.getElementById('list-diarios');
    if (!container) return;

    if (AppState.data.diarios.length === 0) {
      container.innerHTML = `<div class="text-center py-8 text-slate-500"><i class="fa-solid fa-receipt text-3xl mb-2"></i><p>No hay gastos diarios registrados este mes.</p></div>`;
      return;
    }

    container.innerHTML = AppState.data.diarios.map(d => `
      <div class="flex items-center justify-between p-3.5 bg-slate-800/60 rounded-xl border border-slate-700/50 hover:border-slate-600 transition">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-lg bg-rose-500/10 text-rose-400 flex items-center justify-center font-bold">
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
      container.innerHTML = `<div class="text-center py-8 text-slate-500"><i class="fa-solid fa-calendar-check text-3xl mb-2"></i><p>No hay servicios fijos configurados.</p></div>`;
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
        : `<span class="px-2.5 py-1 text-xs font-semibold rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20">Vence día ${s.vencimiento}</span>`;

      return `
        <div class="flex flex-col md:flex-row md:items-center justify-between p-4 bg-slate-800/60 rounded-xl border border-slate-700/50 gap-3">
          <div class="flex items-center gap-3">
            <button onclick="DataService.toggleServicio('${s.id}')" class="w-8 h-8 rounded-lg flex items-center justify-center transition ${isPaid ? 'bg-emerald-500 text-white' : 'bg-slate-700 text-slate-400 hover:bg-slate-600'}">
              <i class="fa-solid fa-check text-sm"></i>
            </button>
            <div>
              <h4 class="text-sm font-semibold ${isPaid ? 'text-slate-400 line-through' : 'text-white'}">${s.servicio}</h4>
              <div class="flex items-center gap-2 mt-1">
                ${statusBadge}
                ${s.comprobante_url ? `<a href="${s.comprobante_url}" target="_blank" class="text-xs text-indigo-400 hover:underline"><i class="fa-solid fa-paperclip"></i> Voucher</a>` : ''}
              </div>
            </div>
          </div>
          <div class="flex items-center justify-between md:justify-end gap-3">
            <span class="text-base font-bold ${isPaid ? 'text-slate-400' : 'text-white'}">${UI.formatCurrency(s.monto)}</span>
            <div class="flex items-center gap-1.5">
              <button onclick="abrirModalEditarServicio('${s.id}')" class="text-slate-400 hover:text-indigo-400 p-2 rounded-lg hover:bg-slate-700/50 transition" title="Editar servicio">
                <i class="fa-solid fa-pen-to-square"></i>
              </button>
              <label class="cursor-pointer text-slate-400 hover:text-indigo-400 p-2 rounded-lg hover:bg-slate-700/50 transition" title="Subir comprobante">
                <i class="fa-solid fa-cloud-arrow-up"></i>
                <input type="file" accept="image/*,.pdf" class="hidden" onchange="DataService.uploadVoucher('${s.id}', this.files[0])">
              </label>
              <button onclick="DataService.deleteServicio('${s.id}')" class="text-slate-500 hover:text-rose-400 p-2 rounded-lg hover:bg-slate-700/50 transition" title="Eliminar">
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
    const containerPrestamos = document.getElementById('list-prestamos');

    // Totales y resumen de deudas
    let totalDeudaRestante = 0;
    let cuotasMesTotal = 0;
    let activasCount = 0;

    AppState.data.tarjetas.forEach(t => {
      const restCuotas = Math.max(0, (t.cuotas_totales || 1) - (t.cuotas_pagadas || 0));
      if (restCuotas > 0) {
        activasCount++;
        cuotasMesTotal += (parseFloat(t.monto_cuota) || 0);
        totalDeudaRestante += restCuotas * (parseFloat(t.monto_cuota) || 0);
      }
    });

    AppState.data.prestamos.forEach(p => {
      const restCuotas = Math.max(0, (p.cuotas_totales || 1) - (p.cuotas_pagadas || 0));
      if (restCuotas > 0) {
        activasCount++;
        cuotasMesTotal += (parseFloat(p.monto_cuota) || 0);
        totalDeudaRestante += restCuotas * (parseFloat(p.monto_cuota) || 0);
      }
    });

    const elTotalDeuda = document.getElementById('metric-total-deuda');
    const elCuotasMes = document.getElementById('metric-cuotas-mes-deuda');
    const elActivas = document.getElementById('metric-deudas-activas');
    if (elTotalDeuda) elTotalDeuda.textContent = UI.formatCurrency(totalDeudaRestante);
    if (elCuotasMes) elCuotasMes.textContent = UI.formatCurrency(cuotasMesTotal);
    if (elActivas) elActivas.textContent = activasCount;

    if (containerTarjetas) {
      if (AppState.data.tarjetas.length === 0) {
        containerTarjetas.innerHTML = `<p class="text-sm text-slate-500 py-4 text-center col-span-2">No hay compras en cuotas activas.</p>`;
      } else {
        containerTarjetas.innerHTML = AppState.data.tarjetas.map(t => {
          const restCuotas = Math.max(0, (t.cuotas_totales || 1) - (t.cuotas_pagadas || 0));
          const restMonto = restCuotas * (parseFloat(t.monto_cuota) || 0);
          const pct = Math.min(100, Math.round(((t.cuotas_pagadas || 0) / (t.cuotas_totales || 1)) * 100));
          return `
            <div class="p-4 bg-slate-800/60 rounded-2xl border border-slate-700/50 space-y-3">
              <div class="flex justify-between items-start">
                <div>
                  <h4 class="font-bold text-white text-sm">${t.compra}</h4>
                  <span class="text-xs text-slate-400">${t.cuotas_pagadas || 0}/${t.cuotas_totales} cuotas pagadas (${pct}%)</span>
                </div>
                <div class="text-right">
                  <span class="text-sm font-extrabold text-indigo-400 block">${UI.formatCurrency(t.monto_cuota)} / mes</span>
                  <span class="text-[11px] text-slate-400">Resta: ${UI.formatCurrency(restMonto)}</span>
                </div>
              </div>
              <div class="w-full bg-slate-700 h-2 rounded-full overflow-hidden">
                <div class="bg-indigo-500 h-full rounded-full transition-all duration-500" style="width: ${pct}%"></div>
              </div>
              <div class="flex justify-between items-center pt-1">
                <span class="text-xs text-slate-400">Total: ${UI.formatCurrency(t.monto_total)}</span>
                <div class="flex items-center gap-1.5">
                  ${(t.cuotas_pagadas || 0) < t.cuotas_totales ? `
                    <button onclick="abrirModalPagarCuota('${t.id}', 'tarjeta')" class="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold rounded-lg text-white transition active:scale-95">
                      Pagar Cuota
                    </button>
                  ` : `<span class="text-xs text-emerald-400 font-semibold px-2">Completado</span>`}
                  <button onclick="abrirModalEditarDeuda('${t.id}', 'tarjeta')" class="text-slate-400 hover:text-indigo-300 p-1.5 rounded-lg hover:bg-slate-700/50 transition" title="Editar deuda">
                    <i class="fa-solid fa-pen-to-square"></i>
                  </button>
                  <button onclick="DataService.deleteDeuda('${t.id}', 'tarjeta')" class="text-slate-500 hover:text-rose-400 p-1.5 rounded-lg hover:bg-slate-700/50 transition" title="Eliminar">
                    <i class="fa-regular fa-trash-can"></i>
                  </button>
                </div>
              </div>
            </div>
          `;
        }).join('');
      }
    }

    if (containerPrestamos) {
      if (AppState.data.prestamos.length === 0) {
        containerPrestamos.innerHTML = `<p class="text-sm text-slate-500 py-4 text-center col-span-2">No hay préstamos activos.</p>`;
      } else {
        containerPrestamos.innerHTML = AppState.data.prestamos.map(p => {
          const restCuotas = Math.max(0, (p.cuotas_totales || 1) - (p.cuotas_pagadas || 0));
          const restMonto = restCuotas * (parseFloat(p.monto_cuota) || 0);
          const pct = Math.min(100, Math.round(((p.cuotas_pagadas || 0) / (p.cuotas_totales || 1)) * 100));
          return `
            <div class="p-4 bg-slate-800/60 rounded-2xl border border-slate-700/50 space-y-3">
              <div class="flex justify-between items-start">
                <div>
                  <h4 class="font-bold text-white text-sm">${p.prestamo}</h4>
                  <span class="text-xs text-slate-400">${p.cuotas_pagadas || 0}/${p.cuotas_totales} cuotas abonadas (${pct}%)</span>
                </div>
                <div class="text-right">
                  <span class="text-sm font-extrabold text-violet-400 block">${UI.formatCurrency(p.monto_cuota)} / mes</span>
                  <span class="text-[11px] text-slate-400">Resta: ${UI.formatCurrency(restMonto)}</span>
                </div>
              </div>
              <div class="w-full bg-slate-700 h-2 rounded-full overflow-hidden">
                <div class="bg-violet-500 h-full rounded-full transition-all duration-500" style="width: ${pct}%"></div>
              </div>
              <div class="flex justify-between items-center pt-1">
                <span class="text-xs text-slate-400">Total: ${UI.formatCurrency(p.monto_total)}</span>
                <div class="flex items-center gap-1.5">
                  ${(p.cuotas_pagadas || 0) < p.cuotas_totales ? `
                    <button onclick="abrirModalPagarCuota('${p.id}', 'prestamo')" class="px-2.5 py-1 bg-violet-600 hover:bg-violet-500 text-xs font-semibold rounded-lg text-white transition active:scale-95">
                      Pagar Cuota
                    </button>
                  ` : `<span class="text-xs text-emerald-400 font-semibold px-2">Cancelado</span>`}
                  <button onclick="abrirModalEditarDeuda('${p.id}', 'prestamo')" class="text-slate-400 hover:text-violet-300 p-1.5 rounded-lg hover:bg-slate-700/50 transition" title="Editar préstamo">
                    <i class="fa-solid fa-pen-to-square"></i>
                  </button>
                  <button onclick="DataService.deleteDeuda('${p.id}', 'prestamo')" class="text-slate-500 hover:text-rose-400 p-1.5 rounded-lg hover:bg-slate-700/50 transition" title="Eliminar">
                    <i class="fa-regular fa-trash-can"></i>
                  </button>
                </div>
              </div>
            </div>
          `;
        }).join('');
      }
    }
  },

  renderHistorial() {
    const container = document.getElementById('list-historial');
    if (!container) return;

    if (AppState.data.historial.length === 0) {
      container.innerHTML = `<div class="text-center py-8 text-slate-500"><i class="fa-solid fa-clock-rotate-left text-3xl mb-2"></i><p>Sin movimientos recientes.</p></div>`;
      return;
    }

    container.innerHTML = AppState.data.historial.slice(0, 50).map(h => {
      const isTransfer = h.categoria && h.categoria.toLowerCase().includes('traspaso');
      const isPositive = !isTransfer && (h.categoria.toLowerCase().includes('ingreso') || h.monto > 0);
      
      let icon = isPositive ? 'fa-arrow-down' : 'fa-arrow-up';
      let iconColor = isPositive ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400';
      if (isTransfer) {
        icon = 'fa-right-left';
        iconColor = 'bg-blue-500/10 text-blue-400';
      }

      return `
        <div class="flex items-center justify-between p-3.5 bg-slate-800/40 rounded-xl border border-slate-700/40 text-sm">
          <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-lg ${iconColor} flex items-center justify-center font-bold text-xs">
              <i class="fa-solid ${icon}"></i>
            </div>
            <div>
              <p class="font-medium text-white">${h.descripcion}</p>
              <span class="text-xs text-slate-400">${h.categoria} • ${h.metodo} • ${h.fecha}</span>
            </div>
          </div>
          <span class="font-bold ${isTransfer ? 'text-blue-400' : (isPositive ? 'text-emerald-400' : 'text-slate-300')}">
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

    // Configurar sugerencias automáticas para traspaso
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
      <div class="flex items-center justify-between p-2.5 bg-slate-800 rounded-lg border border-slate-700 text-sm">
        <span class="text-slate-300"><i class="fa-solid fa-wallet text-indigo-400 mr-2"></i>${m}</span>
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

  appendChatMessage(sender, text) {
    const container = document.getElementById('chat-messages');
    if (!container) return;

    const isUser = sender === 'user';
    const msgDiv = document.createElement('div');
    msgDiv.className = `flex gap-3 ${isUser ? 'justify-end' : 'justify-start'} animate-fade-in`;
    msgDiv.innerHTML = `
      ${!isUser ? `<div class="w-8 h-8 rounded-full bg-indigo-600 flex items-center justify-center text-white shrink-0 text-xs"><i class="fa-solid fa-wand-magic-sparkles"></i></div>` : ''}
      <div class="max-w-[85%] md:max-w-[70%] p-3.5 rounded-2xl text-sm ${isUser ? 'bg-indigo-600 text-white rounded-br-none' : 'bg-slate-800 text-slate-200 border border-slate-700 rounded-bl-none'}">
        ${text}
      </div>
      ${isUser ? `<div class="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center text-white shrink-0 text-xs"><i class="fa-solid fa-user"></i></div>` : ''}
    `;
    container.appendChild(msgDiv);
    container.scrollTop = container.scrollHeight;
  },

  setAILoading(loading) {
    const indicator = document.getElementById('ai-loading-indicator');
    if (indicator) indicator.classList.toggle('hidden', !loading);
  },

  updateMicButton(recording) {
    const micBtn = document.getElementById('btn-voice-mic');
    if (micBtn) {
      micBtn.classList.toggle('bg-rose-600', recording);
      micBtn.classList.toggle('animate-pulse', recording);
      micBtn.classList.toggle('bg-slate-700', !recording);
    }
  },

  showNotification(message, type = 'info') {
    const banner = document.getElementById('toast-notification');
    if (!banner) return;

    banner.textContent = message;
    banner.className = `fixed bottom-20 left-1/2 -translate-x-1/2 px-5 py-2.5 rounded-full text-xs font-semibold text-white shadow-xl transition-all duration-300 z-50 ${
      type === 'success' ? 'bg-emerald-600' : type === 'error' ? 'bg-rose-600' : type === 'warning' ? 'bg-amber-600' : 'bg-indigo-600'
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
// 5. EVENT LISTENERS E INICIALIZACIÓN
// ==============================================================================

window.addEventListener('DOMContentLoaded', () => {
  DataService.loadAllData();
  AIAssistant.initVoice();

  // Navegación
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => UI.switchTab(btn.dataset.tab));
  });

  // Chat AI
  const chatForm = document.getElementById('ai-chat-form');
  const chatInput = document.getElementById('ai-input-text');
  if (chatForm && chatInput) {
    chatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const val = chatInput.value.trim();
      if (val) {
        chatInput.value = '';
        AIAssistant.processPrompt(val);
      }
    });
  }

  // Cargar Ajustes guardados
  const inputSupabaseUrl = document.getElementById('setting-supabase-url');
  const inputSupabaseKey = document.getElementById('setting-supabase-key');
  const inputGeminiKey = document.getElementById('setting-gemini-key');

  if (inputSupabaseUrl) inputSupabaseUrl.value = SupabaseConfig.getUrl();
  if (inputSupabaseKey) inputSupabaseKey.value = SupabaseConfig.getKey();
  if (inputGeminiKey) inputGeminiKey.value = localStorage.getItem('CFP_GEMINI_API_KEY') || '';
});
