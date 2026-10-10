# Input_AutoComplete

RichWidgets  | Traditional | UI flow **RichWidgets** | publico | 9 widgets internos

Shows a list of options in a dropdown that match what the user types on an input widget.
Use the Input_AutoComplete_ShowList() action on the OnNotify action of this widget to set the list of options to show.

The ShowList should include the full set of results and not only a subset.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| InputWidgetId | Text | sim |  | The Id of the Input widget where the user will type the text and where the dropdown list of options will be shown. |
| SearchOnlyFromStart | Boolean | nao | True | If set to True (default), results will be filtered to return matching lablels that "start with" the entered text rather than "contain" the query string. |
| CacheResults | Boolean | nao | False | If set to True, the results will be cached and fewer roundtrips will be done to the server. Only do that if your query returns all possible results and not a Top 10 or similar. |
| DelayInMilliseconds | Integer | nao | 200 | The amount of milliseconds to wait for another character before showing the autocomplete list |

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: RichWidgetsjQueryUI
- Actions do bloco: FakeOnNotify
- Chama actions do modulo: Deprecated_Notify (contratos em [actions.md](../actions.md))

## JavaScript

JavaScript do bloco:

```js
var RichWidgets_Input_AutoComplete_IndexResults = function(term, items) { return true; };

function RichWidgets_Input_AutoComplete_init(inputId, inputValueId, autocompleteId, searchFromStart, usePartialResultCache, delayInMs) {

 outsystems.internal.$(function($) {
     
  var input = $("#" + inputId);
  if (input.length == 0){
    try {
       window.OsHandleException(new Error("Cannot find Input for AutoComplete Widget."), outsystems.osErrorCodes.SystemJavascriptError, 'Input_AutoComplete');
    } catch(e) {}
   return;
  }
  
  var inputAutocomplete;
  
  var autocompleteBlock = $("#" + autocompleteId);
  var inputValue = $("#" + inputValueId);
  var forceSearch = false;
  var autocompleteListOpened = false;
  
  // Hashtable with the search results, keyed by the search term
  var searchIndex = {};

  if (inputValue.val() == "") {
   inputValue.val("--unchanged--");
  }
  if (input.attr('readonly'))
    return;

  var forceOpenAutocomplete = function(event) {
   forceSearch = true;
   input.autocomplete("search", "");
   forceSearch = false;
  };

  var addItems = function(term, items, add) {

   if (RichWidgets_Input_AutoComplete_IndexResults.call(input.get(0), term, items)) {
    searchIndex[term] = items;
   }

   add(items);

   if (items.length == 0) {
    // Workaround the fact that the menu preserves the last value even if is
    // refreshed as empty
    inputAutocomplete.menu.element.empty();
    inputAutocomplete.menu.active = null;
   } else {
    // Try to find an item which exactly matches the input
    // For performance reasons, we only search in the 10 first items
    var fullMatcher = new RegExp("^" + $.ui.autocomplete.escapeRegex(input.val()) + "$", "i");
    var menuItems = inputAutocomplete.menu.element.children("li");
    for (var i = 0; i < menuItems.length && i < 10; i++) {
     if (fullMatcher.test(menuItems.eq(i).data("item.autocomplete").label)) {
      // Exact case-insensitive match: activate it
      inputAutocomplete.menu.activate($.Event("search"), menuItems.eq(i));
      return;
     }
    }

    // Activate the first item as fallback
    inputAutocomplete.menu.activate($.Event("search"), menuItems.eq(0));
   }
  };

  var onNotifySource = function(req, add) {
   window["RichWidgets_Input_AutoComplete_setListFor" + inputId.replace(/:/g, "$")] = function(rows) {
    var items = $.map(rows.split("\n"), function(row) {
     if (row != "") {
      var rowParts = $.trim(row).split("\t");
      return { label: rowParts[0], id: rowParts[1] };
     } else {
      return null;
     }
    });

    addItems(req.term, items, add);
   };

   OsNotifyWidget(autocompleteId, searchFromStart? req.term + "%" : "%" + req.term + "%");
   return true;
  };

  var onIndexedSource = function(req, add) {
   // Search exact match in the searchIndex
   var items = searchIndex[req.term];
   if (items) {
    addItems(req.term, items, add);
    return true;
   }
   
   if (usePartialResultCache) {
    // Search for a substring-match
    for (var k in searchIndex) {
     var matcher;

     if (searchFromStart && req.term.toLowerCase().indexOf(k.toLowerCase()) == 0) {
      matcher = new RegExp("^" + $.ui.autocomplete.escapeRegex(req.term), "i");
     } else if (!searchFromStart && req.term.toLowerCase().indexOf(k.toLowerCase()) != -1) {
      matcher = new RegExp($.ui.autocomplete.escapeRegex(req.term), "i");
     }

     if (matcher) {
      var items = $.map(searchIndex[k], function(item) {
       if (matcher.test(item.label)) {
        return item;
       } else {
        return null;
       }
      });
      addItems(req.term, items, add);
      return true;
     }
    }
   }

   return false;
  };

  input.autocomplete({
   delay: delayInMs,
   minLength: 0,
   source: function(req, add) {
    onIndexedSource(req, add) || onNotifySource(req, add);
   },
   search: function(event, ui) {
    if (input.val() == "" && !forceSearch) {
     // Prevent search without any input
     input.autocomplete("close");
     return false;
    }
   },
   change: function(event, ui) {
    if(autocompleteListOpened) {
        if (ui.item) {
         inputValue.val(ui.item.id);
         inputValue.trigger("onchange");
        } else {
         inputValue.val(input.val() == ""? "" : "--invalid--");
        }
    }
   },
   open: function(event, ui) {
    OsDisableSubmitOnEnterKey = true;
    autocompleteListOpened = true;
   },
   close: function(event, ui) {
    OsDisableSubmitOnEnterKey = false;
    autocompleteListOpened = false;
   },
   focus: function(event, ui) {
     inputAutocomplete.selectedItem = null;
     if (ui.item && (input.val().toLowerCase() == ui.item.label.toLowerCase())) {
       inputAutocomplete.selectedItem = ui.item;
     }
    }
  });

  inputAutocomplete = input.data("autocomplete");
  //Remove blur event from menu to avoid it from re-writing the input text
  inputAutocomplete.menu.options['blur'] = null
  //Transfer on changes to the real input
  if (input.attr("onchange") != null) {
    var onchange = input.get(0).onchange.bind(inputValue.get(0));
    inputValue.get(0).onchange = function (evt) {
        try {
            return onchange(evt);
        } catch(ex) {}
    }
    input.removeAttr("onchange");
  }
  if (input.attr("onoschange") != null) {
    inputValue.attr("onoschange", input.attr("onoschange"));
    input.removeAttr("onoschange");
  }
  inputAutocomplete.menu.element.bind("menuselected", function(event, ui) {
    if (ui.item) {
        inputValue.val(ui.item.data("item.autocomplete").id);
        inputValue.trigger("onchange");
    }
  });

  inputAutocomplete._renderItem = (function(oldRenderItem) {
   return function(ul, item) {
    var li = oldRenderItem(ul, item);
    var text = $("a", li).text();
    var html = $("a", li).html();
    var termHtml = $("<div/>").text(this.term).html();
    var regex = new RegExp("(" + $.ui.autocomplete.escapeRegex(termHtml) + ")", "i");
    $("a", li).html("<ui-autocomplete-item>" + html.replace(regex, "<strong>$1</stro
/* ... truncado: 1796 chars a mais no JSON do catalogo */
```

