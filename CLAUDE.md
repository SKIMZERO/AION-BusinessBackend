# AION Business Backend — Configuración de proyecto

**Hereda:** `~/.claude/CLAUDE.md` (línea base global + skills automáticas)

---

## Qué es este repositorio

Un Worker de Cloudflare, `pulse-business-api`: el alta y la revisión de
negocios de AION y su directorio público. Diseño en `docs/NEGOCIOS-DISENO.md`
§13 de AION-iOS; contrato HTTP en `README.md`.

En el Mac vive en `/Volumes/DevSSD/Developer/AION-BusinessBackend`, junto a
`AION-iOS` y `AION-Backend`.

Se separó de `apps/business` de AION-Backend el 2026-10-06. **No comparte** base
de datos, bucket, secretos ni despliegue con el relay, con `pulse-recovery-api`
ni con `SkimZeroVaultBackend`: si se filtrara cualquiera de ellos, de aquí no
debe salir ni un domicilio.

---

## Reglas de seguridad (OBLIGATORIAS)

- **CURP y RFC de persona física, nunca en claro.** Llegan en la petición, se
  convierten en índice (`HMAC(BUSINESS_INDEX_PEPPER, propósito + valor)`) y se
  descartan. Solo el RFC y la razón social de una **persona moral** se guardan
  en claro, porque son públicos.
- **La bóveda guarda bytes sellados.** El teléfono cifra expediente, fotos y
  documentos con la clave pública de revisión. La clave privada no entra nunca
  en el Worker ni en este repositorio.
- **Imágenes de credencial y rostro: no llegan aquí.** Van del teléfono al
  proveedor de identidad.
- **Sin IP persistente.** Solo contadores por hora en `limites`, con clave HMAC,
  que la purga borra.
- **Respuestas indistinguibles.** Un alta con otro token responde igual que una
  que no existe.
- **Dos operadores** para aprobar, reactivar, revocar y vetar. Cada operador con
  su propio token (`OPERATOR_TOKENS` guarda solo su SHA-256).
- **Secretos fuera del repositorio.** En archivos versionados solo marcadores
  `REPLACE_WITH_...`; los valores de `vitest.config.ts` son de prueba.
- Una columna nueva en D1 obliga a actualizar la prueba de esquema
  («el esquema no tiene columnas para ellos»).

---

## Reglas compartidas con otros repositorios

| Archivo | Original | Regla |
|---|---|---|
| `src/rules.ts` | `Sources/PulseCore/Business/` de AION-iOS | Mismos casos de RFC que `BusinessTests.swift` |
| `src/alias.ts` + `tests/vectors/alias-v1.json` | `apps/directory` de AION-Backend | Copia tal cual; se añaden casos, no se cambian |

Si cambias una regla aquí, cámbiala en el original y al revés.

---

## Cómo se verifica

```bash
pnpm install
pnpm run typecheck
pnpm test
```

Referencia al 2026-10-06 (v0.1.0): **34 pruebas en 2 archivos**, tipos limpios.

## Versiones

Etiquetas `vX.Y.Z` y `CHANGELOG.md`. Cambiar el contrato HTTP o el esquema D1
sube la versión menor mientras sea `0.x`. Una migración nueva va en
`migrations/` con número siguiente; nunca se edita una ya aplicada.

---

## Orchestron

Este repositorio es un proyecto **backend** del producto en Orchestron
(`/Volumes/DevSSD/Developer/OrquestacionMultiplataforma`), junto a «Pulse iOS» y
«Pulse Backend». **Hasta el 2026-10-06 no estaba dado de alta**: el registro
propuesto está en `docs/orchestron/SINCRONIZACION-2026-10-06.md` de AION-iOS.

- El `projectId` se resuelve por la ruta, nunca de memoria:
  `orchestron_list_workspaces` → `orchestron_get_workspace` → el proyecto cuyo
  `repoUrl` sea `/Volumes/DevSSD/Developer/AION-BusinessBackend`.
- Al empezar: `orchestron_get_platform_context` con ese `projectId`.
- Antes de modificar un archivo: `orchestron_check_path`.
- Al terminar: actualizar la fase con `outputSummary` (evidencia: `pnpm test`).
  Una fase pasa a `completed` solo con evidencia y con `/linea-base` sin regresiones.

