using ServiceStudio.PluginAPI.Debugger;
using ServiceStudio.ServerCommunications.API;
using System.Text.Json.Serialization;
using System.Xml;
using System.Xml.Linq;
using System.Security.Cryptography;
using System.Text;

// Raw provenance must survive the native ServerThreadData constructor's ThreadId fallback.
// This envelope is transport-private; it is never a command result or receipt.
internal sealed class DebugTransportEvent(DebuggerEvent nativeEvent, DebugTransportEvent.RequestProvenance provenance) {
    [JsonIgnore] internal DebuggerEvent NativeEvent { get; } = nativeEvent;
    [JsonIgnore] internal string? RawRequestId { get; } = provenance.RawRequestId;
    internal bool RawRequestIdPresent { get; } = provenance.Present;
    internal bool RequestIdIsFallback { get; } = provenance.IsFallback;
    internal string? NativeRequestIdSha256 => provenance is { Present: true, IsFallback: false, RawRequestId: { Length: > 0 and <= 512 } id }
        && !id.Any(char.IsControl) && NativeEvent.ThreadData is ServerThreadData thread && !thread.IsClientSideThread && thread.RequestId == id
        ? Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(id))).ToLowerInvariant() : null;
    // Value-free qualification of the raw id against platform ids: a length bucket and a format class only.
    internal object NativeRequestIdShape => RequestIdShape(provenance.Present && !provenance.IsFallback ? provenance.RawRequestId : null,
        provenance.Present, provenance.IsFallback, NativeEvent.ThreadData);
    internal static object RequestIdShape(string? raw, bool present = true, bool fallback = false, ThreadData? thread = null) => new {
        present = present && raw != null, fallback,
        lengthBucket = raw == null ? null : raw.Length switch { 0 => "0", <= 8 => "1-8", <= 16 => "9-16", <= 32 => "17-32", <= 36 => "33-36",
            <= 64 => "37-64", <= 128 => "65-128", <= 512 => "129-512", _ => ">512" },
        format = raw == null ? null : raw.Length == 36 && Guid.TryParseExact(raw, "D", out _) ? "guid"
            : raw.Length == 32 && raw.All(Uri.IsHexDigit) ? "hex32" : "other",
        threadRequestIdMatch = raw != null && thread is ServerThreadData server && server.RequestId == raw,
        clientThread = thread?.IsClientSideThread == true
    };
    // ThreadEnd's native last breakpoint (XML attribute or typed payload; the PluginAPI conversion drops it).
    // Only a node of the thread's own module is reported, as its ObjectKey.
    internal string? LastBreakpointNodeKey => NativeEvent is ServiceStudio.PluginAPI.Debugger.ThreadEndEvent && provenance.LastBreakpoint is { Length: > 0 and <= 512 } text &&
        !text.Any(char.IsControl) && NativeEvent.ThreadData is ServerThreadData { IsClientSideThread: false } thread &&
        Breakpoint.TryParse(text, out var breakpoint) && breakpoint.ESpaceKey != null && breakpoint.ESpaceKey.ToString() == thread.ESpaceKey?.ToString()
            ? breakpoint.ObjectKey?.ToString() : null;
    public override string ToString() => "DebugTransportEvent";
    internal sealed record RequestProvenance([property: JsonIgnore] string? RawRequestId, bool Present, bool IsFallback,
        [property: JsonIgnore] string? LastBreakpoint = null) {
        public override string ToString() => "DebugTransportEvent.RequestProvenance";
    }
    internal static RequestProvenance ReadXmlRequestId(string xml) {
        using var reader = XmlReader.Create(new StringReader(xml), new XmlReaderSettings {
            DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 1048576
        });
        var root = XDocument.Load(reader).Root ?? throw new DebugFailure("debug_event_decode_failed");
        var attribute = root.Attribute("requestId"); // exact original, unqualified native attribute
        return new(attribute?.Value, attribute != null, attribute == null,
            root.Name.LocalName == "ThreadEndEvent" ? root.Attribute("lastBreakpoint")?.Value : null);
    }
    internal static DebugTransportEvent FromXml(DebuggerEvent evt, RequestProvenance provenance) {
        if (provenance.Present && evt.ThreadData != null && (evt.ThreadData is not ServerThreadData thread || thread.RequestId != provenance.RawRequestId))
            throw new DebugFailure("debug_event_request_provenance_mismatch");
        return new(evt, provenance);
    }
#if ODC
    internal static DebugTransportEvent FromTyped(DebuggerEvent evt, OutSystems.DebuggerClient.Payloads.DebuggerEvent payload) {
        var requestId = payload.RequestId;
        var present = !string.IsNullOrEmpty(requestId);
        if (present && (requestId!.Length > 512 || requestId.Any(char.IsControl)))
            throw new DebugFailure("debug_event_request_provenance_mismatch");
        var provenance = new RequestProvenance(present ? requestId : null, present, !present,
            (payload as OutSystems.DebuggerClient.Payloads.ThreadEndEvent)?.LastBreakpoint);
        if (present && evt.ThreadData != null && (evt.ThreadData is not ServerThreadData thread || thread.RequestId != requestId))
            throw new DebugFailure("debug_event_request_provenance_mismatch");
        return new(evt, provenance);
    }
#endif
    // A native object after conversion cannot manufacture original request evidence.
    internal static DebugTransportEvent WithoutProvenance(DebuggerEvent evt) => new(evt, new(null, false, true));
}
