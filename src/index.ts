/// <reference types="@cloudflare/workers-types" />
//
// pulse-business-api — alta y revisión de negocios de AION, y su directorio.
//
// Diseño en `docs/NEGOCIOS-DISENO.md` §13 de AION-iOS (fase B2). Lo que este
// servicio NUNCA ve en claro:
// - La CURP del responsable ni el RFC de una persona física: llegan en la
//   petición, se convierten en su índice (HMAC con BUSINESS_INDEX_PEPPER) y se
//   descartan. El RFC en claro solo se guarda de una persona moral: es público.
// - Las fotos, documentos y el expediente: el teléfono los cifra con la clave
//   pública de revisión antes de enviarlos. Aquí son bytes opacos en R2; la
//   clave privada vive en los aparatos de los operadores.
// - Las imágenes de la credencial y del rostro: van del teléfono al proveedor
//   de identidad y no pasan por aquí.
// - La IP: solo un contador por hora en `limites`, que se purga.
//
// No comparte base de datos ni secretos con pulse-recovery-api ni con
// SkimZeroVaultBackend.

import {
  type Category, type LegalForm, type Presence, type VaultPart, type PublicLocation,
  LEGAL_FORMS, PRESENCES, VAULT_PARTS, allowedAttachments, cleanText, isCategory, isConfusableName,
  isReservedAlias, isVaultPart, parseAliasBase, parseCURP, parsePublicLocation, parseRFC, parseTradeName,
  requiredAttachments, tradeNameSkeleton
} from "./rules";
import { skeleton } from "./alias";

export interface Entorno {
  DB: D1Database;
  /** Bóveda: los bytes sellados de cada alta, bajo `<id>/<parte>`. */
  VAULT: R2Bucket;
  ENVIRONMENT: "development" | "sandbox" | "production";
  /** Secreto de 32+ bytes. Índices de CURP, RFC, token de dueño y límites. */
  BUSINESS_INDEX_PEPPER: string;
  /**
   * Secreto: `{"<operador>": "<sha256 hex de su token>"}`. Uno por persona:
   * aprobar exige dos operadores distintos y eso solo significa algo si cada
   * uno tiene su propio token.
   */
  OPERATOR_TOKENS: string;
  /** Id de la clave pública de revisión vigente, la del documento de reglas firmado. */
  REVIEW_KEY_ID: string;
}

type State = "borrador" | "enviada" | "en_revision" | "requiere_cambios" | "aprobada" | "rechazada" | "suspendida" | "revocada";

interface ApplicationRow {
  id: string; owner_token_hmac: string; state: State;
  trade_name: string; alias_base: string; alias_skeleton: string; name_skeleton: string;
  category: Category; legal_form: LegalForm; presence: Presence; public_location: string;
  rfc_moral: string | null; legal_name: string | null; rfc_index: string | null; curp_index: string;
  review_key_id: string; review_flags: string; decision_reason: string | null; appeal_open: number;
  created_at: number; submitted_at: number | null; decided_at: number | null; approved_at: number | null; updated_at: number;
}

const DAY_MS = 86_400_000;
/** Lo que solo servía para decidir se borra a los 30 días de decidir (`BusinessDataPolicy`). */
export const REVIEW_RETENTION_MS = 30 * DAY_MS;
/** Un alta a medias no deja rastro: lo que no se envía en un día se borra. */
export const DRAFT_TTL_MS = DAY_MS;
/** `BusinessNewcomerPeriod`: 30 días como «Negocio nuevo», sin mandar novedades. */
export const NEWCOMER_MS = 30 * DAY_MS;
/** N11: como mucho 3 negocios vivos por persona responsable. */
export const MAX_BUSINESSES_PER_PERSON = 3;
export const MAX_APPLICATIONS_PER_IP_PER_HOUR = 10;
const MAX_JSON_BYTES = 256 * 1024;
const MAX_SEALED_INLINE_BYTES = 64 * 1024;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
/** Lo que no cuenta para el tope ni ocupa alias o RFC. */
const DEAD_STATES = ["rechazada", "revocada"] as const;

