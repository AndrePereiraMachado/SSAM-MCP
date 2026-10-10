using System.Text.Json.Nodes;
using Anvil.Bridge;
using Xunit;

namespace Anvil.Tests;

// D5 of the atritos 3 package (session of 2026-10-06 22:58Z): the user closed the Studio's main window, the hidden Service
// Center window of SSAM and its keep-alive kept the process running, and the process held the O11 lane ("the Studio has no
// window"). ScWindowLifetime (ScProtocol.cs, pure) is the rule ScWebHandler applies: a Service Center window lives only
// while the Studio has a main window.
public class Pa3FaScTests
{
    [Fact]
    public void TheServiceCenterWindowsCloseOnceWhenTheStudioHasNoMainWindowLeft()
    {
        var life = new ScWindowLifetime();
        var closed = 0;
        Assert.True(life.Register(() => closed++));
        Assert.True(life.Register(() => closed++));
        Assert.False(life.Observe(1));
        Assert.True(life.MayOpen(2));
        Assert.Equal(0, closed);
        Assert.True(life.Observe(0));
        Assert.Equal(2, closed);
        Assert.False(life.Observe(0));
        Assert.Equal(2, closed);
        Assert.True(life.OwnerGone);
        Assert.False(life.MayOpen(1));
        // A window asked after that closes at once and is refused: it would keep a windowless process running.
        Assert.False(life.Register(() => closed++));
        Assert.Equal(3, closed);
    }

    [Fact]
    public void AWindowThatClosedByItselfIsNotClosedAgainAndAFailingCloseStopsNothing()
    {
        var life = new ScWindowLifetime();
        var first = 0; var second = 0;
        Action a = () => first++;
        Action broken = () => throw new InvalidOperationException("already gone");
        Action b = () => second++;
        life.Register(a); life.Register(broken); life.Register(b);
        life.Unregister(a);
        Assert.True(life.Observe(0));
        Assert.Equal(0, first);
        Assert.Equal(1, second);
    }

    [Fact]
    public void TheWindowlessRefusalNamesThePidTheConnectionAndThatNothingWasSent()
    {
        var failure = ScWindowLifetime.Windowless(4242, "studio_login");
        Assert.Equal(ScCodes.StudioWindowless, failure.Code);
        Assert.Equal("STUDIO_WINDOWLESS", failure.Code);
        Assert.Contains("4242", failure.Message);
        Assert.Contains("ssam_connect {lane:\"o11\"}", failure.Message);
        Assert.Contains("never closes or ends a Studio", failure.Message);
        Assert.False(failure.Sent);
        Assert.Equal(4242, failure.Details!["pid"]!.GetValue<int>());
        var reply = JsonNode.Parse(ScReply.Fail(failure))!.AsObject();
        Assert.Equal("STUDIO_WINDOWLESS", reply["code"]!.GetValue<string>());
        Assert.Equal(4242, reply["data"]!["pid"]!.GetValue<int>());
        Assert.False(reply["executed"]!.GetValue<bool>());
    }
}
