# Input_Calendar

RichWidgets  | Traditional | UI flow **RichWidgets** | publico | 11 widgets internos

Shows a calendar when clicking the selected Input widget. 
Uses the open source calendar available at http://www.dynarch.com/projects/calendar/.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| InputWidgetId | Text | sim |  | The 'Id' runtime property of the Input widget where the calendar widget is shown up. |
| MinYear | Integer | nao | -1 | The calendar will only display the years in the range [MinYear, MaxYear] |
| MaxYear | Integer | nao | -1 | The calendar will only display the years in the range [MinYear, MaxYear] |
| Align | Text | nao | "Bl" | A 2-characters string used to set the vertical & horizontal alignment of the calendar.  The first character is the vertical alignment and can take one of the following values:     T - completely above the reference element (bottom margin of the calendar aligned to the top margin of the element).     t - above the element but may overlap it (bottom margin of the calendar aligned to the bottom margin of the element).     c - the calendar displays vertically centered to the reference element. It might overlap it (that depends on the horizontal alignment).      b - below the element but may overlap it (top margin of the calendar aligned to the top margin of the element).     B - completely below the element (top margin of the calendar aligned to the bottom margin of the element).  The second character is the horizontal alignment and can take one of the following values:     L - completely to the left of the reference element (right margin of the calendar aligned to the left margin of the element).     l - to the left of the element but may overlap it (left margin of the calendar aligned to the left margin of the element).     c - horizontally centered to the element. Might overlap it, depending on the vertical alignment.     r - to the right of the element but may overlap it (right margin of the calendar aligned to the right margin of the element).     R - completely to the right of the element (left margin of the calendar aligned to the right margin of the element). |
| SingleClick | Boolean | nao | True | If true, the date will be selected on the first click. If false, a double-click is required. |
| ShowWeekNumbers | Boolean | nao | False | If True, the week numbers (1-52) are displayed. |
| UpdateOnCloseOnly | Boolean | nao | False | If True, the date in the Input widget is updated only when the calendar is closed. |
| ShowOthers | Boolean | nao | False | If True, displays days adjacent to the currently selected month. |
| FirstDay | Integer | nao |  | Sets the first day of the week (0 is Sunday, 1 is Monday, etc.) |
| ShowTime | Boolean | nao | False | If True, displays hours and minutes. |
| Show24HourFormat | Boolean | nao | True | If true, displays a 24-hour clock. |
| ReuseCalendarObject | Boolean | nao | False | The javascript object is not re-created each time the calendar is opened. |
| InitialDate | Date Time | nao |  | If set, the calendar will initially display this date. |
| DateFormat | Text | nao | "" | Defaults to the date format defined in the server configuration. The defaults are "%Y-%m-%d" for Date and "%Y-%m-%d %H:%M:%S" for DateTime Supported date formats:     %a abbreviated weekday name     %A full weekday name     %b abbreviated month name     %B full month name     %C century number     %d the day of the month ( 00 .. 31 )     %e the day of the month ( 0 .. 31 )     %H hour ( 00 .. 23 )     %I hour ( 01 .. 12 )     %j day of the year ( 000 .. 366 )     %k hour ( 0 .. 23 )     %l hour ( 1 .. 12 )     %m month ( 01 .. 12 )     %M minute ( 00 .. 59 )     %n a newline character     %p "PM" or "AM"     %P "pm" or "am"     %S second ( 00 .. 59 )     %s number of seconds since Epoch (since Jan 01 1970 00:00:00 UTC)     %t a tab character     %U, %W, %V the week number5     %u the day of the week ( 1 .. 7, 1 = MON )     %w the day of the week ( 0 .. 6, 0 = SUN )     %y year without the century ( 00 .. 99 )     %Y year including the century ( ex. 1979 )     %% a literal % character |
| SpecialDays | Text | nao | "" | String containing the days to be displayed differently. Example: " 1 : [ 13, 24 ],  // January 3 : [ 1, 6, 8, 12, 18 ], // March 9 : [ 21, 11 ],  // September 10 : [ 6 ], // October 12 : [ 25, 31 ]  // December " |
| OnUpdate | Text | nao |  | The function that is called after the date is updated in the Input widget. Receives a reference to the calendar. |
| FlatStyle | Boolean | nao | False | If true, the calendar will be displayed inline and not as a popup. When set to true, only the following parameters are meaningful:     MinYear     MaxYear     InputField     ShowWeekNumbers     ShowOthers     FirstDay     ShowTime     Show24HourFormat     InitialDate     DateFormat     SpecialDays |
| ButtonWidgetId | Text | nao |  | The Id of a button that will popup the calendar |
| YearStep | Integer | nao | 2 | The interval of years that will be used for jumping through several years at once (click and hold on the Next/Previous year button). Defaults to 2. |

