using System.Text.Json.Nodes;
using Anvil.Reading;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>
/// DL2 of the SSAM text plan: the way back of the data text. `{"op":"spec","data":{"ddl":"…"}}` carries the statements of
/// the module's data text (ssam-ddl/1, `ssam_map view:"ddl"`) that change; the session compiles them against the module as
/// it is now (its own text, DataDdl, which reads back to the model exactly) into the spec of the new types and the raw verbs
/// (DdlCompiler), applies them, and then reads the module again: what the platform rewrote on its own (the Label of a renamed
/// static record, the convention of the spec) is set back to what the text says, and a third reading must find nothing left,
/// or the op is refused (DDL_NOT_CONVERGED) with what the platform keeps. So the data the module ends with is the text, or
/// nothing is kept (the job is one transaction). Every problem comes at once, each with its line in the text.
/// </summary>
public sealed partial class ModelSession
{
    private JsonNode DdlSpec(JsonObject data)
    {
        var text = data["ddl"]!.GetValue<string>();
        // The same checks as the job's preflight (the closed keys, the syntax, what the text names), all at once.
        _ = SpecExpander.DdlCreation(data);
        var lane = MessageExpectations.Lane;
        var edit = SpecExpander.DdlParse(text);
        var prefix = "$ddl" + _applyIndex;
        var rounds = new JsonArray();
        DdlCompilation? first = null;
        var known = new HashSet<string>(StringComparer.Ordinal);
        var basedOn = data["basedOn"] is JsonValue based && based.TryGetValue<string>(out var sha) && sha.Length > 0 ? sha : null;
        JsonObject? merged = null;
        List<DdlProblem> conventionProblems = [];
        for (var round = 1; ; round++)
        {
            var built = DataDdl.Build((IObjectSignature)_espace, new KernelModelReader(), lane, "", 0);
            var current = DdlParser.Parse(built.Text);
            if (round == 1)
            {
                foreach (var element in current.All()) if (element.Key.Length > 0) known.Add(element.Key);
                // What the platform fills by itself (the identifier, a static entity's identifier, label and order values, a
                // required value), given its one meaning in the text itself, against the module now, before anything is
                // compiled: every round compiles the same text, so no round clears what another wrote (DdlConventions).
                var conventions = DdlConventions.Apply(edit, current);
                foreach (var note in conventions.Notes) Note(note.Code, note.Message);
                conventionProblems = conventions.Problems;
                // Statements with keys were written on a read (basedOn): merged three ways with it, so what the Studio changed since
                // stays (DdlMerge); on the capture the job runs on, compared with the module now. Without basedOn, or without
                // the read, refused with the declarations now (nothing is compiled as sent against a module that may have
                // changed since).
                (edit, merged) = MergeDdl(edit, current, built, basedOn, lane);
            }
            else
            {
                // The elements the first round created, by their place and name in the module now: their keys.
                var lost = KeyCreated(first!.Created, current, known);
                if (lost.Count > 0)
                    throw SpecExpander.DdlRefusal("DDL_NOT_CONVERGED", lost.Select(e => new DdlProblem(e.Line, "DDL_NOT_CONVERGED",
                        $"{e.Name} was created and the module has no {e.Name} there now (the platform named it otherwise)", "give it another name")).ToList());
            }
            var compiled = DdlCompiler.Compile(round == 1 ? edit : WithoutDrops(edit), current, lane, prefix + "r" + round, text, first?.Created.Concat(first.Retyped));
            if (round == 1 && conventionProblems.Count > 0)
                throw SpecExpander.DdlRefusal("DDL_INVALID", conventionProblems.Concat(compiled.Problems).OrderBy(p => p.Line).ToList());
            if (compiled.Problems.Count > 0) throw SpecExpander.DdlRefusal(round == 1 ? "DDL_INVALID" : "DDL_NOT_CONVERGED", compiled.Problems);
            if (compiled.Count == 0) break;
            if (round == 3)
                throw SpecExpander.DdlRefusal("DDL_NOT_CONVERGED", compiled.Steps.Select(s => new DdlProblem(s.Line, "DDL_NOT_CONVERGED",
                    $"{s.What}: the module keeps another value after two rounds ({DdlDescribe(s.Op)})", "write the value the module keeps, or change it in the Studio")).ToList());
            RunDdl(compiled);
            first ??= compiled;
            var summary = compiled.Summary();
            summary["round"] = round;
            // What the platform had rewritten on its own, set back to the text (the second round).
            if (round > 1) summary["steps"] = new JsonArray(compiled.Ops().Select(o => (JsonNode)(o.What + ": " + DdlDescribe(o.Op))).ToArray());
            rounds.Add(summary);
        }
        var keys = new JsonObject();
        foreach (var created in first?.Created ?? [])
            if (created.Key.Length > 0) keys[(created.Parent != null ? created.Parent.Name + "." : "") + created.Name] = created.Key;
        // The basedOn of a next edit: the module's data text as this op leaves it, kept in the store (an edit of it that arrives
        // after the Studio changed the module is merged three ways with it).
        var next = KeepsDdlReadings ? KeepDdlReading(DataDdl.Build((IObjectSignature)_espace, new KernelModelReader(), lane, "", 0)) : null;
        return new JsonObject {
            ["ddl"] = first?.Summary() ?? new JsonObject { ["ops"] = 0 }, ["rounds"] = rounds,
            ["settled"] = rounds.Count > 1 ? rounds[1]!.DeepClone() : null, ["keys"] = keys.Count > 0 ? keys : null,
            ["basedOn"] = data["basedOn"]?.DeepClone(), ["merged"] = merged, ["nextBasedOn"] = next };
    }

