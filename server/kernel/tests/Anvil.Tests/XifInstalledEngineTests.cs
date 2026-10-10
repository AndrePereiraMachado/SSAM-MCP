using System.IO.Compression;
using System.Text.Json.Nodes;
using Anvil.Xif;
using Xunit;

namespace Anvil.Tests;

/// <summary>The engine against the INSTALLED Integration Studio, offline (local files only, nothing sent): the model and
/// final stages of XifBuild run through Anvil.Xif.Engine.exe with the synthetic stubs and fake platform DLL of the fixtures,
/// and an unexpected exception inside the engine is XIF_ENGINE_FAILED, never a problem of the spec. Without the engine
/// (ANVIL_XIF_ENGINE or kernel\.local\xif-engine) or without Integration Studio the tests return early: they prove the
/// installation of the machine they run on.</summary>
public sealed class XifInstalledEngineTests
{
    private const string Spec = """
        { "name": "ZZHybridXifLab", "description": "SSAM offline lab extension.",
          "actions": [ { "name": "Add", "description": "Adds two integers.",
            "inputs": [ { "name": "Left", "type": "Integer" }, { "name": "Right", "type": "Integer" } ],
            "outputs": [ { "name": "Result", "type": "Integer" } ],
            "body": "Result = checked(FakeRuntime.Twice(Left) / 2 + Right);" } ] }
        """;

    private const string EditSpec = """
        { "name": "ZZHybridXifLab",
          "actions": [ { "name": "Multiply", "description": "Multiplies two integers.",
            "inputs": [ { "name": "Left", "type": "Integer" }, { "name": "Right", "type": "Integer" } ],
            "outputs": [ { "name": "Result", "type": "Integer" } ],
            "body": "Result = checked(Left * Right);" } ] }
        """;

    // The stubs the environment would generate for the edited model (the layout of fixtures\xif\stubs).
    private const string EditMain = """
        using System;
        using System.Collections;
        using System.Data;
        using OutSystems.HubEdition.RuntimePlatform;
        using OutSystems.RuntimePublic.Db;

        namespace OutSystems.NssZZHybridXifLab {

        	public class CssZZHybridXifLab: IssZZHybridXifLab {

        		public void MssAdd(int ssLeft, int ssRight, out int ssResult) {
        			ssResult = 0;
        			// TODO: Write implementation for action
        		} // MssAdd

        		public void MssMultiply(int ssLeft, int ssRight, out int ssResult) {
        			ssResult = 0;
        			// TODO: Write implementation for action
        		} // MssMultiply

        	} // CssZZHybridXifLab

        } // OutSystems.NssZZHybridXifLab
        """;

    private const string EditInterface = """
        using System;
        using System.Collections;
        using System.Data;

        namespace OutSystems.NssZZHybridXifLab {

        	public interface IssZZHybridXifLab {

        		void MssAdd(int ssLeft, int ssRight, out int ssResult);

        		void MssMultiply(int ssLeft, int ssRight, out int ssResult);

        	} // IssZZHybridXifLab

        } // OutSystems.NssZZHybridXifLab
        """;

    private static string Write(string dir, string name, string text)
    {
        var file = Path.Combine(dir, name);
        File.WriteAllText(file, text);
        return file;
    }

