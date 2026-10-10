using System.ComponentModel;
using System.IO.Compression;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.ExternalLibraries;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>
/// ODC External Libraries, headless (contract INTEGRACOES-GITSSAM, lane extlib): the spec with every problem at once,
/// the generated project byte for byte, the build behind a fake `dotnet` (diagnostics mapped to the action and the line
/// of its body, no SDK, NuGet), the deterministic zip and its gates, the contents diff, and the External Library form of
/// the public signature envelope. No dotnet publish, NuGet feed, Studio session or tenant is touched.
/// </summary>
public class OdcExternalLibraryTests
{
    private static readonly string Root = FindRoot();
    private static readonly string Fixtures = Path.Combine(Root, "tests", "fixtures", "external-library");

    private static ExternalLibrarySpec TextTools() => ExternalLibrarySpec.Read(Path.Combine(Fixtures, "ssam-text-tools.json"));
    private static string Work()
    {
        var dir = Path.Combine(Root, ".local", "lane-odc", "external-library-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }

    // ---- spec
    [Fact]
    public void TheSharedInvalidSpecAnswersExactlyItsFiveProblems()
    {
        var problems = ExternalLibrarySpec.Check(JsonNode.Parse(File.ReadAllText(Path.Combine(Fixtures, "spec-invalid.json"))));
        var expected = JsonNode.Parse(File.ReadAllText(Path.Combine(Fixtures, "spec-invalid.expected.json")))!["problems"]!.AsArray()
            .Select(p => (p!["code"]!.GetValue<string>(), p["path"]!.GetValue<string>())).ToArray();
        Assert.Equal(expected, problems.Select(p => (p.Code, p.Path)).ToArray());
        Assert.All(problems, p => Assert.False(string.IsNullOrWhiteSpace(p.Fix)));
        var refusal = Assert.Throws<ExternalLibraryException>(() => ExternalLibrarySpec.Parse(JsonNode.Parse(File.ReadAllText(Path.Combine(Fixtures, "spec-invalid.json")))));
        Assert.Equal("EXTERNAL_LIBRARY_SPEC_INVALID", refusal.Code);
        Assert.Equal(5, refusal.Problems.Count);
    }

    [Fact]
    public void EverySpecRuleIsReportedInOneRefusal()
    {
        var spec = JsonNode.Parse("""
        {
          "name": "Tools", "namespace": "Bad..Namespace", "sources": [],
          "structures": [
            { "name": "Text", "attributes": [ { "name": "A", "type": "Text" } ] },
            { "name": "Empty", "attributes": [] },
            { "name": "Pair", "attributes": [ { "name": "Key", "type": "Text", "length": -1 }, { "name": "key", "type": "Object" } ] }
          ],
          "actions": [
            { "name": "Tools", "body": "return;" },
            { "name": "class", "inputs": [ { "name": "A", "type": "Text List List" }, { "name": "B", "type": "text" } ], "body": " " },
            { "name": "Pick", "isFunction": true, "outputs": [ { "name": "R", "type": "pair" } ], "body": "R = default;" }
          ],
          "packages": [
            { "name": "OutSystems.ExternalLibraries.SDK", "version": "1.5.0" },
            { "name": "Newtonsoft.Json", "version": "13.*" },
            { "name": "newtonsoft.json", "version": "13.0.3" }
          ],
          "usings": [ "using System.Text;" ]
        }
        """);
        var codes = ExternalLibrarySpec.Check(spec).Select(p => p.Code + " " + p.Path).ToArray();
        foreach (var expected in new[] {
            "FIELD_UNKNOWN /sources", "NAMESPACE_INVALID /namespace", "STRUCTURE_NAME_RESERVED /structures/0/name", "ATTRIBUTES_REQUIRED /structures/1/attributes",
            "NUMBER_INVALID /structures/2/attributes/0/length", "DUPLICATE_NAME /structures/2/attributes/1/name", "TYPE_NOT_SUPPORTED /structures/2/attributes/1/type",
            "ACTION_NAME_IS_LIBRARY /actions/0/name", "IDENTIFIER_INVALID /actions/1/name", "TYPE_UNKNOWN /actions/1/inputs/0/type", "TYPE_UNKNOWN /actions/1/inputs/1/type",
            "BODY_REQUIRED /actions/1/body", "FIELD_UNKNOWN /actions/2/isFunction", "STRUCTURE_UNDECLARED /actions/2/outputs/0/type",
            "SDK_PACKAGE_PINNED /packages/0/name", "PACKAGE_VERSION_INEXACT /packages/1/version", "DUPLICATE_NAME /packages/2/name", "USING_INVALID /usings/0" })
            Assert.Contains(expected, codes);
        Assert.Contains(ExternalLibrarySpec.Check(JsonNode.Parse("{\"name\":\"X\"}")), p => p.Code == "ACTIONS_REQUIRED");
        Assert.Empty(ExternalLibrarySpec.Check(JsonNode.Parse(File.ReadAllText(Path.Combine(Fixtures, "ssam-text-tools.json")))));
    }

    // ---- project
    [Fact]
    public void TheSameSpecGivesTheSameProjectBytesWithNet10AndThePinnedSdk()
    {
        var project = ExternalLibraryProject.Generate(TextTools());
        Assert.Equal(new[] { "ISSAMTextTools.cs", "SSAMTextTools.cs", "SSAMTextTools.csproj", "Structures.cs" }, project.Files.Keys.ToArray());
        Assert.Contains("<TargetFramework>net10.0</TargetFramework>", project.Files["SSAMTextTools.csproj"]);
        Assert.Contains("<PackageReference Include=\"OutSystems.ExternalLibraries.SDK\" Version=\"" + ExternalLibraryProject.SdkVersion + "\" />", project.Files["SSAMTextTools.csproj"]);
        Assert.Equal("1.5.0", ExternalLibraryProject.SdkVersion);
        var golden = Path.Combine(Fixtures, "golden", "SSAMTextTools");
        foreach (var (file, text) in project.Files)
        {
            var path = Path.Combine(golden, file + ".golden");
            if (Environment.GetEnvironmentVariable("ANVIL_WRITE_GOLDEN") == "1") { Directory.CreateDirectory(golden); File.WriteAllBytes(path, new UTF8Encoding(false).GetBytes(text)); continue; }
            Assert.True(File.Exists(path), "missing golden file " + path);
            Assert.Equal(File.ReadAllText(path).Replace("\r\n", "\n"), text);
        }
        var again = ExternalLibraryProject.Generate(TextTools());
        Assert.All(project.Files, f => Assert.Equal(f.Value, again.Files[f.Key]));
        Assert.DoesNotContain('\r', string.Concat(project.Files.Values));
    }

    // The generated C# compiles: the project's sources plus a stand-in of the SDK's public attributes (written here from
    // its documented surface) and the implicit usings, against the running framework. A body error would be CS....
    [Fact]
    public void TheGeneratedSourcesCompileAgainstTheSdkSurface()
    {
        var project = ExternalLibraryProject.Generate(TextTools());
        var trees = project.Files.Where(f => f.Key.EndsWith(".cs")).Select(f => CSharpSyntaxTree.ParseText(f.Value, path: f.Key))
            .Append(CSharpSyntaxTree.ParseText(SdkSurface)).Append(CSharpSyntaxTree.ParseText(ImplicitUsings)).ToArray();
        var references = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!).Split(Path.PathSeparator)
            .Where(p => Path.GetFileName(p).StartsWith("System.") || Path.GetFileName(p) is "mscorlib.dll" or "netstandard.dll")
            .Select(p => MetadataReference.CreateFromFile(p)).ToArray();
        var compilation = CSharpCompilation.Create("SSAMTextTools", trees, references, new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var errors = compilation.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error).Select(d => d.ToString()).ToArray();
        Assert.Empty(errors);
    }
    private const string ImplicitUsings = "global using System; global using System.Collections.Generic; global using System.IO; global using System.Linq; global using System.Net.Http; global using System.Threading; global using System.Threading.Tasks;";
    private const string SdkSurface = """
        namespace OutSystems.ExternalLibraries.SDK {
          public enum OSDataType { InferredFromDotNetType, Text, Integer, LongInteger, Decimal, Boolean, DateTime, Date, Time, PhoneNumber, Email, BinaryData, Currency }
          [System.AttributeUsage(System.AttributeTargets.Interface)] public sealed class OSInterfaceAttribute : System.Attribute { public string Name { get; set; } public string Description { get; set; } public string IconResourceName { get; set; } public string OriginalName { get; set; } }
          [System.AttributeUsage(System.AttributeTargets.Method)] public sealed class OSActionAttribute : System.Attribute { public string Description { get; set; } public string IconResourceName { get; set; } public string ReturnName { get; set; } public string ReturnDescription { get; set; } public OSDataType ReturnType { get; set; } public string OriginalName { get; set; } }
          [System.AttributeUsage(System.AttributeTargets.Parameter)] public sealed class OSParameterAttribute : System.Attribute { public string Description { get; set; } public OSDataType DataType { get; set; } public string OriginalName { get; set; } }
          [System.AttributeUsage(System.AttributeTargets.Struct)] public sealed class OSStructureAttribute : System.Attribute { public string Description { get; set; } public string OriginalName { get; set; } }
          [System.AttributeUsage(System.AttributeTargets.Property | System.AttributeTargets.Field)] public sealed class OSStructureFieldAttribute : System.Attribute { public string Description { get; set; } public int Length { get; set; } public int Decimals { get; set; } public OSDataType DataType { get; set; } public bool IsMandatory { get; set; } public string OriginalName { get; set; } public string DefaultValue { get; set; } }
        }
        """;

    // ---- build behind a fake dotnet
    private sealed class FakeDotnet(Func<ProcessCall, ProcessOutcome> answer) : IProcessRunner
    {
        public List<ProcessCall> Calls { get; } = [];
        public ProcessOutcome Run(ProcessCall call) { Calls.Add(call); return answer(call); }
    }
    private static string Deps(string version) => "{\"runtimeTarget\":{\"name\":\".NETCoreApp,Version=v" + version + "/linux-x64\"},\"targets\":{}}";
    // What a successful publish leaves: the library, its deps.json, the SDK assembly. Fixed bytes, so two builds match.
    private static Func<ProcessCall, ProcessOutcome> Publishes(string depsVersion = "10.0", int extraDeps = 0, int padding = 0) => call =>
    {
        var output = call.Arguments[call.Arguments.ToList().IndexOf("-o") + 1];
        Directory.CreateDirectory(output);
        File.WriteAllBytes(Path.Combine(output, "SSAMTextTools.dll"), Enumerable.Range(0, 2048 + padding).Select(i => (byte)(i * 7)).ToArray());
        File.WriteAllText(Path.Combine(output, "SSAMTextTools.deps.json"), Deps(depsVersion));
        for (var i = 0; i < extraDeps; i++) File.WriteAllText(Path.Combine(output, "Other" + i + ".deps.json"), Deps(depsVersion));
        File.WriteAllBytes(Path.Combine(output, "OutSystems.ExternalLibraries.SDK.dll"), new byte[] { 1, 2, 3 });
        return new ProcessOutcome(0, "SSAMTextTools -> " + output, "", false);
    };

    [Fact]
    public void ABuildIsOneDeterministicPublishAndTheSameZipTwice()
    {
        var spec = TextTools();
        var dotnet = new FakeDotnet(Publishes());
        var first = ExternalLibraryBuild.Build(spec, Path.Combine(Work(), "a"), dotnet);
        var second = ExternalLibraryBuild.Build(spec, Path.Combine(Work(), "b"), dotnet);
        Assert.True(first["ok"]!.GetValue<bool>());
        Assert.Equal(first["package"]!["sha256"]!.GetValue<string>(), second["package"]!["sha256"]!.GetValue<string>());
        Assert.Equal("SSAMTextTools-" + first["package"]!["sha256"]!.GetValue<string>()[..16] + ".zip", first["package"]!["fileName"]!.GetValue<string>());
        Assert.Equal(2, dotnet.Calls.Count); // one dotnet publish per build, nothing else
        var call = dotnet.Calls[0];
        Assert.Equal("dotnet", call.FileName);
        Assert.Equal("publish", call.Arguments[0]);
        Assert.Equal(new[] { "-c", "Release", "-r", "linux-x64", "--self-contained", "false", "-p:Deterministic=true" }, call.Arguments.Skip(2).Take(7).ToArray());
        Assert.Equal("1", call.Environment["DOTNET_CLI_TELEMETRY_OPTOUT"]);
        // Entries in ordinal order, one fixed date.
        using var zip = new ZipArchive(File.OpenRead(first["package"]!["path"]!.GetValue<string>()));
        Assert.Equal(zip.Entries.Select(e => e.FullName).OrderBy(n => n, StringComparer.Ordinal), zip.Entries.Select(e => e.FullName));
        Assert.All(zip.Entries, e => Assert.Equal(1980, e.LastWriteTime.Year));
        Assert.Equal("SSAMTextTools.dll", first["package"]!["mainAssembly"]!.GetValue<string>());
        Assert.Equal(2, first["contents"]!["actions"]!.AsArray().Count);
    }

    [Fact]
    public void CompilerErrorsAreMappedToTheActionAndTheLineOfItsBody()
    {
        var spec = TextTools();
        var project = ExternalLibraryProject.Generate(spec);
        var body = project.Spans.Single(s => s.Kind == "body" && s.Index == 1);
        var dir = @"C:\work\project\";
        var output = $"{dir}SSAMTextTools.cs({body.FirstLine + 1},13): error CS0103: The name 'Wrds' does not exist in the current context [{dir}SSAMTextTools.csproj]\n"
            + $"{dir}SSAMTextTools.cs({body.FirstLine + 1},13): error CS0103: The name 'Wrds' does not exist in the current context [{dir}SSAMTextTools.csproj]\n"
            + $"{dir}Structures.cs(9,5): error CS0246: The type or namespace name 'Strng' could not be found [{dir}SSAMTextTools.csproj]\n";
        var refusal = Assert.Throws<ExternalLibraryException>(() => ExternalLibraryBuild.Build(spec, Work(), new FakeDotnet(_ => new ProcessOutcome(1, output, "", false))));
        Assert.Equal("EXTERNAL_LIBRARY_BUILD_FAILED", refusal.Code);
        Assert.Equal(2, refusal.Problems.Count); // the repeated summary line is one problem
        var first = refusal.Problems[0];
        Assert.Equal(("CS0103", "/actions/1/body", "CountWords", 2, 5), (first.Code, first.Path, first.Target, first.Line, first.Column));
        Assert.Equal(("CS0246", "/structures/0", "WordCount"), (refusal.Problems[1].Code, refusal.Problems[1].Path, refusal.Problems[1].Target));
        Assert.NotNull(refusal.Extra?["log"]);
    }

    [Fact]
    public void NoDotnetOrAnSdkThatCannotTargetNet10IsDotnetSdkMissing()
    {
        var missing = Assert.Throws<ExternalLibraryException>(() => ExternalLibraryBuild.Build(TextTools(), Work(),
            new FakeDotnet(_ => throw new Win32Exception(2, "The system cannot find the file specified"))));
        Assert.Equal("DOTNET_SDK_MISSING", missing.Code);
        Assert.Contains(".NET 10 SDK", missing.Problems[0].Fix);
        var old = Assert.Throws<ExternalLibraryException>(() => ExternalLibraryBuild.Build(TextTools(), Work(), new FakeDotnet(_ => new ProcessOutcome(1,
            @"C:\Program Files\dotnet\sdk\8.0.400\Sdks\Microsoft.NET.Sdk\targets\Microsoft.NET.TargetFrameworkInference.targets(166,5): error NETSDK1045: The current .NET SDK does not support targeting .NET 10.0. [C:\w\SSAMTextTools.csproj]", "", false))));
        Assert.Equal("DOTNET_SDK_MISSING", old.Code);
    }

    [Fact]
    public void APackageNuGetCannotRestoreIsNugetRestoreFailedOnThatPackage()
    {
        var refusal = Assert.Throws<ExternalLibraryException>(() => ExternalLibraryBuild.Build(TextTools(), Work(), new FakeDotnet(_ => new ProcessOutcome(1,
            @"C:\w\SSAMTextTools.csproj : error NU1101: Unable to find package Humanizer.Core. No packages exist with this id in source(s): nuget.org", "", false))));
        Assert.Equal("NUGET_RESTORE_FAILED", refusal.Code);
        Assert.Equal(("NU1101", "/packages/0"), (refusal.Problems[0].Code, refusal.Problems[0].Path));
    }

    [Fact]
    public void ThePackageGatesRefuseNet8TwoDepsFilesAndOversize()
    {
        var net8 = Assert.Throws<ExternalLibraryException>(() => ExternalLibraryBuild.Build(TextTools(), Work(), new FakeDotnet(Publishes("8.0"))));
        Assert.Equal("PACKAGE_NOT_NET10", net8.Code);
        Assert.Equal("NOT_NET10", net8.Problems[0].Code);
        var two = Assert.Throws<ExternalLibraryException>(() => ExternalLibraryBuild.Build(TextTools(), Work(), new FakeDotnet(Publishes(extraDeps: 1))));
        Assert.Equal("PACKAGE_NOT_NET10", two.Code);
        Assert.Equal("DEPS_JSON_COUNT", two.Problems[0].Code);
        var large = Assert.Throws<ExternalLibraryException>(() => ExternalLibraryBuild.Build(TextTools(), Work(), new FakeDotnet(Publishes(padding: 4096)),
            new ExternalLibraryBuild.Options(MaxPackageBytes: 200)));
        Assert.Equal("PACKAGE_TOO_LARGE", large.Code);
        Assert.Equal(90L * 1024 * 1024, ExternalLibraryPackage.MaxBytes);
    }

    [Fact]
    public void TheDiffNamesAddedRemovedAndUpdatedActionsAndStructures()
    {
        var before = ExternalLibraryContents.FromSpec(TextTools());
        var after = JsonNode.Parse("""
        { "actions": [
            { "name": "Reverse", "parameters": [ { "name": "Text", "dataType": "Text", "parameterType": "Input" }, { "name": "Result", "dataType": "Text", "parameterType": "Output" } ] },
            { "name": "CountWords", "parameters": [ { "name": "Text", "dataType": "Long Integer", "parameterType": "Input" } ] },
            { "name": "Upper", "parameters": [] } ],
          "structures": [] }
        """);
        var diff = ExternalLibraryContents.Diff(before, after);
        Assert.Equal("Upper", diff["added"]!.AsArray().Single()!["name"]!.GetValue<string>());
        Assert.Equal("WordCount", diff["removed"]!.AsArray().Single()!["name"]!.GetValue<string>());
        var updated = diff["updated"]!.AsArray().Single()!;
        Assert.Equal("CountWords", updated["name"]!.GetValue<string>());
        Assert.Contains(updated["changes"]!.AsArray(), c => c!.GetValue<string>().StartsWith("Text type"));
        Assert.Contains(updated["changes"]!.AsArray(), c => c!.GetValue<string>() == "Words removed");
        Assert.Equal(1, diff["unchanged"]!.GetValue<int>());
        Assert.True(diff["breaking"]!.GetValue<bool>());
        Assert.False(ExternalLibraryContents.Diff(before, before)["breaking"]!.GetValue<bool>());
    }

    [Fact]
    public void TheCommandAnswersARefusalAsDataNeverAnException()
    {
        var specFile = Path.Combine(Work(), "spec.json");
        File.Copy(Path.Combine(Fixtures, "spec-invalid.json"), specFile);
        var answer = ExternalLibraryCommand.Run(["external-library", "build", "--spec", specFile, "--out", Path.Combine(Work(), "out")], new FakeDotnet(_ => throw new InvalidOperationException("never started")));
        Assert.False(answer["ok"]!.GetValue<bool>());
        Assert.Equal("EXTERNAL_LIBRARY_SPEC_INVALID", answer["code"]!.GetValue<string>());
        Assert.Equal(5, answer["problems"]!.AsArray().Count);
        var contents = ExternalLibraryCommand.Run(["external-library", "contents", "--spec", Path.Combine(Fixtures, "ssam-text-tools.json")]);
        Assert.Equal("Reverse", contents["contents"]!["actions"]![0]!["name"]!.GetValue<string>());
        Assert.Equal("USAGE", ExternalLibraryCommand.Run(["external-library", "publish"])["code"]!.GetValue<string>());
    }

    // ---- the External Library form of the public signature envelope (the ODC model's ReferenceKind has ExternalLibrary)
    [Fact]
    public void AnUnattestedExternalLibraryEnvelopeWithActionsAndStructuresIsAnOdcPublicSignature()
    {
        StudioAssembliesOdc.Bind();
        Envelopes();
    }
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Envelopes()
    {
        string Key() => Guid.NewGuid().ToString();
        NativeReferenceSnapshot Envelope(string kind, string[] elementKinds, JsonObject? attestation = null)
        {
            var json = new JsonObject {
                ["FormatVersion"] = 2, ["Environment"] = "lab.test", ["ModuleKey"] = Key(), ["ApplicationKey"] = "", ["ModuleKind"] = kind,
                ["ModuleType"] = kind == "ExternalLibrary" ? "ExternalLibrary" : "Service", ["Name"] = "SSAMTextTools", ["SignatureHash"] = Guid.NewGuid().ToString(),
                ["SignatureBinary"] = Convert.ToBase64String([1, 2, 3]),
                ["Elements"] = new JsonArray(elementKinds.Select((k, i) => (JsonNode)new JsonObject { ["Kind"] = k, ["Name"] = k == "structure" ? "WordCount" : "Reverse" + i, ["Key"] = Key() }).ToArray())
            };
            if (attestation != null) json["Attestation"] = attestation;
            var path = Path.Combine(Path.GetTempPath(), "ssam-extlib-envelope-" + Guid.NewGuid().ToString("N") + ".avsig");
            File.WriteAllText(path, json.ToJsonString());
            try { return NativeReferenceSnapshot.Read(path); } finally { File.Delete(path); }
        }
        var library = Envelope("ExternalLibrary", ["action", "structure"]);
        Assert.True(library.IsExternalLibrary);
        Assert.True(library.IsOdcPublicSignature);
        Assert.Equal("Reverse0", library.Select("IServerAction:Reverse0").Name);
        Assert.Equal("WordCount", library.Select("IStructure:WordCount").Name);
        Assert.Throws<ArgumentException>(() => library.Select("IClientAction:Reverse0"));
        // Only actions and structures; never attested; an unattested extension stays refused.
        Assert.ThrowsAny<Exception>(() => Envelope("ExternalLibrary", ["action", "entity"]));
        Assert.ThrowsAny<Exception>(() => Envelope("ExternalLibrary", ["block"]));
        Assert.ThrowsAny<Exception>(() => Envelope("ExternalLibrary", ["action"], new JsonObject { ["Source"] = "server-signature", ["Guard"] = "module-version", ["VersionId"] = 3, ["CapturedAtUtc"] = "2026-10-05T00:00:00Z" }));
        Assert.ThrowsAny<Exception>(() => Envelope("Extension", ["action"]));
        Assert.True(Envelope("eSpace", ["action", "structure"]).IsOdcPublicSignature);
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(OdcExternalLibraryTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
