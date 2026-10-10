using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.CSharp;
using Xunit;

namespace Anvil.CSharp.Tests;

public sealed class FixedReferenceErrorTests
{
    private const string Source = """
        public sealed class Cell { public int Value { get; set; } }
        public static class Rules
        {
            public static int Loop(int failAt)
            {
                Cell? cell = new Cell();
                var total = 0;
                for (var i = 0; i < 3; i++)
                {
                    cell.Value += 1;
                    if (i == failAt) cell = null;
                    total += cell.Value;
                }
                return total;
            }
            public static int Choose(int mode)
            {
                var cell = new Cell();
                cell.Value = 7;
                if (mode == 0) return cell.Value;
                if (mode == 1)
                {
                    Cell missing = null!;
                    return missing.Value;
                }
                int? empty = null;
                return empty.Value;
            }
            public static int Dynamic(int seed, bool skip)
            {
                var cell = new Cell();
                cell.Value = seed;
                if (skip) return cell.Value;
                throw new ArgumentException(Message(cell), Parameter(cell));
            }
            private static string Message(Cell cell)
            {
                cell.Value += 1;
                return "failure:" + cell.Value;
            }
            private static string Parameter(Cell cell)
            {
                cell.Value += 10;
                return "argument:" + cell.Value;
            }
        }
        """;

    private static readonly Lazy<CompilationResult> Compiled = new(() => CSharpCompiler.Compile(
        new Dictionary<string, string> { ["FixedReferenceErrors.cs"] = Source }));

    [Theory]
    [InlineData(-1)]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    public void LoopGuardFailsOnlyWhenReachedAndPreservesEarlierEffects(int failAt)
    {
        var output = Run(new ReferenceGraphProbe(Compiled.Value.Specification), "Loop", null, ("failAt", failAt));
        Assert.Equal(failAt < 0 ? 3m : failAt + 1m, CellValue(output));
        if (failAt < 0)
        {
            Assert.Equal(6m, output["AvResult"]);
            Assert.Equal(0m, Fields(output["AvCompletion"])["ExceptionRef"]);
            Assert.Empty(Exceptions(output));
        }
        else AssertFailure(output, new NullReferenceException(), 1);
    }

    [Fact]
    public void RepeatedFailuresAppendDistinctIndicesAndEarlyReturnPreservesExistingErrors()
    {
        var probe = new ReferenceGraphProbe(Compiled.Value.Specification);
        Dictionary<string, object>? context = null;
        var previousErrors = new List<string>();
        foreach (var mode in new[] { 1, 1, 2, 1 })
        {
            var output = Run(probe, "Choose", context, ("mode", mode));
            AssertFailure(output, mode == 1 ? new NullReferenceException() : new InvalidOperationException("Nullable object must have a value."), previousErrors.Count + 1);
            var errors = Exceptions(output);
            Assert.Equal(previousErrors, errors.Take(previousErrors.Count).Select(error => JsonSerializer.Serialize(error)));
            previousErrors.Add(JsonSerializer.Serialize(errors[^1]));
            context = Fields(output["AvContextOut"]);
        }

        var returned = Run(probe, "Choose", context, ("mode", 0));
        Assert.Equal(7m, returned["AvResult"]);
        Assert.Equal(1m, Fields(returned["AvCompletion"])["Kind"]);
        Assert.Equal(0m, Fields(returned["AvCompletion"])["ExceptionRef"]);
        Assert.Equal(previousErrors, Exceptions(returned).Select(error => JsonSerializer.Serialize(error)));

        var fresh = Run(probe, "Choose", null, ("mode", 1));
        AssertFailure(fresh, new NullReferenceException(), 1);
        var successful = Run(probe, "Choose", null, ("mode", 0));
        Assert.Empty(Exceptions(successful));
    }

    [Theory]
    [InlineData(2)]
    [InlineData(17)]
    public void SourceMessagesAndParameterNamesKeepTheirEvaluationOrder(int seed)
    {
        var probe = new ReferenceGraphProbe(Compiled.Value.Specification);
        var skipped = Run(probe, "Dynamic", null, ("seed", seed), ("skip", true));
        Assert.Equal((decimal)seed, CellValue(skipped));
        Assert.Empty(Exceptions(skipped));

        var output = Run(probe, "Dynamic", null, ("seed", seed), ("skip", false));
        var expected = new ArgumentException("failure:" + (seed + 1), "argument:" + (seed + 11));
        AssertFailure(output, expected, 1);
        Assert.Equal(seed + 11m, CellValue(output));
        var exception = Fields(Assert.Single(Exceptions(output)));
        Assert.True((bool)exception["HasParamName"]);
        Assert.Equal(expected.ParamName, exception["ParamName"]);
    }

    private static Dictionary<string, object> Run(ReferenceGraphProbe probe, string method,
        Dictionary<string, object>? context, params (string Name, object Value)[] values)
    {
        var mapping = Compiled.Value.SourceMap.OfType<JsonObject>().Single(entry => entry["source"]?.ToString()
            .StartsWith("Rules." + method + "(", StringComparison.Ordinal) == true);
        var inputs = values.ToDictionary(value => "Arg_" + value.Name, value => value.Value);
        if (context != null) inputs["AvContextIn"] = context;
        return probe.Run(mapping["implementation"]?.ToString() ?? "AvImpl_" + mapping["native"]!.ToString(), inputs);
    }

    private static void AssertFailure(Dictionary<string, object> output, Exception expected, int index)
    {
        var completion = Fields(output["AvCompletion"]);
        Assert.Equal(2m, completion["Kind"]);
        Assert.Equal((decimal)index, completion["ExceptionRef"]);
        var errors = Exceptions(output);
        Assert.Equal(index, errors.Count);
        var exception = Fields(errors[index - 1]);
        Assert.Equal(expected.GetType().FullName, exception["TypeName"]);
        Assert.Equal(expected.Message, exception["Message"]);
        Assert.True((bool)exception["HasHResult"]);
        Assert.Equal((decimal)expected.HResult, exception["HResult"]);
    }

    private static decimal CellValue(Dictionary<string, object> output)
    {
        var context = Fields(output["AvContextOut"]);
        var cell = Compiled.Value.Specification["data"]!["structures"]!.AsArray().OfType<JsonObject>()
            .Single(structure => structure["name"]!.ToString().StartsWith("AvCell_", StringComparison.Ordinal)
                && structure["attributes"]!.AsArray().Any(field => field!["name"]!.ToString() == "Value"));
        var contextType = Compiled.Value.Specification["data"]!["structures"]!.AsArray().OfType<JsonObject>()
            .Single(structure => structure["attributes"]!.AsArray().Any(field => field!["name"]!.ToString() == "Exceptions"));
        var arena = contextType["attributes"]!.AsArray().Single(field => field!["type"]!.ToString() == cell["name"] + " List")!["name"]!.ToString();
        return (decimal)Fields(Assert.Single(Assert.IsType<List<object>>(context[arena])))["Value"];
    }

    private static List<object> Exceptions(Dictionary<string, object> output) => Assert.IsType<List<object>>(Fields(output["AvContextOut"])["Exceptions"]);
    private static Dictionary<string, object> Fields(object value) => Assert.IsType<Dictionary<string, object>>(value);
}
