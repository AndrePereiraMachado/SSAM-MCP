using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Xif;

/// <summary>
/// The spec of an O11 .NET extension (contract I9 plus sources, references, resources and remove). It is declarative about
/// what it names: an action or structure it names is created or updated in place (by name, keeping its key); what it does
/// not name stays as it is; remove lists what goes. Parse collects EVERY problem and refuses once with XIF_SPEC_INVALID,
/// before anything is generated, compiled or sent.
/// </summary>
public sealed class XifSpec
{
    public required string Name { get; init; }
    public string? Description { get; init; }
    public IReadOnlyList<XifStructure> Structures { get; init; } = [];
    public IReadOnlyList<XifAction> Actions { get; init; } = [];
    public IReadOnlyList<XifSource> Sources { get; init; } = [];
    public IReadOnlyList<string> References { get; init; } = [];
    public IReadOnlyList<XifResource> Resources { get; init; } = [];
    public XifRemove Remove { get; init; } = new();
    /// <summary>K1-f (atritos 3): what the parser accepted in another shape and normalized (sources, references or resources
    /// given as one object instead of a list), as the receipt's specNormalized.</summary>
    public IReadOnlyList<XifNormalization> Normalized { get; init; } = [];

    public static readonly IReadOnlyList<string> Primitives =
        ["Text", "Integer", "LongInteger", "Decimal", "Boolean", "Date", "DateTime", "Time", "Currency", "Email", "PhoneNumber", "BinaryData", "Object"];
    public static readonly IReadOnlyList<string> Deploys = ["Ignore", "Binaries", "Application", "Images"];
    private static readonly Dictionary<string, string> PrimitiveAliases = new(StringComparer.OrdinalIgnoreCase)
    {
        ["Text"] = "Text", ["Integer"] = "Integer", ["LongInteger"] = "LongInteger", ["Long Integer"] = "LongInteger", ["Decimal"] = "Decimal",
        ["Boolean"] = "Boolean", ["Date"] = "Date", ["DateTime"] = "DateTime", ["Date Time"] = "DateTime", ["Time"] = "Time",
        ["Currency"] = "Currency", ["Email"] = "Email", ["PhoneNumber"] = "PhoneNumber", ["Phone Number"] = "PhoneNumber",
        ["BinaryData"] = "BinaryData", ["Binary Data"] = "BinaryData", ["Object"] = "Object",
    };
    private static readonly Regex Identifier = new("^[A-Za-z][A-Za-z0-9_]*$", RegexOptions.CultureInvariant);
    private static readonly string[] RootKeys = ["name", "description", "structures", "actions", "sources", "references", "resources", "remove"];
    private static readonly string[] StructureKeys = ["name", "description", "attributes"];
    private static readonly string[] AttributeKeys = ["name", "type", "mandatory", "length", "decimals", "default", "description"];
    private static readonly string[] ActionKeys = ["name", "description", "isFunction", "inputs", "outputs", "body"];
    private static readonly string[] InputKeys = ["name", "type", "mandatory", "default", "description"];
    private static readonly string[] OutputKeys = ["name", "type", "description"];
    private static readonly string[] SourceKeys = ["path", "file", "text"];
    private static readonly string[] ResourceKeys = ["path", "file", "text", "deploy"];
    private static readonly string[] RemoveKeys = ["actions", "structures", "resources"];

    /// <summary>A primitive type name in its canonical form ("Long Integer" -> LongInteger), or null.</summary>
    public static string? Primitive(string? type) => type != null && PrimitiveAliases.TryGetValue(type.Trim(), out var canonical) ? canonical : null;

    public static bool IsIdentifier(string? name) => name != null && Identifier.IsMatch(name);

    public static XifSpec Parse(JsonNode? node, XifSpecContext? context = null)
    {
        var parser = new Parser(context ?? new XifSpecContext());
        var spec = parser.Root(node);
        if (parser.Problems.Count > 0 || spec == null)
            throw new XifRefusal(XifCodes.SpecInvalid,
                $"The extension spec has {parser.Problems.Count} problem(s); nothing was generated, compiled or sent.", parser.Problems);
        return spec;
    }

    /// <summary>The normalized spec (canonical type names), the shape `xif check` answers and the facade keeps.</summary>
    public JsonObject ToJson()
    {
        var o = new JsonObject { ["name"] = Name };
        if (Description != null) o["description"] = Description;
        if (Structures.Count > 0) o["structures"] = new JsonArray(Structures.Select(s => (JsonNode)s.ToJson()).ToArray());
        o["actions"] = new JsonArray(Actions.Select(a => (JsonNode)a.ToJson()).ToArray());
        if (Sources.Count > 0) o["sources"] = new JsonArray(Sources.Select(s => (JsonNode)s.ToJson()).ToArray());
        if (References.Count > 0) o["references"] = new JsonArray(References.Select(r => (JsonNode)JsonValue.Create(r)!).ToArray());
        if (Resources.Count > 0) o["resources"] = new JsonArray(Resources.Select(r => (JsonNode)r.ToJson()).ToArray());
        if (!Remove.IsEmpty) o["remove"] = Remove.ToJson();
        return o;
    }

