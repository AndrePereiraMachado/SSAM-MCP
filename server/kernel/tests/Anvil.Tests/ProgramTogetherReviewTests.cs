using System.Text.Json.Nodes;
using OutSystems.Model;
using OutSystems.Model.Logic.Nodes;
using Xunit;

namespace Anvil.Tests;

/// <summary>F1 review (C:\t\r4\REVISAO-F1.md, A1, A3, A7, A8): the stops the review found, each with the person editing the open
/// module between the delivery's capture and its merge. The harness is in ProgramTogetherTests.cs.</summary>
public partial class ProgramTogetherTests
{
    private const string OrderEntity = """{"ops":[{"op":"spec","data":{"entities":[{"name":"Order","public":true,"attributes":[ATTRS]}]}}]}""";
    private static string Attributes(params string[] names) => OrderEntity.Replace("ATTRS", string.Join(",", names.Select(n => "{\"name\":\"" + n + "\",\"type\":\"Text\",\"length\":50}")));
    private static string AddAttribute(string name) => """{"ops":[{"op":"create","parent":"IServerEntity:Order","type":"IEntityAttribute","name":"NAME"}]}""".Replace("NAME", name);
    private static bool HasNamed(string path, string name)
    {
        var host = new Anvil.Core.ModelHost(Path.Combine(Path.GetDirectoryName(path)!, "named-" + Guid.NewGuid().ToString("N")[..8]));
        var model = host.Load(File.ReadAllBytes(path));
        try { return Objects(model).Any(o => Anvil.Core.ModelHost.Prop(o, "Name")?.ToString() == name); }
        finally { Anvil.Core.ModelHost.Release(model); }
    }

    [Fact]
    public void A1_TwoAttributesAddedToOneEntityByThePersonAndTheJobAreBothKept()
    {
        var studio = Studio(fingerprint: true);
        Apply(studio.Live, Attributes("Name"));
        studio.AfterBaseSnapshot = live => Apply(live, AddAttribute("Notes"));
        var result = Deliver(studio, AddAttribute("Status"));
        Assert.True(result["delivered"]?.GetValue<bool>() == true, result["code"] + " " + result["error"] + " " + result["contentProof"]?["differences"]?.ToJsonString());
        Assert.True(HasNamed(studio.Live, "Status") && HasNamed(studio.Live, "Notes"));
        Assert.Contains(Notes(result), n => n.Contains("Notes", StringComparison.Ordinal));
    }

    [Fact]
    public void A3_WithTheOpenModuleEqualToTheBaseALossOutsideTheJobStillRefuses()
    {
        // Rule (a): no edit of the person reached the module before the merge, so a base element the merge loses is the merge's.
        var studio = Studio(fingerprint: true);
        Apply(studio.Live, Action("Untouched"));
        studio.AfterMerge = live => Edit(live, model => { foreach (var a in Actions(model, "Untouched")) a.Delete(); });
        var result = Deliver(studio, Action("Delivered"));
        Assert.Equal("a", result["mergeProof"]?["rule"]?.ToString());
        Assert.Equal("MERGE_CONTENT_MISMATCH", result["code"]?.ToString());
        Assert.Contains(result["contentProof"]!["differences"]!.AsArray(), d => d!["element"]!.ToString().Contains("Untouched", StringComparison.Ordinal));
    }

    [Fact]
    public void A3_ARemovalByThePersonIsNamedAsRemovedNeverAsKept()
    {
        var studio = Studio(fingerprint: true);
        Apply(studio.Live, Action("RemovedByThePerson"));
        studio.AfterBaseSnapshot = live => Edit(live, model => { foreach (var a in Actions(model, "RemovedByThePerson")) a.Delete(); });
        var result = Deliver(studio, Action("Delivered3a"));
        Assert.True(result["delivered"]?.GetValue<bool>() == true, result["code"] + " " + result["error"]);
        var note = Assert.Single(Notes(result), n => n.Contains("RemovedByThePerson", StringComparison.Ordinal));
        Assert.Contains("were removed", note);
        Assert.DoesNotContain("kept", note);
    }

    [Fact]
    public void A7_TwinNodesTheJobCreatedAndTheStudioMovedAreNotARefusal()
    {
        var studio = Studio(fingerprint: true);
        studio.AfterMerge = live => Edit(live, model =>
        {
            var x = 0;
            foreach (var node in Objects(model).OfType<IFlowNode>()) { node.HorizontalPosition += 40 + 10 * x++; node.VerticalPosition += 25; }
        });
        var result = Deliver(studio, """{"ops":[{"op":"logic","data":{"actions":[{"name":"Twins","kind":"server","inputs":[{"name":"Amount","type":"Integer"}],"outputs":[{"name":"Out","type":"Integer"}],"steps":[{"if":"Amount > 10","then":[{"assign":{"Out":"1"}}],"else":[{"assign":{"Out":"1"}}]}]}]}}]}""");
        Assert.True(result["delivered"]?.GetValue<bool>() == true, result["code"] + " " + result["error"] + " " + result["contentProof"]?["differences"]?.ToJsonString());
    }

    [Fact]
    public void A8_TheJobDeletesAnActionThePersonEditedAndTheDeliveryWins()
    {
        var studio = Studio(fingerprint: true);
        Apply(studio.Live, Action("Gone"));
        studio.AfterBaseSnapshot = live => SetDescription(live, "Gone", "edited by the person");
        var result = Deliver(studio, """{"ops":[{"op":"delete","target":"ServerAction:Gone"}]}""");
        Assert.True(result["delivered"]?.GetValue<bool>() == true, result["code"] + " " + result["error"] + " " + result["contentProof"]?["differences"]?.ToJsonString());
        Assert.False(Has(studio.Live, "Gone"));
        Assert.NotEmpty(Notes(result));
    }

    [Fact]
    public void A8_ThePersonRenamesTheActionTheJobEditsAndTheDeliveryWins()
    {
        var studio = Studio(fingerprint: true);
        Apply(studio.Live, Action("Renamed"));
        studio.AfterBaseSnapshot = live => Apply(live, """{"ops":[{"op":"set","target":"ServerAction:Renamed","prop":"Name","value":"RenamedByThePerson"}]}""");
        var result = Deliver(studio, """{"ops":[{"op":"set","target":"ServerAction:Renamed","prop":"Description","value":"written by the job"}]}""");
        Assert.True(result["delivered"]?.GetValue<bool>() == true, result["code"] + " " + result["error"] + " " + result["contentProof"]?["differences"]?.ToJsonString());
        Assert.Equal("written by the job", DescriptionOf(studio.Live, "Renamed") ?? DescriptionOf(studio.Live, "RenamedByThePerson"));
        Assert.NotEmpty(Notes(result));
    }

    [Fact]
    public void A8_ThePersonDeletesTheEntityTheJobAddsAnAttributeToAndTheDeliveryWins()
    {
        var studio = Studio(fingerprint: true);
        Apply(studio.Live, Attributes("Name"));
        studio.AfterBaseSnapshot = live => Edit(live, model =>
        {
            foreach (var e in Objects(model).Where(o => Anvil.Core.ModelHost.Prop(o, "Name")?.ToString() == "Order" && o.GetType().Name.Contains("Entity", StringComparison.Ordinal)).ToList()) e.Delete();
        });
        var result = Deliver(studio, AddAttribute("Status"));
        Assert.True(result["delivered"]?.GetValue<bool>() == true, result["code"] + " " + result["error"] + " " + result["contentProof"]?["differences"]?.ToJsonString());
        Assert.True(HasNamed(studio.Live, "Status"));
        Assert.NotEmpty(Notes(result));
    }
}
