using System.Reflection;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Preflight;
using Xunit;

namespace Anvil.Tests;

public sealed class ApplyFixTextTests
{
    private static JsonObject ApplyProblem(string message, bool missingReference = false)
    {
        var failureType = typeof(ModelSession).GetNestedType("ApplyFailure", BindingFlags.NonPublic)!;
        Exception error = missingReference ? new KeyNotFoundException(message) : new InvalidOperationException(message);
        var failure = failureType.GetConstructors(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
            .Single(c => c.GetParameters().Length == 5).Invoke([0, "logic", new JsonObject { ["op"] = "logic" }, error, null]);
        var method = typeof(ModelSession).GetMethod("ApplyProblems", BindingFlags.NonPublic | BindingFlags.Static)!;
        return Assert.Single((IEnumerable<JsonObject>)method.Invoke(null, [failure, "/ops"])!);
    }

    [Theory]
    [InlineData("NAME_COLLISION", "the name collides with an existing element and the Studio renamed it to 'Another2'", false)]
    [InlineData("REFERENCE_UNRESOLVED", "missing reference", true)]
    [InlineData("TYPE_UNRESOLVED", "unknown type: MissingRecord", true)]
    [InlineData("CHILD_NOT_FOUND", "Element has no child #1 of type IAssignNode (has 0)", false)]
    [InlineData("PROPERTY_NOT_WRITABLE", "Element has no writable property or setter 'Size'", false)]
    [InlineData("ENUM_VALUE_INVALID", "Invalid Mode value 'Wrong'; allowed: First, Second", false)]
    public void ApplyAdviceBelongsToTheCodeEvenInsideALogicOp(string code, string message, bool missingReference)
    {
        var problem = ApplyProblem(message, missingReference);
        Assert.Equal(code, problem["code"]!.ToString());
        Assert.NotEmpty(problem["fix"]!.ToString());
        Assert.DoesNotContain("write the step in the logic grammar", problem["fix"]!.ToString());
    }

    [Fact]
    public void ThePlatformCollisionAdviceIsExtractedAndPublishedOnce()
    {
        const string advice = "give it another name (or 'Compute2' explicitly), or use the existing 'Compute' instead of creating it";
        var problem = ApplyProblem("create IServerAction 'Compute' under Module: the name collides with an element of the same name in that scope and the Studio renamed it to 'Compute2'; every expression of this job that names 'Compute' would read the other element. Fix: " + advice);
        Assert.Equal("NAME_COLLISION", problem["code"]!.ToString());
        Assert.Equal(advice, problem["fix"]!.ToString());
        Assert.DoesNotContain("Fix:", problem["message"]!.ToString());
    }

    [Theory]
    [InlineData("NAME_COLLISION")]
    [InlineData("REFERENCE_UNRESOLVED")]
    [InlineData("TYPE_UNRESOLVED")]
    [InlineData("CHILD_NOT_FOUND")]
    [InlineData("PROPERTY_NOT_WRITABLE")]
    [InlineData("ENUM_VALUE_INVALID")]
    public void ACodedErrorCannotKeepAStaleGrammarFallback(string code)
    {
        foreach (var origin in new[] { "logic", "spec", "html", "html-visual", "sql", "data", "verbs" })
        {
            var error = new KernelRefusalException(code, "the named element was refused", new JsonArray(new JsonObject {
                ["code"] = code, ["message"] = "the named element was refused", ["fix"] = JobPreflight.DefaultFix(origin), ["pointer"] = "/item"
            }));
            var problem = Assert.Single(CodedProblems.From(error, 2, "logic", "/ops/2/data")!);
            Assert.Equal(JobPreflight.CodeFix(code), problem["fix"]!.ToString());
            Assert.Equal("/ops/2/data/item", problem["pointer"]!.ToString());
        }
    }

    [Fact]
    public void ACodedErrorKeepsItsSpecificCorrectionButTheInlineAdviceHasPriority()
    {
        const string specific = "rename this action to RecalculateInvoice";
        JsonObject Read(string message) => Assert.Single(CodedProblems.From(new KernelRefusalException("NAME_COLLISION", message,
            new JsonArray(new JsonObject { ["code"] = "NAME_COLLISION", ["message"] = message, ["fix"] = specific })), 0, "logic", "/ops/0/data")!);
        Assert.Equal(specific, Read("the action name is taken")["fix"]!.ToString());
        var explicitAdvice = Read("the action name is taken. Fix: call the existing action instead");
        Assert.Equal("call the existing action instead", explicitAdvice["fix"]!.ToString());
        Assert.DoesNotContain("Fix:", explicitAdvice["message"]!.ToString());
    }

    [Fact]
    public void AnUnknownCodedErrorStillKeepsItsGrammarFallback()
    {
        var fallback = JobPreflight.DefaultFix("logic");
        var error = new KernelRefusalException("CUSTOM_INVALID", "custom rule", new JsonArray(new JsonObject {
            ["code"] = "CUSTOM_INVALID", ["message"] = "custom rule", ["fix"] = fallback
        }));
        Assert.Equal(fallback, Assert.Single(CodedProblems.From(error, 0, "logic", "/ops/0/data")!)["fix"]!.ToString());
    }
}
