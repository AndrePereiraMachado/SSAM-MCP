# Tabs

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Navigation** | publico | 29 widgets internos

Used to display large sets of information which can be split into different areas, whilst always remaining a click away. 

Avoid using it in large forms.

Fill in the placeholders Header and Content with the Blocks TabsHeaderItem and TabsContentItem, respectively. Use any number of these as you need.
In the parameters, specify the initial active tab, along with the Tabs orientation and justification.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ActiveTab | Text | nao |  | The default tab that is considered opened. By default, the active tab should match with DataTab of the TabHeaderItem and TabContentItem. If you want to use this as an index reference, you should set the ActiveTabAsIndex parameter as True.  Examples:     ActiveTab = "", the first tab is active.     ActiveTab = "tab-two" and the DataTab (TabHeaderItem, TabContentItem) = "tab-two", that tab will be active.     ActiveTab = 2 and ActiveTabAsIndex = True, if the third tab exists, it will be active.     ActiveTab = "Tabs2Developer" and ActiveTabAsIndex = True, the non-digits will be ignored and if the third tab exists, it will be active. |
| Orientation | Orientation Identifier | nao | Entities.Orientation.Horizontal | If Vertical, the header will be displayed side by side to the content. If Horizontal, header will be displayed above the content. |
| IsJustified | Boolean | nao |  | When set to true the Items are evenly distributed in the space available. |
| IsRight | Boolean | nao | False | When set to true, aligns the Tabs Header items to right.  This will only go into effect if the Orientation parameter is set to Vertical. |
| ActiveTabAsIndex | Boolean | nao | False | Set to True if the ActiveTab value is an index. By default, the ActiveTab value is handled as a text reference.  Examples:     ActiveTabAsIndex = True and ActiveTab = 2, if the third tab exists, it will be active.     ActiveTabAsIndex = True and ActiveTab = "Tabs2Developer", the non-digits will be ignored and if the third tab exists, it will be active.     ActiveTabAsIndex = False and ActiveTab = "tab-two", if the DataTab (TabHeaderItem, TabContentItem) = "tab-two", that tab will be active. |
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

Valores possiveis (static entities):

- **Entities.Orientation**: Horizontal, Vertical

## Placeholders

