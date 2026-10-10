# OutSystemsCharts 3.10.0: valores de configuracao (static entities)

## Entities.AxisType

| Id | Type |
|---|---|
| X | "X" |
| Z | "Z" |
| Y | "Y" |

## Entities.AxisValuesType

| Id | Type |
|---|---|
| Logarithmic | "logarithmic" |
| Linear | "linear" |
| Category | "category" |
| Datetime | "datetime" |

## Entities.ChartEvent

| Id | Event |
|---|---|
| Initialized | "Initialized" |

## Entities.ChartProvider

| Id | ProviderName |
|---|---|
| Highcharts | "Highcharts" |

## Entities.HighchartModules

Additional Highcharts modules that can be referenced.

| Id | ModuleName |
|---|---|
| Networkgraph | "networkgraph" |
| Sankey | "sankey" |
| Windbarb | "windbarb" |
| Pareto | "pareto" |
| HighContrastLight | "high-contrast-light" |
| Organization | "organization" |
| VariablePie | "variable-pie" |
| ItemSeries | "item-series" |
| Dumbbell | "dumbbell" |
| Timeline | "timeline" |
| Streamgraph | "streamgraph" |
| Bellcurve | "bellcurve" |
| Data | "data" |
| Histogram | "histogram" |
| Cylinder | "cylinder" |
| Tilemap | "tilemap" |
| Sunburst | "sunburst" |
| Sonification | "sonification" |
| Pyramid3d | "pyramid3d" |
| ArcDiagram | "arc-diagram" |
| Drilldown | "drilldown" |
| Annotations | "annotations" |
| Funnel3d | "funnel3d" |
| Treemap | "treemap" |
| Boost | "boost" |
| Wordcloud | "wordcloud" |
| SeriesLabel | "series-label" |
| Funnel | "funnel" |
| Bullet | "bullet" |
| Xrange | "xrange" |
| CanvasTools | "canvas-tools" |
| OfflineExporting | "offline-exporting" |
| Heatmap | "heatmap" |
| Pictorial | "pictorial" |
| PatternFill | "pattern-fill" |
| Lollipop | "lollipop" |
| Venn | "venn" |
| Treegraph | "treegraph" |
| Adaptive | "adaptive" |
| Vector | "vector" |
| SolidGauge | "solid-gauge" |
| Variwide | "variwide" |
| DependencyWheel | "dependency-wheel" |
| HighContrastDark | "high-contrast-dark" |
| BrokenAxis | "broken-axis" |

## Entities.LegendLayout

The legend position in chart

| Id | Layout |
|---|---|
| Horizontal | "horizontal" |
| Proximate | "proximate" |
| Vertical | "vertical" |

## Entities.LegendPosition

| Id | Position |
|---|---|
| Top | "Top" |
| TopRight | "TopRight" |
| BottomLeft | "BottomLeft" |
| Bottom | "Bottom" |
| BottomRight | "BottomRight" |
| Right | "Right" |
| Center | "Center" |
| Left | "Left" |
| TopLeft | "TopLeft" |

## Entities.LegendPosition_v1

The legend position in chart

| Id | Label | Order | Is_Active |
|---|---|---|---|
| Top | "Top" | 2 | True |
| Right | "Right" | 4 | True |
| Left | "Left" | 3 | True |
| Hidden | "Hidden" | 6 | True |
| Inside | "Inside" | 5 | True |
| Bottom | "Bottom" | 1 | True |

## Entities.OSChartVersion

| Id | Version |
|---|---|
| Version1 | "Version1" |
| Version2 | "Version2" |

## Entities.SeriesEvent

| Id | Event |
|---|---|
| Click | "Click" |

## Entities.SeriesEvent_v1

| Id |  |
|---|
| Click |  |

## Entities.SeriesType

| Id | Type |
|---|---|
| Bar | "bar" |
| LineSpline | "spline" |
| AreaSpline | "areaspline" |
| Area | "area" |
| Pie | "pie" |
| Line | "line" |
| Column | "column" |

## Entities.StackingType

The way to plot multiple data series on Area, Bar, or Column charts:
    - ‘NoStacking’: plot data series side by side to compare them;
    - ‘Stacked’: plot data series stacked to show their contribution to a total;
    - ‘Stacked100Percent’: plot data series stacked to show their percentage in a total.

| Id | Type |
|---|---|
| NoStacking | "NoStacking" |
| Stacked100Percent | "Stacked100Percent" |
| Stacked | "Stacked" |

