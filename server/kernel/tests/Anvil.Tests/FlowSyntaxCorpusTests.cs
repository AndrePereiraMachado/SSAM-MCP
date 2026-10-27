using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

/// <summary>The FLOW_SYNTAX refusals of real deliveries measured against the parser of now (R1, 24/10/2026). The corpus is a
/// local file of the receipts (SSAM_FLOW_SYNTAX_CORPUS: a JSON list of {message, text}, the text of the refused data.flow item),
/// never checked in; the report goes to SSAM_FLOW_SYNTAX_REPORT. Each message is: accepted (the text normalizes whole), patch (a
/// certain edit removes its line's error: the op's patch), candidates (two readings, each with its patch), shape (the refusal
/// names the accepted form or the shape to write beside the line) or dry (the refusal as before).</summary>
public sealed class FlowSyntaxCorpusTests
{
    [Fact]
    public void TheRefusalsOfTheReceiptsAreMeasured()
    {
        var corpus = Environment.GetEnvironmentVariable("SSAM_FLOW_SYNTAX_CORPUS");
        if (string.IsNullOrEmpty(corpus) || !File.Exists(corpus)) return;
        var report = new JsonArray();
        foreach (var entry in JsonNode.Parse(File.ReadAllText(corpus))!.AsArray().OfType<JsonObject>()) {
            var message = entry["message"]!.GetValue<string>();
            var text = entry["text"]?.GetValue<string>();
            var line = Regex.Match(message, @"line ([0-9]+): ") is { Success: true } m ? int.Parse(m.Groups[1].Value) : (int?)null;
            string verdict, now = "";
            if (text == null || line == null) verdict = "n/a";
            else {
                List<string> errors;
                try { ModuleFlow.Read(text); errors = []; }
                catch (FlowSyntaxException error) { errors = error.Errors.ToList(); }
                catch (FormatException error) { errors = [error.Message]; }
                var normalized = FlowTextNormalizer.Normalize(text);
                var whole = normalized.Edits.Count > 0 && Parses(normalized.Text) || errors.Count == 0;
                var partial = whole ? null : FlowTextNormalizer.Corrected(text);
                var readings = whole || partial != null ? [] : FlowTextNormalizer.Ambiguities(text);
                var own = errors.FirstOrDefault(e => FlowTextNormalizer.LineOf(e) == line) ?? "";
                now = own;
                verdict = whole ? "accepted"
                    : partial != null && partial.Lines.Contains(line.Value) ? "patch"
                    : readings.Any(r => r.Line == line) ? "candidates"
                    : own.Contains("; accepted form", StringComparison.Ordinal) || own.Contains("; use: ", StringComparison.Ordinal) || Hinted(own) ? "shape"
                    : own.Length == 0 ? "moved" : "dry";
                if (whole) now = string.Join(", ", normalized.Edits.Select(e => e.Rule).Distinct());
            }
            report.Add(new JsonObject { ["message"] = message, ["verdict"] = verdict, ["now"] = now, ["count"] = entry["count"]?.DeepClone() });
        }
        var output = Environment.GetEnvironmentVariable("SSAM_FLOW_SYNTAX_REPORT");
        if (!string.IsNullOrEmpty(output)) File.WriteAllText(output, report.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
    }

    private static bool Parses(string text) { try { ModuleFlow.Read(text); return true; } catch (FormatException) { return false; } }

    private static bool Hinted(string error) => new[] { "write the false branch", "a jump names the id", "return is no step", "a loop is foreach",
        "else if is no line", "a call names the action alone", "an assign of several assignments", "nothing follows a switch", "a navigate names the screen alone" }.Any(h => error.Contains(h, StringComparison.Ordinal));
}
