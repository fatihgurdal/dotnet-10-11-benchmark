using System.Text.Json;
using Bench.Api.Engine;

namespace Bench.Api.Workloads;

/// <summary>
/// Reflection-based System.Text.Json (default options, no source generation): each order document is
/// serialized to UTF-8 and read back, then the whole batch is serialized as one array string and read back.
/// </summary>
public sealed class JsonWorkload : Workload
{
    private const int OrdersPerUnit = 1_500;

    public override WorkloadDto Descriptor { get; } = Describe(
        "json", "serialization", "JSON serialize / deserialize",
        "JSON Serileştirme",
        "Sipariş nesne grafiklerini System.Text.Json ile yazıp tekrar okur.",
        "📦", "doküman");

    public override int UnitsPerScale => 72;

    public override long OpsPerUnit => OrdersPerUnit;

    protected override ulong RunUnit(int unit)
    {
        var rng = new Rng(0x150A_0000UL + (ulong)unit);
        var orders = new List<Order>(OrdersPerUnit);
        for (int i = 0; i < OrdersPerUnit; i++)
        {
            orders.Add(OrderFactory.Create(ref rng, unit * OrdersPerUnit + i));
        }

        ulong h = Hash.Seed;
        long totalBytes = 0;

        foreach (var order in orders)
        {
            byte[] utf8 = JsonSerializer.SerializeToUtf8Bytes(order);
            Order back = JsonSerializer.Deserialize<Order>(utf8)!;
            totalBytes += utf8.Length;
            h = Hash.Mix(h, Digest(back));
        }

        string batchJson = JsonSerializer.Serialize(orders);
        List<Order> batch = JsonSerializer.Deserialize<List<Order>>(batchJson)!;
        long batchTotal = 0;
        foreach (var order in batch)
        {
            batchTotal += ToCents(order.Total);
        }

        h = Hash.Mix(h, totalBytes);
        h = Hash.Mix(h, batchJson.Length);
        h = Hash.Mix(h, batch.Count);
        return Hash.Mix(h, batchTotal);
    }

    private static long ToCents(decimal value) => (long)decimal.Round(value * 100m, 0, MidpointRounding.AwayFromZero);

    private static ulong Digest(Order o)
    {
        ulong h = Hash.Mix(Hash.Seed, o.Id);
        h = Hash.Mix(h, Hash.Str(o.OrderNumber));
        h = Hash.Mix(h, o.Customer.Id);
        h = Hash.Mix(h, Hash.Str(o.Customer.Email));
        h = Hash.Mix(h, o.CreatedAt.UtcTicks);
        h = Hash.Mix(h, o.ShippedAt?.Ticks ?? -1);
        h = Hash.Mix(h, (long)o.Status);
        h = Hash.Mix(h, ToCents(o.Total));
        h = Hash.Mix(h, o.Lines.Count);
        foreach (var line in o.Lines)
        {
            h = Hash.Mix(h, Hash.Str(line.Sku));
            h = Hash.Mix(h, line.Quantity * ToCents(line.UnitPrice));
        }
        h = Hash.Mix(h, o.Tags.Length);
        h = Hash.Mix(h, o.Metadata.Count);
        return Hash.Mix(h, Hash.Str(o.ShippingAddress.City));
    }
}

public enum OrderStatus { Pending, Paid, Shipped, Delivered, Cancelled, Refunded }

public sealed class Order
{
    public long Id { get; set; }
    public string OrderNumber { get; set; } = "";
    public Customer Customer { get; set; } = new();
    public DateTimeOffset CreatedAt { get; set; }
    public DateTime? ShippedAt { get; set; }
    public OrderStatus Status { get; set; }
    public string Currency { get; set; } = "TRY";
    public List<OrderLine> Lines { get; set; } = [];
    public Address ShippingAddress { get; set; } = new();
    public string[] Tags { get; set; } = [];
    public decimal Subtotal { get; set; }
    public decimal Tax { get; set; }
    public decimal Total { get; set; }
    public bool IsGift { get; set; }
    public string? Note { get; set; }
    public Dictionary<string, string> Metadata { get; set; } = [];
}

public sealed class Customer
{
    public int Id { get; set; }
    public string FullName { get; set; } = "";
    public string Email { get; set; } = "";
    public string Phone { get; set; } = "";
    public int LoyaltyTier { get; set; }
    public DateTime MemberSince { get; set; }
}

public sealed class OrderLine
{
    public string Sku { get; set; } = "";
    public string Name { get; set; } = "";
    public int Quantity { get; set; }
    public decimal UnitPrice { get; set; }
    public decimal Discount { get; set; }
    public double Weight { get; set; }
    public bool InStock { get; set; }
}

