using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;

namespace Ssam.Agent;

internal sealed record MacDialogResult(bool Accepted, JsonObject? Values);
internal static class MacPrivateDialog
{
    internal const string Schema = "ssam-private-dialog/1";
    internal const int MaximumFrame = 32768;
    internal static string Resolve(string runtimeRoot, string dataRoot)
    {
        JsonObject? pack;
        try { pack = JsonNode.Parse(File.ReadAllText(Path.Combine(runtimeRoot, "pack.json"))) as JsonObject; }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or System.Text.Json.JsonException) { throw Failed(); }
        if (pack?["privateDialog"] is not JsonObject descriptor) throw Failed();
        var resolved = RenderKinds.Resolve(runtimeRoot, new JsonObject { ["renderer"] = descriptor.DeepClone() }, dataRoot);
        return resolved.Path ?? throw Failed();
    }
    private static AgentFault Failed() => new("MAC_PRIVATE_DIALOG_UNAVAILABLE", "The private SSAM dialog could not complete. Update or reopen the SSAM Agent app.", false);
    internal static async Task<JsonObject?> ReadFrameAsync(Stream stream, CancellationToken token)
    {
        using var bytes = new MemoryStream(); var single = new byte[1]; var blankLines = 0;
        while (await stream.ReadAsync(single, token) != 0) {
            if (single[0] == 10) {
                if (bytes.Length == 0 || bytes.Length == 1 && bytes.GetBuffer()[0] == 13) { if (++blankLines > 8) throw Failed(); bytes.SetLength(0); continue; }
                try { return JsonNode.Parse(new UTF8Encoding(false, true).GetString(bytes.ToArray())) as JsonObject ?? throw Failed(); }
                catch (Exception error) when (error is DecoderFallbackException or System.Text.Json.JsonException) { throw Failed(); }
            }
            if (bytes.Length >= MaximumFrame) throw Failed(); bytes.WriteByte(single[0]);
        }
        if (bytes.Length != 0) throw Failed(); return null;
    }
    internal static async Task<MacDialogResult> RunAsync(string executable, JsonObject model, Func<JsonObject, Task<string?>> accept, CancellationToken token, Action? visible = null)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token); deadline.CancelAfter(TimeSpan.FromSeconds(130));
        var ct = deadline.Token;
        var id = Guid.NewGuid().ToString("N"); model = (JsonObject)model.DeepClone(); model["schema"] = Schema; model["id"] = id;
        var start = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardInputEncoding = new UTF8Encoding(false), StandardOutputEncoding = new UTF8Encoding(false, true) };
        start.ArgumentList.Add("--ssam-private-dialog-worker"); start.Environment.Remove("ELECTRON_RUN_AS_NODE");
        using var process = Process.Start(start) ?? throw Failed();
        // Never buffer or report worker stderr: it may contain text entered in a private field.
        var drain = process.StandardError.BaseStream.CopyToAsync(Stream.Null, ct);
        JsonObject? accepted = null; var shown = false; var submitted = 0;
        try {
            await process.StandardInput.WriteLineAsync(model.ToJsonString().AsMemory(), ct); await process.StandardInput.FlushAsync(ct);
            while (await ReadFrameAsync(process.StandardOutput.BaseStream, ct) is { } frame) {
                if (frame["id"]?.GetValue<string>() != id) throw Failed();
                var type = frame["type"]?.GetValue<string>();
                if (type == "visible") { if (shown) throw Failed(); shown = true; visible?.Invoke(); continue; }
                if (type == "submit") {
                    if (!shown || accepted != null || ++submitted > 10 || frame["values"] is not JsonObject values) throw Failed();
                    string? error; try { error = await accept(values); } catch (AgentFault fault) { error = fault.Code is "MAC_KEYCHAIN_LOCKED" ? "CREDENTIAL_PERMISSION_DENIED" : "CREDENTIAL_STORE_FAILED"; }
                    if (error == null) accepted = (JsonObject)values.DeepClone();
                    var decision = new JsonObject { ["type"] = "decision", ["id"] = id, ["ok"] = error == null };
                    if (error != null) decision["code"] = error;
                    await process.StandardInput.WriteLineAsync(decision.ToJsonString().AsMemory(), ct); await process.StandardInput.FlushAsync(ct); continue;
                }
                if (type == "closed") {
                    var success = frame["accepted"]?.GetValue<bool>() == true;
                    if (success != (accepted != null)) throw Failed();
                    process.StandardInput.Close();
                    if (await ReadFrameAsync(process.StandardOutput.BaseStream, ct) != null) throw Failed();
                    await process.WaitForExitAsync(ct); await drain;
                    if (process.ExitCode != 0) throw Failed();
                    return new(success, success ? accepted : null);
                }
                throw Failed();
            }
            throw Failed();
        } catch (Exception error) when (error is OperationCanceledException or IOException or System.Text.Json.JsonException or InvalidOperationException) { throw Failed(); }
        finally { if (!process.HasExited) try { process.Kill(true); } catch (InvalidOperationException) { } }
    }
}
