# InputWithIcon

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Controls** | publico | 5 widgets internos

Customize an input with an Icon. 

Just drag your input and choose the desired icon.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| AlignIconRight | Boolean | nao | False | If set as true, sets the icon to the right. |
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

## Placeholders

- **Icon**: Drag the Icon widget to this placeholder. (em `InputWithIconWrapper`) | nasce com: WebBlockInstance:Icon (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)
- **Input**: Drag the Input widget to this placeholder. (em `InputWithIconWrapper`) | nasce com: Input. Esse Input e parte do padrao: NAO use empty; ligue-o com `set $b/Input/#IInput prop Variable value <variavel>` (os nomes reais sao renumerados, ex. Input1; enderece por tipo)

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
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"InputWithIcon1","source":"IWebBlock:InputWithIcon","empty":true,"as":"$b"}
{"op":"set","target":"$b/Input/#IInput","prop":"Variable","value":"<variavel local>"}
```
