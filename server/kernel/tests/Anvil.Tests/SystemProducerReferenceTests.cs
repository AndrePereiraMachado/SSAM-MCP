using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>fix/system-reference (owner, 2026-10-15): a delivery that adds a reference to a (System) element never fails. The
/// Studio lists the system producer as "(System)"; a job may name it "(System)", "System" or any casing, and they are one
/// producer bound as System. Before the fix the kernel read "(System)" as a file path and refused it with "points to an OML
/// outside tests/fixtures and outside the SSAM capture folders" (JobSources.Resolve: IsBindingName rejected the parentheses),
/// the refusal of the incident of 15/10 (proof folder friction records 188556f1, 106f0a39, aa28f054, 5751f26c, 22cc6ea3).</summary>
public sealed class SystemProducerReferenceTests
{
    private static readonly string Root = FindRoot();
    private static readonly string JobDir = Path.Combine(Root, "tests", "jobs");
    private static string Fixture => Path.Combine(Root, "tests", "fixtures", "blank-service.oml");

    [Theory]
    [InlineData("(System)")]
    [InlineData("System")]
    [InlineData("system")]
    [InlineData("(system)")]
    [InlineData("( System )")]
    public void TheSystemProducerAsTheStudioListsItResolvesToItsBinding(string spec)
    {
        foreach (var binding in new[] { "System=" + Fixture, "(System)=" + Fixture })
            Assert.Equal(Fixture, JobSources.Resolve(spec, JobDir, "producer", JobSources.ParseBindings([binding])).Path);
        // The ODC CLI keeps the --producer keys as given.
        Assert.Equal(Fixture, JobSources.Resolve(spec, JobDir, "producer", new Dictionary<string, string> { ["(System)"] = Fixture }).Path);
    }

    [Fact]
    public void AnUnboundSystemProducerNamesItsCaptureNeverTheFixtureFolders()
    {
        var error = Assert.Throws<ArgumentException>(() => JobSources.Resolve("(System)", JobDir, "producer")).Message;
        Assert.StartsWith("producer (System) not bound", error);
        Assert.DoesNotContain("outside tests/fixtures", error);
        Assert.Contains("captureProducers:[\"System=(System)\"]", error);
        Assert.Contains("studio_deliver: by itself from the consumer session, as \"(System)\"", error);
        Assert.Contains("producers {\"System\":", error);
        var users = Assert.Throws<ArgumentException>(() => JobSources.Resolve("Users", JobDir, "producer")).Message;
        Assert.StartsWith("producer Users not bound", users);
        Assert.Contains("captureProducers:[\"Users\"]", users);
    }

    [Fact]
    public void BindingsOfOneProducerInTwoSpellingsAreOneBinding()
    {
        Assert.Equal("System", JobSources.ParseBindings(["(System)=a.avsig"]).Keys.Single());
        Assert.Throws<ArgumentException>(() => JobSources.ParseBindings(["(System)=a.avsig", "System=b.avsig"]));
        // Round 2 (H1): a name that is no identifier binds by its letters and digits ("(Sys tem)" and "((System))" are System);
        // only a value with no letter or digit, or with / or \, is no binding name.
        foreach (var named in new[] { "(Sys tem)=a.avsig", "((System))=a.avsig" })
            Assert.Equal("System", JobSources.ParseBindings([named]).Keys.Single());
        foreach (var invalid in new[] { "()=a.avsig", "-=a.avsig", @"..\System=a.avsig" })
            Assert.Throws<ArgumentException>(() => JobSources.ParseBindings([invalid]));
    }

    [Fact]
    public void ACapturedSignatureOfTheCaptureFoldersIsAProducerSourceNeverABase()
    {
        var workspace = Path.GetDirectoryName(Root)!;
        var capture = Path.Combine(workspace, "platforms", "odc", "snapshots", "System-producer.avsig");
        Assert.True(JobSources.IsCapturePath(capture, Root));
        Assert.Equal(capture, JobSources.FixturePath(capture, JobDir, "producer"));
        Assert.Contains("outside tests/fixtures", Assert.Throws<ArgumentException>(() => JobSources.FixturePath(capture, JobDir, "base")).Message);
        var loose = Path.Combine(Path.GetTempPath(), "System.avsig");
        Assert.Contains("outside tests/fixtures", Assert.Throws<ArgumentException>(() => JobSources.FixturePath(loose, JobDir, "producer")).Message);
    }

