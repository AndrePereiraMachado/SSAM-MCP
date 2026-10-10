# ADR-006: Corpus e fixtures

Data: 2026-09-04. Estado: aceito (dono + agente).

## Decisao

Padrao 'certo' so de modulos feitos pela OutSystems (oficiais, templates, accelerators); modulos de cliente/terceiros so como estatistica e carga de robustez, nunca exemplo nem fixture; fixtures locais, fora do pacote. Ambientes de terceiros: so leitura (readOnly nas credenciais; export pela sessao do Studio).

## Contexto e evidencia

Leitor de corpus (scan) em 306 OMLs do personal: 306/306 load, Verify, round-trip.
