using System.Text.Json.Nodes;
using OutSystems.Model;
using OutSystems.Model.Merge;
using OutSystems.ModelAPILoader;
using ServiceStudio.Model;
using MatchType = OutSystems.Model.Merge.MatchType;   // System.IO tambem tem um MatchType

namespace Anvil.Core;

/// <summary>
/// Comparação de três vias headless na faixa ODC, pela API pública do próprio Studio
/// (<c>IModelServices.Diff</c> → <see cref="IMatchTree"/>). O SS11 não tem isto: lá a API só oferece
/// <c>bool Merge(meu, outro, base)</c>, sem árvore, e por isso o kernel tem o seu próprio
/// <c>MergeProbe</c> (excluído do build ODC).
///
/// O que a árvore dá, por objeto E por propriedade: <see cref="MatchType"/> (em ambos, só no local, só no
/// estrangeiro, só na base), <see cref="DifferenceType"/> (incluindo <c>Conflict</c> e <c>ChangedInLocal</c>),
/// e um <c>MergeAction</c> GRAVÁVEL. Aqui só se LÊ: <see cref="Compare"/> descreve as diferenças e não chama
/// <c>Merge()</c>. Aplicar o merge num módulo do tenant continua a ser decisão de quem entrega, e a entrega
/// viva passa pelo bridge (WS2), que tem os seus próprios portões e recibo.
/// </summary>
public static class OdcDiff
{
    /// <summary>
    /// Descreve o que muda de <paramref name="localOml"/> para <paramref name="foreignOml"/>. Sem base, a própria
    /// local serve de base (é a pergunta "o que o outro acrescenta ao meu"). Nada é gravado em disco nem no modelo.
    /// </summary>
    public static JsonObject Compare(ModelHost host, byte[] localOml, byte[] foreignOml, byte[]? baseOml = null, int sample = 20)
    {
        ArgumentNullException.ThrowIfNull(host);
        var local = host.Load(localOml);
        var foreign = host.Load(foreignOml);
        var basis = baseOml == null ? local : host.Load(baseOml);
        try
        {
            using var tree = Loader.ModelServicesInstance.Diff((IESpace)local, (IESpace)foreign, (IESpace)basis);
            var all = tree.AllMatches.ToList();
            var byType = new JsonObject();
            foreach (var group in all.GroupBy(m => m.Type).OrderBy(g => g.Key.ToString(), StringComparer.Ordinal))
                byType[group.Key.ToString()] = group.Count();
            var byDifference = new JsonObject();
            foreach (var group in all.Where(m => m.Difference != DifferenceType.None)
                         .GroupBy(m => m.Difference.ToString()).OrderByDescending(g => g.Count()))
                byDifference[group.Key] = group.Count();
            return new JsonObject
            {
                ["matches"] = all.Count,
                ["byMatchType"] = byType,
                ["byDifference"] = byDifference,
                ["conflicts"] = all.Count(m => m.Difference.HasFlag(DifferenceType.Conflict)),
                ["onlyInForeign"] = Describe(all.Where(m => m.Type == MatchType.InForeignESpaceOnly).Select(m => m.Foreign), sample),
                ["onlyInLocal"] = Describe(all.Where(m => m.Type == MatchType.InLocalESpaceOnly).Select(m => m.Local), sample),
                ["changedProperties"] = Properties(all, sample),
            };
        }
        finally
        {
            if (!ReferenceEquals(basis, local)) ModelHost.Release(basis);
            ModelHost.Release(foreign);
            ModelHost.Release(local);
        }
    }

    private static JsonArray Describe(IEnumerable<IObjectSignature?> objects, int sample)
    {
        var result = new JsonArray();
        foreach (var o in objects.Where(o => o != null).Take(sample))
            result.Add(new JsonObject { ["type"] = ModelHost.Kind(o!.GetInterface()?.Name ?? "?"), ["name"] = TypeResolver.Name(o), ["path"] = ModelHost.PathOf(o) });
        return result;
    }

    /// <summary>As propriedades que diferem, com o valor dos dois lados: é o detalhe que um gate de equivalência lê.</summary>
    private static JsonArray Properties(IEnumerable<IMatch> matches, int sample)
    {
        var result = new JsonArray();
        foreach (var match in matches)
        {
            foreach (var pair in match.Properties.Where(p => p.Difference != DifferenceType.None && p.IsVisible))
            {
                if (result.Count >= sample) return result;
                result.Add(new JsonObject
                {
                    ["element"] = ModelHost.PathOf(match.Local ?? match.Foreign),
                    ["property"] = pair.PropertyName,
                    ["difference"] = pair.Difference.ToString(),
                    ["local"] = pair.LocalValue?.ToString(),
                    ["foreign"] = pair.ForeignValue?.ToString(),
                });
            }
        }
        return result;
    }
}
