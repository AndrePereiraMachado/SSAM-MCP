using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>
/// C27 of the atritos 3 package: a raw `set` is judged like the rest of the job, never only by the Verify after a build.
/// <list type="bullet">
/// <item>CanSet mirrors every write path of SetCore: the preflight against the base refuses a property the target has no way
/// to write (PROPERTY_NOT_WRITABLE, with the closest), all at once, before the first op (JobRunner.CheckAgainstBase).</item>
/// <item>Style on a widget without Style is written where that widget keeps it: StyleClasses (IPlaceholderWidget), else the
/// extended property `class` (IAdvancedHtml; the rule HtmlVisual.Attributes uses), reported in the notes.</item>
/// <item>An expression property written as plain words (`Jogo da Velha`) is the text it means (quoted); `Type:Entity/Attribute`
/// (the form ssam_map prints, lab 32: `IServerEntity:Product/Id` as a Sort) is `Entity.Attribute`; both reported in
/// expressionRewrites. Unbalanced quotes are ambiguous: EXPRESSION_SYNTAX with the pointer.</item>
/// </list>
/// </summary>
public sealed partial class ModelSession
{
    /// <summary>Whether SetCore has a way to write <paramref name="prop"/> on <paramref name="target"/> (the same branches).</summary>
    internal bool CanSet(object target, string prop)
    {
        if (prop == "SpecialOptions" && TraditionalWidgetMetadata.Combo(target.GetType())) return true;
        if (target is ServiceStudio.Model.EntityIndex && prop == "Unique") return true;
        var pi = FindProperty(target, prop);
        if (pi != null && (pi.CanWrite || prop == "Roles")) return true;
        if (target is OutSystems.Model.Logic.Nodes.IRefreshDataNode && prop is "StartIndex" or "MaxRecords") return true;
        if (pi != null) { try { if (pi.GetValue(target) is IExpression) return true; } catch { } }
        if (target is OutSystems.Model.Logic.Nodes.IRecordListToExcelNode && prop == "AttributeSelection") return true;
        if (FindMethod(target, "Set" + prop, 1) != null) return true;
        if (pi != null && ListEditors(target, pi) != null) return true;
        return FindMethod(target, "From" + prop, 1) is { } parser && parser.GetParameters()[0].ParameterType == typeof(string);
    }

    /// <summary>Whether Style written on <paramref name="target"/> has a place StyleRule writes it to (StyleClasses, or the
    /// extended property `class`).</summary>
    internal bool StyleHasAPlace(object target) => CanSet(target, "StyleClasses") || FindCreate(target, "IExtendedProperty").Count > 0;

    /// <summary>The apply's refusal of a property the target cannot write (PropertyError), for the preflight against the base.</summary>
    internal static string PropertyErrorText(object target, string prop) => PropertyError(target, prop);

    /// <summary>The writable names of the target closest to <paramref name="prop"/>.</summary>
    internal static IReadOnlyList<string> ClosestWritable(object target, string prop)
        => NameSuggestions.Closest(prop, AllProperties(target).Where(p => p.CanWrite).Select(p => p.Name)
            .Concat(AllMethods(target).Where(m => m.Name.StartsWith("Set", StringComparison.Ordinal) && m.GetParameters().Length == 1).Select(m => m.Name[3..])));

    /// <summary>Whether a property of <paramref name="target"/> holds an OutSystems expression (an IExpression to write the Text
    /// of, or the ODC ExpressionDefinition a writable property parses).</summary>
    internal static bool IsExpressionProperty(object target, string prop)
    {
        var pi = FindProperty(target, prop);
        if (pi == null) return false;
        if (pi.CanWrite) return pi.PropertyType.FullName == "OutSystems.Model.Expressions.ExpressionDefinition";
        // Every interface may declare the name (a signature as text, the element as an expression): any declaration of an
        // expression type says it is one; an empty expression reads as null (as PropertyError lists expression.Text).
        if (AllProperties(target).Any(p => p.Name == prop && typeof(IExpression).IsAssignableFrom(p.PropertyType))) return true;
        try { return pi.GetValue(target) is IExpression; } catch { return false; }
    }

