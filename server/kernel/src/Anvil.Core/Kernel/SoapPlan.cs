using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;

namespace Anvil.Core;

/// <summary>One problem of an integration op (rest, rest-expose, soap) or of its document: UPPER_SNAKE code, the place in
/// the op data (JSON pointer relative to the op), one line, the exact fix. SsamRule marks a rule of SSAM that the platform
/// itself would not refuse (section 1.6 of docs/INTEGRACOES-GITSSAM.md).</summary>
public sealed record IntegrationProblem(string Code, string Path, string Message, string? Fix, bool SsamRule = false)
{
    public JsonObject ToJson(int? op = null, string? opsPointer = "/ops")
    {
        var pointer = op is { } i && opsPointer != null ? $"{opsPointer}/{i}{Path}" : Path;
        var json = JobPreflight.Problem(op, pointer, Code, "error", Message, Fix);
        if (SsamRule) json["ssamRule"] = true;
        return json;
    }
}

/// <summary>The refusal of an integration op before any of its raw ops is applied: every problem at once, with the
/// aggregated code (REST_REFUSED, REST_EXPOSE_REFUSED, SOAP_REFUSED) or the single problem's code when there is one.</summary>
public sealed class IntegrationRefusalException : KernelRefusalException
{
    public IReadOnlyList<IntegrationProblem> Items { get; }
    public IntegrationRefusalException(string op, IReadOnlyList<IntegrationProblem> problems)
        : base(problems.Select(p => p.Code).Distinct().Count() == 1 ? problems[0].Code : op.ToUpperInvariant().Replace('-', '_') + "_REFUSED",
            $"{op}: refused before any change, {problems.Count} problem(s): " + string.Join(" | ", problems.Select(p => $"[{p.Code}] {p.Path}: {p.Message}" + (p.Fix is { Length: > 0 } f ? " Fix: " + f : ""))),
            new JsonArray(problems.Select(p => (JsonNode)JobPreflight.PublicProblem(p.ToJson())).ToArray()))
    {
        Items = problems;
    }
}

/// <summary>
/// The headless pre-check of a SOAP import (op `soap`, O11): reads the pinned WSDL, lists its SOAP 1.1/1.2 ports and picks
/// the one the import uses, before anything changes. It ports the behavior GitSSAM proved live (soap_import.py), not its
/// code: a DTD or ENTITY is refused; service/port/binding/soapVersion filter the ports; every requested method must be an
/// operation of the chosen port; a single SOAP 1.1 port wins when nothing else decides; otherwise every choice is listed.
/// The native importer takes the PORT name (the binding resolves to the port that uses it). Pure: no Studio, no network.
/// </summary>
public static class SoapPlan
{
    public const int MaxWsdlBytes = 5 * 1024 * 1024;
    private const string WsdlNs = "http://schemas.xmlsoap.org/wsdl/";
    private const string Soap11Ns = "http://schemas.xmlsoap.org/wsdl/soap/";
    private const string Soap12Ns = "http://schemas.xmlsoap.org/wsdl/soap12/";
    public static readonly string[] Keys = ["wsdl", "client", "service", "port", "binding", "soapVersion", "methods", "refresh", "remove", "breaks"];
    public static readonly string[] DocumentKeys = ["path", "sha256", "source", "imports"];

