using System.ComponentModel.DataAnnotations;
using System.Text;
using System.Text.Json.Nodes;
using Xunit;

namespace Anvil.CSharp.Tests;

/// <summary>Independent UTF-16/BCL anchors. Probe execution checks emitted logic, not O11 or HTTP.
/// Isolated surrogate cases are deliberately in-process only: existing REST evidence does not
/// establish that those code units survive transport. Cold38 and its oracle are not used or changed.</summary>
public sealed class Utf16LengthTests
{
    public static IEnumerable<object[]> UnicodeCorpus()
    {
        yield return Case("empty", "", 0, 0);
        yield return Case("ascii", "abc", 3, 3);
        yield return Case("trailing-ascii-space", "a ", 2, 2);
        yield return Case("bmp-accent", "\u00e9", 1, 1);
        yield return Case("bmp-cjk", "\u6f22\u5b57", 2, 2);
        yield return Case("combining", "e\u0301", 2, 2);
        yield return Case("supplementary", "\U0001f600", 2, 1);
        yield return Case("cold-failure-shape-independent", "\u00e9\U0001f600", 3, 2);
        yield return Case("zwj-profession", "\U0001f469\u200d\U0001f4bb", 5, 3);
        yield return Case("zwj-family", "\U0001f468\u200d\U0001f469\u200d\U0001f467\u200d\U0001f466", 11, 7);
        yield return Case("regional-indicators", "\U0001f1e7\U0001f1f7", 4, 2);
        yield return Case("variation-selector", "\u2764\ufe0f", 2, 2);
        yield return Case("nul", "\0x", 2, 2);
        yield return Case("crlf", "\r\n", 2, 2);
        yield return Case("isolated-high-inprocess-only", "\ud800", 1, 1, false);
        yield return Case("isolated-low-inprocess-only", "\udc00", 1, 1, false);
        yield return Case("high-plus-ascii-inprocess-only", "\ud800A", 2, 2, false);
        yield return Case("reversed-surrogates-inprocess-only", "\udc00\ud800", 2, 2, false);
        static object[] Case(string id, string value, int utf16Units, int runesIncludingReplacement, bool wellFormed = true)
            => [id, value, utf16Units, runesIncludingReplacement, wellFormed];
    }

    [Theory]
    [MemberData(nameof(UnicodeCorpus))]
    public void BclCorpusHasExplicitCodeUnitAndRuneAnchors(string id, string value, int units, int runes, bool wellFormed)
    {
        Assert.False(string.IsNullOrWhiteSpace(id));
        Assert.Equal(units, value.Length);
        Assert.Equal(runes, value.EnumerateRunes().Count());
        Assert.Equal(wellFormed, IsWellFormed(value));
        // MaxLength and StringLength validate CLR string.Length, including trailing spaces.
        Assert.Equal(units <= 2, new MaxLengthAttribute(2).IsValid(value));
        Assert.Equal(units <= 2, new StringLengthAttribute(2).IsValid(value));
    }

    private const string LengthSource = """
        #nullable enable
        public sealed class Counter { public int Value; }
        public static class UnicodeLength
        {
            public static int Count(string? value) { var c = new Counter(); c.Value++; return value!.Length; }
            public static int OrMissing(string? value) { var c = new Counter(); c.Value++; return value == null ? -1 : value.Length; }
            private static string? Capture(Counter c, string? value) { c.Value++; return value; }
            public static int Once(string? value) { var c = new Counter(); int length = Capture(c, value)!.Length; return length * 10 + c.Value; }
        }
        """;
    private static readonly Lazy<CompilationResult> LengthCompilation = new(() => Compile(LengthSource));

    [Theory]
    [MemberData(nameof(UnicodeCorpus))]
    public void EmittedStringLengthUsesTheClrPrimitiveForEveryCodeUnit(string id, string value, int units, int runes, bool wellFormed)
    {
        _ = (id, runes, wellFormed);
        var compiled = LengthCompilation.Value;
        Assert.Equal(FrameworkIntrinsic.Utf16Length, Assert.Single(compiled.RequiredIntrinsics!));
        var probe = new ReferenceGraphProbe(compiled.Specification);
        foreach (var method in new[] { "Count", "OrMissing" })
            Assert.Equal((decimal)units, probe.Run(method, TextArguments(value))["AvResult"]);
        Assert.Equal((decimal)(units * 10 + 1), probe.Run("Once", TextArguments(value))["AvResult"]);
    }

    [Fact]
    public void NullDereferenceAndExplicitNullGuardKeepDifferentBclResults()
    {
        string? missing = null;
        Assert.Throws<NullReferenceException>(() => _ = missing!.Length);
        Assert.Equal(-1, missing?.Length ?? -1);
        var probe = new ReferenceGraphProbe(LengthCompilation.Value.Specification);
        Assert.Equal(-1m, probe.Run("OrMissing", TextArguments(null))["AvResult"]);
        var exception = Assert.Throws<ReferenceGraphProbe.Failure>(() => probe.Run("Count", TextArguments(null)));
        Assert.Contains("NullReferenceException", exception.Kind);
        Assert.Equal("Object reference not set to an instance of an object.", exception.Message);
    }

