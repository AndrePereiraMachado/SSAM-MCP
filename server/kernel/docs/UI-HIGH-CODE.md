# Autoria de componentes nativos com HTML, CSS e JavaScript

O arquivo `.html` é a fonte. O Hybrid compila seus componentes para o contrato de módulo existente,
reconcilia o modelo nativo e verifica esse modelo independentemente das operações geradas. A LLM não
escreve um segundo manifesto de bindings nem escolhe uma sequência de operações de recuperação.

Este documento descreve o recorte implementado, não suporte arbitrário a qualquer aplicação JavaScript.
O caso executável está em `tests/html/components/gallery.html`; a prova de navegador em
`tests/browser/native-components.cjs`. O Dashboard legado continua usando o frontend `html` anterior.

## Fonte

```html
<component name="Counter" kind="block">
  <script type="module">
    export const inputs = { title: "string" };
    export const events = { changed: { value: "integer" } };
    export let count = 0;
    export function increment() {
      count += 1;
      emit.changed({ value: count });
    }
  </script>
  <style>
    :root { display:block; }
    article { padding:24px; border:1px solid #ddd; border-radius:16px; }
  </style>
  <article>
    <h2>{{ title }}</h2>
    <p>{{ count }}</p>
    <button id="Increment" onclick="increment()">Incrementar</button>
    <slot name="Footer"></slot>
  </article>
</component>

<component name="Overview" kind="screen" roles="Registered">
  <script type="module">
    export let last = 0;
    export function receive(value) { last = value; }
  </script>
  <Counter id="First" title="Suporte" @changed="receive">
    <span slot="Footer">Conteúdo desta tela</span>
  </Counter>
  <p>Último valor: {{ last }}</p>
</component>
```

Todos os componentes do arquivo são conhecidos antes de compilar os consumidores. A ordem textual pode
ser invertida. Ciclos de composição são recusados. Um componente `block` cria um `IMobileBlock` público;
seu uso cria uma instância que referencia esse mesmo bloco. O HTML do bloco não é copiado para as telas.
Telas usam `Layouts/LayoutBlank`; conteúdo e estilos pertencem à fonte.

## Imports de arquivos HTML

Componentes podem importar outros arquivos usando JavaScript de módulo:

```html
<component name="Overview" kind="screen">
  <script type="module">
    import Card from './card.html';
    import { Panel as Summary } from './panel.html';
  </script>
  <Card title="Incidentes"></Card>
  <Summary></Summary>
</component>
```

Cada componente do arquivo exporta seu `name`. O import default exige exatamente um block no arquivo
importado; o import nomeado seleciona esse nome. Imports pertencem ao script do componente que os declara.
Aliases seguem a grafia JavaScript: um `<Button>` importado não substitui o `<button>` HTML.
Dois aliases do mesmo export apontam para a mesma definição nativa. Imports transitivos são resolvidos
uma vez; telas não selecionadas em arquivos importados não são acrescentadas ao módulo.

No fluxo controlado, também é possível enviar a fonte como um bundle:

```json
{
  "uiSource": {
    "entry": "main.html",
    "files": {
      "main.html": "... fonte HTML da tela ...",
      "card.html": "... fonte HTML do block ...",
      "panel.html": "... fonte HTML do painel ..."
    }
  }
}
```

`files` contém os arquivos autorados, não bindings ou operações internas. O controlador congela todos
os conteúdos no mesmo contrato e não lê arquivos externos para completar esse bundle. Na entrada CLI,
`--spec main.html` descobre os imports relativos; dentro do repositório, os caminhos são relativos à raiz
dele, e fora dele a raiz é a pasta do arquivo de entrada. Imports não podem escapar dessa raiz.

O nome nativo dos componentes da entrada é preservado. Definições importadas recebem um sufixo estável
derivado do caminho relativo, distinguindo exports com o mesmo nome em arquivos diferentes. Aliases e
edições de conteúdo não mudam essa identidade; mover o arquivo ou mudar qual arquivo é a entrada exige
tratar a migração de identidade. Não representa um rename automático de um block público existente.