    public static JsonObject Schema() => new()
    {
        ["op"] = "soap", ["lanes"] = new JsonArray("o11"),
        ["data"] = new JsonArray(Keys.Select(k => (JsonNode)k).ToArray()),
        ["shapes"] = new JsonObject { ["wsdl"] = new JsonArray("<url or absolute path>", "{path, sha256, source?, imports?:{<uri>: {path, sha256}}}"), ["document"] = new JsonArray(DocumentKeys.Select(k => (JsonNode)k).ToArray()) },
        ["soapVersion"] = new JsonArray("1.1", "1.2"),
        ["rules"] = "O11 only (ODC: SOAP_LANE_UNSUPPORTED). The WSDL is pinned by the deliver (5 MB, no DTD/ENTITY, .wso tries ?WSDL, imports bundled). "
            + "service/port/binding/soapVersion select the port; every method must be an operation of it; a single SOAP 1.1 port wins otherwise; ambiguity lists every choice. "
            + "The client name defaults to the service name (letters, digits, _; at most 50). The Studio's own importer runs on a copy of the module through o11_deliver "
            + "(bridge integration_import, the full WSDL with only the requested methods to import); existing methods are skipped, refresh imports them again, remove "
            + "deletes them and the structures no remaining method uses (breaks names their consumers). The candidate is checked before the merge: each method once, "
            + "the WSDL type bindings (SOAP_CONTRACT_TYPE_MISMATCH; xsd:decimal also accepts the native O11 lexical Text representation), TrueChange delta 0. ssam_job/o11_job without the Studio: INTEGRATION_IMPORT_NEEDS_STUDIO.",
        ["codes"] = new JsonArray(new[] { "WSDL_REQUIRED", "UNSAFE_WSDL_XML", "INVALID_WSDL_XML", "INVALID_WSDL_ROOT", "WSDL_HAS_NO_SOAP_PORTS", "SERVICE_NOT_FOUND", "PORT_NOT_FOUND",
            "BINDING_NOT_FOUND", "SOAP_VERSION_NOT_FOUND", "SOAP_METHOD_NOT_FOUND", "AMBIGUOUS_SOAP_PORT", "SOAP_METHODS_REQUIRED", "WSDL_TOO_LARGE", "SOAP_CLIENT_PORT_MISMATCH",
            "SOAP_CONTRACT_TYPE_MISMATCH", "SOAP_LANE_UNSUPPORTED", "DOCUMENT_SHA256_MISMATCH", "DOCUMENT_NOT_PINNED", "INTEGRATION_IMPORT_NEEDS_BRIDGE", "INTEGRATION_IMPORT_NEEDS_STUDIO",
            "INTEGRATION_IMPORTER_NOT_FOUND", "DELETE_HAS_CONSUMERS", "CONSUMERS_CHANGED" }.Select(c => (JsonNode)c).ToArray()),
    };

    public sealed record Port(string Service, string Name, string Binding, string PortType, string SoapVersion, string Endpoint, IReadOnlyList<string> Operations)
    {
        public JsonObject ToJson() => new()
        {
            ["service"] = Service, ["port"] = Name, ["binding"] = Binding, ["portType"] = PortType, ["soapVersion"] = SoapVersion,
            ["endpoint"] = Endpoint, ["operations"] = new JsonArray(Operations.Select(o => (JsonNode)o).ToArray()),
        };
    }

    /// <summary>The selection a valid plan carries: the port the native importer receives, the client the methods go to.</summary>
    public sealed record Selection(Port Port, string Client, IReadOnlyList<string> Methods, IReadOnlyList<string> Refresh, string DocumentPath, string DocumentSha256,
        IReadOnlyList<(string Uri, string Path, string Sha256)> Imports, string? Source)
    {
        public JsonObject ToJson() => new()
        {
            ["service"] = Port.Service, ["port"] = Port.Name, ["binding"] = Port.Binding, ["soapVersion"] = Port.SoapVersion,
        };
    }

    public sealed record Result(Selection? Selection, IReadOnlyList<IntegrationProblem> Problems, IReadOnlyList<Port> Ports);

