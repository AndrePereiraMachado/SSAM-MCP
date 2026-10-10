"""Generate independent acceptance contracts, not the compiler's emitted operations."""
import copy
import json
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'tests/contracts/action-coverage'
OUT.mkdir(parents=True, exist_ok=True)
DATA = {'structures': [
    {'name':'CoverageItem','public':True,'attributes':[{'name':'Number','type':'Integer'},{'name':'Text','type':'Text'}]},
    {'name':'CoverageEnvelope','public':True,'attributes':[{'name':'Item','type':'CoverageItem'},{'name':'Items','type':'CoverageItem List'},{'name':'Numbers','type':'Integer List'}]}],
    'entities':[{'name':'CoverageRow','public':True,'attributes':[{'name':'Value','type':'Integer'}]}]}
def param(name, kind): return {'name':name,'type':kind}
def assign(**values): return {'assign':values}
def node(kind, name, **properties): return {'node':kind,'as':name,'properties':properties}
def emit(feature, fixture, kind, action, mutation=None, extra=(), unsupported=None):
    action = copy.deepcopy(action); action.update(name='Coverage',kind=kind,public=True)
    if kind != 'client': action['access']={'authenticated':True}
    contract={'data':copy.deepcopy(DATA),'exceptions':[{'name':'CoverageFailure'}], 'logic':{'actions':[*copy.deepcopy(extra),action]}}
    row={'fixture':fixture,'features':[feature,kind],'contract':contract}
    if mutation:
        target, prop, value=mutation
        row['mutation']={'target':{'server':'IServerAction','service':'IServiceAction','client':'IClientAction'}[kind]+':Coverage'+target,'prop':prop,'value':value}
    if unsupported: row['unsupported']=unsupported
    (OUT/f'{fixture}-{kind}-{feature}.json').write_text(json.dumps(row,indent=2)+'\n',encoding='utf-8')
