# Karşılaştırma paneli (dashboard)

Aynı iş yüklerini **.NET 10** ve **.NET 11** üzerinde çalıştırıp süre, CPU, bellek ve GC
değerlerini yan yana gösteren statik web paneli. Derleme adımı yoktur: düz HTML + CSS +
vanilla ES modülleri. nginx (veya herhangi bir statik sunucu) ile servis edilir.

Ekrandaki **tüm sayılar API'den gelen gerçek ölçümlerdir**; panel hiçbir sonucu uydurmaz
veya sabit kodlamaz. .NET 11 bir testte yavaşsa bu da olduğu gibi (amber renkle) gösterilir.

## Dosyalar

| Dosya | Görev |
|---|---|
| `index.html` | Sayfa iskeleti (Türkçe arayüz) |
| `css/base.css` | Renk/yazı belirteçleri, butonlar, çipler, rozetler, bildirimler |
| `css/layout.css` | Üst çubuk, hero, seçici, kontroller, sahne, grafikler, metodoloji, sunum modu, duyarlı düzen |
| `css/card.css` | Runtime kartı: 100 karo, DIMM · HEAP bellek çubuğu, göstergeler |
| `css/results.css` | Karşılaştırma bandı, tur şeridi, genel özet, sonuç tablosu, 16:9 özet kartı |
| `css/print.css` | Yazdırma (Ctrl+P → PDF): rapor ya da yalnızca özet kartı |
| `js/main.js` | Giriş noktası: bağlantı, iş yükleri, çalıştırma orkestrasyonu (adil ölçüm / gösteri), görünüm |
| `js/api.js` | API istemcisi; SSE akışı `fetch` + `ReadableStream` ile okunur (404/409 görülebilir, otomatik yeniden bağlanma yok) |
| `js/store.js` | Basit durum deposu + `localStorage` kalıcılığı |
| `js/summary.js` | Turların medyanı, min–max aralığı, gürültü tabanı, genel özet (geometrik ortalama vb.) |
| `js/card.js` | Runtime kartı bileşeni |
| `js/suite.js` | Karşılaştırma bandı, sonuç tablosu, genel özet, 16:9 özet kartı |
| `js/charts.js` | El yazımı SVG çizgi grafikleri (CPU %, çalışma kümesi + GC heap) |
| `js/format.js` | `tr-TR` sayı biçimi (1.234,5), birimler, oran ifadeleri |
| `js/dom.js` | Küçük DOM yardımcıları (API metinleri yalnızca `textContent` ile yazılır) |
| `assets/` | Kendi çizdiğimiz logo/favicon (resmî .NET logosu kullanılmaz) |

## Çalıştırma modları

