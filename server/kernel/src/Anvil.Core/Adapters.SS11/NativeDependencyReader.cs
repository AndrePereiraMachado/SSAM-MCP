using System.Security.Cryptography;
using System.Xml.Linq;
using OutSystems.MetaModel.CompoundKeys;
using OutSystems.Model.Implementation;
using OutSystems.Model.Implementation.Oml;
using OutSystems.Model.Implementation.Oml.Signatures;
using OutSystems.ObjectKeys;
using ServiceStudio.Model;

namespace Anvil.Core;

/// <summary>One element of a producer signature, named as a job names it (Type = interface, Kind = envelope kind).</summary>
public sealed record NativeSignatureElement(string Type, string Kind, string Name, string OriginalKey, bool Hidden,
    string? ParentKey = null, string? Path = null);

/// <summary>Requested elements, their same-producer type closure (Requires: element key -> closure keys), keys owned
/// by other producers (Foreign), same-producer keys absent from the payload (Unresolved) and, when existing imports are
/// validated, the existing exports the producer no longer publishes (Absent).</summary>
public sealed record NativeSignatureResolution(string ProducerKey, int ElementSignatures,
    IReadOnlyList<NativeSignatureElement> Elements, IReadOnlyList<NativeSignatureElement> Closure,
    IReadOnlyDictionary<string, string[]> Requires, IReadOnlyList<string> Foreign, IReadOnlyList<string> Unresolved,
    IReadOnlyList<string>? Absent = null);

/// <summary>Reads frozen producer OML bytes without creating a module model. Native OML identity
/// and the exact file hash must agree with the controller's expected immutable descriptor.
/// A signature-only envelope cannot independently attest producer identity and is rejected.
/// Environment and published version remain controller attestations, not observations of a server.</summary>
public static class NativeDependencyReader
{
    /// <summary>Validated visible producer elements for a Manage Dependencies picker. Unknown
    /// signature tags remain explicit instead of being advertised as importable.</summary>
    public static IReadOnlyList<NativeSignatureElement> ListServerSignature(string producerKey,string producerName,byte[] binary,Guid? expectedHash=null)
    {
        var signature=ReadServerSignature(binary);
        if(signature.Name!="Signature" || signature.Element("ElementSignatures")==null)
            throw Error("Producer signature payload is not a complete public signature: "+producerName);
        if(signature.Element("ServiceStudioData")?.Element("TopLevelReferenceableElementsWithInvalidSignature")?.Elements().Any()==true)
            throw Error("Producer signature payload contains invalid cached signatures: "+producerName);
        if(expectedHash is { } hash && OmlAttrParser.GetGuid(SignatureHasher.CalculateHash(signature))!=hash)
            throw Error("Producer signature payload hash differs: "+producerName);
        var descriptor=new NativeDependencyProducer(producerName,"",Keys.ToStudio(producerKey),producerName,"","",0,"","");
        var index=new Index([new ProducerFile(descriptor,"",signature)]);
        return index.VisibleElements();
    }
    public static NativeDependencyCatalog Read(IReadOnlyList<NativeDependencyRequirement> requirements,
        IReadOnlyList<NativeDependencyProducer> producers, IReadOnlyDictionary<string, string> signaturePaths)
    {
        ArgumentNullException.ThrowIfNull(requirements); ArgumentNullException.ThrowIfNull(producers);
        ArgumentNullException.ThrowIfNull(signaturePaths);
        // Validate/freeze the caller's descriptors before reading any signature. No filename is identity.
        var frozen = new NativeDependencyCatalog(producers.Select(p => p with { ProducerKey = Keys.ToStudio(p.ProducerKey) }), []);
        var requests = requirements.Select(r => r with { }).ToArray();
        if (requests.Any(r => string.IsNullOrWhiteSpace(r.SourceSymbol)) || requests.Select(r => r.SourceSymbol).Distinct(StringComparer.Ordinal).Count() != requests.Length)
            throw Error("Source requirements must have unique qualified symbols");
        var paths = signaturePaths.ToDictionary(p => p.Key, p => Path.GetFullPath(p.Value), StringComparer.Ordinal);
        if (paths.Count != frozen.Producers.Count || frozen.Producers.Any(p => !paths.ContainsKey(p.Binding)))
            throw Error("signaturePaths must contain exactly one frozen OML per producer binding");
        var files = frozen.Producers.Select(p => ReadProducer(p, paths[p.Binding])).ToArray();
        var index = new Index(files);
        var bindings = requests.Select(index.Bind).ToArray();
        var catalog = new NativeDependencyCatalog(frozen.Producers, bindings);
        // A concurrently changed file cannot produce an apparently current successful read.
        foreach (var file in files)
            if (!Hash(File.ReadAllBytes(file.Path)).Equals(file.Producer.SignatureFileSha256, StringComparison.OrdinalIgnoreCase))
                throw Error("Frozen producer OML changed while being read: " + file.Producer.Binding);
        return catalog;
    }