## Entities.StackingType_v1

The way to plot multiple data series on Area, Bar, or Column charts:
    - ‘NoStacking’: plot data series side by side to compare them;
    - ‘Stacked’: plot data series stacked to show their contribution to a total;
    - ‘Stacked100Percent’: plot data series stacked to show their percentage in a total.

| Id | Order | Is_Active |
|---|---|---|
| Stacked | 2 | True |
| Stacked100Percent | 3 | True |
| NoStacking | 1 | True |

## Entities.ValuesType

Set how the chart labels are handled to be displayed on the chart.
The type of the values can be:
 - Integer: the labels will be displayed as integer numbers.
 - Decimal: the labels will be displayed as decimal numbers.
 - Datetime: the labels will be displayed as datetimes.
 - Text: the labels will be displayed as text and treated as categories.
By default, the type is Text.

| Id | Type |
|---|---|
| Datetime | "datetime" |
| Decimal | "decimal" |
| Text | "text" |
| Integer | "integer" |

## Entities.XAxisType

| Id | Label | Order | IsActive |
|---|---|---|---|
| Datetime | "datetime" | 3 | True |
| Category | "category" | 1 | True |
| Decimal | "decimal" | 2 | True |
| Linear | "linear" | 4 | True |

## Entities.XAxisValuesType_v1

The data type of labels displayed on the X-axis to format them. 
Using ‘Auto’ means the type is inferred from the label of the first data point.

| Id | Label | Order |
|---|---|---|
| Text | "Text" | 2 |
| Auto | "Auto" | 1 |

# Structures

## AxisInternalConfigs

- UniqueId: Text
- Title: Text
- Visible: Boolean = True
- MinValue: Decimal
- MaxValue: Decimal
- ExtendedClass: Text
- ValuesPrefix: Text - Set the text prefixing the values displayed on the axis.
By default, labels don't have prefixes.
- ValuesSuffix: Text - Set the text suffixing the values displayed on the axis.
By default, labels don't have suffixes.
- LabelColor: Text = "#666666" - Set the color of the axis labels. 
By default, labels are #666666.
- LabelSize: Integer = 11 - Set the size of the labels on the axis. 
By default, labels are 11px.
- LabelRotation: Decimal = 0 - Set the rotation, in degrees, of the labels on the axis. 
By default, the rotation of the labels is 0º.
- LineColor: Text = "#ccd6eb" - Customize the color of the line marking the axis itself.
By default, the line color is #ccd6eb.
- LineWidth: Text - Customize the width, in pixels, of the line marking the axis itself.
By default, the line width is 1px.
- GridLinesColor: Text = "#ccd6eb"
- GridLinesWidth: Text
- GridLineStep: Integer
- Crosshair: Boolean = False
- ValuesType: AxisValuesType Identifier = Entities.AxisValuesType.Linear
- Opposite: Boolean

## AxisLabel

Holds the configurations available for an axis label.

- ValuesPrefix: Text - Set the text prefixing the values displayed on the axis.
By default, labels don't have prefixes.
- ValuesSuffix: Text - Set the text suffixing the values displayed on the axis.
By default, labels don't have suffixes.
- LabelColor: Text = "#666666" - Set the color of the axis labels. 
By default, labels are #666666.
- LabelSize: Integer = 11 - Set the size of the labels on the axis. 
By default, labels are 11px.
- LabelRotation: Decimal = 0 - Set the rotation, in degrees, of the labels on the axis. 
By default, the rotation of the labels is 0º.

## Chart

Holds basic configurations about a chart.

- Type: Text [obrigatorio] - Chart's type.
- RenderTo: Text [obrigatorio] - Indicates the element where the chart will be rendered on.
- Height: Text [obrigatorio] - Chart's height.
- ClassName: Text - Holds a class name to be added.
- InnerSize: Text - Inner size of the chart.

## ChartExportMenuOptions

List of options that can be added to the export menu. For each option, it's possible to set if it's part of the menu (EnableOption) and, when enabled, the label of the option (ButtonLabel). By default, all options are enabled.

