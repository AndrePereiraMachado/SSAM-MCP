using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using OutSystems.Model;
using ServiceStudio.Model;

namespace Anvil.Core;

public sealed record GalleryBlockResult(string Module, string Flow, string Block, string Status, int Ops, string? Error, IReadOnlyList<string> Messages);

/// <summary>
/// Galeria de widgets: instancia TODOS os blocos publicos dos catalogos de UI (OutSystemsUI, Charts, Maps...) num fixture, uma
/// tela por UI flow, e configura cada um como um dev faria depois de arrastar o bloco: inputs obrigatorios (escalares com valor,
/// listas/structures com variavel local do tipo), placeholders (bloco filho esperado ou expressao) e handlers obrigatorios; e o
/// conteudo de exemplo que o bloco traz: Inputs sem variavel ganham variavel local, Lists sem fonte ganham lista local, Links e
/// Buttons sem destino ganham screen action, blocos aninhados ganham os seus inputs obrigatorios.
/// Cada bloco e aplicado isoladamente: falhou, apaga-se o que criou e segue. Sai um relatorio por bloco (ok / mensagens do
/// Verify / falhou), o OML e um job com os ops que passaram (para merge no Studio).
/// </summary>
public static class UiGallery
{
    public static object Run(ModelHost host, string fixturePath, IEnumerable<string> catalogPaths, string outDir, string runtime, Action<string>? log = null, string? onlyFlow = null, string? onlyBlock = null, IReadOnlyDictionary<string, string>? producers = null)
    {
        var web = runtime.Equals("Traditional", StringComparison.OrdinalIgnoreCase);
        var mobile = runtime.Equals("Mobile", StringComparison.OrdinalIgnoreCase);
        var catalogs = catalogPaths.Select(UiCatalog.ReadJson).ToList();
        var statics = catalogs.SelectMany(c => c.StaticEntities).GroupBy(s => s.Name).ToDictionary(g => g.Key, g => g.First(), StringComparer.OrdinalIgnoreCase);
        var blocksByName = catalogs.SelectMany(c => c.Blocks).GroupBy(b => b.Name).ToDictionary(g => g.Key, g => g.First(), StringComparer.OrdinalIgnoreCase);
        var wantedRuntime = web ? "Traditional" : "Reactive/Mobile";
        var blocks = catalogs.SelectMany(c => c.Blocks).Where(b => b.Public && b.Runtime == wantedRuntime && b.Flow != "Private").ToList();
        if (onlyFlow != null) blocks = blocks.Where(b => string.Equals(b.Flow, onlyFlow, StringComparison.OrdinalIgnoreCase)).ToList();
        if (onlyBlock != null) blocks = blocks.Where(b => string.Equals(b.Name, onlyBlock, StringComparison.OrdinalIgnoreCase)).ToList();

        var espace = host.Load(File.ReadAllBytes(fixturePath));
        var beforeMessages = ModelHost.Messages(espace);
        var available = new HashSet<string>(((IObjectSignature)espace).GetAllDescendantsOfType<IObjectSignature>()
            .Where(o => o.GetType().Name.Contains("Block") && !o.GetType().Name.Contains("Instance")).Select(o => TypeResolver.Name(o) ?? "").Where(n => n.Length > 0), StringComparer.OrdinalIgnoreCase);
        var session = new ModelSession(espace);
        var results = new List<GalleryBlockResult>();
        var jobOps = new JsonArray();
        var ctx = new Ctx(web, mobile, blocksByName, statics);
        var producerCache = new Dictionary<string, ESpace>(StringComparer.OrdinalIgnoreCase);
        session.ProducerLoader = spec => producerCache.TryGetValue(spec, out var p) ? p : producerCache[spec] = host.Load(File.ReadAllBytes(producers![spec]));

