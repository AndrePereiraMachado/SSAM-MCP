using System.Diagnostics;
using System.Net;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Anvil.Core;

public sealed record BuiltinParam(string Name, string Type, bool Optional, string Description);

/// <summary>Uma funcao built-in das expressoes OutSystems, como o Studio a regista. Onde e visivel: Logic (expressoes de
/// acoes e telas server-side), ClientSide (client actions e telas Reactive/Mobile), ServerAggregates/ClientAggregates
/// (filtros e colunas calculadas de aggregates), Emails.</summary>
public sealed record BuiltinFunctionInfo(
    string Name, string Group, string Signature, string ReturnType, IReadOnlyList<BuiltinParam> Parameters,
    bool Logic, bool ClientSide, bool ServerAggregates, bool ClientAggregates, bool Emails,
    string Description, string Examples);

public sealed record FunctionCatalogDoc(string Studio, int Count, IReadOnlyList<BuiltinFunctionInfo> Functions);

/// <summary>
/// Catalogo das funcoes built-in lido do registo do proprio Studio (ServiceStudio.Scope.BuiltinFunctions): nomes, parametros,
/// tipos, visibilidade, descricao e exemplos. Mesma instalacao => mesmo catalogo (o teste CatalogInRepoMatchesTheStudio
/// garante que o JSON do repo nao deriva). Nada aqui vem de memoria de LLM.
/// </summary>
public static partial class FunctionCatalog
{
    /// <summary>Where a built-in is visible, read from the Studio's descriptor. The descriptor differs per platform
    /// (SS11 exposes five booleans; ODC exposes three of them as predicates over the module), so each build supplies
    /// this from its adapter: Adapters.SS11/FunctionCatalogSs11.cs and Adapters.ODC/FunctionCatalogOdc.cs.</summary>
    private static partial (bool Logic, bool ClientSide, bool ServerAggregates, bool ClientAggregates, bool Emails) Visibility(ServiceStudio.Scope.BuiltinFunctions.BuiltinFunctionDescriptor descriptor);

    private static IReadOnlyList<BuiltinFunctionInfo>? _all;
    private static HashSet<string>? _names;

    public static IReadOnlyList<BuiltinFunctionInfo> All => _all ??= Extract();

    /// <summary>Nomes (comparacao sem distincao de maiusculas: e assim que o Verify aceita).</summary>
    public static HashSet<string> Names => _names ??= new HashSet<string>(All.Select(f => f.Name), StringComparer.OrdinalIgnoreCase);

    public static string StudioVersion
    {
        get
        {
            var loc = typeof(ServiceStudio.Scope.BuiltinFunctions).Assembly.Location;
            var v = string.IsNullOrEmpty(loc) ? null : FileVersionInfo.GetVersionInfo(loc).FileVersion;
            return v == null ? "?" : string.Join('.', v.Split('.').Take(3));
        }
    }

