using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>
/// Onda 2 (C-21, C-39): one refusal lists every real problem once, at its line, and what only follows from a failed op is
/// that op's, never a problem of its own.
/// <list type="bullet">
/// <item>F-FitBody-23 (FigmaMobile, lote 3, seq 11): a data text refused at apply (DDL_BASE_REQUIRED) and 35 problems for two
/// causes: the documents that use its entities were skipped, but a later logic op prepared every page of the job, so their
/// aggregates over the missing entities reached the Verify (InvalidDataSet_NoEntity, ExpressionUnknownObject,
/// RequiredPropertyValue_Property) with no op.</item>
/// <item>F-FigmaMobile-01 (5 rounds): a block whose content failed was discarded whole, so the screen that uses it and the
/// logic texts of its actions were skipped and their own problems came one round later.</item>
/// <item>F-FT-18: a Traditional document stopped at the first element the platform refused, with no line.</item>
/// </list>
/// </summary>
public sealed class RefusalCascadeTests(ITestOutputHelper output)
{
    private static readonly string Root = PacoteBPolicyTests.FindRoot();

    private static string Dir()
    {
        var dir = Path.Combine(Root, ".local", "refusal-cascade-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }

    private (List<JsonObject> Problems, List<JsonObject> Warnings) Refused(string dir, JsonObject job)
    {
        var path = Path.Combine(dir, "job.json");
        File.WriteAllText(path, job.ToJsonString());
        var outPath = Path.Combine(dir, "out.oml");
        var error = Assert.ThrowsAny<Exception>(() => JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, path, outPath));
        Assert.False(File.Exists(outPath));
        var envelope = Errors.Envelope("apply", error, 1);
        var problems = (envelope["problems"] as JsonArray ?? []).OfType<JsonObject>().ToList();
        var warnings = (Errors.FindCoded(error) as JobPreflightException)?.Warnings.OfType<JsonObject>().ToList() ?? [];
        output.WriteLine($"code {envelope["code"]} verifyRan {envelope["verifyRan"]}");
        foreach (var p in problems) output.WriteLine($"{p["code"]} {p["phase"]} op={p["op"]} {p["pointer"]} line={p["line"]} blocks={p["blocks"]} :: {p["message"]}");
        foreach (var w in warnings) output.WriteLine($"warning {w["code"]} {w["pointer"]} :: {w["message"]}");
        return (problems, warnings);
    }

    private static JsonObject Html(string html) => new() { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } };
    private static JsonObject Flow(params string[] texts) => new() { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray(texts.Select(t => (JsonNode)t).ToArray()) } };

    // A statement with a key of a read and no basedOn: refused at apply (DDL_BASE_REQUIRED), as in F-FitBody-21/23.
    private const string KeyedDdl = """
        create entity CsSeed label Code ( -- @UQMLFQl1qk6FV7uDhSnKuQ
          Id Long Integer identifier auto required,
          Code Text(50) required
        );

        create entity CsWorkout label Heading (
          Id Long Integer identifier auto required,
          Heading Text(100) required,
          Rank Integer default 0
        );
        """;

    [Fact]
    public void ADocumentSkippedForAFailedDataTextLeavesNothingForTheVerify()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var (problems, _) = Refused(Dir(), new JsonObject
        {
            ["base"] = "mobile-ui.oml",
            ["ops"] = new JsonArray(
                new JsonObject { ["op"] = "spec", ["data"] = new JsonObject { ["ddl"] = KeyedDdl } },
                // Uses CsWorkout: skipped after the data text fails.
                Html("""
                    <screen name="CsWorkouts" flow="MainFlow" actions="GoHome">
                    <aggregate name="GetWorkouts" from="CsWorkout" where="CsWorkout.Rank > 0" sort="CsWorkout.Rank"/>
                    <div class="cs-list" list="GetWorkouts.List">
                     <div class="cs-item" onclick="GoHome">{{ GetWorkouts.List.Current.CsWorkout.Heading }}</div>
                    </div>
                    </screen>
                    """),
                // Independent of the data text: it runs, and its compile prepares every page of the job (the skipped one too).
                Html("""
                    <screen name="CsHome" flow="MainFlow">
                    <div class="cs-home">Home</div>
                    </screen>
                    """),
                Flow("action CsWorkouts.GoHome\n  navigate CsHome()\n")),
        });
        // The one real cause, at its line.
        Assert.Single(problems, p => p["code"]!.ToString() == "DDL_BASE_REQUIRED");
        // Nothing of the skipped page reaches the Verify.
        Assert.DoesNotContain(problems, p => p["code"]!.ToString() is "InvalidDataSet_NoEntity" or "ExpressionUnknownObject" or "RequiredPropertyValue_Property");
        Assert.All(problems, p => Assert.NotEqual("verify", p["phase"]?.ToString()));
    }

    [Fact]
    public void ABlockWhoseContentFailsKeepsItsShellSoTheScreenThatUsesItAndItsActionsAreJudgedInTheSameRefusal()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var (problems, warnings) = Refused(Dir(), new JsonObject
        {
            ["base"] = "mobile-ui.oml",
            ["ops"] = new JsonArray(
                // The content fails (a block nothing has, said by the compile); the block, its input and its action shell stay.
                Html("""
                    <block name="CsNav" flow="MainFlow" actions="Go">
                    <input name="Active" type="Integer"/>
                    <div class="cs-nav" onclick="Go"><Block name="CsNoSuchBlock"/></div>
                    </block>
                    """),
                // Uses the block: compiled in the same round, with its own fault.
                Html("""
                    <screen name="CsHome" flow="MainFlow">
                    <Block name="CsNav" :Active="1"/>
                    <div class="cs-home">{{ CsMissingB }}</div>
                    </screen>
                    """),
                // The action of the block: filled in its shell, its Verify in the same round.
                Flow("action CsNav.Go\n  local Count: Integer\n  assign Count = \"abc\"\n")),
        });
        var codes = problems.Select(p => p["code"]!.ToString()).ToList();
        Assert.Contains(problems, p => p["op"]?.ToString() == "0" && (p["message"]?.ToString() ?? "").Contains("CsNoSuchBlock"));
        Assert.Contains(problems, p => p["op"]?.ToString() == "1" && (p["message"]?.ToString() ?? "").Contains("CsMissingB"));
        Assert.Contains(problems, p => p["op"]?.ToString() == "2" && p["phase"]?.ToString() == "verify");
        Assert.DoesNotContain(warnings, w => w["code"]!.ToString() == "APPLY_SKIPPED");
    }

    [Fact]
    public void ABlockWhoseContentFailsKeepsThePlaceholderOfItsContainerSoTheScreenFillsItInTheSameRefusal()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        // C-50: a placeholder the document puts in a container is moved there from the block's root, and the platform's move
        // recreates it; the shell of a refused block kept the deleted one, so the container took the placeholder with it and
        // the screen that fills it got a problem of its own ("the block CsCard has no placeholder 'Body'").
        var (problems, _) = Refused(Dir(), new JsonObject
        {
            ["base"] = "mobile-ui.oml",
            ["ops"] = new JsonArray(
                Html("""
                    <block name="CsCard" flow="MainFlow">
                    <div class="cs-card"><placeholder name="Body"/><Block name="CsNoSuchBlock"/></div>
                    </block>
                    """),
                Html("""
                    <screen name="CsUsesCard" flow="MainFlow">
                    <Block name="CsCard"><slot name="Body"><p>Inside the card</p></slot></Block>
                    <div class="cs-after">{{ CsMissingC }}</div>
                    </screen>
                    """)),
        });
        Assert.Contains(problems, p => p["op"]?.ToString() == "0" && (p["message"]?.ToString() ?? "").Contains("CsNoSuchBlock"));
        Assert.Contains(problems, p => p["op"]?.ToString() == "1" && (p["message"]?.ToString() ?? "").Contains("CsMissingC"));
        Assert.DoesNotContain(problems, p => (p["message"]?.ToString() ?? "").Contains("no placeholder"));
    }

    /// <summary>F-FitBody-21/23: the patch round ran the job with the refusal's patch of the data text (its read, without the
    /// entities the text created), and the calls of their entity actions came back as CALL_UNKNOWN problems "the refusal could
    /// not see". A problem of the round naming what a patch dropped is that patch's: never added, and a patch that drops work of
    /// the job is never offered.</summary>
    [Fact]
    public void ThePatchRoundNeverAddsWhatAPatchDroppedFromTheJob()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Dir();
        var host = new ModelHost(Path.Combine(dir, "work"));
        // A base with an entity, read by its key (the statement of the job names it as a read).
        var setup = Path.Combine(dir, "setup.json");
        File.WriteAllText(setup, new JsonObject { ["base"] = "mobile-ui.oml", ["ops"] = new JsonArray(
            new JsonObject { ["op"] = "spec", ["data"] = new JsonObject { ["ddl"] = "create entity CsSeed label Code (\n  Id Long Integer identifier auto required,\n  Code Text(50) required\n);\n" } },
            new JsonObject { ["op"] = "get", ["target"] = "IServerEntity:CsSeed" }) }.ToJsonString());
        var baseline = Path.Combine(dir, "work", "baseline.oml");
        var prepared = System.Text.Json.JsonSerializer.SerializeToNode(JobRunner.Run(host, null, setup, baseline))!;
        var key = prepared["results"]!.AsArray().Last()!["result"]!["key"]!.ToString();
        var ddl = $"create entity CsSeed label Code ( -- @{key}\n  Id Long Integer identifier auto required,\n  Code Text(50) required\n);\n\n"
            + "create entity CsWorkout label Heading (\n  Id Long Integer identifier auto required,\n  Heading Text(100) required\n);\n";
        var job = Path.Combine(dir, "job.json");
        File.WriteAllText(job, new JsonObject { ["ops"] = new JsonArray(
            new JsonObject { ["op"] = "spec", ["data"] = new JsonObject { ["ddl"] = ddl } },
            Flow("server action CsAddWorkout\n  in Heading: Text\n  local Item: CsWorkout\n  assign\n    Item.Heading = Heading\n  Saved = CreateCsWorkout(Source=Item)\n")) }.ToJsonString());
        var error = Assert.ThrowsAny<Exception>(() => JobRunner.Run(host, baseline, job, Path.Combine(dir, "out.oml")));
        var problems = (Errors.Envelope("apply", error, 1)["problems"] as JsonArray ?? []).OfType<JsonObject>().ToList();
        foreach (var p in problems) output.WriteLine($"{p["code"]} {p["phase"]} op={p["op"]} {p["pointer"]} afterPatch={p["afterPatch"]} patch={(p["patch"] is JsonArray a ? a.Count : 0)} :: {p["message"]} || {p["fix"]}");
        var root = Assert.Single(problems, p => p["code"]!.ToString() == "DDL_BASE_REQUIRED");
        // Nothing the patch dropped comes back as a problem of the job.
        Assert.DoesNotContain(problems, p => p["afterPatch"]?.GetValue<bool>() == true);
        Assert.DoesNotContain(problems, p => p["code"]!.ToString() == "CALL_UNKNOWN");
        // A patch still offered for the data text keeps every entity the job declared.
        if (root["patch"] is JsonArray { Count: > 0 } patch)
            Assert.All(patch.OfType<JsonObject>().Where(s => s["path"]?.ToString() == "/ops/0/data/ddl"), s => Assert.Contains("CsWorkout", s["value"]?.ToString() ?? ""));
    }

    [Fact]
    public void ATraditionalDocumentSaysEveryElementThePlatformRefusesEachAtItsLine()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        // F-FT-18: an If inside a Link and a List Records inside a Container, each refused by the platform at its create.
        var (problems, _) = Refused(Dir(), new JsonObject
        {
            ["base"] = "traditional-ui.oml",
            ["ops"] = new JsonArray(Html("""
                <screen name="CsRefused">
                <var name="Shown" type="Boolean" default="True"/>
                <a class="cs-a"><div if="Shown">first</div></a>
                <div class="cs-ok">fine</div>
                <a class="cs-b"><div if="Shown">second</div></a>
                </screen>
                """)),
        });
        var lines = problems.Where(p => p["op"]?.ToString() == "0").Select(p => p["line"]?.ToString()).ToList();
        Assert.True(problems.Count(p => p["op"]?.ToString() == "0") >= 2, "both refused elements, in one refusal");
        Assert.Contains("3", lines);
        Assert.Contains("5", lines);
    }
}
