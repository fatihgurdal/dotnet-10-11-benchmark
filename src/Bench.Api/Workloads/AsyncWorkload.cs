using System.Threading.Channels;
using Bench.Api.Engine;

namespace Bench.Api.Workloads;

/// <summary>
/// CPU-bound async plumbing (no I/O, no delays): layered async/await call chains with Task and ValueTask,
/// Task.WhenAll fan-out, Channel&lt;T&gt; producer/consumer, async iterators, SemaphoreSlim and Task.Yield.
/// </summary>
public sealed class AsyncWorkload : Workload
{
    private const int RequestsPerUnit = 8_000;
    private const int ChannelItemsPerUnit = 160_000;

    public override WorkloadDto Descriptor { get; } = Describe(
        "async", "async", "async/await & channels",
        "Async / Await",
        "İç içe async çağrılar, Task.WhenAll dağıtımı ve Channel üretici-tüketici hattı çalıştırır.",
        "⚡", "istek");

    public override int UnitsPerScale => 100;

    public override long OpsPerUnit => RequestsPerUnit;

    protected override ulong RunUnit(int unit) => RunUnitAsync(unit).GetAwaiter().GetResult();

    private static async Task<ulong> RunUnitAsync(int unit)
    {
        ulong h = Hash.Seed;

        // 1) Fan-out: many "requests" handled concurrently through a layered service stack.
        var service = new OrderService(new PriceRepository(), new SemaphoreSlim(4));
        var tasks = new Task<long>[RequestsPerUnit];
        for (int i = 0; i < tasks.Length; i++) tasks[i] = service.HandleAsync(unit * RequestsPerUnit + i);
        long[] results = await Task.WhenAll(tasks);
        long sum = 0;
        foreach (long r in results) sum += r;
        h = Hash.Mix(h, sum);

        // 2) Channel pipeline: 2 producers -> bounded channel -> 2 consumers.
        var channel = Channel.CreateBounded<int>(new BoundedChannelOptions(256) { SingleReader = false, SingleWriter = false });
        Task producers = Task.WhenAll(Produce(channel.Writer, unit, 0), Produce(channel.Writer, unit, 1))
            .ContinueWith(_ => channel.Writer.Complete(), TaskScheduler.Default);
        Task<long> c1 = Consume(channel.Reader);
        Task<long> c2 = Consume(channel.Reader);
        await producers;
        long consumed = await c1 + await c2;
        h = Hash.Mix(h, consumed);

        // 3) Async iterator.
        long streamed = 0;
        await foreach (int v in ReadEventsAsync(unit, 20_000)) streamed += v;
        h = Hash.Mix(h, streamed);

        // 4) Deep recursive ValueTask chain (mostly synchronous completions).
        h = Hash.Mix(h, await SumTreeAsync(16, unit));
        return h;
    }

    private sealed class PriceRepository
    {
        private int _calls;

        public ValueTask<long> GetPriceAsync(int productId)
        {
            // Cache hits complete synchronously; every 8th call is a "miss" that completes asynchronously.
            if ((Interlocked.Increment(ref _calls) & 7) != 0)
                return ValueTask.FromResult(1_000L + productId % 997);
            return LoadAsync(productId);
        }

        private static async ValueTask<long> LoadAsync(int productId)
        {
            await Task.Yield();
            return 1_000L + productId % 997;
        }
    }

    private sealed class OrderService(PriceRepository prices, SemaphoreSlim limiter)
    {
        public async Task<long> HandleAsync(int requestId)
        {
            if (!await ValidateAsync(requestId)) return 0;
            long total = 0;
            for (int line = 0; line < 4; line++)
            {
                total += await PriceLineAsync(requestId, line);
            }
            total += await ApplyCampaignAsync(requestId, total);
            await limiter.WaitAsync();
            try
            {
                return await SaveAsync(requestId, total);
            }
            finally
            {
                limiter.Release();
            }
        }

        private static ValueTask<bool> ValidateAsync(int requestId) => ValueTask.FromResult(requestId % 101 != 0);

        private async ValueTask<long> PriceLineAsync(int requestId, int line)
        {
            int productId = (requestId * 31 + line * 7) % 5_000;
            long price = await prices.GetPriceAsync(productId);
            int quantity = 1 + (requestId + line) % 3;
            return price * quantity;
        }

        private static async Task<long> ApplyCampaignAsync(int requestId, long total)
        {
            if (requestId % 5 == 0) await Task.Yield();
            return -(total / 20);
        }

        private static async Task<long> SaveAsync(int requestId, long total)
        {
            if (requestId % 3 == 0) await Task.Yield();
            return total ^ (requestId & 0xFF);
        }
    }

    private static async Task Produce(ChannelWriter<int> writer, int unit, int producer)
    {
        int count = ChannelItemsPerUnit / 2;
        for (int i = 0; i < count; i++)
        {
            await writer.WriteAsync(unit + i * 2 + producer);
        }
    }

    private static async Task<long> Consume(ChannelReader<int> reader)
    {
        long sum = 0;
        while (await reader.WaitToReadAsync())
        {
            while (reader.TryRead(out int v)) sum += Transform(v);
        }
        return sum;
    }

    private static long Transform(int v) => (long)v * 3 % 1_000_003;

    private static async IAsyncEnumerable<int> ReadEventsAsync(int unit, int count)
    {
        for (int i = 0; i < count; i++)
        {
            if ((i & 255) == 0) await Task.Yield();
            yield return (unit + i) % 1_000;
        }
    }

    private static async ValueTask<long> SumTreeAsync(int depth, int seed)
    {
        if (depth == 0) return seed & 15;
        long left = await SumTreeAsync(depth - 1, seed * 3 + 1);
        long right = await SumTreeAsync(depth - 1, seed * 5 + 2);
        return left + right + depth;
    }
}
