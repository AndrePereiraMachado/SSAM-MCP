using System.Text.Json;
using System.Text.Json.Nodes;

namespace Anvil.Core;

/// <summary>The kernel's face of the one signature reader (PublicSignatureReader.cs, which the ODC bridge links too).</summary>
public static class OdcPublicSignature
{
    public sealed record Element(string Kind, string Name, string Key);
    /// <summary>An element the signature holds and SSAM cannot bind: named, never dropped.</summary>
    public sealed record Other(string Tag, string Name, string Key);
    public sealed record Catalog(Element[] Elements, Other[] Others);

    public static Catalog Read(byte[] bytes)
    {
        var read = PublicSignatureReader.Read(bytes);
        return new Catalog(read.Elements.Select(e => new Element(e.Kind, e.Name, e.Key)).ToArray(), read.Others.Select(o => new Other(o.Tag, o.Name, o.Key)).ToArray());
    }

    /// <summary>What a capture (.avsig) holds, from its own bytes: `anvil-odc signature-elements`. The envelope's list is what the
    /// bridge that wrote it knew, so nothing here reads it. A file that is no capture is refused.</summary>
    public static JsonObject ReadCapture(string avsig)
    {
        using var capture = JsonDocument.Parse(File.ReadAllText(avsig).TrimStart('﻿'));
        var root = capture.RootElement;
        if (!root.TryGetProperty("SignatureBinary", out var binary) || binary.ValueKind != JsonValueKind.String)
            throw new ArgumentException("Not a producer signature capture: no SignatureBinary");
        var read = Read(binary.GetBytesFromBase64());
        string? Text(string name) => root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
        return new JsonObject
        {
            ["schema"] = "ssam-signature-elements/1",
            ["producer"] = Text("Name"), ["moduleKey"] = Text("ModuleKey"), ["moduleKind"] = Text("ModuleKind"), ["revision"] = Text("Revision"), ["signatureHash"] = Text("SignatureHash"),
            ["elements"] = new JsonArray(read.Elements.Select(e => (JsonNode)new JsonObject { ["kind"] = e.Kind, ["name"] = e.Name, ["key"] = e.Key }).ToArray()),
            ["others"] = new JsonArray(read.Others.Select(o => (JsonNode)new JsonObject { ["tag"] = o.Tag, ["name"] = o.Name, ["key"] = o.Key }).ToArray()),
        };
    }

    // Every read of a capture on this lane takes its elements from the bytes (NativeReferenceSnapshot.Read), whatever bridge wrote it.
    // Set when the Studio's assemblies are bound (StudioAssembliesOdc.Bind): the snapshot's type needs them.
    internal static void UseForCaptures() =>
        NativeReferenceSnapshot.ElementsOfSignature = bytes => Read(bytes).Elements.Select(e => new NativeReferenceElement(e.Kind, e.Name, e.Key)).ToArray();
}
