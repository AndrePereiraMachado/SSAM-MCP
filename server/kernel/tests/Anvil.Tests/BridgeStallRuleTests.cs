using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;
namespace Anvil.Tests;
public sealed class BridgeStallRuleTests
{
    private static JsonObject Fixture() => JsonNode.Parse(File.ReadAllText(Path.Combine(JobRunner.RepoRoot(Path.GetDirectoryName(typeof(BridgeStallRuleTests).Assembly.Location)!)!, "tests", "fixtures", "bridge-stall", "cases.json")))!.AsObject();
    public static IEnumerable<object[]> Cases() => Fixture()["cases"]!.AsArray().Select(c => new object[] { c!.ToJsonString() });
    [Fact]
    public void ConstantsAndErrorTitlesMatchSharedContract()
    {
        var f = Fixture();
        Assert.Equal(f["errorReportTitles"]!.AsArray().Select(x=>x!.GetValue<string>()), OperationDialogPolicy.ErrorTitles);
        Assert.Equal(f["watchedVerbs"]!.AsArray().Select(x=>x!.GetValue<string>()), BridgeStallRule.WatchedVerbs);
        Assert.Equal(f["preProbeVerbs"]!.AsArray().Select(x=>x!.GetValue<string>()), BridgeStallRule.PreProbeVerbs);
        Assert.Equal(f["errorReportAutoVerbs"]!.AsArray().Select(x=>x!.GetValue<string>()), BridgeStallRule.ErrorReportAutoVerbs);
        Assert.Equal(f["errorReportAutoCapability"]!.GetValue<string>(), BridgeStallRule.ErrorReportAutoCapability);
        Assert.Equal(new[]{2000,5000,2,8,2,20},new[]{BridgeStallRule.ProbeMs,BridgeStallRule.ProbeTimeoutMs,BridgeStallRule.ErrorReportProbes,BridgeStallRule.DialogProbes,BridgeStallRule.GoneProbes,BridgeStallRule.MaxTexts});
    }
    [Theory, MemberData(nameof(Cases))]
    public void SharedParity(string json)
    {
        var item=JsonNode.Parse(json)!.AsObject();
        if(item["classify"] is JsonObject classify) { Assert.Equal(item["kind"]!.GetValue<string>(),DialogPolicy.ClassifyWindow(classify["title"]?.GetValue<string>(), classify["texts"]!.AsArray().Select(t=>t!.GetValue<string>()))); return; }
        var method=item["method"]!.GetValue<string>();
        var rule=new BridgeStallRule(method,item["probeMs"]?.GetValue<int>()??BridgeStallRule.ProbeMs,item["timeoutMs"]?.GetValue<int>());
        var verdict=rule.Begin(item["before"]?.AsArray(),item["capabilities"]?.AsArray().Select(c=>c!.GetValue<string>()),123,item["startedUtc"]?.GetValue<string>());
        var probes=item["probes"]!.AsArray();
        for(var i=0;i<probes.Count && verdict==null;i++) { var p=probes[i]!.DeepClone().AsObject(); p["afterMs"] ??= (i+1)*2000; verdict=rule.Observe(p); if(verdict!=null) Assert.Equal(probes.Count-1,i); }
        Assert.Equal(item["expected"]?.GetValue<string>(),verdict?["verdict"]?.GetValue<string>());
        if(item["expectedQuestion"]!=null) Assert.Equal(item["expectedQuestion"]!.GetValue<string>(),verdict!["blockedBy"]!["question"]!.GetValue<string>());
        // CX14 R2: what the person typed in a dialog (a TextBox) never leaves the rule: not in texts, buttons or question.
        if(item["absent"] is JsonArray absent) foreach(var text in absent) Assert.DoesNotContain(text!.GetValue<string>(),verdict?.ToJsonString()??"");
        if(verdict!=null) { Assert.Equal(method,verdict["method"]!.GetValue<string>()); Assert.Equal(123,verdict["studio"]!["pid"]!.GetValue<int>()); }
    }
}
