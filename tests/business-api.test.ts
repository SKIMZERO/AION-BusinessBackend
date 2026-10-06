import { applyD1Migrations, env, SELF } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { beforeEach, describe, expect, it } from "vitest";
import { curpCheckDigit, isConfusableName, isReservedAlias, parseAliasBase, parseCURP, parsePublicLocation, parseRFC, parseTradeName } from "../src/rules";
import { purgar, REVIEW_RETENTION_MS, DRAFT_TTL_MS } from "../src/index";

const migrations = env.TEST_MIGRATIONS as D1Migration[];
const ANA = "token-ana";
const BETO = "token-beto";

beforeEach(async () => {
  await applyD1Migrations(env.DB, migrations);
  await env.DB.batch(["dossier_access", "review_actions", "vault_parts", "banned_indices", "sat_69b", "limites", "applications"]
    .map(tabla => env.DB.prepare(`DELETE FROM ${tabla}`)));
  const objetos = await env.VAULT.list();
  for (const objeto of objetos.objects) await env.VAULT.delete(objeto.key);
});

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

/** Una CURP sintética con su dígito verificador; `n` cambia la homoclave. */
function curp(n: number): string {
  const base = `GOAP780710HDFRLB${n % 10}`;
  return base + curpCheckDigit(base);
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Bytes «sellados» de prueba: el servidor no los abre, así que basta con que sean opacos. */
function sellado(etiqueta: string, size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  const marca = new TextEncoder().encode(etiqueta);
  bytes.set(marca.subarray(0, size));
  return bytes;
}

interface Alta { id: string; token: string; body: Record<string, unknown> }

function alta(over: Record<string, unknown> = {}): Alta {
  const id = crypto.randomUUID();
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const body: Record<string, unknown> = {
    applicationID: id,
    ownerToken: token,
    tradeName: "Richie Hoodies",
    aliasBase: "richie_hoodies",
    category: "ropaYCalzado",
    legalForm: "persona_fisica",
    presence: "domicilio",
    publicLocation: { subdivision: "CMX", municipality: "Coyoacán" },
    rfc: "GOAP780710RH7",
    curp: curp(1),
    reviewKeyID: "review-dev-1",
    expediente: b64url(sellado("expediente")),
    evidencia: b64url(sellado("evidencia")),
    ...over
  };
  return { id, token, body };
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(`https://business.test${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body)
  });
}

async function crear(a: Alta): Promise<Response> {
  return post("/v1/applications", a.body);
}

async function adjuntar(a: Alta, part: string, bytes = sellado(part)): Promise<Response> {
  return SELF.fetch(`https://business.test/v1/applications/${a.id}/attachments/${part}`, {
    method: "PUT", headers: { authorization: `Bearer ${a.token}`, "content-type": "application/octet-stream" }, body: bytes
  });
}

async function enviar(a: Alta): Promise<Response> {
  return post(`/v1/applications/${a.id}/submit`, {}, { authorization: `Bearer ${a.token}` });
}

async function estado(a: Alta, token = a.token): Promise<Response> {
  return SELF.fetch(`https://business.test/v1/applications/${a.id}`, { headers: { authorization: `Bearer ${token}` } });
}

async function operar(token: string, path: string, body?: unknown): Promise<Response> {
  return body === undefined
    ? SELF.fetch(`https://business.test${path}`, { method: path.endsWith("queue") || path.includes("/parts/") ? "GET" : "POST", headers: { authorization: `Bearer ${token}` } })
    : post(path, body, { authorization: `Bearer ${token}` });
}

/** Crea, adjunta lo requerido y envía. */
async function altaEnviada(over: Record<string, unknown> = {}): Promise<Alta> {
  const a = alta(over);
  expect((await crear(a)).status).toBe(201);
  const vista = await (await estado(a)).json() as { missing: string[] };
  for (const part of vista.missing) expect((await adjuntar(a, part)).status).toBe(201);
  expect((await enviar(a)).status).toBe(200);
  return a;
}

