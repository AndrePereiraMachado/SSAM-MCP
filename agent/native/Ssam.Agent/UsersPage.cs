using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Ssam.Agent;

// What the agent sends to the Users application, read from the page the agent itself fetched: the rules of agent/lib/users-page.mjs. The table
// is the whole of it: for each operation the route, the control and the fields. A page that does not have exactly what the table expects
// is refused (USERS_PAGE_NOT_KNOWN). delete, revoke-role and remove-group are not here. tests/native/users.test.mjs compares the two.
internal static class UsersPage
{
    internal sealed class Control
    {
        public required string Tag; public required Dictionary<string, string> Attrs; public string Value = ""; public string Label = "";
        public string? Name; public string Id = ""; public string Type = "";
        public string? Attr(string key) => Attrs.TryGetValue(key, out var value) ? value : null;
        public bool Has(string key) => Attrs.ContainsKey(key);
        public Control With(string value) => new() { Tag = Tag, Attrs = Attrs, Value = value, Label = Label, Name = Name, Id = Id, Type = Type };
    }
    internal sealed class Page { public string Action = ""; public string Text = ""; public List<Control> Controls = []; }
    internal sealed record Plan(string Url, List<KeyValuePair<string, string>> Fields, List<string> SecretFields, JsonArray Rows, string? Username);

    internal static AgentFault Unknown(string what) => new("USERS_PAGE_NOT_KNOWN", "This page is not the one this agent knows (" + what + "); nothing was sent.", false);

    private const RegexOptions O = RegexOptions.CultureInvariant;
    private const RegexOptions OI = RegexOptions.CultureInvariant | RegexOptions.IgnoreCase;
    private const string Quoted = "(?:\"[^\"]*\"|'[^']*'|[^'\">])*";
    private static readonly Regex Entity = new("&(?:#([0-9]{1,7})|#x([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos|nbsp));", O);
    private static readonly Regex Tags = new("<[^>]*>", O);
    private static readonly Regex Hidden = new("[\\u0000-\\u001f\\u007f-\\u00a0\\u00ad\\u1680\\u180e\\u2000-\\u200f\\u2028-\\u202f\\u205f-\\u206f\\u3000\\ufeff]+", O);
    private static readonly Regex Spaces = new(" +", O);
    private static readonly Regex BadSpacing = new("^ | \\z| {2}", O);
    private static readonly Regex Tag = new("<(input|select|textarea|a|button)\\b(" + Quoted + ")>", OI);
    private static readonly Regex Attribute = new("([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+)))?", O);
    private static readonly Regex Option = new("<option\\b(" + Quoted + ")>([^<]*)", OI);
    private static readonly Regex Comment = new("<!--[\\s\\S]*?-->", O);
    private static readonly Regex Script = new("<script\\b[\\s\\S]*?</script\\s*>", OI);
    private static readonly Regex Style = new("<style\\b[\\s\\S]*?</style\\s*>", OI);
    private static readonly Regex FormTag = new("<form\\b(" + Quoted + ")>", OI);
    private static readonly Regex Ajax = new("OsAjax\\([^,]*,\\s*'([^']*)'\\s*,\\s*'([^']*)'", O);
    private static readonly Regex Back = new("__doPostBack\\('([^']*)','([^']*)'\\)", O);
    private static readonly Regex H1 = new("<h1\\b[^>]*>([\\s\\S]*?)</h1\\s*>", OI);
    private static readonly Regex Div = new("<div\\b(" + Quoted + ")>([^<]*)", OI);
    private static readonly Regex TitleClass = new("(?:^|\\s)title(?:\\s|\\z)", OI);
    private static readonly Regex TableTag = new("<table\\b(" + Quoted + ")>([\\s\\S]*?)</table\\s*>", OI);
    private static readonly Regex Row = new("<tr\\b[^>]*>([\\s\\S]*?)</tr\\s*>", OI);
    private static readonly Regex Cell = new("<td\\b[^>]*>([\\s\\S]*?)</td\\s*>", OI);
    private static readonly Regex LoginForm = new("<form\\b[^>]*\\baction\\s*=\\s*[\"'][^\"']*Login\\.aspx", OI);
    private static readonly Regex State = new("\"__OSVSTATE\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"", O);
    private static readonly Regex Literal = new("\"((?:[^\"\\\\]|\\\\.)*)\"", RegexOptions.CultureInvariant | RegexOptions.Singleline);
    private static readonly Regex InputTag = new("<input\\b", OI);
    private static readonly Regex WholeHtml = new("^\\s*(?:<!doctype|<html)", OI);

    internal static string Decode(string? text) => Entity.Replace(text ?? "", m =>
    {
        if (m.Groups[3].Success) return m.Groups[3].Value switch { "amp" => "&", "lt" => "<", "gt" => ">", "quot" => "\"", "apos" => "'", _ => " " };
        var code = m.Groups[1].Success ? int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture) : int.Parse(m.Groups[2].Value, NumberStyles.HexNumber, CultureInfo.InvariantCulture);
        if (code > 0x10ffff) return "";
        return code is >= 0xd800 and <= 0xdfff ? ((char)code).ToString() : char.ConvertFromUtf32(code);
    });
    // A value read from a page, for a window: one line, nothing that hides or reorders text.
    internal static string CleanText(string? text, int max = 120)
    {
        var line = Spaces.Replace(Hidden.Replace(Decode(Tags.Replace(text ?? "", " ")), " "), " ").Trim(' ');
        return line.Length > max ? line[..max] + "..." : line;
    }
    // A value the server asks to write: exactly what will be sent and shown, so nothing may hide in it.
    internal static bool PlainValue(string? value, int max) => value is { Length: > 0 } && value.Length <= max && !Hidden.IsMatch(value) && !BadSpacing.IsMatch(value);

