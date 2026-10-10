using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Anvil.CSharp;
using Xunit;

namespace Anvil.Tests;

public sealed class FrozenFrameworkDependenciesTests
{
    public FrozenFrameworkDependenciesTests() => StudioAssemblies.Bind();

    [Fact]
    public void RoundtripProducesOrdinaryReferencesAndStableCallTargets()
    {
        var fixture = new Fixture(); var frozen = fixture.Create();
        var path = Path.Combine(fixture.Work, "dependencies.json"); frozen.Write(path);
        var bytes = File.ReadAllBytes(path); frozen.Write(path); Assert.Equal(bytes, File.ReadAllBytes(path));
        var loaded = FrozenFrameworkDependencies.Read(path, frozen.Fingerprint);
        loaded.ValidateReuse(fixture.SourceHash, [fixture.Intrinsic], fixture.Environment.ToUpperInvariant(), fixture.ModuleKey, fixture.Package);
        Assert.Equal(frozen.Fingerprint, loaded.Fingerprint);
        Assert.Equal(fixture.SnapshotPath, loaded.ProducerBindings()["Runtime"]);
        var op = Assert.Single(loaded.ReferenceOperations())!.AsObject();
        Assert.Equal("reference", op["op"]!.ToString()); Assert.Equal("Runtime", op["producer"]!.ToString());
        Assert.Equal("IServerActionSignature:NativeOrdinal", Assert.Single(op["elements"]!.AsArray())!.ToString());
        Assert.Equal("IServerActionSignature:@" + Keys.ToStudio(fixture.ProducerKey) + "/" + Keys.ToStudio(fixture.ElementKey), loaded.CallBindings()[fixture.Intrinsic.Reference]);
    }

    [Fact]
    public void LockOwnsItsInputsAndReturnsReadonlyCollections()
    {
        var fixture = new Fixture(); var parameters = fixture.Intrinsic.Inputs.ToList();
        var requirements = new List<FrameworkIntrinsic> { fixture.Intrinsic with { Inputs = parameters } };
        var expectedInputs = fixture.Intrinsic.Inputs.ToList();
        var mappings = new List<FrameworkIntrinsicBinding> { fixture.Binding with { Inputs = expectedInputs } };
        var producers = new List<FrameworkProducerSnapshot> { fixture.Producer };
        var frozen = FrozenFrameworkDependencies.Create(fixture.SourceHash, requirements, fixture.Environment, fixture.ModuleKey, fixture.Package, producers, mappings);
        var fingerprint = frozen.Fingerprint;
        parameters.Clear(); expectedInputs[0] = new("Tampered", "Binary Data"); requirements.Clear(); producers.Clear(); mappings.Clear();
        Assert.Equal(fingerprint, frozen.Fingerprint); Assert.Equal(2, frozen.Requirements[0].Inputs.Count);
        Assert.Throws<NotSupportedException>(() => ((IList<IntrinsicParameter>)frozen.Requirements[0].Inputs).Clear());
        Assert.Throws<NotSupportedException>(() => ((IList<FrameworkIntrinsicBinding>)frozen.Bindings).Clear());
        Assert.Throws<NotSupportedException>(() => ((IDictionary<string, string>)frozen.CallBindings()).Clear());
        frozen.ToJson()["sourceHash"] = new string('a', 64); Assert.Equal(fingerprint, frozen.Fingerprint);
    }

    [Fact]
    public void RequirementHashAndLockFingerprintIgnoreSetOrdering()
    {
        var fixture = new Fixture(); var other = fixture.Intrinsic with { Id = "System.String.Other" };
        var mapping = fixture.Binding with { Reference = other.Reference };
        var first = FrozenFrameworkDependencies.Create(fixture.SourceHash, [fixture.Intrinsic, other], fixture.Environment, fixture.ModuleKey, fixture.Package, [fixture.Producer], [fixture.Binding, mapping]);
        var second = FrozenFrameworkDependencies.Create(fixture.SourceHash, [other, fixture.Intrinsic], fixture.Environment, fixture.ModuleKey, fixture.Package, [fixture.Producer], [mapping, fixture.Binding]);
        Assert.Equal(first.RequirementsHash, second.RequirementsHash); Assert.Equal(first.Fingerprint, second.Fingerprint);
        Assert.Single(Assert.Single(first.ReferenceOperations())!["elements"]!.AsArray());
        Assert.Equal(2, first.CallBindings().Count);
    }