async function aprobar(a: Alta): Promise<void> {
  expect((await operar(ANA, `/review/${a.id}/take`)).status).toBe(200);
  expect((await operar(ANA, `/review/${a.id}/decide`, { action: "approve" })).status).toBe(202);
  expect((await operar(BETO, `/review/${a.id}/decide`, { action: "approve" })).status).toBe(200);
}

/** Todo lo que hay en D1, como texto: para buscar algo que no debería estar. */
async function todoD1(): Promise<string> {
  const tablas = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'").all<{ name: string }>();
  let texto = "";
  for (const { name } of tablas.results) texto += JSON.stringify((await env.DB.prepare(`SELECT * FROM ${name}`).all()).results);
  return texto;
}

// ---------------------------------------------------------------------------
// Reglas (las mismas que en Swift)
// ---------------------------------------------------------------------------

describe("reglas del alta, iguales a las del teléfono", () => {
  it("RFC: los mismos casos que BusinessTests.swift", () => {
    expect(parseRFC("NWM9709244W4")?.kind).toBe("persona_moral");
    expect(parseRFC("TME840315KT6")?.kind).toBe("persona_moral");
    expect(parseRFC("CFE370814QI0")?.kind).toBe("persona_moral");
    expect(parseRFC("GOAP780710RH7")?.kind).toBe("persona_fisica");
    expect(parseRFC("nwm 970924 4w4")?.value).toBe("NWM9709244W4");
    expect(parseRFC("NWM9709244W5")).toBeNull();
    expect(parseRFC("XAXX010101000")).toBeNull();
    expect(parseRFC("NWM970924W4")).toBeNull();
    expect(parseRFC("ABC991301AB2")).toBeNull();
    expect(parseRFC("ABC010229AB8")).toBeNull();
    expect(parseRFC("GOAP780230RH5")).toBeNull();
    expect(parseRFC("ABC000229AB5")).not.toBeNull();
    expect(parseRFC("GOAP800229RH7")).not.toBeNull();
  });

  it("CURP: forma, fecha, entidad y dígito verificador", () => {
    expect(parseCURP(curp(1))).toBe(curp(1));
    expect(parseCURP(curp(1).toLowerCase())).toBe(curp(1));
    const malo = curp(1).slice(0, 17) + String((Number(curp(1)[17]) + 1) % 10);
    expect(parseCURP(malo)).toBeNull();
    expect(parseCURP("GOAP781310HDFRLB01")).toBeNull();
    const sinEntidad = "GOAP780710HZZRLB0";
    expect(parseCURP(sinEntidad + curpCheckDigit(sinEntidad))).toBeNull();
  });

  it("nombre comercial y alias", () => {
    expect(parseTradeName("  Richie   Hoodies ")).toBe("Richie Hoodies");
    expect(parseTradeName("Café & Pan de Doña Rosa")).toBe("Café & Pan de Doña Rosa");
    expect(parseTradeName("✅ Oficial")).toBeNull();
    expect(parseTradeName("Richie Hооdies")).toBeNull(); // «о» cirílicas
    expect(parseTradeName("12")).toBeNull();
    expect(parseAliasBase("Richie_Hoodies")).toBe("richie_hoodies");
    expect(parseAliasBase("a_b_c_d")).toBeNull();
    expect(isReservedAlias("banco_juarez")).toBe(true);
    expect(isReservedAlias("satelite_tacos")).toBe(false);
    expect(isConfusableName("Richie Hoodies", "Rlchie Hoodies")).toBe(true);
    expect(isConfusableName("Richie Hoodies", "Richie Hoodie")).toBe(true);
    expect(isConfusableName("Café", "Cafa")).toBe(false);
  });

  it("la ubicación pública no puede llevar de más", () => {
    expect(parsePublicLocation({ subdivision: "CMX", municipality: "Coyoacán" }, "domicilio")).toEqual({ subdivision: "CMX", municipality: "Coyoacán" });
    expect(parsePublicLocation({ subdivision: "CMX", municipality: "Coyoacán", point: { latitude: 19.3, longitude: -99.1 } }, "domicilio")).toBe("publicLocation.extra");
    expect(parsePublicLocation({ subdivision: "CMX", municipality: "Coyoacán" }, "en_linea")).toBe("publicLocation.extra");
    expect(parsePublicLocation({ subdivision: "XYZ" }, "en_linea")).toBe("publicLocation.subdivision");
  });
});

