using System.Diagnostics;
using System.Reflection;
using System.Text.Json.Nodes;

namespace Anvil.Core;

/// <summary>
/// `api --op native --types A,B,...`: the native probes of the discover (NativeSurface, one per type) in ONE process, the
/// Studio bound and its assemblies loaded once instead of once per type (lote 3, L3a: ~126 O11 and ~75 ODC cold
/// processes after every kernel release). Each type answers what `api --op native --type T` answers in a process of its
/// own: the candidates are looked up among the assemblies loaded when the first probe starts (what a fresh process has
/// at that point), never among those the earlier probes of the batch loaded by reflection, and the model plugins are
/// the same files either way. results[T] is the envelope that single process would print without its command and
/// timing ({ok:true, data} or the error envelope of Errors), so one type that throws never takes the others with it.
/// </summary>
public static class NativeProbe
{
    public static JsonObject DescribeMany(IEnumerable<string> types)
    {
        _ = StudioAdapter.Runtime;
        Assembly[] fresh = AppDomain.CurrentDomain.GetAssemblies();
        var results = new JsonObject();
        foreach (var type in types)
        {
            if (results.ContainsKey(type)) continue;
            var sw = Stopwatch.StartNew();
            try { results[type] = new JsonObject { ["ok"] = true, ["data"] = NativeSurface.Describe(type, name => ModelApiMetadata.Types(name, fresh)) }; }
            catch (Exception ex) { results[type] = Errors.Envelope("api", ex, sw.ElapsedMilliseconds); }
        }
        return new JsonObject
        {
            ["op"] = "native", ["types"] = results.Count, ["results"] = results,
            ["note"] = "one result per type, each the answer of api --op native --type <T> in a process of its own (ok and data, or the error of that type alone)",
        };
    }

    /// <summary>The type names of `--types` (comma separated, blanks dropped, first occurrence kept, order kept).</summary>
    public static IReadOnlyList<string> Names(string list)
    {
        var names = list.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Distinct(StringComparer.Ordinal).ToList();
        return names.Count > 0 ? names : throw new ArgumentException("--types names no type (comma separated: IEntity,IAction)");
    }
}