    /// <summary>The receipt form of the normalizations: [{path, from, to}].</summary>
    public JsonArray NormalizedJson() => new(Normalized.Select(n => (JsonNode)new JsonObject { ["path"] = n.Path, ["from"] = n.From, ["to"] = n.To }).ToArray());

    // K1-f: a minimal correct example of each list, for the fix of a value that is not one.
    private static readonly Dictionary<string, string> ListExamples = new(StringComparer.Ordinal)
    {
        ["structures"] = """[{"name":"Row","attributes":[{"name":"Value","type":"Text"}]}]""",
        ["actions"] = """[{"name":"Sum","inputs":[{"name":"Left","type":"Integer"},{"name":"Right","type":"Integer"}],"outputs":[{"name":"Result","type":"Integer"}],"body":"Result = Left + Right;"}]""",
        ["attributes"] = """[{"name":"Value","type":"Text"}]""",
        ["inputs"] = """[{"name":"Value","type":"Text"}]""",
        ["outputs"] = """[{"name":"Result","type":"Text"}]""",
        ["sources"] = """[{"path":"Helper.cs","text":"namespace OutSystems.NssMyExtension { public static class Helper { } }"}]""",
        ["references"] = """["C:\\libs\\Vendor.Library.dll"]""",
        ["resources"] = """[{"path":"Data\\settings.json","text":"{}","deploy":"Ignore"}]""",
    };
    // The level each field belongs to, for an unknown field that is a field of another level.
    private static readonly (string Level, string[] Keys)[] Levels =
        [("the root of the spec", RootKeys), ("a structure", StructureKeys), ("an attribute", AttributeKeys), ("an action", ActionKeys),
         ("an input", InputKeys), ("an output", OutputKeys), ("a source", SourceKeys), ("a resource", ResourceKeys), ("remove", RemoveKeys)];

    /// <summary>The accepted name closest to an unknown one (edit distance, ties by name), or null when none is close.</summary>
    internal static string? Closest(string unknown, IReadOnlyList<string> accepted)
    {
        static int Distance(string a, string b)
        {
            a = a.ToLowerInvariant(); b = b.ToLowerInvariant();
            var d = new int[a.Length + 1, b.Length + 1];
            for (var i = 0; i <= a.Length; i++) d[i, 0] = i;
            for (var j = 0; j <= b.Length; j++) d[0, j] = j;
            for (var i = 1; i <= a.Length; i++)
                for (var j = 1; j <= b.Length; j++)
                    d[i, j] = Math.Min(Math.Min(d[i - 1, j] + 1, d[i, j - 1] + 1), d[i - 1, j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1));
            return d[a.Length, b.Length];
        }
        var best = accepted.Select(a => (Name: a, Cost: Distance(unknown, a))).OrderBy(x => x.Cost).ThenBy(x => x.Name, StringComparer.Ordinal).FirstOrDefault();
        return best.Name != null && best.Cost <= Math.Max(2, unknown.Length / 2) ? best.Name : null;
    }

    private sealed class Parser(XifSpecContext context)
    {
        public readonly List<XifProblem> Problems = [];
        public readonly List<XifNormalization> Normalized = [];

        private void Add(string code, string path, string message, string fix) => Problems.Add(new XifProblem(code, path, message, fix));