// ---------------------------------------------------------------------------
// El alta
// ---------------------------------------------------------------------------

describe("alta de un negocio", () => {
  it("un alta completa llega a la cola; una incompleta no", async () => {
    const a = alta();
    const creada = await crear(a);
    expect(creada.status).toBe(201);
    const vista = await creada.json() as { state: string; missing: string[] };
    expect(vista.state).toBe("borrador");
    expect(vista.missing).toEqual(["productos"]);

    const incompleta = await enviar(a);
    expect(incompleta.status).toBe(422);
    expect(await incompleta.json()).toEqual({ error: "incompleta", missing: ["productos"] });
    let cola = await (await operar(ANA, "/review/queue")).json() as { items: unknown[] };
    expect(cola.items).toHaveLength(0);

    expect((await adjuntar(a, "productos")).status).toBe(201);
    expect((await enviar(a)).status).toBe(200);
    cola = await (await operar(ANA, "/review/queue")).json() as { items: { applicationID: string }[] };
    expect(cola.items.map(item => item.applicationID)).toEqual([a.id]);
  });

  it("lo requerido depende de cómo es el negocio", async () => {
    const local = alta({
      presence: "establecimiento", category: "farmacia", legalForm: "persona_moral", rfc: "NWM9709244W4",
      legalName: "Nueva Wal Mart de México", aliasBase: "farmacia_centro", tradeName: "Farmacia Centro",
      publicLocation: {
        subdivision: "CMX", municipality: "Coyoacán", point: { latitude: 19.35, longitude: -99.16 },
        address: { street: "Av. Universidad", exteriorNumber: "100", neighborhood: "Oxtopulco", postalCode: "04318", municipality: "Coyoacán", subdivision: "CMX" }
      }
    });
    const vista = await (await crear(local)).json() as { missing: string[]; publicProfile: Record<string, unknown> };
    expect(vista.missing).toEqual(["fachada", "interior", "permiso", "efirma"]);
    expect(vista.publicProfile.rfc).toBe("NWM9709244W4");

    const enLinea = alta({ presence: "en_linea", publicLocation: { subdivision: "JAL" }, aliasBase: "solo_en_linea", curp: curp(2), rfc: undefined, legalForm: "sin_rfc" });
    delete enLinea.body.rfc;
    expect((await (await crear(enLinea)).json() as { missing: string[] }).missing).toEqual(["comprobante"]);
  });

  it("valida en el servidor lo que el teléfono ya comprobó", async () => {
    const casos: [Record<string, unknown>, string][] = [
      [{ tradeName: "✅ Oficial" }, "tradeName"],
      [{ rfc: "NWM9709244W4" }, "rfc"],                       // RFC de empresa en una persona física
      [{ legalForm: "persona_moral", rfc: "NWM9709244W4" }, "legalName"],
      [{ curp: "GOAP780710HDFRLB00" }, "curp"],
      [{ category: "armas" }, "category"],
      [{ publicLocation: { subdivision: "CMX", municipality: "Coyoacán", address: {} } }, "publicLocation.extra"],
      [{ extra: 1 }, "unexpected"]
    ];
    for (const [cambio, campo] of casos) {
      const respuesta = await crear(alta(cambio));
      expect(respuesta.status, campo).toBe(400);
      expect(await respuesta.json(), campo).toEqual({ error: "invalid", field: campo });
    }
  });

  it("un alias reservado solo lo pide una empresa, y entonces va marcado a revisión", async () => {
    expect((await crear(alta({ aliasBase: "banco_juarez" }))).status).toBe(422);
    const empresa = alta({ aliasBase: "banco_juarez", legalForm: "persona_moral", rfc: "TME840315KT6", legalName: "Teléfonos de México" });
    const vista = await (await crear(empresa)).json() as { warnings: string[] };
    expect(vista.warnings).toEqual(["alias_reservado"]);
  });

  it("es idempotente para el mismo teléfono y ajena para otro", async () => {
    const a = alta();
    expect((await crear(a)).status).toBe(201);
    expect((await crear(a)).status).toBe(200);
    const otro = { ...a.body, ownerToken: b64url(crypto.getRandomValues(new Uint8Array(32))) };
    expect((await post("/v1/applications", otro)).status).toBe(409);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM applications").first<{ n: number }>())?.n).toBe(1);
  });

  it("con otro token el alta no existe: misma respuesta que un id inventado", async () => {
    const a = alta();
    await crear(a);
    const ajeno = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const r1 = await estado(a, ajeno);
    const r2 = await SELF.fetch(`https://business.test/v1/applications/${crypto.randomUUID()}`, { headers: { authorization: `Bearer ${a.token}` } });
    expect(r1.status).toBe(404);
    expect(r2.status).toBe(404);
    expect(await r1.json()).toEqual(await r2.json());
  });

  it("una clave de revisión vieja se rechaza: nadie podría abrir lo sellado", async () => {
    const respuesta = await crear(alta({ reviewKeyID: "review-dev-0" }));
    expect(respuesta.status).toBe(409);
    expect(await respuesta.json()).toEqual({ error: "clave_de_revision_vieja", reviewKeyID: "review-dev-1" });
  });

  it("alias y RFC: uno por negocio vivo", async () => {
    await altaEnviada();
    expect(await (await crear(alta({ aliasBase: "rlchie_hoodies", curp: curp(3), rfc: "GOAP800229RH7" }))).json()).toEqual({ error: "alias_ocupado" });
    expect(await (await crear(alta({ aliasBase: "otro_alias", curp: curp(3) }))).json()).toEqual({ error: "rfc_ya_registrado" });
  });
});

