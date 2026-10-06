# AION Business Backend (`pulse-business-api`)

Alta y revisión de negocios de AION, y su directorio público. Fase **B2** de
`docs/NEGOCIOS-DISENO.md` (§13) de AION-iOS.

Vivía en `apps/business` de AION-Backend; se separó a este repositorio el
2026-10-06 para que no comparta ni código desplegado, ni dependencias, ni
secretos con el relay y la recuperación.

## Lo que este servicio no ve nunca en claro

| Dato | Qué llega aquí |
|---|---|
| CURP del responsable | Su índice: `HMAC(BUSINESS_INDEX_PEPPER, "curp:" + CURP)`. La CURP se descarta al calcularlo |
| RFC de persona física | Su índice. El RFC de una **persona moral** sí se guarda: es público |
| Expediente, fotos, documentos | Bytes que el teléfono selló con la clave pública de revisión. La clave privada no está aquí |
| Credencial y rostro | Nada: van del teléfono al proveedor de identidad |
| IP | Un contador por hora en `limites`, que se purga |

## Contrato HTTP (v1)

El negocio, con `Authorization: Bearer <ownerToken>` (32 bytes que solo tiene su teléfono):

| Ruta | Qué hace |
|---|---|
| `POST /v1/applications` | Crea el alta en `borrador`: datos públicos, CURP y RFC (para el índice), `expediente` y `evidencia` sellados. Idempotente por `applicationID` |
| `PUT /v1/applications/{id}/attachments/{parte}` | Sube una parte sellada (`fachada`, `interior`, `productos`, `comprobante`, `permiso`, `efirma`), hasta 8 MiB |
| `POST /v1/applications/{id}/submit` | Pasa a `enviada` si no falta nada; si falta, `422` con la lista |
| `GET /v1/applications/{id}` | Estado, lo que falta, el motivo de la revisión y el perfil público tal como se verá |
| `GET /v1/applications/{id}/access-log` | Qué operador abrió qué parte y cuándo |
| `POST /v1/applications/{id}/appeal` | Apela un rechazo dentro de 30 días; detiene la purga |

Con otro token, un alta responde igual que una que no existe (`404`).

Cualquiera: `POST /v1/directory/search {"query"}`, solo negocios aprobados y solo lo público.

Operadores, con su token personal (`OPERATOR_TOKENS`):

| Ruta | Qué hace |
|---|---|
| `GET /review/queue` | Altas `enviada` y `en_revision`, con avisos automáticos y votos pendientes |
| `POST /review/{id}/take` | `enviada → en_revision` |
| `GET /review/{id}/parts/{parte}` | Devuelve la parte sellada y lo anota en `dossier_access` |
| `POST /review/{id}/decide` | `request_changes`, `reject`, `suspend` (uno); `approve`, `reactivate`, `revoke` (dos operadores distintos). `revoke` con `fraud: true` de los dos veta a la persona |
| `POST /review/sat-69b` | Carga RFC de la lista 69-B del SAT (por índice) |

## Reglas que aplica

- Las mismas de forma que el teléfono (`src/rules.ts`, portadas de `Sources/PulseCore/Business/`; el esqueleto y las reservadas del alias de persona, en `src/alias.ts`, copia de AION-Backend con su vector): nombre comercial, alias, RFC con dígito verificador, CURP, categoría de lista cerrada, ubicación pública según la presencia.
- Alias reservado: solo persona moral, y marcado para revisión.
- Un alias y un RFC por negocio vivo; como mucho 3 negocios vivos por persona (N11).
- Persona vetada por fraude o RFC en la 69-B: no entra.
- Nombre parecido a un verificado: aviso a la revisión, sin decirle al solicitante a cuál.
- Purga: lo que solo servía para decidir, a los 30 días de decidir; de un alta rechazada o revocada, toda la bóveda; un borrador no enviado, al día. Corre en el cron y al abrir la cola.

## Pendiente

- Publicar las fotos públicas de un local en el perfil (B4).
- Verificar la e.firma (B3) y el resultado del proveedor de identidad por su propio canal, no por lo que diga el teléfono.
- Cambiar los datos públicos al responder a «requiere cambios».
- El catálogo de SEPOMEX para cruzar el código postal.

## Puesta en marcha

```bash
git clone https://github.com/SKIMZERO/AION-BusinessBackend.git /Volumes/DevSSD/Developer/AION-BusinessBackend
cd /Volumes/DevSSD/Developer/AION-BusinessBackend
pnpm install
pnpm run typecheck && pnpm test

wrangler d1 create pulse-business-development   # y pon el id en wrangler.toml
wrangler r2 bucket create pulse-business-vault-development
wrangler secret put BUSINESS_INDEX_PEPPER --env development
wrangler secret put OPERATOR_TOKENS --env development
pnpm run migrate:development
```
