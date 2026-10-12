using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Anvil.Core;

/// <summary>
/// Names of the prototype importer (docs/PROTOTIPO-NATIVO.md 1.6 and 3.5), deterministic and shared by every step: PascalCase
/// ASCII of a text (accents removed), the ownership mark written in Descriptions, the module image name, the icon mask class,
/// and the widget names of a screen (the prototype id, else Tag + n). Nothing here reads the module: the collision rules that
/// need it (an unmarked homonym gets &lt;Prefix&gt;&lt;Name&gt;) live in <see cref="PrototypeNameScope"/>, fed by the session.
/// </summary>
public static class PrototypeNames
{
    /// <summary>The mark that says an element belongs to the importation of <paramref name="prefix"/> (1.6). No hash: the
    /// capture hash goes to the receipt and to the flow description only, so a new capture of the same prototype updates in
    /// place.</summary>
    public static string Mark(string prefix) => "ssam:prototype " + prefix;

    /// <summary>The Description of an imported element: the descriptive text, a blank line and the mark (N1).</summary>
    public static string Description(string text, string prefix) => (text.Trim().Length > 0 ? text.Trim() + "\n\n" : "") + Mark(prefix);

    /// <summary>True when a Description carries the mark of <paramref name="prefix"/> on a line of its own.</summary>
    public static bool IsMarked(string? description, string prefix)
        => description != null && description.Replace("\r", "").Split('\n').Any(l => l.Trim() == Mark(prefix));

    private static readonly Regex Separators = new(@"[^A-Za-z0-9]+", RegexOptions.Compiled);

    /// <summary>Accents removed (NFD without marks), then every run of letters and digits starts with an upper case letter; the
    /// rest of a run is kept ("meus-pedidos" -> "MeusPedidos", "Detalhes do produto" -> "DetalhesDoProduto",
    /// "FarmaVirtual | Higiene" -> "FarmaVirtualHigiene"). A leading digit gets "N" in front; nothing at all gives "Item".</summary>
    public static string Pascal(string? text)
    {
        var ascii = Ascii(text ?? "");
        var sb = new StringBuilder();
        foreach (var part in Separators.Split(ascii))
        {
            if (part.Length == 0) continue;
            sb.Append(char.ToUpperInvariant(part[0])).Append(part, 1, part.Length - 1);
        }
        if (sb.Length == 0) return "Item";
        if (char.IsDigit(sb[0])) sb.Insert(0, 'N');
        return sb.ToString();
    }

    /// <summary>The singular of a word in pt or en (imoveis -> imovel, propostas -> proposta, itens -> item, opcoes -> opcao,
    /// cores -> cor, users -> user); a word that is already singular with a final s (status, lapis) is kept.</summary>
    public static string Singular(string word)
    {
        if (word.Length < 3) return word;
        if (Regex.IsMatch(word, "eis$", RegexOptions.IgnoreCase)) return Regex.Replace(word, "eis$", "el", RegexOptions.IgnoreCase);
        if (Regex.IsMatch(word, "(us|is|ss)$", RegexOptions.IgnoreCase)) return word;
        // features, pictures: the s only (the pt cores -> cor, luzes -> luz never ends in -ures)
        if (Regex.IsMatch(word, "ures$", RegexOptions.IgnoreCase)) return word[..^1];
        foreach (var (pattern, to) in new[] { ("([oa])es$", "ao"), ("ns$", "m"), ("([rz])es$", "$1"), ("([^s])s$", "$1") })
            if (Regex.IsMatch(word, pattern, RegexOptions.IgnoreCase)) return Regex.Replace(word, pattern, to, RegexOptions.IgnoreCase);
        return word;
    }

    /// <summary>The entity name a collection of the prototype store gets (N1): every word of it in the singular, PascalCase
    /// ("imoveis" -> "Imovel", "imoveisFotos" -> "ImovelFoto", "CarrinhoItem" -> "CarrinhoItem", "Users" -> "User").</summary>
    public static string EntityStem(string collection)
    {
        var words = Regex.Matches(Ascii(collection), "[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])").Select(m => m.Value).ToList();
        if (words.Count == 0) return Pascal(collection);
        return string.Concat(words.Select(w => Singular(w)).Select(w => char.ToUpperInvariant(w[0]) + w[1..]));
    }

    /// <summary>The text without diacritics, letters outside ASCII dropped.</summary>
    public static string Ascii(string text)
    {
        var sb = new StringBuilder(text.Length);
        foreach (var ch in text.Normalize(NormalizationForm.FormD))
        {
            if (CharUnicodeInfo.GetUnicodeCategory(ch) == UnicodeCategory.NonSpacingMark) continue;
            sb.Append(ch < 128 ? ch : ' ');
        }
        return sb.ToString();
    }

    /// <summary>The prefix the capture gives when data.prefix is absent: the title up to the first separator (| - – :), in
    /// PascalCase ASCII; without a title, the source folder name.</summary>
    public static string PrefixOf(string? title, string? folder)
    {
        if (!string.IsNullOrWhiteSpace(title))
        {
            var cut = title.IndexOfAny(['|', '-', '–', ':']);
            var head = (cut > 0 ? title[..cut] : title).Trim();
            if (head.Length > 0) return Pascal(head);
        }
        return Pascal(folder ?? "Prototype");
    }

