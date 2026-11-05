using System.Collections.Concurrent;
using Bench.Api.Engine;

namespace Bench.Api.Workloads;

/// <summary>
/// Data parallelism across all available cores: Parallel.For with thread-local state (fixed-point Mandelbrot),
/// Parallel.ForEach over range partitions (formatting + small allocations), and PLINQ queries.
/// All partial results are combined with order-independent integer sums, so the checksum is deterministic.
/// </summary>
public sealed class ParallelWorkload : Workload
{
    private const int Width = 320;
    private const int Height = 200;
    private const int MaxIter = 200;
    private const int RecordsPerUnit = 60_000;
    private const int PlinqRange = 120_000;

    public override WorkloadDto Descriptor { get; } = Describe(
        "parallel", "parallel", "Parallel.For / PLINQ",
        "Paralel Hesaplama",
        "Parallel.For, Parallel.ForEach ve PLINQ ile tüm çekirdekleri doyurur.",
        "🚀", "görev");

    public override int UnitsPerScale => 120;

    public override long OpsPerUnit => Height + RecordsPerUnit / 1_000 + PlinqRange / 1_000;

    protected override ulong RunUnit(int unit)
    {
        ulong h = Hash.Seed;
        h = Hash.Mix(h, Mandelbrot(unit));
        h = Hash.Mix(h, ProcessRecords(unit));
        h = Hash.Mix(h, PlinqQueries(unit));
        return h;
    }

    // Q32.32-free fixed point: 1.0 == 1 << 24, all arithmetic in long.
    private static long Mandelbrot(int unit)
    {
        const int shift = 24;
        const long one = 1L << shift;
        long x0 = -2L * one - unit * (one / 512);
        long y0 = -one;
        long step = 3L * one / Width;
        long total = 0;

        Parallel.For(0, Height,
            () => 0L,
            (row, _, local) =>
            {
                long ci = y0 + row * (2L * one / Height);
                for (int col = 0; col < Width; col++)
                {
                    long cr = x0 + col * step;
                    long zr = 0, zi = 0;
                    int iter = 0;
                    while (iter < MaxIter)
                    {
                        long zr2 = (zr * zr) >> shift;
                        long zi2 = (zi * zi) >> shift;
                        if (zr2 + zi2 > 4 * one) break;
                        zi = ((2 * zr * zi) >> shift) + ci;
                        zr = zr2 - zi2 + cr;
                        iter++;
                    }
                    local += iter;
                }
                return local;
            },
            local => Interlocked.Add(ref total, local));
        return total;
    }

    private sealed record Transaction(int Id, int AccountId, long AmountCents, string Reference);

    private static long ProcessRecords(int unit)
    {
        long checksum = 0;
        var perAccount = new ConcurrentDictionary<int, long>();
        Parallel.ForEach(
            Partitioner.Create(0, RecordsPerUnit, 2_000),
            () => 0L,
            (range, _, local) =>
            {
                var rng = new Rng(0x9A7A_0000UL + (ulong)unit * 1_000 + (ulong)range.Item1);
                var batch = new List<Transaction>(range.Item2 - range.Item1);
                for (int i = range.Item1; i < range.Item2; i++)
                {
                    int account = rng.Next(256);
                    long amount = rng.Next(-50_000, 500_000);
                    batch.Add(new Transaction(i, account, amount, $"TRX-{unit:D4}-{i:D6}-{account:X2}"));
                }
                foreach (var t in batch)
                {
                    local += t.AmountCents + (long)(Hash.Str(t.Reference) % 1_000);
                    perAccount.AddOrUpdate(t.AccountId, t.AmountCents, (_, existing) => existing + t.AmountCents);
                }
                return local;
            },
            local => Interlocked.Add(ref checksum, local));

        long accounts = 0;
        foreach (var kv in perAccount) accounts += kv.Key * 1_000_003L ^ kv.Value; // order independent sum
        return checksum ^ accounts;
    }

    private static long PlinqQueries(int unit)
    {
        int start = unit * PlinqRange;
        long primeSum = ParallelEnumerable.Range(start, PlinqRange)
            .Where(IsPrime)
            .Select(p => (long)p)
            .Sum();

        long grouped = ParallelEnumerable.Range(start, PlinqRange)
            .Select(i => (Key: Digits(i), Value: (long)i % 1_000))
            .GroupBy(x => x.Key)
            .Select(g => g.Key * 1_000_000L + g.Sum(x => x.Value))
            .Sum();

        int maxCollatz = Enumerable.Range(start + 1, PlinqRange / 4)
            .AsParallel()
            .Max(Collatz);

        return primeSum ^ (grouped << 3) ^ maxCollatz;
    }

    private static bool IsPrime(int n)
    {
        if (n < 2) return false;
        if (n % 2 == 0) return n == 2;
        for (int d = 3; (long)d * d <= n; d += 2)
            if (n % d == 0) return false;
        return true;
    }

    private static int Digits(int n) => n.ToString().Length;

    private static int Collatz(int n)
    {
        long x = n;
        int steps = 0;
        while (x != 1)
        {
            x = (x & 1) == 0 ? x >> 1 : 3 * x + 1;
            steps++;
        }
        return steps;
    }
}
