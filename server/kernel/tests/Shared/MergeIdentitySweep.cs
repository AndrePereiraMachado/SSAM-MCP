using System.Collections;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using OutSystems.Model;
using ServiceStudio.Model;

namespace Anvil.Tests;

/// <summary>
/// The content proof's identity rule (MergeContentProof, ssam-merge-identity/2) over the repository's jobs, in either lane.
/// Each job is built twice, independently, from the same base: every element the job creates gets a new local key from the
/// Studio's own key generator, and the keyed collections enumerate in another order, as after a native merge that recreates
/// unchanged elements. The two builds are the same content: the proof must accept them. Then one property of one element
/// of each kind is changed in the second build (in memory, through the kernel's own set verb): the proof must refuse it and
/// name an element. Optionally the second half of a merge: the candidate merged natively over its base (the lane's merge)
/// must be accepted against the candidate. Producers and bases a job builds from another job are built once and shared by
/// both builds (two builds of a producer are two different producers, whose elements the proof rightly tells apart).
/// </summary>
internal static class MergeIdentitySweep
{
    internal delegate string? NativeMerge(ModelHost host, byte[] basis, byte[] candidate, string merged);

    internal static string Root => JobRunner.RepoRoot(Path.GetDirectoryName(typeof(MergeIdentitySweep).Assembly.Location)!)!;

    private static bool Keep => Environment.GetEnvironmentVariable("SSAM_MERGE_IDENTITY_KEEP") is { Length: > 0 };

    private static readonly HashSet<Type> Scalars = [typeof(string), typeof(bool), typeof(int), typeof(long), typeof(decimal), typeof(double)];

