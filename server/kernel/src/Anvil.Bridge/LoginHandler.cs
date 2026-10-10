using Anvil.Core;
using System.Text.Json.Nodes;
using Avalonia.Threading;
using OutSystems.Communication;
using OutSystems.Communication.Identity;
using OutSystems.Communication.Identity.Login;
using ServiceStudio.Common.ExtendedLoginInfo;
using ServiceStudio.Presenter;

namespace Anvil.Bridge;

/// <summary>
/// Liga o Studio a um ambiente com usuario e senha lidos de um arquivo local de credenciais (o caminho vem pelo
/// verbo; a senha nunca passa pelo fio nem pelo log). Usa ServerOperations.Login -> TryAutoLoginOrShowLoginDialog:
/// com credenciais validas nao ha dialogo. So para ambientes com login por senha; SSO continua manual.
/// login {credentials_file, host?}
/// </summary>
internal static class LoginHandler
{
    public static async Task<string> Login(JsonObject? p)
    {
        var file = PathArgs.Absolute("login", "credentials_file", p?["credentials_file"]?.GetValue<string>());
        if (!File.Exists(file)) return Server.Fail("login: 'credentials_file' must exist");
        JsonObject creds;
        try { creds = JsonNode.Parse(File.ReadAllText(file))!.AsObject(); }
        catch (Exception ex) { return Server.Fail("login: cannot read credentials: " + ex.Message); }
        var user = creds["username"]?.GetValue<string>() ?? "";
        var password = creds["password"]?.GetValue<string>() ?? "";
        var host = p?["host"]?.GetValue<string>()
                   ?? creds["targets"]?["o11PlatformRoot"]?.GetValue<string>()
                   ?? creds["targets"]?["o11ServiceCenter"]?.GetValue<string>()
                   ?? creds["host"]?.GetValue<string>() ?? "";
        if (host.Contains("://")) host = new Uri(host).Host;
        host = host.TrimEnd('/');
        if (user.Length == 0 || password.Length == 0 || host.Length == 0) return Server.Fail("login: credentials file needs username, password and a host");
        try
        {
            // logo apos o arranque o Runtime ainda nao existe: espera a janela do ambiente (ate 90 s)
            var swReady = System.Diagnostics.Stopwatch.StartNew();
            while (true)
            {
                bool ready;
                try
                {
                    ready = await Ui.Run(() => ServiceStudio.Runtime.Instance is RuntimeImplementation rt
                        && rt.AggregatorWindows.Any(w => w.ServerPagePresenter != null || w.SelectedTopLevelPresenter != null), TimeSpan.FromSeconds(5), "login: window ready");
                }
                catch (UiBusyException) { ready = false; UiGate.Forget(); }
                if (ready) break;
                if (swReady.Elapsed.TotalSeconds > 90) return Server.Fail("login: the Studio window is not ready after 90 s");
                await Task.Delay(1000);
            }
            // o alvo vem da UI thread; o Login em si corre num worker (como os ServerCommands do Studio): na UI thread
            // ele pode travar o dispatcher (visto em 2026-09-04 03:15 com um dialogo de arranque aberto)
            var (target, info) = await Ui.Run(() =>
            {
                var rt = ServiceStudio.Runtime.Instance as RuntimeImplementation ?? throw new InvalidOperationException("RuntimeImplementation not available");
                var window = rt.AggregatorWindows.FirstOrDefault() ?? throw new InvalidOperationException("no aggregator window");
                var t = (ITopLevelPresenter?)window.ServerPagePresenter ?? window.SelectedTopLevelPresenter ?? throw new InvalidOperationException("no top-level presenter");
                var i = new ExtendedLoginInfoWithPassword { HostInfo = HostInfo.GetHostInfo(host), UserName = user, Password = new Password(password) };
                return (t, i);
            }, UiGate.Read, "login: target");
            var loginTask = Task.Run(() => ServerOperations.Login(target, info));
            var timeoutS = p?["timeout"]?.GetValue<int>() ?? 90;
            if (await Task.WhenAny(loginTask, Task.Delay(TimeSpan.FromSeconds(timeoutS))) != loginTask)
                return Server.Fail($"login: ServerOperations.Login did not finish in {timeoutS} s (a dialog may be waiting: see 'windows')");
            var ok = await loginTask;
            UiGate.MarkDispatched();
            var connected = await Ui.Run(() =>
            {
                var rt = ServiceStudio.Runtime.Instance as RuntimeImplementation;
                var w = rt?.AggregatorWindows.FirstOrDefault();
                var li = w?.ServerCommunicationsProvider?.LoginInfo;
                return new JsonObject { ["host"] = li?.HostInfo?.HostName, ["user"] = li?.UserName, ["type"] = li?.GetType().Name };
            }, UiGate.Read, "login: read the session");
            return Server.Ok(new JsonObject { ["login"] = ok, ["host"] = host, ["user"] = user, ["connected"] = connected });
        }
        catch (Exception ex) { return Server.Fail(Server.Unwrap(ex)); }
    }
}
