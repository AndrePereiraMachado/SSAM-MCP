# ADR-002: Sala limpa em relacao ao SSAM

Data: 2026-09-04. Estado: aceito (dono + agente).

## Decisao

Do SSAM nao vem codigo: vem cenarios (testes de aceitacao), friccoes (requisitos) e formatos de spec (candidatos, reescritos). Fica para tras: SSModelHandler, ModelMirror, BatchModify, clipboard, taxonomia de leitura.

## Contexto e evidencia

Codigo por reflexao sobre internals com remendos acumulados foi a causa do custo por escrita (543 ms) e das quedas; toda funcao nova comeca lendo a API e termina com teste julgado pelo Verify.