public sealed class Address
{
    public string Line1 { get; set; } = "";
    public string? Line2 { get; set; }
    public string City { get; set; } = "";
    public string District { get; set; } = "";
    public string PostalCode { get; set; } = "";
    public string Country { get; set; } = "TR";
}

internal static class OrderFactory
{
    private static readonly string[] FirstNames = ["Ayşe", "Mehmet", "Zeynep", "Mustafa", "Elif", "Emre", "Fatma", "Burak", "Selin", "Can", "Gökhan", "Şule"];
    private static readonly string[] LastNames = ["Yılmaz", "Kaya", "Demir", "Şahin", "Çelik", "Yıldız", "Aydın", "Öztürk", "Arslan", "Doğan"];
    private static readonly string[] Cities = ["İstanbul", "Ankara", "İzmir", "Bursa", "Antalya", "Konya", "Eskişehir", "Trabzon"];
    private static readonly string[] Products = ["Kahve Makinesi", "Kulaklık", "Laptop Çantası", "Akıllı Saat", "Klavye", "Monitör", "Telefon Kılıfı", "Powerbank", "Kitap Okuma Lambası", "Termos"];
    private static readonly string[] TagPool = ["express", "campaign", "first-order", "mobile", "web", "gift-wrap", "b2b", "loyalty"];

    private static readonly DateTimeOffset Epoch = new(2025, 1, 1, 0, 0, 0, TimeSpan.FromHours(3));

    public static Order Create(ref Rng rng, int seq)
    {
        int lineCount = rng.Next(1, 9);
        var lines = new List<OrderLine>(lineCount);
        decimal subtotal = 0m;
        for (int i = 0; i < lineCount; i++)
        {
            int productIdx = rng.Next(Products.Length);
            decimal price = rng.Next(1_000, 2_500_000) / 100m;
            int qty = rng.Next(1, 6);
            decimal discount = rng.Chance(25) ? decimal.Round(price * rng.Next(5, 30) / 100m, 2) : 0m;
            lines.Add(new OrderLine
            {
                Sku = $"SKU-{productIdx:D3}-{rng.Next(100000):D5}",
                Name = Products[productIdx],
                Quantity = qty,
                UnitPrice = price,
                Discount = discount,
                Weight = rng.Next(50, 20_000) / 1000.0,
                InStock = !rng.Chance(10),
            });
            subtotal += (price - discount) * qty;
        }

        decimal tax = decimal.Round(subtotal * 0.20m, 2);
        int customerId = rng.Next(1, 250_000);
        string first = rng.Pick(FirstNames);
        string last = rng.Pick(LastNames);
        var created = Epoch.AddMinutes(rng.Next(0, 525_600));
        var status = (OrderStatus)rng.Next(6);

        var tags = new string[rng.Next(0, 4)];
        for (int i = 0; i < tags.Length; i++) tags[i] = rng.Pick(TagPool);

        var metadata = new Dictionary<string, string>
        {
            ["channel"] = rng.Chance(60) ? "mobile" : "web",
            ["campaign"] = $"CMP-{rng.Next(1000):D4}",
        };
        if (rng.Chance(30)) metadata["coupon"] = $"KUPON{rng.Next(100):D2}";

        return new Order
        {
            Id = 1_000_000L + seq,
            OrderNumber = $"HK-{created:yyyyMMdd}-{seq:D7}",
            Customer = new Customer
            {
                Id = customerId,
                FullName = $"{first} {last}",
                Email = $"user{customerId}@example.com",
                Phone = $"+90 5{rng.Next(30, 60)} {rng.Next(100, 1000)} {rng.Next(1000, 10000)}",
                LoyaltyTier = rng.Next(0, 4),
                MemberSince = new DateTime(2015, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddDays(rng.Next(0, 3650)),
            },
            CreatedAt = created,
            ShippedAt = status >= OrderStatus.Shipped ? created.UtcDateTime.AddHours(rng.Next(2, 96)) : null,
            Status = status,
            Currency = "TRY",
            Lines = lines,
            ShippingAddress = new Address
            {
                Line1 = $"{rng.Next(1, 200)}. Sokak No:{rng.Next(1, 80)}",
                Line2 = rng.Chance(40) ? $"Daire {rng.Next(1, 40)}" : null,
                City = rng.Pick(Cities),
                District = $"Mahalle {rng.Next(1, 60)}",
                PostalCode = rng.Next(10000, 82000).ToString("D5"),
            },
            Tags = tags,
            Subtotal = subtotal,
            Tax = tax,
            Total = subtotal + tax,
            IsGift = rng.Chance(8),
            Note = rng.Chance(20) ? "Lütfen kapıya bırakın, zile basmayın." : null,
            Metadata = metadata,
        };
    }
}