        public XifSpec? Root(JsonNode? node)
        {
            if (node is not JsonObject root)
            {
                Add("XIF_SPEC_SHAPE", "", "The spec must be a JSON object.", "Pass spec as {name, actions:[...]} (see ssam_discover integration.dotnet-extension-o11).");
                return null;
            }
            Keys(root, "", RootKeys);
            var name = Name(root, "name", "", "the extension");
            var structuresNode = List(root, "structures", "");
            var actionsNode = List(root, "actions", "");
            if (root["actions"] == null && (context.ExistingActions.Count == 0))
                Add("XIF_SPEC_REQUIRED", "actions", "An extension needs at least one action.", "Add actions:[{name, inputs?, outputs?, body}].");

            // Structures first: their names are the types the actions and attributes may use.
            var declared = new List<string>();
            foreach (var (item, i) in structuresNode.Select((x, i) => (x, i)))
                if (item is JsonObject s && Text(s, "name") is { } n && IsIdentifier(n)) declared.Add(n);
            var structures = new List<XifStructure>();
            var seenStructures = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            foreach (var (item, i) in structuresNode.Select((x, i) => (x, i)))
            {
                var path = $"structures[{i}]";
                if (item is not JsonObject s) { Add("XIF_SPEC_SHAPE", path, "A structure must be an object.", "Write {name, attributes:[...]}."); continue; }
                Keys(s, path, StructureKeys);
                var sname = Name(s, "name", path, "the structure");
                if (sname != null)
                {
                    if (Primitive(sname) != null)
                        Add("XIF_SPEC_TYPE_COLLISION", path + ".name", $"The structure '{sname}' has the name of a basic type.", $"Rename the structure (for example {sname}Item); basic type names are reserved.");
                    else if (seenStructures.TryGetValue(sname, out var first))
                        Add("XIF_SPEC_DUPLICATE", path + ".name", $"The structure '{sname}' is declared twice (structures[{first}]); names compare without case.", "Keep one declaration or rename one of them.");
                    else seenStructures[sname] = i;
                }
                var attributes = new List<XifAttribute>();
                var seenAttributes = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                var attributesNode = List(s, "attributes", path);
                if (s["attributes"] == null || attributesNode.Count == 0)
                    Add("XIF_SPEC_REQUIRED", path + ".attributes", $"The structure '{sname}' has no attributes.", "Add attributes:[{name, type}].");
                foreach (var (attr, j) in attributesNode.Select((x, j) => (x, j)))
                {
                    var apath = $"{path}.attributes[{j}]";
                    if (attr is not JsonObject a) { Add("XIF_SPEC_SHAPE", apath, "An attribute must be an object.", "Write {name, type}."); continue; }
                    Keys(a, apath, AttributeKeys);
                    var aname = Name(a, "name", apath, "the attribute");
                    if (aname != null && !seenAttributes.Add(aname))
                        Add("XIF_SPEC_DUPLICATE", apath + ".name", $"The attribute '{aname}' appears twice in '{sname}'; names compare without case.", "Keep one attribute or rename one of them.");
                    var type = Type(a, apath, declared, ownerIndex: i);
                    attributes.Add(new XifAttribute
                    {
                        Name = aname ?? "", Type = type ?? "", Mandatory = Bool(a, "mandatory", apath) ?? false, Length = Int(a, "length", apath),
                        Decimals = Int(a, "decimals", apath), Default = Text(a, "default"), Description = Text(a, "description"),
                    });
                }
                structures.Add(new XifStructure { Name = sname ?? "", Description = Text(s, "description"), Attributes = attributes });
            }

            var actions = new List<XifAction>();
            var seenActions = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            foreach (var (item, i) in actionsNode.Select((x, i) => (x, i)))
            {
                var path = $"actions[{i}]";
                if (item is not JsonObject a) { Add("XIF_SPEC_SHAPE", path, "An action must be an object.", "Write {name, inputs?, outputs?, body}."); continue; }
                Keys(a, path, ActionKeys);
                var aname = Name(a, "name", path, "the action");
                if (aname != null)
                {
                    if (seenActions.TryGetValue(aname, out var first))
                        Add("XIF_SPEC_DUPLICATE", path + ".name", $"The action '{aname}' is declared twice (actions[{first}] is '{Text((JsonObject)actionsNode[first]!, "name")}'); action names compare without case.", "Keep one action or rename one of them.");
                    else seenActions[aname] = i;
                }
                var parameters = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                var all = ParameterNames(a);
                var inputs = new List<XifParameter>();
                foreach (var (p, j) in List(a, "inputs", path).Select((x, j) => (x, j)))
                {
                    var ppath = $"{path}.inputs[{j}]";
                    if (p is not JsonObject po) { Add("XIF_SPEC_SHAPE", ppath, "An input must be an object.", "Write {name, type}."); continue; }
                    Keys(po, ppath, InputKeys);
                    var pname = Parameter(po, ppath, aname, parameters, all);
                    inputs.Add(new XifParameter
                    {
                        Name = pname ?? "", Type = Type(po, ppath, declared, ownerIndex: null) ?? "", IsInput = true, Mandatory = Bool(po, "mandatory", ppath) ?? true,
                        Default = Text(po, "default"), Description = Text(po, "description"),
                    });
                }
                var outputs = new List<XifParameter>();
                foreach (var (p, j) in List(a, "outputs", path).Select((x, j) => (x, j)))
                {
                    var ppath = $"{path}.outputs[{j}]";
                    if (p is not JsonObject po) { Add("XIF_SPEC_SHAPE", ppath, "An output must be an object.", "Write {name, type}."); continue; }
                    Keys(po, ppath, OutputKeys);
                    var pname = Parameter(po, ppath, aname, parameters, all);
                    outputs.Add(new XifParameter { Name = pname ?? "", Type = Type(po, ppath, declared, ownerIndex: null) ?? "", IsInput = false, Description = Text(po, "description") });
                }
                var isFunction = Bool(a, "isFunction", path) ?? false;
                if (isFunction && outputs.Count != 1)
                    Add("XIF_SPEC_FUNCTION_OUTPUTS", path + ".outputs", $"The function '{aname}' has {outputs.Count} outputs; a function returns exactly one.",
                        outputs.Count == 0 ? "Add one output, or set isFunction:false." : "Keep exactly one output, or set isFunction:false.");
                string? body = null;
                if (a["body"] is { } bodyNode)
                {
                    if (bodyNode is JsonValue v && v.TryGetValue<string>(out var text)) body = text;
                    else Add("XIF_SPEC_SHAPE", path + ".body", "body must be a string of C# statements.", "Write body as a string, for example \"Result = Left + Right;\".");
                }
                var existing = aname != null && context.ExistingActions.Contains(aname);
                if (string.IsNullOrWhiteSpace(body) && !existing && a["body"] is null or JsonValue)
                    Add("XIF_SPEC_BODY_REQUIRED", path + ".body", $"The new action '{aname}' has no body.",
                        "Give the C# statements of the action in body, using the declared names (or ss<Name>), for example \"Result = Left + Right;\".");
                actions.Add(new XifAction
                {
                    Name = aname ?? "", Description = Text(a, "description"), IsFunction = isFunction, Inputs = inputs, Outputs = outputs,
                    Body = string.IsNullOrWhiteSpace(body) ? null : body,
                });
            }

            var sources = new List<XifSource>();
            var seenPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var (item, i) in List(root, "sources", "", loose: true).Select((x, i) => (x, i)))
            {
                var path = $"sources[{i}]";
                if (item is not JsonObject s) { Add("XIF_SPEC_SHAPE", path, "A source must be an object.", "Write {path, file|text}."); continue; }
                Keys(s, path, SourceKeys);
                var relative = RelativePath(s, path, ".cs");
                if (relative != null && !seenPaths.Add("src:" + relative))
                    Add("XIF_SPEC_DUPLICATE", path + ".path", $"The source '{relative}' is listed twice.", "Keep one entry.");
                var (file, text) = Content(s, path);
                sources.Add(new XifSource { Path = relative ?? "", File = file, Text = text });
            }

