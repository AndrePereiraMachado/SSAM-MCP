# ChartCSS

OutSystemsCharts 3.10.0 | Reactive/Mobile | UI flow **Styles** | privado | 4 widgets internos

## Inputs

Nenhum.

## Placeholders

Nenhum.

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Classes: `.chart-wrapper`, `.chart-image`, `.addons-container`, `.addons-header`, `.addons-title`, `.addons-display-info`, `.addons-display-info-image`, `.addons-placeholder`, `.chart-legend`, `.chart-xaxis`, `.chart-yaxis`, `.chart-export-menu`, `.os-area-chart`, `.os-bar-chart`, `.os-column-chart`, `.os-line-chart`, `.os-donut-chart`, `.os-pie-chart`, `.os-radar-chart`, `.chart-addon`, `.chart-addon-icon`, `.chart-addon-text`, `.chart-addon-text-ellipsis`, `.chart-addon-vertical-align`

Variaveis: `--drag-and-drop-image`, `--area-bar-column-chart-legend`, `--area-chart-xaxis`, `--area-chart-yaxis`, `--bar-chart-xaxis`, `--bar-chart-yaxis`, `--column-chart-xaxis`, `--column-chart-yaxis`, `--line-chart-legend`, `--line-chart-xaxis`, `--line-chart-yaxis`, `--donut-pie-chart-legend`, `--radar-chart-legend`, `--radar-chart-xaxis`, `--radar-chart-yaxis`, `--export-menu-icon`

