# Wizard

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Navigation** | publico | 16 widgets internos

Used to split larger tasks into more manageable steps. Usually supported by explicit button navigation to move forward and backward.

Drag as many WizardItems in the Content placeholder as you need.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Orientation | Orientation Identifier | nao | Entities.Orientation.Horizontal | Set the orientation. |
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

Valores possiveis (static entities):

- **Entities.Orientation**: Horizontal, Vertical

## Placeholders

- **Content**: Drag WizardItem blocks to this placeholder. | nasce com: WebBlockInstance:WizardItem, WebBlockInstance:WizardItem, WebBlockInstance:WizardItem (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: WizardItem

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Wizard1","source":"IWebBlock:Wizard","empty":true,"as":"$b"}
```