    [Fact]
    public void LengthRequirementIsTypedAndBindingDoesNotRewriteUserLiterals()
    {
        var compiled = Compile("public static class R { public static int Count(string value) => value.Length; public static string Literal() => \"IFrameworkIntrinsic:System.String.Length/1\"; }");
        var intrinsic = Assert.Single(compiled.RequiredIntrinsics!);
        Assert.Equal("System.String.Length", intrinsic.Id); Assert.Equal(1, intrinsic.Version);
        Assert.Equal(new IntrinsicParameter("Value", "Text"), Assert.Single(intrinsic.Inputs));
        Assert.Equal(new IntrinsicParameter("Result", "Integer"), intrinsic.Output);
        var original = compiled.Specification.ToJsonString();
        var bound = FrameworkIntrinsic.Bind(compiled, new Dictionary<string, string> { [intrinsic.Reference] = "IServerActionSignature:@producer/length" });
        Assert.Equal(original, compiled.Specification.ToJsonString());
        Assert.Contains(Nodes(bound.Specification), n => n["call"]?.ToString() == "IServerActionSignature:@producer/length");
        Assert.DoesNotContain(Nodes(bound.Specification), n => n["call"]?.ToString() == intrinsic.Reference);
        Assert.Contains(intrinsic.Reference, bound.Specification.ToJsonString());
        Assert.Equal(compiled.SourceHash, bound.SourceHash);
    }

    [Theory]
    [InlineData("MaxLength")]
    [InlineData("StringLength")]
    public void PersistedTextMaximumUsesTheSameCodeUnitRequirement(string attribute)
    {
        var source = """
            using Anvil.Authoring;
            using System.ComponentModel.DataAnnotations;
            [Entity] public record Item(Id<Item> Id, [property: ATTRIBUTE(2)] string? Text);
            public static class R { public static void Save(IDataSession data, Item value) => data.Insert(value); }
            """.Replace("ATTRIBUTE", attribute, StringComparison.Ordinal);
        var compiled = Compile(source);
        Assert.Contains(FrameworkIntrinsic.Utf16Length, compiled.RequiredIntrinsics!);
        var calls = Nodes(compiled.Specification).Where(n => n["call"]?.ToString() == FrameworkIntrinsic.Utf16Length.Reference).ToArray();
        Assert.Single(calls);
        var result = calls[0]["as"]!.ToString() + ".Result";
        Assert.Contains(Nodes(compiled.Specification), n => n["if"]?.ToString().Contains(result + " > 2", StringComparison.Ordinal) == true);
    }

    [Fact]
    public void CapturedQueryLengthIsComputedBeforeSqlButPerRowLengthRemainsAnExplicitGap()
    {
        const string declarations = "using Anvil.Authoring; using System.Linq; [Entity] public record Item(Id<Item> Id, string Text, int Size); ";
        var captured = Compile(declarations + "public static class R { public static int Count(IDataSession data, string text) => data.Query<Item>().Where(row => row.Size == text.Length).Count(); }");
        Assert.Contains(FrameworkIntrinsic.Utf16Length, captured.RequiredIntrinsics!);
        Assert.Contains(Nodes(captured.Specification), n => n["call"]?.ToString() == FrameworkIntrinsic.Utf16Length.Reference);
        Assert.Contains(Nodes(captured.Specification), n => n["sql"]?.GetValue<bool>() == true);
        var failure = Assert.Throws<SourceCompilationException>(() => Compile(declarations + "public static class R { public static int Count(IDataSession data) => data.Query<Item>().Where(row => row.Text.Length > 0).Count(); }"));
        Assert.Contains(failure.Diagnostics, d => d.Code == "AVCS310" && d.Message.Contains("Query member is not bound", StringComparison.Ordinal));
    }

    [Fact]
    public void EmptinessAndCollectionCountsDoNotAcquireAStringLengthPrimitive()
    {
        var compiled = Compile("public static class R { public static bool Empty(string? value) => string.IsNullOrEmpty(value); public static int Count(System.Collections.Generic.List<int> values) => values.Count; }");
        Assert.DoesNotContain(compiled.RequiredIntrinsics ?? [], i => i.Id == FrameworkIntrinsic.Utf16Length.Id);
        Assert.True(string.IsNullOrEmpty(null)); Assert.True(string.IsNullOrEmpty("")); Assert.False(string.IsNullOrEmpty("\U0001f600"));
    }

