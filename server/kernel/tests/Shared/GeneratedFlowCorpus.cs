using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Anvil.Tests;

/// <summary>
/// The C# translator's corpus for the generated-flow sweeps of both lanes (GeneratedFlowRulesTests, GeneratedFlowRulesOdcTests):
/// every source under tests/csharp, subfolders included, derived from the folder; what the source itself writes (its loops),
/// read with Roslyn; and the checks on the planned logic that the flow rules alone do not make.
/// </summary>
internal static class GeneratedFlowCorpus
{
    /// <summary>A source that compiles only with others of the corpus (its types live there), by its corpus name.</summary>
    internal static readonly IReadOnlyDictionary<string, string[]> Bundles = new Dictionary<string, string[]>(StringComparer.Ordinal)
    {
        // StockRuntime exercises the types and actions of ColdStock (RuntimeCaseSourceTests compiles them together).
        ["StockRuntime"] = ["ColdStock"],
    };

    /// <summary>Every source of the corpus by its name: a file of tests/csharp without ".cs.txt", or a subfolder, whose files
    /// are one source (they are compiled together, as the tests of each subfolder compile them).</summary>
    internal static IEnumerable<object[]> Sources(string root)
    {
        var corpus = Path.Combine(root, "tests", "csharp");
        return Directory.GetFiles(corpus, "*.cs.txt").Select(f => Path.GetFileName(f)[..^".cs.txt".Length])
            .Concat(Directory.GetDirectories(corpus).Where(d => Directory.GetFiles(d, "*.cs.txt", SearchOption.AllDirectories).Length > 0)
                .Select(d => Path.GetFileName(d) + "/"))
            .OrderBy(n => n, StringComparer.Ordinal).Select(n => new object[] { n });
    }

    /// <summary>The files of a source, by the name the bundle gives each (its file name without ".txt").</summary>
    internal static Dictionary<string, string> Files(string root, string name)
    {
        var corpus = Path.Combine(root, "tests", "csharp");
        if (name.EndsWith('/'))
            return Directory.GetFiles(Path.Combine(corpus, name.TrimEnd('/')), "*.cs.txt", SearchOption.AllDirectories).OrderBy(f => f, StringComparer.Ordinal)
                .ToDictionary(f => Path.GetFileName(f)[..^".txt".Length], File.ReadAllText, StringComparer.Ordinal);
        return (Bundles.TryGetValue(name, out var with) ? with.Append(name) : new[] { name })
            .ToDictionary(n => n + ".cs", n => File.ReadAllText(Path.Combine(corpus, n + ".cs.txt")), StringComparer.Ordinal);
    }

    /// <summary>The contract the delivery sends for a source: its text, or its files (a bundle, a subfolder).</summary>
    internal static JsonObject Contract(string root, string name)
    {
        var files = Files(root, name);
        if (files.Count == 1 && !name.EndsWith('/')) return new JsonObject { ["csharpSource"] = files.Values.Single() };
        return new JsonObject { ["csharpSource"] = new JsonObject { ["files"] = new JsonObject(files.Select(f => KeyValuePair.Create(f.Key, (JsonNode?)JsonValue.Create(f.Value)))) } };
    }

    private static IEnumerable<string> Texts(JsonObject contract) => contract["csharpSource"] switch
    {
        JsonObject { } bundle => bundle["files"]!.AsObject().Select(f => f.Value!.ToString()),
        { } text => [text.ToString()],
        _ => [],
    };

    /// <summary>The loops each method of the source writes, as the translator labels them: a for or while loop by its condition
    /// (a while step's label), a foreach by its iteration variable (the local the translator assigns first in the step).</summary>
    private static Dictionary<string, (HashSet<string> Conditions, HashSet<string> Variables)> SourceLoops(JsonObject contract)
    {
        var loops = new Dictionary<string, (HashSet<string>, HashSet<string>)>(StringComparer.Ordinal);
        foreach (var text in Texts(contract))
            foreach (var method in CSharpSyntaxTree.ParseText(text).GetRoot().DescendantNodes().OfType<MethodDeclarationSyntax>())
            {
                if (!loops.TryGetValue(method.Identifier.Text, out var found))
                    loops[method.Identifier.Text] = found = (new HashSet<string>(StringComparer.Ordinal), new HashSet<string>(StringComparer.Ordinal));
                foreach (var node in method.DescendantNodes())
                    switch (node)
                    {
                        case ForStatementSyntax f: found.Item1.Add(f.Condition?.ToString() ?? "Continuous loop"); break;
                        case WhileStatementSyntax w: found.Item1.Add(w.Condition.ToString()); break;
                        case ForEachStatementSyntax e: found.Item2.Add(e.Identifier.Text); break;
                    }
            }
        return loops;
    }

