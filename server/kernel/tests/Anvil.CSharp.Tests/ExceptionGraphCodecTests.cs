using Anvil.Authoring.Transport;
using System.Globalization;
using System.Text.Json.Nodes;
using Xunit;

namespace Anvil.CSharp.Tests;

// Independently authored peer messages and observations. This suite exercises SDK data
// transport only; neither a mock peer nor CLR construction certifies native lowering.
public class ExceptionGraphCodecTests
{
    private static readonly GraphException ExceptionShape = new(typeof(Exception));
    private static readonly GraphReference StateShape = new("State");
    private static readonly GraphDefinition[] Definitions = [new("State", typeof(State), [
        new("Value", typeof(State).GetField("Value")!, new GraphScalar(typeof(int))),
        new("Failure", typeof(State).GetField("Failure")!, ExceptionShape),
        new("Other", typeof(State).GetField("Other")!, ExceptionShape),
        new("Next", typeof(State).GetField("Next")!, StateShape)])];
    private static JsonObject Handle(int index) => new() { ["Index"] = index };
    private static JsonObject Payload(string type = "System.InvalidOperationException", string message = "failure", int inner = 0,
        string? param = null, object? actual = null, int hresult = -2146233079) => new() {
        ["TypeName"] = type, ["Message"] = message, ["ParamName"] = param ?? "", ["HasParamName"] = param != null,
        ["InnerRef"] = inner, ["HasHResult"] = true, ["HResult"] = hresult, ["HasActualValue"] = actual != null,
        ["ActualValueType"] = actual switch { int => "System.Int32", long => "System.Int64", bool => "System.Boolean", string => "System.String", _ => "" },
        ["ActualValueInteger"] = actual is int i ? i : 0, ["ActualValueLong"] = actual is long l ? l : 0L,
        ["ActualValueText"] = actual as string ?? "", ["ActualValueBoolean"] = actual is bool b && b
    };
    private static JsonObject StateCell(int value, int failure, int other = 0, int next = 0) => new() {
        ["Value"] = value, ["Failure"] = Handle(failure), ["Other"] = Handle(other), ["Next"] = Handle(next)
    };
    private static JsonObject Reply(JsonObject arenas, int failure = 0, JsonNode? result = null) {
        var reply = new JsonObject { ["AvGraphAbiOut"] = 3, ["AvGraphOut"] = arenas,
            ["AvCompletion"] = new JsonObject { ["Kind"] = failure == 0 ? 1 : 2, ["ExceptionRef"] = failure } };
        if (result != null) reply["AvResult"] = result;
        return reply;
    }
    private static object? Call(State state, Func<JsonObject, JsonObject> peer, bool result = false) =>
        new ReferenceGraphCall("Observe", ["Arg_state"], [StateShape], result ? [ExceptionShape] : [], Definitions, 3)
            .Invoke([state], (_, request) => peer(request));
    private static object? Materialize(JsonObject payload, Type? declared = null) =>
        new ReferenceGraphCall("Create", [], [], [new GraphException(declared ?? typeof(Exception))], [], 3)
            .Invoke([], (_, _) => Reply(new() { ["Exceptions"] = new JsonArray(payload) }, result: Handle(1)));

    [Theory]
    [InlineData("System.Exception", -2146233088)]
    [InlineData("System.SystemException", -2146233087)]
    [InlineData("System.ApplicationException", -2146232832)]
    [InlineData("System.ArgumentException", -2147024809)]
    [InlineData("System.ArgumentNullException", -2147467261)]
    [InlineData("System.ArgumentOutOfRangeException", -2146233086)]
    [InlineData("System.InvalidOperationException", -2146233079)]
    [InlineData("System.NullReferenceException", -2147467261)]
    [InlineData("System.IndexOutOfRangeException", -2146233080)]
    [InlineData("System.OverflowException", -2146233066)]
    [InlineData("System.DivideByZeroException", -2147352558)]
    [InlineData("System.NotSupportedException", -2146233067)]
    [InlineData("System.InvalidCastException", -2147467262)]
    [InlineData("System.FormatException", -2146233033)]
    public void FourteenExactBclTypesMaterializeWithIndependentPayloadExpectations(string name, int hresult)
    {
        var result = Assert.IsAssignableFrom<Exception>(Materialize(Payload(name, "observed", hresult: hresult)));
        Assert.Equal(name, result.GetType().FullName); Assert.Equal("observed", result.Message);
        Assert.Equal(hresult, result.HResult); Assert.Null(result.InnerException);
    }

