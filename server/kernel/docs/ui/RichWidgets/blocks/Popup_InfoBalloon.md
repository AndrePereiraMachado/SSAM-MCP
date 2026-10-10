# Popup_InfoBalloon

RichWidgets  | Traditional | UI flow **RichWidgets** | publico | 6 widgets internos

Displays the selected link on a pop-up balloon when hovering the link. 
Used for read-only information. 
If WidthPx and HeightPx are not specified the popup will auto-resize to contents. Not supported in mobile devices.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| LinkId | Text | sim |  | The link id to show in the pop-up. |
| WidthPx | Integer | nao | -1 | The width of the pop-up window. When not set it will automatically resize to fit contents. |
| HeightPx | Integer | nao | -1 | The height of the pop-up window. When not set it will automatically resize to fit contents. |

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: RichWidgetsjQueryUI

## JavaScript

JavaScript do bloco:

```js
//Open an Dialog
var RichWidgets_Popup_InfoBalloon_ShowTimeoutMilSecs = 200;
var RichWidgets_Popup_InfoBalloon_HideTimeoutMilSecs = 800;
var RichWidgets_Popup_InfoBalloon_InitialWidth = 220;
var RichWidgets_Popup_InfoBalloon_InitialHeight = 53;
var RichWidgets_Popup_InfoBalloon_Index = 4010;
var RichWidgets_Popup_InfoBalloon_ParentUrl;
var RichWidgets_Popup_InfoBalloon_Space = 4;

function RichWidgets_Popup_InfoBalloon_init(linkId, setHeight, setWidth, parentUrl) {
 outsystems.internal.$(function($) {
  var openTimer;
  var closeTimer;
  var callOut; 
  var cssTop;
  var cssleft;
  try  {
   linkId = '#' + linkId;
   RichWidgets_Popup_InfoBalloon_ParentUrl = parentUrl;

   //Checks if the id is from a link or not
   var linkHref = $(linkId).attr('href');

   //Tests for visibility/existence
   if (typeof linkHref== 'undefined') 
    throw ("Inexistent or Invisible link");
  } catch(e) {//Case the link is inexistent or invisible, it will show no errors.
   return;
  }

  if (linkHref == "" || linkHref == "#" || linkHref.indexOf("javascript:") == 0) {
      try {
         window.OsHandleException(new Error("Popup link id must be the id of a Link Widget with Method Navigate."), outsystems.osErrorCodes.SystemJavascriptError, 'Popup_InfoBalloon');
      } catch(e) {}
      return;
   } 

  //on click open popup
  var clickHandler = function() {
   if ($(linkId).data("Popup_InfoBalloonDiv"))
    return false;
   var popupDiv = $("<div style='text-align: center; display: none;'></div>").appendTo("body");
   popupDiv.append("<iframe width='100%' scrolling='auto' height='100%' frameborder='0'/>");
   var waitText =  " Please wait while content is loading...";
   var imgHTML = "<img style='border-width: 0px; height: 16px; width: 16px;' src='/RichWidgets/img/SpinBlack.gif'/>";
   var pleaseWaitDiv = popupDiv.prepend("<div style='margin-left:8px; margin-top:17px;' class='Text_Note'>" + imgHTML + waitText + "</div>")
   $(linkId).data("Popup_InfoBalloonDiv", popupDiv);
   $(popupDiv).data("Popup_InfoBalloonLink", linkId);
   
   $(popupDiv).hover(cancelCloseTimer, setCloseTimer);

   var pointerWidth = 17;
   var leftPos = $(linkId).offset().left + $(linkId).width() + pointerWidth - $(window).scrollLeft() + 4;
   
   var topPos =  0;
   if($(linkId)[0].children.length > 0){
       topPos = $($(linkId)[0].children[0]).offset().top - 20;
   } else {
       topPos = $(linkId).offset().top - 20;
   }

   //Checks if the infoBallon will apear in the left ou right side
   var center = $(linkId).offset().left + ($(linkId).width() / 2) - $(window).scrollLeft();
   var align = (($(window).width() / 2) > center) ? 'right': 'left';
   var iniWidth = (setWidth == -1) ? RichWidgets_Popup_InfoBalloon_InitialWidth: setWidth;
   var rightPos = (($(linkId).offset().left - $(window).scrollLeft() - 4 - pointerWidth) - iniWidth);
   
   if (callOut!= null) {
    callOut.remove();
    callOut = null;
   }
   
   if (align == 'right') 
    callOut = $("<img src='/RichWidgets/img/Popup_pointerLeft.gif' style='display:none'/>").appendTo($("body"));
   else
    callOut = $("<img src='/RichWidgets/img/Popup_pointerRight.gif' style='display:none'/>").appendTo($("body"));


   leftPos = (align == 'right') ? leftPos: rightPos;

   OpenPopup(popupDiv, leftPos, topPos, align);
  
   $(popupDiv).find('iframe').height(0);

   //load target page
   $(popupDiv).find('iframe').attr('src', $(linkId).attr('href'));
   $(popupDiv).find('iframe').load(function() {
    resizePopup(this, $(this).parents('div:eq(0)'), align);
   });
   popupDiv = null;
   pleaseWaitDiv = null;   
   return false;
  }
  
  outsystems.internal.registerClickInBothJQueries(linkId, clickHandler);
  
  //on click outside dialog, close it immediatly
  $(document).bind('click',
   function(event) {
    var target = $(event.target);
    if (target.is('.os-internal-ui-dialog') || target.parents('.os-internal-ui-dialog').length) {
     return;
    }
    if ($(linkId).data("Popup_InfoBalloonDiv")) {
     $(linkId).data("Popup_InfoBalloonDiv").dialog('close');
     $(linkId).removeData("Popup_InfoBalloonDiv");
    }
   });
   
  //on hover click link to open after timeout
  $(linkId).hover(
   function() {
    cancelCloseTimer();
    openTimer = window.setTimeout(function() {
     $(linkId).click()
    },
    RichWidgets_Popup_InfoBalloon_ShowTimeoutMilSecs);
   },
   function() { //on mouse out cancel timeout to click link to open
    clearTimeout(openTimer);
    setCloseTimer();
   });

  function OpenPopup(divToPopup, leftPos, topPos, alignI) {

   //destroy any previous dialog 
   $('.os-internal-ui-dialog-content').dialog('close');
   
   //Issue #542121 - in IE, the browser would "flick" when big (2x window height) vertical scroll was present
   // due to the "please wait" info balloon initial position
   // jquery ui would put it on top or bottom, depending on the version of IE (bug?)
   // the solution was to override the "using" function of the jquery ui
   var dialogPosition;
   if(navigator.appVersion.indexOf("MSIE") != -1) {
      dialogPosition = { 
        my: alignI == 'right'? 'left': alignI, 
        at: alignI == 'right'? alignI: 'left', 
        of: $(linkId), 
        using: function(props) {  
          $(this).css( {
            left : leftPos,
            top :  topPos
          }); 
        } 
      }
   }
  
   $(divToPopup).show();
      $('.os-internal-ui-dialog-titlebar').css("position","absolute");
   $('.os-internal-ui-dialog-titlebar-close').css("position","absolute");
   $(divToPopup).dialog({
    dialogClass: 'os-internal-Popup',
    resizable: false,
    autoResize: false,
    draggable: false,
    bgiframe: true,
    autoOpen: true,
    height: 28 + ((setHeight == -1) ? RichWidgets_Popup_InfoBalloon_InitialHeight: setHeight),
    width: ((setWidth == -1) ? RichWidgets_Popup_InfoBalloon_InitialWidth: setWidth),
    position: dialogPosition ? dialogPosition : [leftPos, topPos],
    zIndex: RichWidgets_Popup_InfoBalloon_Index,
    close: fu
/* ... truncado: 4864 chars a mais no JSON do catalogo */
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Popup_InfoBalloon1","source":"IWebBlock:Popup_InfoBalloon","as":"$b"}
{"op":"set","target":"$b/LinkId","prop":"Value","value":"<Text>"}
```
