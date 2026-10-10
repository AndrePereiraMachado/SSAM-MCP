"""Per-widget screen contracts; every positive row must Verify, survive native merge and reject a valid mutation."""
import copy
import json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'tests/contracts/screen-coverage'
V=json.loads((ROOT/'src/Anvil.Core/Kernel/ScreenVocabulary.json').read_text(encoding='utf-8'))

def make(context, typ, fixture):
    rootType='IMobileScreen' if context=='mobile' else 'IWebScreen'
    screen={'name':'Coverage','type':rootType,'flow':'MainFlow','roles':['Registered'],'properties':{'Title':'"Coverage"'},'widgets':[]}
    contract={'screens':[screen]}; actions=[]; count=0
    def w(t,n=None,p=None,children=None,slots=None):
        nonlocal count
        count+=1
        obj={'name':n or 'Part'+str(count),'type':t,'properties':p or {}}
        if children is not None: obj['children']=children
        if slots is not None: obj['slots']=slots
        return obj
    def text(value='Content'):
        return w('ITextWidget',p={'Text':value})
    def variable(name,type):
        screen.setdefault('vars',[]).append({'name':name,'type':type})
        return name
    def rows():
        contract['data']={'structures':[{'name':'ScreenRow','attributes':[{'name':'Name','type':'Text'},{'name':'Value','type':'Integer'}]}]}
        return variable('Rows','ScreenRow List')
    def bind(widget,event='OnClick'):
        action='Handle'+str(len(actions)+1)
        actions.append({'name':action,'kind':'screen','owner':rootType+':Coverage','steps':[]})
        widget.setdefault('events',{})[event]={'destination':rootType+':Coverage/'+action}
    widget=w(typ,'Subject'); props=widget['properties']; extra=[]; top=widget
    if typ=='ITextWidget':props['Text']='Original'
    if typ in ('IExpression','IExpressionWidget'):props['Value']='"Original"'
    if typ in ('IIfWidget',):
        props['Condition']='True'; widget['slots']={'TrueBranch':[text('True branch')],'FalseBranch':[text('False branch')]}
    if typ in ('IPlaceholderWidget',):
        screen['type']=rootType=rootType.replace('Screen','Block'); screen.pop('roles'); screen['properties']={}
    if 'BlockInstanceWidget' in typ:
        blockType='IMobileBlock' if context=='mobile' else 'IWebBlock'
        contract['screens'].append({'name':'ContractBlock','type':blockType,'flow':'MainFlow','inputs':[{'name':'Caption','type':'Text','mandatory':False}], 'widgets':[w('IExpression' if context=='mobile' else 'IExpressionWidget','BlockTitle',{'Value':'Caption'}),w('IPlaceholderWidget','Content')]})
        widget['source']=blockType+':ContractBlock';widget['args']={'Caption':'"Original"'};widget['slots']={'Content':[text()]}
    if context=='mobile':
        if typ in ('IInput','ITextArea'): props['Variable']=variable('Value','Text');props['Prompt']='"Enter value"'
        if typ in ('ICheckbox','ISwitch'):props['Variable']=variable('Value','Boolean')
        if typ in ('IRadioGroup','IRadioButton','IButtonGroup','IButtonGroupItem'):
            group='IRadioGroup' if 'Radio' in typ else 'IButtonGroup'; item='IRadioButton' if 'Radio' in typ else 'IButtonGroupItem'
            if typ==group:
                props['Variable']=variable('Choice','Text');widget['children']=[w(item,p={'Value':'"A"'},children=[text('A')])]
            else:
                props['Value']='"A"';widget['children']=[text('A')];top=w(group,'Group',{'Variable':variable('Choice','Text')},[widget])
        if typ=='IContainer':props['Visible']='True';widget['children']=[text()]
        if typ=='IForm': widget['children']=[w('IInput',p={'Variable':variable('Value','Text')})]
        if typ=='IDropdown':props.update({'List':rows(),'Values':'Value','Labels':'Name','Variable':variable('Chosen','Integer')})
        if typ in ('IButton','ILink'):widget['children']=[text('Go')];bind(widget)
        if typ=='IIcon':props['Icon']='star'
        if typ=='IImage':props.update({'Type':'External','Url':'"https://example.com/image.png"'})
        if typ=='IAdvancedHtml':props['Tag']='section';widget['slots']={'Content':[text()]}
        if typ=='ILabel':
            props['TargetWidget']='IMobileScreen:Coverage/Editor';widget['children']=[text('Name')];extra=[w('IInput','Editor',{'Variable':variable('Value','Text')})]
        if typ in ('IList','IListItem','IListItemAction'):
            source=rows()
            if typ=='IList':props['Source']=source; widget['children']=[text()]
            elif typ=='IListItem':widget['slots']={'Content':[text()]};top=w('IList','RowsList',{'Source':source},[widget])
            else:
                bind(widget); widget['children']=[text('Swipe')];top=w('IList','RowsList',{'Source':source},[w('IListItem','RowItem',slots={'Content':[text()],'RightActions':[widget]})])
        if typ=='IPopover':widget['slots']={'TopContent':[text('Top')],'BottomContent':[text('Bottom')]}
        if typ=='IPopup':props['ShowPopup']='False';widget['children']=[text()]
        if typ in ('ITableRecords','IHeaderCell','IRowCell'):
            source=rows()
            if typ=='ITableRecords': props['Source']=source; widget['slots']={'HeaderRow':[w('IHeaderCell',children=[text('Name')])],'Row':[w('IRowCell',children=[text()])]}
            elif typ=='IHeaderCell':widget['children']=[text()];top=w('ITableRecords','Table',{'Source':source},slots={'HeaderRow':[widget],'Row':[w('IRowCell',children=[text()])]})
            else:widget['children']=[text()];top=w('ITableRecords','Table',{'Source':source},slots={'HeaderRow':[w('IHeaderCell',children=[text('Name')])],'Row':[widget]})
        if typ=='IUpload':props.update({'FileContent':variable('Content','Binary Data'),'FileName':variable('Filename','Text'),'Accept':'Any'})
    else:
        if typ in ('IInputWidget','IInputPasswordWidget'):props['Variable']=variable('Value','Text'); props['Mandatory']='False'
        if typ=='ICheckBoxWidget':props['Variable']=variable('Value','Boolean')
        if typ=='IRadioButtonWidget':props.update({'Variable':variable('Value','Text'),'Value':'"A"'})
        if typ=='IComboBoxWidget': props.update({'Variable':variable('Choice','User Identifier'),'SourceEntity':'IEntitySignature:User','SourceAttribute':'IEntitySignature:User/Name','IsMandatory':'False'})
        if typ in ('IButtonWidget','ILinkWidget'):
            if typ=='IButtonWidget':props['Label']='"Go"'
            else:widget['children']=[text('Go')]
            bind(widget)
            if typ=='ILinkWidget':widget['events']['OnClick']['method']='Ajax'
        if typ=='IContainerWidget':props['Display']='True';widget['children']=[text()]
        if typ in ('IEditRecordWidget','IShowRecordWidget','IForm'):
            rows();screen['vars']=[{'name':'Row','type':'ScreenRow'}];props['SourceRecord']='Row'
            if typ=='IForm':widget['children']=[text()]
            else:widget['children']=[w('IRowWidget','RecordRow',children=[w('ICellWidget',children=[text('Name')]),w('ICellWidget',children=[text()])])]
        if typ in ('IListRecordsWidget','ITableRecordsWidget','IEditableTable','IEditableTableCell','ICellWidget'):
            source=rows()
            if typ=='IListRecordsWidget':props['SourceRecordList']=source;widget['children']=[text()]
            elif typ=='ITableRecordsWidget':props['SourceRecordList']=source;widget['slots']={'HeaderRow':[w('ICellWidget',children=[text('Name')])],'DataRow':[w('ICellWidget',children=[text()])]}
            elif typ=='IEditableTable':props['SourceRecordList']=source;widget['slots']={'HeaderRow':[w('IEditableTableCell',children=[text('Name')])],'Row':[w('IEditableTableCell',children=[text()])]};bind(widget,'OnRowSave');bind(widget,'OnRowDelete')
            elif typ=='IEditableTableCell':widget['children']=[text()];top=w('IEditableTable','Table',{'SourceRecordList':source},slots={'HeaderRow':[w('IEditableTableCell',children=[text('Name')])],'Row':[widget]});bind(top,'OnRowSave');bind(top,'OnRowDelete')
            else:widget['children']=[text()];top=w('ITableRecordsWidget','Table',{'SourceRecordList':source},slots={'HeaderRow':[w('ICellWidget',children=[text('Name')])],'DataRow':[widget]})
        if typ in ('ITableWidget','IRowWidget'):
            if typ=='ITableWidget':widget['children']=[w('IRowWidget','TableRow',children=[w('ICellWidget',children=[text()])])]
            else:widget['children']=[w('ICellWidget',children=[text()])];top=w('ITableWidget','Table',children=[widget])
        if typ=='ILabel':props.update({'TargetWidget':'IWebScreen:Coverage/Editor','Text':'Name'});extra=[w('IInputWidget','Editor',{'Variable':variable('Value','Text')})]
    shape=V[context+':'+typ]
    # Every negative case changes a property of the widget under test while preserving native validity.
    if 'Style' in shape['properties']:props['Style']='"coverage"';mutation=('Style','"changed"')
    elif 'StyleClasses' in shape['properties']:
        expr=shape['properties']['StyleClasses']['kind']=='expression';props['StyleClasses']='"coverage"' if expr else 'coverage';mutation=('StyleClasses','"changed"' if expr else 'changed')
    elif typ=='IComboBoxWidget':mutation=('IsMandatory','True')
    elif typ=='IForm':props['IsEditable']='True';mutation=('IsEditable','False')
    elif typ=='IEditableTable':props['IsEditable']='True';mutation=('IsEditable','False')
    elif typ=='IEditableTableCell': mutation=None
    elif typ=='IAdvancedHtml':mutation=('Tag','article')
    elif typ=='IIfWidget':mutation=('Condition','False')
    elif 'BlockInstanceWidget' in typ:mutation=None
    else:mutation=None
    if context=='web' and (screen.get('vars') or typ=='IInputFilenameWidget') and not actions:
        submit=w('IButtonWidget','Submit',{'Label':'\"Submit\"'});bind(submit);extra.append(submit)
    screen['widgets']=[top]+extra
    if actions:contract['logic']={'actions':actions}
    case={'fixture':fixture,'features':['native-widget',context+':'+typ],'contract':contract}
    def find_path(node,path):
        if node is widget:return path+'/'+node['name']
        for child in node.get('children',[]):
            found=find_path(child,path+'/'+node['name'])
            if found:return found
        for slot,children in node.get('slots',{}).items():
            for child in children:
                found=find_path(child,path+'/'+node['name']+'/'+slot)
                if found:return found
    path=find_path(top,rootType+':Coverage')
    if mutation:case['mutation']={'target':path,'prop':mutation[0],'value':mutation[1]}
    elif 'BlockInstanceWidget' in typ:case['mutation']={'target':path+'/Caption','prop':'Value','value':'\"Changed\"'}
    elif typ=='IRowWidget':case['mutation']={'target':rootType+':Coverage/Table/#IRowWidget/#ICellWidget/#ITextWidget','prop':'Text','value':'Changed'}
    else:case['mutation']={'target':path,'prop':'Name','value':'ChangedName'}
    return case

if __name__=='__main__':
    OUT.mkdir(parents=True,exist_ok=True)
    for key,shape in V.items():
        if shape['root']:continue
        context,typ=key.split(':')
        for fixture in (['reactive-ui','mobile-ui'] if context=='mobile' else ['traditional-ui']):
            case=make(context,typ,fixture)
            (OUT/(fixture+'-'+typ.lower()+'.json')).write_text(json.dumps(case,indent=2)+'\n',encoding='utf-8')
    print('Native screen cases:',len(list(OUT.glob('*.json'))))