    /// <summary>The whole check of a soap op's data: keys, document, ports, selection and methods, every problem at once.</summary>
    public static Result Plan(JsonObject data)
    {
        var problems = new List<IntegrationProblem>();
        foreach (var key in data.Select(p => p.Key).Where(k => !Keys.Contains(k, StringComparer.Ordinal)))
            problems.Add(new("SOAP_UNKNOWN_KEYS", "/data/" + key, $"soap: unknown key '{key}'", "use only: " + string.Join(", ", Keys)));
        var methods = Names(data, "methods", problems);
        var refresh = Names(data, "refresh", problems);
        var remove = Names(data, "remove", problems);
        Names(data, "breaks", problems);
        if (methods.Count == 0 && refresh.Count == 0 && remove.Count == 0)
            problems.Add(new("SOAP_METHODS_REQUIRED", "/data/methods", "soap: name at least one exact SOAP operation in methods (or refresh/remove)",
                "\"methods\": [\"<Operation>\"] with the operation names of the WSDL"));
        foreach (var name in refresh.Where(r => !methods.Contains(r, StringComparer.Ordinal)))
            methods.Add(name);
        string? soapVersion = null;
        if (data["soapVersion"] is { } versionNode)
        {
            soapVersion = NormalizeVersion(versionNode.ToString());
            if (soapVersion == null) problems.Add(new("SOAP_VERSION_INVALID", "/data/soapVersion", $"soap: soapVersion '{versionNode}' is not 1.1 or 1.2", "\"soapVersion\": \"1.1\" or \"1.2\""));
        }
        var document = Document(data, problems);
        if (document == null) return new(null, problems, []);
        IReadOnlyList<Port> ports;
        try { ports = Parse(document.Value.Bytes); }
        catch (SoapPlanException ex) { problems.Add(new(ex.Code, "/data/wsdl", ex.Message, ex.Fix)); return new(null, problems, []); }
        var wanted = methods.Count > 0 ? methods : remove;
        var port = Select(ports, Text(data, "service"), Text(data, "port"), Text(data, "binding"), soapVersion, methods, problems);
        if (problems.Count > 0 || port == null) return new(null, problems, ports);
        var client = Text(data, "client") is { Length: > 0 } given ? given : null;
        if (client != null && !Regex.IsMatch(client, "^[A-Za-z][A-Za-z0-9_]{0,49}$"))
            problems.Add(new("SOAP_CLIENT_NAME_INVALID", "/data/client", $"soap: client '{client}' is not an OutSystems name (letter first, letters, digits and _, at most 50)", $"\"client\": \"{ClientName(client)}\""));
        if (problems.Count > 0) return new(null, problems, ports);
        return new(new(port, client ?? ClientName(port.Service), methods, refresh, document.Value.Path, document.Value.Sha256, document.Value.Imports, document.Value.Source), problems, ports);
    }

    /// <summary>The OutSystems name of a WSDL service: any other character becomes _, a name that does not start with a
    /// letter gets the Soap_ prefix, at most 50 characters (the client name the import uses by default).</summary>
    public static string ClientName(string service)
    {
        var name = Regex.Replace((service ?? "").Trim(), "[^A-Za-z0-9_]", "_");
        if (name.Length == 0) return "SoapClient";
        if (!char.IsLetter(name[0]) || name[0] > 'z') name = "Soap_" + name;
        return name.Length > 50 ? name[..50] : name;
    }

    public static string? NormalizeVersion(string? value)
    {
        var text = (value ?? "").Trim().ToLowerInvariant().Replace("soap", "").Replace('_', '.').Replace('-', '.').Trim();
        return text switch { "" => null, "11" or "1.1" => "1.1", "12" or "1.2" => "1.2", _ => null };
    }

    public sealed class SoapPlanException(string code, string message, string fix) : Exception(message)
    {
        public string Code { get; } = code;
        public string Fix { get; } = fix;
    }

