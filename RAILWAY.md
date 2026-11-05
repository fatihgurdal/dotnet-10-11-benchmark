# Railway'e Dağıtım (.NET 10 vs .NET 11 Benchmark Demosu)

> **Önemli not:** Bu belgedeki Railway'e özgü adımlar Railway'in resmî dokümanlarına dayanır;
> **yazar tarafından Railway üzerinde henüz çalıştırılıp doğrulanmamıştır.** Arayüz adları veya
> davranışlar farklı çıkabilir. Yerelde (Docker Desktop, arm64) Dockerfile'lar, nginx şablonu ve compose topolojisi
> doğrulanmıştır (bkz. "Yerelde topoloji denemesi"); Railway'in kendi ağı, edge'i ve amd64 build'i denenmemiştir.

## 1. Ne dağıtılıyor?

Üç ayrı Railway servisi, aynı GitHub reposundan:

| Servis | Dockerfile | Görev | Erişim |
|---|---|---|---|
| `bench10` | `Dockerfile.bench10` | .NET 10 benchmark API'si | Özel (yalnızca Railway ağı) |
| `bench11` | `Dockerfile.bench11` | .NET 11 benchmark API'si | Özel (yalnızca Railway ağı) |
| `dashboard` | `Dockerfile.dashboard` | Statik panel + nginx proxy (`/bench10/`, `/bench11/`) | **Herkese açık domain** |

**Neden tek konteyner değil?** İki runtime aynı konteynerde çalışsa CPU ve belleği paylaşır, birbirini
etkiler ve her birinin limiti ayrı ayrı (ve eşit) ayarlanamaz. Ayrı servislerde her runtime kendi
kaynak limitiyle, kendi sürecinde çalışır; adil karşılaştırma ancak böyle mümkündür.

## 2. Yol 1: Compose dosyasını içe aktarma

1. Repoyu GitHub'a gönderin (`Dockerfile.*`, `docker-compose.railway.yml`, `deploy/`, `dashboard/`, `src/` dahil).
2. Railway → **New Project** → **Empty Project**.
3. `docker-compose.railway.yml` dosyasını proje tuvaline (canvas) sürükleyip bırakın. Üç servis
   (`bench10`, `bench11`, `dashboard`) **staged** (henüz uygulanmamış) değişiklik olarak görünür.
4. Her servis için: GitHub reposunu bağlayın ve Dockerfile yolunu kontrol edin
   (içe aktarmada zaten dolu gelmiş olabilir):
   - `bench10` → `RAILWAY_DOCKERFILE_PATH` = `Dockerfile.bench10`
   - `bench11` → `RAILWAY_DOCKERFILE_PATH` = `Dockerfile.bench11`
   - `dashboard` → `RAILWAY_DOCKERFILE_PATH` = `Dockerfile.dashboard`
5. Değişkenlerin geldiğini doğrulayın (bkz. tablo aşağıda), ardından **Deploy**.
6. Compose'tan **aktarılmayanları** elle yapın: Replica Limits, health check, domain (bölüm 4 ve 5).

Compose dosyasındaki `ports`, `depends_on`, `container_name`, `restart`, `deploy.resources`, `cpus`,
`mem_limit` ve bind mount'lar Railway tarafından yok sayılır/güvenilmez; bu yüzden dosyada kullanılmadı.

## 3. Yol 2: Compose olmadan (elle)

Aynı GitHub reposundan üç servis oluşturun (New → GitHub Repo), her birine şu değişkenleri verin:

| Servis | Değişken | Değer |
|---|---|---|
| `bench10` | `RAILWAY_DOCKERFILE_PATH` | `Dockerfile.bench10` |
| | `PORT` | `8080` |
| | `DOTNET_PROCESSOR_COUNT` | `2` (bench11 ile aynı; Replica Limits ile uyumlu) |
| `bench11` | `RAILWAY_DOCKERFILE_PATH` | `Dockerfile.bench11` |
| | `PORT` | `8080` |
| | `DOTNET_PROCESSOR_COUNT` | `2` (bench10 ile aynı) |
| `dashboard` | `RAILWAY_DOCKERFILE_PATH` | `Dockerfile.dashboard` |
| | `PORT` | `8080` |
| | `BENCH10_UPSTREAM` | `http://bench10.railway.internal:8080` |
| | `BENCH11_UPSTREAM` | `http://bench11.railway.internal:8080` |

**Servis adları tam olarak `bench10`, `bench11`, `dashboard` olmalı**: özel ağ adresi servis adından
türer (`<servis-adı>.railway.internal`). Farklı ad verirseniz `BENCH*_UPSTREAM` değerlerini düzeltin.

