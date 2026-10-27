const t=(name,value)=>({type:'expression',name,value});
const b=(name,component,inputs={},slots={},events={})=>({type:'component',library:'OutSystemsUIWeb',name,component,inputs,slots,events});
export const composition={screen:{name:'WidgetEventAudit',flow:'MainFlow',title:'Eventos oficiais com parâmetros'},
 variables:[{name:'SelectedDate',type:'Date',default:'CurrDate()'},{name:'ActiveIndex',type:'Integer'},{name:'SelectedAmount',type:'Decimal',default:'25'}],
 content:[
  t('Explain','"Altere a data, a aba e o valor: cada componente envia seu parâmetro para uma ação no servidor."'),
  {type:'input',name:'DateInput',bind:'SelectedDate'},
  b('Calendar','DatePicker',{InputWidgetId:'DateInput.Id',InitialDate:'SelectedDate'},{},{OnSelect:{action:'ChooseDate',arguments:{Value:'StartDate'}}}),
  b('Sections','Tabs',{}, {Tabs_Header:[b('FirstHeader','TabsHeaderItem',{DataTab:'"first"'},{Title:[t('FirstTitle','"Primeira"')]}),b('SecondHeader','TabsHeaderItem',{DataTab:'"second"'},{Title:[t('SecondTitle','"Segunda"')]})],Tabs_Content:[b('FirstBody','TabsContentItem',{DataTab:'"first"'},{Content:[t('FirstText','"Conteúdo da primeira aba"')]}),b('SecondBody','TabsContentItem',{DataTab:'"second"'},{Content:[t('SecondText','"Conteúdo da segunda aba"')]})]}, {OnTabChange:{action:'ChooseTab',arguments:{Value:'CurrentTab'}}}),
  b('Amount','RangeSlider',{MinValue:'0',MaxValue:'100',InitialValue:'"25"',Step:'5'},{Label:[t('AmountLabel','"Valor"')]},{OnChange:{action:'ChooseAmount',arguments:{Value:'SelectedValue'}}}),
  {type:'container',name:'EventResult',class:'margin-top-xl',children:[t('State','"Data recebida: " + DateToText(SelectedDate) + " | Aba recebida: " + IntegerToText(ActiveIndex) + " | Valor recebido: " + DecimalToText(SelectedAmount)')]},
  {type:'link',name:'ApplyDate',caption:'"Aplicar data digitada"',action:'ChooseDate',arguments:{Value:'SelectedDate'},method:'Ajax',validation:'Server'}
 ],
 flows:`action WidgetEventAudit.ChooseDate
  in Value: Date
  assign SelectedDate = Value
  node AjaxRefreshNode()
    @{WidgetOrWebBlock=&"EventResult"}
  end
action WidgetEventAudit.ChooseTab
  in Value: Integer
  assign ActiveIndex = Value
  node AjaxRefreshNode()
    @{WidgetOrWebBlock=&"EventResult"}
  end
action WidgetEventAudit.ChooseAmount
  in Value: Decimal
  assign SelectedAmount = Value
  node AjaxRefreshNode()
    @{WidgetOrWebBlock=&"EventResult"}
  end`
};
