using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis;

namespace Anvil.CSharp;

/// <summary>Compiler-owned portable schema for the staged reference ABI. Consumers
/// receive data descriptors, never a request to execute or re-analyze source code.</summary>
internal static class ReferenceSourceAbi
{
    internal const string Id = "anvil.csharp.reference-graph";
    internal const int Version = 2;
    internal static int VersionFor(ReferenceBoundary boundary, DataModel data)
        => boundary.RequiresTemporalCodec || boundary.Types.Any(type => ReadOnlyListTypes.Is(type.Symbol))
            || boundary.Method.Parameters.Any(parameter => parameter.HasExplicitDefaultValue) ? 4
            : boundary.Types.Any(type => data.IsException(type.Symbol)) ? 3 : Version;

    internal static JsonObject Describe(ReferenceBoundary boundary, DataModel data)
    {
        var definitions = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        JsonObject Shape(ITypeSymbol source)
        {
            var symbol = source.WithNullableAnnotation(NullableAnnotation.NotAnnotated);
            if (ReadOnlyListTypes.Is(symbol))
            {
                var concrete = ReadOnlyListTypes.Concrete(symbol, data.Compilation);
                var list = Shape(concrete.List); var array = Shape(concrete.Array);
                return new() { ["kind"] = "readonly-list", ["listArena"] = list["arena"]!.ToString(), ["arrayArena"] = array["arena"]!.ToString() };
            }
            if (data.IsException(symbol)) return new() { ["kind"] = "exception", ["type"] = Type(symbol) };
            if (symbol is INamedTypeSymbol { OriginalDefinition.SpecialType: SpecialType.System_Nullable_T } optional)
                return new() { ["kind"] = "nullable", ["value"] = Shape(optional.TypeArguments[0]) };
            if (TemporalModel.Kind(symbol) != TemporalKind.None) return new() { ["kind"] = "temporal", ["type"] = Type(symbol) };
            if (IsIdentity(symbol))
            {
                var bits = data.IdentityBits(data.Type(symbol, symbol));
                return new() { ["kind"] = "identity", ["type"] = Type(symbol), ["bits"] = bits };
            }
            if (symbol.SpecialType is SpecialType.System_String or SpecialType.System_Boolean or SpecialType.System_Char
                or SpecialType.System_Byte or SpecialType.System_SByte or SpecialType.System_Int16 or SpecialType.System_UInt16
                or SpecialType.System_Int32 or SpecialType.System_UInt32 or SpecialType.System_Int64 or SpecialType.System_UInt64
                or SpecialType.System_Single or SpecialType.System_Double or SpecialType.System_Decimal || symbol.TypeKind == TypeKind.Enum)
                return new() { ["kind"] = "scalar", ["type"] = Type(symbol) };
            if (symbol.IsValueType) return new() { ["kind"] = "inline", ["type"] = Type(symbol), ["fields"] = Fields((INamedTypeSymbol)symbol) };
            var arena = ReferenceCallerBinding.ArenaName(symbol);
            if (!definitions.ContainsKey(arena))
            {
                var definition = new JsonObject { ["arena"] = arena, ["type"] = Type(symbol) };
                definitions.Add(arena, definition); // Reserve before following recursive members.
                if (symbol is IArrayTypeSymbol array) definition["element"] = Shape(array.ElementType);
                else if (IsList(symbol, out var list)) definition["element"] = Shape(list!.TypeArguments[0]);
                else if (symbol is INamedTypeSymbol named && named.Locations.Any(l => l.IsInSource)) definition["fields"] = Fields(named);
                else throw SourceProgram.Error("AVCS341", "Reference caller requires a concrete source type, List<T> or array", symbol);
            }
            return new() { ["kind"] = "reference", ["arena"] = arena };
        }
        JsonArray Fields(INamedTypeSymbol symbol)
        {
            var declaration = data.Declaration(symbol);
            return new(SourceMember.Of(symbol).Select(member => (JsonNode)new JsonObject {
                ["name"] = declaration.Properties[member.Symbol], ["sourceMember"] = member.Name,
                ["storage"] = member.Symbol is IPropertySymbol ? "<" + member.Name + ">k__BackingField" : member.Name,
                ["shape"] = Shape(member.Type) }).ToArray());
        }
        JsonObject Type(ITypeSymbol symbol)
        {
            symbol = symbol.WithNullableAnnotation(NullableAnnotation.NotAnnotated);
            if (ReadOnlyListTypes.Is(symbol)) return new() { ["kind"] = "readonly-list", ["element"] = Type(((INamedTypeSymbol)symbol).TypeArguments[0]) };
            if (data.IsException(symbol))
            {
                if (symbol.Locations.Any(location => location.IsInSource) || !ExceptionTypes.Builtins.ContainsKey(symbol.ToDisplayString()))
                    throw SourceProgram.Error("AVCS347", "Exception boundary requires a supported exact BCL type", symbol);
                return new() { ["kind"] = "exception", ["name"] = symbol.ToDisplayString() };
            }
            if (IsIdentity(symbol))
                return new() { ["kind"] = "identity", ["target"] = Type(((INamedTypeSymbol)symbol).TypeArguments[0]) };
            if (symbol is INamedTypeSymbol { OriginalDefinition.SpecialType: SpecialType.System_Nullable_T } optional)
                return new() { ["kind"] = "nullable", ["element"] = Type(optional.TypeArguments[0]) };
            if (TemporalModel.Kind(symbol) != TemporalKind.None) return new() { ["kind"] = "temporal", ["name"] = symbol.ToDisplayString() };
            if (symbol is IArrayTypeSymbol array)
            {
                if (array.Rank != 1) throw SourceProgram.Error("AVCS341", "Caller array transport requires rank one", symbol);
                return new() { ["kind"] = "array", ["element"] = Type(array.ElementType) };
            }
            if (IsList(symbol, out var list)) return new() { ["kind"] = "list", ["element"] = Type(list!.TypeArguments[0]) };
            if (symbol is not INamedTypeSymbol named) throw SourceProgram.Error("AVCS341", "Unsupported caller type", symbol);
            var metadata = named.MetadataName;
            for (var parent = named.ContainingType; parent != null; parent = parent.ContainingType) metadata = parent.MetadataName + "+" + metadata;
            if (!named.ContainingNamespace.IsGlobalNamespace) metadata = named.ContainingNamespace.ToDisplayString() + "." + metadata;
            return new() { ["kind"] = named.Locations.Any(l => l.IsInSource) ? "source" : "primitive", ["name"] = metadata };
        }
        var names = new SymbolNames(boundary.Method.Parameters);
        var inputs = new JsonArray(boundary.Method.Parameters.Where(p => !LogicModel.DataDependency(p.Type)).Select(p => {
            var input = new JsonObject { ["name"] = SymbolNames.Normalize("Arg_" + names[p]), ["sourceName"] = p.Name, ["shape"] = Shape(p.Type) };
            if (p.HasExplicitDefaultValue) input["optional"] = true;
            return (JsonNode)input;
        }).ToArray());
        var results = new JsonArray(boundary.Roots.Where(r => r.IsResult).Select(r => (JsonNode)Shape(r.Type)).ToArray());
        var descriptor = new JsonObject { ["id"] = Id, ["version"] = VersionFor(boundary, data), ["inputs"] = inputs, ["results"] = results,
            ["definitions"] = new JsonArray(definitions.OrderBy(p => p.Key, StringComparer.Ordinal).Select(p => (JsonNode)p.Value).ToArray()) };
        if (VersionFor(boundary, data) >= 3) descriptor["exceptionArena"] = "Exceptions";
        return descriptor;
    }
    private static bool IsList(ITypeSymbol type, out INamedTypeSymbol? named)
    {
        named = type as INamedTypeSymbol;
        return named is { IsGenericType: true } && named.OriginalDefinition.ToDisplayString() == "System.Collections.Generic.List<T>";
    }
    private static bool IsIdentity(ITypeSymbol symbol) => symbol is INamedTypeSymbol named
        && named.OriginalDefinition.ToDisplayString() == "Anvil.Authoring.Id<T>"
        && !named.OriginalDefinition.Locations.Any(location => location.IsInSource)
        && named.ContainingAssembly.Identity.GetDisplayName() == typeof(Authoring.Id<>).Assembly.FullName;
}
