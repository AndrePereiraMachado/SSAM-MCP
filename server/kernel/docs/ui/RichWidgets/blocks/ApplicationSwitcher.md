# ApplicationSwitcher

RichWidgets  | Traditional | UI flow **RichWidgets** | publico | 19 widgets internos

Shows a dropdown with a list of links to all applications that the currently logged user has access to (i.e. belong to one of its roles). Not supported in mobile devices.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ESpaceId | Espace Identifier | sim |  | The 'Id' runtime property of the eSpace of an application. For a generic usage set the argument with the 'GetOwnerEspaceIdentifier()' built-in function. |

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Chama actions do modulo: Feedback_Message (contratos em [actions.md](../actions.md))

## JavaScript

JavaScript do bloco:

```js
outsystems.internal.$(function($){
    //show app switcher list on ipads/iphones
    $(".AppSwitcherContainer").bind("click",
        function(event) {
            $(".AppSwitcherList").toggle();
            event.stopPropagation();
        }
    );
     $('html').click(function() {
            $(".AppSwitcherList").hide();
     });
 });
```

## CSS

Classes: `.AppSwitcherContainer`, `.AppSwitcherListContainer`, `.AppSwitcherList`, `.AppSwitcherLink`, `.AppSwitcherDownArrow`

```css
.AppSwitcherContainer {
    display: inline;
    margin-right: 40px;
    font-weight: normal;
    cursor: pointer;
}

.AppSwitcherListContainer {
    position:relative;
    display:inline-block;
    *display: inline;
    *zoom: 1;
    font-weight: normal; 
}

.AppSwitcherList {
    position: absolute;
    -servicestudio-position: static;
    white-space: nowrap;
    display:none;
    background-color: #f2f2f2;
    border: solid 1px #DDD;
    top: 10px;
    z-index: 300;
}

.AppSwitcherLink,
.AppSwitcherLink:link,
.AppSwitcherLink:visited {
    color:#444444;
    text-decoration:none;
    display:block;
    padding: 4px 8px;
}


.AppSwitcherDownArrow {
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
/* ExcludeAllFromPickersOutsideBlock */
```

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"ApplicationSwitcher1","source":"IWebBlock:ApplicationSwitcher","as":"$b"}
{"op":"set","target":"$b/ESpaceId","prop":"Value","value":"<Espace Identifier>"}
```
