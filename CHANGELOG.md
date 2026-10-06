# Cambios

Versionado semántico. Mientras sea `0.x`, el contrato HTTP puede cambiar entre
versiones menores; cada cambio de contrato se anota aquí y en el README.

## 0.1.0 — 2026-10-06

Primera versión, separada de `apps/business` de AION-Backend.

- Alta en borrador → partes selladas → enviar. Lo incompleto no llega a la
  cola; un borrador no enviado se borra al día.
- CURP y RFC de persona física solo como índice HMAC; el RFC de una persona
  moral, que es público, en claro. Expediente, fotos y documentos sellados en
  el teléfono con la clave de revisión.
- Reglas de forma portadas de PulseCore: nombre comercial, alias, reservadas,
  RFC y CURP con dígito verificador, ubicación pública según la presencia.
- Un alias y un RFC por negocio vivo; tope de 3 negocios vivos por persona;
  veto por fraude con dos operadores; lista 69-B por índice; aviso de nombre
  parecido a un verificado.
- Revisión con doble operador para aprobar, reactivar y revocar; registro de
  aperturas del expediente sin IP, visible para el negocio.
- Purga a 30 días de decidir, salvo apelación.
- 34 pruebas (28 del servicio, 6 del vector de alias compartido).
