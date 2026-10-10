using System.Net;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Bridge;

// secretRefs of sc_web fetch (CONTRATO.md, wave 2 item 1): a write postback names entries of the Windows vault for some
// of its form fields. The bridge reads them inside the Studio right before the send and puts them only in the form copy
// handed to the page script. A value never comes from the facade and never reaches an answer, a file or the log. This
// file needs no Studio type (the tests compile it); the vault itself is ScVault.cs, which the tests replace by a fake.

/// <summary>One form field filled from the vault. Field: the form field name; Target: the generic credential
/// (SSAM/O11/&lt;host&gt;/&lt;entry&gt;); Part: password (the credential blob) or username.</summary>
internal sealed record ScSecretRef(string Field, string Target, string Part);

/// <summary>A generic credential as the bridge reads it. ToString never shows the values.</summary>
internal sealed class ScVaultEntry(string? userName, string? password)
{
    public string? UserName { get; } = userName;
    public string? Password { get; } = password;
    public override string ToString() => nameof(ScVaultEntry);
}

/// <summary>The Windows vault as sc_web sees it: one generic credential by target name.</summary>
internal interface IScVault
{
    /// <summary>null when the vault has no such entry; a ScFailure when the vault cannot be read.</summary>
    ScVaultEntry? Read(string target);
}

internal static class ScSecretRefs
{
    public const string Prefix = "SSAM/O11/";
    public const int Limit = 8;
    private static readonly Regex EntryName = new("^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$", RegexOptions.CultureInvariant);
    // The logins SSAM keeps for this environment (windows-o11-credential.ps1, O11CredentialVault): never a form value of a
    // Service Center postback. The ServiceCenter login reaches one page only, the sign-in form, through sc_web login (ScWebLogin).
    private static readonly string[] Logins = ["ServiceCenter", "ServiceStudio", "LifeTime"];

    /// <summary>Checks secretRefs before the page is touched. Two shapes name the same thing: the O11 one
    /// {field: form field name, target, part: password|username} and the one shared with the ODC bridge
    /// {pointer: "/" + form field name (RFC 6901) or the bare name, target, field: password|username}, which the O11 facade
    /// sends. Only a write POST answered as html takes them, and
    /// each named field must already be in the form (any placeholder), so a misnamed field is refused, not added.</summary>
    public static IReadOnlyList<ScSecretRef> Parse(JsonObject request, string host, bool write, string method, string accept, JsonObject? form)
    {
        var node = request["secretRefs"];
        if (node is null) return [];
        if (node is not JsonArray list) throw Invalid("secretRefs must be a list of {field, target, part}");
        if (list.Count == 0) return [];
        if (!write)
            throw new ScFailure(ScCodes.NotAllowed, "secretRefs go only with a write postback (write:true, operationId, authorizeSha256); nothing was sent",
                details: Gate("secret_refs_write_only"));
        if (method != "POST" || form == null) throw Invalid("secretRefs fill fields of a POST form: send the form with each named field present (any placeholder)");
        if (accept != "html") throw Invalid("a postback with secretRefs is read as html");
        if (list.Count > Limit) throw Invalid($"at most {Limit} secretRefs per postback");
        var refs = new List<ScSecretRef>();
        foreach (var item in list)
        {
            if (item is not JsonObject entry) throw Invalid("each secretRef is an object {field, target, part}");
            foreach (var (key, _) in entry)
                if (key is not ("field" or "pointer" or "target" or "part"))
                    throw Invalid($"secretRef key '{(key.Length > 64 ? key[..64] : key)}' is not accepted: a secretRef names a vault entry and never carries a value");
            var part = Str(entry, "part");
            var field = Str(entry, "field");
            var pointer = Member(Str(entry, "pointer"));
            string? name;
            if (part != null)
            {
                if (field != null && pointer != null && field != pointer) throw Invalid("secretRef field and pointer name different form fields");
                name = field ?? pointer;
            }
            else (name, part) = (pointer, field);
            if (string.IsNullOrEmpty(name) || name.Length > 512) throw Invalid("secretRef must name the form field that receives the value (field)");
            if (part is not ("password" or "username")) throw Invalid("secretRef part must be password or username");
            if (!form.ContainsKey(name))
                throw Invalid($"secretRef field '{name}' is not in the form: send the form as read from the page, with that field present (any placeholder)");
            if (form[name] is not (null or JsonValue)) throw Invalid($"form field '{name}' takes one value from the vault, not a list");
            if (refs.Any(r => r.Field == name)) throw Invalid($"form field '{name}' is named by more than one secretRef");
            refs.Add(new ScSecretRef(name, Target(Str(entry, "target"), host), part));
        }
        return refs;
    }

