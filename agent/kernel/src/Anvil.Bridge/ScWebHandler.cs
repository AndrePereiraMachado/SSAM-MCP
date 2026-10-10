using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json.Nodes;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Threading;
using WebViewControl;

namespace Anvil.Bridge;

/// <summary>
/// sc_web {host, action: status|open|login|fetch|close, hidden?, reenter?, session?, method?, path?, form?, accept?, write?, operationId?,
/// authorizeSha256?, timeoutMs?, secretRefs?}: a Service Center window inside the Studio (WebViewControl over the Studio's
/// CEF) on https://host/ServiceCenter/. open {hidden:true} keeps it off screen and out of the taskbar (CEF needs a shown
/// window to run the page, so it is shown where nobody sees it, and it stays hidden for its whole life); without hidden it
/// is shown to the user, as before. login signs the window in: it loads the Service Center again and lets the identity
/// session of the Studio's browser profile answer (single sign-on, nothing typed); only a sign-in form SSAM may fill takes
/// the login stored in the Windows vault (ScWebLogin); a sign-in that needs the user (MFA, another identity provider) is
/// refused, never shown. login {session:"studio"} (capability sc_web:studioSession) signs it in through the Studio's own
/// session only: never the vault, nothing typed, WEB_SIGN_IN_NEEDS_LOGIN when the page still asks for a login (LoginThroughStudio).
/// The agent never sees the credential. fetch runs a fixed same-origin fetch() in the page
/// (ScWebScripts) and returns status, final URL, content type and the HTML or the xlsx bytes; a read answered by the
/// sign-in page while the Studio is signed in re-enters silently once and is read again (ScWebSession.OnSignInPage).
/// While the window exists and is signed in, its own timer keeps the Service Center session alive (ScWebSession.KeepAliveDue).
/// secretRefs (write postbacks only): form fields filled from the Windows vault here, right before the send (ScSecrets.cs).
/// Cookies stay in the Studio's CEF profile, shared by its web views (WebViewControl has no per-view in-memory context),
/// never reach an answer, and close deletes the host cookies. Every answer carries reentry and keepAlive (ScWebSession.Describe):
/// the facade knows this bridge by those fields.
/// </summary>
internal static class ScWebHandler
{
    private sealed class Session(Window window, WebView view)
    {
        public Window Window { get; } = window;
        public WebView View { get; } = view;
        private volatile bool signingIn = true;
        public bool SigningIn { get => signingIn; set => signingIn = value; }
        private volatile bool hidden;
        public bool Hidden { get => hidden; set => hidden = value; }
        // Known signed in (a sign-in or a read went through) and not answered by the sign-in page since.
        private volatile bool signedIn;
        public bool SignedIn { get => signedIn; set => signedIn = value; }
        // A read or the keep-alive was answered by the sign-in page: the page on screen no longer proves a session.
        private volatile bool expired;
        public bool Expired { get => expired; set => expired = value; }
        private long lastActivity = DateTime.UtcNow.Ticks;
        public DateTime LastActivityUtc { get => new(Interlocked.Read(ref lastActivity), DateTimeKind.Utc); set => Interlocked.Exchange(ref lastActivity, value.Ticks); }
        public DateTime? LastKeepAliveUtc { get; set; }
        public System.Threading.Timer? KeepAliveTimer { get; set; }
        public void Touch() { SignedIn = true; Expired = false; LastActivityUtc = DateTime.UtcNow; }
    }

    private static readonly ConcurrentDictionary<string, Session> Sessions = new(StringComparer.OrdinalIgnoreCase);
    private static readonly SemaphoreSlim Gate = new(1);
    private static readonly IScVault Vault = new ScWindowsVault();
    // D5 (atritos 3): the Service Center windows live only while the Studio has a main window (ScWindowLifetime).
    private static readonly ScWindowLifetime Lifetime = new();

    /// <summary>The Studio's main windows (its aggregator windows), read on the UI thread; -1 when the runtime cannot tell
    /// (never read as "gone").</summary>
    private static int StudioWindows()
    {
        try { return ServiceStudio.Runtime.Instance is ServiceStudio.Presenter.RuntimeImplementation runtime ? runtime.AggregatorWindows.Count() : -1; }
        catch (Exception) { return -1; }
    }
    private static bool MayOpen() { var count = StudioWindows(); return count < 0 ? !Lifetime.OwnerGone : Lifetime.MayOpen(count); }

