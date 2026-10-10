using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Xml.Linq;
using Anvil.Xif;
using Xunit;

namespace Anvil.Tests;

/// <summary>XifPackage: a synthetic zlib XIF goes back to the spec (structures, actions, parameter keys, the Mss bodies of the
/// main source, resource sha256); a stream that is not zlib, one that inflates beyond the limit and one without the
/// Extension root are refused.</summary>
public sealed class XifPackageTests
{
    [Fact]
    public void ASyntheticXifReadsBackToTheSpecWithKeysBodiesAndHashes()
    {
        var source = File.ReadAllText(Path.Combine(XifCompilerTests.Fixtures, "current", "ZZHybridXifLab.cs"));
        var notes = Encoding.UTF8.GetBytes("synthetic notes");
        var xml = XifSynthetic.Extension("ZZHybridXifLab", "ext-key-1",
            [XifSynthetic.Structure("Pair", "s-pair", XifSynthetic.Attribute("Left", "a-left", "rtLongInteger", mandatory: true), XifSynthetic.Attribute("When", "a-when", "rtDateTime"))],
            [
                XifSynthetic.Action("Add", "act-add", false, XifSynthetic.Input("Left", "p-left", "rtInteger"), XifSynthetic.Input("Right", "p-right", "rtInteger"), XifSynthetic.Output("Result", "p-result", "rtInteger")),
                XifSynthetic.Action("Echo", "act-echo", false, XifSynthetic.Input("Value", "p-value", "rtText", mandatory: false), XifSynthetic.Output("Echoed", "p-echoed", "rtRecordList", "s-pair,")),
            ],
            [XifSynthetic.Resource("\\Source\\NET\\", "ZZHybridXifLab.cs", Encoding.UTF8.GetBytes(source)), XifSynthetic.Resource("\\Resources\\", "notes.txt", notes, "Binaries")]);
        var raw = XifPackage.Pack(xml);
        Assert.Equal(raw, XifPackage.Pack(xml));            // deterministic
        var document = XifPackage.Read(raw);
        Assert.Equal(("ZZHybridXifLab", "ext-key-1", "model-hash-1"), (document.Name, document.Key, document.Hash));
        Assert.Equal(Convert.ToHexString(SHA256.HashData(raw)).ToLowerInvariant(), document.Sha256);
        var spec = document.Spec();
        Assert.Equal("Pair", spec["structures"]![0]!["name"]!.ToString());
        Assert.Equal("LongInteger", spec["structures"]![0]!["attributes"]![0]!["type"]!.ToString());
        Assert.True(spec["structures"]![0]!["attributes"]![0]!["mandatory"]!.GetValue<bool>());
        var add = spec["actions"]![0]!;
        Assert.Equal(("Add", "act-add"), (add["name"]!.ToString(), add["key"]!.ToString()));
        Assert.Equal(["p-left", "p-right"], add["inputs"]!.AsArray().Select(p => p!["key"]!.ToString()));
        Assert.Equal("p-result", add["outputs"]![0]!["key"]!.ToString());
        Assert.Equal("ssResult = ssLeft - ssRight; // wrong on purpose: the spec fixes it", add["body"]!.ToString());
        Assert.Equal("ssEchoed   =   ssValue + \"!\"; // untouched body", spec["actions"]![1]!["body"]!.ToString());
        Assert.Equal("Pair List", spec["actions"]![1]!["outputs"]![0]!["type"]!.ToString());
        Assert.False(spec["actions"]![1]!["inputs"]![0]!["mandatory"]!.GetValue<bool>());
        var resource = document.Resources.Single(r => r.Filename == "notes.txt");
        Assert.Equal(Convert.ToHexString(SHA256.HashData(notes)).ToLowerInvariant(), resource.Sha256);
        Assert.Equal("Resources\\notes.txt", resource.RelativePath);
        var described = document.Describe();
        Assert.Equal(document.SignatureHash, described["signatureHash"]!.ToString());
        Assert.DoesNotContain("must-never-leave", described.ToJsonString());   // ActivationCode is never read out
        // A body-only change keeps the signature hash; a new input changes it.
        var bodyOnly = XifPackage.Read(XifPackage.Pack(XifSynthetic.Extension("ZZHybridXifLab", "ext-key-1",
            [XifSynthetic.Structure("Pair", "s-pair", XifSynthetic.Attribute("Left", "a-left", "rtLongInteger", mandatory: true), XifSynthetic.Attribute("When", "a-when", "rtDateTime"))],
            [
                XifSynthetic.Action("Add", "act-add", false, XifSynthetic.Input("Left", "p-left", "rtInteger"), XifSynthetic.Input("Right", "p-right", "rtInteger"), XifSynthetic.Output("Result", "p-result", "rtInteger")),
                XifSynthetic.Action("Echo", "act-echo", false, XifSynthetic.Input("Value", "p-value", "rtText", mandatory: false), XifSynthetic.Output("Echoed", "p-echoed", "rtRecordList", "s-pair,")),
            ], [])));
        Assert.Equal(document.SignatureHash, bodyOnly.SignatureHash);
    }