- ViewInFullScreen: ChartExportOption - Configure the menu option that allows users to see the chart in full screen. By default, this option is visible on the menu with the label "View in full screen".
- PrintChart: ChartExportOption - Configure the menu option that allows users to print the chart. By default, this option is visible on the menu with the label “Print chart”.
- DownloadPNG: ChartExportOption - Configure the menu option that allows users to download the chart as a .png image. By default, this option is visible on the menu with the label “Download PNG image”.
- DownloadJPEG: ChartExportOption - Configure the menu option that allows users to download the chart as a .jpeg image. By default, this option is visible on the menu with the label “Download JPEG image”.
- DownloadPDF: ChartExportOption - Configure the menu option that allows users to download the chart as a .pdf file. By default, this option is visible on the menu with the label “Download PDF image”.
- DownloadSVG: ChartExportOption - Configure the menu option that allows users to download the chart as a .svg vector image. By default, this option is visible on the menu with the label “Download SVG vector image”.
- DownloadCSV: ChartExportOption - Configure the menu option that allows users to download the chart as a .csv file. By default, this option is visible on the menu with the label “Download CSV”.
- DownloadXLS: ChartExportOption - Configure the menu option that allows users to download the chart as a .xls file. By default, this option is visible on the menu with the label “Download XLS”.

## ChartExportOption

Define the chart export options.

- EnableOption: Boolean = True - Set to True to display this option on the exporting menu. Set to False to hide it. By default, True.
- ButtonLabel: Text - The text displayed on the menu for this option.

## ChartExportOptionalConfigs

Define the optional styles for chart export.

- MenuExtendedClass: Text - Add custom style classes to the context menu. You define your custom style classes in your application using CSS. Examples:
- Blank - No custom styles are added (default value).
- "myclass" - Adds the myclass style to the UI styles being applied.
- "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.

## ChartLegendOptionalConfigs

Set additional parameters to customize the chart series legend behavior and functionality.

- Floating: Boolean = False - Set to True to the legend above the chart. By default, False.

## ChartLegendStyling

Define the styles for the legend of the chart.

- BackgroundColor: Text = "transparent" - Set the background color of the legend. By default, the legend has no background color (transparent).
- ItemsDistance: Integer = 20 - Set the distance between the items, in pixels, of the legend. By default, the items have a distance of 20px between them.

## DataPoint

Information to plot a data point on the chart.

- Value: Decimal [obrigatorio] - The value to be plotted.
- Label: Text [obrigatorio] - The label of the data point.
- SeriesName: Text - The name of the series where the data point belongs.
- Color: Text - The color of the data point. By default, the chart will be presented with the OutSystems data visualization color palette.
- Tooltip: Text - The text that will be displayed on the tooltip of the data point. By default, the tooltip contains the label and value of the point, following the structure [Label]: [Value].  Example: "Apples: 58"

## ErrorMessage

Return message from actions.

- Code: Text - Code that tells if there was any success or error resulting from the actions.
- Message: Text - Message that explains the resulting code from the actions.

## ExportInternalConfigs

- UniqueId: Text
- ExtendedClass: Text
- Filename: Text
- MenuExtendedClass: Text
- DownloadJPEG: ChartExportOption - Configure the menu option that allows users to download the chart as a .jpeg image. By default, this option is visible on the menu with the label “Download JPEG image”.
- DownloadPDF: ChartExportOption - Configure the menu option that allows users to download the chart as a .pdf file. By default, this option is visible on the menu with the label “Download PDF image”.
- DownloadPNG: ChartExportOption - Configure the menu option that allows users to download the chart as a .jpeg image. By default, this option is visible on the menu with the label “Download JPEG image”.
- DownloadSVG: ChartExportOption - Configure the menu option that allows users to download the chart as a .svg vector image. By default, this option is visible on the menu with the label “Download SVG vector image”.
- DownloadCSV: ChartExportOption - Configure the menu option that allows users to download the chart as a .csv file. By default, this option is visible on the menu with the label “Download CSV”.
- DownloadXLS: ChartExportOption - Configure the menu option that allows users to download the chart as a .xls file. By default, this option is visible on the menu with the label “Download XLS”.
- PrintChart: ChartExportOption - Configure the menu option that allows users to print the chart. By default, this option is visible on the menu with the label “Print chart”.
- ViewInFullScreen: ChartExportOption - Configure the menu option that allows users to see the chart in full screen. By default, this option is visible on the menu with the label "View in full screen".

## InternalConfig

Holds the internal configurations for a chart.

- Chart: Chart
- StackingType: StackingType Identifier
- UniqueId: Text
- ValuesType: ValuesType Identifier
- disableLoadingAnimation: Boolean = False - Set to True to disable the loading animation shown while the chart's data is being fetched. By default, False, a loading animation is displayed.

## Legacy_AdvancedDataPointFormat

