using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// F7 (25/10/2026): GenerateGuid() is a built-in of ODC and not of Service Studio 11: the registry of the installed Studio
/// (ServiceStudio.Scope.BuiltinFunctions, the catalog of the repo) has no Guid function and the Studio's own Verify answers
/// ExpressionUnknownFunction 'GenerateGuid' (measured offline on the installed 11.55.93 over blank-service.oml). So the catalog stays as the
/// Studio says; FUNCTION_UNKNOWN names the function without the parenthesis and, for a built-in of the other platform, says
/// what to write in this one.
/// </summary>
public class FunctionCatalogOtherPlatformTests
{
    [Fact]
    public void ABuiltInOfTheOtherPlatformHasTheFixOfThisOne()
    {
        var fix = FunctionCatalog.OtherPlatformFix("o11", "GenerateGuid");
        Assert.NotNull(fix);
        Assert.Contains("built-in of ODC, not of Service Studio 11", fix);
        Assert.Contains("NEWID()", fix);
        Assert.Equal(fix, FunctionCatalog.OtherPlatformFix("o11", "generateguid"));
        Assert.Null(FunctionCatalog.OtherPlatformFix("odc", "GenerateGuid"));
        Assert.Null(FunctionCatalog.OtherPlatformFix("o11", "Substr"));
    }

    [Fact]
    public void TheStudioHasNoGenerateGuidAndTheRefusalNamesItWithoutTheParenthesis()
    {
        if (!StudioAvailable()) return;
        Assert.DoesNotContain("GenerateGuid", FunctionCatalog.Names);
        var (_, error, _) = DeleteBreaksTests.Run(null, new JsonArray(new JsonObject
        {
            ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray("server action NewKey\n  out Key: Text\n  assign Key = GenerateGuid()\n  end\n") },
        }), expectValid: true);
        var problem = Assert.Single(Errors.FindCoded(error!)!.Problems!.OfType<JsonObject>(), p => p["code"]!.ToString() == "FUNCTION_UNKNOWN");
        Assert.StartsWith("'GenerateGuid' is not a built-in function of this Studio (o11)", problem["message"]!.ToString());
        Assert.Contains("built-in of ODC", problem["fix"]!.ToString());
    }

    private static bool StudioAvailable()
    {
        try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; }
    }
}
