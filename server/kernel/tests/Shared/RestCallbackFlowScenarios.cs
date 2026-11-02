using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Linked into both test projects: the existing callbacks of a consumed REST client (OnBeforeRequest, OnAfterResponse) read
/// and edited as ssam-flow text (ModuleFlow.Extractor 10), offline on the lane's blank fixture. rest-consume creates the
/// callbacks (the bearer client Acme of RestConsumeAuthScenarios, with the model's own steps in both); the flow reading lists
/// them as callback action Acme.OnBeforeRequest/OnAfterResponse, fixed points; the same text sent back writes nothing; an
/// edit of one callback changes only that callback and keeps its native parameters; a header that declares parameters,
/// renames the callback or names no @key is refused, the last two with the name to use.
/// </summary>
public static class RestCallbackFlowScenarios
{
    private static string Lane(string fixture) => fixture.Contains("odc", StringComparison.OrdinalIgnoreCase) ? "odc" : "o11";

    private static ModuleFlow Flow(string dir, string oml, string lane)
    {
        var bytes = File.ReadAllBytes(oml);
        return new ModelHost(Path.Combine(dir, "read-" + Path.GetFileNameWithoutExtension(oml))).BuildFlow(bytes, Convert.ToHexString(SHA256.HashData(bytes)), lane);
    }

    // A text with the textSha of its read (basedOn), or a new action's text (null).
    private static JsonObject Logic(string text, string? basedOn)
    {
        var data = new JsonObject { ["flow"] = text };
        if (basedOn != null) data["basedOn"] = basedOn;
        return new() { ["op"] = "logic", ["data"] = data };
    }

    private static JsonObject Get(string key) => new() { ["op"] = "get", ["target"] = "@" + key };

    private static JsonObject Result(JsonNode job, string op, int nth = 0)
        => job["results"]!.AsArray().OfType<JsonObject>().Where(r => r["op"]?.ToString() == op).ElementAt(nth)["result"]!.AsObject();

    private static List<string> Codes(Exception error) => (Errors.FindCoded(error)?.Problems ?? new JsonArray()).OfType<JsonObject>().Select(p => p["code"]!.ToString()).ToList();

    // The codes, messages and fixes as plain text (a JSON text would escape the + of a model key).
    private static string Problems(Exception error) => string.Join(Environment.NewLine, (Errors.FindCoded(error)?.Problems ?? new JsonArray()).OfType<JsonObject>()
        .Select(p => p["code"] + ": " + p["message"] + " | " + p["fix"]));

    /// <summary>The module with the client Acme and its two callbacks, and its flow reading.</summary>
    private static (string Oml, ModuleFlow Flow) Consumed(string dir, string fixture)
    {
        var ops = new JsonArray(RestConsumeAuthScenarios.AuthOps()[0]!.DeepClone());
        var first = RestConsumeScenarios.Run(dir, "callbacks", ops, fixture);
        Assert.True(first["accepted"]!.GetValue<bool>(), first.ToJsonString());
        var oml = Path.Combine(dir, "callbacks.oml");
        return (oml, Flow(dir, oml, Lane(fixture)));
    }

