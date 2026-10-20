using System.Text.Json.Nodes;

namespace Anvil.Reading;

// The three-way merge of a data text (ssam-ddl/1) written on an older read, the limit the screens closed with ScreenHtmlMerge:
// base = the module's data text of the read the edit names (basedOn: the capture's sha256, whose text the store keeps since
// ssam_map view ddl served it), theirs = the module's text now (changed in the Studio since), ours = the statements the edit
// sends (only the ones that change). Elements are matched by @key. For every name, property (a type with its size and the
// entity it references as one value; a reference to an attribute by the attribute's key), record value, index column and call
// argument: what only one side changed is taken from that side; what both changed differently is a conflict, and the
// delivery's version wins (the owner's rule), listed with what the Studio had and what was delivered. Inside a statement sent
// whole, an attribute or record the Studio added after the read is kept (never deleted because the edit does not have it);
// one the edit left out that the Studio changed is deleted and listed; one the Studio removed that the edit changed is written
// again as a new element (its key is gone) and listed. A `drop` of an element the Studio changed is a conflict (dropped,
// listed); of one the Studio already removed, nothing. A new statement named like an element the Studio created since the read
// edits that element (the delivery's values win, what only the Studio wrote stays); so does a new attribute or record named
// like one the Studio added to the same element. Two elements of one name the two sides brought otherwise (a rename onto the
// name of one the other side added) are refused (DDL_MERGE_NAME_TAKEN). What the Studio renamed is read in its new names in
// the edit. An element the statements name by a key the read does not have (created after it: the keys came from a receipt)
// is held to the rule without a read: a statement of it that differs from the module now is refused with its current
// declaration (DDL_BASE_UNKNOWN), never compiled as sent. The result is the edit the compiler (DdlCompiler) then diffs against
// the module now: only what the delivery changed is written. Free of Studio types.
public static class DdlMerge
{
    public sealed class Result
    {
        public DdlDocument Edit = new();
        public readonly List<JsonObject> Conflicts = [];
        // Elements the Studio added since the read that the statements now carry (and so keep).
        public readonly List<string> Kept = [];
        // Statements left out because the Studio removed what they name and they change nothing of it.
        public readonly List<string> Notes = [];
        // What cannot be merged (an element the read does not have that the statements change; two elements of one name): the
        // caller refuses with them, nothing is compiled.
        public readonly List<DdlProblem> Problems = [];
    }

    private static readonly string[] AttributeRefs = ["LabelAttribute", "OrderByAttribute", "IsActiveAttribute", "Identifier"];
    private static readonly HashSet<string> TypeUnit = new(StringComparer.Ordinal) { "DataType", "Length", "Decimals" };

    public static Result ThreeWay(DdlDocument @base, DdlDocument theirs, DdlDocument ours, string lane) => new Merger(@base, theirs, ours, lane).Run();

    // Without the read (another store, a trimmed store, an older read): a statement with a key cannot tell what the Studio changed
    // since from what it changes. One that says what the module says now changes nothing and goes; every other one (a property
    // that differs, an attribute or record left out, a drop of what the module has) is a problem with the current declaration
    // as the patch: nothing is compiled as sent against the module now.
    public static List<DdlProblem> WithoutRead(DdlDocument theirs, DdlDocument ours, string basedOn, string lane)
    {
        var problems = new List<DdlProblem>();
        var tops = theirs.Elements.Where(e => e.Key.Length > 0).GroupBy(e => e.Key).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
        foreach (var top in ours.Elements.Where(e => e.Key.Length > 0)) {
            if (!tops.TryGetValue(top.Key, out var now)) {
                if (!top.Drop) problems.Add(Unknown(top.Line, top.Name + " (@" + top.Key + ") is not an element of the module now", "the read this text was written on (basedOn "
                    + basedOn + ") is not kept here", null, "write the statement without the key to create it, or read the data again (ssam_map view ddl)"));
                continue;
            }
            if (Differs(top, now) is { } why)
                problems.Add(Unknown(top.Line, (top.Drop ? "drop " : "") + now.Name + " (@" + now.Key + ") " + why, "the read this text was written on (basedOn " + basedOn + ") is not kept here",
                    Declaration(theirs.Text, now.Key), null));
        }
        var all = theirs.All().Where(e => e.Key.Length > 0).GroupBy(e => e.Key).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
        foreach (var statement in ours.Detached.Where(e => e.Key.Length > 0)) {
            if (!all.TryGetValue(statement.Key, out var now) || now.Parent == null || now.Parent.Name != statement.Of) {
                problems.Add(Unknown(statement.Line, statement.Name + " (@" + statement.Key + ") is not a statement of entity " + statement.Of + " now",
                    "the read this text was written on (basedOn " + basedOn + ") is not kept here", null, "read the data again (ssam_map view ddl)"));
                continue;
            }
            if (!Merger.SameDetached(statement, now))
                problems.Add(Unknown(statement.Line, statement.Name + " (@" + statement.Key + ") differs from its declaration now",
                    "the read this text was written on (basedOn " + basedOn + ") is not kept here", Declaration(theirs.Text, now.Parent.Key), null));
        }
        return problems;
    }

    // How a statement differs from its element now (null: it says what the module says): what it leaves out, else that it differs.
    private static string? Differs(DdlElement statement, DdlElement now)
    {
        if (statement.Drop) return "is dropped by the text";
        var written = statement.Children.Where(c => c.Key.Length > 0).Select(c => c.Key).ToHashSet(StringComparer.Ordinal);
        var left = now.Children.Where(c => (Members(c) || statement.HasValues && IsValuesRecord(c, now)) && !written.Contains(c.Key)).Select(c => now.Name + "." + c.Name + " (@" + c.Key + ")").ToList();
        if (left.Count > 0) return "leaves out " + string.Join(", ", left);
        return Merger.ChangedStatement(statement, now) ? "differs from its declaration now" : null;
    }

