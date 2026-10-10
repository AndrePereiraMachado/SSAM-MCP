# OSHighCharts

OutSystemsChartsWeb 2.0.0 | Traditional | UI flow **ChartLibrariesJS** | privado | 7 widgets internos

Highcharts More JS v11.4.1 (2024-04-04)

## Inputs

Nenhum.

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: HighCharts, Accessibility, JavaScript_Content

## JavaScript

JavaScript do bloco:

```js
!/**
 * Highcharts JS v11.4.1 (2024-04-04)
 *
 * (c) 2009-2024 Torstein Honsi
 *
 * License: www.highcharts.com/license
 */function(t){"object"==typeof module&&module.exports?(t.default=t,module.exports=t):"function"==typeof define&&define.amd?define("highcharts/highcharts-more",["highcharts"],function(e){return t(e),t.Highcharts=e,t}):t("undefined"!=typeof Highcharts?Highcharts:void 0)}(function(t){"use strict";var e=t?t._modules:{};function i(t,e,i,s){t.hasOwnProperty(e)||(t[e]=s.apply(null,i),"function"==typeof CustomEvent&&window.dispatchEvent(new CustomEvent("HighchartsModuleLoaded",{detail:{path:e,module:t[e]}})))}i(e,"Extensions/Pane/PaneComposition.js",[e["Core/Utilities.js"]],function(t){let{addEvent:e,correctFloat:i,defined:s,pick:o}=t;function a(t){let e;let i=this;return t&&i.pane.forEach(s=>{r(t.chartX-i.plotLeft,t.chartY-i.plotTop,s.center)&&(e=s)}),e}function r(t,e,o,a,r){let n=!0,l=o[0],h=o[1];if(s(a)&&s(r)){let s=Math.atan2(i(e-h,8),i(t-l,8));r!==a&&(n=a>r?s>=a&&s<=Math.PI||s<=r&&s>=-Math.PI:s>=a&&s<=i(r,8))}return Math.sqrt(Math.pow(t-l,2)+Math.pow(e-h,2))<=Math.ceil(o[2]/2)&&n}function n(t){this.polar&&(t.options.inverted&&([t.x,t.y]=[t.y,t.x]),t.isInsidePlot=this.pane.some(e=>r(t.x,t.y,e.center,e.axis&&e.axis.normalizedStartAngleRad,e.axis&&e.axis.normalizedEndAngleRad)))}function l(t){let e=this.chart;t.hoverPoint&&t.hoverPoint.plotX&&t.hoverPoint.plotY&&e.hoverPane&&!r(t.hoverPoint.plotX,t.hoverPoint.plotY,e.hoverPane.center)&&(t.hoverPoint=void 0)}function h(t){let e=this.chart;e.polar?(e.hoverPane=e.getHoverPane(t),t.filter=function(i){return i.visible&&!(!t.shared&&i.directTouch)&&o(i.options.enableMouseTracking,!0)&&(!e.hoverPane||i.xAxis.pane===e.hoverPane)}):e.hoverPane=void 0}return{compose:function(t,i){let s=t.prototype;s.getHoverPane||(s.collectionsWithUpdate.push("pane"),s.getHoverPane=a,e(t,"afterIsInsidePlot",n),e(i,"afterGetHoverData",l),e(i,"beforeGetHoverData",h))}}}),i(e,"Extensions/Pane/PaneDefaults.js",[],function(){return{pane:{center:["50%","50%"],size:"85%",innerSize:"0%",startAngle:0},background:{shape:"circle",borderWidth:1,borderColor:"#cccccc",backgroundColor:{linearGradient:{x1:0,y1:0,x2:0,y2:1},stops:[[0,"#ffffff"],[1,"#e6e6e6"]]},from:-Number.MAX_VALUE,innerRadius:0,to:Number.MAX_VALUE,outerRadius:"105%"}}}),i(e,"Extensions/Pane/Pane.js",[e["Series/CenteredUtilities.js"],e["Extensions/Pane/PaneComposition.js"],e["Extensions/Pane/PaneDefaults.js"],e["Core/Utilities.js"]],function(t,e,i,s){let{extend:o,merge:a,splat:r}=s;class n{constructor(t,e){this.coll="pane",this.init(t,e)}init(t,e){this.chart=e,this.background=[],e.pane.push(this),this.setOptions(t)}setOptions(t){this.options=t=a(i.pane,this.chart.angular?{background:{}}:void 0,t)}render(){let t=this.options,e=this.chart.renderer;this.group||(this.group=e.g("pane-group").attr({zIndex:t.zIndex||0}).add()),this.updateCenter();let s=this.options.background;if(s){let t=Math.max((s=r(s)).length,this.background.length||0);for(let e=0;e<t;e++)s[e]&&this.axis?this.renderBackground(a(i.background,s[e]),e):this.background[e]&&(this.background[e]=this.background[e].destroy(),this.background.splice(e,1))}}renderBackground(t,e){let i={class:"highcharts-pane "+(t.className||"")},s="animate";this.chart.styledMode||o(i,{fill:t.backgroundColor,stroke:t.borderColor,"stroke-width":t.borderWidth}),this.background[e]||(this.background[e]=this.chart.renderer.path().add(this.group),s="attr"),this.background[e][s]({d:this.axis.getPlotBandPath(t.from,t.to,t)}).attr(i)}updateCenter(e){this.center=(e||this.axis||{}).center=t.getCenter.call(this)}update(t,e){a(!0,this.options,t),this.setOptions(this.options),this.render(),this.chart.axes.forEach(function(t){t.pane===this&&(t.pane=null,t.update({},e))},this)}}return n.compose=e.compose,n}),i(e,"Series/AreaRange/AreaRangePoint.js",[e["Core/Series/SeriesRegistry.js"],e["Core/Utilities.js"]],function(t,e){let{area:{prototype:{pointClass:i,pointClass:{prototype:s}}}}=t.seriesTypes,{defined:o,isNumber:a}=e;return class extends i{setState(){let t=this.state,e=this.series,i=e.chart.polar;o(this.plotHigh)||(this.plotHigh=e.yAxis.toPixels(this.high,!0)),o(this.plotLow)||(this.plotLow=this.plotY=e.yAxis.toPixels(this.low,!0)),e.lowerStateMarkerGraphic=e.stateMarkerGraphic,e.stateMarkerGraphic=e.upperStateMarkerGraphic,this.graphic=this.graphics&&this.graphics[1],this.plotY=this.plotHigh,i&&a(this.plotHighX)&&(this.plotX=this.plotHighX),s.setState.apply(this,arguments),this.state=t,this.plotY=this.plotLow,this.graphic=this.graphics&&this.graphics[0],i&&a(this.plotLowX)&&(this.plotX=this.plotLowX),e.upperStateMarkerGraphic=e.stateMarkerGraphic,e.stateMarkerGraphic=e.lowerStateMarkerGraphic,e.lowerStateMarkerGraphic=void 0;let r=e.modifyMarkerSettings();s.setState.apply(this,arguments),e.restoreMarkerSettings(r)}haloPath(){let t=this.series.chart.polar,e=[];return this.plotY=this.plotLow,t&&a(this.plotLowX)&&(this.plotX=this.plotLowX),this.isInside&&(e=s.haloPath.apply(this,arguments)),this.plotY=this.plotHigh,t&&a(this.plotHighX)&&(this.plotX=this.plotHighX),this.isTopInside&&(e=e.concat(s.haloPath.apply(this,arguments))),e}isValid(){return a(this.low)&&a(this.high)}}}),i(e,"Series/AreaRange/AreaRangeSeries.js",[e["Series/AreaRange/AreaRangePoint.js"],e["Core/Globals.js"],e["Core/Series/SeriesRegistry.js"],e["Core/Utilities.js"]],function(t,e,i,s){let{noop:o}=e,{area:a,area:{prototype:r},column:{prototype:n}}=i.seriesTypes,{addEvent:l,defined:h,extend:p,isArray:d,isNumber:c,pick:u,merge:g}=s;class f extends a{toYData(t){return[t.low,t.high]}highToXY(t){let e=this.chart,i=this.xAxis.postTranslate(t.rectPlotX||0,this.yAxis.len-(t.plotHigh||0));t.plotHighX=i.x-e.plotLeft,t.plotHigh=i.y-e.plotTop,t.plotLowX=t.plotX}getGraphPath(t){let e=[],i=[],s=r.getGraphPath,o=this.options,a=this.chart.polar,n=a&&!1!==o.connectEnds,l=o.connectNulls,h,p,d,c=o.step;for(h=(t=t||this.points).length;h--;){p=t[h];let s=a?{plotX:p.rectPlotX,plotY:p.yBottom,doCurve:!1}:{plotX:p.plotX,plotY:p.plotY,do
/* ... truncado: 93958 chars a mais no JSON do catalogo */
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"OSHighCharts1","source":"IWebBlock:OSHighCharts","as":"$b"}
```