    /// <summary>The target is an entry of this environment's namespace in the vault, never one of its logins.</summary>
    public static string Target(string? target, string host)
    {
        if (string.IsNullOrEmpty(target) || target.Length > 256 || target.Any(char.IsControl))
            throw Invalid("secretRef target must name a generic credential of the Windows vault: SSAM/O11/<host>/<entry>");
        var rest = target.StartsWith(Prefix, StringComparison.OrdinalIgnoreCase) ? target[Prefix.Length..] : null;
        var slash = rest?.IndexOf('/') ?? -1;
        if (rest == null || slash <= 0 || !string.Equals(rest[..slash], host, StringComparison.OrdinalIgnoreCase))
            throw new ScFailure(ScCodes.HostMismatch, $"secretRef target {target} is not an entry of this environment: it must start with {Prefix}{host}/; nothing was sent",
                details: Gate("secret_target_host"));
        var name = rest[(slash + 1)..];
        if (!EntryName.IsMatch(name) || name.Split('/').Any(segment => segment is "." or ".."))
            throw Invalid($"secretRef target {target}: the entry after {Prefix}{host}/ takes letters, digits, '_', '.', '-' and '/' segments");
        if (Logins.Contains(name, StringComparer.OrdinalIgnoreCase))
            throw new ScFailure(ScCodes.NotAllowed, $"secretRef target {target} is a login of this environment; it never goes into a form; nothing was sent",
                details: Gate("secret_target_login"));
        return target;
    }

    /// <summary>Reads each named entry once, in the Studio, right before the send. A missing entry or part stops the
    /// postback with SECRET_NOT_FOUND naming the target, never a value.</summary>
    public static ScInjected Resolve(IReadOnlyList<ScSecretRef> refs, IScVault vault)
    {
        if (refs.Count == 0) return ScInjected.None;
        var entries = new Dictionary<string, ScVaultEntry>(StringComparer.OrdinalIgnoreCase);
        var values = new List<KeyValuePair<string, string>>();
        foreach (var secretRef in refs)
        {
            if (!entries.TryGetValue(secretRef.Target, out var entry))
            {
                ScVaultEntry? read;
                try { read = vault.Read(secretRef.Target); }
                catch (ScFailure) { throw; }
                catch (Exception error)
                {
                    throw new ScFailure(ScCodes.StudioUnavailable, $"the Windows vault could not be read for secretRef target {secretRef.Target} ({error.GetType().Name}); nothing was sent",
                        details: new JsonObject { ["target"] = secretRef.Target, ["gate"] = "vault_unavailable" });
                }
                entries[secretRef.Target] = entry = read ?? throw NotFound(secretRef, "the Windows vault of this user has no such entry");
            }
            var value = secretRef.Part == "password" ? entry.Password : entry.UserName;
            if (string.IsNullOrEmpty(value)) throw NotFound(secretRef, $"the entry has no {secretRef.Part}");
            values.Add(new(secretRef.Field, value));
        }
        return new ScInjected(values);
    }

    private static ScFailure NotFound(ScSecretRef secretRef, string why) => new(ScCodes.SecretNotFound,
        $"secretRef target {secretRef.Target}: {why}; store it with the private prompt (kernel\\scripts\\service_center\\windows-o11-credential.ps1 -Mode bootstrap), then repeat; nothing was sent",
        details: new JsonObject { ["target"] = secretRef.Target, ["part"] = secretRef.Part, ["gate"] = "secret_not_found" });

