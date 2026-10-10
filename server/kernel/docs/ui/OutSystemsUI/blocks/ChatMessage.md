# ChatMessage

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Content** | publico | 23 widgets internos

Block with Chat Message content, such as user photo, text, images, delivery time and status.

After adding the user picture and message content, configure the Time and Status of the message in the Input Parameters.

Use to create chat screens or a feed of user posts

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| DisplayOnRight | Boolean | nao | False | Usually, sent messages are displayed on the right and received messages are on the left |
| Time | Time | nao |  | Time of the message |
| MessageStatus | MessageStatus Identifier | sim |  | The status of the current message, it can be: sent, received, read or hidden |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

Valores possiveis (static entities):

- **Entities.MessageStatus**: Received, Hidden, Sent, Read

## Placeholders

- **Image**: Drag an image or UserAvatar to this placeholder. (em `content/content`)
- **Content**: Chat Message Content (em `content/content/Message/content`)

## Eventos

Nenhum.

## Composicao interna

- Ciclo de vida: OnReady -> OnReady
- Actions do bloco: ShowStatus, OnReady

## JavaScript

`OnReady` / no `Init`:

```js
var elemId = document.getElementById($parameters.ElemId);
var isExpanded;

var onKeyDownPress = function(e){
    isExpanded = elemId.getAttribute('aria-expanded');
    
    //If ESC and expanded, hide the status 
    if(isExpanded === "true" && e.keyCode == "27") {
        $actions.ShowStatus();
        e.preventDefault();
        e.stopPropagation();
    }
    
    //If Enter or Space toggle status visibility
    if (e.keyCode == "32" || e.keyCode == "13") {
        $actions.ShowStatus();
        e.preventDefault();
        e.stopPropagation();
    }
};

elemId.addEventListener('keydown', onKeyDownPress);
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"ChatMessage1","source":"IMobileBlock:ChatMessage","as":"$b"}
{"op":"set","target":"$b/MessageStatus","prop":"Value","value":"<MessageStatus Identifier>"}
{"op":"create","parent":"$b/Image","type":"IExpression","as":"$eImage"}
{"op":"create","parent":"$b/Content","type":"IExpression","as":"$eContent"}
```