    /// <summary>The queries (by action, the name of the get step) the planned logic writes inside a loop of the source: the
    /// only ones whose QUERY_IN_LOOP is the user's code. A query inside a loop only the translator writes is not here.</summary>
    internal static HashSet<(string Action, string Query)> QueriesInSourceLoops(JsonArray planned, JsonObject contract)
    {
        var loops = SourceLoops(contract);
        var found = new HashSet<(string, string)>();
        foreach (var action in Actions(planned))
        {
            var name = action["name"]?.ToString() ?? "";
            if (!loops.TryGetValue(name, out var source)) continue;
            bool SourceLoop(JsonObject step)
            {
                if (step["while"] == null || step["do"] is not JsonArray body) return false;
                if (step["label"]?.ToString() is { } label && source.Conditions.Contains(label)) return true;
                return body.OfType<JsonObject>().Any(s => s["assign"] is JsonObject assign
                    && assign.Any(a => source.Variables.Any(v => Regex.IsMatch(a.Key, @"^Var[0-9]+_" + Regex.Escape(v) + "$"))));
            }
            void Walk(JsonArray steps, bool inLoop)
            {
                foreach (var step in steps.OfType<JsonObject>())
                {
                    if (inLoop && step["get"] != null && step["as"]?.ToString() is { } query) found.Add((name, query));
                    var loop = inLoop || SourceLoop(step);
                    // then, else, do, next, the switch cases and their steps, a try and its handlers: every nested step list.
                    foreach (var (_, value) in step) if (value is JsonArray nested) Walk(nested, loop);
                }
            }
            Walk(action["steps"] as JsonArray ?? [], false);
        }
        return found;
    }

    /// <summary>The actions of the planned logic ops.</summary>
    internal static IEnumerable<JsonObject> Actions(JsonArray planned) =>
        planned.OfType<JsonObject>().Where(o => o["op"]?.ToString() == "logic").SelectMany(o => (o["data"]?["actions"] as JsonArray ?? []).OfType<JsonObject>());

    /// <summary>The For Each steps that only copy the rows of a query into a list: over a query's list, a body of assigns and
    /// Ifs (no else) of assigns, then one ListAppend. The translator writes each as a List action (MethodQueries.MappedRows), so
    /// one left here is a materialization it failed to rewrite, whatever the flow rules' recognizer says of it.</summary>
    internal static IEnumerable<string> MappingOnlyLoops(JsonArray planned)
    {
        static bool Assigns(JsonNode? step) => step is JsonObject { Count: 1 } o && o["assign"] is JsonObject;
        static bool Copies(JsonArray body) =>
            body.Count >= 1 && body[^1] is JsonObject last && last["call"]?.ToString() == "ListAppend"
            && body.Take(body.Count - 1).All(s => Assigns(s)
                || s is JsonObject { Count: 2 } test && test["if"] != null && test["then"] is JsonArray then && then.All(Assigns));
        foreach (var action in Actions(planned))
        {
            var found = new List<string>();
            void Walk(JsonArray steps)
            {
                foreach (var step in steps.OfType<JsonObject>())
                {
                    if (step["foreach"]?.ToString() is { } list && Regex.IsMatch(list, @"^AvQuery[0-9]+\.List$") && step["do"] is JsonArray body && Copies(body))
                        found.Add(action["name"] + ": foreach " + list);
                    foreach (var (_, value) in step) if (value is JsonArray nested) Walk(nested);
                }
            }
            Walk(action["steps"] as JsonArray ?? []);
            foreach (var f in found) yield return f;
        }
    }

    /// <summary>The List actions with a mapping the planned logic writes, by action.</summary>
    internal static Dictionary<string, int> MappedAppends(JsonArray planned)
    {
        var counts = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var action in Actions(planned))
        {
            var n = 0;
            void Walk(JsonArray steps)
            {
                foreach (var step in steps.OfType<JsonObject>())
                {
                    if (step["call"]?.ToString() == "ListAppendAll" && step["args"]?["SourceList"]?.ToString()?.Contains(" mapTo { ", StringComparison.Ordinal) == true) n++;
                    foreach (var (_, value) in step) if (value is JsonArray nested) Walk(nested);
                }
            }
            Walk(action["steps"] as JsonArray ?? []);
            if (n > 0) counts[action["name"]!.ToString()] = n;
        }
        return counts;
    }
}