Information to format a data point using Highcharts JSON.

- DataPoint: Legacy_DataPoint - Information to plot a data point on the chart.
- DataPointJSON: Text - Highcharts JSON to format the data point.

## Legacy_AdvancedDataSeriesFormat

Information to format a data series using Highcharts JSON.

- SeriesName: Text - Name of the data series to format.
- DataSeriesJSON: Text - Highcharts JSON to format the data series.

## Legacy_AdvancedFormat

Information to format chart elements using Highcharts JSON.

- DataPointFormats: Legacy_AdvancedDataPointFormat List - Highcharts JSON to format data points.
- DataSeriesFormats: Legacy_AdvancedDataSeriesFormat List - Highcharts JSON to format data series.
- XAxisJSON: Text - Highcharts JSON to format the X-axis.
- YAxisJSON: Text - Highcharts JSON to format the Y-axis.
- HighchartsJSON: Text - Highcharts JSON to format any element of the chart.

## Legacy_AdvancedFormat_JSON

Information to format chart elements using Highcharts JSON.

- DataPointFormatsJSON: Text - Highcharts JSON to format data points.
- DataSeriesFormatsJSON: Text - Highcharts JSON to format data series.
- XAxisJSON: Text - Highcharts JSON to format the X-axis.
- YAxisJSON: Text - Highcharts JSON to format the Y-axis.
- HighchartsJSON: Text - Highcharts JSON to format any element of the chart.

## Legacy_Chart

Holds basic configurations about a chart.

- plotShadow: Boolean [obrigatorio] - Sets if plot shadow is to be used or not.
- type: Text [obrigatorio] - Chart's type.
- renderTo: Text [obrigatorio] - Indicates the element where the chart will be rendered on.
- height: Integer [obrigatorio] - Chart's height.
- animation: Boolean [obrigatorio] = True - Sets if the chart will have animation or not.
- backgroundColor: Text [obrigatorio] = "rgba(255, 255, 255, 0)" - Custom background color for the chart.

## Legacy_ChartFormat

Information to format the chart.

- ShowDataPointValues: Boolean = False - Set to True to display the value of the data points.
- UseAnimation: Boolean [obrigatorio] = True - Set to True to plot the chart with animation.

## Legacy_DataPoint

Information to plot a data point on the chart.

- Label: Text [obrigatorio] - The label on the X-axis for the data point.
- Value: Decimal [obrigatorio] - The value to be plotted.
- SeriesName: Text - Name of the series where the data point belongs.
- Tooltip: Text - Custom tooltip for the data point when hovering the mouse.
- Color: Text - Custom color for the data point.

## Legacy_InternalConfig

Holds the internal configurations for a chart.

- chart: Legacy_Chart - Holds basic configurations about a chart.
- chartFormat: Legacy_ChartFormat - Information to format the chart.
- stackingTypeId: StackingType_v1 Identifier - Holds the stacking type.
- xAxisFormat: Legacy_XAxisFormat - Information to format the X-axis on the chart.
- xAxisType: Text - Can be one of:
'linear', 'logarithmic', 'datetime' or 'category'.
In a datetime axis, the numbers are given in milliseconds, and tick marks are placed on appropriate values like full hours or days.
- yAxisFormat: Legacy_YAxisFormat - Information to format the Y-axis on the chart.
- legendPositionId: LegendPosition_v1 Identifier - Holds the legend position.
- uniqueId: Text - Holds the chart unique identifier.
- advancedFormat_JSON: Legacy_AdvancedFormat_JSON - Information to format chart elements using Highcharts JSON.
- isClickable: Boolean - Sets if the chart is clickable or not.

## Legacy_XAxisFormat

Information to format the X-axis on the chart.

- Title: Text - The text displayed next to the X-axis.
- LabelsRotation: Integer - The counterclockwise rotation in degrees of all labels displayed on the X-axis.
- MinValue: Text - The minimum value that is displayed on the X-axis.
- MaxValue: Text - The maximum value that is displayed on the X-axis.
- ValuesType: XAxisValuesType_v1 Identifier - The data type of labels displayed on the X-axis to format them.
Using ‘Auto’ means the type is inferred from the label of the first data point.

## Legacy_YAxisFormat

Information to format the Y-axis on the chart.

