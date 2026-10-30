using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Core.Preflight;
using Anvil.Reading;

namespace Anvil.Core;

/// <summary>
/// R3-B (KERNEL K3, MINERACAO F8, 2026-10-29): the one table of the static limits and rules of the platform, by lane, each row
/// with its source (a measurement with the Studio that showed it, or the Model API catalog with its version). The preflight of
/// the data text (SpecExpander.DdlCreation), of the logic text and of the JSON ops (Preflight/PlatformLimitRules, the scope
/// phase) and the apply (ModelSession.Create and Rename, EntityIndexes, the convergence of the data text) read the same rows,
/// so the apply has no limit the preflight does not know: before, the 28 characters of a name were cut in silence by the
/// generic create, refused by the index rename, and found by the data text only in its second round (DDL_NOT_CONVERGED).
/// <para>Aspects: <c>name.maxLength</c> (the longest name the platform keeps for a kind), <c>type.modifiers</c> (where a type
/// keeps a Length and Decimals), <c>property.writable</c> (the Model API's own writable properties: Preflight/ModelTypes),
/// <c>parent.allowed</c> (what the platform refuses under a parent or in a module type: the creation maps of the fixtures plus
/// the measured rows), <c>element.requiresOp</c> (an element no text form declares) and <c>asset.format</c> (the image formats
/// a lane stores, whose facts AssetFacts reads from the bytes).</para>
/// <para>When the one valid value is known (a name cut without colliding with a sibling), the refusal carries the certain
/// patch (PLATFORM_NAME_KEPT, the rule R2-B registered for the data text's second round, now said before the first); a JSON
/// form whose name is an alias the job never writes again keeps the cut the apply makes, listed as a normalization. Nothing is
/// cut in silence.</para>
/// </summary>
public static class PlatformLimits
{
    /// <summary>One row: the lanes it holds in ("o11 odc"), the aspect, the kinds (Model API names without the I, space
    /// separated, "*" for every kind), where it holds, the value, what the kernel does (cut, refuse, drop, keep, facts, own op,
    /// catalog), the code of the problem, normalization or rule it answers with, and where the value comes from.</summary>
    public sealed record Row(string Id, string Lanes, string Aspect, string Kinds, string Where, string Value, string Action, string Code, string Consumers, string Source)
    {
        public bool In(string lane) => Lanes.Split(' ').Contains(lane, StringComparer.Ordinal);
        public bool For(string kind) => Kinds == "*" || Kinds.Split(' ').Contains(Kind(kind), StringComparer.Ordinal);
    }

    /// <summary>The length both Studios keep of the name of an entity attribute or an index (measured, see the rows).</summary>
    public const int MeasuredNameLength = 28;

    /// <summary>The refusal of a name longer than the platform keeps, written by a text or a rename (the author's text names it
    /// again, so the cut is never made for them).</summary>
    public const string NameLimit = "PLATFORM_NAME_LIMIT";
    /// <summary>R2-B's certainty rule of the cut name (PatchCertainty), and the normalization of a JSON form that keeps the cut.</summary>
    public const string NameKept = "PLATFORM_NAME_KEPT";
    /// <summary>A user exception a logic text raises or handles that nothing declares: it has no form in a text.</summary>
    public const string RequiresOp = "ELEMENT_REQUIRES_OP";

