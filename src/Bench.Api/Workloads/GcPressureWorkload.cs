using System.Buffers;
using Bench.Api.Engine;

namespace Bench.Api.Workloads;

/// <summary>
/// GC stress in the shape of a cache/buffer-heavy service: a rolling retained working set of mixed-size
/// arrays (including LOH-sized buffers &gt; 85 KB) and small object graphs that survive long enough to be
/// promoted to gen1/gen2, plus temporary buffers both freshly allocated and rented from ArrayPool.
/// No finalizers.
/// </summary>
public sealed class GcPressureWorkload : Workload
{
    private const int StepsPerUnit = 2_500;
    private const int RetainedSlots = 6_000;

    public override WorkloadDto Descriptor { get; } = Describe(
        "gc-pressure", "gc", "GC pressure (gen0/1/2 + LOH)",
        "GC Baskısı",
        "Büyük ve küçük dizilerle yaşayan bir çalışma kümesi oluşturup çöp toplayıcıyı zorlar.",
        "🗑️", "adım");

    public override int UnitsPerScale => 150;

    public override long OpsPerUnit => StepsPerUnit;

    private sealed class CacheEntry
    {
        public required long Key { get; init; }
        public required byte[] Payload { get; init; }
        public CacheEntry? Next { get; set; }
    }

    private object?[] _slots = [];
    private Rng _rng;

    protected override void BeginRun()
    {
        _slots = new object?[RetainedSlots];
        _rng = new Rng(0x6C6C_0000UL);
    }

    protected override void EndRun()
    {
        _slots = [];
    }

    protected override ulong RunUnit(int unit)
    {
        ulong h = Hash.Seed;
        long evictedSum = 0;
        long scratchSum = 0;
        object?[] slots = _slots;

        for (int step = 0; step < StepsPerUnit; step++)
        {
            int kind = _rng.Next(100);
            object item;
            if (kind < 60)
            {
                var small = new byte[_rng.Next(128, 8 * 1024)];
                small.AsSpan().Fill((byte)step);
                item = small;
            }
            else if (kind < 85)
            {
                var mid = new int[_rng.Next(2_048, 20_000)]; // 8 KB - 80 KB (stays in SOH)
                mid.AsSpan().Fill(step);
                item = mid;
            }
            else if (kind < 95)
            {
                var large = new byte[_rng.Next(90_000, 600_000)]; // LOH
                large.AsSpan(0, 4_096).Fill((byte)(step >> 3));
                large[^1] = (byte)step;
                item = large;
            }
            else
            {
                CacheEntry? head = null;
                int length = _rng.Next(16, 128);
                for (int i = 0; i < length; i++)
                    head = new CacheEntry { Key = (long)unit << 32 | (uint)(step * 131 + i), Payload = new byte[64 + (i & 31) * 8], Next = head };
                item = head!;
            }

            // Replace a random retained slot: the old object becomes garbage after having survived for a while.
            int slot = _rng.Next(RetainedSlots);
            evictedSum += Inspect(slots[slot]);
            slots[slot] = item;

            // Temporary buffers: raw allocation vs ArrayPool rental.
            if ((step & 1) == 0)
            {
                var temp = new long[_rng.Next(64, 4_096)];
                for (int i = 0; i < temp.Length; i += 16) temp[i] = i ^ step;
                scratchSum += temp[^1] + temp.Length;
            }
            else
            {
                int size = _rng.Next(1_024, 256 * 1024);
                byte[] rented = ArrayPool<byte>.Shared.Rent(size);
                rented.AsSpan(0, size).Fill((byte)step);
                scratchSum += rented[size - 1] + size;
                ArrayPool<byte>.Shared.Return(rented);
            }
        }

        h = Hash.Mix(h, evictedSum);
        return Hash.Mix(h, scratchSum);
    }

    private static long Inspect(object? evicted) => evicted switch
    {
        byte[] b => b.Length + b[0] + b[^1],
        int[] a => a.Length + a[0],
        CacheEntry e => CountChain(e),
        _ => 0,
    };

    private static long CountChain(CacheEntry? e)
    {
        long n = 0;
        for (; e is not null; e = e.Next) n += e.Payload.Length + (e.Key & 0xFF);
        return n;
    }
}
