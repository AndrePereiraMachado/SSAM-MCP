using System.Text.Json.Nodes;

namespace Anvil.Core;

/// <summary>Credenciais de um ambiente O11. Nunca serializar nem imprimir.</summary>
public sealed class HeadlessCredentials
{
    public required string Host { get; init; }
    public required string Username { get; init; }
    public required string Password { get; init; }
    /// <summary>Ambiente so de leitura: qualquer verbo de escrita (publish, criar/apagar app ou modulo) e recusado no cliente.</summary>
    public bool ReadOnly { get; init; }

    public override string ToString() => $"{Username}@{Host} (password redacted)";

    /// <summary>
    /// Le o formato local do repo (`.ssam/local/*.credentials.json`): `username`,
    /// `password` e `targets.o11PlatformRoot`. `hostOverride` troca o host.
    /// </summary>
    public static HeadlessCredentials FromJsonFile(string path, string? hostOverride = null)
    {
        var root = JsonNode.Parse(File.ReadAllText(path))?.AsObject()
                   ?? throw new InvalidDataException($"not a JSON object: {path}");
        var username = root["username"]?.GetValue<string>() ?? throw new InvalidDataException("username missing");
        var password = root["password"]?.GetValue<string>() ?? throw new InvalidDataException("password missing");
        var host = hostOverride;
        if (string.IsNullOrWhiteSpace(host))
        {
            var url = root["targets"]?["o11PlatformRoot"]?.GetValue<string>()
                      ?? root["targets"]?["o11ServiceCenter"]?.GetValue<string>()
                      ?? root["host"]?.GetValue<string>()
                      ?? throw new InvalidDataException("targets.o11PlatformRoot / targets.o11ServiceCenter / host missing and no host given");
            host = HostOnly(url);
        }
        var readOnly = root["readOnly"]?.GetValue<bool>() ?? false;
        return new HeadlessCredentials { Host = HostOnly(host!), Username = username, Password = password, ReadOnly = readOnly };
    }

    public static HeadlessCredentials FromEnvironment(string hostVar = "SSAM_O11_HOST", string userVar = "SSAM_O11_USERNAME", string passVar = "SSAM_O11_PASSWORD")
    {
        string Need(string v) => Environment.GetEnvironmentVariable(v) ?? throw new InvalidOperationException($"{v} not set");
        return new HeadlessCredentials { Host = HostOnly(Need(hostVar)), Username = Need(userVar), Password = Need(passVar) };
    }

    /// <summary>Aceita host puro ou URL; devolve so o host.</summary>
    public static string HostOnly(string hostOrUrl)
    {
        var s = hostOrUrl.Trim();
        if (s.Contains("://")) return new Uri(s).Host;
        return s.TrimEnd('/');
    }
}
