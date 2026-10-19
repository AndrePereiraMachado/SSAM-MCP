using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Preflight;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>Headless native naming oracle: creates and removes only disposable in-memory actions, never opens a Studio.</summary>
public sealed class ActionNameCollisionCorpusTests(ITestOutputHelper output)
{
    [Fact]
    public void TheNativeNameOracleDoesNotDependOnAnExternalAcceptanceCapture()
    {
        var root = TextRoundTripCorpus.Root()!;
        var source = File.ReadAllText(Path.Combine(root, "kernel", "tests", "Anvil.Tests", "ActionNameCollisionCorpusTests.cs"));
        var obsolete = string.Concat("C:", "\\t\\codex\\", "cx1\\replay\\");
        Assert.DoesNotContain(obsolete, source);
    }

    [Fact]
    public void PredictionsAndPatchNamesAgreeWithTheNativeNamingScope()
    {
        // An isolated test output folder may be outside the checkout (parallel offline validation).
        var root = Environment.GetEnvironmentVariable("ACTION_NAME_ORACLE_ROOT") ?? TextRoundTripCorpus.Root()!;
        var manifest = JsonNode.Parse(File.ReadAllText(Path.Combine(root, "kernel", "tests", "fixtures", "text-roundtrip", "corpus.json")))!.AsArray();
        var modules = manifest.OfType<JsonObject>().Where(m => m["lane"]!.ToString() == "o11")
            .Select(m => (Name: m["label"]!.ToString(), File: m["oml"]!.ToString())).ToList();
        if (Environment.GetEnvironmentVariable("ACTION_NAME_ORACLE_MODULES") is { Length: > 0 } only)
        {
            var selected = only.Split(',', StringSplitOptions.TrimEntries).ToHashSet(StringComparer.OrdinalIgnoreCase);
            modules = modules.Where(m => selected.Contains(m.Name)).ToList();
        }
        var available = modules.Where(m => File.Exists(m.File)).ToList();
        if (available.Count == 0) { output.WriteLine("WARNING: no O11 corpus captures; collision oracle did not run"); return; }
        if (available.Count < modules.Count) output.WriteLine($"WARNING: {modules.Count - available.Count} captures unavailable; their collision oracles did not run");
        StudioAssemblies.Bind();
        var watch = Stopwatch.StartNew();
        var total = 0;
        foreach (var module in available)
        {
            var result = Check(module.File);
            total += result.Count;
            output.WriteLine(module.Name + ": " + result.Count + " native name predictions and free patch names matched: " + result.Names);
        }
        output.WriteLine($"{available.Count} captures, {total} predictions, {watch.Elapsed.TotalSeconds:0.0} seconds");
        Assert.True(total > 0);
        Assert.True(watch.Elapsed < TimeSpan.FromMinutes(5), "the sampled collision oracle must finish within five minutes");
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static (int Count, string Names) Check(string file)
    {
        var host = new ModelHost(Path.Combine(Path.GetDirectoryName(typeof(ActionNameCollisionCorpusTests).Assembly.Location)!, "collision-oracle"));
        return host.WithSession(file, session => {
            var facts = session.ActionNameFacts();
            var all = session.ActionNames();
            var candidates = all.Where(a => a.Kind == "IEntityActionSignature").Take(8)
                .Concat(all.Where(a => a.Kind is "IServerAction" or "IClientAction" or "IServiceAction").Take(6))
                .Concat(all.Where(a => a.Kind.Contains("Signature", StringComparison.Ordinal) && a.Kind != "IEntityActionSignature").Take(3))
                .Select(a => a.Name).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
            foreach (var kind in new[] { "IScreenAction", "IMobileScreen", "IMobileBlock" })
                if (session.ApplyOne(new JsonObject { ["op"] = "find", ["type"] = kind, ["max"] = 1 })!.AsArray().FirstOrDefault()?["name"]?.ToString() is { Length: > 0 } name
                    && !candidates.Contains(name, StringComparer.OrdinalIgnoreCase)) candidates.Add(name);
            for (var n = 0; n < 3; n++) candidates.Add("CollisionOracleFree" + n);
            var failures = new List<string>();
            var scopes = facts.ModuleType is "Mobile" or "MobileLibrary" or "CrossDevice" or "ReactiveLibrary" ? new[] { "server", "client" } : ["server"];
            foreach (var scope in scopes)
            foreach (var name in candidates)
            {
                var observed = Probe(session, name, scope);
                var predicted = facts.ActionNameTaken(name, scope);
                if ((predicted != null) != observed.Renamed)
                {
                    failures.Add($"{file}: scope={scope}; name={name}; predicted={predicted != null}; kind={predicted?.Kind}; owner={predicted?.Owner}; nativeRenamed={observed.Renamed}; actual={observed.Actual}; evidence={Evidence(session, name)}");
                    continue;
                }
                if (predicted != null)
                {
                    var occupied = all.Where(a => a.Scope == scope).Select(a => a.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
                    var free = NameRules.Free(name, occupied);
                    Assert.Equal(observed.Actual, free);
                    Assert.False(Probe(session, free, scope).Renamed, "the proposed patch name collides: " + free);
                }
                else if (all.Any(a => a.Name.Equals(name, StringComparison.OrdinalIgnoreCase) && a.Scope != scope))
                    Assert.Equal(name, ProductCreate(session, name, scope));
            }
            Assert.True(failures.Count == 0, string.Join(Environment.NewLine, failures));
            if (scopes.Length == 2) TextPair(session, facts);
            return (candidates.Count * scopes.Length, string.Join("/", scopes) + ": " + string.Join(", ", candidates));
        });
    }

    private static (bool Renamed, string Actual) Probe(ModelSession session, string name, string scope)
    {
        var observed = (Renamed: false, Actual: name);
        session.Mutate("action naming oracle", () => observed = session.ProbeNativeActionName(name, scope));
        return observed;
    }

    private static string ProductCreate(ModelSession session, string name, string scope)
    {
        var actual = "";
        session.Mutate("cross-scope public create", () => {
            var created = session.ApplyOne(new JsonObject { ["op"] = "create", ["parent"] = "@espace", ["type"] = scope == "client" ? "IClientAction" : "IServerAction", ["name"] = name })!;
            actual = created["name"]!.ToString();
            session.ApplyOne(new JsonObject { ["op"] = "delete", ["target"] = "@" + created["key"]!.ToString(), ["force"] = true });
        });
        return actual;
    }

    private static string Evidence(ModelSession session, string name)
    {
        var rows = new List<string>();
        foreach (var kind in new[] { "IEntityActionSignature", "IServerAction", "IClientAction", "IServerActionSignature", "IClientActionSignature", "IScreenAction", "IMobileScreen", "IMobileBlock" })
        {
            object? element;
            try { element = session.Resolve(kind + ":" + name); } catch { continue; }
            for (var depth = 0; element != null && depth < 4; depth++)
            {
                var type = element.GetType();
                var flags = type.GetProperties().Where(p => p.PropertyType == typeof(bool) && (p.Name.Contains("Client") || p.Name.Contains("Server") || p.Name.Contains("Static")))
                    .Select(p => { try { return p.Name + "=" + p.GetValue(element); } catch { return p.Name + "=?"; } });
                rows.Add(type.FullName + " [" + string.Join(",", type.GetInterfaces().Select(i => i.Name).Where(n => n.Contains("Entity") || n.Contains("Action"))) + "] " + string.Join(",", flags));
                element = type.GetProperty("Parent")?.GetValue(element);
            }
        }
        return string.Join(" -> ", rows.Distinct());
    }

    private static void TextPair(ModelSession session, IBaseFacts facts)
    {
        var name = "CollisionOracleScopePair";
        for (var suffix = 2; facts.ActionNameTaken(name, "server") != null || facts.ActionNameTaken(name, "client") != null; suffix++) name = "CollisionOracleScopePair" + suffix;
        session.Mutate("cross-scope text pair", () => session.ApplyOne(new JsonObject {
            ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray("server action " + name + "\n  end\n", "client action " + name + "\n  end\n") }
        }));
    }
}