    public static async Task<string> Handle(JsonObject? p)
    {
        try
        {
            if (p == null) throw new ScFailure(ScCodes.BadRequest, "sc_web parameters are required");
            var host = ScGuard.Host(ScGuard.Text(p, "host"));
            var watch = Stopwatch.StartNew();
            var body = ScGuard.Text(p, "action") switch
            {
                "status" => await Describe(host),
                "open" => await Open(host, ScGuard.Flag(p, "hidden")),
                "login" when ScGuard.Text(p, "session") == ScWebSession.StudioSession => await LoginThroughStudio(host, ScGuard.Flag(p, "reenter")),
                "login" => await Login(host, ScGuard.Flag(p, "reenter")),
                "fetch" => await Fetch(host, ScWebRequest.Parse(p, host)),
                "close" => await Close(host),
                _ => throw new ScFailure(ScCodes.BadRequest, "action must be status, open, login, fetch or close"),
            };
            return ScReply.Ok("studio-web", host, null, watch.ElapsedMilliseconds, body);
        }
        catch (ScFailure failure) { return ScReply.Fail(failure); }
        catch (Exception error) { return ScReply.Fail(new ScFailure(ScCodes.StudioUnavailable, "sc_web: " + ScReply.Unwrap(error))); }
    }

    public static async Task<JsonObject> Describe(string host)
    {
        if (!Sessions.TryGetValue(host, out var session))
        {
            var closed = new JsonObject { ["open"] = false, ["signedIn"] = false, ["persistentProfile"] = WebView.Settings.PersistCache };
            ScWebSession.Describe(closed, false, false, null);
            return closed;
        }
        var status = ScWebResult.Status(host, await Evaluate(session.View, ScWebScripts.Status));
        // A page answered by the sign-in page since (expired) is never reported signed in from what is still on screen.
        if (session.Expired) status["signedIn"] = false;
        else if (status["signedIn"]?.GetValue<bool>() == true) { session.SigningIn = false; session.SignedIn = true; }
        status["signingIn"] = session.SigningIn;
        status["hidden"] = session.Hidden;
        status["expired"] = session.Expired;
        status["persistentProfile"] = WebView.Settings.PersistCache;
        ScWebSession.Describe(status, true, session.SignedIn && !session.Expired, session.LastKeepAliveUtc);
        return status;
    }

    /// <summary>Opens (or shows) the window. hidden: shown off screen, never activated and out of the taskbar, so CEF runs the
    /// page while nobody sees it; the window keeps the mode it was created with (a hidden one is never brought on screen).
    /// A new window gets its keep-alive timer, which lives and dies with it.</summary>
    private static Task<JsonObject> Open(string host, bool hidden) => OnUi(() =>
    {
        var created = false;
        if (!Sessions.TryGetValue(host, out var session))
        {
            // D5: a process whose main window was closed never gets a window that would keep it running.
            if (!MayOpen()) throw ScWindowLifetime.Windowless(Environment.ProcessId, "sc_web open");
            var view = new WebView { DisableFileDialogs = true };
            var window = new Window { Title = $"Service Center - {host} (SSAM)", Width = 1180, Height = 820, Content = view };
            var made = session = new Session(window, view) { Hidden = hidden };
            if (hidden)
            {
                window.ShowInTaskbar = false;
                window.ShowActivated = false;
                window.SystemDecorations = SystemDecorations.None;
                window.WindowStartupLocation = WindowStartupLocation.Manual;
                window.Position = new PixelPoint(-32000, -32000);
            }
            view.BeforeNavigate += request => { if (!ScWebPaths.MayNavigate(host, request.Url, made.SigningIn)) request.Cancel(); };
            // No Service Center link is handed to the external browser.
            view.PopupOpening += _ => { };
            // D5: the Studio's main window gone closes this window and stops its keep-alive (on the UI thread).
            Action closeWithStudio = () => Dispatcher.UIThread.Post(() => { made.KeepAliveTimer?.Dispose(); try { window.Close(); } catch { } });
            window.Closed += (_, _) =>
            {
                Sessions.TryRemove(new KeyValuePair<string, Session>(host, made));
                made.KeepAliveTimer?.Dispose();
                Lifetime.Unregister(closeWithStudio);
                try { view.Dispose(); } catch { }
            };
            Lifetime.Register(closeWithStudio);
            made.KeepAliveTimer = new System.Threading.Timer(_ => _ = KeepAlive(host, made), null, ScWebSession.KeepAliveTick, ScWebSession.KeepAliveTick);
            Sessions[host] = session;
            view.LoadUrl(ScWebPaths.Root(host));
            created = true;
        }
        session.SigningIn = true;
        if (created || !session.Hidden) session.Window.Show();
        if (!session.Hidden) session.Window.Activate();
        var body = new JsonObject { ["open"] = true, ["signingIn"] = true, ["hidden"] = session.Hidden, ["persistentProfile"] = WebView.Settings.PersistCache,
            ["note"] = session.Hidden ? "the window runs off screen; sc_web login signs it in through the Studio's single sign-on, else with the login stored in the Windows vault"
                : "the user signs in in the Service Center window of the Studio; then sc_web status reports signedIn" };
        ScWebSession.Describe(body, true, session.SignedIn && !session.Expired, session.LastKeepAliveUtc);
        return body;
    }, "open");