    /// <summary>The SOAP ports of a WSDL 1.1 document. A DTD or ENTITY is refused before the XML is parsed.</summary>
    public static IReadOnlyList<Port> Parse(byte[] wsdl)
    {
        if (wsdl.Length > MaxWsdlBytes)
            throw new SoapPlanException("WSDL_TOO_LARGE", $"WSDL has {wsdl.Length} bytes, more than the {MaxWsdlBytes}-byte limit", "pin a WSDL of at most 5 MB (split the service or import a smaller contract)");
        var upper = Encoding.UTF8.GetString(wsdl).ToUpperInvariant();
        if (upper.Contains("<!DOCTYPE", StringComparison.Ordinal) || upper.Contains("<!ENTITY", StringComparison.Ordinal))
            throw new SoapPlanException("UNSAFE_WSDL_XML", "WSDL with a DTD or ENTITY declaration is refused", "use the WSDL without <!DOCTYPE>/<!ENTITY> (the service's own ?WSDL contract has none)");
        XDocument xml;
        try
        {
            using var stream = new MemoryStream(wsdl);
            using var reader = XmlReader.Create(stream, new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null });
            xml = XDocument.Load(reader);
        }
        catch (XmlException ex) { throw new SoapPlanException("INVALID_WSDL_XML", "WSDL is not valid XML: " + ex.Message, "pin the service's WSDL document itself (not an HTML page)"); }
        var root = xml.Root!;
        if (root.Name.LocalName != "definitions")
            throw new SoapPlanException("INVALID_WSDL_ROOT", $"WSDL root is <{root.Name.LocalName}>, not <definitions> (WSDL 1.1)", "pin a WSDL 1.1 document whose root is wsdl:definitions");
        XName W(string local) => XName.Get(local, WsdlNs);
        var portTypes = root.Elements(W("portType")).Where(p => Attr(p, "name") != "")
            .GroupBy(p => Attr(p, "name")).ToDictionary(g => g.Key, g => g.First().Elements(W("operation")).Select(o => Attr(o, "name")).Where(n => n != "").ToArray(), StringComparer.Ordinal);
        var bindings = new Dictionary<string, (string PortType, string Version, string[] Operations)>(StringComparer.Ordinal);
        foreach (var b in root.Elements(W("binding")))
        {
            var name = Attr(b, "name");
            if (name == "" || bindings.ContainsKey(name)) continue;
            var version = b.Element(XName.Get("binding", Soap11Ns)) != null ? "1.1" : b.Element(XName.Get("binding", Soap12Ns)) != null ? "1.2" : "";
            var type = Local(Attr(b, "type"));
            var operations = b.Elements(W("operation")).Select(o => Attr(o, "name")).Where(n => n != "").ToArray();
            bindings[name] = (type, version, operations.Length > 0 ? operations : portTypes.GetValueOrDefault(type) ?? []);
        }
        var ports = new List<Port>();
        foreach (var service in root.Elements(W("service")))
        {
            var serviceName = Attr(service, "name");
            foreach (var port in service.Elements(W("port")))
            {
                var portName = Attr(port, "name");
                var bindingName = Local(Attr(port, "binding"));
                if (serviceName == "" || portName == "" || !bindings.TryGetValue(bindingName, out var binding)) continue;
                var a11 = port.Element(XName.Get("address", Soap11Ns));
                var a12 = port.Element(XName.Get("address", Soap12Ns));
                var version = binding.Version != "" ? binding.Version : a11 != null ? "1.1" : a12 != null ? "1.2" : "";
                if (version == "") continue;
                ports.Add(new(serviceName, portName, bindingName, binding.PortType, version, Attr(a11 ?? a12, "location"), binding.Operations));
            }
        }
        if (ports.Count == 0)
            throw new SoapPlanException("WSDL_HAS_NO_SOAP_PORTS", "WSDL has no SOAP 1.1 or SOAP 1.2 service port", "pin the WSDL of a SOAP service (an HTTP-only or REST WSDL has no SOAP port)");
        return ports;
    }

    /// <summary>The port the import uses. Selectors filter in order (service, port, binding, soapVersion); each one that
    /// leaves nothing is its *_NOT_FOUND with every choice; then every requested method must be on the port.</summary>
    public static Port? Select(IReadOnlyList<Port> ports, string? service, string? port, string? binding, string? soapVersion, IReadOnlyList<string> methods, List<IntegrationProblem> problems)
    {
        var candidates = ports.ToList();
        string Choices(IEnumerable<Port> list) => string.Join("; ", list.Select(p => $"service={p.Service}, port={p.Name}, binding={p.Binding}, soap={p.SoapVersion}"));
        bool Filter(string? value, Func<Port, string> field, string code, string key)
        {
            if (string.IsNullOrWhiteSpace(value)) return true;
            var local = Local(value);
            var kept = candidates.Where(p => field(p) == local).ToList();
            if (kept.Count == 0)
            {
                problems.Add(new(code, "/data/" + key, $"soap: no SOAP port with {key} '{value}'. Available: {Choices(ports)}", $"use one of: {string.Join(", ", ports.Select(field).Distinct())}"));
                return false;
            }
            candidates = kept;
            return true;
        }
        if (!Filter(service, p => p.Service, "SERVICE_NOT_FOUND", "service")) return null;
        if (!Filter(port, p => p.Name, "PORT_NOT_FOUND", "port")) return null;
        if (!Filter(binding, p => p.Binding, "BINDING_NOT_FOUND", "binding")) return null;
        if (!Filter(soapVersion, p => p.SoapVersion, "SOAP_VERSION_NOT_FOUND", "soapVersion")) return null;
        if (methods.Count > 0)
        {
            var exposing = candidates.Where(p => methods.All(m => p.Operations.Contains(m, StringComparer.Ordinal))).ToList();
            if (exposing.Count == 0)
            {
                var available = ports.SelectMany(p => p.Operations).Distinct(StringComparer.Ordinal).OrderBy(o => o, StringComparer.Ordinal).ToArray();
                var scope = candidates.SelectMany(p => p.Operations).ToHashSet(StringComparer.Ordinal);
                foreach (var missing in methods.Where(m => !scope.Contains(m)))
                    problems.Add(new("SOAP_METHOD_NOT_FOUND", "/data/methods", $"soap: operation '{missing}' is not on {(candidates.Count == ports.Count ? "any SOAP port" : "the selected port(s)")} of the WSDL",
                        "use one of: " + string.Join(", ", NameSuggestions.Closest(missing, available) is { Count: > 0 } close ? close : available.Take(20))));
                if (problems.Count == 0)
                    problems.Add(new("SOAP_METHOD_NOT_FOUND", "/data/methods", "soap: no single SOAP port exposes every requested operation (" + string.Join(", ", methods) + ")",
                        "split the methods by port, or name the port: " + Choices(candidates)));
                return null;
            }
            candidates = exposing;
        }
        if (candidates.Count == 1) return candidates[0];
        if (string.IsNullOrWhiteSpace(port) && string.IsNullOrWhiteSpace(binding) && string.IsNullOrWhiteSpace(soapVersion))
        {
            var soap11 = candidates.Where(p => p.SoapVersion == "1.1").ToList();
            if (soap11.Count == 1) return soap11[0];
        }
        problems.Add(new("AMBIGUOUS_SOAP_PORT", "/data", "soap: more than one SOAP port fits. Choices: " + Choices(candidates),
            "name one with \"port\" (or \"binding\" / \"soapVersion\"): " + string.Join(" | ", candidates.Select(p => $"\"port\": \"{p.Name}\""))));
        return null;
    }

    /// <summary>The pinned document of the op: {path, sha256, source?, imports?}, or an absolute local path. A URL is never
    /// fetched here: o11_deliver/ssam_job pin it first (facade integration-documents.mjs).</summary>
    private static (string Path, string Sha256, byte[] Bytes, IReadOnlyList<(string Uri, string Path, string Sha256)> Imports, string? Source)? Document(JsonObject data, List<IntegrationProblem> problems)
    {
        var node = data["wsdl"];
        if (node == null || node is JsonValue v && string.IsNullOrWhiteSpace(v.ToString()))
        {
            problems.Add(new("WSDL_REQUIRED", "/data/wsdl", "soap: wsdl is required (URL, path or the pinned {path, sha256})", "\"wsdl\": \"https://host/Service.asmx?WSDL\" (the deliver pins it) or {\"path\": \"<absolute>\", \"sha256\": \"<hex>\"}"));
            return null;
        }
        return IntegrationDocuments.Read(node, "/data/wsdl", problems, "WSDL", MaxWsdlBytes);
    }

    private static List<string> Names(JsonObject data, string key, List<IntegrationProblem> problems)
    {
        var list = new List<string>();
        if (data[key] is null) return list;
        if (data[key] is not JsonArray array) { problems.Add(new("SOAP_KEY_INVALID", "/data/" + key, $"soap: {key} is a list of names", $"\"{key}\": [\"<Name>\"]")); return list; }
        for (var i = 0; i < array.Count; i++)
        {
            var text = array[i] is JsonValue value && value.TryGetValue<string>(out var s) ? s.Trim() : "";
            if (text.Length == 0) problems.Add(new("SOAP_KEY_INVALID", $"/data/{key}/{i}", $"soap: {key}[{i}] is not a name", $"\"{key}\": [\"<Name>\"]"));
            else if (!list.Contains(text, StringComparer.Ordinal)) list.Add(text);
        }
        return list;
    }

    private static string? Text(JsonObject data, string key) => data[key] is JsonValue v && v.TryGetValue<string>(out var s) && s.Trim().Length > 0 ? s.Trim() : null;
    private static string Attr(XElement? element, string name) => element?.Attribute(name)?.Value.Trim() ?? "";
    private static string Local(string qname) => (qname ?? "").Split(':').Last().Trim();
}