```css
/* 
* This pseudo element will force the .chart-wrapper to occupy all the possibly width.
* This is specially important when the chart is inside an if. 
*/
.chart-image:before {
    -servicestudio-content: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    -servicestudio-display: block;
    -servicestudio-height: 0;
    -servicestudio-overflow: hidden;
    -servicestudio-word-break: break-all;
}

.addons-container{
    -servicestudio-background-color: #F7F8FA;
    -servicestudio-border-color: #A2A4A7;
    -servicestudio-border-style: dashed;
    -servicestudio-border-width: 1px;
    -servicestudio-color: #3B3D41;
    -servicestudio-font-family: 'Verdana';
    -servicestudio-margin: 20px 20px 0px 20px;
    -servicestudio-padding: 10px 10px;
}

.addons-container .addons-header{
    -servicestudio-align-items: center;
    -servicestudio-column-gap: 29px;
    -servicestudio-display: flex;
    -servicestudio-flex-wrap: wrap;
    -servicestudio-justify-content: flex-start;
    -servicestudio-margin-bottom: 5px;
    -servicestudio-min-height: 15px;
}

.addons-container .addons-header .addons-title{
    -servicestudio-color: #2C2F32;
    -servicestudio-display: flex;
    -servicestudio-font-size: 12px;
    -servicestudio-font-weight: 700;
    -servicestudio-justify-content: center;
}

.addons-container .addons-header .addons-display-info{
    -servicestudio-align-items: flex;
    -servicestudio-color: #A2A4A7;
    -servicestudio-display: flex;
    -servicestudio-font-size: 10px;
    -servicestudio-font-weight: 400;
    -servicestudio-text-align: left;
}

.addons-container .addons-header .addons-display-info .addons-display-info-image{
    -servicestudio-height: 10px;
    -servicestudio-margin-right: 3px;
    -servicestudio-width: 10px;
}

.addons-container .addons-placeholder{
    -servicestudio-border-width: 0px;
    -servicestudio-display: flex;
    -servicestudio-flex-wrap: wrap;
    -servicestudio-gap: 5px;
    -servicestudio-width: 100%;
}

.addons-container .addons-placeholder:empty{
    -servicestudio-align-items: center;
    -servicestudio-border-width: 0px;
    -servicestudio-color: #A2A4A7;
    -servicestudio-content: "";
    -servicestudio-display: flex;
    -servicestudio-font-size: 10px;
    -servicestudio-font-weight: 400;
    -servicestudio-justify-content: center;
    -servicestudio-line-height: 14px;
    -servicestudio-min-height: 65px;
    -servicestudio-width: auto;
}

.addons-container .addons-placeholder:empty:after{
    -servicestudio-content: var(--drag-and-drop-image) "\aTo customize your chart, drag addons to this section."; 
    -servicestudio-text-align: center;
    -servicestudio-white-space: pre-wrap;
    -servicestudio-width: 100%;
}

.chart-wrapper {
    -servicestudio-position: relative;
    -servicestudio-z-index: 0;
}

.chart-legend:after,
.chart-xaxis:after,
.chart-yaxis:after,
.chart-export-menu:after {
    -servicestudio-background-repeat: no-repeat;
    -servicestudio-background-size: 100%;
    -servicestudio-content: '';
    -servicestudio-height: 100%;
    -servicestudio-left: 0;
    -servicestudio-max-height: 250px;  /* max height of the image */
    -servicestudio-max-width: 820px; /* max width of the image */
    -servicestudio-pointer-events: none;
    -servicestudio-position: absolute;
    -servicestudio-top: 0;
    -servicestudio-width: 100%;
    -servicestudio-z-index: -1;
}

.os-area-chart .chart-legend:after,
.os-bar-chart .chart-legend:after,
.os-column-chart .chart-legend:after {
    -servicestudio-background-image: var(--area-bar-column-chart-legend);
}

.os-area-chart .chart-xaxis:after {
    -servicestudio-background-image: var(--area-chart-xaxis);
}
.os-area-chart .chart-yaxis:after {
    -servicestudio-background-image: var(--area-chart-yaxis);
}

.os-bar-chart .chart-xaxis:after {
    -servicestudio-background-image: var(--bar-chart-xaxis);
}
.os-bar-chart .chart-yaxis:after {
    -servicestudio-background-image: var(--bar-chart-yaxis);
}

.os-column-chart .chart-xaxis:after {
    -servicestudio-background-image: var(--column-chart-xaxis);
}
.os-column-chart .chart-yaxis:after {
    -servicestudio-background-image: var(--column-chart-yaxis);
}

.os-line-chart .chart-legend:after {
    -servicestudio-background-image:  var(--line-chart-legend);
}

.os-line-chart .chart-xaxis:after {
    -servicestudio-background-image: var(--line-chart-xaxis);
}
.os-line-chart .chart-yaxis:after {
    -servicestudio-background-image: var(--line-chart-yaxis);
}

.os-donut-chart .chart-legend:after,
.os-pie-chart .chart-legend:after {
    -servicestudio-background-image: var(--donut-pie-chart-legend);
}

.os-radar-chart .chart-legend:after {
    -servicestudio-background-image: var(--radar-chart-legend);
}

.os-radar-chart .chart-xaxis:after {
    -servicestudio-background-image: var(--radar-chart-xaxis);
}
.os-radar-chart .chart-yaxis:after {
    -servicestudio-background-image: var(--radar-chart-yaxis);
}

.os-area-chart .chart-export-menu:after,
.os-bar-chart .chart-export-menu:after,
.os-column-chart .chart-export-menu:after,
.os-donut-chart .chart-export-menu:after,
.os-line-chart .chart-export-menu:after,
.os-pie-chart .chart-export-menu:after,
.os-radar-chart  .chart-export-menu:after{
    -servicestudio-background-image: var(--export-menu-icon);
}

.chart-addon {
    -servicestudio-background: #f8f9fa;
    -servicestudio-border-radius: 4px;
    -servicestudio-border: 2px solid #dee2e6;
    -servicestudio-color: #101213;
    -servicestudio-font-size: 10px;
    -servicestudio-padding: 4px 8px;
}

.chart-addon-icon {
    -servicestudio-margin-right: 4px;
}

.chart-addon-text {
    -servicestudio-font-weight: bold;
}

.chart-addon-text-ellipsis {
    -servicestudio-max-width: 250px;
    -servicestudio-overflow: hidden;
    -servicestudio-white-space: nowrap;
    -servicestudio-text-overflow: ellipsis;
}

.chart-addon-vertical-align {
    -servicestudio-align-items: center;
    -servicestudio-display: flex;
}
```

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"ChartCSS1","source":"IMobileBlock:ChartCSS","as":"$b"}
```
