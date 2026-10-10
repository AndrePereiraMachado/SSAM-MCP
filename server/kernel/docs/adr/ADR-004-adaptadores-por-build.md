# ADR-004: Adaptadores por build do Studio

Data: 2026-09-04. Estado: aceito (dono + agente).

## Decisao

Tudo que toca internals (prologo, presenter mock, merge, load do presenter, Service Center) vive em Adapters.<build> com bateria de provas no lab; o Kernel usa so o Model API V1. Build novo = adaptador novo + leitor no corpus.

## Contexto e evidencia

11.55.69 e o build de referencia (decompilado e SS3/SS4); 11.55.73 e o do ss1.