    /// <summary>Both callbacks are read as owned callback actions, fixed points; the same text sent back writes nothing; an edit
    /// of OnAfterResponse changes it alone (every other action reads as before) and keeps its native inputs and outputs.</summary>
    public static void ACallbackTextRoundTripsAndAnEditChangesOnlyIt(string dir, string fixture)
    {
        var lane = Lane(fixture);
        var (oml, flow) = Consumed(dir, fixture);
        var callbacks = flow.Actions.Where(a => a.Kind == "RestCallbackActionFlow").OrderBy(a => a.Name, StringComparer.Ordinal).ToArray();
        Assert.Equal(["Acme/OnAfterResponse", "Acme/OnBeforeRequest"], callbacks.Select(a => a.Name).ToArray());
        foreach (var callback in callbacks) {
            Assert.True(callback.FixedPoint, callback.Name + ": " + string.Join("; ", callback.Problems));
            Assert.StartsWith("callback action Acme." + callback.Name[(callback.Name.IndexOf('/') + 1)..] + " @", callback.Text.Split('\n').First(l => !l.StartsWith("///", StringComparison.Ordinal)));
            // The native parameters are the platform's: never written as in/out lines.
            Assert.DoesNotContain(callback.Text.Split('\n'), l => l.TrimStart().StartsWith("in ", StringComparison.Ordinal) || l.TrimStart().StartsWith("out ", StringComparison.Ordinal));
        }
        var after = callbacks.Single(a => a.Name == "Acme/OnAfterResponse");
        var before = callbacks.Single(a => a.Name == "Acme/OnBeforeRequest");

        // Round trip: the text as read, sent back, writes nothing and reads back the same.
        var same = RestConsumeScenarios.Run(dir, "same", new JsonArray(Logic(after.Text, after.TextSha), Get(after.Key)), fixture, oml);
        Assert.True(same["accepted"]!.GetValue<bool>(), same.ToJsonString());
        var written = Result(same, "logic")["flow"]![0]!.AsObject();
        Assert.Equal("RestCallbackActionFlow", written["kind"]!.ToString());
        Assert.Empty(written["ops"]!.AsObject());
        var sameFlow = Flow(dir, Path.Combine(dir, "same.oml"), lane);
        Assert.Equal(flow.Actions.Select(a => (a.Key, a.Text)), sameFlow.Actions.Select(a => (a.Key, a.Text)));
        var nativeBefore = Result(same, "get")["properties"]!.AsObject();

        // An edit of the body: only OnAfterResponse changes, and its native parameters stay.
        var edited = after.Text.Replace("Trim(Response.ResponseText)", "Response.ResponseText", StringComparison.Ordinal);
        Assert.NotEqual(after.Text, edited);
        var result = RestConsumeScenarios.Run(dir, "edited", new JsonArray(Logic(edited, after.TextSha), Get(after.Key)), fixture, oml);
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        Assert.NotEmpty(Result(result, "logic")["flow"]![0]!["ops"]!.AsObject());
        var nativeAfter = Result(result, "get")["properties"]!.AsObject();
        foreach (var list in new[] { "InputParameters", "OutputParameters" })
            Assert.Equal(nativeBefore[list]?.ToString(), nativeAfter[list]?.ToString());
        Assert.NotEqual("0", nativeAfter["InputParameters"]?.ToString());
        var editedFlow = Flow(dir, Path.Combine(dir, "edited.oml"), lane);
        var now = editedFlow.Actions.ToDictionary(a => a.Key);
        Assert.Equal(flow.Actions.Select(a => a.Key).Order(StringComparer.Ordinal), now.Keys.Order(StringComparer.Ordinal));
        foreach (var action in flow.Actions.Where(a => a.Key != after.Key)) Assert.Equal(action.Text, now[action.Key].Text);
        Assert.Equal(edited, now[after.Key].Text);
        Assert.True(now[after.Key].FixedPoint);
        Assert.Equal(before.Text, now[before.Key].Text);
        var texts = new ModelHost(Path.Combine(dir, "work-texts")).RestCallbackTexts(Path.Combine(dir, "edited.oml"), "Acme");
        Assert.DoesNotContain("Trim(Response.ResponseText)", texts["OnAfterResponse"]);
    }