    /// <summary>Signs the window in. It opens hidden when it is not open; an open window that is expired, not signed in or
    /// asked to re-enter loads the Service Center again, so a stale page never counts. Then it follows the page: the identity
    /// session of the Studio's browser profile answers by itself (single sign-on, followed once when the page offers it); a
    /// sign-in form SSAM may fill takes SSAM/O11/&lt;host&gt;/ServiceCenter from the Windows vault, filled once
    /// (ScWebLogin.Fill). Never resubmits: WEB_LOGIN_REJECTED when the form comes back, WEB_SIGN_IN_INTERACTIVE when the page
    /// needs the user, SECRET_NOT_FOUND when a form needs the stored login and there is none (ScWebSession.AskFor).</summary>
    private static async Task<JsonObject> Login(string host, bool reenter = false)
    {
        if (!reenter && Sessions.TryGetValue(host, out var open) && !open.Expired &&
            ScWebResult.Status(host, await Evaluate(open.View, ScWebScripts.Status))["signedIn"]?.GetValue<bool>() == true)
        {
            open.Touch();
            var already = new JsonObject { ["signedIn"] = true, ["submitted"] = false, ["hidden"] = open.Hidden };
            ScWebSession.Describe(already, true, true, open.LastKeepAliveUtc);
            return already;
        }
        var target = ScWebLogin.Target(host);
        var entry = Vault.Read(target);
        var stored = !string.IsNullOrEmpty(entry?.UserName) && !string.IsNullOrEmpty(entry?.Password);
        var created = !Sessions.ContainsKey(host);
        if (created) await Open(host, hidden: true);
        if (!Sessions.TryGetValue(host, out var session))
            throw new ScFailure(ScCodes.StudioUnavailable, "sc_web login: the Service Center window closed");
        await Gate.WaitAsync();
        try
        {
            session.SigningIn = true;
            if (!created) await OnUi(() => { session.View.LoadUrl(ScWebPaths.Root(host)); return true; }, "load");
            var expired = !created;
            var watch = Stopwatch.StartNew();
            TimeSpan? submittedAt = null;
            var ssoFollowed = false;
            while (watch.Elapsed < ScWebLogin.Limit)
            {
                await Task.Delay(500);
                var status = ScWebResult.Status(host, await Evaluate(session.View, ScWebScripts.Status));
                // Right after the reload the old page may still be on screen: it proves nothing until the new one loads.
                if (expired && watch.Elapsed < TimeSpan.FromSeconds(1)) continue;
                var step = ScWebLogin.Next(host, status, await Evaluate(session.View, ScWebLogin.State), submittedAt == null ? null : watch.Elapsed - submittedAt, ssoFollowed);
                switch (step)
                {
                    case ScWebLogin.Step.SignedIn:
                        session.SigningIn = false;
                        session.Touch();
                        var body = new JsonObject { ["signedIn"] = true, ["submitted"] = submittedAt != null, ["hidden"] = session.Hidden,
                            ["via"] = submittedAt != null ? "stored-login" : "single-sign-on" };
                        ScWebSession.Describe(body, true, true, session.LastKeepAliveUtc);
                        return body;
                    case ScWebLogin.Step.Sso:
                        session.View.ExecuteScript(ScWebLogin.SsoClick);
                        ssoFollowed = true;
                        break;
                    case ScWebLogin.Step.Fill:
                        if (ScWebSession.AskFor(true, step, stored) == ScWebSession.Ask.StoredLogin)
                            throw new ScFailure(ScCodes.SecretNotFound, $"the sign-in of {host} asks for a login (no single sign-on session in the Studio's browser profile) and none is stored in the Windows vault ({target}); the private prompt stores it; nothing was sent",
                                details: new JsonObject { ["target"] = target, ["reentry"] = "needs-login" });
                        session.View.ExecuteScript(ScWebLogin.Fill(entry!.UserName!, entry.Password!));
                        submittedAt = watch.Elapsed;
                        break;
                    case ScWebLogin.Step.Rejected:
                        throw new ScFailure(ScCodes.WebLoginRejected, $"the sign-in form rejected the login stored in {target}; it is not submitted again: store the login again (private prompt), then repeat",
                            true, new JsonObject { ["target"] = target, ["location"] = status["location"]?.DeepClone() });
                    case ScWebLogin.Step.Interactive:
                        throw Interactive(host, status, submittedAt != null);
                }
            }
            throw Interactive(host, ScWebResult.Status(host, await Evaluate(session.View, ScWebScripts.Status)), submittedAt != null);
        }
        finally { entry = null; Gate.Release(); }
    }

