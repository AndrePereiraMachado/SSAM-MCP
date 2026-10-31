using System.Text.Json;

// The deadlines of the bridge and of its .NET client, from the one table the facade also reads
// (platforms/odc/facade/bridge-deadlines.json, embedded in this assembly). The client always waits past the bridge, so the
// answer of a command that outlives its deadline is read, never left on a closed pipe.
internal static class BridgeDeadlines {
    public const string Resource = "bridge-deadlines.json";
    private static readonly JsonElement Table = ReadTable();
    private static JsonElement ReadTable() {
        using var stream = typeof(BridgeDeadlines).Assembly.GetManifestResourceStream(Resource)
            ?? throw new InvalidOperationException("The bridge was built without its deadlines table " + Resource + ".");
        using var document = JsonDocument.Parse(stream);
        return document.RootElement.Clone();
    }
    private static TimeSpan Seconds(string name) => TimeSpan.FromSeconds(Table.GetProperty(name).GetInt32());
    // How long a job may wait for its tab's top level to become idle before it is abandoned.
    public static TimeSpan QueueStart => Seconds("queueStartSeconds");
    // How long a command waits for the one running before it is refused BRIDGE_BUSY.
    public static TimeSpan TurnWait => Seconds("turnWaitSeconds");
    // How long a status may wait for the Studio's UI while another command runs, before it answers from the bridge alone.
    public static TimeSpan BusyAnswer => Seconds("busyAnswerSeconds");
    // How long a connection may take to send its command line, and the bridge to write one answer.
    public static TimeSpan CommandLine => Seconds("commandLineSeconds");
    public static TimeSpan AnswerWrite => Seconds("answerWriteSeconds");
    // How long the answer of a late command waits for the list of open dialogs.
    public static TimeSpan Dialogs => Seconds("dialogsSeconds");
    // The bridge's own deadline: past it, it answers by itself (outcome uncertain) and the command keeps running.
    public static TimeSpan For(string command, string argument) {
        if (command == "publish" && argument.Contains("--wait")) return Seconds("publishWaitSeconds");
        return Table.GetProperty("commandSeconds").TryGetProperty(command, out var seconds) ? TimeSpan.FromSeconds(seconds.GetInt32()) : Seconds("defaultSeconds");
    }
    // How long a client waits for that answer (odc-pipe.mjs replyTimeoutMs is the same rule).
    public static TimeSpan ClientWait(string command, string argument) {
        var margin = Seconds("clientMarginSeconds");
        var wait = Seconds("clientFloorSeconds");
        if (For(command, argument) + margin > wait) wait = For(command, argument) + margin;
        var words = argument.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (command == "wait" && words.Length > 0 && double.TryParse(words[^1], out var seconds) && TimeSpan.FromSeconds(seconds) + margin > wait) wait = TimeSpan.FromSeconds(seconds) + margin;
        var flag = Array.IndexOf(words, "--wait");
        if (command == "publish" && flag >= 0 && flag + 1 < words.Length && double.TryParse(words[flag + 1], out var minutes) && TimeSpan.FromMinutes(minutes) + margin > wait) wait = TimeSpan.FromMinutes(minutes) + margin;
        return wait;
    }
}