    internal static JsonObject Run(string jobsDir, string work, NativeMerge? merge, string? filter, int mutationsPerKind)
    {
        Directory.CreateDirectory(work);
        var prebuilt = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var mutatedKinds = new Dictionary<string, int>(StringComparer.Ordinal);
        var jobs = new JsonArray();
        var totals = new Dictionary<string, int>(StringComparer.Ordinal);
        void Count(string name, int by = 1) => totals[name] = totals.GetValueOrDefault(name) + by;
        var files = Directory.EnumerateFiles(jobsDir, "*.json", SearchOption.TopDirectoryOnly)
            .Where(f => !Path.GetFileName(f).StartsWith(".mi-", StringComparison.Ordinal))
            .Where(f => string.IsNullOrEmpty(filter) || filter.Split(',').Any(x => Path.GetFileNameWithoutExtension(f).Equals(x.Trim(), StringComparison.OrdinalIgnoreCase)))
            .OrderBy(f => f, StringComparer.Ordinal).ToList();
        foreach (var file in files)
        {
            var name = Path.GetFileNameWithoutExtension(file);
            var record = new JsonObject { ["job"] = name };
            jobs.Add(record);
            Count("jobs");
            var dir = Path.Combine(work, name); Directory.CreateDirectory(dir);
            string? prepared = null;
            try
            {
                var bindings = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                prepared = Prepare(file, dir, prebuilt, bindings);
                var first = Build(prepared ?? file, Path.Combine(dir, "first.oml"), bindings);
                var second = Build(prepared ?? file, Path.Combine(dir, "second.oml"), bindings);
                if (first.Error != null || second.Error != null) { record["build"] = first.Error ?? second.Error; Count("buildRefused"); continue; }
                Count("built");
                var host = new ModelHost(Path.Combine(dir, "proof-model"));
                var proof = MergeContentProof.Check(host, first.Path!, second.Path!);
                var (regenerated, total) = Regenerated(host, first.Path!, second.Path!);
                record["localKeys"] = total; record["regeneratedKeys"] = regenerated;
                Count("localKeys", total); Count("regeneratedKeys", regenerated);
                record["checked"] = proof["checked"]!.GetValue<int>();
                var ambiguous = proof["coverage"]!["expectedOmissions"]!.AsArray().Count(o => o?["property"]?.ToString() == "$identity");
                record["ambiguousIdentities"] = ambiguous; Count("ambiguousIdentities", ambiguous);
                var accepted = proof["accepted"]!.GetValue<bool>();
                record["accepted"] = accepted;
                Count(accepted ? "accepted" : "refused");
                // The oracle, with no identity in it: the multiset of (readable path, property, value) of each build. Equal
                // multisets are the same content: a refusal there is an identity fault. Different ones mean the job builder is
                // not deterministic there (a layout position, a generated text, a selector that two elements match): the proof
                // is right to refuse, and an acceptance would be a gap.
                var (onlyFirst, onlySecond) = ContentDelta(host, first.Path!, second.Path!);
                var sameContent = onlyFirst.Count == 0 && onlySecond.Count == 0;
                record["sameContent"] = sameContent;
                if (!sameContent) record["contentDelta"] = new JsonArray(onlyFirst.Take(5).Select(s => (JsonNode)("- " + Clip(s, 200)))
                    .Concat(onlySecond.Take(5).Select(s => (JsonNode)("+ " + Clip(s, 200)))).ToArray());
                if (!accepted)
                {
                    var differences = proof["differences"]!.AsArray().OfType<JsonObject>().ToList();
                    record["differences"] = Summary(proof["differences"]!.AsArray(), 40);
                    record["differenceCount"] = differences.Count;
                    record["refusal"] = sameContent ? "identity" : "buildsDiffer";
                    Count(sameContent ? "refused:identity" : "refused:buildsDiffer");
                }
                else if (!sameContent) Count("accepted:contentDiffers");
                if (merge != null)
                {
                    var basis = JobRunner.ResolveBase(new ModelHost(Path.Combine(dir, "base-model")), prepared ?? file, bindings);
                    var mergedPath = Path.Combine(dir, "merged.oml");
                    string? mergeError;
                    try { mergeError = merge(new ModelHost(Path.Combine(dir, "merge-model")), File.ReadAllBytes(basis), File.ReadAllBytes(first.Path!), mergedPath); }
                    catch (Exception error) { mergeError = error.GetType().Name + ": " + Clip(error.Message); }
                    if (mergeError != null) { record["merge"] = mergeError; Count("mergeFailed"); }
                    else
                    {
                        var merged = MergeContentProof.Check(new ModelHost(Path.Combine(dir, "merge-proof-model")), first.Path!, mergedPath);
                        var mergeAccepted = merged["accepted"]!.GetValue<bool>();
                        record["mergeAccepted"] = mergeAccepted;
                        Count(mergeAccepted ? "mergeAccepted" : "mergeRefused");
                        if (!mergeAccepted) record["mergeDifferences"] = Summary(merged["differences"]!.AsArray());
                    }
                }
                if (accepted && mutationsPerKind > 0)
                {
                    var mutations = Mutate(host, first.Path!, second.Path!, name, mutatedKinds, mutationsPerKind);
                    record["mutations"] = mutations;
                    foreach (var m in mutations.OfType<JsonObject>()) Count("mutation:" + m["outcome"]);
                }
            }
            catch (Exception error) { record["error"] = error.GetType().Name + ": " + Clip(error.ToString()); Count("errors"); }
            finally
            {
                if (prepared != null) try { File.Delete(prepared); } catch { }
                // Two builds, a merge and their hosts take tens of megabytes per job (hundreds on the large ODC fixtures):
                // only the counts stay, unless SSAM_MERGE_IDENTITY_KEEP asks for the files.
                if (!Keep) try { Directory.Delete(dir, true); } catch { }
            }
        }
        if (!Keep) try { Directory.Delete(Path.Combine(Root, ".local", "merge-identity-sweep", "work"), true); } catch { }
        var rule = typeof(MergeContentProof).GetField("IdentityRule")?.GetValue(null)?.ToString() ?? "local ObjectKey (before ssam-merge-identity/2)";
        var summary = new JsonObject { ["identityRule"] = rule, ["jobsDir"] = jobsDir, ["kindsMutated"] = mutatedKinds.Count };
        foreach (var (key, value) in totals.OrderBy(t => t.Key, StringComparer.Ordinal)) summary[key] = value;
        summary["results"] = jobs;
        return summary;
    }