    private static DdlProblem Unknown(int line, string what, string why, string? current, string? fix) =>
        new(line, "DDL_BASE_UNKNOWN", what + ", and " + why + ": what changed in the Studio since cannot be told from what the statement changes, so nothing of it is written"
            + (current != null ? " (its declaration now is the patch)" : ""),
            fix ?? "write the statement on the declaration as the module has it now (the patch; the edit of this problem carries every declaration this text names, with the basedOn to send), or read the data again (ssam_map view ddl)",
            current);

    // The declaration of a top-level element in a data text: its block (the statement and the ones of its own after it, up to
    // the blank line), found by the key of its first statement. Null when the text does not have it.
    public static string? Declaration(string? text, string key)
    {
        if (text == null) return null;
        foreach (var block in text.Replace("\r\n", "\n").Split("\n\n")) {
            var lines = block.Trim('\n').Split('\n');
            var first = Array.FindIndex(lines, l => !l.StartsWith("///", StringComparison.Ordinal) && !l.StartsWith("-- ", StringComparison.Ordinal));
            if (first < 0 || !lines[first].EndsWith(" -- @" + key, StringComparison.Ordinal)) continue;
            // The description lines of the element (///) stay with it; a header line of the text (-- ssam-ddl/1) does not.
            return string.Join("\n", lines.Take(first).Where(l => l.StartsWith("///", StringComparison.Ordinal)).Concat(lines.Skip(first)));
        }
        return null;
    }

    private static bool Members(DdlElement element) => element.Kind is "EntityAttribute" or "StructureAttribute";
    private static bool IsRecord(DdlElement element) => element.Kind is "Record" or "StaticEntityRecord";
    private static bool IsValuesRecord(DdlElement element, DdlElement owner) => IsRecord(element) && owner.Kind == "StaticEntity";
    // The statements of their own inside an entity's block: indexes, events, the sample record.
    private static bool OwnStatement(DdlElement element, DdlElement owner) => element.Kind == "EntityIndex" || DdlRules.IsEventKind(element.Kind) || IsRecord(element) && owner.Kind != "StaticEntity";
    private static string Family(string kind) => DdlRules.IsEntityKind(kind) || kind == "Structure" ? "type" : kind;

    // One kept child merged (base, ours, theirs), under the merged parent m, with the three owners it is read in.
    private delegate DdlElement MergeOne(DdlElement was, DdlElement mine, DdlElement now, DdlElement m, DdlElement wasOwner, DdlElement mineOwner, DdlElement nowOwner, string element);

    private sealed class Merger(DdlDocument @base, DdlDocument theirs, DdlDocument ours, string lane)
    {
        private readonly Result result = new();
        private readonly Dictionary<string, DdlElement> b = new(StringComparer.Ordinal), t = new(StringComparer.Ordinal);
        // References to attributes taken from one side, by the attribute's key: named after the members are merged.
        private readonly List<(DdlElement Element, string Property, string Attribute)> refs = [];

        public Result Run()
        {
            // What the Studio renamed (and the edit did not rename otherwise) is read in its new name in the edit and the read.
            var studio = DdlCompiler.RenamesOf(theirs, @base);
            var mine = DdlCompiler.RenamesOf(ours, @base);
            foreach (var name in mine.Types.Keys) studio.Types.Remove(name);
            foreach (var name in mine.Site.Keys) studio.Site.Remove(name);
            foreach (var name in mine.Client.Keys) studio.Client.Remove(name);
            foreach (var name in mine.Session.Keys) studio.Session.Remove(name);
            foreach (var (entity, records) in mine.Records) if (studio.Records.TryGetValue(entity, out var theirsRecords)) foreach (var name in records.Keys) theirsRecords.Remove(name);
            DdlCompiler.Canonical(ours, studio, lane);
            DdlCompiler.Canonical(@base, studio, lane);
            foreach (var element in @base.All()) if (element.Key.Length > 0) b.TryAdd(element.Key, element);
            foreach (var element in theirs.All()) if (element.Key.Length > 0) t.TryAdd(element.Key, element);
            var edit = result.Edit;
            edit.Schema = ours.Schema; edit.Module = ours.Module; edit.Lane = ours.Lane; edit.SourceSha256 = ours.SourceSha256;
            foreach (var statement in ours.Detached) MergeDetached(statement);
            foreach (var top in ours.Elements) {
                if (top.Drop) { Drop(top); continue; }
                if (top.Key.Length == 0) { edit.Elements.Add(NewTop(top)); continue; }
                b.TryGetValue(top.Key, out var was); t.TryGetValue(top.Key, out var now);
                // A key the read does not have of an element the module has now (created after the read): the rule without a read.
                if (was == null && now != null && now.Parent == null) {
                    if (Differs(top, now) is { } why)
                        result.Problems.Add(Unknown(top.Line, now.Name + " (@" + now.Key + ") " + why, "the read this text was written on does not have it (it was created after that read)",
                            Declaration(theirs.Text, now.Key), null));
                    else result.Notes.Add($"{Words(now)} {now.Name} (@{now.Key}) was created after the read and the statement says what the module has: nothing to write");
                    continue;
                }
                // A key neither the read nor the module has, or not a top-level element: the compiler says what is wrong with it.
                if (was == null || was.Parent != null || now != null && now.Parent != null) { edit.Elements.Add(top); continue; }
                if (now == null) {
                    if (!ChangedStatement(top, was)) { result.Notes.Add($"{Words(was)} {was.Name} (@{was.Key}) was removed in the Studio since the read and the statement changes nothing of it: left out"); continue; }
                    Conflict(was.Key, Words(was) + " " + was.Name, "removed in the Studio", "(removed)", Show(top),
                        "changed by the delivery and removed in the Studio since the read: written again as a new element (the delivery's version; its key is gone)");
                    edit.Elements.Add(Fresh(top, null));
                    continue;
                }
                edit.Elements.Add(MergeTop(was, top, now, Words(now) + " " + now.Name));
            }
            TopNames(edit);
            return result;
        }

