using System.Text.Json.Nodes;
using Anvil.Xif;
using Xunit;

namespace Anvil.Tests;

/// <summary>XifSpec: every problem of an extension spec in ONE XIF_SPEC_INVALID, each with its path and exact fix, before
/// anything is generated, compiled or sent.</summary>
public sealed class XifSpecTests
{
    [Fact]
    public void SevenProblemsComeBackInOneRefusalEachWithItsFix()
    {
        var spec = JsonNode.Parse("""
        {
          "name": "ZZHybridXifLab",
          "actions": [
            { "name": "Bad-Name", "outputs": [ { "name": "Value", "type": "Integer" } ], "body": "Value = 1;" },
            { "name": "Add", "inputs": [ { "name": "Items", "type": "Text List" } ], "body": "" , "description": "x" },
            { "name": "add", "body": "return;" },
            { "name": "Parse", "inputs": [ { "name": "Raw", "type": "Foo" } ], "body": "return;" },
            { "name": "Pair", "isFunction": true, "outputs": [ { "name": "A", "type": "Integer" }, { "name": "B", "type": "Integer" } ], "body": "A = 1; B = 2;" },
            { "name": "Fresh", "outputs": [ { "name": "Result", "type": "Text" } ] }
          ],
          "resources": [ { "path": "..\\x", "text": "a", "deploy": "Ignore" } ]
        }
        """);
        // "Add" has an empty body too: keep the seven distinct problems by giving it one.
        spec!["actions"]![1]!["body"] = "Items = null;";
        var refusal = Assert.Throws<XifRefusal>(() => XifSpec.Parse(spec, new XifSpecContext { RequireFiles = false }));
        Assert.Equal(XifCodes.SpecInvalid, refusal.Code);
        var codes = refusal.Problems.Select(p => (p.Code, p.Path)).ToList();
        Assert.Equal(7, refusal.Problems.Count);
        Assert.Contains(("XIF_SPEC_IDENTIFIER", "actions[0].name"), codes);
        Assert.Contains(("XIF_SPEC_PRIMITIVE_LIST", "actions[1].inputs[0].type"), codes);
        Assert.Contains(("XIF_SPEC_DUPLICATE", "actions[2].name"), codes);
        Assert.Contains(("XIF_SPEC_TYPE_UNKNOWN", "actions[3].inputs[0].type"), codes);
        Assert.Contains(("XIF_SPEC_FUNCTION_OUTPUTS", "actions[4].outputs"), codes);
        Assert.Contains(("XIF_SPEC_BODY_REQUIRED", "actions[5].body"), codes);
        Assert.Contains(("XIF_SPEC_RESOURCE_PATH", "resources[0].path"), codes);
        Assert.All(refusal.Problems, p => Assert.False(string.IsNullOrWhiteSpace(p.Fix)));
        Assert.Contains("BadName", refusal.Problems.Single(p => p.Code == "XIF_SPEC_IDENTIFIER").Fix);
        Assert.Contains("TextItem List", refusal.Problems.Single(p => p.Code == "XIF_SPEC_PRIMITIVE_LIST").Fix);
        var json = refusal.ToJson();
        Assert.Equal(7, json["problems"]!.AsArray().Count);
        Assert.False(json["ok"]!.GetValue<bool>());
    }

