using OutSystems.Model;
using ServiceStudio.Model;

namespace Anvil.Core;

public static partial class FlowLayout
{
    /// <summary>Relayout de varias actions de um modulo carregado (nomes; vazio = todas as server actions).</summary>
    public static IReadOnlyList<LayoutOutcome> ApplyAll(ESpace espace, IEnumerable<string>? actionNames, Action<string>? log = null)
    {
        var es = (IESpace)espace;
        var wanted = actionNames?.Select(a => a.Trim()).Where(a => a.Length > 0).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var results = new List<LayoutOutcome>();
        StudioAdapter.Runtime.Mutate(espace, "SSHeadless: flow relayout", _ =>
        {
            foreach (var a in es.ServerActions)
            {
                var name = a.GetType().GetProperty("Name")?.GetValue(a) as string ?? "";
                if (wanted != null && wanted.Count > 0 && !wanted.Contains(name)) continue;
                var r = Apply(a);
                results.Add(r);
                log?.Invoke(r.Refused != null
                    ? $"relayout {r.Action}: refused, geometry kept ({r.Refused})"
                    : $"relayout {r.Action}: {r.Nodes} nodes in {r.Rows} rows x {r.Columns} cols, {r.Moved} moved");
            }
        });
        return results;
    }
}
