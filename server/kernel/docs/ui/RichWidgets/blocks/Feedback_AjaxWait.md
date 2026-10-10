# Feedback_AjaxWait

RichWidgets  | Traditional | UI flow **RichWidgets** | publico | 8 widgets internos

Shows a message if Ajax calls take too much time to show.
This web block is often present in the footer of all screens.

## Inputs

Nenhum.

## Placeholders

Nenhum.

## Eventos

Nenhum.

## JavaScript

JavaScript do bloco:

```js
var RichWidgets_Feedback_AjaxWait_ajaxWaitMessageTimer;
var RichWidgets_Feedback_AjaxWait_Timeout = 200;

function RichWidgets_Feedback_AjaxWait_init(divId) {
 outsystems.internal.$(function($) {
  osAjaxBackend.BindBeforeAjaxRequest(function(){
    if(RichWidgets_Feedback_AjaxWait_ajaxWaitMessageTimer == null) {
       RichWidgets_Feedback_AjaxWait_ajaxWaitMessageTimer = setTimeout(function () { 
            $('#' + divId).fadeIn(); 
            $('body').addClass('Feedback_AjaxWait_CursorProgress');
        } , RichWidgets_Feedback_AjaxWait_Timeout);
      window.OsOnBeforeChange = function(){
       clearTimeout(RichWidgets_Feedback_AjaxWait_ajaxWaitMessageTimer);
       RichWidgets_Feedback_AjaxWait_ajaxWaitMessageTimer = null;
       $('body').removeClass('Feedback_AjaxWait_CursorProgress');
       $('#' + divId ).fadeOut();
      };
      function handlePageCleanup() {
          window.OsOnBeforeChange = null;
          window.removeEventListener("pagehide", handlePageCleanup);
      }
      window.addEventListener("pagehide", handlePageCleanup);
      osAjaxBackend.BindAfterAjaxRequest(function(){window.OsOnBeforeChange();});        
    }
  });
 });
}
```

## CSS

Classes: `.Feedback_AjaxWait`, `.Feedback_AjaxWait_CursorProgress`

```css
div.Feedback_AjaxWait {
	color: white;
    font-size: 16px;
	position: fixed;
	bottom: 0px;
	right: 0px;
    background-color: #FFD026;
	padding: 4px 10px 4px 10px;
	z-index: 10000;
    border-top-left-radius: 3px;
}

div.Feedback_AjaxWait img {
  vertical-align: bottom;
}

.Feedback_AjaxWait_CursorProgress,
.Feedback_AjaxWait_CursorProgress a,
.Feedback_AjaxWait_CursorProgress input {
    cursor: progress;
}

/* ExcludeAllFromPickersOutsideBlock */
```

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Feedback_AjaxWait1","source":"IWebBlock:Feedback_AjaxWait","as":"$b"}
```