// ---------------------------------------------------------------------------
// Tratamiento de los datos
// ---------------------------------------------------------------------------

describe("ni CURP, ni RFC de persona física, ni imágenes en claro", () => {
  it("el esquema no tiene columnas para ellos", async () => {
    const columnas: string[] = [];
    const tablas = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all<{ name: string }>();
    for (const { name } of tablas.results) {
      const info = await env.DB.prepare(`PRAGMA table_info(${name})`).all<{ name: string }>();
      columnas.push(...info.results.map(c => `${name}.${c.name}`));
    }
    const sospechosas = columnas.filter(c => /curp|rfc|ip|email|correo|image|foto|photo|address|direccion/i.test(c.split(".")[1]));
    expect(sospechosas.sort()).toEqual([
      "applications.curp_index", "applications.rfc_index", "applications.rfc_moral", "banned_indices.curp_index", "sat_69b.rfc_index"
    ]);
  });

  it("tras un alta completa, ni la CURP ni el RFC de la persona están en D1, y la bóveda guarda los bytes tal cual", async () => {
    const foto = crypto.getRandomValues(new Uint8Array(4096));
    const a = alta();
    await crear(a);
    await adjuntar(a, "productos", foto);
    await enviar(a);
    const d1 = await todoD1();
    expect(d1).not.toContain(curp(1));
    expect(d1).not.toContain("GOAP780710RH7");
    expect(d1).not.toContain("GOAP780710");
    const guardada = await env.VAULT.get(`${a.id}/productos`);
    expect(new Uint8Array(await guardada!.arrayBuffer())).toEqual(foto);
  });

  it("de un negocio en casa, el directorio solo enseña municipio y estado", async () => {
    const a = await altaEnviada();
    await aprobar(a);
    const resultados = await (await post("/v1/directory/search", { query: "richie" })).json() as { results: Record<string, unknown>[] };
    expect(resultados.results).toEqual([{
      tradeName: "Richie Hoodies", aliasBase: "richie_hoodies", category: "ropaYCalzado",
      location: { subdivision: "CMX", municipality: "Coyoacán" }, newcomer: true
    }]);
  });
});

// ---------------------------------------------------------------------------
// Contra el fraude
// ---------------------------------------------------------------------------

