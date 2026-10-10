using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Operations;

namespace Anvil.CSharp;

internal sealed partial class MethodCompiler
{
    private SourceValue NewSizedArray(IArrayCreationOperation array, JsonArray steps)
    {
        if (array.DimensionSizes.Length != 1) throw Unsupported(array, "Array allocation requires one dimension");
        var type = Type(array.Type!);
        if (!type.IsArenaReference || !type.IsList) throw Unsupported(array, "Array allocation requires its typed identity representation");
        var count = Snapshot(Value(array.DimensionSizes[0], steps), steps);
        Guard(steps, count.Text + " < 0", "OverflowException", "Arithmetic operation resulted in an overflow.");
        if (Range(count.Type.Source) is { Maximum: > int.MaxValue })
            Guard(steps, count.Text + " > 2147483647", "OverflowException",
                count.Type.Source.SpecialType == Microsoft.CodeAnalysis.SpecialType.System_UInt32
                    ? "Arithmetic operation resulted in an overflow." : "Array dimensions exceeded supported range.");
        var result = AllocateReference(type, steps);
        var cell = ReadCell(result, steps);
        // This untouched runtime local includes the complete nullable wrapper and
        // reference handle. StorageDefault deliberately strips nullable presence.
        var element = Temp(type.Element!);
        var position = Temp(Type(model.Program.Compilation.GetSpecialType(SpecialType.System_Int32)));
        Assign(steps, position.Text, "0");
        steps.Add(new JsonObject { ["while"] = position.Text + " < " + count.Text,
            ["do"] = new JsonArray(new JsonObject { ["call"] = "ListAppend", ["as"] = "AvArrayDefault" + ++calls,
                ["args"] = new JsonObject { ["List"] = cell.Text + ".Items", ["Element"] = element.Text } }),
            ["next"] = new JsonArray(new JsonObject { ["assign"] = new JsonObject { [position.Text] = position.Text + " + 1" } }) });
        Assign(steps, CellPath(result), cell.Text);
        return result;
    }
    private SourceValue NewList(ValueType type,IEnumerable<IOperation> elements,JsonArray steps,IOperation location)
    {
        if (type.IsArenaReference) return NewReferenceList(type, elements, steps);
        if(!type.IsList||type.Nullable)throw Unsupported(location,"Collection construction requires a non-null typed list");
        var result=EmptyList(type,steps);
        foreach(var element in elements)
        {
            var value=Coerce(Value(element,steps),type.Element!,false,steps,element);
            steps.Add(new JsonObject {["call"]="ListAppend",["as"]="AvAppend"+(++calls),["args"]=new JsonObject {["List"]=result.Text,["Element"]=value.Text}});
        }
        return result;
    }
    private SourceValue EmptyList(ValueType type,JsonArray steps)
    {
        if (type.IsArenaReference) return AllocateReference(type, steps);
        var result=Temp(type);
        // A query materialization and a list literal both allocate a fresh collection per evaluation.
        steps.Add(new JsonObject {["call"]="ListClear",["as"]="AvClear"+(++calls),["args"]=new JsonObject {["List"]=result.Text}});
        return result;
    }
    private SourceValue NewList(IObjectCreationOperation op,ValueType type,JsonArray steps)
    {
        if(op.Arguments.Length!=0)throw Unsupported(op,"Collection constructor arguments require copy/capacity semantics");
        var elements=new List<IOperation>();
        foreach(var initializer in op.Initializer?.Initializers??[])
        {
            if(initializer is not IInvocationOperation {TargetMethod.Name:"Add",Arguments.Length:1} add)throw Unsupported(initializer,"Collection initializer requires one element at a time");
            elements.Add(add.Arguments[0].Value);
        }
        return NewList(type,elements,steps,op);
    }
}
