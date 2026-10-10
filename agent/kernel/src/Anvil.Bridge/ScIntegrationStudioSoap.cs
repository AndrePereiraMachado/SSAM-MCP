using System.Text.Json.Nodes;
using System.Xml;
using System.Xml.Linq;

namespace Anvil.Bridge;

// sc_api surface integration-studio: the pure part (no Studio type), so the tests compile this file as is.
// IntegrationStudio.asmx is the SOAP 1.1 service Integration Studio itself calls. Its contract, read from the installed
// Integration Studio 11.14 (OutSystems.IntegrationStudio.Core, IntegrationStudioSoap and its message contracts):
//   SOAPAction http://ServiceCenter/IntegrationStudio/<Operation>; body wrapper <Operation xmlns="http://www.outsystems.com">
//   Handshake {username, password, version, lastUpgradeVersion} -> {ok, error, platform, database}
//   GenerateSourceCodeStubs {username, password, extension (base64)} -> {sourceCodeZip (base64), messages: HEMessage[]}
//   GetSourceCodeDependencies {username, password} -> {dependenciesZip (base64), messages: HEMessage[]}
//   UploadNeeded {username, password, ExtensionGUID, ExtensionHash} -> {Needs, ExtensionId, equalVersionId, runningVersionId, messages}
// username/password are the Studio's user and a fresh secret of its own login (the id_token under SSO), as for ServiceStudio.asmx.

/// <summary>One request to IntegrationStudio.asmx: endpoint, SOAPAction and the envelope (it carries the secret: never logged).</summary>
internal sealed record ScSoapRequest(Uri Uri, string SoapAction, string Body)
{
    public override string ToString() => $"POST {Uri} ({SoapAction})";
}

/// <summary>The read answer: HTTP status, a SOAP fault (redacted later), the fields of &lt;Operation&gt;Response and its HEMessage list.</summary>
internal sealed record ScSoapAnswer(int Status, string? Fault, IReadOnlyDictionary<string, XElement> Fields, IReadOnlyList<JsonObject> Messages)
{
    public string? Text(string name) => Fields.TryGetValue(name, out var e) ? e.Value : null;
    public bool? Bool(string name) => Text(name) is { } t && bool.TryParse(t.Trim(), out var b) ? b : null;
    public int? Int(string name) => Text(name) is { } t && int.TryParse(t.Trim(), System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out var n) ? n : null;
    public byte[]? Bytes(string name)
    {
        if (Text(name) is not { } text || text.Trim().Length == 0) return null;
        try { return Convert.FromBase64String(string.Concat(text.Where(c => !char.IsWhiteSpace(c)))); }
        catch (FormatException) { throw new ScFailure(ScCodes.RemoteError, $"IntegrationStudio.asmx answered {name} that is not base64", true); }
    }
    public IReadOnlyList<JsonObject> Errors => Messages.Where(m => string.Equals(m["type"]?.ToString(), "Error", StringComparison.OrdinalIgnoreCase)).ToList();
}

internal static class ScIntegrationStudioSoap
{
    public const string Path = "/ServiceCenter/IntegrationStudio.asmx";
    public const string Namespace = "http://www.outsystems.com";
    public const string ActionPrefix = "http://ServiceCenter/IntegrationStudio/";
    public const string ContentType = "text/xml; charset=utf-8";
    private static readonly XNamespace Ns = Namespace;
    private static readonly XNamespace Soap = "http://schemas.xmlsoap.org/soap/envelope/";

    public static Uri Endpoint(string host) => new($"https://{ScGuard.Host(host)}{Path}");

    /// <summary>The SOAP 1.1 envelope of one operation: username, password, then the operation's own fields in order.</summary>
    public static ScSoapRequest Request(string host, string operation, string user, string secret, params (string Name, string Value)[] fields)
    {
        var body = new XElement(Ns + operation, new XElement(Ns + "username", user), new XElement(Ns + "password", secret),
            fields.Select(f => new XElement(Ns + f.Name, f.Value)));
        var envelope = new XElement(Soap + "Envelope", new XAttribute(XNamespace.Xmlns + "soap", Soap.NamespaceName), new XElement(Soap + "Body", body));
        return new ScSoapRequest(Endpoint(host), ActionPrefix + operation, "<?xml version=\"1.0\" encoding=\"utf-8\"?>" + envelope.ToString(SaveOptions.DisableFormatting));
    }

    /// <summary>Reads one answer. A body that is not SOAP XML is an empty answer with the status; a fault keeps its text.</summary>
    public static ScSoapAnswer Parse(string operation, int status, string? body)
    {
        var fields = new Dictionary<string, XElement>(StringComparer.OrdinalIgnoreCase);
        var messages = new List<JsonObject>();
        if (string.IsNullOrWhiteSpace(body)) return new ScSoapAnswer(status, null, fields, messages);
        XDocument document;
        try
        {
            using var reader = XmlReader.Create(new StringReader(body), new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null });
            document = XDocument.Load(reader);
        }
        catch (XmlException) { return new ScSoapAnswer(status, body.Length > 400 ? body[..400] : body, fields, messages); }
        var soapBody = document.Root?.Elements().FirstOrDefault(e => e.Name.LocalName == "Body");
        var fault = soapBody?.Elements().FirstOrDefault(e => e.Name.LocalName == "Fault");
        if (fault != null)
        {
            var text = fault.Elements().FirstOrDefault(e => e.Name.LocalName is "faultstring" or "Reason")?.Value ?? fault.Value;
            return new ScSoapAnswer(status, text.Trim(), fields, messages);
        }
        var response = soapBody?.Elements().FirstOrDefault(e => e.Name.LocalName == operation + "Response");
        foreach (var field in response?.Elements() ?? [])
        {
            if (string.Equals(field.Name.LocalName, "messages", StringComparison.OrdinalIgnoreCase))
                messages.AddRange(field.Elements().Select(Message));
            else fields[field.Name.LocalName] = field;
        }
        return new ScSoapAnswer(status, null, fields, messages);
    }

    /// <summary>An HEMessage as JSON (Id, Message, Detail, HelpRef, ExtraInfo, Type).</summary>
    private static JsonObject Message(XElement message)
    {
        string? Of(string name) => message.Elements().FirstOrDefault(e => string.Equals(e.Name.LocalName, name, StringComparison.OrdinalIgnoreCase))?.Value;
        var o = new JsonObject { ["type"] = Of("Type"), ["id"] = Of("Id"), ["message"] = Of("Message"), ["detail"] = Of("Detail") };
        if (Of("ExtraInfo") is { Length: > 0 } extra) o["extraInfo"] = extra;
        if (int.TryParse(Of("HelpRef"), out var help) && help != 0) o["helpRef"] = help;
        return o;
    }
}
