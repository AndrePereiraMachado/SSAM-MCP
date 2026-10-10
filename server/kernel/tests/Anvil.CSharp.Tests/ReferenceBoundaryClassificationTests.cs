using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Anvil.CSharp.Tests;

public class ReferenceBoundaryClassificationTests
{
    private static (SourceProgram Program, IMethodSymbol Method) Source(string declarations, string method)
    {
        var program = SourceProgram.Parse(new Dictionary<string, string> {
            ["Boundary.cs"] = declarations + "\npublic static class Rules { " + method + " }"
        });
        return (program, program.Types.Single(type => type.Name == "Rules").GetMembers("Run").OfType<IMethodSymbol>().Single());
    }
    private static ReferenceBoundary Analyze(string declarations, string method)
        => ReferenceBoundary.Analyze(Source(declarations, method).Method);

    [Theory]
    [InlineData("public sealed class R { public int Value; }", "public static R Run(R value) => value;")]
    [InlineData("public sealed class R { public int Value; }", "public static int Run(R value) => value.Value;")]
    [InlineData("public sealed record R(int Value);", "public static R Run(R value) => value;")]
    [InlineData("public sealed record R(int Value);", "public static R Run() => new(1);")]
    public void EffectFreeReferenceSignaturesStillRequireIdentity(string declarations, string method)
    {
        var boundary = Analyze(declarations, method);
        Assert.True(boundary.IsPublicEntry);
        Assert.True(boundary.RequiresIdentityCodec);
        Assert.Equal(BoundaryTypeKind.ObjectReference, boundary.Types.Single(type => type.Symbol.Name == "R").Kind);
    }

    [Theory]
    [InlineData("R")]
    [InlineData("R?")]
    public void ReferenceNullabilityDoesNotDependOnAnnotation(string type)
    {
        var boundary = Analyze("public sealed record R(int Value);", $"public static {type} Run({type} value) => value;");
        Assert.True(boundary.Types.Single(value => value.Symbol.Name == "R").CanBeNull);
        Assert.True(boundary.RequiresIdentityCodec);
        Assert.Equal(2, boundary.Roots.Count);
        Assert.False(boundary.Roots[0].IsResult);
        Assert.True(boundary.Roots[1].IsResult);
    }

    [Theory]
    [InlineData("List<R>", "ListReference")]
    [InlineData("IReadOnlyList<R>", "ListReference")]
    [InlineData("R[]", "ArrayReference")]
    [InlineData("byte[]", "ArrayReference")]
    public void ListsAndArraysRetainDistinctReferenceKindsIncludingBinaryData(string type, string expected)
    {
        var boundary = Analyze("public sealed record R(int Value);", $"public static {type} Run({type} value) => value;");
        Assert.True(boundary.RequiresIdentityCodec);
        var root = boundary.Types[0];
        Assert.Equal(expected, root.Kind.ToString());
        Assert.True(root.CanBeNull);
        Assert.True(root.HasIdentity);
    }

    [Fact]
    public void OneCatalogClosesAllArgumentsResultsAndRecursiveMembersBySymbol()
    {
        var boundary = Analyze("""
            public sealed class Left { public Right? Next; public Left? Self; }
            public sealed class Right { public List<Left> Values; }
            """, "public static Right Run(Left a, Left? b, Right result) => result;");
        Assert.Equal(4, boundary.Roots.Count);
        Assert.Equal(3, boundary.Types.Count(type => type.HasIdentity));
        Assert.Equal(new[] { "Left", "Right", "List" }, boundary.Types.Where(type => type.HasIdentity).Select(type => type.Symbol.Name));
        Assert.All(boundary.Types.Where(type => type.HasIdentity), type => Assert.True(type.CanBeNull));
    }

    [Fact]
    public void ReferenceClosureCrossesValueTypesNullableAndPrivateOrNotMappedState()
    {
        var boundary = Analyze("""
            public sealed class R { public int Value; }
            public readonly struct Inner { private readonly R Hidden; }
            public struct Middle { [System.ComponentModel.DataAnnotations.Schema.NotMapped] public Inner State; }
            public readonly record struct Envelope(Middle? State);
            """, "public static Envelope Run(Envelope value) => value;");
        Assert.True(boundary.RequiresIdentityCodec);
        Assert.Contains(boundary.Types, type => type.Symbol.Name == "R" && type.HasIdentity);
        Assert.Contains(boundary.Types, type => type.Symbol.Name == "Inner" && type.Kind == BoundaryTypeKind.Value);
        Assert.Contains(boundary.Types, type => type.Symbol.OriginalDefinition.SpecialType == SpecialType.System_Nullable_T);
    }