        // An owner omitted from the edit is not an owner omitted from the read. Its keyed standalone statements obey
        // the same three-way rules as those written under an entity; new unkeyed statements still copy unchanged.
        private void MergeDetached(DdlElement mine)
        {
            if (mine.Key.Length == 0) { result.Edit.Detached.Add(Copy(mine, null)); return; }
            b.TryGetValue(mine.Key, out var was);
            t.TryGetValue(mine.Key, out var now);
            if (was?.Parent is not { } wasOwner)
            {
                var unknown = new DdlDocument(); unknown.Detached.Add(mine);
                var problems = WithoutRead(theirs, unknown, "the requested read", lane);
                result.Problems.AddRange(problems);
                if (problems.Count == 0) result.Edit.Detached.Add(Copy(mine, null));
                return;
            }
            var nowOwner = now?.Parent;
            if (nowOwner == null && t.TryGetValue(wasOwner.Key, out var liveOwner)) nowOwner = liveOwner;
            if (nowOwner == null || (mine.Of != wasOwner.Name && mine.Of != nowOwner.Name))
            {
                result.Problems.Add(Unknown(mine.Line, mine.Name + " (@" + mine.Key + ") is not a statement of entity " + mine.Of + " now",
                    "the keyed statement must keep its owner", null, "read the data again (ssam_map view ddl)"));
                return;
            }
            if (now != null && now.Parent?.Key != wasOwner.Key)
            {
                result.Problems.Add(Unknown(mine.Line, mine.Name + " (@" + mine.Key + ") no longer belongs to entity " + mine.Of,
                    "the keyed statement must keep its owner", null, "read the data again (ssam_map view ddl)"));
                return;
            }
            if (now == null && SameOwn(mine, was, wasOwner, wasOwner))
            {
                result.Notes.Add($"{Words(was)} {was.Name} (@{was.Key}) was removed in the Studio since the read and the statement changes nothing of it: left out");
                return;
            }
            if (now == null)
                Conflict(was.Key, Words(was) + " " + was.Name, "removed in the Studio", "(removed)", Show(mine),
                    "changed by the delivery and removed in the Studio since the read: written again (the delivery's version; its key is gone)");
            var owner = Copy(nowOwner, null);
            var merged = MergeOwn(was, mine, now ?? was, owner, wasOwner, wasOwner, now?.Parent ?? wasOwner,
                Words(nowOwner) + " " + nowOwner.Name);
            merged.Of = nowOwner.Name;
            if (now == null) merged.Key = "";
            result.Edit.Detached.Add(merged);
        }

        // A statement the delivery renamed onto the name of a top-level element the Studio created (or renamed) since the read,
        // or a new statement named like one the Studio renamed: two elements of one name. (A new statement named like one the
        // Studio created is that element: NewTop.)
        private void TopNames(DdlDocument edit)
        {
            foreach (var mine in edit.Elements.Where(e => !e.Drop)) {
                var renamed = mine.Key.Length > 0 && b.TryGetValue(mine.Key, out var was) && !string.Equals(was.Name, mine.Name, StringComparison.OrdinalIgnoreCase);
                if (!renamed && mine.Key.Length > 0) continue;
                var other = theirs.Elements.FirstOrDefault(e => e.Key.Length > 0 && e.Key != mine.Key && Family(e.Kind) == Family(mine.Kind)
                    && string.Equals(e.Name, mine.Name, StringComparison.OrdinalIgnoreCase)
                    && (!b.TryGetValue(e.Key, out var before) ? renamed : !string.Equals(before.Name, e.Name, StringComparison.OrdinalIgnoreCase)));
                if (other != null) NameTaken(mine.Line, mine.Name, Words(other) + " " + other.Name + " (@" + other.Key + ")", Declaration(theirs.Text, other.Key));
            }
        }

        private void NameTaken(int line, string name, string other, string? current) =>
            result.Problems.Add(new DdlProblem(line, "DDL_MERGE_NAME_TAKEN", "the statement names an element " + name + ", and since the read the Studio gave that name to "
                + other + ": two elements of one name that are not the same element", "give it another name, or write the statement on the module as it is now (the edit of this problem)", current));

        // ---- top-level statements ----------------------------------------------------------------------------------------------

        private void Drop(DdlElement drop)
        {
            b.TryGetValue(drop.Key, out var was); t.TryGetValue(drop.Key, out var now);
            if (now == null && was != null) { result.Notes.Add($"drop {drop.Name} (@{drop.Key}): already removed in the Studio since the read"); return; }
            // A drop of an element the read does not have (created after it, its key from a receipt): the rule without a read, as
            // for any other statement of such a key (correction 2: what the Studio did to it since was dropped with nothing listed).
            if (was == null && now != null && now.Parent == null) {
                result.Problems.Add(Unknown(drop.Line, "drop " + now.Name + " (@" + now.Key + ") is dropped by the text", "the read this text was written on does not have it (it was created after that read)",
                    Declaration(theirs.Text, now.Key), null));
                return;
            }
            if (now != null && was != null && !SameWhole(now, was))
                Conflict(drop.Key, Words(now) + " " + now.Name, "dropped by the delivery", Show(now), "(dropped)",
                    "dropped by the delivery and changed in the Studio since the read: dropped (the delivery's version)");
            result.Edit.Elements.Add(drop);
        }