CONTEXTS=[('blank-service','server'),('blank-service','service'),('reactive-ui','server'),('reactive-ui','client'),('mobile-ui','server'),('mobile-ui','client'),('traditional-ui','server')]
for fixture, kind in CONTEXTS:
    echo={'name':'Echo','kind':'server' if kind=='service' else kind,'inputs':[],'outputs':[],'vars':[],'steps':[]}
    types=['Boolean','Integer','Long Integer','Decimal','Currency','Text','Email','Phone Number','Date','Time','Date Time','Binary Data','User Identifier','CoverageRow Identifier','CoverageRow','CoverageRow List','Integer List','CoverageItem','CoverageItem List','CoverageEnvelope']
    values={}; outs={}; args={}; result={}
    for i,t in enumerate(types):
        echo['inputs'].append(param(f'Input{i}',t));echo['outputs'].append(param(f'Output{i}',t));echo['vars'].append(param(f'Local{i}',t))
        values[f'Local{i}']=f'Input{i}';outs[f'Output{i}']=f'Local{i}';args[f'Input{i}']=f'Input{i}';result[f'Output{i}']=f'Nested.Output{i}'
    echo['steps']=[{'assign':values},{'assign':outs}]
    # Service actions call a local server helper; local service-to-service calls are disallowed by Studio.
    caller={'inputs':copy.deepcopy(echo['inputs']),'outputs':copy.deepcopy(echo['outputs']),'steps':[{'call':'Echo','as':'Nested','args':args},{'assign':result}]}
    emit('types-and-nested-call',fixture,kind,caller,('/#IAssignNode/#IAssignment[2]','Value','Nested.Output1 + 1'),extra=[echo])
    control={'inputs':[param('Number','Integer'),param('Values','Integer List')], 'outputs':[param('Result','Integer')],
       'steps':[{'switch':[{'when':'Number < 0','steps':[assign(Result='-1')]},{'when':'Number = 0','steps':[assign(Result='0')]}],'otherwise':[assign(Result='Number')],'as':'SelectValue'},
                {'foreach':'Values','as':'EachValue','start':'0','max':'Values.Length','do':[assign(Result='Result + Values.Current')]},
                {'if':'Result < 0','then':[{'raise':'CoverageFailure','message':'"negative"'}]}],
       'handlers':[{'name':'Recover','exception':'CoverageFailure','abortTransaction':True,'logError':False,'steps':[assign(Result='-999')]}],
       'comments':[{'text':'Coverage: preserve branches, loops and recovery.','reminder':False}]}
    emit('switch-loop-handler-comment',fixture,kind,control,('/#ISwitchNode/#ISwitchCondition[1]','Value','Number > 0'))
    serialize=node('IJSONSerializeNode','Encode',Data='Value',DateFormat='ISO',SerializeDefaultValues=True)
    deserialize=node('IJSONDeserializeNode','Decode',JSONString='Encode.JSON',DataType='CoverageEnvelope',DateFormat='ISO')
    emit('json-nested-structures',fixture,kind,{'inputs':[param('Value','CoverageEnvelope')],'outputs':[param('Result','CoverageEnvelope')], 'steps':[serialize,deserialize,assign(Result='Decode.Data')]},('/Encode','SerializeDefaultValues',False))
    lists={'inputs':[param('Value','CoverageItem'),param('Values','CoverageItem List')],'outputs':[param('Result','CoverageItem List')],
       'steps':[assign(Result='Values'),{'call':'ListAppend','as':'Append','args':{'List':'Result','Element':'Value'}},
         {'call':'ListInsert','as':'Insert','args':{'List':'Result','Position':'0','Element':'Value'}},
         {'call':'ListRemove','as':'Remove','args':{'List':'Result','Position':'0'}},
         {'call':'ListClear','as':'Clear','args':{'List':'Result'}},
         {'call':'ListAppendAll','as':'AppendAll','args':{'List':'Result','SourceList':'Values'}},
         {'call':'ListSort','as':'Sort','args':{'List':'Result','By':'Result.Current.Number','Ascending':'True'}},
         {'call':'ListFilter','as':'Filter','args':{'SourceList':'Result','Condition':'Result.Current.Number >= 0'}},
         {'call':'ListDuplicate','as':'Copy','args':{'SourceList':'Filter.FilteredList'}},
         {'call':'ListAll','as':'All','args':{'List':'Copy.DuplicatedList','Condition':'Copy.DuplicatedList.Current.Number >= 0'}},
         {'call':'ListAny','as':'Any','args':{'List':'Copy.DuplicatedList','Condition':'Copy.DuplicatedList.Current.Number > 0'}},
         {'call':'ListIndexOf','as':'Find','args':{'List':'Copy.DuplicatedList','Condition':'Copy.DuplicatedList.Current.Number = Value.Number'}},
         assign(Result='Copy.DuplicatedList')]}
    emit('list-operations',fixture,kind,lists,('/Insert/arg:Position','Value','1'))
    if kind!='client':
        excel={'inputs':[param('Values','CoverageItem List')],'outputs':[param('Count','Integer'),param('File','Binary Data')], 'steps':[
          node('IRecordListToExcelNode','Export',RecordList='Values',AttributeSelection=['Number','Text']),
          node('IExcelToRecordListNode','Import',FileContent='Export',SheetName='""',DataType='CoverageItem List'),
          assign(Count='Import.Length',File='Export')]}
        emit('excel-roundtrip',fixture,kind,excel,('/Import','SheetName','"Sheet2"'))
        crud={'inputs':[param('Row','CoverageRow')],'outputs':[param('Count','Integer')],'steps':[
          {'create':'CoverageRow','as':'Insert','record':'Row'}, {'update':'CoverageRow','as':'Update','record':'Row'}, {'save':'CoverageRow','as':'Upsert','record':'Row'},
          {'get':'CoverageRow','as':'ReadRows','where':'CoverageRow.Id = Row.Id','sort':['CoverageRow.Value','Descending'],'start':'0','max':'100'},
          {'get':'CoverageRow','sql':True,'as':'ReadSql','statement':'SELECT {CoverageRow}.* FROM {CoverageRow} WHERE {CoverageRow}.[Id] = @Id','params':{'Id':{'type':'Long Integer','value':'Row.Id'}}},
          {'delete':'CoverageRow','as':'RemoveRow','id':'Row.Id'},assign(Count='ReadRows.List.Length + ReadSql.List.Length'),{'call':'CommitTransaction','as':'Commit'}]}
        emit('aggregate-sql-crud-transaction',fixture,kind,crud,('/ReadRows','MaxRecords','1'))
    if kind=='client':
        js=node('IJavaScriptNode','Calculate',JavaScript='$parameters.Result = $parameters.Value + 1;')
        js.update(inputs=[param('Value','Integer')],outputs=[param('Result','Integer')],args={'Value':'Value'})
        emit('javascript',fixture,kind,{'inputs':[param('Value','Integer')],'outputs':[param('Result','Integer')],'steps':[js,assign(Result='Calculate.Result')]},('/Calculate','JavaScript','$parameters.Result = $parameters.Value + 2;'))
        emit('message',fixture,kind,{'inputs':[param('Text','Text')],'steps':[node('IMessageNode','Notice',Message='Text',Type='Info')]},('/#IMessageNode','Type','Warning'))
        server={'name':'ServerEcho','kind':'server','access':{'authenticated':True},'inputs':[param('N','Integer')],'outputs':[param('Result','Integer')],'steps':[assign(Result='N')]}
        emit('client-calls-server',fixture,kind,{'inputs':[param('N','Integer')],'outputs':[param('Result','Integer')],'steps':[{'call':'ServerEcho','as':'Remote','args':{'N':'N'}},assign(Result='Remote.Result')]},('/Remote/arg:N','Value','N + 1'),extra=[server])
        emit('download',fixture,kind,{'inputs':[param('File','Binary Data')],'steps':[node('IDownloadNode','Download',FileContent='File',FileName='"coverage.bin"',MimeType='"application/octet-stream"',SaveToDisk=True)]},('/#IDownloadNode','FileName','"changed.bin"'),unsupported='IDownloadNode')