        StudioAdapter.Runtime.Mutate(espace, "Anvil: widget gallery", _ =>
        {
            // 0) referencias em falta: o verbo reference (Manage Dependencies headless) com o OML do produtor
            if (producers != null)
                foreach (var mod in blocks.Select(b => b.Module).Distinct())
                {
                    if (!producers.TryGetValue(mod, out var oml)) continue;
                    var missing = blocks.Where(b => b.Module == mod && !available.Contains(b.Name)).Select(b => $"{ctx.BlockType}:{b.Name}").ToList();
                    if (missing.Count == 0) continue;
                    var refOp = Op(("op", "reference"), ("producer", mod));
                    refOp["elements"] = new JsonArray(missing.Select(m => (JsonNode)m).ToArray());
                    try
                    {
                        session.ApplyOne(refOp);
                        jobOps.Add(Clone(refOp));
                        foreach (var m in missing) available.Add(m.Split(':')[1]);
                        log?.Invoke($"reference {mod}: +{missing.Count} blocos");
                    }
                    catch (Exception ex) { log?.Invoke($"reference {mod} FAILED: {Unwrap(ex)}"); }
                }
            foreach (var group in blocks.GroupBy(b => b.Module + "|" + b.Flow))
            {
                var first = group.First();
                var screenName = Safe($"Gallery_{first.Module.Replace("OutSystems", "")}_{first.Flow}");
                var screenOps = new List<JsonObject> { Op(("op", "create"), ("parent", ctx.FlowRef), ("type", ctx.ScreenType), ("name", screenName), ("as", "$scr")) };
                if (!web) screenOps.Add(Op(("op", "set"), ("target", "$scr/#IMobileBlockInstanceWidget"), ("prop", "SourceBlock"), ("value", mobile ? "IMobileBlock:Layout" : "IMobileBlock:LayoutTopMenu")));
                screenOps.Add(Op(("op", "create"), ("parent", web ? "$scr/#IWebBlockInstanceWidget/Title" : "$scr/#IMobileBlockInstanceWidget/Title"), ("type", ctx.ExprType), ("as", "$scrTitle")));
                screenOps.Add(Op(("op", "set"), ("target", "$scrTitle"), ("prop", "Value"), ("value", $"\"{first.Module} / {first.Flow}\"")));
                foreach (var o in screenOps) { session.ApplyOne(o); jobOps.Add(Clone(o)); }
                log?.Invoke($"== {screenName}: {group.Count()} blocos");

                foreach (var b in group)
                {
                    if (!available.Contains(b.Name))
                    {
                        results.Add(new GalleryBlockResult(b.Module, b.Flow, b.Name, "not-referenced", 0, "block not referenced by the fixture (add the dependency)", Array.Empty<string>()));
                        continue;
                    }
                    var ops = BlockOps(b, ctx);
                    var done = 0; string? error = null;
                    var created = new List<string>();
                    var applied = new List<JsonObject>();
                    foreach (var o in ops)
                    {
                        try
                        {
                            session.ApplyOne(o);
                            applied.Add(o);
                            if (o["as"] != null && (o["parent"]?.GetValue<string>() == ctx.ContentPath || o["parent"]?.GetValue<string>() == "$scr")) created.Add(o["as"]!.GetValue<string>());
                            done++;
                        }
                        catch (Exception ex) { error = $"op #{done} {o["op"]} {o["type"] ?? o["prop"]} on {o["parent"] ?? o["target"]}: {Unwrap(ex)}"; break; }
                    }
                    if (error == null)
                    {
                        // 2a passada: configurar o conteudo de exemplo como um dev faria
                        var auto = AutoConfig(session, b, $"${b.Name}1", $"{b.Name}1", ctx);
                        foreach (var o in auto)
                        {
                            try { session.ApplyOne(o); applied.Add(o); if (o["as"] != null && o["parent"]?.GetValue<string>() == "$scr") created.Add(o["as"]!.GetValue<string>()); done++; }
                            catch (Exception ex) { log?.Invoke($"   auto {b.Name}: {o["op"]} {o["prop"] ?? o["type"]} -> {Unwrap(ex)}"); }
                        }
                    }
                    if (error != null)
                    {
                        foreach (var alias in Enumerable.Reverse(created))
                            try { session.ApplyOne(Op(("op", "delete"), ("target", alias), ("force", true))); } catch { }
                        results.Add(new GalleryBlockResult(b.Module, b.Flow, b.Name, "failed", done, error, Array.Empty<string>()));
                        log?.Invoke($"   FAIL {b.Name}: {error}");
                    }
                    else
                    {
                        foreach (var o in applied) { var c = Clone(o); c["_block"] = b.Name; jobOps.Add(c); }
                        results.Add(new GalleryBlockResult(b.Module, b.Flow, b.Name, "created", done, null, Array.Empty<string>()));
                    }
                }
            }
        });

