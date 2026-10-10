# CardBackground

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Content** | publico | 13 widgets internos

Card with a background image and placeholder for content with input parameters to configure the style of the card.

A card background is useful for a few short, related pieces of information. It roughly resembles a playing card in size and shape, and is intended as a linked, short representation of a conceptual unit.

Place your content in the placeholder and set the background image. Alternatively, in the parameters, you can define a background-color, the position of content and a minimum height.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Color | Color Identifier | nao | Entities.Color.Transparent | Set the backgound color. |
| Position | PositionExtended Identifier | nao |  | Set the position around the widget element. |
| Height | Integer | nao | 300 | Set the height of the Card, in pixels. Content will be vertically aligned by default. |
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

Valores possiveis (static entities):

- **Entities.Color**: Yellow, Neutral0, Indigo, Neutral7, Neutral8, Primary, Grape, Neutral10, Blue, Orange, Green, Lime, Neutral5, Secondary, Neutral6, Violet, Cyan, Pink, Red, Neutral1, Teal, Neutral3, Neutral4, Neutral2, Transparent, Neutral9
- **Entities.PositionExtended**: TopLeft, TopRight, TopCenter, BottomRight, Center, CenterLeft, CenterRight, BottomCenter, BottomLeft

## Placeholders

- **Content**: Drag your content to this placeholder. (em `CardBackgroundWrapper`) | nasce com: Container (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)
- **BackgroundImage**: Drag an image, GIF or video to this placeholder. (em `CardBackgroundWrapper`) | nasce com: Image (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: JavaScriptNode

## JavaScript

JavaScript do bloco:

```js
var CardBackground = function() {
    // Objects
    var isIE;
    var cardBackground;
    var cardBackgroundImage;
    var cardBackgroundImageURL;
    
    var start = function(widgetId) {
        cardBackground = document.getElementById(widgetId);

        // detect IE11
        isIE = document.body.classList.contains('ie11');
    
        if(isIE) { 
            cardBackground.classList.add('card-background-ie');       
            cardBackgroundImage = cardBackground.querySelector('.card-background-image');
            cardBackgroundImageURL = cardBackgroundImage.getElementsByTagName('img')[0].getAttribute('src');           
            cardBackgroundImage.style.backgroundImage = 'url('+ cardBackgroundImageURL +')';                   
        };
    };
         
    return {
        init: function(widgetId) {
            start(widgetId);
        }
    };
};
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"CardBackground1","source":"IWebBlock:CardBackground","empty":true,"as":"$b"}
```
