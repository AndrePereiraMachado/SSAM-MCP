# DEPRECATED_SectionIndex

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Navigation** | publico | 13 widgets internos

Use the Section Index to organize a screen's content, enabling quick navigation within a page.

Just drag the pattern, and it will create a link to every section you have on the page. If you use a list of sections, add disable-virtualization=true through the Attributes section on the list widget containing the section patterns.

Use the parameter isFixed to define if it will stick on scroll and the TopPosition to change the distance to top. 

Set IsSmooth to true to enable animated scroll.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| IsSmooth | Boolean | nao | True | If IsSmooth is true, the navigation to destination will animate. If set to false, it will navigate instantly. |
| IsFixed | Boolean | nao | True | If Fixed is true, SectionIndex will allways be in the same position within the screen.  If set to false, it scrolls with the page content. |
| TopPosition | Integer | nao | 0 | Set the top position when the SectionIndex is fixed. Just insert the number, the pixels unit will be added automatically. |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Scripts exigidos: DEPRECATED_SectionIndex, ScrollPolyfill
- Ciclo de vida: OnParametersChanged -> OnReady; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnReady, SetObject, OnDestroy

## JavaScript

`OnReady` / no `Init`:

```js
var sectionIndex;
var timeoutVar;
var isInsideList;
var list = document.querySelector('[data-list]') || document.querySelector('.list');
var listChildren = list ? list.children : undefined;

var options = {
    isSmooth: $parameters.IsSmooth,
    isFixed: $parameters.IsFixed,
    topPosition: $parameters.TopPosition,
    isWebApp: $parameters.IsWebApp,
    isLayoutNative: $parameters.IsLayoutNative
};

var waitListRender = function() {
    
    var virtualizationDisabled = list.hasAttribute('data-virtualization-disabled');
    // 2 because of the 2 scripts tags inserted by List Widget virtualization. If there's more than 2, it means it's list items.
    var minimunLength = virtualizationDisabled ? 2 : 0;
    
    // If list doesn't have the virtualization disabled, throws a warning to console
    if(!virtualizationDisabled) {
        console.warn('The list that SectionIndex is watching does not have the virtualization disabled. Please, add disable-virtualization=true through Attributes section on the list widget containing the section patterns');
    }
    
    if(!list.classList.contains("list-loading") && listChildren.length > minimunLength) {
        sectionIndex = new SectionIndex();
        sectionIndex.init(options, $parameters.IsUpdate);
        $actions.SetObject(sectionIndex);
    } else {
        timeoutVar = setTimeout(waitListRender, 0);
    }
};

if(list){
    waitListRender();
} else {
    sectionIndex = new SectionIndex();
    sectionIndex.init(options, $parameters.IsUpdate);
    $actions.SetObject(sectionIndex);
}

```

`OnDestroy` / no `Destroy`:

```js
$parameters.Obj.destroy();
```

`OnDestroy` / no `CheckObjectStatus`:

```js
$parameters.ObjectIsDefined = $parameters.Object !== null;
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DEPRECATED_SectionIndex1","source":"IMobileBlock:DEPRECATED_SectionIndex","as":"$b"}
```