- Title: Text - The text displayed next to the Y-axis.
- MinValue: Decimal = -2147483647 - The minimum value that is displayed on the Y-axis.
- MaxValue: Decimal = -2147483647 - The maximum value that is displayed on the Y-axis.
- ValuesPrefix: Text - The text prefixing the values displayed on the Y-axis.
- ValuesSuffix: Text - The text suffixing the values displayed on the Y-axis.
- GridLineStep: Decimal = -2147483647 - The step by which grid lines are displayed on the Y-axis.

## LegendInternalConfigs

- UniqueId: Text
- Visible: Boolean = True - Set to True to display the X axis and its elements on the chart. False, otherwise. By default, the Y axis is visible.
- Position: LegendPosition Identifier - Set the Legend's position (Default: Bottom). The predefined options are:
    -Bottom
    -BottomLeft
    -BottomRight
    -Center
    -Left
    -Right
    -Top
    -TopLeft
    -TopRight

Examples:
    Entities.Position.Right - The Legend is displayed to the right of the chart.Entities.
    Position.Bottom - The Legend is displayed underneath the chart.
- Layout: LegendLayout Identifier = Entities.LegendLayout.Horizontal - The layout of the legend items. The layout of the legend can be: 
    - Horizontal
    - Vertical
    - Proximate: the legend items will be placed as close as possible to the graphs they're representing, except in inverted charts or when the legend position doesn't allow it.

By default, the legend layout is horizontal.
- ExtendedClass: Text - Add custom style classes to the pattern. You define your custom style classes in your application using CSS.
Examples:
    - Blank - No custom styles are added (default value).
    - "myclass" - Adds the myclass style to the UI styles being applied.
    - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.
- BackgroundColor: Text [obrigatorio] = "transparent" - Set the background color of the legend. By default, the legend has no background color (transparent).
- ItemsDistance: Integer [obrigatorio] = 20 - Set the distance between the items, in pixels, of the legend. By default, the items have a distance of 20px between them.
- Floating: Boolean [obrigatorio] = False - Set to True to have place the legend above the chart. By default, False.

## OptionalConfigs

Set additional parameters to customize the Chart behavior and functionality.

- DisableLoadingAnimation: Boolean = False - Set to True to disable the loading animation shown while the chart's data is being fetched. If True, a "Loading" message will be displayed (HighCharts default behavior). By default, False, a loading animation is displayed.

## PropertyValue

Structure used for charts extensibility with the property path and its value.

- PropertyPathList: Text List [obrigatorio] - The name of the Highcharts property.
Check all Highharts chart properties at: https://api.highcharts.com/highcharts
- Value: Text [obrigatorio] - The value to be set for the property entered in the Property field. All values must be entered as Text.
If the value is True, it should be entered as “True”.

## ReturnMessage

Returning structures from actions.

- IsSuccess: Boolean
- Code: Text
- Message: Text
- Value: Text

## SeriesStyling

Define the styles for a given series of the chart.

- FillColor: Text - Customize the background color of the series. By default, background colors are defined based on OutSystems data visualization color palette.
- LineColor: Text - Set the color of the line (area and line series) or the color of series outline (bar and column series).
- LineWidth: Text - Set the width of the line (area and line series) or the width of the series outline (bar and column series). 
Example: "2" (the line width will be 2px)
- Opacity: Text - Customize the opacity of the chart series. The opacity varies between 0 and 1.

## SeriesStylingMarker

Define the styles for the marker inside a specific serie of the chart.

- HideMarker: Boolean = False - Set to True to hide the point markers. Set to False, to show them. 
By default, markers are visible (False).
- FillColor: Text - Set the color of the marker symbol. 
By default, markers have the color of the series.
- BorderColor: Text - Set the color of the marker's border. 
By default, markers don't have border.
- BorderWidth: Text - Set the width of the marker's border. 
By default, border width is 0. 
Example: "2" (the marker will have a border width of 2px)
- Radius: Integer = 4 - Set the radius of the symbol's markers. By default, 4.
- MarkerSymbol: Text - Set a predefined shape or symbol for markers. 
You can select between:
- 'circle'
- 'square'
- 'diamond'
- 'triangle'
- 'triangle-down'

Alternatively, you can set an image as a symbol. To do that, use: 'url(graphic.png)'.

## SeriesStylingOptionalConfigs

Define the optional styles for a given serie of the chart.

- ShowInLegend: Boolean = True - Set to True to show this series on the chart legend. False, otherwise (to not display this series in legend).
By default all series are displayed in the legend.
- xAxisId: Text = "" - When using dual or multiple X-axes, set the ID or index of the xAxis that this particular series is connected to.
- yAxisId: Text = "" - When using dual or multiple Y-axes, set the ID or index of the yAxis that this particular series is connected to.