    /// <summary>One refusal per mistake, before anything is written: declared parameters, a renamed callback (with the name to
    /// keep), a header without @key (with the callback's @key) and a callback the client does not have (with the nearest).</summary>
    public static void ACallbackTextIsRefusedWithTheNameToUse(string dir, string fixture)
    {
        var (oml, flow) = Consumed(dir, fixture);
        var after = flow.Actions.Single(a => a.Name == "Acme/OnAfterResponse");
        var header = after.Text.Split('\n').First(l => l.StartsWith("callback action ", StringComparison.Ordinal));
        var start = after.Text.IndexOf(header, StringComparison.Ordinal);
        string With(string newHeader) => after.Text[..start] + newHeader + after.Text[(start + header.Length)..];

        // The header's own property line (@{CallbackType=...}) follows it; a parameter goes after that.
        var lines = after.Text.Split('\n').ToList();
        var at = lines.IndexOf(header) + 1;
        if (at < lines.Count && lines[at].StartsWith("  @{", StringComparison.Ordinal)) at++;
        lines.Insert(at, "  in Request: Text");
        var declared = string.Join('\n', lines);
        var error = Assert.ThrowsAny<Exception>(() => RestConsumeScenarios.Run(dir, "declared", new JsonArray(Logic(declared, after.TextSha)), fixture, oml));
        Assert.True(Codes(error).Contains("FLOW_CALLBACK_PARAMETERS"), Problems(error) + Environment.NewLine + declared);

        // The callback's type is its identity too (the text may write it as a property of the header).
        if (after.Text.Contains("CallbackType=OnAfterResponse", StringComparison.Ordinal)) {
            var retyped = after.Text.Replace("CallbackType=OnAfterResponse", "CallbackType=OnBeforeRequest", StringComparison.Ordinal);
            error = Assert.ThrowsAny<Exception>(() => RestConsumeScenarios.Run(dir, "retyped", new JsonArray(Logic(retyped, after.TextSha)), fixture, oml));
            Assert.True(Codes(error).Contains("FLOW_CALLBACK_NAME"), Problems(error));
        }

        var renamed = With(header.Replace("Acme.OnAfterResponse", "Acme.OnAfterRespons", StringComparison.Ordinal));
        error = Assert.ThrowsAny<Exception>(() => RestConsumeScenarios.Run(dir, "renamed", new JsonArray(Logic(renamed, after.TextSha)), fixture, oml));
        Assert.Contains("FLOW_CALLBACK_NAME", Codes(error));
        Assert.Contains("callback action Acme.OnAfterResponse", Problems(error));

        var keyless = With("callback action Acme.OnAfterResponse");
        error = Assert.ThrowsAny<Exception>(() => RestConsumeScenarios.Run(dir, "keyless", new JsonArray(Logic(keyless, after.TextSha)), fixture, oml));
        Assert.Contains("FLOW_CALLBACK_CREATION", Codes(error));
        Assert.Contains("@" + after.Key, Problems(error));

        var unknown = With("callback action Acme.OnAfterReponse");
        error = Assert.ThrowsAny<Exception>(() => RestConsumeScenarios.Run(dir, "unknown", new JsonArray(Logic(unknown, after.TextSha)), fixture, oml));
        Assert.Contains("FLOW_CALLBACK_UNKNOWN", Codes(error));
        Assert.Contains("Acme.OnAfterResponse @" + after.Key, Problems(error));
        Assert.False(File.Exists(Path.Combine(dir, "unknown.oml")));
    }

    /// <summary>A callback header over the @key of an action of another kind (here a service action) is FLOW_ACTION_KIND alone:
    /// no callback rule runs on an action that is not a callback, and no fix names a callback that does not exist.</summary>
    public static void ACallbackHeaderOverAnotherActionIsOnlyAKindChange(string dir, string fixture)
    {
        var (oml, flow) = Consumed(dir, fixture);
        var service = flow.Actions.First(a => a.Kind == "ServiceAction" && a.FixedPoint);
        var lines = service.Text.Split('\n').ToList();
        var at = lines.FindIndex(l => l.StartsWith("service action ", StringComparison.Ordinal));
        lines[at] = "callback action Acme.OnAfterResponse @" + service.Key;
        var text = string.Join('\n', lines);
        var error = Assert.ThrowsAny<Exception>(() => RestConsumeScenarios.Run(dir, "kinds", new JsonArray(Logic(text, service.TextSha)), fixture, oml));
        var codes = Codes(error);
        Assert.True(codes.Contains("FLOW_ACTION_KIND"), Problems(error));
        Assert.DoesNotContain(codes, c => c.StartsWith("FLOW_CALLBACK_", StringComparison.Ordinal));
        Assert.DoesNotContain("callback action " + service.Name, Problems(error));
    }

