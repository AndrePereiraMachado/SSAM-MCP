# Alert

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Content** | publico | 25 widgets internos

Alert messages give feedback after different types of actions: Success, Warning, Error or Info.

Used for the display of information that is important to the user.

Write the message on the placeholder and set the alert type in the properties.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| AlertType | Alert Identifier | sim |  | Select type of alert. |
| ShowCloseButton | Boolean | nao | False | Enable the Close Button on the Alert Block. |
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

Valores possiveis (static entities):

- **Entities.Alert**: Error, Info, Success, Warning

## Placeholders

- **Text**: Drag text to this placeholder. (em `AlertWrapper`)

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: Icon, JavaScriptNode

## JavaScript

JavaScript do bloco:

```js
var newAlert = function() { 
    // Objects
    var alert;
    var alertClose;
    var alertCloseButton;
    

    var start = function(widgetIdParam, alertShowCloseButton) {
        // Fills objects
        alert = document.getElementById(widgetIdParam);
        alertClose = alert.querySelector('.alert-close');
        alertCloseButton = alertShowCloseButton;
        
        // Add event listeners
        if(alertCloseButton === "true"){
            alertClose.addEventListener('click', onAlertCloseClick);
            alertClose.addEventListener('focus', onAlertCloseFocus);
            alert.addEventListener('keydown', onAlertOnKeypress);
        }
    };
    
    var onAlertCloseClick = function() {
        
        // Change ARIA state
        alert.setAttribute('aria-hidden','true');
        
        // Set and remove classes
        alert.classList.add('is--hidden');
        alertClose.classList.add('is--hidden');
        
        alert.classList.remove('is--visible');
        alertClose.classList.remove('is--visible');
        
    };
    
    var onAlertCloseFocus = function() {
        
        // Change ARIA state
        alertClose.setAttribute('aria-hidden','false');
        
    };
    
    //Set keyboard interaction
    var onAlertOnKeypress = function(e) {
        if (e.keyCode == "27") {
            onAlertCloseClick();
            e.preventDefault();
            e.stopPropagation();
        }     
    };
    
    return {
        init: function(widgetIdParam, alertShowCloseButton) {
            start(widgetIdParam, alertShowCloseButton);
        }
    }

};
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Alert1","source":"IWebBlock:Alert","as":"$b"}
{"op":"set","target":"$b/AlertType","prop":"Value","value":"<Alert Identifier>"}
{"op":"create","parent":"$b/Text","type":"IExpressionWidget","as":"$eText"}
```