- **Tabs_Header**: Drag TabsHeaderItem blocks to this placeholder. (em `TabsWrapper`) | nasce com: WebBlockInstance:TabsHeaderItem, WebBlockInstance:TabsHeaderItem, WebBlockInstance:TabsHeaderItem (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)
- **Tabs_Content**: Drag TabsContentItem blocks to this placeholder. (em `TabsWrapper`) | nasce com: WebBlockInstance:TabsContentItem, WebBlockInstance:TabsContentItem, WebBlockInstance:TabsContentItem (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

- **OnTabChange**(CurrentTab: Integer): Event fired on tab change

## Composicao interna

- Usa os blocos: TabsHeaderItem, TabsContentItem, JavaScriptNode, EventThroughExtensibility
- Actions do bloco: OnChange
- Chama actions do modulo: Feedback_Message (contratos em [actions.md](../actions.md))

## JavaScript

JavaScript do bloco:

```js
var newTabs = function () {
    // Variables
    var tabs;
    var tabsHeader;
    var tabsHeaderItems;
    var tabsContentItems;
    var tabsContent;
    var activeTabHeader;
    var activeTabContent;
    var activeTab;
    var activeTabAsIndex;
    var widgetId;
    var changeId;
    var currentTabIndex;
    var inputsOnTabs;

    var start = function (widgetIdParam, onChangeId) {
        // Sets main objects
        widgetId = widgetIdParam;
        tabs = document.querySelector('#' + widgetId + ' > .tabs');

        // Ensure that tabs instance exists in the DOM
        if(!tabs) {
            return;
        }

        tabsHeader = tabs.querySelector('.tabs-header');
        tabsContent = tabs.querySelector('.tabs-content');

        tabsHeaderItems = Array.prototype.filter.call(tabsHeader.querySelectorAll('.tabs-header-item'), function (el) {
            return el.closest('.tabs') === tabs;
        });

        // Accessibility tabindex change values to all tabsHeaderItems
        tabsHeaderItemsParentTabId = '';
        tabsHeaderItemsCount = 0;
        tabsHeaderItems.forEach(function (item) {
            item.setAttribute('tabindex', "-1");
            // Check if the parent has changed
            if (tabsHeaderItemsParentTabId != item.parentElement.id) {
                tabsHeaderItemsParentTabId = item.parentElement.id;
                tabsHeaderItemsCount = 0;
                item.setAttribute('tabindex', "0");
            }
            item.setAttribute('data-tabheader-index', tabsHeaderItemsCount++);

            // Adds the necessary event listener to tabs
            // Adding event listeners to the wrapper (tabs) instead of each children (tabHeaderItem) to avoid unnecessary multiple event listeners
            item.addEventListener('click', onTabsClick);
            item.addEventListener('keydown', onTabsKeypress);
        });

        tabsContentItems = Array.prototype.filter.call(tabsContent.querySelectorAll('.tabs-content-item'), function (el) {
            return el.closest('.tabs') === tabs;
        });

        // Accessibility tabindex change values to all tabsContentItems
        var tabsContentTotal_I = 0;
        tabsContentItems.forEach(function (item) {
            item.setAttribute('tabindex', "-1");

            // define the aria-labelledby attribute
            if (tabsHeaderItems[tabsContentTotal_I])
                item.setAttribute('aria-labelledby', tabsHeaderItems[tabsContentTotal_I].getAttribute('id'));
            tabsContentTotal_I++;
        });

        changeId = onChangeId;
        inputsOnTabs = ['input', 'select', 'button', 'textarea'];
        var _auxActiveTabHeaderItem, _auxActiveTabContentItem;
        if(tabs.dataset.activeTabAsIndex === 'True'){activeTabAsIndex = true} else {activeTabAsIndex = false};
        
        if(activeTabAsIndex){
            // Replace every character that's not a digit with '' and use the digits as the activeTab
            activeTab = parseInt(tabs.dataset.activeTab.replace(/\D/g, ''));
        } else {
            activeTab = tabs.getAttribute('data-active-tab');
            if(activeTab !== "tab-"){
                _auxActiveTabHeaderItem = tabs.querySelector('.tabs-header-item[data-tab = '+activeTab+']');
                _auxActiveTabContentItem = tabs.querySelector('.tabs-content-item[data-tab = '+activeTab+']');
            }
            
        }

        if(activeTabAsIndex && activeTab > 0 && tabsHeaderItems[activeTab] && tabsContentItems[activeTab]) {
            // Use activeTab as index to locate the right tab header and tab content 
            activeTabHeader = tabsHeaderItems[activeTab];
            activeTabContent = tabsContentItems[activeTab];
        } else if(activeTab.length > 0 && _auxActiveTabHeaderItem && _auxActiveTabContentItem) {
            // In case activeTabAsIndex is false let's check if we have already an active header and content identied
            activeTabHeader = _auxActiveTabHeaderItem;
            activeTabContent = _auxActiveTabContentItem;
        } else {
            // Select the first as active if empty or doesn't match
            activeTabHeader = tabsHeaderItems[0];
            activeTabContent = tabsContentItems[0];
            activeTab = 0;
        }   

        // Sets header and content as active
        setTabAsActive(activeTabHeader, activeTabContent);
    };

    var setTabAsActive = function (header, content) {
        // Adds active class to active tab header and tab content
        if (header && !header.classList.contains('active')) {
            header.classList.add('active');
            header.setAttribute('aria-selected', 'true');

            // Accessibility tabindex change values
            header.setAttribute('tabindex', "0");
        }
        if (content && !content.classList.contains('active')) {
            content.classList.add('active');
            content.setAttribute('aria-hidden', 'false');

            // Accessibility tabindex change values
            content.setAttribute('tabindex', "0");
        }
    };

    var onTabsKeypress = function (e) {
        var nextTabItem = document.activeElement; // set active as default
        var items = tabsHeaderItems.length;

        // Verify if exists inputs, textareas, select or buttons inside tabs when using arrow key to navigate.
        if (document.activeElement && inputsOnTabs.indexOf(document.activeElement.tagName.toLowerCase()) !== -1) {
            return false;
        } else {
            if (tabs.classList.contains('tabs-horizontal')) {
                // Arrow Right
                if (e.keyCode == "39") {
                    nextTabItem = document.activeElement.nextElementSibling;
                    if (!nextTabItem) {
                        nextTabItem = tabsHeaderItems[0];
                        nextTabItem.focus();
                        nextTabItem.click();
                    }
                    else {
                        nextTabItem.focus();
              
/* ... truncado: 4906 chars a mais no JSON do catalogo */
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Tabs1","source":"IWebBlock:Tabs","empty":true,"as":"$b"}
```
