using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// CX17, the native look of what the html op writes (declared in the answer of the op, never in silence): the page marker on the
/// element at the top of a screen the op created (PAGE_MARKED_FOR_LAYOUT) and the class the Studio gives a new widget written
/// without class (STYLE_STUDIO_CLASS_KEPT / STYLE_STUDIO_CLASS_TRIMMED, whose note says "the reading writes it as class=...").
/// The reading of a screen written from scratch is what it says plus exactly what the answer of its op declares: each declared
/// addition is in the text as many times as the answer counts it and is taken out here; no other marker of the engine is in it.
/// Review of the CX17 merge, B2: the notes of one class are summed (an Input and a TextArea are both form-control), and the
/// classes the author wrote (the authored text) are discounted and stay where the authored text has them.
/// </summary>
internal static class DeclaredLook
{
    /// <summary>The reading's text without the additions the answer of the op that wrote <paramref name="root"/> declares.
    /// <paramref name="authored"/>: the text the author wrote (the body the caller looks for), whose own classes are not additions.</summary>
    public static string WithoutDeclared(string text, JsonNode result, string root, string? authored = null)
    {
        var notes = result["results"]!.AsArray().Select(r => r!["result"]).OfType<JsonObject>().Where(r => r["root"]?.ToString() == root)
            .SelectMany(r => r["normalized"] as JsonArray ?? []).OfType<JsonObject>().ToList();
        var marked = notes.Where(n => n["code"]?.ToString() == ScreenVisual.PageMarked).Sum(n => n["count"]?.GetValue<int>() ?? 1);
        Assert.Equal(marked, Regex.Matches(text, " data-ssam-page=\"1\"").Count);
        text = text.Replace(" data-ssam-page=\"1\"", "");
        // Per class: the counts of every note that writes it, summed.
        var declared = notes.Where(n => n["code"]?.ToString() is ScreenVisual.StudioClassKept or ScreenVisual.StudioClassTrimmed)
            .GroupBy(n => " class=\"" + Regex.Match(n["note"]!.ToString(), "the reading writes it as class=\"([^\"]*)\"").Groups[1].Value + "\"", StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => g.Sum(n => n["count"]!.GetValue<int>()), StringComparer.Ordinal);
        var own = declared.Keys.ToDictionary(a => a, a => authored == null ? 0 : Occurrences(authored, a), StringComparer.Ordinal);
        foreach (var (attribute, count) in declared)
            Assert.True(count + own[attribute] == Occurrences(text, attribute),
                $"{attribute.Trim()}: the answer declares {count}, the author wrote {own[attribute]}, the reading has {Occurrences(text, attribute)}");
        if (own.Values.All(n => n == 0)) foreach (var attribute in declared.Keys) text = text.Replace(attribute, "");
        else
        {
            text = WithoutAdded(text, authored!, declared.Keys.ToList());
            foreach (var (attribute, count) in own) Assert.Equal(count, Occurrences(text, attribute));
        }
        Assert.DoesNotContain("data-ssam-", text);
        return text;
    }

    private static int Occurrences(string text, string part) => Regex.Matches(text, Regex.Escape(part)).Count;

    /// <summary>The text without the declared classes it adds to the authored text: the authored text is found in it with those
    /// attributes as the only thing the text may add (where the author wrote the same class, both ways are tried), and every
    /// occurrence the author did not write there is taken out. No such place: the test fails.</summary>
    private static string WithoutAdded(string text, string authored, IReadOnlyList<string> attributes)
    {
        string? At(string s, int i) => attributes.FirstOrDefault(a => s.AsSpan(i).StartsWith(a, StringComparison.Ordinal));
        var failed = new HashSet<(int, int)>();
        var kept = new List<int>();   // where the text has a class the author wrote
        bool Match(int i, int j)
        {
            var start = (i, j);
            if (failed.Contains(start)) return false;
            while (j < authored.Length)
            {
                if (At(text, i) is { } attribute)
                {
                    if (authored.AsSpan(j).StartsWith(attribute, StringComparison.Ordinal))
                    {
                        kept.Add(i);
                        if (Match(i + attribute.Length, j + attribute.Length)) return true;
                        kept.RemoveAt(kept.Count - 1);
                    }
                    i += attribute.Length;   // an addition the answer declares
                    continue;
                }
                if (i >= text.Length || text[i] != authored[j]) { failed.Add(start); return false; }
                i++; j++;
            }
            return true;
        }
        for (var s = text.IndexOf(authored[0]); s >= 0; s = text.IndexOf(authored[0], s + 1))
        {
            kept.Clear();
            if (!Match(s, 0)) continue;
            var keep = new HashSet<int>(kept);
            var written = new StringBuilder();
            for (var i = 0; i < text.Length;)
            {
                if (!keep.Contains(i) && At(text, i) is { } attribute) { i += attribute.Length; continue; }
                written.Append(text[i++]);
            }
            return written.ToString();
        }
        Assert.Fail("the authored text is not in the reading with only the declared classes added (" + string.Join(", ", attributes.Select(a => a.Trim())) + ")");
        return text;
    }
}
