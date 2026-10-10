# DropDownMenu

RichWidgets  | Traditional | UI flow **RichWidgets** | publico | 5 widgets internos

When clicked, shows a dropdown menu with all the submenu items.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| IsActive | Boolean | sim |  | If True, the 'Menu_TopMenuActive' class will be appended to the Menu_TopMenu container (to show which menu is selected) |

## Placeholders

- **MenuItem** (em `DropDownButtonRoot/DropDownButtonElement`)
- **MenuSubItems** (em `DropDownButtonRoot/DropDownPanel`)

## Eventos

Nenhum.

## JavaScript

JavaScript do bloco:

```js
outsystems.internal.$(function($) {
    var RichWidgets = (window.RichWidgets = window.RichWidgets || {});

    // configuration
    var rootSel = '.Menu_DropDownButton',
        primarySel = '.Menu_TopMenu',
        panelSel = '.Menu_DropDownPanel',
        openClass = 'open';

    // auxiliary stuff
    var caproot = $(document.body);
    var $openRoots = $([]);

    var openRoot = function($root) {
        $root.addClass(openClass);
        if (RichWidgets.DropDownMenus.customOpenFunction) {
            $root.find(panelSel).each(function() {
                RichWidgets.DropDownMenus.customOpenFunction(this);
            });
        } else {
            $root.find(panelSel).show();
        }
        $openRoots = $openRoots.add($root);
    };
    var closeRoot = function($root) {
        $root.removeClass(openClass);
        if (RichWidgets.DropDownMenus.customCloseFunction) {
            $root.find(panelSel).each(function() {
                RichWidgets.DropDownMenus.customCloseFunction(this);
            });
        } else {
            $root.find(panelSel).hide();
        }
        $openRoots = $openRoots.not($root);
    };
    
    // 0. define the keyboard event
    caproot.delegate(rootSel, "keydown", function(ev) {
        var _this = this.querySelector(primarySel + " a");
        if(ev.keyCode == 13 || ev.keyCode == 32) {
            _this.click();
        } else if (ev.keyCode == 27 && this.classList.contains(openClass)) {
            _this.click();
        }
    });
    
    // 1. a click in a primary link toggles its menu
    caproot.delegate(primarySel, "click", function(ev) {
        var $primary = $(this);
        var $root = $primary.closest(rootSel);
        if ( !$root.length ) { return; } // not our menus, bail out
        var $panel = $root.find(panelSel);
        if ( !$panel.text().length ) { return; } // menu without content

        if ($root.hasClass(openClass)) { // close it
            closeRoot($root);
            // add accessibility
            $root.attr("aria-expanded", "false");
            $panel.attr("aria-hidden", "true");
            
            setTimeout(function(){
                $primary.focus();
            }, 0)
        } else { // open it
            openRoot($root);
            // add accessibility
            $root.attr("aria-expanded", "true");
            $panel.attr("aria-hidden", "false");
        }
        ev.preventDefault();
    });

    // 2. a click somewhere that's not a menu, closes all menus
    $( document.body ).bind( "click", function(ev) {
        var $inMenu = $(ev.target).closest(rootSel);
        $openRoots.not($inMenu).each(function() {
            var $root = $(this);
            if ($root.hasClass(openClass)) {
                closeRoot($root);
            }
        });
    });

    // add accessibility
    $( rootSel ).has( panelSel + " a" ).find( panelSel ).each(function() {
        var $this = $( this );
        $this.attr("aria-hidden", "true");
        
        var menuLabel = $this.parent().find(".Menu_TopMenu a").attr("aria-label");
        if(menuLabel) {
            var subMenus = $this.find("a");
            for(var i=0; i<subMenus.length; i++) {
                var item = subMenus[i];
                $(item).attr("role", "menuitem");
            }
        }
    });

    // 3. add the V thingie
    var addArrow = function() {
        $( rootSel ).has( panelSel + " a" ).find( primarySel ).each(function() {
            var $this = $( this )
            
            if($this.find("span.Menu_DropDownArrow").get().length === 0){
                 $this.find("div").append(' <span class="Menu_DropDownArrow"/>' );
                setTimeout(function(){
                    $this.attr("tabindex", "0");
                    $this.find("div a").attr("tabindex", "-1");
                }, 200);
            }
        });
    };

    addArrow();

    // 4. expose an API
    RichWidgets.DropDownMenus = {
        // close all currently open menus
        closeAllMenus: function() {
            $openRoots.each(function() { closeRoot($( this )); });
        },
        // specify a custom function that shows the menu panel
        // (possibly using a different effect)
        // arguments: HTMLElement to be shown 
        customOpenFunction: function(e) { $(e).slideDown(50); },
        // specify a custom function that hides the menu panel
        // (possibly using a different effect)
        // arguments: HTMLElement to be hidden
        customCloseFunction: null
    };

    $(document).ready(function(){
        osAjaxBackend.BindAfterAjaxRequest(function(){
            addArrow();
        });
    });
});
```

