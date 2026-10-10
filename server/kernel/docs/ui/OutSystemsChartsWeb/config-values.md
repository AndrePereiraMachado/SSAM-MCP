# OutSystemsChartsWeb 2.0.0: valores de configuracao (static entities)

## Entities.InternalChartType

| Id | Order | Is_Active |
|---|---|---|
| Column | 1 | True |
| Bar | 2 | True |
| Area | 4 | True |
| Pie | 5 | True |
| Line | 3 | True |

## Entities.InternalXAxisValuesType

The data type of labels displayed on the X-axis to format them. 
Using ‘Auto’ means the type is inferred from the label of the first data point.

| Id | Label | Order |
|---|---|---|
| Date | "Date" | 3 |
| Decimal | "Decimal" | 4 |
| Text | "Text" | 2 |
| Auto | "Auto" | 1 |

## Entities.LegendPosition

The position where the legend is displayed on charts.

| Id | Order | Is_Active |
|---|---|---|
| Bottom | 1 | True |
| Hidden | 6 | True |
| Inside | 5 | True |
| Top | 2 | True |
| Left | 3 | True |
| Right | 4 | True |

## Entities.StackingType

The way to plot multiple data series on Area, Bar, or Column charts:
    - ‘NoStacking’: plot data series side by side to compare them;
    - ‘Stacked’: plot data series stacked to show their contribution to a total;
    - ‘Stacked100Percent’: plot data series stacked to show their percentage in a total.

| Id | Order | Is_Active |
|---|---|---|
| Stacked | 2 | True |
| Stacked100Percent | 3 | True |
| NoStacking | 1 | True |

## Entities.XAxisValuesType

The data type of labels displayed on the X-axis to format them. 
Using ‘Auto’ means the type is inferred from the label of the first data point.

| Id | Label | Order |
|---|---|---|
| Auto | "Auto" | 1 |
| Text | "Text" | 2 |

# Structures

## AdvancedDataPointFormat

Information to format a data point using Highcharts JSON.

- DataPoint: DataPoint Record - Data point to format.
- DataPointJSON: Text - Highcharts JSON to format the data point.
Refer to Highcharts API (http://api.highcharts.com/highcharts#series.data) for all available options.

As an example, show a custom data label in this point, using the following Highcharts JSON:
"dataLabels: { enabled: true, formatter: function () { return 'top value' } }"

## AdvancedDataSeriesFormat

Information to format a data series using Highcharts JSON.

- DataSeriesName: Text - Name of the data series to format.
- DataSeriesJSON: Text - Highcharts JSON to format the data series.
All data points belonging to the data series are affected by this formatting.
Refer to Highcharts API (http://api.highcharts.com/highcharts#series and http://api.highcharts.com/highcharts#plotOptions.series) for all available options.

As an example, plot a series with a thicker line in a Line chart using the following Highcharts JSON:
"lineWidth: 5"

## AdvancedFormat

Information to format chart elements using Highcharts JSON.

- DataPointFormats: AdvancedDataPointFormat Record List - Highcharts JSON to format data points.
- DataSeriesFormats: AdvancedDataSeriesFormat Record List - Highcharts JSON to format data series.
- XAxisJSON: Text - Highcharts JSON to format the X-axis.
Refer to Highcharts API (http://api.highcharts.com/highcharts#xAxis) for all available options.

As an example, format the dates on the X-axis to "MMM YYYY" using the following Highcharts JSON:
"labels:{ formatter: function() { return Highcharts.dateFormat('%b %Y', this.value); } }"
- YAxisJSON: Text - Highcharts JSON to format the Y-axis.
Refer to Highcharts API (http://api.highcharts.com/highcharts#yAxis) for all available options.

As an example, prevent using decimals in the axis values using the following Highcharts JSON:
"allowDecimals: false"
- HighchartsJSON: Text - Highcharts JSON to format any element of the chart. 
Refer to Highcharts API (http://api.highcharts.com/highcharts) for all available options.

## ChartFormat

Information to format the chart.

- ShowDataPointValues: Boolean = False - Set to True to display the value of the data points.
- UseAnimation: Boolean = False - Set to True to plot the chart with animation.

## DataPoint

Information to plot a data point on the chart.

- Label: Text [obrigatorio] - The label on the X-axis for the data point.
To display dates in the X-axis use the Platform Server date format (by default YYYY-MM-DD).
- Value: Decimal [obrigatorio] - The value to be plotted.
- DataSeriesName: Text - Name of the series where the data point belongs.
- Tooltip: Text - Custom tooltip for the data point when hovering the mouse.
- Color: Text - Custom color for the data point.

As an example, set the color of a data point to red using either of the following values: "Red", "#FF0000", "rgb(255,0,0)" or "rgba(255,0,0,1)"

## InternalCategory

- Occurence: Integer
- Category: Text

## InternalSeries

- Series: Text
- Values: DataPoint Record List
- AdvancedOptions: Text
- Color: Text = ""

## XAxisFormat

Information to format the X-axis on the chart.

- Title: Text - The text displayed next to the X-axis.
- LabelsRotation: Integer - The counterclockwise rotation in degrees of all labels displayed on the X-axis.
- MinValue: Text - The minimum value that is displayed on the X-axis.
- MaxValue: Text - The maximum value that is displayed on the X-axis.
- ValuesType: XAxisValuesType Identifier = Entities.XAxisValuesType.Auto - The data type of labels displayed on the X-axis to format them.
Using ‘Auto’ means the type is inferred from the label of the first data point.

## YAxisFormat

Information to format the Y-axis on the chart.

- Title: Text - The text displayed next to the Y-axis.
- MinValue: Decimal = -2147483647 - The minimum value that is displayed on the Y-axis.
- MaxValue: Decimal = -2147483647 - The maximum value that is displayed on the Y-axis.
- ValuesPrefix: Text - The text prefixing the values displayed on the Y-axis.
- ValuesSuffix: Text - The text suffixing the values displayed on the Y-axis.
- GridLineStep: Decimal = -2147483647 - The step by which grid lines are displayed on the Y-axis.

