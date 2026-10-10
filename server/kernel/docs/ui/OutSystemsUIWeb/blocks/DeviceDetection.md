# DeviceDetection

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Private** | privado | 3 widgets internos

Javascript for Device Detection

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| DeviceConfig | DeviceConfiguration | sim |  | Configuration to change the default values that set when the application will be seen as phone, tablet or desktop. |

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: JavaScriptNode
- Chama actions do modulo: GetReferrerURL, AddDeviceMetatag (contratos em [actions.md](../actions.md))

## JavaScript

JavaScript do bloco:

```js
/* OutSystems UI Web Device Detection                                  

  $0 - Variable Declaration                                            
  $1 - Device Detection Object declaration
  
    Public Functions
    $1.1 - setValues - sets all initial values
    $1.2 - setOpSystem - sets operating system
    $1.3 - getOpSystem - returns operating system
    $1.4 - setBroswer - sets browser
    $1.5 - getBroswer - returns browser
    $1.6 - setDevice - sets device
    $1.7 - getDevice - returns device
    $1.8 - hasSpecialVersion - sets classes if iphonex
    $1.9 - setOrientation - sets device orientation
    $1.10 - getOrientation - returns device orientation
    $1.11 - setCookie - sets cookie
    $1.12 - getCookie - gets cookie
    $1.13 - clearCookie - clears cookie
    $1.14 - resetOpSystem - resets operating system class on body
    $1.15 - resetBrowser - resets browser class on body
    $1.16 - resetDevice - resets device class on body
    $1.17 - resetOrientation - resets orientation class on body
    $1.18 - getWidth - returns initial witdh
    $1.19 - getHeight - returns initial height
    $1.20 - getDeviceWidth - returns device witdh
    $1.21 - getDeviceHeight - returns device height
    
    Private Functions - auxiliary 
    $1.22 - resizeend - triggered when resize event ends
    $1.23 - setEventValues - called by resize and orientation events to reset/set values
    $1.24 - setListeners - sets resize and orientation events
    $1.25 - getCookiePolicy - gets the current cookie policy

  $2 - Start 
*/

var deviceDetection = function() {
    
    /* $0 - Variable Declaration */
    var deviceDetect;
    var userValues;
    var device;
    var os;
    var browser;
    var orientation;
    var height;
    var width;
    var isPreviewInDevices;
    
    // Chech if is Preview In Devices
    if(window.top.document.querySelector(".marvel-device") !== null) {
        isPreviewInDevices = true;
    }
        
    /* $1 - Device Detection Object declaration */
    deviceDetectionObj = function() { 
        /* $0 - Variable Declaration */
        var body;
        
        var rtime;
        var timeout = false;
        var delta = 200
    
        /* $1.1 - setValues - sets all initial values */
        this.setValues = function() {
            
            body = document.body;            
            
            this.setOpSystem();
            this.setDevice();
            this.setBrowser();
            this.setOrientation();
            
            setListeners();
        }
        
        /* $1.2 - setOpSystem - sets operating system */
        this.setOpSystem = function() {
            var nav = navigator.userAgent;
        
            switch(true) {
                case (/Windows/gi.test(nav)):
                    body.classList.add("windows");
                    os = "windows";
                    break;
                case (/IPAD/gi.test(nav) || /IPHONE/gi.test(nav) || /IPOD/gi.test(nav)):
                    body.classList.add("ios");
                    os = "ios";
                    break;
                case (/Android/gi.test(nav)):
                    body.classList.add("android");
                    os = "android";
                    break;
                case (/MAC/gi.test(nav) && /OS/gi.test(nav)):
                    body.classList.add("osx");
                    os = "osx";
                    break;
                case (/Ubunto/gi.test(nav)):
                    body.classList.add("ubunto");
                    os = "ubunto";
                    break;
                case (/Linux/gi.test(nav)):
                    body.classList.add("linux");
                    os = "linux";
                    break;
            }
            
            this.setCookie('DEVICE_OS', os);
        }
        
        /* $1.3 - getOpSystem - returns operating system */
        this.getOpSystem = function() {
            return os;
        }
        
        /* $1.4 - setBrowser - sets browser */
        this.setBrowser = function() {
            var nav = navigator.userAgent;
            
            switch(true) {
                case (nav.indexOf("Trident/7.0") > -1):
                        body.classList.add("ie11");
                        browser = "ie11";
                        break;
                    case (nav.indexOf("MSIE 10") > -1):
                        body.classList.add("ie10");
                        browser = "ie10";
                        break;
                    case (/Firefox/gi.test(nav)):
                        body.classList.add("firefox");
                        browser = "firefox";
                        break;
                    case (/Chrome/gi.test(nav) && !/Edge/gi.test(nav)):
                        body.classList.add("chrome");
                        browser = "chrome";
                        break;
                    case (/Safari/gi.test(nav) && !/Edge/gi.test(nav)):
                        body.classList.add("safari");
                        browser = "safari";
                        break;
                    case (/Opera/gi.test(nav)):
                        body.classList.add("opera");
                        browser = "opera";
                        break;
                    case (/Edge/gi.test(nav)):
                        body.classList.add("edge");
                        browser = "edge";
                        break;   
            }

            this.setCookie('DEVICE_BROWSER', browser);
        }

        /* $1.5 - getBroswer - returns browser */
        this.getBrowser = function() {
            return browser;
        }

        /* $1.6 - setDevice - sets device */
        this.setDevice = function() {
            var nav = navigator.userAgent;
            var windowWidth = this.getDeviceWidth();
            var windowHeight = this.getDeviceHeight();
            var isLandscape = body.classList.contains("landscape");
            
            /* checks if the value is set by the user, if it is then i
/* ... truncado: 10908 chars a mais no JSON do catalogo */
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"DeviceDetection1","source":"IWebBlock:DeviceDetection","as":"$b"}
{"op":"set","target":"$b/DeviceConfig","prop":"Value","value":"<DeviceConfiguration>"}
```
