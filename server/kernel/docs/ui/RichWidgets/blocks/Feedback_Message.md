# Feedback_Message

RichWidgets  | Traditional | UI flow **RichWidgets** | publico | 63 widgets internos

Displays a feedback box based on the last call to the Feedback_SetMessage() action. 
This web block is often present in the header of all screens.

## Inputs

Nenhum.

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: RichWidgetsjQueryUI, NotifyWidget
- Actions do bloco: Refresh
- Chama actions do modulo: RunJavaScript, SetCookie (contratos em [actions.md](../actions.md))

## JavaScript

JavaScript do bloco:

```js
var RichWidgets_Feedback_Message_timerHide;
var RichWidgets_Feedback_Message_widget;
var RichWidgets_Feedback_Message_notifyWidget;
var RichWidgets_Feedback_Message_Feedback;
//Fetches the cookie policy set on screen
function getCookiePolicy(){
    var cookiePolicy = "";
    var htmlPolicy = document.body.getAttribute("data-os-cookie-policy");
    if(htmlPolicy){
        if (htmlPolicy.search(/SameSite/i) > -1){
            var pattern = new RegExp(/SameSite=([^&;]+)/i);
            var result = pattern.exec(htmlPolicy);
            cookiePolicy = cookiePolicy + result[0] + ";"; 
        }
        if (htmlPolicy.search(/Secure/i) > -1){
            cookiePolicy = cookiePolicy + "Secure"; 
        }
    }
    return cookiePolicy;
}
// Detect whether or not we are loading this page from the browser cache
outsystems.internal.$(function($) {
    if (typeof(outsystems.internal.$.resetLoadedFromBrowserCache)=='undefined') {
        var CACHE_COOKIE = 'pageLoadedFromBrowserCache';
        outsystems.internal.$.loadedFromBrowserCache = (document.cookie.indexOf(CACHE_COOKIE + "=true") != -1);
        document.cookie = CACHE_COOKIE + "=true;path=/; " + getCookiePolicy();
    }
});
// finds the topmost frame that defines a notify widget
// sync with the method in JSNotifyFeedback Script at Feedback_Message action
// reason: when you call feedback_message action, and you are not on a page that uses the feeedback_message 
// web block, you will not know this JS function, that's why it is here and in the web block.
function RichWidgets_Feedback_Message_findParentWithNotifyWidget() {
    function RichWidgets_Feedback_Message_checkProp(obj, prop) {
        try {
            return typeof(obj) != 'undefined' && (obj[prop]===obj[prop]);
        } catch(ex) {
            return false;
        }
    }
    
    var lastCandidateParent = undefined, lastParent = parent;
    while(window !== lastParent && lastParent) {
        if (RichWidgets_Feedback_Message_checkProp(lastParent,'RichWidgets_Feedback_Message_notifyWidget') &&
            lastParent.RichWidgets_Feedback_Message_notifyWidget) {
            lastCandidateParent = lastParent;
        }
        if(lastParent === lastParent.parent) {
            break;
        }
        lastParent = lastParent.parent;
    }
    return lastCandidateParent;
}
function RichWidgets_Feedback_Message_feedbackSlideDown(feedbackWrapperId, autoHide){
  outsystems.internal.$(function($){
    
    var lastCandidateParent = RichWidgets_Feedback_Message_findParentWithNotifyWidget();
    
    //Prevent messages from showing in inner iframes
    if(lastCandidateParent) {
        return;
    }
    
    //Prevent messages from showing when the user clicks the browser back button
    if (outsystems.internal.$.loadedFromBrowserCache)
        return;
    feedbackWrapperId = '#' + feedbackWrapperId;
    var $feedbackWrapperId = $(feedbackWrapperId);
    
    //Cancel previous hide animation if exists
    clearTimeout(RichWidgets_Feedback_Message_timerHide);
    if (RichWidgets_Feedback_Message_widget)
      RichWidgets_Feedback_Message_widget.stop().hide();
    $feedbackWrapperId.hide();
    if(!($.browser.msie && $.browser.version<7))
        $feedbackWrapperId.css("top", "-2px"); //Don't do this in IE 6
    //Slidedown Feedback 
    RichWidgets_Feedback_Message_widget = $feedbackWrapperId.show('slide',{direction:'up'}, 600, function(){
        var slideUp = function(){
            $feedbackWrapperId.css("height","auto");
          $(RichWidgets_Feedback_Message_widget).hide('slide',{direction:'up'}, 500); 
          clearTimeout(RichWidgets_Feedback_Message_timerHide);
        };
        $feedbackWrapperId.find('.Feedback_Message_Wrapper_Close').click(slideUp);
        $feedbackWrapperId.bind('touchstart', slideUp); // mobile devices
        $feedbackWrapperId.css("height",0);// to avoid ignoring clicks
        if (autoHide) {
          RichWidgets_Feedback_Message_timerHide = window.setTimeout(slideUp, 15000);
        }
        setFocus($feedbackWrapperId);
        bindESC($feedbackWrapperId, slideUp);
        trapFocus(feedbackWrapperId);
      });
  });
}
var RichWidgets_Feedback_Message_UnloadingState = false;
//#590137 Must use jQuery here to ensure "beforeunload" is not overwritten
jQuery(window).bind("beforeunload", function () {
    RichWidgets_Feedback_Message_UnloadingState = true;
});
var RichWidgets_Feedback_Message_errorTrapped = false;
function RichWidgets_Feedback_Message_ErrorHandler(event, exception) {
    outsystems.internal.$(function($){
        if(!RichWidgets_Feedback_Message_UnloadingState)    {
            if (!RichWidgets_Feedback_Message_errorTrapped)
                OsNotifyWidget(RichWidgets_Feedback_Message_notifyWidget, "3 An exception occurred in the client script.\n Error: " + (exception.message == ''? exception : exception.message) );
            RichWidgets_Feedback_Message_errorTrapped = true;
        } else {
            RichWidgets_Feedback_Message_UnloadingState = false;
        }
    });
}
function setFocus(feedbackWrapperId){
  var Feedback_Message = $( "span[class*='Feedback_Message_Text']" );
  feedbackWrapperId.find(Feedback_Message).focus();
}
function setRoleAlert(feedbackWrapperId){
  removeRole(feedbackWrapperId);
  var Feedback_Message = $( "span[class*='Feedback_Message_Text']" );
  feedbackWrapperId.find(Feedback_Message).attr("role", "alert");
}
function removeRole(feedbackWrapperId){
    var Feedback_Message = $( "span[class*='Feedback_Message_Text']" );
    feedbackWrapperId.find(Feedback_Message).removeAttr("role");
}
function bindESC(feedbackWrapperId, slideUp){
    var Feedback_Message = $( "span[class*='Feedback_Message_Text']" );
    var onKeypress = function(e) {
        var KEYCODE_ESC = 27;
        if (e.keyCode == KEYCODE_ESC) { slideUp(); }
        };
    feedbackWrapperId.find(Feedback_Message).keyup(onKeypress);
}
function trapFocus(feedbackWrapperId) {
    var element = document.querySelector(feedbackWrapperId);
    var 
/* ... truncado: 1036 chars a mais no JSON do catalogo */
```

