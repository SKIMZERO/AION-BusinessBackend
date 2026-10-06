// Las reglas del alta de un negocio, del lado del servidor.
//
// Son las mismas que el teléfono comprueba antes de enviar
// (`Sources/PulseCore/Business/` de AION-iOS); el servidor las repite porque
// un teléfono modificado puede mandar cualquier cosa. Diseño completo en
// `docs/NEGOCIOS-DISENO.md` §13 de AION-iOS.

import { RESERVED_WORDS, skeleton } from "./alias";

// ---------------------------------------------------------------------------
// Nombre comercial y alias
// ---------------------------------------------------------------------------

/** Espacios en blanco colapsados a uno y recortados, como `ProfileName.limpio`. */
export function cleanText(text: string): string {
  return text.split(/\s+/u).filter(Boolean).join(" ");
}

/**
 * Letras latinas (con acentos, `ñ`, `ç`), cifras, espacio y `& ' - . ,`.
 * Sin emojis ni letras de otros alfabetos: una «а» cirílica se ve igual que la
 * «a» y es la forma más barata de copiar el nombre de otro.
 */
function allowedInTradeName(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  if (/^[a-zA-Z0-9]$/.test(char)) return true;
  if (code >= 0x00c0 && code <= 0x024f) return /^\p{Alphabetic}$/u.test(char);
  return " &'-.,".includes(char);
}

export function parseTradeName(text: string): string | null {
  const clean = cleanText(text);
  const chars = Array.from(clean);
  if (chars.length < 2 || chars.length > 40) return null;
  if (!chars.some(char => /^\p{L}$/u.test(char))) return null;
  return chars.every(allowedInTradeName) ? clean : null;
}

/** De 1 a 3 palabras de `a-z0-9` unidas por `_`, de 3 a 30 caracteres. */
export function parseAliasBase(text: string): string | null {
  const lower = text.toLowerCase();
  const words = lower.split("_");
  if (lower.length < 3 || lower.length > 30 || words.length > 3) return null;
  return words.every(word => /^[a-z0-9]+$/.test(word)) ? lower : null;
}

/** `BusinessReserved.words` de Swift: las del alias de persona y estas. */
export const BUSINESS_RESERVED_WORDS = [
  ...RESERVED_WORDS,
  // Autoridades
  "sat", "imss", "issste", "infonavit", "cfe", "conagua", "profeco", "condusef",
  "cofepris", "sre", "ine", "renapo", "gobierno", "gob", "policia", "fiscalia",
  "guardianacional", "sedena", "semar", "aduanas", "pemex",
  // Bancos y pagos
  "banco", "bbva", "banorte", "santander", "banamex", "citibanamex", "hsbc",
  "scotiabank", "inbursa", "bancoazteca", "bancoppel", "banregio", "nubank", "spei",
  "banxico", "mercadopago", "paypal", "oxxo", "westernunion",
  // Paqueterías y plataformas que se suplantan para cobrar «envíos»
  "dhl", "fedex", "estafeta", "correos", "sepomex", "mercadolibre", "amazon",
  "whatsapp", "telegram", "apple", "google"
] as const;

const reservedSkeletons = new Set<string>(BUSINESS_RESERVED_WORDS.map(skeleton));

/** La base entera o alguna de sus palabras; nunca una búsqueda dentro del texto. */
export function isReservedAlias(base: string): boolean {
  return reservedSkeletons.has(skeleton(base)) || base.split("_").some(word => reservedSkeletons.has(skeleton(word)));
}

/** El esqueleto del nombre comercial: sin acentos, solo `a-z0-9`, y `skeleton`. */
export function tradeNameSkeleton(name: string): string {
  const plain = name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return skeleton(plain);
}

