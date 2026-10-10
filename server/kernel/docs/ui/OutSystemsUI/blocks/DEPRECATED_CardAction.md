# DEPRECATED_CardAction

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Content** | publico | 5 widgets internos

Card with placeholders for Title, Content, Footer and Action. When Action is triggered, the content apears. Title and Footer placeholders are not displayed if they are empty.

Perfect to display and highlight additional information on top of the front side of a Card

## Inputs

Nenhum.

## Placeholders

- **Content**: Add content to this placeholder (em `CardAdvanced/content`)
- **Footer**: Add footer content to this placeholder (em `CardAdvanced/content`)
- **Actions**: Add content be be shown when triggered (em `CardAdvanced/content/content`)

## Eventos

- **OnActionClick**()

## Composicao interna

- Ciclo de vida: OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnDestroy, setButtonPosition, OnReady, OpenAction

## JavaScript

`OnDestroy` / no `Destroy`:

```js
window.removeEventListener('orientationchange', $actions.setButtonPosition);
```

`setButtonPosition` / no `setButtonPosition`:

```js
function setButtonPosition() {
    var card = document.getElementById($parameters.WidgetId);
    var cardContent = card.querySelector(".card-content");
    var cardAction = card.querySelector(".card-action");
    var cardBottom = card.querySelector(".card-bottom");
    
    if(cardBottom) {
        clearInterval(interval);
        
        cardAction.classList.add("no-transition");
        
        var height = cardContent.offsetHeight;
        
        if(cardBottom.innerHTML !== "") {
            cardAction.style.top = height - 28 + "px";
        } else {
            cardAction.style.top = height - 77 + "px";
        }
        
        card.offsetHeight; // force repaint
        cardAction.classList.remove("no-transition");
    }
}

var interval = setInterval(function() {
    setButtonPosition();
}, 100);
```

`OnReady` / no `Init`:

```js
$actions.setButtonPosition();
window.addEventListener('orientationchange', $actions.setButtonPosition);
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DEPRECATED_CardAction1","source":"IMobileBlock:DEPRECATED_CardAction","as":"$b"}
{"op":"create","parent":"$b/Content","type":"IExpression","as":"$eContent"}
{"op":"create","parent":"$b/Footer","type":"IExpression","as":"$eFooter"}
{"op":"create","parent":"$b/Actions","type":"IExpression","as":"$eActions"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnActionClick` resolve o IEventHandler pelo nome do evento e `$b/OnActionClick/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"DEPRECATED_CardAction1_OnActionClick","as":"$h"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnActionClick","prop":"Handler","value":"$h"}
```
