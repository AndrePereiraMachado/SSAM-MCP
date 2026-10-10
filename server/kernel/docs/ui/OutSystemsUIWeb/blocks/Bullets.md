# Bullets

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Content** | publico | 7 widgets internos

Make complex data easier to grasp, while highlighting key information.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ExtendedClass | Text | nao | "" | Add custom style classes to this Block. |

## Placeholders

- **BulletsItems**: Drop BulletItems here to build your bulleted list. | nasce com: WebBlockInstance:BulletItem, WebBlockInstance:BulletItem, WebBlockInstance:BulletItem (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: BulletItem

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Bullets1","source":"IWebBlock:Bullets","empty":true,"as":"$b"}
```
