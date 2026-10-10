using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Core.ExternalLibraries;

/// <summary>One problem of a refusal (contract 1.6): the JSON pointer it names, what is wrong and the exact fix. A build
/// diagnostic also carries the action it maps to and the line and column inside that action's body.</summary>
public sealed record ExternalLibraryProblem(string Code, string Path, string Message, string? Fix,
    string? Target = null, int? Line = null, int? Column = null)
{
    public JsonObject ToJson()
    {
        var o = new JsonObject { ["code"] = Code, ["path"] = Path, ["message"] = Message, ["fix"] = Fix };
        if (Target != null) o["target"] = Target;
        if (Line != null) o["line"] = Line;
        if (Column != null) o["column"] = Column;
        return o;
    }
}

/// <summary>A refusal with every problem at once; nothing was built, written to the tenant or sent.</summary>
public sealed class ExternalLibraryException(string code, string message, IReadOnlyList<ExternalLibraryProblem> problems, JsonObject? extra = null)
    : Exception(message)
{
    public string Code { get; } = code;
    public IReadOnlyList<ExternalLibraryProblem> Problems { get; } = problems;
    public JsonObject? Extra { get; } = extra;
    public JsonObject ToJson()
    {
        var o = new JsonObject { ["ok"] = false, ["code"] = Code, ["error"] = Message,
            ["problems"] = new JsonArray(Problems.Select(p => (JsonNode)p.ToJson()).ToArray()) };
        foreach (var (key, value) in Extra ?? new JsonObject()) o[key] = value?.DeepClone();
        return o;
    }
}

public sealed record ExternalLibraryParameter(string Name, string Type, string? Description, string? Default);
public sealed record ExternalLibraryAttribute(string Name, string Type, bool Mandatory, int? Length, int? Decimals, string? Default, string? Description);
public sealed record ExternalLibraryStructure(string Name, string? Description, IReadOnlyList<ExternalLibraryAttribute> Attributes);
public sealed record ExternalLibraryAction(string Name, string? Description, IReadOnlyList<ExternalLibraryParameter> Inputs,
    IReadOnlyList<ExternalLibraryParameter> Outputs, string Body);
public sealed record ExternalLibraryPackageReference(string Name, string Version);

