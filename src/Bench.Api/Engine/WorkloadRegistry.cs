using System.Diagnostics.CodeAnalysis;
using Bench.Api.Workloads;

namespace Bench.Api.Engine;

public static class WorkloadRegistry
{
    public static readonly IReadOnlyList<IWorkload> All =
    [
        new JsonWorkload(),
        new LinqWorkload(),
        new StringsWorkload(),
        new CollectionsWorkload(),
        new AllocChurnWorkload(),
        new AsyncWorkload(),
        new MathSimdWorkload(),
        new ParallelWorkload(),
        new GcPressureWorkload(),
    ];

    public static readonly WorkloadDto[] Descriptors = All.Select(w => w.Descriptor).ToArray();

    public static bool TryGet(string id, [NotNullWhen(true)] out IWorkload? workload)
    {
        foreach (var w in All)
        {
            if (string.Equals(w.Descriptor.Id, id, StringComparison.OrdinalIgnoreCase))
            {
                workload = w;
                return true;
            }
        }
        workload = null;
        return false;
    }
}
