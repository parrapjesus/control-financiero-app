-- ==============================================================================
-- CONTROL FINANCIERO PRO - ESQUEMA DE BASE DE DATOS PARA SUPABASE (POSTGRESQL)
-- ==============================================================================
-- Ejecuta este script completo en el SQL Editor de tu proyecto en Supabase.
-- Incluye: Tablas relacionales, Claves Foráneas, Índices, RLS (Seguridad) y Storage.
-- ==============================================================================

-- 1. Habilitar extensión UUID
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. TABLA: Métodos de Pago / Billeteras / Bancos
CREATE TABLE IF NOT EXISTS public.metodos_pago (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    nombre TEXT NOT NULL,
    icono TEXT DEFAULT 'wallet',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 3. TABLA: Ingresos
CREATE TABLE IF NOT EXISTS public.ingresos (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    descripcion TEXT NOT NULL,
    monto NUMERIC(12, 2) NOT NULL CHECK (monto >= 0),
    fecha DATE NOT NULL DEFAULT CURRENT_DATE,
    metodo TEXT NOT NULL DEFAULT 'Efectivo',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 4. TABLA: Gastos Diarios
CREATE TABLE IF NOT EXISTS public.gastos_diarios (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    descripcion TEXT NOT NULL,
    monto NUMERIC(12, 2) NOT NULL CHECK (monto >= 0),
    fecha DATE NOT NULL DEFAULT CURRENT_DATE,
    metodo TEXT NOT NULL DEFAULT 'Efectivo',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 5. TABLA: Gastos Fijos y Servicios
CREATE TABLE IF NOT EXISTS public.gastos_fijos (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
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
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
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
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    fecha TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    categoria TEXT NOT NULL,
    descripcion TEXT NOT NULL,
    monto NUMERIC(12, 2) NOT NULL,
    metodo TEXT NOT NULL DEFAULT 'General'
);

-- ==============================================================================
-- CONFIGURACIÓN DE ROW LEVEL SECURITY (RLS) - SEGURIDAD MULTI-USUARIO
-- ==============================================================================
ALTER TABLE public.metodos_pago ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ingresos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gastos_diarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gastos_fijos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deudas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.historial ENABLE ROW LEVEL SECURITY;

-- Políticas para Metodos de Pago
CREATE POLICY "Usuarios pueden gestionar sus metodos de pago"
ON public.metodos_pago FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Políticas para Ingresos
CREATE POLICY "Usuarios pueden gestionar sus ingresos"
ON public.ingresos FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Políticas para Gastos Diarios
CREATE POLICY "Usuarios pueden gestionar sus gastos diarios"
ON public.gastos_diarios FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Políticas para Gastos Fijos
CREATE POLICY "Usuarios pueden gestionar sus gastos fijos"
ON public.gastos_fijos FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Políticas para Deudas
CREATE POLICY "Usuarios pueden gestionar sus deudas"
ON public.deudas FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Políticas para Historial
CREATE POLICY "Usuarios pueden ver y registrar historial"
ON public.historial FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ==============================================================================
-- STORAGE BUCKET PARA COMPROBANTES / VOUCHERS
-- ==============================================================================
INSERT INTO storage.buckets (id, name, public) 
VALUES ('vouchers', 'vouchers', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Vouchers accesibles por usuarios autenticados"
ON storage.objects FOR ALL
USING (bucket_id = 'vouchers' AND auth.uid()::text = (storage.foldername(name))[1])
WITH CHECK (bucket_id = 'vouchers' AND auth.uid()::text = (storage.foldername(name))[1]);

-- Políticas públicas de lectura para vouchers (opcional si URLs públicas activadas)
CREATE POLICY "Vouchers públicos para lectura"
ON storage.objects FOR SELECT
USING (bucket_id = 'vouchers');

-- ==============================================================================
-- DATOS SEMILLA POR DEFECTO PARA NUEVOS USUARIOS (Trigger Automático)
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    -- Crear métodos de pago por defecto para el usuario recién registrado
    INSERT INTO public.metodos_pago (user_id, nombre) VALUES
        (NEW.id, 'Efectivo'),
        (NEW.id, 'Transferencia'),
        (NEW.id, 'Mercado Pago'),
        (NEW.id, 'Mercado Crédito'),
        (NEW.id, 'Tarjeta de Crédito');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