        var afterMessages = ModelHost.Messages(espace);
        var messageDelta = MessageDelta.Compute(beforeMessages, afterMessages);
        var details = ModelHost.ValidationDetails(espace, 100000, afterMessages);
        var final = new List<GalleryBlockResult>();
        foreach (var r in results)
        {
            if (r.Status != "created") { final.Add(r); continue; }
            var mine = details.Where(d => d.Contains($"G_{r.Block} (") || d.Contains($"/ G_{r.Block}") || d.Contains($"{r.Block}1 (") || d.Contains($"{r.Block}1_")).ToList();
            final.Add(r with { Status = mine.Count == 0 ? "ok" : mine.Any(m => m.StartsWith("Error")) ? "errors" : "warnings", Messages = mine });
        }
        var snap = ModelHost.Describe(espace, 0, afterMessages);
        Directory.CreateDirectory(outDir);
        var stem = Path.Combine(outDir, $"gallery-{runtime.ToLowerInvariant()}");
        File.WriteAllBytes(stem + ".oml", host.Save(espace));
        File.WriteAllText(stem + ".json", JsonSerializer.Serialize(final, new JsonSerializerOptions { WriteIndented = true }));
        File.WriteAllText(stem + ".md", Report(final, runtime, snap.Objects, snap.Validation.Total));
        var okBlocks = final.Where(r => r.Status is "ok" or "warnings").Select(r => r.Block).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var okOps = new JsonArray();
        foreach (var o in jobOps)
        {
            var oj = o!.AsObject();
            var owner = oj["_block"]?.GetValue<string>();
            if (owner != null && !okBlocks.Contains(owner)) continue;
            var c = Clone(oj); c.Remove("_block"); okOps.Add(c);
        }
        var expectedMessages = messageDelta.New.Where(m => !m.IsError && okBlocks.Any(block =>
            m.Path.Contains($"G_{block} (") || m.Path.Contains($"/ G_{block}") || m.Path.Contains($"{block}1 (") || m.Path.Contains($"{block}1_")))
            .Select(m => new ExpectedMessage(m.Id, m.Path,
                "Aviso observado no contrato do bloco instanciado na galeria de demonstracao: " + m.Detail)).ToArray();
        File.WriteAllText(stem + "-job.json", new JsonObject { ["description"] = $"Galeria de widgets {runtime} gerada do catalogo ({okBlocks.Count} blocos ok)", ["base"] = fixturePath, ["expectValid"] = true, ["expectedMessages"] = JsonSerializer.SerializeToNode(expectedMessages), ["ops"] = okOps }.ToJsonString());
        var summary = final.GroupBy(r => r.Status).ToDictionary(g => g.Key, g => g.Count());
        log?.Invoke($"gallery {runtime}: {string.Join(", ", summary.Select(k => k.Key + "=" + k.Value))}; objects {snap.Objects}, verify {snap.Validation.Total} msgs");
        return new { runtime, blocks = final.Count, summary, objects = snap.Objects, verifyMessages = snap.Validation.Total, isValid = snap.IsValid, oml = stem + ".oml", report = stem + ".md", job = stem + "-job.json" };
    }

