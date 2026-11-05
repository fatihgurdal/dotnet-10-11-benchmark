using Bench.Api.Engine;

namespace Bench.Api.Workloads;

/// <summary>
/// Everyday business code (a shopping-cart pricing engine) written the way it usually is:
/// immutable Money records, small helper objects, interface-typed collections and rules,
/// lambdas/closures, boxing, tiny temporary arrays and tuples. Almost every allocation here is
/// short-lived and does not escape the method that creates it, so this is where the JIT's escape
/// analysis / object stack allocation can remove heap allocations.
/// </summary>
public sealed class AllocChurnWorkload : Workload
{
    private const int CartsPerUnit = 100_000;
    private const int CartPool = 2_048;

    public override WorkloadDto Descriptor { get; } = Describe(
        "alloc-churn", "jit", "Short-lived allocations (escape analysis)",
        "Kısa Ömürlü Nesneler",
        "Sepet fiyatlama kodundaki geçici nesneler, lambda'lar ve boxing ile JIT kaçış analizini sınar.",
        "♻️", "sepet");

    public override int UnitsPerScale => 64;

    public override long OpsPerUnit => CartsPerUnit;

    // ----- domain -----

    private sealed record Product(int Id, string Name, int CategoryId, long PriceCents);

    private readonly record struct CartItem(Product Product, int Quantity);

    private sealed class Cart
    {
        public required int Id { get; init; }
        public required int CustomerTier { get; init; }
        public required string City { get; init; }
        public required List<CartItem> Items { get; init; }
    }

    private sealed record Money(long Cents, string Currency)
    {
        public static Money Zero(string currency) => new(0, currency);
        public Money Add(Money other) => new(Cents + other.Cents, Currency);
        public Money Subtract(Money other) => new(Cents - other.Cents, Currency);
        public Money Times(int quantity) => new(Cents * quantity, Currency);
        public Money Percent(int percent) => new(Cents * percent / 100, Currency);
        public bool IsGreaterThan(Money other) => Cents > other.Cents;
    }

    private sealed class LineResult(CartItem item, Money gross, Money discount)
    {
        public CartItem Item { get; } = item;
        public Money Gross { get; } = gross;
        public Money Discount { get; } = discount;
        public Money Net => Gross.Subtract(Discount);
    }

    private interface IDiscountRule
    {
        string Code { get; }
        Money? Discount(Cart cart, CartItem item, Money lineTotal);
    }

    private sealed class CategoryDiscount(int categoryId, int percent) : IDiscountRule
    {
        public string Code => "CAT";
        public Money? Discount(Cart cart, CartItem item, Money lineTotal)
            => item.Product.CategoryId == categoryId ? lineTotal.Percent(percent) : null;
    }

    private sealed class BulkDiscount(int minQuantity, int percent) : IDiscountRule
    {
        public string Code => "BULK";
        public Money? Discount(Cart cart, CartItem item, Money lineTotal)
            => item.Quantity >= minQuantity ? lineTotal.Percent(percent) : null;
    }

    private sealed class LoyaltyDiscount(int minTier, int percent) : IDiscountRule
    {
        public string Code => "LOYAL";
        public Money? Discount(Cart cart, CartItem item, Money lineTotal)
            => cart.CustomerTier >= minTier ? lineTotal.Percent(percent) : null;
    }

    private sealed class CityDiscount(string city, long fixedCents) : IDiscountRule
    {
        public string Code => "CITY";
        public Money? Discount(Cart cart, CartItem item, Money lineTotal)
            => cart.City == city && lineTotal.Cents > fixedCents * 4 ? new Money(fixedCents, lineTotal.Currency) : null;
    }

    private sealed record ShippingQuote(string Carrier, long Cents, int Days);

    private static readonly string[] CityNames = ["İstanbul", "Ankara", "İzmir", "Bursa", "Antalya", "Kayseri"];

    private Product[] _catalog = [];
    private Cart[] _carts = [];

    protected override void BeginRun()
    {
        // Deterministic catalog and cart pool (rebuilt for every run so warm-up and measured passes are identical).
        var rng = new Rng(0xA110_C000UL);
        _catalog = new Product[500];
        for (int i = 0; i < _catalog.Length; i++)
            _catalog[i] = new Product(i, $"Ürün {i}", rng.Next(12), rng.Next(990, 150_000));

        _carts = new Cart[CartPool];
        for (int c = 0; c < _carts.Length; c++)
        {
            int count = rng.Next(1, 9);
            var items = new List<CartItem>(count);
            for (int i = 0; i < count; i++) items.Add(new CartItem(_catalog[rng.Next(_catalog.Length)], rng.Next(1, 7)));
            _carts[c] = new Cart { Id = c, CustomerTier = rng.Next(4), City = rng.Pick(CityNames), Items = items };
        }
    }

    protected override void EndRun()
    {
        _catalog = [];
        _carts = [];
    }

