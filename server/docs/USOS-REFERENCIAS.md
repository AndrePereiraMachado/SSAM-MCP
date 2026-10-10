# Usos nativos e prova de reapontamento — 18/09/2026

Implementação compartilhada pelos kernels ODC/O11 e pelo leitor do builder ODC.

## Consulta

```powershell
.\odc inspect caminho.oml "Entity:Project" --usages --max 60
.\odc inspect caminho.oml "@chave-da-captura" --usages --scope direct --include-internal
.\ssam inspect --lane o11 --oml caminho.oml --path "Entity:Project" --usages
```

MCP `studio_inspect`: `usages: true`, `scope: "subtree" | "direct"`, `includeInternal: true | false`.
Job: `{"op":"usages","target":"...","scope":"subtree"}`. Sem `scope`, o verbo de job mantém
o contrato antigo, agora explicitamente marcado como direto.

`ssam-usages/1` identifica cada aresta por **consumidor e alvo efetivamente referenciado**.
O padrão `subtree` inclui alvos filhos: identificadores, atributos, parâmetros, eventos e demais
filhos percorríveis. `direct` examina somente o alvo selecionado. Usos dentro da subárvore são
excluídos por padrão e contados em `excludedInternal`; `includeInternal` inclui esses usos.
Referências derivadas não são removidas desta consulta.

`count` conta pares distintos consumidor/alvo, não ocorrências textuais nem propriedades
individuais dentro do mesmo consumidor; `consumers` conta consumidores distintos. `direct`, `descendant`,
`byTargetKind` e `byConsumerKind` descrevem a cobertura encontrada. `max`/`offset` paginam em
ordem de chaves; `returned`, `omitted`, `nextOffset` e `truncated` tornam o corte explícito.
Falha do índice gera `complete:false`, `referenceReadErrors` e amostras do erro.

## Escrita e prova

Uma FK pode apontar ao `IdentifierType` filho da entidade. Trocar a entidade pai não equivale
a trocar esse identificador. Foram corrigidos o setter de `DataType` para aceitar `@chave`/
`$alias` e a resolução de filhos materializados depois da criação do cache de lookup.

`replace` continua com escopo **direto, externo e não derivado**. Agora confere cada consumidor
original no destino e referências residuais na origem. Incompletude interrompe o job;
`rewired` conta consumidores conferidos, não chamadas ao método nativo.

Em jobs com `replace`, o runner captura conjuntos finais de referências após todos os ops,
salva, libera e recarrega o candidato. `refactorProof` compara existência dos alvos e chaves dos
consumidores. Divergência torna `accepted:false`. Exclusões e substituições posteriores no mesmo
job são consideradas na captura final. Jobs sem `replace` não ganham outra carga da OML.
Isto não prova equivalência de comportamento nem verifica o merge vivo.

## Evidência

Inventário de 33 OMLs autorizadas, 104.532.004 bytes. Cinco cópias selecionadas; os 33 hashes
originais permaneceram idênticos. Entradas e resultados privados estão em
`.local/usage-audit/20260918-c04c54b8`, ignorado pelo Git.

| Cópia | Objetos | Arestas nativas | Tipos de alvo | FKs conferidas pelo DataType |
|---|---:|---:|---:|---:|
| Autenticação IS | 1.171 | 739 | 37 | 0 |
| Cockpit | 39.368 | 31.407 | 90 | 3 |
| Sinal Core | 4.697 | 3.611 | 47 | 3 |
| SRT | 32.399 | 26.502 | 87 | 3 |
| Viver Bem | 66.174 | 54.116 | 76 | 0 |

Total: 143.809 objetos, 116.375 arestas, 108 tipos de alvo e 98 tipos de consumidor,
sem falha reportada pelo índice. Inclui Data Actions, SQL, JavaScript, REST, widgets, actions,
parâmetros, estruturas, entidades e identificadores. São tipos observados, não certificação
de todos os tipos possíveis. Nove amostras de FK conferidas pela propriedade `DataType`,
além da consulta reversa. As 19 consultas levaram 154,5 segundos, evidenciando o custo de recarga.

Nove testes compartilhados passaram em ODC e O11: paginação, identidade, erros explícitos,
FK invisível na consulta direta e visível pela subárvore; reapontamento de uma FK preservando
outra após save/reload; replace de action; prova pós-recarga; recusa de contrato incorreto.
No ODC também foi conferida a preservação do valor do argumento da chamada.
Os 106 testes Node da raiz/fachada/Portal passaram, sem skips, incluindo MCP real de usages.

Repetir: `dotnet test kernel/tests/Anvil.Tests.Odc --filter FullyQualifiedName~ModelReadingTests`
e o mesmo filtro em `kernel/tests/Anvil.Tests`, com `ANVIL_LANE=ss4`; `npm test` para Node.
Provas nativas em `kernel/.local/lane-odc/reading-tests` e `kernel/.local/reading-tests`.

## Limites

- Literais, URLs, buscas por nome em runtime e consumidores de outros módulos não são inferidos.
- A consulta não cria um mapeamento semântico automático entre filhos de dois elementos.
- A prova de replace cobre referências diretas selecionadas, não toda refatoração possível.
- Uma captura nova exige conferir novamente identidade e conteúdo.
- Leitura residente, seleção em lote e navegação foram implementadas e medidas depois desta prova:
  [LEITURA-RAPIDA.md](LEITURA-RAPIDA.md) e [FRICCAO-LEITURA-QUOTES.md](FRICCAO-LEITURA-QUOTES.md).
- A falha temporal anterior e os resultados das suítes gerais são registrados em
  `FECHAMENTO-REFERENCIAS.md`; os testes específicos acima não substituem essa regressão.