    [Fact]
    public void AValidSpecIsNormalizedAndAnExistingActionMayKeepItsBody()
    {
        var spec = XifSpec.Parse(JsonNode.Parse("""
        {
          "name": "ZZHybridXifLab",
          "structures": [ { "name": "Pair", "attributes": [ { "name": "Left", "type": "Long Integer" }, { "name": "When", "type": "Date Time", "mandatory": true } ] },
                          { "name": "Bag", "attributes": [ { "name": "Pairs", "type": "Pair List" } ] } ],
          "actions": [
            { "name": "Add", "inputs": [ { "name": "Left", "type": "Integer" }, { "name": "Right", "type": "Integer" } ],
              "outputs": [ { "name": "Result", "type": "Integer" } ], "body": "Result = checked(Left + Right);" },
            { "name": "Echo", "inputs": [ { "name": "Value", "type": "Phone Number", "mandatory": false } ], "outputs": [ { "name": "Out", "type": "Bag" } ] }
          ],
          "resources": [ { "path": "Resources/notes.txt", "text": "hello", "deploy": "binaries" } ],
          "remove": { "actions": [ "Gone" ] }
        }
        """), new XifSpecContext { ExistingActions = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "Echo" }, RequireFiles = false });
        Assert.Equal("LongInteger", spec.Structures[0].Attributes[0].Type);
        Assert.Equal("DateTime", spec.Structures[0].Attributes[1].Type);
        Assert.Equal("Pair List", spec.Structures[1].Attributes[0].Type);
        Assert.Equal("PhoneNumber", spec.Actions[1].Inputs[0].Type);
        Assert.Null(spec.Actions[1].Body);
        Assert.Equal("Resources\\notes.txt", spec.Resources[0].Path);
        Assert.Equal("Binaries", spec.Resources[0].Deploy);
        Assert.Equal(["Gone"], spec.Remove.Actions);
        Assert.Equal("Result = checked(Left + Right);", spec.ToJson()["actions"]![0]!["body"]!.ToString());
    }

    [Fact]
    public void StructuresMustBeDeclaredBeforeUseAndNeverTakeABasicTypeName()
    {
        var refusal = Assert.Throws<XifRefusal>(() => XifSpec.Parse(JsonNode.Parse("""
        { "name": "ZZHybridXifLab",
          "structures": [ { "name": "Outer", "attributes": [ { "name": "Inner", "type": "Inner" } ] },
                          { "name": "Inner", "attributes": [ { "name": "V", "type": "Text" } ] },
                          { "name": "Text", "attributes": [ { "name": "V", "type": "Text" } ] } ],
          "actions": [ { "name": "Run", "body": "return;" } ],
          "references": [ "relative\\Helper.dll" ] }
        """), new XifSpecContext { RequireFiles = false }));
        Assert.Equal(["XIF_SPEC_FORWARD_REFERENCE", "XIF_SPEC_TYPE_COLLISION", "XIF_SPEC_FILE"], refusal.Problems.Select(p => p.Code).ToArray());
        Assert.Contains("Move 'Inner' before 'Outer'", refusal.Problems[0].Fix);
    }

    [Fact]
    public void AnAuthorDllWithoutItsDependenciesIsRefused()
    {
        var dir = Path.Combine(Path.GetTempPath(), "anvil-xif-spec-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            // A synthetic author DLL that references a library nobody provides.
            var dependency = XifCompilerTests.CompileLibrary(dir, "Acme.Core", "namespace Acme { public static class Core { public static int One() { return 1; } } }");
            var helper = XifCompilerTests.CompileLibrary(dir, "Acme.Helper", "namespace Acme { public static class Helper { public static int Two() { return Core.One() + 1; } } }", dependency);
            var spec = JsonNode.Parse($$"""{ "name": "ZZHybridXifLab", "actions": [ { "name": "Run", "body": "return;" } ], "references": [ {{System.Text.Json.JsonSerializer.Serialize(helper)}} ] }""");
            var refusal = Assert.Throws<XifRefusal>(() => XifSpec.Parse(spec, new XifSpecContext { FrameworkAssemblies = () => XifCompiler.FrameworkAssemblyNames(XifCompilerTests.ReferenceAssemblies) }));
            var problem = Assert.Single(refusal.Problems);
            Assert.Equal("XIF_SPEC_REFERENCE_CLOSURE", problem.Code);
            Assert.Contains("Acme.Core", problem.Message);
            Assert.Contains("Acme.Core.dll", problem.Fix);
            // With the dependency listed too, the closure holds.
            var closed = JsonNode.Parse($$"""{ "name": "ZZHybridXifLab", "actions": [ { "name": "Run", "body": "return;" } ], "references": [ {{System.Text.Json.JsonSerializer.Serialize(helper)}}, {{System.Text.Json.JsonSerializer.Serialize(dependency)}} ] }""");
            Assert.Equal(2, XifSpec.Parse(closed, new XifSpecContext { FrameworkAssemblies = () => XifCompiler.FrameworkAssemblyNames(XifCompilerTests.ReferenceAssemblies) }).References.Count);
        }
        finally { Directory.Delete(dir, true); }
    }
}