describe("tope, veto y lista 69-B", () => {
  it("una persona no tiene más de 3 negocios vivos; uno rechazado no cuenta", async () => {
    for (let i = 0; i < 3; i += 1) {
      expect((await crear(alta({ aliasBase: `negocio_${i}`, tradeName: `Negocio ${i}`, legalForm: "sin_rfc", rfc: undefined }))).status).toBe(201);
    }
    const cuarta = await crear(alta({ aliasBase: "negocio_cuatro", legalForm: "sin_rfc", rfc: undefined }));
    expect(cuarta.status).toBe(409);
    expect(await cuarta.json()).toEqual({ error: "tope_de_negocios", max: 3 });
    await env.DB.prepare("UPDATE applications SET state = 'rechazada' WHERE alias_base = 'negocio_0'").run();
    expect((await crear(alta({ aliasBase: "negocio_cuatro", legalForm: "sin_rfc", rfc: undefined }))).status).toBe(201);
  });

  it("revocar por fraude con dos operadores veta a la persona", async () => {
    const a = await altaEnviada();
    await aprobar(a);
    expect((await operar(ANA, `/review/${a.id}/decide`, { action: "revoke", reason: "cobró y no entregó", fraud: true })).status).toBe(202);
    expect((await operar(BETO, `/review/${a.id}/decide`, { action: "revoke", reason: "confirmado", fraud: true })).status).toBe(200);
    const otra = await crear(alta({ aliasBase: "otro_nombre", tradeName: "Otro Nombre", legalForm: "sin_rfc", rfc: undefined }));
    expect(otra.status).toBe(403);
    expect(await otra.json()).toEqual({ error: "no_admitida" });
  });

  it("si solo uno de los dos marca fraude, se revoca pero no se veta", async () => {
    const a = await altaEnviada();
    await aprobar(a);
    await operar(ANA, `/review/${a.id}/decide`, { action: "revoke", reason: "dudas", fraud: true });
    await operar(BETO, `/review/${a.id}/decide`, { action: "revoke", reason: "otra razón" });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM banned_indices").first<{ n: number }>())?.n).toBe(0);
  });

  it("un RFC de la lista 69-B no entra", async () => {
    expect((await operar(ANA, "/review/sat-69b", { rfcs: ["GOAP780710RH7"] })).status).toBe(200);
    const respuesta = await crear(alta());
    expect(respuesta.status).toBe(403);
    expect(await respuesta.json()).toEqual({ error: "rfc_no_admitido" });
  });

  it("un nombre parecido a un verificado llega marcado a la revisión, sin decir a cuál", async () => {
    const a = await altaEnviada();
    await aprobar(a);
    const copia = alta({ tradeName: "Rlchie Hoodies", aliasBase: "rh_ropa", curp: curp(4), rfc: "GOAP800229RH7" });
    const vista = await (await crear(copia)).json() as { warnings: string[] };
    expect(vista.warnings).toEqual(["nombre_parecido"]);
    const fila = await env.DB.prepare("SELECT review_flags FROM applications WHERE id = ?").bind(copia.id).first<{ review_flags: string }>();
    expect(JSON.parse(fila!.review_flags)).toEqual([{ tipo: "nombre_parecido", con: a.id }]);
  });

  it("más de 10 altas por hora desde la misma IP: 429", async () => {
    let ultima = 0;
    for (let i = 0; i < 11; i += 1) {
      const r = await SELF.fetch("https://business.test/v1/applications", {
        method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" },
        body: JSON.stringify(alta({ aliasBase: `n_${i}`, tradeName: `Negocio ${i}`, curp: curp(i), legalForm: "sin_rfc", rfc: undefined }).body)
      });
      ultima = r.status;
    }
    expect(ultima).toBe(429);
    expect(await todoD1()).not.toContain("203.0.113.7");
  });
});

// ---------------------------------------------------------------------------
// La revisión
// ---------------------------------------------------------------------------

