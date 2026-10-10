using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text.Json;
using Xunit;

namespace Anvil.CSharp.Tests;

/// <summary>
/// Independent source-semantics oracle: the installed .NET SDK builds ordinary C#,
/// then the real CLR result is checked against expectations frozen before execution.
/// This class does not invoke the translator, native model, worker, or Studio.
/// </summary>
public sealed class ExceptionSearchSourceTests
{
    private static readonly Lazy<OracleRun> Run = new(BuildAndRun);

    [Theory]
    [InlineData("caller-filter-before-callee-finally")]
    [InlineData("filter-mutates-captured-caller-scalar")]
    [InlineData("finally-replacement-restarts-outer-filter-search")]
    [InlineData("throwing-filter-helper-is-false-with-effects")]
    [InlineData("reassigned-catch-variable-bare-rethrow-keeps-original")]
    [InlineData("recursive-same-region-selects-frame-and-cleanup-order")]
    public void RealClrMatchesFrozenSearchAndUnwindOracle(string name)
    {
        var run = Run.Value;
        var expected = run.Expected.Single(item => item.Name == name);
        var actual = run.Actual.Single(item => item.Name == name);
        Assert.Equal(expected.Events, actual.Events);
        Assert.Equal(expected.ReturnValue, actual.ReturnValue);
        Assert.Equal(expected.CaughtException, actual.CaughtException);
        Assert.Equal(expected.FinalException, actual.FinalException);
        Assert.Equal(expected.State.OrderBy(item => item.Key), actual.State.OrderBy(item => item.Key));
    }

    private static OracleRun BuildAndRun()
    {
        var corpus = FindCorpus();
        var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
        var freeze = JsonSerializer.Deserialize<Freeze>(
            File.ReadAllText(Path.Combine(corpus, "freeze.cases.json")), options)!;
        foreach (var entry in freeze.Files)
        {
            var actualHash = Convert.ToHexString(SHA256.HashData(
                File.ReadAllBytes(Path.Combine(corpus, entry.Key)))).ToLowerInvariant();
            Assert.Equal(entry.Value, actualHash);
        }

        var expected = JsonSerializer.Deserialize<ExpectedCorpus>(
            File.ReadAllText(Path.Combine(corpus, "expected.cases.json")), options)!.Cases;
        Assert.Equal(6, expected.Length);
        Assert.Equal(6, expected.Select(item => item.Name).Distinct(StringComparer.Ordinal).Count());

        var workspace = FindWorkspace();
        var directory = Path.Combine(workspace, ".local", "exception-search-oracle", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        foreach (var source in Directory.GetFiles(corpus, "*.cs.txt").OrderBy(path => path))
        {
            Assert.True(freeze.Files.ContainsKey(Path.GetFileName(source)), "Unfrozen source: " + source);
            File.Copy(source, Path.Combine(directory, Path.GetFileNameWithoutExtension(source)));
        }

        var project = Path.Combine(directory, "ExceptionSearchOracle.csproj");
        File.WriteAllText(project, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <OutputType>Exe</OutputType>
                <TargetFramework>net8.0</TargetFramework>
                <UseAppHost>false</UseAppHost>
                <ImplicitUsings>enable</ImplicitUsings>
                <Nullable>enable</Nullable>
                <RollForward>Major</RollForward>
                <DebugType>portable</DebugType>
                <EnableNETAnalyzers>false</EnableNETAnalyzers>
              </PropertyGroup>
            </Project>
            """);

        ExecuteDotNet(directory, "build", project, "--nologo", "--verbosity", "quiet", "-p:UseAppHost=false");
        var output = ExecuteDotNet(directory, Path.Combine(directory, "bin", "Debug", "net8.0", "ExceptionSearchOracle.dll"));
        File.WriteAllText(Path.Combine(directory, "actual-results.json"), output);
        var actual = JsonSerializer.Deserialize<CaseResult[]>(output, options)!;
        Assert.Equal(expected.Select(item => item.Name).OrderBy(name => name),
            actual.Select(item => item.Name).OrderBy(name => name));
        return new OracleRun(expected, actual);
    }

    private static string ExecuteDotNet(string directory, params string[] arguments)
    {
        var startInfo = new ProcessStartInfo("dotnet")
        {
            WorkingDirectory = directory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };
        foreach (var argument in arguments) startInfo.ArgumentList.Add(argument);
        startInfo.Environment["DOTNET_NOLOGO"] = "1";
        startInfo.Environment["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1";
        using var process = Process.Start(startInfo)!;
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(120_000))
        {
            process.Kill(entireProcessTree: true);
            throw new TimeoutException("CLR oracle exceeded 120 seconds.");
        }
        var output = stdout.GetAwaiter().GetResult();
        var error = stderr.GetAwaiter().GetResult();
        Assert.True(process.ExitCode == 0,
            $"dotnet {string.Join(' ', arguments)} failed ({process.ExitCode}).\n{output}\n{error}");
        return output;
    }

    private static string FindCorpus([CallerFilePath] string testSource = "")
    {
        var copied = Path.Combine(AppContext.BaseDirectory, "Cases", "exception-search");
        if (Directory.Exists(copied)) return copied;
        return Path.GetFullPath(Path.Combine(Path.GetDirectoryName(testSource)!, "..", "csharp", "exception-search"));
    }

    private static string FindWorkspace([CallerFilePath] string testSource = "") =>
        Path.GetFullPath(Path.Combine(Path.GetDirectoryName(testSource)!, "..", ".."));

    private sealed record Freeze(Dictionary<string, string> Files);
    private sealed record ExpectedCorpus(CaseResult[] Cases);
    private sealed record CaseResult(string Name, string[] Events, string ReturnValue,
        string CaughtException, string FinalException, Dictionary<string, string> State);
    private sealed record OracleRun(CaseResult[] Expected, CaseResult[] Actual);
}