            var references = new List<string>();
            foreach (var (item, i) in List(root, "references", "", loose: true).Select((x, i) => (x, i)))
            {
                var path = $"references[{i}]";
                var file = item is JsonValue v && v.TryGetValue<string>(out var t) ? t : item is JsonObject o ? Text(o, "file") : null;
                if (item is JsonObject ro) Keys(ro, path, ["file"]);
                if (AbsoluteFile(file, path, ".dll") is { } absolute)
                {
                    if (references.Any(r => string.Equals(System.IO.Path.GetFileName(r), System.IO.Path.GetFileName(absolute), StringComparison.OrdinalIgnoreCase)))
                        Add("XIF_SPEC_DUPLICATE", path, $"Two references are named {System.IO.Path.GetFileName(absolute)}.", "Keep one file of each name.");
                    else references.Add(absolute);
                }
            }
            Closure(references);

            var resources = new List<XifResource>();
            foreach (var (item, i) in List(root, "resources", "", loose: true).Select((x, i) => (x, i)))
            {
                var path = $"resources[{i}]";
                if (item is not JsonObject r) { Add("XIF_SPEC_SHAPE", path, "A resource must be an object.", "Write {path, file|text, deploy}."); continue; }
                Keys(r, path, ResourceKeys);
                var relative = RelativePath(r, path, null);
                if (relative != null && !seenPaths.Add("res:" + relative))
                    Add("XIF_SPEC_DUPLICATE", path + ".path", $"The resource '{relative}' is listed twice.", "Keep one entry.");
                var deploy = Text(r, "deploy") ?? "Ignore";
                var canonical = Deploys.FirstOrDefault(d => string.Equals(d, deploy, StringComparison.OrdinalIgnoreCase));
                if (canonical == null)
                    Add("XIF_SPEC_DEPLOY", path + ".deploy", $"deploy '{deploy}' is not a deploy mode of a resource.", "Use one of " + string.Join(", ", Deploys) + ".");
                var (file, text) = Content(r, path);
                resources.Add(new XifResource { Path = relative ?? "", File = file, Text = text, Deploy = canonical ?? "Ignore" });
            }

            var remove = new XifRemove();
            if (root["remove"] is { } removeNode)
            {
                if (removeNode is not JsonObject ro) Add("XIF_SPEC_SHAPE", "remove", "remove must be an object {actions?, structures?, resources?}.", "Write remove:{actions:[\"Name\"]}.");
                else
                {
                    Keys(ro, "remove", RemoveKeys);
                    remove = new XifRemove { Actions = Names(ro, "actions"), Structures = Names(ro, "structures"), Resources = Names(ro, "resources", identifiers: false) };
                    foreach (var removed in remove.Actions.Where(seenActions.ContainsKey))
                        Add("XIF_SPEC_DUPLICATE", "remove.actions", $"The action '{removed}' is both declared and removed.", "Either declare it or remove it.");
                    foreach (var removed in remove.Structures.Where(seenStructures.ContainsKey))
                        Add("XIF_SPEC_DUPLICATE", "remove.structures", $"The structure '{removed}' is both declared and removed.", "Either declare it or remove it.");
                }
            }

