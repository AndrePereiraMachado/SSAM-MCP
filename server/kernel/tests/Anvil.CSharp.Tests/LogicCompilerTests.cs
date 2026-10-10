using System.Text.Json.Nodes;
using Anvil.CSharp;
using Xunit;

namespace Anvil.CSharp.Tests;

public class LogicCompilerTests
{
    private static string Source => File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"Cases","LogicBasics.cs.txt"));
    private static CompilationResult Compile(string source) => CSharpCompiler.Compile(new Dictionary<string,string> { ["Rules.cs"] = source });
    [Fact]
    public void EnumsHaveNumericSourceValuesAndSeparateNativeCatalogForeignKeys()
    {
        const string source = """
            public enum State : short { First = 10, Last = 90 }
            [Anvil.Authoring.Entity] public record Entry(Anvil.Authoring.Id<Entry> Id, State State);
            public static class EnumRules {
                public static State Convert(int value) => unchecked((State)value);
                public static State Unknown() => (State)42;
                public static int Code(State value) => (int)value;
            }
            """;
        var specification = Compile(source).Specification;
        var stored = specification["data"]!["entities"]![0]!["attributes"]!.AsArray().Single(a=>a!["name"]!.ToString()=="State")!;
        Assert.Equal("State Identifier", stored["type"]!.ToString());
        foreach (var action in specification["logic"]!["actions"]!.AsArray())
            Assert.Equal("Integer", action!["outputs"]![0]!["type"]!.ToString());
        Assert.DoesNotContain("Entities.State", specification["logic"]!.ToJsonString());
        Assert.Throws<SourceCompilationException>(()=>Compile("public enum Key {A=1} [Anvil.Authoring.Entity] public record Bad(Key Id);"));
    }
    [Fact]
    public void IndependentBodyFailuresAreReportedTogetherWithoutReturningAPartialContract()
    {
        const string source = """
            public static class UnsupportedEffects
            {
                public static string Host() => System.Environment.UserName;
                public static string Read() => System.IO.File.ReadAllText("not executed");
            }
            """;
        var error=Assert.Throws<SourceCompilationException>(()=>Compile(source));
        Assert.Equal(new[] {3,4},error.Diagnostics.Select(d=>d.Line));
        Assert.All(error.Diagnostics,d=>Assert.Equal("AVCS310",d.Code));
    }
    [Fact]
    public void IndependentSignatureFailuresAreReportedInOneCompilation()
    {
        const string source = """
            public static class UnsupportedSignatures
            {
                public static T Identity<T>(T value) => value;
                public static void Increment(ref int value) { value++; }
            }
            """;
        var error=Assert.Throws<SourceCompilationException>(()=>Compile(source));
        Assert.Equal(new[] {"AVCS301","AVCS303"},error.Diagnostics.Select(d=>d.Code));
    }
    [Fact]
    public void NullableReferenceMembersPreserveDereferenceExceptionsAndActualPropertyNames()
    {
        var source=File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"Cases","NullableMembers.cs.txt"));
        var result=Compile(source);
        Assert.Contains(result.Specification["exceptions"]!.AsArray(),e=>e!["name"]!.ToString()=="NullReferenceException");
        Assert.DoesNotContain(result.Specification["exceptions"]!.AsArray(),e=>e!["name"]!.ToString()=="InvalidOperationException");
        var value=result.Specification["logic"]!["actions"]!.AsArray().Single(a=>a!["name"]!.ToString()=="ReadValue")!.ToJsonString();
        Assert.Contains("Arg_input.Value.Value",value);
        var presence=result.Specification["logic"]!["actions"]!.AsArray().Single(a=>a!["name"]!.ToString()=="ReadHasValue")!.ToJsonString();
        Assert.Contains("Arg_input.Value.HasValue",presence);
    }
    [Fact]
    public void SourceActionsBindForwardCallsOverloadsRolesAndTypedReturns()
    {
        var result = Compile(Source); var actions = result.Specification["logic"]!["actions"]!.AsArray().OfType<JsonObject>().ToArray();
        var decimalHelpers=actions.Count(action=>action["description"]?.ToString()=="C# decimal arithmetic; isolated native overflow boundary.");
        Assert.Equal(40+decimalHelpers,actions.Length); // 39 authored methods, one service implementation and shared arithmetic intrinsics.
        Assert.Equal("service",actions.Single(a=>a["name"]!.ToString()=="MakeQuote")["kind"]!.ToString());
        Assert.Equal("Quote",actions.Single(a=>a["name"]!.ToString()=="MakeQuote")["outputs"]![0]!["type"]!.ToString());
        Assert.Contains(result.Specification["roles"]!.AsArray(),r=>r!["name"]!.ToString()=="Supervisor");
        Assert.Equal(2,actions.Count(a=>a["name"]!.ToString().StartsWith("Amount_",StringComparison.Ordinal)));
        Assert.All(actions.Where(a=>a["public"]!.GetValue<bool>()),a=>Assert.True(a["access"]!["authenticated"]!.GetValue<bool>()));
        Assert.Equal(result.Specification.ToJsonString(),Compile(Source).Specification.ToJsonString());
    }
    [Theory]
    [InlineData("public static class R { public static int Value(ref int x)=>++x; }", "AVCS303")]
    [InlineData("public static class R { public static long Product(long a,long b)=>a*b; }", "AVCS310")]
    [InlineData("public static class R { public static string User()=>System.Environment.UserName; }", "AVCS310")]
    [InlineData("public class Item {public int Quantity{get;set;}} public static class R { public static int Mutate(Item input){var alias=input;alias.Quantity++;return input.Quantity;} }", "AVCS310")]
    [InlineData("public static class R {public static int Mutate(int[] input){var alias=input;alias[0]++;return input[0];}}", "AVCS310")]
    public void UntranslatedSemanticsHaveSourceDiagnostics(string source,string code)
        => Assert.Contains(Assert.Throws<SourceCompilationException>(()=>Compile(source)).Diagnostics,d=>d.Code==code && d.File=="Rules.cs");
    [Fact]
    public void NarrowCompoundDivisionWrapsAfterPromotedArithmetic()
    {
        const string source="public static class Narrow { public static short Divide(short a,short b){unchecked {a/=b;} return a;} }";
        var compiled=Compile(source);
        Assert.DoesNotContain(compiled.Specification["exceptions"]!.AsArray(),e=>e!["name"]!.ToString()=="OverflowException");
        using var stream=new MemoryStream();var reference=SourceProgram.Parse(new Dictionary<string,string> {["Narrow.cs"]=source}).Compilation.Emit(stream);
        Assert.True(reference.Success);stream.Position=0;
        var context=new System.Runtime.Loader.AssemblyLoadContext("NarrowReference",isCollectible:true);
        try
        {
            var type=context.LoadFromStream(stream).GetType("Narrow")!;
            Assert.Equal(short.MinValue,type.GetMethod("Divide")!.Invoke(null,new object[]{short.MinValue,(short)-1}));
        }
        finally {context.Unload();}
    }
}
