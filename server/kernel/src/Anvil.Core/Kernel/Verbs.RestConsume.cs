using System.Text.Json.Nodes;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>
/// The op `rest-consume` (RestConsume.cs, RestConsume.Auth.cs): the plan is pure; here the module answers what is already
/// there. Its own elements are found by the marker in their description (the op's client name and the element's planned
/// name), keep their names and are left alone when their hash is the same; a planned name the module already uses for
/// something else moves to the next free one. Then only what changes is written: the site properties/settings (raw verbs),
/// the op `rest` (client, methods, client structures; RestOp, its deletes of what a new sample no longer has deferred), the
/// token client (oauth2), the raw verbs of the public structures, the user exceptions, the callbacks (created first, so the
/// logic op replaces them and their HTTPHeader/URLQueryParameter are known by key), one op `logic` with the mapping
/// functions, the token action, the callbacks and every action (replace keeps the key of an action that already exists),
/// then what the op no longer plans and the deferred deletes. The receipt lists what was created, updated, removed and left
/// as it was, and what the user fills after the publish (configure).
/// </summary>
public sealed partial class ModelSession
{
    private static readonly string[] NamedKinds = ["IRestClient", "IRestStructure", "IRestAction", "IRestService", "IRestServiceAction", "ISOAPClient", "ISOAPStructure", "ISOAPAction",
        "IStructure", "IStructureSignature", "IServerAction", "IServerActionSignature", "IServiceAction", "IServiceActionSignature", "IUserException", "IExceptionSignature",
        "IEntity", "IEntitySignature", "IStaticEntity", "IStaticEntitySignature", "IClientAction", "IClientActionSignature", "IServerEntity", "IClientEntity",
        "ISiteProperty", "IRestCallbackActionFlow"];

    private static readonly string[] CallbackNames = ["OnBeforeRequest", "OnAfterResponse"];

    private JsonNode RestConsumeOp(JsonObject data)
    {
        var problems = Anvil.Core.RestConsume.Validate(data, Lane);
        if (problems.Count > 0) throw new IntegrationRefusalException(Anvil.Core.RestConsume.Op, problems);
        var plan = Anvil.Core.RestConsume.Build(data, Lane);
        var client = plan.Client;
        var callbacks = Anvil.Core.RestConsume.HasCallbacks(plan);
        var oauth = plan.AuthType == "oauth2";
        var tokenPlanned = Anvil.Core.RestConsume.TokenNames(plan);
        // ODC: a library has no service actions (its public server actions serve the apps); an app exposes no public server
        // action (server actions stay the app's own).
        if (Lane == "odc" && plan.Expose)
        {
            var app = OdcApplicationKind();
            if (app == null && plan.ServiceActions)
            {
                plan.ServiceActions = false;
                plan.Warnings.Add(new JsonObject { ["code"] = "REST_CONSUME_LIBRARY_SERVER_ACTIONS", ["path"] = "/data/expose", ["message"] = "an ODC library has no service actions: public server actions instead" });
            }
            else if (app != null && !plan.ServiceActions) plan.PublicActions = false;
        }

        // What the module has: its own elements by marker, every other name as taken in its namespace (data types, actions,
        // exceptions, integrations, settings: a structure and an action may share a name, two structures may not).
        var own = new Dictionary<string, IObjectSignature>(StringComparer.Ordinal); // kind key + planned name
        var taken = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        HashSet<string> Taken(string ns) => taken.TryGetValue(ns, out var set) ? set : taken[ns] = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var element in Descendants().Where(e => NamedKinds.Any(k => Implements(e, k))))
        {
            var name = TypeResolver.Name(element);
            if (string.IsNullOrEmpty(name)) continue;
            var marker = Anvil.Core.RestConsume.ReadMarker(ModelHost.Prop(element, "Description")?.ToString());
            var key = marker is { } m && m.Client == client ? KindKey(element, m.Element) : null;
            if (key != null && !own.ContainsKey(key)) { own[key] = element; continue; }
            Taken(Namespace(element)).Add(name);
        }
        var ownClient = own.GetValueOrDefault("client:");
        var ownAuth = own.GetValueOrDefault("rest-client:" + tokenPlanned.Client);
        // The own clients' methods and structures are their own whatever their marker says (the op rest owns them).
        foreach (var mine in new[] { ownClient, ownAuth }.OfType<IObjectSignature>())
            foreach (var child in mine.Children.OfType<IObjectSignature>())
                if (TypeResolver.Name(child) is { Length: > 0 } childName) Taken(Namespace(child)).Remove(childName);

