using Bench.Api;
using Bench.Api.Engine;

var builder = WebApplication.CreateSlimBuilder(args);

// Adres onceligi: ASPNETCORE_URLS (varsayilan host davranisi) > PORT > 8080.
if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("ASPNETCORE_URLS")))
{
    var port = Environment.GetEnvironmentVariable("PORT");
    builder.WebHost.UseUrls($"http://+:{(string.IsNullOrEmpty(port) ? "8080" : port)}");
}

// Keep request logging out of the measurements.
builder.Logging.SetMinimumLevel(LogLevel.Warning);
builder.Logging.AddFilter("Microsoft.Hosting.Lifetime", LogLevel.Information);

builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.TypeInfoResolverChain.Insert(0, AppJsonContext.Default));
builder.Services.AddCors(o => o.AddDefaultPolicy(p => p.AllowAnyOrigin().AllowAnyMethod().AllowAnyHeader()));
builder.Services.AddSingleton<RunGate>();

var app = builder.Build();

app.UseCors();

app.MapGet("/healthz", () => Results.Text("ok"));

app.MapGet("/api/info", (RunGate gate) => Results.Json(RuntimeInfo.Get(gate.IsBusy), AppJsonContext.Default.InfoDto));

app.MapGet("/api/workloads", () => Results.Json(WorkloadRegistry.Descriptors, AppJsonContext.Default.WorkloadDtoArray));

app.MapGet("/api/run/{workloadId}/stream", BenchmarkRunner.StreamAsync);

app.MapPost("/api/gc/collect", (RunGate gate) =>
{
    if (!gate.TryEnter())
        return Results.Json(new ErrorDto("busy"), AppJsonContext.Default.ErrorDto, statusCode: StatusCodes.Status409Conflict);
    try
    {
        GC.Collect(2, GCCollectionMode.Forced, blocking: true, compacting: true);
        GC.WaitForPendingFinalizers();
        GC.Collect(2, GCCollectionMode.Forced, blocking: true, compacting: true);
        return Results.Json(new OkDto(true), AppJsonContext.Default.OkDto);
    }
    finally
    {
        gate.Exit();
    }
});

app.Run();
