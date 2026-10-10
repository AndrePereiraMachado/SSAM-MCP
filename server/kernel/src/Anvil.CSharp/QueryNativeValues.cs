using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Operations;
using System.Text.Json.Nodes;

namespace Anvil.CSharp;

internal sealed partial class MethodCompiler
{
    private sealed record NativeGroup(SqlGroup Shape,string Rows,string Start,string End);
    private sealed record NativeRow(SqlShape Shape,string Row);
    private readonly Dictionary<IParameterSymbol,NativeGroup> nativeGroups = new(SymbolEqualityComparer.Default);
    private readonly Dictionary<IParameterSymbol,NativeRow> nativeRows = new(SymbolEqualityComparer.Default);
    private ValueType QueryPrimitive(SpecialType type) => Type(model.Program.Compilation.GetSpecialType(type));
    private ValueType QueryWorkType(string name) => new(name,false,model.Program.Compilation.GetSpecialType(SpecialType.System_Object),Category:RuntimeCategory.NativeBuffer);
    private ValueType QueryListType(ValueType item) => new(model.Data.Transport(item)+" List",false,model.Program.Compilation.CreateArrayTypeSymbol(item.Source),Element:item,Category:RuntimeCategory.NativeBuffer);
    private SourceValue QueryList(ValueType item,JsonArray steps) => EmptyList(QueryListType(item),steps);
    private void QueryAppend(string list,string item,JsonArray steps) => steps.Add(new JsonObject {
        ["call"]="ListAppend",["as"]="AvQueryAppend"+(++calls),["args"]=new JsonObject {["List"]=list,["Element"]=item} });

