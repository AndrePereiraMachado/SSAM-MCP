using System.ComponentModel;
using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Core.ExternalLibraries;

public sealed record ProcessCall(string FileName, IReadOnlyList<string> Arguments, string WorkingDirectory,
    IReadOnlyDictionary<string, string> Environment, TimeSpan Timeout);
public sealed record ProcessOutcome(int ExitCode, string StandardOutput, string StandardError, bool TimedOut);

/// <summary>The one process the build starts (`dotnet publish`); tests pass a fake. Throws Win32Exception or
/// FileNotFoundException when the program does not exist.</summary>
public interface IProcessRunner { ProcessOutcome Run(ProcessCall call); }

public sealed class SystemProcessRunner : IProcessRunner
{
    public ProcessOutcome Run(ProcessCall call)
    {
        var info = new ProcessStartInfo(call.FileName) { WorkingDirectory = call.WorkingDirectory, RedirectStandardOutput = true,
            RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8 };
        foreach (var argument in call.Arguments) info.ArgumentList.Add(argument);
        foreach (var (key, value) in call.Environment) info.Environment[key] = value;
        using var process = Process.Start(info) ?? throw new Win32Exception("The process could not start: " + call.FileName);
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit((int)Math.Min(int.MaxValue, call.Timeout.TotalMilliseconds)))
        {
            try { process.Kill(entireProcessTree: true); } catch { }
            return new ProcessOutcome(-1, output.IsCompleted ? output.Result : "", error.IsCompleted ? error.Result : "", true);
        }
        process.WaitForExit();
        return new ProcessOutcome(process.ExitCode, output.Result, error.Result, false);
    }
}

/// <summary>
/// The build of an External Library, headless: the generated project (ExternalLibraryProject) is published with
/// `dotnet publish -c Release -r linux-x64 --self-contained false -p:Deterministic=true`, the publish folder becomes the
/// deterministic zip and the zip passes the platform's gates (ExternalLibraryPackage). A failure answers with the
/// problems the build printed: a C# error is mapped to its action and to the line and column inside that action's body
/// (EXTERNAL_LIBRARY_BUILD_FAILED); no .NET SDK, or one that cannot target net10.0, is DOTNET_SDK_MISSING; a package
/// NuGet cannot restore is NUGET_RESTORE_FAILED.
/// </summary>
public static class ExternalLibraryBuild
{
    public sealed record Options(long MaxPackageBytes = ExternalLibraryPackage.MaxBytes, TimeSpan? Timeout = null, string Dotnet = "dotnet");

    private static readonly Regex Positioned = new(@"^(?<file>[^\r\n()]+?)\((?<line>\d+),(?<col>\d+)(?:,\d+,\d+)?\)\s*:\s*error\s+(?<code>[A-Z]+[0-9]+)\s*:\s*(?<msg>.*?)(?:\s+\[[^\]]+\])?\s*$", RegexOptions.CultureInvariant);
    private static readonly Regex Plain = new(@"(?:^|:\s)error\s+(?<code>[A-Z]+[0-9]+)\s*:\s*(?<msg>.*?)(?:\s+\[[^\]]+\])?\s*$", RegexOptions.CultureInvariant);
    private static readonly HashSet<string> SdkCodes = new(StringComparer.Ordinal) { "NETSDK1045", "NETSDK1141", "MSB4236" };