    [Theory]
    [InlineData("source")]
    [InlineData("environment")]
    [InlineData("module")]
    [InlineData("package")]
    [InlineData("revision")]
    [InlineData("artifact")]
    [InlineData("missing-requirement")]
    [InlineData("extra-requirement")]
    [InlineData("intrinsic-version")]
    [InlineData("input-type")]
    [InlineData("input-order")]
    [InlineData("output-type")]
    public void PersistedReuseRejectsChangesToAcceptedInputs(string fault)
    {
        var fixture = new Fixture(); var original = fixture.Create();
        var path = Path.Combine(fixture.Work, "frozen.json"); original.Write(path);
        var loaded = FrozenFrameworkDependencies.Read(path, original.Fingerprint);
        var source = fixture.SourceHash; var environment = fixture.Environment; var module = fixture.ModuleKey;
        var package = fixture.Package; FrameworkIntrinsic[] requirements = [fixture.Intrinsic];
        switch (fault)
        {
            case "source": source = new string('a', 64); break;
            case "environment": environment = "other.invalid"; break;
            case "module": module = Guid.NewGuid().ToString(); break;
            case "package": package = package with { Id = "AnotherRuntime" }; break;
            case "revision": package = package with { Revision = "2" }; break;
            case "artifact": package = package with { ArtifactSha256 = new string('b', 64) }; break;
            case "missing-requirement": requirements = []; break;
            case "extra-requirement": requirements = [fixture.Intrinsic, fixture.Intrinsic with { Id = "System.String.Other" }]; break;
            case "intrinsic-version": requirements = [fixture.Intrinsic with { Version = 2 }]; break;
            case "input-type": requirements = [fixture.Intrinsic with { Inputs = [new("Left", "Binary Data"), new("Right", "Text")] }]; break;
            case "input-order": requirements = [fixture.Intrinsic with { Inputs = fixture.Intrinsic.Inputs.Reverse().ToArray() }]; break;
            case "output-type": requirements = [fixture.Intrinsic with { Output = new("Result", "Long Integer") }]; break;
        }
        Assert.Throws<InvalidOperationException>(() => loaded.ValidateReuse(source, requirements, environment, module, package));
        Assert.Equal(original.Fingerprint, loaded.Fingerprint);
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("extra")]
    [InlineData("duplicate")]
    [InlineData("unknown-producer")]
    [InlineData("input-type")]
    [InlineData("input-name")]
    [InlineData("output")]
    [InlineData("version")]
    public void MappingRequiresAnExactCompleteExpectedAbi(string fault)
    {
        var fixture = new Fixture(); FrameworkIntrinsicBinding[] mappings = [fixture.Binding];
        switch (fault)
        {
            case "missing": mappings = []; break;
            case "extra": mappings = [fixture.Binding, fixture.Binding with { Reference = "IFrameworkIntrinsic:System.String.Other/1" }]; break;
            case "duplicate": mappings = [fixture.Binding, fixture.Binding]; break;
            case "unknown-producer": mappings = [fixture.Binding with { ProducerBinding = "Other" }]; break;
            case "input-type": mappings = [fixture.Binding with { Inputs = [new("Left", "Integer"), new("Right", "Text")] }]; break;
            case "input-name": mappings = [fixture.Binding with { Inputs = [new("First", "Text"), new("Right", "Text")] }]; break;
            case "output": mappings = [fixture.Binding with { Output = new("Result", "Text") }]; break;
            case "version": mappings = [fixture.Binding with { Reference = "IFrameworkIntrinsic:System.String.CompareOrdinal/2" }]; break;
        }
        Assert.Throws<ArgumentException>(() => fixture.Create(mappings: mappings));
    }

    [Theory]
    [InlineData("snapshot-content")]
    [InlineData("snapshot-missing")]
    public void ArtifactChangesAreRejectedEvenByGeneratedBindingAccessors(string fault)
    {
        var fixture = new Fixture(); var frozen = fixture.Create();
        if (fault == "snapshot-content") File.AppendAllText(fixture.SnapshotPath, " "); else File.Delete(fixture.SnapshotPath);
        Assert.Throws<InvalidOperationException>(() => frozen.ValidateArtifacts());
        Assert.Throws<InvalidOperationException>(() => frozen.ProducerBindings());
        Assert.Throws<InvalidOperationException>(() => frozen.ReferenceOperations());
        Assert.Throws<InvalidOperationException>(() => frozen.CallBindings());
        Assert.Throws<InvalidOperationException>(() => frozen.ValidateReuse(fixture.SourceHash, [fixture.Intrinsic], fixture.Environment, fixture.ModuleKey, fixture.Package));
    }

