using System.Text.Json.Nodes;
using Anvil.Reading;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>
/// Family F5 (composition in one delivery), the session's side of JobComposition: the plan of the job against the names the
/// base already has, the roots declared before the first op (a screen an earlier op navigates to: its name, flow and inputs,
/// compiled from the signature of its document) and the results of the apply in the job's order. Every move and every root
/// declared first is listed in the receipt (composedOrder, declaredFirst), never silent.
/// </summary>
public sealed partial class ModelSession
{
    // The roots declared before the first op, by name, until their document fills them (DocumentCompiler adopts the root).
    private readonly Dictionary<string, IObjectSignature> _declaredRoots = new(StringComparer.OrdinalIgnoreCase);

    // The plan of the job the apply runs (its refusals never advise moving an op the kernel moved).
    private JobComposition.Plan? _composition;

    // The ops of the job that started to run, in the order they ran (H10: an html op fills the logic ops that have not run yet,
    // whatever their place in the job).
    private readonly HashSet<int> _ranOps = [];

    /// <summary>Whether the kernel ran op <paramref name="op"/> at another place than the job writes it.</summary>
    internal bool ComposedElsewhere(int op) => _composition?.Moved.Any(m => m.Op == op) == true;

    private JobComposition.Plan Compose(JsonArray ops, int[] order, Action<string>? log)
    {
        _declaredRoots.Clear();
        _composition = null;
        _ranOps.Clear();
        if (ops.Count < 2) return new(order, [], [], []);
        HashSet<string>? names = null;
        JobComposition.Plan plan;
        try { plan = JobComposition.Compose(ops, order, name => (names ??= ComposableNames()).Contains(name)); }
        catch (Exception error) { log?.Invoke("  composition not planned: " + Unwrap(error)); return new(order, [], [], []); }
        // Every op whose place changed (the one an earlier op needs, and each op it passed).
        foreach (var move in plan.Moved)
        {
            Report("composedOrder", new JsonObject { ["op"] = move.Op, ["from"] = move.From, ["to"] = move.To, ["before"] = move.Before, ["declares"] = move.Declares,
                ["why"] = move.Before is { } before ? $"op #{before} needs {move.Declares}, which op #{move.Op} creates: op #{move.Op} runs first"
                    : $"op #{move.Op} runs after the ops moved before it" });
            log?.Invoke($"  composition: op #{move.Op} runs at {move.To} (written at {move.From})");
        }
        foreach (var cycle in plan.Cycles) log?.Invoke("  composition: " + cycle);
        if (plan.Kept != null) log?.Invoke("  composition: " + plan.Kept);
        _composition = plan;
        DeclareRoots(ops, plan.Roots, log);
        return plan;
    }

    // The names of the elements another op can reference whole or by signature: the screens and blocks of the module's flows,
    // its actions, entities, structures and the elements of its references (never what is inside a screen or an action).
    private HashSet<string> ComposableNames()
    {
        var reader = new KernelModelReader();
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var pending = new Stack<IObjectSignature>();
        pending.Push((IObjectSignature)_es);
        while (pending.TryPop(out var node))
        {
            foreach (var child in reader.ChildrenOf(node))
            {
                if (child.WasDeleted) continue;
                var kind = reader.KindOf(child);
                var leaf = kind.EndsWith("Action", StringComparison.Ordinal) || kind.EndsWith("Screen", StringComparison.Ordinal) || kind.EndsWith("Block", StringComparison.Ordinal)
                    || kind.EndsWith("Entity", StringComparison.Ordinal) || kind.EndsWith("Structure", StringComparison.Ordinal) || kind.EndsWith("Email", StringComparison.Ordinal);
                if (reader.NameOf(child) is { Length: > 0 } name && (leaf || kind.EndsWith("Flow", StringComparison.Ordinal) || kind.EndsWith("Variable", StringComparison.Ordinal)
                    || kind.EndsWith("Property", StringComparison.Ordinal) || kind.EndsWith("Role", StringComparison.Ordinal) || kind.EndsWith("Exception", StringComparison.Ordinal)))
                    names.Add(name);
                if (!leaf) pending.Push(child);
            }
        }
        return names;
    }

    // The root of each document an earlier op navigates to, before the first op: its signature (JobComposition.Signature: the
    // root with its name and flow, its inputs and events) compiled as a document; its own op fills it in place. A signature
    // that does not compile declares nothing: the document's op refuses with every problem of its text.
    private void DeclareRoots(JsonArray ops, IReadOnlyList<(int Op, string Name)> roots, Action<string>? log)
    {
        foreach (var (index, name) in roots)
        {
            if (ops[index] is not JsonObject op || op["data"]?["html"] is not JsonValue value || !value.TryGetValue<string>(out var html)
                || JobComposition.Signature(html) is not { } signature) continue;
            var compiler = new DocumentCompiler(this, signature, "/html", new DocumentOptions { Declaration = true });
            try
            {
                var report = compiler.Run();
                if (report["key"]?.ToString() is { Length: > 0 } key && Resolve("@" + key) is IObjectSignature root)
                {
                    _declaredRoots[name] = root;
                    Report("declaredFirst", new JsonObject { ["op"] = index, ["root"] = name, ["kind"] = report["kind"]?.ToString(),
                        ["why"] = $"an op that runs before op #{index} navigates to {name}: its name and inputs are declared first, op #{index} fills it" });
                    log?.Invoke($"  composition: {name} (op #{index}) declared before the first op");
                }
            }
            catch (Exception error)
            {
                compiler.Discard();
                log?.Invoke($"  composition: {name} (op #{index}) not declared first: {Unwrap(error)}");
            }
        }
    }

    // The results of the apply in the job's order (each with the op it answers), when the composition ran the ops in another.
    private static void InJobOrder(JsonArray results, List<int> executed)
    {
        if (results.Count != executed.Count) return;
        var entries = results.Select((entry, k) => (Entry: entry!, Op: executed[k])).OrderBy(e => e.Op).ToList();
        results.Clear();
        foreach (var (entry, op) in entries) { entry["index"] = op; results.Add(entry); }
    }
}
