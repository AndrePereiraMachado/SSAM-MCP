using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Operations;
using System.Text.Json.Nodes;

namespace Anvil.CSharp;

internal sealed partial class MethodCompiler
{
    private NativeSequence QuerySort(NativeSequence source,IReadOnlyList<IInvocationOperation> orders,JsonArray steps)
    {
        var selectors=orders.Select(op=>Lambda(op.Arguments[1].Value)).ToArray();
        var types=selectors.Select(selector=>Type(selector.Symbol.ReturnType)).ToArray();
        foreach(var op in orders)
        {
            if(op.Arguments.Length<3)continue;
            IOperation comparer=op.Arguments[2].Value;while(comparer is IConversionOperation conversion)comparer=conversion.Operand;
            if(comparer is not IPropertyReferenceOperation {Property.Name:"Ordinal"} property || property.Property.ContainingType.ToDisplayString()!="System.StringComparer")
                throw Unsupported(comparer,"This query comparer has no native sequence translation");
        }
        var fields=new List<(string Name,string Type)>{("Item",model.Data.Transport(source.Item))};
        fields.AddRange(types.Select((type,i)=>("Key"+i,model.Data.Transport(type))));
        var rowType=QueryWorkType(model.Data.QueryWorkRow(fields));
        var current=QueryList(rowType,steps);var buffer=QueryList(rowType,steps);var row=Temp(rowType);
        var integer=QueryPrimitive(SpecialType.System_Int32);var index=Temp(integer);Assign(steps,index.Text,"0");var decorate=new JsonArray();
        var item=new SourceValue(source.Value.Text+"["+index.Text+"]",source.Item);Assign(decorate,row.Text+".Item",item.Text);
        for(var i=0;i<selectors.Length;i++)Store(decorate,new(row.Text+".Key"+i,types[i]),QueryLambda(selectors[i],item,source.Cursor(item.Text),decorate),selectors[i]);
        QueryAppend(current.Text,row.Text,decorate);QueryWalk(source.Value,index,decorate,steps);

        // Stable bottom-up merge sort. Each key is evaluated once, and buffers own their
        // containers: no in-place mutation or dependence on source reference aliasing.
        var width=Temp(integer);var start=Temp(integer);var middle=Temp(integer);var stop=Temp(integer);var left=Temp(integer);var right=Temp(integer);var comparison=Temp(integer);
        var chooseLeft=Temp(QueryPrimitive(SpecialType.System_Boolean));
        Assign(steps,width.Text,"1");var pass=new JsonArray();QueryClear(buffer.Text,pass);Assign(pass,start.Text,"0");var chunk=new JsonArray();
        Assign(chunk,middle.Text,"If("+width.Text+" < "+current.Text+".Length - "+start.Text+", "+start.Text+" + "+width.Text+", "+current.Text+".Length)");
        Assign(chunk,stop.Text,"If("+width.Text+" < "+current.Text+".Length - "+middle.Text+", "+middle.Text+" + "+width.Text+", "+current.Text+".Length)");
        Assign(chunk,left.Text,start.Text);Assign(chunk,right.Text,middle.Text);
        var merge=new JsonArray();var compare=new JsonArray();Assign(compare,comparison.Text,"0");
        for(var i=0;i<types.Length;i++)
        {
            var keySteps=new JsonArray();
            QueryCompare(new(current.Text+"["+left.Text+"].Key"+i,types[i]),new(current.Text+"["+right.Text+"].Key"+i,types[i]),comparison,
                orders[i].TargetMethod.Name.EndsWith("Descending",StringComparison.Ordinal),orders[i].Arguments.Length>=3,keySteps,orders[i]);
            compare.Add(new JsonObject {["if"]=comparison.Text+" = 0",["then"]=keySteps});
        }
        var appendLeft=new JsonArray();QueryAppend(buffer.Text,current.Text+"["+left.Text+"]",appendLeft);Assign(appendLeft,left.Text,left.Text+" + 1");
        var appendRight=new JsonArray();QueryAppend(buffer.Text,current.Text+"["+right.Text+"]",appendRight);Assign(appendRight,right.Text,right.Text+" + 1");
        Assign(compare,chooseLeft.Text,comparison.Text+" <= 0");
        var onlyRight=new JsonArray();Assign(onlyRight,chooseLeft.Text,"False");var onlyLeft=new JsonArray();Assign(onlyLeft,chooseLeft.Text,"True");
        merge.Add(new JsonObject {["if"]=left.Text+" >= "+middle.Text,["then"]=onlyRight,["else"]=new JsonArray(new JsonObject {
            ["if"]=right.Text+" >= "+stop.Text,["then"]=onlyLeft,["else"]=compare})});
        merge.Add(new JsonObject {["if"]=chooseLeft.Text,["then"]=appendLeft,["else"]=appendRight});
        chunk.Add(new JsonObject {["while"]=left.Text+" < "+middle.Text+" or "+right.Text+" < "+stop.Text,["do"]=merge});Assign(chunk,start.Text,stop.Text);
        pass.Add(new JsonObject {["while"]=start.Text+" < "+current.Text+".Length",["do"]=chunk});
        QueryClear(current.Text,pass);Assign(pass,index.Text,"0");var copy=new JsonArray();QueryAppend(current.Text,buffer.Text+"["+index.Text+"]",copy);QueryWalk(buffer,index,copy,pass);
        Assign(pass,width.Text,"If("+width.Text+" < "+current.Text+".Length - "+width.Text+", "+width.Text+" * 2, "+current.Text+".Length)");
        steps.Add(new JsonObject {["while"]=width.Text+" < "+current.Text+".Length",["do"]=pass});
        var result=QueryList(source.Item,steps);Assign(steps,index.Text,"0");var unwrap=new JsonArray();QueryAppend(result.Text,current.Text+"["+index.Text+"].Item",unwrap);QueryWalk(current,index,unwrap,steps);
        return source with {Value=result};
    }
    private void QueryClear(string list,JsonArray steps) => steps.Add(new JsonObject {["call"]="ListClear",["as"]="AvQueryClear"+(++calls),["args"]=new JsonObject {["List"]=list}});
    private void QueryCompare(SourceValue left,SourceValue right,SourceValue result,bool descending,bool ordinal,JsonArray steps,IOperation location)
    {
        var a=Payload(left);var b=Payload(right);var smaller=descending?"1":"-1";var greater=descending?"-1":"1";
        string Comparable(SourceValue value)
        {
            if(value.Type.IsIdentity)return (ShortIdentity(value.Type)?"IdentifierToInteger(":"IdentifierToLongInteger(")+value.Text+")";
            return value.Type.Native=="Boolean"?"If("+value.Text+", 1, 0)":value.Text;
        }
        if(a.Type.IsList || a.Type.Declaration is {Kind:not DataKind.Enum} && !a.Type.IsIdentity)
            throw Unsupported(location,"Ordering requires a scalar key or an explicit supported comparer");
        if(a.Type.Temporal != TemporalKind.None) throw Unsupported(location, "Temporal query ordering requires its own scalar key lowering" );
        var scalar=new JsonArray();
        if(a.Type.Source.SpecialType==SpecialType.System_String && ordinal)
        {
            var comparison = OrdinalTextPayloads(a, b, scalar);
            // Sorting observes the sign. Branches avoid negating int.MinValue when
            // reversing a comparator; nulls stay outside the primitive call.
            Assign(scalar,result.Text,"If("+comparison.Text+" < 0, "+smaller+", If("+comparison.Text+" > 0, "+greater+", 0))");
        }
        else Assign(scalar,result.Text,"If("+Comparable(a)+" < "+Comparable(b)+", "+smaller+", If("+Comparable(a)+" > "+Comparable(b)+", "+greater+", 0))");
        var nullLeft=new JsonArray();Assign(nullLeft,result.Text,"If("+Present(right)+", "+smaller+", 0)");
        var nullRight=new JsonArray();Assign(nullRight,result.Text,greater);
        steps.Add(new JsonObject {["if"]="not ("+Present(left)+")",["then"]=nullLeft,["else"]=new JsonArray(new JsonObject {
            ["if"]="not ("+Present(right)+")",["then"]=nullRight,["else"]=scalar})});
    }
}