# Rejected contexts are assertions too, never counted as positive widget support.
emit('service-action-not-in-ui','reactive-ui','service',{'steps':[]},unsupported='Service Action')
emit('client-action-not-in-service','blank-service','client',{'steps':[]},unsupported='Client Action')


def create(parent,type,name=None,**args):
    result={'op':'create','parent':parent,'type':type}
    if name:result['name']=name
    if args:result['args']=args
    return result

def setp(target,prop,value):return {'op':'set','target':target,'prop':prop,'value':value}

def contextual(feature, fixture, action, setup, bindings, mutation):
    contract={'logic':{'actions':[action]}}
    row={'fixture':fixture,'features':[feature,action['kind']],'contract':contract,'setup':setup,'bindings':bindings,'mutation':mutation}
    (OUT/f'{fixture}-{feature}.json').write_text(json.dumps(row,indent=2)+'\n',encoding='utf-8')

for fixture in ['reactive-ui','mobile-ui','traditional-ui']:
    mobile=fixture!='traditional-ui'; screen='IMobileScreen' if mobile else 'IWebScreen'; flow='IMobileFlow:MainFlow' if mobile else 'IWebFlow:MainFlow'
    owner=screen+':CoverageScreen'
    setup=[create(flow,screen,'CoverageScreen'),create(flow,screen,'CoverageTarget')]
    if mobile:
        layout='IMobileBlock:Layout' if fixture=='mobile-ui' else 'IMobileBlock:LayoutTopMenu'
        setup += [setp(owner+'/#IMobileBlockInstanceWidget','SourceBlock',layout),setp(screen+':CoverageTarget/#IMobileBlockInstanceWidget','SourceBlock',layout)]
    setup += [create(owner,'IButton' if mobile else 'ILinkWidget','Run'),setp(owner+'/Run/#ITextWidget','Text','Run proof') if mobile else create(owner+'/Run','IExpressionWidget','Caption'),*([] if mobile else [setp(owner+'/Run/Caption','Value','"Run proof"')])]
    if not mobile:setup += [setp(owner+'/Run/OnClick','Method','Ajax'),setp('IWebScreen:CoverageTarget','IsFrequentDestination',True)]
    act={'name':'Coverage','kind':'screen','owner':owner,'steps':[node('IDestinationNode','Go',Destination=screen+':CoverageTarget',Transition='Inherited')]}
    contextual('screen-navigation',fixture,act,setup,[setp(owner+'/Run/OnClick','Destination',owner+'/Coverage')],{'target':owner+'/Coverage/#IDestinationNode','prop':'Transition','value':'None'})
    if mobile:
        setup_read=copy.deepcopy(setup)+[create(owner,'IScreenAggregate','ReadUsers'),create(owner+'/ReadUsers','IAliasedSource',dataSource='IEntitySignature:User'),setp(owner+'/ReadUsers','MaxRecords','10'),create(owner,'IExpression','Count'),setp(owner+'/Count','Value','ReadUsers.List.Length')]
        act={'name':'Coverage','kind':'screen','owner':owner,'steps':[node('IRefreshDataNode','Refresh',DataSource=owner+'/ReadUsers',MaxRecords='10',StartIndex='')]}
        contextual('screen-refresh-data',fixture,act,setup_read,[setp(owner+'/Run/OnClick','Destination',owner+'/Coverage')],{'target':owner+'/Coverage/#IRefreshDataNode','prop':'MaxRecords','value':'1'})
        block='IMobileBlock:CoverageBlock'
        setup_block=[create(flow,'IMobileBlock','CoverageBlock'),setp(block,'Public',True),create(block,'IBlockEvent','Changed'),create(block+'/Changed','IInputParameter','Value'),setp(block+'/Changed/Value','DataType','Integer'),create(block,'IButton','Run'),setp(block+'/Run/#ITextWidget','Text','Notify')]
        trigger=node('ITriggerNode','Notify',Event=block+'/Changed');trigger['args']={'Value':'1'}
        act={'name':'Coverage','kind':'screen','owner':block,'steps':[trigger]}
        contextual('block-trigger-event',fixture,act,setup_block,[setp(block+'/Run/OnClick','Destination',block+'/Coverage')],{'target':block+'/Coverage/Notify/arg:Value','prop':'Value','value':'2'})
    else:
        setup_refresh=copy.deepcopy(setup)+[create(owner,'IContainerWidget','Panel'),create(owner+'/Panel','IExpressionWidget','Content'),setp(owner+'/Panel/Content','Value','"Refresh target"')]
        act={'name':'Coverage','kind':'screen','owner':owner,'steps':[node('IAjaxRefreshNode','Refresh',WidgetOrWebBlock=owner+'/Panel',RowNumber='',AnimationEffect='None')]}
        contextual('screen-ajax-message',fixture,act,setup_refresh,[setp(owner+'/Run/OnClick','Destination',owner+'/Coverage')],{'target':owner+'/Coverage/#IAjaxRefreshNode','prop':'AnimationEffect','value':'Fade'})
        act={'name':'Coverage','kind':'screen','owner':owner,'inputs':[param('File','Binary Data')],'steps':[node('IDownloadNode','Download',FileContent='File',FileName='"proof.bin"',MimeType='"application/octet-stream"',SaveToDisk=True)]}
        act['inputs'][0]['mandatory']=False
        contextual('screen-download',fixture,act,setup,[setp(owner+'/Run/OnClick','Method','Submit'),setp(owner+'/Run/OnClick','Destination',owner+'/Coverage')],{'target':owner+'/Coverage/#IDownloadNode','prop':'FileName','value':'"changed.bin"'})