## SerieStylingInternalConfigs

- UniqueId: Text
- Binding: Text
- Type: SeriesType Identifier
- MarkerHideMarker: Boolean
- MarkerFillColor: Text
- MarkerBorderColor: Text
- MarkerBorderWidth: Text
- MarkerSymbol: Text
- MarkerRadius: Integer = 4
- ShowDataPointValues: Boolean
- FillColor: Text
- LineColor: Text
- LineWidth: Text
- Opacity: Text
- ShowInLegend: Boolean = True
- ExtendedClass: Text
- XAxisId: Text = "0"
- YAxisId: Text = "0"

## XAxisGridLinesStyling

Define the styles for the vertical lines of the chart.

- GridLineStep: Integer - The step by which grid lines are displayed on the X-axis.
By default, the grid line step is automatically calculated according to the data and chart dimensions.
- LinesColor: Text = "#ccd6eb" - Customize the color of the grid lines extending the ticks across the chart area.
By default, the color of the lines is #CCD6EB.
- LinesWidth: Text - Customize the width, in pixels, of the grid lines extending the ticks across the chart area.
By default, the line width is 0px.

## XAxisOptionalConfigs

Set additional parameters to customize the XAxis behavior and functionality.

- ValuesType: AxisValuesType Identifier = Entities.AxisValuesType.Category - The type of axis. The type of the values can be:
- Linear: the numbers along the axis are of linear scale. The Chart block ValuesType must be Integer or Decimal.
- Logarithmic: the numbers along the axis increase logarithmically and the axis adjusts itself to the data series present in the chart. The Chart block ValuesType must be Integer or Decimal.
- Datetime: The Chart block ValuesType must be DateTime.
- Category: the names of the categories are used instead of numbers or dates on the axis. The Chart block ValuesType must be Text.
By default, the type is category.
- Crosshair: Boolean = False - Set to True to show a vertical crosshair that follows either the mouse pointer or the hovered point.
Set to false, otherwise. By default, false.
- Opposite: Boolean = False - Set to true to display the axis on the opposite side of the normal. The normal side is on the left side for vertical axes and bottom for horizontal, so the opposite sides will be right and top respectively. This is typically used with dual or multiple axes.

## XAxisStyling

Define the styles for the X axis of the chart.

- LineColor: Text = "#ccd6eb" - Customize the color of the line marking the axis itself.
By default, the line color is #ccd6eb.
- LineWidth: Text - Customize the width, in pixels, of the line marking the axis itself.
Example: "2" (the line width is 2px)

## YAxisGridLinesStyling

Define the styles for the horizontal lines of the chart.

- GridLineStep: Integer - The step by which grid lines are displayed on the Y-axis.
By default, the grid line step is automatically calculated according to the data and chart dimensions.
- LinesColor: Text = "#ccd6eb" - Customize the color of the grid lines extending the ticks across the chart area.
By default, the color of the lines is #CCD6EB.
- LinesWidth: Text - Customize the width, in pixels, of the grid lines extending the ticks across the chart area.
By default, the line width is 1px.

## YAxisOptionalConfigs

Set additional parameters to customize the YAxis behavior and functionality.

- ValuesType: AxisValuesType Identifier = Entities.AxisValuesType.Linear - The type of axis. The type of the values can be: 
- Linear: the numbers along the axis are of linear scale. 
- Logarithmic: the numbers along the axis increase logarithmically and the axis adjusts itself to the data series present in the chart.
- Datetime
- Category: the names of the categories are used instead of numbers or dates on the axis.

By default, the type is linear.
- Crosshair: Boolean = False - Set to True to show a horizontal crosshair that follows either the mouse pointer or the hovered point.
Set to false, otherwise. By default, false.
- Opposite: Boolean = False - Set to true to display the axis on the opposite side of the normal. The normal side is on the left side for vertical axes and bottom for horizontal, so the opposite sides will be right and top respectively. This is typically used with dual or multiple axes.

## YAxisStyling

Define the styles for the Y axis of the chart.

- LineColor: Text = "#ccd6eb" - Customize the color of the grid lines extending the ticks across the chart area.
By default, the color of the lines is #CCD6EB.
- LineWidth: Text - Customize the width, in pixels, of the line marking the axis itself.
By default, the line width is 0.
Example: "2" (the line width is 2px)

