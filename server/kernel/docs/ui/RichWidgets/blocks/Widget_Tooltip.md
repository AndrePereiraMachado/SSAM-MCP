# Widget_Tooltip

RichWidgets  | Traditional | UI flow **Private** | privado | 5 widgets internos

Shows a tooltip when hovering a widget.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| WidgetId | Text | sim |  | The widget id to show the tooltip when hoovered. |
| HtmlOrText | Text | sim |  | The tooltip text to be shown. Rendered as an unescaped expression allowing you to use HTML tags in your text. |

## Placeholders

Nenhum.

## Eventos

Nenhum.

## JavaScript

JavaScript do bloco:

```js
 
var Widget_Tooltip_ShowTimeoutMilSecs = 100;
var Widget_Tooltip_HideTimeoutMilSecs = 500;

;(function($) {
 
  // the tooltip element
 var helper = {},
  // the current tooltipped element
  currentId,
  // timeout id for delayed tooltips
  showTimer,
  // timeout id for delayed tooltips
  hideTimer;
 
 $.tooltip = {
  blocked: false,
  defaults: {
   extraClass: "",
   top: 15,
   left: 15,
   id: "tooltip"
  },
  block: function() {
   $.tooltip.blocked = !$.tooltip.blocked;
  }
 };
 
 $.fn.extend({
  tooltip: function(settings) {
   settings = $.extend({}, $.tooltip.defaults, settings);
   createHelper(settings);
   helper.parent.hover(function(){clearTimeout(hideTimer)}, hideAfterDelay);  
   
   return this.each(function() {
     $.data(this, "tooltip", settings);
     this.tOpacity = helper.parent.css("opacity");
     $(this).removeAttr("title");
     // also remove alt attribute to prevent default tooltip in IE
     this.alt = "";
    })
    .hover(showAfterDelay, hideAfterDelay);
  },
  hideWhenEmpty: function() {
   return this.each(function() {
    $(this)[ $(this).html() ? "show" : "hide" ]();
   });
  },
  url: function() {
   return this.attr('href') || this.attr('src');
  }
 });

 function hideOnClickOutside(evt) {
  var target = $(evt.target);
  if (target.is('#tooltip') || target.parents('#tooltip').length>0 || '#' + target[0].id==currentId ||(currentId!=null && target.parents(currentId).length>0))
   return;
  if (currentId != '')
   hide.apply($(currentId)[0], arguments); 
  $("body").unbind('click', hideOnClickOutside);
 }
    
 function createHelper(settings) {
  // there can be only one tooltip helper
  if( helper.parent )
   return;
  // create the helper
  helper.parent = $('<div id="' + settings.id + '"><div class="body"></div></div>')
   // add to document
   .appendTo(document.body)
   // hide it at first
   .hide();
   
  // apply bgiframe if available
  if ( $.fn.bgiframe )
   helper.parent.bgiframe();

  helper.body = $('div.body', helper.parent);
 }
 
 function settings(element) {
  return $.data(element, "tooltip");
 }
 

 function hideAfterDelay() {
  clearTimeout(hideTimer);
  clearTimeout(showTimer);
  if (!currentId)
   return;
  var obj=$(currentId)[0];
  hideTimer = setTimeout(function() {hide.apply(obj, arguments)}, Widget_Tooltip_HideTimeoutMilSecs);
 }

 function showAfterDelay(evt) {
  clearTimeout(hideTimer);
  clearTimeout(showTimer);
  var obj = this;
  var ev = evt;
  showTimer = setTimeout(function() {setTooltipContents.apply(obj, [ev])}, Widget_Tooltip_ShowTimeoutMilSecs);

 }

 function show() {
  helper.parent.show();
  $("body").click(hideOnClickOutside);
  updatePosition();
 }
  
 function setTooltipContents(evt) {
  if (helper.parent.is(":visible"))
   hide.apply(this, arguments);

  // if this is the current source, or it has no title (occurs with click event), stop
  if ( $.tooltip.blocked || this.id == currentId)
   return;

  // save current
  currentId = "#" + this.id;


  var bodyContent = settings(this).bodyHandler.call(this);
  if (bodyContent.nodeType || bodyContent.jquery) {
   helper.body.empty().append(bodyContent)
  } else {
   helper.body.html( bodyContent );
  }
  helper.body.show();
  
  
  // add an optional class for this tip
  helper.parent.addClass(settings(this).extraClass);

  
  show.apply(this, arguments);
  // updatePosition at least once
  updatePosition(evt);
 }


 

 function updatePosition(evt) {
  if($.tooltip.blocked)
   return;
  
  if (evt && evt.target.tagName == "OPTION") {
   return;
  }
  
  
  // if no current element is available, remove this listener
  if( currentId == null ) {
   return; 
  }

  
  // remove position helper classes
  helper.parent.removeClass("viewport-right").removeClass("viewport-bottom");
  
  
  var left = helper.parent[0].offsetLeft;
  var top = helper.parent[0].offsetTop;
  if (evt) {
   // position the helper 15 pixel to bottom right, starting from mouse position
   left = evt.pageX + settings($(currentId)[0]).left;
   top = evt.pageY + settings($(currentId)[0]).top;
   var right='auto';
   if (($(window).width() - 450) < (left  - $(window).scrollLeft())) {
    right = $(window).width() - left;
    left = 'auto';
   }
   helper.parent.css({
    left: left,
    right: right,
    top: top
   });
  }
  
  var v = viewport(),
   h = helper.parent[0];
  // check horizontal position
  if (v.x + v.cx < h.offsetLeft + h.offsetWidth && left != "auto") {
   left -= h.offsetWidth + 20 + settings($(currentId)[0]).left;
   helper.parent.css({left: left + 'px'}).addClass("viewport-right");
  }
  // check vertical position
  if ((v.y + v.cy < h.offsetTop + h.offsetHeight) && (h.offsetTop > h.offsetHeight)) {
   top -= h.offsetHeight + 20 + settings($(currentId)[0]).top;
   helper.parent.css({top: top + 'px'}).addClass("viewport-bottom");
  }
  if (helper.parent.is(":visible"))
   helper.parent.queue( function() {$(this).dropShadow({left:2, top:2});$(this).dequeue();})
 }
 
 function viewport() {
  return {
   x: $(window).scrollLeft(),
   y: $(window).scrollTop(),
   cx: $(window).width(),
   cy: $(window).height()
  };
 }
 
 // hide helper and restore added classes
 function hide(evt) {
  if($.tooltip.blocked)
   return;

  // no more current element
  currentId = null;
  
  var tsettings = settings(this);
  helper.parent.removeClass( tsettings.extraClass ).hide().css("opacity", "");
  
  $("body").unbind('click',hideOnClickOutside);
 }
 
})(outsystems.internal.$);



function RichWidgets_Widget_Tooltip(widgetId, HTMLTooltipText){
 outsystems.internal.$(function($){
  HTMLTooltipText = HTMLTooltipText.match(/<[^<>]+>/)? HTMLTooltipText: HTMLTooltipText.replace(/\n/g,"<br>\n");
  $('#' + widgetId).tooltip(
   { bodyHandler: function() { return HTMLTooltipText;  }
   , extraClass:'Widget_Tooltip'});
 });
}
```

## CSS

Classes: `.Widget_Tooltip`, `.clientWidth`, `.Help_Screen`, `.Help_Context`

```css
div.Widget_Tooltip {
	position: absolute;
	z-index: 3000;
	border: 1px solid #888888;
	background-color: #FFFCA9;
	color: #555555;
	padding: 8px;
	max-width: 400px;
	_width: expression(this.clientWidth>400?"400px":"auto");
}

div.Help_Screen {
	cursor:default;
	width:120px;
	float:right;
	text-align:right;
}
div.Help_Context {
	display:inline;
}

div.Help_Context:hover img,
div.Help_Screen:hover img {
	opacity:1;
	filter:none;
}

div.Help_Context img,
div.Help_Screen img {
	opacity:0.70;
	filter:alpha(opacity=70);
	_filter:none; /* IE6 */
}

/* ExcludeAllFromPickersOutsideBlock */
```

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Widget_Tooltip1","source":"IWebBlock:Widget_Tooltip","as":"$b"}
{"op":"set","target":"$b/WidgetId","prop":"Value","value":"<Text>"}
{"op":"set","target":"$b/HtmlOrText","prop":"Value","value":"<Text>"}
```
