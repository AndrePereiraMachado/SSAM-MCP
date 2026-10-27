// End-to-end development fixture. All application mutation goes through o11_deliver.
const text=(name,value)=>({type:'expression',name,value});
const link=(name,caption,action,args={})=>({type:'link',name,caption:JSON.stringify(caption),action,arguments:args,method:'Ajax',validation:'None'});
const component=(name,library,block,inputs={},slots={},events={})=>({type:'component',name,library,component:block,inputs,slots,events});
const reload=`  Loaded = AuditWidgetList(Search=Search, Start=Offset, Descending=Descending)
  assign
    Rows = Loaded.Rows
    Total = Loaded.Total
  node AjaxRefreshNode()
    @{WidgetOrWebBlock=&"Results"}`;
const reset=`  RichWidgets.List_Navigation_ResetStartIndex(ListWidgetId=ResultsTable.Id)
  assign Offset = 0`;
export const composition={
 screen:{name:'WidgetDataAudit',flow:'MainFlow',title:'Componentes com dados e eventos'},
 ddl:`create entity AuditWidgetItem label Name (
  Id Long Integer identifier auto required,
  Name Text(80) required
);
type AuditWidgetRow = {
  Id: AuditWidgetItem Identifier;
  Name: Text(80);
  TotalCount: Long Integer;
}`,
 exceptions:['AuditWidgetError'],
 references:[{producer:'RichWidgets',elements:['IServerAction:Feedback_Message','IServerAction:List_Navigation_GetStartIndex','IServerAction:List_Navigation_ResetStartIndex','IServerAction:List_SortColumn_GetOrderBy']},{producer:'OutSystemsUIWeb',elements:['IServerAction:ToggleModal']}],
 variables:[{name:'Rows',type:'AuditWidgetRow List'},{name:'Total',type:'Long Integer'},{name:'Search',type:'Text'},{name:'Offset',type:'Integer'},{name:'Descending',type:'Boolean'},{name:'Draft',type:'AuditWidgetItem'}],
 initial:{action:'AuditWidgetList',arguments:{Search:'Search',Start:'Offset',Descending:'Descending'},assign:{Rows:'InitialLoad.Rows',Total:'InitialLoad.Total'}},
 content:[
  text('Intro','"Prova isolada: pesquisa, ordenação, páginas de 2 registros e edição com salvamento real."'),
  component('SearchBox','OutSystemsUIWeb','Search',{}, {Input:[{type:'input',name:'SearchInput',bind:'Search'}],Actions:[link('SearchButton','Pesquisar','SearchRows')]}),
  link('NewButton','Novo registro','NewRow'),
  {type:'container',name:'Results',class:'margin-top-m',children:[
    text('Count','"Total: " + LongIntegerToText(Total)'),
    {type:'table',name:'ResultsTable',source:'Rows',lineCount:'2',columns:[
      {header:[text('NameHeader','"Nome"'),component('SortName','RichWidgets','List_SortColumn',{Column:'"{AuditWidgetItem}.[Name]"'},{},{OnNotify:'SortRows'})],content:[text('RowName','ResultsTable.List.Current.Name')]},
      {header:[text('ActionsHeader','"Ações"')],content:[link('EditButton','Editar','EditRow',{RecordId:'ResultsTable.List.Current.Id'})]}
    ]},
    component('Pager','RichWidgets','List_Navigation',{ListWidgetId:'ResultsTable.Id',LineCount:'2',TotalRowCount:'Total'},{},{OnNotify:'PageRows'}),
    {type:'if',name:'EmptyState',condition:'Total = 0',then:[text('EmptyText','"Nenhum registro. Crie um novo ou altere a pesquisa."')],else:[]}
  ]},
  component('EditorModal','OutSystemsUIWeb','Modal',{}, {Title:[text('EditorTitle','"Registro de teste"')],Content:[
    {type:'container',name:'EditorFields',children:[text('NameLabel','"Nome"'),{type:'input',name:'NameInput',bind:'Draft.Name',mandatory:true,maxLength:80}]}
  ],Footer:[link('CancelButton','Cancelar','ToggleEditor'),link('SaveButton','Salvar','SaveRow')]})
 ],
 flows:`server action AuditWidgetList
  in Search: Text
  in Start: Integer
  in Descending: Boolean
  out Rows: AuditWidgetRow List
  out Total: Long Integer
  if GetUserId() = NullIdentifier():
    raise AuditWidgetError("Autenticação necessária")
  if Start < 0:
    raise AuditWidgetError("Página inválida")
  Page = sql -> AuditWidgetRow max 2
    in Term: Text = Search
    in Offset: Integer = Start
    in Reverse: Boolean = Descending
    | SELECT {AuditWidgetItem}.*, COUNT(*) OVER()
    | FROM {AuditWidgetItem}
    | WHERE {AuditWidgetItem}.[Name] LIKE '%' + @Term + '%'
    | ORDER BY CASE WHEN @Reverse = 0 THEN {AuditWidgetItem}.[Name] END ASC,
    | CASE WHEN @Reverse = 1 THEN {AuditWidgetItem}.[Name] END DESC, {AuditWidgetItem}.[Id] ASC
    | OFFSET @Offset ROWS FETCH NEXT 2 ROWS ONLY
  assign Rows = Page.List mapTo { Id: AuditWidgetRow.Id, Name: AuditWidgetRow.Name, TotalCount: AuditWidgetRow.TotalCount }
  if not Page.List.Empty:
    assign Total = Page.List.Current.AuditWidgetRow.TotalCount
  end

server action AuditWidgetSave
  in Record: AuditWidgetItem
  if GetUserId() = NullIdentifier():
    raise AuditWidgetError("Autenticação necessária")
  if Trim(Record.Name) = "":
    raise AuditWidgetError("Informe o nome")
  if Length(Trim(Record.Name)) > 80:
    raise AuditWidgetError("O nome aceita até 80 caracteres")
  assign Record.Name = Trim(Record.Name)
  CreateOrUpdateAuditWidgetItem(Source=Record)
  end

action WidgetDataAudit.SearchRows
${reset}
${reload}
  end

action WidgetDataAudit.PageRows
  Page = RichWidgets.List_Navigation_GetStartIndex(ListWidgetId=ResultsTable.Id)
  assign Offset = Page.StartIndex
${reload}
  end

action WidgetDataAudit.SortRows
  Sort = RichWidgets.List_SortColumn_GetOrderBy(TableRecordsId=ResultsTable.Id, DefaultOrder="{AuditWidgetItem}.[Name]")
  assign Descending = Index(ToUpper(Sort.OrderBy), "DESC") >= 0
${reset}
${reload}
  end

action WidgetDataAudit.ToggleEditor
  OutSystemsUIWeb.ToggleModal(WidgetId=EditorModal.Id, TriggerButtonId=NewButton.Id)
  end

action WidgetDataAudit.NewRow
  assign
    Draft.Id = NullIdentifier()
    Draft.Name = ""
  node AjaxRefreshNode()
    @{WidgetOrWebBlock=&"EditorFields"}
  OutSystemsUIWeb.ToggleModal(WidgetId=EditorModal.Id, TriggerButtonId=NewButton.Id)
  end

action WidgetDataAudit.EditRow
  in RecordId: AuditWidgetItem Identifier
  One = aggregate FROM AuditWidgetItem WHERE (AuditWidgetItem.Id = RecordId) MAX 1
  if One.List.Empty:
    raise AuditWidgetError("Registro não encontrado")
  assign Draft = One.List.Current.AuditWidgetItem
  node AjaxRefreshNode()
    @{WidgetOrWebBlock=&"EditorFields"}
  OutSystemsUIWeb.ToggleModal(WidgetId=EditorModal.Id, TriggerButtonId=NewButton.Id)
  end

action WidgetDataAudit.SaveRow
  AuditWidgetSave(Record=Draft)
${reset}
${reload}
  OutSystemsUIWeb.ToggleModal(WidgetId=EditorModal.Id, TriggerButtonId=NewButton.Id)
  RichWidgets.Feedback_Message(MessageText="Registro salvo", MessageType=Entities.MessageType.Success)
  end
  on exception AuditWidgetError abort:
    RichWidgets.Feedback_Message(MessageText="Informe um nome válido", MessageType=Entities.MessageType.Error)
    end
`
};