    public static IReadOnlyList<Row> Rows { get; } =
    [
        new("name.attribute", "o11 odc", "name.maxLength", "EntityAttribute", "the name of an attribute of an entity",
            MeasuredNameLength.ToString(System.Globalization.CultureInfo.InvariantCulture), "cut",
            NameKept + " / " + NameLimit,
            "data text: refused before the first round with the text of every cut name (certain when no sibling takes it); JSON create/spec: the apply writes the cut name, listed in normalizations and nameTruncations; rename: refused",
            "measured 2026-09-23 on ODC Studio 1.7.25.10778 and Service Studio 11.55.87 (a client migration's 'SignatureAuthenticationMethod', 29 characters, kept as 28: D2 of atritos 3)"),
        new("name.index", "o11 odc", "name.maxLength", "EntityIndex", "the name of an index of an entity",
            MeasuredNameLength.ToString(System.Globalization.CultureInfo.InvariantCulture), "cut",
            NameKept + " / " + NameLimit,
            "the same as name.attribute (EntityIndexes.CheckName on rename)",
            "measured 2026-09-23 on ODC Studio 1.7.25.10778 ('UQ_WfCovMilestone_ProjectName' became 'UQ_WfCovMilestone_ProjectNam') and Service Studio 11.55.87 ('IX_Contact_Email_Name_Status30' became 'IX_Contact_Email_Name_Status'); again 2026-10-20 (report 875d39c3, indexes of 32 to 36 characters) and 2026-10-28 (BankDash, 8 UQ_ indexes, DDL_NOT_CONVERGED)"),
        new("type.size.kept", "o11 odc", "type.modifiers", "EntityAttribute StructureAttribute", "the type of an attribute of an entity or a structure",
            "Length (Text, Decimal), Decimals (Decimal)", "keep", "",
            "the data text, the JSON spec and the set verb write them",
            "catalog/model-api-11.55.69.json: IEntityAttribute and IStructureAttribute write Length and Decimals (the ODC Studio's Model API the same)"),
        new("type.size.none", "o11 odc", "type.modifiers", "SiteProperty InputParameter OutputParameter LocalVariable SQLInputParameter", "a site property (O11) or setting (ODC), an input, an output, a local variable, a parameter of an SQL (a binding of the logic text)",
            "none", "drop", "TYPE_SIZE_DROPPED",
            "R2-C (Preflight/TypeSizes.cs) drops the size and lists it; before it, the preflight refuses `set Length` (PROPERTY_NOT_WRITABLE)",
            "catalog/model-api-11.55.69.json: ISiteProperty, IInputParameter, IOutputParameter and ILocalVariable have no Length or Decimals, nor ISQLInputParameter (an IInputParameter); ODC labs 17 and 258 (setting Text(250)); BankDash 2026-10-28 (site property and local Decimal(37,8))"),
        new("property.writable", "o11 odc", "property.writable", "*", "a set, a create's args",
            "the type's writable properties, Set<X> setters, From<X> parsers and list editors", "refuse", "PROPERTY_NOT_WRITABLE / ENUM_VALUE_INVALID",
            "Preflight/PropertyRules (preflight) and ModelSession.FindProperty (apply) read the same Model API (Preflight/ModelTypes)",
            "O11: catalog/model-api-11.55.69.json and the bound Service Studio; ODC: the bound ODC Studio (no catalog: unknown is never refused)"),
        new("parent.map", "o11", "parent.allowed", "*", "a module of type CrossDevice/ReactiveLibrary (reactive-ui), Mobile/MobileLibrary (mobile-ui), WebResponsive/WebResponsiveLibrary (traditional-ui), Service (blank-service)",
            "the (type, parent) pairs the Studio refused and the types with no class in that module type", "refuse", "ACTION_KIND_NODE",
            "the scope phase (ScopeRules.Kinds) reads the maps through PlatformLimits.MapFixture",
            "docs/mapa/criar-<fixture>.json (ProofGenerator, Service Studio 11.55.73.64880, every creatable type under every parent)"),
        new("parent.image.service", "o11", "parent.allowed", "Image", "the module tree (@espace) of a Service module",
            "none", "refuse", "ACTION_KIND_NODE",
            "the scope phase (ScopeRules.Kinds), before the first op",
            "measured 2026-10-28 (BankDash_CS, a Service module): 'Image objects can't be children of Module objects', 3 of 3 creates; the blank-service map has no verdict (its probe created the image without a binary)"),
        new("parent.sessionvariable", "odc", "parent.allowed", "SessionVariable", "an ODC app or library",
            "none", "refuse", "ODC_SESSION_VARIABLE",
            "the scope phase (PreflightRules/OdcScopeRules)",
            "ODC labs (L3c, 2026-10-24): 'Session Variable objects can't be children of App objects'"),
        new("parent.localizedimage", "odc", "parent.allowed", "LocalizedImage", "an image of an ODC app or library",
            "none", "refuse", "ODC_LOCALIZED_IMAGE",
            "the scope phase (PreflightRules/OdcScopeRules)",
            "ODC labs (L3c, 2026-10-24): 'Localized Image objects can't be children of Image objects'"),
        new("ownop.userexception", "o11 odc", "element.requiresOp", "UserException", "the data text and the logic text",
            "no form: only {\"op\":\"create\",\"parent\":\"@espace\",\"type\":\"IUserException\",\"name\":...}", "own op", RequiresOp,
            "the scope phase (Preflight/PlatformLimitRules.OwnOps), for a raise or a handler of a logic op",
            "ssam-ddl/1 and ssam-flow/1 have no exception statement; BankDash 2026-10-28: FLOW_NAME_UNKNOWN at apply for a raised exception nothing created"),
        new("asset.format", "o11 odc", "asset.format", "Image", "the binary of a create whose form takes format, width and height (IESpace.CreateImage; O11 11.55.69's CreateLocalizedImage takes none)",
            "O11: Png, Jpg, Gif, Ico, Svg; ODC: the bound Studio's ImageFormat", "facts", AssetFacts.FactsRule + " / " + AssetFacts.UnknownFormat + " / " + AssetFacts.Mismatch,
            "format, width and height read from the bytes (AssetFacts) by the preflight (JobNormalizer, PlatformLimitRules) and the create (ModelSession.ImageFactsFromBytes, by the Create form's own parameters)",
            "catalog/model-api-11.55.69.json (enum ImageFormat); BankDash 2026-10-28: 'Image format could not be determined' x4 for PNGs created with binary and originalPath only"),
    ];