export default {
  async fetch(request: Request, entorno: Entorno, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.split("/").filter(Boolean);
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true, service: "pulse-business-api", environment: entorno.ENVIRONMENT });
      }
      // --- El negocio, desde su teléfono ---
      if (path[0] === "v1" && path[1] === "applications") {
        if (request.method === "POST" && path.length === 2) return await crearAlta(request, entorno);
        const id = path[2];
        if (!id || !isUUID(id)) return notFound();
        if (request.method === "PUT" && path.length === 5 && path[3] === "attachments") return await adjuntar(request, entorno, id, path[4]);
        if (request.method === "POST" && path.length === 4 && path[3] === "submit") return await enviarAlta(request, entorno, id);
        if (request.method === "POST" && path.length === 4 && path[3] === "appeal") return await apelar(request, entorno, id);
        if (request.method === "GET" && path.length === 3) return await estadoAlta(request, entorno, id);
        if (request.method === "GET" && path.length === 4 && path[3] === "access-log") return await registroDeAccesos(request, entorno, id);
        return notFound();
      }
      // --- Cualquiera: el directorio ---
      if (request.method === "POST" && url.pathname === "/v1/directory/search") return await buscar(request, entorno);
      // --- Operadores ---
      if (path[0] === "review") {
        const operador = await autenticarOperador(request, entorno);
        if (!operador) return json({ error: "unauthorized" }, 401);
        if (request.method === "GET" && path.length === 2 && path[1] === "queue") {
          ctx.waitUntil(purgar(entorno, Date.now()));
          return await cola(entorno);
        }
        if (request.method === "POST" && path.length === 2 && path[1] === "sat-69b") return await cargar69B(request, entorno);
        const id = path[1];
        if (!id || !isUUID(id)) return notFound();
        if (request.method === "POST" && path.length === 3 && path[2] === "take") return await tomar(entorno, id, operador);
        if (request.method === "POST" && path.length === 3 && path[2] === "decide") return await decidir(request, entorno, id, operador);
        if (request.method === "GET" && path.length === 4 && path[2] === "parts") return await abrirParte(entorno, id, path[3], operador);
        return notFound();
      }
      return notFound();
    } catch (error) {
      if (error instanceof Invalid) return json({ error: "invalid", field: error.field }, 400);
      console.log(JSON.stringify({ level: "error", event: "unhandled", message: error instanceof Error ? error.message : String(error) }));
      return json({ error: "internal" }, 500);
    }
  },

  async scheduled(_controller: ScheduledController, entorno: Entorno, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(purgar(entorno, Date.now()));
  }
};

// ---------------------------------------------------------------------------
// Alta
// ---------------------------------------------------------------------------

const CREATE_FIELDS = [
  "applicationID", "ownerToken", "tradeName", "aliasBase", "category", "legalForm", "presence",
  "publicLocation", "rfc", "legalName", "curp", "reviewKeyID", "expediente", "evidencia"
];