    /// <summary>sc_web login {session:"studio"} (capability sc_web:studioSession): signs the window in through the Studio's
    /// own session only. The Studio must be signed in on host (else STUDIO_NOT_SIGNED_IN, the Studio's own sign-in is the
    /// only login asked); the Service Center is loaded in the hidden window and its single sign-on choice is followed once,
    /// so the identity session of the Studio's browser profile answers. The vault is never read and nothing is typed: a page
    /// that still asks for a login answers WEB_SIGN_IN_NEEDS_LOGIN (the facade then takes the stored-login path).</summary>
    private static async Task<JsonObject> LoginThroughStudio(string host, bool reenter)
    {
        if (!await ScApiHandler.StudioSignedIn(host))
            throw new ScFailure(ScCodes.StudioNotSignedIn, $"the Studio is not signed in on {host}: studio_login opens the Studio's own sign-in; nothing was loaded");
        if (!reenter && Sessions.TryGetValue(host, out var open) && !open.Expired &&
            ScWebResult.Status(host, await Evaluate(open.View, ScWebScripts.Status))["signedIn"]?.GetValue<bool>() == true)
        {
            open.Touch();
            var already = new JsonObject { ["signedIn"] = true, ["submitted"] = false, ["hidden"] = open.Hidden, ["via"] = "studio-session" };
            ScWebSession.Describe(already, true, true, open.LastKeepAliveUtc);
            return already;
        }
        var created = !Sessions.ContainsKey(host);
        if (created) await Open(host, hidden: true);
        if (!Sessions.TryGetValue(host, out var session))
            throw new ScFailure(ScCodes.StudioUnavailable, "sc_web login: the Service Center window closed");
        await Gate.WaitAsync();
        try
        {
            session.SigningIn = true;
            if (!created) await OnUi(() => { session.View.LoadUrl(ScWebPaths.Root(host)); return true; }, "load");
            var watch = Stopwatch.StartNew();
            var ssoFollowed = false;
            while (watch.Elapsed < ScWebLogin.Limit)
            {
                await Task.Delay(500);
                var status = ScWebResult.Status(host, await Evaluate(session.View, ScWebScripts.Status));
                if (!created && watch.Elapsed < TimeSpan.FromSeconds(1)) continue;
                switch (ScWebLogin.NextStudioSession(host, status, await Evaluate(session.View, ScWebLogin.State), ssoFollowed))
                {
                    case ScWebLogin.Step.SignedIn:
                        session.SigningIn = false;
                        session.Touch();
                        var body = new JsonObject { ["signedIn"] = true, ["submitted"] = false, ["hidden"] = session.Hidden, ["via"] = "studio-session" };
                        ScWebSession.Describe(body, true, true, session.LastKeepAliveUtc);
                        return body;
                    case ScWebLogin.Step.Sso:
                        session.View.ExecuteScript(ScWebLogin.SsoClick);
                        ssoFollowed = true;
                        break;
                    case ScWebLogin.Step.NeedsLogin:
                        throw new ScFailure(ScCodes.WebSignInNeedsLogin, $"the Studio's own session did not sign the Service Center window of {host} in (no single sign-on session in the Studio's browser profile) and the page asks for a login; nothing was typed and the vault was not read",
                            details: new JsonObject { ["reentry"] = "needs-login", ["location"] = status["location"]?.DeepClone() });
                    case ScWebLogin.Step.Interactive:
                        throw Interactive(host, status, false);
                }
            }
            throw Interactive(host, ScWebResult.Status(host, await Evaluate(session.View, ScWebScripts.Status)), false);
        }
        finally { Gate.Release(); }
    }

