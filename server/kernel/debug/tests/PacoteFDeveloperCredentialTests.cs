#if !ODC
// C05 (2026-10-05 package): an O11 start with no developer login answered only debug_native_error
// (InvalidOperationException "SSAM_O11_HOST not set"). The missing login is now the classified code the facade explains.
static class PacoteFDeveloperCredentialTests {
    internal static void Run() {
        var names = new[] { "SSAM_O11_HOST", "SSAM_O11_USERNAME", "SSAM_O11_PASSWORD" };
        var saved = names.ToDictionary(name => name, Environment.GetEnvironmentVariable);
        try {
            foreach (var name in names) Environment.SetEnvironmentVariable(name, null);
            Expect(() => O11Authentication.Credentials(null), "no file and no environment");
            Expect(() => O11Authentication.Credentials(Path.Combine(Path.GetTempPath(), "ssam-missing-" + Guid.NewGuid().ToString("N") + ".json")), "a file that does not exist");
            var broken = Path.Combine(Path.GetTempPath(), "ssam-broken-" + Guid.NewGuid().ToString("N") + ".json");
            File.WriteAllText(broken, "{\"username\":\"synthetic\"}");
            try { Expect(() => O11Authentication.Credentials(broken), "a file without password"); }
            finally { File.Delete(broken); }
        } finally {
            foreach (var (name, value) in saved) Environment.SetEnvironmentVariable(name, value);
        }
    }
    static void Expect(Action action, string what) {
        try { action(); throw new Exception("developer credentials accepted: " + what); }
        catch (DebugFailure error) { Tests.Check(error.Message == "debug_developer_credentials_required", "classified developer login refusal: " + what); }
    }
}
#endif
