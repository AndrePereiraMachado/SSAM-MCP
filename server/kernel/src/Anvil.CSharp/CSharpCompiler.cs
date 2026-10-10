using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis;

namespace Anvil.CSharp;

public sealed record CompilationResult(JsonObject Specification, JsonArray SourceMap, string SourceHash, JsonArray? RetiredStructures = null,
    IReadOnlyList<FrameworkIntrinsic>? RequiredIntrinsics = null, JsonArray? SourceAbis = null);

public static class CSharpCompiler
{
    public static CompilationResult Compile(IReadOnlyDictionary<string, string> files) => CompileCore(files, false);
    // Staging entry for the complete graph ABI. Normal authoring remains unchanged until
    // native entry/caller/producer integration and existing persistence paths are proved.
    internal static CompilationResult CompileReferenceGraph(IReadOnlyDictionary<string, string> files) => CompileCore(files, true);
    private static CompilationResult CompileCore(IReadOnlyDictionary<string, string> files, bool graphBoundaries)
    {
        var program = SourceProgram.Parse(files); DataDeclarations.Validate(program);
        var data = new DataModel(program); var logic = new LogicModel(program, data, graphBoundaries); var specification = new JsonObject();
        logic.Apply(specification);
        var schema = data.Emit(specification["logic"]); if (schema.Count > 0) specification["data"] = schema;
        var mapping = data.Mapping; foreach (var action in logic.Mapping) mapping.Add(action!.DeepClone());
        return new(specification, mapping, program.Hash, data.LegacyQueryRows(),logic.RequiredIntrinsics, logic.SourceAbis);
    }
    public static CompilationResult CompileData(IReadOnlyDictionary<string, string> files)
    {
        var program = SourceProgram.Parse(files);
        var data = new DataModel(program);
        // This entry is deliberately data-only until logic lowering is connected.
        // A business method must never disappear merely because the data model compiled.
        var method = program.Types.SelectMany(t => t.GetMembers().OfType<IMethodSymbol>())
            .FirstOrDefault(m => !m.IsImplicitlyDeclared && m.MethodKind == MethodKind.Ordinary);
        if (method != null) throw SourceProgram.Error("AVCS101", "Business methods require the Logic translator; data-only compilation does not discard them", method);
        DataDeclarations.Validate(program);
        var specification = new JsonObject { ["data"] = data.Emit() };
        return new(specification, data.Mapping, program.Hash);
    }
}
