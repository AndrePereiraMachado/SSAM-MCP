using System.Reflection;
using System.Text.Json.Nodes;
using Xunit;

namespace Anvil.CSharp.Tests;

public sealed class ManagedDecimalTests
{
    private const string Source = """
        using System;
        public sealed class BalanceCell { public decimal Value; public int Trace; public Exception? Error; }
        public static class Rules {
            public static decimal Add(BalanceCell state, decimal amount) { state.Trace++; return state.Value + amount; }
            public static decimal Subtract(BalanceCell state, decimal amount) { state.Trace++; return state.Value - amount; }
            public static decimal Multiply(BalanceCell state, decimal amount) { state.Trace++; return state.Value * amount; }
            public static decimal Divide(BalanceCell state, decimal amount) { state.Trace++; return state.Value / amount; }
            public static decimal Remainder(BalanceCell state, decimal amount) { state.Trace++; return state.Value % amount; }
            public static decimal Recover(BalanceCell state, decimal amount) {
                try { state.Trace = state.Trace * 10 + 1; state.Value = state.Value * amount; return state.Value; }
                catch (OverflowException error) { state.Error = error; state.Trace = state.Trace * 10 + 2; return 17m; }
                finally { state.Trace = state.Trace * 10 + 3; }
            }
            public static decimal CallerFilter(BalanceCell state, decimal amount) {
                try { return Inner(state, amount); }
                catch (OverflowException error) when (Filter(state, error)) { return 19m; }
            }
            private static decimal Inner(BalanceCell state, decimal amount) {
                try { state.Trace = 1; return state.Value + amount; }
                finally { state.Trace = state.Trace * 10 + 3; }
            }
            private static bool Filter(BalanceCell state, Exception error) {
                state.Error = error; state.Trace = state.Trace * 10 + 2; return true;
            }
            public static decimal EvaluateOnce(BalanceCell state, decimal amount) => Left(state) / Right(state, amount);
            private static decimal Left(BalanceCell state) { state.Trace = state.Trace * 10 + 1; return state.Value; }
            private static decimal Right(BalanceCell state, decimal amount) { state.Trace = state.Trace * 10 + 2; return amount; }
        }
        """;

    public static IEnumerable<object[]> Cases()
    {
        yield return ["Add", 1.250m, 2.750m];
        yield return ["Subtract", 10m, 13.125m];
        yield return ["Multiply", 79228162514264337593543950335m, 0.1m];
        yield return ["Divide", 1m, 3m];
        yield return ["Remainder", -11.50m, 3m];
        yield return ["Add", decimal.MaxValue, 1m];
        yield return ["Subtract", decimal.MinValue, 1m];
        yield return ["Multiply", decimal.MaxValue, 2m];
        yield return ["Divide", decimal.MaxValue, 0.1m];
        yield return ["Divide", 1m, 0m];
        yield return ["Remainder", 1m, 0m];
        yield return ["Recover", decimal.MaxValue, 2m];
        yield return ["Recover", 2.5m, 4m];
        yield return ["CallerFilter", decimal.MaxValue, 1m];
        yield return ["EvaluateOnce", 10m, 2m];
        yield return ["EvaluateOnce", 10m, 0m];
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void NativeDecimalBoundaryMatchesClrAndSearchesBeforeCallerFinally(string method, decimal value, decimal amount)
    {
        using var call = new ReferencePublicGraphTests.Call(Source, method);
        var state = call.New("BalanceCell"); var oracle = call.New("BalanceCell");
        Set(state, "Value", value); Set(oracle, "Value", value);
        var reflected = oracle.GetType().Assembly.GetType("Rules")!.GetMethod(method)!;
        var expected = Observe(() => {
            try { return reflected.Invoke(null, [oracle, amount]); }
            catch (TargetInvocationException error) { throw error.InnerException!; }
        });
        var actual = Observe(() => call.Invoke(state, amount));
        Assert.Equal(expected.Result, actual.Result);
        Assert.Equal(expected.Error?.GetType(), actual.Error?.GetType());
        Assert.Equal(expected.Error?.Message, actual.Error?.Message);
        Assert.Equal(expected.Error?.HResult, actual.Error?.HResult);
        Assert.Equal(Get(oracle, "Value"), Get(state, "Value"));
        Assert.Equal(Get(oracle, "Trace"), Get(state, "Trace"));
        var expectedStored = Get(oracle, "Error") as Exception; var actualStored = Get(state, "Error") as Exception;
        Assert.Equal(expectedStored?.GetType(), actualStored?.GetType());
        Assert.Equal(expectedStored?.Message, actualStored?.Message);
        if (method == "CallerFilter") Assert.Equal(123, Get(state, "Trace"));
        if (method == "EvaluateOnce") Assert.Equal(12, Get(state, "Trace"));
    }

    [Fact]
    public void ScalarBusinessActionUsesTheNormalPublicCompilerWithoutAGraphFlag()
    {
        const string source = "using System; public static class Rules { public static decimal Recover(decimal amount) { try { return amount * 2m; } catch(OverflowException) { return 17m; } } }";
        var compiled = CSharpCompiler.Compile(new Dictionary<string, string> { ["Business.cs"] = source });
        Assert.Empty(compiled.SourceAbis!);
        var probe = new ReferenceGraphProbe(compiled.Specification);
        Assert.Equal(8m, probe.Run("Recover", new Dictionary<string, object> { ["Arg_amount"] = 4m })["AvResult"]);
        Assert.Equal(17m, probe.Run("Recover", new Dictionary<string, object> { ["Arg_amount"] = decimal.MaxValue })["AvResult"]);
    }

    [Fact]
    public void OnlyThePrimitiveHasANativeHandlerAndTheCallerOwnsSourceFailureSearch()
    {
        var compiled = CSharpCompiler.CompileReferenceGraph(new Dictionary<string, string> { ["Decimal.cs"] = Source });
        var actions = compiled.Specification["logic"]!["actions"]!.AsArray().OfType<JsonObject>().ToArray();
        var primitives = actions.Where(a => a["outputs"]!.AsArray().Any(p => p!["name"]!.ToString() == "AvOverflow")).ToArray();
        Assert.Equal(5, primitives.Length);
        Assert.All(primitives, primitive => {
            Assert.Single(primitive["steps"]!.AsArray());
            var handler = Assert.Single(primitive["handlers"]!.AsArray())!;
            Assert.False(handler["abortTransaction"]!.GetValue<bool>());
            Assert.Equal("True", handler["steps"]![0]!["assign"]!["AvOverflow"]!.ToString());
            Assert.DoesNotContain("AvContext", primitive.ToJsonString());
        });
        Assert.All(actions.Where(a => !primitives.Contains(a)), action => Assert.False(action.ContainsKey("handlers")));
        Assert.Empty(compiled.RequiredIntrinsics!);
    }

    private static (object? Result, Exception? Error) Observe(Func<object?> call)
    { try { return (call(), null); } catch (Exception error) { return (null, error); } }
    private static void Set(object value, string field, object data) => value.GetType().GetField(field)!.SetValue(value, data);
    private static object? Get(object value, string field) => value.GetType().GetField(field)!.GetValue(value);
}