    private NativeRow? QueryRow(IOperation? op)
    {
        while(op is IConversionOperation conversion) op=conversion.Operand;
        if(op is IParameterReferenceOperation parameter) return nativeRows.GetValueOrDefault(parameter.Parameter);
        if(op is not IPropertyReferenceOperation property)return null;
        if(property.Instance is IParameterReferenceOperation groupParameter && nativeGroups.TryGetValue(groupParameter.Parameter,out var group) && property.Property.Name=="Key")
            return new(group.Shape.Key,group.Rows+"["+group.Start+"].List");
        var parent=QueryRow(property.Instance);
        var member=parent?.Shape.Members?.FirstOrDefault(m=>SymbolEqualityComparer.Default.Equals(m.Property,property.Property));
        return member is {Shape:not null}?new(member.Value.Shape,parent!.Row):null;
    }
    private SourceValue? NativeQueryValue(IOperation op,JsonArray steps)
    {
        if(nativeGroups.Count==0 && nativeRows.Count==0)return null;
        if(op is IInvocationOperation aggregate && aggregate.TargetMethod.ContainingType.ToDisplayString()=="System.Linq.Enumerable")
        {
            IOperation? input=aggregate.Arguments.FirstOrDefault()?.Value;
            while(input is IConversionOperation converted)input=converted.Operand;
            if(input is IParameterReferenceOperation parameter && nativeGroups.TryGetValue(parameter.Parameter,out var group))return NativeAggregate(aggregate,group,steps);
        }
        if(QueryRow(op) is { } row)return ReadNativeRow(row,steps,op);
        return null;
    }
    private SourceValue ReadNativeRow(NativeRow row,JsonArray steps,IOperation location)
    {
        if(row.Shape.Value is { } leaf)
        {
            if(leaf.Expression.Column<0 || leaf.Predicate)throw Unsupported(location,"Native query input must be a materialized typed column");
            var column=leaf.Expression.Column;
            return new(row.Row+".AvC"+column,leaf.Type,leaf.Type.Nullable?row.Row+".AvHas"+column:null);
        }
        var type=Type(row.Shape.Source);var result=Temp(type with {Nullable=false});
        var declaration=type.Declaration??throw Unsupported(location,"Native projection needs a declared record type");
        foreach(var (property,shape) in row.Shape.Members??[])
            Store(steps,new(result.Text+"."+declaration.Properties[property],Type(property.Type)),ReadNativeRow(new(shape,row.Row),steps,location),location);
        return result;
    }
    private SourceValue QueryLambda(IAnonymousFunctionOperation lambda,SourceValue item,NativeGroup? group,JsonArray steps)
    {
        if(lambda.Symbol.Parameters.Length!=1)throw Unsupported(lambda,"Indexed query lambdas need explicit index semantics");
        var parameter=lambda.Symbol.Parameters.Single();
        var returned=lambda.Body.Operations.OfType<IReturnOperation>().SingleOrDefault()?.ReturnedValue??throw Unsupported(lambda,"Query requires an expression lambda");
        var old=boundValues.GetValueOrDefault(parameter);var oldGroup=nativeGroups.GetValueOrDefault(parameter);
        if(group!=null)nativeGroups[parameter]=group;else boundValues[parameter]=item;
        try{return Value(returned,steps);}
        finally
        {
            if(old==null)boundValues.Remove(parameter);else boundValues[parameter]=old;
            if(oldGroup==null)nativeGroups.Remove(parameter);else nativeGroups[parameter]=oldGroup;
        }
    }
    private SourceValue NativeAggregate(IInvocationOperation op,NativeGroup group,JsonArray steps)
    {
        var kind=op.TargetMethod.Name;var outputType=Type(op.Type!);
        if(kind=="Count" && op.Arguments.Length==1)return new("("+group.End+" - "+group.Start+")",outputType);
        if(kind is not ("Count" or "Sum" or "Average" or "Min" or "Max"))throw Unsupported(op,"Group aggregate is not translated: "+kind);
        var selector=op.Arguments.Length>1?Lambda(op.Arguments[1].Value):null;
        var integer=QueryPrimitive(SpecialType.System_Int32);var boolean=QueryPrimitive(SpecialType.System_Boolean);
        var index=Temp(integer);var count=kind=="Average"?Temp(integer):null;var seen=kind is "Min" or "Max" or "Average"?Temp(boolean):null;
        Assign(steps,index.Text,group.Start);if(count!=null)Assign(steps,count.Text,"0");if(seen!=null)Assign(steps,seen.Text,"False");
        var result=Temp(outputType with {Nullable=false});Assign(steps,result.Text,StorageDefault(result.Type));
        var body=new JsonArray();SourceValue selected;
        if(selector!=null)
        {
            var parameter=selector.Symbol.Parameters.Single();var previous=nativeRows.GetValueOrDefault(parameter);
            nativeRows[parameter]=new(group.Shape.Element,group.Rows+"["+index.Text+"].List");
            try{selected=Value(selector.Body.Operations.OfType<IReturnOperation>().Single().ReturnedValue!,body);}
            finally{if(previous==null)nativeRows.Remove(parameter);else nativeRows[parameter]=previous;}
        }
        else selected=ReadNativeRow(new(group.Shape.Element,group.Rows+"["+index.Text+"].List"),body,op);
        var add=new JsonArray();var payload=Payload(selected);
        if(kind=="Count")Assign(add,result.Text,result.Text+" + 1");
        else if(kind is "Sum" or "Average")
        {
            var converted=Coerce(payload,result.Type,true,add,op);
            var sum=Numeric(BinaryOperatorKind.Add,result.Text,converted.Text,result.Type,true,add,op);
            Assign(add,result.Text,sum.Text);
        }
        else
        {
            var assign=new JsonArray();Store(assign,result,payload,op);
            add.Add(new JsonObject {["if"]="not "+seen!.Text+" or "+payload.Text+(kind=="Min"?" < ":" > ")+result.Text,["then"]=assign});
        }
        if(count!=null)Assign(add,count.Text,count.Text+" + 1");if(seen!=null)Assign(add,seen.Text,"True");
        body.Add(new JsonObject {["if"]=kind=="Count"?selected.Text:Present(selected),["then"]=add});
        var next=new JsonArray();Assign(next,index.Text,index.Text+" + 1");
        steps.Add(new JsonObject {["while"]=index.Text+" < "+group.End,["do"]=body,["next"]=next});
        if(kind=="Average")
        {
            var divide=new JsonArray();var mean=Numeric(BinaryOperatorKind.Divide,result.Text,count!.Text,result.Type,true,divide,op);Assign(divide,result.Text,mean.Text);
            steps.Add(new JsonObject {["if"]=seen!.Text,["then"]=divide});
        }
        if(kind is "Min" or "Max" or "Average")
        {
            if(!outputType.Nullable)Guard(steps,"not "+seen!.Text,"InvalidOperationException","Sequence contains no elements.");
            else return Coerce(new(result.Text,outputType,seen!.Text),outputType,false,steps,op);
        }
        return Coerce(result,outputType,false,steps,op);
    }
}