            if (name == null) return null;
            return new XifSpec
            {
                Name = name, Description = Text(root, "description"), Structures = structures, Actions = actions, Sources = sources,
                References = references, Resources = resources, Remove = remove, Normalized = Normalized,
            };
        }

        /// <summary>K1-f: a parameter name repeated among the inputs and outputs of an action (one namespace, without case) is
        /// refused with the exact free name: the output takes Out, an input In, then a number, never a name of the action.</summary>
        private string? Parameter(JsonObject p, string path, string? action, HashSet<string> seen, IReadOnlySet<string> all)
        {
            var name = Name(p, "name", path, "the parameter");
            if (name != null && !seen.Add(name))
            {
                var stem = name + (path.Contains(".outputs[", StringComparison.Ordinal) ? "Out" : "In");
                var free = stem;
                for (var n = 2; all.Contains(free) || seen.Contains(free); n++) free = stem + n;
                seen.Add(free);
                Add("XIF_SPEC_DUPLICATE", path + ".name", $"The parameter '{name}' appears twice in '{action}' (inputs and outputs share one namespace, without case).",
                    $"Rename this one to {free} (a free name in '{action}'), and use {free} in its body.");
            }
            return name;
        }

        // Every parameter name an action declares, for the free name of a repeated one.
        private static IReadOnlySet<string> ParameterNames(JsonObject action)
            => new[] { "inputs", "outputs" }.SelectMany(k => action[k] is JsonArray list ? list.OfType<JsonObject>() : [])
                .Select(p => Text(p, "name")).OfType<string>().ToHashSet(StringComparer.OrdinalIgnoreCase);

        private string? Type(JsonObject owner, string path, IReadOnlyList<string> declared, int? ownerIndex)
        {
            var raw = Text(owner, "type");
            if (raw == null) { Add("XIF_SPEC_REQUIRED", path + ".type", "type is required.", "Give a type: " + string.Join(", ", Primitives) + ", a structure, or '<Structure> List'."); return null; }
            var trimmed = raw.Trim();
            var list = trimmed.EndsWith(" List", StringComparison.OrdinalIgnoreCase);
            var element = list ? trimmed[..^5].Trim() : trimmed;
            if (Primitive(element) is { } primitive)
            {
                if (!list) return primitive;
                Add("XIF_SPEC_PRIMITIVE_LIST", path + ".type", $"'{raw}' is a list of a basic type; an O11 extension takes lists of structures only.",
                    $"Declare a structure with one attribute (for example {primitive}Item {{Value: {primitive}}}) and use '{primitive}Item List'.");
                return null;
            }
            var index = declared.ToList().FindIndex(d => string.Equals(d, element, StringComparison.OrdinalIgnoreCase));
            if (index >= 0)
            {
                if (ownerIndex is { } owning && index >= owning)
                {
                    Add("XIF_SPEC_FORWARD_REFERENCE", path + ".type", $"The structure '{declared[owning]}' uses '{declared[index]}', declared {(index == owning ? "as itself" : "after it")}.",
                        index == owning ? "A structure cannot contain itself; use a list of another structure." : $"Move '{declared[index]}' before '{declared[owning]}' in structures.");
                    return null;
                }
                return list ? declared[index] + " List" : declared[index];
            }
            if (context.ExistingStructures.FirstOrDefault(s => string.Equals(s, element, StringComparison.OrdinalIgnoreCase)) is { } existing)
                return list ? existing + " List" : existing;
            Add("XIF_SPEC_TYPE_UNKNOWN", path + ".type", $"'{raw}' is not a type of an O11 extension.",
                "Use one of " + string.Join(", ", Primitives) + (declared.Count > 0 ? ", a declared structure (" + string.Join(", ", declared) + ")" : ", a structure declared in structures") + ", or '<Structure> List'.");
            return null;
        }

        private string? Name(JsonObject owner, string key, string path, string what)
        {
            var at = path.Length == 0 ? key : path + "." + key;
            var name = Text(owner, key);
            if (name == null) { Add("XIF_SPEC_REQUIRED", at, $"The name of {what} is required.", "Give a name that starts with a letter and has only letters, digits and _."); return null; }
            if (IsIdentifier(name)) return name;
            var suggestion = Regex.Replace(name, "[^A-Za-z0-9_]", "");
            if (suggestion.Length == 0 || !char.IsLetter(suggestion[0])) suggestion = "X" + suggestion;
            Add("XIF_SPEC_IDENTIFIER", at, $"'{name}' is not a valid name for {what}.", $"Use a name that starts with a letter and has only letters, digits and _ (for example {suggestion}).");
            return null;
        }