    /// <summary>Structural resolution of a producer signature payload as the server returns it (ReferenceInfo.SignatureBinary,
    /// the FastInfoset signature document) against Tipo:Nome requests, plus the same producer's type closure.
    /// This is NOT an identity attestation: the payload names no producer, which is why <see cref="Read"/> keeps
    /// rejecting signature-only envelopes. Identity (environment, producer key, SignatureHash, VersionId) is observed by
    /// the read-only capture that fetched these bytes and re-observed by the delivery; the caller supplies that key.</summary>
    public static NativeSignatureResolution ResolveServerSignature(string producerKey, string producerName, byte[] signatureBinary,
        IReadOnlyList<string> typedNames)
        => ResolveServerSignatureCore(producerKey, producerName, signatureBinary, typedNames, existing: false);

    // Existing native imports can contain hidden ABI dependencies. This validation never selects a new export;
    // ReferenceRefresher separately validates the requested public roots before calling it for existing identities.
    // An existing export the producer no longer publishes (removed, re-keyed or now of another kind) has nothing to
    // validate: it is reported in Absent and the native refresh drops or flags it, as Manage Dependencies does.
    internal static NativeSignatureResolution ValidateExistingServerImports(string producerKey, string producerName, byte[] signatureBinary,
        IReadOnlyList<string> typedOriginalKeys)
    {
        if (typedOriginalKeys.Any(name => name.Split(':', 2) is not [_, var key] || !key.StartsWith('@')))
            throw Error("Existing native imports require original keys");
        return ResolveServerSignatureCore(producerKey, producerName, signatureBinary, typedOriginalKeys, existing: true);
    }

    private static NativeSignatureResolution ResolveServerSignatureCore(string producerKey, string producerName, byte[] signatureBinary,
        IReadOnlyList<string> typedNames, bool existing)
    {
        ArgumentNullException.ThrowIfNull(signatureBinary); ArgumentNullException.ThrowIfNull(typedNames);
        if (signatureBinary.Length == 0) throw Error("Empty producer signature payload: " + producerName);
        var signature = ReadServerSignature(signatureBinary);
        if (signature.Name != "Signature" || signature.Element("ElementSignatures") == null)
            throw Error("Producer signature payload is not a complete public signature: " + producerName);
        if (signature.Element("ServiceStudioData")?.Element("TopLevelReferenceableElementsWithInvalidSignature")?.Elements().Any() == true)
            throw Error("Producer signature payload contains invalid cached signatures: " + producerName);
        var descriptor = new NativeDependencyProducer(producerName, "", Keys.ToStudio(producerKey), producerName, "", "", 0, "", "");
        var index = new Index([new ProducerFile(descriptor, "", signature)], validateWholePayload: typedNames.Count == 0);
        var requested = new List<NativeSignatureElement>(); var closure = new Dictionary<string, NativeSignatureElement>(StringComparer.Ordinal);
        var requires = new Dictionary<string, string[]>(StringComparer.Ordinal);
        var foreign = new SortedSet<string>(StringComparer.Ordinal); var unresolved = new SortedSet<string>(StringComparer.Ordinal);
        var absent = new List<string>();
        var missing = new List<System.Text.Json.Nodes.JsonObject>();
        if (typedNames.Count == 0) index.ValidateAllDependencies(foreign, unresolved);
        foreach (var typed in typedNames.Distinct(StringComparer.Ordinal))
        {
            var parts = typed.Split(':', 2);
            var kind = parts.Length == 2 ? NativeReferenceSnapshot.KindOf(parts[0]) : null;
            if (kind == null || string.IsNullOrWhiteSpace(parts[1])) throw Error("Expected Tipo:Nome with a supported producer element type: " + typed);
            var element = index.FindTop(SignatureTag(kind), parts[1], includeHidden: existing);
            if (element == null && existing) { absent.Add(typed); continue; }
            // A25: every requested element the signature does not show, all at once, each with its cause and fix.
            if (element == null) { missing.Add(Missing(index, typed, kind, parts[1], producerName)); continue; }
            var described = Describe(element, kind);
            requested.Add(described);
            var dependencies = index.DependencyClosure(element, foreign, unresolved).ToList();
            requires[described.OriginalKey] = dependencies.Select(d => d.Key).ToArray();
            foreach (var dependency in dependencies)
                if (dependency.Key != described.OriginalKey)
                    closure.TryAdd(dependency.Key, Describe(dependency, NativeReferenceKinds.ForTag(dependency.Tag)?.Kind
                        ?? throw Error("Unsupported closure element: " + dependency.Tag)));
        }
        if (missing.Count > 0) throw Preflight.ProducerSignatureMissing.Refusal(producerName, missing);
        return new(Keys.ToStudio(producerKey), signature.Element("ElementSignatures")!.Elements().Count(), requested,
            closure.Values.Where(c => requested.All(r => r.OriginalKey != c.OriginalKey)).ToArray(), requires, foreign.ToArray(), unresolved.ToArray(),
            existing ? absent : null);
        NativeSignatureElement Describe(Element element, string kind)
            => new(NativeReferenceSnapshot.InterfaceOf(kind), kind, element.Name, element.Key, element.Signature.Hidden,
                element.Signature.ParentOriginalKey?.ToString(), index.QualifiedName(element));
    }

