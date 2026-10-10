# Tabs_ClientSide

RichWidgets  | Traditional | UI flow **RichWidgets** | publico | 5 widgets internos

Allows the selective display of content using a tab interface.
Put this web block inside a container together with other containers, and the ones with the 'Display' property set to true and the 'title' extended property defined will become tabs.
The outer container must have the style 'Tabs_Wrapper', and the inner containers must have the style 'Tabs_TabBody'.
The value of the 'title' extended property will become the caption of each tab.
You can also set the 'enabled' extended property to 'false' to disable some of the tabs.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| InitialActiveTab | Text | nao | "" | The Id or the title extended property of the tab that will be activated when the screen is first loaded. If there is more than one tab with the same title, the first one is used. Defaults to the first tab. |
| RememberActiveTab | Boolean | nao | False | When set to True, and the InitialActiveTab parameter is not specified, when the screen is first loaded the tab that will be active will be the one that last tab that was active during the same session. Defaults to False. |
| OnLoading | Text | nao | "" | The JavaScript to be called before the rendering of the tab controller. |
| OnLoaded | Text | nao | "" | The JavaScript to be called after the rendering of the tab controller. |
| OnTabActivation | Text | nao | "" | The JavaScript to be called when the active tab changes. Receives a parameter named 'title' with the title of the active tab. |
| IgnoreErrors | Boolean | nao | False | When set to True, disables the display of error messages. |

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Chama actions do modulo: SetCookie (contratos em [actions.md](../actions.md))

## JavaScript

JavaScript do bloco:

```js
var RichWidgets_Tabs_ClientSide_onTabDisplayFunctions = new Array(); 
var RichWidgets_Tabs_ClientSide_containerIds = new Array(); 
var RichWidgets_Tabs_ClientSide_onTabShowFunction = null; 

function RichWidgets_Tabs_ClientSide_setInnerText(obj, text) {
    obj.innerText = text;
    obj.textContent = text;
}

function Tabs_ClientSide_Invalid_Use(header) {
    var errorElement = document.createElement("p");
    RichWidgets_Tabs_ClientSide_setInnerText(errorElement, "Invalid use of RichWidgets\\Tabs_ClientSide: The Tabs_ClientSide web block must be placed inside a container.");
    errorElement.style.color = "red";
    containerDiv.replaceChild(errorElement, header);
}

function RichWidgets_Tabs_ClientSide_bootstrap(headerId, blockRuntimeId, initialTab, onLoading, onLoaded, onTabDisplay, pageName, displayErrors) {
    var header = document.getElementById(headerId);
    var containerDiv = outsystems.internal.$(header).closest("div.Tabs_Wrapper")[0];
    
    if (typeof containerDiv == "undefined" ) {
        if (displayErrors) {
            Tabs_ClientSide_Invalid_Use(header);
        }
        return;
    }
    containerDiv.style.display = "none";

    var initFunc = new Function("RichWidgets_Tabs_ClientSide_init('" + headerId + "', '" + blockRuntimeId + "', '" + initialTab + "', '" + escape(onLoading) + "', '" + escape(onLoaded) + "', '" + escape(onTabDisplay) + "', '" + pageName + "', " + (displayErrors ? 'true' : 'false') + ");");

    outsystems.internal.$(initFunc);
}

function RichWidgets_Tabs_ClientSide_init(headerId, blockRuntimeId, initialTab, onLoading, onLoaded, onTabDisplay, pageName, displayErrors) {
    var header = document.getElementById(headerId);
    var containerDiv = outsystems.internal.$(header).closest("div.Tabs_Wrapper")[0];
    
    if (typeof containerDiv == "undefined" ) {
        if (displayErrors) {
            Tabs_ClientSide_Invalid_Use(header);
        }
        return;
    }
    var containerId = containerDiv.id;
    if (containerId == "" || containerId == undefined) {
        containerDiv.id = headerId + "_container";
        containerId = containerDiv.id;
    }

    RichWidgets_Tabs_ClientSide_onTabDisplayFunctions[pageName + ":" + blockRuntimeId] = new Function("title", unescape(onTabDisplay)); 
    RichWidgets_Tabs_ClientSide_containerIds[pageName + ":" + blockRuntimeId] = containerId; 

    var onLoadingFunc = new Function("containerDiv", unescape(onLoading));
    onLoadingFunc(containerDiv);

    var children = RichWidgets_Tabs_ClientSide_getImmediateDivDescendants(containerDiv); 
    var pos = 0;
    var initialTabPos = null;
    var firstTabPos = null;
    var lastTabPos = null;
    var html = "";
    var tabCount = 0;
    while (pos < children.length) {
    
        var childDiv = children[pos];
        if (childDiv.style.display != "none") {
        
            if (childDiv.title == "") {
            
                childDiv.style.display = "none";
                
            } else {
            
                if (childDiv.getAttribute("enabled") == "False" || childDiv.getAttribute("enabled") == "false") {
                
                    childDiv.style.display = "none";
                    childDiv.isActiveTab = "false";
                    childDiv.isDisabled2 = "true";
                    html = html + "<li class=\"Tabs_TabDisabled\" id=\"" + blockRuntimeId + "_li_" + pos + "\">" +
                                    "<a style=\"display: none;\" class=\"Tabs_TabOff\" id=\"" + blockRuntimeId + "_a_" + pos + "\" href=\"#\" onclick=\" RichWidgets_Tabs_ClientSide_activate('" + blockRuntimeId + "', " + pos + ", '" + pageName + "'); return false;\">" + childDiv.title + "</a>" +
                                    "<span class=\"Tabs_TabDisabled\" id=\"" + blockRuntimeId + "_span_" + pos + "\">" + childDiv.title + "</span>" +
                                  "</li>";
                    childDiv.title2 = childDiv.title;
                    childDiv.title = "";                    
                    
                } else {
                
                    if (initialTabPos == null && initialTab != "") {                    
                        if (childDiv.id == initialTab || childDiv.title == initialTab) {
                            initialTabPos = pos;
                        }
                    }
                    
                    if (firstTabPos == null) {
                        firstTabPos = pos;
                    }
                    lastTabPos = pos;

                    childDiv.style.display = "none";
                    childDiv.isActiveTab = "false";
                    childDiv.isDisabled2 = "false";
                    tabCount = tabCount + 1;
                    html = html + "<li class=\"Tabs_TabOff\" id=\"" + blockRuntimeId + "_li_" + pos + "\">" +
                                    "<a class=\"Tabs_TabOff\" id=\"" + blockRuntimeId + "_a_" + pos + "\" href=\"#\" onclick=\"javascript: RichWidgets_Tabs_ClientSide_activate('" + blockRuntimeId + "', " + pos + ", '" + pageName + "'); return false;\">" + childDiv.title + "</a>" +
                                    "<span style=\"display: none;\" class=\"Tabs_TabOn\" id=\"" + blockRuntimeId + "_span_" + pos + "\">" + childDiv.title + "</span>" +
                                  "</li>";
                    childDiv.title2 = childDiv.title;
                    childDiv.title = "";
                }
            }
        }
        childDiv = childDiv.nextSibling;
        pos = pos + 1;
    }
    
    if (initialTabPos == null) {
    
        if (initialTab != "") {
        
            if (displayErrors) {
            
                var errorElement = document.createElement("p");
                var initialTabDiv = document.getElementById(initialTab);
    
                var errorMessage;
                if (initialTabDiv == null) {
                    errorMessage = "Invalid use of RichWidgets\\Tabs_ClientSide: Can't find the initial tab ('" + initialTab +
/* ... truncado: 15529 chars a mais no JSON do catalogo */
```