Arquivos ausentes, exports inválidos, aliases duplicados e ciclos de imports são diagnosticados antes
de carregar o runtime. Imports de `.js` e namespaces (`import * as`) ainda não fazem
parte desta etapa. O exemplo executável está em `tests/html/components/imports/main.html`.

## Imports de blocks de módulos OutSystems

```html
<component name="Overview" kind="screen">
  <script type="module">
    import { Card as Summary } from 'outsystems:OutSystemsUI/Content';
    import AnotherCard from 'outsystems:OutSystemsUI/Content/Card';
  </script>
  <Summary><h2>Resumo</h2></Summary>
  <AnotherCard><p>Outra instância do mesmo block.</p></AnotherCard>
</component>
```

O import nomeado identifica módulo e flow; o default inclui também o nome do block. O compilador lê a
assinatura da referência registrada no snapshot de destino. Cria somente instâncias, preservando os
inputs/defaults, eventos obrigatórios/opcionais e slots do produtor. Não copia o HTML nem recria o block.
O caminho é resolvido segmento a segmento, com unicidade; um homônimo de outro produtor não é escolhido.
Flow e block usam `OriginalName` da assinatura pública quando o Studio lhes atribui um alias no consumidor:
por exemplo, o código continua importando `MainFlow` mesmo quando a referência local aparece como `MainFlow2`.

O bundle continua contendo somente código autorado. Sem snapshot, a validação confere parsing, imports
e declarações JavaScript; a ligação e a validação completa dos usos ocorrem antes da mutação headless,
quando a assinatura real está disponível. O recibo registra chave global do block, chave/hash da
referência e assinatura. A prova posterior ao merge e a retomada comparam essas identidades congeladas.

Neste recorte, a dependência precisa estar registrada no módulo. A aquisição automática de dependências
ausentes ainda falta; o erro identifica o produtor e nenhuma instância é emitida com assinatura inventada.
Imports de actions e tipos também não estão implementados. Inputs/eventos transportados por JavaScript
cobrem Text, Integer, Decimal e Boolean. Um Long Integer literal vai diretamente para uma expressão
nativa, sem passar por JS Number. Inputs opcionais de outros tipos podem manter o default do produtor;
fornecê-los ou usar eventos com payloads desses tipos exige os codecs ainda pendentes.

O exemplo `tests/html/components/native-imports.html` importa Card e Pagination do OutSystems UI.
Ele prova o controle, seus parâmetros e o callback; não contém uma consulta paginada nem comprova a
paginação de dados do Dashboard. O consumidor `native-consumer.html` usa o CounterCard público do lab.

## Semântica

| Fonte | Modelo e comportamento |
|---|---|
| `export const inputs` | Parâmetros nativos tipados. `{type:"string", default:"..."}` é opcional; sem default é obrigatório. |
| `export let` com literal | Estado local de cada instância. Tipos iniciais: texto, booleano e número finito. |
| `export const` com literal | Valor capturado como `const` no JavaScript; não pode ser alvo de um controle editável. |
| `{{ expression }}` | Função cliente nativa com JavaScript e somente as capturas utilizadas. Helpers locais chamados pela expressão são incluídos. |
| `onclick="functionName()"` | Screen action nativa contendo o handler JavaScript. |
| `export const events` / `emit.changed(payload)` | Evento nativo tipado. Payloads são validados e copiados na emissão. |
| `@changed="receive"` | Handler nativo no consumidor; parâmetros seguem a ordem declarada no evento. |
| `:title="expression"` | Argumento dinâmico de bloco; `title="literal"` é estático. |
| `<slot name="Footer">` / `slot="Footer"` | Placeholder nativo e conteúdo fornecido pelo consumidor, inclusive através de blocos aninhados. |
| `if="condition"` | If widget nativo: monta/desmonta o ramo e executa seu ciclo de vida. |
| `<input bind:value="title">` | Input nativo com estado, tipo, obrigatoriedade, prompt e comprimento. |
| `<textarea bind:value="details">` | TextArea nativa; `rows` e `maxlength` são propriedades nativas. |
| `<input type="checkbox" bind:checked="enabled">` | Checkbox nativa com estado booleano. |
| `<label for="Title">` | Label nativa ligada à identidade do controle. |
| `:disabled="expression"` | Propriedade `Enabled` nativa derivada da expressão. |

