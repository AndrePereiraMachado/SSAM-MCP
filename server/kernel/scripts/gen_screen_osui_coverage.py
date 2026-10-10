"""Exercise current public OutSystems UI components in batches; preserved declarations are independently checked."""
import json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'tests/contracts/screen-coverage'

def generate(fixture, module, file, producer):
    catalog=json.loads((ROOT/'catalog/ui'/file).read_text(encoding='utf-8'))
    blocks={b['Name']:b for b in catalog['Blocks']}
    selected=[b for b in blocks.values() if b['Public'] and b['Flow']!='Private' and not b['Name'].startswith('DEPRECATED')]
    selected.sort(key=lambda b:b['Name'])
    statics={s['Name']:s for s in catalog['StaticEntities']}
    mobile=fixture!='traditional-ui'; rootType='IMobileScreen' if mobile else 'IWebScreen'; blockType='IMobileBlock' if mobile else 'IWebBlock'
    inventory=[]
    for offset in range(0,len(selected),5):
        actions=[];screens=[];references=set();mutations=[]
        for num, block in enumerate(selected[offset:offset+5],offset):
            screenName='Ui'+str(num)+'_'+block['Name'];count=0
            screen={'name':screenName,'type':rootType,'flow':'MainFlow','roles':['Registered'],'widgets':[],'vars':[]}
            def widget(typ,props=None,children=None,slots=None):
                nonlocal count
                count+=1;node={'name':'Part'+str(count),'type':typ,'properties':props or {}}
                if children is not None:node['children']=children
                if slots is not None:node['slots']=slots
                return node
            def text(label='Component content'):return widget('ITextWidget',{'Text':label})
            def var(type):
                name='Value'+str(len(screen['vars'])+1);screen['vars'].append({'name':name,'type':type});return name
            def handler(instance,event):
                name=screenName+'_Event'+str(len(actions)+1)
                inputs=[{'name':p['Name'],'type':p['Type'],'mandatory':p['Mandatory']} for p in event['Params']]
                steps=[]
                for i,p in enumerate(inputs):
                    conversions={'Text':lambda n:n,'Integer':lambda n:'IntegerToText('+n+')',
                                 'Decimal':lambda n:'DecimalToText('+n+')','Date':lambda n:'DateToText('+n+')',
                                 'Date Time':lambda n:'DateTimeToText('+n+')','Time':lambda n:'TimeToText('+n+')'}
                    if p['type'] in conversions:
                        steps.append({'assign':{'LastEvent':conversions[p['type']](p['name'])}})
                        continue
                    alias='Serialized'+str(i+1)
                    steps.append({'node':'IJSONSerializeNode','as':alias,'properties':{'Data':p['name'],'DateFormat':'ISO','SerializeDefaultValues':True,'Description':''}})
                    steps.append({'assign':{'LastEvent':alias+'.JSON'}})
                if inputs and not any(v['name']=='LastEvent' for v in screen['vars']):
                    screen['vars'].append({'name':'LastEvent','type':'Text'});screen['widgets'].append(widget('IExpression' if mobile else 'IExpressionWidget',{'Value':'LastEvent'}))
                actions.append({'name':name,'kind':'screen','owner':rootType+':'+screenName,'inputs':inputs,'steps':steps})
                instance.setdefault('events',{})[event['Name']]={'destination':rootType+':'+screenName+'/'+name,'args':{p['Name']:p['Name'] for p in event['Params']}}
            def required_value(parameter):
                typ=parameter['Type'];name=parameter['Name']
                if 'WidgetId' in name or name in ['InputId','InputWidget']:
                    inputWidget=widget('IInput' if mobile else 'IInputWidget',{'Variable':var('Text')})
                    screen['widgets'].append(inputWidget);return inputWidget['name']+'.Id'
                if typ in ['Text','Phone Number','Email']:return '"Coverage"'
                if typ in ['Integer','Long Integer','Decimal','Currency']:return '1'
                if typ=='Boolean':return 'True'
                if typ=='Date':return 'CurrDate()'
                if typ=='Date Time':return 'CurrDateTime()'
                if typ=='Time':return 'CurrTime()'
                if typ.endswith(' Identifier'):
                    static=statics.get(typ[:-11]);records=static.get('Records',[]) if static else []
                    if records:return 'Entities.'+static['Name']+'.'+records[0]['Id']
                    return 'NullIdentifier()'
                return var(typ)
            def component(b,depth=0):
                references.add(blockType+':'+b['Name'])
                instance=widget(blockType+'InstanceWidget');instance['source']=blockType+':'+b['Name'];instance['args']={};instance['slots']={}
                for p in b['Inputs']:
                    if p['Mandatory'] and not p['Default']:instance['args'][p['Name']]=required_value(p)
                if any(p['Name']=='ExtendedClass' for p in b['Inputs']):instance['args']['ExtendedClass']='"coverage"'
                for ev in b['Events']:
                    if ev['Mandatory']:handler(instance,ev)
                for slot in b['Placeholders']:
                    children=[]
                    defaults=slot['Defaults']
                    for default in dict.fromkeys(defaults):
                        kind,_,name=default.partition(':')
                        if kind=='WebBlockInstance' and name in blocks and depth<3:children.append(component(blocks[name],depth+1))
                        elif kind=='Input':children.append(widget('IInput' if mobile else 'IInputWidget',{'Variable':var('Text')}))
                        elif kind in ['List','ListRecords']:
                            children.append(widget('IList' if mobile else 'IListRecordsWidget',{'Source' if mobile else 'SourceRecordList':var('Text List')},[text()]))
                        elif kind in ['CheckBox','RadioButton']:
                            props={'Variable':var('Boolean' if kind=='CheckBox' else 'Text')}
                            if kind=='RadioButton':props['Value']='"Choice"'
                            children.append(widget('ICheckbox' if mobile else 'ICheckBoxWidget',props) if kind=='CheckBox' else widget('IRadioButtonWidget',props))
                        else:children.append(text(name or kind))
                    instance['slots'][slot['Name']]=children or [text()]
                return instance
            subject=component(block)
            screen['widgets'].append(subject)
            if not mobile and any(v['name']!='LastEvent' for v in screen['vars']):
                name=screenName+'_Submit';actions.append({'name':name,'kind':'screen','owner':rootType+':'+screenName,'steps':[]})
                button=widget('IButtonWidget',{'Label':'"Submit"'});button['events']={'OnClick':{'destination':rootType+':'+screenName+'/'+name}};screen['widgets'].append(button)
            if 'ExtendedClass' in subject['args']:
                mutations.append({'op':'set','target':rootType+':'+screenName+'/'+subject['name']+'/ExtendedClass','prop':'Value','value':'"changed"','element':block['Name']})
            elif subject['slots']:
                # A component without ExtendedClass still has an explicit, independently checked placeholder tree.
                name=next(iter(subject['slots']));children=subject['slots'][name]
                if len(children)==1 and children[0]['type']=='ITextWidget':mutations.append({'op':'set','target':rootType+':'+screenName+'/'+subject['name']+'/'+name+'/'+children[0]['name'],'prop':'Text','value':'Changed','element':block['Name']})
            if not any(m['element']==block['Name'] for m in mutations):mutations.append({'op':'set','target':rootType+':'+screenName+'/'+subject['name'],'prop':'Name','value':'RenamedSubject','element':block['Name']})
            screens.append(screen);inventory.append({'module':module,'block':block['Name'],'fixture':fixture,'case':fixture+'-osui-'+str(offset//5+1).zfill(2)})
        contract={'screens':screens}
        if actions:contract['logic']={'actions':actions}
        case={'fixture':fixture,'features':['OutSystemsUI']+[module+':'+b['Name'] for b in selected[offset:offset+5]],'setup':[{'op':'reference','producer':'tests/fixtures/'+producer+'.oml','elements':sorted(references)}],'contract':contract,'mutations':mutations}
        (OUT/(fixture+'-osui-'+str(offset//5+1).zfill(2)+'.json')).write_text(json.dumps(case,indent=2)+'\n',encoding='utf-8')
    return inventory

if __name__=='__main__':
    inventory=[]
    for fixture in ['reactive-ui','mobile-ui']:inventory+=generate(fixture,'OutSystemsUI','OutSystemsUI-2.28.1.json','outsystems-ui')
    inventory+=generate('traditional-ui','OutSystemsUIWeb','OutSystemsUIWeb-1.12.8.json','outsystems-ui-web')
    p=ROOT/'docs/mapa/screen-osui-inventory.json';p.write_text(json.dumps({'scope':'Current public components outside the Private flow; deprecated/internal components are not certified by this matrix.','rows':inventory},indent=2)+'\n',encoding='utf-8')
    print('Component/context rows:',len(inventory))
