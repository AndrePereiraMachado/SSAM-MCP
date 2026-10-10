# OutSystemsCharts 3.10.0: actions publicas

## AdvancedFormat_Init_v1 (ClientAction, function)

Initializes an AdvancedFormat record with the values passed as arguments. The record is returned by the action.

- in DataPointFormats: Legacy_AdvancedDataPointFormat List - Advanced JSON formatting for the data points.
- in DataSeriesFormats: Legacy_AdvancedDataSeriesFormat List - Advanced JSON formatting for the data series.
- in XAxisJSON: Text - Advanced JSON formatting for the X-axis. 
Refer to Highcharts API (http://api.highcharts.com/highcharts#xAxis) for all available options.

As an example, format the dates on the X-axis to "MMM YYYY" using the following Highcharts JSON:
"labels:{ formatter: function() { return Highcharts.dateFormat('%b %Y', this.value); } }"
- in YAxisJSON: Text - Advanced JSON formatting for the Y-axis. 
Refer to Highcharts API (http://api.highcharts.com/highcharts#yAxis) for all available options.

As an example, prevent using decimals in the axis values using the following Highcharts JSON:
"allowDecimals: false"
- in HighchartsJSON: Text - Advanced JSON formatting for any element of the chart. 
Refer to Highcharts API (http://api.highcharts.com/highcharts) for all available options.
- out AdvancedFormat: Legacy_AdvancedFormat - The initialized AdvancedFormat record.

## ChartFormat_Init_v1 (ClientAction, function)

Initializes a ChartFormat record with the values passed as arguments. The record is returned by the action.

- in ShowDataPointValues: Boolean = False - Set to True to display the value of the data points.
- in UseAnimation: Boolean - Set to True to plot the chart with animation.
- out ChartFormat: Legacy_ChartFormat - The initialized ChartFormat record.

## DataPoint_Init_v1 (ClientAction, function)

Initializes a DataPoint record with the values passed as arguments. The record is returned by the action.

- in Label: Text [obrigatorio] - The label on the X-axis for the data point.
To display dates in the X-axis use the Platform Server date format (by default YYYY-MM-DD).
- in Value: Decimal [obrigatorio] - The value to be plotted.
- in DataSeriesName: Text - Name of the series where the data point belongs.
- in Tooltip: Text - Custom tooltip for the data point when hovering the mouse.
- in Color: Text - Custom color for the data point.
- out DataPoint: Legacy_DataPoint - The initialized DataPoint record.

## DataPoint_InitMissing_v1 (ClientAction, function)

Initializes a DataPoint to plot a gap on the chart. The record is returned by the action.

- in Label: Text [obrigatorio] - The label on the X-axis for the data point.
To display dates in the X-axis use the Platform Server date format (by default YYYY-MM-DD).
- in DataSeriesName: Text - Name of the series where the data point belongs.
- out DataPoint: Legacy_DataPoint - The initialized DataPoint record.

## SetHighchartsChartConfigs (ClientAction)

Extend the properties of the chart blocks with additional Highcharts configurations.
Due to security reasons, configurations/properties using callback functions, objects (e.g. arrays) cannot be used since they will not be parsed.
Check all Highcharts chart properties at: https://api.highcharts.com/highcharts/

- in WidgetId: Text [obrigatorio] - Identifier of the chart block.
- in PropertyValueList: PropertyValue List [obrigatorio] - Structure used for charts extensibility with the property path and its value.
Example: To remove the series animation, expand the list and add an entry where Property = “animation” and Value = “False”.
Check all Highcharts chart properties at: https://api.highcharts.com/highcharts/
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.

## SetHighchartsSeriesConfigs (ClientAction)

Extend the properties of a series of a chart with additional Highcharts configurations.
Due to security reasons, configurations/properties using callback functions, objects (e.g. arrays) cannot be used since they will not be parsed.
Check all Highharts chart properties at: https://api.highcharts.com/highcharts/series

- in WidgetId: Text [obrigatorio] - Identifier of the chart block.
- in SerieName: Text [obrigatorio] - The name of the series to be customized.
The name should match one of the series from the DataPointList.SeriesName.
- in PropertyValueList: PropertyValue List [obrigatorio] - Structure used for charts extensibility with the property path and its value.
Example: To remove the series animation , expand the list and add an entry where Property = “animation” and Value = “False”.
Check all Highcharts chart properties at: https://api.highcharts.com/highcharts/series
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.

## SetHighchartsXAxisConfigs (ClientAction)

Extend the properties of the x-axis of a chart with additional Highcharts configurations.
Due to security reasons, configurations/properties using callback functions, objects (e.g. arrays) cannot be used since they will not be parsed.
Check all Highharts chart properties at: https://api.highcharts.com/highcharts/xAxis

- in WidgetId: Text [obrigatorio] - Identifier of the X axis block.
- in PropertyValueList: PropertyValue List [obrigatorio] - List of Highcharts properties and corresponding values.
Example: To change the angle of the axis labels, expand the list and add an entry where Property = “angle” and Value = “45”.
Check all Highharts chart properties at: https://api.highcharts.com/highcharts/xAxis
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.

## SetHighchartsYAxisConfigs (ClientAction)

Extend the properties of the y-axis of a chart with additional Highcharts configurations.
Due to security reasons, configurations/properties using callback functions, objects (e.g. arrays) cannot be used since they will not be parsed.
Check all Highharts chart properties at: https://api.highcharts.com/highcharts/yAxis

- in WidgetId: Text [obrigatorio] - Identifier of the Y axis block.
- in PropertyValueList: PropertyValue List [obrigatorio] - List of Highcharts properties and corresponding values.
Example: To change the angle of the axis labels, expand the list and add an entry where Property = “angle” and Value = “45”.
Check all Highharts chart properties at: https://api.highcharts.com/highcharts/yAxis
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.

## UpdateChartColorScheme (ClientAction)

A list of color values to use for the chart. Some of the formats accepted are: html, rgb, rgba and hex.

- in ChartId: Text [obrigatorio] - Identifier of the chart to change the color scheme for.
- in ColorScheme: Text List [obrigatorio] - A list of color values to use for the chart.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.

## XAxisFormat_Init_v1 (ClientAction, function)

Initializes an XAxisFormat record with the values passed as arguments. The record is returned by the action.

- in Title: Text - The text displayed next to the X-axis.
- in LabelsRotation: Integer - The rotation in degrees of all labels displayed on the X-axis.
- in MinValue: Text - The minimum value that is displayed on the X-axis.
- in MaxValue: Text - The maximum value that is displayed on the X-axis.
- in ValuesType: XAxisValuesType_v1 Identifier = Entities.XAxisValuesType_v1.Auto - The data type of labels displayed on the X-axis to format them.
Using ‘Auto’ means the type is inferred from the label of the first data point.
- out XAxisFormat: Legacy_XAxisFormat - The initialized XAxisFormat record.

## YAxisFormat_Init_v1 (ClientAction, function)

Initializes an YAxisFormat record with the values passed as arguments. The record is returned by the action.

- in Title: Text - The text displayed next to the Y-axis.
- in MinValue: Decimal = -2147483647 - The minimum value that is displayed on the Y-axis.
- in MaxValue: Decimal = -2147483647 - The maximum value that is displayed on the Y-axis.
- in ValuesPrefix: Text - The text prefixing the values displayed on the Y-axis.
- in ValuesSufix: Text - The text suffixing the values displayed on the Y-axis.
- in GridLineStep: Decimal = -2147483647 - The step by which grid lines are displayed on the Y-axis.
- out YAxisFormat: Legacy_YAxisFormat - The initialized YAxisFormat record.