        private string? RelativePath(JsonObject owner, string path, string? extension)
        {
            var raw = Text(owner, "path");
            if (raw == null) { Add("XIF_SPEC_REQUIRED", path + ".path", "path is required.", "Give the relative path inside the extension, for example Bin\\Helper.dll."); return null; }
            var segments = raw.Split('/', '\\');
            if (raw.Length == 0 || System.IO.Path.IsPathRooted(raw) || raw.Contains(':') || raw.Contains('\0') ||
                segments.Any(s => s is "" or "." or ".."))
            {
                Add("XIF_SPEC_RESOURCE_PATH", path + ".path", $"'{raw}' is not a safe relative path inside the extension.",
                    "Use a relative path without '..', '.', empty parts, ':' or a drive, for example Resources\\data.txt.");
                return null;
            }
            if (extension != null && !raw.EndsWith(extension, StringComparison.OrdinalIgnoreCase))
            {
                Add("XIF_SPEC_RESOURCE_PATH", path + ".path", $"'{raw}' must be a {extension} file.", $"Name the file with the {extension} extension.");
                return null;
            }
            return string.Join("\\", segments);
        }

        private (string? File, string? Text) Content(JsonObject owner, string path)
        {
            var hasFile = owner["file"] != null; var hasText = owner["text"] != null;
            if (hasFile == hasText)
            {
                Add("XIF_SPEC_CONTENT", path, "Give exactly one of file (an absolute path) or text.", "Keep file or text, not both and not neither.");
                return (null, null);
            }
            if (hasText) return (null, Text(owner, "text") ?? "");
            return (AbsoluteFile(Text(owner, "file"), path + ".file", null), null);
        }

        private string? AbsoluteFile(string? file, string path, string? extension)
        {
            if (string.IsNullOrWhiteSpace(file) || !System.IO.Path.IsPathFullyQualified(file))
            {
                Add("XIF_SPEC_FILE", path, $"'{file}' is not an absolute file path.", "Give the absolute path of the file on this machine.");
                return null;
            }
            if (extension != null && !file.EndsWith(extension, StringComparison.OrdinalIgnoreCase))
            {
                Add("XIF_SPEC_FILE", path, $"'{file}' is not a {extension} file.", $"Give a {extension} file.");
                return null;
            }
            if (context.RequireFiles && !File.Exists(file))
            {
                Add("XIF_SPEC_FILE", path, $"The file '{file}' does not exist.", "Give the absolute path of an existing file.");
                return null;
            }
            return System.IO.Path.GetFullPath(file);
        }

        /// <summary>Every assembly an author DLL references must be in the .NET Framework, in the platform (OutSystems.*) or
        /// among the author DLLs themselves: otherwise the extension would fail to load on the server.</summary>
        private void Closure(IReadOnlyList<string> references)
        {
            if (references.Count == 0 || !context.RequireFiles) return;
            var framework = context.FrameworkAssemblies();
            var names = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            var refs = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
            foreach (var file in references)
            {
                try
                {
                    using var stream = File.OpenRead(file);
                    using var pe = new PEReader(stream);
                    if (!pe.HasMetadata) { Add("XIF_SPEC_REFERENCE", "references", $"{System.IO.Path.GetFileName(file)} is not a .NET assembly.", "Reference only managed .NET Framework DLLs."); continue; }
                    var reader = pe.GetMetadataReader();
                    var own = reader.GetString(reader.GetAssemblyDefinition().Name);
                    names[own] = file;
                    refs[file] = reader.AssemblyReferences.Select(h => reader.GetString(reader.GetAssemblyReference(h).Name)).ToList();
                }
                catch (Exception error) when (error is BadImageFormatException or InvalidOperationException or IOException)
                {
                    Add("XIF_SPEC_REFERENCE", "references", $"{System.IO.Path.GetFileName(file)} cannot be read as a .NET assembly ({error.Message}).", "Reference only managed .NET Framework DLLs.");
                }
            }
            foreach (var (file, needed) in refs)
            {
                var missing = needed.Where(n => !framework.Contains(n) && !names.ContainsKey(n) && !n.StartsWith("OutSystems.", StringComparison.OrdinalIgnoreCase)
                    && n is not ("mscorlib" or "netstandard")).Distinct(StringComparer.OrdinalIgnoreCase).OrderBy(n => n, StringComparer.Ordinal).ToList();
                if (missing.Count > 0)
                    Add("XIF_SPEC_REFERENCE_CLOSURE", "references", $"{System.IO.Path.GetFileName(file)} needs {string.Join(", ", missing)}, which is not in the .NET Framework nor among the references.",
                        "Add " + string.Join(", ", missing.Select(m => m + ".dll")) + " to references (absolute paths).");
            }
        }

