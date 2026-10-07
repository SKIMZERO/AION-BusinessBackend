# AION-BusinessBackend · instrucciones para agentes

## Plan maestro AION

Cola única: `/Volumes/DevSSD/Developer/AION-Android/blueprints/aion-plan-maestro/tasks.json`. Trabaja solo la siguiente tarea lista (orden de array,
dependencias en `done`), lee únicamente su `epics/<epic>.md`, ejecuta todos sus `verify` y no edites rutas fuera de su `files`. Respeta Orchestron
(check → claim → release) y la lista de congelados de `AION-iOS/docs/LITERALES-CONGELADOS.md`. Un tronco por repo; CI verde para fusionar.
Ningún cambio de cable fuera de la ola 2. Sin secretos en repo, logs ni chat.
Todo lo que haga Codex lo audita Claude antes de cerrarse: debe seguir la estructura, las convenciones y la arquitectura de la propuesta de Claude (blueprint, épica, ADR); Claude puede corregirlo o devolverlo. Codex no cambia diseño decidido por Claude.
Codex puede ejecutar /adversario sobre su cambio y registrar propuestas «[Propuesta Codex]» en Orchestron; no las implementa ni las aprueba: decide Claude. En la cadena (`relevo cadena`), Codex trabaja solo la tarea que le asignan, deja la fase en «pendiente de auditoría» y no cierra su propio trabajo.
Cuando la carga pase a Codex (Claude sin cuota o tareas pendientes), Codex sigue obligatoriamente `/Volumes/DevSSD/Developer/AION-Android/blueprints/aion-plan-maestro/relevo/ESTANDARES.md` y el diseño de Claude: sin arquitectura, dependencias, contratos ni criptografía propios; las tareas de diseño solo como borrador para aprobación de Claude; las rutas congeladas en Orchestron no se tocan.
