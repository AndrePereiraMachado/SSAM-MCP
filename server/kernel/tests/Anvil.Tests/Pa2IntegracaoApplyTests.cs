using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Integration of the atritos 2 package (lane F2's apply that collects everything, lane F3's html fragment): a widget an html
/// fragment names (id="...") is created by that op only. When the fragment is skipped because an earlier op failed, a later
/// op that targets the widget is skipped too, never a failure of its own. The Cardapio UI replay of 2026-10-06 answered one
/// real failure and 92 REFERENCE_UNRESOLVED of buttons its skipped fragments would have created: the skipped op's text was
/// kept JSON-escaped (the quote of id="LoginBtn1" as a backslash-u0022 sequence), so the name never matched as a word.
/// </summary>
public sealed class Pa2IntegracaoApplyTests
{
    private static readonly string Root = PacoteBPolicyTests.FindRoot();

    [Fact]
    public void AWidgetASkippedFragmentWouldNameIsSkippedNotAFailure()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Path.Combine(Root, ".local", "pa2-integracao-tests", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(dir);
        var job = Path.Combine(dir, "skip.json");
        File.WriteAllText(job, """
        {"base":"reactive-ui.oml","ops":[
          {"op":"create","parent":"IMobileFlow:MainFlow","type":"IMobileScreen","name":"Pa2Tela","as":"$tela"},
          {"op":"create","parent":"$tela/NaoExiste","type":"IContainer","name":"Pa2Painel","as":"$painel"},
          {"op":"html","parent":"$painel","html":"<div id=\"Pa2Caixa\" class=\"x\">Ok</div>"},
          {"op":"set","target":"IContainer:Pa2Caixa","prop":"Style","value":"\"y\""}]}
        """);
        var output = Path.Combine(dir, "skip.oml");
        var error = Assert.ThrowsAny<Exception>(() => JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, job, output));
        var refused = Assert.IsType<JobPreflightException>(Errors.FindCoded(error));
        // One problem, the op that failed; the fragment and the op on its widget are skipped and named as such.
        var problem = Assert.Single(refused.Problems.OfType<JsonObject>());
        Assert.Equal(1, problem["op"]!.GetValue<int>());
        Assert.Equal("CHILD_NOT_FOUND", problem["code"]!.GetValue<string>());
        var skipped = refused.Warnings.OfType<JsonObject>().Where(w => w["code"]!.GetValue<string>() == "APPLY_SKIPPED").Select(w => w["op"]!.GetValue<int>());
        Assert.Equal(new[] { 2, 3 }, skipped);
        Assert.False(File.Exists(output));
        Assert.Equal("PREFLIGHT_REFUSED", Errors.Envelope("apply", error, 1)["code"]!.GetValue<string>());
    }
}
