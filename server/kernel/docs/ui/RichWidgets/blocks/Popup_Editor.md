# Popup_Editor

RichWidgets  | Traditional | UI flow **RichWidgets** | publico | 9 widgets internos

[DEPRECATED] Opens the specified link on a modal pop-up that can have editable screens.
Actions PopUpEditor_Close and PopUpEditor_Notify can be used to send information to the parent screen.
If WidthPx and HeightPx are not specified the popup will auto-resize to contents. 
Refresh the pop-up whenever the link is refreshed to keep them working accordingly.
Not supported in mobile devices.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| LinkOrButtonWidgetId | Text | sim |  | The link or button id to open in the pop-up. |
| Title | Text | nao | " " | Title for the pop-up window. |
| WidthPx | Integer | nao | -1 | The width of the pop-up window. When not set it will automatically resize to fit contents. |
| HeightPx | Integer | nao | -1 | The height of the pop-up window. When not set it will automatically resize to fit contents. |
| AutoResize | Boolean | nao | True | When set to True, the popup will be resized after each Ajax refresh. The default is True. |
| RecenterOnResize | Boolean | nao | False | When set to True, the popup will be recentered when it is resized after an Ajax refresh. The default is False. |
| HideCloseButton | Boolean | nao | False |  |

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: Popup_Editor_WithToken, Popup_Editor_Legacy
- Actions do bloco: FakeOnNotify
- Chama actions do modulo: Deprecated_Notify, Deprecated_NotifyGetMessage (contratos em [actions.md](../actions.md))

## JavaScript

JavaScript do bloco:

