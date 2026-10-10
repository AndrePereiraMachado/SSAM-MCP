# AccordionItem

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Content** | publico | 6 widgets internos

A single Accordion item should be placed inside the Accordion placeholder.

Used within the Accordion Pattern.

Drag into the Accordion Block as many items as you need.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| IsOpen | Boolean | nao | False | If true, when rendering the Accordion Item is open. |
| IsDisable | Boolean | nao | False | Doesn't allow the Accordion Item to be clickable. |
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

## Placeholders

- **Content**: Drag your content to this placeholder. (em `AccordionItemWrapper`)
- **Title**: Use this placeholder to set your title. (em `AccordionItemWrapper`)

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
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"AccordionItem1","source":"IWebBlock:AccordionItem","as":"$b"}
{"op":"create","parent":"$b/Content","type":"IExpressionWidget","as":"$eContent"}
{"op":"create","parent":"$b/Title","type":"IExpressionWidget","as":"$eTitle"}
```