/** Si dos nombres se confunden: mismo esqueleto, o a una letra si miden 6 o más. */
export function isConfusableName(candidate: string, existing: string): boolean {
  const a = Array.from(tradeNameSkeleton(candidate));
  const b = Array.from(tradeNameSkeleton(existing));
  if (a.join("") === b.join("")) return true;
  if (Math.min(a.length, b.length) < 6 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1; else if (b.length > a.length) j += 1; else { i += 1; j += 1; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

// ---------------------------------------------------------------------------
// RFC y CURP
// ---------------------------------------------------------------------------

export type RFCKind = "persona_fisica" | "persona_moral";

const RFC_TABLE = Array.from("0123456789ABCDEFGHIJKLMN&OPQRSTUVWXYZ Ñ");
const RFC_GENERIC = new Set(["XAXX010101000", "XEXX010101000"]);

function validDate(yymmdd: string): boolean {
  if (!/^[0-9]{6}$/.test(yymmdd)) return false;
  const year = Number(yymmdd.slice(0, 2));
  const month = Number(yymmdd.slice(2, 4));
  const day = Number(yymmdd.slice(4, 6));
  if (month < 1 || month > 12 || day < 1) return false;
  const days = [31, year % 4 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

export function rfcCheckDigit(rfc: string): string | null {
  const thirteen = Array.from(rfc.length === 12 ? ` ${rfc}` : rfc);
  if (thirteen.length !== 13) return null;
  let sum = 0;
  for (let i = 0; i < 12; i += 1) {
    const value = RFC_TABLE.indexOf(thirteen[i]);
    if (value < 0) return null;
    sum += value * (13 - i);
  }
  const rest = sum % 11;
  if (rest === 0) return "0";
  const digit = 11 - rest;
  return digit === 10 ? "A" : String(digit);
}

/**
 * Forma, fecha y dígito verificador del SAT. Que sea válido no prueba que sea
 * de quien lo escribe: eso lo prueba la e.firma (fase B3).
 */
export function parseRFC(text: string): { value: string; kind: RFCKind } | null {
  const clean = text.toUpperCase().replace(/[\s-]/g, "");
  const chars = Array.from(clean);
  let letters: number;
  let kind: RFCKind;
  if (chars.length === 12) { letters = 3; kind = "persona_moral"; }
  else if (chars.length === 13) { letters = 4; kind = "persona_fisica"; }
  else return null;
  const initials = chars.slice(0, letters);
  const date = chars.slice(letters, letters + 6).join("");
  const homoclave = chars.slice(letters + 6);
  if (!initials.every(char => /^[A-Z&Ñ]$/.test(char))) return null;
  if (!homoclave.every(char => /^[A-Z0-9]$/.test(char))) return null;
  if (!validDate(date) || RFC_GENERIC.has(clean)) return null;
  return rfcCheckDigit(clean) === chars[chars.length - 1] ? { value: clean, kind } : null;
}

const CURP_TABLE = Array.from("0123456789ABCDEFGHIJKLMNÑOPQRSTUVWXYZ");
const CURP_STATES = new Set([
  "AS", "BC", "BS", "CC", "CL", "CM", "CS", "CH", "DF", "DG", "GT", "GR", "HG", "JC", "MC", "MN",
  "MS", "NT", "NL", "OC", "PL", "QT", "QR", "SP", "SL", "SR", "TC", "TS", "TL", "VZ", "YN", "ZS", "NE"
]);

export function curpCheckDigit(first17: string): string | null {
  const chars = Array.from(first17);
  if (chars.length !== 17) return null;
  let sum = 0;
  for (let i = 0; i < 17; i += 1) {
    const value = CURP_TABLE.indexOf(chars[i]);
    if (value < 0) return null;
    sum += value * (18 - i);
  }
  return String((10 - (sum % 10)) % 10);
}

/**
 * La CURP de quien responde por el negocio: forma, fecha, entidad y dígito
 * verificador. Solo se usa para calcular su índice; nunca se guarda.
 */
export function parseCURP(text: string): string | null {
  const clean = text.toUpperCase().replace(/\s/g, "");
  if (!/^[A-Z][AEIOUX][A-Z]{2}[0-9]{6}[HMX][A-Z]{2}[B-DF-HJ-NP-TV-Z]{3}[A-Z0-9][0-9]$/.test(clean)) return null;
  if (!validDate(clean.slice(4, 10)) || !CURP_STATES.has(clean.slice(11, 13))) return null;
  return curpCheckDigit(clean.slice(0, 17)) === clean[17] ? clean : null;
}

// ---------------------------------------------------------------------------
// Categoría, forma y presencia
// ---------------------------------------------------------------------------

/**
 * La lista cerrada de `BusinessCategory`. Lo prohibido (armas, sustancias,
 * apuestas sin permiso, «inversiones garantizadas»…) no está: no se puede ni
 * expresar.
 */
export const CATEGORIES = {
  ropaYCalzado: null, alimentosPreparados: null, abarrotes: null, panaderiaYPostres: null,
  bellezaYEstetica: null, saludConsultorio: "cedulaProfesional", farmacia: "cofepris",
  bebidasAlcoholicas: "licenciaAlcohol", prestamosYServiciosFinancieros: "condusef",
  casaDeEmpeno: "profecoEmpeno", reparacionesYOficios: null, hogarYFerreteria: null,
  electronicaYCelulares: null, educacionYClases: null, artesanias: null, mascotas: null,
  transporteYMensajeria: null, eventosYFiestas: null, inmobiliaria: null, automotriz: null,
  tecnologiaYServicios: null, otrosServicios: null
} as const satisfies Record<string, string | null>;
export type Category = keyof typeof CATEGORIES;

export function isCategory(value: unknown): value is Category {
  return typeof value === "string" && Object.hasOwn(CATEGORIES, value);
}

export const LEGAL_FORMS = ["sin_rfc", "persona_fisica", "persona_moral"] as const;
export type LegalForm = (typeof LEGAL_FORMS)[number];
export const PRESENCES = ["establecimiento", "domicilio", "ambulante", "en_linea"] as const;
export type Presence = (typeof PRESENCES)[number];

/** Las 32 entidades, ISO 3166-2 sin el país, como `Subdivisions` de Swift. */
export const MX_SUBDIVISIONS = new Set([
  "AGU", "BCN", "BCS", "CAM", "CHH", "CHP", "CMX", "COA", "COL", "DUR", "GRO", "GUA", "HID", "JAL",
  "MEX", "MIC", "MOR", "NAY", "NLE", "OAX", "PUE", "QUE", "ROO", "SIN", "SLP", "SON", "TAB", "TAM",
  "TLA", "VER", "YUC", "ZAC"
]);

// ---------------------------------------------------------------------------
// Lo que se publica de la ubicación (§13.2)
// ---------------------------------------------------------------------------

export interface PublicAddress {
  street: string; exteriorNumber: string; interiorNumber?: string;
  neighborhood: string; postalCode: string; municipality: string; subdivision: string;
}
export interface PublicLocation {
  subdivision: string;
  municipality?: string;
  address?: PublicAddress;
  point?: { latitude: number; longitude: number };
}

/**
 * La ubicación pública, comprobada contra la presencia. Un local enseña punto
 * y dirección; una casa o un puesto, solo municipio y estado; solo en línea,
 * el estado. Si el teléfono manda de más, se rechaza: el domicilio de alguien
 * que trabaja en su casa no puede acabar en el directorio por un descuido.
 */
export function parsePublicLocation(value: unknown, presence: Presence): PublicLocation | string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "publicLocation";
  const record = value as Record<string, unknown>;
  const allowed: Record<Presence, string[]> = {
    establecimiento: ["subdivision", "municipality", "address", "point"],
    domicilio: ["subdivision", "municipality"],
    ambulante: ["subdivision", "municipality"],
    en_linea: ["subdivision"]
  };
  if (Object.keys(record).some(key => !allowed[presence].includes(key))) return "publicLocation.extra";
  const subdivision = record.subdivision;
  if (typeof subdivision !== "string" || !MX_SUBDIVISIONS.has(subdivision)) return "publicLocation.subdivision";
  const result: PublicLocation = { subdivision };
  if (presence === "en_linea") return result;

  const municipality = typeof record.municipality === "string" ? cleanText(record.municipality) : "";
  if (municipality.length < 2 || municipality.length > 80) return "publicLocation.municipality";
  result.municipality = municipality;
  if (presence !== "establecimiento") return result;

  const address = parseAddress(record.address);
  if (!address || address.subdivision !== subdivision || address.municipality !== municipality) return "publicLocation.address";
  const point = record.point as Record<string, unknown> | undefined;
  const latitude = point?.latitude, longitude = point?.longitude;
  if (typeof latitude !== "number" || typeof longitude !== "number" || !Number.isFinite(latitude) || !Number.isFinite(longitude)
    || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return "publicLocation.point";
  result.address = address;
  result.point = { latitude, longitude };
  return result;
}

function parseAddress(value: unknown): PublicAddress | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = ["street", "exteriorNumber", "interiorNumber", "neighborhood", "postalCode", "municipality", "subdivision"];
  if (Object.keys(record).some(key => !keys.includes(key))) return null;
  const text = (key: string, max: number): string | null => {
    const raw = record[key];
    if (typeof raw !== "string") return null;
    const clean = cleanText(raw);
    return clean.length >= 1 && clean.length <= max ? clean : null;
  };
  const street = text("street", 120), exteriorNumber = text("exteriorNumber", 20), neighborhood = text("neighborhood", 120);
  const municipality = text("municipality", 80), subdivision = text("subdivision", 3);
  const postalCode = typeof record.postalCode === "string" && /^[0-9]{5}$/.test(record.postalCode) ? record.postalCode : null;
  if (!street || !exteriorNumber || !neighborhood || !municipality || !subdivision || !postalCode) return null;
  const address: PublicAddress = { street, exteriorNumber, neighborhood, postalCode, municipality, subdivision };
  if (record.interiorNumber !== undefined) {
    const interior = text("interiorNumber", 20);
    if (!interior) return null;
    address.interiorNumber = interior;
  }
  return address;
}

// ---------------------------------------------------------------------------
// Lo que tiene que llegar a la bóveda antes de pasar a revisión
// ---------------------------------------------------------------------------

/**
 * Las partes selladas de un alta. Todas van cifradas en el teléfono con la
 * clave pública de revisión; el servidor guarda bytes opacos.
 *
 * `retention` es la de `BusinessDataPolicy`: «mientras exista» o «30 días
 * tras decidir».
 */
export const VAULT_PARTS = {
  /** Nombre del responsable, dirección y punto, resultado del proveedor. */
  expediente: "mientras_exista",
  /** La lectura de la visita y lo demás que solo sirve para decidir. */
  evidencia: "decision",
  fachada: "decision",
  interior: "decision",
  productos: "decision",
  comprobante: "decision",
  permiso: "decision",
  efirma: "decision"
} as const;
export type VaultPart = keyof typeof VAULT_PARTS;
export type Retention = (typeof VAULT_PARTS)[VaultPart];

export function isVaultPart(value: unknown): value is VaultPart {
  return typeof value === "string" && Object.hasOwn(VAULT_PARTS, value);
}

/** Lo que se adjunta aparte (fotos y documentos), según el alta. */
export function requiredAttachments(presence: Presence, category: Category, legalForm: LegalForm): VaultPart[] {
  const parts: VaultPart[] = [];
  if (presence === "establecimiento") parts.push("fachada", "interior");
  if (presence === "domicilio" || presence === "ambulante") parts.push("productos");
  if (presence === "en_linea") parts.push("comprobante");
  if (CATEGORIES[category] !== null) parts.push("permiso");
  if (legalForm === "persona_moral") parts.push("efirma");
  return parts;
}

/** Lo que un alta puede adjuntar: lo requerido para ella, y nada más. */
export function allowedAttachments(presence: Presence, category: Category, legalForm: LegalForm): VaultPart[] {
  return requiredAttachments(presence, category, legalForm);
}
