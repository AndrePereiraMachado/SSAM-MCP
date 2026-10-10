using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Linked into both test projects: the data contract anchored on element IDENTITY (phase 3, 2026-09-23) behaves the
/// same on O11 and ODC. The positive path (write, then rename; expressions the platform rewrites; record values
/// addressed by path before their record's Identifier changes) is the job data-contract-identity.json of each lane.
/// This file holds the case a green job cannot contain: a write that ALREADY differed from the model before the
/// rename is NOT absorbed as a platform rewrite and stays a difference, naming the element and the two values.
/// The test projects bind the Studio at run time (no compile-time reference to the model assemblies), so the
/// scenarios go through ModelHost.WithSession and reflection only.
/// </summary>
public static class DataContractIdentityScenarios
{
    private static JsonArray Ops(string json) => JsonNode.Parse(json)!.AsArray();

    /// <summary>set Description "Notas", then an OUT-OF-BAND change to "Outra coisa" (the platform, another tool, a
    /// bug) before the rename of the attribute: the rename must not launder that divergence into an expectation.</summary>
    public static void WrongValueStaysRejectedAcrossARename(ModelHost host, string fixture)
    {
        var contract = host.WithSession(fixture, session =>
        {
            session.Apply(Ops("""
            [
             {"op":"spec","data":{"entities":[{"name":"DcWrong","attributes":[{"name":"Title","type":"Text","length":50},{"name":"Notes","type":"Text","length":200}]}]}},
             {"op":"set","target":"$DcWrong.Notes","prop":"Description","value":"Notas"},
             {"op":"set","target":"$DcWrong.Title","prop":"Description","value":"Titulo"}
            ]
            """));
            var notes = session.Resolve("IServerEntity:DcWrong/Notes");
            var description = notes.GetType().GetProperty("Description") ?? notes.GetType().GetInterfaces().Select(i => i.GetProperty("Description")).First(p => p != null)!;
            Assert.Equal("Notas", description.GetValue(notes));
            session.Mutate("test: out-of-band change", () => description.SetValue(notes, "Outra coisa"));   // not a verb of this job
            session.Apply(Ops("""[{"op":"rename","target":"IServerEntity:DcWrong/Notes","name":"Remarks"},{"op":"rename","target":"IServerEntity:DcWrong","name":"DcWrongCase"}]"""));
            return session.DataContract();
        });
        Assert.False(contract["accepted"]!.GetValue<bool>(), contract.ToJsonString());
        var differences = contract["differences"]!.AsArray();
        var notesDifference = Assert.Single(differences, d => d!["property"]?.ToString() == "Description" && d["element"]!.ToString().Contains("Notes", StringComparison.Ordinal));
        Assert.Equal("Notas", notesDifference!["expected"]!.ToString());
        Assert.Equal("Outra coisa", notesDifference["actual"]!.ToString());
        Assert.Null(notesDifference["platformRewrites"]);       // nothing was absorbed: it already differed before the rename
        // The sibling written correctly and renamed with its entity is still accepted, and the entity's own Name
        // assertion was refreshed by the platform rewrite the rename caused, with the history kept.
        var titleAssertion = contract["assertions"]!.AsArray().Single(a => a!["property"]?.ToString() == "Description" && a["element"]!.ToString().Contains("Title", StringComparison.Ordinal));
        Assert.Equal("Titulo", titleAssertion!["expected"]!.ToString());
        Assert.DoesNotContain(differences, d => d!["element"]!.ToString().Contains("Title", StringComparison.Ordinal));
        // The entity's Name assertion (from its create) was refreshed by the rename and keeps the rewrite history.
        var names = contract["assertions"]!.AsArray().Where(a => a!["property"]?.ToString() == "Name").Select(a => a!["element"] + " => " + a["expected"]).ToList();
        var entityName = contract["assertions"]!.AsArray().SingleOrDefault(a => a!["property"]?.ToString() == "Name" && a["expected"]?.ToString() == "DcWrongCase");
        Assert.True(entityName != null, "no Name assertion expects DcWrongCase; Name assertions: " + string.Join(" | ", names));
        Assert.NotNull(entityName!["platformRewrites"]);
        Assert.True(contract["rewrittenByPlatform"]!.GetValue<int>() >= 1);
    }