## CSS

Classes: `.Tabs_Wrapper`, `.Tabs_TabBody`, `.OSAutoMarginTop`, `.Tabs_Header`, `.Tabs_TabOn`, `.Tabs_TabOff`, `.Tabs_TabDisabled`

```css
.Tabs_Wrapper {
    margin: 0px 0px 8px 0px;
    border: 1px solid white;
}

.Tabs_TabBody {
    margin: 24px 0px 0px 0px;
    padding: 5px;
    border: 1px solid #cccccc;
    _height: 1%;  /* IE6 */
    *display: inline-block;    
}

.Tabs_TabBody.OSAutoMarginTop {
    margin-top:24px;
}

.Tabs_TabBody:after {
    content: ".";
    display: block;
    height: 0;
    clear: both;
    visibility: hidden;
}

ul.Tabs_Header {
    margin: 0px;
    padding: 0px;
    height: 31px;
    position: absolute;
    overflow: hidden;
    z-index: 1;
    line-height: 18px;    
}

ul.Tabs_Header span {
    height: auto;
}

div.Tabs_TabOn,
li.Tabs_TabOn {
    float: left;
    margin: 0px;
    padding: 1px;
    list-style: none;
    color: #333333;
    border-top: 1px solid #cccccc;
    border-left: 1px solid #cccccc;
    border-right: 1px solid #cccccc;
    border-bottom: 1px solid white;
    background: white;
}

div.Tabs_TabOff,
li.Tabs_TabOff {
    float: left;
    margin: 0px;
    padding: 1px;
    color: #666666;
    list-style: none;
    border: 1px solid #cccccc;
}

div.Tabs_TabDisabled,
li.Tabs_TabDisabled {
    float: left;
    margin: 0px;
    padding: 1px;
    list-style: none;
    border: 1px solid #cccccc;
}

a.Tabs_TabOn,
a.Tabs_TabOn:link,
a.Tabs_TabOn:visited,
a.Tabs_TabOn:hover,
span.Tabs_TabOn {
    display: block;
    white-space: nowrap;
    text-decoration: none;
    color: #666666;
    padding: 2px 10px 1px 10px;
}

a.Tabs_TabOff,
a.Tabs_TabOff:link,
a.Tabs_TabOff:visited {
    display: block;
    white-space: nowrap;
    text-decoration: none;
    color: #666666;
    padding: 2px 10px 1px 10px;
    background: #EAEAEA;
}

a.Tabs_TabOff:hover {
    background: white;
}

a.Tabs_TabDisabled,
a.Tabs_TabDisabled:link,
a.Tabs_TabDisabled:visited,
a.Tabs_TabDisabled:hover,
span.Tabs_TabDisabled {
    display: block;
    white-space: nowrap;
    text-decoration: none;
    color: #AAAAAA;
    padding: 2px 8px 1px 8px;    
    background: #EAEAEA;
}

/* ExcludeFromPickersOutsideBlock: Tabs_Header, Tabs_TabOn, Tabs_TabOff, Tabs_TabDisabled */

```

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Tabs_ClientSide1","source":"IWebBlock:Tabs_ClientSide","as":"$b"}
```