    [Theory]
    [InlineData("producer-key")]
    [InlineData("signature-hash")]
    [InlineData("element-key")]
    [InlineData("element-name")]
    [InlineData("environment")]
    public void ControllerDescriptorsMustMatchFrozenSnapshotIdentity(string fault)
    {
        var fixture = new Fixture(); var producer = fixture.Producer; var binding = fixture.Binding; var environment = fixture.Environment;
        switch (fault)
        {
            case "producer-key": producer = producer with { ProducerKey = Guid.NewGuid().ToString() }; break;
            case "signature-hash": producer = producer with { SignatureHash = Guid.NewGuid().ToString() }; break;
            case "element-key": binding = binding with { OriginalElementKey = Guid.NewGuid().ToString() }; break;
            case "element-name": binding = binding with { ElementName = "Absent" }; break;
            case "environment": environment = "other.invalid"; break;
        }
        Assert.ThrowsAny<Exception>(() => FrozenFrameworkDependencies.Create(fixture.SourceHash, [fixture.Intrinsic], environment, fixture.ModuleKey, fixture.Package, [producer], [binding]));
    }

    [Theory]
    [InlineData("unknown-root")]
    [InlineData("missing")]
    [InlineData("null")]
    [InlineData("version")]
    [InlineData("unknown-package")]
    [InlineData("unknown-parameter")]
    [InlineData("requirement-hash")]
    [InlineData("invalid-artifact-hash")]
    [InlineData("relative-snapshot")]
    public void JsonLockIsStrictAtEveryLevel(string fault)
    {
        var fixture = new Fixture(); var json = fixture.Create().ToJson();
        switch (fault)
        {
            case "unknown-root": json["allowMismatch"] = true; break;
            case "missing": json.Remove("sourceHash"); break;
            case "null": json["bindings"] = null; break;
            case "version": json["formatVersion"] = 2; break;
            case "unknown-package": json["package"]!["dynamicAssembly"] = "author.dll"; break;
            case "unknown-parameter": json["requirements"]![0]!["inputs"]![0]!["default"] = ""; break;
            case "requirement-hash": json["requirementsHash"] = new string('a', 64); break;
            case "invalid-artifact-hash": json["package"]!["artifactSha256"] = "interface-hash"; break;
            case "relative-snapshot": json["producers"]![0]!["path"] = "signature.avsig"; break;
        }
        Assert.ThrowsAny<Exception>(() => FrozenFrameworkDependencies.FromJson(json));
    }

    [Fact]
    public void DuplicateJsonPropertiesCannotOverrideRecordedValues()
    {
        var fixture = new Fixture(); var text = fixture.Create().ToJson().ToJsonString();
        var path = Path.Combine(fixture.Work, "duplicates.json");
        File.WriteAllText(path, text.Replace("\"formatVersion\":1", "\"formatVersion\":2,\"formatVersion\":1", StringComparison.Ordinal));
        Assert.Throws<ArgumentException>(() => FrozenFrameworkDependencies.Read(path));
    }