    /// <summary>A record value written by PATH and then renamed through set Identifier resolves by identity at the end
    /// (@record/@attribute), and the Label the platform rewrote (equal to the old name) is expected as rewritten; a
    /// second value the job wrote with a different text is untouched by the rename and still compared as written.</summary>
    public static void RecordValuesFollowTheirRecordByIdentity(ModelHost host, string fixture)
    {
        var contract = host.WithSession(fixture, session =>
        {
            session.Apply(Ops("""
            [
             {"op":"spec","data":{"static":[{"name":"DcKind","records":[{"name":"Alpha","label":"Alpha"},{"name":"Beta","label":"Beta"}]}]}},
             {"op":"set","target":"IStaticEntity:DcKind/Beta/Label","prop":"Value","value":"\"Beta\""},
             {"op":"set","target":"IStaticEntity:DcKind/Beta/Order","prop":"Value","value":"7"},
             {"op":"set","target":"IStaticEntity:DcKind/Beta","prop":"Identifier","value":"Gamma"},
             {"op":"rename","target":"IStaticEntity:DcKind","name":"DcKindOfThing"}
            ]
            """));
            return session.DataContract();
        });
        Assert.True(contract["accepted"]!.GetValue<bool>(), contract["differences"]!.ToJsonString());
        var assertions = contract["assertions"]!.AsArray();
        // The Label the platform rewrote (it equalled the old identifier) is the only rewritten record value.
        var label = Assert.Single(assertions, a => a!["property"]?.ToString() == "Value" && a["platformRewrites"] is JsonArray { Count: > 0 });
        Assert.Equal("\"Gamma\"", label!["expected"]!.ToString());
        Assert.Equal("set Identifier", label["platformRewrites"]![0]!["verb"]!.ToString());
        Assert.Equal("\"Beta\"", label["platformRewrites"]![0]!["before"]!.ToString());
        Assert.Contains("/@", label["reference"]!.ToString());
        // The Order written by path is compared as written, through the same identity-anchored reference.
        var order = Assert.Single(assertions, a => a!["property"]?.ToString() == "Value" && a["expected"]?.ToString() == "7");
        Assert.Null(order!["platformRewrites"]);
        Assert.StartsWith("@", order["reference"]!.ToString()); Assert.Contains("/@", order["reference"]!.ToString());
        Assert.True(contract["rewrittenByPlatform"]!.GetValue<int>() >= 1);
    }

    /// <summary>A12 (atritos 2 package): a reference to a PRODUCER element (the theme a module theme derives from) compares by
    /// the resolved target, not by the local key. The real case, SS360_Portal on 2026-10-06: "BaseTheme expected {key
    /// F_65+..} actual {key zeDb..}", the candidate's reference re-keyed by the Studio's merge to the consumer's own key. The
    /// assertion here is what a candidate recorded (another local key, the same producer element); the module answers its
    /// own key: equal, listed in platformRewrites. The same assertion pointing at another element of the producer differs.
    /// <paramref name="ownerReference"/>: the element whose <paramref name="property"/> references a producer element.</summary>
    public static void AProducerReferenceReKeyedByTheMergeIsEqual(ModelHost host, string fixture, string ownerReference, string property)
    {
        var (actual, rekeyed, other) = host.WithSession(fixture, session =>
        {
            var owner = session.Resolve(ownerReference);
            var key = ModelHost.Prop(owner, "ObjectKey")!.ToString()!;
            JsonObject Assertion(JsonNode expected) => new()
            {
                ["key"] = key, ["reference"] = "@" + key, ["element"] = ModelHost.PathOf(owner), ["property"] = property, ["expected"] = expected,
            };
            // What the module holds now, as the proof reads it (the difference names the actual value).
            var probe = session.CheckDataContract(new JsonArray(Assertion(new JsonObject { ["key"] = "probe-key-that-is-not-there" })));
            var read = probe["differences"]!.AsArray().Single()!["actual"]!.AsObject();
            var candidate = new JsonObject { ["key"] = "F_65+kV7wUGqyj307a5RvQ", ["target"] = read["target"]?.DeepClone() };
            var same = session.CheckDataContract(new JsonArray(Assertion(candidate)));
            var otherTarget = read["target"]?.DeepClone().AsObject() ?? new JsonObject();
            otherTarget["originalKey"] = "another-element-of-the-producer";
            var differs = session.CheckDataContract(new JsonArray(Assertion(new JsonObject { ["key"] = "F_65+kV7wUGqyj307a5RvQ", ["target"] = otherTarget })));
            return (read, same, differs);
        });
        var target = Assert.IsType<JsonObject>(actual["target"]);
        Assert.False(string.IsNullOrEmpty(target["producerKey"]?.ToString()), actual.ToJsonString());
        Assert.False(string.IsNullOrEmpty(target["producer"]?.ToString()), actual.ToJsonString());
        Assert.True(rekeyed["accepted"]!.GetValue<bool>(), rekeyed["differences"]!.ToJsonString());
        Assert.Equal(1, rekeyed["rewrittenByPlatform"]!.GetValue<int>());
        var rewrite = Assert.Single(rekeyed["platformRewrites"]!.AsArray())!;
        Assert.Equal(property, rewrite["property"]!.ToString());
        var recorded = Assert.Single(rekeyed["assertions"]!.AsArray())!["platformRewrites"]![0]!;
        Assert.Equal("merge", recorded["verb"]!.ToString());
        Assert.Equal("F_65+kV7wUGqyj307a5RvQ", recorded["from"]!.ToString());
        Assert.Equal(actual["key"]!.ToString(), recorded["to"]!.ToString());
        Assert.False(other["accepted"]!.GetValue<bool>());
        Assert.Equal(property, Assert.Single(other["differences"]!.AsArray())!["property"]!.ToString());
    }
}
