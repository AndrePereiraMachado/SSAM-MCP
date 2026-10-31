using System.Text.Json.Nodes;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// A test over the plan's corpus of captures (absolute paths, never committed). Without the captures on the machine it is SKIPPED, with the
/// reason, at discovery: it used to pass having read nothing, and a green run said the corpus held when no corpus had been read (the
/// review of 2026-10-31: ScreenRecreation*, TextRoundTripCorpus*, the C2 battery). What the manifests themselves say decides, never a list.
/// </summary>
public sealed class CorpusFactAttribute : FactAttribute
{
    /// <summary>tests/contracts/screen-html/corpus.json: the test reads the modules of the lane that are present.</summary>
    public const string Screens = "screens";
    /// <summary>tests/fixtures/text-roundtrip/corpus.json: the test compares totals of the whole corpus, so it needs every module of the lane.</summary>
    public const string Text = "text";
    /// <summary>The same manifest: the test reads the modules of the lane that are present, each by itself.</summary>
    public const string TextPresent = "text-present";

    public string Corpus { get; }
    public string? Module { get; }

    /// <param name="module">The one module of the manifest the test reads (its label), when it reads one.</param>
    public CorpusFactAttribute(string corpus, string lane, string? module = null)
    {
        Corpus = corpus; Module = module;
        if (Reason(corpus, lane, module) is { } why) Skip = why;
    }

    public static string? Reason(string corpus, string lane, string? module = null)
    {
        var dir = Path.GetDirectoryName(typeof(CorpusFactAttribute).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        if (dir == null) return "the kernel folder is not above the test assembly: no corpus manifest to read";
        return corpus == Screens ? ReasonOf(Path.Combine(dir, "tests", "contracts", "screen-html", "corpus.json"), lane, all: false)
            : ReasonOf(Path.Combine(dir, "tests", "fixtures", "text-roundtrip", "corpus.json"), lane, all: corpus == Text, module);
    }

    /// <summary>Why a test over that manifest cannot run here, or null. all: it needs every module of the lane; module: it reads that one.
    /// Otherwise it reads what is present, so only no capture at all keeps it from running.</summary>
    public static string? ReasonOf(string manifest, string lane, bool all, string? module = null)
    {
        var node = JsonNode.Parse(File.ReadAllText(manifest))!;
        var rows = (node is JsonArray list ? list : node["modules"]!.AsArray()).Select(m => m!.AsObject()).Where(m => m["lane"]!.GetValue<string>() == lane).ToList();
        var name = Path.GetFileName(manifest);
        if (rows.Count == 0) return "corpus " + name + " has no module of the " + lane + " lane";
        var present = rows.Count(m => File.Exists(m["oml"]!.GetValue<string>()));
        var counted = present + " of " + rows.Count + " captures of the " + lane + " corpus (" + name + ") are on this machine";
        if (module != null)
        {
            var row = rows.FirstOrDefault(m => m["label"]?.GetValue<string>() == module);
            if (row == null) return "corpus " + name + " has no module " + module;
            return File.Exists(row["oml"]!.GetValue<string>()) ? null : counted + ", and not " + module + ", the one this test reads: " + row["oml"];
        }
        if (present == rows.Count || !all && present > 0) return null;
        return present == 0 ? counted + ": this test has nothing to read"
            : counted + ": this test compares the totals of the whole corpus, so it needs all of them";
    }
}