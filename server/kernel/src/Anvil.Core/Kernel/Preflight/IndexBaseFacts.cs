using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Reading;

namespace Anvil.Core.Preflight;

/// <summary>A producer the job references, as the static check reads it: its capture's index and digest (either may be absent).</summary>
public sealed record ProducerBasis(string Name, string File, string? Sha256, ModuleIndex? Index, JsonObject? Digest);

/// <summary>A catalog of a UI library (kernel/catalog/ui, UiCatalog.ReadJson): its blocks' contracts. VersionMatches: the
/// version the module imports is this one (unknown or another: its problems are warnings).</summary>
public sealed record UiCatalogBasis(string File, string Library, string? Version, bool VersionMatches, UiModule Catalog);

/// <summary>
/// CX16 (2026-10-15): what the static check knows of the base without the model. The module's index (ModuleIndex, by file:
/// <c>&lt;sha&gt;.kernel.json</c> or <c>.builder.json</c>) with its digest beside it (public, function and signature of each action,
/// the references the module already imports), the producers' indexes, the UI catalogs. <see cref="Fresh"/>: the index is
/// provably the module the job is applied to (a capture taken for this delivery, or the base of a check); otherwise a name
/// the index lacks is no evidence (warnings only).
/// </summary>
public sealed class StaticBasis
{
    public string Lane { get; init; } = "o11";
    public ModuleIndex? Module { get; init; }
    public JsonObject? Digest { get; init; }
    public string? ModuleFile { get; init; }
    public bool Fresh { get; init; }
    public List<ProducerBasis> Producers { get; init; } = [];
    public List<UiCatalogBasis> UiCatalogs { get; init; } = [];

