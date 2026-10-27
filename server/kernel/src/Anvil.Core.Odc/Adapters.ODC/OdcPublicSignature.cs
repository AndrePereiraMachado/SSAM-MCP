using OutSystems.Model.Implementation.Oml;

namespace Anvil.Core;

/// <summary>Reads the platform's public signature, including UI elements omitted by LoadModuleSignature's typed view.</summary>
public static class OdcPublicSignature
{
    public sealed record Element(string Kind, string Name, string Key);
    public sealed record Catalog(Element[] Elements);

    public static Catalog Read(byte[] bytes)
    {
        var xml = Oml.GetSignatureReader(bytes).ToXElement();
        if (xml.Name.LocalName != "Signature") throw new ArgumentException("Expected a public module signature");
        var result = new List<Element>();
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
                if (kind != null && !string.IsNullOrWhiteSpace(name) && !string.IsNullOrWhiteSpace(key))
                    result.Add(new Element(kind, name, key));
            }
        }
        return new Catalog(result.Distinct().ToArray());
    }
}