        private List<string> Names(JsonObject owner, string key, bool identifiers = true)
        {
            var found = new List<string>();
            foreach (var (item, i) in List(owner, key, "remove").Select((x, i) => (x, i)))
            {
                var text = item is JsonValue v && v.TryGetValue<string>(out var t) ? t : null;
                if (text == null || (identifiers && !IsIdentifier(text)))
                    Add("XIF_SPEC_IDENTIFIER", $"remove.{key}[{i}]", $"'{item?.ToJsonString()}' is not a name to remove.", "List the exact names as strings.");
                else found.Add(text);
            }
            return found;
        }

        /// <summary>The items of a list field. K1-f: sources, references and resources given as ONE object (a reference also as
        /// one path) are a list of one, accepted and noted in specNormalized; any other non-list is refused with the minimal
        /// correct list as the fix.</summary>
        private List<JsonNode?> List(JsonObject owner, string key, string path, bool loose = false)
        {
            var node = owner[key];
            var at = path.Length == 0 ? key : path + "." + key;
            if (node == null) return [];
            if (node is JsonArray array) return array.ToList();
            if (loose && (node is JsonObject || (key == "references" && node is JsonValue v && v.TryGetValue<string>(out _))))
            {
                Normalized.Add(new XifNormalization(at, node is JsonObject ? "object" : "text", "list"));
                return [node];
            }
            Add("XIF_SPEC_SHAPE", at, $"{key} must be a list.",
                ListExamples.TryGetValue(key, out var example) ? $"Write {key} as a JSON array, for example \"{key}\": {example}." : $"Write {key} as a JSON array.");
            return [];
        }

        /// <summary>K1-f: an unknown field is named with where it belongs (a field of another level of the spec) or with the
        /// closest accepted field, plus the fields accepted here.</summary>
        private void Keys(JsonObject owner, string path, string[] allowed)
        {
            foreach (var (key, _) in owner)
            {
                if (allowed.Contains(key, StringComparer.Ordinal)) continue;
                var cased = allowed.FirstOrDefault(a => string.Equals(a, key, StringComparison.OrdinalIgnoreCase));
                var elsewhere = Levels.Where(l => l.Keys != allowed && l.Keys.Contains(key, StringComparer.Ordinal)).Select(l => l.Level).ToList();
                var closest = cased ?? Closest(key, allowed);
                var fix = cased != null ? $"Write '{cased}' (field names are case-sensitive)."
                    : elsewhere.Count > 0 && closest == null ? $"'{key}' is a field of {string.Join(" or ", elsewhere)}, not here; move it there."
                    : closest != null ? $"Did you mean '{closest}'?" + (elsewhere.Count > 0 ? $" '{key}' is a field of {string.Join(" or ", elsewhere)}." : "")
                    : "Remove it.";
                Add("XIF_SPEC_FIELD", path.Length == 0 ? key : path + "." + key, $"'{key}' is not a field here.", fix + " Accepted here: " + string.Join(", ", allowed) + ".");
            }
        }

        private bool? Bool(JsonObject owner, string key, string path)
        {
            if (owner[key] is not { } node) return null;
            if (node is JsonValue v && v.TryGetValue<bool>(out var flag)) return flag;
            Add("XIF_SPEC_SHAPE", path + "." + key, $"{key} must be true or false.", $"Write {key}: true or {key}: false.");
            return null;
        }

        private int? Int(JsonObject owner, string key, string path)
        {
            if (owner[key] is not { } node) return null;
            if (node is JsonValue v && v.TryGetValue<int>(out var number) && number >= 0) return number;
            Add("XIF_SPEC_SHAPE", path + "." + key, $"{key} must be a non-negative integer.", $"Write {key} as a whole number.");
            return null;
        }
    }

    internal static string? Text(JsonObject owner, string key) => owner[key] is JsonValue v && v.TryGetValue<string>(out var text) ? text : null;
}

/// <summary>K1-f: one value the parser accepted in another shape (sources as one object: from "object" to "list").</summary>
public sealed record XifNormalization(string Path, string From, string To);

/// <summary>What the spec is checked against: the actions and structures of the extension it edits (an existing action may
/// keep its body), and the .NET Framework assembly names an author DLL may reference.</summary>
public sealed class XifSpecContext
{
    public IReadOnlySet<string> ExistingActions { get; init; } = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    public IReadOnlySet<string> ExistingStructures { get; init; } = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    /// <summary>false only for a check without the files at hand (paths are still checked to be absolute).</summary>
    public bool RequireFiles { get; init; } = true;
    public Func<IReadOnlySet<string>> FrameworkAssemblies { get; init; } = XifCompiler.FrameworkAssemblyNames;
}