    protected override ulong RunUnit(int unit)
    {
        // A different campaign every unit.
        IReadOnlyList<IDiscountRule> rules =
        [
            new CategoryDiscount(unit % 12, 15),
            new CategoryDiscount((unit + 5) % 12, 10),
            new BulkDiscount(4, 8),
            new LoyaltyDiscount(2, 5 + unit % 3),
            new CityDiscount(CityNames[unit % CityNames.Length], 2_500),
        ];
        int taxPercent = 20;

        ulong h = Hash.Seed;
        long grandTotal = 0;
        long valid = 0;
        for (int i = 0; i < CartsPerUnit; i++)
        {
            Cart cart = _carts[(i * 7 + unit * 13) % _carts.Length];
            if (!Validate(cart)) continue;
            valid++;
            CartSummary summary = PriceCart(cart, rules, taxPercent);
            grandTotal += summary.TotalWithTax;
            h = Hash.Mix(h, summary.TotalWithTax ^ ((long)summary.HeavyItems << 40) ^ ((long)summary.Discounted << 48));
            h = Hash.Mix(h, summary.ShippingCents + summary.Segment);
        }
        h = Hash.Mix(h, valid);
        return Hash.Mix(h, grandTotal);
    }

    private readonly record struct CartSummary(long TotalWithTax, int HeavyItems, int Discounted, long ShippingCents, int Segment);

    private static bool Validate(Cart cart)
    {
        var errors = new List<string>();
        if (cart.Items.Count == 0) errors.Add("Sepet boş");
        foreach (var item in cart.Items)
        {
            if (item.Quantity <= 0) errors.Add($"Geçersiz adet: {item.Product.Id}");
            if (item.Product.PriceCents <= 0) errors.Add($"Geçersiz fiyat: {item.Product.Id}");
        }
        return errors.Count == 0;
    }

    private static CartSummary PriceCart(Cart cart, IReadOnlyList<IDiscountRule> rules, int taxPercent)
    {
        Money total = Money.Zero("TRY");
        Money totalDiscount = Money.Zero("TRY");
        int discounted = 0;

        IEnumerable<CartItem> items = cart.Items;
        foreach (CartItem item in items)
        {
            Money gross = new Money(item.Product.PriceCents, "TRY").Times(item.Quantity);
            Money best = Money.Zero("TRY");
            foreach (IDiscountRule rule in rules)
            {
                Money? discount = rule.Discount(cart, item, gross);
                if (discount is not null && discount.IsGreaterThan(best)) best = discount;
            }

            var line = new LineResult(item, gross, best);
            if (line.Discount.Cents > 0) discounted++;
            total = total.Add(line.Net);
            totalDiscount = totalDiscount.Add(line.Discount);
        }

        // Closures over locals and parameters.
        int bulkThreshold = 3;
        int heavyItems = cart.Items.Count(i => i.Quantity >= bulkThreshold);
        Func<long, long> applyTax = cents => cents + cents * taxPercent / 100;
        long withTax = applyTax(total.Cents);

        // Tuples and tiny temporary arrays.
        (long Min, long Max) range = PriceRange(cart.Items);
        long[] thresholds = [10_000, 50_000, 250_000];
        int band = 0;
        foreach (long t in thresholds) if (withTax > t) band++;

        // Boxing through object-typed helpers.
        int segment = Segment(cart.CustomerTier, band);

        ShippingQuote quote = CheapestShipping(cart.City, withTax, range.Max);
        return new CartSummary(withTax + quote.Cents, heavyItems, discounted, quote.Cents + totalDiscount.Cents % 997, segment);
    }

    private static (long Min, long Max) PriceRange(List<CartItem> items)
    {
        long min = long.MaxValue, max = long.MinValue;
        foreach (var item in items) // struct enumerator
        {
            min = Math.Min(min, item.Product.PriceCents);
            max = Math.Max(max, item.Product.PriceCents);
        }
        return (min, max);
    }

    private static int Segment(object tier, object band)
    {
        int t = tier is int ti ? ti : 0;
        int b = band is int bi ? bi : 0;
        return tier.Equals(3) ? 100 + b : t * 10 + b;
    }

    private static ShippingQuote CheapestShipping(string city, long orderCents, long maxItemCents)
    {
        var quotes = new List<ShippingQuote>
        {
            new("Yurtiçi", city == "İstanbul" ? 2_990 : 3_990, 2),
            new("Aras", 3_490, 3),
            new("MNG", maxItemCents > 100_000 ? 5_990 : 3_290, 2),
        };
        if (orderCents > 75_000) quotes.Add(new ShippingQuote("Ücretsiz", 0, 4));

        ShippingQuote best = quotes[0];
        foreach (var q in quotes)
            if (q.Cents < best.Cents || (q.Cents == best.Cents && q.Days < best.Days)) best = q;
        return best;
    }
}
