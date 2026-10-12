using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

internal sealed class DebugFailure(string code) : Exception(code);
internal sealed class Configuration {
    public string SessionId { get; set; } = "";
    public string RuntimeUrl { get; set; } = "";
    public string Module { get; set; } = "";
    public string ModuleKey { get; set; } = "";
    public string? EntryModule { get; set; }
    public string? EntryModuleKey { get; set; }
    public string[] NodeKeys { get; set; } = [];
    // Optional owner moduleKey per breakpoint node (native ExtendedBreakpointId(OwnerESpace.Key, node)): the
    // session module plus at most one partner, e.g. the runner-bound ODC consumer/library pair. See BreakpointOwners.
    public Dictionary<string, string>? NodeModuleKeys { get; set; }
    public string? Token { get; set; }
    // Private worker stdin only: the O11 native SOAP caller sends its SSO ID token alongside
    // the distinct debugging bearer. These fields never belong to the public command contract.
    public string? SoapUser { get; set; }
    public string? SoapSecret { get; set; }
    public string? Credentials { get; set; }
    // Private stdin only. Actual app values protect aliases/nested records; never public metadata.
    public string[] PrivateValues { get; set; } = [];
    // Ephemeral controller/worker encryption key; private stdin only.
    public string? PrivateInspectionKey { get; set; }
    // Private stdin only. Production remains refused until controller/publisher qualification
    // covers the REST service's pre-entry hooks as well as the native wrapper graph.
    public RequestOwnershipConfiguration? RequestOwnership { get; set; }
    internal DebugPolicy.PrivateValues? Redactor { get; set; }
    internal void AddPrivateValues(params string?[] values) => Redactor?.Add(values);
    public string? ReceiptPath { get; set; }
    // Private bootstrap only: an app-user redaction lease never outlives its authority.
    public DateTimeOffset? CredentialExpiresAt { get; set; }
    internal DateTimeOffset? Deadline { get; set; }
    internal TimeSpan EvaluationTimeout {
        get {
            var seconds = Inspection == null ? Math.Min(PauseSeconds, 2) : 8;
            if (Deadline is not { } deadline) return TimeSpan.FromSeconds(seconds);
            var remaining = deadline - DateTimeOffset.UtcNow;
            if (remaining <= TimeSpan.Zero) throw new DebugFailure("debug_session_expired");
            return remaining < TimeSpan.FromSeconds(seconds) ? remaining : TimeSpan.FromSeconds(seconds);
        }
    }
    public int Seconds { get; set; } = 120;
    public int PauseSeconds { get; set; } = 5;
    public bool AutoContinue { get; set; } = true;
    public InspectionOptions? Inspection { get; set; }
    public string[] Paths { get; set; } = [];
    public TraceOptions? Trace { get; set; }
    public void Validate() {
        ValidatePrivateValues();
        if (CredentialExpiresAt is { } expiry && expiry <= DateTimeOffset.UtcNow) throw new DebugFailure("debug_app_user_expired");
        if (!Guid.TryParseExact(SessionId, "N", out _) || !Uri.TryCreate(RuntimeUrl, UriKind.Absolute, out var url) || url.Scheme != "https" || url.UserInfo != "" || url.Query != "" || url.Fragment != "") throw new DebugFailure("debug_invalid_target");
        if (!Regex.IsMatch(Module, "^[A-Za-z_][A-Za-z0-9_]{0,198}$") || Seconds is < 1 or > 600 || PauseSeconds is < 1 or > 30) throw new DebugFailure("debug_invalid_configuration");
#if ODC
        if (SoapUser != null || SoapSecret != null || EntryModule != null || EntryModuleKey != null) throw new DebugFailure("debug_invalid_auth_context");
#else
        if (EntryModule != null || EntryModuleKey != null) {
            if (EntryModule == null || EntryModuleKey == null || !Regex.IsMatch(EntryModule, "^[A-Za-z_][A-Za-z0-9_]{0,198}$") ||
                !Regex.IsMatch(EntryModuleKey, "^[A-Za-z0-9_+]{22}$") || url.AbsolutePath.TrimEnd('/') != "/" + EntryModule)
                throw new DebugFailure("debug_invalid_entry_binding");
        }
        if (Token != null) {
            if (!PrivateText(SoapUser, 512) || !PrivateText(SoapSecret, 65536)) throw new DebugFailure("debug_invalid_auth_context");
        } else if (SoapUser != null || SoapSecret != null) throw new DebugFailure("debug_invalid_auth_context");
#endif
        // A trace window may start at several entry nodes (every predecessor at distance X); a plain session keeps the exact short list.
        if (NodeKeys.Length < 1 || NodeKeys.Length > (Trace == null ? 20 : 200) || NodeKeys.Distinct().Count() != NodeKeys.Length) throw new DebugFailure("debug_exact_breakpoints_required");
        ValidateBreakpointOwners();
        ValidatePaths(Paths);
        Trace?.Validate();
        Inspection?.Validate();
        if (PrivateInspectionKey != null && (Inspection == null || !Regex.IsMatch(PrivateInspectionKey, "^[a-f0-9]{64}$")))
            throw new DebugFailure("debug_private_inspection_binding_invalid");
        if (Inspection != null && (AutoContinue || Trace != null)) throw new DebugFailure("debug_inspection_requires_manual_session");
        ValidateRequestOwnership();
        BlockedBindings.Refuse(this);
    }
    internal void ValidateRequestOwnership() {
        if (RequestOwnership == null) return;
#if ODC
        throw new DebugFailure("debug_request_ownership_lane_not_qualified");
#else
        var ownership = RequestOwnership;
        if (ownership.Qualification != RequestOwnershipQualification.OfflineSynthetic)
            throw new DebugFailure("debug_request_ownership_qualification_pending");
        if (!Uri.TryCreate(RuntimeUrl, UriKind.Absolute, out var target) || target.Scheme != "https" || target.GetLeftPart(UriPartial.Authority) != "https://example.invalid"
            || target.UserInfo != "" || target.Query != "" || target.Fragment != "" || Token != null || SoapUser != null || SoapSecret != null || Credentials != null
            || ownership.Binding == null || ownership.Binding.RuntimeOrigin != "https://example.invalid" || ownership.Binding.SessionId != SessionId
            || ownership.Binding.ModuleKey != ModuleKey || ownership.Binding.ExpiresAt > DateTimeOffset.UtcNow.AddSeconds(Seconds)
            || NodeKeys.Length != 1 || ownership.ProofBytes == null || ownership.ProofBytes.Length is < 1 or > 1048576)
            throw new DebugFailure("debug_request_ownership_offline_binding_invalid");
#endif
    }
    // Every breakpoint node keeps exactly one declared owner; a map never falls back to the session module.
    internal void ValidateBreakpointOwners() {
        if (NodeModuleKeys == null) return;
        if (NodeModuleKeys.Count > NodeKeys.Length || NodeModuleKeys.Any(kv => !Regex.IsMatch(kv.Key, "^[A-Za-z0-9_+]{22}$") ||
                !Regex.IsMatch(kv.Value ?? "", "^[A-Za-z0-9_+]{22}$") || !NodeKeys.Contains(kv.Key)))
            throw new DebugFailure("debug_invalid_breakpoint_owners");
        if (NodeKeys.Any(node => !NodeModuleKeys.ContainsKey(node)) || NodeModuleKeys.Values.Where(owner => owner != ModuleKey).Distinct().Count() > 1)
            throw new DebugFailure("debug_breakpoint_owner_required");
    }
    internal void ValidatePrivateValues() {
        if (PrivateValues == null || PrivateValues.Length > 32 || PrivateValues.Any(value => string.IsNullOrEmpty(value) || value.Length > 65536))
            throw new DebugFailure("debug_invalid_private_values");
    }
    static bool PrivateText(string? value, int max) => !string.IsNullOrEmpty(value) && value.Length <= max && !value.Any(char.IsControl);
    internal static void ValidatePaths(string[] paths, int max = 30) {
        if (paths.Length > max || paths.Any(p => !Regex.IsMatch(p, @"^[A-Za-z_][A-Za-z0-9_.\[\]]{0,499}$"))) throw new DebugFailure("debug_invalid_variable_path");
    }
}
// A binding (lane, runtime origin, module key) whose last native Start/Stop is uncertain never gets another session.
// Defense in depth below the facade: the code list holds operation 4c7016f0a51445108b185fdcd0109586 (Headless_UI on
// personal-2qqw9srv, 2026-10-03); the local registry .local/debugger/blocked-bindings/<sha256(lane|origin|moduleKey)>.json
// (the same hash the facade uses) adds more. A narrowly pinned native observation
// may neutralize the historical binding; the original operation stays non-replayable.
internal static class BlockedBindings {
#if ODC
    const string Lane = "odc";
#else
    const string Lane = "o11";
    static readonly (string Origin, string ModuleKey)[] Fixed = [("https://personal-2qqw9srv.outsystemscloud.com", "Mif02PxcH0K7KiABEHTwMg")];
#endif
    internal static string Hash(string origin, string moduleKey) =>
        Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(Lane + "|" + origin.ToLowerInvariant() + "|" + moduleKey))).ToLowerInvariant();
    internal static void Refuse(Configuration config) {
        if (!Uri.TryCreate(config.RuntimeUrl, UriKind.Absolute, out var url)) return;
        var origin = url.GetLeftPart(UriPartial.Authority).ToLowerInvariant();
        var root = config.ReceiptPath is { } receipt ? Path.GetDirectoryName(Path.GetDirectoryName(Path.GetFullPath(receipt))) : null;
#if !ODC
        var historical = Fixed.Any(b => b.Origin == origin && (b.ModuleKey == config.ModuleKey || b.ModuleKey == config.EntryModuleKey));
        if (historical && (config.SessionId == O11NativeNeutralization.OperationId || root == null ||
            !O11NativeNeutralization.Verify(root, origin, O11NativeNeutralization.ModuleKey))) throw new DebugFailure("debug_binding_blocked");
#endif
        if (root != null) foreach (var key in new[] { config.ModuleKey, config.EntryModuleKey }.Where(k => k != null)) {
            var file = Path.Combine(root, "blocked-bindings", Hash(origin, key!) + ".json");
            if (!File.Exists(file)) continue;
#if !ODC
            try {
                using var registry = JsonDocument.Parse(File.ReadAllBytes(file));
                if (registry.RootElement.TryGetProperty("operationId", out var operation) && operation.GetString() == O11NativeNeutralization.OperationId &&
                    config.SessionId != O11NativeNeutralization.OperationId && O11NativeNeutralization.Verify(root, origin, key!)) continue;
            } catch { /* An unreadable or unrelated registry is still blocked. */ }
#endif
            throw new DebugFailure("debug_binding_blocked");
        }
    }
}
internal enum RequestOwnershipQualification { Unqualified, OfflineSynthetic, ProductionQualified }
internal sealed class RequestOwnershipConfiguration {
    public RequestOwnershipQualification Qualification { get; set; }
    public DebugRequestOwnership.Binding? Binding { get; set; }
    public byte[] ProofBytes { get; set; } = [];
    public string? PrivateNonce { get; set; }
    internal void Clear() { if (ProofBytes != null) Array.Clear(ProofBytes); ProofBytes = []; PrivateNonce = null; Binding = null; }
}
// Tracer: at every pause dump the variables of the action on top of the stack, then step (or continue) at once.
// The map is the ordered list of those pauses, appended to trace.jsonl as they happen.
internal sealed class TraceOptions {
    internal const int MaxRoots = 60;
#if ODC
    static readonly Regex Key = new("^[A-Za-z0-9_+]{22}$");
#else
    // Traditional Preparation has the native screen-derived ObjectKey. This
    // exception is for trace function identity only, never module/breakpoint keys.
    static readonly Regex Key = new(@"^[A-Za-z0-9_+]{22}(?:\.#Preparation)?$");
#endif
    public string Mode { get; set; } = "step";          // step: step-into after each dump; breakpoints: continue after each dump
    public int Steps { get; set; } = 200;               // node visits recorded before the session only continues
    public int Depth { get; set; } = 2;                 // detail depth of each variable root
    public bool FullValues { get; set; }                // development tracing: every value except secrets
    public string? FocusFunctionKey { get; set; }       // stepping ends when this action leaves the stack
    public string? RequireFunctionKey { get; set; }     // only threads whose stack holds this action are traced
    public Dictionary<string, string[]> Scopes { get; set; } = new(); // functionKey -> variable roots
    internal void Validate() {
        if (Mode is not ("step" or "breakpoints") || Steps is < 1 or > 2000 || Depth is < 0 or > 4 || Scopes.Count > 500) throw new DebugFailure("debug_invalid_trace");
        if (new[] { FocusFunctionKey, RequireFunctionKey }.Any(k => k != null && !Key.IsMatch(k)) || Scopes.Keys.Any(k => !Key.IsMatch(k))) throw new DebugFailure("debug_invalid_trace");
        foreach (var roots in Scopes.Values) Configuration.ValidatePaths(roots, MaxRoots);
    }
}
internal sealed class Request {
    public string Op { get; set; } = "status";
    public string? ThreadId { get; set; }
    public string? EventId { get; set; }
    public int Frame { get; set; }
    public int Depth { get; set; } = 1;
    public string[] Paths { get; set; } = [];
    public string? Reference { get; set; }
    public string[] References { get; set; } = [];
    public string? ChildPath { get; set; }
    public InspectionScopeUpdate? ScopeUpdate { get; set; }
    public int Offset { get; set; }
    public int Limit { get; set; } = 50;
    public int TextOffset { get; set; }
    public int TextLimit { get; set; } = 4096;
    // read-frame node budget: roots plus child pages described in one bounded read.
    public int MaxNodes { get; set; } = 2000;
}
internal static class Wire {
    internal static readonly JsonSerializerOptions Options = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, PropertyNameCaseInsensitive = true, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow };
    internal static string Json(object value) => JsonSerializer.Serialize(value, Options);
    internal static string SafeFailureCode(Exception error, string fallback) => error is DebugFailure &&
        Regex.IsMatch(error.Message, @"^debug_[a-z_]{1,100}(?::[A-Za-z0-9_]{1,80}){0,3}$") ? error.Message : fallback;
    internal static string SafeExceptionClass(Exception error) => error.GetType().Name switch {
        "DebugFailure" or "WebException" or "HttpRequestException" or "IOException" or "TimeoutException" or
        "TaskCanceledException" or "OperationCanceledException" or "JsonReaderException" or "JsonSerializationException" or
        "JsonException" or "XmlException" or "InvalidOperationException" or "ArgumentException" or "NullReferenceException" or
        "AggregateException" => error.GetType().Name,
        _ => "unknown"
    };
    internal static object Error(Exception error) => new { ok = false, error = SafeFailureCode(error, "debug_native_error"), exceptionType = SafeExceptionClass(error) };
}