    /// <summary>The data texts an edit written on a read is merged with, by the read's sourceSha256 (the merge battery keeps them in
    /// memory). Null: the store (ModuleIndexStore.Default), where ssam_map view ddl keeps the text of every capture it serves.</summary>
    public Func<string, string?>? DdlReadings { get; set; }

    // The module's data text before the first op of the job (Apply), when the job has a data text: a data text written on the
    // capture this job runs on is merged three ways with it once an earlier op of the job changed the module's data (MergeDdl).
    private string? _ddlAtStart;

    private string? DdlReadOf(string sourceSha256) =>
        DdlReadings != null ? DdlReadings(sourceSha256)
        // servidor/fase4-26 (M2): with ModuleIndexStore.OwnReadingsOnly (hosted) only a read of this job's own capture.
        : sourceSha256.Length == 64 && sourceSha256.All(Uri.IsHexDigit) && ModuleIndexStore.KeptReadingAllowed(sourceSha256, BaseSha256) ? ModuleIndexStore.Default()?.LoadDdl(sourceSha256)?.Text : null;

    /// <summary>Called with every data text this session keeps as a read (its content key and its text) instead of the store: the
    /// merge battery keeps them in memory beside DdlReadings.</summary>
    public Action<string, string>? DdlKeep { get; set; }

    /// <summary>Whether this session keeps the reads its answers name (the basedOn of a next edit, the edit a refusal hands back) in
    /// the store: a job (JobRunner) does; a battery that reads the module itself does not.</summary>
    public bool KeepReadings { get; set; }

    private bool KeepsDdlReadings => DdlKeep != null || KeepReadings && DdlReadings == null;

