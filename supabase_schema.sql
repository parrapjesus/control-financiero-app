-- ==============================================================================
-- CONTROL FINANCIERO PRO - ESQUEMA DE BASE DE DATOS PARA SUPABASE (POSTGRESQL)
-- ==============================================================================
-- Ejecuta este script completo en el SQL Editor de tu proyecto en Supabase.
-- ==============================================================================

-- 1. Habilitar extensión UUID
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. TABLA: Métodos de Pago / Billeteras / Bancos
CREATE TABLE IF NOT EXISTS public.metodos_pago (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID,
    nombre TEXT NOT NULL UNIQUE,
    icono TEXT DEFAULT 'wallet',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 3. TABLA: Ingresos
CREATE TABLE IF NOT EXISTS public.ingresos (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID,
    descripcion TEXT NOT NULL,
    monto NUMERIC(12, 2) NOT NULL CHECK (monto >= 0),
    fecha DATE NOT NULL DEFAULT CURRENT_DATE,
    metodo TEXT NOT NULL DEFAULT 'Efectivo',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 4. TABLA: Gastos Diarios
CREATE TABLE IF NOT EXISTS public.gastos_diarios (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID,
    descripcion TEXT NOT NULL,
    monto NUMERIC(12, 2) NOT NULL CHECK (monto >= 0),
    fecha DATE NOT NULL DEFAULT CURRENT_DATE,
    metodo TEXT NOT NULL DEFAULT 'Efectivo',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 5. TABLA: Gastos Fijos y Servicios
CREATE TABLE IF NOT EXISTS public.gastos_fijos (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID,
    servicio TEXT NOT NULL,
    monto NUMERIC(12, 2) NOT NULL CHECK (monto >= 0),
    vencimiento INTEGER NOT NULL CHECK (vencimiento >= 1 AND vencimiento <= 31),
    estado TEXT NOT NULL DEFAULT 'Pendiente' CHECK (estado IN ('Pendiente', 'Pagado')),
    comprobante_url TEXT,
    fecha_pago DATE,
    metodo_pago TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 6. TABLA: Deudas (Tarjetas de Crédito y Préstamos)
CREATE TABLE IF NOT EXISTS public.deudas (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID,
    tipo TEXT NOT NULL CHECK (tipo IN ('tarjeta', 'prestamo')),
    nombre TEXT NOT NULL,
    monto_total NUMERIC(12, 2) NOT NULL CHECK (monto_total >= 0),
    cuotas_totales INTEGER NOT NULL CHECK (cuotas_totales >= 1),
    cuotas_pagadas INTEGER NOT NULL DEFAULT 0 CHECK (cuotas_pagadas >= 0),
    monto_cuota NUMERIC(12, 2) NOT NULL CHECK (monto_cuota >= 0),
    fecha_inicio DATE NOT NULL DEFAULT CURRENT_DATE,
    metodo TEXT NOT NULL DEFAULT 'Tarjeta de Crédito',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 7. TABLA: Historial de Transacciones (Auditoría / Timeline)
CREATE TABLE IF NOT EXISTS public.historial (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID,
    fecha TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    categoria TEXT NOT NULL,
    descripcion TEXT NOT NULL,
    monto NUMERIC(12, 2) NOT NULL,
    metodo TEXT NOT NULL DEFAULT 'General'
);

-- ==============================================================================
-- HABILITAR RLS CON POLÍTICAS DE ACCESO PARA APP PERSONAL
-- ==============================================================================
ALTER TABLE public.metodos_pago ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ingresos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gastos_diarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gastos_fijos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deudas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.historial ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Acceso total metodos_pago" ON public.metodos_pago;
CREATE POLICY "Acceso total metodos_pago" ON public.metodos_pago FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Acceso total ingresos" ON public.ingresos;
CREATE POLICY "Acceso total ingresos" ON public.ingresos FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Acceso total gastos_diarios" ON public.gastos_diarios;
CREATE POLICY "Acceso total gastos_diarios" ON public.gastos_diarios FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Acceso total gastos_fijos" ON public.gastos_fijos;
CREATE POLICY "Acceso total gastos_fijos" ON public.gastos_fijos FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Acceso total deudas" ON public.deudas;
CREATE POLICY "Acceso total deudas" ON public.deudas FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Acceso total historial" ON public.historial;
CREATE POLICY "Acceso total historial" ON public.historial FOR ALL USING (true) WITH CHECK (true);

-- ==============================================================================
-- STORAGE BUCKET PARA COMPROBANTES / VOUCHERS
-- ==============================================================================
INSERT INTO storage.buckets (id, name, public) 
VALUES ('vouchers', 'vouchers', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Vouchers publicos acceso total" ON storage.objects;
CREATE POLICY "Vouchers publicos acceso total"
ON storage.objects FOR ALL
USING (bucket_id = 'vouchers')
WITH CHECK (bucket_id = 'vouchers');

-- ==============================================================================
-- MÉTODOS DE PAGO INICIALES POR DEFECTO
-- ==============================================================================
INSERT INTO public.metodos_pago (nombre) VALUES
    ('Efectivo'),
    ('Transferencia'),
    ('Mercado Pago'),
    ('Mercado Crédito'),
    ('Tarjeta de Crédito')
ON CONFLICT (nombre) DO NOTHING;