    /// <summary>The form field a pointer names. The O11 facade sends an RFC 6901 pointer into the flat form, "/" + the
    /// field name with '~1' for '/' and '~0' for '~' (the format of the ODC bridge); a bare field name is taken as is.</summary>
    private static string? Member(string? pointer)
    {
        if (pointer is not ['/', ..]) return pointer;
        var member = pointer[1..];
        if (member.Contains('/'))
            throw Invalid("secretRef pointer names one field of the flat form: /<field name>, with '~1' for '/' and '~0' for '~'");
        return member.Replace("~1", "/").Replace("~0", "~");
    }

    private static string? Str(JsonObject entry, string name) => entry[name] switch
    {
        null => null,
        JsonValue value when value.TryGetValue<string>(out var text) => text,
        _ => throw Invalid($"secretRef {name} must be text"),
    };

    private static ScFailure Invalid(string message) => new(ScCodes.BadRequest, message + "; nothing was sent", details: Gate("secret_refs_invalid"));

    private static JsonObject Gate(string gate) => new() { ["gate"] = gate };
}

/// <summary>The vault values of one postback. They go only into the form copy handed to the page script and are masked
/// out of whatever comes back: the answer, its form state and any failure message. ToString never shows them.</summary>
internal sealed class ScInjected
{
    public static readonly ScInjected None = new([]);

