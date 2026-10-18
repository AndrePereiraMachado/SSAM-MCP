using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>fix/system-reference round 3 (review C:\t\revisoes\system-ref-2, H1-R and M5). H1-R: a producer listed with / or \
/// in its name ("Wright/Flood Lib") binds by its EXACT text only: to a capture bound by the letters and digits of the listed
/// name (--producer WrightFloodLib=...) whose envelope names exactly that producer. Its letters alone never bind it, so
/// "..\System" never binds the System capture. M5: the system shortcut ("System" is "(System)") is only for a name that IS
/// "System" without its outer spaces and parentheses, never for one that only shares its letters ("System.").</summary>
public sealed class SystemReferenceRound3Tests
{
    private static readonly string Root = FindRoot();
    private static readonly string JobDir = Path.Combine(Root, "tests", "jobs");

    private static string Capture(string dir, string file, string listedName)
    {
        var path = Path.Combine(dir, file);
        File.WriteAllText(path, new JsonObject { ["FormatVersion"] = 2, ["Name"] = listedName }.ToJsonString());
        return path;
    }

    [Theory]
    [InlineData("Wright/Flood Lib")]
    [InlineData(" Wright/Flood Lib ")]
    [InlineData("wright/flood lib")]
    public void ANameListedWithASeparatorBindsToTheCaptureOfExactlyThatProducer(string spec)
    {
        var dir = Scratch();
        var exact = Capture(dir, "WrightFloodLib.avsig", "Wright/Flood Lib");
        Assert.Equal(exact, JobSources.Resolve(spec, JobDir, "producer", JobSources.ParseBindings(["WrightFloodLib=" + exact])).Path);
        Assert.True(JobSources.SameProducer(spec, "WrightFloodLib"));
    }

    [Theory]
    [InlineData(@"..\System", "System", "(System)")]
    [InlineData("a/System", "aSystem", "aSystem")]
    [InlineData("Wright/Flood Lib", "WrightFloodLib", "WrightFloodLib")]
    [InlineData("Wright/Flood Lib", "WrightFloodLib", "Wright Flood Lib")]
    public void ANameWithASeparatorNeverBindsByItsLetters(string spec, string key, string listedName)
    {
        var dir = Scratch();
        var other = Capture(dir, key + ".avsig", listedName);
        var error = Assert.Throws<ArgumentException>(() => JobSources.Resolve(spec, JobDir, "producer", JobSources.ParseBindings([key + "=" + other]))).Message;
        Assert.StartsWith("producer '" + spec + "' is not a producer name", error);
        Assert.Contains("a name with / or \\ binds only to a capture", error);
        Assert.DoesNotContain("points to an OML", error);
        // A producer OML (no envelope to name it) never binds a separated name either.
        var oml = Path.Combine(Root, "tests", "fixtures", "blank-service.oml");
        Assert.Throws<ArgumentException>(() => JobSources.Resolve(spec, JobDir, "producer", JobSources.ParseBindings([key + "=" + oml])));
    }

    [Theory]
    [InlineData("Wright/Flood Lib", "WrightFloodLib", "Wright/Flood Lib")]
    [InlineData(@"Flood\Tools", "FloodTools", @"Flood\Tools")]
    [InlineData("WrightFloodLib=Wright/Flood Lib", "WrightFloodLib", "Wright/Flood Lib")]
    [InlineData(@"..\System", "System", @"..\System")]
    [InlineData("System.", "System", "System.")]
    [InlineData("System", "System", "(System)")]
    [InlineData("(System) ", "System", "(System)")]
    public void ACaptureEntryNamesTheProducerByItsExactTextUnderASafeKey(string entry, string binding, string producer)
        => Assert.Equal((binding, producer), ProducerSignatures.ParseCapture(entry));

    [Fact]
    public void TheSystemShortcutIsOnlyForSystemItself()
    {
        Assert.Equal("(System)", JobSources.StudioName("System"));
        Assert.Equal("(System)", JobSources.StudioName(" (system) "));
        Assert.Equal("System.", JobSources.StudioName("System."));
        Assert.Equal("Sys tem", JobSources.StudioName("Sys tem"));
    }

    [Fact]
    public void TheElementsOfASeparatedProducerAreFoundByItsKey()
    {
        var dir = Scratch();
        var job = Path.Combine(dir, "job.json");
        File.WriteAllText(job, """{"ops":[{"op":"reference","producer":"Wright/Flood Lib","elements":["IServerActionSignature:A"]}]}""");
        Assert.Equal(["IServerActionSignature:A"], ProducerSignatures.ReferencedElements(job, "WrightFloodLib"));
    }

    // O11: the referenceable catalog resolves a separated name only by its exact text.
    [Fact]
    public void AnO11ProducerListedWithASeparatorIsCapturedByItsExactTextOnly()
    {
        var work = Scratch();
        var primitive = SignatureEnvironment.Primitive();
        var stub = SignatureEnvironment.Serving(primitive.Recorded with { Name = "Wright/Flood Lib" }, "Extension");
        using (var session = HeadlessSession.ConnectStudio(stub, "lab.example", null, readOnly: true))
        {
            var result = ProducerSignatureCapture.Capture(session, new SignatureCaptureRequest(" wright/flood lib ", ["IServerActionSignature:CSharpTextCompareOrdinal"], Path.Combine(work, "a.avsig")));
            Assert.Equal("Wright/Flood Lib", result["producer"]!.ToString());
        }
        using (var session = HeadlessSession.ConnectStudio(stub, "lab.example", null, readOnly: true))
        {
            var error = Assert.Throws<SignatureCaptureException>(() =>
                ProducerSignatureCapture.Capture(session, new SignatureCaptureRequest("WrightFlood/Lib", ["IServerActionSignature:CSharpTextCompareOrdinal"], Path.Combine(work, "b.avsig"))));
            Assert.Equal("ProducerNotFound", error.Code);
            Assert.Equal("PRODUCER_UNKNOWN", ((ICodedError)error).Code);
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
        var dir = Path.GetDirectoryName(typeof(SystemReferenceRound3Tests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir!;
    }
}