    [Fact]
    public void InputArgumentStateAndThrownCompletionShareTheSameObjectAfterWriteback()
    {
        var inner = new FormatException("inner"); var original = new InvalidOperationException("original", inner);
        var state = new State { Value = 5, Failure = original }; state.Next = state;
        var call = new ReferenceGraphCall("Observe", ["State", "Error"], [StateShape, ExceptionShape], [], Definitions, 3);
        var thrown = Assert.Throws<InvalidOperationException>(() => call.Invoke([state, original], (_, request) => {
            Assert.Equal(3, request["AvGraphAbiIn"]!.GetValue<int>());
            Assert.Equal(1, request["Error"]!["Index"]!.GetValue<int>());
            var arenas = request["AvGraphIn"]!.DeepClone().AsObject();
            Assert.Equal(2, arenas["Exceptions"]!.AsArray().Count);
            arenas["State"]![0]!["Value"] = 41;
            return Reply(arenas, 1);
        }));
        Assert.Same(original, thrown); Assert.Same(original, state.Failure);
        Assert.Same(inner, thrown.InnerException); Assert.Equal(41, state.Value); Assert.Same(state, state.Next);
    }

    [Fact]
    public void NewForwardReferencesShareOneInnerAndFailureIsAReachabilityRoot()
    {
        var state = new State { Value = 3 };
        var thrown = Assert.Throws<InvalidOperationException>(() => Call(state, _ => Reply(new() {
            ["State"] = new JsonArray(StateCell(9, 1, 2, 2), StateCell(7, 2, 1, 1)),
            ["Exceptions"] = new JsonArray(Payload(inner: 3), Payload("System.ArgumentException", "second (Parameter 'p')", 3, "p", hresult: -2147024809),
                Payload("System.FormatException", "shared", hresult: -2146233033))
        }, 1)));
        Assert.Same(thrown, state.Failure); Assert.Same(thrown.InnerException, state.Other!.InnerException);
        Assert.Equal("shared", thrown.InnerException!.Message); Assert.Equal("p", Assert.IsType<ArgumentException>(state.Other).ParamName);
        Assert.Equal(9, state.Value); Assert.Equal(7, state.Next!.Value); Assert.Same(state, state.Next.Next);
        Assert.Same(state.Other, state.Next.Failure);
    }

    [Fact]
    public void FailureOnlyGraphIsExportedAndThrownWithoutAResultRoot()
    {
        var call = new ReferenceGraphCall("Fail", [], [], [ExceptionShape], [], 3);
        var failure = Assert.Throws<InvalidOperationException>(() => call.Invoke([], (_, _) =>
            Reply(new() { ["Exceptions"] = new JsonArray(Payload(inner: 2), Payload("System.Exception", "inner", hresult: -2146233088)) }, 1, Handle(0))));
        Assert.Equal("failure", failure.Message); Assert.Equal("inner", failure.InnerException!.Message);
    }