    /// <summary>The kind of a type as the rows name it: the Model API name without its namespace and the I of an interface
    /// (IEntityAttribute, OutSystems.Model.Data.IEntityAttribute and EntityAttribute are EntityAttribute; IEntityIndex too).</summary>
    public static string Kind(string type)
    {
        var shortName = type.Split('.').Last().Trim();
        return shortName.Length > 1 && shortName[0] == 'I' && char.IsUpper(shortName[1]) ? shortName[1..] : shortName;
    }

    /// <summary>The longest name the platform keeps for an element of this type, from the table; null when the table has no
    /// measured limit for it (the name is never judged).</summary>
    public static int? MaxName(string type, string? lane = null)
    {
        var kind = Kind(type);
        foreach (var row in Rows)
            if (row.Aspect == "name.maxLength" && (lane == null || row.In(lane)) && row.For(kind)
                && int.TryParse(row.Value, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var max)) return max;
        return null;
    }

    /// <summary>The name the platform keeps among <paramref name="siblings"/> (the cut of NameTruncation: the first characters,
    /// numbered when that is taken), or the name itself when it fits or no limit is known.</summary>
    public static string Kept(string type, string name, IEnumerable<string> siblings, string? lane = null)
        => MaxName(type, lane) is { } max && name.Length > max ? NameTruncation.Truncate(name, siblings, max) : name;

    /// <summary>The words a message names a kind with ("an index", "an attribute").</summary>
    public static string Words(string type) => Kind(type) switch
    {
        "EntityIndex" => "index", "EntityAttribute" => "attribute", var other => other,
    };

    /// <summary>The refusal of a rename to a name longer than the platform keeps: the apply's (EntityIndexes, ModelSession.Rename)
    /// and the preflight's wording, one text.</summary>
    public static string RenameMessage(string type, string name, int max)
        => $"{Kind(type)} name '{name}' has {name.Length} characters; the Studio truncates {Words(type)} names to {max} (it would become '{name[..max]}'); pick a shorter name";

    // ---- type.modifiers -------------------------------------------------------------------------------------------------

    /// <summary>Whether the type of an element of this kind keeps a Length and Decimals (type.modifiers): true for an
    /// attribute of an entity or a structure, false for the kinds of type.size.none, null for a kind the table does not name.</summary>
    public static bool? KeepsSize(string kind)
    {
        var k = Kind(kind);
        foreach (var row in Rows.Where(r => r.Aspect == "type.modifiers"))
            if (row.For(k)) return row.Action == "keep";
        return null;
    }

