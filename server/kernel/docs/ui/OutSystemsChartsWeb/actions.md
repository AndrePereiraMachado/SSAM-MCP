# OutSystemsChartsWeb 2.0.0: actions publicas

## AdvancedFormat_Init (ServerAction, function)

Initializes an AdvancedFormat record with the values passed as arguments. The record is returned by the action.

- in DataPointFormats: AdvancedDataPointFormat Record List - Advanced JSON formatting for the data points.
- in DataSeriesFormats: AdvancedDataSeriesFormat Record List - Advanced JSON formatting for the data series.
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
- out AdvancedFormat: AdvancedFormat Record - The initialized AdvancedFormat record.

## ChartFormat_Init (ServerAction, function)

Initializes a ChartFormat record with the values passed as arguments. The record is returned by the action.

- in ShowDataPointValues: Boolean = False - Set to True to display the value of the data points.
- in UseAnimation: Boolean - Set to True to plot the chart with animation.
- out ChartFormat: ChartFormat Record - The initialized ChartFormat record.

## DataPoint_GetClicked (ServerAction, function)

Returns the data point that was clicked on the chart.
Execute this action in the On Click action of a chart.

- out DataPoint: DataPoint Record - The clicked Data Point.
- chama: NotifyMessageToInternalPoint, Deprecated_NotifyGetMessage

## DataPoint_Init (ServerAction, function)

Initializes a DataPoint record with the values passed as arguments. The record is returned by the action.

- in Label: Text [obrigatorio] - The label on the X-axis for the data point.
To display dates in the X-axis use the Platform Server date format (by default YYYY-MM-DD).
- in Value: Decimal [obrigatorio] - The value to be plotted.
- in DataSeriesName: Text - Name of the series where the data point belongs.
- in Tooltip: Text - Custom tooltip for the data point when hovering the mouse.
- in Color: Text - Custom color for the data point.
- out DataPoint: DataPoint Record - The initialized DataPoint record.

## DataPoint_InitMissing (ServerAction, function)

Initializes a DataPoint to plot a gap on the chart. The record is returned by the action.

- in Label: Text [obrigatorio] - The label on the X-axis for the data point.
To display dates in the X-axis use the Platform Server date format (by default YYYY-MM-DD).
- in DataSeriesName: Text - Name of the series where the data point belongs.
- out DataPoint: DataPoint Record - The initialized DataPoint record.

## XAxisFormat_Init (ServerAction, function)

Initializes an XAxisFormat record with the values passed as arguments. The record is returned by the action.

- in Title: Text - The text displayed next to the X-axis.
- in LabelsRotation: Integer - The rotation in degrees of all labels displayed on the X-axis.
- in MinValue: Text - The minimum value that is displayed on the X-axis.
- in MaxValue: Text - The maximum value that is displayed on the X-axis.
- in ValuesType: XAxisValuesType Identifier = Entities.XAxisValuesType.Auto - The data type of labels displayed on the X-axis to format them.
Using ‘Auto’ means the type is inferred from the label of the first data point.
- out XAxisFormat: XAxisFormat Record - The initialized XAxisFormat record.

## YAxisFormat_Init (ServerAction, function)

Initializes an YAxisFormat record with the values passed as arguments. The record is returned by the action.

- in Title: Text - The text displayed next to the Y-axis.
- in MinValue: Decimal = -2147483647 - The minimum value that is displayed on the Y-axis.
- in MaxValue: Decimal = -2147483647 - The maximum value that is displayed on the Y-axis.
- in ValuesPrefix: Text - The text prefixing the values displayed on the Y-axis.
- in ValuesSuffix: Text - The text suffixing the values displayed on the Y-axis.
- in GridLineStep: Decimal = -2147483647 - The step by which grid lines are displayed on the Y-axis.
- out YAxisFormat: YAxisFormat Record - The initialized YAxisFormat record.