    private static ScFailure Interactive(string host, JsonObject status, bool submitted) => new(ScCodes.WebSignInInteractive,
        $"the sign-in of the Service Center window for {host} needs the user (another identity provider, MFA or a consent page); the hidden window is not shown: sign in through the Studio or a browser",
        submitted, new JsonObject { ["location"] = status["location"]?.DeepClone(), ["submitted"] = submitted });

    /// <summary>A read answered by the sign-in page re-enters once (Login, reenter) and reads again when the Studio itself is
    /// signed in on the host; a write answered by it stays uncertain (ScWebResult.Fetch); a logged-out Studio is the only
    /// login asked (STUDIO_NOT_SIGNED_IN).</summary>
    private static async Task<JsonObject> Fetch(string host, ScWebRequest request)
    {
        if (!Sessions.TryGetValue(host, out var session))
            throw new ScFailure(ScCodes.WebSignInRequired, $"no Service Center window for {host}: run sc_web action=login (or open and sign in there)");
        try { return await FetchOnce(host, session, request); }
        catch (ScFailure failure) when (failure.Code == ScCodes.WebSignInRequired)
        {
            session.Expired = true;
            session.SignedIn = false;
            switch (ScWebSession.OnSignInPage(await ScApiHandler.StudioSignedIn(host), request.Write, request.Method, reentered: false))
            {
                case ScWebSession.Expired.Reenter:
                    await Login(host, reenter: true);
                    if (!Sessions.TryGetValue(host, out var again)) throw;
                    var body = await FetchOnce(host, again, request);
                    body["reentered"] = true;
                    return body;
                case ScWebSession.Expired.StudioSignIn:
                    throw new ScFailure(ScCodes.StudioNotSignedIn, $"the Service Center window of {host} expired and the Studio itself is not signed in on {host}: studio_login opens the Studio's own sign-in; nothing was read",
                        failure.Sent, new JsonObject { ["expired"] = true });
                default:
                    throw;
            }
        }
    }

    private static async Task<JsonObject> FetchOnce(string host, Session session, ScWebRequest request)
    {
        await Gate.WaitAsync();
        try
        {
            var id = Guid.NewGuid().ToString("N");
            // secretRefs: the vault is read here, inside the Studio, right before the send. The values live only in the form
            // copy of this script; a missing entry stops the postback before its operationId is used.
            var injected = ScSecretRefs.Resolve(request.SecretRefs, Vault);
            var script = ScWebScripts.Fetch(id, "https://" + host, request.Url, request.Method, injected.Apply(request.Form), request.Accept);
            if (request.OperationId != null) ScLedger.Claim(request.OperationId);
            JsonObject body;
            try
            {
                session.View.ExecuteScript(script);
                body = ScWebResult.Fetch(host, request.Method, request.Write, await Poll(session.View, id, request.Timeout), injected);
            }
            catch (ScFailure failure) { throw injected.Mask(failure); }
            catch (Exception error)
            {
                if (request.Write) throw injected.Mask(ScReply.Uncertain("sc_web " + request.Method, error, null));
                throw injected.Mask(new ScFailure(ScCodes.RemoteError, "sc_web: " + ScReply.Unwrap(error), true));
            }
            session.SigningIn = false;
            session.Touch();
            body["write"] = request.Write;
            body["operationId"] = request.OperationId;
            return body;
        }
        finally { Gate.Release(); }
    }

