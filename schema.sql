-- ============================================================
-- PROVISIO — Schema SQL completo
-- Ejecutar en: Supabase SQL Editor
-- ============================================================

-- ─── EXTENSIONES ────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ─── TABLAS ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS hogares (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  nombre             text NOT NULL,
  codigo_invitacion  text NOT NULL UNIQUE,
  creado_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS perfiles (
  id              uuid PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,
  hogar_id        uuid REFERENCES hogares(id) ON DELETE SET NULL,
  nombre_completo text NOT NULL,
  rol             text NOT NULL DEFAULT 'admin' CHECK (rol IN ('admin', 'miembro')),
  creado_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS espacios (
  id        uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  hogar_id  uuid NOT NULL REFERENCES hogares(id) ON DELETE CASCADE,
  nombre    text NOT NULL,
  creado_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventario (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  hogar_id         uuid NOT NULL REFERENCES hogares(id) ON DELETE CASCADE,
  espacio_id       uuid REFERENCES espacios(id) ON DELETE SET NULL,
  nombre           text NOT NULL,
  categoria        text,
  categoria_emoji  text DEFAULT '📦',
  precio_total     numeric(10,2) NOT NULL DEFAULT 0,
  stock_actual     numeric(10,3) NOT NULL DEFAULT 0,
  stock_minimo     numeric(10,3) NOT NULL DEFAULT 1,
  fraccionado      boolean NOT NULL DEFAULT false,
  unidades_fraccion int NOT NULL DEFAULT 1,
  creado_at        timestamptz NOT NULL DEFAULT now(),
  actualizado_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ocr_learning_diccionario (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  hogar_id        uuid NOT NULL REFERENCES hogares(id) ON DELETE CASCADE,
  texto_sucio     text NOT NULL,
  nombre_corregido text NOT NULL,
  veces_usado     int NOT NULL DEFAULT 1,
  creado_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hogar_id, texto_sucio)
);

CREATE TABLE IF NOT EXISTS pendientes_validacion (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  hogar_id          uuid NOT NULL REFERENCES hogares(id) ON DELETE CASCADE,
  datos_ocr         jsonb NOT NULL DEFAULT '[]',
  imagen_thumbnail  text,
  creado_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS resumen_mensual (
  id                      uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  hogar_id                uuid NOT NULL REFERENCES hogares(id) ON DELETE CASCADE,
  mes                     int NOT NULL CHECK (mes BETWEEN 1 AND 12),
  anio                    int NOT NULL CHECK (anio > 2000),
  gasto_total             numeric(10,2) NOT NULL DEFAULT 0,
  listado_productos_texto text,
  UNIQUE (hogar_id, mes, anio)
);

-- ─── ÍNDICES ────────────────────────────────────────────────

-- Fuzzy matching OCR
CREATE INDEX IF NOT EXISTS idx_ocr_trgm
  ON ocr_learning_diccionario USING GIN (texto_sucio gin_trgm_ops);

-- Consultas frecuentes de inventario por hogar/espacio
CREATE INDEX IF NOT EXISTS idx_inventario_hogar
  ON inventario (hogar_id, espacio_id);

CREATE INDEX IF NOT EXISTS idx_inventario_stock_alert
  ON inventario (hogar_id) WHERE stock_actual <= stock_minimo;

CREATE INDEX IF NOT EXISTS idx_inventario_purge_candidates
  ON inventario (hogar_id, creado_at) WHERE stock_actual = 0;

CREATE INDEX IF NOT EXISTS idx_espacios_hogar
  ON espacios (hogar_id);

-- ─── FUNCIÓN HELPER RLS ─────────────────────────────────────

CREATE OR REPLACE FUNCTION get_my_hogar_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT hogar_id FROM perfiles WHERE id = auth.uid();
$$;

-- ─── TRIGGER: PERFIL AUTOMÁTICO AL REGISTRARSE ──────────────

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO perfiles (id, nombre_completo, rol)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
    'admin'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE PROCEDURE handle_new_user();

-- ─── FUNCIÓN RPC: UPSERT RESUMEN MENSUAL ────────────────────
-- Usada por el Motor de Purga Silenciosa en app.js

CREATE OR REPLACE FUNCTION upsert_resumen(
  p_mes   int,
  p_anio  int,
  p_gasto numeric,
  p_nombre text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hogar_id uuid;
BEGIN
  v_hogar_id := get_my_hogar_id();

  INSERT INTO resumen_mensual (id, hogar_id, mes, anio, gasto_total, listado_productos_texto)
  VALUES (uuid_generate_v4(), v_hogar_id, p_mes, p_anio, p_gasto, p_nombre)
  ON CONFLICT (hogar_id, mes, anio) DO UPDATE SET
    gasto_total = resumen_mensual.gasto_total + EXCLUDED.gasto_total,
    listado_productos_texto = CASE
      WHEN resumen_mensual.listado_productos_texto IS NULL OR resumen_mensual.listado_productos_texto = ''
        THEN EXCLUDED.listado_productos_texto
      ELSE resumen_mensual.listado_productos_texto || ', ' || EXCLUDED.listado_productos_texto
    END;
END;
$$;

-- ─── ROW LEVEL SECURITY ─────────────────────────────────────

ALTER TABLE hogares               ENABLE ROW LEVEL SECURITY;
ALTER TABLE perfiles              ENABLE ROW LEVEL SECURITY;
ALTER TABLE espacios              ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventario            ENABLE ROW LEVEL SECURITY;
ALTER TABLE ocr_learning_diccionario ENABLE ROW LEVEL SECURITY;
ALTER TABLE pendientes_validacion ENABLE ROW LEVEL SECURITY;
ALTER TABLE resumen_mensual       ENABLE ROW LEVEL SECURITY;

-- ── hogares ──────────────────────────────────────────────────
DROP POLICY IF EXISTS "members can view their hogar"          ON hogares;
DROP POLICY IF EXISTS "authenticated users can create hogares" ON hogares;
DROP POLICY IF EXISTS "admin can update hogar"                ON hogares;

CREATE POLICY "members can view their hogar"
  ON hogares FOR SELECT
  USING (id = get_my_hogar_id());

CREATE POLICY "authenticated users can create hogares"
  ON hogares FOR INSERT
  WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "admin can update hogar"
  ON hogares FOR UPDATE
  USING (id = get_my_hogar_id());

-- ── perfiles ─────────────────────────────────────────────────
DROP POLICY IF EXISTS "users can view own profile"   ON perfiles;
DROP POLICY IF EXISTS "users can view hogar members" ON perfiles;
DROP POLICY IF EXISTS "users can insert own profile" ON perfiles;
DROP POLICY IF EXISTS "users can update own profile" ON perfiles;

CREATE POLICY "users can view own profile"
  ON perfiles FOR SELECT
  USING (id = auth.uid());

CREATE POLICY "users can view hogar members"
  ON perfiles FOR SELECT
  USING (hogar_id = get_my_hogar_id());

CREATE POLICY "users can insert own profile"
  ON perfiles FOR INSERT
  WITH CHECK (id = auth.uid());

CREATE POLICY "users can update own profile"
  ON perfiles FOR UPDATE
  USING (id = auth.uid());

-- ── espacios ─────────────────────────────────────────────────
DROP POLICY IF EXISTS "members can manage espacios" ON espacios;

CREATE POLICY "members can manage espacios"
  ON espacios FOR ALL
  USING (hogar_id = get_my_hogar_id())
  WITH CHECK (hogar_id = get_my_hogar_id());

-- ── inventario ───────────────────────────────────────────────
DROP POLICY IF EXISTS "members can manage inventario" ON inventario;

CREATE POLICY "members can manage inventario"
  ON inventario FOR ALL
  USING (hogar_id = get_my_hogar_id())
  WITH CHECK (hogar_id = get_my_hogar_id());

-- ── ocr_learning_diccionario ─────────────────────────────────
DROP POLICY IF EXISTS "members can manage ocr dictionary" ON ocr_learning_diccionario;

CREATE POLICY "members can manage ocr dictionary"
  ON ocr_learning_diccionario FOR ALL
  USING (hogar_id = get_my_hogar_id())
  WITH CHECK (hogar_id = get_my_hogar_id());

-- ── pendientes_validacion ────────────────────────────────────
DROP POLICY IF EXISTS "members can manage pendientes" ON pendientes_validacion;

CREATE POLICY "members can manage pendientes"
  ON pendientes_validacion FOR ALL
  USING (hogar_id = get_my_hogar_id())
  WITH CHECK (hogar_id = get_my_hogar_id());

-- ── resumen_mensual ──────────────────────────────────────────
DROP POLICY IF EXISTS "members can view resumen" ON resumen_mensual;

-- SELECT solo; INSERT/UPDATE van por la función upsert_resumen (SECURITY DEFINER)
CREATE POLICY "members can view resumen"
  ON resumen_mensual FOR SELECT
  USING (hogar_id = get_my_hogar_id());

-- ─── DATOS INICIALES DE ESPACIOS (función helper) ───────────
-- Llamar desde la app tras crear un hogar nuevo
CREATE OR REPLACE FUNCTION crear_espacios_default(p_hogar_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO espacios (hogar_id, nombre) VALUES
    (p_hogar_id, 'Despensa'),
    (p_hogar_id, 'Nevera'),
    (p_hogar_id, 'Congelador'),
    (p_hogar_id, 'Limpieza'),
    (p_hogar_id, 'Farmacia')
  ON CONFLICT DO NOTHING;
END;
$$;
