// Synthetic stand-in for a platform DLL of GetSourceCodeDependencies, written for the tests (no OutSystems code). The
// tests compile it to OutSystems.HubEdition.RuntimePlatform.dll for .NET Framework 4.7.2 and give it to XifCompiler as a
// platform reference.
namespace OutSystems.HubEdition.RuntimePlatform
{
    public static class FakeRuntime
    {
        public static int Twice(int value) { return checked(value * 2); }
    }
}

namespace OutSystems.RuntimePublic.Db
{
    public sealed class FakeTransaction
    {
        public string Name { get; set; }
    }
}
