using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json.Nodes;
using Xunit;

namespace Anvil.CSharp.Tests;

public sealed class ExceptionControlProtocolTests
{
    [Theory]
    [InlineData("public static class Work { public static bool Run() { Func<int> first = () => 1; var alias = first; return first == alias; } }", "Delegate equality")]
    [InlineData("public static class Work { public static int Run() { Func<int> latest = () => 0; for(int i=0; i<2; i++) { int captured = i; latest = () => captured; } return latest(); } }", "lexical closure frame")]
    public void UnsupportedClosureSemanticsAreDiagnosedBeforeEmittingAContract(string source, string message)
    {
        var error = Assert.Throws<SourceCompilationException>(() => CSharpCompiler.Compile(new Dictionary<string, string> { ["ClosureBoundary.cs"] = source }));
        Assert.Contains(message, error.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("ReturnSnapshot", 10)]
    [InlineData("NormalFinally", 12)]
    [InlineData("TypedCatch", 42)]
    [InlineData("CallerFilterBeforeCalleeFinally", 12345)]
    [InlineData("CapturedScalar", 117)]
    [InlineData("FailingFilterUnwindsOnlyItsHelpers", 123456)]
    [InlineData("FinallyStartsReplacementSearch", 12345)]
    [InlineData("RethrowKeepsCaughtIdentity", 1)]
    [InlineData("RecursiveActivation", 121123)]
    [InlineData("LoopTransfers", 45)]
    [InlineData("ForeachTransfers", 45)]
    [InlineData("SwitchTransfer", 12)]
    [InlineData("LocalFilterCapture", 117)]
    [InlineData("RecursiveLocalFunction", 121123)]
    [InlineData("FilterChangesCatchVariable", 1)]
    [InlineData("DelegateCleanupCapturesCallerScalar", 17117)]
    [InlineData("DelegateFilterFailureCleanup", 123456)]
    public void StructuredNativeProtocolMatchesExplicitClrOutcomes(string name, int expected)
    {
        var files = new Dictionary<string, string> { ["ExceptionProtocol.cs"] = Source };
        var compiled = CSharpCompiler.Compile(files);
        var context = new AssemblyLoadContext("exception-control-" + Guid.NewGuid(), isCollectible: true);
        try
        {
            using var stream = new MemoryStream(); var emitted = SourceProgram.Parse(files).Compilation.Emit(stream);
            Assert.True(emitted.Success, string.Join("\n", emitted.Diagnostics)); stream.Position = 0;
            var assembly = context.LoadFromStream(stream);
            Assert.Equal(expected, assembly.GetType("Rules")!.GetMethod(name)!.Invoke(null, null));
            var implementation = compiled.SourceMap.OfType<JsonObject>().Single(item => item["source"]!.ToString() == "Rules." + name + "()")!["implementation"]!.ToString();
            var result = new ReferenceGraphProbe(compiled.Specification).Run(implementation, new Dictionary<string, object>());
            Assert.Equal((decimal)expected, result["AvResult"]);
            Assert.Equal(1m, ((Dictionary<string, object>)result["AvCompletion"])["Kind"]);
            Assert.Empty((List<object>)((Dictionary<string, object>)result["AvContextOut"])["ActiveRegions"]);
            Assert.Empty(compiled.SourceAbis!);
        }
        finally { context.Unload(); }
    }

    private const string Source = """
        public sealed class State { public int Trace; }
        public static class Rules {
            public static int ReturnSnapshot() { int value = 10; try { return value; } finally { value = 99; } }
            public static int NormalFinally() { int value = 1; try { value += 1; } finally { value += 10; } return value; }
            public static int TypedCatch() { try { throw new InvalidOperationException("held"); } catch(ArgumentException) { return -1; } catch(SystemException) { return 42; } finally { int unused = 1; } }
            private static void FailingCallee(State state) { try { state.Trace = 1; throw new InvalidOperationException("held"); } finally { state.Trace = state.Trace * 10 + 3; } }
            public static int CallerFilterBeforeCalleeFinally() {
                var state = new State();
                try { FailingCallee(state); }
                catch(Exception) when ((state.Trace = state.Trace * 10 + 2) > 0) { state.Trace = state.Trace * 10 + 4; }
                finally { state.Trace = state.Trace * 10 + 5; }
                return state.Trace;
            }
            private static void ThrowSimple() { throw new Exception("held"); }
            public static int CapturedScalar() { int local = 10; try { ThrowSimple(); } catch(Exception) when ((local += 7) > 0) { local += 100; } return local; }
            private static bool BrokenFilter(State state) { state.Trace = state.Trace * 10 + 2; try { throw new ApplicationException("filter"); } finally { state.Trace = state.Trace * 10 + 3; } }
            public static int FailingFilterUnwindsOnlyItsHelpers() {
                var state = new State();
                try { try { state.Trace = 1; throw new Exception("original"); } finally { state.Trace = state.Trace * 10 + 5; } }
                catch(Exception) when (BrokenFilter(state)) { return -1; }
                catch(Exception) when ((state.Trace = state.Trace * 10 + 4) > 0) { state.Trace = state.Trace * 10 + 6; }
                return state.Trace;
            }
            public static int FinallyStartsReplacementSearch() {
                var state = new State();
                try {
                    try { state.Trace = 1; throw new InvalidOperationException("original"); }
                    finally { state.Trace = state.Trace * 10 + 3; throw new ApplicationException("replacement"); }
                }
                catch(InvalidOperationException) when ((state.Trace = state.Trace * 10 + 2) > 0) { return -1; }
                catch(ApplicationException) when ((state.Trace = state.Trace * 10 + 4) > 0) { state.Trace = state.Trace * 10 + 5; }
                return state.Trace;
            }
            public static int RethrowKeepsCaughtIdentity() {
                Exception original = new InvalidOperationException("original");
                try { try { throw original; } catch(Exception variable) { variable = new ArgumentException("replacement"); throw; } }
                catch(Exception caught) { return ReferenceEquals(original, caught) ? 1 : 0; }
            }
            private static int Recursive(State state, int depth) {
                int local = depth * 10;
                try { if(depth == 0) throw new Exception("held"); return Recursive(state, depth - 1); }
                catch(Exception) when ((local += 1) > 0 && depth == 2) { local += 100; return local; }
                finally { state.Trace = state.Trace * 10 + depth; local += 1000; }
            }
            public static int RecursiveActivation() { var state = new State(); int value = Recursive(state, 3); return value * 1000 + state.Trace; }
            public static int LoopTransfers() {
                int sum = 0; int cleanups = 0;
                for(int index = 0; index < 8; index++) {
                    try { if(index == 4) break; if(index % 2 == 0) continue; sum += index; }
                    finally { cleanups++; }
                }
                return sum * 10 + cleanups;
            }
            public static int ForeachTransfers() {
                int sum = 0; int cleanups = 0;
                foreach(int index in new int[] {0,1,2,3,4,5}) {
                    try { if(index == 4) break; if(index % 2 == 0) continue; sum += index; }
                    finally { cleanups++; }
                }
                return sum * 10 + cleanups;
            }
            public static int SwitchTransfer() { int value = 1; switch(value) { case 1: try { value += 10; break; } finally { value += 1; } default: return -1; } return value; }
            public static int LocalFilterCapture() {
                int scalar = 10;
                bool Filter(Exception exception) { scalar += 7; return exception.Message == "held"; }
                try { ThrowSimple(); } catch(Exception exception) when (Filter(exception)) { scalar += 100; }
                return scalar;
            }
            public static int RecursiveLocalFunction() {
                int trace = 0;
                int Recurse(int depth) {
                    int local = depth * 10;
                    bool Filter(Exception exception) { local++; return depth == 2; }
                    try { if(depth == 0) throw new Exception("held"); return Recurse(depth - 1); }
                    catch(Exception exception) when (Filter(exception)) { local += 100; return local; }
                    finally { trace = trace * 10 + depth; local += 1000; }
                }
                int result = Recurse(3); return result * 1000 + trace;
            }
            public static int FilterChangesCatchVariable() {
                Exception original = new Exception("original"); Exception replacement = new Exception("replacement");
                try { try { throw original; } catch(Exception variable) when ((variable = replacement) != null) { if(!ReferenceEquals(variable, replacement)) return -1; throw; } }
                catch(Exception caught) { return ReferenceEquals(caught, original) ? 1 : 0; }
            }
            private static void ThrowWithCleanup(Exception failure, Action cleanup) { try { throw failure; } finally { cleanup(); } }
            public static int DelegateCleanupCapturesCallerScalar() {
                int scalar = 10; int observed = -1;
                bool Filter(Exception failure) { scalar += 7; return true; }
                try { ThrowWithCleanup(new Exception("original"), () => { observed = scalar; scalar += 100; }); }
                catch(Exception failure) when (Filter(failure)) { }
                return observed * 1000 + scalar;
            }
            public static int DelegateFilterFailureCleanup() {
                int trace = 0;
                bool Filter(Exception failure) { trace = trace * 10 + 2; ThrowWithCleanup(new ApplicationException("filter"), () => { trace = trace * 10 + 3; }); return false; }
                try { try { trace = 1; throw new Exception("original"); } finally { trace = trace * 10 + 5; } }
                catch(Exception failure) when (Filter(failure)) { return -1; }
                catch(Exception) when ((trace = trace * 10 + 4) > 0) { trace = trace * 10 + 6; }
                return trace;
            }
        }
        """;
}
