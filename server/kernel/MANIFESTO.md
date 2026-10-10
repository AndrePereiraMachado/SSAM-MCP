# Manifesto do SSAM Hybrid (2026-09-04)

Curto de proposito. Se um dia isto nao couber numa tela, algo saiu do foco.

## O que estamos construindo

Um compilador de intencao para OutSystems: uma spec entra, um modulo valido sai, e entra no Studio do
desenvolvedor como uma edicao que ele revisa e desfaz com Ctrl+Z. O agente escreve numa copia; o humano
recebe por merge; publicar e decisao humana.

## A LLM cria; o Hybrid assume a complexidade da plataforma

A autoria deve favorecer o que as LLMs fazem bem: escrever high code claro, compor componentes e testar regras.
HTML/CSS e linguagens com ferramentas maduras devem ser fontes naturais; formatos internos, identidades,
ligacoes, convencoes e recuperacao pertencem ao compilador. Liberdade de expressao com significado preservado:
o Hybrid traduz para elementos nativos, mostra limites na fonte e prova o resultado. Nao exige que a LLM simule
cliques nem escreva manualmente o grafo que o compilador pode derivar. Sem uma pilha de remendos por caso.

## Principios inegociaveis

1. **Headless escreve, o Studio recebe por merge.** Nunca mutar o modulo que o humano tem aberto. Snapshot,
   worker, merge de 3 vias. Publish direto so em CI, sem humano.
2. **Modelo valido e comportamento correto.** A API e o Verify provam a estrutura nativa; testes executados
   provam regras e interacoes. Preview, Verify e teste unitario isolado nao substituem a prova no destino.
3. **Um nucleo, varias formas de autoria.** Frontends high code convergem em contratos tipados e nos mesmos
   mecanismos de modelo, prova e entrega. O catalogo cresce; nao criamos um caminho operacional por linguagem.
4. **Convencao e regra com teste, nao receita.** O que a API nao diz (Id, FK, user provider, layout) vira
   gancho por tipo com teste. Receitas existem so como teste de aceitacao.
5. **Sala limpa em relacao ao SSAM.** Do SSAM vem prova (cenarios, friccoes, formatos), nunca codigo.
6. **Nada da OutSystems sai daqui.** Nenhum binario deles no pacote; decompilado fora do repo do produto;
   codigo referencia so nomes e a API publica. Credencial e token nunca em log, nunca em disco fora do dono.
7. **Modulo de cliente nunca vira exemplo.** Fixtures so de modulos oficiais da OutSystems, locais, fora do pacote.
8. **Um no por celula, nada na diagonal.** O que sai do compilador tem de parecer feito a mao por alguem bom.
9. **Pronto tem uma definicao so:** teste offline verde (cria, Verify zero, salva, recarrega igual), prova viva
   no lab (merge e publish), e a linha do mapa de capacidades gerada. Sem os tres, nao esta pronto.
10. **Documentar e parte de fazer.** ADR por decisao; o mapa de capacidades e gerado dos testes, nao escrito.

11. **Comercializavel e incorporavel pela OutSystems.** Dependencias, ativos e codigo precisam de origem e
   direitos compativeis com incorporacao, distribuicao e venda do produto. Avaliar versoes e transitivas;
   nenhuma dependencia nova de produto sem essa analise. Carregar DLLs locais nao concede direitos adicionais.
   Preferir integracao oficial; preservar a instalacao do Studio sempre que houver mecanismo comprovado.

## As tres medidas

Toda decisao e julgada por qualidade (o modulo nasce valido e bem feito), velocidade (segundos, nao minutos) e
precisao (o que a spec pede e exatamente o que sai). Se uma mudanca melhora uma e piora outra sem o dono decidir,
nao entra.

## Qualquer LLM, sem contexto

O produto tem de ser usavel por um agente que nunca viu esta conversa: um AGENTS.md na raiz, verbos poucos e
documentados, catalogo e esquemas gerados, erros que ensinam a correcao. Conhecimento que so existe na cabeca de
alguem ou num transcript e divida. A aceitacao inclui uso cego pela entrada publica, medindo intervencoes,
retrabalho, contexto exigido, chamadas, tokens e tempo; testes semanticos isolados nao substituem essa prova.
Protocolo: [aceitacao de autoria high code](docs/architecture/2026-09-07-high-code-friction-acceptance.md).

## O que nao somos

Nao somos um wrapper do Studio por reflexao. Nao somos uma colecao de scripts. Nao somos um SaaS que le o
OML do cliente na nossa nuvem. Nao substituimos o Studio: o humano continua vendo, revisando e publicando nele.
