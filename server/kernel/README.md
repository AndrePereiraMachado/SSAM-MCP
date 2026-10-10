# SSAM Hybrid (codinome dos assemblies: Anvil)

Nome do produto: SSAM Hybrid. Codinome interno dos assemblies e namespaces: Anvil. Compilador de intencao para OutSystems O11: uma spec entra, um modulo valido sai, e entra no Service Studio do
desenvolvedor por merge de 3 vias, como uma edicao com Ctrl+Z. Leia `MANIFESTO.md` primeiro.

## Estrutura

| Pasta | O que e |
|---|---|
| `src/Anvil.Core/Kernel` | so Model API V1 + tipos puros: ModelBuilder, FlowLayout, credenciais, leitor de corpus (catalogo e verbos genericos entram aqui) |
| `src/Anvil.Core/Adapters.SS11` | o que toca internals do build 11.55.69: prologo do runtime, presenter mock, load/save, merge, Service Center |
| `src/Anvil.Core/Recipes` | specs em C# usadas como testes de aceitacao (Temporada, VacationRental); nao sao o produto |
| `src/Anvil.Bridge` | o unico codigo dentro do Studio: TCP JSON-lines, ping, snapshot, merge, export, leituras |
| `src/Anvil.Cli` | worker/CLI: inventario, download, inspect, scan, demo-*, relayout, merge de apoio |
| `tools/Anvil.Inject` | injetor de IL (Mono.Cecil) para ligar o bridge ao Studio |
| `tests/Anvil.Tests` | testes offline (xunit) |
| `scripts/` | launcher do SS4 (`open_ss4.ps1`) e roteiros de prova |
| `docs/` | arquitetura, ADRs, specs, mapa de capacidades |

## Para um agente (LLM) sem contexto

Comece por `AGENTS.md`: os 17 verbos, o formato de job JSON, o cliente do bridge e as tres medidas que mandam
(qualidade, velocidade, precisao). Tudo que o produto expoe e autoexplicativo: catalogo gerado, erros que dizem o
que fazer, esquemas por tipo. Se algo so funciona com contexto de conversa, e bug.

## Regras de ouro

Nenhum binario da OutSystems neste repo nem no pacote. Nenhum decompilado aqui. Credenciais so em `.local/`
(ignorado). Toda capacidade: ler a API, escrever, teste com Verify zero, prova viva no lab, linha no mapa.

## Build

```
dotnet build Anvil.sln -c Release
dotnet test tests/Anvil.Tests -c Release
```

`SSDir` aponta para a copia do Studio usada no desenvolvimento (SS4, porta 4516, CDP 9226).