        // A callback of the own client that this op did not write is never replaced: one refusal, before anything is written.
        if (callbacks && ownClient != null)
        {
            var foreign = ownClient.Children.OfType<IObjectSignature>().Where(c => Implements(c, "IRestCallbackActionFlow")
                && Anvil.Core.RestConsume.ReadMarker(ModelHost.Prop(c, "Description")?.ToString())?.Client != client).Select(c => TypeResolver.Name(c)).ToList();
            if (foreign.Count > 0)
                throw new IntegrationRefusalException(Anvil.Core.RestConsume.Op, foreign.Select(f => new IntegrationProblem("REST_CONSUME_CALLBACK_NOT_OWN", "/data",
                    $"rest-consume: {client}.{f} was not written by this op, and the callbacks of the auth, headers, settings or errors.status are",
                    $"move its steps into callbacks.{(f == "OnBeforeRequest" ? "before" : "after")}.steps of this op and delete {client}.{f}; or drop the keys that need the callbacks")).ToList());
        }

        // Auth basic on O11 encodes the credentials at runtime with the system extension BinaryData: the module references its
        // two actions (the job's reference op, which the facade adds and o11_deliver captures read-only), or one refusal first.
        if (Anvil.Core.RestConsume.UsesBinaryData(plan))
        {
            var missing = Anvil.Core.RestConsume.BinaryDataElements.Select(e => e[(e.IndexOf(':') + 1)..])
                .Where(action => !Descendants().Any(d => Implements(d, "IServerActionSignature") && TypeResolver.Name(d) == action
                    && d.Parent is IObjectSignature owner && string.Equals(TypeResolver.Name(owner), Anvil.Core.RestConsume.BinaryDataProducer, StringComparison.OrdinalIgnoreCase)))
                .ToList();
            if (missing.Count > 0)
                throw new IntegrationRefusalException(Anvil.Core.RestConsume.Op, [new IntegrationProblem("REST_CONSUME_REFERENCE_MISSING", "/data/auth",
                    $"rest-consume: auth basic on O11 encodes user:password in Base64 at runtime with the system extension BinaryData, and the module does not reference {string.Join(", ", missing)}",
                    Anvil.Core.RestConsume.BinaryDataReference().ToJsonString() + " in the job (o11_deliver adds it and captures BinaryData read-only; ssam_job: captureProducers [\"BinaryData\"] or producers {\"BinaryData\": \"<capture .avsig>\"})")]);
        }

