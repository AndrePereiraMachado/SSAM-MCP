using System.Text.Json.Nodes;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

// Linked into both test projects (B7, port of proto F9 8f56078f): the two rules the delivery uses to skip a step that would
// change nothing. AlignedInModule: the Studio's Manage Dependencies (or Refresh References) before the merge. SignaturesUnchanged:
// the C15 signature preview, whose plan (ReferenceSignatureMerge.Analyze) holds a change or a conflict only for a producer key
// base and candidate share whose ReferenceHash moved or that one side references more than once. Pure: no model, no Studio.
public sealed class DeliveryAlignmentRulesTests
{
    private const string CsKey = "ctlxH_I+u0qYinuZ13qdyg";
    private const string Published = "58fcb70e-14d9-ab51-f92e-11505b8e046e";
    private const string Older = "fc080de4-0000-0000-0000-000000000000";

    private static ModuleReferenceEntry Ref(string name, string key, string hash, params string[] exports)
        => new(name, key, "eSpace", hash, exports.Select(e => new ReferencedExport(e, "ReferenceEntity", e + "-key")).ToArray());

    // The producer's capture as ProducerSignatureCapture records it: {type, name, path, originalKey} per element.
    private static JsonArray Captured(params (string Type, string Name, string Path, string Key)[] elements)
        => new(elements.Select(e => (JsonNode)new JsonObject { ["type"] = e.Type, ["name"] = e.Name, ["path"] = e.Path, ["originalKey"] = e.Key }).ToArray());

    [Fact]
    public void TheAlignmentIsNeededOnlyWhenTheModuleLacksAReferenceASignatureOrAnElement()
    {
        var target = new ReferenceClosure.AlignmentTarget("Core_CS", CsKey, Published, Published, ["IServerEntity:Visita"],
            Captured(("IServerEntity", "Visita", "Visita", "Visita-key")));
        var (aligned, report) = ReferenceClosure.AlignedInModule([target], [Ref("Core_CS", CsKey, Published, "Visita")]);
        Assert.True(aligned);
        Assert.True(report[0]!["aligned"]!.GetValue<bool>());

        // Each missing piece keeps the Studio's Manage Dependencies, with the reason.
        Assert.Contains("does not reference", ReferenceClosure.AlignedInModule([target], []).Report[0]!["why"]!.ToString());
        Assert.Contains(Older, ReferenceClosure.AlignedInModule([target], [Ref("Core_CS", CsKey, Older, "Visita")]).Report[0]!["why"]!.ToString());
        Assert.Contains("lacks IServerEntity:Visita", ReferenceClosure.AlignedInModule([target], [Ref("Core_CS", CsKey, Published, "Local")]).Report[0]!["why"]!.ToString());
        // The server advertises another signature than the capture: the Studio brings it there.
        Assert.False(ReferenceClosure.AlignedInModule([target with { PublishedHash = Older }], [Ref("Core_CS", CsKey, Published, "Visita")]).Aligned);
        // A target without key or hash decides nothing, and no target at all is no proof.
        Assert.False(ReferenceClosure.AlignedInModule([target with { Hash = null }], [Ref("Core_CS", CsKey, Published, "Visita")]).Aligned);
        Assert.False(ReferenceClosure.AlignedInModule([target with { Key = null }], [Ref("Core_CS", CsKey, Published, "Visita")]).Aligned);
        Assert.False(ReferenceClosure.AlignedInModule([], [Ref("Core_CS", CsKey, Published)]).Aligned);
        // One target behind is enough to send the alignment for all.
        var other = new ReferenceClosure.AlignmentTarget("Other_CS", "other", Published, null, []);
        // Without the producer's capture a name resolves to nothing: the Studio runs.
        Assert.False(ReferenceClosure.AlignedInModule([target with { CapturedElements = null }], [Ref("Core_CS", CsKey, Published, "Visita")]).Aligned);
        Assert.Contains("cannot resolve", ReferenceClosure.AlignedInModule([target with { CapturedElements = null }], [Ref("Core_CS", CsKey, Published, "Visita")]).Report[0]!["why"]!.ToString());
        Assert.False(ReferenceClosure.AlignedInModule([target, other], [Ref("Core_CS", CsKey, Published, "Visita"), Ref("Other_CS", "other", Older)]).Aligned);
    }

