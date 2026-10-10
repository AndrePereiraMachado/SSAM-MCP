"""Generate a bounded runtime experiment, not a product frontend or recovery path.

Native spec has one screen and one block, with two isolated block instances.
Only synthetic values are used. Delivery/publication are separate explicit steps.
"""
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[3]
OUT = ROOT / '.local/review/ui-interop'
OUT.mkdir(parents=True, exist_ok=True)


def f(name, typ, default=None):
    return dict(name=name, type=typ, **({'default': default} if default is not None else {}))


def w(typ, name, properties=None, **kw):
    return dict(type=typ, name=name, properties=properties or {}, **kw)


def js(name, code, inputs=(), outputs=(), args=None):
    return dict(node='IJavaScriptNode', **{'as': name}, properties={'JavaScript': code},
                inputs=list(inputs), outputs=list(outputs), args=args or {})


owner = 'IMobileBlock:InteropAsyncCard'


def button(name, action):
    return w('IButton', name, children=[w('ITextWidget', name+'Label', {'Text': name})],
             events={'OnClick': {'destination': owner+'/'+action}})


def action(name, steps, inputs=()):
    return dict(name=name, kind='screen', owner=owner, inputs=list(inputs), steps=steps)


# The Object frame is per native block instance, never a global registry or DOM key.
# Browser proof must establish it survives the native input boundary by reference.
actions = [
    {'name': 'InteropServerEcho', 'kind': 'server', 'inputs': [f('Value', 'Integer')],
     'outputs': [f('Result', 'Integer')], 'steps': [{'assign': {'Result': 'Value + 1'}}]},
    {'name': 'InteropClientEcho', 'kind': 'client', 'inputs': [f('Value', 'Integer')],
     'outputs': [f('Result', 'Integer')], 'steps': [
         {'call': 'InteropServerEcho', 'as': 'Fetch', 'args': {'Value': 'Value'}},
         {'assign': {'Result': 'Fetch.Result'}}]},
    action('Initialize', [js('Frame', '$parameters.Value={alive:true,version:0};', outputs=[f('Value', 'Object')]),
                          {'assign': {'Lifetime': 'Frame.Value'}}]),
    action('Destroy', [js('Dispose', '$parameters.Frame.alive=false;', [f('Frame', 'Object')], args={'Frame': 'Lifetime'})]),
    action('Commit', [{'assign': {'Result': 'Value', 'Busy': 'False', 'Failure': 'Message'}}],
           [f('Value', 'Integer'), f('Message', 'Text')]),
]
wire = '[{"Id":9223372036854775807,"Caption":"primeiro","Amount":123456789012345.6789,"At":"2026-09-06T12:34:56"},{"Id":9007199254740993,"Caption":"segundo","Amount":0.1,"At":"1900-01-01T00:00:00"}]'
wire_literal = '"' + wire.replace('"', '""') + '"'
actions[2]['steps'].extend([
    {'node': 'IJSONDeserializeNode', 'as': 'Decode', 'properties': {'JSONString': wire_literal, 'DataType': 'InteropWireRow List', 'DateFormat': 'ISO'}},
    {'assign': {'Rows': 'Decode.Data'}},
    {'foreach': 'Rows', 'as': 'EachRow', 'do': [
        {'assign': {'SafeRow.Id': 'LongIntegerToText(Rows.Current.Id)', 'SafeRow.Caption': 'Rows.Current.Caption',
                    'SafeRow.Amount': 'DecimalToText(Rows.Current.Amount)', 'SafeRow.At': 'FormatDateTime(Rows.Current.At, "yyyy-MM-ddTHH:mm:ss")'}},
        {'call': 'IClientActionSignature:ListAppend', 'as': 'AppendWire', 'args': {'List': 'SafeRows', 'Element': 'SafeRow'}}]},
    {'node': 'IJSONSerializeNode', 'as': 'Encode', 'properties': {'Data': 'SafeRows', 'DateFormat': 'ISO', 'SerializeDefaultValues': True}},
    {'assign': {'WireJson': 'Encode.JSON'}},
])
for name, delay, value, reject in [('Slow', 1800, 10, False), ('Fast', 150, 20, False), ('Fail', 150, 0, True)]:
    code = '''const frame=$parameters.Frame, version=++frame.version;
  const request=REJECT ? Promise.reject(new Error('synthetic failure')) : $actions.InteropClientEcho(VALUE);
  const delayed=request.then(value=>new Promise(resolve=>setTimeout(()=>resolve(value),DELAY)),
                             error=>new Promise((resolve,reject)=>setTimeout(()=>reject(error),DELAY)));
  delayed.then(function(value){
    if(!frame.alive || frame.version!==version){$resolve();return;}
    Promise.resolve().then(()=>$actions.Commit(value.Result,'')).then($resolve,$reject);
  },function(error){
    if(!frame.alive || frame.version!==version){$resolve();return;}
    Promise.resolve().then(()=>$actions.Commit(-1,error.message)).then($resolve,$reject);
  });'''.replace('REJECT', str(reject).lower()).replace('VALUE', str(value)).replace('DELAY', str(delay))
    actions.append(action(name, [{'assign': {'Busy': 'True', 'Failure': '""'}},
                                 js('Wait', code, [f('Frame', 'Object')], args={'Frame': 'Lifetime'})]))