## Placeholders

Nenhum.

## Eventos

Nenhum.

## JavaScript

JavaScript do bloco:

```js
/*  Copyright Mihai Bazon, 2002-2005  |  www.bazon.net/mishoo
 * -----------------------------------------------------------
 *
 * The DHTML Calendar, version 1.0 "It is happening again"
 *
 * Details and latest version at:
 * www.dynarch.com/projects/calendar
 *
 * This script is developed by Dynarch.com.  Visit us at www.dynarch.com.
 *
 * This script is distributed under the GNU Lesser General Public License.
 * Read the entire license text here: http://www.gnu.org/licenses/lgpl.html
 *
 * Changes by OutSystems performed on the original code.
 */

// $Id: calendar.js,v 1.51 2005/03/07 16:44:31 mishoo Exp $

/** The Calendar object constructor. */
(function() {
var Calendar = function (firstDayOfWeek, dateStr, onSelected, onClose) {
 // member variables
 this.activeDiv = null;
 this.currentDateEl = null;
 this.getDateStatus = null;
 this.getDateToolTip = null;
 this.getDateText = null;
 this.timeout = null;
 this.onSelected = onSelected || null;
 this.onClose = onClose || null;
 this.dragging = false;
 this.hidden = false;
 this.minYear = 1970;
 this.maxYear = 2050;
 this.dateFormat = Calendar._TT["DEF_DATE_FORMAT"];
 this.ttDateFormat = Calendar._TT["TT_DATE_FORMAT"];
 this.isPopup = true;
 this.weekNumbers = true;
 this.firstDayOfWeek = typeof firstDayOfWeek == "number" ? firstDayOfWeek : Calendar._FD; // 0 for Sunday, 1 for Monday, etc.
 this.showsOtherMonths = false;
 this.dateStr = dateStr;
 this.ar_days = null;
 this.showsTime = false;
 this.time24 = true;
 this.yearStep = 2;
 this.hiliteToday = true;
 this.multiple = null;
 // HTML elements
 this.table = null;
 this.element = null;
 this.tbody = null;
 this.firstdayname = null;
 // Combo boxes
 this.monthsCombo = null;
 this.yearsCombo = null;
 this.hilitedMonth = null;
 this.activeMonth = null;
 this.hilitedYear = null;
 this.activeYear = null;
 // Information
 this.dateClicked = false;

 // one-time initializations
 if (typeof Calendar._SDN == "undefined") {
  // table of short day names
  if (typeof Calendar._SDN_len == "undefined")
   Calendar._SDN_len = 3;
  var ar = new Array();
  for (var i = 8; i > 0;) {
   ar[--i] = Calendar._DN[i].substr(0, Calendar._SDN_len);
  }
  Calendar._SDN = ar;
  // table of short month names
  if (typeof Calendar._SMN_len == "undefined")
   Calendar._SMN_len = 3;
  ar = new Array();
  for (var i = 12; i > 0;) {
   ar[--i] = Calendar._MN[i].substr(0, Calendar._SMN_len);
  }
  Calendar._SMN = ar;
 }
};

// ** constants

/// "static", needed for event handlers.
Calendar._C = null;

/// detect a special case of "web browser"
Calendar.is_ie = ( /msie/i.test(navigator.userAgent) &&
     !/opera/i.test(navigator.userAgent) );

Calendar.is_ie5 = ( Calendar.is_ie && /msie 5\.0/i.test(navigator.userAgent) );

/// detect Opera browser
Calendar.is_opera = /opera/i.test(navigator.userAgent);

/// detect KHTML-based browsers
Calendar.is_khtml = false;

// BEGIN: UTILITY FUNCTIONS; beware that these might be moved into a separate
//        library, at some point.

Calendar.getAbsolutePos = function(el) {
 if (typeof(outsystems.internal.$) != 'undefined') {
  Calendar.getAbsolutePos = function(el) {
   var o = outsystems.internal.$(el).offset();
   return { x: o.left, y: o.top };
  };
  return Calendar.getAbsolutePos(el);
 } else {
  Calendar.getAbsolutePos = function(el) {
   var SL = 0, ST = 0;
   var is_div = /^div$/i.test(el.tagName);
   if (is_div && el.scrollLeft)
    SL = el.scrollLeft;
   if (is_div && el.scrollTop)
    ST = el.scrollTop;
   var r = { x: el.offsetLeft - SL, y: el.offsetTop - ST };
   if (el.offsetParent) {
    var tmp = this.getAbsolutePos(el.offsetParent);
    r.x += tmp.x;
    r.y += tmp.y;
   }
   return r;
  };
  return Calendar.getAbsolutePos(el);
 }
};

Calendar.isRelated = function (el, evt) {
 var related = evt.relatedTarget;
 if (!related) {
  var type = evt.type;
  if (type == "mouseover") {
   related = evt.fromElement;
  } else if (type == "mouseout") {
   related = evt.toElement;
  }
 }
 while (related) {
  if (related == el) {
   return true;
  }
  related = related.parentNode;
 }
 return false;
};

Calendar.removeClass = function(el, className) {
 if (!(el && el.className)) {
  return;
 }
 var cls = el.className.split(" ");
 var ar = new Array();
 for (var i = cls.length; i > 0;) {
  if (cls[--i] != className) {
   ar[ar.length] = cls[i];
  }
 }
 el.className = ar.join(" ");
};

Calendar.addClass = function(el, className) {
 Calendar.removeClass(el, className);
 el.className += " " + className;
};

// FIXME: Consider replacing the following 2 functions 
Calendar.getElement = function(ev) {
 var f = Calendar.is_ie ? window.event.srcElement : ev.currentTarget;
 while (f.nodeType != 1 || /^div$/i.test(f.tagName))
  f = f.parentNode;
 return f;
};

Calendar.getTargetElement = function(ev) {
 var f = Calendar.is_ie ? window.event.srcElement : ev.target;
 while (f.nodeType != 1)
  f = f.parentNode;
 return f;
};

Calendar.stopEvent = function(ev) {
 ev || (ev = window.event);
 if (Calendar.is_ie) {
  ev.cancelBubble = true;
  ev.returnValue = false;
 } else {
  ev.preventDefault();
  ev.stopPropagation();
 }
 return false;
};

Calendar.addEvent = function(el, evname, func) {
 if (el.attachEvent) { // IE
  el.attachEvent("on" + evname, func);
 } else if (el.addEventListener) { // Gecko / W3C
  el.addEventListener(evname, func, true);
 } else {
  el["on" + evname] = func;
 }
};

Calendar.removeEvent = function(el, evname, func) {
 if (el.detachEvent) { // IE
  el.detachEvent("on" + evname, func);
 } else if (el.removeEventListener) { // Gecko / W3C
  el.removeEventListener(evname, func, true);
 } else {
  el["on" + evname] = null;
 }
};

Calendar.createElement = function(type, parent) {
 var el = null;
 if (document.createElementNS) {
  // use the XHTML namespace; IE won't normally get here unless
  // _they_ "fix" the DOM2 implementation.
  el = document.createElementNS("http://www.w3.org/1999/xhtml", type);
 } else {
  el = document.createElement(type);
 }
 if (typeof parent 
/* ... truncado: 59577 chars a mais no JSON do catalogo */
```