## Plan maestro AION

Este repositorio forma parte del programa **AION** (iOS, Mac, Android, Web, Windows, AION-Backend, AION-BusinessBackend). La cola de trabajo única es
`/Volumes/DevSSD/Developer/AION-Android/blueprints/aion-plan-maestro/tasks.json`; el porqué está en `blueprint.md` y `PLAN-MAESTRO.md`
del mismo directorio.

Reglas que mandan sobre cualquier otra prioridad de trabajo:

1. **Una ola a la vez.** Solo se trabaja en tareas cuyo `epic` pertenece a la ola activa (o a los carriles de clientes `08-carril-android`, `09-cliente-web`, `10-cliente-windows`, cada uno en su repo). Nada entra en la
   cola sin pasar por el plan; una idea nueva va a una propuesta, no a una rama.
2. **Siguiente tarea:** la primera de `tasks.json`, en orden de array, con `status: pending` y todas sus dependencias en `done`. Marcarla
   `in_progress` antes de tocar código; abrir solo `epics/<epic>.md`; ejecutar todos sus `verify`; marcar `done`; commit `E{n}-T{m}: …`
   y tag del `checkpoint`.
3. **Un tronco por repo** (`master` iOS y backend, `main` BusinessBackend, WebApp y Windows, `aion` Android). Ramas cortas `ola<N>/<slug>`; CI verde para fusionar.
4. **Orchestron:** `orchestron_check_path` → `orchestron_claim_path` → heartbeat → `orchestron_release_path`. Ruta congelada o reservada = parada.
5. **Congelado, no se toca:** bundle IDs `com.skimzero.pulse*`, App Group, servicio de llavero `com.skimzero.pulse.v1`, iCloud, `_pulsemesh-v1`,
   `pulse-relay-v3`, collapse-id `pulse`, DO `PulseMailbox`, `Vendor/OpenMLS`, y los literales de `AION-iOS/docs/LITERALES-CONGELADOS.md`.
6. **Contratos:** todo cambio de cable o de formato persistido lleva vector dorado compartido (Swift/TS/Kotlin). Los cambios de cable solo entran en la ola 2 (v4).
7. **Puertas:** `/linea-base check` sin regresión no aceptada, `/auditor-zero` en protocolo/cripto/relay/persistencia, `/sincroniza` al cerrar.
8. **Routing:** Opus diseña y revisa; Sonnet implementa con brief y ruta reclamada; Codex revisa los P0. Máximo 2 relanzamientos.
9. **Relevo Claude ↔ Codex:** quién hace y quién revisa cada tarea está en `asignacion.json`; el estado, la asignación viva, el consumo y los traspasos viven solo en Orchestron. Al pasar del 85 % del límite de 5 h, del 90 % del semanal o del 85 % de contexto: cerrar el paso atómico, commit WIP, paquete `_relevo` en la fase y reasignar. Protocolo completo en `relevo/RELEVO.md`.
10. **Claude audita y corrige todo lo que haga Codex** antes de darlo por terminado o proponerlo para fusionar: misma estructura, convenciones y arquitectura que la propuesta de Claude. Si no cumple, Claude lo corrige o lo devuelve con instrucciones, y deja `_auditoriaClaude` en la fase de Orchestron. Codex revisa lo de Claude solo como segunda opinión.

11. **Propuestas de Codex (/adversario):** Codex puede proponer mejoras, registradas en Orchestron como «[Propuesta Codex]», pero **nunca las implementa**. Claude las aprueba o rechaza con motivo en la auditoría de esa tarea; solo las aprobadas entran al plan como tareas nuevas, con ID nuevo.
12. **Relevo · Cadena:** `relevo cadena --ola <N>` encadena tareas dentro de una ola, un agente a la vez, y para en la frontera de ola y en cualquier puerta humana. No arranca si el preflight de calidad (MCP, hooks, daemon de codebase-memory, línea base) falla. Nunca hace push, fusión, despliegue ni sello. Detalle en `relevo/RELEVO.md` §6.