# Traditional email attachment belongs to the email preparation, and the send node to a server action.
email='IWebEmail:CoverageMail'
setup_mail=[create('IWebFlow:Emails','IWebEmail','CoverageMail'),setp(email,'Subject','"Proof"'),create(email,'IExpressionWidget','Body'),setp(email+'/Body','Value','"Test email body"')]
act={'name':'Preparation','kind':'preparation','owner':email,'steps':[node('IAttachFileNode','Attach',FileContent='NullBinary()',FileName='"proof.bin"',MimeType='"application/octet-stream"')]}
send=node('ISendEmailNode','Send',Email=email,To='"nobody@example.invalid"',From='',Cc='',Bcc='',LogContent=False)
contract={'logic':{'actions':[act,{'name':'SendProof','kind':'server','public':True,'access':{'authenticated':True},'steps':[send]}]}}
(OUT/'traditional-ui-email-attachment.json').write_text(json.dumps({'fixture':'traditional-ui','features':['ISendEmailNode','IAttachFileNode','preparation','server'],'contract':contract,'setup':setup_mail,'mutation':{'target':email+'/Preparation/Attach','prop':'FileName','value':'"changed.bin"'}},indent=2)+'\n',encoding='utf-8')

local={'clientEntities':[{'name':'CoverageDraft','attributes':[{'name':'Text','type':'Text'}]}]}
contract={'data':local,'logic':{'actions':[{'name':'Coverage','kind':'client','public':True,'inputs':[param('Id','Long Integer'),param('Text','Text')],'vars':[param('Value','CoverageDraft')],'outputs':[param('Count','Integer')],'steps':[assign(**{'Value.Id':'LongIntegerToIdentifier(Id)','Value.Text':'Text'}),
    {'create':'CoverageDraft','record':'Value','as':'CreateDraft'}, {'update':'CoverageDraft','record':'Value','as':'UpdateDraft'},
    {'save':'CoverageDraft','record':'Value','as':'SaveDraft'}, {'get':'CoverageDraft','as':'ReadDrafts','where':'CoverageDraft.Id = Value.Id and CoverageDraft.Text = Value.Text','max':'10'},
    {'delete':'CoverageDraft','id':'Value.Id','as':'DeleteDraft'}, assign(Count='ReadDrafts.List.Length')]}]}}