## CSS

Classes: `.calendar`, `.button`, `.wn`, `.notclose`, `.nav`, `.title`, `.name`, `.weekend`, `.hilite`, `.active`, `.day`, `.othermonth`, `.oweekend`, `.rowhilite`, `.daynames`, `.selected`, `.disabled`, `.emptycell`, `.emptyrow`, `.combo`, `.label`, `.label-IEfix`, `.time`, `.hour`, `.minute`, `.ampm`, `.colon`, `.special`, `.footrow`, `.ttip`, `.calendarContainer`

Variaveis: `---`

```css
div.calendar table,
div.calendar td,
div.calendar textarea,
div.calendar img {
    vertical-align: middle;
}

div.calendar {
    position: relative;
    z-index: 2;
}

div.calendar,
div.calendar table {
    font-size: 12px;
    cursor: default;
    background-color: white;
    border-collapse: collapse;
}

div.calendar table{
    border: 1px solid #ccc;
    -webkit-border-radius: 2px;
    -moz-border-radius: 2px;
    border-radius: 2px;
    -webkit-box-shadow: 1px 3px 4px 1px rgba(0,0,0,0.1);
    box-shadow: 1px 3px 4px 1px rgba(0,0,0,0.1);
}

div.calendar .button {
    background: #e8e8e8;
    text-align: center;
    padding: 2px;
    display: table-cell;
}

div.calendar table .wn {
    background: #fff;
    border: 1px solid #fff;
    border-right: 1px solid #666;
    padding: 2px 4px 3px 3px;
}

div.calendar thead .button.notclose {
    color: #666;
    line-height: 1;
}

div.calendar .nav {
}

div.calendar thead .title {
    background: #e8e8e8;
    font-size: 11px;
    line-height: 1;
    color: #666;
    text-align: center;
    padding: 2px;
    width: auto;
}

div.calendar thead td[colspan="6"] + td[colspan="1"] {
    font-size: 14px;
}
 
div.calendar thead td[colspan="3"] {
    font-size: 11px;
}


div.calendar thead .name {
    font-weight: 700;
    text-align: center;
    color: #000;
    padding: 5px 2px;
}

div.calendar thead .weekend {
    color: #999;
}

div.calendar thead .hilite {
     color: #666;
}

div.calendar thead .button.notclose.hilite {
    background: #d8d8d8;
}

div.calendar thead .active {
     color: #333;
}

div.calendar thead .active.notclose {
     padding: 3px 1px 0px 3px;
}

div.calendar tbody .day {
    background: #fff;
    color: #555;
    text-align: right;
    padding: 3px 8px 2px 8px;
}

div.calendar tbody .day.othermonth {
    font-size: 1.5em;
    background-color: white;
    color: black;
    font-style: italic;
}

div.calendar tbody .day.othermonth.oweekend {
    background: #fff;
    color: #a0a0a0;
}

div.calendar tbody td.active.day.othermonth,
div.calendar tbody th.active.day.othermonth {
    background: #333;
}

div.calendar tbody .rowhilite td.hilite.day.othermonth,
div.calendar tbody .rowhilite th.hilite.day.othermonth {
    background: #fff;
}

div.calendar tbody .rowhilite td.day.othermonth,
div.calendar tbody .rowhilite th.day.othermonth {
}

div.calendar .daynames .wn {
    border: 1px solid #EAEAEA;
    border-right: 1px solid #666;
    border-bottom: 1px solid #ccc;
}


div.calendar tbody .rowhilite td.selected,
div.calendar tbody .rowhilite th.selected {
    background: #006699;
}
 /* DEEP BLUE **/
div.calendar tbody .rowhilite td.wn,
div.calendar tbody .rowhilite th.wn {
    background: #fff;
    border: 1px solid #ccc;
}

div.calendar tbody td.hilite,
div.calendar tbody th.hilite {
    background: #d0e4ff;
     color: #333;
}

div.calendar tbody td.active,
div.calendar tbody th.active {
    background: #333;
    color: #fff;
}
 
div.calendar tbody td.weekend,
div.calendar tbody th.weekend {
    color: #a0a0a0;
}

div.calendar tbody td.selected,
div.calendar tbody th.selected {
    background: #006699;
    color: #fff;
}

div.calendar tbody .disabled {
}

div.calendar tbody .emptycell {
    background: #fff;
}

div.calendar tbody .emptyrow {
    display: none;
}


div.calendar .combo {
    position: absolute;
    display: none;
    top: 0;
    left: 0;
    font-size: 90%;
    width: 4em;
    cursor: default;
    background: #fff;
    border: 1px solid #ccc;
    color: #000;
    z-index: 100;
    font-size: 90%;
}

div.calendar .combo .label,
div.calendar .combo .label-IEfix {
    text-align: center;
    padding: 1px;
}

div.calendar .combo .label-IEfix {
    width: 4em;
}

div.calendar .combo .hilite {
    background: #b7d6ff;
    color: #666;
}

div.calendar .combo .active {
    background: #006699;
    color: #fff;
}

div.calendar td.time,
div.calendar th.time {
    text-align: center;
    color: #333;
    padding: 3px 0 1px;
}

div.calendar td.time[colspan="2"] {
    text-align: right;
}

div.calendar td.time .hour,
div.calendar th.time .hour,
div.calendar td.time .minute,
div.calendar th.time .minute,
div.calendar td.time .ampm,
div.calendar th.time .ampm {
    font-weight: bold;
    color: #000;
    padding: 0 5px 0 6px;
}

div.calendar td.time .ampm,
div.calendar th.time .ampm {
    text-align: center;
}

div.calendar td.time .colon,
div.calendar th.time .colon {
    font-weight: 700;
    padding: 0 2px 0 3px;
}

div.calendar td.time span.hilite,
div.calendar th.time span.hilite {
    background: #fff;
    color: #000;
}

div.calendar td.time span.active,
div.calendar th.time span.active {
    background: #333;
    color: white;
}

div.calendar td.special,
div.calendar th.special {
    background-color: #efefef;
    border: 1px solid #ccc;
}

div.calendar tbody td.hilite.special,
div.calendar tbody th.hilite.special {
    background: #fff;
    padding: 2px 4px 2px 2px;
}

div.calendar .rowhilite td.special,
div.calendar .rowhilite th.special {
    background-color: #efefef;
}


/* --- CALENDAR FOOTER --- */
div.calendar tfoot .footrow {
    text-align: center;
}

div.calendar tfoot .ttip {
    font-size: 11px;
    background: #e8e8e8;
    color: #777;
    padding: 3px 2px;
}

div.calendar tfoot .hilite {
    background: #fff;
    border: 1px solid #666;
    color: #000;
    padding: 1px;
}

div.calendar tfoot .active {
    background: #333;
    color: white;
    padding: 2px 0 0 2px;
}

.calendarContainer {
    position: relative;
    width: 200px;
}

.calendarContainer table {
    width: 100%;    
}

/* ExcludeAllFromPickersOutsideBlock */
```

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Input_Calendar1","source":"IWebBlock:Input_Calendar","as":"$b"}
{"op":"set","target":"$b/InputWidgetId","prop":"Value","value":"<Text>"}
```