    /// <summary>An index file of the store read as itself (its own lane, adapter and sha256), never through the store of this
    /// assembly (on ODC the adapter of the assembly is not the builder's). Throws InvalidDataException when it does not read.</summary>
    public static ModuleIndex ReadIndex(string file)
    {
        var bytes = File.ReadAllBytes(file);
        using var document = JsonDocument.Parse(bytes);
        var top = document.RootElement;
        var lane = top.GetProperty("lane").GetString() ?? "";
        var adapter = top.GetProperty("adapter").GetString() ?? "";
        var sha = top.GetProperty("sourceSha256").GetString() ?? "";
        var name = Path.GetFileName(file);
        if (!name.StartsWith(sha, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException(name + " is not the index of " + sha);
        return ModuleIndex.Parse(bytes, lane, adapter, sha);
    }

    /// <summary>The digest beside an index file (<c>&lt;sha&gt;.kernel.digest.json</c>, the kernel's reader writes it in both
    /// lanes), or null.</summary>
    public static JsonObject? DigestBeside(string indexFile)
    {
        var folder = Path.GetDirectoryName(Path.GetFullPath(indexFile))!;
        var sha = Path.GetFileName(indexFile).Split('.')[0];
        foreach (var candidate in new[] { sha + ".kernel.digest.json", sha + ".builder.digest.json" }) {
            var path = Path.Combine(folder, candidate);
            try { if (File.Exists(path)) return JsonNode.Parse(File.ReadAllBytes(path)) as JsonObject; } catch (JsonException) { } catch (IOException) { }
        }
        return null;
    }
}

/// <summary>
/// CX16: <see cref="IBaseFacts"/> over the module index, the digest, the producers' indexes and the reference ops of the job
/// (their elements say name and kind: IServerEntity:Station is a type, IServerAction:X an action), read only. The semantics of
/// ModelBaseFacts: null or false is "unknown"; a name is a type only when every element so named is an entity or a structure.
/// What only the model answers (a raw expression) is null.
/// </summary>
public sealed class IndexBaseFacts : IBaseFacts
{
    private static readonly Regex RecordKind = new(@"^I?(?:(?:Server|Static|Client)?Entity|Structure)(?:Signature)?$", RegexOptions.Compiled);
    private static readonly Regex ActionKind = new(@"^I?(?:Server|Service|Client|Extension)Action(?:Signature)?$|^I?ActionSignature$", RegexOptions.Compiled);
    private static readonly HashSet<string> Inner = new(StringComparer.Ordinal) { "screen", "block", "action", "entity", "staticEntity", "structure", "aggregate" };

    private readonly StaticBasis basis;
    // Every name and the kinds of the elements so named: the module (index rows; references' signatures included), the
    // references the module already imports (digest), the elements the job's reference ops import.
    private readonly Dictionary<string, HashSet<string>> kinds = new(StringComparer.OrdinalIgnoreCase);
    // The names a screen's expression may start with from outside the screen: the module and the producers it references
    // (a qualified path, Producer.Element). A module element is never a bare root: a variable of another screen is not
    // visible, a client variable or site property is read through Client. or Site., an action is a call, an entity or a
    // structure is a type (NamesOnlyTypes).
    private readonly HashSet<string> topLevel = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> functions = new(StringComparer.OrdinalIgnoreCase);
    /// <summary>Producer name -> imported names of the job's reference ops (Kind:Name), and the producers' own names.</summary>
    public Dictionary<string, HashSet<string>> Imported { get; } = new(StringComparer.OrdinalIgnoreCase);

    public IndexBaseFacts(StaticBasis basis, JsonArray ops)
    {
        this.basis = basis;
        if (basis.Module is { } index) {
            var rows = index.Rows().ToList();
            foreach (var row in rows) {
                if (row.Name.Length == 0) continue;
                Add(row.Name, row.Kind);
                if (row.Kind is "Reference" or "ESpace") topLevel.Add(row.Name);
            }
            topLevel.Add(index.ModuleName);
        }
        if (basis.Digest is { } digest) {
            foreach (var (producer, kind, name) in DigestReferences(digest)) { Add(name, kind); topLevel.Add(producer); }
            foreach (var action in (digest["actions"] as JsonArray ?? []).OfType<JsonObject>())
                if (action["function"]?.GetValue<bool>() == true && action["name"]?.ToString() is { Length: > 0 } f) functions.Add(f);
        }
        foreach (var op in ops.OfType<JsonObject>().Where(o => o["op"]?.ToString() == "reference")) {
            var producer = op["producer"]?.ToString() ?? "";
            if (producer.Length > 0) topLevel.Add(producer);
            var set = Imported.TryGetValue(producer, out var known) ? known : (Imported[producer] = new HashSet<string>(StringComparer.OrdinalIgnoreCase));
            foreach (var element in (op["elements"] as JsonArray ?? []).Select(e => e?.ToString() ?? "")) {
                var colon = element.IndexOf(':');
                if (colon <= 0) continue;
                var kind = element[..colon]; var name = element[(colon + 1)..].Trim();
                set.Add(kind.TrimStart('I') + ":" + name);
                Add(name, kind.TrimStart('I'));
            }
        }
        foreach (var producer in basis.Producers)
            foreach (var action in (producer.Digest?["actions"] as JsonArray ?? []).OfType<JsonObject>())
                if (action["function"]?.GetValue<bool>() == true && action["public"]?.GetValue<bool>() == true && action["name"]?.ToString() is { Length: > 0 } f) functions.Add(f);
    }

    private void Add(string name, string kind)
    {
        if (!kinds.TryGetValue(name, out var set)) kinds[name] = set = new(StringComparer.Ordinal);
        set.Add(kind.StartsWith('I') && kind.Length > 1 && char.IsUpper(kind[1]) ? kind[1..] : kind);
    }

    private static bool InsideOf(List<ModuleIndex.Row> rows, ModuleIndex.Row row)
    {
        var seen = 0;
        for (var p = row.Parent; p >= 0 && p < rows.Count && seen++ < 64; p = rows[p].Parent)
            if (Inner.Contains(rows[p].Role) || RecordKind.IsMatch(rows[p].Kind)) return true;
        return false;
    }

    /// <summary>The references a digest lists in its module section: (producer, kind, name), from the lines
    /// `reference P @key (...)` and `  Kind: a, b, c`.</summary>
    public static IEnumerable<(string Producer, string Kind, string Name)> DigestReferences(JsonObject digest)
    {
        foreach (var section in (digest["sections"] as JsonArray ?? []).OfType<JsonObject>().Where(s => s["id"]?.ToString() == "module"))
            foreach (var block in (section["blocks"] as JsonArray ?? []).OfType<JsonObject>().Where(b => b["kind"]?.ToString() == "Reference")) {
                var lines = (block["text"]?.ToString() ?? "").Split('\n');
                var head = Regex.Match(lines[0], @"^reference\s+(.+?)\s+@");
                var producer = head.Success ? head.Groups[1].Value.Trim() : block["name"]?.ToString() ?? "";
                foreach (var line in lines.Skip(1)) {
                    var m = Regex.Match(line, @"^\s+([A-Za-z]+):\s*(.+)$");
                    if (!m.Success) continue;
                    foreach (var name in m.Groups[2].Value.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
                        if (!name.Contains('…')) yield return (producer, m.Groups[1].Value, name);
                }
            }
    }

    public bool Fresh => basis.Fresh && basis.Module != null;
    public bool HasIndex => basis.Module != null;

    /// <summary>The kinds of the elements of this name (module, its references, the job's reference ops); empty when none.</summary>
    public IReadOnlyCollection<string> KindsOf(string name) => kinds.TryGetValue(name, out var set) ? set : [];

    // CX16 r2 (A1): what the module has or imports, by kind. The references the module already has are rows of its index too
    // (role reference, kind <Kind>Signature: MobileBlockSignature, WebScreenSignature, ...), so a rule of "the module has it or
    // imports it" reads them here, beside the digest and the job's reference ops (all of them in the same table).
    public static readonly Regex BlockKind = new(@"^I?(?:Mobile|Web)?Block(?:Signature)?$", RegexOptions.Compiled);
    public static readonly Regex ScreenKind = new(@"^I?(?:Mobile|Web)?Screen(?:Signature)?$", RegexOptions.Compiled);

    /// <summary>Every name with an element of a kind <paramref name="kind"/> accepts: the module, the references it has, the
    /// references of its digest and the elements the job's reference ops import.</summary>
    public IEnumerable<string> NamesOf(Func<string, bool> kind) => kinds.Where(p => p.Value.Any(kind)).Select(p => p.Key);

    /// <summary>The names of one role in the indexes of the producers (what the job could import from them).</summary>
    public IEnumerable<string> ProducerNames(string role) =>
        basis.Producers.Where(p => p.Index != null).SelectMany(p => p.Index!.Rows().Where(r => r.Role == role && r.Name.Length > 0).Select(r => r.Name));

    /// <summary>A name a screen's expression may start with, from outside the screen.</summary>
    public bool TopLevel(string name) => topLevel.Contains(name) || functions.Contains(name);

    public bool HasName(string name) => kinds.ContainsKey(name) || functions.Contains(name);

    public bool NamesOnlyTypes(string name) => kinds.TryGetValue(name, out var set) && set.Count > 0 && set.All(k => RecordKind.IsMatch(k));

    public bool IsFunction(string name) => functions.Contains(name);

    public bool IsClientEntity(string name) => kinds.TryGetValue(name, out var set) && set.Any(k => k.StartsWith("ClientEntity", StringComparison.Ordinal));

    public string? ModuleType => basis.Digest?["module"]?["kind"]?.ToString();

    public string? GlobalOf(string name)
    {
        if (!kinds.TryGetValue(name, out var set)) return null;
        if (set.Any(k => k.StartsWith("SiteProperty", StringComparison.Ordinal))) return "Site";
        if (set.Any(k => k.StartsWith("Setting", StringComparison.Ordinal))) return "Settings";
        return null;
    }

    public RawExpressionFact? RawExpression(string target, string prop) => null;

    public CalleeFact? Callee(string target, JsonObject caller) => null;

    public IReadOnlyDictionary<string, string>? Attributes(string record)
    {
        foreach (var index in new[] { basis.Module }.Concat(basis.Producers.Select(p => p.Index))) {
            if (index == null) continue;
            var rows = index.Rows().ToList();
            var owner = rows.FirstOrDefault(r => RecordKind.IsMatch(r.Kind) && string.Equals(r.Name, record, StringComparison.OrdinalIgnoreCase));
            if (owner == null) continue;
            var attributes = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var row in rows.Where(r => r.Parent == owner.Index && r.Kind.Contains("Attribute", StringComparison.Ordinal)))
                attributes[row.Name] = row.Name.Equals("Id", StringComparison.OrdinalIgnoreCase) ? owner.Name + " Identifier" : row.DataType ?? "";
            if (attributes.Count > 0) return attributes;
        }
        return null;
    }

    public ActionNameFact? ActionNameTaken(string name) => ActionNameTaken(name, "server");

    public ActionNameFact? ActionNameTaken(string name, string kind)
    {
        if (basis.Module is not { } index) return null;
        var rows = index.Rows().ToList();
        var scope = ActionNameRules.Scope(kind);
        foreach (var row in rows.Where(r => string.Equals(r.Name, name, StringComparison.OrdinalIgnoreCase) && ActionKind.IsMatch(r.Kind) && !InsideOf(rows, r))) {
            var rowScope = row.Kind.Contains("Client", StringComparison.Ordinal) ? "client" : "server";
            if (rowScope == scope) return new ActionNameFact("I" + row.Kind, row.Name, "module", rowScope);
        }
        return null;
    }

    public IReadOnlyCollection<string>? ScreenNames(string owner)
    {
        if (basis.Module is not { } index) return null;
        var colon = owner.IndexOf(':');
        var name = colon >= 0 ? owner[(colon + 1)..] : owner;
        var rows = index.Rows().ToList();
        var screen = rows.FirstOrDefault(r => r.Role is "screen" or "block" && string.Equals(r.Name, name, StringComparison.OrdinalIgnoreCase));
        if (screen == null) return null;
        return rows.Where(r => r.Parent == screen.Index && (r.Role is "parameter" or "variable" or "aggregate" || r.Kind.Contains("DataAction", StringComparison.Ordinal)))
            .Select(r => r.Name).Where(n => n.Length > 0).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
    }

    /// <summary>The screens and blocks of the module (name -> kind), and the names of what each one holds by kind (the
    /// screen actions, data actions, inputs, local variables), for the rules of a document that names them.</summary>
    public (string Kind, Dictionary<string, List<string>> Children)? Root(string name, bool block)
    {
        if (basis.Module is not { } index) return null;
        var rows = index.Rows().ToList();
        var root = rows.FirstOrDefault(r => r.Role == (block ? "block" : "screen") && string.Equals(r.Name, name, StringComparison.OrdinalIgnoreCase));
        if (root == null) return null;
        var children = rows.Where(r => r.Parent == root.Index).GroupBy(r => r.Kind).ToDictionary(g => g.Key, g => g.Select(r => r.Name).ToList(), StringComparer.Ordinal);
        return (root.Kind, children);
    }

    /// <summary>The roots of the module of one role (screen, block), by name.</summary>
    public IEnumerable<string> Roots(string role) => basis.Module?.Rows().Where(r => r.Role == role).Select(r => r.Name) ?? [];
}
