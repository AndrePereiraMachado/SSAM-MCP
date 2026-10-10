# DEPRECATED_Tooltip

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Content** | publico | 13 widgets internos

This pattern is DEPRECATED. Consider using OutSystems UI's Tooltip instead. 
Get more information about changes at https://outsystemsui.outsystems.com/OutSystemsUIWebsite/MigrationPath?PatternName=Tooltip

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Position | Position Identifier | sim |  | Set the tooltip's position. The predefined options are: -Bottom -BottomLeft -BottomRight -Center -Left -Right -Top -TopLeft -TopRight  Examples:  Entities.Position.Right - The tooltip is displayed to the right of the element. Entities.Position.Bottom - The tooltip is displayed underneath the element. |
| IsVisible | Boolean | nao | False | If set as true, the block is visible when the page is first loaded (without the need for the initial trigger). |
| IsHover | Boolean | nao | False | Set to true, to use hover as interaction trigger. |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

Valores possiveis (static entities):

- **Entities.Position**: Right, TopRight, BottomLeft, Left, TopLeft, Center, BottomRight, Top, Bottom

## Placeholders

- **Content**: Content (em `TooltipWrapper/content`)
- **Tooltip**: Tooltip text (em `TooltipWrapper/content/Preview`)

## Eventos

Nenhum.

## Composicao interna

- Ciclo de vida: OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnReady, OnDestroy, ToggleTooltip

## JavaScript

`OnReady` / no `Init`:

```js
var content = document.getElementById($parameters.ContentId);
var wrapper = document.getElementById($parameters.TooltipWrapperId);
var tooltip = document.getElementById($parameters.TooltipId) ? document.getElementById($parameters.TooltipId) : '';
var tooltipBackground = document.getElementById($parameters.TooltipBackgroundId)
    ? document.getElementById($parameters.TooltipBackgroundId)
    : '';
var isActive = false;
var isExpanded;

function tooltipBgClick(e) {
    e.preventDefault();
    e.stopPropagation();

    $actions.ToggleTooltip(false);
    tooltipBackground.removeEventListener('click', tooltipBgClick, true);
}


if ($parameters.IsHover) {
    content.addEventListener('focus', function () {
        $actions.ToggleTooltip(true);
    });
    content.addEventListener('focusout', function(e){
        $actions.ToggleTooltip(false);
        e.target.blur();
    });
    wrapper.addEventListener('mouseover', function (e) {
        $actions.ToggleTooltip(true);
        // To enable Esc listener on mouseover
        e.target.focus();
    });
    wrapper.addEventListener('mouseleave', function () {
        $actions.ToggleTooltip(false);

        if (tooltipBackground !== '') {
            tooltipBackground.addEventListener('click', tooltipBgClick, true);
        }
    });
} else {
    if (tooltipBackground !== '') {
        tooltipBackground.addEventListener('click', tooltipBgClick, true);
    }

    content.addEventListener(
        'click',
        function (e) {
            $actions.ToggleTooltip(true);

            setTimeout(function () {
                tooltipBackground = document.getElementById($parameters.TooltipBackgroundId)
                    ? document.getElementById($parameters.TooltipBackgroundId)
                    : '';
                tooltipBackground.removeEventListener('click', tooltipBgClick, true);
                tooltipBackground.addEventListener('click', tooltipBgClick, true);
            }, 0);
        },
        true
    );
    isActive = true;
}

var onKeyDownPress = function (e) {
    isExpanded = content.getAttribute('aria-expanded');

    //If esc or Tab, Close Tooltip
    if ((isExpanded === 'true' && e.keyCode == '27') || (document.activeElement === tooltip && e.keyCode == '9')) {
        $actions.ToggleTooltip(!isExpanded);
        isActive = !isExpanded;
    }

    //If enter or space use the tooltip to validate
    if (e.keyCode == '13') {
        $actions.ToggleTooltip(true);
        isActive = true;
    }
};

wrapper.addEventListener('keydown', onKeyDownPress);
```

`OnDestroy` / no `RemoveListeners`:

```js
var content = document.getElementById($parameters.ContentId);

if(content) {
    if($parameters.IsHover) {
        content.removeEventListener("mouseover", $actions.ToggleTooltip);
        content.removeEventListener("mouseleave", $actions.ToggleTooltip);
    } else {
        content.removeEventListener("click", $actions.ToggleTooltip);
    }
}
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DEPRECATED_Tooltip1","source":"IMobileBlock:DEPRECATED_Tooltip","as":"$b"}
{"op":"set","target":"$b/Position","prop":"Value","value":"<Position Identifier>"}
{"op":"create","parent":"$b/Content","type":"IExpression","as":"$eContent"}
{"op":"create","parent":"$b/Tooltip","type":"IExpression","as":"$eTooltip"}
```
