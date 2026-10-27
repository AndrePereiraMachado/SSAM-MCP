using System.Collections;
using System.Diagnostics;
using System.Globalization;
using System.Reflection;
using System.Text.Json.Nodes;
using Anvil.Reading;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>
/// The document form of the html op (B1, ScreenDocument): one &lt;screen&gt; or &lt;block&gt; in ssam-html/1 compiled straight
/// into the model in declaration/content phases, with the parent in hand (the direct builder: no op per widget).
/// The text is the one the reading writes (ScreenHtml, C1): every attribute is a property of the table or os-&lt;Property&gt;
/// with the value as the model keeps it, every reference a name the reading's rules resolve (the document's own elements
/// first, then the module, the references and the types), every event Destination(Param = expression, ...). A property the
/// text does not name is at its default (ScreenDefaults, the installed Studio's): what a new widget is born with is reset, so
/// what the document says is what the model holds. Every problem (syntax, names, the owner's rules) is collected and the
/// op fails once with all of them; nothing of a failed op is kept (the apply discards the candidate).
/// </summary>
public sealed partial class ModelSession
{
    /// <summary>The literal-certainty scope, shared by production and corpus checks. Every named native node counts,
    /// including reference signatures and record/attribute members; no role or action-body filter narrows it.</summary>
    internal IReadOnlySet<string> LiteralScopeNames(IEnumerable<string>? jobNames = null)
    {
        var names = new HashSet<string>(FunctionCatalog.Names, StringComparer.OrdinalIgnoreCase);
        if (jobNames != null) names.UnionWith(jobNames.Where(n => !string.IsNullOrEmpty(n)));
        var pending = new Stack<IObjectSignature>(); pending.Push((IObjectSignature)_espace);
        var seen = new HashSet<IObjectSignature>(ReferenceEqualityComparer.Instance);
        var reader = new KernelModelReader();
        while (pending.TryPop(out var node)) {
            if (!seen.Add(node)) continue;
            try { if (node.WasDeleted) continue; } catch (NotImplementedException) { /* Signatures without this getter still contribute their names and children. */ }
            try { if (TypeResolver.Name(node) is { Length: > 0 } name) names.Add(name); } catch (TargetInvocationException) { }
            try { if (reader.DisplayOf(node) is { Length: > 0 } display) names.Add(display); } catch (TargetInvocationException) { }
            foreach (var child in node.Children.OfType<IObjectSignature>()) pending.Push(child);
        }
        return names;
    }
    private sealed record PreparedDocument(DocumentCompiler Compiler, Func<JsonObject> Finish, JsonArray Shells,
        List<JsonObject> Marked, List<string> FlowShells, DocumentOptions Options, string Html, HtmlJob? Job);
    private Dictionary<JsonObject, PreparedDocument>? _preparedDocuments;
    private Dictionary<JsonObject, Exception>? _documentDeclarationErrors;
    private bool _preparingDocuments;

    private void PrepareUiDeclarations()
    {
        if (_applyOps == null || _preparedDocuments != null || _espace.ESpaceType.ToString() is "WebResponsive" or "WebResponsiveLibrary") return;
        _preparedDocuments = new(); _documentDeclarationErrors = new(); _preparingDocuments = true;
        var current = _applyIndex;
        try
        {
            foreach (var candidate in _applyOps.OfType<JsonObject>().Where(ScreenDocument.IsDocumentOp))
            {
                var position = _applyOps.IndexOf(candidate);
                if (SkipOps?.Contains(position) == true) continue;
                _applyIndex = position;
                try { HtmlDocument(candidate); }
                catch (Exception error) { _documentDeclarationErrors[candidate] = error; }
            }
        }
        finally { _preparingDocuments = false; _applyIndex = current; }
    }

    private void PrepareUiForLogic(JsonObject op)
    {
        if (_preparedDocuments != null) return;
        var localOps = new JsonArray(op.DeepClone());
        if (HtmlJob.FlowActions(localOps).Count > 0 || HtmlJob.From(localOps, 0)?.Actions.Any(a => a.Kind is "screen" or "block" or "data") == true)
            PrepareUiDeclarations();
    }

    /// <summary>What a caller inside the kernel adds to a document compile (the recreation proof, the job's shells).</summary>
    internal sealed class DocumentOptions
    {
        /// <summary>Where the root is created; else the document's flow attribute, else the module's UI flow.</summary>
        public IObjectSignature? Flow;
        /// <summary>A root whose elements never answer a name (the screen a recreation replaces).</summary>
        public IObjectSignature? Exclude;
        /// <summary>k -> ObjectKey of the reading the document is based on: an element with one of these k exists, so what
        /// it has (Visible, JavaScript, JSON) is kept and listed, never refused.</summary>
        public IReadOnlyDictionary<string, string>? ReadKeys;
        /// <summary>The text of that reading, when the store keeps it: an element with k keeps only the markers of the engine it
        /// was read with (review 2, M4).</summary>
        public string? ReadHtml;
        /// <summary>Runs after the root and its data exist, before the widgets and the events (actions that the document
        /// names and does not create are declared here: the job's logic ops, the recreation's move).</summary>
        public Action<IObjectSignature>? BeforeContent;
        /// <summary>The original of an os-opaque element of the reading (by its k): copied natively, untouched.</summary>
        public Func<string, IObjectSignature?>? Opaque;
        /// <summary>The original of an os-opaque element is moved (the platform's move), not copied: the recreation, whose
        /// original goes away.</summary>
        public bool MoveOpaque;
        /// <summary>The actions a logic op of the same job declares for a root (its interface name, its name): a data action
        /// named in data-actions="..." is created by that op after the document (no event binds to it).</summary>
        public Func<string, string, IReadOnlyCollection<string>>? DeclaredBy;
        /// <summary>The names the ops of the job declare (actions, entities, structures, created elements): an expression may
        /// name one that a later op creates, which the Verify of the page alone would call unknown.</summary>
        public IReadOnlySet<string>? JobNames;
        /// <summary>The check of a corrected document before it is offered as a patch: the Verify's word on its expressions is
        /// read even when nothing else is wrong (a name the correction wrote that the module does not have).</summary>
        public bool CheckExpressions;
        /// <summary>The op's data.css: the end of the root's own style sheet, after the &lt;style&gt; blocks of the document.</summary>
        public string? Css;
        /// <summary>F5: the compile of a root's signature before the first op (JobComposition.Signature: the root, its inputs
        /// and events), which the document's own op fills later: no theme, no visual notes.</summary>
        public bool Declaration;
    }