async function crearAlta(request: Request, entorno: Entorno): Promise<Response> {
  const body = await readJSON(request);
  if (Object.keys(body).some(key => !CREATE_FIELDS.includes(key))) throw new Invalid("unexpected");

  const id = typeof body.applicationID === "string" && isUUID(body.applicationID) ? body.applicationID.toLowerCase() : null;
  if (!id) throw new Invalid("applicationID");
  const ownerToken = typeof body.ownerToken === "string" ? fromBase64URL(body.ownerToken) : null;
  if (!ownerToken || ownerToken.length !== 32) throw new Invalid("ownerToken");
  const tradeName = typeof body.tradeName === "string" ? parseTradeName(body.tradeName) : null;
  if (!tradeName) throw new Invalid("tradeName");
  const aliasBase = typeof body.aliasBase === "string" ? parseAliasBase(body.aliasBase) : null;
  if (!aliasBase) throw new Invalid("aliasBase");
  if (!isCategory(body.category)) throw new Invalid("category");
  const category = body.category;
  if (!LEGAL_FORMS.includes(body.legalForm as LegalForm)) throw new Invalid("legalForm");
  const legalForm = body.legalForm as LegalForm;
  if (!PRESENCES.includes(body.presence as Presence)) throw new Invalid("presence");
  const presence = body.presence as Presence;
  const location = parsePublicLocation(body.publicLocation, presence);
  if (typeof location === "string") throw new Invalid(location);
  const curp = typeof body.curp === "string" ? parseCURP(body.curp) : null;
  if (!curp) throw new Invalid("curp");

  let rfc: { value: string; kind: string } | null = null;
  let legalName: string | null = null;
  if (legalForm === "sin_rfc") {
    if (body.rfc !== undefined || body.legalName !== undefined) throw new Invalid("rfc");
  } else {
    rfc = typeof body.rfc === "string" ? parseRFC(body.rfc) : null;
    if (!rfc || rfc.kind !== legalForm) throw new Invalid("rfc");
    if (legalForm === "persona_moral") {
      legalName = typeof body.legalName === "string" ? cleanText(body.legalName) : "";
      if (legalName.length < 2 || legalName.length > 150) throw new Invalid("legalName");
    } else if (body.legalName !== undefined) {
      throw new Invalid("legalName");
    }
  }

  const expediente = typeof body.expediente === "string" ? fromBase64URL(body.expediente) : null;
  if (!expediente || expediente.length === 0 || expediente.length > MAX_SEALED_INLINE_BYTES) throw new Invalid("expediente");
  const evidencia = typeof body.evidencia === "string" ? fromBase64URL(body.evidencia) : null;
  if (!evidencia || evidencia.length === 0 || evidencia.length > MAX_SEALED_INLINE_BYTES) throw new Invalid("evidencia");

  // Lo sellado con una clave que ya no es la vigente no lo puede abrir nadie.
  if (body.reviewKeyID !== entorno.REVIEW_KEY_ID) return json({ error: "clave_de_revision_vieja", reviewKeyID: entorno.REVIEW_KEY_ID }, 409);

  // Un nombre reservado solo lo puede pedir una empresa; si coincide con su
  // razón social lo decide la revisión.
  const flags: { tipo: string; con?: string }[] = [];
  if (isReservedAlias(aliasBase)) {
    if (legalForm !== "persona_moral") return json({ error: "alias_reservado" }, 422);
    flags.push({ tipo: "alias_reservado" });
  }

  const ownerHMAC = await indice(entorno, "owner", toBase64URL(ownerToken));
  const now = Date.now();

  // Reintento del mismo teléfono: la misma respuesta, sin crear nada.
  const existente = await entorno.DB.prepare("SELECT * FROM applications WHERE id = ?").bind(id).first<ApplicationRow>();
  if (existente) {
    if (!constantTimeEqual(existente.owner_token_hmac, ownerHMAC)) return json({ error: "id_en_uso" }, 409);
    return json(await vistaDelDueno(entorno, existente, now), 200);
  }

  if (!(await dentroDelLimite(entorno, request, now))) return json({ error: "rate_limited" }, 429);

  const curpIndex = await indice(entorno, "curp", curp);
  const rfcIndex = rfc ? await indice(entorno, "rfc", rfc.value) : null;

  // Quien tuvo un negocio revocado por fraude no abre otro.
  if (await entorno.DB.prepare("SELECT 1 FROM banned_indices WHERE curp_index = ?").bind(curpIndex).first()) {
    return json({ error: "no_admitida" }, 403);
  }
  if (rfcIndex && await entorno.DB.prepare("SELECT 1 FROM sat_69b WHERE rfc_index = ?").bind(rfcIndex).first()) {
    return json({ error: "rfc_no_admitido" }, 403);
  }
  const vivos = await entorno.DB.prepare(
    `SELECT COUNT(*) AS n FROM applications WHERE curp_index = ? AND state NOT IN ('rechazada','revocada')`
  ).bind(curpIndex).first<{ n: number }>();
  if ((vivos?.n ?? 0) >= MAX_BUSINESSES_PER_PERSON) return json({ error: "tope_de_negocios", max: MAX_BUSINESSES_PER_PERSON }, 409);

  const aliasSkeleton = skeleton(aliasBase);
  if (await entorno.DB.prepare(`SELECT 1 FROM applications WHERE alias_skeleton = ? AND state NOT IN ('rechazada','revocada')`).bind(aliasSkeleton).first()) {
    return json({ error: "alias_ocupado" }, 409);
  }
  if (rfcIndex && await entorno.DB.prepare(`SELECT 1 FROM applications WHERE rfc_index = ? AND state NOT IN ('rechazada','revocada')`).bind(rfcIndex).first()) {
    return json({ error: "rfc_ya_registrado" }, 409);
  }

  // Anti-plagio: se parece a un verificado. No decide: avisa a la revisión.
  const verificados = await entorno.DB.prepare(`SELECT id, trade_name FROM applications WHERE state IN ('aprobada','suspendida')`).all<{ id: string; trade_name: string }>();
  for (const otro of verificados.results) {
    if (isConfusableName(tradeName, otro.trade_name)) flags.push({ tipo: "nombre_parecido", con: otro.id });
  }

  try {
    await entorno.DB.prepare(
      `INSERT INTO applications (id, owner_token_hmac, state, trade_name, alias_base, alias_skeleton, name_skeleton,
         category, legal_form, presence, public_location, rfc_moral, legal_name, rfc_index, curp_index,
         review_key_id, review_flags, created_at, updated_at)
       VALUES (?, ?, 'borrador', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, ownerHMAC, tradeName, aliasBase, aliasSkeleton, tradeNameSkeleton(tradeName),
      category, legalForm, presence, JSON.stringify(location),
      legalForm === "persona_moral" ? rfc!.value : null, legalName, rfcIndex, curpIndex,
      entorno.REVIEW_KEY_ID, JSON.stringify(flags), now, now
    ).run();
  } catch (error) {
    // Dos altas a la vez con el mismo alias o RFC: el índice único decide.
    if (error instanceof Error && /UNIQUE/i.test(error.message)) return json({ error: "alias_o_rfc_ocupado" }, 409);
    throw error;
  }
  await guardarParte(entorno, id, "expediente", expediente, now);
  await guardarParte(entorno, id, "evidencia", evidencia, now);

  const fila = await entorno.DB.prepare("SELECT * FROM applications WHERE id = ?").bind(id).first<ApplicationRow>();
  return json(await vistaDelDueno(entorno, fila!, now), 201);
}

async function adjuntar(request: Request, entorno: Entorno, id: string, part: string): Promise<Response> {
  const alta = await altaDelDueno(request, entorno, id);
  if (!alta) return notFound();
  if (alta.state !== "borrador" && alta.state !== "requiere_cambios") return json({ error: "estado", state: alta.state }, 409);
  const permitidas: VaultPart[] = ["expediente", "evidencia", ...allowedAttachments(alta.presence, alta.category, alta.legal_form)];
  if (!isVaultPart(part) || !permitidas.includes(part)) return json({ error: "parte_no_admitida" }, 422);
  const length = Number(request.headers.get("content-length") ?? "NaN");
  if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_ATTACHMENT_BYTES) return json({ error: "size" }, 413);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) return json({ error: "size" }, 413);
  await guardarParte(entorno, id, part, bytes, Date.now());
  return json({ stored: part, size: bytes.length }, 201);
}

async function enviarAlta(request: Request, entorno: Entorno, id: string): Promise<Response> {
  const alta = await altaDelDueno(request, entorno, id);
  if (!alta) return notFound();
  if (alta.state !== "borrador" && alta.state !== "requiere_cambios") return json({ error: "estado", state: alta.state }, 409);
  const now = Date.now();
  const faltan = await partesQueFaltan(entorno, alta);
  if (faltan.length > 0) return json({ error: "incompleta", missing: faltan }, 422);
  await cambiarEstado(entorno, alta, "enviada", now, { submitted_at: now, decision_reason: null });
  const fila = await entorno.DB.prepare("SELECT * FROM applications WHERE id = ?").bind(id).first<ApplicationRow>();
  return json(await vistaDelDueno(entorno, fila!, now));
}

async function estadoAlta(request: Request, entorno: Entorno, id: string): Promise<Response> {
  const alta = await altaDelDueno(request, entorno, id);
  if (!alta) return notFound();
  return json(await vistaDelDueno(entorno, alta, Date.now()));
}

/** Quién abrió qué parte de su expediente y cuándo (§13.6). */
async function registroDeAccesos(request: Request, entorno: Entorno, id: string): Promise<Response> {
  const alta = await altaDelDueno(request, entorno, id);
  if (!alta) return notFound();
  const filas = await entorno.DB.prepare(
    "SELECT operator_id, part, accessed_at FROM dossier_access WHERE application_id = ? ORDER BY accessed_at ASC"
  ).bind(id).all<{ operator_id: string; part: string; accessed_at: number }>();
  return json({ accesses: filas.results.map(fila => ({ operator: fila.operator_id, part: fila.part, at: fila.accessed_at })) });
}

/** Un rechazo se apela en 30 días; mientras, su expediente no se borra. */
async function apelar(request: Request, entorno: Entorno, id: string): Promise<Response> {
  const alta = await altaDelDueno(request, entorno, id);
  if (!alta) return notFound();
  const now = Date.now();
  if (alta.state !== "rechazada" || alta.decided_at === null || now - alta.decided_at > REVIEW_RETENTION_MS) {
    return json({ error: "no_apelable" }, 409);
  }
  await entorno.DB.prepare("UPDATE applications SET appeal_open = 1, updated_at = ? WHERE id = ?").bind(now, id).run();
  return json({ appealOpen: true });
}

async function vistaDelDueno(entorno: Entorno, alta: ApplicationRow, now: number): Promise<Record<string, unknown>> {
  const vista: Record<string, unknown> = {
    applicationID: alta.id,
    state: alta.state,
    tradeName: alta.trade_name,
    aliasBase: alta.alias_base,
    publicProfile: perfilPublico(alta, now)
  };
  if (alta.state === "borrador" || alta.state === "requiere_cambios") vista.missing = await partesQueFaltan(entorno, alta);
  if (alta.state === "requiere_cambios" || alta.state === "rechazada" || alta.state === "suspendida") vista.reason = alta.decision_reason;
  const flags = JSON.parse(alta.review_flags) as { tipo: string }[];
  // El negocio ve el tipo de aviso, nunca con qué otro negocio se cruzó.
  if (flags.length > 0) vista.warnings = [...new Set(flags.map(flag => flag.tipo))];
  return vista;
}

/** Lo que verá cualquiera en el directorio: solo lo público de `BusinessDataPolicy`. */
function perfilPublico(alta: ApplicationRow, now: number): Record<string, unknown> {
  const perfil: Record<string, unknown> = {
    tradeName: alta.trade_name,
    aliasBase: alta.alias_base,
    category: alta.category,
    location: JSON.parse(alta.public_location) as PublicLocation
  };
  if (alta.legal_form === "persona_moral") { perfil.rfc = alta.rfc_moral; perfil.legalName = alta.legal_name; }
  if (alta.approved_at !== null) perfil.newcomer = now - alta.approved_at < NEWCOMER_MS;
  return perfil;
}

async function partesQueFaltan(entorno: Entorno, alta: ApplicationRow): Promise<VaultPart[]> {
  const guardadas = await entorno.DB.prepare("SELECT part FROM vault_parts WHERE application_id = ?").bind(alta.id).all<{ part: string }>();
  const hay = new Set(guardadas.results.map(fila => fila.part));
  const requeridas: VaultPart[] = ["expediente", "evidencia", ...requiredAttachments(alta.presence, alta.category, alta.legal_form)];
  return requeridas.filter(part => !hay.has(part));
}

async function guardarParte(entorno: Entorno, id: string, part: VaultPart, bytes: Uint8Array, now: number): Promise<void> {
  await entorno.VAULT.put(`${id}/${part}`, bytes);
  await entorno.DB.prepare(
    `INSERT INTO vault_parts (application_id, part, retention, size, stored_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (application_id, part) DO UPDATE SET size = excluded.size, stored_at = excluded.stored_at`
  ).bind(id, part, VAULT_PARTS[part], bytes.length, now).run();
}

/** El alta, si el token de dueño es el suyo. Si no, como si no existiera. */
async function altaDelDueno(request: Request, entorno: Entorno, id: string): Promise<ApplicationRow | null> {
  const token = bearer(request);
  const bytes = token ? fromBase64URL(token) : null;
  const alta = await entorno.DB.prepare("SELECT * FROM applications WHERE id = ?").bind(id.toLowerCase()).first<ApplicationRow>();
  if (!alta || !bytes || bytes.length !== 32) return null;
  const hmac = await indice(entorno, "owner", toBase64URL(bytes));
  return constantTimeEqual(alta.owner_token_hmac, hmac) ? alta : null;
}

// ---------------------------------------------------------------------------
// Directorio
// ---------------------------------------------------------------------------

/** Buscable por defecto: todo negocio aprobado sale aquí, con lo público y nada más. */
async function buscar(request: Request, entorno: Entorno): Promise<Response> {
  const body = await readJSON(request);
  if (Object.keys(body).some(key => key !== "query")) throw new Invalid("unexpected");
  const query = typeof body.query === "string" ? tradeNameSkeleton(body.query) : "";
  if (query.length < 2 || query.length > 40) throw new Invalid("query");
  // El esqueleto solo tiene `a-z0-9`: no hay comodines de LIKE que escapar.
  const filas = await entorno.DB.prepare(
    `SELECT * FROM applications WHERE state = 'aprobada' AND (name_skeleton LIKE ? OR alias_skeleton LIKE ?)
     ORDER BY trade_name LIMIT 20`
  ).bind(`%${query}%`, `%${query}%`).all<ApplicationRow>();
  const now = Date.now();
  return json({ results: filas.results.map(fila => perfilPublico(fila, now)) });
}

// ---------------------------------------------------------------------------
// Revisión
// ---------------------------------------------------------------------------

async function cola(entorno: Entorno): Promise<Response> {
  const filas = await entorno.DB.prepare(
    `SELECT * FROM applications WHERE state IN ('enviada','en_revision') ORDER BY submitted_at ASC LIMIT 50`
  ).all<ApplicationRow>();
  const items = [];
  for (const alta of filas.results) {
    const partes = await entorno.DB.prepare("SELECT part, size FROM vault_parts WHERE application_id = ?").bind(alta.id).all<{ part: string; size: number }>();
    const votos = await entorno.DB.prepare(
      "SELECT action, operator_id FROM review_actions WHERE application_id = ? AND completed = 0"
    ).bind(alta.id).all<{ action: string; operator_id: string }>();
    items.push({
      applicationID: alta.id, state: alta.state, submittedAt: alta.submitted_at,
      legalForm: alta.legal_form, presence: alta.presence, profile: perfilPublico(alta, Date.now()),
      flags: JSON.parse(alta.review_flags), reviewKeyID: alta.review_key_id,
      parts: partes.results, pendingVotes: votos.results.map(voto => ({ action: voto.action, operator: voto.operator_id }))
    });
  }
  return json({ items });
}

async function tomar(entorno: Entorno, id: string, operador: string): Promise<Response> {
  const alta = await entorno.DB.prepare("SELECT * FROM applications WHERE id = ?").bind(id.toLowerCase()).first<ApplicationRow>();
  if (!alta || alta.state === "borrador") return notFound();
  if (alta.state !== "enviada") return json({ error: "estado", state: alta.state }, 409);
  const now = Date.now();
  await anotarAccion(entorno, alta, operador, "take", null, false, true, now);
  await cambiarEstado(entorno, alta, "en_revision", now, {});
  return json({ state: "en_revision" });
}

/** Abrir una parte sellada deja constancia: quién, cuál y cuándo. Sin IP. */
async function abrirParte(entorno: Entorno, id: string, part: string, operador: string): Promise<Response> {
  const alta = await entorno.DB.prepare("SELECT * FROM applications WHERE id = ?").bind(id.toLowerCase()).first<ApplicationRow>();
  if (!alta || alta.state === "borrador" || !isVaultPart(part)) return notFound();
  const objeto = await entorno.VAULT.get(`${alta.id}/${part}`);
  if (!objeto) return notFound();
  await entorno.DB.prepare(
    "INSERT INTO dossier_access (id, application_id, operator_id, part, accessed_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(crypto.randomUUID(), alta.id, operador, part, Date.now()).run();
  return new Response(objeto.body, {
    headers: { "content-type": "application/octet-stream", "cache-control": "no-store", "x-review-key-id": alta.review_key_id }
  });
}

type Accion = "request_changes" | "reject" | "approve" | "suspend" | "reactivate" | "revoke";

/** `BusinessReview.next`: desde qué estado vale cada acción, a cuál lleva y cuántos operadores pide. */
const TRANSICIONES: Record<Accion, { from: State[]; to: State; operators: 1 | 2; reason: boolean }> = {
  request_changes: { from: ["en_revision"], to: "requiere_cambios", operators: 1, reason: true },
  reject: { from: ["en_revision"], to: "rechazada", operators: 1, reason: true },
  approve: { from: ["en_revision"], to: "aprobada", operators: 2, reason: false },
  // Suspender es urgente y reversible: basta uno.
  suspend: { from: ["aprobada"], to: "suspendida", operators: 1, reason: true },
  reactivate: { from: ["suspendida"], to: "aprobada", operators: 2, reason: false },
  // Revocar es definitivo: dos.
  revoke: { from: ["aprobada", "suspendida"], to: "revocada", operators: 2, reason: true }
};

async function decidir(request: Request, entorno: Entorno, id: string, operador: string): Promise<Response> {
  const body = await readJSON(request);
  if (Object.keys(body).some(key => !["action", "reason", "fraud"].includes(key))) throw new Invalid("unexpected");
  const accion = body.action as Accion;
  const regla = TRANSICIONES[accion];
  if (!regla || !Object.hasOwn(TRANSICIONES, accion)) throw new Invalid("action");
  const reason = typeof body.reason === "string" ? cleanText(body.reason) : null;
  if (regla.reason && (!reason || reason.length < 3 || reason.length > 1000)) throw new Invalid("reason");
  if (body.fraud !== undefined && (typeof body.fraud !== "boolean" || accion !== "revoke")) throw new Invalid("fraud");
  const fraud = body.fraud === true;

  const alta = await entorno.DB.prepare("SELECT * FROM applications WHERE id = ?").bind(id.toLowerCase()).first<ApplicationRow>();
  if (!alta || alta.state === "borrador") return notFound();
  if (!regla.from.includes(alta.state)) return json({ error: "estado", state: alta.state }, 409);
  const now = Date.now();

  if (regla.operators === 2) {
    const pendientes = await entorno.DB.prepare(
      "SELECT operator_id, fraud FROM review_actions WHERE application_id = ? AND action = ? AND from_state = ? AND completed = 0"
    ).bind(alta.id, accion, alta.state).all<{ operator_id: string; fraud: number }>();
    if (pendientes.results.some(voto => voto.operator_id === operador)) return json({ error: "ya_votaste" }, 409);
    const otro = pendientes.results.find(voto => voto.operator_id !== operador);
    if (!otro) {
      await anotarAccion(entorno, alta, operador, accion, reason, fraud, false, now);
      return json({ pending: true, votes: 1, required: 2 }, 202);
    }
    await anotarAccion(entorno, alta, operador, accion, reason, fraud, true, now);
    // Vetar a la persona también exige a los dos: los dos marcaron fraude.
    if (accion === "revoke" && fraud && otro.fraud === 1) {
      await entorno.DB.prepare("INSERT OR IGNORE INTO banned_indices (curp_index, reason, banned_at) VALUES (?, 'fraude', ?)")
        .bind(alta.curp_index, now).run();
    }
  } else {
    await anotarAccion(entorno, alta, operador, accion, reason, false, true, now);
  }

  const extra: Record<string, number | string | null> = {};
  if (accion === "approve") { extra.decided_at = now; extra.approved_at = alta.approved_at ?? now; extra.decision_reason = null; }
  if (accion === "reject" || accion === "revoke") { extra.decided_at = now; extra.decision_reason = reason; }
  if (accion === "request_changes" || accion === "suspend") extra.decision_reason = reason;
  if (accion === "reactivate") extra.decision_reason = null;
  await cambiarEstado(entorno, alta, regla.to, now, extra);
  return json({ state: regla.to });
}

async function anotarAccion(entorno: Entorno, alta: ApplicationRow, operador: string, accion: string,
                            reason: string | null, fraud: boolean, completed: boolean, now: number): Promise<void> {
  await entorno.DB.prepare(
    `INSERT INTO review_actions (id, application_id, operator_id, action, from_state, reason, fraud, completed, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(crypto.randomUUID(), alta.id, operador, accion, alta.state, reason, fraud ? 1 : 0, completed ? 1 : 0, now).run();
}

const CAMPOS_EXTRA = new Set(["submitted_at", "decided_at", "approved_at", "decision_reason"]);

/**
 * Cambia de estado y descarta los votos pendientes: un voto se emitió sobre
 * lo que había entonces, y tras pedir cambios y reenviar ya no es lo mismo.
 */
async function cambiarEstado(entorno: Entorno, alta: ApplicationRow, to: State, now: number,
                             extra: Record<string, number | string | null>): Promise<void> {
  const columnas = Object.keys(extra).filter(columna => CAMPOS_EXTRA.has(columna));
  const sets = ["state = ?", "updated_at = ?", ...columnas.map(columna => `${columna} = ?`)].join(", ");
  await entorno.DB.batch([
    entorno.DB.prepare(`UPDATE applications SET ${sets} WHERE id = ? AND state = ?`)
      .bind(to, now, ...columnas.map(columna => extra[columna]), alta.id, alta.state),
    entorno.DB.prepare("UPDATE review_actions SET completed = 1 WHERE application_id = ? AND completed = 0").bind(alta.id)
  ]);
}

/** La lista 69-B del SAT. Se guarda el índice: también trae personas físicas. */
async function cargar69B(request: Request, entorno: Entorno): Promise<Response> {
  const body = await readJSON(request);
  if (!Array.isArray(body.rfcs) || body.rfcs.length < 1 || body.rfcs.length > 1000) throw new Invalid("rfcs");
  const now = Date.now();
  const sentencias: D1PreparedStatement[] = [];
  for (const valor of body.rfcs) {
    const rfc = typeof valor === "string" ? parseRFC(valor) : null;
    if (!rfc) throw new Invalid("rfcs");
    sentencias.push(entorno.DB.prepare("INSERT OR IGNORE INTO sat_69b (rfc_index, loaded_at) VALUES (?, ?)")
      .bind(await indice(entorno, "rfc", rfc.value), now));
  }
  await entorno.DB.batch(sentencias);
  return json({ loaded: sentencias.length });
}

async function autenticarOperador(request: Request, entorno: Entorno): Promise<string | null> {
  const token = bearer(request);
  if (!token) return null;
  let tokens: Record<string, unknown>;
  try { tokens = JSON.parse(entorno.OPERATOR_TOKENS) as Record<string, unknown>; } catch { return null; }
  const digest = await sha256Hex(token);
  let encontrado: string | null = null;
  // Se recorren todos: el tiempo no dice cuál coincidió.
  for (const [operador, hash] of Object.entries(tokens)) {
    if (typeof hash === "string" && constantTimeEqual(hash.toLowerCase(), digest) && operador.length > 0) encontrado = operador;
  }
  return encontrado;
}

// ---------------------------------------------------------------------------
// Purga
// ---------------------------------------------------------------------------

/**
 * Lo que la política dice que se borra, se borra:
 * - Lo que solo servía para decidir, a los 30 días de decidir, salvo apelación abierta.
 * - De un alta rechazada o revocada, todo lo de la bóveda a los 30 días. La
 *   fila se queda: su índice de CURP cuenta para el tope y para el veto.
 * - Un alta que nunca se envió, al día.
 * - Los contadores de IP de horas pasadas.
 *
 * Corre en el cron y, por si el plan no deja otro cron, también al abrir la
 * cola de revisión.
 */
export async function purgar(entorno: Entorno, now: number): Promise<void> {
  const limite = now - REVIEW_RETENTION_MS;
  const caducadas = await entorno.DB.prepare(
    `SELECT v.application_id, v.part FROM vault_parts v JOIN applications a ON a.id = v.application_id
     WHERE a.decided_at IS NOT NULL AND a.decided_at < ? AND a.appeal_open = 0
       AND (v.retention = 'decision' OR a.state IN ('rechazada','revocada'))`
  ).bind(limite).all<{ application_id: string; part: string }>();
  for (const fila of caducadas.results) {
    await entorno.VAULT.delete(`${fila.application_id}/${fila.part}`);
    await entorno.DB.prepare("DELETE FROM vault_parts WHERE application_id = ? AND part = ?").bind(fila.application_id, fila.part).run();
  }

  const borradores = await entorno.DB.prepare("SELECT id FROM applications WHERE state = 'borrador' AND created_at < ?")
    .bind(now - DRAFT_TTL_MS).all<{ id: string }>();
  for (const { id } of borradores.results) {
    const partes = await entorno.DB.prepare("SELECT part FROM vault_parts WHERE application_id = ?").bind(id).all<{ part: string }>();
    for (const { part } of partes.results) await entorno.VAULT.delete(`${id}/${part}`);
    await entorno.DB.batch([
      entorno.DB.prepare("DELETE FROM vault_parts WHERE application_id = ?").bind(id),
      entorno.DB.prepare("DELETE FROM applications WHERE id = ? AND state = 'borrador'").bind(id)
    ]);
  }

  await entorno.DB.prepare("DELETE FROM limites WHERE ventana < ?").bind(Math.floor(now / 3_600_000)).run();
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

class Invalid extends Error {
  constructor(readonly field: string) { super(`invalid ${field}`); }
}

async function dentroDelLimite(entorno: Entorno, request: Request, now: number): Promise<boolean> {
  const ventana = Math.floor(now / 3_600_000);
  const ip = request.headers.get("cf-connecting-ip") ?? "sin-ip";
  const clave = await indice(entorno, "ip", `${ventana}:${ip}`);
  const fila = await entorno.DB.prepare(
    `INSERT INTO limites (clave, ventana, cuenta) VALUES (?, ?, 1)
     ON CONFLICT (clave) DO UPDATE SET cuenta = cuenta + 1 RETURNING cuenta`
  ).bind(clave, ventana).first<{ cuenta: number }>();
  return (fila?.cuenta ?? 1) <= MAX_APPLICATIONS_PER_IP_PER_HOUR;
}

/** HMAC-SHA256 con el pepper, separado por propósito. Hex. */
async function indice(entorno: Entorno, proposito: string, valor: string): Promise<string> {
  if (!entorno.BUSINESS_INDEX_PEPPER || entorno.BUSINESS_INDEX_PEPPER.length < 32) throw new Error("BUSINESS_INDEX_PEPPER missing");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(entorno.BUSINESS_INDEX_PEPPER),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const firma = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${proposito}:${valor}`));
  return hex(new Uint8Array(firma));
}

async function sha256Hex(valor: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(valor))));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diferencia = 0;
  for (let i = 0; i < a.length; i += 1) diferencia |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diferencia === 0;
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() || null : null;
}

async function readJSON(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json") throw new Invalid("content-type");
  const texto = await request.text();
  if (texto.length > MAX_JSON_BYTES) throw new Invalid("size");
  let valor: unknown;
  try { valor = JSON.parse(texto); } catch { throw new Invalid("json"); }
  if (valor === null || typeof valor !== "object" || Array.isArray(valor)) throw new Invalid("json");
  return valor as Record<string, unknown>;
}

function isUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function fromBase64URL(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const normal = text.replaceAll("-", "+").replaceAll("_", "/");
    const binario = atob(normal + "=".repeat((4 - (normal.length % 4)) % 4));
    return Uint8Array.from(binario, char => char.charCodeAt(0));
  } catch { return null; }
}

function toBase64URL(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

function notFound(): Response {
  return json({ error: "not_found" }, 404);
}
