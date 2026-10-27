# Aquisição de dependências ODC por assinatura pública

Estado histórico da aquisição inicial abaixo. Em 22/10/2026 o leitor da assinatura pública passou a incluir
Service Actions (`ReferenceServiceAPIMethod`); a captura usa o mesmo leitor compilado na bridge ODC, então só uma
bridge construída a partir desta mudança as exporta. Essa mudança não publica nem faz merge no aplicativo vivo.

## Problema e caminho público

Um bloco ausente não exige abrir o produtor como OML editável nem pedir ao usuário que marque elementos
em Manage Dependencies. Módulos de sistema recusam a abertura editável pela Model API. O bridge obtém
a assinatura pública pelo serviço nativo de referências da sessão do consumidor; o kernel importa os
elementos no candidato descartável usando AddDependency. O modelo aberto só muda pelo merge existente.

1. Para descobrir os elementos disponíveis, use `studio_reference_snapshot` no MCP com `module`,
   `producer` (nome ou chave) e `output` (arquivo `.avsig` novo). A resposta lista kind, nome e chave.
   Na CLI: `odc studio reference-snapshot '<JSON com module, producer, output>'`.
2. Coloque as operações `reference` antes das edições no job. A entrada `studio_deliver` / `odc deliver --job`
   captura automaticamente os produtores nomeados das operações do job raiz, uma vez por produtor.
3. O mesmo fluxo executa build, Verify, manifesto e preview/merge. `--until preview` não faz merge.
   Publicação continua separada e autorizada.

Exemplo de seleção, **condicionado aos nomes realmente devolvidos pela captura**:

```json
{
  "ops": [
    {
      "op": "reference",
      "producer": "OutSystemsUI",
      "elements": [
        "IMobileBlock:DropdownSearch",
        "IStructure:DropdownOption",
        "IStructure:DropdownOptionalConfigs"
      ]
    }
  ]
}
```

Após essa operação, o restante do job pode usar o bloco e os tipos pelo resolver existente.
O formato `.avsig` v2 inclui ambiente, identidade do produtor, assinatura binária pública e identidade
da revisão. Não contém senha/token nem código protegido. O manifesto da entrega conserva o hash do arquivo.
O formato v1 de extensões O11 permanece separado; este trabalho não implementa a aquisição de bibliotecas O11.
Na integração com o produto O11 (K1 Manage Dependencies) a versão 2 passou a ser compartilhada: a captura O11
atestada (`anvil signature`) é v2 com `Attestation`; a assinatura pública ODC é a única forma v2 sem atestação
(eSpace, `NativeReferenceSnapshot.IsOdcPublicSignature`, bloco com kind `block`). Só o adaptador ODC importa
essa forma, e o importador O11 (`ReferenceRefresher.ImportSnapshot`) a recusa.

## Guardas e limites

- Produtor ausente, ambíguo, sem assinatura publicada ou elemento não declarado: recusa antes de construir.
- Ambiente divergente, consumidor alterado durante captura ou hash do arquivo divergente: entrega interrompida.
- Mesmo nome com outra identidade ou revisão diferente da referência existente: recusa; atualizar explicitamente
  a referência existente e capturar novamente. `refresh-references` não substitui aquisição de elementos ausentes.
- Seleção validada contra o conteúdo nativo da assinatura, além do envelope; importação repetida não duplica objetos.
- O método nativo não recebe SignatureHash em SignatureInformation. Depois de importar e conferir os elementos,
  o adaptador conserva no ReferenceHash a identidade recebida do servidor, dentro da mesma transação descartável.
- Parser de assinatura pública contempla blocos, structures, client/server/service actions e entities.
  Service Actions usam `ReferenceServiceAPIMethod` / `service-action`, selecionáveis por `ServiceAction`,
  `IServiceAction` ou `IServiceActionSignature`; não são convertidas em Server Actions.
  External Libraries continuam limitadas a server actions e structures. A prova inicial cobre bloco,
  structure transitiva e client action; a de 22/10 (`OdcServiceActionReferenceTests`) cobre importação e chamada
  de Service Action com estrutura de entrada/saída, recarga, repetição sem duplicação e rejeição de
  identidade/revisão adulteradas.
- Aquisição automática limitada a produtores nomeados nas ops do job raiz; jobs compostos e fontes `job:`
  continuam com sua resolução anterior. O CLI do kernel também aceita `--producer Nome=<arquivo.avsig>`.
- Dependências que exigirem assinaturas adicionais de outros produtores não têm captura recursiva implementada.
  Importe primeiro as assinaturas dos donos dos tipos no mesmo candidato: o callback nativo reutiliza esses
  bytes ao importar a action dependente, com guard de ambiente e revisão. A captura recursiva na rede
  continua não implementada. Se faltar uma assinatura e o importador recusar, preserve a recusa;
  não invente objetos nem silencie o Verify.
- O tradutor HTML/CSS/JS e o fluxo controlado de spec não ganharam aquisição automática nesta mudança.
- Bridge e cliente novos: `v31` (a prova candidata de 25/09 rodou com o nome `v31Dependencies`; na integração
  o protocolo virou `v31` porque o attach e o runtime assinado exigem versões `v<número>`), sem substituir DLL
  carregada. MCP antigo não passa a expor a ferramenta sozinho. Ativação deve promover
  kernel/bridge/cliente/fachada compatíveis em conjunto; o runtime assinado precisa ser preparado de novo.

## Verificação e liberação

Teste focal `OdcDependencyTests` cria produtor e consumidor locais, encerra o produtor, captura e importa
bloco/tipo/action, prova aquisição incremental e repetição, rejeita identidade falsa/revisão divergente,
executa um job que instancia o bloco e valida o candidato salvo/recarregado. A identidade de publicação
da biblioteca sintética é exclusivamente de teste; nenhuma publicação no servidor foi feita.

`NativeReferenceSnapshotTests` verifica retrocompatibilidade O11 do envelope. `kernel-delivery.test.mjs`
verifica orquestração, deduplicação, ambiente, hash e recusas antes do build/merge, com bridge simulado.
Evidência local: `.local/dependency-probe/` no checkout desta correção.

Antes de liberação operacional: capturar OutSystemsUI pela sessão autenticada de um consumidor de laboratório,
selecionar DropdownSearch e tipos publicados, gerar candidato, conferir Verify/save/reload, fazer preview e
merge nativo com equivalência e recibo. Confirmar que o produtor não foi aberto como módulo editável e que
nenhuma mudança chegou ao consumidor antes do merge. Essa prova não foi substituída pelos testes sintéticos.
Não alterar o congelamento da avaliação do catálogo para incorporar esta correção.
