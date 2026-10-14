# AION-BusinessBackend · instrucciones para agentes

## Plan maestro AION

Cola única: `/Volumes/DevSSD/Developer/AION-Android/blueprints/aion-plan-maestro/tasks.json`. Trabaja solo la siguiente tarea lista (orden de array,
dependencias en `done`), lee únicamente su `epics/<epic>.md`, ejecuta todos sus `verify` y no edites rutas fuera de su `files`. Respeta Orchestron
(check → claim → release) y la lista de congelados de `AION-iOS/docs/LITERALES-CONGELADOS.md`. Un tronco por repo; CI verde para fusionar.
Ningún cambio de cable fuera de la ola 2. Sin secretos en repo, logs ni chat.
Desde el 2026-10-12 el plan se desarrolla sin Codex: lo ejecuta Claude (Sonnet con brief) y lo revisa Opus; en P0 (`revisionIndependiente: true`), revisión con contexto limpio y `/auditor-zero` antes de fusionar. `relevo/` está archivado.
Beta estable = iOS + Mac + Android; las tareas `postBeta: true` (web y Windows) esperan a E5-T2. Única excepción a «cable solo en la ola 2»: E1-T16.