    private static string SignatureTag(string kind) => NativeReferenceKinds.ForKind(kind).Tag;

    /// <summary>The problem of one requested element the published signature does not show (A25, I6 cause): `private` when
    /// the payload has it only as a hidden dependency of a public element (it exists, without Public); `absent` otherwise,
    /// with the element of the same name and another kind, or the closest names, as the fix.</summary>
    private static System.Text.Json.Nodes.JsonObject Missing(Index index, string typed, string kind, string name, string producer)
    {
        var type = typed.Split(':', 2)[0];
        if (index.FindTop(SignatureTag(kind), name, includeHidden: true) != null)
            return Preflight.ProducerSignatureMissing.Problem(typed, producer, "private",
                $"{typed} is not a visible element of the {producer} signature: the published {producer} has it only as a hidden dependency (it is not Public)",
                $"make {name} Public in {producer} (spec \"public\": true, or set Public true), publish {producer}, then deliver again; or use the public element of {producer} that exposes it");
        var visible = index.VisibleElements();
        var other = visible.Where(e => string.Equals(e.Name, name, StringComparison.OrdinalIgnoreCase) || string.Equals(e.Path, name, StringComparison.OrdinalIgnoreCase)).ToArray();
        var similar = NameSuggestions.Closest(name, visible.Where(e => e.Kind == kind).Select(e => e.Path ?? e.Name));
        var fix = other.Length > 0 ? $"use {string.Join(" or ", other.Select(e => e.Type + ":" + (e.Path ?? e.Name)))} (the kind {type} has no {name} in {producer})"
            : (similar.Count > 0 ? $"use one of: {string.Join(", ", similar.Select(n => type + ":" + n))}; " : "")
              + $"if {name} was added or made Public in {producer} after its last publication, publish {producer} first (o11_dependencies list shows what it publishes)";
        return Preflight.ProducerSignatureMissing.Problem(typed, producer, "absent", $"{typed} is not a visible element of the {producer} signature", fix);
    }

    // An element's FullSignatureHash covers its children in the producer's own order. GetSignatureReader re-sorts a payload of
    // an older ElementsOrderVersion (Users, OutSystems UI) into the current order, after which those hashes no longer recompute;
    // the payload is read exactly as the producer published it.
    private static XElement ReadServerSignature(byte[] binary)
    {
        using var reader = Oml.CreateXmlReader(new MemoryStream(binary, writable: false));
        return XElement.Load(reader);
    }

    private sealed record ProducerFile(NativeDependencyProducer Producer, string Path, XElement Signature);
    private static ProducerFile ReadProducer(NativeDependencyProducer expected, string path)
    {
        var bytes = File.ReadAllBytes(path);
        if (!Hash(bytes).Equals(expected.SignatureFileSha256, StringComparison.OrdinalIgnoreCase))
            throw Error("Frozen producer OML SHA-256 differs: " + expected.Binding);
        if (!bytes.AsSpan().StartsWith(Oml.Signature))
            throw Error("missing-native-producer-evidence: frozen producer OML bytes are required for " + expected.Binding
                + "; avsig/signature-only headers do not independently prove producer key/name/type");
        var header = Oml.GetOmlHeader(bytes);
        if (header.Key.ToString() != expected.ProducerKey || header.Name != expected.ProducerName)
            throw Error("Frozen producer key/name differs from native OML header: " + expected.Binding);
        if (expected.ReferenceKind != "eSpace" || header.ESpaceType.ToString() != expected.ModuleType)
            throw Error("Frozen producer reference kind/module type differs from native OML header: " + expected.Binding);
        // Parse the frozen container without upgrades, model creation or signature regeneration.
        // Encrypted/incompatible containers fail; no secret is obtained or guessed here.
#pragma warning disable CS0612, CS0618
        using var oml = Oml.LoadWithoutUpgrades(bytes, "");
#pragma warning restore CS0612, CS0618
        return ValidateSignature(expected, path, oml.GetSignature());
    }

