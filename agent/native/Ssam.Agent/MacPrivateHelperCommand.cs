using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Ssam.Agent;

// A local private pipe endpoint, never a server tool. No credentials in argv.
internal static class MacPrivateHelperCommand
{
    internal static async Task<int> Run()
    {
        try
        {
            if (!OperatingSystem.IsMacOS()) throw new AgentFault("CREDENTIAL_PLATFORM_UNAVAILABLE", "The private macOS helper requires macOS.");
            using var lifetime = new CancellationTokenSource(TimeSpan.FromMinutes(5));
            var buffer = new char[8192]; var input = new StringBuilder();
            int count;
            while ((count = await Console.In.ReadAsync(buffer.AsMemory(), lifetime.Token)) > 0)
            {
                if (input.Length + count > 16 * 1024 * 1024) throw new InvalidDataException();
                input.Append(buffer, 0, count);
            }
            var envelope = JsonNode.Parse(input.ToString()) as JsonObject ?? throw new InvalidDataException();
            input.Clear(); Array.Clear(buffer);
            var marker = Marker(envelope);
            var result = await MacPrivateBackend.ExecuteAsync(envelope, lifetime.Token,
                marker is null ? null : () => File.WriteAllText(marker, "visible", new UTF8Encoding(false)));
            if (marker is not null && envelope["family"]?.GetValue<string>() == "users"
                && envelope["options"]?["kind"]?.GetValue<string>() == "password"
                && result["saved"]?.GetValue<bool>() == true)
                File.WriteAllText(marker, "saved", new UTF8Encoding(false));
            Console.WriteLine(result.ToJsonString());
            return 0;
        }
        catch (Exception error)
        {
            var code = error is AgentFault fault && Regex.IsMatch(fault.Code, "^(?:CREDENTIAL|USERS)_[A-Z_]{1,70}$")
                ? fault.Code : "CREDENTIAL_PRIVATE_HELPER_FAILED";
            Console.WriteLine(new JsonObject { ["ok"] = false, ["code"] = code }.ToJsonString());
            return 0;
        }
    }

    private static string? Marker(JsonObject envelope)
    {
        var raw = envelope["options"]?["promptStatusPath"]?.GetValue<string>();
        if (string.IsNullOrEmpty(raw)) return null;
        if (envelope["mode"]?.GetValue<string>() != "prompt") throw new InvalidDataException();
        var root = Path.GetFullPath(envelope["context"]?["dataRoot"]?.GetValue<string>() ?? throw new InvalidDataException());
        var directory = Path.Combine(root, "private", envelope["family"]?.GetValue<string>() == "users" ? "users" : "credential");
        var file = Path.GetFullPath(raw);
        if (Path.GetDirectoryName(file) != directory || !Regex.IsMatch(Path.GetFileName(file), "^prompt-[a-fA-F0-9-]+\\.status$")) throw new InvalidDataException();
        for (var current = new DirectoryInfo(directory); current is not null; current = current.Parent)
            if (current.Exists && current.LinkTarget is not null) throw new InvalidDataException();
        if (File.Exists(file) && new FileInfo(file).LinkTarget is not null) throw new InvalidDataException();
        Directory.CreateDirectory(directory);
        return file;
    }
}