        var renamed = new JsonArray();
        string Name(string kindKey, string ns, string wanted, string why)
        {
            if (own.TryGetValue(kindKey + wanted, out var mine)) return TypeResolver.Name(mine)!;
            if (Taken(ns).Add(wanted)) return wanted;
            for (var n = 2; ; n++)
            {
                var next = wanted.Length + n.ToString().Length > Anvil.Core.RestConsume.NameMax ? wanted[..(Anvil.Core.RestConsume.NameMax - n.ToString().Length)] + n : wanted + n;
                if (Taken(ns).Add(next)) { renamed.Add(new JsonObject { ["wanted"] = wanted, ["name"] = next, ["why"] = $"the module already has '{wanted}' ({why}), not written by this op" }); return next; }
            }
        }
        var names = new Anvil.Core.RestConsume.Names();
        names.Client = ownClient != null ? TypeResolver.Name(ownClient)! : Name("client:", "integration", client, "the REST client");
        foreach (var s in plan.Structures)
            names.ClientStructures[s.Id] = ownClient != null && OwnChild(ownClient, "IRestStructure", s.Base + "Json") is { } cs ? TypeResolver.Name(cs)! : Name("rest:", "type", s.Base + "Json", "a client structure");
        foreach (var m in plan.Methods)
            names.Methods[m.Name] = ownClient != null && OwnChild(ownClient, "IRestAction", m.Name) is { } cm ? TypeResolver.Name(cm)! : Name("rest:", "action", m.Name, "a REST method");
        foreach (var s in plan.Settings) names.Settings[s.Base] = Name("setting:", "setting", s.Base, Lane == "odc" ? "a setting" : "a site property");
        if (oauth)
        {
            names.AuthClient = ownAuth != null ? TypeResolver.Name(ownAuth)! : Name("rest-client:", "integration", tokenPlanned.Client, "the token client");
            names.TokenStructure = ownAuth != null && OwnChild(ownAuth, "IRestStructure", tokenPlanned.Structure) is { } ts ? TypeResolver.Name(ts)! : Name("rest:", "type", tokenPlanned.Structure, "the token structure");
            names.TokenMethod = ownAuth != null && OwnChild(ownAuth, "IRestAction", tokenPlanned.Method) is { } tm ? TypeResolver.Name(tm)! : Name("rest:", "action", tokenPlanned.Method, "the token method");
            names.TokenAction = Name("action:", "action", tokenPlanned.Action, "the token action");
        }
        if (plan.Expose)
        {
            foreach (var s in plan.Structures) names.Public[s.Id] = Name("structure:", "type", s.Base, "the public structure");
            foreach (var (s, toClient, list) in Anvil.Core.RestConsume.MapFunctions(plan))
                names.Functions[Anvil.Core.RestConsume.FunctionKey(s, toClient, list)] = Name("action:", "action", Anvil.Core.RestConsume.FunctionBase(s, toClient, list), "a mapping function");
            foreach (var m in plan.Methods) names.Actions[m.Name] = Name("action:", "action", m.Action, "the action");
            foreach (var m in plan.Methods.Where(m => Anvil.Core.RestConsume.Guarded(plan, m, names.Methods[m.Name])))
                names.Impls[m.Name] = Name("action:", "action", m.Action + "_Impl", "the private action of a guarded entry");
        }
        // The user exceptions (the platform keeps no description on one: an exception of that name is reused): the client's,
        // raised by the actions, the callbacks and the token action; AccessDenied (an entry that changes data without a
        // signed-in user, as the other generators use it); one per mapped status.
        string Exception(string wanted, string why)
        {
            var existing = Descendants().FirstOrDefault(e => Implements(e, "IUserException") && string.Equals(TypeResolver.Name(e), wanted, StringComparison.OrdinalIgnoreCase));
            return existing != null ? TypeResolver.Name(existing)! : Name("exception:", "exception", wanted, why);
        }
        var needsException = plan.Expose || callbacks || oauth;
        if (needsException) names.Exception = Exception(plan.Exception, "the user exception");
        if (names.Impls.Count > 0) names.AccessDenied = Exception("AccessDenied", "the user exception of a denied caller");
        foreach (var (_, exception) in plan.StatusErrors)
            if (!names.StatusExceptions.ContainsKey(exception)) names.StatusExceptions[exception] = Exception(exception, "the user exception of a mapped status");

        var report = Report(Anvil.Core.RestConsume.Op);
        var unchanged = new JsonArray();
        var applied = 0;
        void Merge(JsonObject? restReport)
        {
            foreach (var key in new[] { "imported", "updated", "removed", "consumersBroken", "warnings" })
                foreach (var item in restReport?[key]?.AsArray() ?? []) ((JsonArray)report[key]!).Add(item?.DeepClone());
        }
        // 1. The site properties (O11) / settings (ODC) that hold the credentials and the base URL: empty (secret) unless a default.
        foreach (var (s, name, description, hash) in Anvil.Core.RestConsume.Settings(plan, names))
        {
            var existing = own.GetValueOrDefault("setting:" + s.Base);
            if (existing != null && Anvil.Core.RestConsume.ReadMarker(ModelHost.Prop(existing, "Description")?.ToString())?.Hash == hash) { unchanged.Add("ISiteProperty:" + name); continue; }
            var alias = existing != null ? "@" + existing.ObjectKey : $"$restConsume.{client}.setting.{name}";
            var ops = new List<JsonObject>();
            if (existing == null) ops.Add(RestExpander.Op("create", ("parent", "@espace"), ("type", "ISiteProperty"), ("name", name), ("as", alias)));
            ops.Add(RestExpander.Set(alias, "DataType", "Text"));
            ops.Add(RestExpander.Set(alias, "Description", description));
            ops.Add(RestExpander.Set(alias, "IsSecret", s.Secret));
            if (s.Default.Length > 0) ops.Add(RestExpander.Set(alias, "DefaultValue", Anvil.Core.RestConsume.Literal("Text", s.Default)));
            ApplyExpanded(Anvil.Core.RestConsume.Op, ops);
            applied += ops.Count;
            ((JsonArray)report[existing == null ? "imported" : "updated"]!).Add("ISiteProperty:" + name);
        }