        // A statement without a key is new; named like an element the Studio created since the read (same family, no key in the
        // read), it edits that element: the delivery's values win, what only the Studio wrote stays (listed).
        private DdlElement NewTop(DdlElement top)
        {
            var created = theirs.Elements.FirstOrDefault(e => e.Key.Length > 0 && !b.ContainsKey(e.Key) && Family(e.Kind) == Family(top.Kind)
                && string.Equals(e.Name, top.Name, StringComparison.OrdinalIgnoreCase));
            if (created == null || created.Kind != top.Kind) return top;
            var claimed = Copy(top, null);
            claimed.Key = created.Key;
            foreach (var child in claimed.Children.Where(c => c.Key.Length == 0)) {
                var same = created.Children.FirstOrDefault(c => c.Kind == child.Kind && string.Equals(c.Name, child.Name, StringComparison.OrdinalIgnoreCase));
                if (same != null && !claimed.Children.Any(c => c.Key == same.Key)) child.Key = same.Key;
            }
            var empty = new DdlElement { Kind = created.Kind, Name = top.Name, Key = created.Key };
            Conflict(created.Key, Words(created) + " " + created.Name, "created in the Studio", Show(created), Show(top),
                "created by the delivery and in the Studio since the read with the same name: one element, the delivery's values first, what only the Studio wrote kept");
            return MergeTop(empty, claimed, created, Words(created) + " " + created.Name);
        }

        private DdlElement MergeTop(DdlElement was, DdlElement mine, DdlElement now, string element)
        {
            var m = Shell(mine, null);
            m.Name = Choose(mine.Name, was.Name, now.Name, Same, () => Conflict(now.Key, element, "name", now.Name, mine.Name))!;
            Properties(m, was, mine, now, element);
            Arguments(m, was, mine, now, element);
            // Attributes (structure attributes), and the records of a static entity when the statement has its values.
            var members = mine.Children.Concat(now.Children).Concat(was.Children).Where(Members).Select(c => c.Kind).Distinct().ToList();
            foreach (var kind in members) Keyed(m, was, mine, now, c => c.Kind == kind, MergeMember, element);
            if (mine.HasValues) Keyed(m, was, mine, now, c => IsRecord(c) && mine.Kind == "StaticEntity", MergeRecord, element);
            // Indexes, events and the sample record the statement writes (their own statements: what it does not write stays).
            foreach (var own in mine.Children.Where(c => OwnStatement(c, mine))) {
                if (own.Key.Length > 0 && !b.ContainsKey(own.Key) && t.TryGetValue(own.Key, out var ownCreated) && ownCreated.Parent?.Key == now.Key) {
                    // Created after the read (its key came from a receipt): the rule without a read.
                    if (!SameOwn(own, ownCreated, mine, now))
                        result.Problems.Add(Unknown(own.Line, element + "." + own.Name + " (@" + own.Key + ") differs from its declaration now", "the read this text was written on does not have it (it was created after that read)",
                            Declaration(theirs.Text, now.Key), null));
                    Add(m, Copy(own, m));
                    continue;
                }
                if (own.Key.Length == 0 || !b.TryGetValue(own.Key, out var ownWas)) { Add(m, Copy(own, m)); continue; }
                if (!t.TryGetValue(own.Key, out var ownNow) || ownNow.Parent?.Key != now.Key) {
                    if (!SameOwn(own, ownWas, mine, was)) {
                        Conflict(own.Key, Words(own) + " " + own.Name, "removed in the Studio", "(removed)", Show(own),
                            "changed by the delivery and removed in the Studio since the read: written again (the delivery's version; its key is gone)");
                        Add(m, Fresh(own, m));
                    }
                    continue;
                }
                Add(m, MergeOwn(ownWas, own, ownNow, m, was, mine, now, element));
            }
            Collide(m, was, mine, now, element);
            foreach (var (owner, property, attribute) in refs.Where(r => ReferenceEquals(r.Element, m)).ToList())
                if (MergedName(m, attribute) is { } named) m.Props[property] = named;
            refs.RemoveAll(r => ReferenceEquals(r.Element, m));
            // Values and columns copied from one side name attributes as that side does: in the merged names (by key).
            string Named(string name)
            {
                if (m.Children.Any(c => c.Kind == "EntityAttribute" && c.Name == name)) return name;
                foreach (var side in new[] { mine, now, was })
                    if (AttributeKey(side, name) is var key && key.StartsWith('@') && MergedName(m, key) is { } merged) return merged;
                return name;
            }
            foreach (var child in m.Children) {
                for (var i = 0; i < child.Values.Count; i++) child.Values[i] = (Named(child.Values[i].Attribute), child.Values[i].Value);
                for (var i = 0; i < child.Columns.Count; i++) child.Columns[i] = Named(child.Columns[i]);
            }
            return m;
        }

        // ---- children ------------------------------------------------------------------------------------------------------------

