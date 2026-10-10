# FloatingActionsItem

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Controls** | publico | 5 widgets internos

Used within the FloatingActions Pattern. Should be placed inside the FloatingActions's Item placeholder.

Drag into the FloatingActions Pattern as many items as you need.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

## Placeholders

- **Label**: Drag the Label widget to this placeholder. | nasce com: Text (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)
- **Item**: Drag the Icon widget to this placeholder. | nasce com: WebBlockInstance:Icon (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

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
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"FloatingActionsItem1","source":"IWebBlock:FloatingActionsItem","empty":true,"as":"$b"}
```