    /// <summary>B7 review (round 2, fix 2): the skip counts an element as held only by the original key the producer's capture
    /// resolves it to, never by its name alone.</summary>
    [Fact]
    public void AnElementOfTheSameNameButAnotherKindOrFlowIsNotHeld()
    {
        var module = new[] { new ModuleReferenceEntry("Core_CS", CsKey, "eSpace", Published, [new ReferencedExport("Ping", "ReferenceEntity", "k-entity")]) };
        // Same name, other kind: the job wants the server action Ping, the module holds the entity Ping.
        var action = new ReferenceClosure.AlignmentTarget("Core_CS", CsKey, Published, null, ["IServerAction:Ping"],
            Captured(("IServerAction", "Ping", "Ping", "k-action"), ("IServerEntity", "Ping", "Ping", "k-entity")));
        var (aligned, report) = ReferenceClosure.AlignedInModule([action], module);
        Assert.False(aligned);
        Assert.Contains("lacks IServerAction:Ping", report[0]!["why"]!.ToString());
        // The entity itself is held, by its key.
        Assert.True(ReferenceClosure.AlignedInModule([action with { Elements = ["IServerEntity:Ping"] }], module).Aligned);
        // A name without its kind that two elements of the capture carry resolves to nothing.
        Assert.Null(ReferenceClosure.ElementKey("Ping", action.CapturedElements));
        Assert.False(ReferenceClosure.AlignedInModule([action with { Elements = ["Ping"] }], module).Aligned);

        // Same name, other flow: the job wants MainFlow\Header, the module holds Common\Header.
        var blocks = new[] { new ModuleReferenceEntry("Core_CS", CsKey, "eSpace", Published, [new ReferencedExport("Header", "ReferenceWebBlock", "k-common")]) };
        var header = new ReferenceClosure.AlignmentTarget("Core_CS", CsKey, Published, null, ["IWebBlock:MainFlow\\Header"],
            Captured(("IWebBlock", "Header", "MainFlow/Header", "k-main"), ("IWebBlock", "Header", "Common/Header", "k-common")));
        Assert.False(ReferenceClosure.AlignedInModule([header], blocks).Aligned);
        Assert.True(ReferenceClosure.AlignedInModule([header with { Elements = ["IWebBlock:Common/Header"] }], blocks).Aligned);
        Assert.False(ReferenceClosure.AlignedInModule([header with { Elements = ["IWebBlock:Header"] }], blocks).Aligned);
        // Two references of the producer's key (review S1): the Studio aligns.
        Assert.False(ReferenceClosure.AlignedInModule([header with { Elements = ["@k-common"], CapturedElements = null }], [.. blocks, .. blocks]).Aligned);
        // @key needs no capture.
        Assert.True(ReferenceClosure.AlignedInModule([header with { Elements = ["@k-common"], CapturedElements = null }], blocks).Aligned);
        // Review S6: Type:@key holds when the capture's element of that key has that type, never with another type or unchecked.
        Assert.True(ReferenceClosure.AlignedInModule([header with { Elements = ["IWebBlock:@k-common"] }], blocks).Aligned);
        Assert.Null(ReferenceClosure.ElementKey("IServerAction:@k-common", header.CapturedElements));
        Assert.False(ReferenceClosure.AlignedInModule([header with { Elements = ["IServerAction:@k-common"] }], blocks).Aligned);
        Assert.False(ReferenceClosure.AlignedInModule([header with { Elements = ["IWebBlock:@k-common"], CapturedElements = null }], blocks).Aligned);
        Assert.Null(ReferenceClosure.ElementKey("IWebBlock:@k-unknown", header.CapturedElements));
    }

    [Fact]
    public void TheSignaturePreviewHasNothingToCheckWhenNoSharedReferenceMovesItsHash()
    {
        var basis = new[] { Ref("(System)", "sys", "25c9070b-5b59-c74b-b02c-0682c87dcb02"), Ref("Core_CS", CsKey, Published) };
        // A new reference and new exports are not part of the signature plan.
        Assert.True(ReferenceClosure.SignaturesUnchanged(basis, [.. basis, Ref("Other", "other", Older)]));
        Assert.True(ReferenceClosure.SignaturesUnchanged(basis, [basis[0], Ref("Core_CS", CsKey, Published, "Visita")]));
        // A reference the candidate drops is no signature the preview selects either.
        Assert.True(ReferenceClosure.SignaturesUnchanged(basis, [basis[0]]));
        // A moved hash is a change; a key referenced twice on either side is a conflict the preview must report.
        Assert.False(ReferenceClosure.SignaturesUnchanged(basis, [basis[0], Ref("Core_CS", CsKey, Older)]));
        Assert.False(ReferenceClosure.SignaturesUnchanged(basis, [.. basis, Ref("Core_CS again", CsKey, Published)]));
        Assert.False(ReferenceClosure.SignaturesUnchanged([.. basis, Ref("Core_CS again", CsKey, Published)], basis));
    }
}
