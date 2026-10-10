using System.Text.Json.Nodes;
using Xunit;

namespace Anvil.CSharp.Tests;

public sealed class AlwaysThrowResultTests
{
    [Theory]
    [InlineData("Cell")]
    [InlineData("int")]
    [InlineData("int?")]
    [InlineData("string")]
    [InlineData("List<int>")]
    public void AlwaysThrowNonVoidKeepsItsTypedOutputWithoutReturningABusinessValue(string returnType)
    {
        var source = """
            public sealed class Cell { public int Value { get; set; } }
            public static class Rules {
                public static RETURN_TYPE ThrowNonVoid(Cell value) {
                    value.Value += 7;
                    throw new InvalidOperationException("after mutation");
                }
            }
            """.Replace("RETURN_TYPE", returnType, StringComparison.Ordinal);
        var compiled = CSharpCompiler.CompileReferenceGraph(new Dictionary<string, string> { ["AlwaysThrow.cs"] = source });
        var implementation = Action(compiled, "AvImpl_ThrowNonVoid");
        AssertExactDefaultStorage(implementation);
        Assert.DoesNotContain(Assignments(implementation["steps"]!), assignment => assignment.Key == "AvCompletion.Kind" && assignment.Value!.ToString() is "0" or "1");
        using var call = new ReferencePublicGraphTests.Call(source, "ThrowNonVoid");
        var value = call.New("Cell"); value.GetType().GetProperty("Value")!.SetValue(value, 10);
        var failure = Assert.Throws<InvalidOperationException>(() => call.Invoke(value));
        Assert.Equal("after mutation", failure.Message);
        Assert.Equal(17, call.Member(value, "Value"));
        Assert.Equal(2, call.LastResponse!["AvCompletion"]!["Kind"]!.GetValue<int>());
        Assert.Equal(1, call.Invocations);
    }

    [Fact]
    public void BranchesThatBothThrowReceiveOneDefaultWhileRealReturnsKeepTheirAssignment()
    {
        const string source = """
            public sealed class Cell { public int Value { get; set; } }
            public static class Rules {
                public static Cell BothFail(Cell value) {
                    if (value.Value > 0) throw new InvalidOperationException("positive");
                    else throw new InvalidOperationException("other");
                }
                public static Cell MayReturn(Cell value) {
                    if (value.Value > 0) throw new InvalidOperationException("positive");
                    return value;
                }
            }
            """;
        var compiled = CSharpCompiler.CompileReferenceGraph(new Dictionary<string, string> { ["Branches.cs"] = source });
        AssertExactDefaultStorage(Action(compiled, "AvImpl_BothFail"));
        var returns = Action(compiled, "AvImpl_MayReturn");
        var assignment = Assert.Single(Assignments(returns["steps"]!), pair => pair.Key == "AvResult");
        Assert.Equal("Arg_value", assignment.Value!.ToString());
        Assert.Contains(Assignments(returns["steps"]!), pair => pair.Key == "AvCompletion.Kind" && pair.Value!.ToString() == "1");
    }

    [Fact]
    public void NativeScalarRaiseRetainsItsSignatureAndStillThrows()
    {
        const string source = """
            public static class Rules {
                public static int ThrowNonVoid() { throw new InvalidOperationException("always fails"); }
            }
            """;
        var compiled = CSharpCompiler.Compile(new Dictionary<string, string> { ["Scalar.cs"] = source });
        var action = Action(compiled, "ThrowNonVoid");
        AssertExactDefaultStorage(action);
        Assert.DoesNotContain(action["steps"]!.AsArray(), step => step!.AsObject().ContainsKey("return"));
        var failure = Assert.Throws<ReferenceGraphProbe.Failure>(() => new ReferenceGraphProbe(compiled.Specification).Run("ThrowNonVoid"));
        Assert.Equal("InvalidOperationException", failure.Kind);
        Assert.Equal("always fails", failure.Message);
    }

    private static void AssertExactDefaultStorage(JsonObject action)
    {
        var output = Assert.Single(action["outputs"]!.AsArray(), parameter => parameter!["name"]!.ToString() == "AvResult")!;
        var assignment = Assert.Single(Assignments(action["steps"]!), pair => pair.Key == "AvResult");
        var storage = Assert.Single(action["vars"]!.AsArray(), variable => variable!["name"]!.ToString() == assignment.Value!.ToString())!;
        Assert.Equal(output["type"]!.ToString(), storage["type"]!.ToString());
        Assert.DoesNotContain(Assignments(action["steps"]!), pair => pair.Key == storage["name"]!.ToString()
            || pair.Key.StartsWith(storage["name"] + ".", StringComparison.Ordinal));
    }

    private static JsonObject Action(CompilationResult compilation, string name)
        => compilation.Specification["logic"]!["actions"]!.AsArray().OfType<JsonObject>().Single(action => action["name"]!.ToString() == name);
    private static IEnumerable<KeyValuePair<string, JsonNode?>> Assignments(JsonNode node)
    {
        if (node is JsonArray list)
            foreach (var child in list) foreach (var pair in Assignments(child!)) yield return pair;
        else if (node is JsonObject item)
        {
            if (item["assign"] is JsonObject assignments) foreach (var pair in assignments) yield return pair;
            foreach (var child in item.Where(pair => pair.Key != "assign" && pair.Value is JsonObject or JsonArray))
                foreach (var pair in Assignments(child.Value!)) yield return pair;
        }
    }
}
