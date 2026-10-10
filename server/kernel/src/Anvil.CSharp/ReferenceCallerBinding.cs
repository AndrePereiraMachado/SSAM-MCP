using System.Reflection;
using System.Text.Json.Nodes;
using Anvil.Authoring.Transport;
using Microsoft.CodeAnalysis;

namespace Anvil.CSharp;

/// <summary>Compiler convenience facade. The actual caller binding consumes a portable
/// ABI descriptor in Anvil.Authoring and does not depend on Roslyn.</summary>
internal sealed class ReferenceCallerBinding
{
    private readonly ReferenceGraphBinding binding;
    internal IReadOnlyList<GraphDefinition> Definitions => binding.Definitions;
    internal IReadOnlyList<GraphShape> Inputs => binding.Inputs;
    internal IReadOnlyList<GraphShape> Results => binding.Results;
    internal ReferenceGraphSession CreateSession() => binding.CreateSession();
    internal object? Invoke(string nativeAction, IReadOnlyList<object?> arguments, Func<string, JsonObject, JsonObject> transport)
        => binding.CreateCall(nativeAction).Invoke(arguments, transport);
    internal ReferenceCallerBinding(ReferenceBoundary boundary, DataModel data, Assembly sourceAssembly)
        : this(ReferenceSourceAbi.Describe(boundary, data), sourceAssembly) { }
    internal ReferenceCallerBinding(JsonObject schema, Assembly sourceAssembly) => binding = new(schema, sourceAssembly, maxSupportedVersion: 4);

    internal static string ArenaName(ITypeSymbol symbol) => "Cells_" + SymbolNames.Digest(
        symbol.WithNullableAnnotation(NullableAnnotation.NotAnnotated).ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat));
}