    public static readonly Regex PrefixShape = new("^[A-Za-z][A-Za-z0-9]*$", RegexOptions.Compiled);

    /// <summary>A module image: &lt;Prefix&gt;&lt;file name in PascalCase&gt; ("assets/products.png" -> "FarmaVirtualProducts").</summary>
    public static string Image(string prefix, string assetPath)
        => prefix + Pascal(Path.GetFileNameWithoutExtension(assetPath.Replace('\\', '/').Split('/').Last()));

    /// <summary>The icon mask class (3.5): ssam-icon-&lt;name&gt; at the default stroke, ssam-icon-&lt;name&gt;-w&lt;stroke x 100&gt; otherwise.</summary>
    public static string IconClass(string name, double strokeWidth, double defaultStrokeWidth)
        => Math.Abs(strokeWidth - defaultStrokeWidth) < 1e-9 ? "ssam-icon-" + name : "ssam-icon-" + name + "-w" + ((int)Math.Round(strokeWidth * 100)).ToString(CultureInfo.InvariantCulture);

    /// <summary>The class an element with an id gets, so the rewritten #id selector also matches it (4.1 item 3).</summary>
    public static string IdClass(string id) => "ssam-id-" + id;

    /// <summary>The class of a substituted tag (3.2).</summary>
    public static string TagClass(string tag) => "ssam-tag-" + tag;

    private static readonly Regex WidgetShape = new("^[A-Za-z][A-Za-z0-9_]*$", RegexOptions.Compiled);

    /// <summary>An id as a widget name: letters, digits and _ only, starting with a letter ("catalog-search" -> "catalog_search").</summary>
    public static string WidgetName(string id)
    {
        var sb = new StringBuilder();
        foreach (var ch in Ascii(id)) sb.Append(char.IsLetterOrDigit(ch) || ch == '_' ? ch : '_');
        var name = sb.ToString().Trim('_');
        if (name.Length == 0) return "W";
        return char.IsLetter(name[0]) ? name : "W" + name;
    }

    /// <summary>The tag part of a generated widget name: "div" -> "Div", "h2" -> "H2".</summary>
    public static string TagStem(string tag)
    {
        var sb = new StringBuilder(); var upper = true;
        foreach (var ch in tag) { if (char.IsLetterOrDigit(ch)) { sb.Append(upper ? char.ToUpperInvariant(ch) : ch); upper = false; } else upper = true; }
        return sb.Length == 0 || !char.IsLetter(sb[0]) ? "W" + sb : sb.ToString();
    }

    public static bool IsWidgetName(string name) => WidgetShape.IsMatch(name);

    /// <summary>The verb of the first data-changing effect (else of the first effect) in the document language, plus the object
    /// (3.4, N1). Unknown effects never reach here (the capture is validated first).</summary>
    public static string Verb(string effect, bool portuguese) => (effect, portuguese) switch
    {
        ("navigate", true) => "IrPara", ("navigate", false) => "GoTo",
        ("openPopup", true) => "Abrir", ("openPopup", false) => "Open",
        ("closePopup", true) => "Fechar", ("closePopup", false) => "Close",
        ("setDimension", true) => "Definir", ("setDimension", false) => "Set",
        ("toggle", true) => "Alternar", ("toggle", false) => "Toggle",
        ("increment", true) => "Alterar", ("increment", false) => "Change",
        ("remove" or "removeWhere", true) => "Remover", ("remove" or "removeWhere", false) => "Remove",
        ("update" or "updateFrom", true) => "Salvar", ("update" or "updateFrom", false) => "Save",
        ("insert" or "insertFrom", true) => "Criar", ("insert" or "insertFrom", false) => "Create",
        ("upsert", true) => "Adicionar", ("upsert", false) => "Add",
        ("validate", true) => "Validar", ("validate", false) => "Validate",
        ("toast", true) => "Mostrar", ("toast", false) => "Show",
        _ => portuguese ? "Executar" : "Run",
    };
}

/// <summary>
/// The names one importation takes in one scope (module elements of a kind, the widgets of a screen): a name already used by
/// an element of the same importation (marked) is reused in place; a name used by an unmarked element is replaced by
/// &lt;Prefix&gt;&lt;Name&gt;, &lt;Prefix&gt;&lt;Name&gt;2... and reported (renamedFrom); a requested name (mapping, explicit prefix) that
/// collides is a problem the caller collects, never a silent rename (1.6).
/// <para>
/// Every name is reserved against the base BEFORE any op is generated, in the scopes where the Model API renames a newcomer
/// (observed headless on Service Studio 11, 2026-10-11): <paramref name="reserved"/> are names of the base this scope must
/// avoid without owning them (a screen action avoids every client action of the module and of its references), and
/// <see cref="Share"/> joins scopes that are one namespace for the Studio (the locals, inputs and aggregates of a screen with
/// its widgets and its screen actions). A name the caller maps (mapping.names, the correction a leftover collision gives) is
/// used instead of the generated one, and the generated one stays reserved.
/// </para>
/// </summary>
public sealed class PrototypeNameScope
{
    private readonly string _prefix;
    private readonly HashSet<string> _taken;
    private readonly HashSet<string> _marked;
    private readonly HashSet<string> _given = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> _reserved;
    private readonly List<PrototypeNameScope> _shared = [];
    private readonly IReadOnlyDictionary<string, string> _renames;

