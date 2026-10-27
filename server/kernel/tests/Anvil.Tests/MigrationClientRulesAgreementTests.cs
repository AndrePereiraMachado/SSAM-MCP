using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Preflight;
using Xunit;

namespace Anvil.Tests;

/// <summary>M07 x T9 (integ/proto-into-product): the client JavaScript the migration adapters generate (the proto line's
/// migration-time helper, its upload check and the download action) is judged by the candidate's client rules exactly as an
/// author's script is (ReactiveClientRules: LogicLint.ClientScript with the runtime table of the lane), and none of it is a
/// finding of any severity, on both lanes. The two lines must agree: T9 refuses, M07 generates.</summary>
public sealed class MigrationClientRulesAgreementTests
{
    private static string Resource(string name)
    {
        using var stream = typeof(MigrationUiAdapters).Assembly.GetManifestResourceStream(name)!;
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }

    // The scripts as the adapters write them in their JavaScript nodes (MigrationUiAdapters.TemporalFunction, UploadValidation,
    // DownloadAction).
    public static TheoryData<string, string> Scripts()
    {
        var data = new TheoryData<string, string>();
        foreach (var lane in new[] { "o11", "odc" })
        {
            data.Add(lane, Resource("Anvil.Core.Kernel.TemporalRuntime.js")
                + "\n$parameters.Formatted = ssamFormatTemporal($parameters.Value, $parameters.Semantics, $parameters.Zone, $parameters.Format);");
            data.Add(lane, Resource("Anvil.Core.Kernel.UploadValidationRuntime.js")
                + "\nvar result = ssamValidateUpload($parameters.FileContent, $parameters.FileName, $parameters.MaxBytes, $parameters.Extensions); $parameters.Valid = result.valid; $parameters.ErrorText = result.error;");
            data.Add(lane, NodeRules.DownloadScript);
        }
        return data;
    }

    [Theory]
    [MemberData(nameof(Scripts))]
    public void TheGeneratedClientScriptsPassTheClientRulesWithoutAFinding(string lane, string script)
    {
        var context = new ScriptContext(ReactiveClientRules.RuntimeOwnedMarkers(lane), ReactiveClientRules.RuntimeAttributes(lane),
            new HashSet<string>(StringComparer.OrdinalIgnoreCase), new HashSet<string>(StringComparer.OrdinalIgnoreCase),
            new Dictionary<string, Filler>(StringComparer.OrdinalIgnoreCase));
        var findings = LogicLint.ClientScript(script, context);
        Assert.True(findings.Count == 0, lane + ": " + string.Join("; ", findings.Select(f => f.Code + " " + f.Severity + ": " + f.Message)));
    }

    // Negative: the same judge on a script that mutates what the runtime owns (a device class of body) still finds it, so the
    // agreement above is not an empty judge.
    [Fact]
    public void AScriptThatMutatesTheRuntimeIsStillAFinding()
    {
        var context = new ScriptContext(ReactiveClientRules.RuntimeOwnedMarkers("o11"), ReactiveClientRules.RuntimeAttributes("o11"),
            new HashSet<string>(StringComparer.OrdinalIgnoreCase), new HashSet<string>(StringComparer.OrdinalIgnoreCase),
            new Dictionary<string, Filler>(StringComparer.OrdinalIgnoreCase));
        var findings = LogicLint.ClientScript("document.body.classList.remove(\"phone\"); document.body.classList.add(\"desktop\");", context);
        Assert.Contains(findings, f => f.Code is "DOM_MUTATION_OF_RUNTIME" or "JS_RUNTIME_DUPLICATE" or "DATETIME_TZ_REINTERPRETED");
    }
}
