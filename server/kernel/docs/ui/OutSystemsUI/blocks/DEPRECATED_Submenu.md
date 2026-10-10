# DEPRECATED_Submenu

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Navigation** | publico | 8 widgets internos

This pattern is DEPRECATED. Consider using OutSystems UI's Submenu instead. 
Get more information about changes at https://outsystemsui.outsystems.com/OutSystemsUIWebsite/MigrationPath?PatternName=Submenu

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

- **Items**: Submenu items (em `Submenu/content`) | nasce com: Link (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)
- **Menu**: Menu item (em `Submenu/content/SubMenuHeader/content`) | nasce com: Text (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

Nenhum.

## Composicao interna

- Ciclo de vida: OnReady -> OnReady
- Actions do bloco: CloseMenu, Accessibility, OpenMenu, OnReady, OnMenuClick

## JavaScript

`CloseMenu` / no `Close`:

```js
var currentSubMenu = document.getElementById($parameters.WidgetId);

currentSubMenu.classList.remove('open');



```

`Accessibility` / no `SetAccessibilityParams`:

```js
var currentSubMenu = document.getElementById($parameters.SubmenuId);
currentSubMenu.querySelector(".submenu-header").setAttribute("aria-expanded", $parameters.IsOpen === true ? "true" : "false");

// change the aria-hidden attrubute on the submenu-items content
var submenu_items = currentSubMenu.querySelector(".submenu-items");
submenu_items.setAttribute("aria-hidden",  $parameters.IsOpen === true ? "false" : "true");
submenu_items.setAttribute("tabindex",  $parameters.IsOpen === true ? "0" : "-1");

// change the tabindex value
var submenu_items_link = submenu_items.querySelectorAll("a");
submenu_items_link = [].slice.call(submenu_items_link);
submenu_items_link.forEach(function(item) {
	item.setAttribute("tabindex",  $parameters.IsOpen === true ? "0" : "-1");
});
```

`OpenMenu` / no `CloseAll`:

```js
var subItems = document.querySelectorAll('.submenu');
var currentSubMenu = document.getElementById($parameters.WidgetId);

var isOpen = function(currentSubItem) {
    if(currentSubItem.classList.contains('open')) {
        return true;
    }
    
    return false;
};

// On Click close all other open SubMenus
for(var i = 0; i < subItems.length; i++) {
    var subItemMenu = subItems[i];

    if(subItemMenu !== currentSubMenu && isOpen(subItemMenu)) {
        subItemMenu.CloseMenu();
    }
}

currentSubMenu.classList.add('open');





```

`OnReady` / no `Init`:

```js
var subMenu = document.getElementById($parameters.WidgetId);
var subMenuHeader = document.getElementById($parameters.HeaderId);
var subMenuItem = subMenuHeader.querySelector('.submenu-item');
var items = subMenu.querySelector('.submenu-items');
var SubMenuLinks = subMenu.getElementsByTagName("a");
var subMenuItems = items.getElementsByTagName("a");
var isDesktop = document.body.classList.contains('desktop');
var triggerElement = subMenuItem.firstChild;
var isTriggerLink;
if(triggerElement){
    isTriggerLink = triggerElement.tagName === 'A';
}
$parameters.HasItems = subMenuItems.length > 0;

// add accessibility - - - - - - - - - - - - - - - - - - - - - 
subMenu.addEventListener('keydown', function (e) {
    if(!subMenu.classList.contains('open')){
        return;
    }
    if(e.keyCode === 27 || e.key === 'Escape' ) {
        e.preventDefault();
        e.stopPropagation();
        subMenuHeader.focus();
        $actions.CloseMenu();
    }
});
// add accessibility - - - - - - - - - - - - - - - - - - - - -

// Check if subItem has links. If true, means it's a dropdown
if(items.childElementCount > 0) {
    subMenu.classList.add('is--dropdown');
    
    // add accessibility - - - - - - - - - - - - - - - - - - - - -
    if(isTriggerLink) {
        triggerElement.setAttribute("tabindex", "-1");
    }
    
    subMenuHeader.addEventListener("keyup", function (e) {
         if(e.keyCode === 13 || e.keyCode === 32) {
            e.preventDefault();
            e.stopPropagation();
            $actions.OnMenuClick();
         }
    });
    // add accessibility - - - - - - - - - - - - - - - - - - - - - 
    
    // Add Click Action here, to be able to use stopPropagation
    subMenuHeader.addEventListener('click', function(e){
        e.preventDefault();
        e.stopPropagation();
        $actions.OnMenuClick();
    });
}

// Add active class to SubMenu, if there's a link with active class
for(var i = 0; i < SubMenuLinks.length; i++) {
    if(SubMenuLinks[i].classList.contains('active')) {
        subMenu.classList.add('active');
    } 
}

```

`OnReady` / no `SetGlobalActions`:

```js
var element = document.getElementById($parameters.WidgetId);

// Add actions
element.CloseMenu = function() { 
    $actions.CloseMenu();
};

element.OpenMenu = function() { 
    $actions.OpenMenu();
};
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DEPRECATED_Submenu1","source":"IMobileBlock:DEPRECATED_Submenu","empty":true,"as":"$b"}
```