## CSS

Classes: `.Menu_DropDownButton`, `.open`, `.Menu_TopMenu`, `.Menu_DropDownArrow`, `.Menu_DropDownPanel`, `.Menu_SubItemsPlaceholder`

```css
.Menu_DropDownButton {
    display: inline-block;
    *display: inline; 
    *zoom: 1;
    *z-index:200; /* required for IE7 */
}

.Menu_DropDownButton.open {
    z-index: 210;
    *vertical-align: top;
}

.Menu_DropDownButton.open .Menu_TopMenu {
    background-image: none;
    position: relative;
    z-index: 210;
    cursor: pointer;
    *display: block;
}

.Menu_DropDownArrow {
    position: relative;
    top: -2px;
    border-style: solid dashed dashed;
    border-color: transparent;
    border-top-color: #666;
    display: -moz-inline-box;
    display: inline-block;
    font-size: 0;
    height: 0;
    line-height: 0;
    width: 0;
    border-width: 3px 3px 0;
    padding-top: 1px;
}

.Menu_DropDownPanel {
    position: absolute;
    z-index: 200;
    display: none;
    list-style: none;
    background-color: white;
    border: 1px solid #ccc;
    margin: -1px 0 0 -1px;
    -webkit-box-shadow: 3px 3px 3px rgba(0, 0, 0, 0.3);
    -moz-box-shadow: 3px 3px 3px rgba(0, 0, 0, 0.3);
    box-shadow: 3px 3px 3px rgba(0, 0, 0, 0.3);
    -webkit-background-clip: padding-box;
    -moz-background-clip: padding;
    background-clip: padding-box;
    -servicestudio-min-width: 140px;
}

.Menu_SubItemsPlaceholder {
    -servicestudio-padding-bottom: 10px;
}

.Menu_DropDownPanel a, 
.Menu_DropDownPanel a:link,
.Menu_DropDownPanel a:visited {
    display: block;
    padding: 3px 10px;
    clear: both;
    font-size: 13px;
    text-decoration: none;
    line-height: 2em;
    color: #333333;
    white-space: nowrap;
    margin: 0;
    background: none;
    text-shadow: none;
    border-width: 0;
    border-radius: 0;
    -webkit-box-shadow: none;
    -moz-box-shadow: none;
    box-shadow: none;
    min-width: 0;
    text-align: left;
    *width: 140px;
    min-width: 140px;
    height: 26px;
}

.Menu_DropDownPanel a:hover,
.Menu_DropDownPanel a:focus {
    text-decoration: none;
}

/* ExcludeAllFromPickersOutsideBlock */
```

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"DropDownMenu1","source":"IWebBlock:DropDownMenu","as":"$b"}
{"op":"set","target":"$b/IsActive","prop":"Value","value":"<Boolean>"}
{"op":"create","parent":"$b/MenuItem","type":"IExpressionWidget","as":"$eMenuItem"}
{"op":"create","parent":"$b/MenuSubItems","type":"IExpressionWidget","as":"$eMenuSubItems"}
```
