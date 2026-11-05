# syntax=docker/dockerfile:1
# Ayni Dockerfile her iki runtime icin kullanilir (build arg'lar ile):
#   .NET 10: SDK_IMAGE=mcr.microsoft.com/dotnet/sdk:10.0-resolute RUNTIME_IMAGE=mcr.microsoft.com/dotnet/aspnet:10.0-resolute TFM=net10.0
#   .NET 11: SDK_IMAGE=mcr.microsoft.com/dotnet/sdk:11.0-resolute RUNTIME_IMAGE=mcr.microsoft.com/dotnet/aspnet:11.0-resolute TFM=net11.0
ARG SDK_IMAGE=mcr.microsoft.com/dotnet/sdk:10.0-resolute
ARG RUNTIME_IMAGE=mcr.microsoft.com/dotnet/aspnet:10.0-resolute
ARG TFM=net10.0

FROM ${SDK_IMAGE} AS build
ARG TFM
WORKDIR /src

# Katman onbellegi icin once csproj + restore
COPY src/Bench.Api/Bench.Api.csproj src/Bench.Api/
RUN dotnet restore src/Bench.Api/Bench.Api.csproj -p:BenchTfm=${TFM}

# Sonra kalan kaynak kodu
COPY src/Bench.Api/ src/Bench.Api/

# Duz JIT uygulamasi: apphost yok, trimming yok, ReadyToRun yok, AOT yok
RUN dotnet publish src/Bench.Api/Bench.Api.csproj \
      -c Release \
      -p:BenchTfm=${TFM} \
      -p:UseAppHost=false \
      -o /out \
      --no-restore

FROM ${RUNTIME_IMAGE} AS final
WORKDIR /app
COPY --from=build /out .

# Adres: uygulama ASPNETCORE_URLS (varsa) > PORT > 8080 siralamasiyla belirler (Program.cs).
ENV PORT=8080
EXPOSE 8080

# NOT: DOTNET_* ayar degiskeni (TieredPGO, TieredCompilation, gcServer vb.) bilerek set edilmiyor;
# her iki konteyner de kendi runtime'inin varsayilanlariyla calisir.

USER app
ENTRYPOINT ["dotnet", "Bench.Api.dll"]