    private static string NewDir(string tag)
    {
        var dir = Path.Combine(Path.GetTempPath(), "anvil-xif-ie-" + tag + "-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(dir);
        return dir;
    }

    /// <summary>True when the engine exists and its probe accepts the installed Integration Studio.</summary>
    private static bool Installed(string work)
    {
        if (!XifEngineClient.Candidates().Any(File.Exists)) return false;
        try { return XifEngineClient.Run(new JsonObject { ["command"] = "probe" }, work)["ok"]?.GetValue<bool>() == true; }
        catch (XifRefusal refusal) when (refusal.Code == XifCodes.EngineUnavailable) { return false; }
    }

    private static string Zip(string file, params (string Entry, string Source)[] entries)
    {
        using var archive = ZipFile.Open(file, ZipArchiveMode.Create);
        foreach (var (entry, source) in entries) archive.CreateEntryFromFile(source, entry);
        return file;
    }

    [Fact]
    public void ModelAndFinalRunOnTheInstalledIntegrationStudio()
    {
        var work = NewDir("build");
        try
        {
            if (!Installed(work)) return;
            var model = XifBuild.Model(JsonNode.Parse(Spec), null, Path.Combine(work, "w"));
            Assert.Equal("ZZHybridXifLab", model["name"]!.ToString());
            Assert.True(model["create"]!.GetValue<bool>());
            Assert.False(string.IsNullOrEmpty(model["key"]?.ToString()));
            Assert.StartsWith("11.", model["engine"]!["version"]!.ToString());
            // The second version of the Handshake is Config.LastUpgradeVersion (11.0.0.200 in 11.14), never the product version.
            var lastUpgrade = model["engine"]!["lastUpgradeVersion"]!.ToString();
            Assert.Matches(@"^\d+\.\d+\.\d+\.\d+$", lastUpgrade);
            Assert.NotEqual(model["engine"]!["version"]!.ToString(), lastUpgrade);

            var fixtures = XifCompilerTests.Fixtures;
            var stubs = Zip(Path.Combine(work, "stubs.zip"), ("ZZHybridXifLab.cs", Path.Combine(fixtures, "stubs", "ZZHybridXifLab.cs")), ("Interface.cs", Path.Combine(fixtures, "stubs", "Interface.cs")));
            var platformDir = Path.Combine(work, "platform");
            Directory.CreateDirectory(platformDir);
            var platform = XifCompilerTests.CompileLibrary(platformDir, "OutSystems.HubEdition.RuntimePlatform", File.ReadAllText(Path.Combine(fixtures, "fake-platform", "OutSystems.HubEdition.RuntimePlatform.cs")));
            var deps = Zip(Path.Combine(work, "deps.zip"), ("OutSystems.HubEdition.RuntimePlatform.dll", platform));

            var final = XifBuild.Final(JsonNode.Parse(Spec), model["xif"]!.ToString(), stubs, deps, null, Path.Combine(work, "w"));
            Assert.Equal("final", final["stage"]!.ToString());
            Assert.Equal(model["key"]!.ToString(), final["key"]!.ToString());
            Assert.Contains("Add", final["changedActions"]!.AsArray().Select(a => a!.ToString()));
            var document = XifPackage.Read(final["xif"]!.ToString());
            Assert.Equal("ZZHybridXifLab", document.Name);
            Assert.Contains(document.Actions, a => a.Name == "Add");
            // The compiled DLL is in the XIF (Audit compared its sha256); the platform DLL is not.
            // Deployed as Integration Studio does (\Source\NET\Bin, Binaries): with Ignore every consumer failed with CS0006.
            Assert.Equal("Binaries", Assert.Single(document.Resources, r => r.Filename == "OutSystems.NssZZHybridXifLab.dll").CompileAction);
            Assert.DoesNotContain(document.Resources, r => r.Filename == "OutSystems.HubEdition.RuntimePlatform.dll");

            // An edit of that extension (the base is loaded by the engine, ProjectLoad's lock in the private TEMP): a new
            // action, the key kept, an additive contract.
            var created = final["xif"]!.ToString();
            var editStubs = Zip(Path.Combine(work, "stubs-edit.zip"),
                ("ZZHybridXifLab.cs", Write(work, "edit-main.cs", EditMain)), ("Interface.cs", Write(work, "edit-interface.cs", EditInterface)));
            // The base where the facade downloads it, inside the same work folder: <work>\base\<name>.xif (the engine copied
            // it onto itself and every edit failed with "in use by another process").
            var editWork = Path.Combine(work, "e");
            var basePath = Path.Combine(editWork, "base", "ZZHybridXifLab.xif");
            Directory.CreateDirectory(Path.GetDirectoryName(basePath)!);
            File.Copy(created, basePath);
            var edited = XifBuild.Model(JsonNode.Parse(EditSpec), basePath, editWork);
            Assert.False(edited["create"]!.GetValue<bool>());
            Assert.Equal(model["key"]!.ToString(), edited["key"]!.ToString());
            var editedFinal = XifBuild.Final(JsonNode.Parse(EditSpec), edited["xif"]!.ToString(), editStubs, deps, basePath, editWork);
            Assert.Equal(model["key"]!.ToString(), editedFinal["key"]!.ToString());
            Assert.False(editedFinal["contractDiff"]!["breaking"]!.GetValue<bool>());
            var editedDocument = XifPackage.Read(editedFinal["xif"]!.ToString());
            Assert.Equal(["Add", "Multiply"], editedDocument.Actions.Select(a => a.Name).OrderBy(n => n, StringComparer.Ordinal));
            Assert.Equal("Binaries", Assert.Single(editedDocument.Resources, r => r.Filename == "OutSystems.NssZZHybridXifLab.dll").CompileAction);

            // An extension published before the fix (its DLL as Ignore), republished with the same spec: the DLL becomes
            // Binaries and the hash changes, so UploadNeeded sends it instead of answering already-running.
            var legacyXml = new System.Xml.Linq.XDocument(XifPackage.Read(created).Xml);
            foreach (var r in legacyXml.Root!.Descendants("Resource").Where(r => (string?)r.Attribute("Filename") == "OutSystems.NssZZHybridXifLab.dll"))
                r.SetAttributeValue("CompileAction", "Ignore");
            var legacyWork = Path.Combine(work, "l");
            var legacyBase = Path.Combine(legacyWork, "base", "ZZHybridXifLab.xif");
            Directory.CreateDirectory(Path.GetDirectoryName(legacyBase)!);
            File.WriteAllBytes(legacyBase, XifPackage.Pack(legacyXml));
            var legacy = XifPackage.Read(legacyBase);
            Assert.Equal("Ignore", legacy.Resources.Single(r => r.Filename == "OutSystems.NssZZHybridXifLab.dll").CompileAction);
            // The model stage keeps the base resources, so its ProjectSave hashes the legacy content (DLL as Ignore); the
            // final stage hashes the same sources and DLL with Binaries. Integration Studio's CalculateExtensionHash is an MD5
            // of the whole Extension element (resources included) without Hash/Generation/LastModifiedUTC/Version, so the
            // deploy mode alone changes it and UploadNeeded asks for the upload.
            var again = XifBuild.Model(JsonNode.Parse(Spec), legacyBase, legacyWork);
            Assert.Equal("Ignore", XifPackage.Read(again["xif"]!.ToString()).Resources.Single(r => r.Filename == "OutSystems.NssZZHybridXifLab.dll").CompileAction);
            var againFinal = XifBuild.Final(JsonNode.Parse(Spec), again["xif"]!.ToString(), stubs, deps, legacyBase, legacyWork);
            Assert.Equal("Binaries", Assert.Single(XifPackage.Read(againFinal["xif"]!.ToString()).Resources, r => r.Filename == "OutSystems.NssZZHybridXifLab.dll").CompileAction);
            Assert.NotEqual(again["hash"]!.ToString(), againFinal["hash"]!.ToString());
        }
        finally { try { Directory.Delete(work, true); } catch (IOException) { } }
    }

    [Fact]
    public void AnUnexpectedEngineExceptionIsEngineFailedNotTheSpec()
    {
        var work = NewDir("fail");
        try
        {
            if (!Installed(work)) return;
            // The work folder of the request is a file: creating the unpack folder throws inside the engine, after the
            // Aggregator and its plugins were created.
            var notADirectory = Path.Combine(work, "a-file");
            File.WriteAllText(notADirectory, "x");
            var request = new JsonObject
            {
                ["command"] = "model", ["work"] = notADirectory, ["output"] = Path.Combine(work, "model", "ZZHybridXifLab.xif"), ["references"] = new JsonArray(),
                ["spec"] = new JsonObject { ["name"] = "ZZHybridXifLab", ["actions"] = new JsonArray() },
            };
            var refusal = Assert.Throws<XifRefusal>(() => XifEngineClient.Run(request, work));
            Assert.Equal(XifCodes.EngineFailed, refusal.Code);
            Assert.Contains("not of the spec", refusal.Message);
            Assert.Equal("model", refusal.Extra!["stage"]!.ToString());
            var frames = refusal.Extra["at"]!.AsArray().Select(f => f!.ToString()).ToList();
            Assert.NotEmpty(frames);
            Assert.All(frames, f => Assert.DoesNotContain(":\\", f));
        }
        finally { try { Directory.Delete(work, true); } catch (IOException) { } }
    }
}
