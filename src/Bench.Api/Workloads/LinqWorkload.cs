using Bench.Api.Engine;

namespace Bench.Api.Workloads;

/// <summary>
/// Typical reporting-style LINQ over a sales list: filtering, projection, grouping, joins, ordering,
/// dictionaries, aggregation, plus chained enumerators over arrays, lists and ranges.
/// </summary>
public sealed class LinqWorkload : Workload
{
    private const int SalesPerUnit = 100_000;

    private static readonly string[] Regions = ["Marmara", "Ege", "Akdeniz", "İç Anadolu", "Karadeniz", "Doğu Anadolu", "Güneydoğu"];

    public override WorkloadDto Descriptor { get; } = Describe(
        "linq", "linq", "LINQ pipelines",
        "LINQ Sorguları",
        "Milyonlarca satış kaydında filtreleme, gruplama, sıralama ve toplama yapar.",
        "🔎", "kayıt");

    public override int UnitsPerScale => 50;

    public override long OpsPerUnit => SalesPerUnit;

    private sealed record Sale(int Id, int StoreId, int ProductId, int CustomerId, int Quantity, long UnitPriceCents, int Day);

    private sealed record Store(int Id, string Name, string Region);

    protected override ulong RunUnit(int unit)
    {
        var rng = new Rng(0x7140_0000UL + (ulong)unit);
        int baseId = unit * SalesPerUnit;

        List<Sale> sales = Enumerable.Range(baseId, SalesPerUnit)
            .Select(id => new Sale(
                Id: id,
                StoreId: rng.Next(64),
                ProductId: rng.Next(5_000),
                CustomerId: rng.Next(40_000),
                Quantity: rng.Next(1, 10),
                UnitPriceCents: rng.Next(500, 250_000),
                Day: rng.Next(365)))
            .ToList();

        List<Store> stores = Enumerable.Range(0, 64)
            .Select(i => new Store(i, $"Mağaza {i:D2}", Regions[i % Regions.Length]))
            .ToList();

        ulong h = Hash.Seed;

        // Top stores by revenue (multi-item orders only).
        var topStores = sales
            .Where(s => s.Quantity > 1)
            .GroupBy(s => s.StoreId)
            .Select(g => new { StoreId = g.Key, Revenue = g.Sum(s => s.Quantity * s.UnitPriceCents), Orders = g.Count() })
            .OrderByDescending(x => x.Revenue)
            .ThenBy(x => x.StoreId)
            .Take(10)
            .ToList();
        foreach (var s in topStores)
        {
            h = Hash.Mix(h, s.StoreId);
            h = Hash.Mix(h, s.Revenue);
            h = Hash.Mix(h, s.Orders);
        }

        // Units sold per product, then dictionary lookups.
        Dictionary<int, long> unitsByProduct = sales
            .GroupBy(s => s.ProductId)
            .ToDictionary(g => g.Key, g => g.Sum(s => (long)s.Quantity));
        long lookupSum = 0;
        for (int p = 0; p < 5_000; p += 3)
        {
            if (unitsByProduct.TryGetValue(p, out long units)) lookupSum += units * p;
        }
        h = Hash.Mix(h, lookupSum);

        // Revenue per region via join.
        var regionRevenue = sales
            .Join(stores, s => s.StoreId, st => st.Id, (s, st) => new { st.Region, Amount = s.Quantity * s.UnitPriceCents })
            .GroupBy(x => x.Region)
            .Select(g => new { Region = g.Key, Total = g.Sum(x => x.Amount) })
            .OrderBy(x => x.Region, StringComparer.Ordinal)
            .ToList();
        foreach (var r in regionRevenue)
        {
            h = Hash.Mix(h, Hash.Str(r.Region));
            h = Hash.Mix(h, r.Total);
        }

        // Best customers: order by spend, stable tie-break.
        long bestCustomerIds = sales
            .GroupBy(s => s.CustomerId)
            .Select(g => (Customer: g.Key, Spend: g.Sum(s => s.Quantity * s.UnitPriceCents)))
            .OrderByDescending(x => x.Spend)
            .ThenBy(x => x.Customer)
            .Take(100)
            .Sum(x => (long)x.Customer);
        h = Hash.Mix(h, bestCustomerIds);

        // Biggest single sales.
        long biggest = sales
            .OrderByDescending(s => s.Quantity * s.UnitPriceCents)
            .ThenBy(s => s.Id)
            .Take(250)
            .Select(s => (long)s.Id)
            .Sum();
        h = Hash.Mix(h, biggest);

        // Weekly aggregate (Aggregate with seed).
        long weekly = sales
            .Where(s => s.Day % 7 == 0)
            .Select(s => s.UnitPriceCents)
            .Aggregate(17L, (acc, v) => unchecked(acc * 31 + v));
        h = Hash.Mix(h, weekly);

        // Distinct / Any / All / Count / Min / Max.
        h = Hash.Mix(h, sales.Select(s => s.Day).Distinct().Count());
        h = Hash.Mix(h, sales.Count(s => s.UnitPriceCents > 200_000));
        h = Hash.Mix(h, sales.Any(s => s.Quantity == 9 && s.StoreId == 63) ? 1 : 0);
        h = Hash.Mix(h, sales.All(s => s.Quantity > 0) ? 1 : 0);
        h = Hash.Mix(h, sales.Max(s => s.UnitPriceCents));
        h = Hash.Mix(h, sales.Min(s => s.UnitPriceCents));

        // Chained enumerators over an array.
        Sale[] array = sales.ToArray();
        long arrayChain = array
            .Skip(1_000)
            .Take(60_000)
            .Where(s => s.StoreId % 4 == 0)
            .Select(s => s.Quantity * 3L)
            .Sum();
        h = Hash.Mix(h, arrayChain);

        // Chunk + SelectMany + ToLookup.
        long chunkMax = array.Chunk(1_000).Select(c => c.Max(s => s.UnitPriceCents)).Sum();
        h = Hash.Mix(h, chunkMax);
        ILookup<int, int> byDay = sales.Where(s => s.Day < 30).ToLookup(s => s.Day, s => s.Quantity);
        long lookupTotal = 0;
        for (int d = 0; d < 30; d++) lookupTotal += byDay[d].Sum() * (long)(d + 1);
        h = Hash.Mix(h, lookupTotal);
        long flattened = stores.Take(8).SelectMany(st => sales.Where(s => s.StoreId == st.Id).Take(50)).Sum(s => (long)s.ProductId);
        h = Hash.Mix(h, flattened);

        // Ranges.
        long rangeSum = Enumerable.Range(0, SalesPerUnit)
            .Where(i => (i & 3) == 0)
            .Select(i => (long)i * i % 1_000_003)
            .Sum();
        h = Hash.Mix(h, rangeSum);
        long zipped = Enumerable.Range(0, 20_000)
            .Zip(array.Select(s => s.Quantity), (i, q) => (long)i * q)
            .Sum();
        h = Hash.Mix(h, zipped);

        // List-to-list projection.
        List<int> highValueProducts = sales
            .Where(s => s.Quantity * s.UnitPriceCents > 1_000_000)
            .Select(s => s.ProductId)
            .Distinct()
            .OrderBy(p => p)
            .ToList();
        h = Hash.Mix(h, highValueProducts.Count);
        return Hash.Mix(h, highValueProducts.Count > 0 ? highValueProducts[^1] : 0);
    }
}
