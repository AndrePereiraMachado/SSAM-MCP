# Choices_v3_0_3

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Libraries** | privado | 5 widgets internos

Choices library. Used to create DropDownSelect.

Current version: 3.0.3
https://github.com/jshjohnson/Choices

## Inputs

Nenhum.

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: ObjectAssignPolyfill, JavaScriptNode

## JavaScript

JavaScript do bloco:

```js
/*! Based on choices.js v3.0.3 and changed by OutSystems UI team | (c) 2018 Josh Johnson | https://github.com/jshjohnson/Choices#readme */ 
(function webpackUniversalModuleDefinition(root, factory) {
  if(typeof exports === 'object' && typeof module === 'object')
      module.exports = factory();
  else if(typeof define === 'function' && define.amd)
      define([], factory);
  else if(typeof exports === 'object')
      exports["Choices"] = factory();
  else
      root["Choices"] = factory();
})(this, function() {
return /******/ (function(modules) { // webpackBootstrap
/******/     // The module cache
/******/     var installedModules = {};

/******/     // The require function
/******/     function __webpack_require__(moduleId) {

/******/         // Check if module is in cache
/******/         if(installedModules[moduleId])
/******/             return installedModules[moduleId].exports;

/******/         // Create a new module (and put it into the cache)
/******/         var module = installedModules[moduleId] = {
/******/             exports: {},
/******/             id: moduleId,
/******/             loaded: false
/******/         };

/******/         // Execute the module function
/******/         modules[moduleId].call(module.exports, module, module.exports, __webpack_require__);

/******/         // Flag the module as loaded
/******/         module.loaded = true;

/******/         // Return the exports of the module
/******/         return module.exports;
/******/     }


/******/     // expose the modules object (__webpack_modules__)
/******/     __webpack_require__.m = modules;

/******/     // expose the module cache
/******/     __webpack_require__.c = installedModules;

/******/     // __webpack_public_path__
/******/     __webpack_require__.p = "/assets/scripts/dist/";

/******/     // Load entry module and return exports
/******/     return __webpack_require__(0);
/******/ })
/************************************************************************/
/******/ ([
/* 0 */
/***/ (function(module, exports, __webpack_require__) {

  module.exports = __webpack_require__(1);


/***/ }),
/* 1 */
/***/ (function(module, exports, __webpack_require__) {

  'use strict';

  var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

  var _fuse = __webpack_require__(2);

  var _fuse2 = _interopRequireDefault(_fuse);

  var _classnames = __webpack_require__(3);

  var _classnames2 = _interopRequireDefault(_classnames);

  var _index = __webpack_require__(4);

  var _index2 = _interopRequireDefault(_index);

  var _index3 = __webpack_require__(31);

  var _utils = __webpack_require__(32);

  __webpack_require__(33);

  function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

  function _defineProperty(obj, key, value) { if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }

  function _toConsumableArray(arr) { if (Array.isArray(arr)) { for (var i = 0, arr2 = Array(arr.length); i < arr.length; i++) { arr2[i] = arr[i]; } return arr2; } else { return Array.from(arr); } }

  function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

  /**
   * Choices
   */
  var Choices = function () {
    function Choices() {
      var element = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : '[data-choice]';
      var userConfig = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};

      _classCallCheck(this, Choices);

      // If there are multiple elements, create a new instance
      // for each element besides the first one (as that already has an instance)
      if ((0, _utils.isType)('String', element)) {
        var elements = document.querySelectorAll(element);
        if (elements.length > 1) {
          for (var i = 1; i < elements.length; i++) {
            var el = elements[i];
            new Choices(el, userConfig);
          }
        }
      }

      var defaultConfig = {
        silent: false,
        items: [],
        choices: [],
        renderChoiceLimit: -1,
        maxItemCount: -1,
        addItems: true,
        removeItems: true,
        removeItemButton: true,
        editItems: false,
        duplicateItems: true,
        delimiter: ',',
        paste: true,
        searchEnabled: true,
        searchChoices: true,
        searchFloor: 1,
        searchResultLimit: 4,
        searchFields: ['label', 'value'],
        position: 'auto',
        resetScrollPosition: true,
        regexFilter: null,
        shouldSort: true,
        shouldSortItems: false,
        sortFilter: _utils.sortByAlpha,
        placeholder: true,
        placeholderValue: null,
        searchPlaceholderValue: null,
        prependValue: null,
        appendValue: null,
        renderSelectedChoices: 'auto',
        loadingText: 'Loading...',
        noResultsText: 'No results found',
        noChoicesText: 'No choices to choose from',
        itemSelectText: '',
        addItemText: function addItemText(value) {
          return 'Press Enter to add <b>"' + value + '"</b>';
        },
        maxItemText: function maxItemText(maxItemCount) {
          return 'Only ' + maxItemCount + ' values can be added.';
        },
        uniqueItemText: 'Only unique values can be added.',
        classNames: {
          containerOuter: 'c
/* ... truncado: 200317 chars a mais no JSON do catalogo */
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Choices_v3_0_31","source":"IWebBlock:Choices_v3_0_3","as":"$b"}
```
