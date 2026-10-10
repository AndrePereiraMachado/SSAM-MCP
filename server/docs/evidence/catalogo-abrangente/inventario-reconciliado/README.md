# Inventário reconciliado com os runtimes instalados (M1, 23/09/2026)

Denominador do catálogo abrangente a partir deste commit (`catalog/ownership.json` → `inventory`). O inventário da
fase 1 (`docs/evidence/descoberta-cobertura-fase1/`) permanece como evidência histórica, sem alteração.

## Fontes nativas regeneradas (fila nativa INT-M1-001, integrador)

| Faixa | Antes (fixado em M0) | Agora | Como | Onde |
|---|---|---|---|---|
| ODC | índice de reflexão 1.7.24.10718 (`platforms/odc/docs/model-api`) | ODC Studio 1.7.25.10778 instalado | `SSAM_HYBRID_ODC_ROOT=<scratch>` + `dotnet run --project platforms/odc/studio/apiindex -c Release` (7 s) | `native/odc-1.7.25.10778/` (JSON + INDEX.md) |
| O11 | catálogo 11.55.69 (`kernel/catalog/model-api-11.55.69.json`) | Service Studio 11.55.87.65162 (Anvil 4516) | `dotnet kernel/.local/cli/anvil.dll catalog --out <scratch>/model-api-11.55.87.json` (1 s) | `native/o11-11.55.87/` |

Nenhum arquivo lido em runtime foi alterado: `platforms/odc/docs/model-api` (descoberta `native:`/`--type`) e
`kernel/catalog` (o kernel O11 carrega o `model-api-*.json` mais recente) continuam como estavam. Promover o índice ODC
1.7.25 para `platforms/odc/docs/model-api` é uma decisão separada (muda respostas A da descoberta; T1).

## Resultado

- O11: o catálogo extraído de 11.55.87 é **idêntico** ao de 11.55.69 em `Assembly`, `AssemblyVersion`, `StudioDir`,
  `Interfaces`, `Enums`, `Creatables` e `Summary` (só `GeneratedAt` difere). Inventário O11: 408 tipos, sem mudança.
- ODC: só `OutSystems.Model.V1` mudou (1228 → 1247 tipos exportados: +23 com descritores, −4, 14 alterados); os
  plugins NRWidgets, Widgets, REST, RESTService, SOAP e ModelAPILoader são idênticos. Inventário ODC: 556 → **564** tipos
  (concreto 278 / base 41 / assinatura 186 / indeterminado 59).
- Diferença por chave estável (`reconciliation.json`): +10 tipos (`ISpecialListEntry`[+Signature], `ICommentWidget`,
  `IImageWidget`[+Signature], `IListBoxWidget`[+Signature] → B; `IKnowledgeBaseReference`, `IToolReferenceAction`,
  `ICallAgentManifestNode` → C), −2 (`ICallableAgent`, `ICallableAgentSignature`, eram de C), 5 alterados só em
  propriedades graváveis/fábricas (`IExtendedProperty`, `IAgent`, `IAgentManifest`, `IMCPToolReference` → C;
  `IComboBoxWidget` → B). Nenhuma mudança de família, classe ou dono em tipo existente.

Denominadores por frente: ODC A 160 / B 227 / C 177; O11 A 114 / B 197 / C 97 (+35 ferramentas, C).

Interfaces fora das raízes de objeto (pedido C-007, `inventory.json` → `typesOutsideRoot`): a regra da fase 1 as excluía
de qualquer denominador. Não são elementos do modelo (aplicações e módulos referenciados, extensões, bibliotecas
externas, merge, plugins de modelo, metamodelo, nós de expressão), mas fazem parte da API que uma tarefa encontra.
Entram na contabilidade como classe própria `outside-object-root`, em bloco separado (`accounting[].outsideRoot`),
nunca somadas aos elementos: ODC 161 (A 45 / B 1 / C 115), O11 62 (A 18 / C 44). Regra de dono:
`catalog.mjs::ownerOfOutsideRoot` (expressões, sequência/objeto de modelo e ajudantes de lógica → A; UI → B; o resto → C).

## Arquivos

- `inventory.json`, `counts.json`, `matrix.csv`, `inventario.md`: saída de
  `node platforms/odc/facade/coverage-inventory.mjs --out <scratch> --census-from docs/evidence/descoberta-cobertura-fase1/inventory.json --odc-model-api docs/evidence/catalogo-abrangente/inventario-reconciliado/native/odc-1.7.25.10778 --o11-catalog docs/evidence/catalogo-abrangente/inventario-reconciliado/native/o11-11.55.87/model-api-11.55.87.json`
  (`inventario.md` é o README gerado pela ferramenta; o título dela ainda diz "fase 1"; `matrix.json` não foi
  versionado: é a mesma matriz do CSV, regenerável pelo comando).
- O censo do leitor foi reutilizado do inventário da fase 1 (mesma fixture, sha256 igual); tipos novos não têm censo
  (não observados, não inferidos).
- `reconciliation.json`: diferença por chave, com família, classe e dono.