card = dict(name='InteropAsyncCard', type='IMobileBlock', flow='MainFlow', properties={'Public': True},
            vars=[f('Lifetime', 'Object'), f('Busy', 'Boolean', 'False'), f('Result', 'Integer', '0'), f('Failure', 'Text', '""'), f('Rows', 'InteropWireRow List'), f('WireJson', 'Text'), f('SafeRows', 'InteropWireTextRow List'), f('SafeRow', 'InteropWireTextRow')],
            events={'OnInitialize': {'destination': owner+'/Initialize'}, 'OnDestroy': {'destination': owner+'/Destroy'}},
            widgets=[w('IContainer', 'Card', {'Style': '"interop-card"'}, children=[
                w('IExpression', 'BusyLabel', {'Value': 'If(Busy, "loading", "idle")', 'Style': '"busy"'}),
                w('IExpression', 'ResultLabel', {'Value': 'IntegerToText(Result)', 'Style': '"result"'}),
                w('IExpression', 'ErrorLabel', {'Value': 'Failure', 'Style': '"failure"'}),
                *[button(n, n) for n in ['Slow', 'Fast', 'Fail']],
                w('IExpression', 'WireLabel', {'Value': 'WireJson', 'Style': '"wire-json"'}),
                w('IList', 'NativeRows', {'Source': 'Rows', 'Style': '"wire-rows"'}, children=[
                    w('IExpression', 'RowLabel', {'Value': 'LongIntegerToText(Rows.Current.Id) + ":" + Rows.Current.Caption'})])])])
screen = dict(name='InteropResearch', type='IMobileScreen', flow='MainFlow', roles=['Anonymous', 'Registered'],
              properties={'StyleSheet': '.interop-card{padding:24px;margin:20px;border:1px solid #ccc}.interop-card span{margin-right:16px}.interop-card button{margin:8px}'},
              vars=[f('Visible', 'Boolean', 'True')], widgets=[
                  w('IMobileBlockInstanceWidget', 'Layout', source='IMobileBlock:LayoutBlank', slots={'Content': [
                      w('IButton', 'Toggle', children=[w('ITextWidget', 'ToggleLabel', {'Text': 'Toggle first'})],
                        events={'OnClick': {'destination': 'IMobileScreen:InteropResearch/ToggleFirst'}}),
                      w('IIfWidget', 'Mount', {'Condition': 'Visible'}, slots={'TrueBranch': [
                          w('IMobileBlockInstanceWidget', 'First', source=owner)], 'FalseBranch': []}),
                      w('IMobileBlockInstanceWidget', 'Second', source=owner)]})])
actions.append({'name': 'ToggleFirst', 'kind': 'screen', 'owner': 'IMobileScreen:InteropResearch',
                'steps': [{'assign': {'Visible': 'not Visible'}}]})
repeat_owner='IMobileScreen:InteropListResearch'
actions.append({'name':'SortRows','kind':'screen','owner':repeat_owner,'steps':[
    {'call':'IClientActionSignature:ListSort','as':'SortItems','args':{'List':'Items','By':'Id','Ascending':'False'}}]})
for method, rows in [('LoadRows',[{'Id':1,'Caption':'A'},{'Id':2,'Caption':'B'}]),('ReverseRows',[{'Id':2,'Caption':'B'},{'Id':1,'Caption':'A'}])]:
    literal='"'+json.dumps(rows).replace('"','""')+'"'
    actions.append({'name':method,'kind':'screen','owner':repeat_owner,'steps':[
        {'node':'IJSONDeserializeNode','as':'Decode','properties':{'JSONString':literal,'DataType':'InteropWireRow List','DateFormat':'ISO'}},
        {'assign':{'Items':'Decode.Data'}}]})
repeat_screen=dict(name='InteropListResearch',type='IMobileScreen',flow='MainFlow',roles=['Anonymous','Registered'],
                   vars=[f('Items','InteropWireRow List')],events={'OnInitialize':{'destination':repeat_owner+'/LoadRows'}},widgets=[
    w('IMobileBlockInstanceWidget','Layout',source='IMobileBlock:LayoutBlank',slots={'Content':[
        w('IButton','Sort',children=[w('ITextWidget','SortLabel',{'Text':'Sort rows'})],events={'OnClick':{'destination':repeat_owner+'/SortRows'}}),
        w('IButton','Reverse',children=[w('ITextWidget','ReverseLabel',{'Text':'Reverse rows'})],events={'OnClick':{'destination':repeat_owner+'/ReverseRows'}}),
        w('IList','Rows',{'Source':'Items'},children=[
            w('IContainer','Row',{'Style':'"research-row"'},children=[
                w('IExpression','Caption',{'Value':'Items.Current.Caption','Style':'"row-caption"'}),
                w('IMobileBlockInstanceWidget','Card',source=owner)])])]} )])
spec = {'screens': [card, screen, repeat_screen], 'logic': {'actions': actions}, 'data': {'structures': [
    {'name': 'InteropWireRow', 'attributes': [f('Id', 'Long Integer'), f('Caption', 'Text'), f('Amount', 'Decimal'), f('At', 'Date Time')]},
    {'name': 'InteropWireTextRow', 'attributes': [f('Id', 'Text'), f('Caption', 'Text'), f('Amount', 'Text'), f('At', 'Text')]}]}}
path = OUT / 'async-lab.spec.json'
path.write_text(json.dumps(spec, indent=2), encoding='utf-8')
print(path)
