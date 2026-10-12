using OutSystems.ObjectKeys;

internal static class TraceFunctionKeyTests {
    internal static void Run() {
        const string action = "dEWwXGH7NkeApGZ+qJiYJQ", preparation = action + ".#Preparation";
        new TraceOptions { FocusFunctionKey = action, RequireFunctionKey = action, Scopes = new() { [action] = ["Count"] } }.Validate();
        var original = new TraceOptions { FocusFunctionKey = preparation, RequireFunctionKey = preparation, Scopes = new() { [preparation] = ["GetContacts"] } };
#if ODC
        try { original.Validate(); throw new Exception("ODC accepted O11 Preparation"); } catch (DebugFailure) { }
#else
        Tests.Check(ObjectKey.Parse(preparation).ToString() == preparation, "Native Preparation ObjectKey must round trip unchanged");
        original.Validate();
#endif
        foreach (var invalid in new[] { action + ".#LaunchProcess", action + ".#WakeTimer", preparation + ".extra", action + ".#preparation", "bad key" }) {
            foreach (var trace in new[] { new TraceOptions { FocusFunctionKey = invalid }, new TraceOptions { RequireFunctionKey = invalid }, new TraceOptions { Scopes = new() { [invalid] = ["Count"] } } })
                try { trace.Validate(); throw new Exception("Invalid trace function key accepted"); } catch (DebugFailure) { }
        }
        Console.WriteLine("TraceFunctionKeyTests passed");
    }
}