public sealed class XifStructure
{
    public required string Name { get; init; }
    public string? Description { get; init; }
    public IReadOnlyList<XifAttribute> Attributes { get; init; } = [];
    public string? Key { get; init; }

    public JsonObject ToJson()
    {
        var o = new JsonObject { ["name"] = Name };
        if (Key != null) o["key"] = Key;
        if (Description != null) o["description"] = Description;
        o["attributes"] = new JsonArray(Attributes.Select(a => (JsonNode)a.ToJson()).ToArray());
        return o;
    }
}

public sealed class XifAttribute
{
    public required string Name { get; init; }
    public required string Type { get; init; }
    public bool Mandatory { get; init; }
    public int? Length { get; init; }
    public int? Decimals { get; init; }
    public string? Default { get; init; }
    public string? Description { get; init; }
    public string? Key { get; init; }

    public JsonObject ToJson()
    {
        var o = new JsonObject { ["name"] = Name };
        if (Key != null) o["key"] = Key;
        o["type"] = Type;
        if (Mandatory) o["mandatory"] = true;
        if (Length != null) o["length"] = Length;
        if (Decimals != null) o["decimals"] = Decimals;
        if (!string.IsNullOrEmpty(Default)) o["default"] = Default;
        if (!string.IsNullOrEmpty(Description)) o["description"] = Description;
        return o;
    }
}

public sealed class XifAction
{
    public required string Name { get; init; }
    public string? Description { get; init; }
    public bool IsFunction { get; init; }
    public IReadOnlyList<XifParameter> Inputs { get; init; } = [];
    public IReadOnlyList<XifParameter> Outputs { get; init; } = [];
    /// <summary>The C# statements; null keeps the body the extension already has (an edit).</summary>
    public string? Body { get; init; }
    public string? Key { get; init; }

    public JsonObject ToJson()
    {
        var o = new JsonObject { ["name"] = Name };
        if (Key != null) o["key"] = Key;
        if (!string.IsNullOrEmpty(Description)) o["description"] = Description;
        if (IsFunction) o["isFunction"] = true;
        if (Inputs.Count > 0) o["inputs"] = new JsonArray(Inputs.Select(p => (JsonNode)p.ToJson()).ToArray());
        if (Outputs.Count > 0) o["outputs"] = new JsonArray(Outputs.Select(p => (JsonNode)p.ToJson()).ToArray());
        if (Body != null) o["body"] = Body;
        return o;
    }
}

public sealed class XifParameter
{
    public required string Name { get; init; }
    public required string Type { get; init; }
    public bool IsInput { get; init; }
    public bool Mandatory { get; init; }
    public string? Default { get; init; }
    public string? Description { get; init; }
    public string? Key { get; init; }

    public JsonObject ToJson()
    {
        var o = new JsonObject { ["name"] = Name };
        if (Key != null) o["key"] = Key;
        o["type"] = Type;
        if (IsInput) o["mandatory"] = Mandatory;
        if (!string.IsNullOrEmpty(Default)) o["default"] = Default;
        if (!string.IsNullOrEmpty(Description)) o["description"] = Description;
        return o;
    }
}

public sealed class XifSource
{
    public required string Path { get; init; }
    public string? File { get; init; }
    public string? Text { get; init; }
    public JsonObject ToJson() => File != null ? new() { ["path"] = Path, ["file"] = File } : new() { ["path"] = Path, ["text"] = Text };
    public string Read() => Text ?? System.IO.File.ReadAllText(File!);
}

public sealed class XifResource
{
    public required string Path { get; init; }
    public string? File { get; init; }
    public string? Text { get; init; }
    public string Deploy { get; init; } = "Ignore";

    public JsonObject ToJson()
    {
        var o = File != null ? new JsonObject { ["path"] = Path, ["file"] = File } : new JsonObject { ["path"] = Path, ["text"] = Text };
        o["deploy"] = Deploy;
        return o;
    }
}

public sealed class XifRemove
{
    public IReadOnlyList<string> Actions { get; init; } = [];
    public IReadOnlyList<string> Structures { get; init; } = [];
    public IReadOnlyList<string> Resources { get; init; } = [];
    public bool IsEmpty => Actions.Count == 0 && Structures.Count == 0 && Resources.Count == 0;

    public JsonObject ToJson()
    {
        var o = new JsonObject();
        if (Actions.Count > 0) o["actions"] = new JsonArray(Actions.Select(a => (JsonNode)JsonValue.Create(a)!).ToArray());
        if (Structures.Count > 0) o["structures"] = new JsonArray(Structures.Select(a => (JsonNode)JsonValue.Create(a)!).ToArray());
        if (Resources.Count > 0) o["resources"] = new JsonArray(Resources.Select(a => (JsonNode)JsonValue.Create(a)!).ToArray());
        return o;
    }
}
