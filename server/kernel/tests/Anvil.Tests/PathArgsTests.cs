using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>Regra dos caminhos da bridge (plano, item 11): relativo e recusado com o verbo, o parametro, o valor e o cwd; absoluto
/// e devolvido normalizado; vazio e recusado. Offline: o helper e puro; os 5 call sites (snapshot_module, merge_from_oml,
/// export_modules, export_status, login) so se provam ao vivo.</summary>
public class PathArgsTests
{
    [Fact]
    public void RelativePathIsRefusedWithVerbParamValueAndCwd()
    {
        var ex = Assert.Throws<ArgumentException>(() => PathArgs.Absolute("snapshot_module", "path", ".local/proofs/x.oml"));
        Assert.Contains("snapshot_module: 'path' must be an absolute path", ex.Message);
        Assert.Contains(".local/proofs/x.oml", ex.Message);
        Assert.Contains(Environment.CurrentDirectory, ex.Message);
    }

    [Fact]
    public void AbsolutePathIsNormalized()
    {
        if (!OperatingSystem.IsWindows()) return;
        var full = PathArgs.Absolute("merge_from_oml", "foreign_path", @"C:\Users\x\..\y\a.oml");
        Assert.Equal(@"C:\Users\y\a.oml", full);
    }

    [Fact]
    public void EmptyPathIsRefused()
    {
        var ex = Assert.Throws<ArgumentException>(() => PathArgs.Absolute("login", "credentials_file", " "));
        Assert.Contains("login: 'credentials_file' is required", ex.Message);
    }
}
