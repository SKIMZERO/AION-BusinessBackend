import { describe, expect, it } from "vitest";
import {
  DISCRIMINATOR_MAX, DISCRIMINATOR_MIN, RESERVED_WORDS,
  canonical, isReserved, parseBase, parseHandle, skeleton, suggestBase, uniquenessKey
} from "../src/alias";
import vectors from "./vectors/alias-v1.json";

// Copia de `apps/directory/test/alias.test.ts` de AION-Backend: los mismos vectores que comprueba iOS (`Tests/PulseCoreTests/AliasVectorTests.swift`).
// Se copian tal cual; se añaden casos, no se cambian.

describe("vectores compartidos del alias", () => {
  it("es la versión de las reglas que implementa este directorio", () => {
    expect(vectors.protocol).toBe("aion-alias-v1");
    expect([DISCRIMINATOR_MIN, DISCRIMINATOR_MAX]).toEqual(vectors.discriminatorRange);
    expect([...RESERVED_WORDS]).toEqual(vectors.reservedWords);
  });

  it("calcula el mismo esqueleto", () => {
    for (const c of vectors.skeleton) expect(skeleton(c.input), c.input).toBe(c.skeleton);
  });

  it("lee igual los alias válidos", () => {
    for (const c of vectors.valid) {
      const handle = parseHandle(c.input);
      expect(handle, c.input).not.toBeNull();
      if (!handle) continue;
      expect(canonical(handle)).toBe(c.canonical);
      expect(`@${canonical(handle)}`).toBe(c.display);
      expect(uniquenessKey(handle)).toBe(c.uniquenessKey);
    }
  });

  it("rechaza los inválidos", () => {
    for (const c of vectors.invalid) expect(parseHandle(c.input), `${c.input}: ${c.why}`).toBeNull();
  });

  it("propone la misma base desde el nombre de perfil", () => {
    for (const c of vectors.suggest) {
      expect(suggestBase(c.firstName, c.lastName), `${c.firstName} ${c.lastName}`).toBe(c.base);
    }
  });

  it("reserva las mismas bases", () => {
    for (const c of vectors.reserved) {
      expect(parseBase(c.base)).toBe(c.base);
      expect(isReserved(c.base), c.base).toBe(c.reserved);
    }
  });
});
