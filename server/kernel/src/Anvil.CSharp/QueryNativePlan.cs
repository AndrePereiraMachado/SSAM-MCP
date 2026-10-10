using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Operations;
using System.Text.Json.Nodes;

namespace Anvil.CSharp;

internal sealed partial class MethodCompiler
{
    private sealed record NativeSequence(SourceValue Value,SqlGroup? Group=null,string? Rows=null)
    {
        public ValueType Item => Value.Type.Element!;
        public NativeGroup? Cursor(string item) => Group==null?null:new(Group,Rows!,item+".Start",item+".Stop");
    }
    private SourceValue NativeGroupedQuery(IInvocationOperation terminal,SqlRelation relation,SqlQuery sql,JsonArray steps)
    {
        var group=relation.Grouping!;var columns=new List<(string Name,string Type)>();var values=new List<string>();
        for(var i=0;i<relation.Columns.Count;i++)
        {
            var type=relation.Columns[i];columns.Add(("AvC"+i,type.Native));values.Add("AvSource.AvC"+i);
            if(type.Nullable)
            {
                columns.Add(("AvHas"+i,"Boolean"));values.Add("CASE WHEN AvSource.AvC"+i+" IS NOT NULL THEN 1 ELSE 0 END AS AvHas"+i);
            }
        }
        var keys=group.Key.Leaves.SelectMany(v=>v.Type.Native=="Text"?new[]{v.Scalar.Render(),"DATALENGTH("+v.Scalar.Render()+")"}:new[]{v.Scalar.Render()});
        columns.Add(("AvGroupOrdinal","Long Integer"));
        values.Add("MIN("+group.Ordinal.Render()+") OVER (PARTITION BY "+string.Join(", ",keys)+") AS AvGroupOrdinal");
        var query="AvQuery"+(++calls);
        var statement="SELECT "+string.Join(", ",values)+" FROM ("+relation.Query+") AvSource ORDER BY AvGroupOrdinal, "+group.Ordinal.Render();
        steps.Add(new JsonObject {["get"]=model.Data.ProjectionSqlRow(columns),["as"]=query,["sql"]=true,["statement"]=statement,["params"]=sql.Parameters});
        var integer=QueryPrimitive(SpecialType.System_Int32);
        var spanType=QueryWorkType(model.Data.QueryWorkRow([("Start","Integer"),("Stop","Integer")]));
        var spans=QueryList(spanType,steps);var span=Temp(spanType);var index=Temp(integer);var id=Temp(QueryPrimitive(SpecialType.System_Int64));
        Assign(steps,index.Text,"0");var scan=new JsonArray();Assign(scan,span.Text+".Start",index.Text);
        Assign(scan,id.Text,query+".List["+index.Text+"].List.AvGroupOrdinal");
        var sameGroup=new JsonArray(new JsonObject {["if"]=query+".List["+index.Text+"].List.AvGroupOrdinal <> "+id.Text,["then"]=new JsonArray(new JsonObject {["break"]=true})});
        Assign(sameGroup,index.Text,index.Text+" + 1");
        scan.Add(new JsonObject {["while"]=index.Text+" < "+query+".List.Length",["do"]=sameGroup});
        Assign(scan,span.Text+".Stop",index.Text);QueryAppend(spans.Text,span.Text,scan);
        steps.Add(new JsonObject {["while"]=index.Text+" < "+query+".List.Length",["do"]=scan});
        var sequence=new NativeSequence(spans,group,query+".List");
        for(var i=0;i<relation.NativeOperators.Count;i++)
        {
            var op=relation.NativeOperators[i];var kind=op.TargetMethod.Name;
            if(kind=="Where")sequence=QueryFilter(sequence,Lambda(op.Arguments[1].Value),steps);
            else if(kind=="Select")sequence=QuerySelect(sequence,Lambda(op.Arguments[1].Value),steps);
            else if(kind is "Skip" or "Take")sequence=QueryPage(sequence,Value(op.Arguments[1].Value,steps),kind=="Skip",steps);
            else if(kind.StartsWith("OrderBy",StringComparison.Ordinal))
            {
                var orders=new List<IInvocationOperation>{op};
                while(i+1<relation.NativeOperators.Count && relation.NativeOperators[i+1].TargetMethod.Name.StartsWith("ThenBy",StringComparison.Ordinal))orders.Add(relation.NativeOperators[++i]);
                sequence=QuerySort(sequence,orders,steps);
            }
            else throw Unsupported(op,"Ordering continuation has no preceding native OrderBy");
        }
        if(terminal.Arguments.Length>1)sequence=QueryFilter(sequence,Lambda(terminal.Arguments[1].Value),steps);
        var name=terminal.TargetMethod.Name;var list=sequence.Value;
        if(name=="Count")return new(list.Text+".Length",Type(terminal.Type!));
        if(name=="Any")return new(list.Text+".Length > 0",Type(terminal.Type!));
        if(sequence.Group!=null)throw Unsupported(terminal,"Materializing group objects needs a public nested collection contract");
        if(name is "Single" or "SingleOrDefault")Guard(steps,list.Text+".Length > 1","InvalidOperationException","Sequence contains more than one element.");
        if(name is "First" or "Single")
        {Guard(steps,list.Text+".Length = 0","InvalidOperationException","Sequence contains no elements.");return new(list.Text+"[0]",sequence.Item);}
        if(name is "FirstOrDefault" or "SingleOrDefault")
        {
            var type=Type(terminal.Type!);if(terminal.Type!.IsReferenceType)type=type with {Nullable=true};
            var result=Temp(type);Assign(steps,type.Nullable?result.Text+".HasValue":result.Text,type.Nullable?"False":StorageDefault(type));
            var present=new JsonArray();Store(present,result,new(list.Text+"[0]",sequence.Item),terminal);
            steps.Add(new JsonObject {["if"]=list.Text+".Length > 0",["then"]=present});return result;
        }
        return Coerce(list,Type(terminal.Type!),false,steps,terminal);
    }
    private NativeSequence QueryFilter(NativeSequence source,IAnonymousFunctionOperation predicate,JsonArray steps)
    {
        var output=QueryList(source.Item,steps);var index=Temp(QueryPrimitive(SpecialType.System_Int32));Assign(steps,index.Text,"0");
        var body=new JsonArray();var item=new SourceValue(source.Value.Text+"["+index.Text+"]",source.Item);
        var condition=QueryLambda(predicate,item,source.Cursor(item.Text),body);var append=new JsonArray();QueryAppend(output.Text,item.Text,append);
        body.Add(new JsonObject {["if"]=condition.Text,["then"]=append});QueryWalk(source.Value,index,body,steps);
        return source with {Value=output};
    }
    private NativeSequence QuerySelect(NativeSequence source,IAnonymousFunctionOperation selector,JsonArray steps)
    {
        var itemType=Type(selector.Symbol.ReturnType);var output=QueryList(itemType,steps);var index=Temp(QueryPrimitive(SpecialType.System_Int32));Assign(steps,index.Text,"0");
        var body=new JsonArray();var item=new SourceValue(source.Value.Text+"["+index.Text+"]",source.Item);
        var selected=Coerce(QueryLambda(selector,item,source.Cursor(item.Text),body),itemType,false,body,selector);
        QueryAppend(output.Text,selected.Text,body);QueryWalk(source.Value,index,body,steps);return new(output);
    }
    private NativeSequence QueryPage(NativeSequence source,SourceValue count,bool skip,JsonArray steps)
    {
        var output=QueryList(source.Item,steps);var index=Temp(QueryPrimitive(SpecialType.System_Int32));var limit=Temp(index.Type);
        Assign(steps,index.Text,skip?"If("+count.Text+" < 0, 0, "+count.Text+")":"0");
        Assign(steps,limit.Text,skip?source.Value.Text+".Length":"If("+count.Text+" < 0, 0, If("+count.Text+" < "+source.Value.Text+".Length, "+count.Text+", "+source.Value.Text+".Length))");
        var body=new JsonArray();QueryAppend(output.Text,source.Value.Text+"["+index.Text+"]",body);
        var next=new JsonArray();Assign(next,index.Text,index.Text+" + 1");
        steps.Add(new JsonObject {["while"]=index.Text+" < "+limit.Text,["do"]=body,["next"]=next});return source with {Value=output};
    }
    private void QueryWalk(SourceValue list,SourceValue index,JsonArray body,JsonArray steps)
    {
        var next=new JsonArray();Assign(next,index.Text,index.Text+" + 1");
        steps.Add(new JsonObject {["while"]=index.Text+" < "+list.Text+".Length",["do"]=body,["next"]=next});
    }
}
