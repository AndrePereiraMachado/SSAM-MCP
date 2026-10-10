"""Native block reference research across distinct fixture modules; no publication."""
import json
import pathlib
import sys

ROOT=pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'scripts'))
from anvil_cli import apply, run
OUT=ROOT/'.local/review/ui-interop/references'
OUT.mkdir(parents=True,exist_ok=True)
if len(sys.argv)!=2:
    raise SystemExit('Usage: ui_reference_probe.py <snapshot of a distinct Reactive LAB module>')
producer_base=str(pathlib.Path(sys.argv[1]).resolve())


def execute(name,ops,base=None,producers=None,fixture='tests/fixtures/reactive-ui.oml'):
    job=OUT/(name+'.json');oml=OUT/(name+'.oml')
    job.write_text(json.dumps({'base':fixture,'ops':ops},indent=2),encoding='utf-8')
    r=apply(base=base,job=str(job),out=str(oml),producers=producers)
    (OUT/(name+'.result.json')).write_text(json.dumps(r,indent=2),encoding='utf-8')
    assert r['ok'],r
    assert r['data']['accepted'],r['data'].get('details')
    return str(oml),[x['result'] for x in r['data']['results'] if x['op']=='get']


producer,_=execute('producer',[
    {'op':'create','parent':'IMobileFlow:MainFlow','type':'IMobileBlock','name':'ImportedResearchCard','as':'$b'},
    {'op':'set','target':'$b','prop':'Public','value':True},
    {'op':'create','parent':'$b','type':'IInputParameter','name':'Title','as':'$p'},
    {'op':'set','target':'$p','prop':'DataType','value':'Text'},
    {'op':'create','parent':'$b','type':'IExpression','name':'Heading','as':'$h'},
    {'op':'set','target':'$h','prop':'Value','value':'Title'},
    {'op':'create','parent':'$b','type':'OutSystems.Model.UI.Mobile.Widgets.IPlaceholderWidget','name':'Footer'},
],base=producer_base)
reference={'op':'reference','producer':'UiResearchProducer','elements':['IMobileBlock:ImportedResearchCard']}
instances=['IMobileScreen:ImportResearch/One','IMobileScreen:ImportResearch/Two']
ops=[reference,{'op':'create','parent':'IMobileFlow:MainFlow','type':'IMobileScreen','name':'ImportResearch','as':'$s'}]
for name in ['One','Two']:
    ops.extend([
        {'op':'create','parent':'$s','type':'IMobileBlockInstanceWidget','name':name,'source':'IMobileBlock:ImportedResearchCard','as':'$i'},
        {'op':'set','target':'$i/Title','prop':'Value','value':'"'+name+'"'},
        {'op':'create','parent':'$i/Footer','type':'ITextWidget','name':name+'Footer','as':'$t'},
        {'op':'set','target':'$t','prop':'Text','value':name+' footer'},
    ])
ops.extend({'op':'get','target':t} for t in instances)
consumer,before=execute('consumer',ops,producers=['UiResearchProducer='+producer])
updated,_=execute('producer-updated',[{'op':'set','target':'IMobileBlock:ImportedResearchCard/Heading','prop':'Value','value':'Title + " updated"'}],base=producer)
refreshed,after=execute('consumer-updated',[reference,*({'op':'get','target':t} for t in instances)],base=consumer,producers=['UiResearchProducer='+updated])
assert len(before)==len(after)==2
assert before[0]['properties']['SourceBlock']==before[1]['properties']['SourceBlock']
for a,b in zip(before,after):
    assert a['key']==b['key']
    assert a['properties']['SourceBlock']==b['properties']['SourceBlock']
merge=run(['merge-probe','--base',consumer,'--foreign',refreshed,'--out',str(OUT/'merged.oml'),'--work',str(OUT/'merge')])
(OUT/'merge.json').write_text(json.dumps(merge,indent=2),encoding='utf-8')
assert merge['ok'],merge
_,reloaded=execute('read-merged',[{'op':'get','target':t} for t in instances],base=str(OUT/'merged.oml'))
assert [o['key'] for o in reloaded]==[o['key'] for o in before]
evidence={'passed':True,'instances':2,'distinctReactiveModules':True,'producer':'private lab snapshot','consumer':'reactive fixture','sharedSourceReference':True,'referenceRefresh':True,'reloadAndMerge':True,'browserExecuted':False,'highCodeImportsImplemented':False}
(OUT/'evidence.json').write_text(json.dumps(evidence,indent=2),encoding='utf-8');print(json.dumps(evidence))
