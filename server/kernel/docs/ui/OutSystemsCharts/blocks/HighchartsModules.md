# HighchartsModules

OutSystemsCharts 3.10.0 | Reactive/Mobile | UI flow **Advanced** | publico | 9 widgets internos

Extends charts by adding additional Highcharts scripts to the page.
Drag-and-drop to a screen to add additional scripts to it. 
This element will not appear in runtime.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ModulesList | HighchartModules Identifier List | sim |  | List of modules that will be added. By default, the OutSystems Charts has the following modules: accessibility.js, highcharts.js, highcharts-more.js, highcharts-3d.js and no-data-to-display.js. |

## Placeholders

Nenhum.

## Eventos

- **Loaded**(AddedNewModules: Boolean): Event triggered when the High Charts modules are successfully loaded into the application. It is important to note that if a module that has already been loaded is not added again, and will not have any effect and but will trigger this event.
- **LoadError**(MessageList: Text List): Event triggered when the an error(s) occurs during the loading of HighCharts modules into the OutSystems application. T
his event provides essential information about the encountered error(s), enabling developers to take appropriate actions to handle these errors gracefully. 
It's important to note that if multiple modules are being loaded and one of them fails, the LoadError event will be triggered. However, the remaining modules were successfully loaded and the changes are reflected in the charts.

## Composicao interna

- Ciclo de vida: OnParametersChanged -> OnParametersChanged; OnReady -> OnReady
- Actions do bloco: OnParametersChanged, OnReady, LoadScripts
- Chama actions do modulo: LoadModules, AddModuleToBeLoaded (contratos em [actions.md](../actions.md))

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"HighchartsModules1","source":"IMobileBlock:HighchartsModules","as":"$b"}
{"op":"set","target":"$b/ModulesList","prop":"Value","value":"<HighchartModules Identifier List>"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/Loaded` resolve o IEventHandler pelo nome do evento e `$b/Loaded/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"HighchartsModules1_Loaded","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"AddedNewModules","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Boolean"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/Loaded","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/Loaded/AddedNewModules","prop":"Value","value":"AddedNewModules"}
```