    // Structural validation only. Callers enter through ReadProducer, which first verifies the
    // exact OML bytes and native producer identity. This private parser is not an attestation API.
    private static ProducerFile ValidateSignature(NativeDependencyProducer expected, string path, XElement signature)
    {
        var expectedHash = Guid.Parse(expected.SignatureHash);
        if (signature.Name != "Signature" || signature.Element("ElementSignatures") == null)
            throw Error("Native payload is not a complete public signature: " + expected.Binding);
        if (signature.Element("ServiceStudioData")?.Element("TopLevelReferenceableElementsWithInvalidSignature")?.Elements().Any() == true)
            throw Error("Native producer contains invalid cached signatures; acquire a current frozen signature: " + expected.Binding);
        if (OmlAttrParser.GetGuid(SignatureHasher.CalculateHash(signature)) != expectedHash)
            throw Error("Native signature payload hash differs: " + expected.Binding);
        var moduleType = (string?)signature.Attribute("ESpaceType");
        if (!string.IsNullOrEmpty(moduleType) && OmlAttrParser.ParseSegmentationKind(moduleType).ToString() != expected.ModuleType)
            throw Error("Native payload module type differs: " + expected.Binding);
        return new(expected, path, signature);
    }

    private sealed record Element(ProducerFile File, FullElementSignature Signature)
    {
        public XElement Xml => Signature.FullSignature;
        public string Tag => Xml.Name.LocalName;
        public string Key => Signature.OriginalKey.ToString();
        public string GlobalKey => new GlobalObjectKey(Keys.Parse(File.Producer.ProducerKey), Signature.OriginalKey).ToString();
        public string Name => Required(Xml, "OriginalName");
        public string Reference => NativeInterface(Tag) + ":@" + File.Producer.ProducerKey + "/" + Key;
    }

    private sealed class Index
    {
        private readonly ProducerFile[] files;
        private readonly Dictionary<string, Element> elements = new(StringComparer.Ordinal);
        // Lists and anonymous structures (the payload's own types under the native anonymous root), keyed by NewKey(UniqueId).
        private readonly Dictionary<string, Element> anonymousTypes = new(StringComparer.Ordinal);
        private readonly Dictionary<string, NativeRecordDefinition> records = new(StringComparer.Ordinal);
        private readonly HashSet<string> originalIdentities = new(StringComparer.Ordinal);
        private readonly HashSet<string> recordPending = new(StringComparer.Ordinal);
        private readonly HashSet<Element> validatedHashes = [];
        public Index(ProducerFile[] files) : this(files, validateWholePayload: true) { }
        public Index(ProducerFile[] files, bool validateWholePayload)
        {
            this.files = files;
            foreach (var file in files)
            foreach (var wrapper in file.Signature.Element("ElementSignatures")!.Elements())
            {
                if (wrapper.Name != "ElementSignature" || wrapper.Elements().Count() != 1)
                    throw Error("Malformed native element signature in " + file.Producer.Binding);
                using var reader = new XElementReader(new XElement(wrapper).CreateReader());
                var signature = new FullElementSignature(reader);
                var element = new Element(file, signature);
                if (!originalIdentities.Add(element.GlobalKey))
                    throw Error("Duplicate native element identity: " + element.GlobalKey);
                if (validateWholePayload) ValidateHash(element);
                if (element.Tag is "ListType" or "AnonymousStructure")
                {
                    var uniqueId = OmlAttrParser.GetGuid(Required(element.Xml, "UniqueId"));
                    if (uniqueId == Guid.Empty || !anonymousTypes.TryAdd(file.Producer.ProducerKey + "/" + ObjectKey.NewKey(uniqueId), element))
                        throw Error("Ambiguous native anonymous type identity: " + file.Producer.Binding);
                }
                else if (!elements.TryAdd(element.GlobalKey, element))
                    throw Error("Duplicate native element identity: " + element.GlobalKey);
            }
        }

        private void ValidateHash(Element element)
        {
            if (validatedHashes.Contains(element)) return;
            var signature = element.Signature;
            if (signature.FullSignatureHash == Guid.Empty)
                throw Error("Native element payload hash omitted: " + signature.OriginalKey);
            var computed = new FullElementSignature(signature.OriginalKey, signature.FullSignature, signature.ExternalDependencies,
                signature.FullSignature, signature.Hidden, signature.ParentOriginalKey);
            if (computed.FullSignatureHash != signature.FullSignatureHash)
                throw Error("Native element payload hash differs: " + signature.OriginalKey);
            validatedHashes.Add(element);
        }

