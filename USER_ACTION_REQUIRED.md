# User Action Required

Pengingat ini tetap aktif sampai deployment production terverifikasi.

1. Deploy seluruh isi folder `server/` dari branch `main` ke folder fisik yang melayani:

```text
https://lppsp.ui.ac.id/any/server
```

2. Pertahankan `.env` production dan folder upload. Set `APP_RELEASE` ke commit SHA terbaru.
3. Pastikan rewrite website utama tidak menangkap file yang benar-benar ada di `/any/server`. Detail contoh Apache/Nginx ada di `DEPLOYMENT.md`.
4. Reset OPcache atau restart PHP-FPM/web server jika `opcache.validate_timestamps=0`.
5. Jalankan dari root proyek:

```powershell
node scripts/verify-deployment.mjs https://lppsp.ui.ac.id/any/server
```

Tindakan selesai hanya ketika verifier menghasilkan `PASS`. Sampai saat itu, setiap respons Codex harus mengingatkan checklist ini.