        // The children of one merged statement by name without case, per family (attributes, records, indexes): two of one name
        // where each side brought one (new on that side, or renamed by it). Both new and of the same kind (an attribute of the
        // same type, a record): one element, the delivery's values on the Studio's element (its key), listed; otherwise refused.
        private void Collide(DdlElement m, DdlElement was, DdlElement mine, DdlElement now, string element)
        {
            static string Kin(DdlElement e) => Members(e) ? "member" : IsRecord(e) ? "record" : e.Kind;
            bool StudioNew(DdlElement c) => c.Key.Length > 0 && !b.ContainsKey(c.Key) && t.ContainsKey(c.Key);
            bool Renamed(DdlElement c, DdlElement side) => c.Key.Length > 0 && was.Children.FirstOrDefault(x => x.Key == c.Key) is { } before
                && side.Children.FirstOrDefault(x => x.Key == c.Key) is { } after && !string.Equals(before.Name, after.Name, StringComparison.OrdinalIgnoreCase)
                && string.Equals(after.Name, c.Name, StringComparison.OrdinalIgnoreCase);
            foreach (var group in m.Children.Where(c => c.Name.Length > 0).GroupBy(c => Kin(c) + "\u0001" + c.Name.ToLowerInvariant()).Where(g => g.Count() > 1).ToList()) {
                var list = group.ToList();
                var studio = list.Where(c => StudioNew(c) || Renamed(c, now)).ToList();
                var delivered = list.Where(c => c.Key.Length == 0 || Renamed(c, mine)).ToList();
                if (studio.Count == 0 || delivered.Count == 0) continue;
                if (list.Count == 2 && studio.Count == 1 && delivered.Count == 1 && StudioNew(studio[0]) && delivered[0].Key.Length == 0 && studio[0].Kind == delivered[0].Kind
                    && (IsRecord(studio[0]) || TypeOf(studio[0]) == TypeOf(delivered[0]))) {
                    var keep = studio[0]; var claim = delivered[0];
                    claim.Key = keep.Key;
                    m.Children.Remove(keep);
                    result.Kept.Remove(now.Name + "." + keep.Name);
                    Conflict(keep.Key, element + "." + keep.Name, "created in the Studio and by the delivery", Show(keep), Show(claim),
                        "created by the delivery and in the Studio since the read with the same name: one element, the delivery's values");
                    continue;
                }
                NameTaken(delivered[0].Line, element + "." + delivered[0].Name, string.Join(", ", studio.Select(c => element + "." + c.Name + " (@" + c.Key + ")")), Declaration(theirs.Text, now.Key));
            }
        }

        private static string TypeOf(DdlElement e) => (e.Props.GetValueOrDefault("DataType") ?? "") + "\u0001" + (e.Props.GetValueOrDefault("Length") ?? "") + "\u0001"
            + (e.Props.GetValueOrDefault("Decimals") ?? "") + "\u0001" + (e.References ?? "");

        private void Keyed(DdlElement m, DdlElement was, DdlElement mine, DdlElement now, Func<DdlElement, bool> which,
            MergeOne one, string element)
        {
            var bs = was.Children.Where(which).ToList(); var os = mine.Children.Where(which).ToList(); var ts = now.Children.Where(which).ToList();
            var bm = bs.Where(c => c.Key.Length > 0).GroupBy(c => c.Key).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
            var tm = ts.Where(c => c.Key.Length > 0).GroupBy(c => c.Key).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
            var merged = new List<(string Id, DdlElement Element)>();
            var oursOrder = new List<string>();
            var counter = 0;
            foreach (var child in os) {
                var id = child.Key.Length > 0 ? child.Key : "new:" + ++counter;
                oursOrder.Add(id);
                if (child.Key.Length == 0) { merged.Add((id, Copy(child, m))); continue; }
                bm.TryGetValue(child.Key, out var x); tm.TryGetValue(child.Key, out var z);
                if (x == null && z == null) { merged.Add((id, Copy(child, m))); continue; }     // foreign: the compiler says so
                if (x == null) {
                    // Created after the read (its key came from a receipt): the rule without a read.
                    if (!SameOwn(child, z!, mine, now))
                        result.Problems.Add(Unknown(child.Line, element + "." + child.Name + " (@" + child.Key + ") differs from its declaration now",
                            "the read this text was written on does not have it (it was created after that read)", Declaration(theirs.Text, now.Key), null));
                    merged.Add((id, Copy(child, m)));
                    continue;
                }
                if (z == null) {
                    if (!SameOwn(child, x!, mine, was)) {
                        Conflict(child.Key, element + "." + child.Name, "removed in the Studio", "(removed)", Show(child),
                            "changed by the delivery and removed in the Studio since the read: written again as a new element (the delivery's version; its key is gone)");
                        var copy = Fresh(child, m);
                        oursOrder[^1] = "new:" + ++counter;
                        merged.Add((oursOrder[^1], copy));
                    }
                    continue;
                }
                merged.Add((id, one(x ?? z, child, z, m, was, mine, now, element)));
            }
            // What the statement leaves out: removed by the delivery (listed when the Studio changed it), or added in the Studio
            // after the read (kept).
            var written = os.Where(c => c.Key.Length > 0).Select(c => c.Key).ToHashSet(StringComparer.Ordinal);
            foreach (var child in ts.Where(c => !written.Contains(c.Key))) {
                if (bm.TryGetValue(child.Key, out var x)) {
                    if (!SameOwn(child, x, now, was))
                        Conflict(child.Key, element + "." + child.Name, "removed by the delivery", Show(child), "(removed)",
                            "left out of the statement by the delivery and changed in the Studio since the read: deleted (the delivery's version)");
                    continue;
                }
                merged.Add((child.Key, Copy(child, m, line: mine.Line)));
                result.Kept.Add(now.Name + "." + child.Name);
            }
            var exists = merged.Select(p => p.Id).ToHashSet(StringComparer.Ordinal);
            var order = Order(bs.Select(c => c.Key).ToList(), oursOrder, ts.Select(c => c.Key).ToList(), exists, out var clash);
            if (clash) Conflict(now.Key, element, "order", string.Join(", ", ts.Select(c => c.Name)), string.Join(", ", os.Select(c => c.Name)),
                "the order changed in the Studio and by the delivery since the read: the delivery's, with what the Studio added after the element it follows");
            var byId = merged.ToDictionary(p => p.Id, p => p.Element, StringComparer.Ordinal);
            foreach (var id in order) Add(m, byId[id]);
        }

        private DdlElement MergeMember(DdlElement was, DdlElement mine, DdlElement now, DdlElement m, DdlElement wasOwner, DdlElement mineOwner, DdlElement nowOwner, string element)
        {
            var name = element + "." + now.Name;
            var merged = Shell(mine, m);
            merged.Name = Choose(mine.Name, was.Name, now.Name, Same, () => Conflict(now.Key, name, "name", now.Name, mine.Name))!;
            Properties(merged, was, mine, now, name);
            return merged;
        }