    private static Dictionary<string, string> AttrsOf(string text)
    {
        var attrs = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (Match m in Attribute.Matches(text))
        {
            var key = m.Groups[1].Value.ToLowerInvariant();
            if (!attrs.ContainsKey(key)) attrs[key] = Decode(m.Groups[2].Success ? m.Groups[2].Value : m.Groups[3].Success ? m.Groups[3].Value : m.Groups[4].Value);
        }
        return attrs;
    }
    private static string Stripped(string html) => Style.Replace(Script.Replace(Comment.Replace(html, ""), ""), "");
    private static List<Control> ControlsOf(string text)
    {
        var list = new List<Control>();
        foreach (Match m in Tag.Matches(text))
        {
            var tag = m.Groups[1].Value.ToLowerInvariant();
            var attrs = AttrsOf(m.Groups[2].Value);
            var after = m.Index + m.Length;
            string Inner() { var end = text.IndexOf("</" + tag, after, StringComparison.OrdinalIgnoreCase); return end < 0 ? "" : text[after..end]; }
            var value = attrs.GetValueOrDefault("value", "");
            var label = "";
            if (tag is "a" or "button") label = CleanText(Inner(), 200);
            if (tag == "textarea") value = Decode(Inner());
            if (tag == "select")
            {
                var options = Option.Matches(Inner()).Select(o => (Attrs: AttrsOf(o.Groups[1].Value), Text: Decode(o.Groups[2].Value).Trim())).ToList();
                var chosen = options.FindIndex(o => o.Attrs.ContainsKey("selected"));
                if (chosen < 0 && options.Count > 0) chosen = 0;
                value = chosen < 0 ? "" : options[chosen].Attrs.GetValueOrDefault("value", options[chosen].Text);
            }
            var type = attrs.TryGetValue("type", out var given) ? given : tag == "button" ? "submit" : tag == "input" ? "text" : tag;
            list.Add(new Control { Tag = tag, Attrs = attrs, Value = value, Label = label, Name = attrs.GetValueOrDefault("name"), Id = attrs.GetValueOrDefault("id", ""), Type = type.ToLowerInvariant() });
        }
        return list;
    }
    internal static Page ParsePage(string html)
    {
        var text = Stripped(html);
        var forms = FormTag.Matches(text);
        if (forms.Count != 1) throw Unknown("its form");
        var attrs = AttrsOf(forms[0].Groups[1].Value);
        if (!string.Equals(attrs.GetValueOrDefault("method", ""), "post", StringComparison.OrdinalIgnoreCase)) throw Unknown("its form");
        return new Page { Action = attrs.GetValueOrDefault("action", ""), Text = text, Controls = ControlsOf(text) };
    }
    private static string CaptionOf(Control c) => c.Attr("value") is { Length: > 0 } value ? value : c.Label;
    private static Control One(List<Control> list, string what) => list.Count == 1 ? list[0] : throw Unknown(what);
    private static Control ById(Page page, string suffix) => One(page.Controls.Where(c => c.Id.EndsWith(suffix, StringComparison.Ordinal)).ToList(), suffix);
    private static Control ByCaption(Page page, string caption) => One(page.Controls.Where(c => CaptionOf(c) == caption && c.Type != "hidden" && !c.Has("disabled")).ToList(), caption);