        public NativeDependencyBinding Bind(NativeDependencyRequirement requirement)
        {
            var file = files.SingleOrDefault(p => p.Producer.ProducerName == requirement.ProducerName)
                ?? throw Error("Missing frozen producer for " + requirement.SourceSymbol + ": " + requirement.ProducerName);
            var matches = elements.Values.Where(e => e.File == file && !e.Signature.Hidden
                && Kind(e.Tag) == requirement.Kind && OriginalPath(e) == requirement.OriginalElementPath).ToArray();
            if (matches.Length != 1) throw Error("Original native export must resolve exactly once: " + requirement.ProducerName + "/" + requirement.OriginalElementPath);
            var element = matches[0];
            var inputs = Parameters(element, "InputParameters", true);
            var outputs = Parameters(element, "OutputParameters", false);
            var events = requirement.Kind == NativeDependencyKind.Block
                ? Collection(element.Xml, "CustomEvents").Select(e => e.Name == "ReferenceWebBlockCustomEvent"
                    ? new NativeEvent(Required(e, "Name"), OriginalKey(e), Mandatory(e), Parameters(element, e, "InputParameters", true))
                    : throw Error("Unsupported native event signature: " + e.Name)).ToArray() : [];
            var placeholders = requirement.Kind == NativeDependencyKind.Block
                ? Collection(element.Xml, "ReferenceWidgets").SelectMany(w => w.DescendantsAndSelf())
                    .Where(w => w.Name.LocalName is "NRWebWidgets.ReferencePlaceholder" or "WebWidgets.ReferencePlaceholder")
                    .Select(w => new NativePlaceholder(Required(w, "Name"), OriginalKey(w))).ToArray() : [];
            var closure = new Dictionary<string, NativeRecordDefinition>(StringComparer.Ordinal);
            void Visit(NativeType type)
            {
                switch (type)
                {
                    case NativeList list: Visit(list.Element); break;
                    case NativeRecord record: Add(record.GlobalKey); break;
                    case NativeIdentifier id: Add(id.TargetGlobalKey); break;
                }
            }
            void Add(string key)
            {
                if (closure.ContainsKey(key)) return;
                var definition = Record(key); closure.Add(key, definition);
                foreach (var field in definition.OrderedFields) Visit(field.Type);
            }
            foreach (var p in inputs.Concat(outputs).Concat(events.SelectMany(e => e.OrderedInputs))) Visit(p.Type);
            if (requirement.Kind == NativeDependencyKind.Type) Add(element.GlobalKey);
            // Public signature dependencies also include non-type signatures required by reference import.
            // Verify the entire reachable closure exists, without polluting the catalog's type-only closure.
            ValidateExternal(element, new HashSet<string>(StringComparer.Ordinal));
            return new(requirement, file.Producer.Binding, element.Key, element.Reference, inputs, outputs, closure, events, placeholders);
        }

        /// <summary>The single visible top-level element with this signature tag and original name, or null.</summary>
        public Element? FindTop(string tag, string name, bool includeHidden = false)
        {
            var matches = elements.Values.Where(e => e.Tag == tag && (includeHidden || !e.Signature.Hidden)
                && (e.Name == name || QualifiedName(e) == name || "@"+e.Key == name)).ToArray();
            return matches.Length switch {
                0 => null, 1 => matches[0],
                _ => throw Error("Producer signature has more than one " + tag + " named " + name + "; use Flow/Name or @originalKey")
            };
        }

        public string QualifiedName(Element element) => element.Signature.ParentOriginalKey is { } parent
            ? Find(new GlobalObjectKey(Keys.Parse(element.File.Producer.ProducerKey),parent).ToString()).Name+"/"+element.Name
            : element.Name;

        public IReadOnlyList<NativeSignatureElement> VisibleElements() => elements.Values.Where(e=>!e.Signature.Hidden)
            .Select(e=>NativeReferenceKinds.ForTag(e.Tag) is { } family
                ? new NativeSignatureElement(family.Interface,family.Kind,e.Name,e.Key,false,
                    e.Signature.ParentOriginalKey?.ToString(),QualifiedName(e))
                : new NativeSignatureElement(e.Tag,"unsupported",(string?)e.Xml.Attribute("OriginalName") ?? e.Key,e.Key,false))
            .OrderBy(e=>e.Type,StringComparer.Ordinal).ThenBy(e=>e.Path,StringComparer.Ordinal).ToArray();

        /// <summary>Validate the exact selected export and its complete same-producer native closure before import.
        /// Unselected exports still participate in identity/deduplication, but do not become importable evidence.
        /// Keys owned by another producer are reported, never guessed.</summary>
        public IReadOnlyList<Element> DependencyClosure(Element root, ISet<string> foreign, ISet<string> unresolved)
        {
            var result = new List<Element>(); var visited = new HashSet<string>(StringComparer.Ordinal) { root.GlobalKey };
            var pending = new Stack<Element>(); pending.Push(root);
            var producerKey = Keys.Parse(root.File.Producer.ProducerKey);
            while (pending.Count > 0)
            {
                var current = pending.Pop();
                ValidateHash(current);
                if (current.Signature.ParentOriginalKey is { } parentKey)
                {
                    var parent = Find(new GlobalObjectKey(producerKey, parentKey).ToString());
                    if (parent.Tag is not ("ReferenceWebFlow" or "NewRuntime.ReferenceWebFlow"))
                        throw Error("Unsupported signature parent: " + parent.Tag);
                    Add(parent);
                }
                foreach (var target in TypeTargets(current, 0, Walk).Concat(current.Signature.ExternalDependencies ?? []))
                {
                    if (target.OwnerKey == FixedKeys.Key_AnonymousTypesRootESpace)
                    {
                        // The anonymous root also cites platform types (Text for a Text List) that never travel in a producer
                        // payload; every list or anonymous structure the element's types use is resolved and checked by TypeTargets.
                        if (anonymousTypes.TryGetValue(current.File.Producer.ProducerKey + "/" + target.Key, out var anonymous)) Walk(anonymous);
                        continue;
                    }
                    if (!target.OwnerKey.Equals(producerKey)) { foreign.Add(target.ToString()); continue; }
                    if (!elements.TryGetValue(target.ToString(), out var found)) { unresolved.Add(target.ToString()); continue; }
                    // A model folder only groups exports: validated with the closure, never imported as one of its elements.
                    if (found.Tag == "ReferenceModelFolder") Walk(found); else Add(found);
                }
            }
            return result;
            void Add(Element element) { if (!visited.Add(element.GlobalKey)) return; result.Add(element); pending.Push(element); }
            void Walk(Element element) { if (visited.Add(element.GlobalKey)) pending.Push(element); }
        }