        // 2. The client (op rest): skipped when its hash is the same.
        var restData = Anvil.Core.RestConsume.RestData(plan, names);
        var clientHash = Anvil.Core.RestConsume.Hash(restData);
        restData["client"]!["description"] = Anvil.Core.RestConsume.ClientDescription(plan, clientHash);
        var clientMarker = ownClient != null ? Anvil.Core.RestConsume.ReadMarker(ModelHost.Prop(ownClient, "Description")?.ToString()) : null;
        // Deletes of what a changed sample no longer has (attributes, parameters) wait until the actions that read them are
        // rewritten (their only consumers): the public attributes first, then the client's.
        var deferredClient = new List<JsonObject>();
        var deferredPublic = new List<JsonObject>();
        if (clientMarker?.Hash == clientHash)
        {
            unchanged.Add("IRestClient:" + names.Client);
            foreach (var m in plan.Methods) unchanged.Add("IRestAction:" + names.Methods[m.Name]);
            foreach (var s in plan.Structures) unchanged.Add("IRestStructure:" + names.ClientStructures[s.Id]);
        }
        else
        {
            Merge(RestOp(restData, deferredClient)["integration"] as JsonObject);
            applied++;
        }
        var clientKey = (ownClient?.ObjectKey ?? TopLevel(names.Client).First(c => Implements(c, "IRestClient")).ObjectKey)!.ToString();
        var clientElement = (IObjectSignature)Resolve("@" + clientKey);
        report["client"] = new JsonObject { ["name"] = names.Client, ["key"] = clientKey, ["created"] = ownClient == null };

        // 3. The token client (oauth2): its own op rest, skipped when its hash is the same.
        if (oauth)
        {
            var tokenData = Anvil.Core.RestConsume.TokenRestData(plan, names);
            var tokenHash = Anvil.Core.RestConsume.Hash(tokenData);
            tokenData["client"]!["description"] = Anvil.Core.RestConsume.TokenClientDescription(plan, tokenHash);
            if (ownAuth != null && Anvil.Core.RestConsume.ReadMarker(ModelHost.Prop(ownAuth, "Description")?.ToString())?.Hash == tokenHash)
            {
                unchanged.Add("IRestClient:" + names.AuthClient);
                unchanged.Add("IRestAction:" + names.TokenMethod);
                unchanged.Add("IRestStructure:" + names.TokenStructure);
            }
            else { Merge(RestOp(tokenData, deferredClient)["integration"] as JsonObject); applied++; }
        }