    /// <summary>The owners of callbacks (REST clients) and of screen actions (screens, blocks, emails) are two indexes: a client
    /// named like a screen (or block) changes nothing of how that screen's actions read or are created, and its callbacks read,
    /// round-trip and edit as with any other client. owner: a screen or block of the fixture.</summary>
    public static void AClientNamedLikeAScreenChangesNothingOfTheScreen(string dir, string fixture, string owner)
    {
        var lane = Lane(fixture);
        var made = RestConsumeScenarios.Run(dir, "owner-action", new JsonArray(Logic("/// The probe of the owner index.\naction " + owner + ".ZzOwnerProbe\n  end\n", null)), fixture);
        Assert.True(made["accepted"]!.GetValue<bool>(), made.ToJsonString());
        var before = Flow(dir, Path.Combine(dir, "owner-action.oml"), lane);
        var probe = before.Actions.Single(a => a.Kind == "ScreenAction" && a.Name.EndsWith("/ZzOwnerProbe", StringComparison.Ordinal));
        Assert.Contains("action " + owner + ".ZzOwnerProbe @", probe.Text);

        // A consumed client of the screen's name (expose:false: a UI module gets no service actions).
        var client = RestConsumeAuthScenarios.AuthOps()[0]!.DeepClone().AsObject();
        client["data"]!["name"] = owner;
        client["data"]!["expose"] = false;
        var consumed = RestConsumeScenarios.Run(dir, "owner-client", new JsonArray(client), fixture, Path.Combine(dir, "owner-action.oml"));
        Assert.True(consumed["accepted"]!.GetValue<bool>(), consumed.ToJsonString());
        var after = Flow(dir, Path.Combine(dir, "owner-client.oml"), lane);
        var now = after.Actions.ToDictionary(a => a.Key);
        // (a) every action read before reads the same (the screen's actions keep "action <Screen>.", their textSha with it).
        foreach (var action in before.Actions) Assert.Equal(action.Text, now[action.Key].Text);

        // (b) a new screen action under that screen is created, not ambiguous.
        var created = RestConsumeScenarios.Run(dir, "owner-new", new JsonArray(Logic("/// A second probe.\naction " + owner + ".ZzOwnerProbeTwo\n  end\n", null)), fixture, Path.Combine(dir, "owner-client.oml"));
        Assert.True(created["accepted"]!.GetValue<bool>(), created.ToJsonString());
        var two = Flow(dir, Path.Combine(dir, "owner-new.oml"), lane).Actions.Single(a => a.Name.EndsWith("/ZzOwnerProbeTwo", StringComparison.Ordinal));
        Assert.Equal(probe.Name[..probe.Name.LastIndexOf('/')], two.Name[..two.Name.LastIndexOf('/')]);

        // (c) the client's callback reads under the client's name, round-trips and edits alone.
        var callback = after.Actions.Single(a => a.Kind == "RestCallbackActionFlow" && a.Name.EndsWith("/OnAfterResponse", StringComparison.Ordinal));
        Assert.Contains("callback action " + owner + ".OnAfterResponse @", callback.Text);
        Assert.True(callback.FixedPoint, string.Join("; ", callback.Problems));
        var same = RestConsumeScenarios.Run(dir, "owner-same", new JsonArray(Logic(callback.Text, callback.TextSha)), fixture, Path.Combine(dir, "owner-client.oml"));
        Assert.True(same["accepted"]!.GetValue<bool>(), same.ToJsonString());
        Assert.Empty(Result(same, "logic")["flow"]![0]!["ops"]!.AsObject());
        var edited = callback.Text.Replace("Trim(Response.ResponseText)", "Response.ResponseText", StringComparison.Ordinal);
        Assert.NotEqual(callback.Text, edited);
        var edit = RestConsumeScenarios.Run(dir, "owner-edit", new JsonArray(Logic(edited, callback.TextSha)), fixture, Path.Combine(dir, "owner-client.oml"));
        Assert.True(edit["accepted"]!.GetValue<bool>(), edit.ToJsonString());
        var final = Flow(dir, Path.Combine(dir, "owner-edit.oml"), lane).Actions.ToDictionary(a => a.Key);
        foreach (var action in after.Actions.Where(a => a.Key != callback.Key)) Assert.Equal(action.Text, final[action.Key].Text);
        Assert.Equal(edited, final[callback.Key].Text);
    }

    /// <summary>The text alone (no module): a callback that declares parameters is refused by the diff.</summary>
    public static void CallbackParametersCannotBeDeclaredByText()
    {
        var baseline = ModuleFlow.Read("callback action Api.OnAfterResponse @original\n  end @n1\n");
        var read = ModuleFlow.Print(baseline);
        var edited = ModuleFlow.Read("callback action Api.OnAfterResponse @original\n  in Request: Text @p1\n  end @n1\n");
        var diff = FlowDiff.Compute(baseline, read.Keys, edited);
        Assert.Contains(diff.Problems, p => p.Code == "FLOW_CALLBACK_PARAMETERS");
    }
}
