using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>fix/system-reference round 2 (review C:\t\revisoes\system-ref, findings H1 and M4). H1: a producer value is a PATH
/// only when it ends in .oml or .avsig or starts with job:; anything else is a NAME, bound by its key (the name itself when it
/// is an identifier, else its letters and digits) and never read from the disk. Before, "OutSystems UI", "Flood-Utils",
/// "System " and the like fell to FixturePath and got the incident's text ("points to an OML outside tests/fixtures ...").
/// M4: an O11 producer the referenceable catalog does not list by that name is resolved by the same rule ("Tools" is
/// "(Tools)"), and one it does not list at all is ONE coded refusal, PRODUCER_UNKNOWN, with the names it does list.</summary>
public sealed class SystemReferenceRound2Tests
{
    private static readonly string Root = FindRoot();
    private static readonly string JobDir = Path.Combine(Root, "tests", "jobs");
    private static string Fixture => Path.Combine(Root, "tests", "fixtures", "blank-service.oml");

    // The spaced, hyphenated and padded names of the review (13 of 25 libraries of a tenant have a space in their name).
    [Theory]
    [InlineData("OutSystems UI", "OutSystemsUI")]
    [InlineData("Flood Utilities", "FloodUtilities")]
    [InlineData("(Flood Utilities)", "FloodUtilities")]
    [InlineData("Flood-Utils", "FloodUtils")]
    [InlineData("System ", "System")]
    [InlineData("(System) ", "System")]
    [InlineData("My_Lib", "My_Lib")]
    public void AProducerNameThatIsNoIdentifierIsANameBoundByItsKey(string spec, string key)
    {
        Assert.Equal(key, JobSources.BindingKey(spec));
        // Bound by the key the facade passes (--producer <key>=<file>), and by the name as written.
        Assert.Equal(Fixture, JobSources.Resolve(spec, JobDir, "producer", JobSources.ParseBindings([key + "=" + Fixture])).Path);
        Assert.Equal(Fixture, JobSources.Resolve(spec, JobDir, "producer", JobSources.ParseBindings([spec + "=" + Fixture])).Path);
        // Unbound: the NotBound text with the capture of each lane, never the path text of the incident.
        var error = Assert.Throws<ArgumentException>(() => JobSources.Resolve(spec, JobDir, "producer")).Message;
        Assert.StartsWith("producer " + spec + " not bound", error);
        Assert.DoesNotContain("points to an OML", error);
        Assert.Contains("producers {\"" + key + "\":", error);
    }

    [Theory]
    [InlineData(@"..\..\fx\System.avsig")]
    [InlineData(@"(System)\..\x.avsig")]
    [InlineData(@"kernel\.local\work\..\..\x.oml")]
    [InlineData("job:missing-job")]
    public void APathStaysAPathAndTheGuardStillRefusesItsEscapes(string spec)
    {
        Assert.Null(JobSources.BindingKey(spec));
        if (spec.StartsWith("job:", StringComparison.Ordinal)) return;
        var error = Assert.Throws<ArgumentException>(() => JobSources.Resolve(spec, JobDir, "producer", JobSources.ParseBindings(["System=" + Fixture]))).Message;
        Assert.Contains("points to an OML outside tests/fixtures", error);
        var absolute = Path.Combine(Path.GetTempPath(), "System.avsig");
        Assert.Contains("points to an OML outside tests/fixtures", Assert.Throws<ArgumentException>(() => JobSources.Resolve(absolute, JobDir, "producer")).Message);
    }

    [Theory]
    [InlineData(@"..\System")]
    [InlineData("a/System")]
    [InlineData("()")]
    [InlineData("-")]
    public void ANameWithASeparatorOrNoLettersNeverBindsAndNeverReadsTheDisk(string spec)
    {
        Assert.Null(JobSources.BindingKey(spec));
        var error = Assert.Throws<ArgumentException>(() => JobSources.Resolve(spec, JobDir, "producer", JobSources.ParseBindings(["System=" + Fixture]))).Message;
        Assert.StartsWith("producer '" + spec + "' is not a producer name", error);
        Assert.DoesNotContain("points to an OML", error);
        Assert.Throws<ArgumentException>(() => JobSources.ParseBindings([spec + "=" + Fixture]));
    }