    // Values shorter than this are masked only as whole tokens, so a short user name such as "sa" does not mask "message".
    private const int WholeTokenBelow = 8;
    private static readonly Regex StateInput = new("<input\\b[^>]*\\bname\\s*=\\s*[\"']?(?:__OSVSTATE|__VIEWSTATE|__EVENTVALIDATION)(?=[\"'\\s/>])[^>]*>",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex ValueAttribute = new("\\bvalue\\s*=\\s*(\"[^\"]*\"|'[^']*'|[^\\s>]+)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    // OsAjaxReply_v1(["__OSVSTATE","<state>"],...) and the page script that sets the state: input[name=__OSVSTATE]').val('<state>').
    private static readonly Regex AjaxState = new("(\"(?:__OSVSTATE|__VIEWSTATE|__EVENTVALIDATION)\"\\s*,\\s*\")([^\"]*)(\")", RegexOptions.CultureInvariant);
    private static readonly Regex ScriptState = new("(name=[\"']?(?:__OSVSTATE|__VIEWSTATE|__EVENTVALIDATION)[\"']?\\]['\"]?\\)\\.val\\(['\"])([^'\"]*)(['\"]\\))",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    private readonly IReadOnlyList<KeyValuePair<string, string>> values;
    private readonly Regex[] masks;
    private readonly Regex[] plain;

    public ScInjected(IReadOnlyList<KeyValuePair<string, string>> values)
    {
        this.values = values;
        plain = values.Select(v => v.Value).Distinct(StringComparer.Ordinal).Select(v => Pattern(v, v.Length < WholeTokenBelow)).ToArray();
        masks = values.Select(v => v.Value).Distinct(StringComparer.Ordinal)
            .SelectMany(v => Forms(v).Where(f => f.Length > 0).Distinct(StringComparer.Ordinal).Select(f => Pattern(f, v.Length < WholeTokenBelow)))
            .ToArray();
    }

    public int Count => values.Count;

    /// <summary>A copy of the form with the vault values in their fields; the request's own form is left as it came.</summary>
    public JsonObject? Apply(JsonObject? form)
    {
        if (values.Count == 0 || form == null) return form;
        var copy = form.DeepClone().AsObject();
        foreach (var (field, value) in values) copy[field] = value;
        return copy;
    }

    /// <summary>Every vault value in the forms a page can carry it (raw, HTML, JavaScript/JSON, URL) becomes the mask.</summary>
    public string Mask(string text)
    {
        foreach (var mask in masks) text = mask.Replace(text, ScRedaction.Mask);
        return text;
    }

    public ScFailure Mask(ScFailure failure) => values.Count == 0 ? failure
        : new ScFailure(failure.Code, Mask(failure.Message), failure.Sent, failure.Details == null ? null : Mask(failure.Details.DeepClone()) as JsonObject);

    /// <summary>The answer of a postback that carried vault values: values masked, form state dropped (a page keeps its
    /// inputs in __OSVSTATE, which the bridge cannot read; read the page again by GET to go on). A value still found
    /// after HTML or URL decoding drops the whole HTML.</summary>
    public void Clean(JsonObject body)
    {
        if (values.Count == 0) return;
        body["injectedFields"] = values.Count;
        // Bytes cannot be masked; a postback with secretRefs is read as html, so this only guards the contract.
        if (body.Remove("bodyBase64")) body["bodyOmitted"] = "a postback with vault values is read as html only";
        if (body["html"]?.ToString() is not { } html) return;
        // The state values are blanked where they sit; long ones are also removed wherever else the page copies them.
        var states = StateInput.Matches(html).SelectMany(tag => ValueAttribute.Matches(tag.Value)).Select(v => v.Groups[1].Value.Trim('"', '\''))
            .Concat(AjaxState.Matches(html).Concat(ScriptState.Matches(html)).Select(m => m.Groups[2].Value))
            .Where(state => state.Length > 0).Distinct(StringComparer.Ordinal).ToArray();
        html = StateInput.Replace(html, tag => ValueAttribute.Replace(tag.Value, "value=\"\""));
        html = ScriptState.Replace(AjaxState.Replace(html, "$1$3"), "$1$3");
        foreach (var state in states.Where(state => state.Length >= 16)) html = html.Replace(state, "", StringComparison.Ordinal);
        var masked = Mask(html);
        body["stateOmitted"] = states.Length > 0;
        body["echoMasked"] = masked != html;
        var decoded = WebUtility.HtmlDecode(masked);
        if (plain.Any(p => p.IsMatch(decoded) || p.IsMatch(Uri.UnescapeDataString(decoded))))
        {
            body["html"] = null;
            body["htmlOmitted"] = "the answer carried a vault value in a form the bridge does not mask; read the page again by GET";
        }
        else body["html"] = masked;
    }

    public override string ToString() => $"{nameof(ScInjected)}({values.Count})";

    private JsonNode? Mask(JsonNode? node) => node switch
    {
        JsonObject obj => new JsonObject(obj.Select(p => KeyValuePair.Create(p.Key, Mask(p.Value?.DeepClone())))),
        JsonArray array => new JsonArray(array.Select(item => Mask(item?.DeepClone())).ToArray()),
        JsonValue value when value.TryGetValue<string>(out var text) => JsonValue.Create(Mask(text)),
        _ => node,
    };

    private static IEnumerable<string> Forms(string value)
    {
        yield return value;
        yield return WebUtility.HtmlEncode(value);
        yield return value.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace("\"", "&quot;");
        yield return JsonEncodedText.Encode(value).ToString();
        yield return JsonEncodedText.Encode(value, JavaScriptEncoder.UnsafeRelaxedJsonEscaping).ToString();
        yield return value.Replace("\\", "\\\\").Replace("'", "\\'");
        yield return Uri.EscapeDataString(value);
        yield return WebUtility.UrlEncode(value);
    }

    private static Regex Pattern(string text, bool wholeToken)
    {
        static bool Word(char c) => char.IsLetterOrDigit(c) || c == '_';
        var before = wholeToken && Word(text[0]) ? "(?<![\\p{L}\\p{N}_])" : "";
        var after = wholeToken && Word(text[^1]) ? "(?![\\p{L}\\p{N}_])" : "";
        return new Regex(before + Regex.Escape(text) + after, RegexOptions.CultureInvariant);
    }
}
