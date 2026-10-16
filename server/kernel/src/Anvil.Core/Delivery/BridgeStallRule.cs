using System.Text.Json.Nodes;
namespace Anvil.Core.Delivery;

/// <summary>Pure safety net for a UI call, shared by both CLIs. Positive windows/transport/process evidence only;
/// timeouts and protocol refusals neither increment nor erase evidence. Never retries or closes a dialog.</summary>
public sealed class BridgeStallRule
{
    public const int ProbeMs=2000, ProbeTimeoutMs=5000, ErrorReportProbes=2, DialogProbes=8, GoneProbes=2, MaxTexts=20;
    public static readonly string[] WatchedVerbs=["merge_from_oml","refresh_references","publish","open_module","close_module","snapshot_module","get_errors","integration_import"];
    public static readonly string[] PreProbeVerbs=["merge_from_oml","refresh_references","publish","open_module","close_module"];
    public static readonly string[] ErrorReportAutoVerbs=["merge_from_oml","refresh_references","publish"];
    public const string ErrorReportAutoCapability="dialogs:error_report_auto";
    private readonly string method;
    private readonly HashSet<string> before=[];
    private readonly Dictionary<string,(int Count,long First)> seen=[];
    private int bridgeGone,studioGone;
    private JsonObject studio=new();
    public bool Enabled { get; }
    public bool NeedsPreProbe { get; }
    public BridgeStallRule(string method,int probeMs=ProbeMs,int? timeoutMs=null)
    {
        this.method=method;
        Enabled=probeMs>0 && WatchedVerbs.Contains(method) && (timeoutMs==null || timeoutMs>probeMs);
        NeedsPreProbe=Enabled && PreProbeVerbs.Contains(method);
    }
    private static string Text(JsonNode? value) => value is JsonValue v && v.TryGetValue<string>(out var s) ? s : "";
    private static bool? Flag(JsonNode? value) => value is JsonValue v && v.TryGetValue<bool>(out var b) ? b : null;
    private static string Identity(JsonObject w)=>Text(w["type"])+"|"+Text(w["title"]);
    private static bool ErrorReport(JsonObject w)=>OperationDialogPolicy.ErrorTitles.Any(t=>t.Equals(Text(w["title"]).Trim(),StringComparison.OrdinalIgnoreCase));
    /// <summary>CX14 R2: what the person typed in a Studio dialog (the bridge's "[TextBox] value (watermark)" text, e.g. the
    /// password of a sign-in) never leaves the client: it is dropped here, before any classification, verdict, question,
    /// receipt or answer, by the same rule as the facade's dialogsFromWindows (and bridge-stall.mjs withoutTypedText).</summary>
    public static bool IsTypedText(string? text) => text != null && text.StartsWith("[TextBox]", StringComparison.Ordinal);
    public static string[] WithoutTypedText(IEnumerable<string> texts) => texts.Where(t => !IsTypedText(t)).ToArray();
    /// <summary>A stall record without typed text (a stall written by another client, or before R2): texts and buttons
    /// filtered, the question rebuilt from the title and the remaining texts.</summary>
    public static JsonObject Clean(JsonObject stall)
    {
        var copy = stall.DeepClone().AsObject();
        if (copy["blockedBy"] is not JsonObject blocked) return copy;
        var title = Text(blocked["title"]);
        if (blocked["texts"] is JsonArray texts) blocked["texts"] = new JsonArray(WithoutTypedText(texts.Select(t => Text(t))).Select(t => (JsonNode)t).ToArray());
        if (blocked["buttons"] is JsonArray buttons) blocked["buttons"] = new JsonArray(WithoutTypedText(buttons.Select(t => Text(t))).Select(t => (JsonNode)t).ToArray());
        if (blocked["question"] != null)
            blocked["question"] = blocked["texts"] is JsonArray kept
                ? string.Join(" | ", new[] { title }.Concat(kept.Select(t => Text(t))).Where(t => t.Length > 0))
                : Text(blocked["question"]).Contains("[TextBox]", StringComparison.Ordinal) ? title : Text(blocked["question"]);
        return copy;
    }
    private static List<JsonObject>? CountingWindows(JsonNode? raw)
    {
        if(raw is not JsonArray array) return null;
        var result=new List<JsonObject>();
        foreach(var item in array)
        {
            if(item is not JsonObject w || w["type"] is not JsonValue type || !type.TryGetValue<string>(out _) || (w["title"]!=null && (w["title"] is not JsonValue title || !title.TryGetValue<string>(out _))) || (w["isVisible"]!=null && Flag(w["isVisible"])==null) || (w["isModal"]!=null && Flag(w["isModal"])==null) || (w["texts"]!=null && (w["texts"] is not JsonArray texts || texts.Any(t=>t is not JsonValue v || !v.TryGetValue<string>(out _))))) return null;
            if(Flag(w["isVisible"])==false || !(Flag(w["isModal"])==true || Text(w["type"]).Contains("DialogWindow",StringComparison.Ordinal))) continue;
            var shown=WithoutTypedText((w["texts"] as JsonArray)?.Select(t=>Text(t))??[]);
            var kind=DialogPolicy.ClassifyWindow(Text(w["title"]),shown);
            if(kind==DialogPolicy.Progress) continue;
            var copy=w.DeepClone().AsObject(); copy["kind"]=kind;
            if(copy["texts"] is JsonArray) copy["texts"]=new JsonArray(shown.Select(t=>(JsonNode)t).ToArray());
            result.Add(copy);
        }
        return result;
    }
    public JsonObject? Begin(JsonArray? windows=null,IEnumerable<string>? capabilities=null,int? pid=null,string? startedUtc=null)
    {
        studio=new JsonObject(); if(pid!=null) studio["pid"]=pid.Value; if(startedUtc!=null) studio["startedUtc"]=startedUtc;
        seen.Clear(); before.Clear(); bridgeGone=studioGone=0;
        var found=CountingWindows(windows)??[];
        foreach(var w in found) before.Add(Identity(w));
        if(!NeedsPreProbe) return null;
        var error=found.FirstOrDefault(ErrorReport);
        return error!=null && !(ErrorReportAutoVerbs.Contains(method) && (capabilities??[]).Contains(ErrorReportAutoCapability)) ? Result("dialog-before",0,error,0) : null;
    }
    private JsonObject Result(string verdict,long afterMs,JsonObject? window=null,long seenMs=0)
    {
        var result=new JsonObject { ["verdict"]=verdict,["method"]=method,["afterMs"]=afterMs,["studio"]=studio.DeepClone() };
        if(window!=null)
        {
            var blocked=new JsonObject { ["title"]=Text(window["title"]),["type"]=Text(window["type"]),["kind"]=ErrorReport(window)?DialogPolicy.UnexpectedError:Text(window["kind"]),["seenMs"]=seenMs };
            if(!ErrorReport(window))
            {
                var texts=WithoutTypedText((window["texts"] as JsonArray)?.Select(t=>Text(t))??[]);
                blocked["texts"]=new JsonArray(texts.Select(t=>(JsonNode)t).ToArray());
                blocked["buttons"]=new JsonArray(texts.Where(t=>t.StartsWith("[Button] ",StringComparison.Ordinal)).Select(t=>t[9..].Trim()).Where(t=>t.Length>0 && t!="Viewbox").Select(t=>(JsonNode)t).ToArray());
                blocked["question"]=string.Join(" | ",new[]{Text(window["title"])}.Concat(texts).Where(t=>t.Length>0));
            }
            result["blockedBy"]=blocked;
        }
        return result;
    }
    public JsonObject? Observe(JsonObject probe)
    {
        if(!Enabled) return null;
        var afterMs=probe["afterMs"] is JsonValue time ? (time.TryGetValue<long>(out var n)?n:time.TryGetValue<int>(out var i)?i:0) : 0;
        var expected=Text(studio["startedUtc"]); var actual=Text(probe["startedUtc"]);
        if(Flag(probe["studioAlive"])==false || (expected.Length>0 && actual.Length>0 && expected!=actual)) { if(++studioGone>=GoneProbes) return Result("studio-gone",afterMs); }
        else if(Flag(probe["studioAlive"])==true || (expected.Length>0 && actual==expected)) studioGone=0;
        if(Flag(probe["connectionRefused"])==true) { if(++bridgeGone>=GoneProbes) return Result("bridge-gone",afterMs); return null; }
        var windows=Flag(probe["success"])==false?null:CountingWindows(probe["windows"]);
        if(windows==null) return null;
        bridgeGone=0;
        var active=new HashSet<string>();
        foreach(var w in windows)
        {
            var id=Identity(w); active.Add(id);
            if(!ErrorReport(w) && before.Contains(id)) continue;
            seen.TryGetValue(id,out var prior); var entry=(Count:prior.Count+1,First:prior.Count>0?prior.First:afterMs); seen[id]=entry;
            if(entry.Count>=(ErrorReport(w)?ErrorReportProbes:DialogProbes)) return Result("dialog",afterMs,w,afterMs-entry.First);
        }
        foreach(var id in seen.Keys.Where(id=>!active.Contains(id)).ToArray()) seen.Remove(id);
        return null;
    }
}
