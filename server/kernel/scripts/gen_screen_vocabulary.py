"""Freeze the installed Model API widget vocabulary; runtime contracts cannot add types/properties."""
import hashlib
import json
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]

def generate(catalog):
    by = {i["Name"]: i for i in catalog["Interfaces"]}
    enums = {e["Namespace"]+"."+e["Name"]: e for e in catalog["Enums"]}
    enums.update({k: {"Values": v} for k, v in json.loads((ROOT/"catalog/ui-plugin-enums-11.55.73.json").read_text()).items()})
    result = {}
    abstract = {"IWidget", "IMobileWidget", "IWebWidget", "IIfBranchWidget", "IPlaceholderContentWidget"}
    roots = {"IMobileScreen", "IMobileBlock", "IWebScreen", "IWebBlock"}
    for full, interface in by.items():
        name = full.split(".")[-1]
        if name.endswith("Signature") or name in abstract: continue
        if "OutSystems.Model.UI.IWidget" not in interface["Bases"] and name not in roots: continue
        context = "mobile" if ".Mobile." in full or ".NRWidgets." in full else "web"
        inherited = [by[b] for b in interface["Bases"] if b in by] + [interface]
        # A read-only signature redeclaration must not hide the writable model property.
        # Both interfaces describe the same property (e.g. IBlock.StyleSheet).
        props = {}
        for base in inherited:
            for prop in base["Properties"]:
                previous = props.get(prop["Name"])
                if previous is None or prop["CanWrite"] or not previous["CanWrite"]:
                    props[prop["Name"]] = prop
        fields, slots, events = {}, {}, {}
        for key, prop in props.items():
            typ = prop["Type"]
            if key in {"Name", "Parent", "Children", "ObjectKey", "GlobalKey", "SourceBlock", "IsReferenced", "EffectiveName"}: continue
            if typ.endswith("IExpression"): fields[key] = {"kind": "expression"}
            elif prop["CanWrite"]:
                if typ == "String": fields[key] = {"kind": "text"}
                elif typ == "Boolean": fields[key] = {"kind": "boolean"}
                elif typ in {"Int32", "Nullable<Int32>"}: fields[key] = {"kind": "integer", "nullable": typ.startswith("Nullable")}
                elif typ in enums: fields[key] = {"kind": "enum", "values": [v["Name"] if isinstance(v, dict) else v for v in enums[typ]["Values"]]}
                elif typ.startswith(("OutSystems.Model.", "ServiceStudio.Plugin.")) and "<" not in typ: fields[key] = {"kind": "reference", "type": typ}
            elif typ in by:
                if ".Events." in typ: events[key] = typ
                elif any(b.split(".")[-1] in {"IWidget", "IWidgetSignature", "IContent", "IContentSignature"} for b in by[typ]["Bases"]) or typ.split(".")[-1] in {"IContent", "IContentSignature"}:
                    slots[key] = typ
        result[context+":"+name] = {"type": full, "context": context, "root": name in roots, "named": "Name" in props, "attributes": "ExtendedProperties" in props, "properties": fields, "children": any(k in props for k in ("Widgets", "Rows", "Cells")), "slots": slots, "events": events}
    return result

if __name__ == "__main__":
    catalog = json.loads((ROOT/"catalog/model-api-11.55.69.json").read_text())
    output = ROOT/"src/Anvil.Core/Kernel/ScreenVocabulary.json"
    output.write_text(json.dumps(generate(catalog), indent=2)+"\n", encoding="utf-8")
    print(len(generate(catalog)), "root/widget shapes ->", output)