        private DdlElement MergeRecord(DdlElement was, DdlElement mine, DdlElement now, DdlElement m, DdlElement wasOwner, DdlElement mineOwner, DdlElement nowOwner, string element)
        {
            var name = element + "." + now.Name;
            var merged = Shell(mine, m);
            merged.Name = Choose(mine.Name, was.Name, now.Name, Same, () => Conflict(now.Key, name, "name", now.Name, mine.Name))!;
            Properties(merged, was, mine, now, name);
            Values(merged, was, mine, now, wasOwner, mineOwner, nowOwner, name);
            return merged;
        }

        // An index, an event or the sample record the statement writes, kept by its key.
        private DdlElement MergeOwn(DdlElement was, DdlElement mine, DdlElement now, DdlElement m, DdlElement wasOwner, DdlElement mineOwner, DdlElement nowOwner, string element)
        {
            var name = element + "." + now.Name;
            var merged = Shell(mine, m);
            merged.Name = Choose(mine.Name, was.Name, now.Name, Same, () => Conflict(now.Key, name, "name", now.Name, mine.Name))!;
            Properties(merged, was, mine, now, name);
            Arguments(merged, was, mine, now, name);
            Values(merged, was, mine, now, wasOwner, mineOwner, nowOwner, name);
            // Index columns, by the keys of the attributes they name, written in the names of the merged statement.
            var columns = Choose(Columns(mine, mineOwner), Columns(was, wasOwner), Columns(now, nowOwner), SameList,
                () => Conflict(now.Key, name, "columns", string.Join(", ", now.Columns), string.Join(", ", mine.Columns)))!;
            merged.Columns.Clear();
            merged.Columns.AddRange(columns.Select(k => MergedName(m, k) ?? k[1..]));
            return merged;
        }

        // ---- values ----------------------------------------------------------------------------------------------------------------

        // Every property one of the texts writes, by its value with defaults: what only one side changed comes from it (its own
        // text: written or left out). A type with its size and the entity it references is one value; a reference to an
        // attribute (label, order, active, identifier) is compared by the attribute's key.
        private void Properties(DdlElement m, DdlElement was, DdlElement mine, DdlElement now, string element)
        {
            var cw = new DdlParsedContext(was); var co = new DdlParsedContext(mine); var cn = new DdlParsedContext(now);
            var typed = mine.Props.ContainsKey("DataType") || now.Props.ContainsKey("DataType") || was.Props.ContainsKey("DataType");
            if (typed) {
                string Unit(DdlElement e, DdlParsedContext c) => string.Join("\u0001", TypeUnit.Order(StringComparer.Ordinal).Select(p => c.Value(p) ?? "")) + "\u0001" + (e.References ?? "");
                var side = Pick(Unit(mine, co), Unit(was, cw), Unit(now, cn), () => Conflict(now.Key, element, "type", TypeText(now), TypeText(mine)));
                var from = side == 'o' ? mine : now;
                foreach (var p in TypeUnit) { if (from.Props.TryGetValue(p, out var v)) m.Props[p] = v; else m.Props.Remove(p); }
                m.References = from.References;
            }
            foreach (var property in mine.Props.Keys.Concat(now.Props.Keys).Concat(was.Props.Keys).Distinct().ToList()) {
                if (TypeUnit.Contains(property)) continue;
                char side;
                if (AttributeRefs.Contains(property))
                    side = Pick(Identity(mine, co.Value(property)), Identity(was, cw.Value(property)), Identity(now, cn.Value(property)),
                        () => Conflict(now.Key, element, property, cn.Value(property), co.Value(property)));
                else
                    side = Pick(co.Value(property), cw.Value(property), cn.Value(property), () => Conflict(now.Key, element, property, cn.Value(property), co.Value(property)));
                var from = side == 'o' ? mine : now;
                if (from.Props.TryGetValue(property, out var value)) m.Props[property] = value; else m.Props.Remove(property);
                // An attribute named by a reference is named as the merged statement names it (after its members are merged).
                if (AttributeRefs.Contains(property) && value != null) refs.Add((m, property, Identity(from, value)!));
            }
        }

        // A call's arguments (a timer's, an event's handler), by parameter.
        private void Arguments(DdlElement m, DdlElement was, DdlElement mine, DdlElement now, string element)
        {
            if (mine.Arguments.Count == 0 && now.Arguments.Count == 0 && was.Arguments.Count == 0) return;
            static Dictionary<string, string> By(DdlElement e) => e.Arguments.GroupBy(a => a.Parameter, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.First().Value, StringComparer.Ordinal);
            var bw = By(was); var bo = By(mine); var bn = By(now);
            m.Arguments.Clear();
            foreach (var parameter in mine.Arguments.Select(a => a.Parameter).Concat(now.Arguments.Select(a => a.Parameter)).Concat(was.Arguments.Select(a => a.Parameter)).Distinct(StringComparer.Ordinal).ToList()) {
                var value = Choose(bo.GetValueOrDefault(parameter), bw.GetValueOrDefault(parameter), bn.GetValueOrDefault(parameter), DdlRules.Same,
                    () => Conflict(now.Key, element, "argument " + parameter, bn.GetValueOrDefault(parameter), bo.GetValueOrDefault(parameter)));
                if (value != null) m.Arguments.Add((parameter, value));
            }
        }

