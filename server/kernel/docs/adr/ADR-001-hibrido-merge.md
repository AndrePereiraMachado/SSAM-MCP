# ADR-001: Hibrido: headless escreve, Studio recebe por merge

Data: 2026-09-04. Estado: aceito (dono + agente).

## Decisao

O agente nunca muta o modulo aberto. Worker headless sobre OML (base = snapshot); resultado entra no Studio por CompareAndMerge de 3 vias como comando com undo; publish e humano (CI pode publicar direto).

## Contexto e evidencia

Provado em 2026-09-03: merge automatico 476-763 ms, TrueChange limpo, edicao local preservada, Ctrl+Z desfaz o conjunto; UPDATE tambem (relayout).
