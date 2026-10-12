using System.Text.Json.Nodes;
using Anvil.Bridge;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>Lane F8 of the atritos 2 package (A13): the Service Center logs asked for a separate vault login while the
/// Studio was signed in by SSO ("No Service Center login is stored for &lt;host&gt;: a private Windows prompt opened",
/// session cx-0e61, 06/10 01:18; the session stopped until 10:06). The bridge now signs its hidden window in through the
/// Studio's own session only (sc_web login {session:"studio"}, capability sc_web:studioSession): the single sign-on
/// choice is followed even beside the form, the vault is never read, and a page that still asks for a login answers
/// WEB_SIGN_IN_NEEDS_LOGIN. Pure parts (ScProtocol.cs) and the capability flags of Dispatch.cs; no Studio or CEF.</summary>
public sealed class Pa2F8ScTests
{
    private const string Host = "personal-0000test.outsystemscloud.com";
    private static string Root => JobRunner.RepoRoot(Path.GetDirectoryName(typeof(Pa2F8ScTests).Assembly.Location)!)!;
    private static JsonObject Status(bool signedIn, bool loading = false) => new() { ["open"] = true, ["signedIn"] = signedIn, ["loading"] = loading };
    private static string Page(string origin, bool form = false, bool sso = false) =>
        new JsonObject { ["origin"] = origin, ["form"] = form, ["error"] = false, ["sso"] = sso }.ToJsonString();

    [Fact]
    public void TheStudioSessionSignInFollowsSingleSignOnAndNeverFillsAForm()
    {
        // The Service Center sign-in page of a personal environment: its form and the "Log in with" choice side by side.
        Assert.Equal(ScWebLogin.Step.Sso, ScWebLogin.NextStudioSession(Host, Status(false), Page("https://" + Host, form: true, sso: true), ssoFollowed: false));
        // The former path fills that same form with the vault login (what asked for the private prompt).
        Assert.Equal(ScWebLogin.Step.Fill, ScWebLogin.Next(Host, Status(false), Page("https://" + Host, form: true, sso: true), null, ssoFollowed: false));
        // Followed once and the identity provider asks for a login: NeedsLogin, never Fill.
        Assert.Equal(ScWebLogin.Step.NeedsLogin, ScWebLogin.NextStudioSession(Host, Status(false), Page("https://id.outsystems.com", form: true), ssoFollowed: true));
        Assert.Equal(ScWebLogin.Step.NeedsLogin, ScWebLogin.NextStudioSession(Host, Status(false), Page("https://" + Host, form: true, sso: true), ssoFollowed: true));
        // Another identity provider (corporate, MFA): the user, never shown.
        Assert.Equal(ScWebLogin.Step.Interactive, ScWebLogin.NextStudioSession(Host, Status(false), Page("https://login.corp.example", form: true), ssoFollowed: true));
        // Signed in by the Studio's own single sign-on; loading pages wait.
        Assert.Equal(ScWebLogin.Step.SignedIn, ScWebLogin.NextStudioSession(Host, Status(true), null, ssoFollowed: true));
        Assert.Equal(ScWebLogin.Step.Wait, ScWebLogin.NextStudioSession(Host, Status(false, loading: true), null, ssoFollowed: false));
        Assert.Equal(ScWebLogin.Step.Wait, ScWebLogin.NextStudioSession(Host, Status(false), Page("https://id.outsystems.com"), ssoFollowed: true));
    }

    [Fact]
    public void TheNewCodeAndCapabilityAreDeclared()
    {
        Assert.Equal("WEB_SIGN_IN_NEEDS_LOGIN", ScCodes.WebSignInNeedsLogin);
        Assert.Equal("sc_web:studioSession", ScWebSession.StudioSessionCapability);
        Assert.Equal("studio", ScWebSession.StudioSession);
    }

    [Fact]
    public void DispatchAdvertisesBothNewCapabilitiesSoOlderBridgesFallBack()
    {
        // Dispatch.cs needs Avalonia (not linked here): its capability list is read as source. The facade decides by these
        // flags (service-center/auth.mjs, the CLI users verb): a bridge without them keeps the former path or refuses.
        var source = File.ReadAllText(Path.Combine(Root, "src", "Anvil.Bridge", "Dispatch.cs"));
        var list = source[source.IndexOf("Capabilities = [", StringComparison.Ordinal)..];
        list = list[..list.IndexOf("];", StringComparison.Ordinal)];
        // SC/Portal line (port of 2026-10-11): sc_web goes through the headless HTTP handler, so the bridge advertises
        // sc_http:studioSession (ScHttpHandler) and the private transport (ScPrivateHttp) instead of sc_web:studioSession;
        // service-center/auth.mjs decides by sc_http:studioSession.
        Assert.Contains("ScHttpHandler.Capability", list);
        Assert.Contains("ScPrivateHttp.Capability", list);
        Assert.DoesNotContain("ScWebSession.StudioSessionCapability", list);
        Assert.Contains("UserDirectory.Capability", list);
        var handler = File.ReadAllText(Path.Combine(Root, "src", "Anvil.Bridge", "ScWebHandler.cs"));
        Assert.Contains("ScWebSession.StudioSession => await LoginThroughStudio", handler);
        // The Studio-session sign-in never touches the vault.
        var method = handler[handler.IndexOf("private static async Task<JsonObject> LoginThroughStudio", StringComparison.Ordinal)..];
        method = method[..method.IndexOf("private static ScFailure Interactive", StringComparison.Ordinal)];
        Assert.DoesNotContain("Vault", method);
        Assert.DoesNotContain("ScWebLogin.Fill", method);
    }
}
