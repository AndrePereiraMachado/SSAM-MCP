"""Generate a LAB-only experiment for exported runtime list operations.

This is not a supported frontend adapter. It compares the normal ListSort with the
runtime's tracking/propagation protocol, without assigning private fields or changing DOM.
Only synthetic local records are used. Deliver/publish separately to ZZHtmlImports_UI.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / '.local/review/list-identity'
OUT.mkdir(parents=True, exist_ok=True)
def field(name, typ): return {'name': name, 'type': typ}
def widget(typ, name, properties=None, **rest): return {'type': typ, 'name': name, 'properties': properties or {}, **rest}
def button(name, owner): return widget('IButton', name, children=[widget('ITextWidget', name+'Text', {'Text': name})], events={'OnClick': {'destination': owner+'/'+name}})
screen = 'IMobileScreen:ListIdentityProtocol'
block = 'IMobileBlock:IdentityCounter'
actions = [
    {'name': 'Increment', 'kind': 'screen', 'owner': block, 'steps': [{'assign': {'Count': 'Count + 1'}}]},
    {'name': 'Reset', 'kind': 'screen', 'owner': screen, 'steps': [
        {'node': 'IJSONDeserializeNode', 'as': 'Decode', 'properties': {'JSONString': '"[{""Id"":""1"",""Caption"":""A""},{""Id"":""2"",""Caption"":""B""}]"', 'DataType': 'IdentityRow List', 'DateFormat': 'ISO'}},
        {'assign': {'Items': 'Decode.Data'}}]},
    {'name': 'NativeSort', 'kind': 'screen', 'owner': screen, 'steps': [{'call': 'IClientActionSignature:ListSort', 'as': 'Sort', 'args': {'List': 'Items', 'By': 'Id', 'Ascending': 'False'}}]},
]
for name, ascending in [('TrackedDescending', False), ('TrackedAscending', True)]:
    code = '''const types = require('OutSystems/ClientRuntime/DataTypes');
const rows = $parameters.Rows;
const ids = () => Array.from({length:rows.length}, (_,i)=>rows.idOf(i));
$parameters.Before = JSON.stringify(ids());
const raw = types.ImmutableBase.getData(rows);
const sorted = raw.sort(i=>types.ImmutableBase.getData(rows.getItem(i)), item=>{
    const record=rows.newItem(item);
    const field=record.getAttributes().find(a=>a.name==='Id');
    return record.getBasicProperty(field.attrName);
}, ASCENDING);
rows.writePropagate(sorted, new types.ListCache());
$parameters.After = JSON.stringify(ids());'''.replace('ASCENDING', str(ascending).lower())
    actions.append({'name': name, 'kind': 'screen', 'owner': screen, 'steps': [
        {'node': 'IJavaScriptNode', 'as': 'SortTracked', 'properties': {'JavaScript': code},
         'inputs': [field('Rows', 'Object')], 'args': {'Rows': 'ToObject(Items)'}, 'outputs': [field('Before', 'Text'), field('After', 'Text')]},
        {'assign': {'BeforeIds': 'SortTracked.Before', 'AfterIds': 'SortTracked.After'}}]})
spec = {'data': {'structures': [{'name': 'IdentityRow', 'attributes': [field('Id', 'Text'), field('Caption', 'Text')]}]},
        'logic': {'actions': actions}, 'screens': [
    {'name': 'IdentityCounter', 'type': 'IMobileBlock', 'flow': 'MainFlow', 'inputs': [field('Caption', 'Text')], 'vars': [field('Count', 'Integer')], 'widgets': [
        widget('IContainer', 'Counter', {'Style': '"identity-counter"'}, children=[
            widget('IExpression', 'CaptionText', {'Value': 'Caption', 'Style': '"caption"'}),
            widget('IExpression', 'Value', {'Value': 'IntegerToText(Count)', 'Style': '"count"'}), button('Increment', block)])]},
    {'name': 'ListIdentityProtocol', 'type': 'IMobileScreen', 'flow': 'MainFlow', 'roles': ['Anonymous', 'Registered'],
     'vars': [field('Items', 'IdentityRow List'), field('BeforeIds', 'Text'), field('AfterIds', 'Text')], 'events': {'OnInitialize': {'destination': screen+'/Reset'}},
     'properties': {'StyleSheet': '.identity-counter{margin:16px;padding:20px;border:1px solid #ddd}.identity-counter span{margin-right:20px}'},
     'widgets': [widget('IMobileBlockInstanceWidget', 'Layout', source='IMobileBlock:LayoutBlank', slots={'Content': [
         *[button(name, screen) for name in ['Reset', 'NativeSort', 'TrackedDescending', 'TrackedAscending']],
         widget('IExpression', 'Before', {'Value': 'BeforeIds', 'Style': '"before-ids"'}),
         widget('IExpression', 'After', {'Value': 'AfterIds', 'Style': '"after-ids"'}),
         widget('IList', 'Rows', {'Source': 'Items'}, children=[widget('IMobileBlockInstanceWidget', 'Counter', source=block, args={'Caption': 'Items.Current.Caption'})])
     ]})]}
]}
path = OUT / 'protocol.spec.json'
path.write_text(json.dumps(spec, indent=2), encoding='utf-8')
print(path)