## CSS

Classes: `.os-internal-ui-autocomplete-loading`, `.os-internal-ui-autocomplete`, `.os-internal-ui-state-hover`

```css
input.os-internal-ui-autocomplete-loading {
    cursor: progress;
}

ul.os-internal-ui-autocomplete, ul.os-internal-ui-autocomplete li {
    margin: 0; 
    padding: 0; 
    list-style: none;
}

ul.os-internal-ui-autocomplete {
    position: absolute;
    z-index: 9999;    
    max-height: 180px;
    overflow-y: auto;
    overflow-x: hidden;
    border: 1px solid #dddddd;
    background-color: #ffffff;
}

ul.os-internal-ui-autocomplete li a {
    display: block;
    font-weight: normal;
    padding: 2px;
    outline: none;
}

ul.os-internal-ui-autocomplete a {
    border-top: 1px solid transparent;
    border-bottom: 1px solid transparent;
    background-color: #ffffff;
    color: #222222 !important;
}

ul.os-internal-ui-autocomplete a.os-internal-ui-state-hover {
    border-top: 1px solid #999999;
    border-bottom: 1px solid #999999;
    background-color: #1E5AA3;
    color: white !important;
}

/* ExcludeAllFromPickersOutsideBlock */
```

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Input_AutoComplete1","source":"IWebBlock:Input_AutoComplete","as":"$b"}
{"op":"set","target":"$b/InputWidgetId","prop":"Value","value":"<Text>"}
```
