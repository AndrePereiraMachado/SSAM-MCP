using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Core;

/// <summary>The accepted module declaration; data and logic use the existing compilers and the same delivery.</summary>
public static class ModuleSpecification
{
    private static readonly string[] Sections = ["data", "logic", "roles", "exceptions", "screens"];
    public static JsonObject Normalize(JsonObject specification, Func<UiNativeImport,ScreenContract>? nativeResolver=null)
    {
        if (CompileCSharpSource(specification) is {} compiled) return compiled.Specification;
        if (specification["uiSource"] is { } source)
        {
            Keys(specification, ["uiSource"], "UI source contract");
            return HtmlComponents.Compile(UiSourceBundle.From(source),nativeResolver);
        }
        // Existing durable data tasks retain their original serialized request.
        if (specification.Any(p => p.Key is "entities" or "static" or "clientEntities" or "structures"))
            return new JsonObject { ["data"] = specification.DeepClone() };
        return specification.DeepClone().AsObject();
    }
    internal static Anvil.CSharp.CompilationResult? CompileCSharpSource(JsonObject specification)
    {
        if (specification["csharpSource"] is not {} code) return null;
        Keys(specification, ["csharpSource"], "C# source contract");
        return Anvil.CSharp.CSharpCompiler.Compile(Anvil.CSharp.SourceBundle.From(code));
    }
    public static bool IsHtmlSource(string path) => Path.GetExtension(path).Equals(".html", StringComparison.OrdinalIgnoreCase);
    public static bool IsCSharpSource(string path) => Path.GetExtension(path).Equals(".cs", StringComparison.OrdinalIgnoreCase);
    public static bool IsAuthoredSource(string path) => IsHtmlSource(path) || IsCSharpSource(path);
    // D3 (atritos 3, C24): a job written as an array of ops is {ops:[...]}, never a raw "must be of type JsonObject".
    public static JsonObject SourceDocument(string path) => IsAuthoredSource(path) ? new JsonObject() : JobDocument.Read(path);
    public static JsonObject Read(string path)
    {
        if (IsCSharpSource(path))
        {
            var authored = new JsonObject { ["csharpSource"] = Anvil.CSharp.SourceBundle.Read(path) };
            Validate(authored); return authored;
        }
        if (IsHtmlSource(path))
        {
            var authored=new JsonObject{["uiSource"]=UiSourceBundle.Read(path).ToJson()};
            Validate(authored);return authored;
        }
        var document = JobDocument.Read(path);
        if (document.ContainsKey("csharpSource"))
        {
            Keys(document, ["csharpSource", "expectedMessages", "description"], "C# source document");
            var authored = new JsonObject { ["csharpSource"] = document["csharpSource"]!.DeepClone() };
            Validate(authored); MessageExpectations.Read(document, path); return authored;
        }
        if(document.ContainsKey("uiSource"))
        {
            Keys(document,["uiSource","expectedMessages","description"],"UI source document");
            var authored=new JsonObject{["uiSource"]=document["uiSource"]!.DeepClone()};Validate(authored);MessageExpectations.Read(document,path);return authored;
        }
        Keys(document, Sections.Concat(["expectedMessages", "description"]), "module contract");
        var specification = new JsonObject(document.Where(p => Sections.Contains(p.Key)).Select(p => KeyValuePair.Create(p.Key, p.Value?.DeepClone())));
        Validate(specification); MessageExpectations.Read(document, path);
        return specification;
    }
    public static JsonObject Schema()
    {
        var logic = LogicExpander.Schema();
        var keys = logic["action"]!.AsArray();
        for (var i = keys.Count - 1; i >= 0; i--) if (keys[i]!.ToString() == "replace") keys.RemoveAt(i);
        keys.Add("access");
        return new JsonObject {
        ["sections"] = new JsonArray(Sections.Select(s => (JsonNode)JsonValue.Create(s)!).ToArray()),
        ["csharpSource"] = Anvil.CSharp.SourceBundle.Schema(),
        ["uiSource"] = new JsonObject{["oneOf"]=new JsonArray(new JsonObject{["type"]="string"},new JsonObject{["type"]="object",["properties"]=new JsonObject{["entry"]=new JsonObject{["type"]="string"},["files"]=new JsonObject{["type"]="object",["additionalProperties"]=new JsonObject{["type"]="string"}}},["required"]=new JsonArray("entry","files"),["additionalProperties"]=false}),["description"]="Author UI as HTML/CSS/JS text or a bundle of files with a relative entry path. Default/named imports of HTML blocks resolve within the bundle; aliases share native definitions. Native blocks use import { Block } from outsystems:Module/Flow against references already registered in the target snapshot; original producer names survive local reference aliases. Missing dependencies and unsupported codecs are explicit errors. Inputs/events are typed exports, export let declares state, {{expression}} renders JS, @event connects callbacks and slot projects content. All source contents are frozen together; do not supply a separate binding manifest."},
        ["data"] = SpecExpander.Schema(), ["logic"] = logic, ["screens"] = ScreenSpecification.Schema(),
        ["role"] = new JsonArray("name", "public", "description"), ["exception"] = new JsonArray("name", "description"),
        ["actionAccess"] = new JsonObject { ["keys"] = new JsonArray("authenticated", "roles", "inputs", "readScopes"),
            ["inputPolicy"] = new JsonObject { ["keys"] = new JsonArray("roles", "default"), ["rule"] = "Other roles may only pass the declared safe default; mismatch raises before executing the body." },
            ["readScope"] = new JsonObject { ["keys"] = new JsonArray("query", "ownerAttribute", "exceptRoles"), ["rule"] = "Named aggregate receives an additional owner = GetUserId filter, with explicit role exceptions; SQL ownership injection is unsupported." },
            ["rules"] = "Public server/service actions require access with authenticated:true. Optional roles are declared in this contract. Guards use GetUserId, never an actor supplied by the caller. Client code does not enforce server authorization." },
        ["scope"] = "Declared data, roles, exceptions, action signatures, expressions, control flow and screen/widget trees and bindings. Natural-language completeness and arbitrary business behavior are not inferred."
        };
    }
    public static void Validate(JsonObject specification)
    {
        if(specification["uiSource"] is {} source)
        {
            Keys(specification,["uiSource"],"UI source contract");HtmlComponents.ValidateSource(UiSourceBundle.From(source));return;
        }
        var normalized = Normalize(specification); Keys(normalized, Sections, "module contract");
        foreach (var section in normalized)
        {
            if (section.Key is "data" or "logic") { if (section.Value is not JsonObject) throw new ArgumentException(section.Key + " must be an object"); }
            else if (section.Value is not JsonArray array || array.Any(item => item is not JsonObject)) throw new ArgumentException(section.Key + " must contain declaration objects");
        }
        var ops = new JsonArray();
        if (normalized["data"] is JsonObject data && data.Count > 0)
        {
            DataSpecification.Validate(data);
            if ((data["clientEntities"]?.AsArray().OfType<JsonObject>() ?? []).Any(e => e["public"]?.GetValue<bool>() == true))
                throw new ArgumentException("Public client entities are not preserved by native merge in this Studio build; expose a public structure instead");
            ops.Add(new JsonObject { ["op"] = "spec", ["data"] = data.DeepClone() });
        }
        foreach (var (section, kind) in new[] { ("roles", "IRole"), ("exceptions", "IUserException") })
        {
            var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var item in normalized[section]?.AsArray().OfType<JsonObject>() ?? [])
            {
                Keys(item, section == "roles" ? ["name", "public", "description"] : ["name", "description"], section);
                var name = Name(item["name"], section);
                if (!names.Add(name)) throw new ArgumentException($"Duplicate {section} declaration: {name}");
                ops.Add(new JsonObject { ["op"] = "create", ["parent"] = "@espace", ["type"] = kind, ["name"] = name });
            }
        }
        if (normalized["logic"] is JsonObject logic)
        {
            foreach (var action in logic["actions"]?.AsArray().OfType<JsonObject>() ?? [])
                if (action.ContainsKey("replace")) throw new ArgumentException("The controller determines replacement; replace is not a contract field");
            var compiled = Logic(normalized);
            ops.Add(new JsonObject { ["op"] = "logic", ["data"] = compiled });
        }
        if (normalized["screens"] is JsonArray screens) ScreenSpecification.Validate(screens);
        if ((normalized["screens"]?.AsArray().Count ?? 0) == 0 && (ops.Count == 0 || !ops.Any(op => op?["op"]?.ToString() != "logic" || op?["data"]?["actions"]?.AsArray().Count > 0))) throw new ArgumentException("Module contract cannot be empty");
        JobPreflight.Validate(ops);
    }
    public static JsonObject Logic(JsonObject specification)
    {
        var normalized = Normalize(specification);
        var logic = normalized["logic"]?.DeepClone().AsObject() ?? new JsonObject { ["actions"] = new JsonArray() };
        var roles = (normalized["roles"]?.AsArray().OfType<JsonObject>() ?? []).Select(role => Name(role["name"], "role")).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var action in logic["actions"]?.AsArray().OfType<JsonObject>() ?? [])
        {
            var access = action["access"] as JsonObject;
            var server = LogicOrder.ActionType(action) is "IServerAction" or "IServiceAction";
            LogicOrder.Owner(action);
            if (LogicOrder.ActionType(action) == "IServiceAction" && action["public"]?.GetValue<bool>() == false)
                throw new ArgumentException("Service actions are public entry points; public:false is unsupported");
            if (server && (action["public"]?.GetValue<bool>() == true || LogicOrder.ActionType(action) == "IServiceAction") && access == null)
                throw new ArgumentException($"Public action {action["name"]} requires an explicit access contract");
            if (action.ContainsKey("access") && access == null) throw new ArgumentException("Action access must be an object");
            if (access == null) continue;
            if (action["handlers"] is JsonArray handlers)
            {
                var businessExceptions = (normalized["exceptions"]?.AsArray().OfType<JsonObject>() ?? []).Select(e => e["name"]!.ToString()).Where(n => !n.Equals("HybridAccessDenied", StringComparison.OrdinalIgnoreCase)).ToHashSet(StringComparer.OrdinalIgnoreCase);
                if (handlers.Any(h => !businessExceptions.Contains((h?["exception"]?.ToString() ?? "").Replace("IUserException:", "", StringComparison.Ordinal))))
                    throw new ArgumentException("Access-denied guards cannot be intercepted: handlers on authenticated actions must name distinct business exceptions declared in the contract");
            }
            if (!server) throw new ArgumentException("Client actions cannot provide a server authorization certificate; enforce access in the called server action");
            Keys(access, ["authenticated", "roles", "inputs", "readScopes"], "action access");
            if (access.ContainsKey("inputs") && access["inputs"] is not JsonObject) throw new ArgumentException("access.inputs must be an object");
            foreach (var key in new[] { "roles", "readScopes" }) if (access.ContainsKey(key) && access[key] is not JsonArray) throw new ArgumentException("access." + key + " must be an array");
            if (access["authenticated"]?.GetValue<bool>() != true) throw new ArgumentException("Controlled server entry points currently require authenticated:true");
            var allowed = RoleList(access["roles"]);
            var steps = action["steps"]?.AsArray() ?? throw new ArgumentException("Action steps are required");
            var prefix = new List<JsonObject> { Guard("GetUserId() = NullIdentifier()", "HybridAuthenticated") };
            if (allowed.Length > 0) prefix.Add(Guard("not (" + RoleCondition(allowed) + ")", "HybridRoles"));
            var inputNames = (action["inputs"]?.AsArray().OfType<JsonObject>() ?? []).Select(input => input["name"]!.ToString()).ToHashSet(StringComparer.OrdinalIgnoreCase);
            foreach (var rule in access["inputs"]?.AsObject() ?? new JsonObject())
            {
                var input = Name(JsonValue.Create(rule.Key), "input policy");
                if (!inputNames.Contains(input)) throw new ArgumentException("Input policy names an undeclared parameter: " + input);
                var policy = rule.Value?.AsObject() ?? throw new ArgumentException("Input policy requires an object");
                Keys(policy, ["roles", "default"], "input policy");
                var privileged = RoleList(policy["roles"]);
                if (privileged.Length == 0) throw new ArgumentException("Input policy requires the roles allowed to supply another value");
                var fallback = policy["default"]?.GetValue<string>() ?? throw new ArgumentException("Input policy requires a safe default expression");
                if (!Regex.IsMatch(fallback, "^(?:NullIdentifier\\(\\)|GetUserId\\(\\)|True|False|-?[0-9]+(?:\\.[0-9]+)?|Entities\\.[A-Za-z][A-Za-z0-9_]*\\.[A-Za-z][A-Za-z0-9_]*|\"(?:\"\"|[^\"])*\")$", RegexOptions.IgnoreCase))
                    throw new ArgumentException("Input policy default must be a literal, static record, NullIdentifier() or the current GetUserId(); caller-controlled expressions are forbidden");
                prefix.Add(Guard("not (" + RoleCondition(privileged) + ") and " + input + " <> (" + fallback + ")", "HybridInput_" + input));
            }
            var queries = AllSteps(steps).Concat((action["handlers"]?.AsArray().OfType<JsonObject>() ?? []).SelectMany(h => AllSteps(h["steps"]!.AsArray()))).Where(step => step.ContainsKey("get")).ToArray(); var scoped = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var item in access["readScopes"]?.AsArray() ?? new JsonArray())
            {
                var scope = item?.AsObject() ?? throw new ArgumentException("Read scope requires an object"); Keys(scope, ["query", "ownerAttribute", "exceptRoles"], "read scope");
                var query = Name(scope["query"], "scoped query"); var owner = Name(scope["ownerAttribute"], "owner attribute");
                var matches = queries.Where(step => step["as"]?.ToString() == query).ToArray();
                if (!scoped.Add(query) || matches.Length != 1) throw new ArgumentException("Read scope must name exactly one distinct query: " + query);
                var source = matches[0];
                if (source["sql"]?.GetValue<bool>() == true) throw new ArgumentException("Automatic owner scopes currently require an aggregate; SQL scope is not silently approximated");
                var except = RoleList(scope["exceptRoles"]);
                var condition = (except.Length == 0 ? "" : RoleCondition(except) + " or ") + source["get"] + "." + owner + " = GetUserId()";
                var where = source["where"] is JsonArray array ? array.DeepClone().AsArray()
                    : source["where"] != null ? new JsonArray(source["where"]!.DeepClone()) : new JsonArray();
                where.Add("(" + condition + ")"); source["where"] = where;
            }
            action.Remove("access");
            for (var i = prefix.Count - 1; i >= 0; i--) steps.Insert(0, prefix[i]);

            string[] RoleList(JsonNode? list)
            {
                var values = list?.AsArray().Select(role => Name(role, "access role")).ToArray() ?? [];
                if (values.Distinct(StringComparer.OrdinalIgnoreCase).Count() != values.Length || values.Any(role => !roles.Contains(role)))
                    throw new ArgumentException("Access roles must be distinct roles declared in this module contract");
                return values;
            }
        }
        return logic;
    }
    public static IEnumerable<JsonObject> Declarations(JsonObject specification)
    {
        var normalized = Normalize(specification);
        foreach (var section in new[] { "roles", "exceptions" })
            foreach (var declaration in normalized[section]?.AsArray().OfType<JsonObject>() ?? [])
            {
                var result = declaration.DeepClone().AsObject(); result["type"] = section == "roles" ? "IRole" : "IUserException"; yield return result;
            }
        if ((normalized["logic"]?["actions"]?.AsArray().OfType<JsonObject>() ?? []).Any(action => action["access"] != null)
            && !(normalized["exceptions"]?.AsArray().OfType<JsonObject>() ?? []).Any(e => e["name"]?.ToString().Equals("HybridAccessDenied", StringComparison.OrdinalIgnoreCase) == true))
            yield return new JsonObject { ["name"] = "HybridAccessDenied", ["type"] = "IUserException" };
    }
    private static IEnumerable<JsonObject> AllSteps(JsonArray steps)
    {
        foreach (var step in steps.OfType<JsonObject>())
        {
            yield return step;
            foreach (var branch in step["switch"]?.AsArray().OfType<JsonObject>() ?? []) foreach (var child in AllSteps(branch["steps"]!.AsArray())) yield return child;
            foreach (var key in new[] { "then", "else", "do", "next", "otherwise" })
                if (step[key] is JsonArray children) foreach (var child in AllSteps(children)) yield return child;
        }
    }
    private static string RoleCondition(IEnumerable<string> roles) => string.Join(" or ", roles.Select(role => $"CheckRole(Roles.{role}, GetUserId())"));
    private static JsonObject Guard(string denied, string name) => new() { ["if"] = denied, ["as"] = name,
        ["then"] = new JsonArray(new JsonObject { ["raise"] = "HybridAccessDenied", ["message"] = "\"Access denied\"" }) };
    private static string Name(JsonNode? value, string where)
    {
        var text = value?.GetValue<string>() ?? "";
        if (!Regex.IsMatch(text, "^[A-Za-z][A-Za-z0-9_]*$")) throw new ArgumentException($"Invalid {where} name: {text}");
        return text;
    }
    private static void Keys(JsonObject value, IEnumerable<string> allowed, string where)
    {
        var unknown = value.Select(p => p.Key).Except(allowed, StringComparer.Ordinal).ToArray();
        if (unknown.Length > 0) throw new ArgumentException($"{where}: unknown fields {string.Join(", ", unknown)}");
    }
}
