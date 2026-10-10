# Panel

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Content** | publico | 6 widgets internos

Used to isolate and highlight content with a title, content and optional footer inside a webscreen.

Add content on the placeholders.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

## Placeholders

- **Content**: Drag your content to this placeholder. (em `PanelWrapper`)
- **Footer**: Use this placeholder to set your footer. (em `PanelWrapper`)
- **Title**: Use this placeholder to set your title. (em `PanelWrapper`)
- **Actions**: Drag your actions (a button or a link) to this placeholder. (em `PanelWrapper`)

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Panel1","source":"IWebBlock:Panel","as":"$b"}
{"op":"create","parent":"$b/Content","type":"IExpressionWidget","as":"$eContent"}
{"op":"create","parent":"$b/Footer","type":"IExpressionWidget","as":"$eFooter"}
{"op":"create","parent":"$b/Title","type":"IExpressionWidget","as":"$eTitle"}
{"op":"create","parent":"$b/Actions","type":"IExpressionWidget","as":"$eActions"}
```