    /// <summary>A data text kept as a read under the sha256 of its text (a content key: the same text, the same key), in the store
    /// or the battery's memory; the key, the basedOn an edit of that text is sent with. Null when nothing keeps it.</summary>
    private string? KeepDdlReading(DataDdl ddl)
    {
        var key = System.Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(ddl.Text))).ToLowerInvariant();
        var kept = ddl.WithSource(key);
        if (DdlKeep != null) { DdlKeep(key, kept.Text); return key; }
        if (!KeepReadings || DdlReadings != null || ModuleIndexStore.Default() is not { } store) return null;
        try { if (store.LoadDdl(key) == null) store.SaveDdl(kept); return key; }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException) { return null; }
    }

    /// <summary>The edit merged three ways with the read it was written on (DdlMerge): base = that read's text, theirs = the module
    /// now, ours = the statements. Statements without a key need no read. With keys: without basedOn, refused (DDL_BASE_REQUIRED);
    /// on the capture this job runs on, compared with the module now; without the read kept here, a statement that differs from
    /// the module is refused (DDL_BASE_UNKNOWN), never compiled as sent; a read of another module is refused (DDL_BASE_FOREIGN).
    /// Every refusal hands back the declarations the text names as they are now, with the basedOn to send them on.</summary>
    private (DdlDocument Edit, JsonObject? Note) MergeDdl(DdlDocument edit, DdlDocument current, DataDdl built, string? basedOn, string lane)
    {
        if (!edit.All().Concat(edit.Detached).Any(e => e.Key.Length > 0))
            return (edit, basedOn == null ? null : new JsonObject { ["merge"] = "none", ["basedOn"] = basedOn, ["note"] = "the statements name no element of a read (no -- @key): nothing to merge" });
        if (basedOn == null)
            throw BaseRefusal("DDL_BASE_REQUIRED", edit, current, built, "names elements of a read by their keys (-- @key) and the op has no basedOn: what changed in the Studio since that read cannot be told from what the statement changes",
                "send the statements with basedOn: the sourceSha256 of the read (ssam_map view ddl) or the nextBasedOn of the last receipt; data.edit is the edit ready on the module now");
        string? read;
        if (BaseSha256 != null && string.Equals(basedOn, BaseSha256, StringComparison.OrdinalIgnoreCase)) {
            // Written on the capture this job runs on: compared with the module now while no earlier op of the job changed its
            // data; otherwise merged three ways with the data text the job started from (what an earlier op of the job changed is
            // kept as the Studio's would be, never set back by a statement that still says what the capture said).
            if (_ddlAtStart == null || _ddlAtStart == built.Text)
                return (edit, new JsonObject { ["merge"] = "none", ["basedOn"] = basedOn,
                    ["note"] = "the statements were written on the capture this job runs on: compared with the module now" });
            read = _ddlAtStart;
        } else read = DdlReadOf(basedOn);
        DdlDocument? @base = null;
        if (read != null) { try { @base = DdlParser.Parse(read); } catch (DdlParseException) { } }
        if (@base == null) {
            var problems = DdlMerge.WithoutRead(current, edit, basedOn, lane);
            if (problems.Count > 0) throw RefuseDdl("DDL_BASE_UNKNOWN", problems, edit, current, built);
            return (edit, new JsonObject { ["merge"] = "none", ["basedOn"] = basedOn,
                ["note"] = "the read basedOn names is not kept here, and every statement with a key says what the module says now: nothing of them to merge" });
        }
        if (@base.ModuleKey != null && current.ModuleKey != null && !string.Equals(@base.ModuleKey, current.ModuleKey, StringComparison.Ordinal))
            throw BaseRefusal("DDL_BASE_FOREIGN", edit, current, built, "is written on a read of another module (basedOn " + basedOn + " is the data text of @" + @base.ModuleKey
                + ", this module is @" + current.ModuleKey + "): its keys name nothing here", "send the statements on a read of this module: data.edit is the edit ready on the module now");
        var result = DdlMerge.ThreeWay(@base, current, edit, lane);
        if (result.Problems.Count > 0) throw RefuseDdl(result.Problems.Select(p => p.Code).Distinct().Count() == 1 ? result.Problems[0].Code : "DDL_MERGE_REFUSED", result.Problems, edit, current, built);
        var note = new JsonObject { ["merge"] = "three-way", ["basedOn"] = basedOn,
            ["note"] = "the statements were merged with what changed since the read (base = that read, theirs = the module now): what only the Studio changed stays" };
        if (result.Kept.Count > 0) note["kept"] = new JsonArray(result.Kept.Select(k => (JsonNode)k).ToArray());
        if (result.Notes.Count > 0) note["notes"] = new JsonArray(result.Notes.Select(n => (JsonNode)n).ToArray());
        if (result.Conflicts.Count > 0) {
            note["conflicts"] = new JsonArray(result.Conflicts.Select(c => (JsonNode)c).ToArray());
            note["rule"] = "a change of the same element in the statements and in the Studio keeps the delivery's version";
        }
        return (result.Edit, note);
    }

    /// <summary>The edit a refusal of statements with keys hands back: the declarations of the top-level elements they name, as the
    /// module has them now (whole blocks), with the basedOn to send them on (that text kept as a read; else the capture this job
    /// runs on).</summary>
    private (string Ddl, JsonObject Data) ReadyDdl(DdlDocument edit, DdlDocument current, DataDdl built)
    {
        var parents = current.All().Where(e => e.Key.Length > 0).GroupBy(e => e.Key).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
        string? Top(string key) { if (!parents.TryGetValue(key, out var element)) return null; while (element.Parent != null) element = element.Parent; return element.Key; }
        var keys = edit.All().Concat(edit.Detached).Where(e => e.Key.Length > 0).Select(e => Top(e.Key)).OfType<string>().Distinct(StringComparer.Ordinal).ToList();
        var ddl = string.Join("\n\n", keys.Select(k => built.Blocks.FirstOrDefault(b => b.Key == k)?.Text).OfType<string>());
        var basedOn = KeepDdlReading(built) ?? BaseSha256;
        return (ddl, new JsonObject { ["edit"] = new JsonObject { ["ddl"] = ddl, ["basedOn"] = basedOn } });
    }

    private KernelRefusalException BaseRefusal(string code, DdlDocument edit, DdlDocument current, DataDdl built, string why, string fix)
    {
        var problems = edit.Elements.Concat(edit.Detached).Where(e => e.Key.Length > 0)
            .Select(e => new DdlProblem(e.Line, code, (e.Drop ? "drop " : "") + e.Name + " (@" + e.Key + ") " + why, fix)).ToList();
        if (problems.Count == 0) problems.Add(new DdlProblem(1, code, "the statements " + why, fix));
        return RefuseDdl(code, problems, edit, current, built);
    }

    // Every problem with the ready edit: its declarations as the patch of /ddl and data.edit with the basedOn to send.
    private KernelRefusalException RefuseDdl(string code, IReadOnlyList<DdlProblem> problems, DdlDocument edit, DdlDocument current, DataDdl built)
    {
        var (ddl, data) = ReadyDdl(edit, current, built);
        return SpecExpander.DdlRefusal(code, problems.Select(p => p with { Corrected = ddl.Length > 0 ? ddl : p.Corrected, Data = data }).ToList());
    }

    /// <summary>The ops of one round, in order: a failing op is kept with its line, the ops that use what it would have created
    /// are skipped, and the round is refused once with every failure (each problem with its line in the text).</summary>
    private void RunDdl(DdlCompilation compiled)
    {
        var failed = new HashSet<string>(StringComparer.Ordinal);
        var problems = new List<JsonObject>();
        var specAliases = compiled.Aliases.Values.Where(a => !a.StartsWith("$ddl", StringComparison.Ordinal)).ToHashSet(StringComparer.Ordinal);
        string? code = null;
        foreach (var (op, opLine, opWhat) in compiled.Ops())
        {
            var (line, what) = (opLine, opWhat);
            if (Uses(op, failed) is { } blocked)
            {
                if (op["as"]?.ToString() is { } skippedAlias) failed.Add(skippedAlias);
                continue;
            }
            try { ApplyOne(op); }
            catch (Exception ex)
            {
                if (op["as"]?.ToString() is { } alias) failed.Add(alias);
                if (op["op"]?.ToString() == "spec") failed.UnionWith(specAliases);
                var coded = Errors.FindCoded(ex);
                code ??= coded?.Code ?? "DDL_APPLY_FAILED";
                var message = Errors.Text(ex);
                // The spec of the new types fails as one op: its problem takes the line of the type its message names.
                if (op["op"]?.ToString() == "spec" && compiled.Created.Where(e => e.Parent == null)
                        .FirstOrDefault(e => System.Text.RegularExpressions.Regex.IsMatch(message, @"(?<![\w])" + System.Text.RegularExpressions.Regex.Escape(e.Name) + @"(?![\w])")) is { } named)
                    (line, what) = (named.Line, named.Name);
                if (coded?.Problems is { Count: > 0 } own)
                    foreach (var p in own.OfType<JsonObject>())
                    {
                        var copy = p.DeepClone().AsObject();
                        copy["line"] = line;
                        copy["message"] = $"line {line} ({what}): {copy["message"]}";
                        if (copy["pointer"] is not JsonValue pv || !pv.TryGetValue<string>(out var pointer) || pointer.StartsWith('/')) { copy["pointer"] = "/ddl"; copy.Remove("patch"); }
                        problems.Add(copy);
                    }
                else
                {
                    var problem = JobPreflight.Problem(null, "/ddl", coded?.Code ?? "DDL_APPLY_FAILED", "error", $"line {line} ({what}): {DdlDescribe(op)}: {message}",
                        JobPreflight.FixFrom(message) ?? "change the statement so the module can take it, or leave it out", null, "spec");
                    problem["line"] = line;
                    problems.Add(JobPreflight.PublicProblem(problem));
                }
            }
        }
        if (problems.Count > 0)
            throw new KernelRefusalException(problems.Count == 1 ? code! : "DDL_REFUSED",
                string.Join(" | ", problems.Select(p => p["message"]?.ToString())), new JsonArray(problems.Select(p => (JsonNode)p).ToArray()));
    }

    /// <summary>The first alias of <paramref name="failed"/> an op names (as itself or as the root of a path), or null.</summary>
    private static string? Uses(JsonObject op, HashSet<string> failed)
    {
        if (failed.Count == 0) return null;
        foreach (var value in Strings(op))
            foreach (var alias in failed)
                if (value == alias || value.StartsWith(alias + "/", StringComparison.Ordinal) || value.StartsWith(alias + ".", StringComparison.Ordinal)) return alias;
        return null;

        static IEnumerable<string> Strings(JsonNode? node)
        {
            switch (node)
            {
                case JsonValue v when v.TryGetValue<string>(out var s): yield return s; break;
                case JsonObject o: foreach (var (key, child) in o) if (key != "as") foreach (var s in Strings(child)) yield return s; break;
                case JsonArray a: foreach (var child in a) foreach (var s in Strings(child)) yield return s; break;
            }
        }
    }

    private static string DdlDescribe(JsonObject op) => op["op"]?.ToString() switch
    {
        "set" => $"set {op["prop"]} = {op["value"]?.ToJsonString() ?? "null"}",
        "rename" => $"rename to {op["name"]}",
        "move" => op["into"] != null ? $"move into {op["into"]}" : op["after"] != null ? $"move after {op["after"]}" : "move first",
        "create" => $"create {op["type"]} {op["name"]}",
        "delete" => "delete",
        var other => other ?? "op",
    };

    /// <summary>The keys of what the first round created, found in the module's text now by their place and name (a top-level
    /// element by kind and name among the new ones, a part by its parent's key and its name); the ones not found.</summary>
    private static List<DdlElement> KeyCreated(List<DdlElement> created, DdlDocument current, HashSet<string> known)
    {
        var lost = new List<DdlElement>();
        foreach (var element in created.OrderBy(e => e.Parent == null ? 0 : 1))
        {
            if (element.Key.Length > 0) continue;
            IEnumerable<DdlElement> candidates;
            if (element.Parent == null) candidates = current.Elements.Where(e => !known.Contains(e.Key));
            else if (element.Parent.Key.Length > 0 && current.All().FirstOrDefault(e => e.Key == element.Parent.Key) is { } parent) candidates = parent.Children;
            else { lost.Add(element); continue; }
            var match = candidates.FirstOrDefault(c => (c.Kind == element.Kind || c.Kind is "Record" or "StaticEntityRecord" && element.Kind is "Record" or "StaticEntityRecord")
                && c.Name == element.Name && !known.Contains(c.Key));
            if (match == null) { lost.Add(element); continue; }
            element.Key = match.Key;
            known.Add(match.Key);
        }
        return lost;
    }

    private static DdlDocument WithoutDrops(DdlDocument edit)
    {
        var copy = new DdlDocument { Schema = edit.Schema, Module = edit.Module, Lane = edit.Lane, SourceSha256 = edit.SourceSha256 };
        copy.Elements.AddRange(edit.Elements.Where(e => !e.Drop));
        return copy;
    }

    /// <summary>`move {into:"folder:Name"}` (DL2): the folder of that name in the branch of the module tree the element is listed
    /// under (Entities, Structures, …), created there when the module has none.</summary>
    private object FolderInBranch(IObjectSignature element, string name)
    {
        var ao = (ServiceStudio.Model.AbstractObject)element;
        var branch = ao.AbstractObjectKind.GetESpaceTreeFolderForObject(ao).ToString();
        var found = new KernelModelReader().Walk(_es).OfType<IFolder>()
            .Where(f => string.Equals(TypeResolver.Name(f), name, StringComparison.Ordinal) && f.ParentFolder.ToString() == branch).ToList();
        if (found.Count > 0) return found[0];
        if (branch == null) throw new InvalidOperationException($"move into folder:{name}: {Describe(element)} is not listed in a branch of the module tree");
        var created = Create(new JsonObject { ["op"] = "create", ["parent"] = "@espace", ["type"] = "IFolder", ["name"] = name, ["args"] = new JsonObject { ["parentFolder"] = branch } });
        return Resolve("@" + created["key"]!.ToString());
    }
}