        var generated = new JsonArray();
        if (plan.Expose)
        {
            // 4. The public structures, in dependency order (raw verbs; an own structure is updated attribute by attribute).
            foreach (var (s, name, description, attributes, hash) in Anvil.Core.RestConsume.PublicStructures(plan, names))
            {
                var existing = own.GetValueOrDefault("structure:" + s.Base);
                if (existing != null && Anvil.Core.RestConsume.ReadMarker(ModelHost.Prop(existing, "Description")?.ToString())?.Hash == hash) { unchanged.Add("IStructure:" + name); continue; }
                var alias = existing != null ? "@" + existing.ObjectKey : $"$restConsume.{client}.{name}";
                var ops = new List<JsonObject>();
                if (existing == null) ops.Add(RestExpander.Op("create", ("parent", "@espace"), ("type", "IStructure"), ("name", name), ("as", alias)));
                ops.Add(RestExpander.Set(alias, "Public", true));
                ops.Add(RestExpander.Set(alias, "Description", description));
                var current = existing?.Children.OfType<IObjectSignature>().Where(c => Implements(c, "IStructureAttribute"))
                    .GroupBy(c => TypeResolver.Name(c) ?? "", StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal)
                    ?? new Dictionary<string, IObjectSignature>(StringComparer.Ordinal);
                var a = 0;
                foreach (var (attributeName, type, json, attributeDescription) in attributes)
                {
                    var target = current.TryGetValue(attributeName, out var have) ? "@" + have.ObjectKey : $"{alias}.a{++a}";
                    if (have == null) ops.Add(RestExpander.Op("create", ("parent", alias), ("type", "IStructureAttribute"), ("name", attributeName), ("as", target)));
                    ops.Add(RestExpander.Set(target, "DataType", type));
                    ops.Add(RestExpander.Set(target, "Description", attributeDescription));
                }
                foreach (var (gone, element) in current.Where(c => attributes.All(x => x.Name != c.Key)))
                {
                    deferredPublic.Add(RestExpander.Op("delete", ("target", "@" + element.ObjectKey)));
                    ((JsonArray)report["removed"]!).Add($"IStructureAttribute:{name}.{gone}");
                }
                ApplyExpanded(Anvil.Core.RestConsume.Op, ops);
                applied += ops.Count;
                ((JsonArray)report[existing == null ? "imported" : "updated"]!).Add("IStructure:" + name);
            }
        }
        // 5. The user exceptions.
        var exceptions = new List<string>();
        if (needsException) exceptions.Add(names.Exception);
        if (names.Impls.Count > 0) exceptions.Add(names.AccessDenied);
        exceptions.AddRange(names.StatusExceptions.Values);
        foreach (var exception in exceptions.Distinct(StringComparer.Ordinal))
        {
            if (Descendants().Any(e => Implements(e, "IUserException") && string.Equals(TypeResolver.Name(e), exception, StringComparison.Ordinal)))
                unchanged.Add("IUserException:" + exception);
            else
            {
                ApplyOne(RestExpander.Op("create", ("parent", "@espace"), ("type", "IUserException"), ("name", exception), ("as", $"$restConsume.{client}.exception.{exception}")));
                applied++;
                ((JsonArray)report["imported"]!).Add("IUserException:" + exception);
            }
        }
        // 6. The callbacks exist before the logic op writes them (replace keeps their keys), so their structures are known by
        // key: each client has its own HTTPHeader and URLQueryParameter, which no name tells apart.
        var bornCallbacks = new HashSet<string>(StringComparer.Ordinal);
        if (callbacks)
        {
            foreach (var callback in CallbackNames)
            {
                if (clientElement.Children.OfType<IObjectSignature>().Any(c => Implements(c, "IRestCallbackActionFlow") && TypeResolver.Name(c) == callback)) continue;
                ApplyOne(RestExpander.Op("create", ("parent", "@" + clientKey), ("type", "IRestCallbackActionFlow"), ("name", callback), ("as", $"$restConsume.{client}.{callback}")));
                bornCallbacks.Add(callback);
                applied++;
            }
            clientElement = (IObjectSignature)Resolve("@" + clientKey);
            // ODC names them apart in the module (HTTPHeader5): the canonical name is the name without its digits.
            foreach (var structure in clientElement.Children.OfType<IObjectSignature>().Where(c => Implements(c, "IRestCallbackStructure") || Implements(c, "IRestCallbackStructureSignature")))
                if (TypeResolver.Name(structure) is { Length: > 0 } structureName
                    && System.Text.RegularExpressions.Regex.Replace(structureName, "[0-9]+$", "") is var canonical && Anvil.Core.RestConsume.CallbackStructures.Contains(canonical))
                {
                    names.CallbackTypes[canonical] = "@" + structure.ObjectKey;
                    names.CallbackTypeNames[canonical] = structureName;
                }
        }

