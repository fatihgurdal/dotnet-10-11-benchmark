namespace Bench.Api.Engine;

/// <summary>Cheap, thread-safe progress counter updated by workloads once per chunk.</summary>
public sealed class ProgressCounter
{
    private long _done;

    public long Done => Volatile.Read(ref _done);

    public void Add(long ops) => Interlocked.Add(ref _done, ops);
}

public interface IWorkload
{
    WorkloadDto Descriptor { get; }

    /// <summary>Number of fixed-size work units at scale 1. Work grows linearly with scale.</summary>
    int UnitsPerScale { get; }

    /// <summary>Work items ("ops") completed per unit.</summary>
    long OpsPerUnit { get; }

    long TotalOps(int units);

    /// <summary>Runs <paramref name="units"/> units and returns a deterministic checksum of the results.</summary>
    ulong Run(int units, ProgressCounter progress, CancellationToken ct);
}

/// <summary>
/// Base class: runs units 0..N-1 sequentially, checks cancellation at unit boundaries,
/// reports progress once per unit and folds every unit's checksum into the result.
/// Unit i always does exactly the same work (seeded by i), so the checksum depends only on N.
/// </summary>
public abstract class Workload : IWorkload
{
    public abstract WorkloadDto Descriptor { get; }
    public abstract int UnitsPerScale { get; }
    public abstract long OpsPerUnit { get; }

    public long TotalOps(int units) => OpsPerUnit * units;

    protected virtual void BeginRun() { }

    protected virtual void EndRun() { }

    protected abstract ulong RunUnit(int unit);

    public ulong Run(int units, ProgressCounter progress, CancellationToken ct)
    {
        BeginRun();
        try
        {
            ulong h = Hash.Seed;
            for (int unit = 0; unit < units; unit++)
            {
                ct.ThrowIfCancellationRequested();
                h = Hash.Mix(h, RunUnit(unit));
                progress.Add(OpsPerUnit);
            }
            return h;
        }
        finally
        {
            EndRun();
        }
    }

    protected static WorkloadDto Describe(
        string id, string category, string title, string titleTr, string descriptionTr, string icon, string unit)
        => new(id, category, title, titleTr, descriptionTr, icon, unit, 1);
}
