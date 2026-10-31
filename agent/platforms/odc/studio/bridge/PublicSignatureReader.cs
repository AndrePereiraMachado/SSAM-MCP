using OutSystems.Model.Implementation.Oml;

// The one reader of a public module signature. The kernel compiles this file (OdcPublicSignature) and the ODC bridge links it
// (platforms/odc/studio/bridge/Bridge.csproj), so the two can never read a signature differently, as v97 to v101 did: their copy knew
// no service action and SSAM called 20 published ones "not published" (the gate of 2026-10-30). Global namespace, internal, no type
// of the kernel: the bridge's DLL carries no kernel name (docs/O11-BRIDGE-FINA.md 6.5; platforms/odc/tests/public-signature-drift.test.mjs).
/// <summary>Reads the platform's public signature, including UI elements omitted by LoadModuleSignature's typed view.</summary>
internal static class PublicSignatureReader
{
    public sealed record Element(string Kind, string Name, string Key);
    /// <summary>An element the signature holds and SSAM cannot bind (a role, an event, a flow, an image...): named, never dropped.</summary>
    public sealed record Other(string Tag, string Name, string Key);
    public sealed record Catalog(Element[] Elements, Other[] Others);

    public static Catalog Read(byte[] bytes)
    {
        var xml = Oml.GetSignatureReader(bytes).ToXElement();
        if (xml.Name.LocalName != "Signature") throw new ArgumentException("Expected a public module signature");
        var result = new List<Element>();
        var others = new List<Other>();
        foreach (var entry in xml.Element("ElementSignatures")?.Elements("ElementSignature") ?? [])
        {
            var key = (string?)entry.Attribute("OriginalKey");
            foreach (var item in entry.Descendants())
            {
                if ((string?)item.Attribute("OriginalKey") != key) continue;
                var kind = item.Name.LocalName switch {
                    "ReferenceStructure" => "structure",
                    "NewRuntime.ReferenceWebBlock" => "block",
                    "ReferenceClientAction" => "client-action",
                    "ReferenceAction" => "action",
                    "ReferenceServiceAPIMethod" => "service-action",
                    "ReferenceEntity" => "entity",
                    _ => null
                };
                var name = (string?)item.Attribute("OriginalName") ?? (string?)item.Attribute("Name");
                if (string.IsNullOrWhiteSpace(name) || string.IsNullOrWhiteSpace(key)) continue;
                if (kind != null) result.Add(new Element(kind, name, key));
                else others.Add(new Other(item.Name.LocalName, name, key));
            }
        }
        return new Catalog(result.Distinct().ToArray(), others.Distinct().ToArray());
    }
}
