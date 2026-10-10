# Help_Contextual

RichWidgets  | Traditional | UI flow **RichWidgets** | publico | 9 widgets internos

Displays a ? icon that when hovered show the help message for a part of the screen.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| HtmlOrHelpText | Text | sim |  | The help text to be shown. Rendered as an unescaped expression allowing you to use HTML tags in your text. |

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: Widget_Tooltip

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Help_Contextual1","source":"IWebBlock:Help_Contextual","as":"$b"}
{"op":"set","target":"$b/HtmlOrHelpText","prop":"Value","value":"<Text>"}
```