    /// <summary>The window's keep-alive: when ScWebSession.KeepAliveDue says so, one same-origin read of the Service Center
    /// home under the window's gate (skipped while another request holds it). The sign-in page marks the window expired, so
    /// the next read re-enters at once instead of trusting the page on screen. Never shown, never asks anything.</summary>
    private static async Task KeepAlive(string host, Session session)
    {
        try
        {
            // D5: every tick first looks at the Studio; without a main window the windows close and nothing is read.
            if (!await OnUi(MayOpen, "keep-alive")) { session.KeepAliveTimer?.Dispose(); return; }
            var open = Sessions.TryGetValue(host, out var current) && ReferenceEquals(current, session);
            if (!ScWebSession.KeepAliveDue(open, session.SignedIn && !session.Expired, Gate.CurrentCount == 0, session.LastActivityUtc, DateTime.UtcNow)) return;
            if (!await Gate.WaitAsync(0)) return;
            try
            {
                var id = Guid.NewGuid().ToString("N");
                session.View.ExecuteScript(ScWebScripts.Fetch(id, "https://" + host, ScWebPaths.Root(host), "GET", null, "html"));
                ScWebResult.Fetch(host, "GET", false, await Poll(session.View, id, TimeSpan.FromSeconds(30)));
                session.Touch();
                session.LastKeepAliveUtc = DateTime.UtcNow;
            }
            catch (ScFailure failure) when (failure.Code == ScCodes.WebSignInRequired) { session.Expired = true; session.SignedIn = false; }
            finally { Gate.Release(); }
        }
        catch (Exception) { /* A failed keep-alive changes nothing; the next read re-enters when the page says so. */ }
    }

    /// <summary>Closes the window and deletes the host cookies of https://host from the Studio's CEF cookie store (CEF
    /// cookie manager methods may be called on any browser-process thread). Domain cookies of a parent domain stay.</summary>
    // Every UI step of the Service Center window is bounded and withdrawn when the UI thread does not run it (UiGate.cs).
    private static Task<T> OnUi<T>(Func<T> job, string what) => Ui.Run(job, UiGate.Step, "sc_web: " + what);

    private static Task<JsonObject> Close(string host) => OnUi(() =>
    {
        var closed = Sessions.TryRemove(host, out var session);
        if (closed)
        {
            session!.KeepAliveTimer?.Dispose();
            session.Window.Close();
            try { session.View.Dispose(); } catch { }
        }
        bool cookiesDeleted;
        try
        {
            using var cookies = Xilium.CefGlue.CefCookieManager.GetGlobal(null);
            cookiesDeleted = cookies?.DeleteCookies("https://" + host, null, null) == true;
        }
        catch (Exception) { cookiesDeleted = false; }
        var body = new JsonObject { ["closed"] = closed, ["cookiesDeleted"] = cookiesDeleted, ["persistentProfile"] = WebView.Settings.PersistCache };
        ScWebSession.Describe(body, false, false, null);
        return body;
    }, "close");

    /// <summary>The page answers through its store; the bridge reads and deletes the entry. null on timeout.</summary>
    private static async Task<string?> Poll(WebView view, string id, TimeSpan timeout)
    {
        var take = ScWebScripts.Take(id);
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            await Task.Delay(150);
            if (await Evaluate(view, take) is { } raw) return raw;
        }
        return null;
    }

    private static async Task<string?> Evaluate(WebView view, string script)
    {
        try
        {
            var task = view.EvaluateScript<string>(script, null, TimeSpan.FromSeconds(10));
            return await Task.WhenAny(task, Task.Delay(TimeSpan.FromSeconds(12))) == task ? task.Result : null;
        }
        catch (Exception) { return null; }
    }
}