(OUT/'mobile-ui-client-local-storage.json').write_text(json.dumps({'fixture':'mobile-ui','features':['client-CRUD','client-aggregate'],'contract':contract,'mutation':{'target':'IClientAction:Coverage/ReadDrafts','prop':'MaxRecords','value':'1'}},indent=2)+'\n',encoding='utf-8')

for fixture,kind in CONTEXTS:
    if kind=='client':continue
    extra=copy.deepcopy(DATA)
    extra['entities'].append({'name':'CoverageDetail','public':True,'attributes':[{'name':'RowId','type':'CoverageRow Identifier'},{'name':'Amount','type':'Decimal'}]})
    query={'get':'CoverageRow','as':'Report','sources':['CoverageDetail'],'joins':[{'left':'CoverageRow','right':'CoverageDetail','kind':'Left','condition':'CoverageRow.Id = CoverageDetail.RowId'}],
        'where':'CoverageRow.Value >= Minimum','sort':['CoverageRow.Value','Descending'],'max':'100',
        'columns':[{'name':'GroupValue','kind':'Group','attribute':'CoverageRow.Value'},*({'name':'Amount'+agg,'kind':agg,'attribute':'CoverageDetail.Amount'} for agg in ['Count','Sum','Max','Min','Avg'])],
        'calculated':[{'name':'DoubleValue','value':'CoverageRow.Value * 2'}]}
    action={'name':'Coverage','kind':kind,'public':True,'access':{'authenticated':True},'inputs':[param('Minimum','Integer')],'outputs':[param('Result','Decimal')],
        'steps':[{'get':'CoverageRow','as':'Calculated','max':'10','calculated':[{'name':'DoubleValue','value':'CoverageRow.Value * 2'}]},query,assign(Result='Calculated.List.Current.DoubleValue + Report.List.Current.AmountSum + Report.List.Current.AmountCount + Report.List.Current.AmountMax + Report.List.Current.AmountMin + Report.List.Current.AmountAvg + Report.List.Current.GroupValue')]}
    row={'fixture':fixture,'features':['aggregate-join-group-calculated-count-sum-max-min-avg',kind],'contract':{'data':extra,'logic':{'actions':[action]}},'mutation':{'target':('IServiceAction' if kind=='service' else 'IServerAction')+':Coverage/Report/**IJoin','prop':'JoinType','value':'Inner'}}
    (OUT/f'{fixture}-{kind}-aggregate-full.json').write_text(json.dumps(row,indent=2)+'\n',encoding='utf-8')

for fixture in ['reactive-ui','mobile-ui','traditional-ui']:
    contract={'logic':{'actions':[{'name':'Coverage','kind':'server','public':True,'access':{'authenticated':True},'inputs':[param('Id','Order Identifier')],'outputs':[param('Summary','OrderSummary')],'steps':[
        {'call':'Order_GetSummary','as':'RemoteService','args':{'OrderId':'Id'}},assign(Summary='RemoteService.Summary')]}]}}
    setup=[{'op':'reference','producer':'job:service-action','elements':['IServiceAction:Order_GetSummary','IServerEntity:Order','IStructure:OrderSummary']}]
    row={'fixture':fixture,'features':['service-reference','server-calls-service'],'contract':contract,'setup':setup,
        'mutation':{'target':'IServerAction:Coverage/RemoteService/arg:OrderId','prop':'Value','value':'If(Id = NullIdentifier(), Id, NullIdentifier())'}}
    (OUT/f'{fixture}-server-calls-referenced-service.json').write_text(json.dumps(row,indent=2)+'\n',encoding='utf-8')
