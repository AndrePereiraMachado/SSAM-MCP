using System.Text.Json.Nodes;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

public sealed class FrozenCSharpCompilationTests
{
    private const string Source = "public static class Pricing { public static int Price(int quantity) => quantity * 3; }";
    [Fact]
    public void NoRuntimeCompilationHasAnImmutableSourceContractAndExplicitNoneChoice()
    {
        var frozen = FrozenCSharpCompilation.Create(JsonValue.Create(Source)!, "fixture.invalid", "Module");
        Assert.Null(frozen.RuntimeFingerprint);
        var roundtrip = FrozenCSharpCompilation.FromJson(frozen.ToJson(), frozen.Fingerprint);
        roundtrip.ValidateReuse(JsonValue.Create(Source)!, "FIXTURE.INVALID", "Module");
        Assert.True(JsonNode.DeepEquals(frozen.Compilation.Specification, roundtrip.Bind(null).Specification));
        Assert.Equal(frozen.Fingerprint, roundtrip.Fingerprint);
        var copy = frozen.Compilation; copy.Specification.Clear(); copy.SourceMap.Clear();
        frozen.Source.Clear(); frozen.ToJson().Clear();
        Assert.NotEmpty(frozen.Compilation.Specification); Assert.NotEmpty(frozen.Compilation.SourceMap);
        Assert.Equal(roundtrip.Fingerprint, frozen.Fingerprint);
    }
    [Fact]
    public void ChangedSourceTargetOrCompilerCannotReuseTheFrozenDecision()
    {
        var frozen = FrozenCSharpCompilation.Create(JsonValue.Create(Source)!, "fixture.invalid", "Module");
        Assert.Throws<InvalidOperationException>(() => frozen.ValidateReuse(JsonValue.Create(Source + "\n// changed")!, "fixture.invalid", "Module"));
        Assert.Throws<InvalidOperationException>(() => frozen.ValidateReuse(JsonValue.Create(Source)!, "other.invalid", "Module"));
        Assert.Throws<InvalidOperationException>(() => frozen.ValidateReuse(JsonValue.Create(Source)!, "fixture.invalid", "Other"));
        var changed = frozen.ToJson(); changed["compiler"]!.AsObject()["Anvil.CSharp"] = new string('0', 64);
        var oldCompiler = FrozenCSharpCompilation.FromJson(changed, DurableJson.Hash(changed.ToJsonString()));
        Assert.Throws<InvalidOperationException>(() => oldCompiler.ValidateReuse(JsonValue.Create(Source)!, "fixture.invalid", "Module"));
    }
    [Theory]
    [InlineData("specification")]
    [InlineData("sourceMap")]
    [InlineData("retiredStructures")]
    [InlineData("requiredIntrinsics")]
    [InlineData("sourceAbis")]
    public void AllCompilationPartsAreCoveredByTheOriginalFingerprint(string part)
    {
        var frozen = FrozenCSharpCompilation.Create(JsonValue.Create(Source)!, "fixture.invalid", "Module");
        var changed = frozen.ToJson();
        if (changed["compilation"]![part] is JsonArray array) array.Add(new JsonObject());
        else changed["compilation"]![part]!["unexpected"] = true;
        Assert.ThrowsAny<Exception>(() => FrozenCSharpCompilation.FromJson(changed, frozen.Fingerprint));
    }
    [Fact]
    public void ExistingLockCannotBeOverwrittenWithAnotherSource()
    {
        var folder = Path.Combine(Path.GetTempPath(), "anvil-frozen-csharp", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(folder);
        var path = Path.Combine(folder, "compilation.json");
        var frozen = FrozenCSharpCompilation.Create(JsonValue.Create(Source)!, "fixture.invalid", "Module");
        frozen.Write(path); var original = File.ReadAllBytes(path); frozen.Write(path);
        Assert.Equal(frozen.Fingerprint, FrozenCSharpCompilation.Read(path, frozen.Fingerprint).Fingerprint);
        var other = FrozenCSharpCompilation.Create(JsonValue.Create(Source.Replace("* 3", "* 4"))!, "fixture.invalid", "Module");
        Assert.Throws<InvalidOperationException>(() => other.Write(path));
        Assert.Equal(original, File.ReadAllBytes(path));
    }
}
