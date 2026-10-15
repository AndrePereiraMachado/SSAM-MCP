using System.Reflection;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Core;
using Anvil.Core.Preflight;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

public sealed class FlowKindPrefixTests(ITestOutputHelper output)
{
    private static (string Text, List<JsonObject> Changes) Normalize(string text)
    {
        var data = new JsonObject { ["flow"] = text };
        var ops = new JsonArray(new JsonObject { ["op"] = "logic", ["data"] = data });
        var changes = new List<JsonObject>();
        TextForms.Normalize(ops, "/ops", "o11", changes);
        return (data["flow"]!.ToString(), changes);
    }

    [Fact]
    public void KindPrefixesAreRemovedBeforeACallCanBeReadAsAnAssignment()
    {
        const string text = "server action Probe\n  Read = IEntityActionSignature:Find(Value=1)\n  end\n";
        var (actual, changes) = Normalize(text);
        Assert.Equal(text.Replace("IEntityActionSignature:", ""), actual);
        var change = Assert.Single(changes);
        Assert.Equal("FLOW_KIND_PREFIX_DROPPED", change["rule"]!.ToString());
        Assert.Equal(2, change["line"]!.GetValue<int>());
        Assert.DoesNotContain("assign Read", actual);
    }

    [Fact]
    public void LiteralsAndNodeLabelsArePreservedByteForByte()
    {
        const string text = "server action Probe\n  Read = IEntityActionSignature:Find(Value=\"IServerActionSignature:Literal\")  # IEntityActionSignature:Keep\n  end\n";
        Assert.Equal(text.Replace("Read = IEntityActionSignature:", "Read = "), Normalize(text).Text);
    }

    [Fact]
    public void PrefixInsideAnExpressionIsNotTouchedWhenTheLineParses()
    {
        const string text = "server action Probe\n  if (IEntityActionSignature:Check()):\n    end\n  end\n";
        ModuleFlow.Read(text);
        var normalized = Normalize(text);
        Assert.Equal(text, normalized.Text);
        Assert.Empty(normalized.Changes);
    }

    [Fact]
    public void AnIncompletePrefixedCallNeverBecomesAnAssignment()
    {
        const string text = "server action Probe\n  Read = IEntityActionSignature:Find(Value=1\n  end\n";
        var normalized = Normalize(text);
        Assert.Equal(text, normalized.Text);
        Assert.Empty(normalized.Changes);
    }

    [Fact]
    public void EveryFailingCallLineIsNormalizedEvenInLongActions()
    {
        var text = "server action Probe\n" + string.Concat(Enumerable.Range(0, 80).Select(i => $"  Read{i} = IServerActionSignature:Find(Value={i})\n")) + "  end\n";
        var normalized = Normalize(text);
        Assert.Equal(80, normalized.Changes.Count);
        Assert.Equal(text.Replace("IServerActionSignature:", ""), normalized.Text);
    }

    [Fact]
    public void AnEarlierUnrepairableLineDoesNotHideAnIndependentPrefixNormalization()
    {
        const string text = "server action Probe\n  nonsense\n  Read = IEntityActionSignature:Find(Value=1)\n  end\n";
        var normalized = Normalize(text);
        Assert.Equal(text.Replace("IEntityActionSignature:", ""), normalized.Text);
        var change = Assert.Single(normalized.Changes);
        Assert.Equal("FLOW_KIND_PREFIX_DROPPED", change["rule"]!.ToString());
        Assert.Equal(3, change["line"]!.GetValue<int>());
        var remaining = Assert.Throws<FlowSyntaxException>(() => ModuleFlow.Read(normalized.Text));
        Assert.Contains(remaining.Errors, e => e.StartsWith("line 2:", StringComparison.Ordinal));
        Assert.DoesNotContain(remaining.Errors, e => e.StartsWith("line 3:", StringComparison.Ordinal));
    }

    [Fact]
    public void IdenticalCallsOnDifferentLinesStaySeparateInThePublishedNormalizations()
    {
        var normalized = Normalize("server action Probe\n  IServerActionSignature:Save(Value=1)\n  IServerActionSignature:Save(Value=1)\n  end\n");
        var published = new JsonArray();
        JobNormalizer.Merge(published, normalized.Changes);
        Assert.Equal(2, published.Count);
        JobNormalizer.Merge(published, normalized.Changes);
        Assert.Equal(2, published.Count);
    }

    [Fact]
    public void EveryPrintedCallInTheO11CorpusReturnsToItsExactOriginalText()
    {
        var root = TextRoundTripCorpus.Root()!;
        var modules = JsonNode.Parse(File.ReadAllText(Path.Combine(root, "kernel", "tests", "fixtures", "text-roundtrip", "corpus.json")))!.AsArray()
            .Where(m => m!["lane"]!.ToString() == "o11").ToList();
        var present = modules.Where(m => File.Exists(m!["oml"]!.ToString())).ToList();
        if (present.Count == 0) { output.WriteLine("SKIPPED: O11 corpus captures unavailable"); return; }
        StudioAssemblies.Bind();
        var count = 0;
        // Every printed node ends in @nN. Assignment-block values are expressions, even when they start in a function call.
        var pattern = new Regex(@"^(?=.* @n\d+\r?$)(?<head> +(?:[A-Za-z_]\w* = )?(?:\(System\)\.)?)(?<callee>[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?=\()", RegexOptions.Multiline);
        foreach (var module in present)
        {
            var flow = Read(module!["oml"]!.ToString(), Path.Combine(root, "kernel", ".local", "flow-kind-prefix-tests"));
            var calls = 0;
            foreach (var entry in flow.Actions)
            {
                var lines = pattern.Matches(entry.Text).Count;
                if (lines == 0) continue;
                var prefixed = pattern.Replace(entry.Text, m => m.Groups["head"].Value + "IServerActionSignature:" + m.Groups["callee"].Value);
                var normalized = Normalize(prefixed);
                var expectedLines = entry.Text.Split('\n');
                var actualLines = normalized.Text.Split('\n');
                var differences = expectedLines.Select((line, i) => i >= actualLines.Length || line != actualLines[i]
                    ? $"line {i + 1}: expected {line}; actual {(i < actualLines.Length ? actualLines[i] : "<missing>")}" : null).OfType<string>().Take(5);
                Assert.True(entry.Text == normalized.Text, module["label"] + " / " + entry.Name + ": " + string.Join("\n", differences));
                Assert.Equal(lines, normalized.Changes.Count);
                Assert.All(normalized.Changes, change => Assert.Equal("FLOW_KIND_PREFIX_DROPPED", change["rule"]!.ToString()));
                calls += lines;
            }
            count += calls;
            output.WriteLine(module["label"] + ": " + calls + " call lines restored exactly");
        }
        Assert.True(count > 0);
        output.WriteLine(present.Count + "/" + modules.Count + " captures, " + count + " call lines");
    }

    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static ModuleFlow Read(string path, string work)
    {
        var host = new ModelHost(work);
        var loaded = typeof(ModelHost).GetMethod("Load", [typeof(string)])!.Invoke(host, [path])!;
        try
        {
            var signature = typeof(KernelModelReader).BaseType!.GetGenericArguments()[0];
            return (ModuleFlow)typeof(ModuleFlow).GetMethod("Build")!.MakeGenericMethod(signature)
                .Invoke(null, [loaded, new KernelModelReader(), "o11", "", 0L, null])!;
        }
        finally { typeof(ModelHost).GetMethod("Release")!.Invoke(null, [loaded]); }
    }
}
