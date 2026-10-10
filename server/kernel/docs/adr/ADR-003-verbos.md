# ADR-003: 17 verbos, catalogo grande

Data: 2026-09-04. Estado: aceito (dono + agente).

## Decisao

Escrita: Create(args), Set, Link, Move, Duplicate, Delete. Leitura: Get, Find, Messages, Usages, Diff. Modulo: Reference, Verify, Load, Save, Snapshot, Merge. Adaptadores so para o que so o Studio faz. Nenhum verbo por tipo de elemento; o catalogo (gerado do DLL por build) decide o que e valido.

## Contexto e evidencia

Ver docs/architecture/2026-09-04-modelo-de-verbos.md.