    private sealed class Ctx
    {
        public readonly bool Web, Mobile;
        public readonly IReadOnlyDictionary<string, UiBlock> ByName;
        public readonly IReadOnlyDictionary<string, UiStaticEntity> Statics;
        public readonly string InstType, BlockType, ScreenType, FlowRef, ContentPath, ExprType, ContainerType, InputType, ListType, LinkType, ButtonType, TextAreaType;
        public int VarSeq;
        public Ctx(bool web, bool mobile, IReadOnlyDictionary<string, UiBlock> byName, IReadOnlyDictionary<string, UiStaticEntity> statics)
        {
            Web = web; Mobile = mobile; ByName = byName; Statics = statics;
            InstType = web ? "IWebBlockInstanceWidget" : "IMobileBlockInstanceWidget";
            BlockType = web ? "IWebBlock" : "IMobileBlock";
            ScreenType = web ? "IWebScreen" : "IMobileScreen";
            FlowRef = web ? "IWebFlow:MainFlow" : "IMobileFlow:MainFlow";
            ContentPath = web ? "$scr/#IWebBlockInstanceWidget/MainContent" : mobile ? "$scr/#IMobileBlockInstanceWidget/Content" : "$scr/#IMobileBlockInstanceWidget/MainContent";
            ExprType = web ? "IExpressionWidget" : "IExpression";
            ContainerType = web ? "IContainerWidget" : "IContainer";
            InputType = web ? "IInputWidget" : "IInput";
            ListType = web ? "IListRecordsWidget" : "IList";
            LinkType = web ? "ILinkWidget" : "ILink";
            ButtonType = web ? "IButtonWidget" : "IButton";
            TextAreaType = web ? "IInputWidget" : "ITextArea";
        }
    }

    private static List<JsonObject> BlockOps(UiBlock b, Ctx ctx)
    {
        var ops = new List<JsonObject>();
        var g = $"$G_{b.Name}";
        ops.Add(Op(("op", "create"), ("parent", ctx.ContentPath), ("type", ctx.ContainerType), ("name", $"G_{b.Name}"), ("as", g)));
        ops.Add(Op(("op", "create"), ("parent", g), ("type", ctx.ExprType), ("as", g + "_t")));
        ops.Add(Op(("op", "set"), ("target", g + "_t"), ("prop", "Value"), ("value", $"\"{b.Name}\"")));
        Instance(ops, b, ctx, g, $"${b.Name}1", $"{b.Name}1", depth: 0);
        return ops;
    }