Aliases de tipos: `string`, `boolean`, `integer`, `number`, `datetime`. Os nomes nativos também são aceitos;
isso não significa que todo tipo composto já tenha conversão JavaScript implementada.

Handlers são síncronos. Ao terminar seu JavaScript, o Hybrid grava o estado e despacha a fila de eventos
nativos na ordem emitida, incluindo emissões repetidas. Portanto `emit` não executa o código do pai no meio
do corpo JavaScript. `async`, generators e aliases de emissores não têm essa semântica e são recusados.
O parser não executa o script durante a compilação. Expressões de renderização devem ser puras; não são
um lugar para efeitos de rede, mudança de estado ou emissão de eventos.

`onInitialize`, `onReady`, `onRender`, `onDestroy` e `onParametersChanged` são ligados ao ciclo de vida
nativo quando declarados como funções. Alterar um input preserva o estado da instância; desmontar e
remontar um bloco cria outra instância. Timers/listeners externos ainda exigem gestão explícita pelo autor;
não existe um runtime geral de effects com cleanup automático.

## Objetos e arrays como estado local

Objetos e arrays literais em `export let`/`export const` inferem estruturas e listas nativas, inclusive
aninhadas. O autor trabalha com valores JavaScript comuns:

```html
<script type="module">
  export let filter = { text: '', active: true };
  export let rows = [{ id: '9223372036854775807', title: 'Primeiro', tags: ['novo'] }];
  export function rename() {
    rows = rows.map(row => ({ ...row, title: row.title.toUpperCase() }));
  }
  export function clear() { rows = []; }
</script>
```

O compilador deduplica tipos pela forma dos valores e inicializa o estado antes do `onInitialize`
autorado. Serialização/desserialização nativas transportam esses valores entre o modelo e o nó JS;
arrays de primitivos recebem estruturas de transporte geradas pelo Hybrid. Esses detalhes não fazem
parte da fonte escrita pela LLM. Cada instância de block possui seu estado próprio.
O transporte é por valor: identidade de objetos JavaScript e aliases compartilhados entre variáveis
não são preservados entre handlers. Essa etapa não constitui um heap JavaScript persistente.

Na saída de um handler, o codec verifica tipos e campos antes da atribuição ao estado nativo. Rejeita
campos extras/ausentes, getters, símbolos, arrays esparsos, `NaN`, infinito e inteiros fora do intervalo
seguro de `Number`. IDs grandes devem permanecer texto; não há promessa de aritmética decimal exata.
Expressões de renderização recebem cópias imutáveis. Um valor composto que não mudou não substitui a
instância nativa existente; alterações reais de uma lista ainda não têm reconciliação por chave.

A forma inicial deve ser inferível: `{}` e `[]` iniciais, tipos mistos, datas e `null` sem tipo declarado
são recusados. Depois de inferir um array, atribuir `[]` em um handler é permitido. A etapa atual cobre
estado local; inputs/eventos compostos, tipos importados, anotação de arrays inicialmente vazios e
repetição visual de listas ainda precisam ser implementados. `.map()` em JavaScript já manipula os
dados, mas não cria por si só uma árvore de widgets repetidos.

Prova: `tests/html/components/values.html`, `HtmlValueTests`, `tests/browser/native-values.cjs` e
`tests/browser/native-value-codecs.cjs`. Este último executa o JavaScript do job emitido na entrega.

## Identidade, atualização e CSS

O nome identifica o componente. IDs explícitos identificam os widgets que precisam sobreviver a edições
estruturais. Widgets sem ID recebem identidades determinísticas pela posição na fonte. Alterar a posição
de um widget sem ID pode substituí-lo; não equivale a um mecanismo de reconciliação por chave de listas.

