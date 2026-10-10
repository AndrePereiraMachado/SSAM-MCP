"""Focused native-model research. Writes only private fixture artifacts; no Studio mutations.

Run with ANVIL_LANE=ss5 and the matching installed compiler. The observations are
not browser execution and do not enable any syntax in the production frontend.
"""
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'scripts'))
from anvil_cli import apply

OUT = ROOT / '.local/review/ui-interop'
OUT.mkdir(parents=True, exist_ok=True)


def field(name, typ):
    return {'name': name, 'type': typ}


def run(name, code, typ='Integer', extras=None):
    js = {'node': 'IJavaScriptNode', 'as': 'Evaluate',
          'properties': {'JavaScript': code},
          'inputs': [field('Value', typ)], 'outputs': [field('Result', typ)],
          'args': {'Value': 'Value'}}
    action = {'name': 'Probe', 'kind': 'client', 'public': True,
              'inputs': [field('Value', typ)], 'outputs': [field('Result', typ)],
              'steps': [js, {'assign': {'Result': 'Evaluate.Result'}}]}
    declarations = [{'op': 'spec', 'data': {'structures': [{'name': 'InteropRow', 'public': True, 'attributes': [
            field('Id', 'Long Integer'), field('Caption', 'Text'), field('Amount', 'Decimal'),
            field('At', 'Date Time')]}]}}] if typ.startswith('InteropRow') else []
    job = {'base': 'tests/fixtures/reactive-ui.oml', 'ops': [*declarations,
        {'op': 'logic', 'data': {'actions': [*(extras or []), action]}},
        {'op': 'get', 'target': 'IClientAction:Probe/Evaluate'}]}
    path = OUT / (name + '.json')
    path.write_text(json.dumps(job, indent=2), encoding='utf-8')
    result = apply(job=str(path), out=str(OUT / (name + '.oml')))
    (OUT / (name + '.result.json')).write_text(json.dumps(result, indent=2), encoding='utf-8')
    data = result.get('data') or {}
    observation = {'case': name, 'commandOk': result.get('ok'), 'error': result.get('error'),
                   'valid': data.get('isValid'), 'accepted': data.get('accepted'),
                   'details': data.get('details'), 'node': next((r.get('result') for r in data.get('results', [])
                                                               if r.get('op') == 'get'), None)}
    print(json.dumps({k: v for k, v in observation.items() if k != 'node'}), flush=True)
    return observation


server = {'name': 'ServerEcho', 'kind': 'server', 'inputs': [field('Value', 'Integer')],
          'outputs': [field('Result', 'Integer')], 'steps': [{'assign': {'Result': 'Value + 1'}}]}
wrapper = {'name': 'ClientEcho', 'kind': 'client', 'inputs': [field('Value', 'Integer')],
           'outputs': [field('Result', 'Integer')], 'steps': [
               {'call': 'ServerEcho', 'as': 'Fetch', 'args': {'Value': 'Value'}},
               {'assign': {'Result': 'Fetch.Result'}}]}
cases = [
    run('synchronous', '$parameters.Result=$parameters.Value;'),
    run('promise-only', 'Promise.resolve($parameters.Value).then(v => {$parameters.Result=v;});'),
    run('async-resolve', 'setTimeout(function(){$parameters.Result=$parameters.Value;$resolve();},25);'),
    run('async-reject', '$parameters.Result=$parameters.Value;$reject(new Error("probe"));'),
    run('server-direct', '$actions.ServerEcho($parameters.Value).then(r=>{$parameters.Result=r.Result;$resolve();},$reject);', extras=[server]),
    run('server-wrapper', '$actions.ClientEcho($parameters.Value).then(r=>{$parameters.Result=r.Result;$resolve();},$reject);', extras=[server, wrapper]),
    run('record-parameter', '$parameters.Result=$parameters.Value;', 'InteropRow'),
    run('list-parameter', '$parameters.Result=$parameters.Value;', 'InteropRow List'),
    run('long-parameter', '$parameters.Result=$parameters.Value;', 'Long Integer'),
]
expected_invalid = {'server-direct', 'record-parameter', 'list-parameter'}
for case in cases:
    assert case['commandOk'], case
    assert case['valid'] == (case['case'] not in expected_invalid), case
    if case['case'] not in expected_invalid:
        assert case['accepted'], case
    expected_async = case['case'] in {'async-resolve', 'async-reject', 'server-direct', 'server-wrapper'}
    assert case['node']['properties']['IsAsynchronous'] == str(expected_async), case
    # Reload the saved OML independently rather than trusting the in-memory node.
    read_path = OUT / 'read.json'
    read_path.write_text(json.dumps({'ops': [{'op': 'get', 'target': 'IClientAction:Probe/Evaluate'}]}), encoding='utf-8')
    reloaded = apply(base=str(OUT / (case['case'] + '.oml')), job=str(read_path), out=str(OUT / 'read.oml'))
    assert reloaded['ok'], reloaded
    node = reloaded['data']['results'][0]['result']
    assert node['key'] == case['node']['key']
    assert node['properties']['IsAsynchronous'] == str(expected_async)
    case['reloadPreserved'] = True
(OUT / 'observations.json').write_text(json.dumps({'browserExecuted': False, 'cases': cases}, indent=2), encoding='utf-8')