/// <summary>Documents an integration op reads (WSDL, OpenAPI): the pinned form {path, sha256, source?, imports|external?}
/// or an absolute local path. The kernel reads only local, pinned bytes; a URL is pinned by the facade before the job runs.</summary>
public static class IntegrationDocuments
{
    public static string Sha256(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    public static (string Path, string Sha256, byte[] Bytes, IReadOnlyList<(string Uri, string Path, string Sha256)> Imports, string? Source)? Read(
        JsonNode node, string pointer, List<IntegrationProblem> problems, string label, int maxBytes, string importsKey = "imports")
    {
        string? path = null, sha = null, source = null;
        var imports = new List<(string Uri, string Path, string Sha256)>();
        if (node is JsonValue value && value.TryGetValue<string>(out var text))
        {
            if (Uri.TryCreate(text, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https")
            {
                problems.Add(new("DOCUMENT_NOT_PINNED", pointer, $"{label} '{text}' is a URL: the kernel reads only pinned local documents", "deliver through o11_deliver/studio_deliver/ssam_job, which pin it ({path, sha256, source}), or pass the downloaded file's absolute path"));
                return null;
            }
            path = text;
        }
        else if (node is JsonObject obj)
        {
            var allowed = new[] { "path", "sha256", "source", importsKey };
            foreach (var key in obj.Select(p => p.Key).Where(k => !allowed.Contains(k, StringComparer.Ordinal)))
                problems.Add(new("DOCUMENT_KEY_INVALID", pointer + "/" + key, $"{label}: unknown key '{key}'", "use only: " + string.Join(", ", allowed)));
            path = obj["path"]?.ToString(); sha = obj["sha256"]?.ToString(); source = obj["source"]?.ToString();
            if (obj[importsKey] is JsonObject deps)
                foreach (var (uri, dep) in deps)
                {
                    var depPath = dep?["path"]?.ToString(); var depSha = dep?["sha256"]?.ToString();
                    if (depPath == null || depSha == null || !System.IO.Path.IsPathFullyQualified(depPath))
                    { problems.Add(new("DOCUMENT_KEY_INVALID", $"{pointer}/{importsKey}", $"{label}: {importsKey} entry '{uri}' needs an absolute path and its sha256", $"\"{importsKey}\": {{\"{uri}\": {{\"path\": \"<absolute>\", \"sha256\": \"<hex>\"}}}}")); continue; }
                    if (!File.Exists(depPath)) { problems.Add(new("DOCUMENT_NOT_FOUND", $"{pointer}/{importsKey}", $"{label}: {importsKey} file of '{uri}' does not exist: {depPath}", "pin the document again (o11_deliver pins every import)")); continue; }
                    var depActual = Sha256(File.ReadAllBytes(depPath));
                    if (!string.Equals(depActual, depSha, StringComparison.OrdinalIgnoreCase))
                    { problems.Add(new("DOCUMENT_SHA256_MISMATCH", $"{pointer}/{importsKey}", $"{label}: {importsKey} file of '{uri}' has sha256 {depActual}, not the pinned {depSha}", "pin the document again; the bytes changed after pinning")); continue; }
                    imports.Add((uri, depPath, depActual));
                }
            else if (obj[importsKey] != null)
                problems.Add(new("DOCUMENT_KEY_INVALID", $"{pointer}/{importsKey}", $"{label}: {importsKey} is an object {{uri: {{path, sha256}}}}", null));
        }
        if (string.IsNullOrWhiteSpace(path))
        {
            problems.Add(new("DOCUMENT_KEY_INVALID", pointer, $"{label}: the pinned document needs path", "{\"path\": \"<absolute>\", \"sha256\": \"<hex>\"}"));
            return null;
        }
        if (!System.IO.Path.IsPathFullyQualified(path))
        {
            problems.Add(new("DOCUMENT_PATH_RELATIVE", pointer + "/path", $"{label}: path '{path}' is relative", "use the absolute path of the pinned document"));
            return null;
        }
        if (!File.Exists(path))
        {
            problems.Add(new("DOCUMENT_NOT_FOUND", pointer + "/path", $"{label}: {path} does not exist", "pin the document again"));
            return null;
        }
        var length = new FileInfo(path).Length;
        if (length > maxBytes)
        {
            problems.Add(new(label == "WSDL" ? "WSDL_TOO_LARGE" : "DOCUMENT_TOO_LARGE", pointer, $"{label} has {length} bytes, more than {maxBytes}", "use a document of at most 5 MB"));
            return null;
        }
        var bytes = File.ReadAllBytes(path);
        var actual = Sha256(bytes);
        if (sha != null && !string.Equals(sha, actual, StringComparison.OrdinalIgnoreCase))
        {
            problems.Add(new("DOCUMENT_SHA256_MISMATCH", pointer + "/sha256", $"{label}: {path} has sha256 {actual}, not the pinned {sha}", "pin the document again; the bytes changed after pinning"));
            return null;
        }
        return (System.IO.Path.GetFullPath(path), actual, bytes, imports, source);
    }
}