Cada função da fonte gera um handler por assinatura, compartilhado por seus consumidores. Actions de UI
com a mesma assinatura preservam suas chaves e parâmetros ao substituir o corpo. Helpers de expressão e
handlers obsoletos são removidos somente quando pertencem à fonte e não têm consumidores externos. A
prova lê os contratos depois de recarregar o OML e depois do merge. Retirada de input/evento/placeholder
público, mudança de tipo, input novo obrigatório ou restrição de visibilidade exige migração de consumidores.
Mover um placeholder público para outro pai também é bloqueado: as APIs de clone/move investigadas recusam
essa operação no runtime examinado. Alterar o CSS ou o corpo sem mudar seu contrato continua permitido.

CSS fica em `StyleSheet` do bloco/tela, com escopo por componente e ownership de cada elemento. Regras do
pai não selecionam o interior de um bloco filho. Conteúdo projetado conserva o ownership do consumidor.
Herança normal do CSS continua existindo. O compilador neutraliza as margens/larguras automáticas relevantes
do tema nos elementos que emite. O frontend não injeta uma imagem, iframe ou página externa no lugar do
modelo nativo.

Seletores de ID autorados são associados a classes do componente, preservando sua especificidade e os IDs
que o framework usa para labels e controles. Classes dinâmicas não removem essas classes de ownership.
Custom properties funcionam na folha de estilo; o renderer O11 altera seus nomes quando usadas inline,
portanto esse caso é recusado com diagnóstico em vez de produzir silenciosamente um estilo incorreto.

## Entrada e prova

No fluxo controlado, `propose` recebe `uiSource` com o texto completo ou o bundle. O controlador congela essa fonte e
usa o mesmo `continue`/`status`, contrato, snapshot, merge e recibo. Não misture `uiSource` com um contrato
manual de dados/actions/telas. A prova da fronteira do controlador está em `AppBoundaryTests`.

Para manutenção autorizada:

```powershell
dotnet <cli-da-faixa>/anvil.dll deliver --module <Modulo> --spec <componentes.html> --port <bridge> --work <provas>
dotnet <cli-da-faixa>/anvil.dll check-delivery --result <provas>/deliver/<taskId>/result.json
node tests/browser/native-components.cjs https://<ambiente>/<Modulo>/ <pasta-de-prova>
```

O recibo inclui os hashes de todos os HTML importados; no bundle embutido, o hash do documento cobre seus
conteúdos. Uma mudança entre leitura/compilação e início da entrega é recusada. Editar qualquer fonte
depois do merge torna aquele recibo insuficiente para afirmar
que a versão atual foi entregue. A publicação de produto continua sendo do humano; provas publicadas usam
módulos de laboratório. `deliver --close` fecha somente uma falha conhecida, com snapshot do estado e motivo;
não converte falha em sucesso nem permite repetir uma escrita de resultado desconhecido.

## Limites restantes

O novo frontend importa blocks de referências OutSystems já registradas e infere objetos/arrays como
estado local. Ainda não cobre aquisição automática de referências, imports de actions/tipos ou arquivos
JavaScript, repetição visual de listas, chamadas assíncronas de servidor, upload, select, form com submissão/validação ou todas as formas
de HTML/CSS/JS. `form`, `select`, tipos de input e eventos não implementados são diagnosticados. Não tratar
a cobertura do backend nativo como cobertura da linguagem high code. O frontend legado de Dashboard tem
fontes de dados e paginação que ainda precisam convergir para esta entrada única antes de declarar o fluxo
completo concluído.

Esprima 3.0.6 é usado apenas pelo compilador; licença BSD-3-Clause preservada em `licenses/Esprima-3.0.6.txt`
e incluída nos outputs. Não é uma dependência do aplicativo OutSystems gerado. A avaliação está no ADR-017.
Não foram incluídas DLLs proprietárias ou fontes decompiladas no pacote do Hybrid.
