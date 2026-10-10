using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using OutSystems.Model;
using ServiceStudio.Model;

namespace Anvil.Core;

public sealed record ProofRow(string Type, string Parent, string Via, string Status, int Messages, IReadOnlyList<string> MessageIds, string? Error, string? Name, string? ParentPath, string? FullType = null, string? FullParent = null);

/// <summary>
/// Gerador de provas do mapa de capacidades ("criar"): para cada par (tipo, pai) criavel do catalogo, obtem uma
/// instancia editavel do pai no fixture (existente, ou criada recursivamente pelo proprio catalogo), tenta criar um
/// exemplar, le as mensagens do Verify do objeto criado e registra. Cada tentativa e um comando proprio; nada e salvo.
/// Estados: created (sem mensagens), created-needs-config (so mensagens estruturais: sem Start, sem atributo,
/// conector/propriedade obrigatoria), created-with-messages (outras), not-allowed (o runtime deste modulo nao aceita
/// o par: "can't be children of", "not supported by"), needs-args (Create tipado pede argumento), no-parent, failed, skipped.
/// </summary>
public static class ProofGenerator
{
    private static readonly string[] StructuralIds = { "InvalidEntity_OneAttr", "InvalidEntity_StaticId", "InvalidStructure_NoAttr", "InvalidFlow_NoStart", "RequiredConnector_", "RequiredPropertyValue_", "InvalidDataSet_NoEntity", "UnusedElement", "UnusedUserAction", "ProcessMissingInboxDetail", "RequiredProperty" };

    public static object Run(ModelHost host, string fixturePath, string catalogPath, string outPath, Action<string>? log = null, string? onlyParent = null)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var espace = host.Load(File.ReadAllBytes(fixturePath));
        try
        {
            var es = (IESpace)espace;
            var catalog = JsonNode.Parse(File.ReadAllText(catalogPath))!.AsObject();
            var all = catalog["Creatables"]!.AsArray().Select(c => (Type: c!["Type"]!.GetValue<string>(), Parent: c["Parent"]!.GetValue<string>(), Via: c["Via"]!.GetValue<string>())).ToList();
            var creatables = onlyParent == null ? all : all.Where(c => c.Parent.EndsWith("." + onlyParent) || c.Parent == onlyParent).ToList();
            var api = typeof(IESpace).Assembly;
            var rows = new List<ProofRow>();
            var parentCache = new Dictionary<string, (object? Inst, string Path)>();
            var resolvingParents = new HashSet<string>(StringComparer.Ordinal);
            var failedParents = new HashSet<(string, int)>();
            var referenced = new HashSet<object>(ReferenceEqualityComparer.Instance);
            foreach (var r in es.References) foreach (var d in ((IObjectSignature)r).GetAllDescendantsOfType<IObjectSignature>()) referenced.Add(d);
            var n = 0;

            // instancia editavel do pai: existente no fixture (fora das referencias) ou criada pelo catalogo, recursivamente
            (object? Inst, string Path) ParentInstance(string parentFull, int depth)
            {
                if (parentCache.TryGetValue(parentFull, out var cached)) return cached;
                if (failedParents.Contains((parentFull, depth)) || !resolvingParents.Add(parentFull)) return (null, "");
                try
                {
                    var pt = api.GetType(parentFull) ?? AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType(parentFull)).FirstOrDefault(t => t != null);
                    (object? Inst, string Path) result = (null, "");
                    if (pt != null)
                    {
                        if (pt.IsInstanceOfType(espace)) result = (espace, "espace");
                        else
                        {
                            var existing = ((IObjectSignature)es).GetAllDescendantsOfType<IObjectSignature>().FirstOrDefault(d => pt.IsInstanceOfType(d) && !referenced.Contains(d));
                            if (existing != null) result = (existing, "fixture:" + (TypeResolver.Name(existing) ?? pt.Name));
                            else if (depth < 4)
                            {
                                foreach (var pair in all.Where(p => p.Type == parentFull && !p.Via.Contains("Metadata")))
                                {
                                    var (gp, gpPath) = ParentInstance(pair.Parent, depth + 1);
                                    if (gp == null) continue;
                                    var session = new ModelSession(espace);
                                    session.Register("$gp", gp);
                                    object? made = null;
                                    try
                                    {
                                        StudioAdapter.Runtime.Mutate(espace, "Anvil probe parent " + pt.Name, _ =>
                                        {
                                            session.ApplyOne(new JsonObject { ["op"] = "create", ["parent"] = "$gp", ["type"] = parentFull, ["name"] = "AnvilProbe_" + pt.Name.TrimStart('I'), ["as"] = "$p" });
                                            made = session.Resolve("$p");
                                        });
                                    }
                                    catch { made = null; }
                                    if (made != null) { result = (made, gpPath + ">" + pt.Name); break; }
                                }
                            }
                        }
                    }
                    if (result.Inst != null) parentCache[parentFull] = result;
                    else failedParents.Add((parentFull, depth));
                    return result;
                }
                finally { resolvingParents.Remove(parentFull); }
            }