    /// <param name="taken">Every name of the scope in the module now (case-insensitive, as the Model API compares).</param>
    /// <param name="marked">The names among them that carry the mark of this prefix.</param>
    /// <param name="reserved">Names of the base in another kind that the Studio still treats as taken in this scope.</param>
    /// <param name="renames">mapping.names for this scope: generated name -> the name to use.</param>
    public PrototypeNameScope(string prefix, IEnumerable<string> taken, IEnumerable<string> marked, IEnumerable<string>? reserved = null, IReadOnlyDictionary<string, string>? renames = null)
    {
        _prefix = prefix;
        _taken = new HashSet<string>(taken, StringComparer.OrdinalIgnoreCase);
        _marked = new HashSet<string>(marked, StringComparer.OrdinalIgnoreCase);
        _reserved = new HashSet<string>(reserved ?? [], StringComparer.OrdinalIgnoreCase);
        _renames = renames ?? new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var from in _renames.Keys) _reserved.Add(from);
    }

    /// <summary>Joins two scopes into one namespace: a name either one takes is taken in both.</summary>
    public static void Share(PrototypeNameScope a, PrototypeNameScope b)
    {
        if (ReferenceEquals(a, b)) return;
        if (!a._shared.Contains(b)) a._shared.Add(b);
        if (!b._shared.Contains(a)) b._shared.Add(a);
    }

    /// <summary>Why a name is not free here: null when free, else what holds it (the base, a reservation, this importation).</summary>
    public string? Holder(string name)
        => _reserved.Contains(name) ? "reserved" : _taken.Contains(name) || _given.Contains(name) ? "taken" : _shared.Any(s => s.Own(name)) ? "shared" : null;

    private bool Own(string name) => _taken.Contains(name) || _given.Contains(name);

    private bool Busy(string name) => Holder(name) != null;

    /// <summary>The name mapping.names gives instead of <paramref name="wanted"/>, or wanted itself.</summary>
    public string Mapped(string wanted) => _renames.TryGetValue(wanted, out var to) && !string.IsNullOrWhiteSpace(to) ? to : wanted;

    public sealed record Choice(string Name, string Wanted, bool Existing, string? RenamedFrom, string? Why, bool Collision);

    /// <summary>The name for <paramref name="wanted"/>. <paramref name="requested"/>: the name came from the caller (mapping or an
    /// explicit prefix), so an unmarked homonym is a collision instead of a rename.</summary>
    public Choice Take(string wanted, bool requested = false, string? kind = null)
    {
        var original = wanted;
        wanted = Mapped(wanted);
        var mapped = !string.Equals(original, wanted, StringComparison.Ordinal);
        if (_marked.Contains(wanted) && !_given.Contains(wanted)) { _given.Add(wanted); return new(wanted, original, true, mapped ? original : null, mapped ? $"mapping.names maps {original} to {wanted}" : null, false); }
        if (!Busy(wanted)) { _given.Add(wanted); _taken.Add(wanted); return new(wanted, original, false, mapped ? original : null, mapped ? $"mapping.names maps {original} to {wanted}" : null, false); }
        var why = $"{kind ?? "element"} {wanted} without the mark of {_prefix} already exists in the module";
        if (requested) return new(wanted, wanted, false, null, why, true);
        var stem = wanted.StartsWith(_prefix, StringComparison.Ordinal) ? wanted : _prefix + wanted;
        var candidate = stem;
        for (var n = 2; ; n++)
        {
            if (_marked.Contains(candidate) && !_given.Contains(candidate)) { _given.Add(candidate); return new(candidate, original, true, original, why, false); }
            if (!Busy(candidate)) break;
            candidate = stem + n;
        }
        _given.Add(candidate); _taken.Add(candidate);
        return new(candidate, original, false, original, why, false);
    }

    /// <summary>The first free name with this stem (the mapped one when mapping.names maps the stem), never reusing one (widget
    /// names of a screen, the members of a screen or block).</summary>
    public string Free(string stem, int start = 1)
    {
        var mapped = Mapped(stem);
        if (!string.Equals(mapped, stem, StringComparison.Ordinal)) { stem = mapped; start = 0; }
        for (var n = start; ; n++)
        {
            var candidate = n == 0 ? stem : stem + n;
            if (!Busy(candidate)) { _given.Add(candidate); _taken.Add(candidate); return candidate; }
        }
    }

    public bool Taken(string name) => Busy(name);

    public bool Claim(string name)
    {
        if (Busy(name)) return false;
        _given.Add(name); _taken.Add(name); return true;
    }
}
