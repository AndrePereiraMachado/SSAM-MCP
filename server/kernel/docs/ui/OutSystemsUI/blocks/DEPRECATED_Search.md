# DEPRECATED_Search

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Interaction** | publico | 13 widgets internos

A search icon that opens an input above the header to search within the application.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

- **Input**: Drag the search input to this placeholder (em `content`) | nasce com: Label, Input:Input1. Esse Input e parte do padrao: NAO use empty; ligue-o com `set $b/Input/#IInput prop Variable value <variavel>` (os nomes reais sao renumerados, ex. Input1; enderece por tipo)

## Eventos

- **OnCollapse**(): Triggered when the search input is collapsed

## Composicao interna

- Scripts exigidos: OutSystemsUI
- Ciclo de vida: OnReady -> OnReady
- Actions do bloco: ExpandOrCollapse, OnReady

## JavaScript

`ExpandOrCollapse` / no `FocusInput`:

```js
//Focus on input inside placeholder only if no value is already there
var input = document.getElementById($parameters.WidgetId).querySelector('input');

if (input && input.value === '') {
    setTimeout(function() { input.focus(); }, 300);
}
```

`OnReady` / no `InputFilled`:

```js
$parameters.HasValue = false;

// Check if there is any input inside the placeholder and if so, checks if it is has value
var input = document.getElementById($parameters.WidgetId).querySelector('input');

if (input) {
    $parameters.HasValue = input.value !== '';
}
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DEPRECATED_Search1","source":"IMobileBlock:DEPRECATED_Search","as":"$b"}
{"op":"set","target":"$b/Input/#IInput","prop":"Variable","value":"<variavel local>"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnCollapse` resolve o IEventHandler pelo nome do evento e `$b/OnCollapse/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"DEPRECATED_Search1_OnCollapse","as":"$h"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnCollapse","prop":"Handler","value":"$h"}
```