    [Fact]
    public void PersistedLockCannotBeReplacedWithDifferentPackageChoices()
    {
        var fixture = new Fixture(); var frozen = fixture.Create(); var path = Path.Combine(fixture.Work, "frozen.json"); frozen.Write(path);
        var changed = fixture.Create(package: fixture.Package with { Revision = "2" });
        Assert.Throws<InvalidOperationException>(() => changed.Write(path));
        Assert.Equal(frozen.Fingerprint, FrozenFrameworkDependencies.Read(path).Fingerprint);
        var edited = frozen.ToJson(); edited["package"]!["revision"] = "2";
        Assert.Throws<InvalidOperationException>(() => FrozenFrameworkDependencies.FromJson(edited, frozen.Fingerprint));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void PackageArtifactBytesAndLocationRemainPartOfTheFrozenEvidence(bool remove)
    {
        var fixture = new Fixture(); var artifact = Path.Combine(fixture.Work, "package.xif");
        File.WriteAllText(artifact, "verified package artifact");
        var package = fixture.Package with { ArtifactPath = artifact };
        var frozen = fixture.Create(package: package);
        var loaded = FrozenFrameworkDependencies.FromJson(frozen.ToJson(), frozen.Fingerprint);
        Assert.Equal(artifact, loaded.Package.ArtifactPath);
        var other = Path.Combine(fixture.Work, "other.xif"); File.Copy(artifact, other);
        Assert.Throws<InvalidOperationException>(() => loaded.ValidateReuse(fixture.SourceHash, [fixture.Intrinsic],
            fixture.Environment, fixture.ModuleKey, package with { ArtifactPath = other }));
        if (remove) File.Delete(artifact); else File.AppendAllText(artifact, "changed");
        Assert.Throws<InvalidOperationException>(() => loaded.ValidateArtifacts());
        Assert.Throws<InvalidOperationException>(() => loaded.CallBindings());
        Assert.Throws<InvalidOperationException>(() => FrozenFrameworkDependencies.FromJson(frozen.ToJson()));
    }

    [Fact]
    public void PackageArtifactPathAndDigestMustDescribeTheProvidedFile()
    {
        var fixture = new Fixture(); var artifact = Path.Combine(fixture.Work, "package.xif");
        File.WriteAllText(artifact, "different package");
        Assert.Throws<InvalidOperationException>(() => fixture.Create(package: fixture.Package with { ArtifactPath = artifact }));
        Assert.Throws<ArgumentException>(() => fixture.Create(package: fixture.Package with { ArtifactPath = "relative.xif" }));
        Assert.False(fixture.Create().ToJson()["package"]!.AsObject().ContainsKey("artifactPath"));
    }

    private sealed class Fixture
    {
        public string Work { get; }
        public string SnapshotPath { get; }
        public string SourceHash { get; } = DurableJson.Hash("accepted C# source");
        public string Environment { get; } = "dependency-test.invalid";
        public string ModuleKey { get; } = Guid.NewGuid().ToString();
        public string ProducerKey { get; } = Guid.NewGuid().ToString();
        public string ElementKey { get; } = Guid.NewGuid().ToString();
        public FrameworkIntrinsic Intrinsic { get; } = FrameworkIntrinsic.CompareOrdinal;
        // Controller-supplied package descriptor, not evidence of executable runtime behavior.
        public FrameworkRuntimePackage Package { get; } = new("TestRuntime", "1", DurableJson.Hash("verified package artifact"));
        public FrameworkProducerSnapshot Producer { get; }
        public FrameworkIntrinsicBinding Binding => new(Intrinsic.Reference, "Runtime", "NativeOrdinal", ElementKey, Intrinsic.Inputs, Intrinsic.Output);
        [MethodImpl(MethodImplOptions.NoInlining)]
        public Fixture()
        {
            var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(FrozenFrameworkDependenciesTests).Assembly.Location)!)!;
            Work = Path.Combine(root, ".local", "data-logic-translator", "dependency-lock-tests", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(Work);
            SnapshotPath = Path.Combine(Work, "runtime.avsig"); var signatureHash = Guid.NewGuid().ToString();
            File.WriteAllText(SnapshotPath, new JsonObject {
                ["FormatVersion"] = 1, ["Environment"] = Environment, ["ModuleKey"] = ProducerKey, ["ApplicationKey"] = "",
                ["Name"] = "TestRuntime", ["ModuleKind"] = "Extension", ["SignatureHash"] = signatureHash, ["SignatureBinary"] = Convert.ToBase64String([1, 2, 3]),
                ["Elements"] = new JsonArray(new JsonObject { ["Kind"] = "action", ["Name"] = "NativeOrdinal", ["Key"] = ElementKey })
            }.ToJsonString());
            Producer = new("Runtime", SnapshotPath, DeliveryReceipt.Hash(SnapshotPath), ProducerKey, signatureHash);
        }
        public FrozenFrameworkDependencies Create(FrameworkRuntimePackage? package = null, FrameworkIntrinsicBinding[]? mappings = null)
            => FrozenFrameworkDependencies.Create(SourceHash, [Intrinsic], Environment, ModuleKey, package ?? Package, [Producer], mappings ?? [Binding]);
    }
}