    private static void Instance(List<JsonObject> ops, UiBlock b, Ctx ctx, string parent, string alias, string name, int depth)
    {
        ops.Add(Op(("op", "create"), ("parent", parent), ("type", ctx.InstType), ("name", name), ("source", $"{ctx.BlockType}:{b.Name}"), ("as", alias)));
        foreach (var i in b.Inputs.Where(i => i.Mandatory))
            BindInput(ops, ctx, alias, name, i);
        foreach (var p in b.Placeholders)
        {
            if (p.Defaults.Count > 0) continue;
            var child = b.Uses.FirstOrDefault(u => p.Description != null && p.Description.Contains(u, StringComparison.Ordinal));
            if (child != null && depth < 1 && ctx.ByName.TryGetValue(child, out var cb))
            {
                Instance(ops, cb, ctx, $"{alias}/{p.Name}", $"{alias}_{p.Name}", $"{name}_{child}", depth + 1);
                continue;
            }
            var ea = $"{alias}_{p.Name}_e";
            ops.Add(Op(("op", "create"), ("parent", $"{alias}/{p.Name}"), ("type", ctx.ExprType), ("as", ea)));
            ops.Add(Op(("op", "set"), ("target", ea), ("prop", "Value"), ("value", $"\"{b.Name} {p.Name}\"")));
        }
        if (depth == 0)
            foreach (var ev in b.Events)
            {
                var h = $"{alias}_{ev.Name}_h";
                ops.Add(Op(("op", "create"), ("parent", "$scr"), ("type", "IScreenAction"), ("name", $"{name}_{ev.Name}"), ("as", h)));
                var k = 0;
                foreach (var pr in ev.Params)
                {
                    k++;
                    ops.Add(Op(("op", "create"), ("parent", h), ("type", "IInputParameter"), ("name", pr.Name), ("as", $"{h}_p{k}")));
                    ops.Add(Op(("op", "set"), ("target", $"{h}_p{k}"), ("prop", "DataType"), ("value", pr.Type)));
                }
                ops.Add(Op(("op", "create"), ("parent", h), ("type", "IStartNode"), ("as", h + "_s")));
                ops.Add(Op(("op", "create"), ("parent", h), ("type", "IEndNode"), ("as", h + "_e")));
                ops.Add(Op(("op", "link"), ("from", h + "_s"), ("to", h + "_e")));
                ops.Add(Op(("op", "set"), ("target", $"{alias}/{ev.Name}"), ("prop", "Handler"), ("value", h)));
                foreach (var pr in ev.Params) ops.Add(Op(("op", "set"), ("target", $"{alias}/{ev.Name}/{pr.Name}"), ("prop", "Value"), ("value", pr.Name)));
            }
    }

    /// <summary>Input obrigatorio: escalar ganha valor; lista/structure ganha uma variavel local da tela desse tipo.</summary>
    private static void BindInput(List<JsonObject> ops, Ctx ctx, string alias, string name, UiParam i)
    {
        // inputs que pedem o Id de um widget da tela (MouseEvents.WidgetId, Tooltip.WidgetId...): o contentor do bloco serve de alvo
        if (i.Type == "Text" && (i.Name.EndsWith("WidgetId", StringComparison.OrdinalIgnoreCase) || i.Name.EndsWith("ElementId", StringComparison.OrdinalIgnoreCase) || i.Name.EndsWith("TargetId", StringComparison.OrdinalIgnoreCase)))
        {
            ops.Add(Op(("op", "set"), ("target", $"{alias}/{i.Name}"), ("prop", "Value"), ("value", $"G_{name.TrimEnd('1')}.Id")));
            return;
        }
        var v = ValueFor(i, ctx.Statics);
        if (v != null) { ops.Add(Op(("op", "set"), ("target", $"{alias}/{i.Name}"), ("prop", "Value"), ("value", v))); return; }
        var varName = Safe($"{name}_{i.Name}");
        ops.Add(Op(("op", "create"), ("parent", "$scr"), ("type", "ILocalVariable"), ("name", varName), ("as", "$v_" + varName)));
        ops.Add(Op(("op", "set"), ("target", "$v_" + varName), ("prop", "DataType"), ("value", i.Type)));
        ops.Add(Op(("op", "set"), ("target", $"{alias}/{i.Name}"), ("prop", "Value"), ("value", varName)));
    }