        public void ValidateAllDependencies(ISet<string> foreign, ISet<string> unresolved)
        {
            foreach (var element in elements.Values.Concat(anonymousTypes.Values)) DependencyClosure(element, foreign, unresolved);
        }

        private IEnumerable<GlobalObjectKey> TypeTargets(Element owner, int depth, Action<Element> anonymousVisited)
        {
            if (depth > 64) throw Error("Native type nesting exceeds 64 levels");
            foreach (var attribute in owner.Xml.DescendantsAndSelf().Attributes().Where(TypePosition))
            {
                var parsed = ParseReference(attribute.Value);
                if (parsed.SystemKey != null) continue;
                if (parsed.Key == null) throw Error("Empty native type reference");
                // A list or an anonymous structure (an extension's record, Users' User_Create input) travels in the same
                // payload: it is hash-validated with the closure and its own types are followed, never imported as an export.
                if (parsed.Tag is "ListType" or "AnonymousStructure")
                {
                    var what = parsed.Tag == "ListType" ? "list" : "anonymous structure";
                    if (parsed.Key.Parent != null || parsed.Key.ReferenceCollectionIndex.ToString() != (parsed.Tag == "ListType" ? "ListTypes" : "AnonymousStructures"))
                        throw Error("Unsupported qualified native " + what + " identity: " + attribute.Value);
                    if (!anonymousTypes.TryGetValue(owner.File.Producer.ProducerKey + "/" + parsed.Key.GetObjectKey(), out var anonymous) || anonymous.Tag != parsed.Tag)
                        throw Error("Missing native " + what + " signature: " + attribute.Value);
                    anonymousVisited(anonymous);
                    foreach (var inner in TypeTargets(anonymous, depth + 1, anonymousVisited)) yield return inner;
                    continue;
                }
                if (parsed.Tag == "EntityIdentifierType")
                {
                    if (parsed.Key.Parent == null || parsed.Key.ReferenceCollectionIndex.ToString() != "IdentifierType")
                        throw Error("Native identifier lacks entity identity: " + attribute.Value);
                    yield return parsed.Key.Parent.GetGlobalObjectKey();
                }
                else if (parsed.Tag is "ReferenceStructure" or "Structure" or "ReferenceEntity" or "Entity") yield return parsed.Key.GetGlobalObjectKey();
                else throw Error("Unsupported native type signature: " + attribute.Value);
            }
        }

        private string OriginalPath(Element element)
        {
            if (Kind(element.Tag) != NativeDependencyKind.Block) return element.Name;
            var parent = element.Signature.ParentOriginalKey ?? throw Error("Block signature is missing its original flow: " + element.Key);
            var flow = Find(new GlobalObjectKey(Keys.Parse(element.File.Producer.ProducerKey), parent).ToString());
            if (flow.Tag is not ("ReferenceWebFlow" or "NewRuntime.ReferenceWebFlow")) throw Error("Block parent is not an original native flow");
            return flow.Name + "/" + element.Name;
        }

        private NativeParameter[] Parameters(Element owner, string collection, bool input) => Parameters(owner, owner.Xml, collection, input);
        private NativeParameter[] Parameters(Element owner, XElement parent, string collection, bool input)
            => Collection(parent, collection).Select(p => {
                var allowed = input ? p.Name.LocalName is "Variables.ReferenceGenericInputParameter" or "Variables.ReferenceSerializableInputParameter" or "Variables.WebReferenceGenericInputParameter"
                    : p.Name.LocalName is "Variables.ReferenceGenericOutputParameter" or "Variables.ReferenceSerializableOutputParameter" or "Variables.WebReferenceGenericOutputParameter";
                if (!allowed) throw Error("Unsupported native parameter signature: " + p.Name);
                return new NativeParameter(Required(p, "Name"), Type(owner, Required(p, "Type"), 0), input && Mandatory(p), Default(p), OriginalKey(p));
            }).ToArray();

