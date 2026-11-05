using System.Text.Json;
using System.Text.Json.Serialization;

namespace Bench.Api;

public sealed record GcInfoDto(bool Server, bool Concurrent, long? HeapHardLimit);

public sealed record InfoDto(
    string RuntimeLabel,
    string FrameworkDescription,
    string Version,
    int Major,
    string Tfm,
    string Os,
    string Arch,
    int ProcessorCount,
    long MemoryLimitBytes,
    GcInfoDto Gc,
    bool TieredCompilation,
    bool TieredPgo,
    bool Busy);

public sealed record WorkloadDto(
    string Id,
    string Category,
    string Title,
    string TitleTr,
    string DescriptionTr,
    string Icon,
    string Unit,
    int DefaultScale);

public sealed record ErrorDto(
    string Error,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Message = null);

public sealed record OkDto(bool Ok);

public sealed record StartEvent(
    string RunId,
    string WorkloadId,
    string RuntimeLabel,
    int Scale,
    bool Warmup,
    DateTime StartedAtUtc);

public sealed record PhaseEvent(string Phase);

public sealed record ProgressSample(
    double T,
    double Progress,
    double CpuPercent,
    long WorkingSetBytes,
    long GcHeapBytes,
    long TotalAllocatedBytes,
    int Gc0,
    int Gc1,
    int Gc2,
    long OpsDone);

public sealed record ResultEvent(
    string WorkloadId,
    string RuntimeLabel,
    int Scale,
    bool Warmup,
    double DurationMs,
    double CpuTimeMs,
    double AvgCpuPercent,
    long AllocatedBytes,
    int Gc0,
    int Gc1,
    int Gc2,
    double GcPauseMs,
    long PeakWorkingSetBytes,
    long PeakGcHeapBytes,
    long Ops,
    double OpsPerSec,
    string Checksum,
    List<ProgressSample> Samples);

public sealed record ErrorEvent(string Message);

/// <summary>Source-generated JSON metadata for the API's own DTOs (camelCase, identical on both runtimes).</summary>
[JsonSourceGenerationOptions(JsonSerializerDefaults.Web)]
[JsonSerializable(typeof(InfoDto))]
[JsonSerializable(typeof(WorkloadDto[]))]
[JsonSerializable(typeof(ErrorDto))]
[JsonSerializable(typeof(OkDto))]
[JsonSerializable(typeof(StartEvent))]
[JsonSerializable(typeof(PhaseEvent))]
[JsonSerializable(typeof(ProgressSample))]
[JsonSerializable(typeof(ResultEvent))]
[JsonSerializable(typeof(ErrorEvent))]
internal sealed partial class AppJsonContext : JsonSerializerContext
{
}
