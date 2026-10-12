// A binding whose last native Start/Stop is uncertain never gets another session: the code list (operation 4c on
// Headless_UI/personal-2qqw9srv) and the local registry refuse at Validate, before any transport or credential use.
static class BlockedBindingTests {
    internal static void Run() {
        O11NativeNeutralizationTests.Run();
        Tests.Check(BlockedBindings.Hash("https://Shop.Example.Test", "UIUIUIUIUIUIUIUIUIUIUI") ==
#if ODC
            BlockedBindings.Hash("https://shop.example.test", "UIUIUIUIUIUIUIUIUIUIUI"),
#else
            "3f36d1607036a0c127714a41720570a48e321d73ad04b3a1923053f85d901971", // same value as the facade's bindingHash
#endif
            "registry hash matches the facade");
        Configuration Make(string url, string moduleKey, string? receipt = null) => new() { SessionId = Guid.NewGuid().ToString("N"), Module = "Headless_UI",
            ModuleKey = moduleKey, RuntimeUrl = url, NodeKeys = [Tests.NodeKey], ReceiptPath = receipt };
#if !ODC
        try { Make("https://personal-2qqw9srv.outsystemscloud.com/Headless_UI/", "Mif02PxcH0K7KiABEHTwMg").Validate(); throw new Exception("4c binding accepted"); }
        catch (DebugFailure error) { Tests.Check(error.Message == "debug_binding_blocked", "4c binding refused: " + error.Message); }
        Make("https://personal-2qqw9srv.outsystemscloud.com/Headless_CS/", "Kawk_WFx5USxo7qFAB0lCQ").Validate(); // another binding of the same environment
        var consumer = Make("https://personal-2qqw9srv.outsystemscloud.com/Headless_UI/", "Kawk_WFx5USxo7qFAB0lCQ");
        consumer.EntryModule = "Headless_UI"; consumer.EntryModuleKey = "Mif02PxcH0K7KiABEHTwMg";
        try { consumer.Validate(); throw new Exception("blocked consumer accepted"); }
        catch (DebugFailure error) { Tests.Check(error.Message == "debug_binding_blocked", "4c remains blocked through a different producer"); }
#endif
        var root = Path.Combine(Path.GetTempPath(), "ssam-blocked-" + Guid.NewGuid().ToString("N"));
        try {
            var session = Path.Combine(root, ".local", "debugger", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(session); Directory.CreateDirectory(Path.Combine(root, ".local", "debugger", "blocked-bindings"));
            var receipt = Path.Combine(session, "receipt.json");
            Make("https://shop.example.test/ShopUI/", "UIUIUIUIUIUIUIUIUIUIUI", receipt).Validate();
            File.WriteAllText(Path.Combine(root, ".local", "debugger", "blocked-bindings", BlockedBindings.Hash("https://shop.example.test", "UIUIUIUIUIUIUIUIUIUIUI") + ".json"), "{}");
            try { Make("https://shop.example.test/ShopUI/", "UIUIUIUIUIUIUIUIUIUIUI", receipt).Validate(); throw new Exception("registry binding accepted"); }
            catch (DebugFailure error) { Tests.Check(error.Message == "debug_binding_blocked", "registry binding refused"); }
        } finally { Directory.Delete(root, true); }
    }
}