    // ---- parent.allowed -------------------------------------------------------------------------------------------------

    /// <summary>The creation map of a module type (parent.map): the fixture whose docs/mapa/criar-&lt;fixture&gt;.json the scope
    /// phase reads; null for a module type without a map.</summary>
    public static string? MapFixture(string? moduleType) => moduleType switch
    {
        "CrossDevice" or "ReactiveLibrary" => "reactive-ui",
        "Mobile" or "MobileLibrary" => "mobile-ui",
        "WebResponsive" or "WebResponsiveLibrary" => "traditional-ui",
        "Service" => "blank-service",
        _ => null,
    };

    /// <summary>A measured parent the platform refuses (parent.allowed rows beyond the maps) for a create of
    /// <paramref name="type"/> under a parent of <paramref name="parentType"/> in a module of <paramref name="moduleType"/>:
    /// the platform's words and the alternative; null when the table says nothing.</summary>
    public static (string Message, string Fix)? RefusedParent(string lane, string? moduleType, string type, string? parentType)
    {
        var kind = Kind(type);
        if (lane == "o11" && moduleType == "Service" && kind == "Image" && (parentType == null || Kind(parentType) is "ESpace" or "Folder"))
            return ("Image objects can't be children of Module objects: a Service module keeps no images (parent.image.service)",
                "create the image in a module that keeps images (a Reactive, Mobile or Traditional Web module or library, the one whose screens show it) and reference it from there; for a file the service only serves, create an IResource here");
        return null;
    }

    // ---- the table as data ----------------------------------------------------------------------------------------------

    /// <summary>The rows of a lane (every row for null), as the answers and the documentation read them.</summary>
    public static JsonArray Describe(string? lane = null) => new(Rows.Where(r => lane == null || r.In(lane)).Select(r => (JsonNode)new JsonObject
    {
        ["id"] = r.Id, ["lanes"] = r.Lanes, ["aspect"] = r.Aspect, ["kinds"] = r.Kinds, ["where"] = r.Where, ["value"] = r.Value,
        ["action"] = r.Action, ["code"] = r.Code, ["consumers"] = r.Consumers, ["source"] = r.Source,
    }).ToArray());

    // ---- the data text (name.maxLength) ---------------------------------------------------------------------------------

    /// <summary>A name of an element outside a data text (another op of the job, the module): its kind (EntityAttribute,
    /// EntityIndex), the entity it belongs to ("*" when the op names it in a way this reader cannot resolve) and its name.</summary>
    public sealed record Sibling(string Owner, string Kind, string Name);

