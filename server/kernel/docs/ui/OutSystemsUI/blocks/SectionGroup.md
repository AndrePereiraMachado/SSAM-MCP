# SectionGroup

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Content** | publico | 11 widgets internos

Use to apply sticky headers to Sections inside this Block.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| HasStickyTitles | Boolean | nao | True | Defines if the Section Titles will be Sticky in the top of the page content |
| TopPosition | Integer | nao | 0 | Set the top position when the SectionGroup is sticky. Just insert the number, the pixels unit will be added automatically. |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

- **Sections**: Add Sections inside this placeholder (em `SectionGroup/content`) | nasce com: WebBlockInstance:Section, WebBlockInstance:Section, WebBlockInstance:Section (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: Section
- Ciclo de vida: OnReady -> OnReady
- Actions do bloco: OnReady
- Chama actions do modulo: GetBrowser (contratos em [actions.md](../actions.md))

## JavaScript

APIs OSUI alcancadas (direto ou pelas actions chamadas): `OutSystems.OSUI.Utils.GetBrowser`

`OnReady` / no `SetTopPosition`:

```js
var sectionGroup = document.getElementById($parameters.WidgetId);

if(sectionGroup) {
    var sections = sectionGroup.querySelectorAll('.section-title');
    
    setTimeout(function(){
        var headerSize = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--header-size'));
        var headerContentSize = parseInt(getComputedStyle(document.body).getPropertyValue('--header-size-content'));
        var finalPosition = $parameters.IsWebApp ? headerSize + $parameters.TopPosition : $parameters.IsLayoutNative ? headerSize + headerContentSize + $parameters.TopPosition : $parameters.TopPosition;
        
        if($parameters.IsWebApp || $parameters.IsLayoutNative) {
            sectionGroup.style.setProperty('--section-top-position', finalPosition + "px");
        } else {
            for(var i = 0; i < sections.length; i++) {
                sections[i].style.top = finalPosition + "px";
            }
        }
    }, 0);
}

```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"SectionGroup1","source":"IMobileBlock:SectionGroup","empty":true,"as":"$b"}
```
