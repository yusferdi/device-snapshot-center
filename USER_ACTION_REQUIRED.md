# User Action Required

Status production pada 6 Juni 2026: perlu deploy ulang setelah fitur remote clipboard dan tuning wheel sensitivity.

Verifier production terakhir masih `FAILED` karena server live belum memiliki release lokal terbaru dan belum mengiklankan `remote_clipboard`.

Pengingat tetap untuk setiap deployment berikutnya:

1. Deploy seluruh folder `server/` sebagai satu release dan pertahankan `.env` production serta folder upload.
2. Pastikan rewrite website utama tidak menangkap file nyata di `/any/server`.
3. Reset OPcache atau restart PHP-FPM/web server jika `opcache.validate_timestamps=0`.
4. Jalankan dari root proyek:

```powershell
node scripts/verify-deployment.mjs https://lppsp.ui.ac.id/any/server
```

Deployment selesai hanya ketika verifier menghasilkan `PASS` dan heartbeat agent tidak memiliki error.