    /// <summary>The names of a data text longer than the platform keeps (name.maxLength), every one at once, each with its line:
    /// PLATFORM_NAME_LIMIT. The one corrected text (rule PLATFORM_NAME_KEPT, certain) comes only with exclusive
    /// correspondence (review A2, the family of R2-B's convergence): no two names of one kind under one entity cut to one
    /// name, and no cut is a name that entity already has or will have of that kind: in the text, in the job's other ops
    /// (<paramref name="outside"/>, PlatformLimits.JobSiblings) and in the module (<paramref name="module"/>, the apply's
    /// reading). And the corrected text renames only the cut elements (review A4, <see cref="CutText"/>): when that cannot be
    /// proved, no patch.</summary>
    public static List<DdlProblem> DdlNames(DdlDocument edit, string text, string lane, DdlDocument? module = null, IReadOnlyList<Sibling>? outside = null)
    {
        var problems = new List<(DdlElement Element, int Max, string Cut, bool Free)>();
        foreach (var element in edit.All().Concat(edit.Detached))
        {
            if (element.Drop || MaxName(element.Kind, lane) is not { } max || element.Name.Length <= max) continue;
            var cut = element.Name[..max];
            var taken = Siblings(element, edit, module).Concat(Outside(element, outside, max));
            problems.Add((element, max, cut, !taken.Contains(cut, StringComparer.OrdinalIgnoreCase)));
        }
        if (problems.Count == 0) return [];
        foreach (var group in problems.GroupBy(p => (Parent: Owner(p.Element).ToLowerInvariant(), p.Element.Kind, Cut: p.Cut.ToLowerInvariant())).Where(g => g.Count() > 1))
            foreach (var p in group.ToList()) problems[problems.IndexOf(p)] = p with { Free = false };
        var certain = problems.All(p => p.Free);
        var corrected = certain ? CutText(text, edit, problems.Select(p => (p.Element, p.Cut)).ToList(), lane) : null;
        // Review B1 (the Integradora's rule): a patch is certain only when every source that proves the cut unique is visible
        // here. An entity the text or the job creates has all its children in the job; an entity of the module needs the
        // module's names of that kind (the apply's reading, <paramref name="module"/>). Without them the patch is a candidate:
        // offered, with no certainty rule (patchCertain false).
        var unseen = module == null
            ? problems.Select(p => Owner(p.Element)).Where(o => !Created(o, edit, outside)).Distinct(StringComparer.OrdinalIgnoreCase).ToList()
            : [];
        var candidate = corrected != null && unseen.Count > 0;
        // Review C1: one certainty decision per problem, from which its message, its fix, its rule and (JobPreflight.Text) the
        // sentence of the refusal are all written: never a text kept from another decision.
        return problems.Select(p =>
        {
            var decision = !p.Free ? CutDecision.Taken
                : !certain ? CutDecision.OtherTaken
                : corrected == null ? CutDecision.Unproved
                : candidate ? (unseen.Contains(Owner(p.Element), StringComparer.OrdinalIgnoreCase) ? CutDecision.CandidateModuleNotRead : CutDecision.CandidateOtherEntity)
                : CutDecision.Certain;
            var (message, fix) = Say(decision, p.Element, p.Max, p.Cut);
            var data = new JsonObject { ["cutDecision"] = decision };
            if (decision == CutDecision.Certain) data["patchRule"] = NameKept;
            return new DdlProblem(p.Element.Line, NameLimit, message, fix, corrected) { Data = data };
        }).ToList();
    }

    /// <summary>The certainty decisions of a cut data text name (review C1), the published `cutDecision` of the problem.</summary>
    public static class CutDecision
    {
        /// <summary>Every source of the cut's uniqueness was read and nothing takes it: the patch is certain (PLATFORM_NAME_KEPT).</summary>
        public const string Certain = "certain";
        /// <summary>The entity is the module's and its names were not read in this phase: the patch is a candidate.</summary>
        public const string CandidateModuleNotRead = "candidate:module-not-read";
        /// <summary>This name's entity was read, another cut of the same text is a candidate: the one corrected text is too.</summary>
        public const string CandidateOtherEntity = "candidate:another-cut-not-proved";
        /// <summary>Another name of that kind on that entity takes the cut (the text, the job or the module): no patch.</summary>
        public const string Taken = "dropped:collision";
        /// <summary>This cut is free, another cut of the same text is taken: the one corrected text cannot be written.</summary>
        public const string OtherTaken = "dropped:another-cut-taken";
        /// <summary>The corrected text could not be proved to rename only the cut elements: no patch.</summary>
        public const string Unproved = "dropped:rename-not-proved";
    }