    [Theory]
    [InlineData("System", "System", "(System)")]
    [InlineData("(System)", "System", "(System)")]
    [InlineData("system", "system", "(System)")]
    [InlineData("System=(System)", "System", "(System)")]
    [InlineData("Users", "Users", "Users")]
    [InlineData("Lib=Library", "Lib", "Library")]
    public void ACaptureEntryCapturesTheProducerTheStudioLists(string entry, string binding, string producer)
        => Assert.Equal((binding, producer), ProducerSignatures.ParseCapture(entry));

    [Fact]
    public void TheElementsOfAProducerAreFoundByItsBindingKey()
    {
        var dir = Scratch();
        var job = Path.Combine(dir, "job.json");
        File.WriteAllText(job, """
            {"ops":[{"op":"reference","producer":"(System)","elements":["IServerActionSignature:ListAppendAll"]},
                    {"op":"reference","producer":"System","elements":["IServerActionSignature:ListAppend"]}]}
            """);
        Assert.Equal(["IServerActionSignature:ListAppendAll", "IServerActionSignature:ListAppend"], ProducerSignatures.ReferencedElements(job, "System"));
        Assert.Equal(2, ReferenceClosure.ReferenceOps(job).Single().Elements.Count);
    }

    [Fact]
    public void AnElementTypeWithoutItsInterfacePrefixIsTheSameFamily()
    {
        Assert.Equal("client-action", NativeReferenceKinds.ForType("ClientAction")?.Kind);
        Assert.Equal("client-action", NativeReferenceKinds.ForType("IClientAction")?.Kind);
        Assert.Equal("action", NativeReferenceKinds.ForType("ServerAction")?.Kind);
        Assert.Equal("image", NativeReferenceKinds.ForType("Image")?.Kind);
        Assert.Null(NativeReferenceKinds.ForType("Bogus"));
        Assert.Null(NativeReferenceKinds.ForType("clientAction"));
    }

    // O11 parity: the same job shape as the ODC incident (a reference to (System) ListAppendAll), headless, on the committed
    // fixture, bound to a (System) signature regenerated from the consumers' own references (SignatureFixtures, offline
    // evidence), in each spelling of the name.
    private const string SystemKey = "uXCIR2Atc0+es3zYuZSnNw";

    [Fact]
    public void AnO11JobReferencingSystemListAppendAllIsAcceptedInEachSpelling()
    {
        StudioAssemblies.Bind();
        RunO11();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void RunO11()
    {
        var work = Scratch();
        var host = new ModelHost(work);
        var signature = Path.Combine(work, "System.avsig");
        var fixture = SignatureFixtures.FromConsumers(host, [Fixture, Path.Combine(Root, "tests", "fixtures", "reactive-ui.oml")], SystemKey,
            ["IServerActionSignature:ListAppendAll"], isSystem: true, environment: "lab.example");
        fixture.Snapshot.Write(signature);
        foreach (var (spec, binding) in new[] { ("(System)", "System"), ("System", "(System)"), ("system", "System"), ("(System)", "(System)") })
        {
            var job = Path.Combine(work, Guid.NewGuid().ToString("N") + ".json");
            var output = Path.ChangeExtension(job, ".oml");
            File.WriteAllText(job, new JsonObject { ["ops"] = new JsonArray(
                new JsonObject { ["op"] = "reference", ["producer"] = spec, ["elements"] = new JsonArray("ServerAction:ListAppendAll") },
                new JsonObject { ["op"] = "find", ["name"] = "ListAppendAll", ["type"] = "IServerActionSignature" }) }.ToJsonString());
            var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, Fixture, job, output, bindings: JobSources.ParseBindings([binding + "=" + signature])))!;
            Assert.True(result["accepted"]!.GetValue<bool>(), spec + " / " + binding + ": " + result["details"]?.ToJsonString());
            var reference = result["results"]![0]!["result"]!;
            Assert.Equal("(System)", reference["producer"]!.ToString());
            Assert.True(reference["system"]!.GetValue<bool>());
            Assert.NotEmpty(result["results"]![1]!["result"]!.AsArray());
            Assert.Empty(result["validation"]!["new"]!.AsArray());
        }
    }

    private static string Scratch()
    {
        var dir = Path.Combine(Root, ".local", "system-producer-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(SystemProducerReferenceTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir!;
    }
}
