using System.Text.Json.Nodes;
using Anvil.Xif;

namespace Anvil.Cli;

/// <summary>
/// anvil xif: O11 .NET extensions without Integration Studio, local files only (contract INTEGRACOES-GITSSAM.md, lane xif).
///   xif check --spec &lt;json&gt; [--base &lt;xif&gt;]                       every spec problem at once (XIF_SPEC_INVALID)
///   xif read  --xif &lt;file&gt;                                            identity, hashes, spec (keys, bodies), resources
///   xif build --stage model --spec &lt;json&gt; [--base &lt;xif&gt;] --work &lt;dir&gt;
///   xif build --stage final --spec &lt;json&gt; --model &lt;xif&gt; --stubs &lt;zip&gt; --deps &lt;zip&gt; [--base &lt;xif&gt;] --work &lt;dir&gt;
///   xif diff  --base &lt;xif&gt; --new &lt;xif&gt;                                 public contract diff (breaking vs additive)
/// One JSON per command, {ok, ...} or {ok:false, code, error, problems}.
/// </summary>
public static class XifCommand
{
    public static JsonObject Run(string[] args)
    {
        try
        {
            var verb = args.Length > 1 ? args[1] : "";
            return verb switch
            {
                "check" => XifBuild.Check(Spec(args), Opt(args, "--base")),
                "read" => Read(Need(args, "--xif"), Opt(args, "--resources-out")),
                "build" => Build(args),
                "diff" => Diff(Need(args, "--base"), Need(args, "--new")),
                _ => Usage(),
            };
        }
        catch (XifRefusal refusal) { return refusal.ToJson(); }
    }

    private static JsonObject Build(string[] args) => Opt(args, "--stage") switch
    {
        "model" => XifBuild.Model(Spec(args), Opt(args, "--base"), Need(args, "--work")),
        "final" => XifBuild.Final(Spec(args), Need(args, "--model"), Need(args, "--stubs"), Need(args, "--deps"), Opt(args, "--base"), Need(args, "--work")),
        _ => XifRefusal.Single(XifCodes.SpecInvalid, "xif build needs --stage model or --stage final.", "Pass --stage model first, then --stage final with the stubs and dependencies.").ToJson(),
    };

    private static JsonObject Read(string file, string? resourcesOut)
    {
        var document = XifPackage.Read(file);
        var described = document.Describe();
        if (resourcesOut != null) described["exported"] = document.ExportResources(resourcesOut);
        described["ok"] = true;
        return described;
    }

    private static JsonObject Diff(string before, string after)
    {
        var diff = XifContractDiff.Diff(XifPackage.Read(before), XifPackage.Read(after));
        diff["ok"] = true;
        return diff;
    }

    private static JsonNode? Spec(string[] args)
    {
        var file = Need(args, "--spec");
        if (!Path.IsPathFullyQualified(file) || !File.Exists(file))
            throw XifRefusal.Single(XifCodes.SpecInvalid, $"--spec '{file}' is not an existing absolute JSON file.", "Write the spec to a JSON file and pass its absolute path.");
        try { return JsonNode.Parse(File.ReadAllText(file).TrimStart('﻿')); }
        catch (System.Text.Json.JsonException error)
        {
            throw XifRefusal.Single(XifCodes.SpecInvalid, "The spec is not valid JSON: " + error.Message, "Fix the JSON of the spec.");
        }
    }

    private static JsonObject Usage() => XifRefusal.Single(XifCodes.SpecInvalid, "usage: anvil xif <check|read|build|diff> ...",
        "check --spec <json> [--base <xif>] | read --xif <file> | build --stage model|final ... | diff --base <xif> --new <xif>").ToJson();

    private static string? Opt(string[] args, string name)
    {
        var i = Array.IndexOf(args, name);
        return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
    }

    private static string Need(string[] args, string name) => Opt(args, name)
        ?? throw XifRefusal.Single(XifCodes.SpecInvalid, $"{name} is required.", $"Pass {name} <value>.");
}