    /// <summary>The message and the fix of a cut name, written from its decision alone.</summary>
    public static (string Message, string Fix) Say(string decision, DdlElement element, int max, string cut)
    {
        var words = Words(element.Kind);
        var head = $"{words} {Qualified(element)} has {element.Name.Length} characters: the platform keeps at most {max} for an {words} name";
        return decision switch
        {
            CutDecision.Taken => (head + $", and its first {max} characters ({cut}) are the name of another {words} there (of {Owner(element)}, in this text, another op of the job or the module), or of its cut",
                $"give it a name of at most {max} characters that no other {words} of {Owner(element)} has"),
            CutDecision.CandidateModuleNotRead => (head + $" and would name it {cut} (a candidate: {Owner(element)} is an entity of the module, whose {words} names are not read here, so that cut may already be taken there)",
                $"write {cut} (the name the platform keeps) if {Owner(element)} has no {words} of that name, or give it a name of at most {max} characters"),
            CutDecision.CandidateOtherEntity => (head + $" and would name it {cut} (the corrected text is a candidate: another cut name of it is on an entity of the module not read here)",
                $"write {cut} (the name the platform keeps), or give it a name of at most {max} characters"),
            CutDecision.OtherTaken => (head + $" and would name it {cut}; no corrected text is offered: another cut name of this text is taken",
                $"write {cut} (the name the platform keeps), or give it a name of at most {max} characters"),
            CutDecision.Unproved => (head + $" and would name it {cut}; no corrected text is offered: renaming it alone in the text could not be proved",
                $"write {cut} (the name the platform keeps) where the text declares it and where it names it, or give it a name of at most {max} characters"),
            _ => (head + $" and would name it {cut}", $"write {cut} (the name the platform keeps), or give it a name of at most {max} characters"),
        };
    }

    /// <summary>The marker kind of an entity the job creates (JobSiblings): all its children are in the job.</summary>
    public const string CreatedEntity = "@entity";

    /// <summary>Whether the text (a new entity: no key) or another op of the job creates the entity <paramref name="owner"/>.</summary>
    private static bool Created(string owner, DdlDocument edit, IReadOnlyList<Sibling>? outside)
        => owner.Length > 0 && (edit.All().Any(e => e.Key.Length == 0 && !e.Drop && DdlRules.IsEntityKind(e.Kind) && string.Equals(e.Name, owner, StringComparison.OrdinalIgnoreCase))
            || outside?.Any(s => s.Kind == CreatedEntity && string.Equals(s.Name, owner, StringComparison.OrdinalIgnoreCase)) == true);

    private static IEnumerable<string> Outside(DdlElement element, IReadOnlyList<Sibling>? outside, int max)
    {
        if (outside == null) yield break;
        var owner = Owner(element);
        foreach (var s in outside)
            if (s.Kind == element.Kind && (s.Owner == "*" || string.Equals(s.Owner, owner, StringComparison.OrdinalIgnoreCase)))
            {
                yield return s.Name;
                if (s.Name.Length > max) yield return s.Name[..max];   // what the platform makes of a long one
            }
    }