    /// <summary>The names every op of the job declares: the actions of logic ops, the entities, statics and structures of
    /// spec ops, the names of create ops and the roots of other html documents.</summary>
    private static HashSet<string> JobDeclaredNames(IEnumerable<JsonNode?> ops)
    {
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var op in ops.OfType<JsonObject>())
        {
            switch (op["op"]?.ToString())
            {
                case "logic":
                    foreach (var action in (op["data"]?["actions"] as JsonArray ?? new JsonArray()).OfType<JsonObject>()) if (action["name"]?.ToString() is { Length: > 0 } a) names.Add(a);
                    break;
                case "spec":
                    foreach (var section in new[] { "entities", "clientEntities", "static", "structures" })
                        foreach (var record in (op["data"]?[section] as JsonArray ?? new JsonArray()).OfType<JsonObject>()) if (record["name"]?.ToString() is { Length: > 0 } n) names.Add(n);
                    // Familias: what a data text declares at its top level (client variables, site properties, entities,
                    // structures): a later spec op of the job declares them too (Client.MockPlaceCount, VisitaCerta_UI).
                    if (op["data"]?["ddl"] is JsonValue ddl && ddl.TryGetValue<string>(out var text))
                        try { foreach (var e in Anvil.Reading.DdlParser.Parse(text, MessageExpectations.Lane).Elements) if (e.Name.Length > 0) names.Add(e.Name); }
                        catch { /* the text's own refusal says why */ }
                    break;
                case "create":
                    if (op["name"]?.ToString() is { Length: > 0 } created) names.Add(created);
                    break;
            }
        }
        return names;
    }

    // Additional names used only to decide literal certainty, never to suppress an unknown-name diagnostic. Null when an op
    // cannot be read: a data.flow that is no text (FlowTextForm.Texts refuses it with FLOW_SYNTAX), a flow, html or ddl text
    // that does not parse, a data that is no object. The scope is then unreadable and every literal of the document is a
    // choice: the unreadable op says what is wrong with it in the same refusal, never instead of the document's problems.
    private static HashSet<string>? LiteralJobNames(IEnumerable<JsonNode?> ops)
    {
        try {
            var list = ops.ToList();
            var names = JobDeclaredNames(list);
            void JsonNames(JsonNode? node) {
                if (node is JsonObject obj) foreach (var (key, value) in obj) {
                    if (key is "name" or "id" or "as" && value is JsonValue scalar && scalar.TryGetValue<string>(out var name) && name.Length > 0) names.Add(name);
                    JsonNames(value);
                }
                else if (node is JsonArray array) foreach (var item in array) JsonNames(item);
            }
            void FlowNames(FlowItem item) { if (item.Name.Length > 0) names.Add(item.Name); foreach (var child in item.Items) FlowNames(child); }
            foreach (var op in list.OfType<JsonObject>()) {
                JsonNames(op);
                if (op["op"]?.ToString() == "reference")
                    foreach (var element in (op["elements"] as JsonArray ?? []).OfType<JsonValue>())
                        if (element.TryGetValue<string>(out var typed) && typed.Split(':', 2) is [_, var name] && name.Length > 0) names.Add(name);
                if (op["data"] is JsonObject data && data["flow"] != null)
                    foreach (var flow in FlowTextForm.Texts(data)) FlowNames(ModuleFlow.Read(flow.Text));
                // ssam-html (a whole document, or the elements of an edit) is read by its own parser. The expander's page and
                // fragment forms are HTML, not ssam-html (review x3-4, R1b: a valid page made the scope unreadable): their names
                // are the ones the expander creates (data-av keys, ids, the screen and its variables), as Collect reads them. A
                // page the HTML parser cannot read leaves the scope unreadable, like any other op.
                if (op["data"]?["html"] is JsonValue html && html.TryGetValue<string>(out var text)) {
                    if (ScreenDocument.IsDocument(text) || ScreenHtmlEdit.IsEdit(op)) {
                        foreach (var (element, _) in ScreenHtmlText.Elements(ScreenHtml.Parse(text)))
                            foreach (var key in new[] { "name", "id" }) if (element.Get(key) is { Length: > 0 } name) names.Add(name);
                    }
                    else {
                        HtmlSource.Parse(text);
                        foreach (var created in HtmlExpander.CreatedNames(op["data"]!.AsObject())) names.Add(created);
                    }
                }
                if (op["data"]?["ddl"] is JsonValue ddl && ddl.TryGetValue<string>(out var source))
                    foreach (var element in DdlParser.Parse(source, MessageExpectations.Lane).All()) if (element.Name.Length > 0) names.Add(element.Name);
            }
            return names;
        }
        catch (Exception) { return null; }
    }

    private static readonly string[] PageKinds = ["IMobileScreen", "IMobileBlock", "IWebScreen", "IWebBlock"];

    /// <summary>The names a page declares, for the one-slip rule of literal certainty (option B of the owner, 2026-10-17): the
    /// page and every named node under it (its variables, inputs, aggregates, widgets, actions and theirs). The compile of a
    /// document adds the job's names; the corpus checks read each page of a capture with this same function.</summary>
    internal static HashSet<string> LiteralPageNames(IObjectSignature page)
    {
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var pending = new Stack<IObjectSignature>(); pending.Push(page);
        var seen = new HashSet<IObjectSignature>(ReferenceEqualityComparer.Instance);
        while (pending.TryPop(out var node)) {
            if (!seen.Add(node)) continue;
            try { if (node.WasDeleted) continue; } catch (NotImplementedException) { }
            try { if (TypeResolver.Name(node) is { Length: > 0 } name) names.Add(name); } catch (TargetInvocationException) { }
            foreach (var child in node.Children.OfType<IObjectSignature>()) pending.Push(child);
        }
        return names;
    }

    /// <summary>Every screen and block of the module (references excluded) with the names it declares (LiteralPageNames).</summary>
    internal IReadOnlyList<(string Page, IReadOnlySet<string> Names)> LiteralDeclaredNamesByPage()
    {
        var pages = new List<(string, IReadOnlySet<string>)>();
        var pending = new Stack<IObjectSignature>(); pending.Push((IObjectSignature)_espace);
        while (pending.TryPop(out var node)) {
            if (Implements(node, "IReference")) continue;
            if (PageKinds.Any(kind => Implements(node, kind))) { pages.Add((TypeResolver.Name(node) ?? "", LiteralPageNames(node))); continue; }
            foreach (var child in node.Children.OfType<IObjectSignature>()) pending.Push(child);
        }
        return pages;
    }

    private static bool OwnedBy(HtmlJobAction action, string rootType, string rootName) =>
        action.Owner.Equals(rootType + ":" + rootName, StringComparison.OrdinalIgnoreCase) || action.Owner.Equals("$html." + rootName, StringComparison.OrdinalIgnoreCase)
        || action.Owner.Equals("IMobileScreen:" + rootName, StringComparison.OrdinalIgnoreCase) || action.Owner.Equals("IMobileBlock:" + rootName, StringComparison.OrdinalIgnoreCase);

    /// <summary>An action of the job that belongs to this root: a JSON declaration by its owner reference, a flow text by the
    /// owner its header writes (the root's name, or its Flow/Name path).</summary>
    private static bool OwnedBy(HtmlJobAction action, IObjectSignature root)
    {
        var rootName = TypeResolver.Name(root) ?? "";
        if (!action.Flow) return OwnedBy(action, root.GetInterface()?.Name ?? "", rootName);
        return action.Owner.Equals(rootName, StringComparison.OrdinalIgnoreCase)
            || root.Parent is IObjectSignature flow && action.Owner.Equals(TypeResolver.Name(flow) + "/" + rootName, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>html {data:{html:"&lt;screen ...&gt;"}}: the document form. The screen or block is new; its actions are declared
    /// by the logic ops of the same job (born here as shells with their inputs, filled by the logic op in place, H10).</summary>
    private JsonNode HtmlDocument(JsonObject op)
    {
        if (!_preparingDocuments && _applyOps != null && _espace.ESpaceType.ToString() is not ("WebResponsive" or "WebResponsiveLibrary"))
        {
            if (_preparedDocuments == null)
            {
                PrepareUiDeclarations();
            }
            if (_documentDeclarationErrors!.TryGetValue(op, out var declarationError)) throw declarationError;
            if (_preparedDocuments.TryGetValue(op, out var prepared)) return FinishDocument(op, prepared);
        }
        var data = op["data"]!.AsObject();
        var html = data["html"]!.GetValue<string>();
        var options = new DocumentOptions { Css = data["css"] is JsonValue css && css.TryGetValue<string>(out var cssText) ? cssText : null };
        if (data["basedOn"] is JsonObject basedOn && basedOn["capture"]?.ToString() is { Length: > 0 } capture && basedOn["html"]?.ToString() is { Length: > 0 } htmlSha
            && ModuleIndexStore.Default()?.LoadHtmlKeys(capture, htmlSha, BaseSha256) is { } stored && stored["keys"] is JsonObject keys)
        {
            options.ReadKeys = keys.Where(k => k.Value is JsonValue).ToDictionary(k => k.Key, k => k.Value!.ToString(), StringComparer.Ordinal);
            options.ReadHtml = stored["html"] is JsonValue readHtml && readHtml.TryGetValue<string>(out var readText) ? readText : null;
        }
        var inJob = _applyOps != null && _applyIndex < _applyOps.Count && ReferenceEquals(_applyOps[_applyIndex], op);
        var job = inJob ? HtmlJob.From(_applyOps, _applyIndex) : null;
        var shells = new JsonArray();
        var marked = new List<JsonObject>();
        var flowShells = new List<string>();
        if (job != null)
        {
            // The actions the job declares: the JSON declarations of its logic ops and the flow texts that name an owner.
            var declaredActions = job.Actions.Concat(HtmlJob.FlowActions(_applyOps)).ToList();
            IObjectSignature? created = null;
            options.BeforeContent = root => { created = root; DocumentShells(root, declaredActions, shells, marked, flowShells); };
            options.DeclaredBy = (rootType, rootName) => declaredActions.Where(a => a.Flow ? created != null && OwnedBy(a, created) : OwnedBy(a, rootType, rootName)).Select(a => a.Name).ToList();
            var names = JobDeclaredNames(_applyOps!);
            foreach (var flowAction in declaredActions.Where(a => a.Flow)) names.Add(flowAction.Name);
            options.JobNames = names;
        }
        if (_espace.ESpaceType.ToString() is "WebResponsive" or "WebResponsiveLibrary") {
            try {
                var traditional = new TraditionalDocumentCompiler(this, html, options).Run();
                if (shells.Count > 0) traditional["sameJobScreenActions"] = shells;
                return traditional;
            } catch {
                foreach (var declaration in marked) declaration.Remove("replace");
                foreach (var key in flowShells) _flowShells.Remove(key);
                throw;
            }
        }
        // The apply rebases a coded problem of an html op without parent onto its data (Verbs.Collect.ApplyProblems).
        var compiler = new DocumentCompiler(this, html, "/html", options);
        Func<JsonObject> finish;
        try { finish = compiler.Prepare(); }
        catch
        {
            compiler.Discard();
            foreach (var declaration in marked) declaration.Remove("replace");
            foreach (var key in flowShells) _flowShells.Remove(key);
            throw;
        }
        var plan = new PreparedDocument(compiler, finish, shells, marked, flowShells, options, html, job);
        if (_preparingDocuments)
        {
            _preparedDocuments![op] = plan;
            return new JsonObject { ["phase"] = "declarations" };
        }
        return FinishDocument(op, plan);
    }

    private JsonNode FinishDocument(JsonObject op, PreparedDocument plan)
    {
        var (compiler, finish, shells, marked, flowShells, options, html, job) = plan;
        var inJob = _applyOps != null && _applyIndex < _applyOps.Count && ReferenceEquals(_applyOps[_applyIndex], op);
        JsonObject report;
        // A refused document leaves nothing behind: the apply goes on with the other ops and runs the Verify of what did
        // apply, which must not judge half a page (an image whose name was wrong, a block without its block).
        try { report = finish(); }
        catch (KernelRefusalException refusal)
        {
            compiler.Discard();
            // The logic ops go back to what the job said: with the shells gone, they create (and fail on the missing owner,
            // skipped as dependents of this op) instead of replacing an action that is not there.
            foreach (var declaration in marked) declaration.Remove("replace");
            foreach (var key in flowShells) _flowShells.Remove(key);
            // B4: a corrected document is offered only when it compiles (its expressions read by the Verify) with no problem but
            // the ones nothing corrects.
            if ((refusal.Data["correctedHtml"] is string || refusal.Data["correctedCss"] is string) && compiler.Problems.Count > 0)
                throw CheckedDocumentRefusal([.. compiler.Problems], html, job, options.ReadKeys, options.Css);
            throw;
        }
        if (shells.Count > 0) report["sameJobScreenActions"] = shells;
        // Every class the document uses has its rule, or the delivery says which have none (a warning: the page shows them
        // without style), with where else they are written and, when another document of this job carries them in its own
        // <style>, the patch that puts that <style> in the theme.
        if (compiler.ClassesWithoutRule() is { } missing)
        {
            var suggestion = ThemeSuggestion(missing);
            report["classesWithoutRule"] = missing.DeepClone();
            var names = missing["classes"]!.AsArray().Select(c => c!["class"]!.ToString()).ToList();
            // A theme of another module in the chain the page reads (goal list of 2026-10-20, item 12): its CSS is not in this capture, so
            // the classes may well have their rules there; the warning says so and is not high.
            var foreignTheme = missing["themeElsewhere"]?.ToString() is { Length: > 0 } t ? t : null;
            var warning = new JsonObject
            {
                ["code"] = ScreenDocument.ClassNoRule, ["severity"] = foreignTheme != null ? "medium" : "high", ["op"] = inJob ? JsonValue.Create(_applyIndex) : null, ["owner"] = missing["root"]?.ToString(),
                ["message"] = $"{missing["root"]} uses {names.Count} class(es) that no rule of its style sheet, the module theme or OutSystems UI defines" + (foreignTheme != null ? "" : ", so the page shows them without style") + ": "
                    + string.Join(", ", names.Take(12)) + (names.Count > 12 ? ", ..." : "") + (missing["elsewhere"] is JsonObject elsewhere && elsewhere.Count > 0
                        ? $"; {string.Join("; ", elsewhere.Select(e => $"{e.Value!.AsArray().Count} defined only in the style sheet of {e.Key}"))} (a screen's style sheet is that screen's)" : "")
                    + (foreignTheme != null ? $"; the page reads the theme {foreignTheme} of another module, whose CSS is not in this capture: these classes may be defined there (this check cannot tell)" : ""),
                ["fix"] = foreignTheme != null
                    ? $"when {foreignTheme} defines them nothing is missing (read its style sheet with ssam_map on that module); otherwise define them in this document's <style>, or once in a theme of this module with <style scope=\"theme\">"
                    : "define them in this document's <style>, or once in the theme with <style scope=\"theme\"> when other pages use them" + (suggestion != null ? "; the suggestion's patch puts the <style> of the document that has them in the theme" : ""),
            };
            if (foreignTheme != null) { warning["maybeDefinedIn"] = foreignTheme; warning["uncertain"] = true; }
            if (suggestion != null) { warning["suggestion"] = suggestion; report["classesWithoutRule"]!["suggestion"] = suggestion.DeepClone(); }
            Report("highWarnings", warning);
        }
        if (compiler.VisualCheck() is { } visual) VisualReport(report, visual, inJob ? _applyIndex : null);   // CX17 F8: one warning per family per job
        return report;
    }

    /// <summary>When the classes a document lacks are written in the own &lt;style&gt; of another document op of this job (a
    /// prototype's CSS given with its first screen), the patch that puts that &lt;style&gt; in the theme (scope="theme"), so every
    /// page has them; checked: the patched document places that CSS in the theme and its classes cover the ones it names.</summary>
    private JsonObject? ThemeSuggestion(JsonObject missing)
    {
        if (_applyOps == null) return null;
        var wanted = missing["classes"]!.AsArray().Select(c => c!["class"]!.ToString()).ToHashSet(StringComparer.Ordinal);
        for (var i = 0; i < _applyOps.Count; i++)
        {
            if (i == _applyIndex || _applyOps[i] is not JsonObject other || !ScreenDocument.IsDocumentOp(other)) continue;
            var text = other["data"]!["html"]!.GetValue<string>();
            ScreenHtml.Node top;
            try { top = ScreenHtml.Parse(text).Children.First(c => !c.IsText && c.Tag is "screen" or "block"); }
            catch (Exception) { continue; }
            var own = ScreenDocument.Styles(top).Where(b => !b.Theme).ToList();
            if (own.Count == 0) continue;
            var covered = wanted.Where(c => own.Any(b => ScreenDocument.CssClasses(b.Css).Contains(c))).ToList();
            if (covered.Count == 0) continue;
            // Every own <style> of that document written as <style scope="theme">: the same CSS, in the theme.
            var patched = System.Text.RegularExpressions.Regex.Replace(text, @"<style(?=[\s>])(?![^>]*\sscope=)", "<style scope=\"theme\"");
            try
            {
                var again = ScreenHtml.Parse(patched).Children.First(c => !c.IsText && c.Tag is "screen" or "block");
                var blocks = ScreenDocument.Styles(again);
                if (blocks.Any(b => !b.Theme) || !covered.All(c => blocks.Any(b => ScreenDocument.CssClasses(b.Css).Contains(c)))) continue;
            }
            catch (Exception) { continue; }
            return new JsonObject
            {
                ["op"] = i, ["root"] = top.Get("name"), ["covers"] = covered.Count,
                ["why"] = $"op #{i} ({top.Get("name")}) writes {covered.Count} of these classes in its own <style>; in the theme they reach every page",
                ["patch"] = new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = $"/ops/{i}/data/html", ["value"] = patched }),
            };
        }
        return null;
    }

    /// <summary>The refusal of a document with its corrected document checked by compiling it in this session (nothing of the check
    /// is kept): every correction first, then only the ones that need no name of the module (an attribute or element removed, an
    /// element wrapped in an If). The corrected document goes as the patch only when its compile has no problem but the ones of
    /// the document that nothing corrects (by code and message); else no patch, each problem with its fix.</summary>
    private KernelRefusalException CheckedDocumentRefusal(List<ScreenDocument.Problem> problems, string html, HtmlJob? job, IReadOnlyDictionary<string, string>? readKeys, string? css)
    {
        foreach (var keep in new Func<ScreenDocument.Correction?, bool>[] { _ => true, c => c is ScreenDocument.RemoveAttribute or ScreenDocument.RemoveElement
                     or ScreenDocument.MoveStyle or ScreenDocument.RewriteStyle or ScreenDocument.RewriteDataCss })
        {
            var subset = problems.Select(p => p.Correction != null && !keep(p.Correction) ? p with { Correct = null, Replace = null } : p).ToList();
            // A correction at an element where the compile of the corrected document finds a fault the document did not have (a
            // button left without On Click) is not certain: it goes, and the others are compiled again.
            for (var round = 0; round < 4; round++)
            {
                if (subset.All(p => p.Correction == null)) break;
                var moved = new Dictionary<(int Line, int Column), (int Line, int Column)>();
                var corrected = ScreenDocument.Correct(html, subset, moved) ?? html;
                // The CSS of the patch: data.css rewritten and every <style> the document cannot place moved to its end.
                var correctedCss = ScreenDocument.CorrectCss(css, subset);
                if (corrected == html && correctedCss == css || !ScreenDocument.RulesPass(corrected, subset, correctedCss)) break;
                if (CheckCompile(corrected, job, readKeys, correctedCss) is not { } remaining) break;
                var allowed = subset.Where(p => p.Correction == null).Select(p => p.Code + "\u0001" + p.Message).ToList();
                var extra = remaining.Where(r => !allowed.Remove(r.Code + "\u0001" + r.Message)).ToList();
                // Integration 24-1 familias (review): a fault an earlier phase of this job already reported on this op, with the
                // Verify message it predicts (OPERAND_TYPES of an aggregate: OperatorIncompatibleTypes), is that problem, which
                // its own patch corrects (JobRunner.DocumentPatches composes both and proves the whole by its compile).
                if (KnownProblems is { Count: > 0 } known && _applyOps != null)
                {
                    var predicted = known.Where(k => k["op"] is JsonValue kv && kv.TryGetValue<int>(out var at) && at == _applyIndex && k["verifyCode"]?.ToString() is { Length: > 0 })
                        .Select(k => k["verifyCode"]!.ToString()).ToList();
                    extra.RemoveAll(e => predicted.FirstOrDefault(code => e.Message.Contains("(" + code + ":", StringComparison.Ordinal)) is { } code && predicted.Remove(code));
                }
                // A fault at an element whose problem nothing corrects is that problem again (a button left with its javascript:
                // has no On Click either).
                extra.RemoveAll(e => subset.Any(p => p.Correction == null && moved.TryGetValue((p.Line, p.Column), out var now) && now == (e.Line, e.Column)));
                if (extra.Count == 0) return ScreenDocument.Refusal(subset, html, "/html", corrected, css, correctedCss);
                var culprits = subset.Where(p => p.Correction != null && moved.TryGetValue((p.Line, p.Column), out var now) && extra.Any(e => e.Line == now.Line && e.Column == now.Column)).ToList();
                if (culprits.Count == 0)
                {
                    // Integration 24-1 familias (review): a fault no correction caused (at an element no correction touched) is the
                    // document's own, which the refused compile had not read yet (it reads only the expressions; an aggregate
                    // without Max. Records): a problem of this same refusal, without a patch, and the corrected document the patch
                    // of the others. Never a refusal now and that fault in the next round.
                    var own = extra.Select(e => e with { Message = e.Message + " (found by the compile of the corrected document; its line there)", Correct = null, Replace = null, Patch = null })
                        .Where(e => !subset.Any(p => p.Code == e.Code && p.Message == e.Message)).ToList();
                    return ScreenDocument.Refusal([.. subset, .. own], html, "/html", corrected, css, correctedCss);
                }
                subset = subset.Select(p => culprits.Contains(p) ? p with { Correct = null, Replace = null } : p).ToList();
            }
        }
        return ScreenDocument.Refusal(problems.Select(p => p with { Correct = null, Replace = null }).ToList(), html, "/html", null, css, css);
    }

    /// <summary>Integration 24-1 familias (review): the problems the earlier phases of the job (the preflight, the base) already
    /// reported, set by JobRunner before the apply: the check of a corrected document does not count again a fault one of them
    /// predicts on the same op (its verifyCode).</summary>
    internal IReadOnlyList<JsonObject>? KnownProblems { get; set; }

    /// <summary>Integration 24-1 familias (review): the compile of a document a refusal composed from several corrections of one
    /// html op (JobRunner.DocumentPatches), after the apply, in its own command, with nothing of it kept: the problems it still
    /// has (code and message), or null when the check could not run. A root of the same name the apply created is renamed out
    /// of the way for the check and put back.</summary>
    internal List<(string Code, string Message)>? CheckComposedDocument(JsonArray ops, int op, string html, string? css)
    {
        if (op < 0 || op >= ops.Count || ops[op] is not JsonObject jobOp || jobOp["data"] is not JsonObject data) return null;
        List<ScreenDocument.Problem>? remaining = null;
        var (savedOps, savedIndex) = (_applyOps, _applyIndex);
        try
        {
            StudioAdapter.Runtime.Mutate(_espace, "Anvil: check a composed document", _ =>
            {
                _applyOps = ops; _applyIndex = op;
                IReadOnlyDictionary<string, string>? readKeys = null;
                if (data["basedOn"] is JsonObject basedOn && basedOn["capture"]?.ToString() is { Length: > 0 } capture && basedOn["html"]?.ToString() is { Length: > 0 } htmlSha
                    && ModuleIndexStore.Default()?.LoadHtmlKeys(capture, htmlSha, BaseSha256)?["keys"] is JsonObject keys)
                    readKeys = keys.Where(k => k.Value is JsonValue).ToDictionary(k => k.Key, k => k.Value!.ToString(), StringComparer.Ordinal);
                string? name = null;
                try { name = ScreenHtml.Parse(html).Children.FirstOrDefault(c => !c.IsText && c.Tag is "screen" or "block")?.Get("name"); } catch (FormatException) { }
                IObjectSignature? existing = null; string? existingName = null;
                if (name != null)
                    foreach (var flow in ((IObjectSignature)_espace).Children.OfType<IObjectSignature>())
                    {
                        existing = flow.Children.OfType<IObjectSignature>().FirstOrDefault(c => (Implements(c, "IMobileScreen") || Implements(c, "IMobileBlock") || Implements(c, "IWebScreen") || Implements(c, "IWebBlock"))
                            && string.Equals(TypeResolver.Name(c), name, StringComparison.OrdinalIgnoreCase));
                        if (existing != null) break;
                    }
                if (existing != null) { existingName = TypeResolver.Name(existing); FindProperty(existing, "Name")!.SetValue(existing, existingName + "_ComposedCheck"); }
                try { remaining = CheckCompile(html, HtmlJob.From(ops, op), readKeys, css); }
                finally { if (existing != null) FindProperty(existing, "Name")!.SetValue(existing, existingName); }
            });
        }
        catch (Exception) { return null; }
        finally { (_applyOps, _applyIndex) = (savedOps, savedIndex); }
        return remaining?.Select(p => (p.Code, p.Message)).ToList();
    }

    // The problems of a compile of the document (none when it compiles, its expressions read by the Verify), with nothing of it
    // kept (the root and the job's shells go, the logic ops keep what the job said); null when the check itself could not run.
    private List<ScreenDocument.Problem>? CheckCompile(string document, HtmlJob? job, IReadOnlyDictionary<string, string>? readKeys, string? css)
    {
        var options = new DocumentOptions { ReadKeys = readKeys, CheckExpressions = true, Css = css };
        var marked = new List<JsonObject>();
        var flowShells = new List<string>();
        if (job != null)
        {
            // The job's actions as the document's own compile declares them: the JSON declarations and the flow texts that name
            // an owner (their shells go with the check).
            var shells = new JsonArray();
            var declaredActions = job.Actions.Concat(HtmlJob.FlowActions(_applyOps)).ToList();
            IObjectSignature? created = null;
            options.BeforeContent = root => { created = root; DocumentShells(root, declaredActions, shells, marked, flowShells); };
            options.DeclaredBy = (rootType, rootName) => declaredActions.Where(a => a.Flow ? created != null && OwnedBy(a, created) : OwnedBy(a, rootType, rootName)).Select(a => a.Name).ToList();
            var names = JobDeclaredNames(_applyOps!);
            foreach (var flowAction in declaredActions.Where(a => a.Flow)) names.Add(flowAction.Name);
            options.JobNames = names;
        }
        var check = new DocumentCompiler(this, document, "/html", options);
        try { check.Run(); return []; }
        catch (KernelRefusalException) { return [.. check.Problems]; }
        catch (Exception) { return null; }
        finally
        {
            check.Discard();
            foreach (var declaration in marked) declaration.Remove("replace");
            foreach (var key in flowShells) _flowShells.Remove(key);
        }
    }

    /// <summary>H10 for the document form: the actions the root names (actions="..."), that a logic op of this job declares for
    /// it, are born before the content with their inputs and outputs (a Start and an End), so the events bind to them; the
    /// logic op rewrites each body in place keeping its key (replace). A flow text fills its shell the same way: the shell is
    /// kept in _flowShells, and the text without @key that names it is the edit of the shell (its key, its Start and its
    /// parameters stay).</summary>
    private void DocumentShells(IObjectSignature root, IReadOnlyList<HtmlJobAction> actions, JsonArray shells, List<JsonObject> marked, List<string> flowShells)
    {
        foreach (var action in actions.Where(a => a.Kind is "screen" or "block" && OwnedBy(a, root)))
        {
            if (root.Children.OfType<IObjectSignature>().Any(c => Implements(c, "IScreenAction") && string.Equals(TypeResolver.Name(c), action.Name, StringComparison.OrdinalIgnoreCase))) continue;
            var shell = (IObjectSignature)NewChild(root, "IScreenAction", action.Name);
            // A flow text writes its types as the reader does: a type this side does not read stays the Studio's until the
            // text sets it (FlowDiff writes the DataType that differs).
            void Typed(object parameter, string type)
            {
                object dataType;
                try { dataType = LogicDataType(type); }
                catch (Exception) when (action.Flow) { return; }
                FindProperty(parameter, "DataType")!.SetValue(parameter, dataType);
            }
            foreach (var input in action.Inputs) Typed(NewChild(shell, "IInputParameter", input.Name), input.Type);
            foreach (var output in action.Outputs) Typed(NewChild(shell, "IOutputParameter", output.Name), output.Type);
            var start = NewChild(shell, "IStartNode", null); var end = NewChild(shell, "IEndNode", null);
            Link(new JsonObject { ["op"] = "link", ["from"] = "@" + ((IObjectSignature)start).ObjectKey, ["to"] = "@" + ((IObjectSignature)end).ObjectKey });
            Anchor(shell, created: true);
            if (action.Flow)
            {
                // The flow text that declares it fills it in place (PlanFlowText: a text without @key on a shell of this job).
                var key = shell.ObjectKey!.ToString()!;
                _flowShells.Add(key); flowShells.Add(key);
            }
            // The logic op that declares it rewrites the body in place (the stable-signature replace keeps the key).
            else if (_applyOps![action.Op] is JsonObject logic && logic["data"]?["actions"] is JsonArray declared)
                foreach (var declaration in declared.OfType<JsonObject>())
                    if (string.Equals(declaration["name"]?.ToString(), action.Name, StringComparison.OrdinalIgnoreCase) && declaration["replace"] == null)
                    {
                        declaration["replace"] = true;
                        marked.Add(declaration);
                    }
            var entry = new JsonObject { ["name"] = action.Name, ["filledBy"] = action.Op };
            if (action.Flow) entry["form"] = "flow";
            shells.Add(entry);
        }
    }

    /// <summary>Creates a child of a type by name through the Model API's Create forms of the parent (the create verb's
    /// lookup, without an op): named when the form takes a name; args by parameter name.</summary>
    private object NewChild(object parent, string type, string? name, IReadOnlyDictionary<string, object?>? args = null)
    {
        var options = FindCreate(parent, type);
        if (options.Count == 0) throw new InvalidOperationException($"{Describe(parent)} cannot create {type}");
        var failures = new List<string>();
        foreach (var (method, generic, target) in options)
        {
            var m = generic ? method.MakeGenericMethod(target) : method;
            var ps = m.GetParameters();
            if (args != null && args.Keys.Any(k => !ps.Any(p => string.Equals(p.Name, k, StringComparison.OrdinalIgnoreCase)))) continue;
            var values = new object?[ps.Length];
            var fits = true;
            for (var k = 0; k < ps.Length; k++)
            {
                var p = ps[k];
                if (p.Name == "name" && p.ParameterType == typeof(string)) { values[k] = name; continue; }
                if (args != null && args.FirstOrDefault(a => string.Equals(a.Key, p.Name, StringComparison.OrdinalIgnoreCase)) is { Key: not null } arg) { values[k] = arg.Value; continue; }
                if (p.ParameterType == typeof(Type)) { values[k] = target; continue; }
                if (p.HasDefaultValue) { values[k] = p.DefaultValue; continue; }
                if (typeof(IObjectSignature).IsAssignableFrom(p.ParameterType) || p.ParameterType.IsInterface) { fits = false; break; }
                values[k] = p.ParameterType.IsValueType ? Activator.CreateInstance(p.ParameterType) : null;
            }
            if (!fits) { failures.Add($"{m.Name} needs {string.Join(", ", ps.Where(p => !p.HasDefaultValue && p.ParameterType.IsInterface).Select(p => p.Name))}"); continue; }
            object? created;
            try { created = m.Invoke(parent, values); }
            catch (TargetInvocationException ex) when (options.Count > 1) { failures.Add($"{target.Name}: {ex.GetBaseException().Message}"); continue; }
            if (created == null) continue;
            if (name != null && ps.All(p => p.Name != "name") && FindProperty(created, "Name") is { CanWrite: true } np) np.SetValue(created, name);
            if (_byKey != null && created is IObjectSignature sig && sig.ObjectKey != null) _byKey[sig.ObjectKey.ToString()!] = sig;
            return created;
        }
        throw new InvalidOperationException($"{Describe(parent)} could not create {type}" + (failures.Count > 0 ? ": " + string.Join(" | ", failures) : ""));
    }

    // The recreation's entry: the compiler of the module's runtime, as the html op chooses it.
    internal JsonObject CompileDocument(string html, string pointer, DocumentOptions options) => _espace.ESpaceType.ToString() is "WebResponsive" or "WebResponsiveLibrary"
        ? new TraditionalDocumentCompiler(this, html, options).Run() : new DocumentCompiler(this, html, pointer, options).Run();

    private sealed partial class DocumentCompiler(ModelSession s, string source, string pointer, DocumentOptions options)
    {
        private readonly KernelModelReader r = new();
        private ScreenHtmlModule<IObjectSignature> index = null!;
        // The defaults of the page compiled: those of its UI flow (ScreenHtmlModule.DefaultsIn).
        private ScreenDefaults defaults = ScreenDefaults.None;
        private readonly List<ScreenDocument.Problem> problems = [];
        private readonly JsonArray preserved = [];
        private readonly JsonArray readOnly = [];
        private readonly Dictionary<string, object> byK = new(StringComparer.Ordinal);
        private readonly Dictionary<string, string> readKeyToK = new(StringComparer.Ordinal);
        // HTML for= reads the id written in this document, even when the native display name is different.
        private readonly Dictionary<string, List<IObjectSignature>> widgetsById = new(StringComparer.Ordinal);
        private readonly Dictionary<ScreenHtml.Node, IObjectSignature> declaredPlaceholders = new();
        private readonly List<Action> targets = [];   // TargetWidget: every widget exists first
        private readonly List<Action> events = [];    // event bindings: after the actions exist
        private readonly HashSet<IObjectSignature> unresolved = new(ReferenceEqualityComparer.Instance); // block instances whose block is unknown
        private readonly Dictionary<string, ScreenHtml.Node> nodeOf = new(StringComparer.Ordinal); // ObjectKey -> the element that wrote it
        private IObjectSignature root = null!;
        private ScreenHtml.Node document = new();
        private string rootKind = "";
        private int widgets, elements, extendedProperties, copied;
        private int version;                          // own elements changed: the tier-0 cache is stale
        private int ownVersion = -1;
        private Dictionary<string, List<IObjectSignature>> own = new(StringComparer.OrdinalIgnoreCase);

        private void Problem(string code, ScreenHtml.Node at, string message, string? fix = null, IReadOnlyList<string>? candidates = null,
            (string, string, string)? replace = null)
            => problems.Add(new(code, at.Line, at.Column, message, fix, candidates, replace));

        /// <summary>Removes the root a refused compile created (and everything in it: widgets, data, the job's shells), and puts
        /// the theme back when this compile wrote its part of it.</summary>
        public void Discard()
        {
            // F5: a root declared before the first op stays as it was declared (the ops that navigate to it keep their
            // destination): only what this compile added goes.
            if (shell != null && root is { WasDeleted: false } declared)
            {
                foreach (var child in declared.Children.OfType<IObjectSignature>().Where(c => !shell.Contains(c)).ToList())
                    try { child.Delete(); } catch (Exception) { /* the apply refuses anyway; the candidate is never saved */ }
            }
            else if (root is { WasDeleted: false } created)
                try { created.Delete(); } catch (Exception) { /* the apply refuses anyway; the candidate is never saved */ }
            RestoreTheme();
        }

        // F5: the children of a root declared before the first op (its inputs and events, JobComposition.Signature) when this
        // compile fills it; null for a root this compile creates.
        private HashSet<IObjectSignature>? shell;
        private readonly HashSet<IObjectSignature> reused = new(ReferenceEqualityComparer.Instance);

        private KernelRefusalException Refuse() => ScreenDocument.CssRefusal(problems, source, pointer, options.Css);

        public JsonObject Run() => Prepare()();

        public Func<JsonObject> Prepare()
        {
            var total = Stopwatch.StartNew();
            try { document = ScreenHtml.Parse(source); }
            catch (FormatException error) { throw ScreenDocument.Refusal([ScreenDocument.ParseProblem(error)], source, pointer); }
            var roots = document.Children.Where(c => !c.IsText || c.Text!.Trim().Length > 0).ToList();
            if (roots.Count != 1 || roots[0].Tag is not ("screen" or "block"))
                throw ScreenDocument.Refusal([new(ScreenDocument.Invalid, 1, 1, "a document is one <screen> or <block> and nothing around it", "wrap the page in <screen name=\"...\"> ... </screen>")], source, pointer);
            var top = roots[0];
            if (options.ReadKeys != null) foreach (var (k, key) in options.ReadKeys) readKeyToK.TryAdd(key, k);
            var indexWatch = Stopwatch.StartNew();
            index = ScreenHtml.Module((IObjectSignature)s._espace, r);
            var indexMs = indexWatch.ElapsedMilliseconds;
            // Without the installed Studio's defaults what the text leaves out has no value to take (a Visible would be written
            // empty and the platform refuses it later, without the reason): refused with the reason, before the model is touched.
            // Here the module's (a new UI flow's: a module where the Studio makes no page has none); the flow's, once it is known.
            if (index.DefaultsIn(null).Note is { Length: > 0 } moduleNote)
            {
                Problem(ScreenDocument.DefaultsMissing, top, "the installed Studio's defaults could not be measured in this module: " + moduleNote,
                    "a document needs them; write it in a module where the Studio creates pages (a UI module), or fix what the reason names");
                throw Refuse();
            }
            // What the document writes in HTML that has one native reading (ScreenHtmlNative: an inline svg, an image by URL, a style
            // with a binding or a decimal), written in it before any check: an element of the reading keeps what it had.
            // Integration 24-1 familias (review): the module's image names (a file name in src), the attributes of a record (the type
            // of a bound src: the job's records, then the module's) and the theme's CSS (a rule for the inside of an svg).
            Preflight.ModelBaseFacts? baseFacts = null;
            Preflight.JobFacts? jobFacts = null;
            IReadOnlyDictionary<string, string>? RecordOf(string name)
            {
                jobFacts ??= s._applyOps != null ? Preflight.JobFacts.From(s._applyOps) : new Preflight.JobFacts();
                if (jobFacts.Records.TryGetValue(name, out var own)) return own;
                try { return (baseFacts ??= new Preflight.ModelBaseFacts(s, s._espace)).Attributes(name); } catch (Exception) { return null; }
            }
            var native = ScreenHtmlNative.Apply(top, _ => true, node => node.Get("k") is { } own && options.ReadKeys?.ContainsKey(own) == true ? node : null,
                form => form.StartsWith('@') ? index.NodeOf(form[1..]) != null : index.Lookup(form, options.Exclude).Count > 0,
                string.Join("\n", ScreenDocument.Styles(top).Select(b => b.Css).Append(options.Css ?? "")),
                images: () => index.NamedNodes(options.Exclude).Where(n => Is(n.Node!, "IImage")).Select(n => n.Name),
                records: RecordOf, themeSheet: s.DefaultThemeCss());
            foreach (var note in native.Normalized) normalized.Add(note.DeepClone());
            foreach (var (code, line, column, message, fix) in native.Problems)
                problems.Add(new(code, line, column, message, fix,
                    Correct: native.Corrections.TryGetValue((line, column), out var set) ? new ScreenDocument.SetAttribute(set.Attribute, set.Value) : null));
            iconRules = native.Css;
            iconsConverted = native.Normalized.Any(n => n["code"]?.ToString() == ScreenHtmlNative.SvgMask);
            // The owner's rules and the keys of the reading, on every element, before the model is touched.
            foreach (var node in ScreenDocument.Descendants(document))
            {
                var k = node.Get("k");
                var read = k != null && options.ReadKeys?.ContainsKey(k) == true;
                if (k != null && !read)
                    Problem(ScreenDocument.KeyForeign, node, $"k=\"{k}\" is not a key of the reading this document is based on" + (options.ReadKeys == null ? " (no basedOn reading)" : ""),
                        "remove k from a new element (k comes only from ssam_map view html, with basedOn {capture, html})");
                foreach (var p in ScreenDocument.RuleProblems(node, read, (attribute, value) => preserved.Add(new JsonObject { ["k"] = k, ["attribute"] = attribute, ["value"] = value, ["line"] = node.Line }),
                             read ? ReadNode(k!) : null, top.Tag == "block"))
                    problems.Add(p);
            }
            // Where every <style> goes, the CSS the theme does not render, the bindings that are not bindings (the same checks
            // as the preflight, with the keys of the reading).
            problems.AddRange(ScreenDocument.FidelityProblems(top, options.Css, node => node.Get("k") is { } key && options.ReadKeys?.ContainsKey(key) == true));
            reported = problems.Select(p => (p.Line, p.Column)).ToHashSet();
            var name = top.Get("name") ?? "";
            // Without a name there is no root to compile into; the problems of the rules wait for the names of the compile
            // (one refusal with both).
            if (!ScreenHtml.IsIdentifier(name))
            {
                Problem(ScreenDocument.Invalid, top, $"<{top.Tag}> needs name=\"<Name>\" (letters, digits and _)");
                throw Refuse();
            }

            rootKind = top.Tag == "screen" ? "MobileScreen" : "MobileBlock";
            var flow = Flow(top);
            if (flow == null) throw Refuse();
            // The defaults of the page: those of its UI flow (what a fresh element is born with there: the theme of the flow decides
            // part of it).
            defaults = index.DefaultsIn(flow);
            if (defaults.Note.Length > 0)
            {
                Problem(ScreenDocument.DefaultsMissing, top, "the installed Studio's defaults could not be measured for the UI flow " + TypeResolver.Name(flow) + ": " + defaults.Note,
                    "a document needs them; write it in a flow whose theme the reason does not name, or fix what the reason names");
                throw Refuse();
            }
            // F5: the root a composition declared before the first op (an earlier op navigates to it) is this document's: filled
            // in place, its inputs and events kept (JobComposition, Verbs.Composition.cs).
            IObjectSignature? declaredRoot = null;
            // It stays declared until a compile of the document succeeds: a refused compile keeps it (Discard), and the check of a
            // corrected document (CheckCompile, CheckedDocumentRefusal) fills it again instead of finding it in the way.
            if (!options.Declaration && s._declaredRoots.TryGetValue(name, out var declaredFirst) && !declaredFirst.WasDeleted && ReferenceEquals(declaredFirst.Parent, flow)
                && Is(declaredFirst, "I" + rootKind) && string.Equals(TypeResolver.Name(declaredFirst), name, StringComparison.OrdinalIgnoreCase))
                declaredRoot = declaredFirst;
            if (declaredRoot == null && flow.Children.OfType<IObjectSignature>().FirstOrDefault(c => c != options.Exclude && (Is(c, "IMobileScreen") || Is(c, "IMobileBlock") || Is(c, "IWebScreen") || Is(c, "IWebBlock"))
                    && string.Equals(TypeResolver.Name(c), name, StringComparison.OrdinalIgnoreCase)) is { } existing)
            {
                problems.Add(new(ScreenDocument.RootExists, top.Line, top.Column,
                    $"{TypeResolver.Name(flow)} already has {ShortType(existing)} '{TypeResolver.Name(existing)}': the document form creates a new {top.Tag}",
                    $"give it another name, or change the existing one through its reading (ssam_map view html) and the edit by k"));
                throw Refuse();
            }
            if (s._footprintBegun) s.Keep(flow, deep: false);

            var build = Stopwatch.StartNew();
            if (declaredRoot != null)
            {
                root = declaredRoot;
                shell = new HashSet<IObjectSignature>(root.Children.OfType<IObjectSignature>(), ReferenceEqualityComparer.Instance);
            }
            else root = (IObjectSignature)s.NewChild(flow, "I" + rootKind, name);
            s.Anchor(root, created: true);
            if (!string.Equals(TypeResolver.Name(root), name, StringComparison.Ordinal))
                Problem(ScreenDocument.RootExists, top, $"the Studio named the new {top.Tag} '{TypeResolver.Name(root)}' instead of '{name}' (the name is taken in its scope)", "give it another name");
            byK[""] = root;
            ClearBorn(root);
            Changed();
            // The root: its facts, its stylesheet, its data, then (after the actions) its widgets.
            var written = Facts(root, rootKind, top, ScreenHtmlModuleMode.Data, skip: ["name", "flow", "actions", "data-actions", "k"]);
            written.Add("Name");
            // Every <style> of the document, wherever it is, and data.css: the root's own style sheet as written (scope="theme":
            // the theme, after every check). Nested ones are not widgets.
            styles = ScreenDocument.Styles(top);
            var dataCss = options.Css;
            if (iconsConverted)
            {
                // The icon spans that replace the svg: the document's own svg and span selectors widened to them (the importer's
                // item 5), so its CSS styles them as it styled the svg.
                styles = styles.Select(b => b with { Css = ScreenHtmlNative.WidenIconSelectors(b.Css) }).ToList();
                if (dataCss != null) dataCss = ScreenHtmlNative.WidenIconSelectors(dataCss);
            }
            ownSheet = ScreenDocument.OwnSheet(styles, dataCss);
            // The mask rules of the icons, after the document's CSS (each class once).
            if (iconRules.Count > 0) ownSheet = (ownSheet is { Length: > 0 } sheet ? sheet.TrimEnd('\r', '\n') + "\n" : "") + string.Join("\n", iconRules);
            // T18: the root's own sheet takes the one normalization before it is written, so what is compared after the compile
            // (PostChecks) is what was written; each rewrite is listed. An absolute url to an OutSystems environment host the
            // document brings (one the sheet did not have) is a problem of the document; an existing one is not.
            if (ownSheet is { Length: > 0 } authored)
            {
                var outcome = CssPipeline.Normalize(authored, new CssPipeline.Context("own <style>"));
                if (outcome.Changed)
                {
                    ownSheet = outcome.Css;
                    normalized.Add(new JsonObject { ["code"] = "CSS_NORMALIZED", ["line"] = top.Line, ["element"] = top.Tag, ["property"] = "StyleSheet",
                        ["cssImportsHoisted"] = outcome.ImportsHoisted.Count > 0 ? new JsonArray(outcome.ImportsHoisted.Select(x => (JsonNode)x.Statement).ToArray()) : null,
                        ["cssImportsMerged"] = outcome.ImportsMerged > 0 ? outcome.ImportsMerged : null,
                        ["note"] = "an @import after a rule (which the browser ignores) moved up, keeping the order of the imports; the rest as written" });
                }
                if (outcome.ImportsKept != null) normalized.Add(new JsonObject { ["code"] = "CSS_IMPORTS_KEPT", ["line"] = top.Line, ["note"] = outcome.ImportsKept });
                if (ThemeCss.Introduced(ThemeCss.AuthorOf(root), ownSheet, $"the {top.Tag}'s <style>") is { } refusal)
                    Problem(CssPipeline.EnvUrl, top, refusal.Message, refusal.Problems?[0]?["fix"]?.ToString());
            }
            if (ownSheet != null) { Assign(root, rootKind, "StyleSheet", ownSheet, top, "style", false); written.Add("StyleSheet"); }
            var body = top.Children.Where(c => c.Tag != "style").ToList();
            var phase = Stopwatch.GetTimestamp();
            foreach (var child in body.Where(IsData)) Data(root, child);
            if (top.Tag == "block")
                foreach (var placeholder in ScreenDocument.Descendants(top).Where(n => n.Tag == "placeholder"))
                {
                    var declared = CreateIn(root, "IPlaceholderWidget", placeholder.Get("name"));
                    ClearBorn(declared);
                    declaredPlaceholders.Add(placeholder, declared);
                    s.Anchor(declared, created: true);
                }
            Spent("phase:data", phase); phase = Stopwatch.GetTimestamp();
            options.BeforeContent?.Invoke(root);
            Spent("phase:actions", phase);
            Changed();
            return () =>
            {
            // All roots and typed signatures in this job now exist. Rebuild the name index before binding bodies.
            index = ScreenHtml.Module((IObjectSignature)s._espace, r);
            var declared = options.DeclaredBy?.Invoke(root.GetInterface()?.Name ?? "", name) ?? [];
            foreach (var list in new[] { "actions", "data-actions" })
                foreach (var action in (top.Get(list) ?? "").Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
                    if (!root.Children.OfType<IObjectSignature>().Any(c => Role(c) == "action" && string.Equals(TypeResolver.Name(c), action, StringComparison.OrdinalIgnoreCase))
                        && !(list == "data-actions" && declared.Contains(action, StringComparer.OrdinalIgnoreCase)))
                        Problem(ScreenDocument.NameUnknown, top, $"{(list == "actions" ? "screen action" : "data action")} '{action}' is not declared",
                            $"declare it in a logic op of this job: a flow text \"action {name}.{action}\" (data action {name}.{action} for a data action), or kind \"screen\" with owner \"I{rootKind}:{name}\"; the document names actions, their bodies are logic");
            phase = Stopwatch.GetTimestamp();
            Children(root, body.Where(c => !IsData(c)).ToList(), "", root, top);
            Spent("phase:widgets", phase);
            Events(root, rootKind, top);
            phase = Stopwatch.GetTimestamp();
            foreach (var target in targets) target();
            Spent("phase:targets", phase); phase = Stopwatch.GetTimestamp();
            foreach (var bind in events) bind();
            Spent("phase:events", phase);
            Reset(root, rootKind, written);
            // The model this compile wrote, read again before anything is reported: the style sheet is the CSS of the document,
            // no text keeps a brace pair of a binding, no new Expression is empty.
            PostChecks();
            var buildMs = build.ElapsedMilliseconds;
            // A refused document still brings the names its expressions got wrong (the Verify of the page as far as it got,
            // read only for the names and the syntax of what the document wrote): one refusal with every wrong name.
            if (problems.Count > 0 || options.CheckExpressions || suspectExpressions) ExpressionProblems();
            if (problems.Count > 0) throw Refuse();
            // The theme's part, last: a refused document never touches the theme (Discard puts it back if a later check fails).
            var theme = options.CheckExpressions || options.Declaration ? null : InstallTheme(top);
            if (problems.Count > 0) throw Refuse();
            if (!options.Declaration) NativeVisualDone();   // CX17: the visual notes and the native layout block of the theme (F3/F6)
            var iconSelectors = iconsConverted && !options.CheckExpressions && !options.Declaration ? WidenThemeIcons() : null;
            var keys = new JsonObject();
            foreach (var (k, o) in byK.OrderBy(k => k.Key, StringComparer.Ordinal)) if (o is IObjectSignature sig) keys[k] = sig.ObjectKey?.ToString();
            var report = new JsonObject
            {
                ["form"] = "document", ["schema"] = ScreenHtml.Schema, ["root"] = TypeResolver.Name(root), ["kind"] = rootKind, ["key"] = root.ObjectKey?.ToString(),
                ["flow"] = TypeResolver.Name(flow), ["widgets"] = widgets, ["elements"] = elements, ["extendedProperties"] = extendedProperties,
                ["timings"] = new JsonObject { ["indexMs"] = indexMs, ["buildMs"] = buildMs, ["totalMs"] = total.ElapsedMilliseconds },
                ["keys"] = keys,
            };
            if (copied > 0) report["opaqueCopied"] = copied;
            report["timings"]!["steps"] = new JsonObject(spent.OrderByDescending(p => p.Value.Ticks).Select(p => KeyValuePair.Create(p.Key,
                (JsonNode?)new JsonObject { ["ms"] = p.Value.Ticks * 1000 / Stopwatch.Frequency, ["calls"] = p.Value.Calls })));
            // F5: the document filled the root declared for it: no longer a declaration (a check of a document never consumes it).
            if (shell != null && !options.CheckExpressions) s._declaredRoots.Remove(name);
            if (preserved.Count > 0) report["preserved"] = preserved;
            if (readOnly.Count > 0) report["derived"] = readOnly;
            if (StyleReport(theme) is { } css) report["styleSheet"] = css;
            if (joined > 0) report["bindingsJoined"] = joined;
            if (spaced > 0) report["spacesKept"] = spaced;
            if (iconSelectors != null) report["iconTheme"] = iconSelectors;
            if (normalized.Count > 0) report["normalized"] = normalized.DeepClone();
            return report;
            };
        }

        // ---- the names inside expressions ---------------------------------------------------------------------------------
        private static readonly System.Text.RegularExpressions.Regex Unidentified = new(@"Can't identify '([^']+)'", System.Text.RegularExpressions.RegexOptions.Compiled);
        // The word a syntax error names ("unexpected 'por' element"): the attribute that holds it is the one at fault.
        private static readonly System.Text.RegularExpressions.Regex Unexpected = new(@"unexpected '([^']+)'", System.Text.RegularExpressions.RegexOptions.Compiled | System.Text.RegularExpressions.RegexOptions.IgnoreCase);

        /// <summary>The Verify's word on the expressions the document wrote, as problems of the document: an unknown name (with
        /// the nearest names of the page and the module, and the corrected document when one is certain) or an expression that
        /// does not parse, each at the line and column of its element. What the Verify says about the parts that failed (an
        /// image without its image) is the failure already reported, not news.</summary>
        private void ExpressionProblems()
        {
            var found = new List<(string Id, string Owner, ScreenHtml.Node Node, string Detail, string? Property)>();
            try
            {
                foreach (var m in s._espace.Verify())
                {
                    if (!m.Type.ToString().Contains("Error", StringComparison.Ordinal)) continue;
                    var messageId = m.Id ?? "";
                    var expression = messageId.StartsWith("Expression", StringComparison.Ordinal) || messageId.StartsWith("Parser", StringComparison.Ordinal) || messageId == "InvalidVariable_UnknownVarIn";
                    // The check of a corrected document reads every error on what the document wrote (the review of 2026-10-12: a
                    // button whose javascript: the patch removed has no On Click, RequiredPropertyValue_Property): a patch that
                    // leaves a widget invalid is no patch.
                    if (!expression && !options.CheckExpressions) continue;
                    // The owner of the message, or the nearest element above it the document wrote (an expression property
                    // answers for its widget).
                    ScreenHtml.Node? at = null; string? ownerKey = null;
                    var first = m.ObjectIdentifier?.TryGetAbstractObject();
                    IObjectSignature? owner = null;
                    for (var o = first as IObjectSignature; o != null && at == null; o = o.Parent as IObjectSignature)
                        if (o.ObjectKey?.ToString() is { } key && nodeOf.TryGetValue(key, out var hit)) { at = hit; ownerKey = key; owner = o; }
                    if (at == null) continue;
                    var definition = m.MessageDefinition;
                    var text = (definition.Message ?? "") + (definition.Detail is { Length: > 0 } more ? " | " + more : "");
                    // The property the message is about (an expression of the widget): the attribute the problem names. The message
                    // says it, or its object is an expression the widget holds in that property.
                    string? property = null;
                    try { property = m.PropertyNames?.FirstOrDefault(p => !string.IsNullOrEmpty(p) && FindProperty(owner!, p) != null); } catch (Exception) { }
                    if (property == null && first != null && !ReferenceEquals(first, owner))
                        foreach (var pi in Readable(owner!.GetType()))
                            if (ReferenceEquals(SafeGet(pi, owner), first)) { property = pi.Name; break; }
                    // The message on the property object itself (... / Input1 (Input) / Prompt (CustomProperty)): its name is the
                    // property, when the widget has one by that name.
                    if (property == null && first is IObjectSignature named && !ReferenceEquals(named, owner)
                        && ModelHost.Prop(named, "Name") is string name && name.Length > 0 && FindProperty(owner!, name) != null) property = name;
                    found.Add((messageId, ownerKey!, at, System.Text.RegularExpressions.Regex.Replace(text, @"\s+", " "), property));
                }
            }
            catch (Exception) { return; }
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var (id, owner, node, detail, property) in found)
            {
                var unknown = Unidentified.Match(detail) is { Success: true } hit ? hit.Groups[1].Value
                    : id == "InvalidVariable_UnknownVarIn" ? node.Get("bind") : null;
                if (!seen.Add(owner + "|" + (unknown ?? detail))) continue;
                if (!id.StartsWith("Expression", StringComparison.Ordinal) && !id.StartsWith("Parser", StringComparison.Ordinal) && id != "InvalidVariable_UnknownVarIn")
                {
                    Problem(ScreenDocument.Invalid, node, $"<{node.Tag}> is not valid as written ({id}: {detail.Trim()})", "write what the Verify asks for on that element (a required property, an event)");
                    continue;
                }
                if (unknown == null)
                {
                    // The attribute of the property the message names (placeholder for Prompt), never the element's first one.
                    var where = AttributeOfProperty(node, property)
                        ?? (Unexpected.Match(detail) is { Success: true } token && ExpressionWhere(node, token.Groups[1].Value) is { Length: > 0 } holder ? holder : null)
                        ?? ExpressionWhere(node, null);
                    // An expression that does not parse, written without a binding, in an attribute: as text it is the string literal
                    // of what it says (placeholder="Buscar por nome…" is "Buscar por nome…"); the patch, checked by compiling it.
                    var value = where.Length > 0 ? node.Get(where) : null;
                    // The parser proves a literal compiles, not that prose was intended. Preserve its offered correction,
                    // but a name in scope or foreign-language syntax makes quoting an author's choice.
                    var literal = id.StartsWith("Parser", StringComparison.Ordinal) && value is { Length: > 0 } && !ScreenHtml.HoldsBraces(value) && !value.TrimStart().StartsWith('"')
                        && ScreenHtml.NotAnExpression(value);
                    var syntax = !literal && value is { Length: > 0 } && !ScreenHtml.HoldsBraces(value) ? Anvil.Core.Preflight.ExpressionSyntax.Check(value) : null;
                    Problem(ScreenDocument.Invalid, node, $"{where}: {detail.Trim()}" + (literal ? $" (\"{Clip(value!)}\" is no expression)" : syntax is { } s1 ? $" ({s1.Problem})" : ""),
                        literal ? $"{where} holds an expression: as text, write its string literal ({where}='{ScreenHtml.Literal(value!)}')"
                            : syntax is { } s2 ? $"{s2.Fix} (no patch: the expression meant and its text are two readings; a text goes in quotes)"
                            : "write the expression in the OutSystems expression language (the Verify's message names the fault)");
                    if (literal) {
                        var certain = LiteralNames() is { } names && ScreenHtml.CertainLiteral(value!, names.Scope, names.Declared);
                        problems[^1] = problems[^1] with { Correct = new ScreenDocument.SetAttribute(where, ScreenHtml.Literal(value!)),
                            PatchRule = certain ? "TEXT_LITERAL_QUOTED" : "TEXT_LITERAL_CHOICE", LiteralIdentifiers = ScreenHtml.LiteralIdentifiers(value!) };
                    }
                    continue;
                }
                var bare = unknown.Split('.')[0];
                // A name another op of the job declares (created after this one): not unknown.
                if (options.JobNames?.Contains(bare) == true) continue;
                // The row of another framework's iteration (v-for="n in Nomes" ... {{ n }}): HTML_FOREACH says it, with the List.
                if (IterationAliases(node).Contains(bare)) continue;
                var near = ScreenDocument.Nearest(bare, ExpressionNames());
                var attribute = ExpressionWhere(node, bare);
                Problem(ScreenDocument.NameUnknown, node, $"{(attribute.Length > 0 ? attribute : "{{ }}")}: no variable, input, aggregate or element of the page or the module is named '{bare}'" + (near.Count > 0 ? "; nearest: " + string.Join(", ", near) : ""),
                    near.Count == 1 ? $"{bare} -> {near[0]}" : "declare it (<var>, <input>, <aggregate>) or name one that exists", near, near.Count == 1 ? (attribute, bare, near[0]) : null);
                if (near.Count == 1) problems[^1] = problems[^1] with { PatchRule = "NEAREST_NAME" };
            }
        }

        // The attribute of an element that writes a property (the table's, else os-<Property>), when the element has it.
        private static string? AttributeOfProperty(ScreenHtml.Node node, string? property)
        {
            if (string.IsNullOrEmpty(property) || node.IsText) return null;
            var data = ScreenDocument.DataElement(node);
            var kind = data ? "" : ScreenHtmlTables.KindOf(node, out _);
            var candidates = data
                ? new[] { ScreenHtmlTables.AttributeOf(kind, property, ScreenHtmlModuleMode.Data, false), "os-" + property }
                : new[] { ScreenHtmlTables.AttributeOf(kind, property, ScreenHtmlModuleMode.Widget, false), ScreenHtmlTables.AttributeOf(kind, property, ScreenHtmlModuleMode.Widget, true), "os-" + property };
            foreach (var candidate in candidates) if (node.Get(candidate) != null) return candidate;
            return null;
        }

        // The aliases of the foreign iterations (v-for, x-for, ...) on the element and the elements around it.
        private HashSet<string> IterationAliases(ScreenHtml.Node node)
        {
            if (parents == null)
            {
                // Every child (a run of text included) with the element it is in.
                parents = new Dictionary<ScreenHtml.Node, ScreenHtml.Node>(ReferenceEqualityComparer.Instance);
                foreach (var (element, _) in ScreenHtmlText.Elements(document))
                    foreach (var child in element.Children) parents[child] = element;
            }
            var aliases = new HashSet<string>(StringComparer.Ordinal);
            for (ScreenHtml.Node? at = node; at != null; at = parents.TryGetValue(at, out var up) ? up : null)
                if (!at.IsText && ScreenDocument.IterationAlias(at) is { } alias) aliases.Add(alias);
            return aliases;
        }
        private Dictionary<ScreenHtml.Node, ScreenHtml.Node>? parents;

        /// <summary>The problems of the compile so far (the check of a corrected document compares them).</summary>
        internal IReadOnlyList<ScreenDocument.Problem> Problems => problems;

        // The attribute of an element whose value holds the word (or "" for the text of a run), for the message and the fix.
        private static string ExpressionWhere(ScreenHtml.Node node, string? word)
        {
            if (node.IsText) return "";
            if (word == null) return node.Attributes.FirstOrDefault().Key ?? "";
            var pattern = new System.Text.RegularExpressions.Regex(@"(?<![A-Za-z0-9_.])" + System.Text.RegularExpressions.Regex.Escape(word) + @"(?![A-Za-z0-9_])");
            return node.Attributes.FirstOrDefault(a => pattern.IsMatch(a.Value)).Key ?? "";
        }

        // The names an expression of the page can start with: the page's own (variables, inputs, aggregates, widgets, actions)
        // and the module's top level.
        private List<string> ExpressionNames()
        {
            // What an expression names first: a variable, an input, an aggregate, a data action, a widget (Input1.Valid).
            bool Value(IObjectSignature o, string role) => role is "variable" or "parameter" or "aggregate" or "widget" || Is(o, "IDataAction");
            var names = new List<string>();
            foreach (var (display, list) in OwnTable()) if (list.Any(o => !o.WasDeleted && Value(o, Role(o)))) names.Add(display);
            foreach (var (node, _, name, role) in index.NamedNodes(options.Exclude)) if (role is not "widget" && Value(node, role)) names.Add(name);
            return names;
        }

        /// <summary>What decides a literal's certainty: every name of the module, its references and the job (Scope), and the
        /// names this job and this page declare (Declared: the one-slip rule, option B of the owner). Null when any of it cannot
        /// be read (an op of the job that is no text where a text goes, a model node that throws): the literal is then a
        /// choice, and nothing of the reading ever leaves this compile as its refusal.</summary>
        private (IReadOnlySet<string> Scope, IReadOnlySet<string> Declared)? LiteralNames()
        {
            if (literalNamesVersion != version) {
                literalNamesVersion = version;
                literalNames = null;
                try {
                    var jobs = s._applyOps == null ? options.JobNames : LiteralJobNames(s._applyOps);
                    if (s._applyOps == null || jobs != null) {
                        var declared = new HashSet<string>(jobs ?? Enumerable.Empty<string>(), StringComparer.OrdinalIgnoreCase);
                        foreach (var (element, _) in ScreenHtmlText.Elements(document))
                            foreach (var key in new[] { "name", "id" }) if (element.Get(key) is { Length: > 0 } name) declared.Add(name);
                        if (root != null) declared.UnionWith(LiteralPageNames(root));
                        literalNames = (s.LiteralScopeNames(jobs), declared);
                    }
                }
                catch (Exception) { literalNames = null; }
            }
            return literalNames;
        }
        private int literalNamesVersion = -1;
        private (IReadOnlySet<string> Scope, IReadOnlySet<string> Declared)? literalNames;

        // ---- the flow -----------------------------------------------------------------------------------------------------
        private IObjectSignature? Flow(ScreenHtml.Node top)
        {
            if (options.Flow != null) return options.Flow;
            var flows = ((IObjectSignature)s._espace).Children.OfType<IObjectSignature>().Where(c => Is(c, "IMobileFlow") || Is(c, "IWebFlow")).ToList();
            if (top.Get("flow") is { Length: > 0 } wanted)
            {
                var hit = flows.FirstOrDefault(f => string.Equals(TypeResolver.Name(f), wanted, StringComparison.OrdinalIgnoreCase));
                if (hit != null) return Traditional(hit, top) ? null : hit;
                var near = ScreenDocument.Nearest(wanted, flows.Select(f => TypeResolver.Name(f) ?? ""));
                Problem(ScreenDocument.NameUnknown, top, $"flow '{wanted}' is not a UI flow of the module; flows: {string.Join(", ", flows.Select(f => TypeResolver.Name(f)))}",
                    near.Count == 1 ? $"flow=\"{near[0]}\"" : null, near, near.Count == 1 ? ("flow", wanted, near[0]) : null);
                return null;
            }
            var ui = flows.Where(f => Is(f, "IMobileFlow")).ToList();
            var chosen = ui.Count == 1 ? ui[0] : ui.FirstOrDefault(f => string.Equals(TypeResolver.Name(f), "MainFlow", StringComparison.OrdinalIgnoreCase));
            if (chosen == null)
            {
                Problem(ScreenDocument.Invalid, top, ui.Count == 0 ? "the module has no Reactive or Mobile UI flow" : $"the module has {ui.Count} UI flows: say which one",
                    ui.Count == 0 ? null : $"flow=\"{TypeResolver.Name(ui[0])}\" on <{top.Tag}> (flows: {string.Join(", ", ui.Select(f => TypeResolver.Name(f)))})");
                return null;
            }
            return chosen;
        }

        private bool Traditional(IObjectSignature flow, ScreenHtml.Node top)
        {
            if (!Is(flow, "IWebFlow") || Is(flow, "IMobileFlow")) return false;
            Problem(ScreenDocument.Traditional, top, $"flow '{TypeResolver.Name(flow)}' is Traditional Web: the document form is Reactive and Mobile (Traditional is D2)",
                "use the native verbs of the Traditional widgets (ui.traditional-widget)");
            return true;
        }

        // ---- data: inputs, variables, aggregates, block events ---------------------------------------------------------------
        private static bool IsData(ScreenHtml.Node node) => ScreenDocument.DataElement(node);

        private static readonly HashSet<string> DerivedParts = new(StringComparer.Ordinal) { "AddSourceOperation", "ImplicitParameter" };

        private void Data(IObjectSignature parent, ScreenHtml.Node node)
        {
            var kind = node.Tag switch {
                "input" => "InputParameter", "var" => "LocalVariable", "aggregate" => "ScreenAggregate", "event" => "BlockEvent",
                "data-action" => "DataAction", "action" => "ScreenAction", _ => node.Tag[3..] };
            if (kind is "DataAction" or "ScreenAction")
            {
                Problem(ScreenDocument.Invalid, node, $"<{node.Tag}> is not written in a document: name the action in actions=\"...\" on the root and declare it in a logic op");
                return;
            }
            // Parts the platform derives from the sources and filters of an aggregate: never created by hand.
            if (DerivedParts.Contains(kind)) return;
            // The short form of an aggregate (plan 1.5): from, join, where, sort, max on the element itself.
            if (kind == "ScreenAggregate" && node.Get("from") != null)
            {
                if (AggregateShortForm(node) is not { } canonical) return;
                node = canonical;
            }
            if (kind == "CombineSourcesOperation")
            {
                static int Rank(ScreenHtml.Node n) => n.Tag switch { "os-AliasedSource" => 0, "os-Join" => 1, "os-Filter" => 2, "os-Sort" => 3, _ => 4 };
                foreach (var child in node.Children.Where(c => !c.IsText).Select((c, i) => (c, i)).OrderBy(x => Rank(x.c)).ThenBy(x => x.i).Select(x => x.c)) Data(parent, child);
                return;
            }
            var name = node.Get("name");
            IObjectSignature element;
            try
            {
                Dictionary<string, object?>? args = null;
                if (kind == "AliasedSource")
                {
                    var entity = node.Get("os-Source") is { } src ? Reference(src, typeof(IObjectSignature), node, "os-Source", "entity") : null;
                    if (entity == null) return;
                    args = new() { ["dataSource"] = entity };
                }
                else if (kind == "Filter") args = new() { ["condition"] = node.Get("os-Condition") ?? "" };
                // F5: an input or event of a root declared before the first op is the one the signature declared (what other
                // pages already bind to); its facts are written again below, as for a new one.
                if (shell != null && ReferenceEquals(parent, root) && kind is "InputParameter" or "BlockEvent" && name != null
                    && shell.FirstOrDefault(c => !c.WasDeleted && !reused.Contains(c) && Is(c, "I" + kind) && string.Equals(TypeResolver.Name(c), name, StringComparison.OrdinalIgnoreCase)) is { } declared)
                {
                    element = declared;
                    reused.Add(declared);
                }
                else element = (IObjectSignature)s.NewChild(parent, "I" + kind, name, args);
            }
            catch (Exception error) { Problem(ScreenDocument.Invalid, node, $"{kind} '{name}' cannot be created under {ShortType(parent)}: {Unwrap(error)}"); return; }
            elements++;
            s.Anchor(element, created: true);
            Record(node, element);
            Changed();
            var skip = new List<string> { "k", "name" };
            if (kind == "AliasedSource") skip.AddRange(["os-Source", "os-SourceOperation"]);
            if (kind == "Filter") skip.Add("os-Condition");
            var written = Facts(element, kind, node, ScreenHtmlModuleMode.Data, skip);
            if (name != null) written.Add("Name");
            if (kind == "AliasedSource") written.UnionWith(["Source", "SourceOperation"]);
            if (kind == "Filter") written.Add("Condition");
            foreach (var child in node.Children.Where(c => !c.IsText)) Data(element, child);
            events.Add(() => Events(element, kind, node));
            events.Add(() => Reset(element, kind, written));
        }

        /// <summary>The short form of a screen aggregate (plan 1.5), as an author writes it:
        /// <c>&lt;aggregate name="GetPedidos" from="Pedido" join="StatusPedido on Pedido.StatusPedidoId = StatusPedido.Id"
        /// where="Pedido.ClienteId = ClienteId" sort="Pedido.CriadoEm desc, Pedido.Id" max="50"/&gt;</c>, turned into the parts
        /// the reading writes (a source per entity, a join, a filter, a sort per key) before it is compiled: the same element
        /// either way, read back in the long form. Several joins are separated by ';'.</summary>
        private ScreenHtml.Node? AggregateShortForm(ScreenHtml.Node node)
        {
            if (node.Children.Any(c => !c.IsText))
            {
                Problem(ScreenDocument.Invalid, node, "an <aggregate> with from=\"...\" is the short form: its sources, joins, filter and sort are attributes, not os-* children",
                    "keep from/join/where/sort, or write the long form (os-AliasedSource, os-Join, os-Filter, os-Sort) without from");
                return null;
            }
            ScreenHtml.Node Part(string tag, params (string Key, string Value)[] attributes) =>
                new() { Tag = tag, Line = node.Line, Column = node.Column, Attributes = attributes.Select(a => new KeyValuePair<string, string>(a.Key, a.Value)).ToList() };
            var canonical = new ScreenHtml.Node { Tag = node.Tag, Line = node.Line, Column = node.Column,
                Attributes = node.Attributes.Where(a => a.Key is not ("from" or "join" or "where" or "sort")).ToList() };
            var combine = Part("os-CombineSourcesOperation");
            canonical.Children.Add(combine);
            var sources = TopLevel(node.Get("from") ?? "", ',');
            if (sources.Count == 0) { Problem(ScreenDocument.Invalid, node, "from=\"\" names no entity", "from=\"<Entity>\""); return null; }
            static string Alias(string source) { var bare = source[(source.LastIndexOf(':') + 1)..]; return bare[(bare.LastIndexOf('.') + 1)..]; }
            var joins = new List<(string Right, string Condition)>();
            foreach (var join in TopLevel(node.Get("join") ?? "", ';'))
            {
                var on = System.Text.RegularExpressions.Regex.Match(join, @"^\s*(\S+)\s+on\s+(.+)$", System.Text.RegularExpressions.RegexOptions.Singleline | System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                if (!on.Success) { Problem(ScreenDocument.Invalid, node, $"join=\"{Clip(join)}\" is not '<Entity> on <condition>'", "join=\"StatusPedido on Pedido.StatusPedidoId = StatusPedido.Id\""); return null; }
                joins.Add((on.Groups[1].Value, on.Groups[2].Value.Trim()));
            }
            foreach (var source in sources.Concat(joins.Select(j => j.Right)).Distinct(StringComparer.OrdinalIgnoreCase))
                combine.Children.Add(Part("os-AliasedSource", ("name", Alias(source)), ("os-Source", source)));
            foreach (var (right, condition) in joins)
                combine.Children.Add(Part("os-Join", ("os-Condition", condition), ("os-LeftSource", "AliasedSource:" + Alias(sources[0])), ("os-RightSource", "AliasedSource:" + Alias(right))));
            if (node.Get("where") is { Length: > 0 } where) combine.Children.Add(Part("os-Filter", ("os-Condition", where)));
            foreach (var key in TopLevel(node.Get("sort") ?? "", ','))
            {
                var parts = System.Text.RegularExpressions.Regex.Match(key, @"^(.+?)(?:\s+(asc|desc|ascending|descending))?$", System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.Singleline);
                var descending = parts.Groups[2].Value.StartsWith("desc", StringComparison.OrdinalIgnoreCase);
                combine.Children.Add(descending ? Part("os-Sort", ("os-Attribute", parts.Groups[1].Value.Trim()), ("os-SortDirection", "Descending")) : Part("os-Sort", ("os-Attribute", parts.Groups[1].Value.Trim())));
            }
            return canonical;
        }

        // A list split at the top level only (strings and parentheses nest), each part trimmed, the empty ones dropped.
        private static List<string> TopLevel(string text, char separator)
        {
            var parts = new List<string>(); var depth = 0; var inString = false; var start = 0;
            for (var i = 0; i < text.Length; i++)
            {
                var c = text[i];
                if (inString) { if (c == '"') inString = false; continue; }
                if (c == '"') inString = true;
                else if (c is '(' or '[' or '{') depth++;
                else if (c is ')' or ']' or '}') depth--;
                else if (c == separator && depth == 0) { parts.Add(text[start..i]); start = i + 1; }
            }
            parts.Add(text[start..]);
            return parts.Select(p => p.Trim()).Where(p => p.Length > 0).ToList();
        }

        // ---- widgets ------------------------------------------------------------------------------------------------------
        // The children of an element in order: runs (a text or {{ expression }} per line), elements, an If's else right after it.
        private void Children(IObjectSignature host, List<ScreenHtml.Node> nodes, string parentId, IObjectSignature owner, ScreenHtml.Node? parent = null)
        {
            var runs = 0;
            // The runs of the text of these nodes (one per line; the whitespace beside an inline element kept, ScreenHtml.Runs), by
            // their real siblings (the root's children include its data elements, which the list leaves out).
            var holder = parent ?? new ScreenHtml.Node { Tag = "#runs" };
            if (parent == null) holder.Children.AddRange(nodes);
            var textRuns = ScreenHtml.Runs(holder).ToLookup(r => r.Source, ReferenceEqualityComparer.Instance);
            for (var i = 0; i < nodes.Count; i++)
            {
                var node = nodes[i];
                if (node.IsText)
                {
                    // One run per line: "{{ x }}" is the Expression x; a line of text with bindings ("Hoje · {{ X }}") is one
                    // Expression, their concatenation, as the reading writes it back (ScreenHtml.Run).
                    foreach (var line in textRuns[node])
                    {
                        var value = ScreenHtml.Run(line.Text, out var expression, out _);
                        var id = parentId + "~" + (runs++).ToString(CultureInfo.InvariantCulture);
                        if (expression && ScreenHtml.Bindings(line.Text, out _) is { Count: > 1 }) joined++;
                        if (line.Text != line.Text.Trim(' ', '\t')) spaced++;
                        if (Run(host, node, id, value, expression) is { } made)
                            madeRuns.Add((made, expression, (line.Line, line.Column), options.ReadKeys?.ContainsKey(id) == true));
                    }
                    continue;
                }
                if (node.Tag == "text" && node.Get("k") == null) { Run(host, node, parentId + "~" + (runs++).ToString(CultureInfo.InvariantCulture), string.Concat(node.Children.Select(c => c.Text)), false); continue; }
                // A <style> is the CSS of the root (Styles), wherever the document writes it: never a widget.
                if (node.Tag == "style") continue;
                if (IsData(node)) { Data(owner, node); continue; }
                if (node.Tag == "div" && node.Attributes is [{ Key: "else" }]) { Problem(ScreenDocument.Invalid, node, "<div else> without a <div if> right before it"); continue; }
                ScreenHtml.Node? otherwise = null;
                if (node.Tag == "div" && node.Get("if") != null && node.Get("list") == null)
                    for (var j = i + 1; j < nodes.Count; j++)
                    {
                        if (nodes[j].IsText && nodes[j].Text!.Trim().Length == 0) continue;
                        if (!nodes[j].IsText && nodes[j].Tag == "div" && nodes[j].Attributes is [{ Key: "else" }]) { otherwise = nodes[j]; nodes.RemoveAt(j); }
                        break;
                    }
                if (node.Tag == "content") { Content(host, node, parentId, owner); continue; }
                if (node.Tag == "slot") { Problem(ScreenDocument.Invalid, node, "<slot> belongs directly inside a <Block>"); continue; }
                if (node.Tag == "os-opaque") { Opaque(host, node); continue; }
                // What the rules refused whole (a script, the iteration element of another framework) is not compiled.
                if (node.Tag is "script" or "foreach" or "for-each" or "for") continue;
                Widget(host, node, otherwise, owner);
            }
        }

        private IObjectSignature? Run(IObjectSignature host, ScreenHtml.Node at, string id, string value, bool expression)
        {
            try
            {
                var run = CreateIn(host, expression ? "IExpression" : "ITextWidget", null);
                ClearBorn(run);
                if (expression) WriteExpression(run, "Value", value);
                else Assign(run, "TextWidget", "Text", value, at, "", false);
                widgets++;
                byK[id] = run;
                if (run.ObjectKey is { } runKey) nodeOf[runKey.ToString()!] = at;
                s.Anchor(run, created: true);
                var kind = expression ? "Expression" : "TextWidget";
                Reset(run, kind, new HashSet<string>(StringComparer.Ordinal) { expression ? "Value" : "Text" });
                return run;
            }
            catch (Exception error) { Problem(ScreenDocument.Invalid, at, $"{(expression ? "{{ " + value + " }}" : "text")} cannot be created: {Unwrap(error)}"); return null; }
        }

        private void Content(IObjectSignature host, ScreenHtml.Node node, string parentId, IObjectSignature owner)
        {
            var name = node.Get("name") ?? "";
            var content = host.Children.OfType<IObjectSignature>().FirstOrDefault(c => ModelHost.Kind(c.GetInterface()?.Name ?? "") == "Content" && string.Equals(TypeResolver.Name(c), name, StringComparison.OrdinalIgnoreCase));
            if (content == null) { Problem(ScreenDocument.Invalid, node, $"{ShortType(host)} has no content '{name}'"); return; }
            byK[parentId + "/content:" + name] = content;
            ClearBorn(content);
            Children(content, node.Children.ToList(), parentId + "/content:" + name, owner);
        }

        private void Opaque(IObjectSignature host, ScreenHtml.Node node)
        {
            var k = node.Get("k") ?? "";
            var original = k.Length > 0 ? options.Opaque?.Invoke(k) : null;
            if (original == null)
            {
                Problem(ScreenDocument.OpaqueTouched, node, $"<os-opaque kind=\"{node.Get("kind")}\"> is a widget the language has no row for: a document cannot create it",
                    "keep it where the reading put it (edit by k) or write it with the native verbs");
                return;
            }
            try
            {
                // The container that takes it: the host or its inner content (the platform's own test, as the move verb does).
                var parent = (ServiceStudio.Model.AbstractObject)Host(host);
                var accepting = new[] { parent }.Concat(parent.DirectChildren.Where(c => string.IsNullOrEmpty(TypeResolver.Name(c)) || TypeResolver.Name(c) == "content"))
                    .FirstOrDefault(c => StudioAdapter.Runtime.ImportsChild(c, (ServiceStudio.Model.AbstractObject)original) == "") ?? parent;
                var copy = options.MoveOpaque ? (IObjectSignature)StudioAdapter.Runtime.MoveObject((IObject)original, (IObject)accepting) : ((IObject)accepting).Duplicate(original);
                Record(node, copy);
                copied++;
                Changed();
            }
            catch (Exception error) { Problem(ScreenDocument.OpaqueTouched, node, $"the {node.Get("kind")} of the reading could not be copied: {Unwrap(error)}"); }
        }

        private void Widget(IObjectSignature host, ScreenHtml.Node node, ScreenHtml.Node? otherwise, IObjectSignature owner)
        {
            var kind = ScreenHtmlTables.KindOf(node, out var tagText);
            var reverse = ScreenHtmlTables.Reverse(kind, ScreenHtmlModuleMode.Widget);
            var nameAttribute = ScreenHtmlTables.AttributeOf(kind, "Name", ScreenHtmlModuleMode.Widget, false);
            var name = node.Get(nameAttribute);
            IObjectSignature widget;
            try
            {
                if (declaredPlaceholders.TryGetValue(node, out var declared))
                {
                    widget = declared;
                    var parent = Host(host);
                    if (!ReferenceEquals(widget.Parent, parent))
                    {
                        var answer = s.Move(new JsonObject { ["target"] = "@" + widget.ObjectKey, ["into"] = "@" + parent.ObjectKey });
                        // The platform's move (Reparent) recreates the moved object: what the document writes next (its class, its
                        // content) goes on the replacement, never on the object the move left behind ("Condition is true" on
                        // PlaceholderWidget.StyleClasses: the generator's FilterBar, integ/proto-into-product).
                        if (((ServiceStudio.Model.AbstractObject)declared).TryGetReplacement() is IObjectSignature moved) widget = moved;
                        else if (answer?["key"]?["after"]?.ToString() is { Length: > 0 } after && s.Resolve("@" + after) is IObjectSignature found) widget = found;
                    }
                    else s.Move(new JsonObject { ["target"] = "@" + widget.ObjectKey, ["last"] = true });
                }
                else widget = CreateIn(host, "I" + kind, name);
            }
            catch (Exception error) { Problem(ScreenDocument.Invalid, node, $"<{node.Tag}> ({kind}) cannot be created inside {ShortType(host)}: {Unwrap(error)}"); return; }
            widgets++;
            s.Anchor(widget, created: true);
            Record(node, widget);
            if (node.Get("id") is { Length: > 0 } authoredId)
            {
                if (!widgetsById.TryGetValue(authoredId, out var sameId)) widgetsById[authoredId] = sameId = [];
                sameId.Add(widget);
            }
            if (name != null && !string.Equals(TypeResolver.Name(widget), name, StringComparison.Ordinal))
                Problem(ScreenDocument.Invalid, node, $"{nameAttribute}=\"{name}\" is taken in this {rootKind}: the Studio named it '{TypeResolver.Name(widget)}'", "give it a name no other element of the page has");
            // A native Table keeps its HeaderRow and Row (the Model API lists them as its widgets in O11): what is born in them is
            // cleared there (TableRows).
            if (kind != "TableRecords") ClearBorn(widget);
            Track(widget);
            var written = new HashSet<string>(StringComparer.Ordinal);
            if (name != null) written.Add("Name");
            if (kind is "AdvancedHtml" || kind == "List" && tagText != "div") { Assign(widget, kind, "Tag", tagText, node, "tag", false); written.Add("Tag"); }
            // What creates other children comes first: the block an instance shows (its arguments, handlers and placeholders),
            // then the facts in the order of the text.
            // What the element spends on itself (its key, its name, the tag of an HTML element...): the preflight skips the same.
            written.UnionWith(Facts(widget, kind, node, ScreenHtmlModuleMode.Widget, ScreenDocument.WidgetSkip(node, kind)));
            var table = kind == "TableRecords" ? ScreenHtmlTables.NativeTable(node) : null;
            if (table != null) TableFacts(widget, table, written);
            // A block that did not resolve has no inputs, events or placeholders: its name is the one problem, and what its
            // slots hold is still compiled (every name of the document is checked in the same refusal).
            var lost = kind == "MobileBlockInstanceWidget" && PrototypeBuilder.Prop(widget, "SourceBlock") == null;
            if (lost) unresolved.Add(widget);
            if (!lost) Arguments(widget, node);
            var k = node.Get("k") ?? "+" + widgets.ToString(CultureInfo.InvariantCulture);
            if (kind == "Expression") madeExpressions.Add((widget, node, node.Get("k") is { } own && options.ReadKeys?.ContainsKey(own) == true));
            if (kind == "TextWidget") { Assign(widget, kind, "Text", string.Concat(node.Children.Select(c => c.Text)), node, "", false); written.Add("Text"); }
            else if (kind == "IfWidget")
            {
                var yes = PrototypeBuilder.Prop(widget, "TrueBranch") as IObjectSignature;
                var no = PrototypeBuilder.Prop(widget, "FalseBranch") as IObjectSignature;
                if (yes == null || no == null) Problem(ScreenDocument.Invalid, node, "the If was created without its two branches");
                else
                {
                    byK[k + ".true"] = yes; byK[k + ".false"] = no;
                    ClearBorn(yes); ClearBorn(no);
                    Children(yes, node.Children.ToList(), k, owner);
                    if (otherwise != null) Children(no, otherwise.Children.ToList(), k, owner);
                }
            }
            else if (kind == "MobileBlockInstanceWidget" && lost)
            {
                // Into the host, only to check their names: the op fails on the block's name anyway.
                foreach (var slot in node.Children.Where(c => !c.IsText && c.Tag == "slot")) Children(host, slot.Children.ToList(), k + "/" + slot.Get("name"), owner);
            }
            else if (kind == "MobileBlockInstanceWidget") Slots(widget, node, k, owner);
            else if (table != null) TableRows(widget, table, k, owner);
            else Children(widget, node.Children.ToList(), k, owner);
            if (lost) return;
            NativeVisual(widget, kind, node, tagText, written);   // CX17: F2 class and F1 rows of a new widget, before its Reset
            events.Add(() => Events(widget, kind, node));
            events.Add(() => Reset(widget, kind, written));
        }

        // ---- the native Table (a data table: ScreenHtmlTables.NativeTable) ----------------------------------------------------
        // Its list wherever the text writes it (the table, its tbody or its template row) is the Source; the class of the header row
        // and of the template row are StyleHeader and StyleRow; the List's own attributes beside the list are left out (a Table
        // renders every row), said once in normalized; any other attribute of a part is refused (the Table has no property for it).
        private void TableFacts(IObjectSignature widget, ScreenHtmlTables.NativeTableShape table, HashSet<string> written)
        {
            if (!ReferenceEquals(table.SourceAt, table.Table)) { Assign(widget, "TableRecords", "Source", table.Source, table.SourceAt, "list", false); written.Add("Source"); }
            // The class of each row: its section's and its <tr>'s (ScreenHtmlTables.RowClass); the List's classes and attributes an
            // older reading wrote where the list is are left out and said. Any other attribute of a part is refused, with the patch
            // that removes it (ScreenDocument.TableProblems, among the rules of every element), and so is half a column.
            foreach (var (header, style) in new[] { (true, "StyleHeader"), (false, "StyleRow") })
                if (ScreenHtmlTables.RowClass(table, header) is { } rowClass) { Assign(widget, "TableRecords", style, rowClass, header ? table.HeadRow : table.BodyRow, "class", true); written.Add(style); }
            // What it made of its parts' classes and of the List's attributes (ScreenHtmlTables.Folded, the edit's note too).
            normalized.Add(new JsonObject
            {
                ["code"] = "TABLE_NATIVE", ["line"] = table.Table.Line, ["column"] = table.Table.Column, ["element"] = "TableRecords", ["columns"] = table.HeaderCells.Count,
                ["note"] = $"a <table> with one header row and one template row over {(table.Source.Length > 0 ? table.Source : "no list yet")} is the native Table: one column per <th>/<td> pair (header cell and row cell in the same column); the reading writes it as <table list=\"{table.Source}\">"
                    + string.Concat(ScreenHtmlTables.Folded(table).Select(note => "; " + note)),
            });
        }

        // The header row and the template row of a native Table are its HeaderRow and Row contents: one header cell per <th>, one row
        // cell per <td>, in order (what the Studio created in them first is cleared).
        private void TableRows(IObjectSignature widget, ScreenHtmlTables.NativeTableShape table, string k, IObjectSignature owner)
        {
            foreach (var (name, row) in new[] { ("HeaderRow", table.HeadRow), ("Row", table.BodyRow) })
            {
                var content = PrototypeBuilder.Prop(widget, name) as IObjectSignature;
                if (content == null) { Problem(ScreenDocument.Invalid, row, $"the native Table was created without its {name}"); continue; }
                byK[k + "/content:" + name] = content;
                ClearBorn(content);
                Children(content, row.Children.ToList(), k + "/content:" + name, owner, row);
            }
        }

        private void Slots(IObjectSignature instance, ScreenHtml.Node node, string k, IObjectSignature owner)
        {
            var contents = instance.Children.OfType<IObjectSignature>().Where(c => Is(c, "IPlaceholderContentWidget")).ToList();
            foreach (var content in contents) ClearBorn(content);
            foreach (var child in node.Children)
            {
                if (child.IsText) { if (child.Text!.Trim().Length > 0) Problem(ScreenDocument.Invalid, child, "the children of a <Block> go in <slot name=\"...\">"); continue; }
                if (child.Tag == "style") continue;   // the CSS of the root (Styles)
                if (child.Tag != "slot") { Problem(ScreenDocument.Invalid, child, $"<{child.Tag}> inside a <Block>: the children of a block instance go in <slot name=\"...\">"); continue; }
                var name = child.Get("name") ?? "";
                var content = contents.FirstOrDefault(c => string.Equals(PlaceholderName(c), name, StringComparison.OrdinalIgnoreCase));
                if (content == null)
                {
                    var names = contents.Select(PlaceholderName).Where(n => n.Length > 0).ToList();
                    var near = ScreenDocument.Nearest(name, names);
                    Problem(ScreenDocument.NameUnknown, child, $"the block {node.Get("name")} has no placeholder '{name}'; placeholders: {string.Join(", ", names)}",
                        near.Count == 1 ? $"<slot name=\"{near[0]}\">" : null, near.Count > 0 ? near : names.Take(3).ToList(), near.Count == 1 ? ("name", name, near[0]) : null);
                    continue;
                }
                byK[k + "/" + name] = content;
                var written = Facts(content, "PlaceholderContentWidget", child, ScreenHtmlModuleMode.Widget, ["name"]);
                Children(content, child.Children.ToList(), k + "/" + name, owner);
                events.Add(() => Reset(content, "PlaceholderContentWidget", written));
            }
        }

        private static string PlaceholderName(IObjectSignature content) =>
            PrototypeBuilder.Prop(content, "Placeholder") is { } placeholder ? TypeResolver.Name(placeholder) ?? "" : TypeResolver.Name(content) ?? "";

        // A widget inside its host; a host that keeps its children in one Content (ODC) takes them there when it refuses them.
        private IObjectSignature CreateIn(IObjectSignature host, string type, string? name) { var t = Stopwatch.GetTimestamp(); try { return CreateInCore(host, type, name); } finally { Spent("CreateIn", t); } }
        private IObjectSignature CreateInCore(IObjectSignature host, string type, string? name)
        {
            try { return (IObjectSignature)s.NewChild(Host(host), type, name); }
            catch (Exception) when (host.Children.OfType<IObjectSignature>().Where(c => ModelHost.Kind(c.GetInterface()?.Name ?? "") == "Content").ToList() is [var content])
            { return (IObjectSignature)s.NewChild(content, type, name); }
        }

        // Where the children of a widget are created: an O11 HTML Element keeps them in its Content.
        private static IObjectSignature Host(IObjectSignature widget) =>
            Is(widget, "IAdvancedHtml") && PrototypeBuilder.Prop(widget, "Content") is IObjectSignature content ? content : widget;

        // The widgets a new element is born with (the caption of a button, the sample radios, the example content of a block's
        // placeholders): the document lists every child, so none of them stays.
        private void ClearBorn(IObjectSignature element) { var t = Stopwatch.GetTimestamp(); try { ClearBornCore(element); } finally { Spent("ClearBorn", t); } }
        private void ClearBornCore(IObjectSignature element)
        {
            foreach (var child in element.Children.OfType<IObjectSignature>().ToList())
            {
                var kind = ModelHost.Kind(child.GetInterface()?.Name ?? child.GetType().Name);
                if (kind is "IfBranchWidget" or "PlaceholderContentWidget" or "Content") { ClearBorn(child); continue; }
                if (Role(child) != "widget") continue;
                try { child.Delete(); } catch (Exception error) { problems.Add(new(ScreenDocument.Invalid, 1, 1, $"the {kind} a new {ShortType(element)} is born with could not be removed: {Unwrap(error)}", null)); }
            }
        }

        private void Record(ScreenHtml.Node node, object element)
        {
            if (node.Get("k") is { } k) byK[k] = element;
            if (element is IObjectSignature { ObjectKey: { } key }) nodeOf[key.ToString()!] = node;
        }

        // ---- facts: attributes to properties -------------------------------------------------------------------------------
        // Every attribute of the element that is a property: the table's (kind, then every widget or data element), os-<Prop>,
        // the extended properties (any other attribute, ext:<name>) in the order written. Events, arguments and handlers are
        // bound later. Answers the properties written.
        private HashSet<string> Facts(IObjectSignature target, string kind, ScreenHtml.Node node, ScreenHtmlModuleMode mode, IEnumerable<string> skip) { var t = Stopwatch.GetTimestamp(); try { return FactsCore(target, kind, node, mode, skip); } finally { Spent("Facts", t); } }
        private HashSet<string> FactsCore(IObjectSignature target, string kind, ScreenHtml.Node node, ScreenHtmlModuleMode mode, IEnumerable<string> skip)
        {
            var written = new HashSet<string>(StringComparer.Ordinal);
            var plain = new List<(string Property, string Value, string Attribute)>();
            var skipped = new HashSet<string>(skip, StringComparer.Ordinal);
            var reverse = ScreenHtmlTables.Reverse(kind, mode);
            var first = new[] { "SourceBlock", "Variable", "List", "Source" };
            var ordered = node.Attributes.Select((a, i) => (a, i, rank: reverse.TryGetValue(a.Key, out var p) && Array.IndexOf(first, p) is var f and >= 0 ? f : 9))
                .OrderBy(x => x.rank).ThenBy(x => x.i).Select(x => x.a).ToList();
            foreach (var (attribute, value) in ordered)
            {
                if (skipped.Contains(attribute)) continue;
                // CX17 review 3, M6: a marker of the engine in the text is never written as it is: NativeVisual decides it on the
                // widget (and says when its decision is not the text's); one the reading did not have is refused (review 2, M4).
                if (mode == ScreenHtmlModuleMode.Widget && ScreenVisual.MarkerOf(attribute) != null && DecidesMarkers(node)) continue;
                // An extended property (ext:<name>, or on a widget an attribute no table names): the rule the preflight checks the
                // bindings of (ScreenDocument.ExtendedName), so a brace pair that is no binding is in its refusal already.
                if (ScreenDocument.ExtendedName(attribute, reverse, mode == ScreenHtmlModuleMode.Widget) is { } extended) { Extended(target, extended, value, node, attribute); continue; }
                if (attribute.StartsWith(':') || attribute.StartsWith('@') || attribute.StartsWith("html:", StringComparison.Ordinal)) continue;
                if (attribute.StartsWith("os-on", StringComparison.Ordinal) && attribute.Contains('.')) continue;
                if (reverse.TryGetValue(attribute, out var property) || attribute.StartsWith("os-", StringComparison.Ordinal) && (property = attribute[3..]).Length > 0)
                {
                    // os-visible is os-Visible in another case (the rules refuse it as the new Visible, with the If patch): the property,
                    // never a setter of a "visible" no widget has (the review of round 2, hd1: HTML_INVALID beside it, no patch).
                    if (ScreenDocument.VisibleInAnotherCase(attribute)) property = "Visible";
                    if (attribute == "os-Name" && value.Length == 0) { written.Add("Name"); continue; }
                    // A label names a widget that may come after it: written once every widget exists.
                    if (property == "TargetWidget") { var (p, v) = (property, value); targets.Add(() => Assign(target, kind, p, v, node, attribute, false)); written.Add(property); continue; }
                    Assign(target, kind, property, value, node, attribute, attribute == "class");
                    written.Add(property);
                    if (attribute.StartsWith("os-", StringComparison.Ordinal)) plain.Add((property, value, attribute));
                    continue;
                }
                if (IsEventAttribute(target, attribute)) continue;
                // What is left of a widget is an extended property (taken above); of a data element, an attribute it does not have.
                if (mode == ScreenHtmlModuleMode.Data) Problem(ScreenDocument.Invalid, node, $"<{node.Tag}> has no attribute {attribute}", "the attributes of data elements are name, type, default, mandatory, description, max, title, roles and os-<Property>");
            }
            // A value another write of the element changed back (a width that clears a margin): written once more.
            foreach (var (property, value, attribute) in plain)
                if (FindProperty(target, property) is { } pi && SafeGet(pi, target) is var now && now is string or bool or IFormattable
                    && (now is IFormattable f ? f.ToString(null, CultureInfo.InvariantCulture) : now is bool b ? (b ? "True" : "False") : (string)now!) != value)
                    Assign(target, kind, property, value, node, attribute, false);
            return written;
        }

        // An on<event> attribute (a native event of the element, or an HTML event), its fallback arguments on<event>.<Param>.
        private static bool IsEventAttribute(IObjectSignature target, string attribute) =>
            attribute.StartsWith("on", StringComparison.Ordinal) && attribute.Length > 2;

        private void Extended(IObjectSignature target, string name, string value, ScreenHtml.Node at, string attribute)
        {
            // An attribute is literal text, one {{ expression }} or text with bindings (their concatenation, ScreenHtml.Unsugar):
            // a brace pair that is no binding never reaches the page as text. The module-free checks found it already (the same
            // rule and the same problem, FidelityProblems): reported once.
            if (ScreenDocument.AttributeBindingProblem(at, attribute, value) is { } binding && !problems.Contains(binding)) problems.Add(binding);
            try
            {
                var create = PrototypeBuilder.FindMethod(target, "CreateExtendedProperty") ?? throw new InvalidOperationException($"{ShortType(target)} takes no attributes (extended properties)");
                var ep = create.Invoke(target, create.GetParameters().Select(p => p.HasDefaultValue ? p.DefaultValue : null).ToArray())!;
                PrototypeBuilder.SetProperty(ep, "Property", name);
                WriteExpression(ep, "Value", ScreenHtml.Unsugar(value));
                extendedProperties++;
            }
            catch (Exception error) { Problem(ScreenDocument.Invalid, at, $"attribute {name}: {Unwrap(error)}"); }
        }

        private void Arguments(IObjectSignature widget, ScreenHtml.Node node)
        {
            foreach (var (attribute, value) in node.Attributes.Where(a => a.Key.StartsWith(':')))
            {
                var argument = Argument(widget, attribute[1..]);
                if (argument == null)
                {
                    var names = widget.Children.Select(ArgumentName).OfType<string>().ToList();
                    var near = ScreenDocument.Nearest(attribute[1..], names);
                    Problem(ScreenDocument.NameUnknown, node, $"{node.Get("name")} has no input '{attribute[1..]}'; inputs: {string.Join(", ", names)}",
                        near.Count == 1 ? $":{near[0]}=\"{value}\"" : null, near, near.Count == 1 ? (attribute, attribute[1..], near[0]) : null);
                    continue;
                }
                Expression(argument, value, node, attribute);
            }
        }

        // A record literal is not text the O11 expression parser reads (the Service Studio builds it in its own editor; the
        // ODC parser reads it): in O11 it is never written, refused before it becomes a Verify error.
        private bool RecordLiteral(string text, ScreenHtml.Node node, string attribute)
        {
            if (ElementWidgetMap.CurrentPlatform != ElementWidgetMap.O11 || !ScreenDocument.IsRecordLiteral(text)) return false;
            Problem(ScreenDocument.RecordLiteral, node, $"{attribute}=\"{Clip(text)}\" is a record literal, which the expression parser of the platform does not read",
                "pass a variable of the structure's type (a <var> set in a screen action), or leave the optional input out");
            return true;
        }

        private static object? Argument(IObjectSignature owner, string name) =>
            owner.Children.FirstOrDefault(c => string.Equals(ArgumentName(c), name, StringComparison.OrdinalIgnoreCase));

        /// <summary>One property from its text: an expression as written (a class literal sugared), text, a boolean, an enum
        /// member, a number, a reference by the reading's names, a type, or a collection of references.</summary>
        private void Assign(IObjectSignature target, string kind, string property, string raw, ScreenHtml.Node at, string attribute, bool sugared)
        {
            try
            {
                var pi = FindProperty(target, property);
                if (pi == null)
                {
                    WriteExpression(target, property, ExpressionOf(raw, sugared, at, attribute));
                    return;
                }
                var t = Nullable.GetUnderlyingType(pi.PropertyType) ?? pi.PropertyType;
                if (IsExpression(t) || !pi.CanWrite && SafeGet(pi, target) is IExpression)
                {
                    WriteExpression(target, property, ExpressionOf(raw, sugared, at, attribute));
                    return;
                }
                // A property that takes a literal (the Model API's type is no expression) written with a binding: the literal of a
                // constant binding ({{ "abc" }} is abc), else refused (the page would show the braces). An element of the reading
                // keeps what it had.
                if (attribute.Length > 0 && property != "StyleSheet" && ScreenHtml.HoldsBraces(raw) && !Read(at))
                {
                    // A reference by a whole binding of a name ({{ Busca }}): the element of that name.
                    if ((t.IsInterface || typeof(OutSystems.Model.Types.ITypeSignature).IsAssignableFrom(t)) && raw.Trim() is var whole
                        && System.Text.RegularExpressions.Regex.Match(whole, @"^\{\{\s*([A-Za-z_][A-Za-z0-9_.:]*)\s*\}\}$") is { Success: true } named)
                    {
                        normalized.Add(new JsonObject { ["code"] = "REFERENCE_NAME", ["line"] = at.Line, ["column"] = at.Column, ["element"] = at.Tag, ["attribute"] = attribute,
                            ["from"] = raw, ["to"] = named.Groups[1].Value, ["note"] = $"{kind}.{property} names an element: the binding of a name is that name" });
                        raw = named.Groups[1].Value;
                    }
                    else if (!t.IsInterface && ScreenHtml.HasBinding(raw) && ScreenHtml.ConstantText(raw) is { } constant)
                    {
                        normalized.Add(new JsonObject { ["code"] = "LITERAL_CONSTANT", ["line"] = at.Line, ["column"] = at.Column, ["element"] = at.Tag, ["attribute"] = attribute,
                            ["from"] = ScreenDocument.ClipText(raw), ["to"] = ScreenDocument.ClipText(constant), ["note"] = $"{kind}.{property} takes a literal ({ModelHost.Kind(t.Name)}): the constant binding is its value" });
                        raw = constant;
                    }
                    else
                    {
                        Problem(ScreenDocument.BindingLiteral, at, $"{attribute}=\"{Clip(raw)}\": {kind}.{property} takes a literal ({ModelHost.Kind(t.Name)}), never an expression: the page would show the braces",
                            $"write the {property} itself in {attribute}, or put the expression in an attribute that takes one (an extended property, {{{{ }}}} in the text)");
                        return;
                    }
                }
                // A property the platform keeps for itself (no setter, no Set method): derived from what the document did
                // write (the master source of an aggregate). Listed; the reading says whether it came out the same.
                var setter = pi.CanWrite ? null : ModelApiMetadata.Methods(target.GetType()).FirstOrDefault(m => m.Name == "Set" + property && m.GetParameters().Length == 1);
                var collection = SafeGet(pi, target) is { } held && t != typeof(string) ? CollectionOf(held) : null;
                if (!pi.CanWrite && setter == null && collection == null)
                {
                    readOnly.Add(new JsonObject { ["element"] = ShortType(target) + (TypeResolver.Name(target) is { Length: > 0 } n ? " " + n : ""), ["property"] = property, ["value"] = raw, ["line"] = at.Line });
                    return;
                }
                if (SafeGet(pi, target) is { } current && CollectionOf(current) is { } element && t != typeof(string))
                {
                    var wanted = raw.Length == 0 ? [] : raw.Split(", ").Select(v => Reference(v, element, at, attribute, property)).ToList();
                    if (wanted.Any(w => w == null)) return;
                    var type = typeof(ICollection<>).MakeGenericType(element);
                    var items = ((IEnumerable)current).Cast<object>().ToList();
                    foreach (var item in items.Where(i => !wanted.Contains(i))) type.GetMethod("Remove")!.Invoke(current, [item]);
                    // The platform keeps rules of its own between the items, so what is missing is read after the removals: in O11
                    // a new screen is born with Registered and every role of the module, and removing a role unticks Registered
                    // (roles="Registered" in a module with roles of its own came out with no role at all).
                    var live = SafeGet(pi, target) is { } again && CollectionOf(again) != null ? again : current;
                    var now = ((IEnumerable)live).Cast<object>().ToList();
                    foreach (var item in wanted.Where(w => !now.Contains(w!))) type.GetMethod("Add")!.Invoke(live, [item]);
                    return;
                }
                object? value;
                if (t == typeof(string)) value = raw;
                else if (t == typeof(bool)) value = bool.Parse(raw);
                else if (t.IsEnum)
                {
                    var text = kind == "Input" && property == "InputType" ? ScreenHtmlTables.InputTypeIn(raw) : raw;
                    if (!Enum.GetNames(t).Contains(text, StringComparer.OrdinalIgnoreCase))
                    {
                        var near = ScreenDocument.Nearest(text, Enum.GetNames(t));
                        Problem(ScreenDocument.Invalid, at, $"{attribute}=\"{raw}\" is not a {property}; values: {string.Join(", ", Enum.GetNames(t))}", near.Count == 1 ? $"{attribute}=\"{near[0]}\"" : null, near,
                            near.Count == 1 ? (attribute, raw, near[0]) : null);
                        return;
                    }
                    value = Enum.Parse(t, text, ignoreCase: true);
                }
                else if (t.IsPrimitive || t == typeof(decimal)) value = System.Convert.ChangeType(raw, t, CultureInfo.InvariantCulture);
                else if (t.IsInterface || typeof(OutSystems.Model.Types.ITypeSignature).IsAssignableFrom(t))
                {
                    if (raw.Length == 0) value = null;
                    else { value = Reference(raw, t, at, attribute, property); if (value == null) return; }
                }
                else value = System.Convert.ChangeType(raw, t, CultureInfo.InvariantCulture);
                if (pi.CanWrite) pi.SetValue(target, value);
                else setter!.Invoke(target, [value]);
                // T18: the own stylesheet of a screen or block (its <style>) settles through the one normalization too (already
                // normalized by the compile, so this writes nothing more: what PostChecks compares is what is stored).
                if (property == "StyleSheet" && ThemeCss.Of(target) is { } sheet) ThemeCss.Settle(sheet);
            }
            catch (Exception error) when (error is not OutOfMemoryException)
            {
                Problem(ScreenDocument.Invalid, at, $"{(attribute.Length > 0 ? attribute : property)}=\"{Clip(raw)}\" ({kind}.{property}): {Unwrap(error)}");
            }
        }

        // An element of the reading the document is based on (its k): what it already has is kept as it is.
        private bool Read(ScreenHtml.Node node) => node.Get("k") is { } k && options.ReadKeys?.ContainsKey(k) == true;

        /// <summary>The expression an attribute writes: as written, or (a class, or any value with a binding) the expression of its
        /// bindings ("Buscar {{ X }}" is "Buscar " + X, {{ x }} is x; ScreenHtml.Unsugar). A brace pair that is no binding is a problem
        /// of the document (AttributeBindingProblem), once.</summary>
        private string ExpressionOf(string raw, bool sugared, ScreenHtml.Node at, string attribute)
        {
            // Prose where an expression goes (placeholder="Buscar por nome…"): the Verify refuses it, so its word (and the checked
            // patch of the string literal) is read in this compile, never in a later round.
            // An expression typed wrong too (what its syntax refuses): its problem comes in the same compile, without a patch.
            if (!sugared && attribute.Length > 0 && !Read(at) && !ScreenHtml.HoldsBraces(raw)
                && (ScreenHtml.NotAnExpression(raw) || Anvil.Core.Preflight.ExpressionSyntax.Check(raw) != null)) suspectExpressions = true;
            if (!sugared && !ScreenHtml.HoldsBraces(raw)) return raw;
            if (attribute.Length > 0 && !Read(at) && ScreenDocument.AttributeBindingProblem(at, attribute, raw) is { } binding && !problems.Contains(binding)) problems.Add(binding);
            return ScreenHtml.Unsugar(raw);
        }

        private static object? SafeGet(PropertyInfo pi, object target) { try { return pi.GetValue(target); } catch { return null; } }
        private static string? Text(object? value) => value switch { IExpression e => e.Text, string t => t, _ => null };

        private static bool IsExpression(Type t) => typeof(IExpression).IsAssignableFrom(t) || t.Name == "IExpression" || t.FullName == "OutSystems.Model.Expressions.ExpressionDefinition";

        /// <summary>An expression property from its text, exactly as written (no rewrite): a writable text or parsed definition
        /// (ODC), the Text of the expression the property holds (O11), or its Set&lt;Prop&gt; method, which takes the text or a
        /// parsed definition (ODC, while the property holds none).</summary>
        private static void WriteExpression(object target, string property, string text)
        {
            var pi = FindProperty(target, property);
            if (pi != null && pi.CanWrite)
            {
                var t = Nullable.GetUnderlyingType(pi.PropertyType) ?? pi.PropertyType;
                if (t == typeof(string)) { pi.SetValue(target, text); return; }
                if (t.FullName == "OutSystems.Model.Expressions.ExpressionDefinition") { pi.SetValue(target, Definition(t, text)); return; }
            }
            if (pi != null && SafeGet(pi, target) is IExpression expression) { expression.Text = text; return; }
            foreach (var setter in ModelApiMetadata.Methods(target.GetType()).Concat(target.GetType().GetMethods(BindingFlags.Public | BindingFlags.Instance))
                         .Where(m => m.Name == "Set" + property && m.GetParameters().Length == 1))
            {
                var parameter = setter.GetParameters()[0].ParameterType;
                if (parameter == typeof(string)) { setter.Invoke(target, [text]); return; }
                if (parameter.FullName == "OutSystems.Model.Expressions.ExpressionDefinition") { setter.Invoke(target, [Definition(parameter, text)]); return; }
            }
            throw new InvalidOperationException($"{ShortType(target)}.{property} takes no expression here");
        }

        private static object Definition(Type type, string text) => type.GetMethod("Parse", BindingFlags.Public | BindingFlags.Static, [typeof(string)])!.Invoke(null, [text])!;

        private static Type? CollectionOf(object value)
        {
            if (value is string || value is not IEnumerable) return null;
            var collection = value.GetType().GetInterfaces().FirstOrDefault(i => i.IsGenericType && i.GetGenericTypeDefinition() == typeof(ICollection<>));
            return collection?.GetGenericArguments()[0] is { IsInterface: true } element ? element : null;
        }

        private static string Clip(string text) => text.Length > 80 ? text[..80] + "…" : text;

        // ---- references: the reading's names ------------------------------------------------------------------------------
        /// <summary>The element a name of the document points at, by the reading's rules: @key; this root's own elements;
        /// the module, its references and the other roots, nearest tier first; a type. Unknown or ambiguous is a problem
        /// with the nearest names of the same kind (null answer).</summary>
        private object? Reference(string form, Type expected, ScreenHtml.Node at, string attribute, string what) { var t = Stopwatch.GetTimestamp(); try { return ReferenceCore(form, expected, at, attribute, what); } finally { Spent("Reference", t); } }
        private object? ReferenceCore(string form, Type expected, ScreenHtml.Node at, string attribute, string what)
        {
            if (attribute == "for" && widgetsById.TryGetValue(form, out var authored))
            {
                var compatible = authored.Where(w => !w.WasDeleted && expected.IsInstanceOfType(w)).ToList();
                if (compatible.Count == 1) return compatible[0];
                if (compatible.Count > 1)
                {
                    Problem(ScreenDocument.NameAmbiguous, at, $"for=\"{form}\" names {compatible.Count} widgets with that id in this document", "give each widget a unique id");
                    return null;
                }
            }
            if (form.StartsWith('@'))
            {
                var id = form[1..];
                if (readKeyToK.TryGetValue(id, out var k) && byK.TryGetValue(k, out var mine) && mine is IObjectSignature own && expected.IsInstanceOfType(own) && FitsReference(own, what)) return own;
                if (index.NodeOf(id) is { } node && !Inside(node, options.Exclude) && expected.IsInstanceOfType(node) && FitsReference(node, what)) return node;
                try { if (s.Resolve(form) is IObjectSignature resolved && !Inside(resolved, options.Exclude) && expected.IsInstanceOfType(resolved) && FitsReference(resolved, what)) return resolved; } catch (KeyNotFoundException) { }
                // A key names one element: when the proto line's kind filter above finds none, the element of the key stands, as
                // the candidate's reading rule has it (the reading writes a System destination as @<reference key>.#PreviousScreen,
                // which is no IObjectSignature; ScreenRecreationTests over the real corpus, integ/proto-into-product).
                if (readKeyToK.TryGetValue(id, out var keyed) && byK.TryGetValue(keyed, out var keyedOwn)) return keyedOwn;
                if (index.NodeOf(id) is { } anyNode && !Inside(anyNode, options.Exclude)) return anyNode;
                try { if (s.Resolve(form) is { } anyResolved && !Inside(anyResolved as IObjectSignature, options.Exclude)) return anyResolved; } catch (KeyNotFoundException) { }
                Problem(ScreenDocument.NameUnknown, at, $"{attribute}=\"{form}\": no element of the module has this key", "name the element (Name, Kind:Name or Owner.Name)");
                return null;
            }
            var hits = Own(form);
            List<List<IObjectSignature>> tiers;
            if (hits.Count > 0) tiers = [hits];
            else
            {
                var found = index.Lookup(form, options.Exclude);
                // The root itself answers as a screen or block does in the reading (the tier of the other roots): a link of a
                // screen to itself.
                if (Root(form)) found.Add((root, rootKind, 3));
                tiers = found.GroupBy(f => f.Tier).OrderBy(g => g.Key).Select(g => g.Select(f => f.Node).ToList()).ToList();
            }
            foreach (var tier in tiers)
            {
                // The reading's rule (the nearest tier answers) among the elements of the kind the property takes.
                // One element answers once, whatever tiers or lookups name it (the root of a recreation is both the index's new
                // root and the root itself: "names 2 elements" with one path, integ/proto-into-product).
                var compatible = tier.Where(n => expected.IsInstanceOfType(n) && FitsReference(n, what)).Distinct(ReferenceEqualityComparer.Instance).Cast<IObjectSignature>().ToList();
                if (compatible.Count == 1) return compatible[0];
                // Two list types of one name and one element are one type (ODC Studio 1.7.29 adds the list types of its system
                // records beside the module's: ScreenHtmlModule.SameTypes): the one the type text of every op gives (TypeResolver).
                if (compatible.Count > 1 && OneListType(compatible) is { } list) return list;
                if (compatible.Count > 1)
                {
                    Problem(ScreenDocument.NameAmbiguous, at, $"{attribute}=\"{form}\" names {compatible.Count} elements: {string.Join(", ", compatible.Take(6).Select(h => ShortType(h) + " " + ModelHost.PathOf(h)))}",
                        "qualify it: Kind:Name or Owner.Name");
                    return null;
                }
            }
            if (Type(form, expected) is { } type) return type;
            var name = form[(form.IndexOf(':') + 1)..];
            name = name[(name.LastIndexOf('.') + 1)..];
            var candidates = Candidates(expected, what).ToList();
            var near = ScreenDocument.Nearest(name, candidates);
            var known = near.Count > 0 ? near : [];
            Problem(ScreenDocument.NameUnknown, at, $"{attribute}=\"{form}\": no {Wanted(expected)} is named '{name}'" + (known.Count > 0 ? "; nearest: " + string.Join(", ", known) : ""),
                near.Count == 1 ? $"{attribute}=\"{form.Replace(name, near[0])}\""
                    : $"name a {Wanted(expected)} the module has, or create '{name}' in this job (its html document or logic op, in any order of the ops)", known, near.Count == 1 ? (attribute, name, near[0]) : null);
            return null;
        }

        private object? OneListType(List<IObjectSignature> compatible)
        {
            if (compatible[0] is not OutSystems.Model.Types.IListType first || TypeResolver.Name(first) is not { Length: > 0 } name) return null;
            if (!compatible.All(c => c is OutSystems.Model.Types.IListType l && ReferenceEquals(l.ElementType, first.ElementType)
                    && string.Equals(TypeResolver.Name(l), name, StringComparison.Ordinal))) return null;
            try { var type = s.LogicDataType(name); return compatible.FirstOrDefault(c => ReferenceEquals(c, type)); }
            catch (Exception error) when (error is not OutOfMemoryException) { return null; }
        }

        private bool Root(string form)
        {
            var colon = form.IndexOf(':');
            if (colon > 0 && form[..colon] != rootKind) return false;
            var rest = colon > 0 ? form[(colon + 1)..] : form;
            var dot = rest.LastIndexOf('.');
            if (dot > 0 && !string.Equals(rest[..dot], TypeResolver.Name(root.Parent), StringComparison.OrdinalIgnoreCase)) return false;
            return string.Equals(dot > 0 ? rest[(dot + 1)..] : rest, TypeResolver.Name(root), StringComparison.OrdinalIgnoreCase);
        }

        private static string Wanted(Type expected) => expected == typeof(IObjectSignature) || expected == typeof(object) ? "element" : ModelHost.Kind(expected.Name);

        // A type by its text (Text, Long Integer, Pedido Identifier, Pedido List, Kind:Name of a basic type).
        private object? Type(string form, Type expected)
        {
            if (!typeof(OutSystems.Model.Types.ITypeSignature).IsAssignableFrom(expected) && expected != typeof(object) && !expected.Name.Contains("Type", StringComparison.Ordinal)) return null;
            var text = form.Contains(':') ? form[(form.IndexOf(':') + 1)..] : form;
            try { var type = s.LogicDataType(text); return expected.IsInstanceOfType(type) ? type : null; }
            catch (Exception) { return null; }
        }

        // The names a refusal offers: the root's own elements and the module's, of the kind the property takes.
        private IEnumerable<string> Candidates(Type expected, string what)
        {
            // An event goes to an action or a screen: the nearest name is one of those, never a variable of the same spelling.
            foreach (var list in OwnTable().Values)
                foreach (var o in list) if (!o.WasDeleted && expected.IsInstanceOfType(o) && FitsReference(o, what)) yield return TypeResolver.Name(o) ?? "";
            foreach (var (node, _, name, role) in index.NamedNodes(options.Exclude)) if (expected.IsInstanceOfType(node) && FitsReference(node, what)) yield return name;
            if (typeof(OutSystems.Model.Types.ITypeSignature).IsAssignableFrom(expected))
                foreach (var basic in BasicTypes) yield return basic;
        }

        // A destination is a screen, a client action, an action of this root, or a destination of the System (RedirectToURL:
        // the reading writes onclick="RedirectToURL" for the System's, which binds with no reference of the module; the
        // candidate's recreation corpus on ODC, integ/proto-into-product).
        private bool FitsReference(IObjectSignature node, string what) => what != "destination" || Role(node) == "screen"
                || PreflightRules.OdcScopeRules.SystemDestinations.Contains(TypeResolver.Name(node) ?? "")
                || ModelHost.Kind(node.GetInterface()?.Name ?? "") is "ClientAction" or "ClientActionSignature"
                || Role(node) == "action" && Inside(node, root);

        private static readonly string[] BasicTypes = ["Text", "Integer", "Long Integer", "Decimal", "Boolean", "Date", "Time", "Date Time", "Currency", "Email", "Phone Number", "Binary Data"];

        private static bool Inside(IObjectSignature? o, IObjectSignature? ancestor)
        {
            if (o == null || ancestor == null) return false;
            for (var p = o; p != null; p = p.Parent as IObjectSignature) if (ReferenceEquals(p, ancestor)) return true;
            return false;
        }

        // Tier 0: the root's own elements (never the root itself; the body of an action is not walked), by name, Kind:Name,
        // Owner.Name, Kind:Owner.Name.
        private void Changed() => version++;

        // Where the compile spends its time (inclusive, per step), in the report: the build of a page stays measured.
        private readonly Dictionary<string, (long Ticks, int Calls)> spent = new(StringComparer.Ordinal);
        private void Spent(string step, long since)
        {
            var (ticks, calls) = spent.TryGetValue(step, out var was) ? was : (0, 0);
            spent[step] = (ticks + Stopwatch.GetTimestamp() - since, calls + 1);
        }

        // A new widget (with what it keeps of what it was born with) joins the table in place: a page of a thousand widgets
        // never walks itself once per widget (the walk is for the coarse changes: the data, the actions, a copied opaque).
        private void Track(IObjectSignature node) { var t = Stopwatch.GetTimestamp(); try { TrackCore(node); } finally { Spent("Track", t); } }
        private void TrackCore(IObjectSignature node)
        {
            if (ownVersion != version) return; // the next lookup walks the root anyway
            var pending = new Stack<IObjectSignature>();
            pending.Push(node);
            while (pending.TryPop(out var o))
            {
                if (o.WasDeleted) continue;
                var display = Display(o);
                if (display.Length > 0) { if (!own.TryGetValue(display, out var list)) own[display] = list = []; list.Add(o); }
                if (Role(o) == "action") continue;
                foreach (var child in o.Children.OfType<IObjectSignature>()) pending.Push(child);
            }
        }
        private Dictionary<string, List<IObjectSignature>> OwnTable() { var t = Stopwatch.GetTimestamp(); try { return OwnTableCore(); } finally { Spent("OwnTable", t); } }
        private Dictionary<string, List<IObjectSignature>> OwnTableCore()
        {
            if (ownVersion == version) return own;
            own = new(StringComparer.OrdinalIgnoreCase);
            var pending = new Stack<IObjectSignature>(root.Children.OfType<IObjectSignature>());
            while (pending.TryPop(out var node))
            {
                if (node.WasDeleted) continue;
                var display = Display(node);
                if (display.Length > 0) { if (!own.TryGetValue(display, out var list)) own[display] = list = []; list.Add(node); }
                if (Role(node) == "action") continue;
                foreach (var child in node.Children.OfType<IObjectSignature>()) pending.Push(child);
            }
            ownVersion = version;
            return own;
        }

        private List<IObjectSignature> Own(string form)
        {
            string? ofKind = null; var rest = form;
            var colon = form.IndexOf(':');
            if (colon > 0) { ofKind = form[..colon]; rest = form[(colon + 1)..]; }
            string? owner = null; var dot = rest.LastIndexOf('.');
            if (dot > 0) { owner = rest[..dot]; rest = rest[(dot + 1)..]; }
            if (!OwnTable().TryGetValue(rest, out var list)) return [];
            return list.Where(o => !o.WasDeleted && (ofKind == null || ModelHost.Kind(o.GetInterface()?.Name ?? o.GetType().Name) == ofKind)
                && (owner == null || o.Parent is IObjectSignature p && string.Equals(Display(p), owner, StringComparison.OrdinalIgnoreCase))).ToList();
        }

        private string Display(IObjectSignature node) => r.DisplayOf(node);

        private string Role(IObjectSignature node)
        {
            var kind = r.KindOf(node);
            return ModuleIndex.Roles[ModuleIndex.RoleOf(kind, new HashSet<string>(r.KindNamesOf(node), StringComparer.Ordinal))];
        }

        // ---- events -----------------------------------------------------------------------------------------------------
        /// <summary>The events of an element: native (a property that points at its own event child: onclick, onchange,
        /// onready...), the handlers of a block instance (@Event) and the HTML events (any other on*, html:*), each with its
        /// destination, its arguments (named, or by position over the destination's inputs) and os-on&lt;event&gt;.&lt;Prop&gt;.</summary>
        private void Events(IObjectSignature element, string kind, ScreenHtml.Node node) { var t = Stopwatch.GetTimestamp(); try { EventsCore(element, kind, node); } finally { Spent("Events", t); } }
        private void EventsCore(IObjectSignature element, string kind, ScreenHtml.Node node)
        {
            if (!node.Attributes.Any(a => a.Key.StartsWith("on", StringComparison.Ordinal) || a.Key.StartsWith('@') || a.Key.StartsWith("html:", StringComparison.Ordinal) || a.Key.StartsWith("os-on", StringComparison.Ordinal))) return;
            var native = NativeEvents(element);
            var handled = new HashSet<string>(StringComparer.Ordinal);
            foreach (var (attribute, value) in node.Attributes)
            {
                string head;
                if (attribute.StartsWith("os-", StringComparison.Ordinal) && attribute.Contains('.')) head = attribute[3..attribute.IndexOf('.')];
                else if (attribute.StartsWith('@') || attribute.StartsWith("html:", StringComparison.Ordinal) || attribute.StartsWith("on", StringComparison.Ordinal) && attribute.Length > 2) head = attribute.Contains('.') ? attribute[..attribute.IndexOf('.')] : attribute;
                else continue;
                if (!head.StartsWith("on", StringComparison.Ordinal) && !head.StartsWith('@') && !head.StartsWith("html:", StringComparison.Ordinal)) continue;
                if (!handled.Add(head)) continue;
                var target = Event(element, kind, head, native, node);
                if (target == null) continue;
                // The destination with its arguments, then the event's own properties.
                if (node.Get(head) is { } call) Bind(target, head, call, node);
                foreach (var (name, argument) in node.Attributes.Where(a => a.Key.StartsWith(head + ".", StringComparison.Ordinal)))
                {
                    var param = name[(head.Length + 1)..];
                    if (Argument(target, param) is { } arg) Expression(arg, argument, node, name);
                    else Problem(ScreenDocument.NameUnknown, node, $"{head} has no argument '{param}'");
                }
                var props = node.Attributes.Where(a => a.Key.StartsWith("os-" + head + ".", StringComparison.Ordinal)).ToList();
                var eventKind = ModelHost.Kind(target.GetInterface()?.Name ?? target.GetType().Name);
                var written = new HashSet<string>(StringComparer.Ordinal) { "Destination", "Handler", "Event", "Name" };
                foreach (var (name, v) in props)
                {
                    var property = name[(3 + head.Length + 1)..];
                    Assign(target, eventKind, property, v, node, name, false);
                    written.Add(property);
                }
                Reset(target, eventKind, written, InPopup(element));
            }
        }

        // attribute -> the native event child it names (OnClick -> onclick), from the properties that point at an own event.
        private Dictionary<string, (string Property, IObjectSignature Event)> NativeEvents(IObjectSignature element)
        {
            var map = new Dictionary<string, (string, IObjectSignature)>(StringComparer.Ordinal);
            var children = new HashSet<IObjectSignature>(element.Children.OfType<IObjectSignature>(), ReferenceEqualityComparer.Instance);
            foreach (var pi in Readable(element.GetType()))
            {
                if (SafeGet(pi, element) is not IObjectSignature value || !children.Contains(value) || Role(value) != "event") continue;
                map.TryAdd(ScreenHtmlModule<IObjectSignature>.EventAttribute(pi.Name), (pi.Name, value));
            }
            // An event child the element names by itself (a lifecycle event without a pointer property).
            foreach (var child in children)
                if (Role(child) == "event" && ModelHost.Kind(child.GetInterface()?.Name ?? "") is "UILifeCycleEvent" or "BuiltinEvent" && Display(child) is { Length: > 0 } own)
                    map.TryAdd(ScreenHtmlModule<IObjectSignature>.EventAttribute(own), (own, child));
            return map;
        }

        private IObjectSignature? Event(IObjectSignature element, string kind, string head, Dictionary<string, (string Property, IObjectSignature Event)> native, ScreenHtml.Node node)
        {
            if (head.StartsWith('@'))
            {
                var name = head[1..];
                var handlers = element.Children.OfType<IObjectSignature>().Where(c => ModelHost.Kind(c.GetInterface()?.Name ?? "") == "EventHandler").ToList();
                var hit = handlers.FirstOrDefault(h => string.Equals(PrototypeBuilder.Prop(h, "Event") is { } e ? TypeResolver.Name(e) : null, name, StringComparison.OrdinalIgnoreCase));
                if (hit != null) return hit;
                var names = handlers.Select(h => PrototypeBuilder.Prop(h, "Event") is { } e ? TypeResolver.Name(e) ?? "" : "").Where(n => n.Length > 0).ToList();
                var near = ScreenDocument.Nearest(name, names);
                Problem(ScreenDocument.NameUnknown, node, $"{node.Get("name")} has no event '{name}'; events: {string.Join(", ", names)}", near.Count == 1 ? $"@{near[0]}" : null, near, near.Count == 1 ? (head, name, near[0]) : null);
                return null;
            }
            if (!head.StartsWith("html:", StringComparison.Ordinal) && native.TryGetValue(head, out var found)) return found.Event;
            // An HTML event of an HTML Element or a Container (onblur, onkeypress...): created with its name.
            var eventName = head.StartsWith("html:", StringComparison.Ordinal) ? head[5..] : head;
            try
            {
                var create = PrototypeBuilder.FindMethod(element, "CreateEvent") ?? throw new InvalidOperationException($"{kind} has no event {head}" + (native.Count > 0 ? "; events: " + string.Join(", ", native.Keys) : ""));
                var created = (IObjectSignature)create.Invoke(element, create.GetParameters().Select(p => p.HasDefaultValue ? p.DefaultValue : null).ToArray())!;
                PrototypeBuilder.SetProperty(created, "Event", eventName);
                return created;
            }
            catch (Exception error)
            {
                Problem(ScreenDocument.NameUnknown, node, $"{head}: {Unwrap(error)}");
                return null;
            }
        }

        private void Bind(IObjectSignature target, string head, string call, ScreenHtml.Node node)
        {
            // Not a call: JavaScript, which the rules already reported (or kept, on an element of the reading). A javascript: URL
            // reads as a call of "javascript:alert": the rules report it (HTML_SCRIPT), never as a destination named 'alert'.
            if (call.TrimStart().StartsWith("javascript:", StringComparison.OrdinalIgnoreCase)) return;
            if (!ScreenDocument.ParseCall(call, out var name, out var arguments)) return;
            if (name.Length == 0) return;
            var property = FindProperty(target, "Destination") is { } d ? d : FindProperty(target, "Handler");
            if (property == null) { Problem(ScreenDocument.Invalid, node, $"{head}: the event has no Destination"); return; }
            var destination = Reference(name, property.PropertyType, node, head, "destination");
            if (destination == null) return;
            try { property.SetValue(target, destination); }
            catch (Exception error) { Problem(ScreenDocument.Invalid, node, $"{head}=\"{name}\": {Unwrap(error)}"); return; }
            if (arguments.Count == 0) return;
            var inputs = Inputs(destination);
            for (var i = 0; i < arguments.Count; i++)
            {
                var (param, value) = arguments[i];
                param ??= i < inputs.Count ? inputs[i] : null;
                if (param == null) { Problem(ScreenDocument.Invalid, node, $"{head}: {name} takes {inputs.Count} input(s); argument {i + 1} has none", $"inputs of {name}: {string.Join(", ", inputs)}"); continue; }
                if (Argument(target, param) is { } arg) { Expression(arg, value, node, head); continue; }
                var near = ScreenDocument.Nearest(param, inputs);
                Problem(ScreenDocument.NameUnknown, node, $"{head}: {name} has no input '{param}'; inputs: {string.Join(", ", inputs)}", near.Count == 1 ? $"{near[0]} = {value}" : null, near,
                    near.Count == 1 ? (head, param, near[0]) : null);
            }
        }

        private static List<string> Inputs(object destination) =>
            destination is IObjectSignature d
                ? d.Children.OfType<IObjectSignature>().Where(c => Is(c, "IInputParameter")).Select(c => TypeResolver.Name(c) ?? "").ToList()
                : [];

        private void Expression(object target, string text, ScreenHtml.Node node, string attribute)
        {
            if (RecordLiteral(text, node, attribute)) return;
            try { WriteExpression(target, "Value", text); }
            catch (Exception error) { Problem(ScreenDocument.Invalid, node, $"{attribute}: {Unwrap(error)}"); }
        }

        // ---- what the text does not say is at its default ---------------------------------------------------------------
        /// <summary>Every property the reading counts as a fact of the element and the text does not name is set to its
        /// default (the reading's ScreenDefaults, the installed Studio's): a new widget is born with values of its own that the
        /// read element did not have; a value the Studio gives it that is a default stays (writing it is a no-op). One exception,
        /// the owner's decision D1 of 2026-10-17 (F2): the class of a new widget without k and without class is the one the
        /// Studio gives it, or its trimmed form (ScreenVisual.StudioClassOf, decided in NativeVisual before this runs, which puts
        /// Style in <paramref name="written"/>), as in the edit forms and the fragment; the class of an element with k is the
        /// one its text says.</summary>
        private void Reset(IObjectSignature element, string kind, HashSet<string> written, bool inPopup = false) { var t = Stopwatch.GetTimestamp(); try { ResetCore(element, kind, written, inPopup); } finally { Spent("Reset", t); } }
        private void ResetCore(IObjectSignature element, string kind, HashSet<string> written, bool inPopup)
        {
            if (element.WasDeleted) return;
            var role = Role(element);
            var children = new HashSet<IObjectSignature>(element.Children.OfType<IObjectSignature>(), ReferenceEqualityComparer.Instance);
            foreach (var pi in Readable(element.GetType()))
            {
                var name = pi.Name;
                if (written.Contains(name) || ModelReader<IObjectSignature>.IsNoise(name) || ScreenHtml.NotFacts.Contains(name)) continue;
                if (name == "Type" && role is "parameter" or "variable" or "aggregate") continue;
                // The reading drops a text's Value that repeats its Text: the platform keeps them together.
                if (kind == "TextWidget" && name == "Value") continue;
                var value = SafeGet(pi, element);
                char type; string text;
                switch (value)
                {
                    case null: continue;
                    case byte[]: continue;
                    case IExpression e: type = 'e'; text = e.Text ?? ""; break;
                    case IObjectSignature target:
                        if (ReferenceEquals(target, element) || ReferenceEquals(target, s._espace) || ReferenceEquals(target, element.Parent) || children.Contains(target)) continue;
                        type = 'r'; text = "?"; break;
                    case string str: type = 't'; text = str; break;
                    case bool b: type = 'b'; text = b ? "True" : "False"; break;
                    case IEnumerable items: {
                        var any = false; var structural = true;
                        foreach (var item in items) { any = true; structural &= item is IObjectSignature o && (children.Contains(o) || Inside(o, element)); }
                        if (!any || structural) continue;
                        type = 'l'; text = "?"; break;
                    }
                    case IFormattable f: type = 'v'; text = f.ToString(null, CultureInfo.InvariantCulture); break;
                    default: continue;
                }
                // A text Style that repeats StyleClasses (or is empty) is not a fact of the reading: the two are kept together.
                if (name == "Style" && type == 't' && (FindProperty(element, "StyleClasses") is { } classes ? Text(SafeGet(classes, element)) == text : text.Length == 0)) continue;
                var wanted = defaults.DefaultOf(kind, name, type, inPopup);
                if (text == wanted) continue;
                try
                {
                    switch (type)
                    {
                        case 'e': WriteExpression(element, name, wanted); break;
                        case 'b' when pi.CanWrite: pi.SetValue(element, bool.Parse(wanted)); break;
                        case 't' when pi.CanWrite: pi.SetValue(element, wanted); break;
                        case 'v' when pi.CanWrite && wanted.Length > 0:
                            var t = Nullable.GetUnderlyingType(pi.PropertyType) ?? pi.PropertyType;
                            pi.SetValue(element, t.IsEnum ? Enum.Parse(t, wanted, true) : System.Convert.ChangeType(wanted, t, CultureInfo.InvariantCulture));
                            break;
                        case 'r' when pi.CanWrite && !pi.PropertyType.IsValueType: pi.SetValue(element, null); break;
                        case 'l' when CollectionOf(value!) is { } element2:
                            typeof(ICollection<>).MakeGenericType(element2).GetMethod("Clear")!.Invoke(value, []); break;
                    }
                }
                catch (Exception) { /* a property the platform keeps for itself: the comparison of the proof names it */ }
            }
        }

        private static IEnumerable<PropertyInfo> Readable(Type type) =>
            ModelApiMetadata.Properties(type).Where(p => p.GetIndexParameters().Length == 0).GroupBy(p => p.Name).Select(g => g.OrderByDescending(p => p.CanWrite).First());

        private static bool Is(object o, string type) => Implements(o, type);
    }
}
