# LoadingCSS

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

Classes: `.chart-wrapper`, `.os-chart--disable-loading-animation`, `.os-area-chart`, `.osareachart`, `.svg`, `.os-bar-chart`, `.osbarchart`, `.os-column-chart`, `.oscolumnchart`, `.os-donut-chart`, `.osdonutchart`, `.os-line-chart`, `.oslinechart`, `.os-pie-chart`, `.ospiechart`, `.os-radar-chart`, `.osradarchart`, `.highcharts-root`, `.highcharts-loading-hidden`, `.highcharts-loading`

Variaveis: `--disable-loading-animation`, `--os-chart-loading-image`

```css
/* Charts Loading Animation Images*/
.chart-wrapper:not(.os-chart--disable-loading-animation).os-area-chart {
    --os-chart-loading-image: url(/OutSystemsCharts/img/OutSystemsCharts.osareachart.svg);
}

.chart-wrapper:not(.os-chart--disable-loading-animation).os-bar-chart {
    --os-chart-loading-image: url(/OutSystemsCharts/img/OutSystemsCharts.osbarchart.svg);
}

.chart-wrapper:not(.os-chart--disable-loading-animation).os-column-chart {
    --os-chart-loading-image: url(/OutSystemsCharts/img/OutSystemsCharts.oscolumnchart.svg);
}

.chart-wrapper:not(.os-chart--disable-loading-animation).os-donut-chart {
    --os-chart-loading-image: url(/OutSystemsCharts/img/OutSystemsCharts.osdonutchart.svg);
}

.chart-wrapper:not(.os-chart--disable-loading-animation).os-line-chart {
    --os-chart-loading-image: url(/OutSystemsCharts/img/OutSystemsCharts.oslinechart.svg);
}

.chart-wrapper:not(.os-chart--disable-loading-animation).os-pie-chart {
    --os-chart-loading-image: url(/OutSystemsCharts/img/OutSystemsCharts.ospiechart.svg);
}

.chart-wrapper:not(.os-chart--disable-loading-animation).os-radar-chart {
    --os-chart-loading-image: url(/OutSystemsCharts/img/OutSystemsCharts.osradarchart.svg);
}


/* Hide/Disable the Charts when the loading is present, to avoid UI conflicts, due to skeleton transparency */
.chart-wrapper:not(.os-chart--disable-loading-animation) .highcharts-root {
    transition: opacity 100ms linear 50ms;
    opacity:0;
}

.chart-wrapper:not(.os-chart--disable-loading-animation):has(.highcharts-loading-hidden) .highcharts-root {
    opacity:1;
}

.chart-wrapper:has(.highcharts-loading:not(.highcharts-loading-hidden)) .highcharts-root {
    pointer-events: none;
}

/* Highcharts Loading container where we add the skeleton image as background*/
.chart-wrapper:not(.os-chart--disable-loading-animation) .highcharts-loading {
    background-size: contain;
    background-image: var(--os-chart-loading-image);
    background-repeat: no-repeat;
    background-position: center;
    /* Important usages needed, as Charts adds inline styles that are not customized by the Loading configs object*/
    height: 100%!important;
    left: 50%!important;
    top: 50%!important;
    transform: translateX(-50%) translateY(-50%);
    width: 100%!important;
}

/* Pseudo element with the skeleton shimmer animation*/
.chart-wrapper:not(.os-chart--disable-loading-animation) .highcharts-loading::after {
    animation: skeletonShimmer 1s infinite;
    background-image: linear-gradient(90deg, rgba(255, 255, 255, 0) 0, rgba(255, 255, 255, 0.2) 20%, rgba(255, 255, 255, 0.5) 60%, rgba(255, 255, 255, 0));
    content: "";
    height: 100%;
    left: 0;
    position: absolute;
    top: 0;
    transform: translateX(-100%);
    width: 100%;
}

@keyframes skeletonShimmer {
    100% {
        transform: translateX(100%);
    }
}
```

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"LoadingCSS1","source":"IMobileBlock:LoadingCSS","as":"$b"}
```
