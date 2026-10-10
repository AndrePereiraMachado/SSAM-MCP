using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Operations;
using System.Text.Json.Nodes;

namespace Anvil.CSharp;

internal static class ReadOnlyListTypes
{
    internal static bool Is(ITypeSymbol type) => type is INamedTypeSymbol named && named.IsGenericType
        && named.OriginalDefinition.ToDisplayString() == "System.Collections.Generic.IReadOnlyList<T>";
    internal static int ConcreteKind(ITypeSymbol type) => type is IArrayTypeSymbol { Rank: 1, IsSZArray: true } ? 2
        : type is INamedTypeSymbol named && named.IsGenericType && named.OriginalDefinition.ToDisplayString() == "System.Collections.Generic.List<T>" ? 1 : 0;
    internal static (INamedTypeSymbol List, IArrayTypeSymbol Array) Concrete(ITypeSymbol type, Compilation compilation)
    {
        var element = ((INamedTypeSymbol)type).TypeArguments[0];
        return (compilation.GetTypeByMetadataName("System.Collections.Generic.List`1")!.Construct(element), compilation.CreateArrayTypeSymbol(element));
    }
    internal static string RuntimeName(ITypeSymbol type)
    {
        if (type is IArrayTypeSymbol array) return RuntimeName(array.ElementType) + "[]";
        var named = (INamedTypeSymbol)type;
        var prefix = named.ContainingType is { } parent ? RuntimeName(parent) + "+"
            : named.ContainingNamespace.IsGlobalNamespace ? "" : named.ContainingNamespace.ToDisplayString() + ".";
        return prefix + named.MetadataName + (named.IsGenericType ? "[" + string.Join(",", named.TypeArguments.Select(RuntimeName)) + "]" : "");
    }
    internal static string InvalidHandle(string path) => "not ((" + path + ".Kind = 0 and " + path + ".Index = 0) or (("
        + path + ".Kind = 1 or " + path + ".Kind = 2) and " + path + ".Index > 0)) or Mod(" + path + ".Index, 1) <> 0";
}

internal sealed record ReadOnlyListLayout(string Handle, ValueType List, ValueType Array);

internal sealed partial class ReferenceModel
{
    private readonly Dictionary<string, ReadOnlyListLayout> readOnlyLists = new(StringComparer.Ordinal);
    private readonly HashSet<string> readOnlyHandles = new(StringComparer.Ordinal);
    internal ReadOnlyListLayout ReadOnlyLayout(ValueType type) => readOnlyLists[type.Native];
    private ValueType ReadOnlyRuntime(ValueType type)
    {
        var key = type.Source.WithNullableAnnotation(NullableAnnotation.NotAnnotated).ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
        var handle = Unique("AvReadOnly_" + SymbolNames.Digest(key));
        if (readOnlyHandles.Add(handle))
        {
            // Reserve before concrete element traversal: a node can point back to
            // this view while its backing List<Node>/Node[] layouts are being built.
            data.AddRuntimeStructure(Structure(handle, new JsonArray(Field("Kind", "Integer"), Field("Index", "Integer"))));
            var concrete = ReadOnlyListTypes.Concrete(type.Source, program.Compilation);
            var list = Runtime(data.Type(concrete.List, type.Source));
            var array = Runtime(data.Type(concrete.Array, type.Source));
            if (!list.IsArenaReference || !array.IsArenaReference || !array.IsList)
                throw SourceProgram.Error("AVCS348", "Read-only list view requires represented concrete List<T> and T[] arenas for this element type", type.Source);
            readOnlyLists.Add(handle, new(handle, list, array));
        }
        return type with { Native = handle, Nullable = false, Category = RuntimeCategory.ReadOnlyListReference, Element = Runtime(type.Element!) };
    }
}

