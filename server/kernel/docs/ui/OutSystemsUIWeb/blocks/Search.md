# Search

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Controls** | publico | 7 widgets internos

Simple search form pattern with a search icon.

Drag an Input Widget inside the placeholder to use as a search input.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

## Placeholders

- **Icon**: Drag the Icon widget to this placeholder. (em `SearchWrapper`) | nasce com: WebBlockInstance:Icon (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)
- **Input**: Drag the Input widget to this placeholder. (em `SearchWrapper`) | nasce com: Input. Esse Input e parte do padrao: NAO use empty; ligue-o com `set $b/Input/#IInput prop Variable value <variavel>` (os nomes reais sao renumerados, ex. Input1; enderece por tipo)
- **Actions**: Drag your actions (a button or a link) to this placeholder. (em `SearchWrapper`)

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: Icon

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Search1","source":"IWebBlock:Search","empty":true,"as":"$b"}
{"op":"set","target":"$b/Input/#IInput","prop":"Variable","value":"<variavel local>"}
{"op":"create","parent":"$b/Actions","type":"IExpressionWidget","as":"$eActions"}
```