- **⚖ Adil ölçüm (varsayılan)** — runtime'lar asla aynı anda çalışmaz. Tekrar sayısı 1 / 3 / 5
  (varsayılan 3). Sıra her turda değişir (10→11, 11→10, 10→11 …) ki sıra ve ısı kayması etkisi
  dengelensin. Her koşudan önce iki tarafta `POST /api/gc/collect` + ~1,5 sn soğuma.
  Sonuç = turların **medyanı**; değerlerin yanında min–max aralığı gösterilir.
  Fark, turlar arası oynaklıktan (her runtime'ın göreli min–max aralığı) küçükse kazanan ilan
  edilmez: **“fark ölçüm hassasiyeti içinde”**. Tek turda: **“tek ölçüm — tekrar edin”**.
- **◐ Gösteri (aynı anda)** — iki runtime eşzamanlı yarışır (görsel gösteri). Kaynaklar
  paylaşıldığı için süre/CPU değerleri birbirini etkiler; bu sonuçlar “gösteri modu — kesin ölçüm
  değil” rozetiyle işaretlenir ve adil ölçüm sonucu varken genel özete katılmaz.

“Tüm testleri çalıştır” aynı mod/tekrar ayarlarıyla bütün iş yüklerini koşturur; ilerleme
(test i/9, tur j/N) ve kalan süre tahmini gösterilir.

### Dürüstlük kuralları (fazla iddia yok)

- **Tek tur** sonuçları her yerde “tek ölçüm” diye işaretlenir: başlık “Tek ölçümde .NET 11 %9 daha
  hızlı göründü” biçimindedir, taç / “Daha hızlı” rozeti verilmez, genel özetin büyük sayısı nötr
  renkte gösterilir.
- **Genel özet** (geometrik ortalama, toplam tahsis, toplam GC, toplam CPU zamanı) toplamdaki farkı
  iş yükü bazındaki hükümlerle sınar: aynı yönde kesin sonuç veren test sayısı ters yöndekilerden
  fazla değilse ya da “hassasiyet içinde” kalan testlerden azsa kazanan ilan edilmez
  (“Farkların çoğu ölçüm hassasiyeti içinde”). Oranın kendisi yine olduğu gibi gösterilir.

## API adresleri

Varsayılan taban adresler aynı origin üzerindeki nginx vekilleridir:

- .NET 10 → `/bench10`
- .NET 11 → `/bench11`

Sorgu parametreleriyle değiştirilebilir (API'ler `Access-Control-Allow-Origin: *` gönderir):

```
http://localhost:8088/?b10=http://localhost:5010&b11=http://localhost:5011
```

Yalnızca `http(s)://…` mutlak adresler veya `/` ile başlayan yollar kabul edilir.

**A/A kontrolü:** iki yuvayı aynı runtime'a yönlendirin (ör. `?b10=/bench11&b11=/bench11`) ve
Adil ölçüm modunda çalıştırın; farkların “hassasiyet içinde” çıkması düzeneğin taraflı
olmadığını gösterir. (Gösteri modunda aynı konteyner iki isteği aynı anda kabul etmez → 409.)

## Kısayollar

| Tuş | İşlev |
|---|---|
| `P` | Sunum modu aç/kapat (kontroller gizlenir, sayılar büyür, mümkünse tam ekran) |
| `Esc` | Sunum modundan / özet kartından çık |
| `R` | Seçili testi başlat |
| `←` / `→` | Sunum modunda iş yükü değiştir |

## Diğer

- **Özet kartı (▣)**: ekran görüntüsü almaya uygun 16:9 kart; “Yazdır / PDF” yalnızca kartı basar.
- **Ctrl+P**: kontrolleri gizleyen, açık renkli bir sonuç raporu üretir.
- **JSON indir**: ortam bilgisi, alan açıklamaları (`alanAciklamalari`), ayarlar, medyanlar, min–max
  aralıkları, genel hüküm (`genelHizHukmu`, `tekOlcum`) ve **ham tur sonuçları**.
- Son sonuçlar ve ayarlar tarayıcının `localStorage` alanında saklanır (“Sonuçları temizle” ile silinir).
- Kaynak bilgisi iki `/api/info` yanıtından okunur (`processorCount` + `memoryLimitBytes`); farklıysa
  “Kaynak sınırları eşit değil” uyarısı, eşitse “eşit kaynak ✓” göstergesi çıkar.
- `memoryLimitBytes` konteyner limiti **değildir**: GC'nin kullanabileceği bellektir (varsayılan olarak
  konteyner limitinin ~%75'i; 2 GB konteynerde 1,5 GB). Panelde her yerde **“GC bellek sınırı
  (konteyner limitinin yaklaşık %75'i)”** olarak adlandırılır.
- CPU yüzdeleri (`cpuPercent`, `avgCpuPercent`) konteynerdeki **tüm çekirdekler** üzerindendir: 2
  çekirdekli konteynerde tek iş parçacıklı bir iş yükü ≈ %50 gösterir. Bu yüzden her “CPU ORT.”
  değerinin altında çekirdek eşdeğeri (`avgCpuPercent ÷ 100 × processorCount`, ör. “≈ 1,0 çekirdek”),
  CPU grafiğinin altında da “% = konteynerdeki tüm çekirdekler üzerinden (N çekirdek)” notu yer alır.
- DIMM · HEAP çubuğu gerçek `totalAllocatedBytes` değeriyle kademeli dolar; ölçüm sürerken ölçek,
  bilinen en büyük toplamdır (diğer runtime'ın sonucu, kayıtlı sonuç ya da tahsis ÷ ilerleme öngörüsü).
- Ölçüm sürerken grafikler saniyede en fazla ~4 kez yeniden çizilir: tarayıcı, ölçülen konteynerlerle
  aynı makinenin CPU'sunu paylaşır.
- Fontlar Google Fonts'tan yüklenir; çevrimdışıyken sistem yazı tiplerine düşer.
- `prefers-reduced-motion` açıksa animasyonlar kapatılır.
