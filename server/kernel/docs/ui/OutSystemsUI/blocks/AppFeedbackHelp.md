# AppFeedbackHelp

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **AppFeedback** | publico | 24 widgets internos

Displays information if the App Feedback is enabled in the application. 

This information is displayed only once for each application, once dismissed, it will never show up again.

Content inside the placeholders can be edited to display custom messages.

## Inputs

Nenhum.

## Placeholders

- **Title** (em `AppFedback/content/Top/content`) | nasce com: Text (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)
- **Message** (em `AppFedback/content/Center`) | nasce com: Container, Container, Container (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: CenterContent
- Ciclo de vida: OnReady -> CheckAppFeedback
- Actions do bloco: ShowAppHelper, CheckAppFeedback

## JavaScript

`CheckAppFeedback` / no `CheckPlugin`:

```js
if(typeof(cordova) !== "undefined" && typeof(OSAppFeedback) !== "undefined") {
    window.OSAppFeedback.isAvailable(available, unavailable);
}
    
function available(success) {
    var cookieLabel = "SHOW_APPFEEDBACK_HELP";
        
    if(success) {
        // Has App Feedback
        
        if(localStorage.cookieLabel !== "SHOW_APPFEEDBACK_HELP") {
            // First Time Viewing the Helper Screen
            
            localStorage.setItem("cookieLabel", cookieLabel);
            $actions.ShowAppHelper(true);
            
            // Add statusbar overlay
            var body = document.querySelector('body');
            var statusbarHeight = body.getAttribute('data-status-bar-height');
            
            var appFeedbackHelper = document.querySelector('.app-helper .center-content-header');
            
            if(appFeedbackHelper) {
                appFeedbackHelper.style.padding = statusbarHeight + "px 15px 0px";   
                appFeedbackHelper.style.height = (parseInt(statusbarHeight) + 44) + "px";     
            }
            
        }  
    }
}

function unavailable(error) {
    // App Feedback not Available
}
```

## CSS

Classes: `.app-helper`, `.center-content`, `.center-content-container`, `.center-content-header`, `.title-app-helper`, `.btn-primary`, `.center-content-bottom`, `.padding20`

Variaveis: `--os-safe-area-top`, `--os-safe-area-right`, `--os-safe-area-left`, `--os-safe-area-bottom`

```css
.app-helper {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;    
    bottom: 0;
    z-index: 150;
    background-color: #fff;
    -servicestudio-top: 100px;
    -servicestudio-bottom: 100px;
    -servicestudio-left: 10px;
    -servicestudio-right: 10px;
    -servicestudio-border-radius: 4px;
    -servicestudio-overflow: hidden;
    -servicestudio-box-shadow: 0 0 100px 100px rgba(0,0,0,0.3);
}

.app-helper .center-content {
    -servicestudio-height: 100% !important;
}

.app-helper .center-content-container > div {
    width: auto;
}

.app-helper .center-content-header {
    background-color: #c20000;
    display: -webkit-box;
    display: -ms-flexbox;
    display: -webkit-flex;
    display: flex;
    -webkit-box-align: center;
        -ms-flex-align: center;
            -webkit-align-items: center;
            align-items: center;
    height: 44px;
    padding: 0 15px;
}

.app-helper .title-app-helper {
    color: #fff;
    font-size: 18px;
    text-align: center;
    width: 100%;
}

.app-helper .center-content-container {
    padding: 20px 15px;
    color: #384142;
    overflow: auto;
}

.app-helper .center-content-container {
    padding: 20px 15px;
    color: #384142;
    overflow: auto;
    padding: 20px 15px;
    color: #384142;
    overflow: auto;
    -webkit-box-orient: vertical;
    -webkit-box-direction: normal;
    -webkit-flex-direction: column;
        -ms-flex-direction: column;
            flex-direction: column;
    -webkit-justify-content: space-around;
        -ms-flex-pack: distribute;
            justify-content: space-around;
    text-align: center;
}

.app-helper .btn-primary, 
.app-helper .btn-primary:hover, 
.app-helper .btn-primary:focus {
    border-radius: 5px;
    background-color: #c20;
    border: 1px solid #c20;
    min-width: 110px;
    min-height: 42px;
}

.app-helper .center-content-header {
    padding-top: var(--os-safe-area-top);
    padding-right: var(--os-safe-area-right);
    padding-left: var(--os-safe-area-left);
}

.app-helper .center-content-container {
    padding-right: var(--os-safe-area-right);
    padding-left: var(--os-safe-area-left);
}

.app-helper .center-content-bottom {
    padding-right: var(--os-safe-area-right);
    padding-bottom: var(--os-safe-area-bottom);
    padding-left: var(--os-safe-area-left);
}

.app-helper .padding20 {
    padding: 20px;
    padding-bottom: calc(var(--os-safe-area-bottom) + 20px);
}
```

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"AppFeedbackHelp1","source":"IMobileBlock:AppFeedbackHelp","empty":true,"as":"$b"}
```