        // 7. The logic: one op logic; an own action whose hash changed is replaced in place (its key stays).
        var declarations = new JsonArray();
        bool Declare(JsonObject declaration, string hash, string planned, string kind, string ownKind = "action:")
        {
            var existing = own.GetValueOrDefault(ownKind + planned);
            if (existing != null && !Implements(existing, kind)) existing = null;
            var name = declaration["name"]!.ToString();
            if (existing != null && Anvil.Core.RestConsume.ReadMarker(ModelHost.Prop(existing, "Description")?.ToString())?.Hash == hash) { unchanged.Add(kind + ":" + name); return false; }
            if (existing != null) declaration["replace"] = true;
            declarations.Add(declaration);
            ((JsonArray)report[existing == null && (ownKind != "callback:" || bornCallbacks.Contains(planned)) ? "imported" : "updated"]!).Add(kind + ":" + name);
            return true;
        }
        // The mapping functions first (a list inside a record maps through one), the token action, the callbacks, then one
        // action per method.
        if (plan.Expose)
            foreach (var (s, toClient, list) in Anvil.Core.RestConsume.MapFunctions(plan))
            {
                var (declaration, hash) = Anvil.Core.RestConsume.Function(plan, s, toClient, list, names);
                Declare(declaration, hash, Anvil.Core.RestConsume.FunctionBase(s, toClient, list), "IServerAction");
            }
        var tokenWritten = false;
        if (oauth)
        {
            var (declaration, hash, planned, kind) = Anvil.Core.RestConsume.TokenAction(plan, names);
            tokenWritten = Declare(declaration, hash, planned, kind);
        }
        foreach (var (declaration, hash, planned, kind) in Anvil.Core.RestConsume.Callbacks(plan, names))
        {
            // A callback is always there by now: born above (replace writes its flow) or the op's own.
            if (own.GetValueOrDefault("callback:" + planned) is { } mine && Anvil.Core.RestConsume.ReadMarker(ModelHost.Prop(mine, "Description")?.ToString())?.Hash == hash)
            { unchanged.Add("IRestCallbackActionFlow:" + planned); continue; }
            declarations.Add(declaration);
            ((JsonArray)report[bornCallbacks.Contains(planned) ? "imported" : "updated"]!).Add("IRestCallbackActionFlow:" + planned);
        }
        if (plan.Expose)
            foreach (var m in plan.Methods)
            {
                var methodActions = Anvil.Core.RestConsume.Action(plan, m, names);
                foreach (var (declaration, hash, planned, kind) in methodActions) Declare(declaration, hash, planned, kind);
                generated.Add(Summary(plan, m, names, methodActions[0].Declaration));
            }
        else foreach (var m in plan.Methods) generated.Add(Summary(plan, m, names, null));
        if (declarations.Count > 0)
        {
            // A mapping the platform already makes by itself waits in _pendingMappings (the JSON form never flushes it):
            // what this op left there is dropped, so a later text of the job does not take it for its own.
            var pendingBefore = _pendingMappings.Keys.ToHashSet(ReferenceEqualityComparer.Instance);
            ApplyOne(new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["actions"] = declarations } });
            foreach (var target in _pendingMappings.Keys.Where(k => !pendingBefore.Contains(k)).ToList())
            {
                var pending = _pendingMappings[target];
                _pendingMappings.Remove(target);
                if (StudioAdapter.Runtime.Mappings?.Write(target, pending.Fields) is { } why && !why.Contains("by itself", StringComparison.Ordinal))
                    ((JsonArray)report["warnings"]!).Add(new JsonObject { ["code"] = "REST_CONSUME_MAPPING", ["message"] = pending.Given + ": " + why });
            }
            applied++;
        }
        // The token action keeps the token TokenCacheMinutes (the platform's Cache in Minutes of a server action).
        if (tokenWritten)
        {
            var action = Descendants().First(e => Implements(e, "IServerAction") && TypeResolver.Name(e) == names.TokenAction);
            ApplyOne(RestExpander.Set("@" + action.ObjectKey, "CacheInMinutes", plan.TokenCacheMinutes));
            applied++;
        }

        // The parameters the platform gives each callback are born without a description: described (only when they differ).
        if (callbacks)
        {
            var described = new List<JsonObject>();
            foreach (var callback in ((IObjectSignature)Resolve("@" + clientKey)).Children.OfType<IObjectSignature>().Where(c => Implements(c, "IRestCallbackActionFlow")))
                foreach (var parameter in callback.Children.OfType<IObjectSignature>())
                    if (TypeResolver.Name(parameter) is { } parameterName && Anvil.Core.RestConsume.CallbackParameters.TryGetValue(parameterName, out var text)
                        && ModelHost.Prop(parameter, "Description")?.ToString() != text)
                        described.Add(RestExpander.Set("@" + parameter.ObjectKey, "Description", text));
            if (described.Count > 0) { ApplyExpanded(Anvil.Core.RestConsume.Op, described); applied += described.Count; }
        }

        // 8. What this op wrote before and no longer plans (an auth that changed or went): the callbacks, the token action
        // and client, the settings; then what the new sample no longer has, now that nothing of this op reads it.
        var stale = new List<(string Target, string Label)>();
        if (!callbacks)
            foreach (var callback in CallbackNames)
                if (own.GetValueOrDefault("callback:" + callback) is { } mine) stale.Add(("@" + mine.ObjectKey, "IRestCallbackActionFlow:" + callback));
        if (!oauth)
        {
            if (own.GetValueOrDefault("action:" + tokenPlanned.Action) is { } action && Implements(action, "IServerAction")) stale.Add(("@" + action.ObjectKey, "IServerAction:" + TypeResolver.Name(action)));
            if (ownAuth != null) stale.Add(("@" + ownAuth.ObjectKey, "IRestClient:" + TypeResolver.Name(ownAuth)));
        }
        foreach (var (key, setting) in own.Where(o => o.Key.StartsWith("setting:", StringComparison.Ordinal)))
            if (plan.Settings.All(s => "setting:" + s.Base != key)) stale.Add(("@" + setting.ObjectKey, "ISiteProperty:" + TypeResolver.Name(setting)));
        if (stale.Count > 0)
        {
            ApplyExpanded(Anvil.Core.RestConsume.Op, stale.Select(s => RestExpander.Op("delete", ("target", s.Target))).ToList());
            applied += stale.Count;
            foreach (var (_, label) in stale) ((JsonArray)report["removed"]!).Add(label);
        }
        var deletes = deferredPublic.Concat(deferredClient).ToList();
        foreach (var delete in deletes)
        {
            // The rewritten mappings still list the attribute as a target slot the platform keeps per attribute of the type
            // (an empty AttributeMapping, dropped with the attribute), and a rewritten call keeps an empty argument per input of
            // the method it calls (dropped with the input): neither is a consumer. Any other one still refuses.
            if (Resolve(delete["target"]!.ToString()) is IObjectSignature staleElement && staleElement is ServiceStudio.Model.AbstractObject
                && DeleteConsumers(staleElement) is { Count: > 0 } consumers && consumers.All(c => c.Path.Contains("/AttributeMappingTarget", StringComparison.Ordinal) || EmptyArgument(c.Referer)))
                delete["force"] = true;
        }
        if (deletes.Count > 0) { ApplyExpanded(Anvil.Core.RestConsume.Op, deletes); applied += deletes.Count; }
        foreach (var warning in plan.Warnings) ((JsonArray)report["warnings"]!).Add(warning.DeepClone());
        report["unchanged"] = unchanged;
        if (renamed.Count > 0) report["renamed"] = renamed;
        var summary = new JsonObject
        {
            ["client"] = names.Client, ["baseUrl"] = plan.BaseUrl, ["exception"] = needsException ? names.Exception : null,
            ["actionKind"] = plan.Expose ? (plan.ServiceActions ? "service" : "server") : null, ["methods"] = generated,
        };
        if (plan.AuthType != "none") summary["auth"] = plan.AuthType;
        if (callbacks) summary["callbacks"] = new JsonArray(CallbackNames.Select(c => (JsonNode)(names.Client + "." + c)).ToArray());
        if (oauth) summary["token"] = new JsonObject { ["client"] = names.AuthClient, ["action"] = names.TokenAction, ["cacheMinutes"] = plan.TokenCacheMinutes };
        if (names.StatusExceptions.Count > 0)
            summary["status"] = new JsonObject(plan.StatusErrors.Select(s => KeyValuePair.Create(s.Status.ToString(System.Globalization.CultureInfo.InvariantCulture), (JsonNode?)names.StatusExceptions[s.Exception])));
        report["generated"] = summary;
        // What the user fills after the publish (names and places only, never a value).
        if (plan.Settings.Count > 0) report["configure"] = Anvil.Core.RestConsume.Configure(plan, names, TypeResolver.Name(_es) ?? "the module");
        report["changed"] = applied > 0;
        Touch(clientElement);
        return new JsonObject { ["expanded"] = applied, ["integration"] = report };
    }

    /// <summary>An argument of a call that passes nothing (the slot the platform keeps for an input the call leaves empty).</summary>
    private static bool EmptyArgument(object referer)
        => Implements(referer, "IArgument") && ModelHost.Prop(referer, "Value") is var value
           && string.IsNullOrWhiteSpace(value is null ? null : value.GetType().GetProperty("Text")?.GetValue(value) as string ?? value.ToString());

    /// <summary>The namespace of a name: data types, actions (REST and SOAP methods too), exceptions, integrations, settings.</summary>
    private static string Namespace(IObjectSignature element)
        => Implements(element, "IUserException") || Implements(element, "IExceptionSignature") ? "exception"
            : Implements(element, "IRestClient") || Implements(element, "IRestService") || Implements(element, "ISOAPClient") ? "integration"
            : Implements(element, "ISiteProperty") ? "setting"
            : Implements(element, "IRestCallbackActionFlow") ? "callback"
            : Implements(element, "IRestAction") || Implements(element, "ISOAPAction") || Implements(element, "IRestServiceAction") || Implements(element, "IServerAction") || Implements(element, "IServerActionSignature")
              || Implements(element, "IServiceAction") || Implements(element, "IServiceActionSignature") || Implements(element, "IClientAction") || Implements(element, "IClientActionSignature") ? "action"
            : "type";

    /// <summary>The key of an own element: its kind and the planned name the marker carries.</summary>
    private static string? KindKey(IObjectSignature element, string? planned)
    {
        if (Implements(element, "IRestClient")) return planned == null ? "client:" : "rest-client:" + planned;
        if (planned == null) return null;
        if (Implements(element, "IRestCallbackActionFlow")) return "callback:" + planned;
        if (Implements(element, "IRestStructure") || Implements(element, "IRestAction")) return "rest:" + planned;
        if (Implements(element, "IStructure")) return "structure:" + planned;
        if (Implements(element, "IServiceAction") || Implements(element, "IServerAction")) return "action:" + planned;
        if (Implements(element, "ISiteProperty")) return "setting:" + planned;
        return null;
    }

    /// <summary>The child of an own client that its marker (or, for an older one, its name) says is the planned element.</summary>
    private static IObjectSignature? OwnChild(IObjectSignature client, string kind, string planned)
    {
        var children = client.Children.OfType<IObjectSignature>().Where(c => Implements(c, kind)).ToList();
        return children.FirstOrDefault(c => Anvil.Core.RestConsume.ReadMarker(ModelHost.Prop(c, "Description")?.ToString())?.Element == planned)
            ?? children.FirstOrDefault(c => string.Equals(TypeResolver.Name(c), planned, StringComparison.Ordinal));
    }

    /// <summary>What a method became: the REST method, its types and the action's signature, so nothing needs to be read back.</summary>
    private static JsonObject Summary(Anvil.Core.RestConsume.Plan plan, Anvil.Core.RestConsume.MethodPlan m, Anvil.Core.RestConsume.Names names, JsonObject? declaration)
    {
        var summary = new JsonObject
        {
            ["method"] = m.Name, ["http"] = m.Http, ["url"] = m.Url, ["restMethod"] = names.Methods[m.Name], ["urlPath"] = m.Path,
            ["response"] = Anvil.Core.RestConsume.ResponseType(m, names, wire: true),
        };
        if (m.Fixed.Count > 0) summary["headers"] = new JsonObject(m.Fixed.Select(f => KeyValuePair.Create(f.Header, (JsonNode?)f.Literal)));
        if (declaration != null)
        {
            summary["result"] = Anvil.Core.RestConsume.ResponseType(m, names, wire: false);
            var inputs = declaration["inputs"]?.AsArray().OfType<JsonObject>().Select(i => i["name"] + ": " + i["type"] + (i["mandatory"]?.GetValue<bool>() == false ? "?" : "") + (i["default"] is { } d ? " = " + d : "")) ?? [];
            var outputs = declaration["outputs"]?.AsArray().OfType<JsonObject>().Select(o => o["name"] + ": " + o["type"]) ?? [];
            var raises = new List<string> { names.Exception };
            if (names.Impls.ContainsKey(m.Name)) raises.Add(names.AccessDenied);
            raises.AddRange(names.StatusExceptions.Values.Where(e => !raises.Contains(e)));
            summary["action"] = new JsonObject
            {
                ["name"] = declaration["name"]!.ToString(), ["kind"] = declaration["kind"]!.ToString(),
                ["signature"] = $"{declaration["name"]}({string.Join(", ", inputs)})" + (outputs.Any() ? " -> " + string.Join(", ", outputs) : ""),
                ["raises"] = string.Join(", ", raises.Distinct(StringComparer.Ordinal)),
                ["impl"] = names.Impls.TryGetValue(m.Name, out var impl) ? impl : null,
            };
        }
        return summary;
    }
}