    public static IEnumerable<object[]> TrimCorpus()
    {
        yield return ["ascii", " x ", "x", "x ", " x"];
        yield return ["bmp", "\u00a0\u00e9\u2028", "\u00e9", "\u00e9\u2028", "\u00a0\u00e9"];
        yield return ["supplementary", " \U0001f600 ", "\U0001f600", "\U0001f600 ", " \U0001f600"];
        yield return ["supplementary-alone", "\U0001f600", "\U0001f600", "\U0001f600", "\U0001f600"];
        yield return ["unicode-whitespace", "\u00a0\U0001f600\u2028", "\U0001f600", "\U0001f600\u2028", "\u00a0\U0001f600"];
        yield return ["combining", "\u2003e\u0301\u3000", "e\u0301", "e\u0301\u3000", "\u2003e\u0301"];
        yield return ["zwj", " \U0001f469\u200d\U0001f4bb ", "\U0001f469\u200d\U0001f4bb", "\U0001f469\u200d\U0001f4bb ", " \U0001f469\u200d\U0001f4bb"];
        yield return ["zero-width-space-not-whitespace", "\u200b\U0001f600\u200b", "\u200b\U0001f600\u200b", "\u200b\U0001f600\u200b", "\u200b\U0001f600\u200b"];
        yield return ["bom-not-whitespace", "\ufeff\U0001f600\ufeff", "\ufeff\U0001f600\ufeff", "\ufeff\U0001f600\ufeff", "\ufeff\U0001f600\ufeff"];
        yield return ["isolated-surrogate-inprocess-only", " \ud800 ", "\ud800", "\ud800 ", " \ud800"];
    }

    [Theory]
    [MemberData(nameof(TrimCorpus))]
    public void TrimBclAnchorsPreservePayloadCodeUnits(string id, string text, string trim, string start, string end)
    {
        _ = id; Assert.Equal(trim, text.Trim()); Assert.Equal(start, text.TrimStart()); Assert.Equal(end, text.TrimEnd());
    }

    private static readonly Lazy<CompilationResult> TrimCompilation = new(() => Compile("""
        public sealed class Marker { public int Value; }
        public static class T {
            public static string Both(string value) { var m = new Marker(); m.Value++; return value.Trim(); }
            public static string Start(string value) { var m = new Marker(); m.Value++; return value.TrimStart(); }
            public static string End(string value) { var m = new Marker(); m.Value++; return value.TrimEnd(); }
        }
        """));

    [Theory]
    [MemberData(nameof(TrimCorpus))]
    public void TrimProbeMustUseOneCoordinateSystemAndPreserveSupplementaryPayload(string id, string text, string trim, string start, string end)
    {
        _ = id;
        // Desired C# behavior. A mismatch diagnoses the frontend/probe pair; it does not
        // establish O11 Substr indexing. O11 Length and Substr require a separate native proof.
        var probe = new ReferenceGraphProbe(TrimCompilation.Value.Specification);
        foreach (var (method, expected) in new[] { ("Both", trim), ("Start", start), ("End", end) })
        {
            var result = Assert.IsType<Dictionary<string, object>>(probe.Run(method, TextArguments(text))["AvResult"]);
            Assert.True((bool)result["HasValue"]); Assert.Equal(expected, result["Value"]);
        }
    }

    [Theory]
    [InlineData(null, -1)]
    [InlineData("", 0)]
    [InlineData("\u00e9\U0001f600", 3)]
    public void ConditionalAccessLengthMatchesBclIndependentlyOfTheMainCorpus(string? value, int expected)
    {
        Assert.Equal(expected, value?.Length ?? -1);
        var compiled = Compile("public static class R { public static int Count(string? value) => value?.Length ?? -1; }");
        Assert.Equal((decimal)expected, new ReferenceGraphProbe(compiled.Specification).Run("Count", TextArguments(value))["AvResult"]);
    }
    private static bool IsWellFormed(string value)
    {
        for (var index = 0; index < value.Length; index++)
        {
            if (!char.IsSurrogate(value[index])) continue;
            if (!char.IsHighSurrogate(value[index]) || index + 1 == value.Length || !char.IsLowSurrogate(value[index + 1])) return false;
            index++;
        }
        return true;
    }
    private static CompilationResult Compile(string source) => CSharpCompiler.Compile(new Dictionary<string, string> { ["Utf16Corpus.cs"] = source });
    private static Dictionary<string, object> TextArguments(string? value) => new() {
        ["Arg_value"] = new Dictionary<string, object> { ["HasValue"] = value != null, ["Value"] = value ?? "" }
    };
    private static IEnumerable<JsonObject> Nodes(JsonNode? node)
    {
        if (node is JsonObject obj) { yield return obj; foreach (var pair in obj) foreach (var child in Nodes(pair.Value)) yield return child; }
        else if (node is JsonArray array) foreach (var item in array) foreach (var child in Nodes(item)) yield return child;
    }
}
