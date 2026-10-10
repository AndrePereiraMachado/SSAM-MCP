using ServiceStudio.PluginAPI.Debugger;
using ServiceStudio.ServerCommunications.API;
using System.Text.Json.Serialization;
using System.Xml;
using System.Xml.Linq;

// Raw provenance must survive the native ServerThreadData constructor's ThreadId fallback.
// This envelope is transport-private; it is never a command result or receipt.
internal sealed class DebugTransportEvent(DebuggerEvent nativeEvent, DebugTransportEvent.RequestProvenance provenance) {
    [JsonIgnore] internal DebuggerEvent NativeEvent { get; } = nativeEvent;
    [JsonIgnore] internal string? RawRequestId { get; } = provenance.RawRequestId;
    internal bool RawRequestIdPresent { get; } = provenance.Present;
    internal bool RequestIdIsFallback { get; } = provenance.IsFallback;
    public override string ToString() => "DebugTransportEvent";
    internal sealed record RequestProvenance([property: JsonIgnore] string? RawRequestId, bool Present, bool IsFallback) {
        public override string ToString() => "DebugTransportEvent.RequestProvenance";
    }
    internal static RequestProvenance ReadXmlRequestId(string xml) {
        using var reader = XmlReader.Create(new StringReader(xml), new XmlReaderSettings {
            DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 1048576
        });
        var root = XDocument.Load(reader).Root ?? throw new DebugFailure("debug_event_decode_failed");
        var attribute = root.Attribute("requestId"); // exact original, unqualified native attribute
        return new(attribute?.Value, attribute != null, attribute == null);
    }
    internal static DebugTransportEvent FromXml(DebuggerEvent evt, RequestProvenance provenance) {
        if (provenance.Present && evt.ThreadData != null && (evt.ThreadData is not ServerThreadData thread || thread.RequestId != provenance.RawRequestId))
            throw new DebugFailure("debug_event_request_provenance_mismatch");
        return new(evt, provenance);
    }
    // ODC typed payload provenance is not qualified here. Legacy operation remains available,
    // but a native object after conversion cannot manufacture original request evidence.
    internal static DebugTransportEvent WithoutProvenance(DebuggerEvent evt) => new(evt, new(null, false, true));
}