    [Fact]
    public void NotZlibTooLargeAndAnotherRootAreRefused()
    {
        var notZlib = Assert.Throws<XifRefusal>(() => XifPackage.Read(Encoding.ASCII.GetBytes("not-zlib at all")));
        Assert.Equal(XifCodes.PackageInvalid, notZlib.Code);
        Assert.Contains("zlib", notZlib.Message);
        var valid = XifPackage.Pack(XifSynthetic.Extension("ZZHybridXifLab", "k", [], [XifSynthetic.Action("Run", "a", false)], []));
        var tooLarge = Assert.Throws<XifRefusal>(() => XifPackage.Read(valid, inflatedLimit: 64));
        Assert.Contains("inflates to more than 64 bytes", tooLarge.Message);
        var other = XifPackage.Pack(new XDocument(new XElement("Module", new XAttribute("Name", "X"))));
        Assert.Contains("not Extension", Assert.Throws<XifRefusal>(() => XifPackage.Read(other)).Message);
        var dtd = Compress("<?xml version=\"1.0\"?><!DOCTYPE Extension [<!ENTITY x \"y\">]><Extension Name=\"A\">&x;</Extension>");
        Assert.Equal(XifCodes.PackageInvalid, Assert.Throws<XifRefusal>(() => XifPackage.Read(dtd)).Code);
        var unsafePath = XifPackage.Pack(XifSynthetic.Extension("ZZHybridXifLab", "k", [], [], [XifSynthetic.Resource("\\..\\..\\", "evil.dll", [1])]));
        Assert.Contains("unsafe resource path", Assert.Throws<XifRefusal>(() => XifPackage.Read(unsafePath)).Message);
    }

    [Fact]
    public void TheAuditOfAFinalXifFindsAForeignDllAPlatformDllAndAProfilePath()
    {
        var dll = new byte[] { 1, 2, 3 };
        var xml = XifSynthetic.Extension("ZZHybridXifLab", "k", [], [XifSynthetic.Action("Run", "a", false)],
        [
            XifSynthetic.Resource("\\Source\\NET\\Bin\\", "OutSystems.NssZZHybridXifLab.dll", dll, "Binaries"),
            XifSynthetic.Resource("\\Source\\NET\\Bin\\", "OutSystems.HubEdition.RuntimePlatform.dll", [9]),
            XifSynthetic.Resource("\\Source\\NET\\", "ZZHybridXifLab.csproj", Encoding.UTF8.GetBytes("<HintPath>C:\\Users\\someone\\lib.dll</HintPath>")),
        ]);
        var document = XifPackage.Read(XifPackage.Pack(xml));
        Assert.Empty(document.Audit(Convert.ToHexString(SHA256.HashData(dll)).ToLowerInvariant(), [], []));
        var problems = document.Audit(new string('0', 64), ["C:\\deps\\OutSystems.HubEdition.RuntimePlatform.dll"], ["C:\\Users\\someone"]);
        Assert.Equal([XifCodes.VerifyFailed, XifCodes.DependencyOverride, XifCodes.VerifyFailed], problems.Select(p => p.Code).ToArray());
    }