    [Fact]
    public void ResultStateAndPolymorphicArgumentPreserveIdentityIncludingNull()
    {
        var original = new ArgumentNullException("p", "missing"); var state = new State { Failure = original };
        var result = Call(state, request => Reply(request["AvGraphIn"]!.DeepClone().AsObject(), result: Handle(1)), true);
        Assert.Same(original, result);
        var session = new ReferenceGraphSession([], 3); var wire = new ReferenceGraphWire([], 3);
        var graph = session.Encode([ExceptionShape, new GraphException(typeof(ArgumentException))], [null, original]);
        var roots = wire.EncodeRoots(graph, [ExceptionShape, new GraphException(typeof(ArgumentException))]);
        Assert.Equal(0, roots[0]!["Index"]!.GetValue<int>());
        var values = session.Reconcile(wire.Decode(wire.EncodeArenas(graph), roots, [ExceptionShape, new GraphException(typeof(ArgumentException))]),
            [ExceptionShape, new GraphException(typeof(ArgumentException))]);
        Assert.Null(values[0]); Assert.Same(original, values[1]);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("size")]
    public void ParameterNullEmptyAndSuffixInOriginalMessageRemainDistinct(string? param)
    {
        using var culture = new CultureScope("en-US");
        var message = "already (Parameter 'size')" + (string.IsNullOrEmpty(param) ? "" : " (Parameter 'size')");
        var result = Assert.IsType<ArgumentException>(Materialize(Payload("System.ArgumentException", message, param: param, hresult: -2147024809)));
        Assert.Equal(param, result.ParamName); Assert.Equal(message, result.Message);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-4)]
    [InlineData(long.MaxValue)]
    [InlineData(false)]
    [InlineData(true)]
    [InlineData("")]
    [InlineData("é😀")]
    public void ActualValueKeepsExactScalarTypeAndBclSuffix(object actual)
    {
        using var culture = new CultureScope("en-US");
        var text = actual switch { false => "False", true => "True", long => "9223372036854775807", _ => Convert.ToString(actual, CultureInfo.InvariantCulture) };
        var message = "outside (Parameter 'size')" + Environment.NewLine + "Actual value was " + text + ".";
        var result = Assert.IsType<ArgumentOutOfRangeException>(Materialize(Payload("System.ArgumentOutOfRangeException", message, param: "size", actual: actual, hresult: -2146233086)));
        Assert.Equal(actual.GetType(), result.ActualValue!.GetType()); Assert.Equal(actual, result.ActualValue);
        Assert.Equal(message, result.Message); Assert.Equal("size", result.ParamName);
    }

    [Theory]
    [InlineData("en-US")]
    [InlineData("pt-BR")]
    [InlineData("tr-TR")]
    public void RenderedPayloadMatchesIndependentClrOracleAcrossCultures(string cultureName)
    {
        using var culture = new CultureScope(cultureName);
        var oracle = new ArgumentOutOfRangeException("n", -42L, "observed");
        var encoded = new ReferenceGraphSession([], 3).Encode([ExceptionShape], [oracle]);
        var wire = new ReferenceGraphWire([], 3); var arena = wire.EncodeArenas(encoded);
        var payload = arena["Exceptions"]![0]!.DeepClone().AsObject();
        Assert.Equal(oracle.Message, payload["Message"]!.GetValue<string>());
        var result = Assert.IsType<ArgumentOutOfRangeException>(Materialize(payload));
        Assert.Equal(oracle.Message, result.Message); Assert.Equal(-42L, result.ActualValue);
    }

    [Theory]
    [InlineData("innerCycle")]
    [InlineData("forwardCycle")]
    [InlineData("innerBounds")]
    [InlineData("missingSuffix")]
    [InlineData("badHResult")]
    [InlineData("wrongParamType")]
    [InlineData("impossibleNullInner")]
    [InlineData("impossibleActualInner")]
    [InlineData("unknownType")]
    [InlineData("unknownProperty")]
    [InlineData("wrongScalar")]
    [InlineData("unknownActualType")]
    [InlineData("inactiveActualSlot")]
    [InlineData("absentHResult")]
    [InlineData("unreachable")]
    public void InvalidExceptionRepliesNeverPartiallyWriteBack(string invalid)
    {
        var state = new State { Value = 7 };
        var payload = Payload(); var errors = new JsonArray(payload);
        switch (invalid) {
            case "innerCycle": payload["InnerRef"] = 1; break;
            case "forwardCycle": payload["InnerRef"] = 2; errors.Add(Payload(inner: 1)); break;
            case "innerBounds": payload["InnerRef"] = 99; break;
            case "missingSuffix": payload = Payload("System.ArgumentException", "missing suffix", param: "x", hresult: -2147024809); errors[0] = payload; break;
            case "badHResult": payload["HResult"] = 123; break;
            case "wrongParamType": payload["HasParamName"] = true; payload["ParamName"] = "x"; break;
            case "impossibleNullInner": errors[0] = Payload("System.ArgumentNullException", "failure (Parameter 'x')", 2, "x", hresult: -2147467261); errors.Add(Payload()); break;
            case "impossibleActualInner": errors[0] = Payload("System.ArgumentOutOfRangeException", "failure", 2, actual: 42, hresult: -2146233086); errors.Add(Payload()); break;
            case "unknownType": payload["TypeName"] = "Example.CustomException"; break;
            case "unknownProperty": payload["Executable"] = "do not execute"; break;
            case "wrongScalar": payload["InnerRef"] = "1"; break;
            case "unknownActualType": payload["ActualValueType"] = "System.Double"; payload["HasActualValue"] = true; break;
            case "inactiveActualSlot": payload["ActualValueLong"] = 8; break;
            case "absentHResult": payload["HasHResult"] = false; break;
            case "unreachable": errors.Add(Payload()); break;
        }
        Assert.Throws<InvalidDataException>(() => Call(state, _ => Reply(new() { ["State"] = new JsonArray(StateCell(99, 1)), ["Exceptions"] = errors })));
        Assert.Equal(7, state.Value); Assert.Null(state.Failure);
    }

    [Theory]
    [InlineData("TypeName")]
    [InlineData("Message")]
    [InlineData("InnerRef")]
    [InlineData("HResult")]
    public void ExistingExceptionPayloadCannotBeReplacedOrMutated(string field)
    {
        var original = new InvalidOperationException("same"); var state = new State { Value = 7, Failure = original };
        Assert.Throws<InvalidDataException>(() => Call(state, request => {
            var arenas = request["AvGraphIn"]!.DeepClone().AsObject(); arenas["State"]![0]!["Value"] = 99;
            var error = arenas["Exceptions"]![0]!;
            if (field == "TypeName") error[field] = "System.Exception";
            else if (field == "Message") error[field] = "changed";
            else error[field] = 1;
            return Reply(arenas);
        }));
        Assert.Equal(7, state.Value); Assert.Same(original, state.Failure); Assert.Equal("same", original.Message);
    }

    [Theory]
    [InlineData("version")]
    [InlineData("nonzeroSuccess")]
    [InlineData("zeroFailure")]
    [InlineData("unknownCompletion")]
    [InlineData("unknownResponse")]
    [InlineData("AvErrors")]
    [InlineData("resultOnFailure")]
    public void CompletionAndNegotiationValidateBeforeCallerMutation(string invalid)
    {
        var state = new State { Value = 7 };
        Assert.Throws<InvalidDataException>(() => Call(state, _ => {
            var response = Reply(new() { ["State"] = new JsonArray(StateCell(99, 1)), ["Exceptions"] = new JsonArray(Payload()) }, result: Handle(1));
            switch (invalid) {
                case "version": response["AvGraphAbiOut"] = 2; break;
                case "nonzeroSuccess": response["AvCompletion"]!["ExceptionRef"] = 1; break;
                case "zeroFailure": response["AvCompletion"]!["Kind"] = 2; break;
                case "unknownCompletion": response["AvCompletion"]!["Extra"] = 1; break;
                case "unknownResponse": response["Extra"] = 1; break;
                case "AvErrors": response["AvErrors"] = new JsonArray(); break;
                case "resultOnFailure": response["AvCompletion"]!["Kind"] = 2; response["AvCompletion"]!["ExceptionRef"] = 1; break;
            }
            return response;
        }, true));
        Assert.Equal(7, state.Value); Assert.Null(state.Failure);
    }

    [Fact]
    public void DeclaredDerivedTypeRejectsIncompatibleRuntimeException()
    {
        Assert.Throws<InvalidDataException>(() => Materialize(Payload(), typeof(ArgumentException)));
        var session = new ReferenceGraphSession([], 3);
        Assert.Throws<ArgumentException>(() => session.Encode([new GraphException(typeof(ArgumentException))], [new InvalidOperationException()]));
    }

    [Fact]
    public void CustomExceptionAndActualValueDoNotInvokeUserGettersOrToString()
    {
        DangerousValue.Calls = 0; CustomException.Calls = 0;
        Assert.Throws<InvalidDataException>(() => new ReferenceGraphSession([], 3).Encode([ExceptionShape], [new CustomException()]));
        Assert.Throws<InvalidDataException>(() => new ReferenceGraphSession([], 3).Encode([ExceptionShape], [new ArgumentOutOfRangeException("p", new DangerousValue(), "test")]));
        Assert.Equal(0, DangerousValue.Calls); Assert.Equal(0, CustomException.Calls);
    }

    [Fact]
    public void ExceptionListsArraysAndInlineValuesShareCanonicalIdentity()
    {
        var shape = new GraphReference("Errors"); var array = new GraphReference("Array");
        var definitions = new GraphDefinition[] { new("Errors", typeof(List<Exception>), [], ExceptionShape), new("Array", typeof(Exception[]), [], ExceptionShape) };
        var inner = new Exception("inner"); var outer = new InvalidOperationException("outer", inner);
        var list = new List<Exception> { outer, inner, outer, null! }; var items = new Exception[] { outer, inner };
        var session = new ReferenceGraphSession(definitions, 3); var wire = new ReferenceGraphWire(definitions, 3);
        var record = new GraphInline(typeof(Inline), [new("Failure", typeof(Inline).GetField("Failure")!, ExceptionShape)]);
        GraphShape[] shapes = [shape, array, record]; var graph = session.Encode(shapes, [list, items, new Inline { Failure = outer }]);
        var decoded = wire.Decode(wire.EncodeArenas(graph), wire.EncodeRoots(graph, shapes), shapes);
        var result = session.Reconcile(decoded, shapes);
        Assert.Same(list, result[0]); Assert.Same(items, result[1]); Assert.Same(outer, Assert.IsType<Inline>(result[2]).Failure);
        Assert.Same(outer, list[0]); Assert.Same(outer, list[2]); Assert.Null(list[3]); Assert.Same(inner, outer.InnerException);
    }

    [Fact]
    public void LongForwardInnerChainIsIterative()
    {
        const int count = 5000;
        var session = new ReferenceGraphSession([], 3); session.Encode([], []);
        var cells = Enumerable.Range(1, count).Select(index => (object)new GraphExceptionRecord("System.Exception", "node", null, null, -2146233088, index == count ? 0 : index + 1)).ToArray();
        var result = session.Reconcile(new(new Dictionary<string, IReadOnlyList<object>> { ["Exceptions"] = cells }, []), [], new("Exceptions", 1));
        var length = 0; for (var error = result.Failure; error != null; error = error.InnerException) length++;
        Assert.Equal(count, length);
    }

    [Fact]
    public void InvalidNewExceptionLeavesInputListAndItsExistingEnumeratorUntouched()
    {
        var original = new Exception("input"); var list = new List<Exception> { original };
        var enumerator = list.GetEnumerator(); var capacity = list.Capacity;
        var definition = new GraphDefinition("Errors", typeof(List<Exception>), [], ExceptionShape);
        var call = new ReferenceGraphCall("Mutate", ["Errors"], [new GraphReference("Errors")], [], [definition], 3);
        Assert.Throws<InvalidDataException>(() => call.Invoke([list], (_, request) => {
            var arenas = request["AvGraphIn"]!.DeepClone().AsObject();
            arenas["Exceptions"]!.AsArray().Add(Payload(hresult: 7));
            var sequence = arenas["Errors"]![0]!;
            sequence["Items"]!.AsArray().Add(Handle(2));
            sequence["Version"] = sequence["Version"]!.GetValue<int>() + 1;
            return Reply(arenas);
        }));
        Assert.Same(original, Assert.Single(list)); Assert.Equal(capacity, list.Capacity);
        Assert.True(enumerator.MoveNext()); Assert.Same(original, enumerator.Current); Assert.False(enumerator.MoveNext());
    }

    public sealed class State { public int Value; public Exception? Failure; public Exception? Other; public State? Next; }
    public struct Inline { public Exception? Failure; }
    public sealed class CustomException : Exception { public static int Calls; public override string Message { get { Calls++; throw new Exception("must not run"); } } }
    public sealed class DangerousValue { public static int Calls; public override string ToString() { Calls++; throw new Exception("must not run"); } }
    private sealed class CultureScope : IDisposable
    {
        private readonly CultureInfo culture = CultureInfo.CurrentCulture, ui = CultureInfo.CurrentUICulture;
        public CultureScope(string name) { CultureInfo.CurrentCulture = new(name); CultureInfo.CurrentUICulture = new(name); }
        public void Dispose() { CultureInfo.CurrentCulture = culture; CultureInfo.CurrentUICulture = ui; }
    }
}