    [Theory]
    [InlineData("OutSystems UI", "OutSystemsUI", "OutSystems UI")]
    [InlineData("(Flood Utilities)", "FloodUtilities", "(Flood Utilities)")]
    [InlineData("System ", "System", "(System)")]
    [InlineData("OutSystemsUI=OutSystems UI", "OutSystemsUI", "OutSystems UI")]
    public void ACaptureEntryOfASpacedNameCapturesThatProducerUnderItsKey(string entry, string binding, string producer)
        => Assert.Equal((binding, producer), ProducerSignatures.ParseCapture(entry));

    [Fact]
    public void TheElementsOfASpacedProducerAreFoundByItsKey()
    {
        var dir = Scratch();
        var job = Path.Combine(dir, "job.json");
        File.WriteAllText(job, """
            {"ops":[{"op":"reference","producer":"OutSystems UI","elements":["IServerActionSignature:A"]},
                    {"op":"reference","producer":"OutSystemsUI","elements":["IServerActionSignature:B"]}]}
            """);
        Assert.Equal(["IServerActionSignature:A", "IServerActionSignature:B"], ProducerSignatures.ReferencedElements(job, "OutSystemsUI"));
        Assert.Single(ReferenceClosure.ReferenceOps(job));
    }

    // The O11 job of the incident with the padded spelling "(System) ", headless on the committed fixture.
    [Fact]
    public void AnO11JobReferencingSystemWithOuterSpacesIsAccepted()
    {
        StudioAssemblies.Bind();
        RunO11Padded();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void RunO11Padded()
    {
        var work = Scratch();
        var host = new ModelHost(work);
        var signature = Path.Combine(work, "System.avsig");
        SignatureFixtures.FromConsumers(host, [Fixture, Path.Combine(Root, "tests", "fixtures", "reactive-ui.oml")], "uXCIR2Atc0+es3zYuZSnNw",
            ["IServerActionSignature:ListAppendAll"], isSystem: true, environment: "lab.example").Snapshot.Write(signature);
        foreach (var spec in new[] { "(System) ", "System " })
        {
            var job = Path.Combine(work, Guid.NewGuid().ToString("N") + ".json");
            File.WriteAllText(job, new JsonObject { ["ops"] = new JsonArray(
                new JsonObject { ["op"] = "reference", ["producer"] = spec, ["elements"] = new JsonArray("ServerAction:ListAppendAll") }) }.ToJsonString());
            var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, Fixture, job, Path.ChangeExtension(job, ".oml"),
                bindings: JobSources.ParseBindings(["System=" + signature])))!;
            Assert.True(result["accepted"]!.GetValue<bool>(), spec + ": " + result["details"]?.ToJsonString());
            Assert.Equal("(System)", result["results"]![0]!["result"]!["producer"]!.ToString());
        }
    }

    // The listing rule of both lanes (producer-names.mjs resolveListedName): "Tools" is the "(Tools)" the O11 catalog lists.
    [Fact]
    public void AListedNameIsResolvedByTextThenNameThenLettersNeverByAGuess()
    {
        string[] none;
        Assert.Equal("(Tools)", JobSources.ResolveListedName("Tools", ["(System)", "(Tools)", "Users"], out none));
        Assert.Equal("(System)", JobSources.ResolveListedName("system ", ["(System)", "Users"], out none));
        Assert.Equal("OutSystemsUI", JobSources.ResolveListedName("OutSystems UI", ["OutSystemsUI", "Users"], out none));
        Assert.Equal("tools", JobSources.ResolveListedName("Tools", ["(Tools)", "tools"], out none));
        Assert.Null(JobSources.ResolveListedName("Flood-Utils", ["Flood Utils", "FloodUtils."], out var two));
        Assert.Equal(["Flood Utils", "FloodUtils."], two);
        Assert.Null(JobSources.ResolveListedName(@"..\System", ["(System)"], out none));
        Assert.Empty(none);
        Assert.Null(JobSources.ResolveListedName("Sistema", ["(System)"], out none));
    }

    // ---- M4: the O11 referenceable catalog (a stub of the Studio's read-only lease, no Studio, no network).

    [Fact]
    public void AnO11ProducerTheCatalogDoesNotListIsOneCodedRefusalWithEveryListedName()
    {
        var work = Scratch(); var stub = SignatureEnvironment.Primitive();
        var outPath = Path.Combine(work, "refused.avsig");
        using var session = HeadlessSession.ConnectStudio(stub, "lab.example", null, readOnly: true);
        var error = Assert.Throws<SignatureCaptureException>(() =>
            ProducerSignatureCapture.Capture(session, new SignatureCaptureRequest("Sistema", ["IServerActionSignature:CSharpTextCompareOrdinal"], outPath)));
        Assert.Equal("ProducerNotFound", error.Code);
        Assert.Contains("The referenceable catalog lists: " + stub.Recorded.Name, error.Message);
        var coded = Assert.IsAssignableFrom<ICodedError>(error);
        Assert.Equal("PRODUCER_UNKNOWN", coded.Code);
        var problem = Assert.IsType<JsonObject>(Assert.Single(coded.Problems!));
        Assert.Equal("PRODUCER_UNKNOWN", problem["code"]!.ToString());
        Assert.Equal("Sistema", problem["producer"]!.ToString());
        Assert.Equal(stub.Recorded.Name, problem["available"]![0]!.ToString());
        // The CLI envelope (o11_job, o11_deliver) carries the code and the problem.
        var envelope = Errors.Envelope("signature", error, 1);
        Assert.Equal("PRODUCER_UNKNOWN", envelope["code"]!.ToString());
        Assert.Equal("Sistema", envelope["problems"]![0]!["producer"]!.ToString());
        Assert.False(File.Exists(outPath));
        // Any other capture refusal keeps its own envelope: no code is invented for it.
        stub.Active = false;
        var inactive = Assert.Throws<SignatureCaptureException>(() =>
            ProducerSignatureCapture.Capture(session, new SignatureCaptureRequest(stub.Recorded.Name, ["IServerActionSignature:CSharpTextCompareOrdinal"], outPath)));
        Assert.Null(Errors.Envelope("signature", inactive, 1)["code"]);
    }

    [Theory]
    [InlineData("({0})")]
    [InlineData(" {0} ")]
    [InlineData("{0}")]
    public void AnO11ProducerNamedAsTheCatalogListsItOrByItsLettersIsTheListedOne(string form)
    {
        var work = Scratch(); var stub = SignatureEnvironment.Primitive();
        var name = stub.Recorded.Name;
        foreach (var written in new[] { string.Format(form, name), string.Format(form, Spaced(name)) })
        {
            using var session = HeadlessSession.ConnectStudio(stub, "lab.example", null, readOnly: true);
            var outPath = Path.Combine(work, Guid.NewGuid().ToString("N") + ".avsig");
            var result = ProducerSignatureCapture.Capture(session, new SignatureCaptureRequest(written, ["IServerActionSignature:CSharpTextCompareOrdinal"], outPath));
            Assert.Equal(name, result["producer"]!.ToString());
            Assert.True(File.Exists(outPath), written);
        }
    }

    // "ZZHighCodePrimitives" -> "ZZ High Code-Primitives": the same letters and digits, another spelling.
    private static string Spaced(string name)
    {
        var chars = new List<char>();
        for (var i = 0; i < name.Length; i++)
        {
            if (i > 0 && char.IsUpper(name[i]) && char.IsLower(name[i - 1])) chars.Add(i % 2 == 0 ? ' ' : '-');
            chars.Add(name[i]);
        }
        return new string(chars.ToArray());
    }

    private static string Scratch()
    {
        var dir = Path.Combine(Root, ".local", "system-producer-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(SystemReferenceRound2Tests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir!;
    }
}