        // A record's values (Attribute = expression), by the key of the attribute (an attribute renamed on one side is the same).
        private void Values(DdlElement m, DdlElement was, DdlElement mine, DdlElement now, DdlElement wasOwner, DdlElement mineOwner, DdlElement nowOwner, string element)
        {
            if (mine.Values.Count == 0 && now.Values.Count == 0 && was.Values.Count == 0) return;
            Dictionary<string, (string Name, string Value)> By(DdlElement e, DdlElement owner) =>
                e.Values.GroupBy(v => AttributeKey(owner, v.Attribute), StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
            var bw = By(was, wasOwner); var bo = By(mine, mineOwner); var bn = By(now, nowOwner);
            m.Values.Clear();
            foreach (var key in bo.Keys.Concat(bn.Keys).Concat(bw.Keys).Distinct(StringComparer.Ordinal).ToList()) {
                var name = bo.TryGetValue(key, out var o) ? o.Name : bn.TryGetValue(key, out var n) ? n.Name : bw[key].Name;
                var value = Choose(bo.TryGetValue(key, out var ov) ? ov.Value : null, bw.TryGetValue(key, out var wv) ? wv.Value : null, bn.TryGetValue(key, out var nv) ? nv.Value : null,
                    DdlRules.Same, () => Conflict(now.Key, element, "value " + name, bn.GetValueOrDefault(key).Value, bo.GetValueOrDefault(key).Value));
                // The attribute as the merged statement names it (the delivery's name when it writes one).
                var attribute = MergedName(m.Parent ?? m, key) ?? name;
                if (value != null) m.Values.Add((attribute, value));
            }
        }

        private static string AttributeKey(DdlElement owner, string name) =>
            owner.Children.FirstOrDefault(c => c.Kind == "EntityAttribute" && c.Name == name) is { Key.Length: > 0 } a ? "@" + a.Key : "?" + name;

        private static string? MergedName(DdlElement owner, string key) =>
            key.StartsWith('@') ? owner.Children.FirstOrDefault(c => c.Kind == "EntityAttribute" && "@" + c.Key == key)?.Name : key.StartsWith('?') ? key[1..] : null;

        private static List<string> Columns(DdlElement index, DdlElement owner) => index.Columns.Select(c => AttributeKey(owner, c)).ToList();

        // The attribute a reference names, by its key ("?name" when no attribute of the element has it, null for none).
        private static string? Identity(DdlElement element, string? name)
        {
            if (name == null) return null;
            var owner = Members(element) ? element.Parent ?? element : element;
            return AttributeKey(owner, name);
        }

        private static string TypeText(DdlElement e) => (e.Props.GetValueOrDefault("DataType") ?? "") + (e.Props.TryGetValue("Length", out var l) && l != null ? "(" + l + (e.Props.TryGetValue("Decimals", out var d) && d != null ? "," + d : "") + ")" : "")
            + (e.References != null ? " references " + e.References : "");

        // ---- comparing ------------------------------------------------------------------------------------------------------------

        // 'o': the delivery's value; 't': the Studio's. Both changed differently: the delivery's, and onConflict says so.
        private static char Pick(string? ours, string? @base, string? theirs, Action onConflict)
        {
            if (DdlRules.Same(ours, @base)) return 't';
            if (DdlRules.Same(theirs, @base) || DdlRules.Same(theirs, ours)) return 'o';
            onConflict();
            return 'o';
        }

        private static T? Choose<T>(T? ours, T? @base, T? theirs, Func<T?, T?, bool> same, Action onConflict)
        {
            if (same(ours, @base)) return theirs;
            if (same(theirs, @base) || same(theirs, ours)) return ours;
            onConflict();
            return ours;
        }

        private static bool Same(string? x, string? y) => string.Equals(x, y, StringComparison.Ordinal);
        private static bool SameList(List<string>? x, List<string>? y) => x == null ? y == null : y != null && x.SequenceEqual(y, StringComparer.Ordinal);

        // The element itself (name, properties with defaults, type, values, columns, arguments), not its children.
        private static bool SameOwn(DdlElement x, DdlElement y, DdlElement xOwner, DdlElement yOwner)
        {
            if (x.Kind != y.Kind && !(IsRecord(x) && IsRecord(y)) || x.Name != y.Name || x.References != y.References) return false;
            var cx = new DdlParsedContext(x); var cy = new DdlParsedContext(y);
            foreach (var property in x.Props.Keys.Union(y.Props.Keys))
                if (AttributeRefs.Contains(property) ? Identity(x, cx.Value(property)) != Identity(y, cy.Value(property)) : !DdlRules.Same(cx.Value(property), cy.Value(property))) return false;
            var vx = x.Values.Select(v => (AttributeKey(xOwner, v.Attribute), v.Value)).OrderBy(v => v.Item1, StringComparer.Ordinal).ToList();
            var vy = y.Values.Select(v => (AttributeKey(yOwner, v.Attribute), v.Value)).OrderBy(v => v.Item1, StringComparer.Ordinal).ToList();
            if (vx.Count != vy.Count || vx.Zip(vy).Any(p => p.First.Item1 != p.Second.Item1 || !DdlRules.Same(p.First.Value, p.Second.Value))) return false;
            if (!Columns(x, xOwner).SequenceEqual(Columns(y, yOwner), StringComparer.Ordinal)) return false;
            return x.Arguments.OrderBy(a => a.Parameter, StringComparer.Ordinal).SequenceEqual(y.Arguments.OrderBy(a => a.Parameter, StringComparer.Ordinal));
        }

        // The whole element, its children by key and in order.
        private static bool SameWhole(DdlElement x, DdlElement y)
        {
            if (!SameOwn(x, y, x.Parent ?? x, y.Parent ?? y)) return false;
            var kx = x.Children.Select(c => c.Key).ToList(); var ky = y.Children.Select(c => c.Key).ToList();
            if (!kx.SequenceEqual(ky, StringComparer.Ordinal)) return false;
            for (var i = 0; i < x.Children.Count; i++) if (!SameOwn(x.Children[i], y.Children[i], x, y)) return false;
            return true;
        }

        // Whether a statement as sent changes the element it was read from: itself, its attributes, its records when it has its
        // values, the indexes, events and sample record it writes.
        internal static bool SameDetached(DdlElement statement, DdlElement now) => SameOwn(statement, now, now.Parent!, now.Parent!);

        internal static bool ChangedStatement(DdlElement statement, DdlElement was)
        {
            if (!SameOwn(statement, was, statement, was)) return true;
            bool Part(DdlElement c, DdlElement owner) => Members(c) || statement.HasValues && IsValuesRecord(c, owner);
            var mine = statement.Children.Where(c => Part(c, statement)).ToList(); var read = was.Children.Where(c => Part(c, was)).ToList();
            if (!mine.Select(c => c.Key).SequenceEqual(read.Select(c => c.Key), StringComparer.Ordinal)) return true;
            for (var i = 0; i < mine.Count; i++) if (!SameOwn(mine[i], read[i], statement, was)) return true;
            foreach (var own in statement.Children.Where(c => OwnStatement(c, statement)))
                if (own.Key.Length == 0 || was.Children.FirstOrDefault(c => c.Key == own.Key) is not { } before || !SameOwn(own, before, statement, was)) return true;
            return false;
        }

        // The order of the members: the side that changed the order of the ones all three have gives it (the delivery's when
        // both did), and what the other side added comes after the member it follows there.
        private static List<string> Order(List<string> bk, List<string> ok, List<string> tk, HashSet<string> exists, out bool clash)
        {
            var common = bk.Where(k => ok.Contains(k) && tk.Contains(k)).ToHashSet(StringComparer.Ordinal);
            var bc = bk.Where(common.Contains).ToList(); var oc = ok.Where(common.Contains).ToList(); var tc = tk.Where(common.Contains).ToList();
            List<string> primary, secondary;
            clash = false;
            if (oc.SequenceEqual(bc)) { primary = tk; secondary = ok; }
            else { primary = ok; secondary = tk; clash = !tc.SequenceEqual(bc) && !tc.SequenceEqual(oc); }
            var order = primary.Where(exists.Contains).Distinct().ToList();
            for (var i = 0; i < secondary.Count; i++) {
                var item = secondary[i];
                if (!exists.Contains(item) || order.Contains(item)) continue;
                var at = -1;
                for (var j = i - 1; j >= 0 && at < 0; j--) at = order.IndexOf(secondary[j]);
                order.Insert(at + 1, item);
            }
            foreach (var item in exists.Where(e => !order.Contains(e)).ToList()) order.Add(item);
            return order;
        }

        // ---- copies ---------------------------------------------------------------------------------------------------------------

        private static DdlElement Shell(DdlElement from, DdlElement? parent)
        {
            var copy = new DdlElement { Kind = from.Kind, Name = from.Name, Key = from.Key, Line = from.Line, Parent = parent, Of = from.Of, References = from.References,
                Drop = from.Drop, HasValues = from.HasValues };
            foreach (var (name, value) in from.Props) copy.Props[name] = value;
            copy.Values.AddRange(from.Values);
            copy.Columns.AddRange(from.Columns);
            copy.Arguments.AddRange(from.Arguments);
            return copy;
        }

        private static DdlElement Copy(DdlElement from, DdlElement? parent, int? line = null)
        {
            var copy = Shell(from, parent);
            if (line is { } l) copy.Line = l;
            foreach (var child in from.Children) copy.Children.Add(Copy(child, copy, line));
            return copy;
        }

        // A copy written as new (no keys): what the Studio removed and the delivery changed.
        private static DdlElement Fresh(DdlElement from, DdlElement? parent)
        {
            var copy = Copy(from, parent);
            foreach (var element in new[] { copy }.Concat(Descendants(copy))) element.Key = "";
            return copy;
        }

        private static IEnumerable<DdlElement> Descendants(DdlElement element)
        {
            foreach (var child in element.Children) { yield return child; foreach (var below in Descendants(child)) yield return below; }
        }

        private static void Add(DdlElement parent, DdlElement child) { child.Parent = parent; parent.Children.Add(child); }

        private string Words(DdlElement element) => element.Kind switch {
            "EntityAttribute" or "StructureAttribute" => "attribute", "Record" or "StaticEntityRecord" => "record", "EntityIndex" => "index", "Structure" => "type",
            "SiteProperty" => lane == "odc" ? "setting" : "site property", "ClientVariable" => "client variable", "SessionVariable" => "session variable", "Timer" => "timer",
            _ when DdlRules.IsEventKind(element.Kind) => "event",
            _ => DdlRules.EntityWords(element.Kind) + "entity" };

        // An element as its own line would read (name, type and properties), for the list of conflicts.
        private static string Show(DdlElement e)
        {
            var parts = new List<string> { e.Name };
            if (e.Props.GetValueOrDefault("DataType") is { } type) parts.Add(TypeText(e));
            foreach (var (name, value) in e.Props.Where(p => !TypeUnit.Contains(p.Key))) parts.Add(name + "=" + (value ?? "none"));
            if (e.Values.Count > 0) parts.Add("(" + string.Join(", ", e.Values.Select(v => v.Attribute + " = " + v.Value)) + ")");
            if (e.Columns.Count > 0) parts.Add("(" + string.Join(", ", e.Columns) + ")");
            if (e.Children.Count > 0) parts.Add("{" + string.Join("; ", e.Children.Select(c => c.Name)) + "}");
            return string.Join(" ", parts);
        }

        private void Conflict(string key, string element, string what, string? studio, string? delivered, string? note = null)
        {
            static string? Clip(string? text) => text == null ? null : text.Length <= 400 ? text : text[..400] + "…";
            result.Conflicts.Add(new JsonObject { ["key"] = key, ["element"] = element, ["what"] = what, ["studio"] = Clip(studio ?? "(none)"),
                ["delivered"] = Clip(delivered ?? "(none)"), ["kept"] = "delivery",
                ["note"] = note ?? "changed in the Studio and by the delivery since the read: the delivery's" });
        }
    }
}
