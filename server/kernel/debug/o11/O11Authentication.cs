using Anvil.Core;
using OutSystems.Communication.Identity;
using OutSystems.Communication.Identity.Login;
using OutSystems.Communication.ServiceCenter;
using OutSystems.Communication.WebServices;

internal static class O11Authentication {
    internal static (string User, string Secret) Login(string? file, Uri runtime, Action<string, string>? privateValues = null) {
        var creds = Credentials(file);
        if (!string.Equals(creds.Host, runtime.Host, StringComparison.OrdinalIgnoreCase)) throw new DebugFailure("debug_credential_target_mismatch");
        privateValues?.Invoke(creds.Username, creds.Password);
        var host = HostInfo.GetHostInfo(creds.Host);
        var sc = WebServicesFactory.CreateServiceCenterWebService(host, new ServerCommunicationsDefaultBehaviours(), false, false, true);
        var props = sc.GetPropertiesForHandshake();
        if (props.TryGetValue("HubServerVersion", out var raw) && Version.TryParse(raw.Split(' ')[0], out var version)) host.Version = version;
        var login = new LoginInfoWithPassword { HostInfo = host, UserName = creds.Username, Password = new Password(creds.Password) };
        var secret = login.GetSecretForWebServiceRequest();
        var sdk = Path.GetDirectoryName(typeof(IServiceCenter).Assembly.Location)!;
        var ide = System.Diagnostics.FileVersionInfo.GetVersionInfo(Path.Combine(sdk, "ServiceStudio.Framework.dll")).FileVersion!;
        if (!sc.Handshake(creds.Username, secret, ide, "11.0.0.200", out _)) throw new DebugFailure("debug_authentication_failed");
        return (creds.Username, secret);
    }

    /// <summary>The legacy developer login: the private file, else SSAM_O11_HOST/USERNAME/PASSWORD. None of them (or an unreadable
    /// file) is the classified debug_developer_credentials_required, never the generic debug_native_error the session got
    /// (InvalidOperationException "SSAM_O11_HOST not set", dd2b79c0 2026-10-05 02:15). No value reaches the message.</summary>
    internal static HeadlessCredentials Credentials(string? file) {
        try { return file == null ? HeadlessCredentials.FromEnvironment() : HeadlessCredentials.FromJsonFile(file); }
        catch (Exception error) when (error is InvalidOperationException or InvalidDataException or IOException or UnauthorizedAccessException or System.Text.Json.JsonException or FormatException or UriFormatException) {
            throw new DebugFailure("debug_developer_credentials_required");
        }
    }
}
