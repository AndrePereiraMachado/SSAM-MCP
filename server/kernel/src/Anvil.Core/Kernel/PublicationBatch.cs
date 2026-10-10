using System.Diagnostics;

namespace Anvil.Core;

public sealed record PublicationResult(PublishOutcome Outcome, long StartOffsetMs, string? Error = null);

/// <summary>Submit every prepared module before waiting. SOAP calls stay on one thread;
/// publication jobs overlap on the server, without sharing a model or client across threads.</summary>
public static class PublicationBatch
{
    public static IReadOnlyList<PublicationResult> Run(int count, Func<int, PublishOutcome> start,
        Func<int, PublishOutcome, PublishOutcome> poll, TimeSpan? timeout = null, TimeSpan? interval = null)
    {
        var clock = Stopwatch.StartNew();
        var limit = timeout ?? TimeSpan.FromMinutes(10);
        var delay = interval ?? TimeSpan.FromMilliseconds(500);
        var results = new PublicationResult[count];
        var active = new bool[count];
        for (var i = 0; i < count; i++)
        {
            var offset = clock.ElapsedMilliseconds;
            try
            {
                var outcome = start(i);
                results[i] = new(outcome, offset);
                active[i] = outcome.Started && !outcome.Completed && !outcome.HasErrors;
            }
            catch (Exception ex)
            {
                // Start1CP may have reached the server. Never retry automatically.
                results[i] = new(new(false, true, false, 0, 0, null, Array.Empty<PublishMessage>(),
                    clock.ElapsedMilliseconds - offset, clock.ElapsedMilliseconds - offset), offset,
                    $"Publication start failed; server outcome unknown, inspect before retry: {ex.GetType().Name}: {ex.Message}");
            }
        }
        while (active.Any(x => x))
        {
            for (var i = 0; i < count; i++)
            {
                if (!active[i]) continue;
                var result = results[i];
                var age = clock.ElapsedMilliseconds - result.StartOffsetMs;
                try
                {
                    if (age >= limit.TotalMilliseconds)
                        throw new TimeoutException("Publication still unconfirmed; inspect its version before retry");
                    var outcome = poll(i, result.Outcome);
                    results[i] = result with { Outcome = outcome with { TotalMs = clock.ElapsedMilliseconds - result.StartOffsetMs } };
                    active[i] = !outcome.Completed && !outcome.HasErrors;
                }
                catch (Exception ex)
                {
                    results[i] = result with { Outcome = result.Outcome with { TotalMs = age },
                        Error = $"Publication completion unknown; inspect version {result.Outcome.VersionId} before retry: {ex.GetType().Name}: {ex.Message}" };
                    active[i] = false;
                }
            }
            if (active.Any(x => x) && delay > TimeSpan.Zero) Thread.Sleep(delay);
        }
        return results;
    }
}