describe("revisión con doble operador", () => {
  it("aprobar exige dos operadores distintos", async () => {
    const a = await altaEnviada();
    await operar(ANA, `/review/${a.id}/take`);
    expect((await operar(ANA, `/review/${a.id}/decide`, { action: "approve" })).status).toBe(202);
    expect((await operar(ANA, `/review/${a.id}/decide`, { action: "approve" })).status).toBe(409);
    expect(((await (await estado(a)).json()) as { state: string }).state).toBe("en_revision");
    expect((await operar(BETO, `/review/${a.id}/decide`, { action: "approve" })).status).toBe(200);
    expect(((await (await estado(a)).json()) as { state: string }).state).toBe("aprobada");
  });

  it("pedir cambios descarta los votos: lo que se reenvía es otra cosa", async () => {
    const a = await altaEnviada();
    await operar(ANA, `/review/${a.id}/take`);
    await operar(ANA, `/review/${a.id}/decide`, { action: "approve" });
    await operar(BETO, `/review/${a.id}/decide`, { action: "request_changes", reason: "la foto de productos no se ve" });
    const vista = await (await estado(a)).json() as { state: string; reason: string };
    expect(vista).toMatchObject({ state: "requiere_cambios", reason: "la foto de productos no se ve" });
    await adjuntar(a, "productos");
    expect((await enviar(a)).status).toBe(200);
    await operar(ANA, `/review/${a.id}/take`);
    // El voto de antes ya no cuenta: uno solo no aprueba.
    expect((await operar(BETO, `/review/${a.id}/decide`, { action: "approve" })).status).toBe(202);
  });

  it("sin token de operador no hay revisión", async () => {
    expect((await operar("token-falso", "/review/queue")).status).toBe(401);
    expect((await SELF.fetch("https://business.test/review/queue")).status).toBe(401);
  });

  it("abrir una parte del expediente queda anotado, y el negocio lo ve", async () => {
    const a = await altaEnviada();
    const parte = await operar(ANA, `/review/${a.id}/parts/expediente`);
    expect(parte.status).toBe(200);
    expect(new Uint8Array(await parte.arrayBuffer())).toEqual(sellado("expediente"));
    const registro = await (await SELF.fetch(`https://business.test/v1/applications/${a.id}/access-log`, { headers: { authorization: `Bearer ${a.token}` } })).json() as { accesses: { operator: string; part: string }[] };
    expect(registro.accesses).toMatchObject([{ operator: "ana", part: "expediente" }]);
  });
});

// ---------------------------------------------------------------------------
// Purga
// ---------------------------------------------------------------------------

describe("lo que solo servía para decidir se borra", () => {
  it("a los 30 días de aprobar se va la evidencia y se queda el expediente", async () => {
    const a = await altaEnviada();
    await aprobar(a);
    await purgar(env, Date.now() + REVIEW_RETENTION_MS - 60_000);
    expect(await env.VAULT.get(`${a.id}/productos`)).not.toBeNull();
    await purgar(env, Date.now() + REVIEW_RETENTION_MS + 60_000);
    expect(await env.VAULT.get(`${a.id}/productos`)).toBeNull();
    expect(await env.VAULT.get(`${a.id}/evidencia`)).toBeNull();
    expect(await env.VAULT.get(`${a.id}/expediente`)).not.toBeNull();
  });

  it("de un alta rechazada se va todo, salvo con apelación abierta", async () => {
    const a = await altaEnviada();
    await operar(ANA, `/review/${a.id}/take`);
    await operar(ANA, `/review/${a.id}/decide`, { action: "reject", reason: "no coincide la dirección" });
    expect((await post(`/v1/applications/${a.id}/appeal`, {}, { authorization: `Bearer ${a.token}` })).status).toBe(200);
    await purgar(env, Date.now() + REVIEW_RETENTION_MS + 60_000);
    expect(await env.VAULT.get(`${a.id}/expediente`)).not.toBeNull();
    await env.DB.prepare("UPDATE applications SET appeal_open = 0").run();
    await purgar(env, Date.now() + REVIEW_RETENTION_MS + 60_000);
    expect(await env.VAULT.get(`${a.id}/expediente`)).toBeNull();
    // La fila se queda: su índice cuenta para el tope y el veto.
    expect(await env.DB.prepare("SELECT state FROM applications WHERE id = ?").bind(a.id).first()).toEqual({ state: "rechazada" });
  });

  it("un alta que nunca se envió no deja rastro al día", async () => {
    const a = alta();
    await crear(a);
    await purgar(env, Date.now() + DRAFT_TTL_MS + 60_000);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM applications").first<{ n: number }>()).toEqual({ n: 0 });
    expect((await env.VAULT.list()).objects).toHaveLength(0);
  });
});
