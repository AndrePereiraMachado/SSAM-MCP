"""Generate the action coverage map from passing native tests, rejecting gaps and stale outcomes."""
import argparse, hashlib, json, xml.etree.ElementTree as ET
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--validation-root',type=Path,required=True)
    ap.add_argument('--trx',type=Path,required=True)
    ap.add_argument('--out',type=Path,required=True)
    ap.add_argument('--runtime-catalog',type=Path,required=True)
    a=ap.parse_args(); ns={'t':'http://microsoft.com/schemas/VisualStudio/TeamTest/2010'}
    trx=ET.parse(a.trx); results=trx.findall('.//t:UnitTestResult',ns)
    counters=trx.find('.//t:Counters',ns).attrib
    assert all(r.attrib['outcome']=='Passed' for r in results), 'Suite is not fully passing'
    rows=[]; node_cases={}
    for path in sorted((ROOT/'tests/contracts/action-coverage').glob('*.json')):
        name=path.stem
        key=hashlib.sha256(path.read_bytes()).hexdigest()[:12].upper()
        match=[r for r in results if f'caseKey: "{key}"' in r.attrib['testName']]
        assert len(match)==1 and match[0].attrib['outcome']=='Passed', f'Missing passing test: {name}'
        case=json.loads(path.read_text(encoding='utf-8'))
        evidence=json.loads((a.validation_root/'.local/action-coverage'/name/'evidence.json').read_text(encoding='utf-8-sig'))
        assert evidence['status']=='passed' and evidence['caseKey']==key,f'Stale/incomplete evidence: {name}'
        for action in evidence.get('actions',[]):
            for node in action['nodeKinds']:node_cases.setdefault(node,[]).append(name)
        rows.append({'case':name,'contract':str(path.relative_to(ROOT)).replace('\\','/'),'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),**evidence})
    catalog=ROOT/'catalog/model-api-11.55.69.json'
    original=json.loads(catalog.read_text());current=json.loads(a.runtime_catalog.read_text(encoding='utf-8-sig'))
    action_interfaces=lambda c:[i for i in c['Interfaces'] if i['Namespace']=='OutSystems.Model.Logic.Nodes']
    assert action_interfaces(original)==action_interfaces(current),'Runtime action catalog differs from the coverage baseline'
    nodes=[i['Name'].split('.')[-1] for i in json.loads(catalog.read_text())['Interfaces'] if i['Namespace']=='OutSystems.Model.Logic.Nodes' and 'OutSystems.Model.IFlowNode' in i['Bases']]
    excluded={'IActionNode':'Abstract base interface, not a concrete widget','IDecisionOutcomeNode':'BPT decision outcome; native creation rejected in ordinary server/service/client actions'}
    for node in nodes:
        assert node in excluded or node_cases.get(node),f'No positive Verify/reload/merge proof for {node}'
    report={'scope':'All concrete Model API action-node types applicable to ordinary server/service/client or their screen/block/email contexts; structural/native merge coverage, not all runtime/business behavior',
        'runtimeCatalogVerified':True,'runtimeCatalogSha256':hashlib.sha256(a.runtime_catalog.read_bytes()).hexdigest(),
        'catalog':str(catalog.relative_to(ROOT)).replace('\\','/'),'catalogSha256':hashlib.sha256(catalog.read_bytes()).hexdigest(),
        'suite':{'counts':counters,'trx':str(a.trx),'sha256':hashlib.sha256(a.trx.read_bytes()).hexdigest()},
        'concreteWidgets':len(nodes)-len(excluded),'positiveContexts':sum(bool(r.get('nativeMerge')) for r in rows),
        'contextRejections':sum(bool(r.get('invalidContextRejected')) for r in rows),'cases':rows,
        'widgets':[{'interface':n,'status':'not-applicable' if n in excluded else 'native-merge-proved','reason':excluded.get(n),'cases':sorted(set(node_cases.get(n,[])))} for n in sorted(nodes)]}
    a.out.parent.mkdir(parents=True,exist_ok=True);a.out.write_text(json.dumps(report,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
    lines=['# Cobertura de widgets de action', '', report['scope'], '',
        f"{report['concreteWidgets']} widgets concretos; {report['positiveContexts']} contextos positivos; {report['contextRejections']} rejeições explícitas de contexto.", '',
        'Gerado pela suíte nativa. Não mede cobertura de regras de negócio nem execução no servidor/browser.', '',
        '| Widget | Resultado | Casos |', '|---|---|---|']
    for row in report['widgets']:
        examples=', '.join('['+c+'](../../tests/contracts/action-coverage/'+c+'.json)' for c in row['cases'][:2])
        if len(row['cases'])>2:examples+=' (+'+str(len(row['cases'])-2)+' no JSON)'
        lines.append('| '+row['interface']+' | '+(row['reason'] or row['status'])+' | '+examples+' |')
    lines.extend(['', 'A matriz integral de casos e hashes está em ['+a.out.name+']('+a.out.name+').'])
    a.out.with_suffix('.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
    print(json.dumps({k:report[k] for k in ['concreteWidgets','positiveContexts','contextRejections']}))
if __name__=='__main__':main()