/// <summary>
/// The spec of an ODC External Library: the common shape of the integrations contract (I9) plus namespace, NuGet
/// packages with exact versions and usings. Types are the OutSystems names (Text, Integer, Long Integer, Decimal,
/// Boolean, Date, Date Time, Time, Currency, Email, Phone Number, Binary Data), a declared structure, or "&lt;T&gt; List"
/// of any of them. Bodies are C# statements that use the declared parameter names (D8). Check returns every problem
/// at once; Parse refuses with EXTERNAL_LIBRARY_SPEC_INVALID before anything is generated. The facade mirrors these
/// rules (platforms/odc/facade/odc-external-library.mjs) so a bad spec is refused without starting this process;
/// kernel/tests/fixtures/external-library/spec-invalid.json and its expected problems keep the two in agreement.
/// </summary>
public sealed record ExternalLibrarySpec(string Name, string? Description, string Namespace, IReadOnlyList<ExternalLibraryStructure> Structures,
    IReadOnlyList<ExternalLibraryAction> Actions, IReadOnlyList<ExternalLibraryPackageReference> Packages, IReadOnlyList<string> Usings)
{
    public const string InvalidCode = "EXTERNAL_LIBRARY_SPEC_INVALID";
    private static readonly Regex Identifier = new("^[A-Za-z_][A-Za-z0-9_]*$", RegexOptions.CultureInvariant);
    private static readonly Regex DottedName = new(@"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$", RegexOptions.CultureInvariant);
    private static readonly Regex PackageId = new(@"^[A-Za-z0-9][A-Za-z0-9_.\-]*$", RegexOptions.CultureInvariant);
    private static readonly Regex ExactVersion = new(@"^\d+(\.\d+){1,3}(-[0-9A-Za-z][0-9A-Za-z.\-]*)?$", RegexOptions.CultureInvariant);

    /// <summary>OutSystems type name (with its spaced alias) to the canonical name.</summary>
    public static readonly IReadOnlyDictionary<string, string> Primitives = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["Text"] = "Text", ["Integer"] = "Integer", ["LongInteger"] = "LongInteger", ["Long Integer"] = "LongInteger",
        ["Decimal"] = "Decimal", ["Boolean"] = "Boolean", ["Date"] = "Date", ["DateTime"] = "DateTime", ["Date Time"] = "DateTime",
        ["Time"] = "Time", ["Currency"] = "Currency", ["Email"] = "Email", ["PhoneNumber"] = "PhoneNumber", ["Phone Number"] = "PhoneNumber",
        ["BinaryData"] = "BinaryData", ["Binary Data"] = "BinaryData",
    };
    /// <summary>C# keywords a generated parameter, member or type name may not be.</summary>
    public static readonly HashSet<string> CSharpKeywords = new(StringComparer.Ordinal)
    {
        "abstract", "as", "base", "bool", "break", "byte", "case", "catch", "char", "checked", "class", "const", "continue", "decimal",
        "default", "delegate", "do", "double", "else", "enum", "event", "explicit", "extern", "false", "finally", "fixed", "float",
        "for", "foreach", "goto", "if", "implicit", "in", "int", "interface", "internal", "is", "lock", "long", "namespace", "new",
        "null", "object", "operator", "out", "override", "params", "private", "protected", "public", "readonly", "ref", "return",
        "sbyte", "sealed", "short", "sizeof", "stackalloc", "static", "string", "struct", "switch", "this", "throw", "true", "try",
        "typeof", "uint", "ulong", "unchecked", "unsafe", "ushort", "using", "virtual", "void", "volatile", "while",
    };
    private static readonly string[] RootFields = ["name", "description", "namespace", "structures", "actions", "packages", "usings"];
    private static readonly string[] O11OnlyFields = ["sources", "references", "resources", "remove", "isFunction"];
    private static readonly string[] StructureFields = ["name", "description", "attributes"];
    private static readonly string[] AttributeFields = ["name", "type", "mandatory", "length", "decimals", "default", "description"];
    private static readonly string[] ActionFields = ["name", "description", "inputs", "outputs", "body"];
    private static readonly string[] InputFields = ["name", "type", "mandatory", "default", "description"];
    private static readonly string[] OutputFields = ["name", "type", "description"];
    private static readonly string[] PackageFields = ["name", "version"];

    public static ExternalLibrarySpec Read(string path)
    {
        JsonNode? node;
        try { node = JsonNode.Parse(File.ReadAllText(path)); }
        catch (JsonException e)
        {
            throw new ExternalLibraryException(InvalidCode, "The spec file is not JSON: " + e.Message,
                [new("SPEC_NOT_JSON", "", "The spec file is not JSON: " + e.Message, "Pass a JSON object with name and actions.")]);
        }
        return Parse(node);
    }

    public static ExternalLibrarySpec Parse(JsonNode? node)
    {
        var problems = Check(node);
        if (problems.Count > 0)
            throw new ExternalLibraryException(InvalidCode, problems.Count + " problem(s) in the external library spec; nothing was generated.", problems);
        var o = node!.AsObject();
        var name = Text(o, "name")!;
        return new ExternalLibrarySpec(name, Text(o, "description"), Text(o, "namespace") ?? name,
            Items(o, "structures").Select(s => new ExternalLibraryStructure(Text(s, "name")!, Text(s, "description"),
                Items(s, "attributes").Select(a => new ExternalLibraryAttribute(Text(a, "name")!, Canonical(Text(a, "type")!), Flag(a, "mandatory"),
                    Number(a, "length"), Number(a, "decimals"), Scalar(a, "default"), Text(a, "description"))).ToArray())).ToArray(),
            Items(o, "actions").Select(a => new ExternalLibraryAction(Text(a, "name")!, Text(a, "description"),
                Items(a, "inputs").Select(p => new ExternalLibraryParameter(Text(p, "name")!, Canonical(Text(p, "type")!), Text(p, "description"), Scalar(p, "default"))).ToArray(),
                Items(a, "outputs").Select(p => new ExternalLibraryParameter(Text(p, "name")!, Canonical(Text(p, "type")!), Text(p, "description"), null)).ToArray(),
                Text(a, "body")!)).ToArray(),
            Items(o, "packages").Select(p => new ExternalLibraryPackageReference(Text(p, "name")!, Text(p, "version")!)).ToArray(),
            Items(o, "usings").Select(u => u.GetValue<string>().Trim()).Distinct(StringComparer.Ordinal).ToArray());
    }

    /// <summary>Every problem of the spec, in document order; empty when it can be generated.</summary>
    public static IReadOnlyList<ExternalLibraryProblem> Check(JsonNode? node)
    {
        var problems = new List<ExternalLibraryProblem>();
        void Add(string code, string path, string message, string? fix) => problems.Add(new(code, path, message, fix));
        if (node is not JsonObject o)
        {
            Add("SPEC_NOT_OBJECT", "", "The spec must be a JSON object.", "Pass {name, actions:[...]}.");
            return problems;
        }
        Unknown(o, "", RootFields, Add);
        var name = Text(o, "name");
        if (string.IsNullOrWhiteSpace(name)) Add("NAME_REQUIRED", "/name", "The library needs a name.", "Set name to an identifier, e.g. \"SSAMTextTools\".");
        else IdentifierRule(name, "/name", "library name", Add);
        var ns = o["namespace"];
        if (ns != null && (ns is not JsonValue nv || !nv.TryGetValue<string>(out var nsText) || !DottedName.IsMatch(nsText)
            || nsText.Split('.').Any(CSharpKeywords.Contains)))
            Add("NAMESPACE_INVALID", "/namespace", "namespace must be dotted identifiers, e.g. Company.Tools.", "Remove namespace (it defaults to the library name) or use identifiers separated by dots.");

        var structures = ListOf(o, "structures", "/structures", Add);
        var declared = new HashSet<string>(StringComparer.Ordinal);
        var structureNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < structures.Count; i++)
            if (structures[i] is JsonObject s && Text(s, "name") is { } sn && Identifier.IsMatch(sn)) declared.Add(sn);
        for (var i = 0; i < structures.Count; i++)
        {
            var path = "/structures/" + i;
            if (structures[i] is not JsonObject s) { Add("STRUCTURE_INVALID", path, "Each structure is an object {name, attributes}.", "Write {name, attributes:[{name, type}]}."); continue; }
            Unknown(s, path, StructureFields, Add);
            var sn = Text(s, "name");
            if (string.IsNullOrWhiteSpace(sn)) Add("NAME_REQUIRED", path + "/name", "The structure needs a name.", "Set name to an identifier.");
            else
            {
                IdentifierRule(sn, path + "/name", "structure name", Add);
                if (!structureNames.Add(sn)) Add("DUPLICATE_NAME", path + "/name", "Structure " + sn + " is declared twice (names ignore case).", "Rename or remove one of them.");
                if (Primitives.ContainsKey(sn) || Primitives.Keys.Any(p => string.Equals(p, sn, StringComparison.OrdinalIgnoreCase)))
                    Add("STRUCTURE_NAME_RESERVED", path + "/name", "Structure " + sn + " has the name of a primitive type.", "Rename the structure.");
                if (name != null && (string.Equals(sn, name, StringComparison.OrdinalIgnoreCase) || string.Equals(sn, "I" + name, StringComparison.OrdinalIgnoreCase)))
                    Add("STRUCTURE_NAME_RESERVED", path + "/name", "Structure " + sn + " has the name of the library class or of its interface.", "Rename the structure.");
            }
            var attributes = ListOf(s, "attributes", path + "/attributes", Add);
            if (attributes.Count == 0) Add("ATTRIBUTES_REQUIRED", path + "/attributes", "Structure " + (sn ?? "") + " has no attributes.", "Add at least one attribute {name, type}.");
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            for (var j = 0; j < attributes.Count; j++)
            {
                var ap = path + "/attributes/" + j;
                if (attributes[j] is not JsonObject a) { Add("ATTRIBUTE_INVALID", ap, "Each attribute is an object {name, type}.", "Write {name, type}."); continue; }
                Unknown(a, ap, AttributeFields, Add);
                MemberName(a, ap, "attribute", seen, Add);
                TypeRule(Text(a, "type"), ap + "/type", declared, Add);
                foreach (var key in new[] { "length", "decimals" })
                    if (a[key] != null && (a[key] is not JsonValue v || !v.TryGetValue<int>(out var n) || n < 0))
                        Add("NUMBER_INVALID", ap + "/" + key, key + " must be a non-negative integer.", "Use an integer such as 50, or remove it.");
                if (a["mandatory"] != null && (a["mandatory"] is not JsonValue mv || !mv.TryGetValue<bool>(out _)))
                    Add("FLAG_INVALID", ap + "/mandatory", "mandatory must be true or false.", "Use true or false.");
            }
        }

        var actions = ListOf(o, "actions", "/actions", Add);
        if (o["actions"] is JsonArray && actions.Count == 0 || o["actions"] == null)
            Add("ACTIONS_REQUIRED", "/actions", "The library needs at least one action.", "Add actions:[{name, inputs, outputs, body}].");
        var actionNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < actions.Count; i++)
        {
            var path = "/actions/" + i;
            if (actions[i] is not JsonObject a) { Add("ACTION_INVALID", path, "Each action is an object {name, inputs, outputs, body}.", "Write {name, body}."); continue; }
            Unknown(a, path, ActionFields, Add);
            var an = Text(a, "name");
            if (string.IsNullOrWhiteSpace(an)) Add("NAME_REQUIRED", path + "/name", "The action needs a name.", "Set name to an identifier.");
            else
            {
                IdentifierRule(an, path + "/name", "action name", Add);
                if (!actionNames.Add(an)) Add("DUPLICATE_NAME", path + "/name", "Action " + an + " is declared twice (names ignore case).", "Rename or remove one of them.");
                if (name != null && string.Equals(an, name, StringComparison.OrdinalIgnoreCase))
                    Add("ACTION_NAME_IS_LIBRARY", path + "/name", "Action " + an + " has the name of the library class (C# refuses a member named like its type).", "Rename the action.");
            }
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var (key, fields) in new[] { ("inputs", InputFields), ("outputs", OutputFields) })
            {
                var parameters = ListOf(a, key, path + "/" + key, Add);
                for (var j = 0; j < parameters.Count; j++)
                {
                    var pp = path + "/" + key + "/" + j;
                    if (parameters[j] is not JsonObject p) { Add("PARAMETER_INVALID", pp, "Each parameter is an object {name, type}.", "Write {name, type}."); continue; }
                    Unknown(p, pp, fields, Add);
                    MemberName(p, pp, "parameter", seen, Add);
                    TypeRule(Text(p, "type"), pp + "/type", declared, Add);
                }
            }
            if (a["body"] is not JsonValue bv || !bv.TryGetValue<string>(out var body) || string.IsNullOrWhiteSpace(body))
                Add("BODY_REQUIRED", path + "/body", "Action " + (an ?? "") + " has no body.", "Write the C# statements of the action in body, using the declared parameter names (e.g. \"Result = new string(Text.Reverse().ToArray());\").");
        }

        var packages = ListOf(o, "packages", "/packages", Add);
        var packageNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < packages.Count; i++)
        {
            var path = "/packages/" + i;
            if (packages[i] is not JsonObject p) { Add("PACKAGE_INVALID", path, "Each package is an object {name, version}.", "Write {name, version:\"1.2.3\"}."); continue; }
            Unknown(p, path, PackageFields, Add);
            var pn = Text(p, "name");
            if (string.IsNullOrWhiteSpace(pn) || !PackageId.IsMatch(pn)) Add("PACKAGE_NAME_INVALID", path + "/name", "The package needs its NuGet id.", "Set name to the NuGet package id.");
            else
            {
                if (string.Equals(pn, ExternalLibraryProject.SdkPackage, StringComparison.OrdinalIgnoreCase))
                    Add("SDK_PACKAGE_PINNED", path + "/name", ExternalLibraryProject.SdkPackage + " is pinned by SSAM at " + ExternalLibraryProject.SdkVersion + ".", "Remove it from packages.");
                if (!packageNames.Add(pn)) Add("DUPLICATE_NAME", path + "/name", "Package " + pn + " is listed twice.", "Keep one entry.");
            }
            var version = Text(p, "version");
            if (string.IsNullOrWhiteSpace(version))
                Add("PACKAGE_VERSION_REQUIRED", path + "/version", "Package " + (pn ?? "") + " has no version: the build pins every package to an exact version.", "Set version to the exact NuGet version, e.g. \"13.0.3\".");
            else if (!ExactVersion.IsMatch(version))
                Add("PACKAGE_VERSION_INEXACT", path + "/version", "Version " + version + " of " + (pn ?? "") + " is not one exact version (ranges and wildcards change the build).", "Set the exact NuGet version, e.g. \"13.0.3\".");
        }
        var usings = ListOf(o, "usings", "/usings", Add);
        for (var i = 0; i < usings.Count; i++)
            if (usings[i] is not JsonValue uv || !uv.TryGetValue<string>(out var u) || !DottedName.IsMatch(u.Trim()))
                Add("USING_INVALID", "/usings/" + i, "Each using is a namespace name, e.g. System.Text.", "Write the namespace without the using keyword.");
        return problems;
    }

    /// <summary>The canonical OutSystems name of a valid type ("Long Integer" -> LongInteger, "Text List" kept).</summary>
    public static string Canonical(string type)
    {
        var t = type.Trim();
        if (t.EndsWith(" List", StringComparison.Ordinal)) return Canonical(t[..^5]) + " List";
        return Primitives.TryGetValue(t, out var canonical) ? canonical : t;
    }
    /// <summary>The item type of a "&lt;T&gt; List", or null.</summary>
    public static string? ListItem(string canonical) => canonical.EndsWith(" List", StringComparison.Ordinal) ? canonical[..^5] : null;

    private static void TypeRule(string? type, string path, HashSet<string> declared, Action<string, string, string, string?> add)
    {
        if (string.IsNullOrWhiteSpace(type)) { add("TYPE_REQUIRED", path, "The type is missing.", "Set type, e.g. Text, Integer or a declared structure."); return; }
        var t = type.Trim();
        var item = t.EndsWith(" List", StringComparison.Ordinal) ? t[..^5].Trim() : t;
        if (item.EndsWith(" List", StringComparison.Ordinal)) { add("TYPE_UNKNOWN", path, "Type " + t + " is a list of lists, which an External Library cannot declare.", "Use a structure that holds the inner list."); return; }
        if (Primitives.ContainsKey(item) || declared.Contains(item)) return;
        if (item == "Object") { add("TYPE_NOT_SUPPORTED", path, "Object exists only in O11 extensions.", "Use Text, Binary Data or a structure."); return; }
        var primitive = Primitives.Keys.FirstOrDefault(p => string.Equals(p.Replace(" ", ""), item.Replace(" ", ""), StringComparison.OrdinalIgnoreCase));
        if (primitive != null) { add("TYPE_UNKNOWN", path, "Type " + item + " is not an OutSystems type name.", "Use " + Primitives[primitive] + "."); return; }
        var structure = declared.FirstOrDefault(s => string.Equals(s, item, StringComparison.OrdinalIgnoreCase));
        if (structure != null) { add("STRUCTURE_UNDECLARED", path, "No structure named " + item + " is declared (names are case-sensitive here).", "Use " + structure + "."); return; }
        if (Identifier.IsMatch(item))
        {
            add("STRUCTURE_UNDECLARED", path, item + " is neither an OutSystems type nor a structure declared in structures.", "Declare structure " + item + " in structures, or use one of: " + string.Join(", ", Primitives.Values.Distinct()) + ".");
            return;
        }
        add("TYPE_UNKNOWN", path, "Type " + t + " is not an OutSystems type: use the OutSystems names, not C# types.", "Use Text, Integer, Long Integer, Decimal, Boolean, Date, Date Time, Time, Currency, Email, Phone Number, Binary Data, a structure or \"<T> List\".");
    }
    private static void IdentifierRule(string name, string path, string what, Action<string, string, string, string?> add)
    {
        if (!Identifier.IsMatch(name)) add("IDENTIFIER_INVALID", path, "The " + what + " '" + name + "' is not an identifier (letters, digits and _, not starting with a digit).", "Rename it to " + Suggest(name) + ".");
        else if (CSharpKeywords.Contains(name)) add("IDENTIFIER_INVALID", path, "The " + what + " '" + name + "' is a C# keyword.", "Rename it, e.g. " + char.ToUpperInvariant(name[0]) + name[1..] + "Value.");
    }
    private static void MemberName(JsonObject o, string path, string what, HashSet<string> seen, Action<string, string, string, string?> add)
    {
        var name = Text(o, "name");
        if (string.IsNullOrWhiteSpace(name)) { add("NAME_REQUIRED", path + "/name", "The " + what + " needs a name.", "Set name to an identifier."); return; }
        IdentifierRule(name, path + "/name", what + " name", add);
        if (!seen.Add(name)) add("DUPLICATE_NAME", path + "/name", "The " + what + " name " + name + " is used twice here (names ignore case; inputs and outputs share them).", "Rename one of them.");
    }
    private static string Suggest(string name)
    {
        var cleaned = Regex.Replace(name, "[^A-Za-z0-9_]", "");
        if (cleaned.Length == 0) return "a name such as Value";
        return char.IsDigit(cleaned[0]) ? "_" + cleaned : cleaned;
    }
    private static void Unknown(JsonObject o, string path, string[] known, Action<string, string, string, string?> add)
    {
        foreach (var (key, _) in o)
        {
            if (known.Contains(key)) continue;
            add("FIELD_UNKNOWN", path + "/" + key, O11OnlyFields.Contains(key) ? key + " exists only in O11 extensions (o11_extension)." : "Unknown field " + key + ".",
                "Remove " + key + "; the fields here are: " + string.Join(", ", known) + ".");
        }
    }
    private static IReadOnlyList<JsonNode?> ListOf(JsonObject o, string key, string path, Action<string, string, string, string?> add)
    {
        var node = o[key];
        if (node == null) return [];
        if (node is JsonArray a) return a.ToList();
        add("LIST_EXPECTED", path, key + " must be a list.", "Write " + key + " as [ ... ].");
        return [];
    }
    private static string? Text(JsonObject o, string key) => o[key] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
    private static string? Text(JsonNode? o, string key) => o is JsonObject obj ? Text(obj, key) : null;
    private static bool Flag(JsonNode? o, string key) => o?[key] is JsonValue v && v.TryGetValue<bool>(out var b) && b;
    private static int? Number(JsonNode? o, string key) => o?[key] is JsonValue v && v.TryGetValue<int>(out var n) ? n : null;
    private static string? Scalar(JsonNode? o, string key) => o?[key] switch
    {
        null => null,
        JsonValue v when v.TryGetValue<string>(out var s) => s,
        JsonValue v => v.ToJsonString(),
        _ => null
    };
    private static IEnumerable<JsonNode> Items(JsonNode? o, string key) => o?[key] is JsonArray a ? a.Where(x => x != null).Select(x => x!) : [];
}
