using System.Text.Json.Nodes;
using Anvil.CSharp;
using Xunit;

namespace Anvil.CSharp.Tests;

public class DataCompilerTests
{
    private static string Domain => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Cases", "DataModel.cs.txt"));
    private static CompilationResult Compile(string source) => CSharpCompiler.CompileData(new Dictionary<string, string> { ["Domain.cs"] = source });
    private static JsonObject Named(JsonNode array, string name) => array.AsArray().OfType<JsonObject>().Single(o => o["name"]!.ToString() == name);
    [Fact]
    public void RelatedClassesAndCatalogsCompileWithoutSourceOrderingOrNativeInstructions()
    {
        var result = Compile(Domain); var data = result.Specification["data"]!;
        Assert.Equal(3, data["entities"]!.AsArray().Count);
        var unit = Named(data["entities"]!, "Unit");
        Assert.Equal("Person Identifier", Named(unit["attributes"]!, "ManagerId")["type"]!.ToString());
        Assert.Equal("Unit Identifier", Named(Named(data["entities"]!, "Person")["attributes"]!, "UnitId")["type"]!.ToString());
        Assert.Equal(12, Named(unit["attributes"]!, "Code")["length"]!.GetValue<int>());
        Assert.True(Named(unit["attributes"]!, "Code")["mandatory"]!.GetValue<bool>());
        Assert.Equal("[\"UnitId\",\"Sequence\"]", Named(data["entities"]!, "Reading")["indexes"]![0]!["attributes"]!.ToJsonString());
        Assert.Equal("\"C\"", Named(Named(data["entities"]!, "Reading")["attributes"]!, "UnitCode")["default"]!.ToString());
        Assert.Equal("Entities.SampleStage.Received", Named(Named(data["entities"]!, "Reading")["attributes"]!, "Stage")["default"]!.ToString());
        Assert.Equal("False", Named(Named(data["entities"]!, "Reading")["attributes"]!, "Validated")["default"]!.ToString());
    }
    [Fact]
    public void EnumsKeepDeclaredCodesAndRichCatalogsKeepAllTypedValues()
    {
        var data = Compile(Domain).Specification["data"]!;
        var stage = Named(data["static"]!, "SampleStage");
        Assert.Equal(new[] { "10", "40", "90" }, stage["records"]!.AsArray().Select(r => r!["AvValue"]!.ToString()));
        var catalog = Named(data["static"]!, "AnalysisClass");
        var special = Named(catalog["records"]!, "Special");
        Assert.Equal("20", special["Code"]!.ToString()); Assert.Equal("47.25", special["Fee"]!.ToString());
        Assert.Equal("Special analysis", special["label"]!.ToString()); Assert.Equal("True", special["Active"]!.ToString());
        Assert.Equal("False", Named(catalog["records"]!, "Historical")["Active"]!.ToString());
    }
    [Fact]
    public void EnumDefaultsUseTheSameBoundSymbolAsTheNativeCatalog()
    {
        var result=Compile(Domain);
        var expected=result.SourceMap.OfType<JsonObject>().Single(m=>m["source"]?.ToString()=="CaseStage.ready")["native"]!.ToString();
        var unit=Named(result.Specification["data"]!["entities"]!,"Unit");
        Assert.Equal(expected,Named(unit["attributes"]!,"Stage")["default"]!.ToString());
    }
    [Fact]
    public void NullableValuesHavePresenceDistinctFromZeroFalseAndEmptyText()
    {
        var result = Compile(Domain); var reading = Named(result.Specification["data"]!["entities"]!, "Reading");
        foreach (var property in new[] { "Measurement", "Note", "ReviewedAt" })
        {
            var mapping = result.SourceMap.OfType<JsonObject>().Single(x => x["source"]!.ToString() == "Reading." + property);
            var presence = mapping["presence"]!.ToString();
            Assert.Equal("Boolean", Named(reading["attributes"]!, presence)["type"]!.ToString());
            Assert.Equal("False", Named(reading["attributes"]!, presence)["default"]!.ToString());
            Assert.False(Named(reading["attributes"]!, property)["mandatory"]!.GetValue<bool>());
        }
        var order = Named(result.Specification["data"]!["structures"]!, "ReturnOrder");
        Assert.Equal("ReturnItem List", Named(order["attributes"]!, "Items")["type"]!.ToString());
        var note = Named(order["attributes"]!, "Note")["type"]!.ToString();
        var optional = Named(result.Specification["data"]!["structures"]!, note);
        Assert.Equal("Boolean", Named(optional["attributes"]!, "HasValue")["type"]!.ToString());
        Assert.Equal("Text", Named(optional["attributes"]!, "Value")["type"]!.ToString());
    }
    [Fact]
    public void NamespaceAndCaseCollisionsAreTranslatedInsteadOfRequiringNativeNames()
    {
        var result = Compile("namespace A {public record Value(int Amount,int amount);} namespace B {public record Value(string Name);}");
        var types = result.Specification["data"]!["structures"]!.AsArray();
        Assert.Equal(2, types.Count);
        Assert.NotEqual(types[0]!["name"]!.ToString(), types[1]!["name"]!.ToString());
        var fields = types[0]!["attributes"]!.AsArray(); Assert.NotEqual(fields[0]!["name"]!.ToString().ToLowerInvariant(), fields[1]!["name"]!.ToString().ToLowerInvariant());
        Assert.Equal(result.Specification.ToJsonString(), Compile("namespace B {public record Value(string Name);} namespace A {public record Value(int Amount,int amount);}").Specification.ToJsonString());
    }
    [Fact]
    public void TypedCollectionsKeepElementTypesNestingAndOptionalPresence()
    {
        var data = Compile(Domain).Specification["data"]!;
        var fields = Named(data["structures"]!, "ValueLists")["attributes"]!;
        Assert.Equal("Integer List", Named(fields, "Counts")["type"]!.ToString());
        Assert.Equal("Text List", Named(fields, "Names")["type"]!.ToString());
        Assert.Equal("Text List List", Named(fields, "Rows")["type"]!.ToString());
        Assert.Equal("Binary Data", Named(fields, "Bytes")["type"]!.ToString());
        Assert.Equal("AvTemporal_DateOnly", Named(fields, "Day")["type"]!.ToString());
        Assert.Equal("AvTemporal_TimeOnly", Named(fields, "Time")["type"]!.ToString());
        var values = Named(fields, "Measurements")["type"]!.ToString();
        Assert.Equal("Decimal", Named(Named(data["structures"]!, values[..^5])["attributes"]!, "Value")["type"]!.ToString());
        var optional = Named(fields, "OptionalItems")["type"]!.ToString();
        Assert.Equal("ReturnItem List", Named(Named(data["structures"]!, optional)["attributes"]!, "Value")["type"]!.ToString());
    }
    [Fact]
    public void MultiFileBindingIsDeterministicAndCompileErrorsPointToTheSource()
    {
        var files = new Dictionary<string,string> { ["a.cs"]="public record Outer(Inner Child);", ["b.cs"]="public record Inner(string Name);" };
        var first = CSharpCompiler.CompileData(files); var second = CSharpCompiler.CompileData(files.Reverse().ToDictionary(p => p.Key, p => p.Value));
        Assert.Equal(first.SourceHash, second.SourceHash); Assert.Equal(first.Specification.ToJsonString(), second.Specification.ToJsonString());
        var error = Assert.Throws<SourceCompilationException>(() => Compile("public class Bad { public Missing Value {get;set;} }"));
        Assert.Contains(error.Diagnostics, d => d.Code == "CS0246" && d.File == "Domain.cs" && d.Line == 1 && d.Column > 1);
    }
    [Theory]
    [InlineData("[System.Flags] public enum E{A=1,B=2}", "AVCS214")]
    [InlineData("public enum E{A=10,B=10}", "AVCS217")]
    [InlineData("public record Value(double Number);", "AVCS205")]
    [InlineData("public static class Rules { public static int Half(int n)=>n/2; }", "AVCS101")]
    [InlineData("public class Rules { public int Half(int n)=>n/2; }", "AVCS101")]
    [InlineData("public record Reading(int Amount) { public int Doubled => Amount*2; }", "AVCS102")]
    [InlineData("public class Reading { public int Amount {get;set;} public Reading() {Amount=7;} }", "AVCS103")]
    [InlineData("public class Reading { public static int Amount; }", "AVCS104")]
    [InlineData("[Anvil.Authoring.Entity] public class Value {[System.ComponentModel.DataAnnotations.MaxLength(0)] public string Name{get;set;}=\"\";}", "AVCS225")]
    [InlineData("[Anvil.Authoring.Entity] public class Value {public string Name{get;set;}=System.Environment.UserName;}", "AVCS226")]
    public void UnsupportedOrExecutableDeclarationsAreDiagnosedBeforeModelMutation(string source,string code)
        => Assert.Contains(Assert.Throws<SourceCompilationException>(() => Compile(source)).Diagnostics, d => d.Code == code && d.File == "Domain.cs");
}