    public static JsonObject Build(ExternalLibrarySpec spec, string outDirectory, IProcessRunner runner, Options? options = null)
    {
        options ??= new Options();
        var output = Path.GetFullPath(outDirectory);
        if (Directory.Exists(output) && Directory.EnumerateFileSystemEntries(output).Any())
            throw new IOException("Use a new output folder for the build; evidence is never overwritten: " + output);
        var project = ExternalLibraryProject.Generate(spec);
        var projectDir = Path.Combine(output, "project");
        var publishDir = Path.Combine(output, "publish");
        ExternalLibraryProject.Write(project, projectDir);
        var call = new ProcessCall(options.Dotnet,
            ["publish", Path.Combine(projectDir, project.ProjectFile), "-c", "Release", "-r", ExternalLibraryProject.Runtime, "--self-contained", "false",
             "-p:Deterministic=true", "-o", publishDir, "-nologo"],
            projectDir,
            new Dictionary<string, string> { ["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1", ["DOTNET_NOLOGO"] = "1", ["DOTNET_SKIP_FIRST_TIME_EXPERIENCE"] = "1",
                ["DOTNET_CLI_UI_LANGUAGE"] = "en" },
            options.Timeout ?? TimeSpan.FromMinutes(10));
        ProcessOutcome outcome;
        try { outcome = runner.Run(call); }
        catch (Exception e) when (e is Win32Exception or FileNotFoundException)
        {
            throw new ExternalLibraryException("DOTNET_SDK_MISSING", "dotnet was not found: the .NET 10 SDK builds External Libraries.",
                [new("DOTNET_SDK_MISSING", "", "The program '" + options.Dotnet + "' could not start (" + e.Message + ").",
                    "Install the .NET 10 SDK (dotnet-sdk-10) on this machine; dotnet must be on PATH.")]);
        }
        var log = Path.Combine(output, "build.log");
        File.WriteAllText(log, "exit " + outcome.ExitCode + (outcome.TimedOut ? " (timeout)" : "") + "\n--- stdout\n" + outcome.StandardOutput + "\n--- stderr\n" + outcome.StandardError);
        var evidence = new JsonObject { ["log"] = log, ["project"] = projectDir };
        if (outcome.TimedOut)
            throw new ExternalLibraryException("EXTERNAL_LIBRARY_BUILD_FAILED", "dotnet publish did not end within " + call.Timeout + ".",
                [new("BUILD_TIMEOUT", "", "dotnet publish did not end within " + call.Timeout + ".", "Check NuGet access and repeat; the log is " + log + ".")], evidence);
        if (outcome.ExitCode != 0) throw Diagnose(outcome, project, spec, evidence);
        if (!Directory.Exists(publishDir))
            throw new ExternalLibraryException("EXTERNAL_LIBRARY_BUILD_FAILED", "dotnet publish ended without a publish folder.",
                [new("PUBLISH_EMPTY", "", "dotnet publish ended without " + publishDir + ".", "Read " + log + ".")], evidence);
        var zip = ExternalLibraryPackage.Zip(publishDir);
        var facts = ExternalLibraryPackage.Inspect(zip, options.MaxPackageBytes, spec.Name);
        var fileName = spec.Name + "-" + facts.Sha256[..16] + ".zip";
        var packagePath = Path.Combine(output, fileName);
        using (var stream = new FileStream(packagePath, FileMode.CreateNew, FileAccess.Write)) stream.Write(zip);
        return new JsonObject
        {
            ["ok"] = true, ["name"] = spec.Name, ["namespace"] = spec.Namespace,
            ["package"] = new JsonObject { ["path"] = packagePath, ["fileName"] = fileName, ["sha256"] = facts.Sha256, ["bytes"] = facts.Bytes,
                ["entries"] = facts.Entries.Count, ["mainAssembly"] = facts.MainAssembly, ["runtimeTarget"] = facts.RuntimeTarget },
            ["project"] = new JsonObject { ["directory"] = projectDir, ["projectFile"] = project.ProjectFile,
                ["files"] = new JsonArray(project.Files.Keys.Select(f => (JsonNode)new JsonObject { ["path"] = f, ["sha256"] = project.Sha256(f) }).ToArray()) },
            ["contents"] = ExternalLibraryContents.FromSpec(spec),
            ["sdk"] = new JsonObject { ["package"] = ExternalLibraryProject.SdkPackage, ["version"] = ExternalLibraryProject.SdkVersion },
            ["targetFramework"] = ExternalLibraryProject.TargetFramework, ["runtime"] = ExternalLibraryProject.Runtime, ["log"] = log,
        };
    }

    /// <summary>The refusal a failed `dotnet publish` deserves, from what it printed.</summary>
    public static ExternalLibraryException Diagnose(ProcessOutcome outcome, ExternalLibraryProject.Project project, ExternalLibrarySpec spec, JsonObject? evidence = null)
    {
        var text = outcome.StandardOutput + "\n" + outcome.StandardError;
        var lines = text.Replace("\r\n", "\n").Split('\n').Select(l => l.Trim()).Where(l => l.Length > 0).ToArray();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var compile = new List<ExternalLibraryProblem>();
        var nuget = new List<ExternalLibraryProblem>();
        var sdk = new List<ExternalLibraryProblem>();
        foreach (var line in lines)
        {
            if (line.Contains("No .NET SDKs were found", StringComparison.OrdinalIgnoreCase)
                || line.Contains("A compatible .NET SDK was not found", StringComparison.OrdinalIgnoreCase)
                || line.Contains("compatible SDK version", StringComparison.OrdinalIgnoreCase))
            {
                if (seen.Add("sdk:" + line)) sdk.Add(new("DOTNET_SDK_MISSING", "", Clip(line), "Install the .NET 10 SDK (dotnet-sdk-10)."));
                continue;
            }
            var positioned = Positioned.Match(line);
            var match = positioned.Success ? positioned : Plain.Match(line);
            if (!match.Success) continue;
            var code = match.Groups["code"].Value; var message = Clip(match.Groups["msg"].Value);
            var file = positioned.Success ? Path.GetFileName(positioned.Groups["file"].Value.Trim()) : null;
            var lineNo = positioned.Success ? int.Parse(positioned.Groups["line"].Value) : 0;
            var col = positioned.Success ? int.Parse(positioned.Groups["col"].Value) : 0;
            if (!seen.Add(code + "|" + file + "|" + lineNo + "|" + col + "|" + message)) continue;
            if (SdkCodes.Contains(code)) sdk.Add(new("DOTNET_SDK_MISSING", "", code + ": " + message, "Install the .NET 10 SDK (dotnet-sdk-10); the installed SDK cannot target " + ExternalLibraryProject.TargetFramework + "."));
            else if (code.StartsWith("NU", StringComparison.Ordinal))
                nuget.Add(new(code, PackagePath(spec, message), code + ": " + message,
                    "Check the package id and exact version on nuget.org and that this machine reaches the NuGet feed; then repeat."));
            else compile.Add(Map(code, message, file, lineNo, col, project, spec));
        }
        if (sdk.Count > 0)
            return new ExternalLibraryException("DOTNET_SDK_MISSING", "The .NET SDK cannot build a net10.0 External Library: " + sdk[0].Message, sdk, evidence);
        if (nuget.Count > 0)
            return new ExternalLibraryException("NUGET_RESTORE_FAILED", "NuGet could not restore the packages: " + nuget[0].Message, nuget, evidence);
        if (compile.Count > 0)
            return new ExternalLibraryException("EXTERNAL_LIBRARY_BUILD_FAILED", compile.Count + " build error(s); the first: " + compile[0].Message, compile, evidence);
        var tail = string.Join(" | ", lines.TakeLast(5));
        return new ExternalLibraryException("EXTERNAL_LIBRARY_BUILD_FAILED", "dotnet publish failed (exit " + outcome.ExitCode + ").",
            [new("BUILD_FAILED", "", Clip("dotnet publish failed (exit " + outcome.ExitCode + "): " + tail), "Read the build log" + (evidence?["log"] is { } l ? " " + l : "") + ".")], evidence);
    }

    private static ExternalLibraryProblem Map(string code, string message, string? file, int line, int col, ExternalLibraryProject.Project project, ExternalLibrarySpec spec)
    {
        const string fix = "Correct the C# of this action in its body (the line is counted from the first line of the body); parameters keep their declared names.";
        if (file != null)
        {
            var body = project.Spans.FirstOrDefault(s => s.Kind == "body" && s.File == file && line >= s.FirstLine && line <= s.LastLine);
            if (body != null)
                return new(code, "/actions/" + body.Index + "/body", message, fix, spec.Actions[body.Index].Name, line - body.FirstLine + 1, Math.Max(1, col - 8));
            var owner = project.Spans.FirstOrDefault(s => s.Kind != "body" && s.File == file && line >= s.FirstLine && line <= s.LastLine);
            if (owner != null)
                return owner.Kind == "structure"
                    ? new(code, "/structures/" + owner.Index, message, "Correct the structure's attribute names and types.", spec.Structures[owner.Index].Name)
                    : new(code, "/actions/" + owner.Index, message, "Correct the action's parameters, types or body (" + file + " line " + line + ").", spec.Actions[owner.Index].Name);
        }
        return new(code, "", message + (file != null ? " (" + file + " line " + line + ")" : ""), "Correct the spec; read the build log for the generated file.");
    }
    private static string PackagePath(ExternalLibrarySpec spec, string message)
    {
        for (var i = 0; i < spec.Packages.Count; i++)
            if (message.Contains(spec.Packages[i].Name, StringComparison.OrdinalIgnoreCase)) return "/packages/" + i;
        return message.Contains(ExternalLibraryProject.SdkPackage, StringComparison.OrdinalIgnoreCase) ? "/packages" : "";
    }
    private static string Clip(string text) => text.Length <= 500 ? text : text[..500] + "...";
}
