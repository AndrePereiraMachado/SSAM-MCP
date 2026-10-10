# Verbo `complexity`: a pergunta "porque e que esta tela esta pesada", respondida por medicao

> Anotado em 2026-09-18 a meio de trabalho real na tela `Options` do `Quotes` (ODC). Nao construido ainda.
> Esta pagina existe para o caminho ficar escrito enquanto se vai mapeando; cada coisa aqui saiu de um passo
> que eu tive de improvisar, e a lista cresce a medida que aparecem mais.

## Porque

A familia mais teimosa dos 243 achados da leitura de 2026-09-17 (`SSAM-Hybrid-ODC/docs/ONDE-FORAM-AS-8-HORAS.md`)
sao 63 casos e 544 minutos com um so nome: a ferramenta nao tem nocao de **quanto e demais**. O humano pediu SETE
vezes em cinco horas para reduzir 33 variaveis locais e 54 screen actions numa tela, e de cada vez a conversa
recomecava do zero porque nao havia numero nenhum em cima da mesa -- so gosto contra gosto.

Os limiares nativos do Studio (`>8` atributos, `Length>1000`, `>=800` linhas, `MaxCssThreshold`,
`ConsecutiveServerInteractions`) ajudam, e devem entrar. Mas sao sobre **tamanho**, e tamanho por si nao prova
nada: uma tela de 500 nos pode estar certa.

O que se mediu na `Options` e melhor, porque e sobre **repeticao**:

```
IndicationArg: os MESMOS 34 campos, com a fórmula LITERALMENTE igual,
               atribuidos em Initialize, LoadDeductibleOptions e RecalculateOptions
Card:          os MESMOS 18 campos, identicos, em Initialize e RecalculateOptions
               -> 86 nos de atribuicao que sao copia-colada
```

Isto nao e opiniao. Conta-se, prova-se, e diz-se sem julgar ninguem.

## A forma

    anvil complexity --oml <modulo.oml> --target <Kind:Nome>      (as duas faixas)
    odc  complexity <modulo.oml> <Kind:Nome>

Alvo: uma tela, um bloco, uma action, ou o modulo inteiro. Leitura pura, nunca escreve.

## O que devolve

**1. Locais, com leitura e escrita SEPARADAS.** Hoje o `usages` devolve uma lista sem distinguir; eu deduzi a
escrita pelo sufixo `#Variable` na chave, que e engenharia reversa de uma convencao nao documentada. O modelo sabe
a diferenca -- deve ser um campo, nao um palpite de quem le.

Por variavel: leituras, escritas, e em que actions. Uma variavel lida uma so vez e candidata a deixar de existir
(na `Options` sao quatro: `ChoiceItem`, `ClientView`, `DeductibleRow`, `CommittedCoverage`, todas o mesmo padrao
-- montar uma estrutura campo a campo para a usar logo a seguir).

**2. Actions, com quem as chama.** Distingue o handler de evento (chamado uma vez, pela UI, e isso e normal) do
envelope fino (duas ou tres linhas chamadas de um sitio so, que se inline).

**3. Atribuicoes duplicadas -- o nucleo.** Para cada raiz de variavel, os campos escritos em mais de uma action
com a MESMA formula. Devolve o conjunto, o numero de nos que desaparecia com a extraccao, e as actions
envolvidas. E o unico numero desta pagina que fecha uma discussao.

**4. Derivaveis.** Variavel cujas escritas sao todas funcao de outras coisas da tela (`SelectedCount` que e sempre
`SelectedIds.Length`). Candidata a virar expressao. CUIDADO: nao afirmar sem ver TODAS as escritas -- na `Options`
o `SelectedCount` tem duas, e uma delas e `0`.

**5. Os limiares nativos do Studio**, quando disparem, com o numero e o nome da regra do produto.

## Tres comportamentos que sao parte do verbo, nao avisos na documentacao

Cada um custou-me tempo hoje.

**Nunca devolver vazio quando a leitura correu mal.** Li dois recibos pela chave errada -- `feature-checks.json`
chama `passed` ao que eu procurei como `checks`, e o resultado do `run_job.py` poe tudo em `data.results` e nao em
`results`. As duas vezes recebi uma tabela VAZIA e nao um erro: parecia "nao ha nada" quando era "leste mal". Um
leitor que nao encontra a chave que esperava tem de gritar.

**Dizer quando trunca.** Pedi `usages` com `max: 40` e o `IndicationArg` tem 136 usos: vieram 40 entradas e um
`count: 136`, sem uma palavra sobre o corte. So escapei porque a aritmetica nao fechava (3 leituras + 37 escritas
nao dao 136). Sem isso teria concluido que a variavel mais importante da tela era pouco usada -- exactamente ao
contrario.

**Responder a pergunta natural.** "Quais sao as atribuicoes desta action" nao tem resposta em lado nenhum hoje. O
`usages` da o lado da variavel e nunca o `= alguma coisa`. Para ver `IndicationArg.X = Client.WF_X` foi preciso um
`inspect --full` de 909 KB e um script Python a andar na arvore. E a primeira pergunta que se faz para simplificar
logica.

## Onde vive

No **kernel do Anvil**, nao no builder do SSAM: assim serve as duas faixas sem se escrever duas vezes, e a mesma
pergunta responde-se numa tela do O11 e numa do ODC. O builder chama-o.

## Detalhe a nao esquecer

O `inspect` a profundidade 2 diz que o `Initialize` tem 51 filhos; uma travessia da subarvore conta 508 nos.
Nenhum dos dois vem rotulado. O verbo tem de dizer QUAL esta a contar, porque "quao grande e esta action" tem duas
respostas legitimas e diferentes.