## CSS

Classes: `.Feedback_Message_Wrapper`, `.documentElement`, `.scrollTop`, `.Feedback_Message_Wrapper_Close`, `.Feedback_Message_Error`, `.Feedback_Message_Warning`, `.Feedback_Message_Success`, `.Feedback_Message_Info`

```css
div.Feedback_Message_Wrapper {
    position: fixed;
    top: -200px;
    text-align: center;
    width: 100%;
    font-size: 16px;
    margin-bottom: 25px;
    margin-top: 24px;
    _position: absolute; /* IE6 */
    _top: expression( (document.documentElement.scrollTop - 2) + 'px' ); /* IE6 */
    z-index: 10000;
}

div.Feedback_Message_Wrapper img {
    vertical-align: middle;
    padding: 2px;
    margin: 0px;
}

a.Feedback_Message_Wrapper_Close {
    position:absolute;
    top: 0px;
    right: 0px;
}

a.Feedback_Message_Wrapper_Close:hover {
  background-color:transparent;
}

div.Feedback_Message_Error,
div.Feedback_Message_Warning,
div.Feedback_Message_Success,
div.Feedback_Message_Info{
    position: relative;
    border: none; 
    border-radius: 8px;
    color: white;
    display: -moz-inline-box;/*FF2*/
    display: inline-block;
    *display: inline;
    *zoom: 1;/*IE7*/
    padding: 5px 18px 5px 5px;
    max-width: 800px;
    text-align: left;
    word-break: break-word;
    
    -webkit-box-shadow: 2px 0px 2px rgba(0, 0, 0, 0.498039);
    -moz-box-shadow: 2px 0px 2px rgba(0, 0, 0, 0.498039);
    box-shadow: 2px 0px 2px rgba(0, 0, 0, 0.498039);
}

div.Feedback_Message_Error {
    background-color: #BF1601;
}

div.Feedback_Message_Warning {
    background-color: #E88310;
}

div.Feedback_Message_Success {
    background-color: #76B501;
}

div.Feedback_Message_Info {
    background-color: #166BA5;
}

/* ExcludeAllFromPickersOutsideBlock */
```

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Feedback_Message1","source":"IWebBlock:Feedback_Message","as":"$b"}
```