    internal sealed record Built(string? Path, string? Error);

    internal static Built Build(string jobPath, string outPath, IReadOnlyDictionary<string, string>? bindings)
    {
        try
        {
            var result = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(Path.GetDirectoryName(outPath)!, "model-" + Guid.NewGuid().ToString("N")[..8])),
                null, jobPath, outPath, bindings: bindings))!;
            if (result["accepted"]?.GetValue<bool>() != true || !File.Exists(outPath)) return new(null, "not accepted: " + Clip(result["policyMessages"]?.ToJsonString() ?? result.ToJsonString()));
            return new(outPath, null);
        }
        catch (Exception error) { return new(null, (Errors.FindCoded(error)?.Code ?? error.GetType().Name) + ": " + Clip(Errors.Text(error))); }
    }

    /// <summary>A copy of the job (next to it, so its relative sources still resolve) whose job-built base and producers are
    /// built once and shared: the base by its path, a producer by a name bound to its build. Null when nothing is shared.</summary>
    private static string? Prepare(string jobPath, string work, Dictionary<string, string> prebuilt, Dictionary<string, string> bindings)
    {
        var job = JsonNode.Parse(File.ReadAllText(jobPath))!;
        var changed = false;
        var jobDir = Path.GetDirectoryName(Path.GetFullPath(jobPath))!;
        string Shared(string spec)
        {
            var source = Path.GetFullPath(JobRunner.ResolveJobFile(spec, jobDir));
            if (prebuilt.TryGetValue(source, out var known)) return known;
            var inner = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            var innerPrepared = Prepare(source, work, prebuilt, inner);
            try
            {
                // A base must be a fixture or an OML of a capture folder (JobSources): the shared builds live in .local/.../work.
                var shared = Path.Combine(Root, ".local", "merge-identity-sweep", "work"); Directory.CreateDirectory(shared);
                var output = Path.Combine(shared, Path.GetFileNameWithoutExtension(source) + "-" + Guid.NewGuid().ToString("N")[..8] + ".oml");
                var built = Build(innerPrepared ?? source, output, inner);
                if (built.Error != null) throw new InvalidOperationException("shared source " + spec + " refused: " + built.Error);
                return prebuilt[source] = built.Path!;
            }
            finally { if (innerPrepared != null) try { File.Delete(innerPrepared); } catch { } }
        }
        if (job is JsonObject root && root["base"]?.ToString() is { } basis && basis.StartsWith("job:", StringComparison.Ordinal))
        { root["base"] = Shared(basis); changed = true; }
        var ops = job is JsonArray direct ? direct : job["ops"] as JsonArray;
        var n = 0;
        foreach (var op in ops?.OfType<JsonObject>() ?? [])
        {
            if (op["op"]?.ToString() == "reference" && op["producer"]?.ToString() is { } producer && producer.StartsWith("job:", StringComparison.Ordinal))
            {
                var name = "SweepProducer" + (++n);
                bindings[name] = Shared(producer); op["producer"] = name; changed = true;
            }
            if (op["op"]?.ToString() == "prototype" && op["data"]?["bind"]?["producer"]?.ToString() is { } bound && bound.StartsWith("job:", StringComparison.Ordinal))
            {
                var name = "SweepProducer" + (++n);
                bindings[name] = Shared(bound); op["data"]!["bind"]!["producer"] = name; changed = true;
            }
        }
        if (!changed) return null;
        var copy = Path.Combine(jobDir, ".mi-" + Guid.NewGuid().ToString("N")[..8] + "-" + Path.GetFileName(jobPath));
        File.WriteAllText(copy, job.ToJsonString());
        return copy;
    }

    /// <summary>The module's own local keys of the second build (outside producer references) and how many of them the first
    /// build does not have.</summary>
    private static (int Regenerated, int Total) Regenerated(ModelHost host, string first, string second)
    {
        HashSet<string> Keys(string path)
        {
            var model = host.Load(File.ReadAllBytes(path));
            try { return Walk(model).Select(n => n.ObjectKey?.ToString() ?? "").ToHashSet(StringComparer.Ordinal); }
            finally { ModelHost.Release(model); }
        }
        var a = Keys(first); var b = Keys(second);
        return (b.Count(k => !a.Contains(k)), b.Count);
    }

    /// <summary>The content of each build without any identity: one line per property of each element of the module (outside
    /// producer references and the proof's declared boundary), its readable path (kind:name segments), the property and the
    /// value (a reference by its target's readable path); the lines only one build has.</summary>
    private static (List<string> OnlyFirst, List<string> OnlySecond) ContentDelta(ModelHost host, string first, string second)
    {
        Dictionary<string, int> Lines(string path)
        {
            var model = host.Load(File.ReadAllBytes(path));
            try
            {
                var lines = new Dictionary<string, int>(StringComparer.Ordinal);
                foreach (var node in Walk(model).Where(n => !InReference(n) && !OutOfScope(n)))
                {
                    var at = ReadablePath(node);
                    foreach (var property in ModelApiMetadata.Properties(node.GetType())
                        .Where(p => p.CanRead && p.GetIndexParameters().Length == 0 && (p.CanWrite || p.Name is "Widgets" or "Rows" or "Cells" or "Assignments" or "InputParameters" or "OutputParameters" or "Attributes" or "Sorts" or "Conditions" or "Roles"))
                        .DistinctBy(p => p.Name))
                    {
                        if (ModelReader<IObjectSignature>.IsNoise(property.Name)) continue;
                        object? value;
                        try { value = property.GetValue(node); } catch { continue; }
                        // The values the proof compares, read as the proof reads them (an unsupported value type is out of both).
                        var text = value switch
                        {
                            null => "null",
                            string s => "text:" + s,
                            byte[] bytes => "bytes:" + Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)),
                            IObjectSignature expression when Kind(expression) == "IExpression" => "expression:" + ModelHost.Prop(expression, "Text"),
                            IObjectSignature reference => "reference:" + ReadablePath(reference),
                            IEnumerable list when property.Name == "Roles" => "set:" + string.Join(",", list.OfType<IObjectSignature>().Select(ReadablePath).OrderBy(x => x, StringComparer.Ordinal)),
                            IEnumerable list when property.Name is "Widgets" or "Rows" or "Cells" or "Assignments" or "InputParameters" or "OutputParameters" or "Attributes" or "Sorts" or "Conditions" => "list:" + string.Join(",", list.OfType<IObjectSignature>().Select(ReadablePath)),
                            bool or Enum or decimal or DateTime or Guid => value.ToString(),
                            _ when value.GetType().IsPrimitive => value.ToString(),
                            _ => null
                        };
                        if (text == null) continue;
                        var line = at + " | " + property.Name + " = " + text;
                        lines[line] = lines.GetValueOrDefault(line) + 1;
                    }
                }
                return lines;
            }
            finally { ModelHost.Release(model); }
        }
        var a = Lines(first); var b = Lines(second);
        var onlyFirst = a.Where(x => b.GetValueOrDefault(x.Key) < x.Value).Select(x => x.Key).OrderBy(x => x, StringComparer.Ordinal).ToList();
        var onlySecond = b.Where(x => a.GetValueOrDefault(x.Key) < x.Value).Select(x => x.Key).OrderBy(x => x, StringComparer.Ordinal).ToList();
        return (onlyFirst, onlySecond);
    }

    /// <summary>The readable path of an element: kind:name segments below the module (kind alone when unnamed).</summary>
    private static string ReadablePath(IObjectSignature node)
    {
        var segments = new List<string>();
        for (var n = node; n != null && n is not IESpace; n = SafeParent(n))
        {
            var name = ModelHost.Prop(n, "Name")?.ToString();
            segments.Add(string.IsNullOrEmpty(name) ? Kind(n) : Kind(n) + ":" + name);
        }
        segments.Reverse();
        return string.Join("/", segments);
    }

    internal static IEnumerable<IObjectSignature> Walk(IObjectSignature root)
    {
        var pending = new Stack<IObjectSignature>(); pending.Push(root);
        while (pending.TryPop(out var node))
        {
            yield return node;
            if (node is ServiceStudio.Model.Interfaces.ITopLevelReferenceElement || Kind(node) == "IReference") continue;
            IEnumerable<IObjectSignature> children;
            try { children = node.Children.OfType<IObjectSignature>().ToList(); } catch { continue; }
            foreach (var child in children) pending.Push(child);
        }
    }

    internal static string Kind(IObjectSignature node) => node.GetInterface()?.Name ?? node.GetType().Name;

    /// <summary>One property of one element of each kind, changed in the second build: the proof must refuse.</summary>
    private static JsonArray Mutate(ModelHost host, string first, string second, string job, Dictionary<string, int> mutatedKinds, int perKind)
    {
        var results = new JsonArray();
        var expectedLabels = new Dictionary<string, string>(StringComparer.Ordinal);
        var expectedModel = host.Load(File.ReadAllBytes(first));
        Dictionary<(string Key, string Property), string> expected;
        try { expected = MergeContentProof.Read(expectedModel, null, expectedLabels); }
        finally { ModelHost.Release(expectedModel); }
        // Seeded by the job name (a stable hash: string hash codes differ per process), so a rerun picks the same elements.
        var random = new Random(BitConverter.ToInt32(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(job)), 0) & 0x7fffffff);
        List<(string Kind, string Key)> targets;
        var probe = host.Load(File.ReadAllBytes(second));
        try
        {
            targets = Walk(probe).Where(n => n is not IESpace && !InReference(n) && !OutOfScope(n)).GroupBy(Kind)
                .Where(g => mutatedKinds.GetValueOrDefault(g.Key) < perKind)
                .Select(g => { var list = g.ToList(); var pick = list[random.Next(list.Count)]; return (g.Key, pick.ObjectKey?.ToString() ?? ""); })
                .Where(t => t.Item2.Length > 0).OrderBy(t => t.Key, StringComparer.Ordinal).ToList();
        }
        finally { ModelHost.Release(probe); }
        foreach (var (kind, key) in targets)
        {
            var outcome = new JsonObject { ["kind"] = kind };
            var model = host.Load(File.ReadAllBytes(second));
            try
            {
                var node = Walk(model).FirstOrDefault(n => n.ObjectKey?.ToString() == key);
                if (node == null) { outcome["outcome"] = "notFound"; results.Add(outcome); continue; }
                var properties = ModelApiMetadata.Properties(node.GetType())
                    .Where(p => p.CanRead && p.CanWrite && p.GetIndexParameters().Length == 0 && !ModelReader<IObjectSignature>.IsNoise(p.Name)
                        && (Scalars.Contains(p.PropertyType) || p.PropertyType.IsEnum))
                    .DistinctBy(p => p.Name).OrderBy(p => p.Name, StringComparer.Ordinal).ToList();
                // A seeded shuffle: a random property of the element, the next one when the set does not apply.
                properties = properties.OrderBy(_ => random.Next()).ToList();
                outcome["outcome"] = properties.Count == 0 ? "noScalarProperty" : "notApplicable";
                foreach (var property in properties)
                {
                    object? before;
                    try { before = property.GetValue(node); } catch { continue; }
                    var value = Changed(before, property.PropertyType);
                    if (value == null) continue;
                    try { new ModelSession((ESpace)model).Apply(new JsonArray(new JsonObject { ["op"] = "set", ["target"] = "@" + key, ["prop"] = property.Name, ["value"] = value })); }
                    catch { continue; }
                    object? after;
                    try { after = property.GetValue(node); } catch { after = null; }
                    if (Equals(before, after)) { outcome["outcome"] = "noOp"; continue; }
                    var labels = new Dictionary<string, string>(StringComparer.Ordinal);
                    var actual = MergeContentProof.Read((ESpace)model, null, labels);
                    var differences = MergeContentProof.Compare(expected, actual, expectedLabels, labels)["differences"]!.AsArray();
                    outcome["property"] = property.Name;
                    outcome["from"] = Clip(before?.ToString() ?? "null", 80); outcome["to"] = Clip(after?.ToString() ?? "null", 80);
                    outcome["differences"] = differences.Count;
                    var shortKind = kind.Length > 1 && kind[0] == 'I' && char.IsUpper(kind[1]) ? kind[1..] : kind;
                    var named = differences.OfType<JsonObject>().Any(d => d["element"]?.ToString()?.Contains(shortKind, StringComparison.Ordinal) == true);
                    outcome["outcome"] = differences.Count == 0 ? "MISS" : named ? "refusedNamed" : "refused";
                    if (differences.Count > 0) outcome["first"] = Summary(differences, 3);
                    mutatedKinds[kind] = mutatedKinds.GetValueOrDefault(kind) + 1;
                    break;
                }
            }
            catch (Exception error) { outcome["outcome"] = "error"; outcome["error"] = Clip(error.GetType().Name + ": " + error.Message); }
            finally { ModelHost.Release(model); }
            results.Add(outcome);
        }
        return results;
    }

    private static bool InReference(IObjectSignature node)
    {
        for (var n = node; n != null; n = SafeParent(n))
            if (n is ServiceStudio.Model.Interfaces.ITopLevelReferenceElement || Kind(n) == "IReference") return true;
        return false;
    }

    /// <summary>What the proof measures through another element, never on its own (its declared boundary): the derived
    /// records the native rebuilds from their owner (anonymous record structures, list types) and the flow's connector
    /// records, whose meaning is the owner's Target properties (a switch condition is read through its switch).</summary>
    internal static bool OutOfScope(IObjectSignature node)
    {
        if (node is OutSystems.Model.Logic.IActionConnector && Kind(node) != "ISwitchCondition") return true;
        for (var n = node; n != null; n = SafeParent(n))
            if (n is OutSystems.Model.Types.IListType || Kind(n) == "IAnonymousStructure") return true;
        return false;
    }

    private static IObjectSignature? SafeParent(IObjectSignature node) { try { return node.Parent as IObjectSignature; } catch { return null; } }

    /// <summary>Another value of the same type, as the set verb takes it.</summary>
    internal static JsonNode? Changed(object? value, Type type)
    {
        if (type == typeof(string)) return JsonValue.Create(string.IsNullOrEmpty(value as string) ? "SweepValue" : value + "X");
        if (type == typeof(bool)) return JsonValue.Create(!(value is true));
        if (type == typeof(int)) return JsonValue.Create((value is int i ? i : 0) + 1);
        if (type == typeof(long)) return JsonValue.Create((value is long l ? l : 0) + 1);
        if (type == typeof(decimal)) return JsonValue.Create((value is decimal d ? d : 0) + 1);
        if (type == typeof(double)) return JsonValue.Create((value is double x ? x : 0) + 1);
        if (type.IsEnum)
        {
            var names = Enum.GetNames(type);
            var current = value?.ToString();
            return names.FirstOrDefault(n => n != current) is { } other ? JsonValue.Create(other) : null;
        }
        return null;
    }

    internal static JsonArray Summary(JsonArray differences, int max = 12)
        => new(differences.OfType<JsonObject>().Take(max).Select(d => (JsonNode)new JsonObject {
            ["element"] = d["element"]?.ToString(), ["property"] = d["property"]?.ToString(),
            ["missing"] = d["missing"]?.GetValue<bool>(), ["unexpected"] = d["unexpected"]?.GetValue<bool>(),
            ["expected"] = Clip(d["expectedValue"]?.ToString() ?? "", 120), ["actual"] = Clip(d["actualValue"]?.ToString() ?? "", 120) }).ToArray());

    internal static string Clip(string text, int max = 600) => text.Length <= max ? text : text[..max] + "...";
}