```js
//Open an Dialog
var RichWidgets_Popup_Editor_ShowTimeoutMilSecs = 200;
var RichWidgets_Popup_Editor_HideTimeoutMilSecs = 800;
var RichWidgets_Popup_Editor_InitialWidth = 210;
var RichWidgets_Popup_Editor_InitialHeight = 100;
var RichWidgets_Popup_Editor_notifyWidget;
var RichWidgets_Popup_Editor_Index = 4010;
var RichWidgets_Popup_Editor_ParentUrl;
var RichWidgets_Popup_Editor_ClosingTag = 'closing';
var RichWidgets_Popup_Editor_ClosingValue = 'true';

function RichWidgets_Popup_Editor_init(linkId, notifyId, setTitle, setHeight, setWidth, parentUrl, useModal, autoResize, recenterOnResize, hideCloseButton) {
 var GetLinkHref = function(widget) {
    var linkHref;
    var isAButton = false;
    try {
    //Checks if the id is from a link or not
    linkHref = outsystems.internal.$(widget).attr('href');

    //Tests for visibility/existence
    if (typeof linkHref == 'undefined') {
      var onClick = widget.getAttribute('onclick');
      if (typeof onClick != 'undefined') {
        isAButton = true;
        if (onClick != null) {
          var hrefMatch;
          if((hrefMatch = onClick.toString().match(/href='([^']*)'/)) != null) {
                linkHref = hrefMatch[1];
          }
        }
      }
    } //else: throw ("Inexistent or Invisible button");
   } catch(e) {}
  
   return [linkHref, isAButton];
 }

 outsystems.internal.$().ready(function($) {
  linkId = '#' + linkId;
  var linkWidget;
  try { linkWidget = $(linkId).get(0); } catch(e) {}
  if (typeof linkWidget == 'undefined') {
    //Case the widget is inexistent or invisible, it will show no errors.
    return;
  }
  
  RichWidgets_Popup_Editor_ParentUrl = parentUrl;
  
  var getLinkResult = GetLinkHref(linkWidget);
  var linkHref = getLinkResult[0];
  var isAButton = getLinkResult[1];

  if (typeof linkHref == 'undefined' || linkHref == "" || linkHref == "#" || linkHref.indexOf("javascript:") == 0) {
   try {
       window.OsHandleException(new Error("Popup link id must be the id of a Link or Button Widget with Method Navigate."), outsystems.osErrorCodes.SystemJavascriptError, 'Popup_Editor');
   } catch(e) {}
   return;
 } 

  if (isAButton) {
    //remove the existing on-click
    linkWidget.setAttribute('onclick', linkWidget.getAttribute('onclick').toString().replace('window.location.href=', 'return false;window.location.href='));
  }

  // if there's a confirmation message, store in an attribute the result
  if (linkWidget.getAttribute('onclick') != null) {
    linkWidget.setAttribute('onclick', linkWidget.getAttribute('onclick').toString().replace("if( ret != true )", "outsystems.internal.$('" + linkId + "').get(0).setAttribute('confirmed', ret); if( ret != true )"));
  }

  var clickHandler = function(event) {
  
    //The clickHandler event is registered in osjs and outsystems.internal.$ for compatibillity reasons, they must not run both for the same click.
    //Variable is set to false in RichWidgets_Popup_Editor_resize function.
    if(outsystems.internal.$.data(event.target,"os-internal-processing") == true){
        return false;
    } else {
        outsystems.internal.$.data(event.target,"os-internal-processing", true);
    }
  
   //Check if the clicked link is disabled
   if(linkWidget.getAttribute('disabled') != null){
       var linkDisabled = linkWidget.getAttribute('disabled').toString().toLowerCase();
       if(linkDisabled == 'disabled' || linkDisabled.indexOf('true') != -1){
        return false;
       }
   }

   if (linkWidget.getAttribute("confirmed") == 'false') {
     outsystems.internal.$.data(event.target,"os-internal-processing", false);
     return false;
   }
   if (OsIsIE()) {
     osFocusBackend.ClearFocusedElement();
   }
   var popupDiv = $("<div style='text-align: center; display: none;'></div>").appendTo("body");
   popupDiv.append('<iframe width="100%" scrolling="auto" height="100%" frameborder="0" src="javascript:void(0);"/>');
   var waitText =  " Please wait while content is loading...";
   var imgHTML = "<img style='border-width: 0px; height: 16px; width: 16px;' src='/RichWidgets/img/SpinBlack.gif'/>";
   var pleaseWaitDiv = popupDiv.prepend("<div style='margin-top: 25px;' class='Text_Note'>" + imgHTML + waitText + "</div>")

   var loadTargetPage = function () {
      RichWidgets_Popup_Editor_notifyWidget = notifyId;
       //load target page
       var ohref = GetLinkHref(linkWidget)[0];
       var rhref = ohref.replace(/(\?|&)_=.*?(&|$)/, "$1_=" + (+ new Date().now) + "$2"); 
       var xhref = rhref + ((rhref == ohref) ? (rhref.indexOf('?') >= 0 ? "&" : "?") + "_=" + (+new Date) : ''); 
       popupDiv.find('iframe').attr('src', xhref); 
       (function(popupDiv) {
           popupDiv.find('iframe').load(function() {
               //after loading try to resize, if it is possible resize also after each ajax call
               if(RichWidgets_Popup_Editor_resize(popupDiv, setWidth, setHeight, true, event)) {
                   if (autoResize) {
                      var contentWindow = this.contentWindow;
                      contentWindow.osAjaxBackend.BindAfterAjaxRequest(function(){
                        contentWindow.parent.RichWidgets_Popup_Editor_resize(popupDiv, setWidth, setHeight, recenterOnResize, event);
                      });
                   }
               }   
           });
       })(popupDiv);
       popupDiv = null;
       pleaseWaitDiv = null;
   }

   OpenPopup(popupDiv, setTitle, setHeight, setWidth, pleaseWaitDiv, hideCloseButton, loadTargetPage, event);

   return false;
  };
  
  outsystems.internal.registerClickInBothJQueries(linkId, clickHandler);

  function OpenPopup(divToPopup, setTitle, setHeight, setWidth, divPleaseWait, hideCloseButton, loadTargetPage, event) {
   //destroy any previous dialog 
   RichWidgets_Popup_Editor_Close(null);
   // if any close is pending, schedule to execute itself asynchronously exit
   // if no close is pending, continue with open operation
   var closingPopups = $('.os-internal-ui-dialog-content');
   fo
/* ... truncado: 17604 chars a mais no JSON do catalogo */
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Popup_Editor1","source":"IWebBlock:Popup_Editor","as":"$b"}
{"op":"set","target":"$b/LinkOrButtonWidgetId","prop":"Value","value":"<Text>"}
```