    /// <summary>Style written on a widget that keeps its classes elsewhere: the op on StyleClasses, or done here as the extended
    /// property `class` (the result), or the op as it was.</summary>
    private (JsonObject Op, JsonNode? Done) StyleRule(object target, JsonObject op)
    {
        if (op["prop"]?.ToString() != "Style" || CanSet(target, "Style")) return (op, null);
        var path = op["target"]?.ToString() ?? Describe(target);
        if (CanSet(target, "StyleClasses"))
        {
            Note("SET_PROPERTY_MAPPED", $"{path}: {ShortType(target)} keeps its classes in StyleClasses (it has no Style); the value was written there");
            var copy = op.DeepClone().AsObject(); copy["prop"] = "StyleClasses";
            return (copy, null);
        }
        if (FindCreate(target, "IExtendedProperty").Count == 0) return (op, null);
        var value = op["value"]?.ToString() ?? "";
        var extended = Create(new JsonObject { ["op"] = "create", ["parent"] = path, ["type"] = "IExtendedProperty" });
        var created = Resolve("@" + extended["key"]);
        SetCore(created, new JsonObject { ["op"] = "set", ["target"] = "@" + extended["key"], ["prop"] = "Property", ["value"] = "class" });
        SetCore(created, new JsonObject { ["op"] = "set", ["target"] = "@" + extended["key"], ["prop"] = "Value", ["value"] = "\"" + value.Replace("\"", "\"\"") + "\"" });
        Note("SET_PROPERTY_MAPPED", $"{path}: {ShortType(target)} has no Style; the classes became its extended property class, as an html class attribute does");
        return (op, new JsonObject { ["set"] = "Style", ["via"] = "extended property class" });
    }

    private static readonly Regex KindPath = new(@"^\s*I?[A-Z][A-Za-z0-9]*:([A-Za-z_][A-Za-z0-9_]*)/([A-Za-z_][A-Za-z0-9_]*)\s*$", RegexOptions.Compiled);
    private static readonly Regex Literals = new("\"(?:[^\"]|\"\")*\"", RegexOptions.Compiled);

    /// <summary>The rewrite of an expression the job wrote (pure): (the new text, the rule) or null when it stays; the third item
    /// is a syntax problem the kernel will not guess at (unbalanced quotes).</summary>
    internal static (string? Text, string? Rule, string? Syntax) ExpressionRewrite(string text)
    {
        if (Literals.Replace(text, "").Contains('"')) return (null, null, "the quotes of the expression are unbalanced");
        if (KindPath.Match(text) is { Success: true } path) return ($"{path.Groups[1].Value}.{path.Groups[2].Value}", "kind-path", null);
        var tokens = Preflight.ExpressionText.Tokens(text);
        if (tokens.Count >= 2 && tokens.All(t => t.Kind is Preflight.TokenKind.Name or Preflight.TokenKind.Number) && tokens.Any(t => t.Kind == Preflight.TokenKind.Name)
            && tokens.All(t => !t.Text.Contains('.')))
            return ("\"" + text.Trim().Replace("\"", "\"\"") + "\"", "plain-words", null);
        return (null, null, null);
    }

    /// <summary>The text written to an expression property: rewritten and reported when a rule applies; EXPRESSION_SYNTAX when the
    /// quotes are unbalanced.</summary>
    private string Expression(object target, string prop, string text, string path)
    {
        // A flow text is the source: its expressions are written as the text has them (Verbs.Flow.cs).
        if (_verbatim) return text;
        // The sort of an aggregate is one attribute and a direction, as the Studio writes it (AggregateSortRule.cs): before the
        // other rules, which would read `Name DESC` as plain words.
        if (prop == "Attribute" && Implements(target, "ISort") && SortAttribute(target, text, path) is var sorted && !string.Equals(sorted, text, StringComparison.Ordinal))
            return sorted;
        var (rewritten, rule, syntax) = ExpressionRewrite(text);
        if (syntax != null)
            throw new KernelRefusalException("EXPRESSION_SYNTAX", $"set {prop} on {Describe(target)}: {syntax}: {text}",
                new JsonArray(JobPreflight.PublicProblem(JobPreflight.Problem(null, "/value", "EXPRESSION_SYNTAX", "error",
                    $"{prop} = {text}: {syntax}", "close every text literal with \" (a quote inside a text is written \"\")"))));
        if (rewritten == null) return text;
        Report("expressionRewrites", path + "/" + prop, text, rewritten);
        return rewritten;
    }
}
