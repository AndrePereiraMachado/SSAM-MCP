using Xunit;

public sealed class AgentDataRootTests
{
    [Fact]
    public void Packaged_bridge_never_writes_to_installation_and_binding_is_immutable()
    {
        var temp = Path.Combine(Path.GetTempPath(), "ssam-root-" + Guid.NewGuid().ToString("N"));
        try
        {
            var installation = Path.Combine(temp, "installation");
            var data = Path.Combine(temp, "data");
            var other = Path.Combine(temp, "other");
            foreach (var home in new[] { data, other })
                foreach (var folder in new[] { "private", "inbox", "odc/snapshots", "odc/journal", "odc/lab" })
                    Directory.CreateDirectory(Path.Combine(home, folder));
            var state = new AgentDataRoot(installation, true);
            Assert.False(state.CanWrite);
            Assert.Throws<InvalidOperationException>(state.Use);
            Assert.False(Directory.Exists(installation));
            Assert.Throws<InvalidOperationException>(() => state.Bind(installation));
            Assert.Equal(Path.Combine(data, "odc"), state.Bind(Path.Combine(data, "odc")));
            state.Use();
            Assert.True(state.CanWrite);
            Assert.Equal(Path.Combine(data, "odc"), state.Bind(Path.Combine(data, "odc")));
            Assert.Throws<InvalidOperationException>(() => state.Bind(Path.Combine(other, "odc")));
            Assert.False(Directory.Exists(installation));
        }
        finally { if (Directory.Exists(temp)) Directory.Delete(temp, true); }
    }

    [Fact]
    public void Checkout_keeps_its_existing_root()
    {
        var root = Path.Combine(Path.GetTempPath(), "ssam-checkout-" + Guid.NewGuid().ToString("N"));
        try
        {
            var state = new AgentDataRoot(root, false);
            state.Use();
            Assert.True(Directory.Exists(Path.Combine(root, "snapshots")));
            Assert.Equal(root, state.Value);
        }
        finally { Directory.Delete(root, true); }
    }
}