    [Fact]
    public void AnExtensionDllThatIsNotDeployedAsBinariesIsRefused()
    {
        // 2026-10-07: the engine saved the DLL with CompileAction Ignore; the extension published, and every consumer failed
        // at 1-Click Publish with CS0006 (the platform deploys only Binaries resources).
        var dll = new byte[] { 1, 2, 3 };
        var xml = XifSynthetic.Extension("ZZHybridXifLab", "k", [], [XifSynthetic.Action("Run", "a", false)],
            [XifSynthetic.Resource("\\Source\\NET\\Bin\\", "OutSystems.NssZZHybridXifLab.dll", dll, "Ignore")]);
        var problem = Assert.Single(XifPackage.Read(XifPackage.Pack(xml)).Audit(Convert.ToHexString(SHA256.HashData(dll)).ToLowerInvariant(), [], []));
        Assert.Equal(XifCodes.VerifyFailed, problem.Code);
        Assert.Contains("not Binaries", problem.Message);
    }

    private static byte[] Compress(string text)
    {
        var output = new MemoryStream();
        using (var z = new ZLibStream(output, CompressionLevel.Optimal, true)) z.Write(Encoding.UTF8.GetBytes(text));
        return output.ToArray();
    }
}

/// <summary>Synthetic XIF XML in the observed layout (Extension root; Structures, Actions/Variables, Resources/Data).</summary>
internal static class XifSynthetic
{
    public static XDocument Extension(string name, string key, IEnumerable<XElement> structures, IEnumerable<XElement> actions, IEnumerable<XElement> resources, string hash = "model-hash-1") =>
        new(new XElement("Extension",
            new XAttribute("Key", key), new XAttribute("Name", name), new XAttribute("Hash", hash), new XAttribute("ApplicationServerType", "NET"),
            new XAttribute("Version", "11.14.25.0"), new XAttribute("ActivationCode", "must-never-leave"),
            new XElement("Resources", resources), new XElement("Actions", actions), new XElement("Structures", structures), new XElement("Entities")));

    public static XElement Structure(string name, string key, params XElement[] attributes) =>
        new("Structure", new XAttribute("Key", key), new XAttribute("Name", name), new XAttribute("Description", ""), attributes);

    public static XElement Attribute(string name, string key, string type, string recordType = "", bool mandatory = false) =>
        new("Attribute", new XAttribute("Key", key), new XAttribute("Name", name), new XAttribute("Type", type), new XAttribute("RecordType", recordType),
            new XAttribute("IsMandatory", mandatory ? "Yes" : "No"), new XAttribute("DefaultValue", ""), new XAttribute("Length", "50"), new XAttribute("Decimals", ""));

    public static XElement Action(string name, string key, bool function, params XElement[] parameters) =>
        new("Action", new XAttribute("Key", key), new XAttribute("Name", name), new XAttribute("IsFunction", function ? "Yes" : "No"), new XElement("Variables", parameters));

    public static XElement Input(string name, string key, string type, string recordType = "", bool mandatory = true) =>
        new("InputParameter", new XAttribute("Key", key), new XAttribute("Name", name), new XAttribute("Type", type), new XAttribute("RecordType", recordType),
            new XAttribute("IsMandatory", mandatory ? "Yes" : "No"), new XAttribute("Default", ""));

    public static XElement Output(string name, string key, string type, string recordType = "") =>
        new("OutputParameter", new XAttribute("Key", key), new XAttribute("Name", name), new XAttribute("Type", type), new XAttribute("RecordType", recordType));

    public static XElement Resource(string path, string filename, byte[] data, string compileAction = "Ignore") =>
        new("Resource", new XAttribute("Key", "r-" + filename), new XAttribute("Path", path), new XAttribute("Filename", filename),
            new XAttribute("CompileAction", compileAction), new XAttribute("CodeReference", "No"), new XElement("Data", Convert.ToBase64String(data)));
}