    /// <summary>Nomes que LLMs escrevem por reflexo de outras linguagens e a funcao OutSystems que resolve o mesmo problema.
    /// Todo alvo tem de existir no catalogo (teste AliasTargetsExist): a lista e verificada contra o binario, nao contra memoria.</summary>
    public static readonly IReadOnlyDictionary<string, string[]> Aliases = new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase)
    {
        ["Right"] = ["Substr", "Length"],
        ["Left"] = ["Substr"],
        ["Mid"] = ["Substr"],
        ["Substring"] = ["Substr"],
        ["Len"] = ["Length"],
        ["IndexOf"] = ["Index"],
        ["Contains"] = ["Index"],
        ["Upper"] = ["ToUpper"],
        ["Lower"] = ["ToLower"],
        ["ToString"] = ["IntegerToText", "DecimalToText", "BooleanToText"],
        ["ToText"] = ["IntegerToText", "DecimalToText", "BooleanToText"],
        ["ToInt"] = ["TextToInteger", "DecimalToInteger"],
        ["ToInteger"] = ["TextToInteger", "DecimalToInteger"],
        ["ParseInt"] = ["TextToInteger"],
        ["Now"] = ["CurrDateTime"],
        ["Today"] = ["CurrDate"],
        ["GetDate"] = ["CurrDate"],
        ["DateDiff"] = ["DiffDays", "DiffHours", "DiffMinutes", "DiffSeconds"],
        ["DateAdd"] = ["AddDays", "AddHours", "AddMinutes", "AddMonths"],
        ["IIf"] = ["If"],
        ["Floor"] = ["Trunc"],
        ["Ceiling"] = ["Round"],
    };

    /// <summary>primeira-certa A4: names whose built-in takes the same arguments, so renaming the call is the whole fix.
    /// Every target must exist in the catalog (only those are used).</summary>
    public static readonly IReadOnlyDictionary<string, string> Renames = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
    {
        ["NullDateTime"] = "NullDate",
        ["Len"] = "Length", ["Upper"] = "ToUpper", ["Lower"] = "ToLower", ["ToUpperCase"] = "ToUpper", ["ToLowerCase"] = "ToLower",
        ["Now"] = "CurrDateTime", ["CurrentDateTime"] = "CurrDateTime", ["CurrentDate"] = "CurrDate", ["CurrentTime"] = "CurrTime",
        ["Today"] = "CurrDate", ["IIf"] = "If", ["NullId"] = "NullIdentifier",
    };

    /// <summary>The one built-in a call to the unknown <paramref name="name"/> certainly means, or null: a rename of
    /// <see cref="Renames"/>, else the only built-in at most one letter (two in a name of eight or more) away.</summary>
    public static string? Certain(string name)
    {
        if (Renames.TryGetValue(name, out var renamed)) return Names.Contains(renamed) ? renamed : null;
        if (name.Length < 5) return null;
        var limit = name.Length >= 8 ? 2 : 1;
        var lower = name.ToLowerInvariant();
        var near = All.Select(f => f.Name).Distinct(StringComparer.Ordinal).Where(c => Math.Abs(c.Length - name.Length) <= limit && Distance(lower, c.ToLowerInvariant()) <= limit).ToList();
        return near.Count == 1 ? near[0] : null;
    }

    public static IReadOnlyList<BuiltinFunctionInfo> Extract()
    {
        var list = new List<BuiltinFunctionInfo>();
        foreach (var d in ServiceStudio.Scope.BuiltinFunctions.Functions)
        {
            var ps = d.Parameters.Select(p => new BuiltinParam(p.Name, CleanType(p.Type), p.IsOptional, Clean(p.Description))).ToList();
            var ret = CleanType(d.ReturnType);
            var sig = $"{d.Name}({string.Join(", ", ps.Select(p => p.Optional ? $"[{p.Name}: {p.Type}]" : $"{p.Name}: {p.Type}"))}): {ret}";
            var visible = Visibility(d);
            list.Add(new BuiltinFunctionInfo(d.Name, d.Group, sig, ret, ps,
                visible.Logic, visible.ClientSide, visible.ServerAggregates, visible.ClientAggregates, visible.Emails,
                Clean(d.Description), Clean(d.Examples)));
        }
        return list.OrderBy(f => f.Group, StringComparer.Ordinal).ThenBy(f => f.Name, StringComparer.Ordinal).ToList();
    }

    public static BuiltinFunctionInfo? Get(string name) => All.FirstOrDefault(f => string.Equals(f.Name, name, StringComparison.OrdinalIgnoreCase));

    public static IReadOnlyList<BuiltinFunctionInfo> Find(string term) =>
        All.Where(f => f.Name.Contains(term, StringComparison.OrdinalIgnoreCase) || f.Description.Contains(term, StringComparison.OrdinalIgnoreCase)).ToList();

    /// <summary>Nomes mais parecidos: primeiro os aliases conhecidos, depois distancia de edicao contra o catalogo e o escopo do modulo.</summary>
    public static IReadOnlyList<string> Closest(string name, IEnumerable<string>? scope = null, int max = 4)
    {
        var res = new List<string>();
        if (Aliases.TryGetValue(name, out var aliases)) res.AddRange(aliases.Where(Names.Contains));
        var pool = All.Select(f => f.Name).Concat(scope ?? Enumerable.Empty<string>()).Distinct(StringComparer.Ordinal);
        var lower = name.ToLowerInvariant();
        var limit = Math.Max(2, name.Length / 2);
        var ranked = pool.Select(c => (c, d: Distance(lower, c.ToLowerInvariant())))
            .Where(x => x.d <= limit || x.c.Contains(name, StringComparison.OrdinalIgnoreCase) || (name.Length >= 4 && name.Contains(x.c, StringComparison.OrdinalIgnoreCase)))
            .OrderBy(x => x.d).ThenBy(x => x.c, StringComparer.Ordinal);
        foreach (var (c, _) in ranked)
        {
            if (res.Count >= max) break;
            if (!res.Contains(c, StringComparer.Ordinal)) res.Add(c);
        }
        return res;
    }

    public static string ToJson() =>
        JsonSerializer.Serialize(new FunctionCatalogDoc(StudioVersion, All.Count, All),
            new JsonSerializerOptions { WriteIndented = true, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping });

    public static string ToMarkdown()
    {
        var sb = new StringBuilder();
        sb.AppendLine($"# Funcoes built-in das expressoes OutSystems (Service Studio {StudioVersion})");
        sb.AppendLine();
        sb.AppendLine("Gerado do registo do proprio Studio por `dotnet .local/cli/anvil.dll functions --out catalog/functions-<ver>.json --docs docs/functions.md`.");
        sb.AppendLine("So o que esta aqui existe: qualquer outro nome seguido de `(` da `ExpressionUnknownFunction` no Verify, e o runner avisa antes");
        sb.AppendLine("(`Hint UnknownFunction`, com as funcoes mais parecidas). Consulta rapida: `anvil functions --find data` ou `--name Substr`.");
        sb.AppendLine();
        sb.AppendLine("Onde: L = expressoes de logica server-side (server actions, timers, telas Traditional); C = client-side (client actions, telas");
        sb.AppendLine("Reactive/Mobile); AS/AC = aggregates server/client (filtros, colunas calculadas); E = emails; vazio = so em contextos");
        sb.AppendLine("especiais (ex.: telas Traditional Web). Parametro entre `[]` e opcional.");
        sb.AppendLine();
        foreach (var g in All.GroupBy(f => f.Group).OrderBy(g => g.Key, StringComparer.Ordinal))
        {
            sb.AppendLine($"## {g.Key} ({g.Count()})");
            sb.AppendLine();
            sb.AppendLine("| Assinatura | Onde | Descricao |");
            sb.AppendLine("|---|---|---|");
            foreach (var f in g)
            {
                var where = string.Join(" ", new[] { f.Logic ? "L" : null, f.ClientSide ? "C" : null, f.ServerAggregates ? "AS" : null, f.ClientAggregates ? "AC" : null, f.Emails ? "E" : null }.Where(x => x != null));
                sb.AppendLine($"| `{f.Signature}` | {where} | {Cell(f.Description)} |");
            }
            sb.AppendLine();
        }
        sb.AppendLine("## Nomes de outras linguagens que NAO existem aqui");
        sb.AppendLine();
        sb.AppendLine("| Escreveu | Use |");
        sb.AppendLine("|---|---|");
        foreach (var a in Aliases.OrderBy(a => a.Key, StringComparer.Ordinal))
            sb.AppendLine($"| {a.Key} | {string.Join(", ", a.Value)} |");
        return sb.ToString();
    }

    private static string Cell(string s) => s.Replace("|", "\\|").Replace("\n", " ");

    private static readonly Regex Tags = new("<[^>]+>", RegexOptions.Compiled);
    private static readonly Regex Spaces = new(@"\s+", RegexOptions.Compiled);

    private static string Clean(string? html)
    {
        if (string.IsNullOrEmpty(html)) return "";
        var t = html.Replace("<br/>", " ").Replace("<br>", " ").Replace("<BR/>", " ");
        t = Tags.Replace(t, "");
        t = WebUtility.HtmlDecode(t);
        return Spaces.Replace(t, " ").Trim();
    }

    private static string CleanType(string? t)
    {
        if (string.IsNullOrEmpty(t)) return "";
        var last = t.Split('.').Last();
        return last switch
        {
            "DateTime" => "Date Time",
            "LongInteger" => "Long Integer",
            "BinaryData" => "Binary Data",
            "PhoneNumber" => "Phone Number",
            "EntityReference" => "Identifier",
            "ObjectType" => "Object",
            _ => last,
        };
    }

    private static int Distance(string a, string b)
    {
        var d = new int[a.Length + 1, b.Length + 1];
        for (var i = 0; i <= a.Length; i++) d[i, 0] = i;
        for (var j = 0; j <= b.Length; j++) d[0, j] = j;
        for (var i = 1; i <= a.Length; i++)
            for (var j = 1; j <= b.Length; j++)
                d[i, j] = Math.Min(Math.Min(d[i - 1, j] + 1, d[i, j - 1] + 1), d[i - 1, j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1));
        return d[a.Length, b.Length];
    }
}
