// Las reglas del alias de AION.
//
// Copia tal cual de `apps/directory/src/alias.ts` de AION-Backend. La misma
// regla está en Swift (`Sources/PulseCore/Alias/AliasHandle.swift` de
// AION-iOS) y la obliga `tests/vectors/alias-v1.json`, copiado tal cual en los
// tres repositorios. Aquí se usa el esqueleto y las reservadas: un alias de
// negocio no puede chocar con el de una persona. Si el teléfono y el servidor
// calculan distinto el esqueleto, uno cree libre un alias que el otro tiene
// ocupado.
//
// Reglas en `docs/ALIAS-DISENO.md` §3.3, §3.4 y §3.15 de AION-iOS.

export const DISCRIMINATOR_MIN = 100_000;
export const DISCRIMINATOR_MAX = 999_999;

export const RESERVED_WORDS = [
  "aion", "skimzero", "pulse", "soporte", "ayuda",
  "admin", "oficial", "seguridad", "verificado", "sistema"
] as const;

const PART = /^[a-z]{2,15}$/;
const DIGITS = /^[0-9]{6}$/;

export interface AliasHandle {
  /** `damaso_sanz`, en minúsculas. */
  base: string;
  discriminator: number;
}

/** La base `nombre_apellido`, en minúsculas, o `null` si no tiene la forma. */
export function parseBase(text: string): string | null {
  const lower = text.toLowerCase();
  const parts = lower.split("_");
  return parts.length === 2 && parts.every(part => PART.test(part)) ? lower : null;
}

/** Con o sin `@`, en mayúsculas o no, con espacios alrededor. Nada más. */
export function parseHandle(text: string): AliasHandle | null {
  let clean = text.trim();
  if (clean.startsWith("@")) clean = clean.slice(1);
  const parts = clean.split(".");
  if (parts.length !== 2) return null;
  const base = parseBase(parts[0]);
  if (base === null || !DIGITS.test(parts[1])) return null;
  const discriminator = Number(parts[1]);
  if (discriminator < DISCRIMINATOR_MIN || discriminator > DISCRIMINATOR_MAX) return null;
  return { base, discriminator };
}

export function canonical(handle: AliasHandle): string {
  return `${handle.base}.${handle.discriminator}`;
}

/**
 * El esqueleto, en este orden y no en otro: minúsculas; quitar `_`; `rn→m` y
 * `vv→w`; y después cada carácter suelto `0→o`, `1→l`, `i→l`, `5→s`.
 */
export function skeleton(text: string): string {
  const joined = text.toLowerCase().replaceAll("_", "").replaceAll("rn", "m").replaceAll("vv", "w");
  const singles: Record<string, string> = { "0": "o", "1": "l", i: "l", "5": "s" };
  return Array.from(joined, char => singles[char] ?? char).join("");
}

/** Lo que el directorio declara único: la columna `UNIQUE`, antes del HMAC. */
export function uniquenessKey(handle: AliasHandle): string {
  return `${skeleton(handle.base)}.${handle.discriminator}`;
}

const reservedSkeletons = new Set<string>(RESERVED_WORDS.map(skeleton));

/**
 * Reservada si lo es el esqueleto de la base entera o el de alguna de sus dos
 * partes: caen `ai_on` y `aion_lopez`, pero no `alonso_perez`.
 */
export function isReserved(base: string): boolean {
  return reservedSkeletons.has(skeleton(base)) || base.split("_").some(part => reservedSkeletons.has(skeleton(part)));
}

/** Solo las letras `a-z` de un texto, sin acentos. */
function letters(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z]/g, "");
}

/** La base que se propone desde el nombre de perfil, o `null` si no sale. */
export function suggestBase(firstName: string, lastName: string): string | null {
  return parseBase(`${letters(firstName).slice(0, 15)}_${letters(lastName).slice(0, 15)}`);
}