internal sealed partial class MethodCompiler
{
    private SourceValue ReadOnlyConversion(SourceValue value, ValueType target, JsonArray steps, IOperation location)
    {
        if (target.Native == value.Type.Native) return value with { Type = target };
        if (value.Type.Element == null || target.Element == null || !SymbolEqualityComparer.Default.Equals(value.Type.Element.Source, target.Element.Source))
            throw Unsupported(location, "Read-only list conversions require the exact element type; covariance is not represented");
        if (target.IsReadOnlyListReference && ReadOnlyListTypes.ConcreteKind(value.Type.Source) is 1 or 2 && value.Type.IsArenaReference)
        {
            var result = Temp(target); var kind = ReadOnlyListTypes.ConcreteKind(value.Type.Source);
            Assign(steps, result.Text + ".Kind", "If(" + value.Text + ".Index = 0, 0, " + kind + ")");
            Assign(steps, result.Text + ".Index", value.Text + ".Index"); return result;
        }
        if (value.Type.IsReadOnlyListReference && ReadOnlyListTypes.ConcreteKind(target.Source) is 1 or 2 && target.IsArenaReference)
        {
            var kind = ReadOnlyListTypes.ConcreteKind(target.Source);
            var view = model.References.ReadOnlyLayout(value.Type);
            var actual = kind == 1 ? view.Array.Source : view.List.Source;
            Guard(steps, value.Text + ".Index <> 0 and " + value.Text + ".Kind <> " + kind, "InvalidCastException",
                "Unable to cast object of type '" + ReadOnlyListTypes.RuntimeName(actual) + "' to type '" + ReadOnlyListTypes.RuntimeName(target.Source) + "'.");
            var result = Temp(target); Assign(steps, result.Text + ".Index", value.Text + ".Index"); return result;
        }
        throw Unsupported(location, "Read-only list views support only exact List<T> and T[] runtime types");
    }

    private void CheckReadOnlyReference(SourceValue value, JsonArray steps)
    {
        Guard(steps, value.Text + ".Index = 0", "NullReferenceException", "Object reference not set to an instance of an object.");
        Guard(steps, value.Text + ".Kind <> 1 and " + value.Text + ".Kind <> 2", "InvalidOperationException", "Read-only list runtime type is not represented.");
        var layout = model.References.ReadOnlyLayout(value.Type);
        foreach (var (kind, type) in new[] { (1, layout.List), (2, layout.Array) })
        {
            var invalid = value.Text + ".Index < 0 or " + value.Text + ".Index > " + Arena(type) + ".Length";
            Guard(steps, value.Text + ".Kind = " + kind + " and (" + invalid + ")", "InvalidOperationException", "Reference does not belong to this invocation.");
        }
    }

    private SourceValue ReadReadOnlyCell(SourceValue value, JsonArray steps)
    {
        CheckReadOnlyReference(value, steps);
        var layout = model.References.ReadOnlyLayout(value.Type);
        // This is a read snapshot, never a new identity or a copied collection argument.
        var result = Temp(NativeType(model.References.Layout(layout.List).Cell));
        var list = new JsonArray(); Assign(list, result.Text, Arena(layout.List) + "[" + value.Text + ".Index - 1]");
        var array = new JsonArray(); Assign(array, result.Text + ".Items", Arena(layout.Array) + "[" + value.Text + ".Index - 1].Items");
        Assign(array, result.Text + ".Version", "0"); Assign(array, result.Text + ".Capacity", result.Text + ".Items.Length");
        steps.Add(new JsonObject { ["if"] = value.Text + ".Kind = 1", ["then"] = list, ["else"] = array });
        return result;
    }

    private string ReferenceIdentity(SourceValue left, SourceValue right, JsonArray steps, IOperation location)
    {
        if (left.Type.IsReadOnlyListReference || right.Type.IsReadOnlyListReference)
        {
            var view = left.Type.IsReadOnlyListReference ? left.Type : right.Type;
            if (left.Type.Element != null && right.Type.Element != null
                && SymbolEqualityComparer.Default.Equals(left.Type.Element.Source, right.Type.Element.Source))
            {
                left = ReadOnlyConversion(left, view, steps, location); right = ReadOnlyConversion(right, view, steps, location);
                return left.Text + ".Kind = " + right.Text + ".Kind and " + left.Text + ".Index = " + right.Text + ".Index";
            }
        }
        return left.Type.Native == right.Type.Native ? left.Text + ".Index = " + right.Text + ".Index"
            : left.Text + ".Index = 0 and " + right.Text + ".Index = 0";
    }
}
