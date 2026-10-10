# OutSystemsChartsWeb 2.0.0 (WebResponsive)

Gerado em 2026-09-04T09:44:38 de `OutSystemsChartsWeb.oml` pelo `anvil ui-catalog`. Nao editar a mao: regenerar quando a versao do ambiente mudar.

13 blocos (5 publicos), 5 static entities de configuracao, 7 actions publicas, 0 scripts, 0 temas.

## Como instanciar um bloco com os verbos

O modulo alvo precisa referenciar a biblioteca (`references`). Um bloco entra na tela como block instance:

```json
{"op":"create","parent":"IWebFlow:MainFlow","type":"IWebScreen","name":"Minha","as":"$scr"}   // nasce com o layout do tema e placeholders Title/MainContent/...
{"op":"create","parent":"$scr/#IWebBlockInstanceWidget/MainContent","type":"IWebBlockInstanceWidget","name":"Card1","source":"IWebBlock:Card","empty":true,"as":"$card"}
// source = SourceBlock na criacao; empty = apaga o conteudo de exemplo dos placeholders
{"op":"set","target":"$card/ExtendedClass","prop":"Value","value":"\"padding-m\""}   // input -> IArgument.Value (expressao)
{"op":"create","parent":"$card/Content","type":"IExpressionWidget","as":"$e"}   // placeholder por nome; widgets Web usam o sufixo Widget
{"op":"set","target":"$e","prop":"Value","value":"\"Ola\""}
```

Widgets nativos do Traditional: IContainerWidget, IExpressionWidget, IInputWidget, IButtonWidget, ILinkWidget, ITableRecordsWidget, IListRecordsWidget, IIfWidget, IEditRecordWidget, IComboBoxWidget, ICheckBoxWidget (namespace OutSystems.Model.UI.Web.Widgets). Leia a pagina do bloco antes de usar: placeholders esperam filhos especificos.

## ChartLibrariesJS (3)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [Accessibility](blocks/Accessibility.md) | nao | Highcharts JS v11.4.1 (2024-04-04) - Accessibility module. | 0 |  |  |
| [HighCharts](blocks/HighCharts.md) | nao | Highcharts JS v11.4.1 (2024-04-04) | 0 |  |  |
| [OSHighCharts](blocks/OSHighCharts.md) | nao | Highcharts More JS v11.4.1 (2024-04-04) | 0 |  |  |

## Charts (5)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [AreaChart](blocks/AreaChart.md) | sim | Area charts illustrate the contribution of values to a total over time. | 9 |  |  |
| [BarChart](blocks/BarChart.md) | sim | Bar charts compare multiple values using horizontal bars. | 9 |  |  |
| [ColumnChart](blocks/ColumnChart.md) | sim | Column charts compare multiple values using vertical bars. | 9 |  |  |
| [LineChart](blocks/LineChart.md) | sim | Line charts illustrate trends of values over time. | 8 |  |  |
| [PieChart](blocks/PieChart.md) | sim | Pie charts illustrate proportions of values. | 6 |  |  |

## Internal (3)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [BarColumnChart_HighCharts](blocks/BarColumnChart_HighCharts.md) | nao |  | 11 |  |  |
| [LineAreaChart_HighCharts](blocks/LineAreaChart_HighCharts.md) | nao |  | 11 |  |  |
| [PieChart_HighCharts](blocks/PieChart_HighCharts.md) | nao |  | 7 |  |  |

## Utils (2)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [JavaScript_Content](blocks/JavaScript_Content.md) | nao | Helps to identify in-line javascript usage in design time. | 1 |  |  |
| [JavaScript_ContentDebug](blocks/JavaScript_ContentDebug.md) | nao | For debug purposes: Replace Javascript_Content with Javascript_ContentDebug to show a Debug link and enable runtime changes in the generated Javascript. | 1 |  |  |

Veja tambem: [config-values.md](config-values.md) (static entities), [actions.md](actions.md) (actions publicas), [themes.md](themes.md) (tokens CSS).