    /// <summary>Conteudo de exemplo do bloco instanciado, configurado como um dev faria: Inputs -> variavel local, Lists -> lista
    /// local, Links/Buttons sem destino -> screen action, blocos aninhados -> inputs obrigatorios.</summary>
    private static List<JsonObject> AutoConfig(ModelSession session, UiBlock b, string alias, string name, Ctx ctx)
    {
        var ops = new List<JsonObject>();
        if (session.Resolve(alias) is not IObjectSignature root) return ops;
        void Bind(string type, string prop, string varType)
        {
            var hits = ModelSession.Descendants(root, type);
            for (var k = 0; k < hits.Count; k++)
            {
                if (UiCatalog.Prop(hits[k], prop) is IExpression ex && !string.IsNullOrWhiteSpace(ex.Text)) continue;
                var varName = Safe($"{name}_{type.TrimStart('I')}{k + 1}");
                ops.Add(Op(("op", "create"), ("parent", "$scr"), ("type", "ILocalVariable"), ("name", varName), ("as", "$v_" + varName)));
                ops.Add(Op(("op", "set"), ("target", "$v_" + varName), ("prop", "DataType"), ("value", varType)));
                ops.Add(Op(("op", "set"), ("target", $"{alias}/**{type}[{k + 1}]"), ("prop", prop), ("value", varName)));
            }
        }
        var lower = b.Name.ToLowerInvariant();
        var inputVarType = lower.Contains("month") ? "Date" : lower.Contains("datetime") ? "Date Time" : lower.Contains("date") ? "Date" : lower.Contains("time") ? "Time" : "Text";
        Bind(ctx.InputType, "Variable", inputVarType);
        if (!ctx.Web) Bind(ctx.TextAreaType, "Variable", "Text");
        Bind(ctx.ListType, ctx.Web ? "SourceRecordList" : "Source", "Text List");
        foreach (var type in new[] { ctx.LinkType, ctx.ButtonType })
        {
            var hits = ModelSession.Descendants(root, type);
            for (var k = 0; k < hits.Count; k++)
            {
                var ev = UiCatalog.Prop(hits[k], "OnClick");
                if (ev == null || UiCatalog.Prop(ev, "Destination") != null) continue;
                var h = Safe($"{name}_{type.TrimStart('I')}{k + 1}_Click");
                ops.Add(Op(("op", "create"), ("parent", "$scr"), ("type", "IScreenAction"), ("name", h), ("as", "$h_" + h)));
                ops.Add(Op(("op", "create"), ("parent", "$h_" + h), ("type", "IStartNode"), ("as", "$h_" + h + "_s")));
                ops.Add(Op(("op", "create"), ("parent", "$h_" + h), ("type", "IEndNode"), ("as", "$h_" + h + "_e")));
                ops.Add(Op(("op", "link"), ("from", "$h_" + h + "_s"), ("to", "$h_" + h + "_e")));
                ops.Add(Op(("op", "set"), ("target", $"{alias}/**{type}[{k + 1}]/OnClick"), ("prop", "Destination"), ("value", "$h_" + h)));
            }
        }
        // imagens de exemplo sem imagem: URL externa
        var images = ModelSession.Descendants(root, ctx.Web ? "IImageWidget" : "IImage");
        for (var k = 0; k < images.Count; k++)
        {
            if (UiCatalog.Prop(images[k], "Image") != null) continue;
            ops.Add(Op(("op", "set"), ("target", $"{alias}/**{(ctx.Web ? "IImageWidget" : "IImage")}[{k + 1}]"), ("prop", "Type"), ("value", "External")));
            ops.Add(Op(("op", "set"), ("target", $"{alias}/**{(ctx.Web ? "IImageWidget" : "IImage")}[{k + 1}]"), ("prop", "Url"), ("value", "\"https://picsum.photos/400/300\"")));
        }
        // blocos aninhados (conteudo de exemplo): inputs obrigatorios sem valor
        var nested = ModelSession.Descendants(root, ctx.InstType);
        for (var k = 0; k < nested.Count; k++)
        {
            var src = TypeResolver.Name(UiCatalog.Prop(nested[k], "SourceBlock"));
            if (src == null || !ctx.ByName.TryGetValue(src, out var nb)) continue;
            var args = (UiCatalog.Prop(nested[k], "Arguments") as System.Collections.IEnumerable)?.Cast<object>().ToList() ?? new List<object>();
            foreach (var i in nb.Inputs.Where(i => i.Mandatory))
            {
                var arg = args.FirstOrDefault(a => string.Equals(TypeResolver.Name(UiCatalog.Prop(a, "Parameter")), i.Name, StringComparison.OrdinalIgnoreCase));
                if (arg != null && UiCatalog.Prop(arg, "Value") is IExpression ex && !string.IsNullOrWhiteSpace(ex.Text)) continue;
                BindInput(ops, ctx, $"{alias}/**{ctx.InstType}[{k + 1}]", $"{name}_{src}{k + 1}", i);
            }
        }
        return ops;
    }

