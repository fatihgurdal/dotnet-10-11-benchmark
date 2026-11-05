using Bench.Api.Engine;

namespace Bench.Api.Workloads;

/// <summary>
/// Dictionary / HashSet / List / SortedDictionary / Queue / PriorityQueue inserts, lookups and removals,
/// plus Array.Sort / List.Sort / OrderBy of structs and strings.
/// </summary>
public sealed class CollectionsWorkload : Workload
{
    private const int ItemsPerUnit = 50_000;
    private const int GridSize = 160;

    public override WorkloadDto Descriptor { get; } = Describe(
        "collections", "collections", "Collections & sorting",
        "Koleksiyonlar ve Sıralama",
        "Dictionary, HashSet, List ve kuyruklarda ekleme, arama, silme ve sıralama yapar.",
        "🗂️", "eleman");

    public override int UnitsPerScale => 64;

    public override long OpsPerUnit => ItemsPerUnit;

    private sealed class Account
    {
        public required int Id { get; init; }
        public required string Email { get; init; }
        public long Balance { get; set; }
        public int Transactions { get; set; }
    }

    private readonly record struct Score(int Id, int Points, long Timestamp);

    protected override ulong RunUnit(int unit)
    {
        var rng = new Rng(0xC011_0000UL + (ulong)unit);
        ulong h = Hash.Seed;

        // Dictionary<int, T>: insert, lookup, update, remove, re-insert.
        var accounts = new Dictionary<int, Account>();
        var byEmail = new Dictionary<string, Account>(StringComparer.Ordinal);
        for (int i = 0; i < ItemsPerUnit; i++)
        {
            int id = rng.Next(1, 4_000_000);
            if (accounts.ContainsKey(id)) continue;
            var acc = new Account { Id = id, Email = $"user{id}@example.com", Balance = rng.Next(0, 1_000_000) };
            accounts.Add(id, acc);
            byEmail[acc.Email] = acc;
        }
        long hits = 0;
        for (int i = 0; i < ItemsPerUnit * 2; i++)
        {
            int id = rng.Next(1, 4_000_000);
            if (accounts.TryGetValue(id, out var acc))
            {
                acc.Balance += 10;
                acc.Transactions++;
                hits++;
            }
        }
        for (int i = 0; i < ItemsPerUnit / 2; i++)
        {
            string email = $"user{rng.Next(1, 4_000_000)}@example.com";
            if (byEmail.TryGetValue(email, out var acc)) hits += acc.Transactions + 1;
        }
        int removed = 0;
        for (int i = 0; i < ItemsPerUnit / 4; i++)
        {
            if (accounts.Remove(rng.Next(1, 4_000_000), out var acc))
            {
                byEmail.Remove(acc.Email);
                removed++;
            }
        }
        long balanceSum = 0;
        foreach (var acc in accounts.Values) balanceSum += acc.Balance; // order independent
        h = Hash.Mix(h, accounts.Count);
        h = Hash.Mix(h, byEmail.Count);
        h = Hash.Mix(h, hits);
        h = Hash.Mix(h, removed);
        h = Hash.Mix(h, balanceSum);

        // HashSet<long>: dedupe, contains, set operations.
        var seen = new HashSet<long>();
        var other = new HashSet<long>();
        int dupes = 0;
        for (int i = 0; i < ItemsPerUnit; i++)
        {
            long key = rng.Next(0, ItemsPerUnit * 2);
            if (!seen.Add(key)) dupes++;
            if ((i & 1) == 0) other.Add(rng.Next(0, ItemsPerUnit * 2));
        }
        int contains = 0;
        for (int i = 0; i < ItemsPerUnit; i++) if (seen.Contains(i)) contains++;
        seen.IntersectWith(other);
        long setSum = 0;
        foreach (long v in seen) setSum += v;
        h = Hash.Mix(h, dupes);
        h = Hash.Mix(h, contains);
        h = Hash.Mix(h, seen.Count);
        h = Hash.Mix(h, setSum);

        // List<T>: add, sort, binary search, RemoveAll, insert.
        var list = new List<int>();
        for (int i = 0; i < ItemsPerUnit; i++) list.Add(rng.Next(0, 10_000_000));
        list.Sort();
        int found = 0;
        for (int i = 0; i < ItemsPerUnit / 2; i++) if (list.BinarySearch(rng.Next(0, 10_000_000)) >= 0) found++;
        int removedOdd = list.RemoveAll(v => (v & 7) == 3);
        for (int i = 0; i < 200; i++) list.Insert(rng.Next(list.Count), i);
        h = Hash.Mix(h, found);
        h = Hash.Mix(h, removedOdd);
        h = Hash.Mix(h, list.Count);
        h = Hash.Mix(h, list[list.Count / 2]);

        // SortedDictionary: ordered inserts and in-order enumeration.
        var sorted = new SortedDictionary<int, string>();
        for (int i = 0; i < ItemsPerUnit / 5; i++)
        {
            int k = rng.Next(0, 1_000_000);
            sorted[k] = "v" + k.ToString();
        }
        int taken = 0;
        foreach (var kv in sorted)
        {
            h = Hash.Mix(h, kv.Key);
            if (++taken == 64) break;
        }
        h = Hash.Mix(h, sorted.Count);

        // Queue<T>: BFS shortest paths on a grid with walls.
        var walls = new bool[GridSize * GridSize];
        for (int i = 0; i < walls.Length; i++) walls[i] = rng.Chance(22);
        walls[0] = false;
        var dist = new int[GridSize * GridSize];
        Array.Fill(dist, -1);
        var queue = new Queue<(int X, int Y)>();
        queue.Enqueue((0, 0));
        dist[0] = 0;
        long distSum = 0;
        while (queue.Count > 0)
        {
            var (x, y) = queue.Dequeue();
            int d = dist[y * GridSize + x];
            distSum += d;
            Visit(x + 1, y, d); Visit(x - 1, y, d); Visit(x, y + 1, d); Visit(x, y - 1, d);
        }
        h = Hash.Mix(h, distSum);

        void Visit(int x, int y, int d)
        {
            if ((uint)x >= GridSize || (uint)y >= GridSize) return;
            int idx = y * GridSize + x;
            if (walls[idx] || dist[idx] >= 0) return;
            dist[idx] = d + 1;
            queue.Enqueue((x, y));
        }

        // PriorityQueue: top-K with unique priorities.
        var pq = new PriorityQueue<int, long>();
        for (int i = 0; i < ItemsPerUnit / 2; i++)
        {
            long priority = (long)rng.Next(0, 1_000_000) * ItemsPerUnit + i;
            pq.Enqueue(i, priority);
            if (pq.Count > 500) pq.Dequeue();
        }
        long topK = 0;
        while (pq.TryDequeue(out int item, out long pr)) topK = unchecked(topK * 31 + item + pr);
        h = Hash.Mix(h, topK);

        // Sorting structs: Array.Sort with comparison (unique tie-break), OrderBy/ThenBy, List.Sort of strings.
        var scores = new Score[ItemsPerUnit];
        for (int i = 0; i < scores.Length; i++) scores[i] = new Score(i, rng.Next(0, 5_000), rng.Next(0, 1_000_000));
        var copy = (Score[])scores.Clone();
        Array.Sort(scores, (a, b) => a.Points != b.Points ? b.Points.CompareTo(a.Points) : a.Id.CompareTo(b.Id));
        for (int i = 0; i < 32; i++) h = Hash.Mix(h, scores[i].Id);
        Score[] byTime = copy.OrderBy(s => s.Timestamp).ThenBy(s => s.Id).ToArray();
        h = Hash.Mix(h, byTime[0].Id);
        h = Hash.Mix(h, byTime[^1].Id);
        h = Hash.Mix(h, byTime[byTime.Length / 2].Id);

        var names = new List<string>(ItemsPerUnit / 2);
        for (int i = 0; i < ItemsPerUnit / 2; i++) names.Add($"müşteri-{rng.Next(0, 1_000_000):D6}-{(char)('a' + rng.Next(26))}");
        names.Sort(StringComparer.Ordinal);
        h = Hash.Mix(h, Hash.Str(names[0]));
        h = Hash.Mix(h, Hash.Str(names[names.Count / 2]));
        return Hash.Mix(h, Hash.Str(names[^1]));
    }
}
