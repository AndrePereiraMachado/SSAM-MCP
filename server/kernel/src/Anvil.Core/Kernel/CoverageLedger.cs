using System.Text.Json.Nodes;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>
/// O que o job TOCOU, registado pela execucao e nao por casar texto no JSON.
///
/// Por que existe: medir cobertura por grep mente, e mentiu tres vezes em 2026-09-17. Procurar
/// <c>"type": "IX"</c> nos jobs nao ve (a) o que nasce das ops compostas -- <c>ICommentNode</c> vem da chave
/// <c>comments</c> da op <c>logic</c>, uma tela inteira vem da op <c>screen</c>, widgets vem da op <c>html</c>;
/// (b) tipos sem o prefixo I, como <c>EntityIndex</c>; (c) a diferenca entre CRIAR um objecto e apenas o
/// REFERIR. Resultado: uma lista de 82 "lacunas" da qual 40% era ruido, e capacidades dadas por descobertas
/// que estavam cobertas ha meses.
///
/// O registo e feito em <c>ApplyOne</c>, que e o ponto unico por onde tudo passa: as ops compostas expandem e
/// chamam <c>ApplyOne</c> de volta (Spec, Logic, Screen, Html), por isso o que elas criam entra aqui sem
/// precisar de ser declarado em lado nenhum.
///
/// Desde 2026-09-23 cada entrada guarda tambem a interface QUALIFICADA do objecto (a que <c>GetInterface()</c> do
/// Model API devolve, com namespace): um nome curto como <c>IStaticEntity</c> existe em mais de um namespace no ODC
/// e uma prova nova nao pode depender de um ranking para saber que tipo executou. As chaves de <c>porTipo</c>
/// continuam a ser nomes curtos (compatibilidade); <c>interfaces</c> e <c>porInterface</c> trazem o qualificado.
///
/// REGRA: contabilidade nunca derruba trabalho. Tudo aqui e best-effort e engole as suas proprias excepcoes;
/// um job correcto nao pode falhar porque o ledger nao soube nomear um tipo.
/// </summary>
public sealed partial class ModelSession
{
    private readonly List<(string Verbo, string Tipo, string? Prop, string? Iface)> _ledger = new();

    /// <summary>Verbos que MEXEM no modelo. `get`, `dump`, `find` e `usages` leem e nao entram: cobertura e do
    /// que se sabe fazer, nao do que se sabe olhar.</summary>
    private static readonly HashSet<string> Mutantes = new(StringComparer.Ordinal)
    { "create", "set", "delete", "rename", "replace", "move", "duplicate", "link", "layout" };

    /// <summary>Anota o op. Chamado DUAS vezes por op: antes (quando o alvo ainda existe -- e o unico momento
    /// possivel para o `delete`) e depois (quando o objecto so existe a partir do resultado -- `create` e
    /// `duplicate`). A segunda chamada substitui a primeira quando traz um tipo melhor.</summary>
    private void Anotar(string verbo, JsonObject op, JsonNode? resultado)
    {
        if (!Mutantes.Contains(verbo)) return;
        try
        {
            // Uma das duas passagens sabe o tipo e a outra nao, conforme o verbo: `delete` so o sabe ANTES
            // (depois o objecto ja nao resolve) e `create` so o sabe DEPOIS (antes nao existe). A passagem
            // que nao souber devolve null aqui e nao anota nada; a que souber anota.
            var (tipo, iface) = TipoDoResultado(resultado) ?? TipoDoAlvo(op) ?? default;
            if (tipo == null) return;
            var entrada = (verbo, tipo, verbo == "set" ? op["prop"]?.GetValue<string>() : null, iface);
            if (!_ledger.Contains(entrada)) _ledger.Add(entrada);
        }
        catch { /* contabilidade nunca derruba trabalho */ }
    }

    private static (string Tipo, string? Iface)? TipoDoResultado(JsonNode? resultado)
        => resultado is JsonObject o && o["type"]?.GetValue<string>() is { Length: > 0 } t ? (t, o["iface"]?.GetValue<string>()) : null;

    private (string Tipo, string? Iface)? TipoDoAlvo(JsonObject op)
    {
        var referencia = op["target"]?.GetValue<string>() ?? op["from"]?.GetValue<string>();
        if (referencia == null) return null;
        try { var o = Resolve(referencia); return (ShortType(o), QualifiedType(o)); } catch { return null; }
    }

    /// <summary>A interface do Model API que o objecto declara como a sua (com namespace); para os tipos nativos sem
    /// interface (EntityIndex), a classe concreta.</summary>
    internal static string? QualifiedType(object o)
        => (o as IObjectSignature)?.GetInterface()?.FullName ?? o.GetType().FullName;

    /// <summary>O ledger desta corrida, agregado por tipo. Entra no resultado do job, ao lado de `validation` e
    /// `dataContract`, para a matriz de cobertura se calcular da EXECUCAO.</summary>
    public JsonObject CoverageLedger()
    {
        var porTipo = new JsonObject();
        foreach (var grupo in _ledger.GroupBy(e => e.Tipo).OrderBy(g => g.Key, StringComparer.Ordinal))
        {
            var verbos = new JsonArray(grupo.Select(e => e.Verbo).Distinct().OrderBy(v => v, StringComparer.Ordinal)
                .Select(v => (JsonNode)v!).ToArray());
            var propriedades = new JsonArray(grupo.Where(e => e.Prop != null).Select(e => e.Prop!).Distinct()
                .OrderBy(p => p, StringComparer.Ordinal).Select(p => (JsonNode)p!).ToArray());
            var entrada = new JsonObject { ["verbos"] = verbos };
            if (propriedades.Count > 0) entrada["propriedades"] = propriedades;
            var interfaces = grupo.Where(e => e.Iface != null).Select(e => e.Iface!).Distinct().OrderBy(i => i, StringComparer.Ordinal).ToList();
            if (interfaces.Count > 0) entrada["interfaces"] = new JsonArray(interfaces.Select(i => (JsonNode)i).ToArray());
            porTipo[grupo.Key] = entrada;
        }
        // O mesmo ledger indexado pela interface qualificada: e por aqui que uma prova nova diz que tipo executou.
        var porInterface = new JsonObject();
        foreach (var grupo in _ledger.Where(e => e.Iface != null).GroupBy(e => e.Iface!).OrderBy(g => g.Key, StringComparer.Ordinal))
        {
            var entrada = new JsonObject
            {
                ["tipo"] = grupo.First().Tipo,
                ["verbos"] = new JsonArray(grupo.Select(e => e.Verbo).Distinct().OrderBy(v => v, StringComparer.Ordinal).Select(v => (JsonNode)v!).ToArray()),
            };
            var propriedades = grupo.Where(e => e.Prop != null).Select(e => e.Prop!).Distinct().OrderBy(p => p, StringComparer.Ordinal).ToList();
            if (propriedades.Count > 0) entrada["propriedades"] = new JsonArray(propriedades.Select(p => (JsonNode)p).ToArray());
            porInterface[grupo.Key] = entrada;
        }
        return new JsonObject { ["schema"] = "anvil-coverage-ledger/2", ["tipos"] = porTipo.Count, ["porTipo"] = porTipo, ["porInterface"] = porInterface };
    }
}