            foreach (var c in creatables)
            {
                n++;
                log?.Invoke($"probe {n}/{creatables.Count}: {c.Type} on {c.Parent}");
                var typeShort = c.Type.Split('.').Last();
                var parentShort = c.Parent.Split('.').Last();
                if (typeShort == "Void" || c.Via.Contains("Metadata")) { rows.Add(new ProofRow(typeShort, parentShort, c.Via, "skipped", 0, Array.Empty<string>(), null, null, null)); continue; }
                var (parent, ppath) = ParentInstance(c.Parent, 0);
                if (parent == null) { rows.Add(new ProofRow(typeShort, parentShort, c.Via, "no-parent", 0, Array.Empty<string>(), null, null, null)); continue; }
                var session = new ModelSession(espace);
                session.Register("$parent", parent);
                var name = "AnvilProbe_" + typeShort.TrimStart('I');
                try
                {
                    object? created = null;
                    var msgs = new List<string>();
                    StudioAdapter.Runtime.Mutate(espace, "Anvil probe " + typeShort, _ =>
                    {
                        session.ApplyOne(new JsonObject { ["op"] = "create", ["parent"] = "$parent", ["type"] = c.Type, ["name"] = name, ["as"] = "$x" });
                        created = session.Resolve("$x");
                        if (created is IObjectSignature sig)
                            foreach (var vm in sig.GetValidationMessages(true)) msgs.Add(vm.Type + ":" + vm.Id);
                    });
                    var ids = msgs.Distinct().ToList();
                    var status = ids.Count == 0 ? "created" : ids.All(m => StructuralIds.Any(s => m.Contains(s))) ? "created-needs-config" : "created-with-messages";
                    rows.Add(new ProofRow(typeShort, parentShort, c.Via, status, msgs.Count, ids.Take(6).ToList(), null, TypeResolver.Name(created), ppath));
                    try { StudioAdapter.Runtime.Mutate(espace, "Anvil probe cleanup", _ => (created as IObjectSignature)?.Delete()); } catch { }
                }
                catch (Exception ex)
                {
                    var msg = Unwrap(ex);
                    var status = msg.Contains("needs arg") ? "needs-args"
                        : msg.Contains("can't be children of") || msg.Contains("not supported by") || msg.Contains("Couldn't find any concrete class") ? "not-allowed"
                        : "failed";
                    rows.Add(new ProofRow(typeShort, parentShort, c.Via, status, 0, Array.Empty<string>(), msg, null, ppath));
                }
                if (n % 200 == 0) log?.Invoke($"{n}/{creatables.Count} probes, {sw.Elapsed.TotalSeconds:F0} s");
            }

            string Best(IEnumerable<ProofRow> g)
            {
                foreach (var s in new[] { "created", "created-needs-config", "created-with-messages", "needs-args", "not-allowed", "no-parent", "failed", "skipped" })
                    if (g.Any(r => r.Status == s)) return s;
                return "?";
            }
            var summary = rows.GroupBy(r => r.Status).OrderByDescending(g => g.Count()).ToDictionary(g => g.Key, g => g.Count());
            var byType = rows.GroupBy(r => r.Type).ToDictionary(g => g.Key, g => Best(g));
            var typeSummary = byType.GroupBy(k => k.Value).OrderByDescending(g => g.Count()).ToDictionary(g => g.Key, g => g.Count());
            rows = rows.Select((r, i) => r with { FullType = creatables[i].Type, FullParent = creatables[i].Parent }).ToList();
            var report = new { fixture = fixturePath, catalog = catalogPath, catalogCreatables = all.Count,
                catalogSha256 = CommandSurface.CatalogHash(File.ReadAllBytes(catalogPath)),
                studioVersion = StudioAdapter.Runtime.IdeVersion, parentDepth = 4, partial = onlyParent != null,
                probes = rows.Count, summary, typeSummary, elapsedMs = sw.ElapsedMilliseconds, rows };
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outPath))!);
            File.WriteAllText(outPath, JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }));
            var md = new System.Text.StringBuilder();
            md.AppendLine($"# Mapa de capacidades, coluna criar: {Path.GetFileNameWithoutExtension(fixturePath)} (gerado {DateTime.Now:s})\n");
            md.AppendLine($"Tipos por melhor estado: {string.Join(", ", typeSummary.Select(k => k.Key + "=" + k.Value))}.\n\nPares: {string.Join(", ", summary.Select(k => k.Key + "=" + k.Value))}.\n");
            md.AppendLine("| Tipo | Melhor estado | Pais que criam | Mensagens (amostra) | Erro (amostra) |");
            md.AppendLine("|---|---|---|---|---|");
            foreach (var g in rows.GroupBy(r => r.Type).OrderBy(g => g.Key))
            {
                var parents = string.Join(", ", g.Where(r => r.Status.StartsWith("created")).Select(r => r.Parent).Distinct().Take(6));
                var sample = string.Join("; ", g.SelectMany(r => r.MessageIds).Distinct().Take(3));
                var err = g.Where(r => r.Error != null).Select(r => r.Error!).FirstOrDefault() ?? "";
                if (err.Length > 90) err = err[..90];
                md.AppendLine($"| {g.Key} | {byType[g.Key]} | {parents} | {sample} | {err.Replace("|", "/")} |");
            }
            File.WriteAllText(Path.ChangeExtension(outPath, ".md"), md.ToString());
            log?.Invoke($"probes {rows.Count}: {string.Join(", ", summary.Select(k => k.Key + "=" + k.Value))}; tipos: {string.Join(", ", typeSummary.Select(k => k.Key + "=" + k.Value))}");
            return new { report.probes, report.summary, report.typeSummary, report.elapsedMs, outPath };
        }
        finally { ModelHost.Release(espace); }
    }

    private static string Unwrap(Exception ex) { while (ex is TargetInvocationException { InnerException: not null } t) ex = t.InnerException!; return ex.GetType().Name + ": " + ex.Message; }
}
