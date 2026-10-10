using System.Text.RegularExpressions;
using OutSystems.Model;
using ServiceStudio.Model;

namespace Anvil.Core;

/// <summary>
/// Checagem deterministica das expressoes ANTES de ler o Verify: todo identificador seguido de "(" tem de ser uma funcao
/// built-in (FunctionCatalog, lido do Studio), uma funcao deste modulo (action com Function=true), uma action referenciada
/// ou uma funcao de role (Check/Grant/Revoke&lt;Role&gt;Role). O que sobra vira "Hint UnknownFunction" com os nomes mais
/// parecidos e o caminho do no (Label quando o no nao tem Name), para a correcao ser uma edicao e nao uma sondagem.
/// </summary>
public static class ExpressionCheck
{
    private static readonly Regex Call = new(@"(?<![\w.])([A-Za-z_][A-Za-z0-9_]*)\s*\(", RegexOptions.Compiled);
    private static readonly Regex Str = new("\"(?:[^\"]|\"\")*\"", RegexOptions.Compiled);

    /// <summary>Operadores da linguagem de expressoes que tambem aparecem antes de "(": nao sao funcoes.</summary>
    private static readonly HashSet<string> Keywords = new(StringComparer.OrdinalIgnoreCase) { "and", "or", "not" };

    /// <summary>Funcoes que o modulo pode chamar alem das built-in.</summary>
    public static HashSet<string> ScopeFunctions(ESpace espace)
    {
        var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var o in ((IObjectSignature)espace).GetAllDescendantsOfType<IObjectSignature>())
        {
            var ifc = o.GetInterface()?.Name ?? "";
            if (ifc is "IServerAction" or "IClientAction")
            {
                if (ModelHost.Prop(o, "Function") is true) Add(set, NameOf(o));
            }
            else if (ifc.EndsWith("ActionSignature", StringComparison.Ordinal))
            {
                Add(set, NameOf(o)); // referenciadas: incluir todas evita falso positivo (o Verify decide o resto)
            }
            else if (ifc is "IRole" or "IRoleSignature")
            {
                var n = NameOf(o);
                if (!string.IsNullOrEmpty(n)) { set.Add("Check" + n + "Role"); set.Add("Grant" + n + "Role"); set.Add("Revoke" + n + "Role"); }
            }
        }
        return set;
    }

    /// <summary>Linhas "Hint UnknownFunction: ..." (vazio quando todas as chamadas resolvem).</summary>
    public static IReadOnlyList<string> Hints(ESpace espace, int max = 20)
    {
        var scope = ScopeFunctions(espace);
        var hints = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var o in ((IObjectSignature)espace).GetAllDescendantsOfType<IObjectSignature>())
        {
            if (o is not IExpression ex) continue;
            if (InReference(o)) continue;
            string? text;
            try { text = ex.Text; } catch { continue; }
            if (string.IsNullOrWhiteSpace(text)) continue;
            foreach (Match m in Call.Matches(Str.Replace(text, "\"\"")))
            {
                var name = m.Groups[1].Value;
                if (Keywords.Contains(name) || FunctionCatalog.Names.Contains(name) || scope.Contains(name)) continue;
                if (!seen.Add(name + "@" + (o.ObjectKey?.ToString() ?? text))) continue;
                var closest = FunctionCatalog.Closest(name, scope);
                hints.Add($"Hint UnknownFunction: '{name}(' nao existe (nem built-in, nem funcao deste modulo ou referenciada)" +
                          (closest.Count > 0 ? $"; parecidas: {string.Join(", ", closest)}" : "") +
                          $"; catalogo: docs/functions.md ou `anvil functions --find {name}` @ {ModelHost.PathOf(o)}");
                if (hints.Count >= max) return hints;
            }
        }
        return hints;
    }

    private static readonly Regex CurrentPath = new(@"(?<![\w.])([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\.Current\.([A-Za-z_][A-Za-z0-9_]*)", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    /// <summary>Best-effort, public model type inspection; Verify remains the judge.</summary>
    public static IReadOnlyList<string> CurrentHints(ESpace espace, IReadOnlyList<MessageInfo> messages, int max = 20)
    {
        var errors = messages.Where(m => m.Id == "ExpressionUnknownObject").ToArray();
        if (errors.Length == 0 || max <= 0) return Array.Empty<string>();
        var owners = errors.Select(m => System.Text.Json.Nodes.JsonNode.Parse(m.Key)?[1]?.GetValue<string>())
            .Where(k => k != null).ToHashSet(StringComparer.Ordinal);
        var hints = new List<string>();
        foreach (var o in ((IObjectSignature)espace).GetAllDescendantsOfType<IObjectSignature>())
        {
            if (o is not IExpression expression || InReference(o)) continue;
            try
            {
                var related = false;
                for (IObjectSignature? p = o; p != null; p = p.Parent as IObjectSignature)
                    if (owners.Contains(p.ObjectKey?.ToString())) { related = true; break; }
                if (!related) continue;
                foreach (Match match in CurrentPath.Matches(Str.Replace(expression.Text ?? "", "\"\"")))
                {
                    var prefix = match.Groups[1].Value;
                    var parts = prefix.Split('.');
                    var source = FindSource(o, parts[0]);
                    if (source == null) continue;
                    object? type;
                    var aggregate = source is OutSystems.Model.Logic.Aggregates.IAggregate;
                    var sql = source is OutSystems.Model.Logic.Nodes.ISQLNode;
                    if (source is OutSystems.Model.Logic.Aggregates.IAggregate agg)
                    {
                        if (parts.Length != 2 || !parts[1].Equals("List", StringComparison.OrdinalIgnoreCase)) continue;
                        type = agg.Type;
                    }
                    else if (source is OutSystems.Model.Logic.Nodes.ISQLNode query)
                    {
                        if (parts.Length != 2 || !parts[1].Equals("List", StringComparison.OrdinalIgnoreCase)) continue;
                        type = query.Type;
                    }
                    else if (source is OutSystems.Model.UI.Mobile.IDataAction action)
                    {
                        if (parts.Length != 2) continue;
                        type = action.OutputParameters.FirstOrDefault(p => p.Name.Equals(parts[1], StringComparison.OrdinalIgnoreCase))?.DataType;
                    }
                    else
                    {
                        type = ModelHost.Prop(source, "DataType");
                        foreach (var part in parts.Skip(1))
                            type = Attributes(type).FirstOrDefault(a => string.Equals(NameOf(a), part, StringComparison.OrdinalIgnoreCase)) is { } attribute
                                ? ModelHost.Prop(attribute, "DataType") : null;
                    }
                    // Aggregate.Type can expose either the list or the current record, depending on the runtime.
                    var element = type is OutSystems.Model.Types.IListType list ? list.ElementType : aggregate ? type : null;
                    var fields = Attributes(element).Select(NameOf).Where(n => !string.IsNullOrEmpty(n)).ToArray();
                    if (fields.Length == 0 || fields.Contains(match.Groups[2].Value, StringComparer.OrdinalIgnoreCase)) continue;
                    var label = sql ? "a SQL result" : aggregate ? "an aggregate" : (NameOf(element!) ?? "record") + " List";
                    var hint = $"Hint Current: '{prefix}' is {label}; Current has: {string.Join(", ", fields.Take(20))}" +
                        (fields.Length > 20 ? ", ..." : "") +
                        (sql ? " (use the SQL output name before its record fields; logic sql:true names that output List)" : aggregate ? " (use the actual aggregate output fields, including grouped columns)" : " (an entity wrapper belongs to an aggregate result, not this list)") +
                        $" @ {ModelHost.PathOf(o)}";
                    if (!hints.Contains(hint)) hints.Add(hint);
                    if (hints.Count >= max) return hints;
                }
            }
            catch { /* An unavailable public type must never hide the original Verify error. */ }
        }
        return hints;
    }

    private static IEnumerable<object> Attributes(object? type) => type != null && ModelHost.Prop(type, "Attributes") is System.Collections.IEnumerable attributes
        ? attributes.Cast<object>() : Enumerable.Empty<object>();

    private static IObjectSignature? FindSource(IObjectSignature expression, string name)
    {
        for (var scope = expression.Parent as IObjectSignature; scope != null; scope = scope.Parent as IObjectSignature)
        {
            var candidates = scope.GetAllDescendantsOfType<IObjectSignature>().Where(o =>
                (o is OutSystems.Model.Logic.Aggregates.IAggregate || o is OutSystems.Model.Logic.Nodes.ISQLNode || o is OutSystems.Model.UI.Mobile.IDataAction
                    || ModelSession.Implements(o, "IParameter") || ModelSession.Implements(o, "IInputParameter") || ModelSession.Implements(o, "IOutputParameter")) && // SS11: IParameter; ODC has only the two concrete ones
                string.Equals(NameOf(o), name, StringComparison.OrdinalIgnoreCase)).Take(2).ToArray();
            if (candidates.Length == 1) return candidates[0];
            if (candidates.Length > 1) return null;
            if (scope.GetInterface()?.Name is "IMobileScreen" or "IMobileBlock" or "IServerAction" or "IClientAction" or "IServiceAction" or "IDataAction") break;
        }
        return null;
    }

    private static void Add(HashSet<string> set, string? name) { if (!string.IsNullOrEmpty(name)) set.Add(name); }

    private static string? NameOf(object o) => ModelHost.Prop(o, "Name") as string;

    private static bool InReference(IObjectSignature o)
    {
        for (var p = o.Parent as IObjectSignature; p != null; p = p.Parent as IObjectSignature)
            if (p.GetType().Name.Contains("Reference", StringComparison.Ordinal)) return true;
        return false;
    }
}
