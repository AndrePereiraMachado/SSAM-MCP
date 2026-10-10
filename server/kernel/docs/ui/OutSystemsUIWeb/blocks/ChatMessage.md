# ChatMessage

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Content** | publico | 12 widgets internos

Display conversational content such as user photo, text, images, delivery time and status.

Add your content to the placeholders. Optionally, you can use the parameters to configure the color, the horizontal alignment or set the styles to post, through the IsInline parameter.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| IsRight | Boolean | nao |  | When set to true, aligns the pattern to right. |
| IsInline | Boolean | nao | False | If set as true, the chat balloon styles are changed to something similar to a post pattern. |
| Color | Color Identifier | nao | Entities.Color.Neutral3 | Set the backgound color. |
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

Valores possiveis (static entities):

- **Entities.Color**: Yellow, Neutral0, Indigo, Neutral7, Neutral8, Primary, Grape, Neutral10, Blue, Orange, Green, Lime, Neutral5, Secondary, Neutral6, Violet, Cyan, Pink, Red, Neutral1, Teal, Neutral3, Neutral4, Neutral2, Transparent, Neutral9

## Placeholders

- **Image**: Drag an image or UserInitials to this placeholder. (em `chat`) | nasce com: WebBlockInstance:UserInitials (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)
- **Actions**: Drag your actions to this placeholder. (em `chat`) | nasce com: InlineExpression, WebBlockInstance:Icon (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)
- **Name**: Use this placeholder to set the name. (em `chat/MessageContent`) | nasce com: Text (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)
- **Content**: Drag your content to this placeholder. (em `chat/MessageContent`) | nasce com: Text (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

- **OnClick**(): Event triggered when the user clicks the message container.

## Composicao interna

- Usa os blocos: UserInitials, Icon

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"ChatMessage1","source":"IWebBlock:ChatMessage","empty":true,"as":"$b"}
```
