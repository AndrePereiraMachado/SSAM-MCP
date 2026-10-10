# Section

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Content** | publico | 9 widgets internos

The Section has three placeholders, for the Title, Actions and Content.

Use it to segment and arrange blocks of content on a page. It also allows to create a Section index if you are using both patterns in the same page.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

## Placeholders

- **Content**: Drag your content to this placeholder. (em `SectionWrapper`)
- **Title**: Use this placeholder to set your title. (em `SectionWrapper`)
- **Actions**: Drag your actions (a button or a link) to this placeholder. (em `SectionWrapper`)

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Section1","source":"IWebBlock:Section","as":"$b"}
{"op":"create","parent":"$b/Content","type":"IExpressionWidget","as":"$eContent"}
{"op":"create","parent":"$b/Title","type":"IExpressionWidget","as":"$eTitle"}
{"op":"create","parent":"$b/Actions","type":"IExpressionWidget","as":"$eActions"}
```
