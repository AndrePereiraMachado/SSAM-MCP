using System.Text.Json.Nodes;
using Anvil.Core;
using OutSystems.ObjectKeys;

namespace Anvil.Bridge;

/// <summary>Generic plumbing the files shared with the thin bridge need (docs/O11-BRIDGE-FINA.md section 2.4). This full
/// bridge delegates every member to the kernel; the thin bridge (kernel/src/Anvil.Bridge.Thin/BridgeKit.cs) carries a
/// copy of the same bodies, proved equal by its parity tests.</summary>
internal static class BridgeKit
{
    public static ObjectKey ParseKey(string key) => Keys.Parse(key);
    public static string DbKey(string key) => Keys.ToDb(key);
    public static string StudioKey(string key) => Keys.ToStudio(key);
    public static string Absolute(string verb, string param, string? value) => PathArgs.Absolute(verb, param, value);
    public static JsonNode? Project(object? value) => Json.Project(value);
    public static object? InterfaceProp(object o, string name) => ModelHost.Prop(o, name);
    public const string Progress = DialogPolicy.Progress, Modal = DialogPolicy.Modal, WebDialog = DialogPolicy.WebDialog;
    // The dialog kinds DialogScope names (atritos 3, C10): through BridgeKit, so the file also compiles in the thin bridge.
    public const string ManageDependencies = DialogPolicy.ManageDependencies, MergeEditor = DialogPolicy.MergeEditor, Recovery = DialogPolicy.Recovery;
    public static bool IsBlockingPresenterKind(string kind) => DialogPolicy.IsBlockingPresenterKind(kind);
    public static string ClassifyPresenter(IEnumerable<string> interfaceNames, string typeName) => DialogPolicy.ClassifyPresenter(interfaceNames, typeName);
    public static string ClassifyWindow(string? title, IEnumerable<string> texts) => DialogPolicy.ClassifyWindow(title, texts);
    public static string DialogHint(string kind) => DialogPolicy.Hint(kind);

    /// <summary>ScGuard.Corporate without corporateHosts in config.json: the full bridge (the owner's checkout and the
    /// release) counts no host as corporate; the controller's host policy (hosts.json) still guards every write. The thin
    /// bridge of the hosted pack counts every host (fail closed).</summary>
    public const bool CorporateWhenUnconfigured = false;
}