> **`PORT`:** Uygulama artık `PORT` değişkenini dinler (öncelik: `ASPNETCORE_URLS` > `PORT` > `8080`; bkz.
> `src/Bench.Api/Program.cs`; Railway imajlarında giriş betiği adresi `PORT`'tan türetir). Yine de `8080`
> kullanmanızı öneririz: dashboard upstream'leri (`BENCH*_UPSTREAM`) ve public domain hedef portu bu değerle aynı olmalıdır;
> `PORT`'u değiştirirseniz bunları da güncelleyin.

## 4. Adil ölçüm ayarları (önemli)

Railway kaynak limitlerini compose'tan almaz; elle ve **iki servis için birebir aynı** girilmelidir.

1. `bench10` → **Settings → Deploy → Replica Limits**: vCPU ve bellek değerini girin (ör. 2 vCPU / 2 GB).
2. `bench11` için **tamamen aynı** değerleri girin.
3. İki serviste de `DOTNET_PROCESSOR_COUNT` aynı olsun (örn. `2`) ve Replica Limits'teki vCPU ile uyumlu olsun.
   .NET'in Railway'deki cgroup limitini görüp görmediği doğrulanmadığı için bunu açıkça veriyoruz.
4. Servisleri yeniden dağıtın, panelde **"eşit kaynak ✓"** rozetinin **yeşil** olduğunu doğrulayın.
   Rozet, iki `/api/info` yanıtındaki `processorCount` ve `memoryLimit` değerlerini karşılaştırır.
   Yeşil değilse ayarlar farklıdır; ölçüm yapmayın.
5. Varsayılan **"Adil ölçüm"** modunu kullanın (runtime'lar asla aynı anda çalışmaz, sıra her turda değişir).
6. Paylaşımlı Railway donanımında gürültü yüksektir: tekrar sayısını **5** yapın ve tüm testleri birkaç kez çalıştırın.

**İşletim sistemi tabanı:** Tüm bench imajları aynı tabana sabitlenmiştir: Ubuntu 26.04 ("resolute")
(`sdk`/`aspnet` `10.0-resolute` ve `11.0-resolute`; her iki etiket de linux/amd64 ve linux/arm64 için mevcut).
Önce Ubuntu 24.04 ("noble") hedeflendi, ancak `11.0-noble` etiketi yok; `11.0` varsayılanı 26.04, `10.0` varsayılanı
24.04 olduğundan işletim sistemi farkı karıştırıcı bir etken olurdu. `/api/info` içindeki `os` alanı iki serviste aynı
ailede ("Ubuntu 26.04.x LTS") görünmelidir.

### Ölçüm doğruluğu

Bu demo mikro-benchmark tarzıdır ve **gürültüye açıktır**. Yazarın Mac'inde (Docker Desktop, 10 vCPU VM, her biri 2 CPU / 2 GB)
*aynı* .NET 10 imajından üretilmiş iki konteyner arasındaki fark sıralı testte +%1 ile +%49 (ortalama +%18), eşzamanlı testte
−%1,5 ile +%44 (ortalama +%8,7) çıktı; yani tek iş yükünde ~%20-25'in altındaki farklar gürültüden ayrılamaz. Railway'in paylaşımlı
vCPU'larında gürültünün benzer veya daha yüksek olması beklenmelidir (ölçülmedi). .NET 10 ile 11.0.0-rc.3 arasındaki farklar
yerelde küçüktü (ortalama ≈ −%3 sıralı, ≈ −%1 eşzamanlı); dolayısıyla sonuçlar **gösterge niteliğindedir, kesin değildir**.
Tekrar sayısını 5 yapın, "Adil ölçüm" modunu kullanın, "fark ölçüm hassasiyeti içinde" çiplerini harfi harfine okuyun ve veriden
fazlasını iddia etmeyin. Ayrıntı için `README.md` içindeki "Ölçüm doğruluğu hakkında dürüst not" bölümüne bakın.

## 5. Servis ayarları

| Ayar | `bench10` | `bench11` | `dashboard` |
|---|---|---|---|
| Health check path (Settings → Deploy) | `/healthz` | `/healthz` | `/healthz` |
| Public domain | **Yok** (özel kalsın) | **Yok** (özel kalsın) | **Generate Domain**, hedef port = `8080` (`PORT` değeri) |
| Replica Limits | Eşit (bölüm 4) | Eşit (bölüm 4) | Varsayılan |
| Replika sayısı | 1 | 1 | 1 |

Public domain'in hedef portu, servisin dinlediği portla (`PORT` = 8080) aynı olmalıdır.

## 6. Dağıtım sonrası doğrulama listesi

- [ ] Üç servis de **Active/Deployed**, health check yeşil.
- [ ] Dashboard domain'i açılıyor.
- [ ] Panelde iki çip de **"bağlı"** (yeşil).
- [ ] **"eşit kaynak ✓"** rozeti yeşil.
- [ ] Tek bir iş yükü çalıştırınca ilerleme çubukları ilerliyor, sonuç geliyor.
- [ ] `https://<dashboard-domain>/bench10/api/info` yanıtında `runtimeLabel` .NET 10 olarak görünüyor.
- [ ] `https://<dashboard-domain>/bench11/api/info` yanıtında `runtimeLabel` .NET 11 olarak görünüyor.

## 7. Riskler ve sorun giderme

- **SSE tampon riski.** Railway edge'inin Server-Sent Events'i tamponlayıp tamponlamadığı doğrulanmadı
  (topluluk raporları var). Belirti: ilerleme çubukları akmak yerine sonda birden atlar. Sonuçlar yine
  doğrudur. nginx tarafında tamponlama kapalıdır (`proxy_buffering off`, `X-Accel-Buffering: no`).
  Dağıtımdan sonra mutlaka kontrol edin.
- **İstek süresi sınırları.** Railway edge'inde HTTP istekleri veri akmaya devam ettiği sürece en fazla
  15 dk, sessizlik 5 dk sürerse kapatılır. Uzun iş yüklerinde bunu aklınızda tutun.
- **Özel ağ çözümleme hatası.** Belirti: bir runtime için "bağlantı yok". Önce `BENCH*_UPSTREAM` adlarını ve
  servis adlarını kontrol edin. **Yedek yol:** her bench servisine **Generate Domain** verin ve paneli şu
  adresle açın (API'ler CORS `*` gönderir):
  `https://<dashboard-domain>/?b10=https://<bench10-domain>&b11=https://<bench11-domain>`
- **.NET 11 bir RC (aday) sürümdür.** `mcr.microsoft.com/dotnet/*:11.0-resolute` imajları ve davranışı değişebilir.
- **Bulut CPU'larında sonuçlar gürültülüdür.** Paylaşımlı vCPU'lar dizüstüne göre daha oynaktır. Düzeneğin
  taraflı olmadığını görmek için A/A denemesi yapın (`?b10=/bench11&b11=/bench11`; farklar "hassasiyet içinde" çıkmalı).
- **Dashboard URL'sini bilen herkes benchmark başlatabilir.** Her serviste aynı anda tek koşu olur (ikincisi
  409 döner), ama yine de URL'yi geniş çevreyle paylaşmayın.
- **Maliyet.** Üç küçük servis çalışır; ölçüm bitince servisleri durdurun/silin.
- **Build bağlamı.** Tüm Dockerfile'lar için tek, kök `.dockerignore` kullanılır; `dashboard/` ve `deploy/`
  bağlamda tutulur (yalnızca `bin/`, `obj/`, `.git`, `*.png`, `results/` vb. dışlanır). Dockerfile'a özel
  `.dockerignore` dosyası kullanılmaz.
- **nginx resolver.** `deploy/17-resolver-fallback.envsh`, `/etc/resolv.conf` boş olsa bile `resolver` satırının
  `127.0.0.11`'e düşmesini sağlar (aksi halde nginx açılmaz ve health check başarısız olur).

## 8. Yerelde topoloji denemesi (Railway'e gitmeden)

```bash
docker compose -f docker-compose.railway.yml config      # geçerlilik
docker compose -f docker-compose.railway.yml -f deploy/railway-local.override.yml up --build -d
# Dashboard: http://localhost:8089  (mevcut yığının 5010/5011/8088 portlarıyla çakışmaz)
docker compose -f docker-compose.railway.yml -f deploy/railway-local.override.yml down
```

Override dosyası bench servislerine eşit `cpus`/`mem_limit` verir ve upstream'leri yerel servis adlarına çevirir.

## 9. `railway.json` neden yok?

`railway.json` / `railway.toml` (Config as Code) Railway tarafından kullanımdan kaldırılmış (deprecated)
olarak işaretlendiği için **bilinçli olarak kullanılmadı**. Dockerfile yolu `RAILWAY_DOCKERFILE_PATH`
değişkeniyle, health check yolu ise servis ayarlarından verilir.