        private NativeType Type(Element owner, string reference, int depth)
        {
            if (depth > 64) throw Error("Native type nesting exceeds 64 levels");
            var parsed = ParseReference(reference);
            if (parsed.SystemKey != null)
                return new NativePrimitive(Primitive(parsed.SystemKey) ?? throw Error("Unsupported native system type: " + reference));
            var key = parsed.Key ?? throw Error("Empty native type reference");
            if (parsed.Tag == "ListType")
            {
                if (key.Parent != null || key.ReferenceCollectionIndex.ToString() != "ListTypes")
                    throw Error("Unsupported qualified native list identity: " + reference);
                var id = key.GetObjectKey().ToString();
                if (!anonymousTypes.TryGetValue(owner.File.Producer.ProducerKey + "/" + id, out var list) || list.Tag != "ListType")
                    throw Error("Missing native list signature (no generated replacement): " + reference);
                return new NativeList(Type(list, Required(list.Xml, "ElementType"), depth + 1));
            }
            if (parsed.Tag == "EntityIdentifierType")
            {
                if (key.Parent == null || key.ReferenceCollectionIndex.ToString() != "IdentifierType")
                    throw Error("Native identifier lacks entity identity: " + reference);
                var entityKey = key.Parent.GetGlobalObjectKey().ToString();
                return new NativeIdentifier(entityKey, IdentifierStorage(Find(entityKey)));
            }
            if (parsed.Tag is "ReferenceStructure" or "Structure" or "ReferenceEntity" or "Entity")
            {
                var target = Find(key.GetGlobalObjectKey().ToString());
                if (Kind(target.Tag) != NativeDependencyKind.Type || (parsed.Tag.Contains("Entity", StringComparison.Ordinal) != (target.Tag == "ReferenceEntity")))
                    throw Error("Native type reference kind disagrees with its target: " + reference);
                return new NativeRecord(target.GlobalKey);
            }
            throw Error("Unsupported native type signature (no generated replacement): " + reference);
        }

        private NativeRecordDefinition Record(string key)
        {
            if (records.TryGetValue(key, out var cached)) return cached;
            var element = Find(key);
            if (element.Tag is not ("ReferenceStructure" or "ReferenceEntity")) throw Error("Native record target is not a named entity/structure: " + key);
            if (!recordPending.Add(key)) throw Error("Identifier storage cycle in native record: " + key);
            try
            {
                var fields = Collection(element.Xml, "Attributes").Select(f => {
                    if (f.Name.LocalName is not ("ReferenceStructureAttribute" or "ReferenceEntityAttribute")) throw Error("Unsupported native record field: " + f.Name);
                    return new NativeField(Required(f, "Name"), Type(element, Required(f, "Type"), 0), OriginalKey(f));
                }).ToArray();
                var result = new NativeRecordDefinition(key, element.Name, element.Tag == "ReferenceEntity" ? NativeRecordKind.Entity : NativeRecordKind.Structure,
                    element.Reference, fields, element.Tag == "ReferenceEntity" ? IdentifierStorage(element) : null);
                records.Add(key, result); return result;
            }
            finally { recordPending.Remove(key); }
        }

        private string IdentifierStorage(Element entity)
        {
            if (entity.Tag != "ReferenceEntity") throw Error("Identifier target is not an entity: " + entity.GlobalKey);
            var id = ParseReference(Required(entity.Xml, "Identifier"));
            if (id.Tag is not ("ReferenceEntityAttribute" or "EntityAttribute") || id.Key == null
                || id.Key.ReferenceCollectionIndex.ToString() != "Attributes" || id.Key.Parent?.GetGlobalObjectKey().ToString() != entity.GlobalKey)
                throw Error("Identifier attribute belongs to another native entity: " + entity.GlobalKey);
            var attr = Collection(entity.Xml, "Attributes").SingleOrDefault(f => OriginalKey(f) == id.Key.GetObjectKey().ToString())
                ?? throw Error("Identifier attribute is missing: " + entity.GlobalKey);
            var storage = ParseReference(Required(attr, "Type"));
            var primitive = storage.SystemKey == null ? null : Primitive(storage.SystemKey);
            return primitive is "Integer" or "Long Integer" or "Text" ? primitive
                : throw Error("Unsupported native identifier storage: " + entity.GlobalKey);
        }

        public Element Find(string key) => elements.TryGetValue(key, out var element) ? element
            : throw Error("Missing native dependency signature: " + key + "; supply the frozen producer/closure, not a replacement type");
        private void ValidateExternal(Element element, HashSet<string> visited)
        {
            if (!visited.Add(element.GlobalKey)) return;
            foreach (var key in element.Signature.ExternalDependencies ?? [])
            {
                // The native anonymous root holds this file's list types and platform types, not a server producer.
                // Lists are resolved where a parameter or field type uses them (Type, Record).
                if (key.OwnerKey == FixedKeys.Key_AnonymousTypesRootESpace) continue;
                ValidateExternal(Find(key.ToString()), visited);
            }
        }
    }