    private static bool Skipped(string type) => type is "submit" or "button" or "image" or "reset";
    private static bool IsEvent(string name) => name is "__EVENTTARGET" or "__EVENTARGUMENT" or "__AJAX" or "__AJAXEVENT";
    private static List<KeyValuePair<string, string>> FieldsOf(Page page, bool ajax)
    {
        var pairs = new List<KeyValuePair<string, string>>();
        foreach (var c in page.Controls)
        {
            if (c.Name == null || c.Tag == "a" || Skipped(c.Type) || IsEvent(c.Name)) continue;
            if (c.Type is "checkbox" or "radio")
            {
                if (c.Has("checked")) pairs.Add(new(c.Name, ajax && c.Has("disabled") ? "on" : c.Value.Length > 0 ? c.Value : "on"));
                else if (ajax && c.Type == "checkbox") pairs.Add(new(c.Name, "off"));
                continue;
            }
            pairs.Add(new(c.Name, c.Value));
        }
        return pairs;
    }
    // The form as a browser would send it for this one control, with these fields changed: nothing else changes.
    private static List<KeyValuePair<string, string>> RequestFor(Page page, Control control, Dictionary<string, string>? updates = null)
    {
        updates ??= [];
        var source = (control.Attr("href") ?? "") + "\n" + (control.Attr("onclick") ?? "");
        var names = page.Controls.Select(c => c.Name).Where(n => n != null).ToHashSet();
        foreach (var key in updates.Keys) if (!names.Contains(key)) throw Unknown(key);
        var ajax = source.Contains("OsAjax", StringComparison.Ordinal);
        var back = Back.Match(source);
        Match? ajaxMatch = null;
        if (ajax) { ajaxMatch = Ajax.Match(source); if (!ajaxMatch.Success) throw Unknown("its control"); }
        else if (!back.Success && (control.Tag == "a" || control.Type is not ("submit" or "image") || control.Name == null || source.Contains(".submit(", StringComparison.Ordinal))) throw Unknown("its control");
        var pairs = FieldsOf(page, ajax).Where(pair => !updates.ContainsKey(pair.Key)).ToList();
        pairs.AddRange(updates);
        if (ajax)
        {
            var name = control.Name ?? ajaxMatch!.Groups[2].Value;
            pairs.Add(new("__EVENTTARGET", name)); pairs.Add(new("__EVENTARGUMENT", ""));
            pairs.Add(new("__AJAX", "1280,1024," + (control.Id.Length > 0 ? control.Id : name.Replace('$', '_')) + ",0,0,0,0,0,0,"));
        }
        else if (back.Success) { pairs.Add(new("__EVENTTARGET", back.Groups[1].Value)); pairs.Add(new("__EVENTARGUMENT", back.Groups[2].Value)); }
        else pairs.Add(new(control.Name!, control.Attr("value") ?? ""));
        return pairs;
    }
    // The form's own address, which must be the route of the table. A form that names another page or another user sends nothing.
    private static string UrlFor(Page page, string host, string route)
    {
        var expected = "https://" + host + route;
        var path = route.Split('?')[0];
        var action = page.Action;
        var full = action.Length == 0 ? expected : action.StartsWith("https://", StringComparison.Ordinal) ? action : action.StartsWith('/') ? "https://" + host + action : "https://" + host + "/Users/" + (action.StartsWith("./", StringComparison.Ordinal) ? action[2..] : action);
        if (full != expected && full != "https://" + host + path) throw Unknown("the address of its form");
        return expected;
    }
    private static string TitleOf(Page page)
    {
        var h1 = H1.Match(page.Text);
        if (h1.Success && CleanText(h1.Groups[1].Value).Length > 0) return CleanText(h1.Groups[1].Value);
        var last = "";
        foreach (Match m in Div.Matches(page.Text))
        {
            var attrs = AttrsOf(m.Groups[1].Value);
            if (attrs.GetValueOrDefault("id", "").EndsWith("wtTitle", StringComparison.Ordinal) && TitleClass.IsMatch(attrs.GetValueOrDefault("class", "")) && CleanText(m.Groups[2].Value).Length > 0) last = CleanText(m.Groups[2].Value);
        }
        return last;
    }
    // The username in the details table of a user's page: never a label from a request.
    private static string UsernameOf(Page page)
    {
        foreach (Match m in TableTag.Matches(page.Text))
        {
            if (!AttrsOf(m.Groups[1].Value).GetValueOrDefault("id", "").EndsWith("wtUserShow", StringComparison.Ordinal)) continue;
            foreach (Match row in Row.Matches(m.Groups[2].Value))
            {
                var cells = Cell.Matches(row.Groups[1].Value).Select(c => CleanText(c.Groups[1].Value, 256)).ToList();
                if (cells.Count == 2 && cells[0] == "Username" && cells[1].Length > 0) return cells[1];
            }
        }
        throw Unknown("the username of this user");
    }
    private static string UserRoute(string page, string? id = null) => "/Users/" + page + ".aspx" + (id != null ? "?UserId=" + id : "");
    internal static string UserPage(string id) => UserRoute("User_Show", id);
    private static readonly Dictionary<string, string> ChangeField = new(StringComparer.Ordinal) { ["name"] = "wtUser_Name", ["username"] = "wtUser_Username", ["email"] = "wtUser_Email", ["phone"] = "wtUser_Phone" };
    private static Dictionary<string, string> ChangesToFields(Page page, JsonObject? changes)
    {
        var fields = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (key, value) in changes ?? []) fields[ById(page, ChangeField[key]).Name ?? throw Unknown(key)] = value!.GetValue<string>();
        return fields;
    }
    internal static readonly Dictionary<string, string> ActionText = new(StringComparer.Ordinal)
    {
        ["activate"] = "Activate this user", ["deactivate"] = "Deactivate this user: the user loses access", ["grant-role"] = "Give this role to this user",
        ["add-group"] = "Add this user to this group: the user gets its roles", ["update"] = "Change the details of this user", ["create"] = "Create this user", ["set-password"] = "Set a new password for this user",
    };
    internal static List<string> RoutesOf(string action, string? userId, string? targetId) => action switch
    {
        "activate" or "deactivate" or "set-password" => [UserRoute("User_Show", userId)],
        "grant-role" => [UserRoute("User_Show", userId), "/Users/Role_Show.aspx?RoleId=" + targetId],
        "add-group" => [UserRoute("User_Show", userId), "/Users/Group_Show.aspx?GroupId=" + targetId],
        "update" => [UserRoute("User_Edit", userId), UserRoute("User_Show", userId)],
        "create" => [UserRoute("User_Edit")],
        _ => throw Unknown("its operation"),
    };
    internal static JsonObject RowOf(string label, string? value, bool data = false)
    {
        var row = new JsonObject { ["label"] = label, ["value"] = value };
        if (data) row["data"] = true;
        return row;
    }
    // What goes out and what the window says. pages: the html of RoutesOf, in order.
    internal static Plan PlanWrite(string action, string host, string? userId, string? targetId, JsonObject? changes, IReadOnlyList<string> pages)
    {
        if (!ActionText.TryGetValue(action, out var text)) throw Unknown("its operation");
        var page = ParsePage(pages[0]);
        var rows = new JsonArray(RowOf("What will happen", text));
        void User(string username)
        {
            rows.Add((JsonNode)RowOf("User id", userId)); rows.Add((JsonNode)RowOf("Username", username, true));
            var name = TitleOf(page);
            if (name.Length > 0) rows.Add((JsonNode)RowOf("Name", name, true));
        }
        if (action is "activate" or "deactivate")
        {
            var username = UsernameOf(page);
            User(username);
            var link = ById(page, "wtEnableDisableLink");
            if (CaptionOf(link) != (action == "activate" ? "Set as Active" : "Set as Inactive")) throw Unknown("its status");
            return new Plan(UrlFor(page, host, UserRoute("User_Show", userId)), RequestFor(page, link), [], rows, username);
        }
        if (action is "grant-role" or "add-group")
        {
            var username = UsernameOf(page);
            User(username);
            var (suffix, label) = action == "grant-role" ? ("wtNewRole", "Role") : ("wtNewGroupInput", "Group");
            var targetName = TitleOf(ParsePage(pages[1]));
            if (targetName.Length == 0) throw Unknown("the name of this " + label.ToLowerInvariant());
            rows.Add((JsonNode)RowOf(label + " id", targetId)); rows.Add((JsonNode)RowOf(label, targetName, true));
            var input = ById(page, suffix);
            // Only what stands between this input and the next block's: the Add of the group is never the Add of the role.
            var rest = page.Controls.Skip(page.Controls.IndexOf(input) + 1).ToList();
            var next = rest.FindIndex(c => c.Id.EndsWith("wtNewRole", StringComparison.Ordinal) || c.Id.EndsWith("wtNewGroupInput", StringComparison.Ordinal));
            var after = next < 0 ? rest : rest.Take(next).ToList();
            var auto = after.Find(c => c.Id.EndsWith("wttxtAutoCompleteValue", StringComparison.Ordinal)) ?? throw Unknown("its autocomplete");
            var add = after.Find(c => CaptionOf(c) == "Add" && c.Type != "hidden") ?? throw Unknown("its Add");
            if (input.Name == null || auto.Name == null) throw Unknown("its fields");
            return new Plan(UrlFor(page, host, UserRoute("User_Show", userId)), RequestFor(page, add, new Dictionary<string, string>(StringComparer.Ordinal) { [input.Name] = targetName, [auto.Name] = targetId! }), [], rows, username);
        }
        if (action == "update")
        {
            var username = UsernameOf(ParsePage(pages[1]));
            rows.Add((JsonNode)RowOf("User id", userId)); rows.Add((JsonNode)RowOf("Username now", username, true));
            foreach (var (key, value) in changes!) rows.Add((JsonNode)RowOf("New " + key, value!.GetValue<string>()));
            return new Plan(UrlFor(page, host, UserRoute("User_Edit", userId)), RequestFor(page, ByCaption(page, "Save"), ChangesToFields(page, changes)), [], rows, username);
        }
        if (action == "create")
        {
            var secretFields = PasswordFields(page, "wtPasswordInput");
            var save = ByCaption(page, "Save");
            var fields = RequestFor(page, save, ChangesToFields(page, changes)).Where(pair => !secretFields.Contains(pair.Key)).ToList();
            return new Plan(UrlFor(page, host, UserRoute("User_Edit")), fields, secretFields, rows, changes!["username"]!.GetValue<string>());
        }
        var who = UsernameOf(page);
        User(who);
        return new Plan(UrlFor(page, host, UserRoute("User_Show", userId)), RequestFor(page, ByCaption(page, "Set Password")), [], rows, who);
    }
    private static List<string> PasswordFields(Page page, string first) => new[] { first, "wtConfirmPasswordInput" }.Select(suffix =>
    {
        var c = ById(page, suffix);
        return c.Type == "password" && c.Name != null ? c.Name : throw Unknown(suffix);
    }).ToList();
    // The answer of the Set Password button, a whole page or an OsAjax reply, gives the form of the second step.
    internal static Plan PlanSavePassword(string host, string userId, string firstHtml, string reply)
    {
        var route = UserRoute("User_Show", userId);
        var first = ParsePage(firstHtml);
        Page page;
        if (WholeHtml.IsMatch(reply)) page = ParsePage(reply);
        else
        {
            var state = State.Match(reply);
            if (!state.Success) throw Unknown("the password form");
            var markup = string.Concat(Literal.Matches(reply).Select(m => JsonText(m.Groups[1].Value)).Where(text => InputTag.IsMatch(text)));
            var refreshed = ControlsOf(Stripped(markup));
            var names = refreshed.Select(c => c.Name).Where(n => n != null).ToHashSet();
            var retained = first.Controls.Where(c => c.Name != null && !names.Contains(c.Name) && !Skipped(c.Type) && c.Tag != "a").Select(c => c.Name!.EndsWith("__OSVSTATE", StringComparison.Ordinal) ? c.With(JsonText(state.Groups[1].Value)) : c).ToList();
            page = new Page { Action = first.Action, Text = Stripped(markup), Controls = [.. retained, .. refreshed] };
        }
        var secretFields = PasswordFields(page, "wtNewPasswordInput");
        var fields = RequestFor(page, ByCaption(page, "Save")).Where(pair => !secretFields.Contains(pair.Key)).ToList();
        return new Plan(UrlFor(page, host, route), fields, secretFields, [], null);
    }
    private static string JsonText(string literal)
    {
        try { return JsonNode.Parse("\"" + literal + "\"")?.GetValue<string>() ?? ""; }
        catch (JsonException) { return ""; }
    }
    // A search of the two lists: the one POST that changes nothing, built here too.
    internal static Plan PlanSearch(string host, bool inactive, string text, string html)
    {
        var page = ParsePage(html);
        var route = "/Users/" + (inactive ? "Inactive_Users" : "User_List") + ".aspx";
        var input = ById(page, "wtSearchInput");
        if (input.Name == null) throw Unknown("its search");
        return new Plan(UrlFor(page, host, route), RequestFor(page, ByCaption(page, "Search"), new Dictionary<string, string>(StringComparer.Ordinal) { [input.Name] = text }), [], [], null);
    }
    // A page that asks to sign in again: the session is gone.
    internal static bool IsLoginPage(string html) => LoginForm.IsMatch(html);
}