    [Fact]
    public void ScalarTextAndFrameworkValueTypesDoNotInventObjectIdentity()
    {
        var boundary = Analyze("""
            [Anvil.Authoring.Entity] public sealed record Stored(long Id, string Name);
            public enum Mode { First, Last }
            public readonly record struct ValueDto(int Count, string? Label);
            """, """
            public static ValueDto Run(int number, bool flag, decimal amount, string text, string? optional,
                DateOnly date, DateTime stamp, TimeSpan span, Guid key, Mode mode, Anvil.Authoring.Id<Stored> id,
                ValueDto? value) => value.GetValueOrDefault();
            """);
        Assert.False(boundary.RequiresIdentityCodec);
        var text = Assert.Single(boundary.Types, type => type.Kind == BoundaryTypeKind.Text);
        Assert.True(text.CanBeNull);
        Assert.False(text.HasIdentity);
        Assert.DoesNotContain(boundary.Types, type => type.Symbol.Name == "Stored");
    }

    [Fact]
    public void DataSessionIsAnInjectedInputRatherThanATransportedRoot()
    {
        var input = Analyze("", "public static int Run(Anvil.Authoring.IDataSession data, int number) => number;");
        Assert.Equal(new[] { "number", "Run" }, input.Roots.Select(root => root.Symbol.Name));
        Assert.False(input.RequiresIdentityCodec);
        // This exception is about injection, not a claim that IDataSession can be returned as data.
        var output = Analyze("", "public static Anvil.Authoring.IDataSession Run(Anvil.Authoring.IDataSession data) => data;");
        Assert.Single(output.Roots);
        Assert.True(output.RequiresIdentityCodec);
    }

    [Theory]
    [InlineData("private static R Run(R value) => value;", false)]
    [InlineData("public static R Run(R value) => value;", true)]
    [InlineData("[Anvil.Authoring.ServiceAction] private static R Run(R value) => value;", true)]
    public void PublicEligibilityIsSeparateFromTheSignatureShape(string method, bool isPublic)
    {
        var boundary = Analyze("public sealed record R(int Value);", method);
        Assert.Equal(isPublic, boundary.IsPublicEntry);
        Assert.True(boundary.RequiresIdentityCodec);
    }

    [Fact]
    public void InventoryDoesNotChangeCurrentEffectSelectionOrLegacyDtoContract()
    {
        var (program, method) = Source("public sealed record R(int Value);", "public static R Run(R value) => value;");
        var logic = new LogicModel(program, new DataModel(program));
        Assert.True(logic.References.Boundary(method).RequiresIdentityCodec);
        Assert.False(logic.References.UsesContext(method));
        var compiled = CSharpCompiler.Compile(program.Files);
        var action = Assert.IsType<JsonObject>(Assert.Single(compiled.Specification["logic"]!["actions"]!.AsArray()));
        Assert.Equal("R", action["inputs"]![0]!["type"]!.ToString());
        Assert.Equal("R", action["outputs"]![0]!["type"]!.ToString());
        Assert.DoesNotContain(compiled.SourceMap.OfType<JsonObject>(), entry => entry.ContainsKey("implementation"));
    }

    [Fact]
    public void ExistingEffectfulReferenceDiagnosticIsPreserved()
    {
        var (program, _) = Source("public sealed class R { public int Value; }", "public static int Run(R value) { value.Value++; return value.Value; }");
        var error = Assert.Throws<SourceCompilationException>(() => CSharpCompiler.Compile(program.Files));
        Assert.Contains(error.Diagnostics, diagnostic => diagnostic.Code == "AVCS310" && diagnostic.Message.Contains("codec", StringComparison.Ordinal));
    }

    [Fact]
    public void DataOnlyDtosRemainAvailableWithoutClaimingInvocationIdentity()
    {
        var compiled = CSharpCompiler.CompileData(new Dictionary<string, string> { ["Data.cs"] = "public sealed record R(int Value); public sealed record Box(R Item);" });
        Assert.Equal(new[] { "Box", "R" }, compiled.Specification["data"]!["structures"]!.AsArray().Select(type => type!["name"]!.ToString()));
        Assert.Null(compiled.Specification["logic"]);
    }
}