    // Type positions of a signature: parameters (an element's and its events'), record fields and the list item type.
    // Widgets and expressions carry Type attributes too, not all of them type references (an Edit Record cell has Type="Caption").
    private static bool TypePosition(XAttribute attribute)
    {
        var owner = attribute.Parent!.Name.LocalName;
        return attribute.Name.LocalName switch {
            "Type" => owner.StartsWith("Variables.", StringComparison.Ordinal) || owner is "ReferenceStructureAttribute" or "ReferenceEntityAttribute" or "AnonymousStructureAttribute",
            "ElementType" => owner == "ListType", _ => false
        };
    }

    private sealed record ParsedReference(string Tag, GlobalCompoundKey? Key, ObjectKey? SystemKey);
    private static ParsedReference ParseReference(string reference)
    {
        var parsed = OmlAttrParser.ParseReferenceKey(reference,
            text => new ParsedReference("", GlobalCompoundKey.Parse(text), null),
            compound => compound is SystemCompoundKey system ? new ParsedReference("", null, system.Key)
                : throw Error("Unsupported non-global native reference: " + reference), out var tag);
        return parsed == null ? throw Error("Empty native reference") : parsed with { Tag = tag };
    }
    private static string? Primitive(ObjectKey key)
    {
        if (key == FixedKeys.TextType) return "Text";
        if (key == FixedKeys.IntegerType) return "Integer";
        if (key == FixedKeys.LongIntegerType) return "Long Integer";
        if (key == FixedKeys.DecimalType) return "Decimal";
        if (key == FixedKeys.BooleanType) return "Boolean";
        if (key == FixedKeys.DateType) return "Date";
        if (key == FixedKeys.TimeType) return "Time";
        if (key == FixedKeys.DateTimeType) return "Date Time";
        if (key == FixedKeys.CurrencyType) return "Currency";
        if (key == FixedKeys.EmailType) return "Email";
        if (key == FixedKeys.PhoneNumberType) return "Phone Number";
        if (key == FixedKeys.BinaryDataType) return "Binary Data";
        if (key == FixedKeys.ObjectType) return "Object";
        return null;
    }
    private static IEnumerable<XElement> Collection(XElement parent, string name)
    {
        var collections = parent.Elements(name).ToArray();
        if (collections.Length > 1) throw Error("Duplicate native collection: " + name);
        if (collections.Length == 0) return [];
        var children = collections[0].Elements().ToArray();
        // Native sequence items carry Index (zero may be omitted); a legacy binary XML tree need
        // not be physically ordered. Non-sequence events preserve the signature's enumeration order.
        if (name is "InputParameters" or "OutputParameters" or "Attributes" or "ReferenceWidgets"
            && children.Any(e => e.Attribute("Index") != null))
            return children.OrderBy(e => int.Parse((string?)e.Attribute("Index") ?? "0", System.Globalization.CultureInfo.InvariantCulture));
        return children;
    }
    private static bool Mandatory(XElement element) => OmlAttrParser.GetBoolean((string?)element.Attribute("IsMandatory") ?? "");
    private static string OriginalKey(XElement element) => Keys.ToStudio(Required(element, "OriginalKey"));
    private static string? Default(XElement element)
    {
        var values = Collection(element, "DefaultValue").ToArray();
        if (values.Length == 0) return null;
        if (values.Length != 1 || values[0].Name != "ReferenceExpression") throw Error("Unsupported native default expression representation");
        return (string?)values[0].Attribute("Text") ?? "";
    }
    private static NativeDependencyKind? Kind(string tag) => tag switch {
        "ReferenceAction" => NativeDependencyKind.ServerAction, "ReferenceClientAction" => NativeDependencyKind.ClientAction,
        "ReferenceServiceAPIMethod" => NativeDependencyKind.ServiceAction,
        "ReferenceWebBlock" or "NewRuntime.ReferenceWebBlock" => NativeDependencyKind.Block,
        "ReferenceStructure" or "ReferenceEntity" => NativeDependencyKind.Type, _ => null
    };
    private static string NativeInterface(string tag) => tag switch {
        "ReferenceAction" => "IServerActionSignature", "ReferenceClientAction" => "IClientActionSignature",
        "ReferenceServiceAPIMethod" => "IServiceActionSignature", "ReferenceWebBlock" => "IWebBlockSignature",
        "NewRuntime.ReferenceWebBlock" => "IMobileBlockSignature", "ReferenceStructure" => "IStructureSignature",
        "ReferenceEntity" => "IEntitySignature", _ => throw Error("Unsupported exported signature: " + tag)
    };
    private static string Required(XElement element, string name) => !string.IsNullOrWhiteSpace((string?)element.Attribute(name))
        ? (string)element.Attribute(name)! : throw Error("Native signature is missing " + name + " on " + element.Name);
    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    private static ArgumentException Error(string message) => new("NativeDependencyReader: " + message);
}