    private static string? ValueFor(UiParam i, IReadOnlyDictionary<string, UiStaticEntity> statics)
    {
        if (!string.IsNullOrWhiteSpace(i.Default)) return i.Default;
        var t = i.Type;
        if (t.EndsWith(" Identifier"))
        {
            var ent = t[..^11];
            if (statics.TryGetValue(ent, out var s) && s.Records.Count > 0) return $"Entities.{s.Name}.{s.Records[0].Id}";
            return "NullIdentifier()";
        }
        return t switch
        {
            "Text" or "Phone Number" or "Email" => "\"Sample\"",
            "Integer" or "Long Integer" or "Decimal" or "Currency" => "1",
            "Boolean" => "True",
            "Date Time" => "CurrDateTime()",
            "Date" => "CurrDate()",
            "Time" => "CurrTime()",
            _ => null,
        };
    }

    private static string? OwnerBlock(JsonObject o)
    {
        foreach (var key in new[] { "as", "parent", "target", "from" })
        {
            if (o[key]?.GetValue<string>() is not { } v) continue;
            if (v.StartsWith("$G_", StringComparison.Ordinal)) return v[3..].Split('/', '_')[0];
            if (v.StartsWith("$v_", StringComparison.Ordinal) || v.StartsWith("$h_", StringComparison.Ordinal)) return v[3..].Split('1')[0];
            if (v.StartsWith("$") && v.Length > 2 && char.IsUpper(v[1]) && v.Contains('1')) return v[1..].Split('1')[0];
        }
        return null;
    }

    private static string Report(List<GalleryBlockResult> rs, string runtime, int objects, int msgs)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"# Galeria de widgets {runtime}: {rs.Count} blocos, {objects} objetos, {msgs} mensagens do Verify");
        sb.AppendLine();
        foreach (var g in rs.GroupBy(r => r.Status).OrderBy(g => g.Key)) sb.AppendLine($"- {g.Key}: {g.Count()}");
        sb.AppendLine();
        sb.AppendLine("| Modulo | Flow | Bloco | Estado | Ops | Detalhe |");
        sb.AppendLine("|---|---|---|---|---|---|");
        foreach (var r in rs.OrderBy(r => r.Module).ThenBy(r => r.Flow).ThenBy(r => r.Block))
        {
            var detail = r.Error ?? string.Join(" ; ", r.Messages.Take(3));
            sb.AppendLine($"| {r.Module} | {r.Flow} | {r.Block} | {r.Status} | {r.Ops} | {detail.Replace("|", "/").Replace("\n", " ")} |");
        }
        return sb.ToString();
    }

    private static JsonObject Op(params (string Key, object Value)[] fields)
    {
        var o = new JsonObject();
        foreach (var (k, v) in fields) o[k] = v switch { string s => JsonValue.Create(s), bool b => JsonValue.Create(b), int i => JsonValue.Create(i), _ => JsonValue.Create(v.ToString()) };
        return o;
    }

    private static JsonObject Clone(JsonObject o) => JsonNode.Parse(o.ToJsonString())!.AsObject();
    private static string Safe(string s) { var sb = new StringBuilder(); foreach (var c in s) sb.Append(char.IsLetterOrDigit(c) || c == '_' ? c : '_'); return sb.ToString(); }
    private static string Unwrap(Exception ex) { while (ex is System.Reflection.TargetInvocationException { InnerException: not null } t) ex = t.InnerException!; return ex.GetType().Name + ": " + ex.Message; }
}
