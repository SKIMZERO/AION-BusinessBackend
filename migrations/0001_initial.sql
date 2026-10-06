-- apps/business: altas de negocio, bóveda de revisión y directorio.
--
-- Reglas que este esquema hace cumplir (docs/NEGOCIOS-DISENO.md §13.6 de AION-iOS):
-- - Ni CURP ni RFC de persona física en claro: solo su índice, un HMAC con
--   BUSINESS_INDEX_PEPPER. El RFC en claro solo existe para una persona moral,
--   donde es público.
-- - Ni imágenes ni documentos en claro: la bóveda guarda lo que el teléfono
--   cifró con la clave pública de revisión. La clave privada no está aquí.
-- - Sin IP: ni en las altas ni en el registro de accesos. Los límites por IP
--   viven en `limites`, contadores por hora que se purgan.

CREATE TABLE applications (
  id                TEXT PRIMARY KEY,               -- UUID que genera el teléfono
  owner_token_hmac  TEXT NOT NULL,                  -- HMAC del token de dueño; el token solo lo tiene el teléfono
  state             TEXT NOT NULL CHECK (state IN ('borrador','enviada','en_revision','requiere_cambios','aprobada','rechazada','suspendida','revocada')),
  trade_name        TEXT NOT NULL,
  alias_base        TEXT NOT NULL,
  alias_skeleton    TEXT NOT NULL,
  name_skeleton     TEXT NOT NULL,
  category          TEXT NOT NULL,
  legal_form        TEXT NOT NULL CHECK (legal_form IN ('sin_rfc','persona_fisica','persona_moral')),
  presence          TEXT NOT NULL CHECK (presence IN ('establecimiento','domicilio','ambulante','en_linea')),
  public_location   TEXT NOT NULL,                  -- JSON, ya recortado según la presencia
  rfc_moral         TEXT,                           -- solo persona moral: es público
  legal_name        TEXT,                           -- solo persona moral: es pública
  rfc_index         TEXT,                           -- HMAC del RFC (física o moral)
  curp_index        TEXT NOT NULL,                  -- HMAC de la CURP del responsable
  review_key_id     TEXT NOT NULL,
  review_flags      TEXT NOT NULL DEFAULT '[]',     -- motivos automáticos para la revisión
  decision_reason   TEXT,                           -- lo que el operador escribe al pedir cambios o rechazar
  appeal_open       INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  submitted_at      INTEGER,
  decided_at        INTEGER,                        -- aprobada, rechazada o revocada: arranca el plazo de 30 días
  approved_at       INTEGER,
  updated_at        INTEGER NOT NULL,
  CHECK (legal_form = 'persona_moral' OR (rfc_moral IS NULL AND legal_name IS NULL)),
  CHECK (legal_form = 'sin_rfc' OR rfc_index IS NOT NULL)
);
CREATE INDEX applications_curp ON applications (curp_index, state);
CREATE INDEX applications_queue ON applications (state, submitted_at);
-- Un alias y un RFC por negocio vivo. Uno rechazado o revocado los suelta.
CREATE UNIQUE INDEX applications_live_alias ON applications (alias_skeleton) WHERE state NOT IN ('rechazada','revocada');
CREATE UNIQUE INDEX applications_live_rfc ON applications (rfc_index) WHERE rfc_index IS NOT NULL AND state NOT IN ('rechazada','revocada');

-- Índice de la bóveda. Los bytes cifrados están en R2 (`VAULT`), bajo `<id>/<part>`.
CREATE TABLE vault_parts (
  application_id  TEXT NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  part            TEXT NOT NULL,
  retention       TEXT NOT NULL CHECK (retention IN ('mientras_exista','decision')),
  size            INTEGER NOT NULL,
  stored_at       INTEGER NOT NULL,
  PRIMARY KEY (application_id, part)
);

-- Quién abrió qué expediente y cuándo. Sin IP. El negocio puede pedirlo.
CREATE TABLE dossier_access (
  id              TEXT PRIMARY KEY,
  application_id  TEXT NOT NULL,
  operator_id     TEXT NOT NULL,
  part            TEXT NOT NULL,
  accessed_at     INTEGER NOT NULL
);
CREATE INDEX dossier_access_application ON dossier_access (application_id, accessed_at);

-- Cada acción de un operador. Las que exigen dos operadores se completan con el segundo voto.
CREATE TABLE review_actions (
  id              TEXT PRIMARY KEY,
  application_id  TEXT NOT NULL,
  operator_id     TEXT NOT NULL,
  action          TEXT NOT NULL,
  from_state      TEXT NOT NULL,
  reason          TEXT,
  fraud           INTEGER NOT NULL DEFAULT 0,
  completed       INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);
CREATE INDEX review_actions_pending ON review_actions (application_id, action, from_state, completed);

-- Personas que no pueden abrir otro negocio: un negocio suyo se revocó por fraude.
CREATE TABLE banned_indices (
  curp_index  TEXT PRIMARY KEY,
  reason      TEXT NOT NULL,
  banned_at   INTEGER NOT NULL
);

-- Lista 69-B del SAT (operaciones simuladas), por índice: el RFC de una persona
-- física también puede estar ahí y no se guarda en claro.
CREATE TABLE sat_69b (
  rfc_index   TEXT PRIMARY KEY,
  loaded_at   INTEGER NOT NULL
);

-- Contadores por hora para limitar altas por IP. La clave es un HMAC de la IP
-- y la ventana; sin timestamp junto a la IP, y se purgan al pasar la hora.
CREATE TABLE limites (
  clave    TEXT PRIMARY KEY,
  ventana  INTEGER NOT NULL,
  cuenta   INTEGER NOT NULL
);