    /// <summary>The attribute and index names the other ops of a job give an entity (raw creates, JSON specs, other data
    /// texts), for the exclusive correspondence of <see cref="DdlNames"/>. A parent this reader cannot resolve to an entity
    /// counts for every entity ("*"): it can only take a patch away, never give one.</summary>
    public static List<Sibling> JobSiblings(JsonArray ops, int except, string lane)
    {
        var found = new List<Sibling>();
        var entityAliases = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var op in ops.OfType<JsonObject>())
            if (op["op"]?.ToString() == "create" && op["as"] is JsonValue a && a.TryGetValue<string>(out var alias) && op["name"]?.ToString() is { } n
                && Kind(KindNames.Normalize(op["type"]?.ToString() ?? "")) is "Entity" or "ServerEntity" or "StaticEntity" or "ClientEntity" or "LocalEntity")
                entityAliases[alias] = n;
        string OwnerOf(string parent)
        {
            if (entityAliases.TryGetValue(parent, out var named)) return named;
            if (parent.StartsWith('$') && parent.Length > 1 && !parent.Contains('/')) return parent[1..];   // a spec's entity alias $Name
            var colon = parent.IndexOf(':');
            return colon > 0 && !parent.Contains('/') && !parent.StartsWith('@') && !parent.StartsWith('$') ? parent[(colon + 1)..] : "*";
        }
        for (var i = 0; i < ops.Count; i++)
        {
            if (i == except || ops[i] is not JsonObject op) continue;
            switch (op["op"]?.ToString())
            {
                case "create" when op["name"]?.ToString() is { } entityName && Kind(KindNames.Normalize(op["type"]?.ToString() ?? "")) is "Entity" or "ServerEntity" or "StaticEntity" or "ClientEntity" or "LocalEntity":
                    found.Add(new(entityName, CreatedEntity, entityName));
                    break;
                case "create" when op["name"]?.ToString() is { } name && Kind(KindNames.Normalize(op["type"]?.ToString() ?? "")) is "EntityAttribute" or "EntityIndex" or "Index":
                    found.Add(new(OwnerOf(op["parent"]?.ToString() ?? ""), Kind(KindNames.Normalize(op["type"]?.ToString() ?? "")) == "EntityAttribute" ? "EntityAttribute" : "EntityIndex", name));
                    break;
                case "spec" when op["data"] is JsonObject data:
                    if (data["ddl"] is JsonValue v && v.TryGetValue<string>(out var ddl))
                    {
                        try
                        {
                            var document = DdlParser.Parse(ddl, lane);
                            foreach (var e in document.All().Concat(document.Detached))
                                if (!e.Drop && e.Kind is "EntityAttribute" or "EntityIndex") found.Add(new(Owner(e), e.Kind, e.Name));
                                else if (!e.Drop && e.Key.Length == 0 && DdlRules.IsEntityKind(e.Kind)) found.Add(new(e.Name, CreatedEntity, e.Name));
                        }
                        catch { /* its own refusal says why */ }
                    }
                    foreach (var entity in (data["entities"] as JsonArray ?? []).OfType<JsonObject>())
                    {
                        if (entity["name"]?.ToString() is not { } owner) continue;
                        found.Add(new(owner, CreatedEntity, owner));
                        foreach (var attribute in (entity["attributes"] as JsonArray ?? []).OfType<JsonObject>())
                            if (attribute["name"]?.ToString() is { } an) found.Add(new(owner, "EntityAttribute", an));
                        foreach (var index in (entity["indexes"] as JsonArray ?? []).OfType<JsonObject>())
                            if (index["name"]?.ToString() is { } xn) found.Add(new(owner, "EntityIndex", xn));
                    }
                    break;
            }
        }
        return found;
    }

    /// <summary>The data text with each cut element written with its cut and nothing else renamed (review A4): an index's name
    /// after `index` on its line; an attribute's name at the start of its declaration line, in the columns of the indexes on
    /// its entity, and as `Entity.Attribute`. Proved by reading the result: the same elements, only the cut ones renamed, the
    /// same columns but the renamed attributes, the same references, and the long name left only where an element keeps it.
    /// Null when any of that fails: then there is no certain patch.</summary>
    public static string? CutText(string text, DdlDocument edit, IReadOnlyList<(DdlElement Element, string Cut)> cuts, string lane)
    {
        var lines = text.Replace("\r\n", "\n").Split('\n');
        foreach (var (element, cut) in cuts)
        {
            if (element.Line < 1 || element.Line > lines.Length) return null;
            var word = Regex.Escape(element.Name);
            if (element.Kind == "EntityIndex")
            {
                var at = new Regex(@"(\bindex[ \t]+)" + word + @"\b", RegexOptions.IgnoreCase);
                if (!at.IsMatch(lines[element.Line - 1])) return null;
                lines[element.Line - 1] = at.Replace(lines[element.Line - 1], m => m.Groups[1].Value + cut, 1);
                continue;
            }
            var declaration = new Regex(@"^([ \t]*)" + word + @"\b");
            if (!declaration.IsMatch(lines[element.Line - 1])) return null;
            lines[element.Line - 1] = declaration.Replace(lines[element.Line - 1], m => m.Groups[1].Value + cut, 1);
            var owner = Regex.Escape(Owner(element));
            var onOwner = new Regex(@"(\bindex[ \t]+\S+[ \t]+on[ \t]+" + owner + @"[ \t]*\()([^)]*)(\))", RegexOptions.IgnoreCase);
            var column = new Regex(@"(?<![\w.])" + word + @"\b");
            var qualified = new Regex(@"\b(" + owner + @")\." + word + @"\b");
            for (var n = 0; n < lines.Length; n++)
            {
                lines[n] = onOwner.Replace(lines[n], m => m.Groups[1].Value + column.Replace(m.Groups[2].Value, cut) + m.Groups[3].Value);
                lines[n] = qualified.Replace(lines[n], m => m.Groups[1].Value + "." + cut);
            }
        }
        var corrected = string.Join('\n', lines);
        if (text.Contains("\r\n")) corrected = corrected.Replace("\n", "\r\n");
        DdlDocument again;
        try { again = DdlParser.Parse(corrected, lane); } catch { return null; }
        var before = edit.All().Concat(edit.Detached).ToList();
        var after = again.All().Concat(again.Detached).ToList();
        if (before.Count != after.Count) return null;
        var renamed = cuts.ToDictionary(c => c.Element, c => c.Cut, ReferenceEqualityComparer.Instance);
        var attributes = cuts.Where(c => c.Element.Kind == "EntityAttribute").ToDictionary(c => (Owner(c.Element).ToLowerInvariant(), c.Element.Name), c => c.Cut);
        for (var k = 0; k < before.Count; k++)
        {
            var expected = renamed.TryGetValue(before[k], out var cut) ? cut : before[k].Name;
            if (after[k].Kind != before[k].Kind || after[k].Name != expected || after[k].References != before[k].References) return null;
            var columns = before[k].Columns.Select(c => attributes.TryGetValue((Owner(before[k]).ToLowerInvariant(), c), out var to) ? to : c);
            if (!columns.SequenceEqual(after[k].Columns)) return null;
        }
        foreach (var (element, _) in cuts)
            if (Regex.IsMatch(corrected, @"\b" + Regex.Escape(element.Name) + @"\b") && !after.Any(e => e.Name == element.Name || e.References == element.Name)) return null;
        return corrected;
    }
    private static string Qualified(DdlElement element) => (Owner(element) is { Length: > 0 } owner ? owner + "." : "") + element.Name;

    private static string Owner(DdlElement element) => element.Parent?.Name ?? element.Of ?? "";

    /// <summary>The names of the other elements of the same kind under the same parent: in the text and, when given, in the module.</summary>
    private static IEnumerable<string> Siblings(DdlElement element, DdlDocument edit, DdlDocument? module)
    {
        var owner = Owner(element);
        IEnumerable<DdlElement> Under(DdlDocument document) => document.All().Concat(document.Detached)
            .Where(e => !ReferenceEquals(e, element) && !e.Drop && e.Kind == element.Kind && string.Equals(Owner(e), owner, StringComparison.Ordinal));
        var names = Under(edit).Select(e => e.Name);
        // A kept element (by its key) of the module is the text's own when the text writes it: its name in the text counts.
        if (module != null)
        {
            var written = edit.All().Concat(edit.Detached).Where(e => e.Key.Length > 0).Select(e => e.Key).ToHashSet(StringComparer.Ordinal);
            names = names.Concat(Under(module).Where(e => e.Key.Length == 0 || !written.Contains(e.Key)).Select(e => e.Name));
        }
        return names;
    }

    // ---- element.requiresOp ----------------------------------------------------------------------------------------------

    private static readonly Regex Raised = new(@"(?:^|[\s:])raise[ \t]+([A-Za-z_]\w*)[ \t]*\(", RegexOptions.Compiled | RegexOptions.Multiline);
    private static readonly Regex Handled = new(@"^[ \t]*(?:@\{[^}]*\}[ \t]*)?on exception[ \t]+([A-Za-z_]\w*)(?:[ \t]+abort)?(?:[ \t]+log)?[ \t]*:", RegexOptions.Compiled | RegexOptions.Multiline);

    /// <summary>The user exceptions a logic text raises or handles (`raise X(...)`, `on exception X:`), in order, each once;
    /// a System exception (All, Database, Security...) is not one.</summary>
    public static IEnumerable<string> ExceptionsOf(string text)
        => Raised.Matches(text).Concat(Handled.Matches(text)).OrderBy(m => m.Index).Select(m => m.Groups[1].Value)
            .Where(n => !ValueAliases.SystemExceptions.Contains(ValueAliases.SystemExceptionKey(n))).Distinct(StringComparer.OrdinalIgnoreCase);
}
