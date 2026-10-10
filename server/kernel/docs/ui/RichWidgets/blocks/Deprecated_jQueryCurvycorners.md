# Deprecated_jQueryCurvycorners

RichWidgets  | Traditional | UI flow **jQueryUI** | privado | 6 widgets internos

## Inputs

Nenhum.

## Placeholders

Nenhum.

## Eventos

Nenhum.

## JavaScript

JavaScript do bloco:

```js
//jQuery Curvycorners

/* #IF_IS_SYSTEM */ outsystems.internal. /* #ENDIF_IS_SYSTEM */ jQueryCurvyCorners = function(jQuery) {
/****************************************************************
 *                                                              *
 *  JQuery Curvy Corners by Mike Jolley                         *
 *  http://blue-anvil.com                                       *
 *  http://code.google.com/p/jquerycurvycorners/                *
 *  ==========================================================  *
 *                                                              *
 *  Version 2.1.1 (Based on CC 2.1 beta)                          *
 *                                                              *
 *  Original by: Terry Riegel, Cameron Cooke and Tim Hutchison  *
 *  Website: http://www.curvycorners.net                        *
 *                                                              *
 *  This library is free software; you can redistribute         *
 *  it and/or modify it under the terms of the GNU              *
 *  Lesser General Public License as published by the           *
 *  Free Software Foundation; either version 2.1 of the         *
 *  License, or (at your option) any later version.             *
 *                                                              *
 *  This library is distributed in the hope that it will        *
 *  be useful, but WITHOUT ANY WARRANTY; without even the       *
 *  implied warranty of MERCHANTABILITY or FITNESS FOR A        *
 *  PARTICULAR PURPOSE. See the GNU Lesser General Public       *
 *  License for more details.                                   *
 *                                                              *
 *  You should have received a copy of the GNU Lesser           *
 *  General Public License along with this library;             *
 *  Inc., 59 Temple Place, Suite 330, Boston,                   *
 *  MA 02111-1307 USA                                           *
 *                                                              *
 ****************************************************************/
(function($){function curvyCnrSpec(selText){this.selectorText=selText;this.tlR=this.trR=this.blR=this.brR=0;this.tlu=this.tru=this.blu=this.bru="";this.antiAlias=true;};curvyCnrSpec.prototype.setcorner=function(tb,lr,radius,unit){if(!tb){this.tlR=this.trR=this.blR=this.brR=parseInt(radius);this.tlu=this.tru=this.blu=this.bru=unit;}else{propname=tb.charAt(0)+lr.charAt(0);this[propname+'R']=parseInt(radius);this[propname+'u']=unit;}};curvyCnrSpec.prototype.get=function(prop){if(/^(t|b)(l|r)(R|u)$/.test(prop))return this[prop];if(/^(t|b)(l|r)Ru$/.test(prop)){var pname=prop.charAt(0)+prop.charAt(1);return this[pname+'R']+this[pname+'u'];}
if(/^(t|b)Ru?$/.test(prop)){var tb=prop.charAt(0);tb+=this[tb+'lR']>this[tb+'rR']?'l':'r';var retval=this[tb+'R'];if(prop.length===3&&prop.charAt(2)==='u')
retval+=this[tb='u'];return retval;}
throw new Error('Don\'t recognize property '+prop);};curvyCnrSpec.prototype.radiusdiff=function(tb){if(tb!=='t'&&tb!=='b')throw new Error("Param must be 't' or 'b'");return Math.abs(this[tb+'lR']-this[tb+'rR']);};curvyCnrSpec.prototype.setfrom=function(obj){this.tlu=this.tru=this.blu=this.bru='px';if('tl'in obj)this.tlR=obj.tl.radius;if('tr'in obj)this.trR=obj.tr.radius;if('bl'in obj)this.blR=obj.bl.radius;if('br'in obj)this.brR=obj.br.radius;if('antiAlias'in obj)this.antiAlias=obj.antiAlias;};curvyCnrSpec.prototype.cloneOn=function(box){var props=['tl','tr','bl','br'];var converted=0;var i,propu;for(i in props)if(!isNaN(i)){propu=this[props[i]+'u'];if(propu!==''&&propu!=='px'){converted=new curvyCnrSpec;break;}}
if(!converted)
converted=this;else{var propi,propR,save=curvyBrowser.get_style(box,'left');for(i in props)if(!isNaN(i)){propi=props[i];propu=this[propi+'u'];propR=this[propi+'R'];if(propu!=='px'){var save=box.style.left;box.style.left=propR+propu;propR=box.style.pixelLeft;box.style.left=save;}
converted[propi+'R']=propR;converted[propi+'u']='px';}
box.style.left=save;}
return converted;};curvyCnrSpec.prototype.radiusSum=function(tb){if(tb!=='t'&&tb!=='b')throw new Error("Param must be 't' or 'b'");return this[tb+'lR']+this[tb+'rR'];};curvyCnrSpec.prototype.radiusCount=function(tb){var count=0;if(this[tb+'lR'])++count;if(this[tb+'rR'])++count;return count;};curvyCnrSpec.prototype.cornerNames=function(){var ret=[];if(this.tlR)ret.push('tl');if(this.trR)ret.push('tr');if(this.blR)ret.push('bl');if(this.brR)ret.push('br');return ret;};if(typeof redrawList==='undefined')redrawList=new Array;$.fn.corner=function(options){var nativeCornersSupported=false;var checkWebkit,checkMozilla,checkStandard;try{checkWebkit=(document.body.style.WebkitBorderRadius!==undefined);}catch(err){}
try{checkMozilla=(document.body.style.MozBorderRadius!==undefined);}catch(err){}
try{checkStandard=(document.body.style.BorderRadius!==undefined||document.body.style.borderRadius!==undefined);}catch(err){}
if(checkWebkit||checkMozilla||checkStandard)nativeCornersSupported=true;if(options instanceof curvyCnrSpec){settings=options;}
else{var options=jQuery.extend({tl:{radius:8},tr:{radius:8},bl:{radius:8},br:{radius:8},antiAlias:true},options);var settings=new curvyCnrSpec(this);settings.setfrom(options);}
function curvyObject()
{this.box=arguments[1];this.settings=arguments[0];var $$=$(this.box);var boxDisp;this.masterCorners=new Array();this.topContainer=this.bottomContainer=this.shell=boxDisp=null;var boxWidth=$$.innerWidth();if($$.is('table'))
throw new Error("You cannot apply corners to "+this.box.tagName+" elements.","Error");if($$.css('display')==='inline'){$$.css('display','inline-block');}
if(!boxWidth){this.applyCorners=function(){};return;}
if(arguments[0]instanceof curvyCnrSpec){this.spec=arguments[0].cloneOn(this.box);}else{this.spec=new curvyCnrSpec('');this.spec.setfrom(this.settings);}
var borderWidth=$$.css("borderTopWidth")?$$.css("borderTopWidth"):0;var borderWidthB=$$.css("borderBottomWidth")?$$.css("borde
/* ... truncado: 22468 chars a mais no JSON do catalogo */
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Deprecated_jQueryCurvycorners1","source":"IWebBlock:Deprecated_jQueryCurvycorners","as":"$b"}
```
